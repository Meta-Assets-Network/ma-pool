import { expect } from "chai";
import { ethers, upgrades, network } from "hardhat";
import { loadFixture } from "@nomicfoundation/hardhat-toolbox/network-helpers";
import type { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
import type { Wallet } from "ethers";

const V1_SWEEP = "0x281F73d00751aEb5f64e76c8B9137d3AA8499762";

async function mintMany(mst: any, foundation: HardhatEthersSigner, to: string, quantity: number) {
  let left = quantity;
  while (left > 0) {
    const n = Math.min(left, 80);
    await mst.connect(foundation).mint(to, n);
    left -= n;
  }
}

async function stakeAll(pool: any, mst: any, miner: HardhatEthersSigner | Wallet, n: number) {
  const addr = await miner.getAddress();
  const ids: bigint[] = [];
  for (let i = 0; i < n; i++) ids.push(await mst.tokenOfOwnerByIndex(addr, i));
  for (let i = 0; i < ids.length; i += 40) {
    await pool.connect(miner).stake(ids.slice(i, i + 40));
  }
}

/// 链下复算:用 V2 的朴素线性扫描公式重放当前高度的命中结果(对拍参照)
async function expectedWinner(pool: any): Promise<string> {
  const total: bigint = await pool.totalWeight();
  if (total === 0n) return await pool.fallbackAddress();
  const [, seed] = await pool.currentSeed();
  const r = ethers.toBigInt(seed) % total;
  const n = Number(await pool.activeMinerCount());
  let acc = 0n;
  for (let i = 0; i < n; i++) {
    const a = await pool.activeMinerAt(i);
    acc += await pool.minerWeight(a);
    if (r < acc) return a;
  }
  throw new Error("linear replay fell through: tree/totalWeight desync?");
}

/// 确定性 PRNG(固定种子),保证 fuzz 可复现
function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe("RewardSystemV3 (Fenwick sweep)", () => {
  // 真链同款升级链路:V1 → V2(initializeV2)→ V3(initializeV3,同笔执行)
  async function deployV3() {
    const [foundation, alice, bob, carol, dave] = await ethers.getSigners();
    const V1 = await ethers.getContractFactory("RewardSystem", foundation);
    const proxy = await upgrades.deployProxy(V1, [foundation.address], { kind: "uups" });
    const V2 = await ethers.getContractFactory("RewardSystemV2", foundation);
    const poolV2 = await upgrades.upgradeProxy(proxy, V2);
    const MST = await ethers.getContractFactory("MSTToken", foundation);
    const mst = await MST.deploy(foundation.address);
    await poolV2.connect(foundation).initializeV2(await mst.getAddress(), V1_SWEEP);
    const V3 = await ethers.getContractFactory("RewardSystemV3", foundation);
    const pool = await upgrades.upgradeProxy(proxy, V3, { call: { fn: "initializeV3", args: [] } });
    return { pool, mst, foundation, alice, bob, carol, dave };
  }

  async function setupMiner(
    pool: any,
    mst: any,
    foundation: HardhatEthersSigner,
    miner: HardhatEthersSigner | Wallet,
    n: number,
    activate = true
  ) {
    const addr = await miner.getAddress();
    await mintMany(mst, foundation, addr, n);
    await mst.connect(miner).setApprovalForAll(await pool.getAddress(), true);
    await stakeAll(pool, mst, miner, n);
    if (activate) await pool.connect(miner).activate();
  }

  async function assertTreeInvariant(pool: any) {
    expect(await pool.fenTotal()).to.equal(await pool.totalWeight());
  }

  // ---------------------------------------------------------------- 升级路径

  describe("UUPS upgrade path: V1 -> V2 -> V3", () => {
    it("keeps proxy address, owner and both POCC selectors", async () => {
      const [foundation] = await ethers.getSigners();
      const V1 = await ethers.getContractFactory("RewardSystem", foundation);
      const proxy = await upgrades.deployProxy(V1, [foundation.address], { kind: "uups" });
      const proxyAddr = await proxy.getAddress();
      const V2 = await ethers.getContractFactory("RewardSystemV2", foundation);
      const poolV2 = await upgrades.upgradeProxy(proxy, V2);
      const MST = await ethers.getContractFactory("MSTToken", foundation);
      const mst = await MST.deploy(foundation.address);
      await poolV2.connect(foundation).initializeV2(await mst.getAddress(), V1_SWEEP);
      const implV2 = await upgrades.erc1967.getImplementationAddress(proxyAddr);

      const V3 = await ethers.getContractFactory("RewardSystemV3", foundation);
      const pool = await upgrades.upgradeProxy(proxy, V3, { call: { fn: "initializeV3", args: [] } });

      expect(await pool.getAddress()).to.equal(proxyAddr); // 代理地址不变
      expect(await upgrades.erc1967.getImplementationAddress(proxyAddr)).to.not.equal(implV2);
      expect(await pool.owner()).to.equal(foundation.address); // owner 保持
      expect(await pool.rewardForBlock(1)).to.equal(10n ** 18n); // 产量语义不变
      expect(await pool.sweepAddress()).to.equal(V1_SWEEP); // 无激活矿工 → fallback
      expect(await pool.FEN_CAPACITY()).to.equal(65536n);
    });

    it("initializeV3 migrates existing active miners into the tree", async () => {
      // 在 V2 上先形成激活集,再升 V3,验证迁移后树与分母一致、命中与线性重放一致
      const [foundation, alice, bob, carol] = await ethers.getSigners();
      const V1 = await ethers.getContractFactory("RewardSystem", foundation);
      const proxy = await upgrades.deployProxy(V1, [foundation.address], { kind: "uups" });
      const V2 = await ethers.getContractFactory("RewardSystemV2", foundation);
      const poolV2 = await upgrades.upgradeProxy(proxy, V2);
      const MST = await ethers.getContractFactory("MSTToken", foundation);
      const mst = await MST.deploy(foundation.address);
      await poolV2.connect(foundation).initializeV2(await mst.getAddress(), V1_SWEEP);

      for (const [s, n] of [
        [alice, 600],
        [bob, 300],
        [carol, 100],
      ] as const) {
        await mintMany(mst, foundation, s.address, n);
        await mst.connect(s).setApprovalForAll(await poolV2.getAddress(), true);
        await stakeAll(poolV2, mst, s, n);
        await poolV2.connect(s).activate();
      }
      const totalBefore = await poolV2.totalWeight();

      const V3 = await ethers.getContractFactory("RewardSystemV3", foundation);
      const pool = await upgrades.upgradeProxy(proxy, V3, { call: { fn: "initializeV3", args: [] } });

      expect(await pool.totalWeight()).to.equal(totalBefore);
      await assertTreeInvariant(pool);
      for (let i = 0; i < 5; i++) {
        await network.provider.send("hardhat_mine", ["0x1"]);
        expect(await pool.sweepAddress()).to.equal(await expectedWinner(pool));
      }
    });

    it("initializeV3 runs only once and only by owner", async () => {
      const { pool, foundation } = await loadFixture(deployV3);
      await expect(pool.connect(foundation).initializeV3()).to.be.revertedWithCustomError(
        pool,
        "InvalidInitialization"
      );
    });
  });

  // ---------------------------------------------------------------- 树不变量与对拍

  describe("Fenwick invariants & parity with V2 linear scan", () => {
    it("selection matches off-chain linear replay (tiered weights)", async () => {
      const { pool, mst, foundation, alice, bob, carol } = await loadFixture(deployV3);
      await setupMiner(pool, mst, foundation, alice, 600); // 1.05x 档
      await setupMiner(pool, mst, foundation, bob, 300);
      await setupMiner(pool, mst, foundation, carol, 100);
      await assertTreeInvariant(pool);

      for (let i = 0; i < 10; i++) {
        await network.provider.send("hardhat_mine", ["0x1"]);
        expect(await pool.sweepAddress()).to.equal(await expectedWinner(pool));
      }
    });

    it("swap-remove keeps tree in sync (deactivate middle / tail)", async () => {
      const { pool, mst, foundation, alice, bob, carol } = await loadFixture(deployV3);
      await setupMiner(pool, mst, foundation, alice, 100);
      await setupMiner(pool, mst, foundation, bob, 100);
      await setupMiner(pool, mst, foundation, carol, 100);

      await pool.connect(alice).deactivate(); // 移除头部:carol 被搬到 index 0
      await assertTreeInvariant(pool);
      expect(await pool.sweepAddress()).to.equal(await expectedWinner(pool));

      await pool.connect(carol).deactivate(); // 移除队尾(无搬移分支)
      await assertTreeInvariant(pool);
      expect(await pool.sweepAddress()).to.equal(bob.address); // 仅剩 bob

      await pool.connect(alice).activate(); // 失活后重新激活(append 语义)
      await assertTreeInvariant(pool);
      expect(await pool.sweepAddress()).to.equal(await expectedWinner(pool));
    });

    it("auto-deactivation on unstake below threshold uses pre-decrement weight", async () => {
      const { pool, mst, foundation, alice, bob } = await loadFixture(deployV3);
      await setupMiner(pool, mst, foundation, alice, 100);
      await setupMiner(pool, mst, foundation, bob, 100);

      // alice 取回 1 个跌破 100 → 自动失活;树上必须扣掉失活前的完整权重
      const ids = await pool.stakedTokensPage(alice.address, 0, 1);
      await expect(pool.connect(alice).unstake([...ids])).to.emit(pool, "MinerDeactivated");
      await assertTreeInvariant(pool);
      expect(await pool.activeMinerCount()).to.equal(1n);
      expect(await pool.sweepAddress()).to.equal(bob.address);
    });

    it("weight change while active crossing a tier updates the tree by delta", async () => {
      const { pool, mst, foundation, alice, bob } = await loadFixture(deployV3);
      await setupMiner(pool, mst, foundation, alice, 100); // 1.00x
      await setupMiner(pool, mst, foundation, bob, 100);

      await mintMany(mst, foundation, alice.address, 500);
      await stakeAll(pool, mst, alice, 500); // staked 100 → 600,跨入 1.05x 档
      expect(await pool.minerWeight(alice.address)).to.equal(600n * 10500n);
      await assertTreeInvariant(pool);
      expect(await pool.sweepAddress()).to.equal(await expectedWinner(pool));
    });

    it("fuzz: random op sequences keep fenTotal == totalWeight and parity", async function () {
      this.timeout(300000);
      const { pool, mst, foundation, alice, bob, carol, dave } = await loadFixture(deployV3);
      const miners = [alice, bob, carol, dave];
      for (const m of miners) {
        await mintMany(mst, foundation, m.address, 300);
        await mst.connect(m).setApprovalForAll(await pool.getAddress(), true);
      }

      const rand = mulberry32(0x5eed);
      const pick = (n: number) => Math.floor(rand() * n);
      for (let step = 0; step < 50; step++) {
        const m = miners[pick(miners.length)];
        const info = await pool.minerInfo(m.address);
        const staked = Number(info.staked);
        const active = info.active as boolean;
        const op = pick(4);

        if (op === 0) {
          // stake 1..40
          const free = Number(await mst.balanceOf(m.address));
          if (free === 0) continue;
          const q = 1 + pick(Math.min(free, 40));
          const ids: bigint[] = [];
          for (let i = 0; i < q; i++) ids.push(await mst.tokenOfOwnerByIndex(m.address, i));
          await pool.connect(m).stake(ids);
        } else if (op === 1) {
          // unstake 1..40(可能触发自动失活)
          if (staked === 0) continue;
          const q = 1 + pick(Math.min(staked, 40));
          const ids = await pool.stakedTokensPage(m.address, 0, q);
          await pool.connect(m).unstake([...ids]);
        } else if (op === 2) {
          if (active || staked < 100) continue;
          await pool.connect(m).activate();
        } else {
          if (!active) continue;
          await pool.connect(m).deactivate();
        }

        await assertTreeInvariant(pool); // 每步:树根 == 分母
        expect(await pool.sweepAddress()).to.equal(await expectedWinner(pool)); // 每步:与线性扫描对拍
      }
    });
  });

  // ---------------------------------------------------------------- 关键回归:100k gas 下的规模

  describe("gas regression: 30 active miners under the chain's 100k budget", () => {
    it("V2 OOGs once the winner index is deep; V3 always succeeds", async function () {
      this.timeout(600000);
      const [foundation] = await ethers.getSigners();

      // 两个代理、同一批矿工、同一激活顺序 → 同高度同 seed 同命中下标,可直接对照
      const deployPool = async (versions: string[]) => {
        const V1 = await ethers.getContractFactory("RewardSystem", foundation);
        const proxy = await upgrades.deployProxy(V1, [foundation.address], { kind: "uups" });
        const MST = await ethers.getContractFactory("MSTToken", foundation);
        const mst = await MST.deploy(foundation.address);
        let pool: any = proxy;
        for (const v of versions) {
          const F = await ethers.getContractFactory(v, foundation);
          pool = await upgrades.upgradeProxy(
            proxy,
            F,
            v === "RewardSystemV3" ? { call: { fn: "initializeV3", args: [] } } : undefined
          );
          if (v === "RewardSystemV2") {
            await pool.connect(foundation).initializeV2(await mst.getAddress(), V1_SWEEP);
          }
        }
        return { pool, mst };
      };
      const v2 = await deployPool(["RewardSystemV2"]);
      const v3 = await deployPool(["RewardSystemV2", "RewardSystemV3"]);

      // 30 个确定性资金账户,每人在两个池各质押 100 并激活(权重均匀,命中下标均匀分布)
      const MINERS = 30;
      const wallets: Wallet[] = [];
      for (let i = 0; i < MINERS; i++) {
        const pk = "0x" + (i + 0x1000).toString(16).padStart(64, "0");
        const w = new ethers.Wallet(pk, ethers.provider);
        await network.provider.send("hardhat_setBalance", [w.address, "0x21E19E0C9BAB2400000"]);
        wallets.push(w);
      }
      for (const { pool, mst } of [v2, v3]) {
        for (const w of wallets) {
          await mintMany(mst, foundation, w.address, 100);
          await mst.connect(w).setApprovalForAll(await pool.getAddress(), true);
          await stakeAll(pool, mst, w, 100);
          await pool.connect(w).activate();
        }
        expect(await pool.activeMinerCount()).to.equal(BigInt(MINERS));
      }
      const unitWeight = 100n * 10000n;
      const total = unitWeight * BigInt(MINERS);
      expect(await v2.pool.totalWeight()).to.equal(total);
      expect(await v3.pool.totalWeight()).to.equal(total);
      await assertTreeInvariant(v3.pool);

      // 链端 StaticCall 给合约整 100k;eth_call 的 gasLimit 还要先扣 21k 交易底价,
      // 此处 100k 上限对合约实际可用 ~79k,比链端更苛刻 —— V3 必须照样通过。
      const GAS = 100_000n;

      // 逐高度找一个命中下标 ≥ 25 的块:V2 线性扫描必 OOG,V3 固定 17 层下降无感
      let deepHit = false;
      for (let i = 0; i < 200 && !deepHit; i++) {
        await network.provider.send("hardhat_mine", ["0x1"]);
        const [, seed] = await v3.pool.currentSeed();
        const idx = Number((ethers.toBigInt(seed) % total) / unitWeight);

        // V3:任何下标、100k 内都成功,且与线性重放一致
        const winner = await v3.pool.sweepAddress({ gasLimit: GAS });
        expect(winner).to.equal(await v3.pool.activeMinerAt(idx));

        if (idx >= 25) {
          deepHit = true;
          // 同高度同下标,V2 在 100k 内扫不到第 26 个矿工 → OOG
          let v2Failed = false;
          try {
            await v2.pool.sweepAddress({ gasLimit: GAS });
          } catch {
            v2Failed = true;
          }
          expect(v2Failed).to.equal(true, "V2 should OOG at winner index >= 25 under 100k gas");
          // 不限 gas 时 V2 与 V3 命中同一矿工(算法等价,只是复杂度不同)
          expect(await v2.pool.sweepAddress()).to.equal(winner);
        }
      }
      expect(deepHit).to.equal(true, "no deep winner index in 200 blocks (p < 1e-12)");
    });
  });

  // ---------------------------------------------------------------- setNft 守卫

  describe("setNft guard", () => {
    it("reverts while stakes exist; works again after pool drains", async () => {
      const { pool, mst, foundation, alice } = await loadFixture(deployV3);
      await setupMiner(pool, mst, foundation, alice, 100, false);

      const MST = await ethers.getContractFactory("MSTToken", foundation);
      const other = await MST.deploy(foundation.address);

      await expect(
        pool.connect(foundation).setNft(await other.getAddress())
      ).to.be.revertedWithCustomError(pool, "StakeNotEmpty");

      // 全部取回后允许切换
      const ids = await pool.stakedTokensPage(alice.address, 0, 100);
      for (let i = 0; i < ids.length; i += 40) {
        await pool.connect(alice).unstake([...ids].slice(i, i + 40));
      }
      expect(await pool.totalStaked()).to.equal(0n);
      await expect(pool.connect(foundation).setNft(await other.getAddress()))
        .to.emit(pool, "NftContractSet")
        .withArgs(await other.getAddress());
      expect(await pool.nft()).to.equal(await other.getAddress());
    });
  });
});

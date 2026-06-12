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

/// 链下复算"已成熟"高度的命中（matured ⇒ deferred == live）：
/// 按永久位置顺序累加各位置的 live 有效权重（active 才计），与 sweepAddress 对拍。
async function maturedWinner(pool: any): Promise<string> {
  const total: bigint = await pool.selectionTotalWeight();
  if (total === 0n) return await pool.fallbackAddress();
  const [, seed] = await pool.currentSeed();
  const r = ethers.toBigInt(seed) % total;
  const used = Number(await pool.positionsUsed());
  let acc = 0n;
  for (let pos = 0; pos < used; pos++) {
    const m = await pool.positionMinerAt(pos);
    if (m === ethers.ZeroAddress) continue;
    const info = await pool.minerInfo(m);
    if (!info.active) continue;
    acc += info.weight as bigint;
    if (r < acc) return m;
  }
  throw new Error("matured replay fell through: deferred tree / total desync?");
}

function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe("RewardSystemV4 (deferred-effectiveness Fenwick)", () => {
  // 真链同款升级链路：V1 → V2 → V3 → V4（每步原子初始化）
  async function deployV4() {
    const [foundation, alice, bob, carol, dave] = await ethers.getSigners();
    const V1 = await ethers.getContractFactory("RewardSystem", foundation);
    const proxy = await upgrades.deployProxy(V1, [foundation.address], { kind: "uups" });
    const V2 = await ethers.getContractFactory("RewardSystemV2", foundation);
    const poolV2 = await upgrades.upgradeProxy(proxy, V2);
    const MST = await ethers.getContractFactory("MSTToken", foundation);
    const mst = await MST.deploy(foundation.address);
    await poolV2.connect(foundation).initializeV2(await mst.getAddress(), V1_SWEEP);
    const V3 = await ethers.getContractFactory("RewardSystemV3", foundation);
    await upgrades.upgradeProxy(proxy, V3, { call: { fn: "initializeV3", args: [] } });
    const V4 = await ethers.getContractFactory("RewardSystemV4", foundation);
    const pool = await upgrades.upgradeProxy(proxy, V4, { call: { fn: "initializeV4", args: [] } });
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

  // 树根 live 值 == 分母（eager 不变量）
  async function assertTreeInvariant(pool: any) {
    expect(await pool.fenTotal()).to.equal(await pool.totalWeight());
  }

  // ---------------------------------------------------------------- 升级路径

  describe("UUPS upgrade path: V1 -> V2 -> V3 -> V4", () => {
    it("keeps proxy address, owner and both POCC selectors", async () => {
      const { pool, foundation } = await loadFixture(deployV4);
      expect(await pool.owner()).to.equal(foundation.address);
      expect(await pool.rewardForBlock(1)).to.equal(10n ** 18n);
      expect(await pool.sweepAddress()).to.equal(V1_SWEEP); // 无激活矿工 → fallback
      expect(await pool.FEN_CAPACITY()).to.equal(65536n);
    });

    it("initializeV4 migrates existing active miners; selection matures one block after upgrade", async () => {
      const [foundation, alice, bob, carol] = await ethers.getSigners();
      const V1 = await ethers.getContractFactory("RewardSystem", foundation);
      const proxy = await upgrades.deployProxy(V1, [foundation.address], { kind: "uups" });
      const V2 = await ethers.getContractFactory("RewardSystemV2", foundation);
      const poolV2 = await upgrades.upgradeProxy(proxy, V2);
      const MST = await ethers.getContractFactory("MSTToken", foundation);
      const mst = await MST.deploy(foundation.address);
      await poolV2.connect(foundation).initializeV2(await mst.getAddress(), V1_SWEEP);
      const V3 = await ethers.getContractFactory("RewardSystemV3", foundation);
      const poolV3 = await upgrades.upgradeProxy(proxy, V3, { call: { fn: "initializeV3", args: [] } });
      for (const [s, n] of [
        [alice, 600],
        [bob, 300],
        [carol, 100],
      ] as const) {
        await mintMany(mst, foundation, s.address, n);
        await mst.connect(s).setApprovalForAll(await poolV3.getAddress(), true);
        await stakeAll(poolV3, mst, s, n);
        await poolV3.connect(s).activate();
      }
      const totalBefore = await poolV3.totalWeight();

      const V4 = await ethers.getContractFactory("RewardSystemV4", foundation);
      const pool = await upgrades.upgradeProxy(proxy, V4, { call: { fn: "initializeV4", args: [] } });

      expect(await pool.totalWeight()).to.equal(totalBefore); // live 分母搬迁无损
      await assertTreeInvariant(pool);
      expect(await pool.activeMinerCount()).to.equal(3n);

      // 迁移当块树节点 stamp=升级块 → 当块 selection 视为空 → fallback（与原子升级一致）
      // 推进一块后成熟，选择恢复正常并与复算一致
      await network.provider.send("hardhat_mine", ["0x1"]);
      expect(await pool.selectionTotalWeight()).to.equal(totalBefore);
      for (let i = 0; i < 5; i++) {
        await network.provider.send("hardhat_mine", ["0x1"]);
        expect(await pool.sweepAddress()).to.equal(await maturedWinner(pool));
      }
    });

    it("initializeV4 runs only once", async () => {
      const { pool, foundation } = await loadFixture(deployV4);
      await expect(pool.connect(foundation).initializeV4()).to.be.revertedWithCustomError(
        pool,
        "InvalidInitialization"
      );
    });
  });

  // ---------------------------------------------------------------- 核心：延迟一块生效（防质押时序操纵）

  describe("deferred effectiveness (anti stake-timing manipulation)", () => {
    it("a stake in block B does NOT change block B's selection denominator; matures at B+1", async () => {
      const { pool, mst, foundation, alice } = await loadFixture(deployV4);
      await setupMiner(pool, mst, foundation, alice, 100); // total 1,000,000
      await network.provider.send("hardhat_mine", ["0x1"]); // 成熟
      const before = await pool.totalWeight();
      expect(await pool.selectionTotalWeight()).to.equal(before);

      // alice 在【单笔交易=单个区块 B】内追加质押 40 → live 立刻变，
      // 但本块 selection 必须仍是旧值（延迟一块生效）
      await mintMany(mst, foundation, alice.address, 40);
      const freeIds: bigint[] = [];
      for (let i = 0; i < 40; i++) freeIds.push(await mst.tokenOfOwnerByIndex(alice.address, i));
      await pool.connect(alice).stake(freeIds); // 单笔 → 块 B
      const live = await pool.totalWeight();
      expect(live).to.equal(140n * 10000n); // live 已是 140 个的权重
      expect(await pool.selectionTotalWeight()).to.equal(before); // 本块 selection 仍是 100 个

      await network.provider.send("hardhat_mine", ["0x1"]); // 过一块成熟
      expect(await pool.selectionTotalWeight()).to.equal(live);
    });

    it("winner cannot be flipped within the same block; flips only next block", async () => {
      const { pool, mst, foundation, alice, bob } = await loadFixture(deployV4);
      await setupMiner(pool, mst, foundation, alice, 100); // 唯一激活 → 恒胜
      await network.provider.send("hardhat_mine", ["0x1"]);
      expect(await pool.sweepAddress()).to.equal(alice.address);

      // bob 先把 NFT 备好（这些不影响激活集）
      await mintMany(mst, foundation, bob.address, 100);
      await mst.connect(bob).setApprovalForAll(await pool.getAddress(), true);
      await stakeAll(pool, mst, bob, 100);

      // 关键一块：alice 失活 + bob 激活 同块发生
      await network.provider.send("evm_setAutomine", [false]);
      await pool.connect(alice).deactivate();
      await pool.connect(bob).activate();
      await network.provider.send("evm_mine", []); // 两笔进同一块 B
      await network.provider.send("evm_setAutomine", [true]);

      // 本块 B：deferred 仍看到旧激活集（alice 在、bob 不在）→ 赢家仍是 alice
      expect(await pool.sweepAddress()).to.equal(alice.address);
      // 下一块 B+1：成熟 → bob 成为唯一激活 → 赢家变 bob
      await network.provider.send("hardhat_mine", ["0x1"]);
      expect(await pool.sweepAddress()).to.equal(bob.address);
    });

    it("idle maturation: change matures with no further tx", async () => {
      const { pool, mst, foundation, alice } = await loadFixture(deployV4);
      await setupMiner(pool, mst, foundation, alice, 100);
      await mintMany(mst, foundation, alice.address, 500);
      await stakeAll(pool, mst, alice, 500); // 100→600，跨 1.05x 档
      const live = await pool.totalWeight();
      expect(live).to.equal(600n * 10500n);
      // 多个空块（无任何池子交易），selection 仍应自动成熟为新值并保持
      for (let i = 0; i < 4; i++) {
        await network.provider.send("hardhat_mine", ["0x1"]);
        expect(await pool.selectionTotalWeight()).to.equal(live);
      }
    });
  });

  // ---------------------------------------------------------------- 永久位置（无 swap-remove 错位）

  describe("permanent positions (no swap-remove desync)", () => {
    it("deactivating a middle miner never desyncs; reactivation reuses position", async () => {
      const { pool, mst, foundation, alice, bob, carol } = await loadFixture(deployV4);
      await setupMiner(pool, mst, foundation, alice, 100);
      await setupMiner(pool, mst, foundation, bob, 100);
      await setupMiner(pool, mst, foundation, carol, 100);
      const usedBefore = await pool.positionsUsed();
      expect(usedBefore).to.equal(3n);

      await pool.connect(bob).deactivate(); // 中间失活
      await network.provider.send("hardhat_mine", ["0x1"]); // 成熟
      await assertTreeInvariant(pool);
      expect(await pool.activeMinerCount()).to.equal(2n);
      // 多块采样：永不命中已失活的 bob，永不 revert
      for (let i = 0; i < 8; i++) {
        await network.provider.send("hardhat_mine", ["0x1"]);
        const w = await pool.sweepAddress();
        expect(w).to.not.equal(bob.address);
        expect([alice.address, carol.address]).to.include(w);
        expect(w).to.equal(await maturedWinner(pool));
      }

      // bob 重新激活：复用原位置，positionsUsed 不增长
      await pool.connect(bob).activate();
      expect(await pool.positionsUsed()).to.equal(usedBefore);
      await network.provider.send("hardhat_mine", ["0x1"]);
      await assertTreeInvariant(pool);
      expect(await pool.activeMinerCount()).to.equal(3n);
    });

    it("auto-deactivation on unstake below threshold keeps tree consistent", async () => {
      const { pool, mst, foundation, alice, bob } = await loadFixture(deployV4);
      await setupMiner(pool, mst, foundation, alice, 100);
      await setupMiner(pool, mst, foundation, bob, 100);

      const ids = await pool.stakedTokensPage(alice.address, 0, 1);
      await expect(pool.connect(alice).unstake([...ids])).to.emit(pool, "MinerDeactivated");
      await network.provider.send("hardhat_mine", ["0x1"]);
      await assertTreeInvariant(pool);
      expect(await pool.activeMinerCount()).to.equal(1n);
      expect(await pool.sweepAddress()).to.equal(bob.address);
    });
  });

  // ---------------------------------------------------------------- 段位数学（自 V2 起不变）

  describe("tier math unchanged", () => {
    it("multiplier + weight boundaries", async () => {
      const { pool } = await loadFixture(deployV4);
      expect(await pool.multiplierBpsFor(599)).to.equal(10000n);
      expect(await pool.multiplierBpsFor(600)).to.equal(10500n);
      expect(await pool.multiplierBpsFor(6000)).to.equal(11500n);
      expect(await pool.weightFor(5900)).to.equal(5900n * 10500n);
      expect(await pool.weightFor(6000)).to.equal(6000n * 11500n);
    });
  });

  // ---------------------------------------------------------------- fuzz：成熟后与线性复算一致 + 树不变量

  describe("fuzz: invariants hold and matured selection matches replay", () => {
    it("random op sequences keep fenTotal==totalWeight; matured sweep matches replay", async function () {
      this.timeout(300000);
      const { pool, mst, foundation, alice, bob, carol, dave } = await loadFixture(deployV4);
      const miners = [alice, bob, carol, dave];
      for (const m of miners) {
        await mintMany(mst, foundation, m.address, 300);
        await mst.connect(m).setApprovalForAll(await pool.getAddress(), true);
      }
      const rand = mulberry32(0x5eed);
      const pick = (n: number) => Math.floor(rand() * n);

      for (let step = 0; step < 40; step++) {
        const m = miners[pick(miners.length)];
        const info = await pool.minerInfo(m.address);
        const staked = Number(info.staked);
        const active = info.active as boolean;
        const op = pick(4);

        if (op === 0) {
          const free = Number(await mst.balanceOf(m.address));
          if (free === 0) continue;
          const q = 1 + pick(Math.min(free, 40));
          const ids: bigint[] = [];
          for (let i = 0; i < q; i++) ids.push(await mst.tokenOfOwnerByIndex(m.address, i));
          await pool.connect(m).stake(ids);
        } else if (op === 1) {
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

        await assertTreeInvariant(pool); // 每步 live 不变量
        await network.provider.send("hardhat_mine", ["0x1"]); // 成熟后再对拍
        expect(await pool.sweepAddress()).to.equal(await maturedWinner(pool));
      }
    });
  });

  // ---------------------------------------------------------------- gas：100k 预算下深命中仍成功

  describe("gas: deferred sweep stays within the chain's 100k StaticCall budget", () => {
    it("30 active miners, deep winner index still resolves under 100k", async function () {
      this.timeout(600000);
      const { pool, mst, foundation } = await loadFixture(deployV4);
      const MINERS = 30;
      const wallets: Wallet[] = [];
      for (let i = 0; i < MINERS; i++) {
        const pk = "0x" + (i + 0x4000).toString(16).padStart(64, "0");
        const w = new ethers.Wallet(pk, ethers.provider);
        await network.provider.send("hardhat_setBalance", [w.address, "0x21E19E0C9BAB2400000"]);
        wallets.push(w);
      }
      for (const w of wallets) {
        await mintMany(mst, foundation, w.address, 100);
        await mst.connect(w).setApprovalForAll(await pool.getAddress(), true);
        await stakeAll(pool, mst, w, 100);
        await pool.connect(w).activate();
      }
      const unitWeight = 100n * 10000n;
      const total = unitWeight * BigInt(MINERS);
      expect(await pool.totalWeight()).to.equal(total);
      await network.provider.send("hardhat_mine", ["0x1"]); // 成熟

      const GAS = 100_000n;
      let deepHit = false;
      for (let i = 0; i < 200 && !deepHit; i++) {
        await network.provider.send("hardhat_mine", ["0x1"]);
        const [, seed] = await pool.currentSeed();
        const idx = Number((ethers.toBigInt(seed) % total) / unitWeight);
        const winner = await pool.sweepAddress({ gasLimit: GAS }); // 100k 内必成功
        expect(winner).to.equal(await pool.positionMinerAt(idx));
        if (idx >= 25) deepHit = true;
      }
      expect(deepHit).to.equal(true, "no deep winner index in 200 blocks");
    });
  });
});

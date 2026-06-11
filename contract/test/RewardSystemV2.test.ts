import { expect } from "chai";
import { ethers, upgrades, network } from "hardhat";
import { loadFixture } from "@nomicfoundation/hardhat-toolbox/network-helpers";
import type { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

const V1_SWEEP = "0x281F73d00751aEb5f64e76c8B9137d3AA8499762";
const SCALE = 10000n;

/** 分块铸造（每笔 ≤100，贴合区块 gas 上限） */
async function mintMany(mst: any, foundation: HardhatEthersSigner, to: string, quantity: number) {
  let left = quantity;
  while (left > 0) {
    const n = Math.min(left, 100);
    await mst.connect(foundation).mint(to, n);
    left -= n;
  }
}

/** 取某地址持有的前 n 个 tokenId */
async function tokensOf(mst: any, owner: string, n: number): Promise<bigint[]> {
  const ids: bigint[] = [];
  for (let i = 0; i < n; i++) ids.push(await mst.tokenOfOwnerByIndex(owner, i));
  return ids;
}

async function stakeN(pool: any, mst: any, miner: HardhatEthersSigner, n: number) {
  // 单笔 ≤100，贴合区块 gas 上限（与铸造、前端同口径）
  const ids = await tokensOf(mst, miner.address, n);
  for (let i = 0; i < ids.length; i += 100) {
    await pool.connect(miner).stake(ids.slice(i, i + 100));
  }
  return ids;
}

describe("RewardSystemV2", () => {
  async function deploy() {
    const [foundation, alice, bob, carol] = await ethers.getSigners();
    // 与真链同路径：V1 代理 → 升级 V2
    const V1 = await ethers.getContractFactory("RewardSystem", foundation);
    const proxy = await upgrades.deployProxy(V1, [foundation.address], { kind: "uups" });
    const V2 = await ethers.getContractFactory("RewardSystemV2", foundation);
    const pool = await upgrades.upgradeProxy(proxy, V2);

    const MST = await ethers.getContractFactory("MSTToken", foundation);
    const mst = await MST.deploy(foundation.address);
    await pool.connect(foundation).initializeV2(await mst.getAddress(), V1_SWEEP);

    // 铸 NFT：alice 700, bob 300, carol 120
    await mintMany(mst, foundation, alice.address, 700);
    await mintMany(mst, foundation, bob.address, 300);
    await mintMany(mst, foundation, carol.address, 120);
    for (const s of [alice, bob, carol]) {
      await mst.connect(s).setApprovalForAll(await pool.getAddress(), true);
    }
    return { pool, mst, foundation, alice, bob, carol };
  }

  describe("tier math (pure)", () => {
    it("multiplier boundaries", async () => {
      const { pool } = await loadFixture(deploy);
      expect(await pool.multiplierBpsFor(0)).to.equal(10000n);
      expect(await pool.multiplierBpsFor(99)).to.equal(10000n);
      expect(await pool.multiplierBpsFor(100)).to.equal(10000n);
      expect(await pool.multiplierBpsFor(599)).to.equal(10000n);
      expect(await pool.multiplierBpsFor(600)).to.equal(10500n);
      expect(await pool.multiplierBpsFor(5999)).to.equal(10500n);
      expect(await pool.multiplierBpsFor(6000)).to.equal(11500n);
      expect(await pool.multiplierBpsFor(60000)).to.equal(11500n);
    });

    it("weightFor matches spec examples (CU x WEIGHT_SCALE)", async () => {
      const { pool } = await loadFixture(deploy);
      expect(await pool.WEIGHT_SCALE()).to.equal(SCALE);
      expect(await pool.weightFor(100)).to.equal(100n * 10000n); // 100.0000 CU
      expect(await pool.weightFor(5900)).to.equal(5900n * 10500n); // 6195 CU
      expect(await pool.weightFor(6000)).to.equal(6000n * 11500n); // 6900 CU
    });
  });

  describe("stake", () => {
    it("transfers NFTs in, records staker and tokens", async () => {
      const { pool, mst, carol } = await loadFixture(deploy);
      const ids = await stakeN(pool, mst, carol, 5);
      expect(await mst.balanceOf(await pool.getAddress())).to.equal(5n);
      const info = await pool.minerInfo(carol.address);
      expect(info.staked).to.equal(5n);
      expect(info.active).to.equal(false);
      for (const id of ids) expect(await pool.stakerOf(id)).to.equal(carol.address);
      const page = await pool.stakedTokensPage(carol.address, 0, 10);
      expect(page.map((x: bigint) => x)).to.deep.equal(ids);
      expect(await pool.minerCount()).to.equal(1n);
      expect(await pool.minerAt(0)).to.equal(carol.address);
    });

    it("emits Staked with indexed miner and token ids", async () => {
      const { pool, mst, carol } = await loadFixture(deploy);
      const ids = await tokensOf(mst, carol.address, 2);
      await expect(pool.connect(carol).stake(ids))
        .to.emit(pool, "Staked")
        .withArgs(carol.address, 2n, 2n, ids);
    });

    it("reverts when staking someone else's token", async () => {
      const { pool, mst, alice, carol } = await loadFixture(deploy);
      const aliceToken = await mst.tokenOfOwnerByIndex(alice.address, 0);
      await expect(pool.connect(carol).stake([aliceToken])).to.be.reverted; // ERC721IncorrectOwner
    });

    it("reverts on empty array", async () => {
      const { pool, carol } = await loadFixture(deploy);
      await expect(pool.connect(carol).stake([])).to.be.revertedWithCustomError(pool, "EmptyTokenList");
    });
  });

  describe("activate", () => {
    it("reverts below threshold of 100", async () => {
      const { pool, mst, carol } = await loadFixture(deploy);
      await stakeN(pool, mst, carol, 99);
      await expect(pool.connect(carol).activate()).to.be.revertedWithCustomError(
        pool,
        "BelowActivationThreshold"
      );
    });

    it("activates at exactly 100 and counts weight", async () => {
      const { pool, mst, carol } = await loadFixture(deploy);
      await stakeN(pool, mst, carol, 100);
      await expect(pool.connect(carol).activate())
        .to.emit(pool, "MinerActivated")
        .withArgs(carol.address, 100n, 100n * 10000n);
      expect(await pool.totalWeight()).to.equal(1_000_000n);
      expect(await pool.activeMinerCount()).to.equal(1n);
      expect(await pool.activeMinerAt(0)).to.equal(carol.address);
      const info = await pool.minerInfo(carol.address);
      expect(info.active).to.equal(true);
      expect(info.multiplierBps).to.equal(10000n);
      expect(info.weight).to.equal(1_000_000n);
    });

    it("reverts when already active", async () => {
      const { pool, mst, carol } = await loadFixture(deploy);
      await stakeN(pool, mst, carol, 100);
      await pool.connect(carol).activate();
      await expect(pool.connect(carol).activate()).to.be.revertedWithCustomError(pool, "AlreadyActive");
    });

    it("tier-2 miner weight at 600 staked", async () => {
      const { pool, mst, alice } = await loadFixture(deploy);
      await stakeN(pool, mst, alice, 600);
      await pool.connect(alice).activate();
      expect(await pool.totalWeight()).to.equal(600n * 10500n); // 6,300,000
    });

    it("staking more while active updates totalWeight across tier boundary", async () => {
      const { pool, mst, alice } = await loadFixture(deploy);
      await stakeN(pool, mst, alice, 599);
      await pool.connect(alice).activate();
      expect(await pool.totalWeight()).to.equal(599n * 10000n);
      await stakeN(pool, mst, alice, 1); // 600 → tier 1.05x
      expect(await pool.totalWeight()).to.equal(600n * 10500n);
    });
  });

  describe("unstake", () => {
    it("returns own tokens and clears staker", async () => {
      const { pool, mst, carol } = await loadFixture(deploy);
      const ids = await stakeN(pool, mst, carol, 5);
      await expect(pool.connect(carol).unstake([ids[0], ids[1]]))
        .to.emit(pool, "Unstaked")
        .withArgs(carol.address, 2n, 3n, [ids[0], ids[1]]);
      expect(await mst.ownerOf(ids[0])).to.equal(carol.address);
      expect(await pool.stakerOf(ids[0])).to.equal(ethers.ZeroAddress);
      expect((await pool.minerInfo(carol.address)).staked).to.equal(3n);
    });

    it("reverts for tokens staked by someone else", async () => {
      const { pool, mst, alice, carol } = await loadFixture(deploy);
      const aliceIds = await stakeN(pool, mst, alice, 1);
      await stakeN(pool, mst, carol, 1);
      await expect(pool.connect(carol).unstake([aliceIds[0]])).to.be.revertedWithCustomError(
        pool,
        "NotTokenStaker"
      );
    });

    it("auto-deactivates when active miner drops below 100", async () => {
      const { pool, mst, carol } = await loadFixture(deploy);
      const ids = await stakeN(pool, mst, carol, 100);
      await pool.connect(carol).activate();
      await expect(pool.connect(carol).unstake([ids[0]]))
        .to.emit(pool, "MinerDeactivated")
        .withArgs(carol.address, 99n);
      expect(await pool.totalWeight()).to.equal(0n);
      expect(await pool.activeMinerCount()).to.equal(0n);
      expect((await pool.minerInfo(carol.address)).active).to.equal(false);
    });

    it("keeps active status when staying >= 100", async () => {
      const { pool, mst, carol } = await loadFixture(deploy);
      const ids = await stakeN(pool, mst, carol, 101);
      await pool.connect(carol).activate();
      await pool.connect(carol).unstake([ids[0]]);
      expect((await pool.minerInfo(carol.address)).active).to.equal(true);
      expect(await pool.totalWeight()).to.equal(100n * 10000n);
    });

    it("removes miner from list when staked reaches 0", async () => {
      const { pool, mst, bob, carol } = await loadFixture(deploy);
      const carolIds = await stakeN(pool, mst, carol, 2);
      await stakeN(pool, mst, bob, 3);
      expect(await pool.minerCount()).to.equal(2n);
      await pool.connect(carol).unstake(carolIds);
      expect(await pool.minerCount()).to.equal(1n);
      expect(await pool.minerAt(0)).to.equal(bob.address);
      expect((await pool.minerInfo(carol.address)).staked).to.equal(0n);
    });
  });

  describe("deactivate / reactivate", () => {
    it("voluntary deactivate keeps stake, removes weight", async () => {
      const { pool, mst, carol } = await loadFixture(deploy);
      await stakeN(pool, mst, carol, 100);
      await pool.connect(carol).activate();
      await expect(pool.connect(carol).deactivate())
        .to.emit(pool, "MinerDeactivated")
        .withArgs(carol.address, 100n);
      expect(await pool.totalWeight()).to.equal(0n);
      expect((await pool.minerInfo(carol.address)).staked).to.equal(100n);
      await pool.connect(carol).activate(); // can re-activate
      expect(await pool.totalWeight()).to.equal(1_000_000n);
    });

    it("deactivate reverts when not active", async () => {
      const { pool, carol } = await loadFixture(deploy);
      await expect(pool.connect(carol).deactivate()).to.be.revertedWithCustomError(pool, "NotActive");
    });
  });

  describe("views", () => {
    it("activeMinersPage paginates", async () => {
      const { pool, mst, alice, bob, carol } = await loadFixture(deploy);
      await stakeN(pool, mst, alice, 600);
      await stakeN(pool, mst, bob, 300);
      await stakeN(pool, mst, carol, 100);
      await pool.connect(alice).activate();
      await pool.connect(bob).activate();
      await pool.connect(carol).activate();
      const page1 = await pool.activeMinersPage(0, 2);
      const page2 = await pool.activeMinersPage(2, 2);
      expect(page1.length).to.equal(2);
      expect(page2.length).to.equal(1);
      const all = [...page1, ...page2];
      expect(new Set(all).size).to.equal(3);
      expect(await pool.totalWeight()).to.equal(600n * 10500n + 300n * 10000n + 100n * 10000n);
    });

    it("minerWeight reflects potential weight even when inactive", async () => {
      const { pool, mst, carol } = await loadFixture(deploy);
      await stakeN(pool, mst, carol, 100);
      expect(await pool.minerWeight(carol.address)).to.equal(1_000_000n);
      expect(await pool.totalWeight()).to.equal(0n); // not active yet
    });
  });
});

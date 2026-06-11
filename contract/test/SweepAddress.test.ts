import { expect } from "chai";
import { ethers, upgrades, network } from "hardhat";
import { loadFixture } from "@nomicfoundation/hardhat-toolbox/network-helpers";
import type { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

const V1_SWEEP = "0x281F73d00751aEb5f64e76c8B9137d3AA8499762";

async function mintMany(mst: any, foundation: HardhatEthersSigner, to: string, quantity: number) {
  let left = quantity;
  while (left > 0) {
    const n = Math.min(left, 80);
    await mst.connect(foundation).mint(to, n);
    left -= n;
  }
}

async function stakeAll(pool: any, mst: any, miner: HardhatEthersSigner, n: number) {
  const ids: bigint[] = [];
  for (let i = 0; i < n; i++) ids.push(await mst.tokenOfOwnerByIndex(miner.address, i));
  for (let i = 0; i < ids.length; i += 40) {
    await pool.connect(miner).stake(ids.slice(i, i + 40));
  }
}

describe("RewardSystemV2.sweepAddress (POCC selection)", () => {
  async function deployBase() {
    const [foundation, alice, bob, carol] = await ethers.getSigners();
    const V1 = await ethers.getContractFactory("RewardSystem", foundation);
    const proxy = await upgrades.deployProxy(V1, [foundation.address], { kind: "uups" });
    const V2 = await ethers.getContractFactory("RewardSystemV2", foundation);
    const pool = await upgrades.upgradeProxy(proxy, V2);
    const MST = await ethers.getContractFactory("MSTToken", foundation);
    const mst = await MST.deploy(foundation.address);
    await pool.connect(foundation).initializeV2(await mst.getAddress(), V1_SWEEP);
    return { pool, mst, foundation, alice, bob, carol };
  }

  it("returns fallback (V1 hardcoded sweep) when no active miners", async () => {
    const { pool } = await loadFixture(deployBase);
    expect(await pool.sweepAddress()).to.equal(V1_SWEEP);
    expect(await pool.fallbackAddress()).to.equal(V1_SWEEP);
  });

  it("returns fallback when miners staked but none activated", async () => {
    const { pool, mst, foundation, carol } = await loadFixture(deployBase);
    await mintMany(mst, foundation, carol.address, 120);
    await mst.connect(carol).setApprovalForAll(await pool.getAddress(), true);
    await stakeAll(pool, mst, carol, 120);
    expect(await pool.sweepAddress()).to.equal(V1_SWEEP);
  });

  it("single active miner always wins", async () => {
    const { pool, mst, foundation, carol } = await loadFixture(deployBase);
    await mintMany(mst, foundation, carol.address, 100);
    await mst.connect(carol).setApprovalForAll(await pool.getAddress(), true);
    await stakeAll(pool, mst, carol, 100);
    await pool.connect(carol).activate();
    for (let i = 0; i < 5; i++) {
      await network.provider.send("hardhat_mine", ["0x1"]);
      expect(await pool.sweepAddress()).to.equal(carol.address);
    }
  });

  it("is deterministic within the same block height", async () => {
    const { pool, mst, foundation, alice, bob } = await loadFixture(deployBase);
    for (const [s, n] of [
      [alice, 100],
      [bob, 100],
    ] as const) {
      await mintMany(mst, foundation, s.address, n);
      await mst.connect(s).setApprovalForAll(await pool.getAddress(), true);
      await stakeAll(pool, mst, s, n);
      await pool.connect(s).activate();
    }
    const a = await pool.sweepAddress();
    const b = await pool.sweepAddress();
    const c = await pool.sweepAddress();
    expect(a).to.equal(b);
    expect(b).to.equal(c);
  });

  it("currentSeed = keccak(blockNumber ++ blockhash(n-1)) at current height", async () => {
    const { pool } = await loadFixture(deployBase);
    const [height, seed] = await pool.currentSeed();
    const block = await ethers.provider.getBlock(Number(height) - 1);
    const expected = ethers.keccak256(
      ethers.solidityPacked(["uint256", "bytes32"], [height, block!.hash!])
    );
    expect(seed).to.equal(expected);
  });

  it("selection matches off-chain replay of the formula", async () => {
    const { pool, mst, foundation, alice, bob, carol } = await loadFixture(deployBase);
    const counts: [HardhatEthersSigner, number][] = [
      [alice, 600],
      [bob, 300],
      [carol, 100],
    ];
    for (const [s, n] of counts) {
      await mintMany(mst, foundation, s.address, n);
      await mst.connect(s).setApprovalForAll(await pool.getAddress(), true);
      await stakeAll(pool, mst, s, n);
      await pool.connect(s).activate();
    }
    // 链下复算：与合约同公式
    const weights = new Map<string, bigint>([
      [alice.address, 600n * 10500n],
      [bob.address, 300n * 10000n],
      [carol.address, 100n * 10000n],
    ]);
    const total = 600n * 10500n + 300n * 10000n + 100n * 10000n;
    expect(await pool.totalWeight()).to.equal(total);

    for (let i = 0; i < 10; i++) {
      await network.provider.send("hardhat_mine", ["0x1"]);
      const [, seed] = await pool.currentSeed();
      const r = ethers.toBigInt(seed) % total;
      // activeList 顺序：activate 顺序 = alice, bob, carol
      let acc = 0n;
      let expectedWinner = "";
      for (const addr of [alice.address, bob.address, carol.address]) {
        acc += weights.get(addr)!;
        if (r < acc) {
          expectedWinner = addr;
          break;
        }
      }
      expect(await pool.sweepAddress()).to.equal(expectedWinner);
    }
  });

  it("distribution over many blocks approximates weight share", async function () {
    this.timeout(300000);
    const { pool, mst, foundation, alice, bob, carol } = await loadFixture(deployBase);
    const counts: [HardhatEthersSigner, number][] = [
      [alice, 600], // weight 6,300,000 → 61.2%
      [bob, 300], //  weight 3,000,000 → 29.1%
      [carol, 100], // weight 1,000,000 →  9.7%
    ];
    for (const [s, n] of counts) {
      await mintMany(mst, foundation, s.address, n);
      await mst.connect(s).setApprovalForAll(await pool.getAddress(), true);
      await stakeAll(pool, mst, s, n);
      await pool.connect(s).activate();
    }
    const tally = new Map<string, number>();
    const SAMPLES = 300;
    for (let i = 0; i < SAMPLES; i++) {
      await network.provider.send("hardhat_mine", ["0x1"]);
      const w = (await pool.sweepAddress()) as string;
      tally.set(w, (tally.get(w) ?? 0) + 1);
    }
    const share = (a: string) => (tally.get(a) ?? 0) / SAMPLES;
    // 理论占比 61.2% / 29.1% / 9.7%，±10 个百分点容差
    expect(share(alice.address)).to.be.closeTo(0.612, 0.1);
    expect(share(bob.address)).to.be.closeTo(0.291, 0.1);
    expect(share(carol.address)).to.be.closeTo(0.097, 0.1);
    // 全部命中均为激活矿工
    expect((tally.get(alice.address) ?? 0) + (tally.get(bob.address) ?? 0) + (tally.get(carol.address) ?? 0)).to.equal(
      SAMPLES
    );
  });

  it("weight dominance: heavier miner wins more often", async function () {
    this.timeout(300000);
    const { pool, mst, foundation, alice, carol } = await loadFixture(deployBase);
    for (const [s, n] of [
      [alice, 600],
      [carol, 100],
    ] as const) {
      await mintMany(mst, foundation, s.address, n);
      await mst.connect(s).setApprovalForAll(await pool.getAddress(), true);
      await stakeAll(pool, mst, s, n);
      await pool.connect(s).activate();
    }
    let aliceWins = 0;
    for (let i = 0; i < 100; i++) {
      await network.provider.send("hardhat_mine", ["0x1"]);
      if ((await pool.sweepAddress()) === alice.address) aliceWins++;
    }
    expect(aliceWins).to.be.greaterThan(60); // 理论 86.3%
  });
});

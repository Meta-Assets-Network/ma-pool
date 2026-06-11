import { expect } from "chai";
import { ethers, upgrades } from "hardhat";
import { loadFixture } from "@nomicfoundation/hardhat-toolbox/network-helpers";

const V1_SWEEP = "0x281F73d00751aEb5f64e76c8B9137d3AA8499762";

describe("UUPS upgrade path: RewardSystem(V1) -> RewardSystemV2", () => {
  async function deployV1() {
    const [foundation, miner, stranger] = await ethers.getSigners();
    const V1 = await ethers.getContractFactory("RewardSystem", foundation);
    const proxy = await upgrades.deployProxy(V1, [foundation.address], { kind: "uups" });
    return { proxy, foundation, miner, stranger };
  }

  it("V1 behaves like the on-chain contract", async () => {
    const { proxy, foundation } = await loadFixture(deployV1);
    expect(await proxy.rewardForBlock(12345)).to.equal(10n ** 18n);
    expect(await proxy.sweepAddress()).to.equal(V1_SWEEP);
    expect(await proxy.owner()).to.equal(foundation.address);
  });

  it("upgrade keeps proxy address and owner; selectors keep working", async () => {
    const { proxy, foundation } = await loadFixture(deployV1);
    const proxyAddr = await proxy.getAddress();
    const implV1 = await upgrades.erc1967.getImplementationAddress(proxyAddr);

    const V2 = await ethers.getContractFactory("RewardSystemV2", foundation);
    const pool = await upgrades.upgradeProxy(proxy, V2);

    expect(await pool.getAddress()).to.equal(proxyAddr); // 代理地址不变
    const implV2 = await upgrades.erc1967.getImplementationAddress(proxyAddr);
    expect(implV2).to.not.equal(implV1); // 实现已替换
    expect(await pool.owner()).to.equal(foundation.address); // owner 保持

    // 升级后、initializeV2 前：两个 POCC 接口可用，sweep 走 fallback=0 之前为未配置
    expect(await pool.rewardForBlock(1)).to.equal(10n ** 18n); // 语义保持
    expect(await pool.sweepAddress()).to.equal(ethers.ZeroAddress); // totalWeight=0 且 fallback 未配置
  });

  it("initializeV2 wires nft + fallback, only once, only owner", async () => {
    const { proxy, foundation, stranger } = await loadFixture(deployV1);
    const V2 = await ethers.getContractFactory("RewardSystemV2", foundation);
    const pool = await upgrades.upgradeProxy(proxy, V2);

    const MST = await ethers.getContractFactory("MSTToken", foundation);
    const mst = await MST.deploy(foundation.address);

    await expect(pool.connect(foundation).initializeV2(await mst.getAddress(), V1_SWEEP))
      .to.emit(pool, "NftContractSet")
      .and.to.emit(pool, "FallbackAddressSet");

    expect(await pool.nft()).to.equal(await mst.getAddress());
    expect(await pool.sweepAddress()).to.equal(V1_SWEEP); // 无激活矿工 → fallback = V1 行为

    // reinitializer(2) 只能执行一次
    await expect(
      pool.connect(foundation).initializeV2(await mst.getAddress(), V1_SWEEP)
    ).to.be.revertedWithCustomError(pool, "InvalidInitialization");
  });

  it("non-owner cannot upgrade", async () => {
    const { proxy, stranger } = await loadFixture(deployV1);
    const V2bad = await ethers.getContractFactory("RewardSystemV2", stranger);
    let failed = false;
    try {
      await upgrades.upgradeProxy(proxy, V2bad);
    } catch {
      failed = true; // OwnableUnauthorizedAccount via _authorizeUpgrade
    }
    expect(failed).to.equal(true);
  });

  it("full life-cycle after upgrade: stake -> activate -> dynamic sweep", async () => {
    const { proxy, foundation, miner } = await loadFixture(deployV1);
    const V2 = await ethers.getContractFactory("RewardSystemV2", foundation);
    const pool = await upgrades.upgradeProxy(proxy, V2);
    const MST = await ethers.getContractFactory("MSTToken", foundation);
    const mst = await MST.deploy(foundation.address);
    await pool.connect(foundation).initializeV2(await mst.getAddress(), V1_SWEEP);

    await mst.connect(foundation).mint(miner.address, 100);
    await mst.connect(miner).setApprovalForAll(await pool.getAddress(), true);
    const ids: bigint[] = [];
    for (let i = 0; i < 100; i++) ids.push(await mst.tokenOfOwnerByIndex(miner.address, i));
    await pool.connect(miner).stake(ids);
    await pool.connect(miner).activate();

    expect(await pool.sweepAddress()).to.equal(miner.address); // 唯一激活矿工
    expect(await pool.rewardForBlock(999999)).to.equal(10n ** 18n); // 奖励不变
  });
});

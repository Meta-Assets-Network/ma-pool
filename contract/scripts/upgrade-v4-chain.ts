/**
 * 真链（Meta Assets Chain, chainId 20260131）V3 → V4 升级脚本。
 *
 * V4 = 延迟一块生效（防"质押时序操纵"，安全审计 C-1 路径 3）。纯合约升级：
 * 代理地址不变、owner 不变、`rewardForBlock`/`sweepAddress` 两个 selector 不变，链端零改动。
 *
 * 用法：
 *   export OWNER_KEY=<基金会 owner 私钥>
 *   export PROXY_ADDRESS=<链上 RewardSystem UUPS 代理地址>
 *   npx hardhat run scripts/upgrade-v4-chain.ts --network machain
 *
 * 升级与 initializeV4 在同一笔交易内完成（upgradeProxy 的 call 选项），避免出现
 * "实现已换、状态未迁移"的中间区块。注意：升级所在区块当块，selection 因迁移节点
 * stamp=升级块而读到 0 → 链端回退 HardcodedSweepFallback；下一块自动成熟恢复。
 */
import { ethers, upgrades } from "hardhat";
import type { RewardSystemV4 } from "../typechain-types";

async function main() {
  const proxyAddress = process.env.PROXY_ADDRESS;
  if (!proxyAddress) throw new Error("PROXY_ADDRESS is required");

  const [owner] = await ethers.getSigners();
  if (!owner) throw new Error("OWNER_KEY is required (hardhat.config networks.machain.accounts)");
  console.log("upgrading V3 -> V4 with owner:", owner.address);

  // 没有本地升级清单时，从链上按 V3 布局重建（forceImport 需要一份与链上实现匹配的工厂）
  const V3 = await ethers.getContractFactory("RewardSystemV3", owner);
  try {
    await upgrades.forceImport(proxyAddress, V3, { kind: "uups" });
    console.log("proxy manifest imported (as V3)");
  } catch {
    console.log("proxy manifest already present");
  }

  const V4 = await ethers.getContractFactory("RewardSystemV4", owner);
  const pool = (await upgrades.upgradeProxy(proxyAddress, V4, {
    call: { fn: "initializeV4", args: [] },
  })) as unknown as RewardSystemV4;

  console.log("upgraded. impl:", await upgrades.erc1967.getImplementationAddress(proxyAddress));
  console.log("rewardForBlock(1):", (await pool.rewardForBlock(1)).toString());
  console.log("totalWeight (live):", (await pool.totalWeight()).toString());
  console.log("selectionTotalWeight (matures next block):", (await pool.selectionTotalWeight()).toString());
  console.log("sweepAddress():", await pool.sweepAddress());
  console.log("activeMinerCount:", (await pool.activeMinerCount()).toString());
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});

/**
 * 真链（Meta Assets Chain, chainId 20260131）升级脚本。
 *
 * 用法：
 *   export OWNER_KEY=<基金会 owner 私钥>
 *   export PROXY_ADDRESS=<链上 RewardSystem UUPS 代理地址>
 *   export NFT_ADDRESS=<已部署的 MST 地址；留空则本脚本先部署一个>
 *   export FALLBACK_ADDRESS=<可选，默认 V1 硬编码地址>
 *   npm run upgrade:chain
 *
 * 流程与本地端到端完全一致：upgradeProxy → initializeV2。
 * 若本机没有该代理的升级清单（.openzeppelin/），先 forceImport 重建。
 */
import { ethers, upgrades } from "hardhat";
import type { RewardSystemV2 } from "../typechain-types";

const V1_SWEEP = "0x281F73d00751aEb5f64e76c8B9137d3AA8499762";

async function main() {
  const proxyAddress = process.env.PROXY_ADDRESS;
  if (!proxyAddress) throw new Error("PROXY_ADDRESS is required");
  const fallbackAddr = process.env.FALLBACK_ADDRESS || V1_SWEEP;

  const [owner] = await ethers.getSigners();
  if (!owner) throw new Error("OWNER_KEY is required (hardhat.config networks.machain.accounts)");
  console.log("upgrading with owner:", owner.address);

  const V1 = await ethers.getContractFactory("RewardSystem", owner);
  const V2 = await ethers.getContractFactory("RewardSystemV2", owner);

  // 没有本地清单时从链上导入代理布局
  try {
    await upgrades.forceImport(proxyAddress, V1, { kind: "uups" });
    console.log("proxy manifest imported");
  } catch {
    console.log("proxy manifest already present");
  }

  let nftAddr = process.env.NFT_ADDRESS;
  if (!nftAddr) {
    const MST = await ethers.getContractFactory("MSTToken", owner);
    const mst = await MST.deploy(owner.address);
    await mst.waitForDeployment();
    nftAddr = await mst.getAddress();
    console.log("MST deployed:", nftAddr);
  }

  const pool = (await upgrades.upgradeProxy(proxyAddress, V2)) as unknown as RewardSystemV2;
  console.log("upgraded. impl:", await upgrades.erc1967.getImplementationAddress(proxyAddress));

  await (await pool.initializeV2(nftAddr, fallbackAddr)).wait();
  console.log("initializeV2 done. nft:", nftAddr, "fallback:", fallbackAddr);

  console.log("rewardForBlock(1):", (await pool.rewardForBlock(1)).toString());
  console.log("sweepAddress():", await pool.sweepAddress());
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});

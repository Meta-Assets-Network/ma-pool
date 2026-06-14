/**
 * Meta Assets 测试网（chainId 20260130）矿池代理 V1 → V4 全路径升级。
 *
 * 前提：代理当前为 V1（RewardSystem，原 init_proxy_pool.sol），owner = 签名者。
 * 行为保留：升级后无激活矿工时 sweepAddress() 返回 fallback（默认 = 原写死的
 * 0x281F73…9762），与升级前完全一致；待矿工质押+激活后才进入动态加权随机。
 *
 * 每步 upgradeProxy 用 upgradeToAndCall（升级与初始化同一笔原子交易），不存在
 * "实现已换、状态未初始化" 的奖励烧毁窗口。
 *
 * 用法：
 *   MATEST_RPC=http://127.0.0.1:8545 \
 *   MATEST_KEY=<owner 私钥> \
 *   PROXY_ADDRESS=0xE038256A6f08343d659b3f0D798e7BeC1E392C9C \
 *   FALLBACK_ADDRESS=0x281F73d00751aEb5f64e76c8B9137d3AA8499762 \
 *   npx hardhat run scripts/upgrade-testnet-v4.ts --network matest
 */
import { ethers, upgrades, network } from "hardhat";
import * as fs from "fs";
import * as path from "path";
import type { MSTToken, RewardSystemV4 } from "../typechain-types";

const DEFAULT_FALLBACK = "0x281F73d00751aEb5f64e76c8B9137d3AA8499762";

async function callRaw(to: string, data: string): Promise<string | null> {
  try {
    return await ethers.provider.call({ to, data });
  } catch {
    return null;
  }
}

async function main() {
  const proxy = process.env.PROXY_ADDRESS;
  if (!proxy) throw new Error("PROXY_ADDRESS is required");
  const fallbackAddr = process.env.FALLBACK_ADDRESS || DEFAULT_FALLBACK;

  const [owner] = await ethers.getSigners();
  if (!owner) throw new Error("MATEST_KEY (owner private key) is required");
  console.log("network    :", network.name, "chainId", (await ethers.provider.getNetwork()).chainId.toString());
  console.log("signer     :", owner.address);
  console.log("proxy      :", proxy);
  console.log("fallback   :", fallbackAddr);

  // ---- 前置校验：必须是 V1，且签名者就是 owner ----
  const ownerOnChain = await callRaw(proxy, "0x8da5cb5b"); // owner()
  if (!ownerOnChain) throw new Error("owner() call failed — is PROXY_ADDRESS a valid proxy?");
  const ownerAddr = ethers.getAddress("0x" + ownerOnChain.slice(26));
  if (ownerAddr.toLowerCase() !== owner.address.toLowerCase()) {
    throw new Error(`signer ${owner.address} is NOT proxy owner ${ownerAddr} — abort`);
  }
  const reward = await callRaw(proxy, "0x4957d325" + "0".repeat(64)); // rewardForBlock(0)
  if (!reward || BigInt(reward) !== 10n ** 18n) throw new Error("rewardForBlock(0) != 1e18 — unexpected state");
  const weightScale = await callRaw(proxy, "0x333fedad"); // WEIGHT_SCALE() — V2+ only
  if (weightScale !== null) throw new Error("WEIGHT_SCALE() succeeded — proxy is already V2+; this script expects V1");
  console.log("precheck   : OK (proxy is V1, signer is owner)\n");

  // ---- 注册升级清单（按 V1 布局） ----
  const V1 = await ethers.getContractFactory("RewardSystem", owner);
  try {
    await upgrades.forceImport(proxy, V1, { kind: "uups" });
    console.log("forceImport: proxy manifest seeded as V1");
  } catch (e) {
    console.log("forceImport: skipped (", (e as Error).message.slice(0, 60), ")");
  }

  // ---- 部署 MST NFT（foundation/minter = owner） ----
  const MST = await ethers.getContractFactory("MSTToken", owner);
  const mst = (await MST.deploy(owner.address)) as unknown as MSTToken;
  await mst.waitForDeployment();
  const mstAddr = await mst.getAddress();
  console.log("MST NFT    :", mstAddr, "(foundation =", owner.address + ")");

  // ---- V1 → V2（原子 initializeV2(nft, fallback)） ----
  const V2 = await ethers.getContractFactory("RewardSystemV2", owner);
  await upgrades.upgradeProxy(proxy, V2, { call: { fn: "initializeV2", args: [mstAddr, fallbackAddr] } });
  console.log("upgraded   : V1 → V2 (+initializeV2)");

  // ---- V2 → V3（原子 initializeV3()） ----
  const V3 = await ethers.getContractFactory("RewardSystemV3", owner);
  await upgrades.upgradeProxy(proxy, V3, { call: { fn: "initializeV3", args: [] } });
  console.log("upgraded   : V2 → V3 (+initializeV3)");

  // ---- V3 → V4（原子 initializeV4()） ----
  const V4 = await ethers.getContractFactory("RewardSystemV4", owner);
  const pool = (await upgrades.upgradeProxy(proxy, V4, {
    call: { fn: "initializeV4", args: [] },
  })) as unknown as RewardSystemV4;
  console.log("upgraded   : V3 → V4 (+initializeV4)\n");

  // ---- 验收 ----
  const impl = await upgrades.erc1967.getImplementationAddress(proxy);
  console.log("impl now   :", impl);
  console.log("owner      :", await pool.owner());
  console.log("rewardForBlock(1):", (await pool.rewardForBlock(1)).toString(), "(expect 1e18)");
  console.log("FEN_CAPACITY     :", (await pool.FEN_CAPACITY()).toString(), "(V4 view OK)");
  console.log("nft              :", await pool.nft());
  console.log("fallbackAddress  :", await pool.fallbackAddress());
  console.log("totalWeight      :", (await pool.totalWeight()).toString());
  console.log("activeMinerCount :", (await pool.activeMinerCount()).toString());
  console.log("sweepAddress     :", await pool.sweepAddress(), "(expect fallback while 0 miners)");

  const out = {
    chainId: Number((await ethers.provider.getNetwork()).chainId),
    proxy,
    nft: mstAddr,
    impl,
    owner: owner.address,
    fallbackAddress: fallbackAddr,
    upgradedTo: "V4",
  };
  const dir = path.resolve(__dirname, "..", "deployments");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "testnet.json"), JSON.stringify(out, null, 2));
  console.log("\nwrote contract/deployments/testnet.json");
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});

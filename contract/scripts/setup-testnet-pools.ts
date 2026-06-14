/**
 * 测试网批量创建并激活 N 个矿池（默认 6 个，每个质押 100 个 MST）。
 *
 * 流程：生成 N 个矿池钱包 → 存私钥到 /root/ma-pool/pools/pool-keys.json(0600) →
 * owner 给每个矿池打 gas → owner 铸 100 NFT 给每个矿池 → 每个矿池
 * setApprovalForAll + 分批 stake + activate → 打印权重/totalWeight。
 *
 * 用法（在 contract/ 下，owner 私钥在 .env 的 MATEST_KEY）：
 *   PROXY_ADDRESS=0xE038... NFT_ADDRESS=0xF6Ea... \
 *   npx hardhat run scripts/setup-testnet-pools.ts --network matest
 */
import { ethers } from "hardhat";
import * as fs from "fs";
import * as path from "path";
import type { MSTToken, RewardSystemV4 } from "../typechain-types";

const POOL_COUNT = Number(process.env.POOL_COUNT ?? 6);
const NFT_PER_POOL = Number(process.env.NFT_PER_POOL ?? 100);
const MINT_BATCH = 50; // ≤80（铸造）
const STAKE_BATCH = 20; // 单笔 stake gas 安全裕度
const GAS_PER_POOL = process.env.GAS_PER_POOL ?? "1.0"; // MA

async function main() {
  const proxy = process.env.PROXY_ADDRESS;
  const nftAddr = process.env.NFT_ADDRESS;
  if (!proxy || !nftAddr) throw new Error("PROXY_ADDRESS / NFT_ADDRESS required");

  const [owner] = await ethers.getSigners();
  if (!owner) throw new Error("MATEST_KEY (owner) required");
  const provider = ethers.provider;

  const pool = (await ethers.getContractAt("RewardSystemV4", proxy, owner)) as unknown as RewardSystemV4;
  const mst = (await ethers.getContractAt("MSTToken", nftAddr, owner)) as unknown as MSTToken;

  const ownerOnChain = await pool.owner();
  if (ownerOnChain.toLowerCase() !== owner.address.toLowerCase()) {
    throw new Error(`signer ${owner.address} != pool owner ${ownerOnChain}`);
  }
  console.log("owner      :", owner.address);
  console.log("proxy      :", proxy, "  nft:", nftAddr);
  console.log("plan       :", POOL_COUNT, "pools ×", NFT_PER_POOL, "NFT each\n");

  // 1) 生成矿池钱包并立即落盘（先存私钥，避免后续失败丢钥）
  const pools: any[] = [];
  for (let i = 0; i < POOL_COUNT; i++) pools.push(ethers.Wallet.createRandom().connect(provider));
  const chainId = Number((await provider.getNetwork()).chainId);
  const dir = path.resolve(__dirname, "..", "..", "pools"); // /root/ma-pool/pools
  fs.mkdirSync(dir, { recursive: true });
  const keyFile = path.join(dir, "pool-keys.json");
  fs.writeFileSync(
    keyFile,
    JSON.stringify(
      {
        chainId,
        proxy,
        nft: nftAddr,
        note: "测试网矿池私钥。每个矿池已质押+激活 100 个 MST。妥善保管。",
        pools: pools.map((w, i) => ({ index: i + 1, address: w.address, privateKey: w.privateKey })),
      },
      null,
      2
    )
  );
  fs.chmodSync(keyFile, 0o600);
  console.log("saved keys :", keyFile, "(chmod 600)\n");

  // 2) owner 给每个矿池打 gas
  for (let i = 0; i < pools.length; i++) {
    const tx = await owner.sendTransaction({ to: pools[i].address, value: ethers.parseEther(GAS_PER_POOL) });
    await tx.wait();
    console.log(`gas -> pool#${i + 1} ${pools[i].address}  ${GAS_PER_POOL} MA`);
  }

  // 3) owner 铸 NFT 给每个矿池
  for (let i = 0; i < pools.length; i++) {
    let left = NFT_PER_POOL;
    while (left > 0) {
      const n = Math.min(left, MINT_BATCH);
      await (await mst.mint(pools[i].address, n)).wait();
      left -= n;
    }
    console.log(`mint ${NFT_PER_POOL} NFT -> pool#${i + 1}`);
  }

  // 4) 每个矿池 approve + stake + activate
  for (let i = 0; i < pools.length; i++) {
    const w = pools[i];
    const mstW = mst.connect(w) as unknown as MSTToken;
    const poolW = pool.connect(w) as unknown as RewardSystemV4;
    await (await mstW.setApprovalForAll(proxy, true)).wait();

    const ids: bigint[] = [];
    for (let k = 0; k < NFT_PER_POOL; k++) ids.push(await mst.tokenOfOwnerByIndex(w.address, k));
    for (let k = 0; k < ids.length; k += STAKE_BATCH) {
      await (await poolW.stake(ids.slice(k, k + STAKE_BATCH))).wait();
    }
    await (await poolW.activate()).wait();
    const info = await pool.minerInfo(w.address);
    console.log(`pool#${i + 1} activated: staked=${info.staked} weight=${info.weight} pos=${await pool.minerPosition(w.address)}`);
  }

  // 5) 汇总
  console.log("\n=== summary ===");
  console.log("activeMinerCount :", (await pool.activeMinerCount()).toString());
  console.log("totalWeight(live):", (await pool.totalWeight()).toString());
  console.log("selectionTotal   :", (await pool.selectionTotalWeight()).toString(), "(下一块成熟后 = totalWeight)");
  console.log("sweepAddress now :", await pool.sweepAddress());
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});

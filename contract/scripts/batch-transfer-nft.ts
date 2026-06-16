/**
 * 批量转移 MST NFT 脚本。
 *
 * 特性：
 *   - 每个接收地址各转多少枚可配（TRANSFER_COUNT）；实际转出 = TRANSFER_COUNT × 接收地址数。
 *   - 起始 tokenId 可选（START_TOKEN_ID）：指定则从该 id 起【连续】选取（不枚举持有，更快）；
 *     留空则自动枚举当前持有、从最小 tokenId 起选取（持有非连续也能正确工作）。
 *   - 接收地址可配（RECIPIENTS），每个地址各分到 TRANSFER_COUNT 枚（按地址顺序连续分配）。
 *   - 私钥从 contract/.env 的 PRIVATE_KEY 读取（.env 已被 gitignore，不进版本库）。
 *
 * 运行：
 *   npx hardhat run scripts/batch-transfer-nft.ts
 *   （连接由下方 RPC_URL 决定，与 --network 无关；加不加 --network 都行）
 *
 * 先 DRY_RUN=true 跑一遍看分配计划，确认无误再改 false 实际发交易。
 */
import { ethers } from "hardhat";
import * as fs from "fs";
import * as path from "path";

const CONFIG = {
  // —— 发送方私钥：从 contract/.env 的 PRIVATE_KEY 读取（见 .env.example）——
  PRIVATE_KEY: process.env.PRIVATE_KEY || "",

  // RPC 节点（默认本地 mock 链）
  RPC_URL: process.env.RPC_URL || "https://rpc.machaintest.com",

  // MST NFT 合约地址。留空则自动从 deployments/local.json 的 "nft" 字段读取。
  NFT_ADDRESS: "0xF6Ea76885f46493640045822A8EeB96028BDABfE",

  // 每个接收地址各转多少枚（总转出 = 此值 × RECIPIENTS 长度）
  TRANSFER_COUNT: 600,

  // 起始 tokenId：指定后从该 id 起【连续】选取（#START, #START+1, …），不枚举持有、更快；
  // 留 null 则自动枚举当前持有、从最小 tokenId 起选取。
  START_TOKEN_ID: 2401,

  // 接收地址（按地址顺序各分配 TRANSFER_COUNT 枚：[0] 拿最小的一批，[1] 拿次之…）
  RECIPIENTS: [
    // "0xAEaD5645d7BDfcA4d6aa9D9D9eD232b2E5455832",
    // "0xf15b6d94c04ee1284320a374073a8b61c3c85c5c",
    // "0x8C1f4bAfe32BDbcFC026bcE1Ffd208052F65cC2e",
    "0x9c37f50AF9A9C653798982A6B75E3d52DbA39785",
  ],

  // true = 只打印计划、不发交易
  DRY_RUN: false,
};

// 仅用到的 ERC721 接口，避免对 typechain / network 账户的依赖
const ERC721_ABI = [
  "function name() view returns (string)",
  "function symbol() view returns (string)",
  "function balanceOf(address owner) view returns (uint256)",
  "function tokenOfOwnerByIndex(address owner, uint256 index) view returns (uint256)",
  "function ownerOf(uint256 tokenId) view returns (address)",
  "function transferFrom(address from, address to, uint256 tokenId)",
];

function resolveNftAddress(): string {
  if (CONFIG.NFT_ADDRESS) return ethers.getAddress(CONFIG.NFT_ADDRESS.toLowerCase());
  const file = path.resolve(__dirname, "..", "deployments", "local.json");
  if (!fs.existsSync(file)) {
    throw new Error("NFT_ADDRESS 未配置，且找不到 deployments/local.json，请在 CONFIG.NFT_ADDRESS 填入 MST 地址");
  }
  const dep = JSON.parse(fs.readFileSync(file, "utf8"));
  if (!dep.nft) throw new Error("deployments/local.json 缺少 nft 字段");
  return ethers.getAddress(String(dep.nft).toLowerCase());
}

async function main() {
  // —— 基本校验 ——
  if (!/^0x[0-9a-fA-F]{64}$/.test(CONFIG.PRIVATE_KEY)) {
    throw new Error("请在 contract/.env 设置 PRIVATE_KEY（0x + 64 位十六进制），参考 .env.example");
  }
  if (CONFIG.TRANSFER_COUNT <= 0) throw new Error("TRANSFER_COUNT 必须 > 0");
  if (CONFIG.RECIPIENTS.length === 0) throw new Error("RECIPIENTS 不能为空");
  if (CONFIG.START_TOKEN_ID != null && CONFIG.START_TOKEN_ID <= 0) {
    throw new Error("START_TOKEN_ID 必须 > 0（MST tokenId 自 1 起），不指定请置为 null");
  }

  // 规范化接收地址（不论大小写都重新计算 checksum，避免输入大小写不匹配报错）
  const recipients = CONFIG.RECIPIENTS.map((a) => ethers.getAddress(a.toLowerCase()));

  const perCount = CONFIG.TRANSFER_COUNT; // 每个地址各转这么多
  const totalNeeded = perCount * recipients.length; // 实际转出总数

  const provider = new ethers.JsonRpcProvider(CONFIG.RPC_URL);
  const wallet = new ethers.Wallet(CONFIG.PRIVATE_KEY, provider);
  const sender = await wallet.getAddress();

  const nftAddr = resolveNftAddress();
  const nft = new ethers.Contract(nftAddr, ERC721_ABI, wallet);

  const [symbol, balanceBn] = await Promise.all([
    nft.symbol().catch(() => "MST"),
    nft.balanceOf(sender) as Promise<bigint>,
  ]);
  const balance = Number(balanceBn);

  console.log("=== 批量转移 NFT ===");
  console.log("NFT      :", nftAddr, `(${symbol})`);
  console.log("发送方   :", sender);
  console.log("持有数量 :", balance);
  console.log("每地址转 :", perCount, `枚 × ${recipients.length} 个地址 = 共 ${totalNeeded} 枚`);
  console.log("接收地址 :", recipients.join(", "));
  console.log("DRY_RUN  :", CONFIG.DRY_RUN);

  if (balance < totalNeeded) {
    throw new Error(`持有不足：当前 ${balance} 枚 < 计划转移 ${totalNeeded} 枚（每地址 ${perCount} × ${recipients.length} 个地址）`);
  }

  // —— 确定要转移的 tokenId 列表 ——
  let tokenIds: bigint[];
  if (CONFIG.START_TOKEN_ID != null) {
    // 指定起始 id：从 #START 起连续选取 totalNeeded 枚（不枚举持有；所有权由转移时合约校验）
    const start = BigInt(CONFIG.START_TOKEN_ID);
    tokenIds = Array.from({ length: totalNeeded }, (_, i) => start + BigInt(i));
    console.log(`\n指定起始 tokenId = #${start}，连续选取 ${tokenIds.length} 枚：#${tokenIds[0]} … #${tokenIds[tokenIds.length - 1]}`);
    console.log("  （此模式不预先枚举持有，逐枚转移时由合约校验所有权；如有不持有的 id 该笔会 revert）");
  } else {
    // 未指定：枚举当前持有的全部 tokenId，升序，取前 totalNeeded 枚
    const owned: bigint[] = [];
    console.log(`\n枚举持有的 tokenId（共 ${balance} 枚）…`);
    for (let i = 0; i < balance; i++) {
      const id = (await nft.tokenOfOwnerByIndex(sender, i)) as bigint;
      owned.push(id);
      console.log(`  [${i + 1}/${balance}] owned.push #${id}`);
    }
    owned.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));

    console.log(`\n当前持有 ${owned.length} 枚 tokenId（升序）：`);
    console.log("  [" + owned.map((x) => "#" + x).join(", ") + "]");

    tokenIds = owned.slice(0, totalNeeded);

    console.log(`\n从最小 tokenId 起选取 ${tokenIds.length} 枚：#${tokenIds[0]} … #${tokenIds[tokenIds.length - 1]}`);
  }

  // —— 按地址顺序各分配 perCount 枚并打印计划 ——
  const plan = tokenIds.map((id, idx) => ({ tokenId: id, to: recipients[Math.floor(idx / perCount)] }));
  const perRecipient = new Map<string, bigint[]>();
  for (const p of plan) {
    if (!perRecipient.has(p.to)) perRecipient.set(p.to, []);
    perRecipient.get(p.to)!.push(p.tokenId);
  }
  console.log("\n分配计划：");
  for (const [to, ids] of perRecipient) {
    console.log(`  ${to} ← ${ids.length} 枚: [${ids.map((x) => "#" + x).join(", ")}]`);
  }

  if (CONFIG.DRY_RUN) {
    console.log("\nDRY_RUN=true，未发送任何交易。确认计划无误后将 DRY_RUN 改为 false 再运行。");
    return;
  }

  // —— 逐枚转移（顺序执行，nonce 简单可靠，日志清晰）——
  console.log("\n开始转移…");
  let ok = 0;
  for (const { tokenId, to } of plan) {
    const tx = await nft.transferFrom(sender, to, tokenId);
    process.stdout.write(`  #${tokenId} → ${to}  tx=${tx.hash} …`);
    await tx.wait();
    console.log(" 已确认");
    ok++;
  }
  console.log(`\n完成：成功转移 ${ok}/${plan.length} 枚。`);
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});

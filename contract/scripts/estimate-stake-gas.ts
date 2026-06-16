/**
 * 标定 RewardSystemV4.stake 在目标链上的真实 gas 成本（纯只读：仅 view + eth_estimateGas，
 * 不发送任何交易、不改链上状态）。
 *
 * 用 contract/.env 的 PRIVATE_KEY 作为质押发送方；该地址需：
 *   1) 持有若干未质押的 MST；
 *   2) 已对 pool 执行过 setApprovalForAll（否则 estimateGas 会因 transferFrom 无授权而 revert）。
 *
 * 运行：npx hardhat run scripts/estimate-stake-gas.ts
 */
import { ethers } from "hardhat";

const RPC_URL = process.env.RPC_URL || "https://rpc.machaintest.com";
const POOL = "0xE038256A6f08343d659b3f0D798e7BeC1E392C9C";
const NFT = "0xF6Ea76885f46493640045822A8EeB96028BDABfE";
const BATCH_SIZES = [1, 2, 5, 10, 20, 40];
const BLOCK_GAS_LIMIT = 30_000_000;

const NFT_ABI = [
  "function balanceOf(address) view returns (uint256)",
  "function tokenOfOwnerByIndex(address,uint256) view returns (uint256)",
  "function isApprovedForAll(address owner,address operator) view returns (bool)",
];
const POOL_ABI = ["function stake(uint256[] tokenIds)", "function nft() view returns (address)"];

async function main() {
  if (!/^0x[0-9a-fA-F]{64}$/.test(process.env.PRIVATE_KEY || "")) {
    throw new Error("请在 contract/.env 设置 PRIVATE_KEY");
  }
  const provider = new ethers.JsonRpcProvider(RPC_URL);
  const wallet = new ethers.Wallet(process.env.PRIVATE_KEY as string, provider);
  const sender = await wallet.getAddress();

  const nft = new ethers.Contract(NFT, NFT_ABI, provider);
  const pool = new ethers.Contract(POOL, POOL_ABI, wallet);

  const [poolNft, balanceBn, approved, feeData] = await Promise.all([
    pool.nft() as Promise<string>,
    nft.balanceOf(sender) as Promise<bigint>,
    nft.isApprovedForAll(sender, POOL) as Promise<boolean>,
    provider.getFeeData(),
  ]);
  const balance = Number(balanceBn);
  const gasPrice = feeData.gasPrice ?? 0n;

  console.log("=== stake gas 标定 ===");
  console.log("RPC        :", RPC_URL);
  console.log("Pool       :", POOL);
  console.log("Pool.nft() :", poolNft, ethers.getAddress(poolNft) === ethers.getAddress(NFT) ? "(与 NFT 一致 ✓)" : "(⚠ 与配置 NFT 不一致)");
  console.log("发送方     :", sender);
  console.log("持有未质押 :", balance, "枚");
  console.log("已授权 pool:", approved);
  console.log("gasPrice   :", ethers.formatUnits(gasPrice, "gwei"), "gwei");

  if (!approved) {
    console.log("\n⚠ 发送方尚未对 pool setApprovalForAll，estimateGas 会因 transferFrom 无授权而 revert。");
    console.log("  要拿真实数据，需先发一笔 setApprovalForAll(pool, true)（这是改状态的真实交易）。");
    console.log("  确认后我可以补一个授权步骤再标定，或你自行授权后重跑本脚本。");
    return;
  }
  if (balance < 1) throw new Error("发送方未持有可质押的 MST");

  // 取发送方实际持有的 token 供 estimateGas 使用
  const maxNeed = Math.min(Math.max(...BATCH_SIZES), balance);
  const owned: bigint[] = [];
  for (let i = 0; i < maxNeed; i++) owned.push((await nft.tokenOfOwnerByIndex(sender, i)) as bigint);

  console.log("\n批量      总gas        每枚均摊     区块占比(30M)");
  const results: { n: number; gas: bigint }[] = [];
  for (const n of BATCH_SIZES) {
    if (n > balance) {
      console.log(`${String(n).padStart(4)}     —（持有不足，跳过）`);
      continue;
    }
    const gas = (await pool.stake.estimateGas(owned.slice(0, n))) as bigint;
    results.push({ n, gas });
    const per = gas / BigInt(n);
    const pct = (Number(gas) / BLOCK_GAS_LIMIT) * 100;
    console.log(`${String(n).padStart(4)}   ${String(gas).padStart(10)}   ${String(per).padStart(8)}   ${pct.toFixed(1)}%`);
  }

  // 用最大/最小两个批量扣掉固定开销，求每枚边际 gas
  if (results.length >= 2) {
    const lo = results[0];
    const hi = results[results.length - 1];
    const marginal = (hi.gas - lo.gas) / BigInt(hi.n - lo.n);
    const fixed = lo.gas - marginal * BigInt(lo.n);
    const maxByMarginal = (BigInt(BLOCK_GAS_LIMIT) - fixed) / marginal;
    const safe80 = (maxByMarginal * 80n) / 100n;

    console.log("\n— 标定结果 —");
    console.log("固定开销   :", fixed.toString(), "gas（每笔与枚数无关的部分）");
    console.log("每枚边际   :", marginal.toString(), "gas");
    console.log("撞 30M 理论上限:", maxByMarginal.toString(), "枚/笔");
    console.log("建议安全批量(留 20% 余量):", safe80.toString(), "枚/笔");
    if (gasPrice > 0n) {
      const costPer = marginal * gasPrice;
      console.log("每枚 gas 费 :", ethers.formatEther(costPer), "MA（按当前 gasPrice）");
    }
  }
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});

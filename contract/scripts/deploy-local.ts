/**
 * 本地 mock 链一键部署 + 模拟活动脚本（network: local，即 `npx hardhat node`）。
 *
 * 完整复刻真链路径：
 *   1. 生成独立基金会 owner 私钥（不是 hardhat 内置账户），hardhat_setBalance 注资
 *   2. owner 部署 RewardSystem(V1) UUPS 代理 —— 等价于链上现状
 *   3. 升级到 RewardSystemV2 + initializeV2(MST, V1 硬编码 sweep 地址)
 *   4. 部署 MSTToken（foundation = owner）
 *   5. 为 3 个测试矿工注资、铸 NFT（120 / 650 / 300，分批 ≤100）
 *   6. 模拟活动：A、B 质押+激活，C 质押不激活，A 再取回 30 → 产出一串事件供扫链验证
 *   7. 写 deployments/local.json，并生成 backend/.env.local 与 frontend/.env.local
 */
import { ethers, upgrades, network } from "hardhat";
import * as fs from "fs";
import * as path from "path";
import type { RewardSystemV2 } from "../typechain-types";

const V1_SWEEP = "0x281F73d00751aEb5f64e76c8B9137d3AA8499762";

async function fund(addr: string, eth: string) {
  await network.provider.send("hardhat_setBalance", [
    addr,
    "0x" + ethers.parseEther(eth).toString(16),
  ]);
}

async function mintMany(mst: any, to: string, quantity: number) {
  let left = quantity;
  while (left > 0) {
    const n = Math.min(left, 80);
    await (await mst.mint(to, n)).wait();
    left -= n;
  }
}

async function stakeN(pool: any, mst: any, miner: any, n: number) {
  const ids: bigint[] = [];
  for (let i = 0; i < n; i++) ids.push(await mst.tokenOfOwnerByIndex(miner.address, i));
  for (let i = 0; i < ids.length; i += 40) {
    await (await pool.connect(miner).stake(ids.slice(i, i + 40))).wait();
  }
  return ids;
}

async function main() {
  const provider = ethers.provider;
  const startBlock = await provider.getBlockNumber();

  // 1. 独立 owner（基金会）
  const owner = ethers.Wallet.createRandom().connect(provider);
  await fund(owner.address, "10000");
  console.log("foundation owner:", owner.address);

  // 2. V1 代理（链上现状）
  const V1 = await ethers.getContractFactory("RewardSystem", owner);
  const proxy = await upgrades.deployProxy(V1, [owner.address], { kind: "uups" });
  await proxy.waitForDeployment();
  const poolAddr = await proxy.getAddress();
  console.log("V1 proxy:", poolAddr, "sweep:", await proxy.sweepAddress());

  // 3. 升级 V2
  const V2 = await ethers.getContractFactory("RewardSystemV2", owner);
  const pool = (await upgrades.upgradeProxy(proxy, V2)) as unknown as RewardSystemV2;
  console.log("upgraded to V2, impl:", await upgrades.erc1967.getImplementationAddress(poolAddr));

  // 4. MST NFT
  const MST = await ethers.getContractFactory("MSTToken", owner);
  const mst = await MST.deploy(owner.address);
  await mst.waitForDeployment();
  const mstAddr = await mst.getAddress();
  console.log("MST:", mstAddr);

  await (await pool.connect(owner).initializeV2(mstAddr, V1_SWEEP)).wait();

  // 5. 测试矿工
  const minerWallets = [0, 1, 2].map(() => ethers.Wallet.createRandom().connect(provider));
  const [minerA, minerB, minerC] = minerWallets;
  const plan: [any, number][] = [
    [minerA, 120],
    [minerB, 650],
    [minerC, 300],
  ];
  for (const [w, n] of plan) {
    await fund(w.address, "1000");
    await mintMany(mst, w.address, n);
    console.log(`minted ${n} MST -> ${w.address}`);
  }

  // 6. 模拟活动
  for (const [w] of plan) {
    await (await mst.connect(w).setApprovalForAll(poolAddr, true)).wait();
  }
  const aIds = await stakeN(pool, mst, minerA, 120);
  await (await pool.connect(minerA).activate()).wait();
  await stakeN(pool, mst, minerB, 650);
  await (await pool.connect(minerB).activate()).wait();
  await stakeN(pool, mst, minerC, 300); // 质押但不激活
  await (await pool.connect(minerA).unstake(aIds.slice(0, 30))).wait(); // 120 -> 90，自动失活

  console.log("totalWeight:", (await pool.totalWeight()).toString());
  console.log("sweepAddress now:", await pool.sweepAddress());

  // 7. 落盘
  const endBlock = await provider.getBlockNumber();
  const out = {
    chainId: Number((await provider.getNetwork()).chainId),
    rpc: "http://127.0.0.1:8545",
    pool: poolAddr,
    nft: mstAddr,
    fallbackAddress: V1_SWEEP,
    owner: { address: owner.address, privateKey: owner.privateKey },
    miners: minerWallets.map((w, i) => ({
      address: w.address,
      privateKey: w.privateKey,
      minted: plan[i][1],
    })),
    startBlock,
    endBlock,
  };
  const root = path.resolve(__dirname, "..", "..");
  fs.mkdirSync(path.join(root, "contract", "deployments"), { recursive: true });
  fs.writeFileSync(
    path.join(root, "contract", "deployments", "local.json"),
    JSON.stringify(out, null, 2)
  );

  fs.writeFileSync(
    path.join(root, "backend", ".env.local"),
    [
      `RPC_URL=http://127.0.0.1:8545`,
      `POOL_ADDRESS=${poolAddr}`,
      `NFT_ADDRESS=${mstAddr}`,
      `DATABASE_URL=postgres://mapool:mapool@127.0.0.1:5433/mapool`,
      `START_BLOCK=${startBlock}`,
      `BATCH_SIZE=2000`,
      `POLL_MS=1500`,
      `PORT=8787`,
      ``,
    ].join("\n")
  );

  fs.writeFileSync(
    path.join(root, "frontend", ".env.local"),
    [
      `NEXT_PUBLIC_CHAIN_MODE=local`,
      `NEXT_PUBLIC_LOCAL_RPC=http://127.0.0.1:8545`,
      `NEXT_PUBLIC_POOL_ADDRESS=${poolAddr}`,
      `NEXT_PUBLIC_NFT_ADDRESS=${mstAddr}`,
      `NEXT_PUBLIC_API_URL=http://127.0.0.1:8787`,
      ``,
    ].join("\n")
  );

  console.log("\nwrote contract/deployments/local.json, backend/.env.local, frontend/.env.local");
  console.log(`scan range so far: [${startBlock}, ${endBlock}]`);
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});

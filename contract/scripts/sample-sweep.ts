/**
 * 对本地链逐块采样 sweepAddress，输出各矿工命中率 vs 理论权重占比。
 * 前置：hardhat node 运行中，已执行 deploy:local。
 *   SAMPLES=300 npm run sample
 */
import { ethers, network } from "hardhat";
import * as fs from "fs";
import * as path from "path";

async function main() {
  const file = path.resolve(__dirname, "..", "deployments", "local.json");
  const dep = JSON.parse(fs.readFileSync(file, "utf8"));
  const pool = await ethers.getContractAt("RewardSystemV2", dep.pool);

  const total: bigint = await pool.totalWeight();
  if (total === 0n) throw new Error("totalWeight=0：先跑 deploy:local 并确保有激活矿工");

  const n = Number(await pool.activeMinerCount());
  const theory = new Map<string, number>();
  for (let i = 0; i < n; i++) {
    const m: string = await pool.activeMinerAt(i);
    const w: bigint = await pool.minerWeight(m);
    theory.set(m, Number((w * 10000n) / total) / 10000);
  }

  const SAMPLES = Number(process.env.SAMPLES || 300);
  const tally = new Map<string, number>();
  for (let i = 0; i < SAMPLES; i++) {
    await network.provider.send("hardhat_mine", ["0x1"]);
    const w: string = await pool.sweepAddress();
    tally.set(w, (tally.get(w) ?? 0) + 1);
  }

  console.log(`samples: ${SAMPLES}, totalWeight: ${total} (${Number(total) / 10000} CU)`);
  for (const [m, p] of theory) {
    const hit = (tally.get(m) ?? 0) / SAMPLES;
    console.log(
      `${m}  theory=${(p * 100).toFixed(2)}%  sampled=${(hit * 100).toFixed(2)}%  diff=${(
        (hit - p) * 100
      ).toFixed(2)}pp`
    );
  }
  const offList = [...tally.keys()].filter((k) => !theory.has(k));
  if (offList.length) console.log("non-active winners (unexpected):", offList);
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});

/** 把 RewardSystemV2 / MSTToken 的 ABI 导出给 backend 与 frontend。 */
import * as fs from "fs";
import * as path from "path";
import { artifacts } from "hardhat";

async function main() {
  const root = path.resolve(__dirname, "..", "..");
  const targets = [
    path.join(root, "backend", "src", "abi"),
    path.join(root, "frontend", "src", "lib", "abi"),
  ];
  // V2 供现有 backend/frontend 消费（selector 与 V4 兼容）；V4 额外导出含延迟生效新增视图。
  for (const name of ["RewardSystemV2", "RewardSystemV4", "MSTToken"]) {
    const art = await artifacts.readArtifact(name);
    for (const dir of targets) {
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, `${name}.json`), JSON.stringify(art.abi, null, 2));
    }
    console.log(`exported ${name} ABI -> ${targets.join(", ")}`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});

import * as dotenv from "dotenv";
import * as fs from "fs";
import * as path from "path";

// .env.local（deploy-local 生成）优先，其次 .env
for (const f of [".env.local", ".env"]) {
  const p = path.resolve(__dirname, "..", f);
  if (fs.existsSync(p)) dotenv.config({ path: p });
}

function req(name: string, fallback?: string): string {
  const v = process.env[name] ?? fallback;
  if (v === undefined) throw new Error(`missing env: ${name}`);
  return v;
}

export const config = {
  rpcUrl: req("RPC_URL", "http://127.0.0.1:8545"),
  poolAddress: req("POOL_ADDRESS"),
  nftAddress: process.env.NFT_ADDRESS ?? "",
  databaseUrl: req("DATABASE_URL", "postgres://mapool:mapool@127.0.0.1:5433/mapool"),
  startBlock: Number(process.env.START_BLOCK ?? 0),
  batchSize: Number(process.env.BATCH_SIZE ?? 2000),
  pollMs: Number(process.env.POLL_MS ?? 1500),
  port: Number(process.env.PORT ?? 8787),
  /// 等待的确认数（私链/本地 0 即可；公链可调大防 reorg）
  confirmations: Number(process.env.CONFIRMATIONS ?? 0),
};

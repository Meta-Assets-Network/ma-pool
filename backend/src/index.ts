import { ethers } from "ethers";
import { config } from "./config";
import { pool, ensureSchema } from "./db";
import { Scanner } from "./scanner";
import { buildApi } from "./api";

async function main() {
  console.log(`[backend] rpc=${config.rpcUrl} pool=${config.poolAddress} db=${config.databaseUrl}`);
  await ensureSchema();

  const provider = new ethers.JsonRpcProvider(config.rpcUrl, undefined, {
    polling: true,
    pollingInterval: config.pollMs,
  });

  const scanner = new Scanner({ provider, db: pool });
  void scanner.run(); // 后台扫链循环

  const app = buildApi(pool, provider);
  app.listen(config.port, () => {
    console.log(`[backend] api listening on :${config.port}`);
  });

  const shutdown = () => {
    console.log("[backend] shutting down");
    scanner.stop();
    void pool.end().then(() => process.exit(0));
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

import express from "express";
import cors from "cors";
import { ethers } from "ethers";
import type { Pool } from "pg";
import { config } from "./config";
import { STATS_KEY, CURSOR_KEY, evtRange, getKV, minerKey, prefixKV, rangeKV } from "./kv";
import type { EventRecord, MinerSnapshot } from "./scanner";

interface GlobalStats {
  totalWeight: string;
  totalStaked: string;
  minerCount: number;
  activeCount: number;
  height: number;
}

export function buildApi(db: Pool, provider: ethers.JsonRpcProvider): express.Express {
  const app = express();
  app.use(cors());

  /** 扫链进度与链头（证明游标直追 tophead） */
  app.get("/api/status", async (_req, res) => {
    try {
      const [cursor, head, net] = await Promise.all([
        getKV<{ height: number }>(db, CURSOR_KEY),
        provider.getBlockNumber(),
        provider.getNetwork(),
      ]);
      res.json({
        scannedHeight: cursor?.height ?? null,
        chainHead: head,
        lag: cursor ? head - cursor.height : null,
        chainId: Number(net.chainId),
        pool: config.poolAddress,
        nft: config.nftAddress || null,
      });
    } catch (e) {
      res.status(500).json({ error: (e as Error).message });
    }
  });

  /** 区块高度区间事件查询（KV 键范围扫描，毫秒级）
   *  GET /api/events?fromBlock=0&toBlock=100&miner=0x..&name=Staked&limit=200&order=desc
   */
  app.get("/api/events", async (req, res) => {
    try {
      const fromBlock = Number(req.query.fromBlock ?? 0);
      const toBlockQ = req.query.toBlock;
      const toBlock = toBlockQ !== undefined ? Number(toBlockQ) : await provider.getBlockNumber();
      if (!Number.isFinite(fromBlock) || !Number.isFinite(toBlock) || fromBlock < 0 || toBlock < fromBlock) {
        res.status(400).json({ error: "invalid fromBlock/toBlock" });
        return;
      }
      const limit = Math.min(Number(req.query.limit ?? 200), 1000);
      const desc = String(req.query.order ?? "asc").toLowerCase() === "desc";
      const [lo, hi] = evtRange(fromBlock, toBlock);
      let rows = await rangeKV<EventRecord>(db, lo, hi, { limit: 1000, desc });
      const miner = typeof req.query.miner === "string" ? req.query.miner.toLowerCase() : null;
      const name = typeof req.query.name === "string" ? req.query.name : null;
      let events = rows.map((r) => r.value);
      if (miner) events = events.filter((e) => e.miner === miner);
      if (name) events = events.filter((e) => e.name === name);
      events = events.slice(0, limit);
      res.json({ fromBlock, toBlock, count: events.length, events });
    } catch (e) {
      res.status(500).json({ error: (e as Error).message });
    }
  });

  /** 矿工列表（含算力 CU 与爆块概率） */
  app.get("/api/miners", async (_req, res) => {
    try {
      const stats = await getKV<GlobalStats>(db, STATS_KEY);
      const rows = await prefixKV<MinerSnapshot>(db, "miner:");
      const totalWeight = BigInt(stats?.totalWeight ?? "0");
      const miners = rows
        .map((r) => r.value)
        .filter((m) => BigInt(m.staked) > 0n)
        .map((m) => {
          const weight = BigInt(m.weight);
          return {
            ...m,
            cu: Number(weight) / 10000,
            probability:
              m.active && totalWeight > 0n ? Number((weight * 1_000_000n) / totalWeight) / 1_000_000 : 0,
          };
        })
        .sort((a, b) => (BigInt(b.weight) > BigInt(a.weight) ? 1 : -1));
      res.json({ totalWeight: totalWeight.toString(), miners });
    } catch (e) {
      res.status(500).json({ error: (e as Error).message });
    }
  });

  /** 单矿工快照 */
  app.get("/api/miners/:address", async (req, res) => {
    try {
      const snap = await getKV<MinerSnapshot>(db, minerKey(req.params.address));
      if (!snap) {
        res.status(404).json({ error: "miner not found" });
        return;
      }
      res.json(snap);
    } catch (e) {
      res.status(500).json({ error: (e as Error).message });
    }
  });

  /** 全局统计 */
  app.get("/api/stats", async (_req, res) => {
    try {
      const stats = await getKV<GlobalStats>(db, STATS_KEY);
      const cursor = await getKV<{ height: number }>(db, CURSOR_KEY);
      res.json({
        totalWeight: stats?.totalWeight ?? "0",
        totalCU: stats ? Number(BigInt(stats.totalWeight)) / 10000 : 0,
        totalStaked: stats?.totalStaked ?? "0",
        minerCount: stats?.minerCount ?? 0,
        activeCount: stats?.activeCount ?? 0,
        height: stats?.height ?? null,
        scannedHeight: cursor?.height ?? null,
        rewardPerBlock: "1000000000000000000", // rewardForBlock 恒为 1e18（1 MA）
      });
    } catch (e) {
      res.status(500).json({ error: (e as Error).message });
    }
  });

  return app;
}

import { ethers } from "ethers";
import type { Pool } from "pg";
import { config } from "./config";
import { CURSOR_KEY, STATS_KEY, evtKey, getKV, minerKey, putKV, prefixKV } from "./kv";
import poolAbi from "./abi/RewardSystemV2.json";

/** 与合约 multiplierBpsFor 同一公式（链下复算权重） */
export function multiplierBpsFor(staked: bigint): bigint {
  if (staked >= 6000n) return 11500n;
  if (staked >= 600n) return 10500n;
  return 10000n;
}
export const weightFor = (staked: bigint) => staked * multiplierBpsFor(staked);

export interface EventRecord {
  name: string;
  miner: string | null;
  args: Record<string, unknown>;
  height: number;
  txHash: string;
  txIndex: number;
  logIndex: number;
  blockHash: string;
}

export interface MinerSnapshot {
  address: string;
  staked: string;
  active: boolean;
  multiplierBps: string;
  weight: string;
  height: number; // 最后变更高度
}

interface ScannerDeps {
  provider: ethers.JsonRpcProvider;
  db: Pool;
  log?: (msg: string) => void;
}

export class Scanner {
  private iface = new ethers.Interface(poolAbi);
  private stopped = false;

  constructor(private deps: ScannerDeps) {}

  stop() {
    this.stopped = true;
  }

  private log(msg: string) {
    (this.deps.log ?? console.log)(`[scanner] ${msg}`);
  }

  /** 启动扫链循环：游标 → tophead 区间批量扫，单事务落库，追平后轮询 */
  async run(): Promise<void> {
    const { provider } = this.deps;
    while (!this.stopped) {
      try {
        const head = (await provider.getBlockNumber()) - config.confirmations;
        const cursor = await this.scannedHeight();
        if (cursor >= head) {
          await sleep(config.pollMs);
          continue;
        }
        let from = cursor + 1;
        while (from <= head && !this.stopped) {
          const to = Math.min(from + config.batchSize - 1, head);
          await this.scanRange(from, to);
          this.log(`scanned [${from}, ${to}] head=${head}`);
          from = to + 1;
        }
      } catch (e) {
        this.log(`error: ${(e as Error).message}; retrying in ${config.pollMs}ms`);
        await sleep(config.pollMs);
      }
    }
  }

  async scannedHeight(): Promise<number> {
    const cur = await getKV<{ height: number }>(this.deps.db, CURSOR_KEY);
    return cur ? cur.height : config.startBlock - 1;
  }

  /** 扫一个闭区间并原子落库（事件 + 矿工快照 + 全局统计 + 游标） */
  async scanRange(fromBlock: number, toBlock: number): Promise<EventRecord[]> {
    const { provider, db } = this.deps;
    const logs = await provider.getLogs({
      address: config.poolAddress,
      fromBlock,
      toBlock,
    });

    const records: EventRecord[] = [];
    for (const lg of logs) {
      const parsed = this.iface.parseLog({ topics: [...lg.topics], data: lg.data });
      if (!parsed) continue; // 非本 ABI 事件（不会发生，防御）
      const args: Record<string, unknown> = {};
      parsed.fragment.inputs.forEach((inp, i) => {
        args[inp.name] = serialize(parsed.args[i]);
      });
      records.push({
        name: parsed.name,
        miner: typeof args["miner"] === "string" ? (args["miner"] as string).toLowerCase() : null,
        args,
        height: lg.blockNumber,
        txHash: lg.transactionHash,
        txIndex: lg.transactionIndex,
        logIndex: lg.index,
        blockHash: lg.blockHash,
      });
    }

    const client = await db.connect();
    try {
      await client.query("BEGIN");
      for (const r of records) {
        await putKV(client, evtKey(r.height, r.txIndex, r.logIndex), r, r.height);
        await this.applyToSnapshot(client, r);
      }
      await this.refreshStats(client, toBlock);
      await putKV(client, CURSOR_KEY, { height: toBlock }, toBlock);
      await client.query("COMMIT");
    } catch (e) {
      await client.query("ROLLBACK");
      throw e;
    } finally {
      client.release();
    }
    return records;
  }

  /** 事件 → 矿工快照（与合约状态机同构） */
  private async applyToSnapshot(client: { query: any }, r: EventRecord): Promise<void> {
    if (!r.miner) return;
    const key = minerKey(r.miner);
    const prev = (await getKV<MinerSnapshot>(client as any, key)) ?? {
      address: r.miner,
      staked: "0",
      active: false,
      multiplierBps: "10000",
      weight: "0",
      height: 0,
    };
    let staked = BigInt(prev.staked);
    let active = prev.active;
    switch (r.name) {
      case "Staked":
      case "Unstaked":
        staked = BigInt(String(r.args["stakedAfter"]));
        if (r.name === "Unstaked" && active && staked < 100n) active = false; // 合约会同时发 MinerDeactivated，这里幂等兜底
        break;
      case "MinerActivated":
        staked = BigInt(String(r.args["staked"]));
        active = true;
        break;
      case "MinerDeactivated":
        staked = BigInt(String(r.args["staked"]));
        active = false;
        break;
      default:
        return; // NftContractSet / FallbackAddressSet 等非矿工事件
    }
    const snap: MinerSnapshot = {
      address: r.miner,
      staked: staked.toString(),
      active,
      multiplierBps: multiplierBpsFor(staked).toString(),
      weight: weightFor(staked).toString(),
      height: r.height,
    };
    await putKV(client as any, key, snap, r.height);
  }

  /** 由矿工快照聚合全局统计 */
  private async refreshStats(client: { query: any }, height: number): Promise<void> {
    const rows = await prefixKV<MinerSnapshot>(client as any, "miner:");
    let totalWeight = 0n;
    let totalStaked = 0n;
    let activeCount = 0;
    let minerCount = 0;
    for (const { value: m } of rows) {
      const staked = BigInt(m.staked);
      if (staked === 0n) continue; // 完全退出的矿工不计数
      minerCount++;
      totalStaked += staked;
      if (m.active) {
        activeCount++;
        totalWeight += BigInt(m.weight);
      }
    }
    await putKV(
      client as any,
      STATS_KEY,
      {
        totalWeight: totalWeight.toString(),
        totalStaked: totalStaked.toString(),
        minerCount,
        activeCount,
        height,
      },
      height
    );
  }
}

function serialize(v: unknown): unknown {
  if (typeof v === "bigint") return v.toString();
  if (Array.isArray(v)) return v.map(serialize);
  return v;
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

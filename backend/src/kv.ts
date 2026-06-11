import type { PoolClient } from "pg";

/** KV 键空间
 *  cursor:scan                                  -> { height }
 *  evt:{height:12}:{txIndex:6}:{logIndex:6}     -> 事件记录（零填充保证字典序 == 数值序）
 *  miner:{address(lowercase)}                   -> 矿工最新快照
 *  stats:global                                 -> 全局统计
 */

const H = 12;
const TX = 6;
const LG = 6;

export function pad(n: number | bigint, width: number): string {
  const s = n.toString();
  if (s.length > width) throw new Error(`value ${s} exceeds pad width ${width}`);
  return s.padStart(width, "0");
}

export function evtKey(height: number | bigint, txIndex: number, logIndex: number): string {
  return `evt:${pad(height, H)}:${pad(txIndex, TX)}:${pad(logIndex, LG)}`;
}

/** [fromBlock, toBlock] 闭区间对应的键范围 [lo, hi) */
export function evtRange(fromBlock: number | bigint, toBlock: number | bigint): [string, string] {
  return [`evt:${pad(fromBlock, H)}:`, `evt:${pad(BigInt(toBlock) + 1n, H)}:`];
}

export const CURSOR_KEY = "cursor:scan";
export const STATS_KEY = "stats:global";
export const minerKey = (address: string) => `miner:${address.toLowerCase()}`;

type Queryable = Pick<PoolClient, "query">;

export async function putKV(q: Queryable, key: string, value: unknown, height: number | bigint): Promise<void> {
  await q.query(
    `INSERT INTO kv (key, value, height, updated_at) VALUES ($1, $2::jsonb, $3, now())
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, height = EXCLUDED.height, updated_at = now()`,
    [key, JSON.stringify(value), height.toString()]
  );
}

export async function getKV<T = unknown>(q: Queryable, key: string): Promise<T | null> {
  const r = await q.query(`SELECT value FROM kv WHERE key = $1`, [key]);
  return r.rows.length ? (r.rows[0].value as T) : null;
}

/** 键前缀范围 [lo, hi)，按 key 排序 */
export async function rangeKV<T = unknown>(
  q: Queryable,
  lo: string,
  hi: string,
  opts: { limit?: number; desc?: boolean } = {}
): Promise<{ key: string; value: T; height: string }[]> {
  const limit = Math.min(Math.max(opts.limit ?? 500, 1), 1000);
  const r = await q.query(
    `SELECT key, value, height FROM kv WHERE key >= $1 AND key < $2
     ORDER BY key ${opts.desc ? "DESC" : "ASC"} LIMIT $3`,
    [lo, hi, limit]
  );
  return r.rows;
}

export async function prefixKV<T = unknown>(
  q: Queryable,
  prefix: string,
  limit = 1000
): Promise<{ key: string; value: T }[]> {
  // 紧邻 prefix 的上界：prefix + 最大码位
  const r = await q.query(
    `SELECT key, value FROM kv WHERE key >= $1 AND key < $2 ORDER BY key ASC LIMIT $3`,
    [prefix, prefix + "￿", limit]
  );
  return r.rows;
}

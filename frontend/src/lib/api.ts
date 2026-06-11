import { API_URL } from "./chains";

export interface ApiMiner {
  address: string;
  staked: string;
  active: boolean;
  multiplierBps: string;
  weight: string;
  height: number;
  cu: number;
  probability: number;
}

export interface ApiEvent {
  name: string;
  miner: string | null;
  args: Record<string, unknown>;
  height: number;
  txHash: string;
  logIndex: number;
}

export interface ApiStats {
  totalWeight: string;
  totalCU: number;
  totalStaked: string;
  minerCount: number;
  activeCount: number;
  height: number | null;
  scannedHeight: number | null;
  rewardPerBlock: string;
}

export interface ApiStatus {
  scannedHeight: number | null;
  chainHead: number;
  lag: number | null;
  chainId: number;
}

async function get<T>(path: string): Promise<T> {
  const res = await fetch(`${API_URL}${path}`, { cache: "no-store" });
  if (!res.ok) throw new Error(`${path}: ${res.status}`);
  return res.json() as Promise<T>;
}

export const fetchStats = () => get<ApiStats>("/api/stats");
export const fetchStatus = () => get<ApiStatus>("/api/status");
export const fetchMiners = () => get<{ totalWeight: string; miners: ApiMiner[] }>("/api/miners");
export const fetchEvents = (fromBlock: number, toBlock?: number) =>
  get<{ events: ApiEvent[] }>(
    `/api/events?fromBlock=${fromBlock}${toBlock !== undefined ? `&toBlock=${toBlock}` : ""}&order=desc&limit=50`
  );

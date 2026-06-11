"use client";

import { usePoolStats } from "@/lib/hooks";
import { weightToCU, shortAddr } from "@/lib/format";
import { formatEther } from "viem";

export function StatsCards() {
  const s = usePoolStats();
  return (
    <div className="grid grid-stats">
      <div className="card">
        <div className="stat-label">矿池总算力</div>
        <div className="stat-value accent">{s.totalWeight !== undefined ? weightToCU(s.totalWeight) : "…"} CU</div>
        <div className="stat-sub">加权分母 totalWeight = Σ staked × 段位系数</div>
      </div>
      <div className="card">
        <div className="stat-label">矿工</div>
        <div className="stat-value">
          {s.activeMinerCount?.toString() ?? "…"}
          <span className="muted"> / {s.minerCount?.toString() ?? "…"}</span>
        </div>
        <div className="stat-sub">激活 / 总质押者 · 池内 MST {s.totalStaked?.toString() ?? "…"}</div>
      </div>
      <div className="card">
        <div className="stat-label">每块奖励</div>
        <div className="stat-value good">{s.rewardForBlock !== undefined ? formatEther(s.rewardForBlock) : "…"} MA</div>
        <div className="stat-sub">rewardForBlock(height) · 链高 #{s.blockNumber?.toString() ?? "…"}</div>
      </div>
      <div className="card">
        <div className="stat-label">本块出块者 sweepAddress</div>
        <div className="stat-value mono" title={s.sweepAddress}>
          {s.sweepAddress ? shortAddr(s.sweepAddress) : "…"}
        </div>
        <div className="stat-sub" title={s.currentSeed?.[1]}>
          seed {s.currentSeed ? `${s.currentSeed[1].slice(0, 10)}…` : "…"} @ #{s.currentSeed?.[0]?.toString() ?? "…"}
        </div>
      </div>
    </div>
  );
}

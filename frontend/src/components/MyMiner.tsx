"use client";

import { useWriteContract, useWaitForTransactionReceipt } from "wagmi";
import { useMyMiner } from "@/lib/hooks";
import { poolContract } from "@/lib/contracts";
import { weightToCU, pct, tierOf } from "@/lib/format";
import { TierProgress } from "./TierProgress";
import { useOnTargetChain } from "./NetworkGuard";

export function MyMiner() {
  const m = useMyMiner();
  const onChain = useOnTargetChain();
  const { writeContract, data: txHash, isPending, error, reset } = useWriteContract();
  const { isLoading: confirming, isSuccess } = useWaitForTransactionReceipt({ hash: txHash });

  if (!m.address) {
    return (
      <div className="card">
        <h3 className="section-title">我的矿池</h3>
        <p className="muted">连接钱包后查看自己的 MST、算力与爆块概率。</p>
      </div>
    );
  }

  const staked = Number(m.staked ?? 0n);
  const tier = tierOf(staked);
  const canActivate = onChain && !m.active && staked >= 100;
  const probability =
    m.active && m.totalWeight && m.totalWeight > 0n && m.weight !== undefined
      ? Number((m.weight * 1_000_000n) / m.totalWeight) / 1_000_000
      : 0;

  const act = (functionName: "activate" | "deactivate") =>
    writeContract(
      { ...poolContract, functionName },
      { onSettled: () => setTimeout(() => m.refetch(), 1200) }
    );

  return (
    <div className="card">
      <h3 className="section-title">
        我的矿池
        <small>{m.active ? "ACTIVE · 出块候选" : staked >= 100 ? "可激活" : "未达门槛"}</small>
      </h3>

      <div className="grid grid-stats" style={{ marginBottom: 8 }}>
        <div>
          <div className="stat-label">钱包 MST</div>
          <div className="stat-value">{m.walletBalance?.toString() ?? "…"}</div>
        </div>
        <div>
          <div className="stat-label">已质押 MST</div>
          <div className="stat-value accent">{m.staked?.toString() ?? "…"}</div>
        </div>
        <div>
          <div className="stat-label">段位 / 算力</div>
          <div className="stat-value">
            {tier.label}
            <span className="muted" style={{ fontSize: 15 }}>
              {" "}
              · {m.weight !== undefined ? weightToCU(m.weight) : "…"} CU
            </span>
          </div>
        </div>
        <div>
          <div className="stat-label">爆块概率</div>
          <div className={`stat-value ${m.active ? "good" : ""}`}>{m.active ? pct(probability) : "—"}</div>
          {!m.active && <div className="stat-sub">激活后参与加权随机出块</div>}
        </div>
      </div>

      <TierProgress staked={staked} />

      <div className="row" style={{ marginTop: 16 }}>
        {!m.active ? (
          <button className="btn" disabled={!canActivate || isPending || confirming} onClick={() => act("activate")}>
            {staked >= 100 ? (isPending || confirming ? "Activating…" : "Activate 矿池") : "需质押 ≥ 100 MST"}
          </button>
        ) : (
          <button
            className="btn-danger btn"
            disabled={!onChain || isPending || confirming}
            onClick={() => act("deactivate")}
          >
            {isPending || confirming ? "处理中…" : "Deactivate"}
          </button>
        )}
        {isSuccess && (
          <span className="good mono" onAnimationEnd={reset}>
            ✓ 已上链
          </span>
        )}
        {error && <span className="bad mono">{(error as Error).name}</span>}
      </div>
    </div>
  );
}

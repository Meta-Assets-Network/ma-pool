"use client";

/**
 * 段位进度条：0 → 100（激活门槛/1.00×）→ 600（1.05×）→ 6000（1.15× MAX）
 * 三段等宽展示，段内线性填充。
 */
export function TierProgress({ staked }: { staked: number }) {
  const seg1 = Math.min(staked / 100, 1) * 100; // 0..100
  const seg2 = staked <= 100 ? 0 : Math.min((staked - 100) / 500, 1) * 100; // 100..600
  const seg3 = staked <= 600 ? 0 : Math.min((staked - 600) / 5400, 1) * 100; // 600..6000

  return (
    <div>
      <div className="tier-track">
        <div className="tier-seg" style={{ ["--fill" as string]: `${seg1}%` }}>
          <i />
        </div>
        <div className="tier-seg" style={{ ["--fill" as string]: `${seg2}%` }}>
          <i />
        </div>
        <div className="tier-seg" style={{ ["--fill" as string]: `${seg3}%` }}>
          <i />
        </div>
      </div>
      <div className="tier-marks">
        <span>0</span>
        <span>
          <b>100</b> 门槛 · 1.00×
        </span>
        <span>
          <b>600</b> · 1.05×
        </span>
        <span>
          <b>6000</b> · 1.15× {staked >= 6000 ? <span className="good">MAX</span> : null}
        </span>
      </div>
    </div>
  );
}

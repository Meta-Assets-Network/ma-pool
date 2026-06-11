/** weight（CU × 10000 定点）→ CU 显示 */
export function weightToCU(weight: bigint | string | undefined | null): string {
  if (weight === undefined || weight === null) return "0";
  const w = typeof weight === "bigint" ? weight : BigInt(weight);
  const int = w / 10000n;
  const frac = w % 10000n;
  if (frac === 0n) return int.toLocaleString();
  return `${int.toLocaleString()}.${frac.toString().padStart(4, "0").replace(/0+$/, "")}`;
}

export function shortAddr(addr?: string | null): string {
  if (!addr) return "—";
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}

export function pct(x: number): string {
  return `${(x * 100).toFixed(2)}%`;
}

/** 段位（与合约 multiplierBpsFor 一致） */
export function tierOf(staked: number): { bps: number; label: string } {
  if (staked >= 6000) return { bps: 11500, label: "1.15×" };
  if (staked >= 600) return { bps: 10500, label: "1.05×" };
  return { bps: 10000, label: "1.00×" };
}

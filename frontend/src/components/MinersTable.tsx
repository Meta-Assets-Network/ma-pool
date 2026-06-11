"use client";

import { useQuery } from "@tanstack/react-query";
import { fetchMiners } from "@/lib/api";
import { shortAddr, pct } from "@/lib/format";

export function MinersTable() {
  const { data, isError } = useQuery({ queryKey: ["miners"], queryFn: fetchMiners });

  return (
    <div className="card">
      <h3 className="section-title">
        矿工列表
        <small>数据来源：扫链索引</small>
      </h3>
      {isError ? (
        <p className="muted">后端索引服务不可用（启动 backend 后自动恢复）。</p>
      ) : (
        <table>
          <thead>
            <tr>
              <th>地址</th>
              <th>MST</th>
              <th>段位</th>
              <th>算力 (CU)</th>
              <th>爆块概率</th>
              <th>状态</th>
            </tr>
          </thead>
          <tbody>
            {(data?.miners ?? []).map((m) => (
              <tr key={m.address}>
                <td title={m.address}>{shortAddr(m.address)}</td>
                <td>{m.staked}</td>
                <td>{(Number(m.multiplierBps) / 10000).toFixed(2)}×</td>
                <td>{m.cu.toLocaleString()}</td>
                <td>{m.active ? pct(m.probability) : "—"}</td>
                <td className={m.active ? "good" : "muted"}>{m.active ? "ACTIVE" : "STAKED"}</td>
              </tr>
            ))}
            {data && data.miners.length === 0 && (
              <tr>
                <td colSpan={6} className="muted">
                  暂无矿工
                </td>
              </tr>
            )}
          </tbody>
        </table>
      )}
    </div>
  );
}

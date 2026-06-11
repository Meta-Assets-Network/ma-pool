"use client";

import { useQuery } from "@tanstack/react-query";
import { fetchEvents, fetchStatus } from "@/lib/api";
import { explorerTxUrl } from "@/lib/chains";
import { shortAddr } from "@/lib/format";

const LABEL: Record<string, string> = {
  Staked: "质押",
  Unstaked: "取回",
  MinerActivated: "激活",
  MinerDeactivated: "失活",
  NftContractSet: "NFT配置",
  FallbackAddressSet: "兜底地址",
};

export function EventsFeed() {
  const { data: status } = useQuery({ queryKey: ["status"], queryFn: fetchStatus });
  const { data, isError } = useQuery({
    queryKey: ["events"],
    queryFn: () => fetchEvents(0),
  });

  return (
    <div className="card">
      <h3 className="section-title">
        事件流
        <small>
          {status
            ? `已扫 ${status.scannedHeight ?? "-"} / 链头 ${status.chainHead}${status.lag ? ` · 滞后 ${status.lag}` : " · 已追平"}`
            : "索引状态未知"}
        </small>
      </h3>
      {isError ? (
        <p className="muted">后端索引服务不可用。</p>
      ) : (
        <div className="feed">
          {(data?.events ?? []).map((e) => {
            const url = explorerTxUrl(e.txHash);
            const amount = e.args["amount"] !== undefined ? String(e.args["amount"]) : null;
            return (
              <div key={`${e.txHash}:${e.logIndex}`} className="feed-item">
                <span className={`evt-${e.name}`}>
                  {LABEL[e.name] ?? e.name}
                  {amount ? ` ×${amount}` : ""}
                </span>
                <span title={e.miner ?? undefined}>{shortAddr(e.miner)}</span>
                <span className="muted">#{e.height}</span>
                {url ? (
                  <a href={url} target="_blank" rel="noreferrer">
                    {shortAddr(e.txHash)}
                  </a>
                ) : (
                  <span className="muted" title={e.txHash}>
                    {shortAddr(e.txHash)}
                  </span>
                )}
              </div>
            );
          })}
          {data && data.events.length === 0 && <p className="muted">暂无事件</p>}
        </div>
      )}
    </div>
  );
}

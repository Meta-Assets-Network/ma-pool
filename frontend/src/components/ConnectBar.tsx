"use client";

import { useAccount, useConnect, useDisconnect, useChainId } from "wagmi";
import { targetChain } from "@/lib/chains";
import { shortAddr } from "@/lib/format";

export function ConnectBar() {
  const { address, isConnected } = useAccount();
  const chainId = useChainId();
  const { connect, connectors, isPending } = useConnect();
  const { disconnect } = useDisconnect();
  const onTarget = isConnected && chainId === targetChain.id;

  return (
    <div className="topbar-right">
      <span className={`badge ${onTarget ? "ok" : ""}`}>
        <span className="dot" />
        {targetChain.name} · #{targetChain.id}
      </span>
      {isConnected ? (
        <>
          <span className="badge ok mono">{shortAddr(address)}</span>
          <button className="btn btn-ghost" onClick={() => disconnect()}>
            断开
          </button>
        </>
      ) : (
        <button
          className="btn"
          disabled={isPending || connectors.length === 0}
          onClick={() => connect({ connector: connectors[0] })}
        >
          {isPending ? "连接中…" : "连接钱包"}
        </button>
      )}
    </div>
  );
}

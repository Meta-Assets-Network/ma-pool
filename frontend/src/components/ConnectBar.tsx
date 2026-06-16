"use client";

import { useAccount, useConnect, useDisconnect, useSwitchChain } from "wagmi";
import { targetChain } from "@/lib/chains";
import { shortAddr } from "@/lib/format";

/**
 * 右上角连接区：始终把钱包带到「当前配置的网络」（targetChain）。
 *  - 未连接：连接时带 chainId=targetChain.id，wagmi 连后切到该链；钱包没有该链时
 *    自动 wallet_addEthereumChain（用 chains.ts 的 RPC/符号/浏览器参数添加）。
 *  - 已连接但不在配置网络：显示「切换」按钮，switchChain 切换（缺失则自动添加）。
 *  - 已连接且在配置网络：显示地址 + 断开。
 */
export function ConnectBar() {
  // chainId 取自 useAccount（钱包实际所在链），不用 useChainId（仅反映配置状态）
  const { address, isConnected, chainId } = useAccount();
  const { connect, connectors, isPending } = useConnect();
  const { disconnect } = useDisconnect();
  const { switchChain, isPending: switching, error: switchError } = useSwitchChain();
  const onTarget = isConnected && chainId === targetChain.id;

  return (
    <div className="topbar-right">
      <span className={`badge ${onTarget ? "ok" : ""}`}>
        <span className="dot" />
        {targetChain.name} · #{targetChain.id}
      </span>

      {!isConnected ? (
        <button
          className="btn"
          disabled={isPending || connectors.length === 0}
          onClick={() => connect({ connector: connectors[0], chainId: targetChain.id })}
        >
          {isPending ? "连接中…" : "连接钱包"}
        </button>
      ) : !onTarget ? (
        <>
          <button
            className="btn"
            disabled={switching}
            onClick={() => switchChain({ chainId: targetChain.id })}
          >
            {switching ? "切换中…" : `切换到 ${targetChain.name}`}
          </button>
          {switchError && <span className="bad mono">{switchError.name}</span>}
          <button className="btn btn-ghost" onClick={() => disconnect()}>
            断开
          </button>
        </>
      ) : (
        <>
          <span className="badge ok mono">{shortAddr(address)}</span>
          <button className="btn btn-ghost" onClick={() => disconnect()}>
            断开
          </button>
        </>
      )}
    </div>
  );
}

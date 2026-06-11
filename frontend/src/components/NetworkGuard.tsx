"use client";

import { useAccount, useChainId, useSwitchChain } from "wagmi";
import { targetChain } from "@/lib/chains";

/**
 * 只认目标链（MA 链）。连接后链不对 → 横幅引导一键切换；
 * 钱包没有该链时 wagmi 自动走 wallet_addEthereumChain（带 RPC/符号/浏览器参数），
 * MetaMask 弹窗确认即可"通车"。
 */
export function NetworkGuard() {
  const { isConnected } = useAccount();
  const chainId = useChainId();
  const { switchChain, isPending, error } = useSwitchChain();

  if (!isConnected || chainId === targetChain.id) return null;

  return (
    <div className="banner">
      <span>
        ⚠ 当前钱包不在 {targetChain.name}（chainId {targetChain.id}）。本 dapp 仅服务 MA 链，
        点击切换；若钱包没有该网络会自动发起"添加网络"。
      </span>
      <span className="row">
        {error && <span className="bad mono">{error.name}</span>}
        <button className="btn" disabled={isPending} onClick={() => switchChain({ chainId: targetChain.id })}>
          {isPending ? "切换中…" : `切换到 ${targetChain.name}`}
        </button>
      </span>
    </div>
  );
}

/** 写操作是否可用：已连接且在目标链 */
export function useOnTargetChain(): boolean {
  const { isConnected } = useAccount();
  const chainId = useChainId();
  return isConnected && chainId === targetChain.id;
}

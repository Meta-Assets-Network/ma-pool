"use client";

import { useAccount, useChainId, useSwitchChain } from "wagmi";
import { targetChain, recognizedChainIds } from "@/lib/chains";

/**
 * 识别 MA 网络（主网 + 测试网）。连到 MA 网络 → 不提示；连到其它链 → 横幅引导
 * 添加/切换到 targetChain。钱包没有该链时 wagmi 自动走 wallet_addEthereumChain
 * （带 RPC/符号/浏览器参数），MetaMask 弹窗确认即可"通车"。
 */
export function NetworkGuard() {
  const { isConnected } = useAccount();
  const chainId = useChainId();
  const { switchChain, isPending, error } = useSwitchChain();

  // 已连接且在 MA 主网/测试网上 → 无需提示
  if (!isConnected || recognizedChainIds.includes(chainId)) return null;

  return (
    <div className="banner">
      <span>
        ⚠ 当前钱包不在 Meta Assets 网络（MA 主网 / 测试网）。本 dapp 仅服务 MA 链，
        点击添加 / 切换到 {targetChain.name}；若钱包没有该网络会自动发起"添加网络"。
      </span>
      <span className="row">
        {error && <span className="bad mono">{error.name}</span>}
        <button className="btn" disabled={isPending} onClick={() => switchChain({ chainId: targetChain.id })}>
          {isPending ? "切换中…" : `添加 / 切换到 ${targetChain.name}`}
        </button>
      </span>
    </div>
  );
}

/** 写操作是否可用：已连接且在 targetChain（合约地址按当前部署单配，故写操作只认目标链） */
export function useOnTargetChain(): boolean {
  const { isConnected } = useAccount();
  const chainId = useChainId();
  return isConnected && chainId === targetChain.id;
}

"use client";

import { useState } from "react";
import { usePublicClient, useWriteContract } from "wagmi";
import { useMyMiner, useMyStakedTokens } from "@/lib/hooks";
import { poolContract, nftContract } from "@/lib/contracts";
import { useOnTargetChain } from "./NetworkGuard";

const CHUNK = 40; // 单笔上限：EIP-7825 交易 gas 上限 2^24 下的安全批量

type Phase = "idle" | "approving" | "staking" | "unstaking";

export function StakePanel() {
  const m = useMyMiner();
  const onChain = useOnTargetChain();
  const client = usePublicClient();
  const { data: stakedTokens } = useMyStakedTokens(CHUNK);
  const { writeContractAsync } = useWriteContract();
  const [qty, setQty] = useState("100");
  const [phase, setPhase] = useState<Phase>("idle");
  const [msg, setMsg] = useState<string | null>(null);

  if (!m.address) return null;

  const busy = phase !== "idle";
  const n = Math.max(0, Math.floor(Number(qty) || 0));

  async function waitTx(hash: `0x${string}`) {
    if (client) await client.waitForTransactionReceipt({ hash });
  }

  /** 数量 → 钱包内 tokenId 列表（ERC721Enumerable 枚举） */
  async function pickWalletTokens(count: number): Promise<bigint[]> {
    if (!client) throw new Error("no client");
    const ids: bigint[] = [];
    for (let i = 0; i < count; i++) {
      ids.push(
        (await client.readContract({
          ...nftContract,
          functionName: "tokenOfOwnerByIndex",
          args: [m.address!, BigInt(i)],
        })) as bigint
      );
    }
    return ids;
  }

  async function doStake() {
    try {
      setMsg(null);
      const balance = Number(m.walletBalance ?? 0n);
      if (n === 0 || n > balance) {
        setMsg(`数量需在 1 ~ ${balance}`);
        return;
      }
      if (!m.approvedAll) {
        setPhase("approving");
        const h = await writeContractAsync({
          ...nftContract,
          functionName: "setApprovalForAll",
          args: [poolContract.address, true],
        });
        await waitTx(h);
      }
      setPhase("staking");
      const ids = await pickWalletTokens(n);
      for (let i = 0; i < ids.length; i += CHUNK) {
        const h = await writeContractAsync({
          ...poolContract,
          functionName: "stake",
          args: [ids.slice(i, i + CHUNK)],
        });
        await waitTx(h);
      }
      setMsg(`✓ 已质押 ${n} 枚`);
    } catch (e) {
      setMsg(`✗ ${(e as Error).message.slice(0, 120)}`);
    } finally {
      setPhase("idle");
      m.refetch();
    }
  }

  async function doUnstake() {
    try {
      setMsg(null);
      const mine = (stakedTokens as bigint[] | undefined) ?? [];
      const staked = Number(m.staked ?? 0n);
      if (n === 0 || n > staked) {
        setMsg(`数量需在 1 ~ ${staked}`);
        return;
      }
      setPhase("unstaking");
      // 第一页最多 CHUNK 枚；更多时分多轮（每轮取回后列表前移）
      let left = n;
      while (left > 0) {
        const batch = mine.slice(0, Math.min(left, CHUNK));
        if (batch.length === 0) break;
        const h = await writeContractAsync({
          ...poolContract,
          functionName: "unstake",
          args: [batch],
        });
        await waitTx(h);
        left -= batch.length;
        if (left > 0) {
          const refreshed = (await client!.readContract({
            ...poolContract,
            functionName: "stakedTokensPage",
            args: [m.address!, 0n, BigInt(CHUNK)],
          })) as bigint[];
          mine.splice(0, mine.length, ...refreshed);
        }
      }
      setMsg(`✓ 已取回 ${n} 枚`);
    } catch (e) {
      setMsg(`✗ ${(e as Error).message.slice(0, 120)}`);
    } finally {
      setPhase("idle");
      m.refetch();
    }
  }

  return (
    <div className="card">
      <h3 className="section-title">
        质押 / 取回
        <small>批量上限 {CHUNK}/笔 · 自动选取 tokenId</small>
      </h3>
      <div className="row">
        <input
          className="input"
          type="number"
          min={1}
          value={qty}
          onChange={(e) => setQty(e.target.value)}
          disabled={busy}
        />
        <button className="btn" disabled={!onChain || busy} onClick={doStake}>
          {phase === "approving" ? "授权中…" : phase === "staking" ? "质押中…" : "Stake MST"}
        </button>
        <button className="btn btn-ghost" disabled={!onChain || busy} onClick={doUnstake}>
          {phase === "unstaking" ? "取回中…" : "Unstake"}
        </button>
      </div>
      {!m.approvedAll && <p className="muted" style={{ fontSize: 12 }}>首次质押会先发起 setApprovalForAll 授权。</p>}
      {msg && <p className="mono" style={{ fontSize: 13 }}>{msg}</p>}
    </div>
  );
}

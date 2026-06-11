"use client";

import { useAccount, useBlockNumber, useReadContract, useReadContracts } from "wagmi";
import { poolContract, nftContract } from "./contracts";

/** 全局矿池读数（每个新块刷新） */
export function usePoolStats() {
  const { data: blockNumber } = useBlockNumber({ watch: true });
  const res = useReadContracts({
    contracts: [
      { ...poolContract, functionName: "totalWeight" },
      { ...poolContract, functionName: "activeMinerCount" },
      { ...poolContract, functionName: "minerCount" },
      { ...poolContract, functionName: "totalStaked" },
      { ...poolContract, functionName: "sweepAddress" },
      { ...poolContract, functionName: "rewardForBlock", args: [blockNumber ?? 0n] },
      { ...poolContract, functionName: "currentSeed" },
    ],
    query: { refetchInterval: 3000 },
  });
  const d = res.data;
  return {
    blockNumber,
    totalWeight: d?.[0]?.result as bigint | undefined,
    activeMinerCount: d?.[1]?.result as bigint | undefined,
    minerCount: d?.[2]?.result as bigint | undefined,
    totalStaked: d?.[3]?.result as bigint | undefined,
    sweepAddress: d?.[4]?.result as `0x${string}` | undefined,
    rewardForBlock: d?.[5]?.result as bigint | undefined,
    currentSeed: d?.[6]?.result as [bigint, `0x${string}`] | undefined,
    isLoading: res.isLoading,
  };
}

/** 当前连接地址的矿工视角读数 */
export function useMyMiner() {
  const { address } = useAccount();
  const enabled = !!address;
  const res = useReadContracts({
    contracts: address
      ? [
          { ...poolContract, functionName: "minerInfo", args: [address] },
          { ...nftContract, functionName: "balanceOf", args: [address] },
          { ...nftContract, functionName: "isApprovedForAll", args: [address, poolContract.address] },
          { ...poolContract, functionName: "totalWeight" },
        ]
      : [],
    query: { enabled, refetchInterval: 3000 },
  });
  const d = res.data;
  const info = d?.[0]?.result as [bigint, boolean, bigint, bigint] | undefined;
  return {
    address,
    staked: info?.[0],
    active: info?.[1],
    multiplierBps: info?.[2],
    weight: info?.[3],
    walletBalance: d?.[1]?.result as bigint | undefined,
    approvedAll: d?.[2]?.result as boolean | undefined,
    totalWeight: d?.[3]?.result as bigint | undefined,
    refetch: res.refetch,
    isLoading: res.isLoading,
  };
}

/** 我质押中的 tokenId 第一页（unstake 用） */
export function useMyStakedTokens(limit = 100) {
  const { address } = useAccount();
  return useReadContract({
    ...poolContract,
    functionName: "stakedTokensPage",
    args: address ? [address, 0n, BigInt(limit)] : undefined,
    query: { enabled: !!address, refetchInterval: 5000 },
  });
}

import { defineChain } from "viem";

/** Meta Assets Chain — dapp 唯一目标链 */
export const maChain = defineChain({
  id: 20260131,
  name: "Meta Assets Chain",
  nativeCurrency: { name: "MA", symbol: "MA", decimals: 18 },
  rpcUrls: {
    // 与 documents/machain-test/CHAIN_RPC_INFO.md 一致（钱包自动添加网络用此参数）
    default: { http: ["https://rpc.ma-chain.xyz", "https://rpc.macscan.io"] },
  },
  blockExplorers: {
    default: { name: "Meta Assets Chain Explorer", url: "https://ma-chain.xyz" },
  },
});

/** Meta Assets Chain 测试网（chainId 20260130，节点对外 https RPC = rpc.machaintest.com） */
export const maTestnet = defineChain({
  id: 20260130,
  name: "Meta Assets Chain Testnet",
  nativeCurrency: { name: "MA", symbol: "MA", decimals: 18 },
  rpcUrls: {
    // 与 documents/machain-test/CHAIN_RPC_INFO.md 一致
    default: {
      http: [process.env.NEXT_PUBLIC_TESTNET_RPC ?? "https://rpc.machaintest.com"],
      webSocket: ["wss://machaintest.com/ws"],
    },
  },
  blockExplorers: {
    default: { name: "Meta Assets Chain Testnet Explorer", url: "https://machaintest.com" },
  },
  testnet: true,
});

/** 本地 mock 链（hardhat node），端到端测试用 */
export const localChain = defineChain({
  id: 31337,
  name: "MA Local Mock",
  nativeCurrency: { name: "MA", symbol: "MA", decimals: 18 },
  rpcUrls: {
    default: { http: [process.env.NEXT_PUBLIC_LOCAL_RPC ?? "http://127.0.0.1:8545"] },
  },
});

export const chainMode = (process.env.NEXT_PUBLIC_CHAIN_MODE ?? "machain") as
  | "machain"
  | "testnet"
  | "local";
export const targetChain =
  chainMode === "local" ? localChain : chainMode === "testnet" ? maTestnet : maChain;

/**
 * 被识别为「MA 网络」的链 id —— 连到这些链不弹"添加/切换"提示。
 * 主网与测试网均视为合法（item 2）；本地模式仅识别本地链。
 * 写操作仍只在 targetChain 放行（合约地址按当前部署单配，见 useOnTargetChain）。
 */
export const recognizedChainIds: readonly number[] =
  chainMode === "local" ? [localChain.id] : [maChain.id, maTestnet.id];

export const POOL_ADDRESS = (process.env.NEXT_PUBLIC_POOL_ADDRESS ?? "0x0000000000000000000000000000000000000000") as `0x${string}`;
export const NFT_ADDRESS = (process.env.NEXT_PUBLIC_NFT_ADDRESS ?? "0x0000000000000000000000000000000000000000") as `0x${string}`;
export const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://127.0.0.1:8787";

export const explorerTxUrl = (hash: string) =>
  targetChain.blockExplorers ? `${targetChain.blockExplorers.default.url}/tx/${hash}` : null;

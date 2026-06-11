import type { Abi } from "viem";
import poolAbiJson from "./abi/RewardSystemV2.json";
import nftAbiJson from "./abi/MSTToken.json";
import { POOL_ADDRESS, NFT_ADDRESS } from "./chains";

export const poolAbi = poolAbiJson as Abi;
export const nftAbi = nftAbiJson as Abi;

export const poolContract = { address: POOL_ADDRESS, abi: poolAbi } as const;
export const nftContract = { address: NFT_ADDRESS, abi: nftAbi } as const;

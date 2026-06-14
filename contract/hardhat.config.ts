import { HardhatUserConfig } from "hardhat/config";
import "@nomicfoundation/hardhat-toolbox";
import "@openzeppelin/hardhat-upgrades";
import * as dotenv from "dotenv";

dotenv.config();

// 与链上 V1 (init_proxy_pool.sol) 保持一致：solc 0.8.24，OZ 5.0.2
const config: HardhatUserConfig = {
  solidity: {
    version: "0.8.24",
    settings: {
      optimizer: { enabled: true, runs: 200 },
    },
  },
  networks: {
    hardhat: {
      chainId: 31337,
      // mock 链放宽块 gas 上限，容纳 100 枚/笔 的批量质押；
      // 真链批量大小需按其区块 gas 上限调整（见 docs/E2E.md）
      blockGasLimit: 60_000_000,
    },
    // 本地 mock 链（npx hardhat node）
    local: {
      url: process.env.LOCAL_RPC_URL || "http://127.0.0.1:8545",
      chainId: 31337,
    },
    // Meta Assets Chain（真链，仅 upgrade-chain.ts 使用）
    machain: {
      url: process.env.MACHAIN_RPC_URL || "https://rpc.ma-chain.xyz",
      chainId: 20260131,
      accounts: process.env.OWNER_KEY ? [process.env.OWNER_KEY] : [],
    },
    // Meta Assets 测试网（chainId 20260130，节点本机 RPC）。
    // 用法：MATEST_KEY=<owner私钥> hardhat run scripts/upgrade-testnet-v4.ts --network matest
    matest: {
      url: process.env.MATEST_RPC || "http://127.0.0.1:8545",
      chainId: 20260130,
      accounts: process.env.MATEST_KEY ? [process.env.MATEST_KEY] : [],
    },
  },
  mocha: {
    timeout: 120000,
  },
};

export default config;

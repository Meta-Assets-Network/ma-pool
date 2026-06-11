import { http, createConfig } from "wagmi";
import { injected } from "wagmi/connectors";
import { maChain, localChain, targetChain } from "./chains";

/** 只激活目标链：钱包连上其他链时由 NetworkGuard 引导切换/添加 MA 链
 *  （transports 需对联合类型的两个 chainId 都给出定义，运行时只用 targetChain） */
export const wagmiConfig = createConfig({
  chains: [targetChain],
  connectors: [injected()],
  transports: {
    [maChain.id]: http(),
    [localChain.id]: http(),
  },
});

declare module "wagmi" {
  interface Register {
    config: typeof wagmiConfig;
  }
}

import { http, createConfig } from "wagmi";
import { injected } from "wagmi/connectors";
import type { Chain } from "viem";
import { maChain, maTestnet, localChain, targetChain } from "./chains";

/**
 * 列出全部已知链（targetChain 居首 = 默认/未连接时的读链）。
 * 若只列一条，useChainId() 会永远返回该链，导致即便 MetaMask 实际在别的网络，
 * DApp 也误判"已在目标网络"。组件改用 useAccount().chainId 读钱包真实链，
 * 这里也补全 chains 以便 wagmi 正确识别/表示钱包所在网络。
 */
const chains = [targetChain, maChain, maTestnet, localChain].filter(
  (c, i, arr) => arr.findIndex((x) => x.id === c.id) === i
) as unknown as readonly [Chain, ...Chain[]];

export const wagmiConfig = createConfig({
  chains,
  connectors: [injected()],
  transports: {
    [maChain.id]: http(),
    [maTestnet.id]: http(),
    [localChain.id]: http(),
  },
});

declare module "wagmi" {
  interface Register {
    config: typeof wagmiConfig;
  }
}

# MA Pool — Meta Assets Chain POCC 矿池三端工程

Meta Assets Chain（MA 链）的共识为 **POCC（Proof of Computation Capacity）**：
链节点出每个块前通过 `eth_call` 读取链上矿池合约（UUPS 代理）的两个接口，决定"产多少、产给谁"：

| 接口 | V1（链上现状） | V2（本工程升级版） |
|---|---|---|
| `rewardForBlock(uint256) → uint256` | 写死 `1e18`（1 MA） | **保持不变** |
| `sweepAddress() → address` | 写死一个地址 | **动态**：当前区块高度派生随机数，在激活矿工间按算力加权随机选择 |

> `sweepAddress` 由 `pure` 改为 `view`，**函数 selector 不变**，链端调用方零改动。

## 链信息

| 项 | 值 |
|---|---|
| 链名 / Chain ID | Meta Assets Chain / `20260131` |
| RPC | https://rpc.ma-chain.xyz（备用 https://madataseed.xyz 、https://maclive.info） |
| 浏览器 | https://macscan.io |
| 币符号 | MA（18 位） |

## 目录

```
contract/   Hardhat 工程：MSTToken（NFT）、RewardSystemV1/V2、测试、部署/升级/采样脚本
backend/    扫链索引器 + REST API（TypeScript 编译启动，Postgres KV 存储）
frontend/   Next.js dapp（wagmi/viem，强制 MA 链，自动添加网络）
docs/       全部文档（本文件、E2E.md、UPGRADE.md、API.md、specs/、plans/）
docker-compose.yml  Postgres 16（host 端口 5433）
init_proxy_pool.sol 链上 V1 原文（保留作参照，勿动）
```

## 核心规则（合约 = 唯一事实源）

- **MST NFT**（symbol `MST`）：仅基金会地址（owner）可铸造，批量铸造、tokenId 自 1 连续递增
- **质押**：持有者将 MST 批量质押进矿池（每枚权重 1），可批量取回
- **激活门槛**：质押 ≥ **100** 枚才能 `activate()` 成为出块候选；取回导致 < 100 自动失活
- **段位系数**（按矿工各自质押量）：

  | 质押数量 n | 系数 | 示例算力 |
  |---|---|---|
  | 100 ≤ n < 600 | 1.00× | 100 → 100 CU |
  | 600 ≤ n < 6000 | 1.05× | 5900 → 6195 CU |
  | n ≥ 6000 | 1.15×（封顶档） | 6000 → 6900 CU |

- **算力/权重**：`weight = staked × 系数bps`（链上整数，`CU = weight / 10000`，`WEIGHT_SCALE=10000`）
- **爆块概率** = `weight / totalWeight`（只统计激活矿工）；ABI 暴露 `minerWeight` / `totalWeight` / `minerInfo` 等全部读数
- **随机源**：`seed = keccak256(blockNumber ‖ blockhash(blockNumber-1))`（`currentSeed()` 可读），同一高度内确定、跨高度变化、全网一致
- **无激活矿工**时 `sweepAddress()` 返回 fallback 地址（初始化为 V1 写死的地址，owner 可改）
- 矿池是**虚拟矿池**：只计算不记账、不持有奖励资金；真实爆块产出由链按读数发放（产出扫链下阶段补）

事件（`miner` 均 `indexed`，支持地址 + 区块区间组合的快速 `eth_getLogs`）：
`Staked / Unstaked / MinerActivated / MinerDeactivated / NftContractSet / FallbackAddressSet`

## 版本锁定（与链上 V1 一致，硬约束）

- Solidity **0.8.24**（optimizer runs=200）
- OpenZeppelin **5.0.2**（contracts 与 contracts-upgradeable 均精确锁定，package.json 不带 `^`）
- 代理：**UUPS**；V2 自身状态用 ERC-7201 命名空间存储（slot `machain.storage.RewardPool`），不占线性槽位，升级安全
- 升级用 `@openzeppelin/hardhat-upgrades` 校验存储布局

## 三端职责

**contract**（[contract/](../contract)）
- `RewardSystemV2.sol`：质押/激活/段位权重/动态 sweepAddress；39 项单测含分布采样与升级路径
- 脚本：`deploy:local`（mock 链一键部署+模拟活动）、`upgrade:chain`（真链升级）、`export-abi`、`sample`（命中率 vs 理论占比）

**backend**（[backend/](../backend)）
- 扫链器：按区块区间 `eth_getLogs`（默认 2000 块/批），**单事务**写入事件 + 矿工快照 + 全局统计 + 游标，崩溃可恢复；游标直追 tophead，追平后按 `POLL_MS` 轮询
- 存储：Postgres 单表 KV（`key/value(jsonb)/height`）。事件键 `evt:{height:12}:{tx:6}:{log:6}` 零填充 → 主键 btree 直接支持高度区间范围扫描
- API：`/api/status`、`/api/events`（高度区间+矿工+事件名过滤）、`/api/miners`、`/api/stats`（见 [API.md](API.md)）

**frontend**（[frontend/](../frontend)）
- 仅认 MA 链：连接后链不符 → 横幅一键切换；钱包没有该链自动 `wallet_addEthereumChain`（RPC/符号/浏览器参数齐全，MetaMask 直接通车）；`NEXT_PUBLIC_CHAIN_MODE=local` 切本地 mock 链
- 仪表盘：总算力 CU、激活/总矿工、每块奖励、本块 `sweepAddress` + seed、我的 MST/质押/段位/算力/爆块概率、**100→600→6000 段位进度条**（≥100 出现 Activate，≥6000 MAX）、批量质押/取回（自动选 tokenId、自动授权、40 枚/笔分批）、矿工列表与事件流（索引器数据）

## 快速开始

完整端到端步骤见 [E2E.md](E2E.md)；真链升级手册见 [UPGRADE.md](UPGRADE.md)。

```bash
# 0) Postgres
docker compose up -d
# 1) 合约测试 + 本地链
cd contract && npm i && npm test && npm run node        # 终端 A
npm run deploy:local && npm run export-abi              # 终端 B（生成各端 .env.local）
# 2) 后端（编译启动）
cd ../backend && npm i && npm run build && npm start    # 终端 C
# 3) 前端
cd ../frontend && npm i && npm run dev                  # 终端 D → http://localhost:3000
```

## 设计文档

- 规格：[superpowers/specs/2026-06-12-ma-pool-design.md](superpowers/specs/2026-06-12-ma-pool-design.md)
- 实施计划：[superpowers/plans/2026-06-12-ma-pool-implementation.md](superpowers/plans/2026-06-12-ma-pool-implementation.md)

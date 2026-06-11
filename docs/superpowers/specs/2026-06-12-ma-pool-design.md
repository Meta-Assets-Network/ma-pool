# MA Pool — POCC 矿池三端工程设计（Design Spec）

日期：2026-06-12
状态：已按自主模式定稿（用户离线，规格来自用户完整需求描述；所有补充假设见文末"假设清单"）

## 1. 背景与目标

Meta Assets Chain（MA 链）采用 **POCC（Proof of Computation Capacity）** 共识：链节点在出每个块前，
通过 `eth_call` 调用链上一个固定的矿池合约（UUPS 代理，已部署，实现为本仓库 `init_proxy_pool.sol` 的 V1），
读取两个接口决定"这一块产多少、产给谁"：

- `rewardForBlock(uint256 blockNumber) → uint256`：该高度的出块奖励。V1 写死 `1e18`（1 MA），**本期保持不变**。
- `sweepAddress() → address`：奖励接收者。V1 写死 `0x281F73d00751aEb5f64e76c8B9137d3AA8499762`，**本期升级为动态加权随机选择**。

本期交付三端：

1. **contract/** — MST NFT 合约 + 矿池合约 V2（升级版实现，UUPS 升级到现有代理上）。
2. **backend/** — 扫链服务（区块区间扫事件 → Postgres KV 表，高度直追 tophead）+ 为前端提供查询 API。
3. **frontend/** — Next.js dapp，连接 MA 链（MetaMask 强制加链/切链），矿池总览 + 矿工面板 + 质押操作。

本地用 mock 链（Hardhat node）端到端测通，不触真链。真实爆块产出的扫链（链本身的 coinbase/出块记录）**下个阶段**做。

## 2. 链信息（固定参数）

| 项 | 值 |
|---|---|
| 链名 | Meta Assets Chain |
| Chain ID | 20260131 |
| RPC | https://rpc.ma-chain.xyz （备用：https://madataseed.xyz 、https://maclive.info） |
| 浏览器 | https://macscan.io |
| 币符号 | MA (18 decimals) |

## 3. 合约设计

### 3.1 版本约束（硬性）

- Solidity **0.8.24**（与 V1 一致）
- OpenZeppelin **5.0.2**（upgradeable 与非 upgradeable 均锁 5.0.2，与 V1 一致）
- 代理模式：**UUPS**（与 V1 一致），用 `@openzeppelin/hardhat-upgrades` 校验存储布局并执行升级
- V1（OZ 5.x ERC-7201 命名空间存储）没有线性存储变量；V2 自身状态同样采用 **ERC-7201 命名空间存储**，杜绝槽位冲突

### 3.2 MSTToken（NFT，新部署，非升级）

- ERC721Enumerable，name/symbol：**"MST" / "MST"**
- `Ownable(foundation)`：**仅基金会地址（owner）可铸造**；`mint(address to, uint256 quantity)` 批量顺序铸造，tokenId 自增（从 1 开始）
- Enumerable 用于前端直接枚举钱包内 tokenId（私链 gas 不敏感）

### 3.3 RewardSystemV2（矿池，升级到现有代理）

**保持不变**：`rewardForBlock(uint256) external pure returns (uint256)` → `1e18`。

**角色模型**：一个地址 = 一个"矿工/矿池"（质押者）。合约即矿工注册表。

**质押与激活**：
- `stake(uint256[] tokenIds)`：批量把 MST 转入合约（需先 `setApprovalForAll`），记录 `stakerOf[tokenId]`，`staked[miner] += n`
- `unstake(uint256[] tokenIds)`：仅能取回自己质押的 token；若激活中且取回后 `staked < 100` → **自动失活**（emit `MinerDeactivated`）
- `activate()`：要求 `staked ≥ 100`（门槛 MIN_ACTIVATION=100），加入激活集合
- `deactivate()`：主动失活（NFT 仍在池中，可再激活）

**段位与算力（CU）**（按矿工各自的质押数量分段）：

| 质押数量 n | 系数 | bps |
|---|---|---|
| 100 ≤ n < 600 | 1.00 | 10000 |
| 600 ≤ n < 6000 | 1.05 | 10500 |
| n ≥ 6000 | 1.15 | 11500（封顶档） |

- `weight(miner) = staked * bps`（**内部权重为 CU×10000 的定点数**，避免除法精度损失；例：6000 个 → 69,000,000 = 6900.0000 CU；5900 个 → 61,950,000 = 6195.0000 CU）
- `totalWeight` 增量维护（stake/unstake/activate/deactivate 时按该矿工权重差额调整），只统计**激活**矿工
- ABI 暴露（前端/链端可读）：`WEIGHT_SCALE()=10000`、`minerWeight(addr)`、`totalWeight()`、`minerInfo(addr)→(staked,active,multiplierBps,weight)`、`activeMinerCount()`、`activeMinerAt(i)`、`activeMinersPage(offset,limit)`、`minerCount()/minerAt(i)`（全部质押者）、`stakedTokensPage(addr,offset,limit)`（该矿工质押的 tokenId，供前端 unstake 选取）、`stakerOf(tokenId)`、`selectionSeed()`（当前高度随机种子，便于核验）

**动态 sweepAddress（核心）**：
```
sweepAddress() external view returns (address)
  若 totalWeight == 0 → 返回 fallbackAddress（初始化为 V1 硬编码地址，owner 可改）
  seed = keccak256(abi.encodePacked(block.number, blockhash(block.number - 1)))
  r = uint256(seed) % totalWeight
  按激活矿工列表累加 weight，首个累计 > r 的矿工即为出块者（加权随机：权重越大概率越高，P = weight/totalWeight）
```
- 取**当前区块高度** + 上一块哈希做种子：同一高度内确定、跨高度变化；`pure→view` 不改 selector，链端调用零改动
- O(active miners) 的 view 遍历，eth_call 场景可接受

**事件（全部对 miner 加 indexed，支持按地址 + 区块区间快速 getLogs）**：
```solidity
event Staked(address indexed miner, uint256 amount, uint256 stakedAfter, uint256[] tokenIds);
event Unstaked(address indexed miner, uint256 amount, uint256 stakedAfter, uint256[] tokenIds);
event MinerActivated(address indexed miner, uint256 staked, uint256 weight);
event MinerDeactivated(address indexed miner, uint256 staked);
event NftContractSet(address indexed nft);
event FallbackAddressSet(address indexed fallbackAddress);
```

**升级与初始化**：`initializeV2(address nft, address fallbackAddr)` 用 `reinitializer(2)`；`_authorizeUpgrade` 仍 onlyOwner。
仓库提供脚本：本地演练 = `deployProxy(V1)` → 校验旧行为 → `upgradeProxy(V2)+initializeV2` → 校验新行为；真链升级脚本读 `PROXY_ADDRESS` 环境变量复用同一流程。

**安全**：转移用 `transferFrom`（OZ5 无接收方回调，避免重入面）；所有权/参数变更 onlyOwner；不持有资金（虚拟矿池，只计算不记账）。

## 4. 后端设计（backend/）

TypeScript（tsc 编译后 `node dist` 启动），ethers v6，pg。

**扫链器**：
- 轮询 `getBlockNumber()` 得 tophead；从游标 `cursor+1` 起按 `BATCH_SIZE`（默认 2000）区间 `getLogs({address: pool, fromBlock, toBlock})`
- 解析为结构化事件，**单事务**写入事件 KV + 推进游标，崩溃可恢复、不重不漏（幂等 upsert）
- 同步维护衍生快照：每个矿工当前状态、全局统计（事件 reduce）

**存储（Postgres，docker-compose 启动）** — 单张 KV 表：
```sql
CREATE TABLE kv (
  key        TEXT PRIMARY KEY,
  value      JSONB NOT NULL,
  height     BIGINT NOT NULL DEFAULT 0,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX kv_height_idx ON kv (height);
```
键空间（key 前缀 + 零填充高度，PK btree 直接支持高度区间 range scan）：
- `cursor:scan` → `{height}`（已扫高度，直追 tophead）
- `evt:{height:12}:{txIndex:6}:{logIndex:6}` → `{name, miner, args, txHash, blockHash, height, ts}`
- `miner:{address}` → `{staked, active, weightBps, weight, height}`（最新快照）
- `stats:global` → `{totalWeight, totalStaked, minerCount, activeCount, height}`

**API（express，供前端）**：
- `GET /api/status` → `{scannedHeight, chainHead, chainId, pool, nft}`
- `GET /api/events?fromBlock&toBlock&miner&name&limit&order` → 区块区间事件（KV 前缀范围扫描）
- `GET /api/miners` → 矿工列表（地址、MST 数、权重 CU、占比、激活状态）
- `GET /api/stats` → 全局统计
- CORS 放开本地前端

真实爆块产出（链 coinbase 层面的记录）下阶段补；本期扫的是矿池合约事件。

## 5. 前端设计（frontend/）

Next.js 14（App Router）+ wagmi v2 + viem + TanStack Query。**视觉跟随 Meta Assets 品牌**：
深底 `#05090A`、玻璃卡片、主绿 `#38C354`、青 `#1FE3C2`、正文 `#EAF5EF`、弱化 `#9CB2AA`，字体 Space Grotesk / IBM Plex Mono。

**链管理（硬性要求）**：dapp 只认 MA 链（20260131）。连接后若链不对 → 顶部横幅 + 一键
`wallet_switchEthereumChain`，钱包没有该链（4902）→ 自动 `wallet_addEthereumChain`（带 RPC/符号/浏览器全套参数）→ MetaMask "通车"。
未连对链时禁用所有写操作。`NEXT_PUBLIC_CHAIN=local` 切到本地 mock 链（31337）用于端到端。

**页面（单页仪表盘）**：
- 头部：品牌 + 实时块高 + 连接钱包/网络徽章
- 全局卡片：总算力（CU）、激活矿工数/总矿工数、每块奖励（1 MA）、当前 `sweepAddress()`（本块中选者）
- 我的矿池（连接后）：钱包 MST 余额、已质押数、当前段位与系数、我的算力（CU）、爆块概率（weight/totalWeight）、激活状态
- **段位进度条**：0 → 100 → 600 → 6000 三段式，标注 1.00× / 1.05× / 1.15×，≥100 出现 **Activate** 按钮，≥6000 显示 MAX
- 操作：按数量批量 Stake（自动选 tokenId + 必要时先 setApprovalForAll）/ 批量 Unstake / Activate / Deactivate
- 矿工表（后端 API）：每个矿工 MST 数、算力 CU、爆块概率、状态；事件流（最近事件，tx 链接到 macscan / 本地显示哈希）

链上实时数据走 wagmi 直读合约；列表/历史走后端 API。

## 6. 目录结构与文档

```
pool/
├── contract/          # Hardhat：MSTToken.sol、RewardSystemV1.sol(参考拷贝)、RewardSystemV2.sol、测试、部署/升级/模拟脚本
├── backend/           # TS 扫链 + API（tsc 编译启动）
├── frontend/          # Next.js dapp
├── docs/              # 全部文档集中：架构、运行手册、端到端步骤、真链升级手册、规格
├── docker-compose.yml # postgres:16
└── init_proxy_pool.sol# 原始 V1（保留不动，作为链上现状参考）
```

## 7. 端到端验证（本地 mock 链）

1. `contract`: `npx hardhat test`（合约单测全绿）→ `hardhat node`（chainId 31337）
2. 部署脚本：生成独立 owner 私钥（基金会地址）→ 部署 V1 代理 → 升级 V2 → 部署 MST → wire → 给 3 个测试矿工铸 NFT → 质押/激活/取回造出一串事件
3. `docker compose up -d postgres` → backend `npm run build && npm start` → 游标追平 tophead，KV 入库
4. 断言：API 的 events/miners/stats 与链上读数一致；`sweepAddress()` 在多个高度采样，分布与权重占比吻合
5. `frontend`: `npm run build` 通过；本地起服 + 浏览器预览首屏

## 8. 假设清单（自主模式下的决策记录）

1. `madataseed.xyz` / `maclive.info` 按命名惯例视为**备用 RPC**，写入链定义的 RPC 列表（若实为他用，改一处常量即可）
2. 段位按**单个矿工自己的质押量**计算（依据"如果是5900 就是 5900*1.05"的算例）；100 以下不可激活
3. 权重定点：CU×10000（WEIGHT_SCALE），避免 601×1.05 这类小数截断影响选择公平性
4. 无激活矿工时 `sweepAddress()` 返回 fallback 地址（初始化为 V1 硬编码值），保持链不停摆；owner 可改 → "sweepAddress 动态化"含此管理口
5. NFT 合约不做升级版（新部署、逻辑简单）；矿池走 UUPS 升级（与链上现状一致）
6. 目录名采用 `frontend/`（需求原文 "forend" 视为 frontend 笔误）
7. 后端选 TypeScript（与全栈统一），"编译后启动" = `tsc && node dist/index.js`
8. 本地 mock 链 = Hardhat node；owner 私钥脚本生成并写入 env 文件（不入库真链密钥）
9. 重组(reorg)处理本期从简（私链+本地链），事件记录 blockHash 留扩展位；真实爆块产出扫链下阶段补

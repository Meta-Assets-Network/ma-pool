# MA Pool 三端工程实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 升级 MA 链 POCC 矿池为动态加权随机出块（sweepAddress），配套 MST NFT、扫链后端（Postgres KV）与 Next.js dapp，本地 mock 链端到端验证。

**Architecture:** UUPS 代理保持不变，新实现 RewardSystemV2 用 ERC-7201 命名空间存储追加状态；后端区间扫 getLogs 入单表 KV（key 内嵌零填充高度支持范围查询），express 提供查询 API；前端 wagmi 直读链上实时数据 + API 读历史/列表，强制 MA 链（本地模式连 31337）。

**Tech Stack:** Solidity 0.8.24 / OZ 5.0.2（exact pin）/ Hardhat 2.x + hardhat-upgrades 3.x + ethers v6；TypeScript + pg + express；Next.js 14 + wagmi v2 + viem；Postgres 16 (docker-compose)。

**Spec:** `docs/superpowers/specs/2026-06-12-ma-pool-design.md`

---

## 文件结构总览

```
contract/
  package.json hardhat.config.ts tsconfig.json
  contracts/MSTToken.sol            # ERC721Enumerable + Ownable(foundation)，批量 mint
  contracts/RewardSystemV1.sol      # init_proxy_pool.sol 的 hardhat 路径版（链上现状）
  contracts/RewardSystemV2.sol      # 升级版：质押/激活/段位权重/动态 sweepAddress
  test/MSTToken.test.ts test/RewardSystemV2.test.ts test/Upgrade.test.ts
  scripts/deploy-local.ts           # 生成 owner → V1代理 → 升级V2 → MST → 铸/质押/激活 模拟活动
  scripts/upgrade-chain.ts          # 真链升级（读 PROXY_ADDRESS）
  scripts/export-abi.ts             # ABI/地址 → backend/frontend
  scripts/sample-sweep.ts           # 多高度采样 sweepAddress 验证分布
backend/
  package.json tsconfig.json .env.example
  src/config.ts src/db.ts src/kv.ts # KV 编解码: evt:{h:12}:{tx:6}:{log:6}
  src/scanner.ts                    # 区间扫链 + reducer 快照 + 游标(单事务)
  src/api.ts src/index.ts
  src/abi/RewardSystemV2.json       # export-abi 生成
frontend/
  package.json next.config.mjs tsconfig.json .env.example
  src/lib/chains.ts                 # maChain(20260131) + local(31337)
  src/lib/wagmi.ts src/lib/abi/*.json src/lib/api.ts src/lib/format.ts
  src/app/layout.tsx page.tsx globals.css providers.tsx
  src/components/{ConnectBar,NetworkGuard,StatsCards,MyMiner,TierProgress,StakePanel,MinersTable,EventsFeed}.tsx
docs/{README.md,E2E.md,UPGRADE.md,API.md}
docker-compose.yml                  # postgres:16 (host 5433)
```

固定参数：`MIN_ACTIVATION=100`；段位 bps：`<600→10000, <6000→10500, ≥6000→11500`；`WEIGHT_SCALE=10000`；weight=staked×bps（CU=weight/10000）；KV 键前缀 `cursor:scan` / `evt:` / `miner:` / `stats:global`。

---

### Task 1: Hardhat 工程脚手架（版本锁定）

**Files:** Create `contract/package.json`, `contract/hardhat.config.ts`, `contract/tsconfig.json`, `contract/contracts/RewardSystemV1.sol`

- [ ] **1.1** `contract/package.json` 依赖（OZ 精确锁 5.0.2，不带 ^）：`@openzeppelin/contracts@5.0.2`、`@openzeppelin/contracts-upgradeable@5.0.2`、`@openzeppelin/hardhat-upgrades@^3.2.0`、`hardhat@^2.22.10`、`@nomicfoundation/hardhat-toolbox@^5.0.0`、`dotenv`。scripts: `compile/test/node/deploy:local/upgrade:chain/export-abi/sample`
- [ ] **1.2** `hardhat.config.ts`：`solidity: { version: "0.8.24", settings: { optimizer: { enabled: true, runs: 200 } } }`；networks: `hardhat`(默认), `local`(http://127.0.0.1:8545), `machain`(https://rpc.ma-chain.xyz, chainId 20260131, accounts: env OWNER_KEY)
- [ ] **1.3** `RewardSystemV1.sol` = `init_proxy_pool.sol` 原文，仅 import 路径去掉 `@5.0.2` 内联版本号（语义不变，包版本由 package.json 锁定）
- [ ] **1.4** `npm install && npx hardhat compile` → 编译通过；`git commit`

### Task 2: MSTToken（TDD）

**Files:** Create `contract/contracts/MSTToken.sol`, `contract/test/MSTToken.test.ts`

- [ ] **2.1** 失败测试：name/symbol="MST"；非 owner mint revert（`OwnableUnauthorizedAccount`）；`mint(to, 3)` 后 balanceOf=3 且 tokenId 1,2,3（tokenOfOwnerByIndex）；再 mint 从 4 继续；quantity=0 revert
- [ ] **2.2** 实现：

```solidity
// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;
import {ERC721} from "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import {ERC721Enumerable} from "@openzeppelin/contracts/token/ERC721/extensions/ERC721Enumerable.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

/// @title MST — Meta Assets 矿工凭证 NFT，仅基金会(owner)可铸造
contract MSTToken is ERC721Enumerable, Ownable {
    uint256 private _nextId = 1;
    error ZeroQuantity();
    constructor(address foundation) ERC721("MST", "MST") Ownable(foundation) {}
    function mint(address to, uint256 quantity) external onlyOwner {
        if (quantity == 0) revert ZeroQuantity();
        uint256 id = _nextId;
        for (uint256 i; i < quantity; ++i) _safeMint(to, id + i);
        _nextId = id + quantity;
    }
}
```

- [ ] **2.3** `npx hardhat test test/MSTToken.test.ts` 全绿；`git commit`

### Task 3: RewardSystemV2 — 质押/激活/权重（TDD）

**Files:** Create `contract/contracts/RewardSystemV2.sol`, `contract/test/RewardSystemV2.test.ts`

- [ ] **3.1** 失败测试（fixture：V1 proxy→升级V2→MST→给矿工铸 NFT 分块100/tx）：
  - 纯函数边界：`multiplierBpsFor(99|100|599)=10000, (600|5999)=10500, (6000|60000)=11500`；`weightFor(5900)=61_950_000`、`weightFor(6000)=69_000_000`
  - stake：转入后 `minerInfo.staked`、`stakerOf`、`stakedTokensPage`、`minerCount` 正确；未授权 revert；非持有者 token revert
  - activate：99 个 revert `BelowActivationThreshold`；100 个成功，`totalWeight=1_000_000`，事件 `MinerActivated(miner,100,1_000_000)`；重复 activate revert
  - 跨段位：600 个激活后 totalWeight=6_300_000；激活中追加 stake 自动更新 totalWeight
  - unstake：取回自己 token、stakerOf 清除、NFT 归还；激活中取到 99 个 → 自动失活（`MinerDeactivated`）且 totalWeight 扣减；取他人 token revert `NotTokenStaker`
  - deactivate/再 activate；staked 减到 0 时从 minerList 移除
  - 事件参数与 indexed topic 校验（`Staked`/`Unstaked` 的 tokenIds 数组）
- [ ] **3.2** 实现核心（ERC-7201 存储 + 增量 totalWeight）：

```solidity
// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;
import {Initializable} from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import {UUPSUpgradeable} from "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import {OwnableUpgradeable} from "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";
import {IERC721} from "@openzeppelin/contracts/token/ERC721/IERC721.sol";

contract RewardSystemV2 is Initializable, UUPSUpgradeable, OwnableUpgradeable {
    uint256 public constant MIN_ACTIVATION = 100;
    uint256 public constant WEIGHT_SCALE = 10000; // CU = weight / WEIGHT_SCALE

    struct MinerData { uint256 staked; bool active; uint256 listIndex; uint256 activeIndex;
        uint256[] tokens; mapping(uint256 => uint256) tokenPos; } // pos = index+1
    /// @custom:storage-location erc7201:machain.storage.RewardPool
    struct PoolStorage { IERC721 nft; address fallbackAddress; uint256 totalWeight; uint256 totalStaked;
        address[] minerList; address[] activeList;
        mapping(address => MinerData) miners; mapping(uint256 => address) stakerOf; }
    bytes32 private constant POOL_STORAGE = /* keccak256(abi.encode(uint256(keccak256("machain.storage.RewardPool"))-1)) & ~0xff */;

    function initializeV2(address nft_, address fallback_) external reinitializer(2) onlyOwner;
    function multiplierBpsFor(uint256 c) public pure returns (uint256); // 段位表
    function weightFor(uint256 c) public pure returns (uint256) { return c * multiplierBpsFor(c); }
    function stake(uint256[] calldata ids) external;     // transferFrom 入池，新矿工入 minerList
    function unstake(uint256[] calldata ids) external;   // 校验 stakerOf，<100 自动失活，0 出列
    function activate() external;                         // staked>=100, 入 activeList, tw+=w
    function deactivate() external;
    // 读接口：minerInfo/minerWeight/totalWeight/activeMinerCount/activeMinerAt/activeMinersPage/
    //         minerCount/minerAt/stakedTokensPage/stakerOf/currentSeed/sweepAddress/rewardForBlock
}
```

权重维护统一走 `_syncWeight(miner, wasActiveWeight)`：任何 staked/active 变化前取旧贡献、变化后取新贡献，差额调 totalWeight。
- [ ] **3.3** `npx hardhat test test/RewardSystemV2.test.ts` 全绿；`git commit`

### Task 4: 动态 sweepAddress + currentSeed（TDD）

**Files:** Modify `RewardSystemV2.sol`, `test/RewardSystemV2.test.ts`

- [ ] **4.1** 失败测试：无激活矿工 → fallback（=V1 硬编码地址）；单矿工 → 恒为其地址；同一高度重复调用结果相同、`hardhat_mine` 后可变化；3 矿工(100/300/600个NFT → weight 1e6/3e6/6.3e6)，`hardhat_mine` 逐块采样 300 次，命中率与 9.7%/29.1%/61.2% 偏差 < 10 个百分点；`currentSeed()` 返回 (block.number, keccak256(block.number‖blockhash(n-1)))
- [ ] **4.2** 实现：

```solidity
function rewardForBlock(uint256) external pure returns (uint256) { return 1e18; } // 保持 V1 语义
function currentSeed() public view returns (uint256 blockNumber, bytes32 seed) {
    blockNumber = block.number;
    seed = keccak256(abi.encodePacked(block.number, blockhash(block.number - 1)));
}
function sweepAddress() external view returns (address) {
    PoolStorage storage $ = _s();
    uint256 tw = $.totalWeight;
    if (tw == 0) return $.fallbackAddress;
    (, bytes32 seed) = currentSeed();
    uint256 r = uint256(seed) % tw; uint256 acc;
    uint256 len = $.activeList.length;
    for (uint256 i; i < len; ++i) {
        address m = $.activeList[i];
        acc += weightFor($.miners[m].staked);
        if (r < acc) return m;
    }
    return $.fallbackAddress;
}
```

- [ ] **4.3** 测试全绿；`git commit`

### Task 5: 升级路径测试

**Files:** Create `contract/test/Upgrade.test.ts`

- [ ] **5.1** `upgrades.deployProxy(RewardSystemV1, [owner], {kind:'uups'})` → 断言 `sweepAddress()==0x281F…9762`、`rewardForBlock(n)==1e18`、owner 正确 → `upgrades.upgradeProxy(proxy, RewardSystemV2)` + `initializeV2(mst, 0x281F…9762)` → 断言代理地址不变、owner 不变、`rewardForBlock` 不变、质押后 `sweepAddress` 动态、`initializeV2` 二次调用 revert、非 owner 升级 revert
- [ ] **5.2** `npx hardhat test`（全套）→ 全绿；`git commit`

### Task 6: 部署/升级/导出脚本

**Files:** Create `scripts/deploy-local.ts`, `scripts/upgrade-chain.ts`, `scripts/export-abi.ts`, `scripts/sample-sweep.ts`

- [ ] **6.1** `deploy-local.ts`（network local）：`Wallet.createRandom()` 生成基金会 owner → `hardhat_setBalance` 注资 → owner 部署 V1 代理 → 升级 V2 + initializeV2 → 部署 MST(foundation=owner) → 给 3 个派生测试矿工地址注资并铸 NFT(120/650/300，分块≤100/tx) → 矿工A/B `setApprovalForAll+stake+activate`，矿工C stake 但不激活，A 再 unstake 30 → 写 `contract/deployments/local.json`（含 ownerKey、minerKeys、地址、起始块）并生成 `backend/.env.local`、`frontend/.env.local`
- [ ] **6.2** `export-abi.ts`：从 artifacts 抽 `RewardSystemV2`/`MSTToken` 的 abi 写到 `backend/src/abi/` 与 `frontend/src/lib/abi/`
- [ ] **6.3** `upgrade-chain.ts`：env `PROXY_ADDRESS`/`NFT_ADDRESS`/`FALLBACK_ADDRESS`，network machain，同一升级流程（forceImport 兜底）；不在本地执行，仅编译期类型检查
- [ ] **6.4** `sample-sweep.ts`：连 local，循环 `hardhat_mine`+读 `sweepAddress`，输出各矿工命中率 vs 理论权重占比
- [ ] **6.5** `git commit`

### Task 7: 后端脚手架 + KV 层

**Files:** Create `backend/package.json`, `tsconfig.json`, `src/config.ts`, `src/db.ts`, `src/kv.ts`, `test/kv.test.ts`, root `docker-compose.yml`

- [ ] **7.1** docker-compose: `postgres:16-alpine`, host 端口 5433, db/user/pass=`mapool`, healthcheck pg_isready
- [ ] **7.2** 依赖：`ethers@^6.13`, `pg@^8.12`, `express@^4.19`, `cors`, `dotenv`；dev: `typescript@^5.5`, `tsx`, `@types/*`。scripts: `build=tsc`, `start=node dist/index.js`, `dev=tsx src/index.ts`, `test=tsx --test test/*.test.ts`
- [ ] **7.3** `kv.ts`：`evtKey(h,tx,log)` 零填充(12/6/6)、`evtRange(from,to)`→`[lo,hi)` 字符串对、`putKV/getKV/rangeKV`（参数化 SQL，upsert on conflict）；`db.ts`：pg Pool + `ensureSchema()`（CREATE TABLE IF NOT EXISTS kv + height 索引）
- [ ] **7.4** `test/kv.test.ts`（node:test，纯函数不连库）：编码宽度、字典序 = 数值序、range 边界含 from 含 to；通过；`git commit`

### Task 8: 扫链器 + reducer + API

**Files:** Create `src/scanner.ts`, `src/api.ts`, `src/index.ts`, `src/abi/RewardSystemV2.json`(由 export-abi 生成)

- [ ] **8.1** `scanner.ts`：`Interface(abi)` 解析 `getLogs({address: POOL, fromBlock, toBlock})`；每批一个 pg 事务：插入全部 `evt:*`、按事件 reduce 更新 `miner:{addr}`（Staked/Unstaked 改 staked，Activated/Deactivated 改 active；weight=staked*bps 同合约公式）、更新 `stats:global`、写 `cursor:scan`；`COMMIT`。追平后 sleep POLL_MS 再追。启动时从 `cursor:scan` 或 `START_BLOCK` 恢复
- [ ] **8.2** `api.ts`：四个端点（见 spec §4），events 走 `rangeKV(evtRange(from,to))` + 可选 miner/name 过滤 + limit(≤1000)；miners 取 `miner:%` 快照排序；stats 直出；`/api/status` 同时报 provider 当前 head 证明"直追 tophead"
- [ ] **8.3** `index.ts`：ensureSchema → 启 scanner loop（不阻塞）→ 启 express(PORT=8787)；`npm run build` 通过；`git commit`

### Task 9: 前端 dapp

**Files:** Create frontend 全部（见文件结构总览）

- [ ] **9.1** 脚手架：next@14.2 / react@18.3 / wagmi@^2.12 / viem@^2.21 / @tanstack/react-query@^5；`chains.ts` 定义 maChain（id 20260131, MA 18位, rpc 主+2备, macscan）与 localChain(31337)；`NEXT_PUBLIC_CHAIN_MODE=machain|local` 选链
- [ ] **9.2** `NetworkGuard`：连接后 chainId≠目标 → 横幅 + 按钮 `switchChain`（wagmi 自动走 wallet_addEthereumChain 当钱包没有该链，参数齐全 MetaMask 直接通车）；未对齐禁用写操作
- [ ] **9.3** 数据：wagmi `useReadContracts` 轮询 blockNumber/totalWeight/activeMinerCount/minerCount/sweepAddress/rewardForBlock/currentSeed + 连接者 minerInfo/balanceOf/stakedTokensPage；API 拉 miners/events/status
- [ ] **9.4** 组件：StatsCards（总算力 CU、矿工数、每块奖励 1 MA、本块 sweep 地址）；MyMiner（余额/质押/段位/算力/概率/激活状态）；TierProgress（0→100→600→6000 三段，1.00×/1.05×/1.15× 标注，≥100 显示 Activate，≥6000 MAX）；StakePanel（数量→tokenOfOwnerByIndex 取 ids→approve→stake；unstake 从 stakedTokensPage 取 ids；Deactivate）；MinersTable + EventsFeed（API，tx 链接 macscan/local 哈希）
- [ ] **9.5** 品牌样式 globals.css（#05090A 底/玻璃卡/#38C354/#1FE3C2/Space Grotesk+IBM Plex Mono）；`npm run build` 通过；`git commit`

### Task 10: 端到端验证（mock 链）

- [ ] **10.1** `docker compose up -d` → postgres healthy
- [ ] **10.2** 终端A `npx hardhat node`；`npm run deploy:local` 完成部署+模拟活动；`npm run export-abi`
- [ ] **10.3** backend `npm run build && npm start`；curl `/api/status` 直至 scannedHeight==chainHead；`/api/events?fromBlock=0&toBlock=999` 含 Staked×3/MinerActivated×2/Unstaked×1 等；`/api/miners`、`/api/stats` 与链上 `totalWeight()` 等读数一致
- [ ] **10.4** `npm run sample` 采样 ≥200 块，命中率 ≈ 权重占比（±10pp）
- [ ] **10.5** frontend `.env.local`(local 模式) `npm run build && npm start`，预览首屏渲染与数据
- [ ] **10.6** `git commit`

### Task 11: 文档

- [ ] **11.1** `docs/README.md`（架构图+三端职责+版本锁定说明）、`docs/E2E.md`（10.x 全命令）、`docs/UPGRADE.md`（真链：export OWNER_KEY/PROXY_ADDRESS → upgrade-chain → macscan 验证 selector 不变）、`docs/API.md`；根 README 指向 docs
- [ ] **11.2** 终检（verification-before-completion）：hardhat test 全绿输出、backend test 通过、两端 build 通过、e2e curl 结果；`git commit`

## Self-Review

- Spec 覆盖：§3 合约→Task1-6；§4 后端→Task7-8；§5 前端→Task9；§7 端到端→Task10；文档→Task11 ✓
- 占位符：无 TBD；V2 完整签名在 Task3/4，后端键空间/端点引用 spec §4 具体定义 ✓
- 类型一致：weightFor/multiplierBpsFor/minerInfo/stakedTokensPage 等命名在 Task3/4/6/8/9 一致；WEIGHT_SCALE=10000 全局一致 ✓

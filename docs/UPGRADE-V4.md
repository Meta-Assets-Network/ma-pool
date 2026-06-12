# RewardSystemV4 升级说明（V3 → V4）

> 日期：2026-06-13
> 合约：`contract/contracts/RewardSystemV4.sol`
> 关联：安全审计 `docs/SECURITY-AUDIT.md` 的 **C-1 路径 3**（质押时序操纵）
> **升级后代理地址不变、owner 不变、`rewardForBlock`/`sweepAddress` 两个 selector 不变，链端零改动。**

---

## 一、为什么要升级

### 核心问题：纯矿工的"反应式择时"可操纵出块归属（C-1 路径 3）

链端（`go-machain/core/state_processor.go`、`miner/worker.go`）在**本块所有交易执行之后**的状态上
调用 `sweepAddress()` 决定本块奖励/手续费归属，而随机种子
`keccak256(N ‖ blockhash(N-1))` 在第 N 块开始前就**公开可算**。

由此，一个**纯矿工**（不必是出块者）只要让一笔 `stake/unstake/activate/deactivate` 落进第 N 块，
就能改动第 N 块自己用的 `totalWeight` 与累加区间边界，把中奖挪到自己头上：

1. 第 N-1 块一落定 → 算出 `seed_N`；
2. 解一个权重增量，使 `seed_N % totalWeight'` 落进自己的区间；
3. 让该笔交易被打进第 N 块 → 本块 `sweepAddress()` 命中自己。

在低流量私链上，"下一块必被收录"很容易满足，攻击相当可靠。这破坏 POCC 的加权随机公平性
（属经济攻击，非夺取链控制）。

> 出块者侧（路径 2：碾磨 `blockhash`）需链层 VRF 修复，**不在纯合约范围**；本次威胁模型中
> validator 为可信内部，故不处理。本升级只堵纯矿工可达的路径 3。

链端"读取 `sweepAddress()` 的时刻"无法在合约侧改动，因此 V4 改"被读取的状态"。

## 二、方案：延迟一块生效（deferred effectiveness）

**任何权重/激活变更对选择的影响延迟一个区块生效。** 落在第 N 块的变更，第 N 块的
`sweepAddress()` 视而不见，自第 N+1 块起才计入。于是：

- 攻击者改不动**正在被决定的那一块**；
- 要影响第 N+1 块就得在第 N 块动手，但那时 `blockhash(N)` 未定 → `seed_{N+1}` 不可预测 → 瞄不准。

择时攻击失效，长期胜率回归到诚实的权重占比。

### 实现：节点版本化的延迟 Fenwick 树

在 V3 的 Fenwick 树之外新建一棵延迟树 `dfen`，每个节点把三段打包进**一个存储槽**
（读仍是单 SLOAD，保持 V3 的 ~43k gas，远低于链端 100k 上限）：

```
node = value(96 bit) | prev(96 bit) | stamp(64 bit)
```
- `value`：当前（live）部分和；`prev`：`stamp` 区块之前的部分和；`stamp`：最近修改的区块号。
- 只读取值规则：`effective = (stamp == block.number) ? prev : value`。

效果：**本块内的修改对选择不可见**（用 prev），且**过块后自动成熟**（stamp < 当前块即用 value）——
无需任何"刷新"交易，空块也能正确成熟，不会出现"已离场矿工仍被支付"的滞留泄漏。

### 配套：永久位置（放弃 swap-remove）

延迟读取与 V3 失活时"立即 swap-remove 压缩数组"会错位。V4 改为**永久位置**：矿工首次激活
分配一个永不移动的位置，失活只清零其权重（保留位置），再次激活复用原位置。

- `activeList` 因而只增不删（含失活占位）；`activeMinerCount/At/Page` 改为按 live `active` 过滤；
- 位置上限仍为 `FEN_CAPACITY = 65536`，按**历史去重矿工数**计（每个地址至多占一个永久位置）。

### 存储与兼容

PoolStorage 仅在末尾**追加** `dfen` / `posOf1` / `activeCountLive` 三个字段，V1/V2/V3 字段
一字未动；V3 的 `fen` 树在 V4 中冻结不用。ERC-7201 命名空间存储槽不变。

| | V3 | V4 |
|---|---|---|
| `sweepAddress()` 读成本 | O(log n)，~43k gas | O(log n)，~43k gas（仍单 SLOAD/节点） |
| 选择依据 | **本块末**（live）权重 | **上一块末**（延迟）权重 |
| 失活 | swap-remove 压缩 | 永久位置 + 清零（不移动） |
| 写成本 | O(log n) | O(log n)（节点多存 prev/stamp，同槽） |

## 三、升级步骤

```bash
cd contract && npm install && npm test          # 全套必须全绿（含 V4 11 项）再动真链

export OWNER_KEY=0x...                           # 基金会 owner 私钥
export PROXY_ADDRESS=0x...                       # 链上 RewardSystem 代理（当前为 V3）

npx hardhat run scripts/upgrade-v4-chain.ts --network machain
```

脚本动作（与本地测试同一条代码路径）：
1. `forceImport`（按 V3 布局）重建本机升级清单（新机器首次操作时需要）；
2. `upgradeProxy(proxy, V4, { call: initializeV4 })` —— 升级实现 + 迁移激活集到延迟树，**同一笔交易**；
3. 回读 `rewardForBlock(1)` / `totalWeight` / `selectionTotalWeight` / `sweepAddress` / `activeMinerCount` 确认。

## 四、升级后验收与注意

- **升级块当块**：迁移使 `dfen` 节点 `stamp = 升级块` → 当块 `selectionTotalWeight()` 读为 0
  → 链端回退 `HardcodedSweepFallback`。**仅此一块**，下一块自动成熟恢复（与 V3 `initializeV3`
  的原子升级语义一致）。
- `totalWeight()`（live，前端展示）与 `selectionTotalWeight()`（选择实际用，延迟一块）在
  发生权重变更后的**那一块**会短暂不等，下一块即重合——属预期。
- 新增运维/对拍视图：`selectionTotalWeight()`、`positionsUsed()`、`positionMinerAt(pos)`、
  `minerPosition(addr)`、`fenTotal()`（延迟树根 live 值，应恒等于 `totalWeight()`）。
- backend/frontend 无需改动：其使用的 `sweepAddress/rewardForBlock/minerInfo/totalWeight/
  activeMinerCount/activeMinersPage/stakedTokensPage` 及事件 selector 在 V4 完全保持。
  `npm run export-abi` 现额外导出 `RewardSystemV4.json`（含新增视图），原 `RewardSystemV2.json` 保留。

## 五、残留风险（需链层处理，超出本次范围）

- **路径 2（出块者碾磨 blockhash）**：V4 不解决。`seed` 仍源自 `blockhash(N-1)`，N-1 的出块者
  可碾磨。根治需链层 VRF / 提交-揭示。威胁模型中 validator 可信内部，暂可接受。
- **位置容量**：历史去重激活矿工数上限 65536（含已永久失活占位，按地址去重）。超大规模公开
  矿工集需引入位置回收（free-list），本版未实现。

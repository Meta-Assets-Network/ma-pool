# RewardSystemV3 升级说明（V2 → V3）

> 日期:2026-06-12
> 合约:`contract/contracts/RewardSystemV3.sol`
> 关联审查:`go-machain/docs/reward-sweep-review.md`(链端集成审查,本次升级修复其中 #1、#5)
> **升级后代理地址不变、owner 不变、`rewardForBlock`/`sweepAddress` 两个 selector 不变,链端零改动。**

---

## 一、为什么要升级

### 核心问题:`sweepAddress()` 的 gas 悬崖(审查 #1,高危)

链端(`go-machain/core/reward_registry.go`)每块用 **100,000 gas** 上限
StaticCall 本合约的 `sweepAddress()` 决定奖励归集地址。V2 的实现对
`activeList` **线性扫描**,每个激活矿工约两次冷 SLOAD(`activeList[i]` +
`miners[m].staked`)≈ 4200 gas:

```
V2 成本 ≈ 5000(入口)+ 4250 × 扫描到的矿工数
100,000 gas ⇒ 最多扫约 22 个矿工
```

后果(激活矿工数 ≥ ~22 时):

- 随机数命中靠后的矿工 ⇒ 扫描中途 **OOG** ⇒ 链端回退,**整块奖励静默流向
  `HardcodedSweepFallback`**;
- 命中位置随 seed 随机 ⇒ 临界规模附近"部分块正常、部分块奖励消失",难排查;
- 超过临界后 **index ≥ ~22 的矿工永远不可能被命中**,但其权重仍计入分母
  `totalWeight`,等于把对应概率质量全部转给 fallback 地址;
- 全网所有节点对同一块的 OOG 行为一致,**不会产生 bad block**,但属于
  必然发生的业务事故 —— 矿工规模增长到 ~22 就触发。

链端的 `registryCallGas = 100_000` 是共识参数(编译期常量),调大意味着
全网协调硬分叉,且只是把悬崖推远;根治必须在合约侧把抽样复杂度降下来。

### 一并修复:`setNft` 可锁死用户 NFT(审查 #5,中危)

`unstake` 用**当前** `$.nft` 执行 `transferFrom(address(this), ...)`。若在
`totalStaked > 0` 时切换 NFT 合约,旧合约里的存量质押 NFT 将永久滞留本合约
(新合约中本池并不持有对应 tokenId,unstake 直接 revert)。

---

## 二、方案:Fenwick 树(树状数组)加权抽样

把"前缀和定位"从线性扫描换成 Fenwick 树下降:

| | V2(线性扫描) | V3(Fenwick) |
|---|---|---|
| `sweepAddress()` 读成本 | O(n),~4250/矿工 | **O(log n),固定 17 次 SLOAD ≈ 43k gas** |
| 100k gas 下可支持矿工数 | ~22 | **65536(容量上限,与 gas 无关)** |
| 权重更新(stake/unstake/activate/deactivate) | O(1) | O(log n),最多 17 次 SSTORE(最坏 ~350k gas) |

成本从"每块全网读"转移到"矿工自己的写交易"——写路径多出的 gas 相对
stake 一笔转几十个 NFT 的开销是噪音,且由操作者自己承担。

不选 alias method(O(1) 查询)的原因:它每次权重变化需要 O(n) 重建概率表,
链上不可行;Fenwick 读写均为 O(log n),是链上加权抽样的标准解。

**抽样分布与 V2 完全一致**:同一 seed、同一权重集合,命中结果与线性扫描
逐项相同(`r` 落在哪个矿工的前缀和区间就选谁),只是定位算法不同。

---

## 三、改了哪里(V2 → V3 全部差异)

### 存储(升级安全的关键)

`PoolStorage` **仅在末尾追加**一个字段,既有 8 个字段一字未动:

```solidity
mapping(uint256 => uint256) fen; // Fenwick 树,1-indexed
// 不变量:fen[FEN_CAPACITY] == totalWeight
```

ERC-7201 命名空间(`machain.storage.RewardPool`)与槽位常量不变。

### 函数级差异

| 位置 | 改动 | 原因 |
|---|---|---|
| `sweepAddress()` | 线性扫描循环 → `activeList[_fenFind($, r)]` | 核心修复;selector/可见性/返回类型不变 |
| `_fenAdd` / `_fenFind` | **新增** 私有函数 | 树的点更新(固定传播到 FEN_CAPACITY,保证 append 语义)与前缀和下降 |
| `activate()` | 新增 `activeList.length >= FEN_CAPACITY` 检查(revert `CapacityExceeded`);入列后 `_fenAdd` 写入权重 | 树为固定规模 2^16;维护树 |
| `deactivate()` | 改为先取 `w = weightFor(md.staked)` 再 `_removeActive($, ..., w)` | 树上需要明确的被移除权重 |
| `_syncWeight()` | 同步 `totalWeight` 之外,追加 `_fenAdd(activeIndex+1, 新权重-旧权重)` | stake/unstake 改变质押量时维护树 |
| `_removeActive()` | **签名变更**:新增 `uint256 removedWeight` 参数;swap-remove 时把队尾矿工权重从 `lastIdx` 搬到 `idx`(两次 `_fenAdd`) | ① unstake 自动失活路径里 `md.staked` 已先扣减,函数内重算会得到错误权重,必须由调用方传入;② 队尾搬移必须在树上同步,否则下标与权重错位 |
| `setNft()` | 新增 `totalStaked != 0` 时 revert `StakeNotEmpty` | 修复审查 #5,防止锁死用户 NFT |
| `initializeV3()` | **新增**,`reinitializer(3) onlyOwner`:遍历现存 `activeList` 把权重灌入树 | V2 → V3 数据迁移 |
| `fenTotal()` | **新增** view:返回 `fen[FEN_CAPACITY]` | 运维校验,应恒等于 `totalWeight()` |
| 常量 `FEN_CAPACITY` | **新增** `= 65536`(2^16) | 树规模即激活矿工容量上限 |
| 错误 `CapacityExceeded` / `StakeNotEmpty` | **新增** | 配合上述检查 |
| NatSpec | `sweepAddress` 描述由"决定出块者"改为"奖励/手续费归集地址" | 与链端实际语义对齐(不参与出块者选择,仅做 fee sweep 归集) |

### 刻意不改的

- `rewardForBlock()`:pure、恒 1e18,不动;
- `stake()` / `unstake()` 主体、`minerList`/`tokens` 簿记、全部既有
  view、事件、`currentSeed()`:不动;
- 两个共识 selector(`0x04fc2a66` / `0x4957d325`)、返回 ABI:不动
  —— **链端 `reward_registry.go` 与 `registryCallGas = 100_000` 零改动**。

### ⚠️ 与 V2 运营手册的行为差异

`UPGRADE.md` 运营动作一节写的"更换 NFT 合约(如需):`setNft(addr)`"在
V3 起**要求池内无存量质押**。如确需带质押迁移 NFT 合约,需先另行设计迁移
方案(新 NFT 合约预铸/镜像本池持仓),或临时升级放开守卫 —— 默认守住,
防止误操作锁死用户资产。

---

## 四、升级步骤

```bash
cd contract && npm install && npm test          # 全绿再动真链

export OWNER_KEY=0x...                          # 基金会 owner 私钥
export PROXY_ADDRESS=0x...                      # 链上 RewardSystem 代理
```

**必须用 `upgradeToAndCall` 把切换实现与 `initializeV3()` 放在同一笔交易**
(OZ 插件 `upgradeProxy` 传 `call: {fn: "initializeV3"}`)。原因:若拆成两笔,
夹在中间的区块走新实现但树还是空的 ⇒ `sweepAddress()` 数组越界 revert ⇒
这些块的奖励全部落到 `HardcodedSweepFallback`。

```ts
await upgrades.upgradeProxy(PROXY_ADDRESS, RewardSystemV3, {
  call: { fn: "initializeV3", args: [] },
});
```

`initializeV3` 的 gas:每个现存激活矿工 ~17 次 SSTORE。当前主网激活矿工
< 22(再多 V2 早已触发悬崖),整笔 < 2M gas,一笔可完成。若未来在激活矿工
很多的环境重放此升级,需评估单笔 gas 上限。

## 五、升级后验收

```bash
# 1. selector 与产量不变
cast call $PROXY "rewardForBlock(uint256)(uint256)" 1     # 1000000000000000000

# 2. 树与分母一致(核心不变量)
cast call $PROXY "fenTotal()(uint256)"                    # 必须 == ↓
cast call $PROXY "totalWeight()(uint256)"

# 3. 用链端同款 gas 上限验证抽样不再 OOG(关键回归)
cast call --gas-limit 100000 $PROXY "sweepAddress()(address)"

# 4. 容量常量
cast call $PROXY "FEN_CAPACITY()(uint256)"                # 65536
```

以下回归已在 `contract/test/RewardSystemV3.test.ts` 落地(`npm test` 全量 49 项),
真链升级前在 devnet 复跑同等场景即可:

1. 灌 **50+ 个激活矿工**(超过 V2 的 ~22 悬崖),`--gas-limit 100000` 调
   `sweepAddress()`,连续多个高度均须成功返回激活矿工而非 fallback;
2. fuzz 对拍:随机 `stake`/`unstake`/`activate`/`deactivate` 序列后断言
   - `fenTotal() == totalWeight()`;
   - 对若干个 r ∈ [0, totalWeight),`_fenFind` 结果与朴素线性扫描一致
     (测试合约里复刻 V2 循环做参照);
3. 边界:`unstake` 跌破 100 自动失活、失活后再 `activate`、swap-remove
   命中队尾/非队尾,每步之后复查上述两条不变量。

## 六、本次明确不修、留待决策的

- **出块者可预测/可操纵**(审查 #4):seed = `keccak(高度, 父块哈希)`,父块
  一出下一块赢家即公开;且质押/激活同块立即生效,可看到 seed 后在同块调仓
  改写命中区间。修复需要"权重下一高度生效"的延迟快照,改动面大、影响产品
  语义,与本次性能升级解耦,单独评审。
- 链端事项(base fee 记账、TxContext 对齐、调试日志等)见
  `go-machain/docs/reward-sweep-review.md` #2/#3/#6,在 go-machain 仓库处理。

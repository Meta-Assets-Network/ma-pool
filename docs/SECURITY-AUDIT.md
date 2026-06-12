# MA Pool 合约安全审计报告

**审计范围**：`contract/contracts/` 下三份合约
- `RewardSystemV2.sol`（385 行，UUPS 升级实现，POCC 出块者选择 + 质押逻辑）
- `RewardSystemV1.sol`（42 行，链上现状基线）
- `MSTToken.sol`（27 行，矿工凭证 NFT）

**编译器 / 依赖**：solc 0.8.24，OpenZeppelin 5.0.2 / contracts-upgradeable 5.0.2
**审计日期**：2026-06-12
**审计方式**：人工逐行审计 + ERC-7201 存储槽常量复算（已核对一致）

> 重要背景：`RewardSystemV2.sol` 不是普通业务合约。链共识（POCC）**每个区块**通过 `eth_call` 读取
> `sweepAddress()` 决定出块者、读 `rewardForBlock()` 决定产量。因此本合约的随机数与可用性问题
> 直接等价于"出块权与区块奖励的分配安全"，威胁模型比一般 DeFi 合约更严苛。

---

## 结论摘要

| 编号 | 严重度 | 标题 |
|------|--------|------|
| C-1 | 严重 (Critical) | 出块者随机源可预测且可被矿工碾磨（grinding）操纵 |
| H-1 | 高 (High) | 升级与 `initializeV2` 非原子，期间区块奖励 sweep 到 `address(0)` 被销毁 |
| H-2 | 高 (High) | Owner 单点全权：可任意升级实现、改 sweep 目标，等于掌控全部出块奖励 |
| M-1 | 中 (Medium) | `setNft` 在已有质押时切换会破坏 `stakerOf` 记账，NFT 可能无法取回 |
| M-2 | 中 (Medium) | `sweepAddress()` 对 `activeList` 做 O(n) 全量遍历，每块执行，存在 gas 增长 / DoS 面 |
| L-1 | 低 (Low) | 无暂停（pause）开关，紧急情况下无法停止质押/取回 |
| L-2 | 低 (Low) | NFT 合约被信任假设过强；非标准 ERC721 会破坏不变量 |
| I-1 | 提示 (Info) | 段位系数对大户线性加成，加剧出块权集中（设计取舍） |
| I-2 | 提示 (Info) | CEI 顺序：`unstake` 在状态更新前转出 NFT（当前因用 `transferFrom` 无回调而安全） |

---

## C-1 · 严重 — 出块者随机源可预测且可被碾磨操纵

**位置**：`RewardSystemV2.sol:148-151`（`currentSeed`）、`:128-145`（`sweepAddress`）

```solidity
function currentSeed() public view returns (uint256 blockNumber, bytes32 seed) {
    blockNumber = block.number;
    seed = keccak256(abi.encodePacked(block.number, blockhash(block.number - 1)));
}
```

出块者由 `r = uint256(seed) % totalWeight` 在激活矿工间加权命中。问题在于种子的全部输入
（`block.number`、`blockhash(block.number-1)`）在区块 N 被生产之前就已经**完全确定且公开可计算**。
由此引出三条攻击路径：

1. **完全可预测**：任何人在区块 N-1 落定的瞬间即可算出 N 的中奖者。对"出块权应不可预测"的共识来说，
   这本身就消除了随机性的意义。

2. **上一块生产者碾磨（最关键）**：`blockhash(N-1)` 由 N-1 的生产者影响。通过调整 N-1 的内容
   （交易排序、时间戳、塞入一笔空操作交易改变 nonce/状态根），生产者可以枚举多个候选块哈希，
   挑出使**指定矿工（如自己）**在 N 中奖的那个。当激活矿工只有数百个时，碾磨成本极低。
   连续掌握出块权的一方可借此把 1 MA/块 的奖励持续偏向自己——这是直接的经济攻击。

3. **质押时序操纵**：由于下一块的种子可观测，而 `r = seed % totalWeight`，攻击者只要让一笔
   `stake/activate/deactivate` 在共识评估 `sweepAddress()` 之前被打包，就能改变 `totalWeight`
   与累加桶边界，把中奖下标挪到自己地址上。

**影响**：区块奖励（真实价值）的分配可被操纵 → 共识公平性与经济模型被破坏。

**建议**：
- 不要用"紧邻的上一块哈希"在"分配该块奖励的同一合约"里就地派生随机数。
- 采用对生产者不可偏置的随机信标：链下 VRF（如 drand / Chainlink VRF 思路）、提交-揭示
  （commit-reveal），或由共识层在区块 N 生产**之后**才可知的值来决定 N 的归属（例如用 N 之后
  若干块的哈希做延迟结算，配合不可重组假设）。
- 至少应在共识层固定"读取 `sweepAddress()` 的时刻"早于任何能改 `totalWeight` 的交易，封堵路径 3。

---

## H-1 · 高 — 升级与初始化非原子，间隙内奖励被销毁

**位置**：`scripts/upgrade-chain.ts:48-51`、`scripts/deploy-local.ts:63-73`、`RewardSystemV2.sol:128-131`

升级流程是两笔独立交易：

```ts
const pool = await upgrades.upgradeProxy(proxyAddress, V2);   // tx1
await (await pool.initializeV2(nftAddr, fallbackAddr)).wait(); // tx2
```

`upgradeProxy` 完成后，`PoolStorage` 全为零值：`totalWeight == 0`、`fallbackAddress == address(0)`。
此时 `sweepAddress()` 走 `if (tw == 0) return $.fallbackAddress;` → **返回 `address(0)`**。
而 `rewardForBlock()` 仍恒返回 `1e18`。于是在 tx1 与 tx2 之间产出的每一个区块，1 MA 奖励都会
sweep 到零地址被销毁（不可找回）。在真链上这两笔交易之间至少隔若干个区块。

**影响**：升级窗口内持续的奖励损失；若 tx2 因 gas/nonce 失败或被遗忘，损失会一直持续。

**建议**：用 OZ 支持的原子升级，把初始化作为升级调用的一部分在**同一笔交易**内完成：

```ts
await upgrades.upgradeProxy(proxyAddress, V2, {
  call: { fn: "initializeV2", args: [nftAddr, fallbackAddr] },
});
```

并在 `initializeV2` 未执行前，让 `sweepAddress()` 的零地址兜底退回到 V1 硬编码地址而非 `address(0)`
（防御性双保险）。

---

## H-2 · 高 — Owner 单点掌控全部出块奖励

**位置**：`RewardSystemV2.sol:102`（`_authorizeUpgrade`）、`:106-116`（`setNft`/`setFallbackAddress`）

`_authorizeUpgrade` 仅 `onlyOwner`，owner 可把实现升级为任意逻辑——包括一份让
`sweepAddress()` 永远返回自己地址的实现，从而独吞所有区块奖励。加上 `setFallbackAddress` 可改无矿工
时的接收地址，owner 实际拥有对共识奖励分配的完全控制。这是 UUPS 的固有属性，但在"合约输出即出块权"
的场景下风险被放大。

**影响**：单个私钥泄露 = 整链区块奖励被劫持。

**建议**：
- 将 owner 设为多签（如 Safe）+ 升级延时（TimelockController），给社区留出观测/退出窗口。
- 公示升级治理流程；考虑对 `setFallbackAddress`、`setNft` 加 timelock 或事件预告。

---

## M-1 · 中 — `setNft` 在已有质押时切换会破坏取回

**位置**：`RewardSystemV2.sol:106-110`

```solidity
function setNft(address nft_) external onlyOwner {
    if (nft_ == address(0)) revert ZeroAddress();
    _s().nft = IERC721(nft_);
    ...
}
```

`setNft` 没有任何"仅在 `totalStaked == 0` 时允许"的约束。若在已有 NFT 质押其中时被调用，
后续 `unstake` 会对**新** NFT 合约调用 `transferFrom(address(this), msg.sender, id)`：
合约并不持有新 NFT 的这些 tokenId，调用 revert，用户资产被永久锁死在旧记账里；同时
`stakerOf_` / `tokens` 等记账仍指向旧合约，状态彻底错乱。

**建议**：要求 `require(_s().totalStaked == 0)` 才允许 `setNft`，或干脆移除该函数、NFT 地址只在
`initializeV2` 设定一次（不可变）。

---

## M-2 · 中 — 每块 O(n) 遍历激活矿工，存在 gas 增长 / DoS 面

**位置**：`RewardSystemV2.sol:136-142`

`sweepAddress()` 对 `activeList` 全量线性扫描，且由共识**每个区块**经 `eth_call` 调用。激活矿工数
增长时，单块共识调用的成本线性上升。虽然每个激活矿工需质押 ≥100 枚 NFT（受 NFT 总供给与经济成本
约束，攻击门槛较高），但仍应评估：
- 共识 `eth_call` 的 gas 上限是否能容纳预期最大激活矿工规模；
- 是否需要前缀和 / 二分等 O(log n) 选择结构，避免规模上来后每块共识变慢。

**建议**：以预期上限做基准压测；必要时改用累积权重的二分查找（需维护有序前缀和）。

---

## L-1 · 低 — 缺少紧急暂停

无 `Pausable`。一旦发现被操纵或异常，无法临时冻结 `stake/unstake/activate`。建议引入
OZ `PausableUpgradeable` 并对状态变更函数加 `whenNotPaused`（注意 `sweepAddress` 读路径应保持可用）。

## L-2 · 低 — 对 NFT 合约的信任假设过强

`stake/unstake` 依赖 `nft.transferFrom` 行为标准。若 owner 误设为非标准/可重入的 ERC721，
swap-remove 记账（`tokens` / `tokenPos` / `stakerOf_`）可被破坏。当前 NFT 由项目方部署且 owner 设置，
风险可控，但与 M-1 一并建议把 NFT 地址设为不可变。

## I-1 · 提示 — 段位系数加剧集中

`multiplierBpsFor`：<600→1.00x，≥600→1.05x，≥6000→1.15x。大户在"按 staked 比例中奖"之外还获得
每枚 NFT 的额外加成，出块权进一步向大户集中。属经济设计取舍，非漏洞，但与 C-1 叠加会放大被操纵收益。

## I-2 · 提示 — CEI 顺序

`unstake`（`:206-223`）在 `md.staked -= ...` 等状态更新**之前**于循环内转出 NFT。当前因使用
`transferFrom`（非 `safeTransferFrom`，接收方无 `onERC721Received` 回调）而**不存在重入**，结论安全。
但这是隐性依赖：若日后改用 `safeTransferFrom`，将立即出现重入窗口。建议保持注释说明，或干脆遵循
先改状态、后转账的 CEI 顺序。

---

## 已核对正确、未发现问题的点

- **ERC-7201 存储槽常量**：`POOL_STORAGE_LOCATION` 经 `cast keccak` 复算与声明值
  `0xb58d…4a00` **完全一致**；命名空间存储正确，升级不会与 V1 线性槽冲突。
- **权重记账一致性**：`stake / unstake / activate / deactivate / _syncWeight / _removeActive`
  对 `totalWeight` 的增减在各路径上前后一致（`wasWeight` 用旧值、新增用 `weightFor(新 staked)`），
  未发现 `totalWeight` 与 `activeList` 实际权重和漂移。
- **加权命中区间**：`r = seed % tw` 配合 `acc += weight; if (r < acc) return m;` 正确划分 `[0, tw)`，
  无 off-by-one；权重和恒等于 `tw`，兜底 `return fallbackAddress` 不可达但保留合理。
- **swap-remove**：`tokens`、`minerList`、`activeList` 三处 swap-remove 的下标与反查表维护正确，
  含"删除末元素"分支。
- **`MSTToken.mint`**：`onlyOwner`、`_nextId` 自增、`_safeMint` 使用正确；连续 tokenId 自 1 起。
- **`initializeV2` 防重入初始化**：`reinitializer(2)` + `onlyOwner` + 零地址校验到位；二次调用会 revert。
- **算术溢出**：`staked` 为 NFT 计数（受供给约束），`weightFor = staked × ≤11500`，0.8.24 默认溢出检查下无实际溢出风险。
- **重复 tokenId 质押**：同笔重复 id 会在第二次 `transferFrom` 因不再持有而 revert，不会重复记账。

---

## 优先级建议

1. **C-1（随机源）** 必须在主网承载真实价值前重新设计——这是本系统的核心安全前提。
2. **H-1（原子升级）** 改为 `upgradeProxy(..., { call: initializeV2 })`，零成本即可消除奖励销毁窗口。
3. **H-2（治理）** 上多签 + timelock。
4. **M-1（setNft）** 加 `totalStaked == 0` 约束或设为不可变。
5. M-2/L-1/L-2 视上线规模与运维需要安排。

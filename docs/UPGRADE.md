# 真链升级手册（Meta Assets Chain）

把链上现有 `RewardSystem`（UUPS 代理，V1：写死 sweep 地址）升级为 `RewardSystemV2`。
**升级后代理地址不变、owner 不变、`rewardForBlock`/`sweepAddress` 两个 selector 不变**，链端 POCC 调用方零改动。

## 前置

- 基金会 owner 私钥（代理的 `owner()`，唯一有权 `_authorizeUpgrade`）
- 代理地址（链上已存在）
- 已决定的 MST NFT 地址（不传则脚本现场部署一个，foundation = owner）

## 步骤

```bash
cd contract && npm install && npm test          # 39 项必须全绿再动真链

export OWNER_KEY=0x...                          # 基金会 owner 私钥
export PROXY_ADDRESS=0x...                      # 链上 RewardSystem 代理
export NFT_ADDRESS=0x...                        # 可选；留空=脚本部署 MST
export FALLBACK_ADDRESS=0x281F73d00751aEb5f64e76c8B9137d3AA8499762   # 可选；默认 V1 写死地址

npm run upgrade:chain
```

脚本动作（与本地端到端同一条代码路径）：
1. `forceImport` 重建本机升级清单（首次在新机器上操作时需要）
2. `upgradeProxy` → 部署 V2 实现并切换（OZ 插件校验存储布局与 UUPS 合规）
3. `initializeV2(nft, fallback)`（`reinitializer(2)`，只能执行一次）
4. 回读 `rewardForBlock(1)` 与 `sweepAddress()` 打印确认

## 升级后验收

```bash
# macscan（https://macscan.io）上看代理地址的 implementation 槽已指向新实现
# 任意节点验证（升级后、矿工激活前）：
cast call $PROXY_ADDRESS "rewardForBlock(uint256)(uint256)" 1   # 1000000000000000000
cast call $PROXY_ADDRESS "sweepAddress()(address)"              # = FALLBACK_ADDRESS（无激活矿工时）
```

矿工开始质押并 `activate()` 后，`sweepAddress()` 即按高度随机数加权选择激活矿工。

## 运营动作

- 基金会铸造：`MSTToken.mint(to, quantity)`（仅 owner；批量 ≤80/笔 视链 gas 上限调整）
- 矿工：`setApprovalForAll(pool, true)` → `stake(tokenIds[])`（≤40/笔）→ `activate()`
- 调整 fallback：`setFallbackAddress(addr)`（owner）
- 更换 NFT 合约（如需）：`setNft(addr)`（owner，谨慎：不影响已质押记录，仅影响后续转移调用的目标合约——原则上只在 NFT 迁移时使用）

## 回滚

UUPS 支持再次升级：紧急情况下 owner 可 `upgradeProxy` 回部署 V1 等价实现（`rewardForBlock` 与写死 `sweepAddress` 行为即恢复）。V2 状态保留在命名空间槽位，不受影响。

## 后端/前端切换到真链

- backend：`.env` 按 `.env.example` 填 `RPC_URL=https://rpc.ma-chain.xyz`、`POOL_ADDRESS=代理地址`、`START_BLOCK=升级所在高度`、`CONFIRMATIONS` 酌情 >0
- frontend：`.env.local` 设 `NEXT_PUBLIC_CHAIN_MODE=machain` + 两个合约地址 + 后端 API 地址

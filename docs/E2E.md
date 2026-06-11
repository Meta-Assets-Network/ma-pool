# 本地端到端测试手册（mock 链）

不触真链：Hardhat node 当 mock 链（chainId 31337），owner/矿工私钥全部脚本生成。
以下命令均从仓库根目录出发。

## 1. 启动 Postgres

```bash
docker compose up -d
docker inspect -f '{{.State.Health.Status}}' mapool-postgres   # → healthy
```

KV 表由后端启动时自动建（`kv(key PK, value jsonb, height, updated_at)` + height 索引）。

## 2. 合约：测试 → mock 链 → 部署

```bash
cd contract && npm install
npm test                 # 39 passing：段位边界/质押/激活/取回/事件/升级路径/选择分布
npm run node             # 终端 A：mock 链 http://127.0.0.1:8545
```

另开终端：

```bash
cd contract
npm run deploy:local     # 生成 owner → V1代理 → 升级V2 → MST → 铸NFT(120/650/300) → 质押/激活/取回
npm run export-abi       # ABI → backend/src/abi、frontend/src/lib/abi
```

`deploy:local` 输出并落盘：
- `contract/deployments/local.json`（owner/矿工私钥、合约地址、起止高度）
- `backend/.env.local`、`frontend/.env.local`（自动配好地址与 RPC）

模拟活动产出的事件：矿工A 质押120→激活→取回30→**自动失活**；矿工B 质押650→激活（1.05×段位）；矿工C 质押300 不激活。

## 3. 后端：编译启动，追平 tophead

```bash
cd backend && npm install
npm test                 # KV 键编码单测
npm run build && npm start
```

验证：

```bash
curl -s localhost:8787/api/status   # scannedHeight == chainHead, lag=0
curl -s localhost:8787/api/stats    # totalWeight/totalCU/minerCount/activeCount 与链上一致
curl -s "localhost:8787/api/events?fromBlock=0&toBlock=999&limit=1000"   # Staked/MinerActivated/Unstaked/MinerDeactivated...
curl -s "localhost:8787/api/events?fromBlock=21&toBlock=30"              # 任意高度区间切片
curl -s localhost:8787/api/miners
```

## 4. 出块分布采样（加权随机正确性）

```bash
cd contract
SAMPLES=300 npm run sample
# 输出每个激活矿工: theory=理论占比  sampled=实测命中率（±几 pp 内）
```

采样会 `hardhat_mine` 推进高度；后端会实时追上（再看 /api/status 仍 lag=0）。

## 5. 前端

```bash
cd frontend && npm install
npm run dev              # http://localhost:3000（.env.local 已是 local 模式）
```

- 不连钱包即可看到：总算力 CU、矿工 2/3、每块奖励 1 MA、本块 sweepAddress+seed、事件流（已追平）
- 连 MetaMask 走完整流程：导入 `contract/deployments/local.json` 里的矿工私钥 →
  添加本地网络（RPC http://127.0.0.1:8545，chainId 31337）→ 质押/激活/取回
- 切到 `NEXT_PUBLIC_CHAIN_MODE=machain`（frontend/.env.local）即指向真链参数：
  错链时横幅引导切换，MetaMask 无 MA 链会自动弹"添加网络"（含 RPC/MA 符号/macscan）

## 已验证结果（2026-06-12 本机）

- 合约 39/39 通过；后端 KV 单测 4/4；两端 build 0 错误
- 扫链：[21,74] 一批入库，事件 39 条对账一致（Staked×28、Activated×2、Unstaked×1、Deactivated×1、Nft/Fallback 配置×2、代理生命周期×5）
- 采样后高度 375，索引器 lag=0；激活 C 后 totalWeight 9,825,000（982.5 CU）
- 300 块采样：B 理论 69.46% 实测 67.00%；C 理论 30.53% 实测 33.00%

## 批量大小说明（重要）

EIP-7825（Osaka）给单笔交易 gas 设了 2^24=16,777,216 上限，本工程按此口径取批量：
**铸造 ≤80 枚/笔、质押/取回 ≤40 枚/笔**（ERC721Enumerable 单枚转移 ≈ 33 万 gas）。
mock 链 blockGasLimit 已放宽到 60M；真链请按其区块/交易 gas 上限调整批量。

## 清理

```bash
docker compose down          # 加 -v 连数据卷一起删
pkill -f "hardhat node"; pkill -f "node dist/index.js"; pkill -f "next dev"
```

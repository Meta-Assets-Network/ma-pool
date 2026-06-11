# MA Pool · Meta Assets Chain POCC 矿池

三端工程：**contract**（MST NFT + 矿池 UUPS 升级版）/ **backend**（扫链索引 + API）/ **frontend**（Next.js dapp）。

- 链：Meta Assets Chain（chainId `20260131`，符号 MA，https://rpc.ma-chain.xyz ，浏览器 https://macscan.io）
- 共识：POCC —— 链每块 `eth_call` 矿池合约：`rewardForBlock(height)`（恒 1 MA）与 `sweepAddress()`（激活矿工间按算力加权随机）
- 版本锁定：Solidity 0.8.24 / OpenZeppelin 5.0.2 / UUPS（与链上 V1 一致）

**文档集中在 [docs/](docs/README.md)**：

- [docs/README.md](docs/README.md) — 架构与规则总览
- [docs/E2E.md](docs/E2E.md) — 本地 mock 链端到端手册（已验证）
- [docs/UPGRADE.md](docs/UPGRADE.md) — 真链升级手册
- [docs/API.md](docs/API.md) — 后端 API 与 KV 键空间

快速开始：

```bash
docker compose up -d                                   # Postgres
cd contract && npm i && npm test && npm run node       # mock 链（终端 A）
npm run deploy:local && npm run export-abi             # 部署+生成 env（终端 B）
cd ../backend && npm i && npm run build && npm start   # 索引器+API（终端 C）
cd ../frontend && npm i && npm run dev                 # dapp（终端 D）
```

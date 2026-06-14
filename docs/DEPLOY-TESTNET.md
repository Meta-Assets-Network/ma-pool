# MA Pool 测试网部署交付文档

> 日期：2026-06-14
> 链：Meta Assets Chain **测试网**（chainId **20260130**）
> 状态：合约已升级 V4、NFT 已发、6 个矿池已激活并在挖矿、前后端 + HTTPS 已上线并验证

---

## 一、访问入口

| 项 | 地址 |
|---|---|
| 矿池 dApp（前端） | **https://pool.metaassetschain.org** |
| 扫链 API（后端） | **https://pool.metaassetschain.org/api** （如 `/api/stats`、`/api/miners`、`/api/status`、`/api/events`） |
| 证书 | Let's Encrypt（有效期 2026-06-14 → 2026-09-12，certbot 自动续期），80 → 443 强制跳转 |
| 链 RPC（对外 https） | https://rpc.machaintest.com |
| 区块浏览器 | https://machaintest.com |

## 二、合约地址（链上实测）

| 合约 | 地址 |
|---|---|
| **矿池 RewardSystemV4（UUPS 代理，链共识读取的就是它）** | `0xE038256A6f08343d659b3f0D798e7BeC1E392C9C` |
| 矿池当前实现 impl（V4） | `0x4AE9E1Dd22146e4c197e0DDE3fbffA5a652C0D8F` |
| **NFT 合约 MSTToken（symbol MST）** | `0xF6Ea76885f46493640045822A8EeB96028BDABfE` |
| **Owner / 基金会（铸造权 + 升级权）** | `0x388153E2D9c654A720f91c1b3256Ab50c8F5a252` |
| 无激活矿工时的 fallback sweep 地址 | `0x281F73d00751aEb5f64e76c8B9137d3AA8499762` |

- 升级链路：V1 → V2 → V3 → V4（每步 `upgradeToAndCall` 原子升级），代理地址、owner、`rewardForBlock`/`sweepAddress` selector 全程不变，链节点零改动。
- `rewardForBlock` 恒 = 1e18（每块 1 MA）。`sweepAddress()` 现按 V4 延迟一块加权随机，在激活矿工间分配。

## 三、6 个矿池（每个质押 100 个 MST = 100 CU，激活）

| # | 矿池地址 |
|---|---|
| 1 | `0x9117366A04a91294A54f338D846ffC4c32C04c61` |
| 2 | `0xf45F6d2F5F1333506664b1b69971FcFC4b14DAC5` |
| 3 | `0x595783E2a488Aff46B42236834058265B36B3CAe` |
| 4 | `0x9ac5A5136B9C11443A13Bf10d252e2c997F222A4` |
| 5 | `0x2db2b5E2dAf11B9892c3A4f82c509daBf8790530` |
| 6 | `0xF8C8306a2a6b31281E000f8FB3a5a05af7bc4305` |

- **矿池私钥文件（保留）**：服务器 **`/root/ma-pool/pools/pool-keys.json`**（权限 `600`，仅 root 可读，含 6 个矿池地址 + 私钥）。
- 当前 `totalWeight = 6,000,000`（6 × 100 × 10000），`activeMinerCount = 6`，每个矿池爆块概率 = 1/6。
- 挖矿已运转：链每块在 6 矿池间加权随机选 1 个发 1 MA，矿池余额持续增长。

## 四、Owner 私钥（已按要求删除）

- 服务器上的 owner 私钥文件 `/root/priv.txt` 及其在 `/root/ma-pool/contract/.env` 中的副本 `MATEST_KEY` **已删除**，机器上不再保存 owner 私钥。
- 后果：以后若要**铸更多 NFT、增删矿池、再次升级合约**等需要 owner 签名的操作，需重新把 owner 私钥放回。流程见第六节。
- 矿池挖矿本身由链共识自动驱动，**不需要任何私钥在线**；矿池私钥仅在该矿池要 stake/unstake/activate/deactivate 时才需要。

## 五、服务部署拓扑（均在 18.207.199.194）

| 组件 | 进程/容器 | 端口 | 备注 |
|---|---|---|---|
| 前端 dApp（Next.js） | pm2 `ma-pool-frontend`（ubuntu） | 127.0.0.1:3100 | 代码 `/home/ubuntu/ma-pool/frontend` |
| 后端扫链 + API（TS） | pm2 `ma-pool-backend`（ubuntu） | 127.0.0.1:8787 | 代码 `/home/ubuntu/ma-pool/backend` |
| Postgres（后端 KV 存储） | docker `mapool-postgres` | 127.0.0.1:5433 | 卷 `mapool-pgdata`，库/账号/密码均 `mapool` |
| 合约工程（升级/运维脚本） | — | — | `/root/ma-pool/contract` |
| Nginx 站点 | `pool.metaassetschain.org` | 80/443 | `/etc/nginx/sites-available/pool.metaassetschain.org`；`/`→3100，`/api/`→8787 |

- 前端环境：`/home/ubuntu/ma-pool/frontend/.env.local`（`NEXT_PUBLIC_CHAIN_MODE=testnet`、合约地址、`NEXT_PUBLIC_API_URL=` 走同域 `/api`）。
- 后端环境：`/home/ubuntu/ma-pool/backend/.env.local`（本地 RPC `127.0.0.1:8545`、合约地址、`DATABASE_URL`、`START_BLOCK`）。
- 进程已 `pm2 save`，随 pm2 自启恢复。

## 六、常用运维

**查状态（只读，无需私钥）**
```bash
curl -s https://pool.metaassetschain.org/api/stats     # 总算力/矿工数/扫链高度
curl -s https://pool.metaassetschain.org/api/miners    # 6 矿池明细
ssh root@18.207.199.194 'sudo -u ubuntu pm2 ls'        # 前后端进程
```

**需要 owner 的操作（先放回 owner 私钥，再用完即删）**
```bash
ssh root@18.207.199.194
cd /root/ma-pool/contract
# 把 owner 私钥写回 .env（0x 开头）：
printf 'MATEST_KEY=%s\n' '0x<owner私钥>' >> .env
# 例：再创建更多矿池
POOL_COUNT=3 PROXY_ADDRESS=0xE038256A6f08343d659b3f0D798e7BeC1E392C9C \
  NFT_ADDRESS=0xF6Ea76885f46493640045822A8EeB96028BDABfE \
  npx hardhat run scripts/setup-testnet-pools.ts --network matest
# 用完务必清掉：
sed -i '/^MATEST_KEY=/d' .env
```

**重启服务**
```bash
ssh root@18.207.199.194 'sudo -u ubuntu pm2 restart ma-pool-backend ma-pool-frontend'
```

## 七、交付验证快照（2026-06-14）

- 合约：`owner=0x388153…a252`、`nft=0xF6Ea76…`、`totalWeight=6000000`、`activeMinerCount=6`，链上实测一致。
- 后端：`/api/status` `lag=0` 追平链头；`/api/miners` 返回 6 矿池，各 100 CU、概率 1/6、active。
- 挖矿：`sweepAddress()` 隔块采样命中多个不同矿池（同块确定、跨块随机切换）；6 矿池余额从初始 ~1 MA 全部增长至 70–90 MA（持续收到出块奖励，分布均匀）。
- HTTPS：前端 200、`/api` 200、80→301 跳 https、Let's Encrypt 证书有效。

## 八、已知提示

- 前端 `next@14.2.32` 有安全更新提示（升级到补丁版即可），不影响当前运行。
- V4 仅修复"纯矿工质押时序操纵"（安全审计 C-1 路径 3）；出块者碾磨 `blockhash`（路径 2）需链层 VRF，按威胁模型（validator 可信内部）暂不处理。详见 `docs/UPGRADE-V4.md`、`docs/SECURITY-AUDIT.md`。

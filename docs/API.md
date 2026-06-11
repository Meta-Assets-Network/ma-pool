# 扫链后端 API

Base：`http://<host>:8787`，全部 GET / JSON / 已开 CORS。
数据来源：Postgres 单表 KV（事件键内嵌零填充高度，主键 btree 范围扫描，毫秒级区间查询）。

## GET /api/status

扫链进度与链头（游标直追 tophead 的证明）。

```json
{
  "scannedHeight": 375,
  "chainHead": 375,
  "lag": 0,
  "chainId": 31337,
  "pool": "0xc7eA…9f06",
  "nft": "0x492D…3acA"
}
```

## GET /api/events

区块高度区间事件查询。参数：

| 参数 | 说明 | 默认 |
|---|---|---|
| `fromBlock` | 起始高度（含） | 0 |
| `toBlock` | 截止高度（含） | 当前链头 |
| `miner` | 按矿工地址过滤（不区分大小写） | — |
| `name` | 按事件名过滤（Staked/Unstaked/MinerActivated/MinerDeactivated…） | — |
| `limit` | 条数上限（≤1000） | 200 |
| `order` | `asc` / `desc`（按 高度,txIndex,logIndex） | asc |

```json
{
  "fromBlock": 21, "toBlock": 74, "count": 2,
  "events": [
    {
      "name": "Staked",
      "miner": "0x287a…fea8",
      "args": { "miner": "0x287a…fea8", "amount": "40", "stakedAfter": "40", "tokenIds": ["1","2"] },
      "height": 60,
      "txHash": "0x…", "txIndex": 0, "logIndex": 3, "blockHash": "0x…"
    }
  ]
}
```

## GET /api/miners

全部矿工（质押 > 0）快照，按权重降序。

```json
{
  "totalWeight": "9825000",
  "miners": [
    {
      "address": "0x5c15…5d61",
      "staked": "650",
      "active": true,
      "multiplierBps": "10500",
      "weight": "6825000",
      "cu": 682.5,
      "probability": 0.694656,
      "height": 65
    }
  ]
}
```

`cu = weight / 10000`；`probability = weight / totalWeight`（仅激活矿工，非激活为 0）。

## GET /api/miners/:address

单矿工快照；未知地址 404。

## GET /api/stats

```json
{
  "totalWeight": "9825000",
  "totalCU": 982.5,
  "totalStaked": "1040",
  "minerCount": 3,
  "activeCount": 2,
  "height": 375,
  "scannedHeight": 375,
  "rewardPerBlock": "1000000000000000000"
}
```

## KV 键空间（表 `kv`：key PK / value jsonb / height / updated_at）

| 键 | 值 |
|---|---|
| `cursor:scan` | `{height}` 已扫游标，事务内与事件同步推进 |
| `evt:{height:12}:{txIndex:6}:{logIndex:6}` | 事件记录（见上） |
| `miner:{address}` | 矿工最新快照 |
| `stats:global` | 全局统计 |

区间查询即 `key >= 'evt:'+pad(from) AND key < 'evt:'+pad(to+1)`，零填充保证字典序 = 数值序。

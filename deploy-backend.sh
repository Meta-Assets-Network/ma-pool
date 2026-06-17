#!/usr/bin/env bash
#
# 部署 MA Pool 后端（扫链 + API）到测试服务器。
#
# 流程（与手动部署一致）：
#   1. rsync 本地 backend 源码 → 服务器（保留服务器的 .env.local / node_modules / dist）
#   2. 远端 npm install + npm run build（tsc → dist/）
#   3. build 成功才 pm2 restart（失败则保留旧版，进程不动）
#   4. 线上验证（/api/status 返回 200 且含 chainId）
#
# 后端是 TS，pm2 跑 `node dist/index.js`（见 docs/DEPLOY-TESTNET.md）。
# Postgres（docker mapool-postgres）独立长驻；KV 表由 db.ts 启动时自建，无单独 migration。
# 服务器 /home/ubuntu/ma-pool 非 git 仓库（直传代码），故用 rsync 而非 git pull。
#
# 用法：
#   ./deploy-backend.sh
#   SSH_KEY=~/.ssh/other.pem SERVER=ubuntu@1.2.3.4 ./deploy-backend.sh
#   RUN_INSTALL=0 ./deploy-backend.sh        # 跳过 npm install（依赖没变时更快）
#
set -euo pipefail

# ---- 配置（可用环境变量覆盖）----
SSH_KEY="${SSH_KEY:-$HOME/.ssh/machain.pem}"
SERVER="${SERVER:-ubuntu@18.207.199.194}"
REMOTE_DIR="${REMOTE_DIR:-/home/ubuntu/ma-pool/backend}"
PM2_APP="${PM2_APP:-ma-pool-backend}"
SITE_URL="${SITE_URL:-https://test.macpool.net}"
RUN_INSTALL="${RUN_INSTALL:-1}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LOCAL_BE="$SCRIPT_DIR/backend"
SSH_OPTS=(-i "$SSH_KEY" -o StrictHostKeyChecking=accept-new -o ConnectTimeout=15)

# ---- 预检 ----
[ -f "$SSH_KEY" ]      || { echo "✗ SSH 密钥不存在: $SSH_KEY"; exit 1; }
[ -d "$LOCAL_BE/src" ] || { echo "✗ 找不到后端源码: $LOCAL_BE/src"; exit 1; }

echo "▶ 部署后端 $LOCAL_BE → $SERVER:$REMOTE_DIR"

# ---- 1. 同步源码 ----
echo "▶ [1/4] rsync 源码（排除 node_modules / dist / .env*）…"
rsync -az --delete -i \
  --exclude node_modules --exclude dist --exclude '.env*' \
  -e "ssh ${SSH_OPTS[*]}" \
  "$LOCAL_BE/" "$SERVER:$REMOTE_DIR/"

# ---- 2 + 3. 远端 install + build，成功才重启 ----
echo "▶ [2/4] 远端 install + build，[3/4] 成功后 pm2 restart…"
ssh "${SSH_OPTS[@]}" "$SERVER" REMOTE_DIR="$REMOTE_DIR" PM2_APP="$PM2_APP" RUN_INSTALL="$RUN_INSTALL" bash -s <<'REMOTE'
set -e
cd "$REMOTE_DIR"
[ "$RUN_INSTALL" = "1" ] && npm install --no-audit --no-fund
if npm run build; then
  pm2 restart "$PM2_APP" --update-env
  sleep 2
  pm2 ls | grep -E "$PM2_APP" || true
else
  echo "BUILD_FAILED — 不重启，保留旧版"
  exit 1
fi
REMOTE

# ---- 4. 线上验证 ----
echo "▶ [4/4] 线上验证…"
code=$(curl -s -o /dev/null -w '%{http_code}' "$SITE_URL/api/status")
echo "  /api/status : HTTP $code"
[ "$code" = "200" ] || { echo "✗ /api/status 非 200"; exit 1; }
body=$(curl -s "$SITE_URL/api/status")
echo "  body        : $body"
echo "$body" | grep -q 'chainId' || { echo "✗ /api/status 响应异常"; exit 1; }
echo "✓ 部署完成：$SITE_URL/api"

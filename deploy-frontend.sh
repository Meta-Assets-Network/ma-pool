#!/usr/bin/env bash
#
# 部署 MA Pool 前端到测试服务器。
#
# 流程（与手动部署一致）：
#   1. rsync 本地 frontend 源码 → 服务器（保留服务器的 .env.local / node_modules / .next）
#   2. 远端 npm install + next build
#   3. build 成功才 pm2 restart（失败则保留旧版，进程不动）
#   4. 线上验证（首页 200 + 应用外壳 + 后端 /api/status）
#
# 服务器 /home/ubuntu/ma-pool 非 git 仓库（直传代码），故用 rsync 而非 git pull。
# 拓扑见 docs/DEPLOY-TESTNET.md。
#
# 用法：
#   ./deploy-frontend.sh
#   # 覆盖默认值（环境变量）：
#   SSH_KEY=~/.ssh/other.pem SERVER=ubuntu@1.2.3.4 ./deploy-frontend.sh
#   RUN_INSTALL=0 ./deploy-frontend.sh        # 跳过 npm install（依赖没变时更快）
#
set -euo pipefail

# ---- 配置（可用环境变量覆盖）----
SSH_KEY="${SSH_KEY:-$HOME/.ssh/machain.pem}"
SERVER="${SERVER:-ubuntu@18.207.199.194}"
REMOTE_DIR="${REMOTE_DIR:-/home/ubuntu/ma-pool/frontend}"
PM2_APP="${PM2_APP:-ma-pool-frontend}"
SITE_URL="${SITE_URL:-https://test.macpool.net}"
RUN_INSTALL="${RUN_INSTALL:-1}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LOCAL_FE="$SCRIPT_DIR/frontend"
SSH_OPTS=(-i "$SSH_KEY" -o StrictHostKeyChecking=accept-new -o ConnectTimeout=15)

# ---- 预检 ----
[ -f "$SSH_KEY" ]      || { echo "✗ SSH 密钥不存在: $SSH_KEY"; exit 1; }
[ -d "$LOCAL_FE/src" ] || { echo "✗ 找不到前端源码: $LOCAL_FE/src"; exit 1; }

echo "▶ 部署前端 $LOCAL_FE → $SERVER:$REMOTE_DIR"

# ---- 1. 同步源码 ----
echo "▶ [1/4] rsync 源码（排除 node_modules / .next / .env*）…"
rsync -az --delete -i \
  --exclude node_modules --exclude .next --exclude '.env*' \
  -e "ssh ${SSH_OPTS[*]}" \
  "$LOCAL_FE/" "$SERVER:$REMOTE_DIR/"

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
code=$(curl -s -o /dev/null -w '%{http_code}' "$SITE_URL")
echo "  homepage : HTTP $code"
[ "$code" = "200" ] || { echo "✗ 首页非 200"; exit 1; }
curl -s "$SITE_URL" | grep -q 'MA POOL' \
  && echo "  app shell: ✓ 渲染正常" \
  || { echo "✗ 未渲染应用外壳"; exit 1; }
echo "  backend  : $(curl -s "$SITE_URL/api/status")"
echo "✓ 部署完成：$SITE_URL"

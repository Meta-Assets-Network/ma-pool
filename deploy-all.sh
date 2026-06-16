#!/usr/bin/env bash
#
# 同时部署 MA Pool 前后端到测试服务器。
#
# 依次调用 deploy-backend.sh、deploy-frontend.sh（后端先行，API 就绪后再更前端）。
# 任一端失败即中止（set -e），不会半部署。
#
# 共享环境变量（SSH_KEY / SERVER / SITE_URL / RUN_INSTALL）会自动透传给两个子脚本；
# 端特定的 REMOTE_DIR / PM2_APP 不应在这里覆盖——需要时请单独运行对应子脚本。
#
# 用法：
#   ./deploy-all.sh
#   SSH_KEY=~/.ssh/other.pem SERVER=ubuntu@1.2.3.4 ./deploy-all.sh
#
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

echo "════════════ 部署后端 ════════════"
"$SCRIPT_DIR/deploy-backend.sh"

echo
echo "════════════ 部署前端 ════════════"
"$SCRIPT_DIR/deploy-frontend.sh"

echo
echo "✓ 前后端均已部署完成"

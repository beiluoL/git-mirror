#!/bin/bash
# 后台启动（Linux/macOS 通用，无 systemd 时可用）
cd "$(dirname "$0")/.."
PORT="${PORT:-3000}" nohup node server.js > launchd.log 2>&1 &
echo $! > .pid
echo "✅ 已启动（PID $(cat .pid)），访问 http://localhost:${PORT}"
echo "   停止： bash scripts/stop.sh"

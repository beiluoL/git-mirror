#!/bin/bash
# 停止后台进程
cd "$(dirname "$0")/.."
if [ -f .pid ]; then
  PID="$(cat .pid)"
  kill "$PID" 2>/dev/null && echo "✅ 已停止进程 $PID"
  rm -f .pid
else
  pkill -f "node server.js" && echo "✅ 已停止" || echo "未找到运行中的进程"
fi

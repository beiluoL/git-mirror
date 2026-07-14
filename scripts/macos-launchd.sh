#!/bin/bash
# macOS 开机自启：生成 LaunchAgent plist 并加载
# 用法： bash scripts/macos-launchd.sh [项目绝对路径] [端口]
set -e
PROJ_DIR="${1:-$(cd "$(dirname "$0")/.." && pwd)}"
PORT="${2:-3000}"
NODE_BIN="$(command -v node)"
PLIST="$HOME/Library/LaunchAgents/com.beiluo.gitmirror.plist"

mkdir -p "$HOME/Library/LaunchAgents"
cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.beiluo.gitmirror</string>
  <key>ProgramArguments</key>
  <array>
    <string>${NODE_BIN}</string>
    <string>${PROJ_DIR}/server.js</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PORT</key>
    <string>${PORT}</string>
  </dict>
  <key>WorkingDirectory</key>
  <string>${PROJ_DIR}</string>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${PROJ_DIR}/launchd.log</string>
  <key>StandardErrorPath</key>
  <string>${PROJ_DIR}/launchd.log</string>
</dict>
</plist>
EOF

launchctl bootout "gui/$(id -u)/com.beiluo.gitmirror" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$PLIST"
echo "✅ 已加载 LaunchAgent：$PLIST"
echo "   打开 http://localhost:${PORT} 使用"
echo "   停用：launchctl bootout gui/$(id -u)/com.beiluo.gitmirror"

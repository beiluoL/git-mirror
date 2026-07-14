/**
 * 开机自启（守护进程）管理
 *  - macOS：LaunchAgent（~/Library/LaunchAgents/com.beiluo.gitmirror.plist）
 *  - Linux：systemd 用户服务（--user，无需 root）
 *  - Windows：计划任务（登录时启动）
 *
 * 守护进程就是「常驻运行 server.js」，从而让「定时同步」在登入后持续生效。
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const LABEL = 'com.beiluo.gitmirror';
const SERVER_JS = path.join(__dirname, '..', 'server.js');
const NODE_BIN = process.execPath;
const PROJECT_DIR = path.join(__dirname, '..');
const PORT = process.env.PORT || 3000;
const COMMON_PATH = '/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:/opt/homebrew/bin';

function platform() {
  return process.platform; // 'darwin' | 'linux' | 'win32'
}

// ---------------- macOS ----------------
function macPlistPath() {
  return path.join(os.homedir(), 'Library', 'LaunchAgents', `${LABEL}.plist`);
}
function writeMacPlist() {
  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${NODE_BIN}</string>
    <string>${SERVER_JS}</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>${COMMON_PATH}</string>
    <key>PORT</key><string>${PORT}</string>
  </dict>
  <key>WorkingDirectory</key><string>${PROJECT_DIR}</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key><false/>
  </dict>
  <key>StandardOutPath</key><string>${path.join(PROJECT_DIR, 'launchd.log')}</string>
  <key>StandardErrorPath</key><string>${path.join(PROJECT_DIR, 'launchd.log')}</string>
</dict>
</plist>`;
  fs.writeFileSync(macPlistPath(), plist);
}
function macUid() { return process.getuid(); }
function macStatus() {
  const installed = fs.existsSync(macPlistPath());
  let running = false;
  try {
    const out = execFileSync('launchctl', ['list'], { stdio: 'pipe' }).toString();
    const line = out.split('\n').find((l) => l.includes(LABEL));
    if (line) {
      const cols = line.split(/\s+/);
      running = cols[0] !== '-'; // 第一列为 PID，- 表示未运行
    }
  } catch (_) {}
  return { installed, running };
}

// ---------------- Linux (systemd --user) ----------------
function linuxUnitPath() {
  return path.join(os.homedir(), '.config', 'systemd', 'user', 'gitmirror.service');
}
function writeLinuxUnit() {
  const dir = path.dirname(linuxUnitPath());
  fs.mkdirSync(dir, { recursive: true });
  const unit = `[Unit]
Description=Git Mirror (GitHub ⇄ Gitee)
After=network.target

[Service]
Type=simple
ExecStart=${NODE_BIN} ${SERVER_JS}
WorkingDirectory=${PROJECT_DIR}
Restart=always
Environment=PATH=${COMMON_PATH}
Environment=PORT=${PORT}

[Install]
WantedBy=default.target
`;
  fs.writeFileSync(linuxUnitPath(), unit);
}
function linuxStatus() {
  let installed = fs.existsSync(linuxUnitPath());
  let running = false;
  let enabled = false;
  try {
    const a = execFileSync('systemctl', ['--user', 'is-active', 'gitmirror.service'], { stdio: 'pipe' }).toString().trim();
    running = a === 'active';
  } catch (_) {}
  try {
    const e = execFileSync('systemctl', ['--user', 'is-enabled', 'gitmirror.service'], { stdio: 'pipe' }).toString().trim();
    enabled = e === 'enabled';
  } catch (_) {}
  return { installed: installed && enabled, running, enabled };
}

// ---------------- Windows (schtasks) ----------------
function winTaskXml() {
  // 登录时启动，无限期重试
  return `<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/05/06/tasks">
  <Triggers><LogonTrigger><Enabled>true</Enabled></LogonTrigger></Triggers>
  <Actions><Exec>
    <Command>${NODE_BIN}</Command>
    <Arguments>${SERVER_JS}</Arguments>
    <WorkingDirectory>${PROJECT_DIR}</WorkingDirectory>
  </Exec></Actions>
  <Principals><Principal id="Author"><LogonType>InteractiveToken</LogonType></Principal></Principals>
  <Settings><MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy></Settings>
</Task>`;
}
function winStatus() {
  let installed = false;
  try {
    const out = execFileSync('schtasks', ['/Query', '/TN', LABEL], { stdio: 'pipe' }).toString();
    installed = out.includes(LABEL);
  } catch (_) {}
  return { installed, running: false, enabled: installed };
}

// ---------------- 统一接口 ----------------
function getStatus() {
  const p = platform();
  if (p === 'darwin') return { platform: 'macOS', ...macStatus() };
  if (p === 'linux') return { platform: 'Linux', ...linuxStatus() };
  if (p === 'win32') return { platform: 'Windows', ...winStatus() };
  return { platform: p, installed: false, running: false, enabled: false, unsupported: true };
}

function enable() {
  const p = platform();
  if (p === 'darwin') {
    writeMacPlist();
    try { execFileSync('launchctl', ['bootstrap', `gui/${macUid()}`, macPlistPath()], { stdio: 'pipe' }); }
    catch (_) { /* 可能已 bootstrap，忽略 */ }
    try { execFileSync('launchctl', ['kickstart', `gui/${macUid()}/${LABEL}`], { stdio: 'pipe' }); } catch (_) {}
    return { ok: true, status: getStatus() };
  }
  if (p === 'linux') {
    writeLinuxUnit();
    execFileSync('systemctl', ['--user', 'daemon-reload'], { stdio: 'pipe' });
    execFileSync('systemctl', ['--user', 'enable', '--now', 'gitmirror.service'], { stdio: 'pipe' });
    return { ok: true, status: getStatus() };
  }
  if (p === 'win32') {
    const xml = winTaskXml();
    const tmp = path.join(os.tmpdir(), 'gitmirror-task.xml');
    fs.writeFileSync(tmp, xml, 'utf16le');
    execFileSync('schtasks', ['/Create', '/TN', LABEL, '/XML', tmp, '/F'], { stdio: 'pipe' });
    return { ok: true, status: getStatus() };
  }
  return { ok: false, error: '不支持的平台: ' + p };
}

function disable() {
  const p = platform();
  if (p === 'darwin') {
    try { execFileSync('launchctl', ['bootout', `gui/${macUid()}/${LABEL}`], { stdio: 'pipe' }); } catch (_) {}
    try { fs.unlinkSync(macPlistPath()); } catch (_) {}
    return { ok: true, status: getStatus() };
  }
  if (p === 'linux') {
    try { execFileSync('systemctl', ['--user', 'disable', '--now', 'gitmirror.service'], { stdio: 'pipe' }); } catch (_) {}
    try { fs.unlinkSync(linuxUnitPath()); } catch (_) {}
    return { ok: true, status: getStatus() };
  }
  if (p === 'win32') {
    try { execFileSync('schtasks', ['/Delete', '/TN', LABEL, '/F'], { stdio: 'pipe' }); } catch (_) {}
    return { ok: true, status: getStatus() };
  }
  return { ok: false, error: '不支持的平台: ' + p };
}

module.exports = { getStatus, enable, disable, platform };

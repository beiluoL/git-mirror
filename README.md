# Git Mirror · GitHub ⇄ Gitee 双向镜像工具

零依赖（仅用 Node 内置模块 + 系统 `git` / `curl`）的本地网页工具，把仓库在 **GitHub** 和 **Gitee** 之间一键/定时/批量同步。

> v2.0 相较初版的核心改进：**默认走 SSH**（两端用同一把密钥，最安全、无需在仓库 URL 埋令牌）；新增**实时进度、批量仓库、状态比对、同步历史、配置档案、CLI 模式**；支持**镜像模式**清理目标多余分支。

## 特性

| 功能 | 说明 |
|---|---|
| 双向同步 | GitHub → Gitee / Gitee → GitHub，协议自动选择 |
| **SSH 优先** | 默认 `git@host:user/repo.git`，无需令牌即可同步；无 SSH 时可切 HTTPS+令牌 |
| 自动建仓 | 目标同名仓库不存在时调用 REST API 创建（需对应平台令牌） |
| **实时进度** | 通过 SSE 把同步日志实时推到浏览器，无需干等 |
| **批量仓库** | 仓库名每行一个，一次同步多个 |
| **状态比对** | 比对两端分支/标签/HEAD，提示差异（基于 `git ls-remote`，无需令牌） |
| **同步历史** | 保留最近 30 次运行记录，随时回看 |
| **配置档案** | 保存命名配置（不含令牌），一键载入 |
| **定时同步** | 页面或 `schedule.json` 配置间隔，持久化、重启自恢复 |
| **CLI 模式** | `node server.js --cli ...`，适合 cron / 服务器无界面场景 |
| 强制 / 镜像 | 可选强制推送；镜像模式 `--mirror` 清理目标被删分支/标签 |
| 跨平台守护 | 提供 macOS LaunchAgent、systemd、start/stop 脚本 |

## 快速开始

```bash
git clone git@github.com:<你>/git-mirror.git
cd git-mirror
node server.js            # 或 npm start
# 浏览器打开 http://localhost:3000
```

CLI 模式（无需启动网页）：

```bash
node server.js --cli --direction gh2gitee \
  --githubUser beiluoL --giteeUser beiluol \
  --repos git-mirror,llm-learning-handbook \
  --transport ssh
```

## 传输策略（重要）

- 默认 **SSH**：要求本机已把公钥加入 GitHub、Gitee（同一把密钥均可）。此时**填不填令牌都能同步**。
- 仅当勾选「自动建仓」且目标仓库尚不存在时，才需要填对应平台**令牌**（用于 REST API 建仓）。
- HTTPS 模式：`git -c http.extraHeader` 传 Basic 认证（`base64(用户名:令牌)`），令牌不写进仓库 URL；临时 clone 目录用完即删；错误日志自动脱敏。

> 安全建议：聊天/代码中不要出现明文令牌；本工具的 `lastSync.json` / `config.json` / `history.json` 均已被 `.gitignore` 排除。

## 接口

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/` | 前端页面 |
| GET | `/api/events` | SSE 实时进度流 |
| POST | `/api/sync` | 执行同步，body: `{direction, transport, githubUser, githubToken?, giteeUser, giteeToken?, repos[], autoCreate, private, force, mirror}` |
| POST | `/api/status` | 比对两端，body 同上（单仓库用 `repo`） |
| POST | `/api/check` | 前置校验 |
| GET/POST | `/api/schedule` | 读取/更新定时配置 |
| GET | `/api/history` | 同步历史 |
| GET/POST/DELETE | `/api/profiles[/name]` | 配置档案增删查 |

## CLI 参数

```
--cli                  启用 CLI 模式
--direction            gh2gitee | gitee2gh（默认 gh2gitee）
--repos               逗号分隔的仓库名列表
--githubUser / --giteeUser
--githubToken / --giteeToken   （仅自动建仓需要）
--transport           ssh（默认）| https
--no-auto-create      不自动建仓
--public              新建仓库设为公开（默认私有）
--no-force            非强制推送
--mirror              镜像模式（清理目标多余引用）
--check               仅做状态比对，不推送
```

## 开机自启 / 守护

**macOS（LaunchAgent）**

```bash
bash scripts/macos-launchd.sh /绝对路径/git-mirror 3000
# 停用：launchctl bootout gui/$(id -u)/com.beiluo.gitmirror
```

**Linux（systemd）**

```bash
sudo cp scripts/git-mirror.service /etc/systemd/system/
sudo sed -i 's#/opt/git-mirror#/你的路径/git-mirror#' /etc/systemd/system/git-mirror.service
sudo systemctl daemon-reload && sudo systemctl enable --now git-mirror
```

**通用**

```bash
bash scripts/start.sh    # 后台启动，写 .pid
bash scripts/stop.sh     # 停止
```

## 准备

- **SSH 密钥**（推荐）：`ssh-keygen -t ed25519`，把 `~/.ssh/id_ed25519.pub` 分别加入 GitHub、Gitee 的 SSH 密钥列表。
- **令牌**（仅自动建仓需要）：GitHub Settings → PAT（勾 `repo`）；Gitee 设置 → 私人令牌（勾 `projects`）。

## 文件结构

```
git-mirror/
├── server.js          # 入口：HTTP 服务 + SSE + CLI
├── src/
│   ├── core.js        # 同步引擎（git/curl 封装、建仓、状态比对）
│   └── store.js       # 本地持久化（定时/档案/历史/最近配置）
├── public/            # 前端（index.html / style.css / app.js）
├── scripts/           # 守护脚本（macOS / systemd / start-stop）
├── package.json
└── README.md
```

## License

MIT

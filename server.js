#!/usr/bin/env node
/**
 * git-mirror 服务端 / CLI 入口
 *  - 网页模式：node server.js  →  http://localhost:3000
 *  - CLI 模式：node server.js --cli --direction gh2gitee --repos repo1,repo2 ...
 *
 * 零 npm 依赖，仅用 Node 内置模块 + 系统 git / curl。
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const net = require('net');
const core = require('./src/core');
const store = require('./src/store');
const autostart = require('./src/autostart');

const PORT = process.env.PORT || 3000;
const PUBLIC_DIR = path.join(__dirname, 'public');
const SYNC_LOG = path.join(__dirname, 'sync.log');

function portInUse(port) {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.once('error', () => resolve(true));
    s.once('listening', () => { s.close(() => resolve(false)); });
    s.listen(port);
  });
}

// ---------------- SSE 广播 ----------------
const sseClients = new Set();

function broadcast(msg) {
  const data = `data: ${JSON.stringify(msg)}\n\n`;
  for (const res of sseClients) {
    try { res.write(data); } catch (_) {}
  }
}

function runWithLogging(params, onLine) {
  const lines = [];
  const onLog = (line) => {
    lines.push(line);
    onLine(line);
  };
  const result = core.runSync(params, onLog);
  result.log = lines.join('\n');
  return result;
}

// ---------------- 调度器 ----------------
let scheduleTimer = null;

function startScheduler() {
  if (scheduleTimer) { clearInterval(scheduleTimer); scheduleTimer = null; }
  const schedule = store.getSchedule();
  const cfg = schedule.syncParams || store.getLastConfig();
  if (schedule.enabled && schedule.intervalMin > 0 && cfg) {
    scheduleTimer = setInterval(() => {
      const live = store.getSchedule().syncParams || store.getLastConfig();
      if (!live) return;
      const res = runWithLogging(live, (line) => broadcast({ type: 'log', line }));
      const entry = {
        ts: new Date().toISOString(),
        direction: live.direction,
        repo: (live.repos && live.repos[0]) || live.repo || '',
        repos: (live.repos || [live.repo]).filter(Boolean),
        ok: res.ok,
        summary: res.log.split('\n').slice(-1)[0] || '',
      };
      store.addHistory(entry);
      const ts = new Date().toLocaleString('zh-CN');
      try {
        fs.appendFileSync(SYNC_LOG, `\n[${ts}] 定时同步(${live.direction}) 结果: ${res.ok ? '成功' : '失败'}\n${res.log}\n`);
      } catch (_) {}
      broadcast({ type: 'done', ok: res.ok, log: res.log, scheduled: true });
    }, schedule.intervalMin * 60 * 1000);
    console.log(`[scheduler] 已启动：每 ${schedule.intervalMin} 分钟自动同步`);
  } else {
    console.log('[scheduler] 未启动（enabled=' + schedule.enabled + '，有配置=' + !!cfg + '）');
  }
}

// ---------------- 静态文件 ----------------
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
};

function serveStatic(req, res) {
  let urlPath = req.url.split('?')[0];
  if (urlPath === '/') urlPath = '/index.html';
  const filePath = path.join(PUBLIC_DIR, path.normalize(urlPath).replace(/^(\.\.[/\\])+/, ''));
  if (!filePath.startsWith(PUBLIC_DIR)) { res.writeHead(403); res.end('Forbidden'); return; }
  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404); res.end('Not Found'); return; }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(filePath)] || 'application/octet-stream' });
    res.end(data);
  });
}

function sendJSON(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(obj));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      try { resolve(body ? JSON.parse(body) : {}); } catch (e) { reject(e); }
    });
    req.on('error', reject);
  });
}

// 把单仓库字段规整为 repos 数组
function normalizeParams(p) {
  let repos = p.repos;
  if (!Array.isArray(repos)) {
    repos = (p.repo || '').split('\n').map((s) => s.trim()).filter(Boolean);
    if (p.repo && !repos.length) repos = [p.repo.trim()].filter(Boolean);
  }
  return {
    direction: p.direction || 'gh2gitee',
    githubUser: (p.githubUser || '').trim(),
    githubToken: (p.githubToken || '').trim(),
    giteeUser: (p.giteeUser || '').trim(),
    giteeToken: (p.giteeToken || '').trim(),
    repos,
    repo: repos[0] || '',
    autoCreate: p.autoCreate !== false,
    private: p.private !== false,
    transport: p.transport || 'ssh',
    force: p.force !== false,
    mirror: !!p.mirror,
  };
}

// ---------------- HTTP 路由 ----------------
const server = http.createServer(async (req, res) => {
  // SSE
  if (req.method === 'GET' && req.url === '/api/events') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });
    res.write('retry: 3000\n\n');
    res.write(`data: ${JSON.stringify({ type: 'ready' })}\n\n`);
    sseClients.add(res);
    req.on('close', () => sseClients.delete(res));
    return;
  }

  if (req.method === 'GET' && (req.url === '/' || req.url.startsWith('/index') || req.url.startsWith('/app') || req.url.startsWith('/style'))) {
    return serveStatic(req, res);
  }

  // 执行同步（结果经 SSE 实时推送，并回传摘要）
  if (req.method === 'POST' && req.url === '/api/sync') {
    try {
      const p = normalizeParams(await readBody(req));
      const params = p;
      const lastCfg = { ...params };
      store.setLastConfig(lastCfg);
      const result = runWithLogging(params, (line) => broadcast({ type: 'log', line }));
      const entry = {
        ts: new Date().toISOString(),
        direction: params.direction,
        repos: params.repos,
        ok: result.ok,
        summary: result.log.split('\n').slice(-1)[0] || '',
      };
      store.addHistory(entry);
      broadcast({ type: 'done', ok: result.ok, log: result.log });
      sendJSON(res, 200, { ok: result.ok, log: result.log, results: result.results });
    } catch (e) {
      sendJSON(res, 500, { ok: false, log: '服务器错误: ' + e.message });
    }
    return;
  }

  // 状态比对
  if (req.method === 'POST' && req.url === '/api/status') {
    try {
      const p = normalizeParams(await readBody(req));
      const result = core.checkStatus(p, (line) => broadcast({ type: 'log', line }));
      broadcast({ type: 'done', ok: result.ok, log: '状态比对完成' });
      sendJSON(res, 200, result);
    } catch (e) {
      sendJSON(res, 500, { ok: false, error: e.message });
    }
    return;
  }

  // 前置校验
  if (req.method === 'POST' && req.url === '/api/check') {
    try {
      const p = normalizeParams(await readBody(req));
      const result = core.validateConfig(p, (line) => broadcast({ type: 'log', line }));
      sendJSON(res, 200, result);
    } catch (e) {
      sendJSON(res, 500, { ok: false, error: e.message });
    }
    return;
  }

  // 定时配置
  if (req.method === 'GET' && req.url === '/api/schedule') {
    const s = store.getSchedule();
    sendJSON(res, 200, { ...s, hasLastConfig: !!store.getLastConfig(), hasSyncParams: !!s.syncParams });
    return;
  }
  if (req.method === 'POST' && req.url === '/api/schedule') {
    try {
      const p = await readBody(req);
      const s = store.getSchedule();
      if (typeof p.enabled === 'boolean') s.enabled = p.enabled;
      if (p.intervalMin && !isNaN(p.intervalMin)) s.intervalMin = Math.max(1, parseInt(p.intervalMin, 10));
      if (p.syncParams) s.syncParams = p.syncParams; // 独立保存的同步配置
      store.setSchedule(s);
      startScheduler();
      sendJSON(res, 200, { ok: true, schedule: { ...s, hasLastConfig: !!store.getLastConfig(), hasSyncParams: !!s.syncParams } });
    } catch (e) {
      sendJSON(res, 500, { ok: false, error: e.message });
    }
    return;
  }

  // 开机自启
  if (req.method === 'GET' && req.url === '/api/autostart') {
    sendJSON(res, 200, autostart.getStatus());
    return;
  }
  if (req.method === 'POST' && req.url === '/api/autostart') {
    try {
      const p = await readBody(req);
      let result;
      if (p.enabled) {
        result = autostart.enable();
        // 若端口已被手动实例占用，本机已运行，无需重复启动（下次登录由守护拉起）
        const inUse = await portInUse(PORT);
        if (inUse) result.note = '本机已有实例在运行，守护将在下次登录时自动拉起';
        store.setAutostart({ enabled: true, platform: result.status && result.status.platform });
      } else {
        result = autostart.disable();
        store.setAutostart({ enabled: false });
      }
      sendJSON(res, 200, result);
    } catch (e) {
      sendJSON(res, 500, { ok: false, error: e.message });
    }
    return;
  }

  // 历史
  if (req.method === 'GET' && req.url === '/api/history') {
    sendJSON(res, 200, { history: store.getHistory() });
    return;
  }

  // 配置档案
  if (req.method === 'GET' && req.url === '/api/profiles') {
    sendJSON(res, 200, { profiles: store.getProfiles() });
    return;
  }
  if (req.method === 'POST' && req.url === '/api/profiles') {
    try {
      const p = await readBody(req);
      store.saveProfile(p);
      sendJSON(res, 200, { ok: true, profiles: store.getProfiles() });
    } catch (e) {
      sendJSON(res, 500, { ok: false, error: e.message });
    }
    return;
  }
  if (req.method === 'DELETE' && req.url.startsWith('/api/profiles/')) {
    const name = decodeURIComponent(req.url.split('/').pop());
    store.deleteProfile(name);
    sendJSON(res, 200, { ok: true, profiles: store.getProfiles() });
    return;
  }

  serveStatic(req, res);
});

// ---------------- CLI 模式 ----------------
function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--cli') { args.cli = true; continue; }
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next && !next.startsWith('--')) { args[key] = next; i++; }
      else args[key] = true;
    }
  }
  return args;
}

function runCLI() {
  const a = parseArgs(process.argv.slice(2));
  const repos = (a.repos || '').split(',').map((s) => s.trim()).filter(Boolean);
  if (!repos.length) { console.error('❌ 请通过 --repos 指定仓库，多个用逗号分隔'); process.exit(1); }
  if (!a.githubUser || !a.giteeUser) { console.error('❌ 请通过 --githubUser / --giteeUser 指定用户名'); process.exit(1); }

  const params = normalizeParams({
    direction: a.direction || 'gh2gitee',
    githubUser: a.githubUser,
    githubToken: a.githubToken || '',
    giteeUser: a.giteeUser,
    giteeToken: a.giteeToken || '',
    repos,
    autoCreate: a['no-auto-create'] ? false : true,
    private: a.public ? false : true,
    transport: a.transport || 'ssh',
    force: a['no-force'] ? false : true,
    mirror: !!a.mirror,
  });

  const ts = () => new Date().toLocaleString('zh-CN');
  const onLog = (line) => console.log(`[${ts()}] ${line}`);

  if (a.check) {
    console.log('== 状态比对 ==');
    const r = core.checkStatus(params, onLog);
    process.exit(r.ok ? 0 : 2);
  }

  console.log('== 开始同步 ==');
  const res = runWithLogging(params, onLog);
  console.log(res.ok ? '\n✅ 全部成功' : '\n❌ 存在失败');
  process.exit(res.ok ? 0 : 1);
}

// ---------------- 启动 ----------------
if (process.argv.includes('--cli')) {
  runCLI();
} else {
  startScheduler();
  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      console.log(`端口 ${PORT} 已被占用，疑似已有实例在运行，本进程直接退出（避免冲突）。`);
      process.exit(0);
    }
    throw err;
  });
  server.listen(PORT, () => {
    console.log(`git-mirror 运行于 http://localhost:${PORT}`);
  });
}

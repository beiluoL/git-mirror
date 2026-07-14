// ---------- 侧边导航 ----------
const TITLES = {
  sync: ['同步', 'GitHub ⇄ Gitee 一键 / 批量 / 定时镜像'],
  status: ['状态比对', '比对两端分支 / 标签 / HEAD，提示差异'],
  history: ['同步历史', '最近 30 次运行记录'],
  profiles: ['配置档案', '保存与一键载入命名配置'],
  automation: ['自动化', '开机自启 + 定时同步'],
};
document.querySelectorAll('.nav button').forEach((b) => {
  b.addEventListener('click', () => {
    document.querySelectorAll('.nav button').forEach((x) => x.classList.remove('active'));
    document.querySelectorAll('.panel').forEach((x) => x.classList.add('hidden'));
    b.classList.add('active');
    const t = b.dataset.tab;
    document.getElementById('panel-' + t).classList.remove('hidden');
    document.getElementById('pageTitle').textContent = TITLES[t][0];
    document.getElementById('pageCrumb').textContent = TITLES[t][1];
    if (t === 'history') loadHistory();
    if (t === 'profiles') loadProfiles();
    if (t === 'automation') loadAutomation();
  });
});

const $ = (id) => document.getElementById(id);
const log = (txt) => { $('log').textContent = txt; };

// ---------- SSE 实时进度 ----------
let sseReady = false;
const es = new EventSource('/api/events');
es.onmessage = (e) => {
  const m = JSON.parse(e.data);
  if (m.type === 'ready') { sseReady = true; return; }
  if (m.type === 'log') {
    const cur = $('log').textContent;
    if (cur && cur !== '等待操作...（进度将实时显示）') $('log').textContent = cur + '\n' + m.line;
    else $('log').textContent = m.line;
    const el = $('log'); el.scrollTop = el.scrollHeight;
  }
  if (m.type === 'done') {
    if (m.log) $('log').textContent = m.log;
    const state = $('syncState');
    state.textContent = m.ok ? '✅ 同步成功' : '❌ 同步失败';
    state.className = m.ok ? 'ok' : 'fail';
    $('syncBtn') && ($('syncBtn').disabled = false);
    if (m.scheduled) loadHistory();
  }
};

// ---------- 表单读取 ----------
function readForm() {
  return {
    direction: $('direction').value,
    transport: $('transport').value,
    githubUser: $('githubUser').value.trim(),
    githubToken: $('githubToken').value.trim(),
    giteeUser: $('giteeUser').value.trim(),
    giteeToken: $('giteeToken').value.trim(),
    repos: $('repos').value.split('\n').map((s) => s.trim()).filter(Boolean),
    autoCreate: $('autoCreate').checked,
    private: $('private').checked,
    force: $('force').checked,
    mirror: $('mirror').checked,
  };
}

async function doSync() {
  const payload = readForm();
  if (!payload.repos.length) { log('⚠ 请填写至少一个仓库名'); return; }
  const btn = document.querySelector('#panel-sync .btn');
  btn.disabled = true;
  $('syncState').textContent = '同步中...'; $('syncState').className = 'muted';
  log('正在同步，请稍候（实时日志见下方）...');
  try {
    const r = await fetch('/api/sync', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
    });
    const data = await r.json();
    if (data.log) log(data.log);
    const state = $('syncState');
    state.textContent = data.ok ? '✅ 同步成功' : '❌ 同步失败';
    state.className = data.ok ? 'ok' : 'fail';
  } catch (e) { log('请求失败：' + e.message); }
  finally { btn.disabled = false; }
}

async function doCheck() {
  const payload = readForm();
  try {
    const r = await fetch('/api/check', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
    });
    const data = await r.json();
    log(data.issues ? ('⚠ 校验未通过：' + data.issues.join('；')) : '✔ 配置校验通过');
  } catch (e) { log('请求失败：' + e.message); }
}

// ---------- 状态比对 ----------
async function doStatus() {
  const payload = {
    direction: $('sDirection').value,
    githubUser: $('sUser').value.trim(),
    giteeUser: $('sUser').value.trim(),
    repo: $('sRepo').value.trim(),
    transport: 'ssh',
  };
  if (!payload.githubUser || !payload.repo) { $('statusState').textContent = '请填写用户名与仓库名'; return; }
  $('statusState').textContent = '比对中...';
  try {
    const r = await fetch('/api/status', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
    });
    const d = await r.json();
    renderStatus(d, payload);
    $('statusState').textContent = d.ok ? '✅ 两端一致' : '⚠ 存在差异';
    $('statusState').className = d.ok ? 'ok' : 'fail';
  } catch (e) { $('statusState').textContent = '失败：' + e.message; }
}

function renderStatus(d, p) {
  const srcLabel = p.direction === 'gh2gitee' ? 'GitHub' : 'Gitee';
  const dstLabel = p.direction === 'gh2gitee' ? 'Gitee' : 'GitHub';
  const box = (title, o) => `
    <div class="status-box">
      <h3>${title} <span class="pill ${o.ok ? 'ok' : 'fail'}">${o.ok ? '可达' : '不可达'}</span></h3>
      <div>分支：<b>${o.branches ? o.branches.length : 0}</b> 个</div>
      <div>标签：<b>${o.tags ? o.tags.length : 0}</b> 个</div>
      <div>HEAD：<code>${o.head ? o.head.slice(0, 10) : '无'}</code></div>
      ${(o.branches || []).map((b) => `<div style="font-size:12px;color:var(--muted);">· ${b}</div>`).join('')}
    </div>`;
  $('statusResult').innerHTML = box(`${srcLabel}`, d.src) + box(`${dstLabel}`, d.dst);
}

// ---------- 历史 ----------
async function loadHistory() {
  try {
    const r = await fetch('/api/history');
    const d = await r.json();
    const rows = (d.history || []).map((h) => `
      <tr>
        <td>${new Date(h.ts).toLocaleString('zh-CN')}</td>
        <td>${h.direction}</td>
        <td>${(h.repos || []).join(', ')}</td>
        <td><span class="pill ${h.ok ? 'ok' : 'fail'}">${h.ok ? '成功' : '失败'}</span></td>
        <td class="muted">${h.summary || ''}</td>
      </tr>`).join('');
    $('historyTable').querySelector('tbody').innerHTML = rows || '<tr><td colspan="5" class="muted">暂无记录</td></tr>';
  } catch (e) { /* ignore */ }
}

// ---------- 配置档案 ----------
async function loadProfiles() {
  try {
    const r = await fetch('/api/profiles');
    const d = await r.json();
    const list = (d.profiles || []);
    if (!list.length) { $('profList').innerHTML = '<div class="muted">暂无档案</div>'; return; }
    $('profList').innerHTML = list.map((p) => `
      <div class="prof-item">
        <div style="flex:1;">
          <div class="name">${p.name}</div>
          <div class="meta">${p.direction} · ${p.repos.length} 个仓库 · ${p.transport}</div>
        </div>
        <button class="btn ghost" onclick="loadProfile('${encodeURIComponent(p.name)}')">载入</button>
        <button class="btn danger" onclick="delProfile('${encodeURIComponent(p.name)}')">删除</button>
      </div>`).join('');
  } catch (e) { /* ignore */ }
}

async function saveProfile() {
  const name = $('profName').value.trim();
  if (!name) { alert('请填写档案名称'); return; }
  const f = readForm();
  const payload = {
    name, direction: f.direction, transport: f.transport,
    githubUser: f.githubUser, giteeUser: f.giteeUser,
    repos: f.repos, autoCreate: f.autoCreate, private: f.private,
    force: f.force, mirror: f.mirror,
  };
  await fetch('/api/profiles', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
  $('profName').value = '';
  loadProfiles();
}

async function loadProfile(name) {
  const r = await fetch('/api/profiles');
  const d = await r.json();
  const p = (d.profiles || []).find((x) => x.name === decodeURIComponent(name));
  if (!p) return;
  $('direction').value = p.direction;
  $('transport').value = p.transport;
  $('githubUser').value = p.githubUser || '';
  $('giteeUser').value = p.giteeUser || '';
  $('repos').value = (p.repos || []).join('\n');
  $('autoCreate').checked = !!p.autoCreate;
  $('private').checked = p.private !== false;
  $('force').checked = p.force !== false;
  $('mirror').checked = !!p.mirror;
  document.querySelector('.nav button[data-tab="sync"]').click();
}

async function delProfile(name) {
  await fetch('/api/profiles/' + name, { method: 'DELETE' });
  loadProfiles();
}

// ---------- 自动化：定时同步 ----------
async function loadAutomation() {
  try {
    const r = await fetch('/api/schedule');
    const s = await r.json();
    $('schedEnabled').checked = !!s.enabled;
    $('intervalMin').value = s.intervalMin || 30;
    $('schedCfg').style.display = s.enabled ? 'flex' : 'none';
    const has = s.hasSyncParams ? '已保存定时配置' : (s.hasLastConfig ? '将沿用「最近一次手动同步」配置' : '⚠ 尚未保存定时配置，请先点「保存为定时配置」');
    $('schedNote').innerHTML = `<b>当前状态：</b>${s.enabled ? '已启用' : '未启用'} · ${has}`;
  } catch (e) {}
  loadAutostart();
}

async function saveScheduleConfig() {
  const f = readForm();
  if (!f.repos.length) { alert('请先在同步页填写仓库名'); return; }
  const r = await fetch('/api/schedule', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ enabled: $('schedEnabled').checked, intervalMin: parseInt($('intervalMin').value, 10) || 30, syncParams: f }),
  });
  const d = await r.json();
  $('schedState').textContent = d.ok ? '✔ 已保存定时配置' : '保存失败：' + (d.error || '');
  loadAutomation();
}

async function onSchedToggle() {
  const on = $('schedEnabled').checked;
  $('schedCfg').style.display = on ? 'flex' : 'none';
  // 仅切换开关时，不覆盖已存的 syncParams；若开启但还没有配置，提示
  const r = await fetch('/api/schedule', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ enabled: on, intervalMin: parseInt($('intervalMin').value, 10) || 30 }),
  });
  const d = await r.json();
  if (on && !d.schedule.hasSyncParams && !d.schedule.hasLastConfig) {
    $('schedNote').innerHTML = '<b style="color:var(--warn)">开启前请先点「保存为定时配置」</b>，否则定时任务无仓库可执行。';
  } else {
    loadAutomation();
  }
}

// ---------- 自动化：开机自启 ----------
async function loadAutostart() {
  try {
    const r = await fetch('/api/autostart');
    const s = await r.json();
    $('autoEnabled').checked = !!s.installed;
    const plat = s.platform || '';
    let state = s.installed ? (s.running ? '已安装并运行中' : '已安装（未运行）') : '未启用';
    if (s.unsupported) state = '当前平台不支持自动安装';
    $('autoMeta').textContent = `${plat} · ${state}`;
    $('autoNote').innerHTML = s.installed
      ? '守护进程会在你登录后自动启动本工具，使「定时同步」持续生效。关闭将卸载守护。'
      : '开启后将把本工具注册为系统守护（macOS 登录项 / Linux 用户服务 / Windows 计划任务）。';
  } catch (e) { $('autoMeta').textContent = '检测失败'; }
}

async function onAutoToggle() {
  const on = $('autoEnabled').checked;
  $('autoMeta').textContent = on ? '正在安装守护进程…' : '正在卸载…';
  try {
    const r = await fetch('/api/autostart', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ enabled: on }),
    });
    const d = await r.json();
    if (d.note) $('autoNote').textContent = d.note;
    loadAutostart();
  } catch (e) {
    $('autoMeta').textContent = '操作失败：' + e.message;
    $('autoEnabled').checked = !on;
  }
}

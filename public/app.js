// ---------- Tab 切换 ----------
document.querySelectorAll('.tab').forEach((t) => {
  t.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach((x) => x.classList.remove('active'));
    document.querySelectorAll('.panel').forEach((x) => x.classList.add('hidden'));
    t.classList.add('active');
    document.getElementById('panel-' + t.dataset.tab).classList.remove('hidden');
    if (t.dataset.tab === 'history') loadHistory();
    if (t.dataset.tab === 'profiles') loadProfiles();
    if (t.dataset.tab === 'schedule') loadSchedule();
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
    $('syncBtn').disabled = false;
  }
};

// ---------- 读取表单 ----------
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
  $('syncBtn').disabled = true;
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
  } catch (e) {
    log('请求失败：' + e.message);
  } finally {
    $('syncBtn').disabled = false;
  }
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
      <h3>${title} · <code>${o.ok ? '可达' : '不可达'}</code></h3>
      <div>分支：<b>${o.branches ? o.branches.length : 0}</b> 个</div>
      <div>标签：<b>${o.tags ? o.tags.length : 0}</b> 个</div>
      <div>HEAD：<code>${o.head ? o.head.slice(0, 10) : '无'}</code></div>
      ${(o.branches || []).map((b) => `<div style="font-size:12px;color:#6b7785;">· ${b}</div>`).join('')}
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
        <button class="ghost" onclick="loadProfile('${encodeURIComponent(p.name)}')">载入</button>
        <button class="danger" onclick="delProfile('${encodeURIComponent(p.name)}')">删除</button>
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
  document.querySelector('.tab[data-tab="sync"]').click();
}

async function delProfile(name) {
  await fetch('/api/profiles/' + name, { method: 'DELETE' });
  loadProfiles();
}

// ---------- 定时 ----------
async function loadSchedule() {
  try {
    const r = await fetch('/api/schedule');
    const s = await r.json();
    $('schedEnabled').checked = s.enabled;
    $('intervalMin').value = s.intervalMin;
    $('schedState').textContent = s.enabled ? `已启用，每 ${s.intervalMin} 分钟` : '当前未启用';
  } catch (e) { /* ignore */ }
}

async function saveSchedule() {
  const payload = { enabled: $('schedEnabled').checked, intervalMin: parseInt($('intervalMin').value, 10) || 30 };
  try {
    const r = await fetch('/api/schedule', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
    const d = await r.json();
    if (d.ok) {
      $('schedState').textContent = d.schedule.enabled ? `已启用，每 ${d.schedule.intervalMin} 分钟` : '已关闭定时';
      if (d.schedule.enabled) alert('已启用定时同步。请确保已成功执行过一次手动同步（用于复用配置）。');
    } else $('schedState').textContent = '保存失败：' + (d.error || '');
  } catch (e) { $('schedState').textContent = '保存失败：' + e.message; }
}

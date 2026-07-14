/**
 * git-mirror 核心引擎（零依赖，使用系统 git + curl）
 *
 * 设计要点：
 *  - 传输策略默认 SSH（两端都用 git@host:user/repo.git），最安全、无需在仓库 URL 里埋令牌；
 *    如需自动建仓，才需要填对应平台令牌（仅用于 REST API）。
 *  - 支持 HTTPS 传输（git -c http.extraHeader 传 Basic 认证），作为无 SSH 场景的备选。
 *  - 所有 git 调用通过 execFileSync + 数组参数，避免命令注入。
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

// ---------------- 基础工具 ----------------

function maskStr(s, secrets) {
  let out = String(s);
  (secrets || []).forEach((sec) => {
    if (sec) out = out.split(sec).join('***');
  });
  return out;
}

// HTTPS Basic 头： base64("用户名:令牌")
function basicAuthHeader(user, token) {
  return `Authorization: Basic ${Buffer.from(user + ':' + token).toString('base64')}`;
}

// 根据平台 + 传输方式构造远程地址
function buildUrl(platform, user, repo, transport) {
  if (transport === 'https') return `https://${platform}.com/${user}/${repo}.git`;
  return `git@${platform}.com:${user}/${repo}.git`;
}

// 传给 git 的全局参数（HTTPS 才需要强制 HTTP/1.1 与认证头）
function gitGlobalArgs(transport, authHeader) {
  const args = [];
  if (transport === 'https') {
    args.push('-c', 'http.version=HTTP/1.1');
    if (authHeader) args.push('-c', `http.extraHeader=${authHeader}`);
  }
  return args;
}

function gitExec(gitArgs, cwd, timeoutMs) {
  return execFileSync('git', gitArgs, {
    cwd,
    stdio: 'pipe',
    maxBuffer: 64 * 1024 * 1024,
    timeout: timeoutMs || 180000,
  });
}

// ---------------- 仓库探测（ls-remote，无需 token）----------------

// 解析 `git ls-remote` 输出：返回分支/标签列表与 HEAD
function parseLsRemote(out) {
  const branches = [];
  const tags = [];
  let head = null;
  String(out)
    .split('\n')
    .forEach((line) => {
      const m = line.match(/^([0-9a-f]+)\t(.+)$/);
      if (!m) return;
      const sha = m[1];
      const ref = m[2];
      if (ref === 'HEAD') head = sha;
      else if (ref.startsWith('refs/heads/')) branches.push(ref.slice('refs/heads/'.length));
      else if (ref.startsWith('refs/tags/')) tags.push(ref.slice('refs/tags/'.length));
    });
  return { branches, tags, head, count: branches.length + tags.length };
}

// 探测远端引用（SSH 即可，无需 API/令牌）
function lsRemote(url, transport, authHeader) {
  try {
    const args = [...gitGlobalArgs(transport, authHeader), 'ls-remote', url];
    const out = gitExec(args, undefined, 60000).toString();
    return { ok: true, ...parseLsRemote(out) };
  } catch (e) {
    return { ok: false, branches: [], tags: [], head: null, count: 0, error: (e.stderr || '').toString() || e.message };
  }
}

// ---------------- REST API（仅用于自动建仓 / 校验）----------------

function curlJSON(args) {
  return execFileSync('curl', args, { stdio: 'pipe', timeout: 30000 }).toString().trim();
}

function repoExistsAPI(platform, token, user, repo) {
  let cmdArgs;
  if (platform === 'github') {
    cmdArgs = [
      '-s', '-o', '/dev/null', '-w', '%{http_code}',
      '-H', `Authorization: Bearer ${token}`,
      '-H', 'User-Agent: git-mirror',
      `https://api.github.com/repos/${user}/${repo}`,
    ];
  } else {
    cmdArgs = [
      '-s', '-o', '/dev/null', '-w', '%{http_code}',
      `https://gitee.com/api/v5/repos/${user}/${repo}?access_token=${token}`,
    ];
  }
  try {
    return curlJSON(cmdArgs) === '200';
  } catch (_) {
    return false;
  }
}

function createRepoAPI(platform, token, repo, isPrivate) {
  const body = JSON.stringify({ name: repo, private: !!isPrivate });
  let cmdArgs;
  if (platform === 'github') {
    cmdArgs = [
      '-s', '-o', '/dev/null', '-w', '%{http_code}',
      '-X', 'POST', 'https://api.github.com/user/repos',
      '-H', `Authorization: Bearer ${token}`,
      '-H', 'Accept: application/vnd.github+json',
      '-H', 'User-Agent: git-mirror',
      '-H', 'Content-Type: application/json',
      '-d', body,
    ];
  } else {
    cmdArgs = [
      '-s', '-o', '/dev/null', '-w', '%{http_code}',
      '-X', 'POST', `https://gitee.com/api/v5/user/repos?access_token=${token}`,
      '-H', 'Content-Type: application/json',
      '-d', body,
    ];
  }
  try {
    return curlJSON(cmdArgs);
  } catch (e) {
    return '000';
  }
}

// ---------------- 平台解析 ----------------

function resolvePlatforms(direction) {
  const src = direction === 'gh2gitee' ? 'github' : 'gitee';
  const dst = direction === 'gh2gitee' ? 'gitee' : 'github';
  return { src, dst };
}

function platformUser(p, params) {
  return p === 'github' ? params.githubUser : params.giteeUser;
}
function platformToken(p, params) {
  return p === 'github' ? params.githubToken : params.giteeToken;
}

// ---------------- 单次仓库同步 ----------------

function syncOneRepo(params, repo, onLog) {
  const { src, dst } = resolvePlatforms(params.direction);
  const secrets = [params.githubToken, params.giteeToken].filter(Boolean);

  const srcUser = platformUser(src, params);
  const dstUser = platformUser(dst, params);
  const srcToken = platformToken(src, params);
  const dstToken = platformToken(dst, params);

  const srcUrl = buildUrl(src, srcUser, repo, params.transport);
  const dstUrl = buildUrl(dst, dstUser, repo, params.transport);

  const srcAuth = params.transport === 'https' ? basicAuthHeader(srcUser, srcToken) : '';
  const dstAuth = params.transport === 'https' ? basicAuthHeader(dstUser, dstToken) : '';

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gitmirror-'));
  const repoDir = path.join(tmp, 'repo');
  const log = (m) => onLog(`[${repo}] ${m}`);

  try {
    // 0. 自动建仓（若开启且目标不存在）
    if (params.autoCreate) {
      const dstTokenReal = dstToken;
      if (!dstTokenReal) {
        log('⚠ 开启了自动建仓但未提供目标平台令牌，跳过建仓（若目标不存在将失败）。');
      } else {
        log(`[预检] 检查目标仓库 ${dst}/${dstUser}/${repo} ...`);
        if (repoExistsAPI(dst, dstTokenReal, dstUser, repo)) {
          log('  ✔ 目标已存在，跳过建仓');
        } else {
          log(`  ✗ 不存在，调用 API 创建（${params.private ? '私有' : '公开'}）...`);
          const code = createRepoAPI(dst, dstTokenReal, repo, params.private);
          log(`  创建接口返回 HTTP ${code}` + (code === '201' || code === '200' ? '（成功）' : '（失败，仍尝试直接推送）'));
        }
      }
    }

    // 1. 克隆源
    log(`[1/3] 克隆源 ${src}（${params.transport.toUpperCase()}）...`);
    gitExec([...gitGlobalArgs(params.transport, srcAuth), 'clone', '--quiet', srcUrl, repoDir], undefined, 180000);
    log('  克隆完成');

    // 2. 添加目标远程
    log('[2/3] 添加目标远程 ...');
    gitExec(['remote', 'add', 'target', dstUrl], repoDir, 60000);

    // 3. 推送
    log(`[3/3] 推送 -> ${dst}（${params.transport.toUpperCase()}）...`);
    if (params.mirror) {
      gitExec([...gitGlobalArgs(params.transport, dstAuth), 'push', 'target', '--mirror'], repoDir, 180000);
      log('  镜像推送完成（含分支/标签，并清理目标多余引用）');
    } else {
      const forceArg = params.force ? ['--force'] : [];
      gitExec([...gitGlobalArgs(params.transport, dstAuth), 'push', 'target', '--all', ...forceArg], repoDir, 180000);
      try {
        gitExec([...gitGlobalArgs(params.transport, dstAuth), 'push', 'target', '--tags', ...forceArg], repoDir, 120000);
      } catch (_) { /* 无 tag 忽略 */ }
      log('  推送完成' + (params.force ? '（强制覆盖）' : '（非强制）'));
    }
    return { repo, ok: true, log: '' };
  } catch (e) {
    const raw = maskStr((e.stderr || '').toString() + (e.stdout || '').toString() + e.message, secrets);
    log('❌ 失败：' + raw);
    return { repo, ok: false, log: raw };
  } finally {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) {}
  }
}

// 批量同步：顺序执行每个仓库
function runSync(params, onLog) {
  const repos = (params.repos || []).map((r) => r.trim()).filter(Boolean);
  if (!repos.length) {
    onLog('⚠ 没有要同步的仓库');
    return { ok: false, results: [] };
  }
  onLog(`▶ 开始同步（方向 ${params.direction}，共 ${repos.length} 个仓库，传输 ${params.transport}）`);
  const results = repos.map((repo) => syncOneRepo(params, repo, onLog));
  const okCount = results.filter((r) => r.ok).length;
  onLog(`■ 完成：${okCount}/${repos.length} 成功`);
  return { ok: okCount === repos.length, results };
}

// ---------------- 状态比对 ----------------

function checkStatus(params, onLog) {
  const { src, dst } = resolvePlatforms(params.direction);
  const srcUser = platformUser(src, params);
  const dstUser = platformUser(dst, params);
  const srcToken = platformToken(src, params);
  const dstToken = platformToken(dst, params);

  const srcUrl = buildUrl(src, srcUser, params.repo, params.transport);
  const dstUrl = buildUrl(dst, dstUser, params.repo, params.transport);
  const srcAuth = params.transport === 'https' ? basicAuthHeader(srcUser, srcToken) : '';
  const dstAuth = params.transport === 'https' ? basicAuthHeader(dstUser, dstToken) : '';

  onLog(`🔍 比对 ${src}/${srcUser}/${params.repo}  ⇄  ${dst}/${dstUser}/${params.repo}`);
  const s = lsRemote(srcUrl, params.transport, srcAuth);
  const d = lsRemote(dstUrl, params.transport, dstAuth);

  if (!s.ok) { onLog('  源仓库不可达：' + (s.error || '未知错误')); return { ok: false, src: s, dst: d }; }
  if (!d.ok) { onLog('  目标仓库不可达（可能尚未创建）：' + (d.error || '未知错误')); return { ok: false, src: s, dst: d }; }

  const srcB = new Set(s.branches);
  const dstB = new Set(d.branches);
  const onlySrc = [...srcB].filter((b) => !dstB.has(b));
  const onlyDst = [...dstB].filter((b) => !srcB.has(b));
  const sameHead = s.head && s.head === d.head;

  onLog(`  源：分支 ${s.branches.length} 个，HEAD=${s.head || '无'}`);
  onLog(`  目标：分支 ${d.branches.length} 个，HEAD=${d.head || '无'}`);
  if (onlySrc.length) onLog(`  仅源有：${onlySrc.join(', ')}`);
  if (onlyDst.length) onLog(`  仅目标有：${onlyDst.join(', ')}`);
  onLog(sameHead ? '  ✅ HEAD 一致，两仓内容同步' : '  ⚠ HEAD 不一致，存在差异');

  return { ok: sameHead, src: s, dst: d, onlySrc, onlyDst, sameHead };
}

// ---------------- 前置校验 ----------------

function validateConfig(params, onLog) {
  const issues = [];
  if (!params.direction) issues.push('缺少同步方向');
  if (!params.repo && !(params.repos && params.repos.length)) issues.push('缺少仓库名');
  if (!params.githubUser) issues.push('缺少 GitHub 用户名');
  if (!params.giteeUser) issues.push('缺少 Gitee 用户名');
  if (params.autoCreate) {
    if (params.direction === 'gh2gitee' && !params.giteeToken) issues.push('自动建仓需提供 Gitee 令牌');
    if (params.direction === 'gitee2gh' && !params.githubToken) issues.push('自动建仓需提供 GitHub 令牌');
  }
  if (issues.length) {
    onLog('⚠ 配置校验未通过：' + issues.join('；'));
    return { ok: false, issues };
  }
  onLog('✔ 配置校验通过');
  return { ok: true, issues: [] };
}

module.exports = {
  buildUrl,
  basicAuthHeader,
  lsRemote,
  repoExistsAPI,
  createRepoAPI,
  resolvePlatforms,
  runSync,
  checkStatus,
  validateConfig,
  parseLsRemote,
};

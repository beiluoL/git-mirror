/**
 * 本地持久化：定时配置 / 配置档案 / 同步历史 / 最近一次配置
 * 所有文件均在 .gitignore 中排除（含敏感信息）。
 */
const fs = require('fs');
const path = require('path');

const ROOT = __dirname.replace(/[\\/]src$/, '');
const SCHEDULE_FILE = path.join(ROOT, 'schedule.json');
const PROFILES_FILE = path.join(ROOT, 'config.json');
const HISTORY_FILE = path.join(ROOT, 'history.json');
const LASTSYNC_FILE = path.join(ROOT, 'lastSync.json');
const AUTOSTART_FILE = path.join(ROOT, 'autostart.json');

function load(file, def) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) { return def; }
}
function save(file, obj) {
  try { fs.writeFileSync(file, JSON.stringify(obj, null, 2)); return true; } catch (_) { return false; }
}

// 定时配置
function getSchedule() {
  return Object.assign({ enabled: false, intervalMin: 30 }, load(SCHEDULE_FILE, {}));
}
function setSchedule(s) {
  return save(SCHEDULE_FILE, s);
}

// 配置档案（不含令牌）
function getProfiles() {
  return load(PROFILES_FILE, []);
}
function saveProfile(profile) {
  const list = getProfiles();
  const idx = list.findIndex((p) => p.name === profile.name);
  if (idx >= 0) list[idx] = profile; else list.push(profile);
  return save(PROFILES_FILE, list);
}
function deleteProfile(name) {
  const list = getProfiles().filter((p) => p.name !== name);
  return save(PROFILES_FILE, list);
}

// 同步历史（保留最近 30 条）
function getHistory() {
  return load(HISTORY_FILE, []);
}
function addHistory(entry) {
  const list = getHistory();
  list.unshift(entry);
  if (list.length > 30) list.length = 30;
  return save(HISTORY_FILE, list);
}

// 最近一次同步配置（含令牌，供调度器复用）
function getLastConfig() {
  return load(LASTSYNC_FILE, null);
}
function setLastConfig(cfg) {
  return save(LASTSYNC_FILE, cfg);
}

// 开机自启状态（是否曾启用过，供前端回显）
function getAutostart() {
  return load(AUTOSTART_FILE, { enabled: false });
}
function setAutostart(obj) {
  return save(AUTOSTART_FILE, obj);
}

module.exports = {
  getSchedule, setSchedule,
  getProfiles, saveProfile, deleteProfile,
  getHistory, addHistory,
  getLastConfig, setLastConfig,
  getAutostart, setAutostart,
};

// Cập nhật online qua máy chủ quản trị chung của bạn (active.mrhuynh.net/gcloudhub).
// App gọi endpoint /v1/app/version → nhận {version,url,sha256,size,notes,mandatory} → tải bộ cài →
// kiểm tra SHA-256 → chạy bộ cài im lặng (/S) → tự mở lại. Giống cơ chế của Video AI.
const { app, net } = require('electron');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const store = require('./store');
const pkg = require('../../package.json');

const DEFAULT_URL = pkg.updateUrl || 'https://active.mrhuynh.net/gcloudhub/v1/app/version';
const DEFAULT_GUIDE = 'https://mrhuynh.net/tools';
const baseUrl = () => store.get().settings.updateUrl || DEFAULT_URL;

// Mã máy ẩn danh (uuid) để máy chủ đếm số lượt dùng — KHÔNG chứa thông tin cá nhân nào.
function installId() {
  const s = store.get().settings;
  if (!s.installId || !/^[A-Za-z0-9_-]{8,64}$/.test(s.installId)) {
    s.installId = (crypto.randomUUID ? crypto.randomUUID() : crypto.randomBytes(16).toString('hex')).replace(/-/g, '');
    store.save();
  }
  return s.installId;
}

function endpoint() {
  const u = baseUrl();
  const sep = u.includes('?') ? '&' : '?';
  return `${u}${sep}os=win&v=${encodeURIComponent(pkg.version)}&iid=${installId()}&t=${Date.now()}`;
}

function emit(ch, p) { require('./ipc').toMain(ch, p); }

function cmpVer(a, b) {
  const pa = String(a).replace(/^v/, '').split('.').map((x) => parseInt(x, 10) || 0);
  const pb = String(b).replace(/^v/, '').split('.').map((x) => parseInt(x, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) { const d = (pa[i] || 0) - (pb[i] || 0); if (d) return d > 0 ? 1 : -1; }
  return 0;
}

const isPortable = () => !!process.env.PORTABLE_EXECUTABLE_FILE;

async function fetchInfo() {
  let res;
  try { res = await net.fetch(endpoint(), { cache: 'no-store' }); }
  catch (e) { throw new Error('Không kết nối được máy chủ cập nhật: ' + e.message); }
  if (!res.ok) throw new Error(`Máy chủ cập nhật trả lỗi ${res.status}`);
  let m;
  try { m = await res.json(); } catch { throw new Error('Phản hồi máy chủ không hợp lệ'); }
  if (m && m.ok === false) throw new Error(m.message || 'Máy chủ từ chối yêu cầu');
  return m || {};
}

// Link video hướng dẫn (YouTube) do bạn đặt ở trang quản trị — trả về trong cùng phản hồi version.
function guideUrlCached() { return store.get().settings.guideUrl || DEFAULT_GUIDE; }
async function guide() {
  try {
    const m = await fetchInfo();
    if (m && typeof m.guide_url === 'string' && /^https?:\/\//.test(m.guide_url)) {
      const s = store.get().settings; s.guideUrl = m.guide_url; store.save();
    }
  } catch {}
  return guideUrlCached();
}

async function check() {
  const m = await fetchInfo();
  const s = store.get().settings; s.lastUpdateCheck = Date.now();
  if (m && typeof m.guide_url === 'string' && /^https?:\/\//.test(m.guide_url)) s.guideUrl = m.guide_url;
  store.save();
  const latest = m.version || '0.0.0';
  return {
    current: pkg.version,
    latest,
    notes: m.notes || '',
    date: m.released_at ? new Date((m.released_at > 1e12 ? m.released_at : m.released_at * 1000)).toLocaleDateString('vi-VN') : '',
    available: cmpVer(latest, pkg.version) > 0 && !!m.url,
    mandatory: !!m.mandatory,
    size: m.size || 0,
  };
}

let downloaded = null;

async function download() {
  const m = await fetchInfo();
  if (!m.url) throw new Error('Máy chủ chưa công bố bản cập nhật nào');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gch-update-'));
  let name = 'GCloudHub-update.exe';
  try { name = path.basename(new URL(m.url).pathname) || name; } catch {}
  if (!/\.exe$/i.test(name)) name += '.exe';
  const file = path.join(dir, name);
  const res = await net.fetch(m.url);
  if (!res.ok || !res.body) throw new Error(`Tải bản cập nhật lỗi ${res.status}`);
  const total = +res.headers.get('content-length') || m.size || 0;
  const hash = crypto.createHash('sha256');
  const out = fs.createWriteStream(file);
  let got = 0, lastEmit = 0;
  const reader = res.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    const buf = Buffer.from(value);
    hash.update(buf);
    if (!out.write(buf)) await new Promise((r) => out.once('drain', r));
    got += buf.length;
    if (Date.now() - lastEmit > 200) { lastEmit = Date.now(); emit('update:progress', { got, total }); }
  }
  await new Promise((r) => out.end(r));
  emit('update:progress', { got, total: total || got });
  if (m.sha256) {
    const digest = hash.digest('hex').toLowerCase();
    if (digest !== String(m.sha256).toLowerCase()) {
      fs.rmSync(dir, { recursive: true, force: true });
      throw new Error('Bản cập nhật bị lỗi hoặc không đúng (sai mã SHA-256) — đã hủy để bảo đảm an toàn');
    }
  }
  downloaded = { file, version: m.version };
  return { version: m.version, size: got };
}

// File công bố là BỘ CÀI (Setup). Chạy im lặng rồi tự mở lại ứng dụng — giống Video AI.
function install() {
  if (!downloaded) throw new Error('Chưa tải bản cập nhật');
  if (process.platform !== 'win32') throw new Error('Cài đặt cập nhật chỉ hỗ trợ trên Windows');
  spawn(downloaded.file, ['/S', '--force-run'], { detached: true, stdio: 'ignore' }).unref();
  setTimeout(() => app.exit(0), 400);
  return true;
}

function updateUrl() { return baseUrl(); }

module.exports = { check, download, install, updateUrl, isPortable, guide, guideUrlCached };

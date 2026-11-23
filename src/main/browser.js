// Quản lý phiên trình duyệt riêng cho từng tài khoản + cửa sổ ẩn để tự động hóa
const { app, session, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');
const store = require('./store');

// ---- Nhận dạng trình duyệt nhất quán để Google không chặn đăng nhập ----
// Phiên bản Chrome giả lập = phiên bản trình duyệt thật đã dùng để đăng nhập (nếu có)
const major = () => String(store.get().settings.uaMajor || process.versions.chrome.split('.')[0]);
const chromeUA = () => `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${major()}.0.0.0 Safari/537.36`;
// Firefox phát hành ~4 tuần/lần: 140 = 24/06/2025 → tính phiên bản hiện tại để không bị coi là trình duyệt cũ
const FF_VER = 140 + Math.max(0, Math.floor((Date.now() - Date.UTC(2025, 5, 24)) / (28 * 864e5)));
const FIREFOX_UA = `Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:${FF_VER}.0) Gecko/20100101 Firefox/${FF_VER}.0`;
const BRAND = (edge) => `"${edge ? 'Microsoft Edge' : 'Google Chrome'}";v="${major()}", "Chromium";v="${major()}", "Not_A Brand";v="24"`;

function uaFor(kind) {
  return kind === 'firefox' ? FIREFOX_UA : kind === 'edge' ? `${chromeUA()} Edg/${major()}.0.0.0` : chromeUA();
}
function mode() { return store.get().settings.loginUA || 'firefox'; }
function currentUA() { return uaFor(mode()); }

// Mã chạy trong trang trước mọi script của Google: xóa dấu vết "trình duyệt nhúng"
function stealthMain(m, ver) {
  try {
    Object.defineProperty(Navigator.prototype, 'webdriver', { get: () => false, configurable: true });
    if (m === 'firefox') {
      Object.defineProperty(Navigator.prototype, 'userAgentData', { get: () => undefined, configurable: true });
      try { delete window.chrome; } catch (e) {}
    } else {
      const name = m === 'edge' ? 'Microsoft Edge' : 'Google Chrome';
      const brands = [{ brand: name, version: ver }, { brand: 'Chromium', version: ver }, { brand: 'Not_A Brand', version: '24' }];
      const full = brands.map((b) => ({ brand: b.brand, version: b.version + '.0.0.0' }));
      const data = {
        brands, mobile: false, platform: 'Windows',
        getHighEntropyValues: async () => ({ brands, mobile: false, platform: 'Windows', platformVersion: '15.0.0', architecture: 'x86', bitness: '64', model: '', wow64: false, uaFullVersion: ver + '.0.0.0', fullVersionList: full }),
        toJSON: () => ({ brands, mobile: false, platform: 'Windows' }),
      };
      Object.defineProperty(Navigator.prototype, 'userAgentData', { get: () => data, configurable: true });
    }
  } catch (e) {}
}

function stealthFile() {
  const f = path.join(app.getPath('userData'), 'stealth-preload.js');
  const code = `const { contextBridge } = require('electron');
try { contextBridge.executeInMainWorld({ func: ${stealthMain.toString()}, args: [${JSON.stringify(mode())}, ${JSON.stringify(major())}] }); } catch (e) {}`;
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, code);
  return f;
}

function fixHeaders(h) {
  const m = mode();
  for (const k of Object.keys(h)) {
    if (k.toLowerCase() === 'user-agent') delete h[k];
    if (/^sec-ch-ua/i.test(k)) delete h[k];
  }
  h['User-Agent'] = uaFor(m);
  if (m !== 'firefox') {
    h['sec-ch-ua'] = BRAND(m === 'edge');
    h['sec-ch-ua-mobile'] = '?0';
    h['sec-ch-ua-platform'] = '"Windows"';
  }
  return h;
}

const configured = new Set();
function partitionOf(acc) { return typeof acc === 'string' ? acc : `persist:acc-${acc.id}`; }

function getSession(acc) {
  const p = partitionOf(acc);
  const ses = session.fromPartition(p);
  if (!configured.has(p)) {
    configured.add(p);
    ses.setUserAgent(currentUA());
    try { ses.registerPreloadScript({ type: 'frame', id: 'gch-stealth', filePath: stealthFile() }); } catch (e) {}
    // Header nhất quán với nhận dạng trình duyệt (User-Agent + Client Hints)
    ses.webRequest.onBeforeSendHeaders((d, cb) => cb({ requestHeaders: fixHeaders(d.requestHeaders) }));
    ses.setPermissionRequestHandler((wc, perm, cb) => cb(['notifications', 'clipboard-read', 'clipboard-sanitized-write', 'media', 'fullscreen'].includes(perm)));
    require('./transfer').attachDownloads(ses, typeof acc === 'string' ? null : acc.id);
  }
  return ses;
}

// Đổi chế độ nhận dạng: áp dụng ngay cho mọi phiên
function applyUA() {
  stealthFile();
  for (const p of configured) session.fromPartition(p).setUserAgent(currentUA());
  app.userAgentFallback = currentUA();
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Mở một cửa sổ ẩn dùng phiên của tài khoản
async function hidden(acc, url, { width = 1366, height = 900 } = {}) {
  const win = new BrowserWindow({
    show: false, width, height,
    webPreferences: { session: getSession(acc), backgroundThrottling: false, paintWhenInitiallyHidden: true },
  });
  win.webContents.setAudioMuted(true);
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  try { await win.loadURL(url); } catch { /* chuyển hướng có thể làm loadURL reject — bỏ qua */ }
  return win;
}

async function evalJS(win, code) {
  try { return await win.webContents.executeJavaScript(code, true); } catch { return null; }
}

async function waitFor(win, cond, timeout = 30000, every = 400) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (win.isDestroyed()) return false;
    if (await evalJS(win, `(()=>{try{return !!(${cond})}catch(e){return false}})()`)) return true;
    await sleep(every);
  }
  return false;
}

function isLoginPage(win) {
  const u = win.webContents.getURL();
  return /accounts\.google\.com|login\.microsoftonline\.com|login\.live\.com/.test(u) && !/ManageAccount|myaccount/.test(u);
}

// Hàng đợi tuần tự theo tài khoản để tránh hai thao tác ngầm đè nhau
const locks = new Map();
function withLock(key, fn) {
  const prev = locks.get(key) || Promise.resolve();
  const next = prev.catch(() => {}).then(fn);
  locks.set(key, next.catch(() => {}));
  return next;
}

module.exports = { currentUA, applyUA, getSession, partitionOf, hidden, evalJS, waitFor, sleep, isLoginPage, withLock, uaFor };

// Quản lý phiên trình duyệt riêng cho từng tài khoản + cửa sổ ẩn để tự động hóa
const { app, session, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');
const store = require('./store');

// ---- Nhận dạng trình duyệt nhất quán để Google không chặn đăng nhập ----
// Phiên bản Chrome giả lập = phiên bản trình duyệt thật đã dùng để đăng nhập (nếu có)
// GHIM nhận dạng trình duyệt MỘT LẦN và giữ cố định mãi — nếu UA đổi theo thời gian,
// Google coi là "trình duyệt lạ" cho cùng một phiên và bắt đăng nhập lại. Ghim = phiên bền.
function major() {
  const s = store.get().settings;
  if (!s.uaMajor) { s.uaMajor = process.versions.chrome.split('.')[0]; store.save(); }
  return String(s.uaMajor);
}
// Firefox phát hành ~4 tuần/lần: 140 = 24/06/2025. Tính 1 lần rồi GHIM, không để trôi theo ngày.
function ffVer() {
  const s = store.get().settings;
  if (!s.ffVer) { s.ffVer = 140 + Math.max(0, Math.floor((Date.now() - Date.UTC(2025, 5, 24)) / (28 * 864e5))); store.save(); }
  return s.ffVer;
}
const chromeUA = () => `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${major()}.0.0.0 Safari/537.36`;
const FIREFOX_UA = () => `Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:${ffVer()}.0) Gecko/20100101 Firefox/${ffVer()}.0`;
const BRAND = (edge) => `"${edge ? 'Microsoft Edge' : 'Google Chrome'}";v="${major()}", "Chromium";v="${major()}", "Not_A Brand";v="24"`;

function uaFor(kind) {
  return kind === 'firefox' ? FIREFOX_UA() : kind === 'edge' ? `${chromeUA()} Edg/${major()}.0.0.0` : chromeUA();
}
function mode() { return store.get().settings.loginUA || 'firefox'; }
function currentUA() { return uaFor(mode()); }

// ---- v1.1.10: nhận dạng trình duyệt GHIM THEO TỪNG TÀI KHOẢN ----
// Trước đây cả ứng dụng dùng chung 1 nhận dạng, đổi mỗi khi thêm / đăng nhập lại BẤT KỲ tài khoản nào (vd. Chrome trên
// máy vừa lên bản mới) → mọi tài khoản khác đột nhiên "đổi trình duyệt" giữa phiên → Google đăng xuất chúng.
// Giờ mỗi tài khoản giữ đúng nhận dạng lúc đăng nhập, chỉ đổi khi CHÍNH tài khoản đó đăng nhập lại.
function idOf(acc) {
  if (!acc || typeof acc === 'string') return { kind: mode(), major: major(), ff: ffVer() };
  const a = (() => { try { return store.account(acc.id); } catch { return acc; } })();
  if (!a.uaPin) { a.uaPin = { kind: mode(), major: major(), ff: ffVer() }; store.save(); }   // tài khoản cũ: ghim 1 lần
  return a.uaPin;
}
function uaOf(id) {
  const ff = `Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:${id.ff}.0) Gecko/20100101 Firefox/${id.ff}.0`;
  const ch = `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${id.major}.0.0.0 Safari/537.36`;
  return id.kind === 'firefox' ? ff : id.kind === 'edge' ? `${ch} Edg/${id.major}.0.0.0` : ch;
}
function accountUA(acc) { return uaOf(idOf(acc)); }
// Ghim nhận dạng mới cho MỘT tài khoản (sau khi chính nó đăng nhập lại) và áp ngay cho phiên của nó
function pinAccount(acc, kind, maj) {
  const a = store.account(acc.id);
  a.uaPin = { kind, major: String(maj || major()), ff: ffVer() };
  store.save();
  const p = partitionOf(a);
  if (configured.has(p)) {
    session.fromPartition(p).setUserAgent(uaOf(a.uaPin));
    try { session.fromPartition(p).registerPreloadScript({ type: 'frame', id: 'gch-stealth', filePath: stealthFile(a.uaPin, p) }); } catch (e) {}
  }
}

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

function stealthFile(id = { kind: mode(), major: major() }, p = '') {
  const tag = p ? '-' + p.replace(/[^\w-]/g, '_') : '';
  const f = path.join(app.getPath('userData'), `stealth-preload${tag}.js`);
  const code = `const { contextBridge } = require('electron');
try { contextBridge.executeInMainWorld({ func: ${stealthMain.toString()}, args: [${JSON.stringify(id.kind)}, ${JSON.stringify(String(id.major))}] }); } catch (e) {}`;
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, code);
  return f;
}

function fixHeaders(h, id = { kind: mode(), major: major(), ff: ffVer() }) {
  const m = id.kind;
  for (const k of Object.keys(h)) {
    if (k.toLowerCase() === 'user-agent') delete h[k];
    if (/^sec-ch-ua/i.test(k)) delete h[k];
  }
  h['User-Agent'] = uaOf(id);
  if (m !== 'firefox') {
    h['sec-ch-ua'] = `"${m === 'edge' ? 'Microsoft Edge' : 'Google Chrome'}";v="${id.major}", "Chromium";v="${id.major}", "Not_A Brand";v="24"`;
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
    const own = typeof acc !== 'string';
    ses.setUserAgent(accountUA(acc));
    try { ses.registerPreloadScript({ type: 'frame', id: 'gch-stealth', filePath: own ? stealthFile(idOf(acc), p) : stealthFile() }); } catch (e) {}
    // Header nhất quán với nhận dạng ĐÃ GHIM của tài khoản (User-Agent + Client Hints) – đọc lại mỗi lần, đổi khi ghim lại
    ses.webRequest.onBeforeSendHeaders((d, cb) => cb({ requestHeaders: fixHeaders(d.requestHeaders, own ? idOf(acc) : undefined) }));
    ses.setPermissionRequestHandler((wc, perm, cb) => cb(['notifications', 'clipboard-read', 'clipboard-sanitized-write', 'media', 'fullscreen'].includes(perm)));
    require('./transfer').attachDownloads(ses, typeof acc === 'string' ? null : acc.id);
  }
  return ses;
}

// Ép ghi toàn bộ cookie của mọi phiên xuống đĩa (giữ phiên đăng nhập qua các lần mở app).
async function flushCookies() {
  await Promise.allSettled([...configured].map((p) => {
    try { return session.fromPartition(p).cookies.flushStore(); } catch { return Promise.resolve(); }
  }));
}

// Đổi chế độ nhận dạng mặc định: CHỈ áp cho tài khoản thêm SAU này và phiên tìm kiếm chung.
// Tài khoản đã đăng nhập giữ nguyên nhận dạng đã ghim (đổi giữa phiên = Google đăng xuất).
function applyUA() {
  stealthFile();
  for (const p of configured) if (!p.startsWith('persist:acc-')) session.fromPartition(p).setUserAgent(currentUA());
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

module.exports = { currentUA, accountUA, pinAccount, applyUA, getSession, partitionOf, hidden, evalJS, waitFor, sleep, isLoginPage, withLock, uaFor, flushCookies };

// Đăng nhập Google bằng trình duyệt THẬT (Chrome/Edge) trong hồ sơ riêng → Google không chặn.
// Đăng nhập xong: đọc cookie qua DevTools Protocol, nạp vào phiên của ứng dụng, đóng trình duyệt.
const { app } = require('electron');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function findBrowser() {
  const env = process.env;
  const cands = process.platform === 'win32' ? [
    ['chrome', path.join(env['PROGRAMFILES'] || 'C:\\Program Files', 'Google\\Chrome\\Application\\chrome.exe')],
    ['chrome', path.join(env['PROGRAMFILES(X86)'] || 'C:\\Program Files (x86)', 'Google\\Chrome\\Application\\chrome.exe')],
    ['chrome', path.join(env.LOCALAPPDATA || '', 'Google\\Chrome\\Application\\chrome.exe')],
    ['edge', path.join(env['PROGRAMFILES(X86)'] || 'C:\\Program Files (x86)', 'Microsoft\\Edge\\Application\\msedge.exe')],
    ['edge', path.join(env['PROGRAMFILES'] || 'C:\\Program Files', 'Microsoft\\Edge\\Application\\msedge.exe')],
    ['brave', path.join(env['PROGRAMFILES'] || 'C:\\Program Files', 'BraveSoftware\\Brave-Browser\\Application\\brave.exe')],
  ] : process.platform === 'darwin' ? [
    ['chrome', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'],
    ['edge', '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge'],
  ] : [
    ['chrome', '/usr/bin/google-chrome'], ['chrome', '/usr/bin/chromium'], ['chrome', '/usr/bin/chromium-browser'],
  ];
  const hit = cands.find(([, p]) => p && fs.existsSync(p));
  return hit ? { kind: hit[0], exe: hit[1] } : null;
}

async function getJSON(port, p) {
  const r = await fetch(`http://127.0.0.1:${port}${p}`);
  return r.json();
}

function cdp(wsUrl) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    let id = 0;
    const pending = new Map();
    ws.onmessage = (ev) => {
      const m = JSON.parse(typeof ev.data === 'string' ? ev.data : ev.data.toString());
      if (m.id && pending.has(m.id)) { const { res, rej } = pending.get(m.id); pending.delete(m.id); m.error ? rej(new Error(m.error.message)) : res(m.result); }
    };
    ws.onerror = () => reject(new Error('Không kết nối được trình duyệt'));
    ws.onopen = () => resolve({
      send: (method, params = {}) => new Promise((res, rej) => { const i = ++id; pending.set(i, { res, rej }); ws.send(JSON.stringify({ id: i, method, params })); }),
      close: () => { try { ws.close(); } catch {} },
    });
  });
}

// Đọc tiêu đề các cửa sổ của tiến trình trình duyệt (không can thiệp vào trang → Google không phát hiện)
const { execFile } = require('child_process');
function run(cmd, args) {
  return new Promise((res) => execFile(cmd, args, { windowsHide: true, timeout: 4000, maxBuffer: 1 << 20 }, (e, out) => res(e ? '' : String(out))));
}
async function windowTitles(pid) {
  if (process.platform === 'win32') {
    // CHỈ cửa sổ của trình duyệt do ứng dụng mở (không đụng tới Chrome bạn đang dùng)
    const out = await run('tasklist', ['/v', '/fo', 'csv', '/nh', '/fi', `PID eq ${pid}`]);
    return out.split(/\r?\n/).map((l) => l.split('","').pop()?.replace(/"$/, '') || '').filter((t) => t && t !== 'N/A');
  }
  if (process.platform === 'linux') {
    const ids = (await run('xdotool', ['search', '--pid', String(pid)])).split('\n').filter(Boolean);
    const names = await Promise.all(ids.map((id) => run('xdotool', ['getwindowname', id])));
    return names.map((n) => n.trim()).filter(Boolean);
  }
  if (process.platform === 'darwin') {
    const out = await run('osascript', ['-e', `tell application "System Events" to get name of windows of (first process whose unix id is ${pid})`]);
    return out.split(', ');
  }
  return [];
}

let current = null; // phiên đăng nhập đang mở (để nút "Đã đăng nhập xong" đóng Chrome)

// Đóng như khi người dùng bấm ✕ (Chrome lưu đủ cookie khi đóng kiểu này)
async function gracefulClose(proc) {
  if (!proc || proc.exitCode != null) return;
  if (process.platform === 'win32') {
    spawn('taskkill', ['/PID', String(proc.pid), '/T'], { stdio: 'ignore', windowsHide: true }); // gửi WM_CLOSE, không ép buộc
  } else if (process.platform === 'linux') {
    // gửi yêu cầu đóng cửa sổ (WM_DELETE_WINDOW) như khi bấm ✕
    const ids = (await run('xdotool', ['search', '--pid', String(proc.pid)])).split('\n').filter(Boolean);
    for (const id of ids) await run('wmctrl', ['-i', '-c', '0x' + (+id).toString(16).padStart(8, '0')]);
    if (!ids.length) { try { proc.kill('SIGTERM'); } catch {} }
  } else { try { proc.kill('SIGTERM'); } catch {} }
  // nếu sau 15 giây vẫn chưa thoát thì mới buộc tắt
  setTimeout(() => { if (proc.exitCode == null) { try { proc.kill('SIGKILL'); } catch {} } }, 15000);
}

// Chờ Chrome ghi cookie đăng nhập xuống đĩa (tệp Cookies được cập nhật sau thời điểm đăng nhập)
async function waitCookieFlush(profile, since, maxMs = 4000) {
  const files = [path.join(profile, 'Default', 'Network', 'Cookies'), path.join(profile, 'Default', 'Cookies')];
  const end = Date.now() + maxMs;
  while (Date.now() < end) {
    for (const f of files) { try { if (fs.statSync(f).mtimeMs >= since) return true; } catch {} }
    await sleep(500);
  }
  return false;
}

// Người dùng bấm "Tôi đã đăng nhập xong"
function finish() { if (current) gracefulClose(current.proc); return !!current; }
function cancel() { if (current) { current.cancelled = true; gracefulClose(current.proc); } return true; }

async function waitPort(profile, proc) {
  const portFile = path.join(profile, 'DevToolsActivePort');
  for (let i = 0; i < 150; i++) {
    await sleep(200);
    if (fs.existsSync(portFile)) { const p = +fs.readFileSync(portFile, 'utf8').split(/\r?\n/)[0]; if (p) return p; }
    if (proc.exitCode != null) break;
  }
  return null;
}

/**
 * Bước 1: mở Chrome/Edge HOÀN TOÀN BÌNH THƯỜNG (không bật gỡ lỗi) để Google cho phép đăng nhập.
 * Bước 2: khi người dùng đóng cửa sổ, mở lại hồ sơ đó ở chế độ ẩn để đọc cookie đăng nhập.
 */
async function loginWithSystemBrowser(startUrl, isDone, { timeoutMs = 15 * 60000, onReady, doneTitle } = {}) {
  const b = findBrowser();
  if (!b) throw new Error('NO_BROWSER');
  if (current) cancel();
  const profile = fs.mkdtempSync(path.join(app.getPath('temp') || os.tmpdir(), 'gch-login-'));
  const extra = process.platform === 'linux' ? ['--no-sandbox'] : [];
  const proc = spawn(b.exe, [...extra, `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check', '--window-size=520,760', startUrl], { stdio: 'ignore' });
  const me = { proc, cancelled: false };
  current = me;
  try {
    onReady?.(b.kind);
    const exited = new Promise((r) => proc.once('exit', r));
    const timer = setTimeout(() => gracefulClose(proc), timeoutMs);
    // Tự nhận biết đăng nhập xong qua tiêu đề cửa sổ (vd: "Hộp thư đến - ban@gmail.com - Gmail")
    let watching = true;
    let autoDetected = false;
    if (doneTitle) (async () => {
      await sleep(3000);
      while (watching && proc.exitCode == null) {
        const titles = await windowTitles(proc.pid);
        if (titles.some((t) => doneTitle.test(t))) {
          autoDetected = true;
          const since = Date.now() - 1500;
          await sleep(1500);
          await waitCookieFlush(profile, since);
          await gracefulClose(proc);
          break;
        }
        await sleep(1500);
      }
    })();
    await exited;
    watching = false;
    clearTimeout(timer);
    if (me.cancelled) throw new Error('Đã hủy đăng nhập');
    await sleep(800);

    // Đọc cookie bằng một phiên chạy ẩn của cùng hồ sơ
    const h = spawn(b.exe, [...extra, `--user-data-dir=${profile}`, '--headless=new', '--remote-debugging-port=0', '--remote-allow-origins=*', '--no-first-run', 'about:blank'], { stdio: 'ignore' });
    try {
      const port = await waitPort(profile, h);
      if (!port) throw new Error('Không đọc được phiên đăng nhập từ ' + b.kind);
      const ver = await getJSON(port, '/json/version');
      const version = (ver.Browser || '').split('/')[1] || '';
      const c = await cdp(ver.webSocketDebuggerUrl);
      const { cookies } = await c.send('Storage.getCookies');
      try { await c.send('Browser.close'); } catch {}
      c.close();
      return { cookies, browser: { kind: b.kind, version, major: version.split('.')[0] } };
    } finally { try { h.kill(); } catch {} }
  } finally {
    if (current === me) current = null;
    setTimeout(() => fs.rm(profile, { recursive: true, force: true }, () => {}), 3000);
  }
}

// Nạp cookie vào một phiên Electron
async function importCookies(ses, cookies, filter = () => true) {
  let n = 0;
  for (const ck of cookies) {
    if (!filter(ck)) continue;
    const host = ck.domain.replace(/^\./, '');
    const details = {
      url: `${ck.secure ? 'https' : 'http'}://${host}${ck.path || '/'}`,
      name: ck.name, value: ck.value, path: ck.path || '/',
      secure: !!ck.secure, httpOnly: !!ck.httpOnly,
    };
    if (ck.domain.startsWith('.')) details.domain = ck.domain;
    if (ck.expires && ck.expires > 0) details.expirationDate = ck.expires;
    if (ck.sameSite) details.sameSite = { Strict: 'strict', Lax: 'lax', None: 'no_restriction' }[ck.sameSite] || 'unspecified';
    // Cookie __Host- không được có domain
    if (ck.name.startsWith('__Host-')) delete details.domain;
    try { await ses.cookies.set(details); n++; } catch {}
  }
  await ses.cookies.flushStore();
  return n;
}

module.exports = { findBrowser, loginWithSystemBrowser, importCookies, finish, cancel };

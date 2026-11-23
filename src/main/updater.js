// Cập nhật online: đọc latest.json trên máy chủ của bạn → tải bản mới → kiểm tra SHA-256 → thay file .exe → khởi động lại
const { app, net, BrowserWindow } = require('electron');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const store = require('./store');
const pkg = require('../../package.json');

const DEFAULT_URL = pkg.updateUrl || 'https://mrhuynh.net/gcloudhub/latest.json';
const updateUrl = () => store.get().settings.updateUrl || DEFAULT_URL;

function emit(ch, p) { require('./ipc').toMain(ch, p); }

function cmpVer(a, b) {
  const pa = String(a).replace(/^v/, '').split('.').map((x) => parseInt(x, 10) || 0);
  const pb = String(b).replace(/^v/, '').split('.').map((x) => parseInt(x, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) { const d = (pa[i] || 0) - (pb[i] || 0); if (d) return d > 0 ? 1 : -1; }
  return 0;
}

const isPortable = () => !!process.env.PORTABLE_EXECUTABLE_FILE;

async function check() {
  const url = updateUrl() + (updateUrl().includes('?') ? '&' : '?') + 't=' + Date.now();
  let res;
  try { res = await net.fetch(url, { cache: 'no-store' }); } catch (e) { throw new Error('Không kết nối được máy chủ cập nhật: ' + e.message); }
  if (!res.ok) throw new Error(`Máy chủ cập nhật trả lỗi ${res.status}`);
  let m;
  try { m = await res.json(); } catch { throw new Error('Tệp latest.json không hợp lệ'); }
  const current = pkg.version;
  const pkgInfo = isPortable() ? m.portable : (m.setup || m.portable);
  const s = store.get().settings;
  s.lastUpdateCheck = Date.now(); store.save();
  return {
    current, latest: m.version, notes: m.notes || '', date: m.date || '',
    available: cmpVer(m.version, current) > 0 && !!pkgInfo?.url,
    mandatory: !!m.mandatory, size: pkgInfo?.size || 0,
  };
}

let downloaded = null;

async function download() {
  const res0 = await net.fetch(updateUrl() + '?t=' + Date.now(), { cache: 'no-store' });
  const m = await res0.json();
  const info = isPortable() ? m.portable : (m.setup || m.portable);
  if (!info?.url || !info?.sha256) throw new Error('latest.json thiếu url hoặc sha256');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gch-update-'));
  const file = path.join(dir, path.basename(new URL(info.url).pathname) || 'GCloudHub-update.exe');
  const res = await net.fetch(info.url);
  if (!res.ok || !res.body) throw new Error(`Tải bản cập nhật lỗi ${res.status}`);
  const total = +res.headers.get('content-length') || info.size || 0;
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
  const digest = hash.digest('hex');
  if (digest.toLowerCase() !== String(info.sha256).toLowerCase()) {
    fs.rmSync(dir, { recursive: true, force: true });
    throw new Error('Bản cập nhật bị lỗi hoặc không đúng (sai mã SHA-256) — đã hủy để bảo đảm an toàn');
  }
  downloaded = { file, version: m.version };
  return { version: m.version, size: got };
}

// Thay file và khởi động lại
function install() {
  if (!downloaded) throw new Error('Chưa tải bản cập nhật');
  if (process.platform !== 'win32') throw new Error('Cài đặt cập nhật chỉ hỗ trợ trên Windows');
  if (isPortable()) {
    const target = process.env.PORTABLE_EXECUTABLE_FILE;
    const bat = path.join(path.dirname(downloaded.file), 'gch-update.cmd');
    fs.writeFileSync(bat, [
      '@echo off',
      'chcp 65001 >nul',
      ':wait',
      `tasklist /FI "PID eq ${process.pid}" 2>nul | find "${process.pid}" >nul && (timeout /t 1 /nobreak >nul & goto wait)`,
      'set n=0',
      ':copy',
      `copy /Y "${downloaded.file}" "${target}" >nul 2>&1 || (set /a n+=1 & timeout /t 1 /nobreak >nul & if %n% LSS 20 goto copy)`,
      `start "" "${target}"`,
      '(goto) 2>nul & del "%~f0"',
    ].join('\r\n'));
    spawn('cmd.exe', ['/c', bat], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
  } else {
    // Bản cài đặt (Setup): chạy trình cài đặt mới ở chế độ im lặng rồi mở lại ứng dụng
    spawn(downloaded.file, ['/S', '--force-run'], { detached: true, stdio: 'ignore' }).unref();
  }
  setTimeout(() => app.exit(0), 300);
  return true;
}

module.exports = { check, download, install, updateUrl, isPortable };

// Gói phát hành GCloud Hub (giống Video AI / Voice AI).
//
// Windows (build-windows.bat tự gọi):  node tools/make-downloads.js
//   → dist/downloads-upload.zip – tải lên mrhuynh.net/downloads/ rồi Extract (ghi đè). Chỉ gồm:
//       gcloud_hub_win.exe   bộ cài – phần mềm TỰ CẬP NHẬT tải file này
//       gcloud_hub_win.zip   cho khách tải lần đầu (bên trong 1 tệp .exe)
//       gcloud_win.json      phiên bản, SHA-256, dung lượng (trang quản trị đọc)
//
// macOS (GitHub Actions tự gọi, không cần làm gì):  node tools/make-downloads.js --mac <arm64.dmg> <x64.dmg>
//   → dist/downloads-mac/ = tệp TÊN CỐ ĐỊNH đưa lên GitHub Releases:
//       gcloud_hub_mac.zip (khách tải lần đầu, bên trong 2 bộ cài) – link cố định
//         https://github.com/alltoolsmax/gcloud-hub-build/releases/latest/download/gcloud_hub_mac.zip
//       gcloud_hub_mac_apple.dmg / gcloud_hub_mac_intel.dmg (phần mềm Mac tự cập nhật) + gcloud_mac.json (máy chủ đọc)
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const pkg = require('../package.json');

const DIST = path.join(__dirname, '..', 'dist');
const today = () => new Date().toLocaleDateString('vi-VN', { day: '2-digit', month: '2-digit', year: 'numeric' });

// ---- zip tối giản (không nén – .exe/.dmg đã nén sẵn), không cần thư viện ngoài
const CRC = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; }
  return t;
})();
function crc32File(file) {
  let c = 0xffffffff;
  const fd = fs.openSync(file, 'r'); const buf = Buffer.alloc(1 << 20); let n;
  while ((n = fs.readSync(fd, buf, 0, buf.length, null)) > 0) for (let i = 0; i < n; i++) c = CRC[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  fs.closeSync(fd);
  return (c ^ 0xffffffff) >>> 0;
}
function zipStore(dest, entries) {           // entries: [[tênTrongZip, đườngDẫn]]
  const out = fs.openSync(dest, 'w'); let off = 0; const central = [];
  const w = (b) => { fs.writeSync(out, b); off += b.length; };
  for (const [name, file] of entries) {
    const size = fs.statSync(file).size; const crc = crc32File(file); const nb = Buffer.from(name, 'utf8'); const at = off;
    const h = Buffer.alloc(30); h.writeUInt32LE(0x04034b50, 0); h.writeUInt16LE(20, 4); h.writeUInt16LE(0x0800, 6);
    h.writeUInt32LE(crc, 14); h.writeUInt32LE(size, 18); h.writeUInt32LE(size, 22); h.writeUInt16LE(nb.length, 26);
    w(h); w(nb);
    const fd = fs.openSync(file, 'r'); const buf = Buffer.alloc(1 << 20); let n;
    while ((n = fs.readSync(fd, buf, 0, buf.length, null)) > 0) w(buf.subarray(0, n));
    fs.closeSync(fd);
    const c = Buffer.alloc(46); c.writeUInt32LE(0x02014b50, 0); c.writeUInt16LE(20, 4); c.writeUInt16LE(20, 6); c.writeUInt16LE(0x0800, 8);
    c.writeUInt32LE(crc, 16); c.writeUInt32LE(size, 20); c.writeUInt32LE(size, 24); c.writeUInt16LE(nb.length, 28); c.writeUInt32LE(at, 42);
    central.push(Buffer.concat([c, nb]));
  }
  const cdAt = off; central.forEach(w); const cdSize = off - cdAt;
  const e = Buffer.alloc(22); e.writeUInt32LE(0x06054b50, 0); e.writeUInt16LE(entries.length, 8); e.writeUInt16LE(entries.length, 10);
  e.writeUInt32LE(cdSize, 12); e.writeUInt32LE(cdAt, 16); w(e);
  fs.closeSync(out);
}
function sha256(file) {
  const h = crypto.createHash('sha256'); const fd = fs.openSync(file, 'r'); const buf = Buffer.alloc(1 << 20); let n;
  while ((n = fs.readSync(fd, buf, 0, buf.length, null)) > 0) h.update(buf.subarray(0, n));
  fs.closeSync(fd); return h.digest('hex');
}
function fresh(dir) { fs.rmSync(dir, { recursive: true, force: true }); fs.mkdirSync(dir, { recursive: true }); return dir; }

function win() {
  const setup = path.join(DIST, `GCloudHub-Setup-${pkg.version}.exe`);
  if (!fs.existsSync(setup)) { console.error('Không thấy ' + setup + ' (build bộ cài trước).'); process.exit(1); }
  const out = fresh(path.join(DIST, 'downloads'));
  const exe = path.join(out, 'gcloud_hub_win.exe');
  fs.copyFileSync(setup, exe);
  zipStore(path.join(out, 'gcloud_hub_win.zip'), [['gcloud_hub_win.exe', exe]]);
  const info = { version: pkg.version, sha256: sha256(exe), size: fs.statSync(exe).size,
    zip_size: fs.statSync(path.join(out, 'gcloud_hub_win.zip')).size, date: today() };
  fs.writeFileSync(path.join(out, 'gcloud_win.json'), JSON.stringify(info, null, 1));
  const z = path.join(DIST, 'downloads-upload.zip');
  zipStore(z, ['gcloud_hub_win.exe', 'gcloud_hub_win.zip', 'gcloud_win.json'].map((n) => [n, path.join(out, n)]));
  console.log('Đã tạo ' + z);
}

function mac(arm, x64) {
  for (const f of [arm, x64]) if (!f || !fs.existsSync(f)) { console.error('Không thấy ' + f); process.exit(1); }
  const out = fresh(path.join(DIST, 'downloads-mac'));
  const info = { version: pkg.version, date: today(), archs: ['apple', 'intel'] };
  for (const [chip, src] of [['apple', arm], ['intel', x64]]) {
    const name = `gcloud_hub_mac_${chip}.dmg`; const dst = path.join(out, name);
    fs.copyFileSync(src, dst);
    info[chip] = { file: name, sha256: sha256(dst), size: fs.statSync(dst).size };
  }
  zipStore(path.join(out, 'gcloud_hub_mac.zip'), ['gcloud_hub_mac_apple.dmg', 'gcloud_hub_mac_intel.dmg'].map((n) => [n, path.join(out, n)]));
  info.zip = 'gcloud_hub_mac.zip'; info.zip_size = fs.statSync(path.join(out, 'gcloud_hub_mac.zip')).size;
  fs.writeFileSync(path.join(out, 'gcloud_mac.json'), JSON.stringify(info, null, 1));
  console.log('Đã tạo ' + out + ': ' + fs.readdirSync(out).join(', '));
}

if (process.argv[2] === '--mac') mac(process.argv[3], process.argv[4]);
else win();

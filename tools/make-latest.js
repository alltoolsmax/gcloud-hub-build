// Tạo tệp latest.json cho chức năng cập nhật online.
// Cách dùng:  node tools/make-latest.js "Ghi chú phiên bản" [https://mrhuynh.net/gcloudhub/]
// Sau đó tải lên máy chủ: latest.json + các tệp .exe trong thư mục dist/
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const pkg = require('../package.json');
const notes = process.argv[2] || '';
const base = (process.argv[3] || pkg.updateUrl.replace(/latest\.json$/, '')).replace(/\/?$/, '/');
const dist = path.join(__dirname, '..', 'dist');
function entry(name) {
  const f = path.join(dist, name);
  if (!fs.existsSync(f)) return undefined;
  const buf = fs.readFileSync(f);
  return { url: base + encodeURIComponent(name), sha256: crypto.createHash('sha256').update(buf).digest('hex'), size: buf.length };
}
const v = pkg.version;
const out = {
  version: v,
  date: new Date().toISOString().slice(0, 10),
  notes,
  mandatory: false,
  portable: entry(`GCloudHub-Portable-${v}.exe`),
  setup: entry(`GCloudHub-Setup-${v}.exe`),
};
fs.writeFileSync(path.join(dist, 'latest.json'), JSON.stringify(out, null, 2));
console.log('Đã tạo dist/latest.json:\n' + JSON.stringify(out, null, 2));
console.log(`\nTải lên ${base} các tệp: latest.json` + (out.portable ? `, GCloudHub-Portable-${v}.exe` : '') + (out.setup ? `, GCloudHub-Setup-${v}.exe` : ''));

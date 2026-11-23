// Lưu cấu hình cục bộ (JSON trong thư mục AppData). Không lưu mật khẩu:
// phiên đăng nhập nằm trong cookie của từng phân vùng trình duyệt riêng (persist:acc-<id>).
const { app } = require('electron');
const fs = require('fs');
const path = require('path');

const FILE = () => path.join(app.getPath('userData'), 'gcloudhub-data.json');
let data = null;

function load() {
  if (data) return data;
  try { data = JSON.parse(fs.readFileSync(FILE(), 'utf8')); } catch { data = {}; }
  data.settings = { theme: 'dark', loginUA: 'firefox', ...(data.settings || {}) };
  // Bản cũ mặc định 'chrome' bị Google chặn → chuyển sang Firefox một lần
  if (!data.settings.uaV2) { data.settings.loginUA = 'firefox'; data.settings.uaV2 = true; setTimeout(save, 0); }
  data.accounts ||= [];
  data.stats ||= {};      // accId -> { storage, unread, entries, at }
  data.syncJobs ||= [];
  return data;
}

let timer = null;
function flush() {
  if (!timer || !data) return;
  clearTimeout(timer);
  timer = null;
  fs.mkdirSync(path.dirname(FILE()), { recursive: true });
  const tmp = FILE() + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
  fs.renameSync(tmp, FILE()); // ghi an toàn, không hỏng tệp nếu mất điện giữa chừng
}
function save() {
  clearTimeout(timer);
  timer = setTimeout(flush, 150);
}
process.on('exit', flush);

module.exports = {
  get: load,
  save,
  flush,
  account(id) {
    const a = load().accounts.find((x) => x.id === id);
    if (!a) throw new Error('Không tìm thấy tài khoản');
    return a;
  },
};

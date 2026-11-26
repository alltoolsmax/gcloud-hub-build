// Lớp chống sập đặt TRÊN CÙNG để bắt mọi lỗi, kể cả lỗi lúc nạp module hay lúc khởi động.
// Lỗi bất đồng bộ (vd. cửa sổ bị hủy) chỉ ghi log, không hiện hộp "A JavaScript error occurred" làm app chết.
process.on('uncaughtException', (e) => { try { console.error('uncaughtException:', e && (e.stack || e.message || e)); } catch {} });
process.on('unhandledRejection', (e) => { try { console.error('unhandledRejection:', e && (e.message || e)); } catch {} });

const { app, BrowserWindow, ipcMain, shell, dialog, nativeTheme, Menu, webContents } = require('electron');
const path = require('path');
const store = require('./store');
const browser = require('./browser');
const accounts = require('./accounts');
const google = require('./google');
const transfer = require('./transfer');
const mail = require('./mail');
const updater = require('./updater');
const pkg = require('../../package.json');
const ipc = require('./ipc');

app.setAppUserModelId('com.gcloudhub.app');
// Giảm dấu hiệu tự động hóa để Google cho phép đăng nhập
app.commandLine.appendSwitch('disable-blink-features', 'AutomationControlled');

if (!app.requestSingleInstanceLock()) app.quit();

let win;
function createWindow() {
  const theme = store.get().settings.theme;
  win = new BrowserWindow({
    width: 1440, height: 900, minWidth: 1100, minHeight: 680,
    title: 'GCloud Hub by Mr. Huỳnh',
    icon: path.join(__dirname, '../../assets/icon.png'),
    backgroundColor: theme === 'light' ? '#f4f6fb' : '#0b1020',
    titleBarStyle: 'hidden',
    titleBarOverlay: { color: '#00000000', symbolColor: theme === 'light' ? '#334155' : '#cbd5e1', height: 40 },
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      webviewTag: true,
      spellcheck: false,
    },
  });
  Menu.setApplicationMenu(null);
  ipc.setMain(win);
  win.loadFile(path.join(__dirname, '../renderer/index.html'));
  // Liên kết trong thư: mailto → soạn thư trong ứng dụng, còn lại mở bằng trình duyệt
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^mailto:/i.test(url)) ipc.toMain('mail:mailto', url);
    else if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, url) => { if (!url.startsWith('file://')) { e.preventDefault(); if (/^https?:/.test(url)) shell.openExternal(url); } });
  // Hiện cửa sổ an toàn: ready-to-show là chính, nhưng có dự phòng để KHÔNG BAO GIỜ kẹt ẩn
  const reveal = () => { try { if (win && !win.isDestroyed() && !win.isVisible()) win.show(); } catch {} };
  win.once('ready-to-show', reveal);
  win.webContents.once('did-finish-load', reveal);
  win.webContents.on('did-fail-load', reveal); // vẫn hiện để người dùng thấy, không để treo ẩn
  setTimeout(reveal, 4000); // chốt chặn: trễ mấy cũng phải hiện
}

// Bấm mở app lần nữa → đưa cửa sổ hiện có ra trước (có kiểm tra cửa sổ đã hủy để không bao giờ văng)
app.on('second-instance', () => {
  try {
    if (win && !win.isDestroyed()) { if (win.isMinimized()) win.restore(); win.show(); win.focus(); }
    else createWindow();
  } catch {}
});

// Webview nhúng: chặn cửa sổ bật lên lạ, mở liên kết ngoài bằng trình duyệt hệ thống
app.on('web-contents-created', (e, contents) => {
  if (contents.getType() !== 'webview') return;
  contents.setWindowOpenHandler(({ url }) => {
    let host = '';
    try { host = new URL(url).hostname; } catch {}
    const internal = /(^|\.)(google\.com|googleusercontent\.com|gstatic\.com|office\.com|office365\.com|live\.com|microsoft\.com|zoho\.com)$/.test(host);
    if (internal && !/google\.com\/url\?/.test(url)) {
      return { action: 'allow', overrideBrowserWindowOptions: { autoHideMenuBar: true, width: 1100, height: 800, webPreferences: { session: contents.session } } };
    }
    shell.openExternal(url);
    return { action: 'deny' };
  });
});

app.whenReady().then(() => {
  // Mở cửa sổ TRƯỚC, các khởi tạo phụ bọc riêng để lỗi của chúng không chặn giao diện
  try { createWindow(); } catch (e) { console.error('createWindow:', e && e.message); }
  try {
    app.userAgentFallback = browser.currentUA();
    store.get().accounts.forEach((a) => { try { browser.getSession(a); } catch {} }); // gắn trình bắt tải xuống
    browser.getSession('persist:search');
    transfer.schedule();
  } catch (e) { console.error('init:', e && e.message); }
  setTimeout(() => { try { mail.watchAll(); } catch {} }, 3000); // nhận thư mới tức thì
  // Ép lưu cookie xuống đĩa mỗi 45s để không mất phiên khi app bị thoát đột ngột.
  setInterval(() => { try { browser.flushCookies(); } catch {} }, 45000);
  // Giữ phiên Google: mở trang Google ẩn cho từng tài khoản lúc khởi động (cách nhau 20 giây) và mỗi 45 phút
  const aliveAll = () => store.get().accounts.filter((a) => a.provider === 'google')
    .forEach((a, i) => setTimeout(() => { google.keepAlive(a.id).catch(() => {}); }, 20000 + i * 20000));
  setTimeout(aliveAll, 10000);
  setInterval(aliveAll, 45 * 60e3);
});

// Lưu cookie trước khi thoát (giữ phiên đăng nhập cho lần mở sau).
let _flushed = false;
app.on('before-quit', (e) => {
  if (_flushed) return;
  e.preventDefault(); _flushed = true;
  Promise.resolve(browser.flushCookies()).catch(() => {}).finally(() => app.quit());
});

app.on('window-all-closed', () => app.quit());

// ---------- IPC ----------
const handlers = {
  'app:info': () => ({ version: pkg.version, platform: process.platform, chrome: process.versions.chrome, ua: browser.currentUA() }),
  'settings:get': () => store.get().settings,
  'settings:set': (patch) => {
    Object.assign(store.get().settings, patch);
    store.save();
    if (patch.loginUA) browser.applyUA();
    if (patch.theme && win) {
      win.setTitleBarOverlay?.({ color: '#00000000', symbolColor: patch.theme === 'light' ? '#334155' : '#cbd5e1', height: 40 });
      nativeTheme.themeSource = patch.theme;
    }
    return store.get().settings;
  },

  'accounts:list': () => accounts.list(),
  'login:browser': () => require('./syslogin').findBrowser(),
  'login:finish': () => require('./syslogin').finish(),
  'login:cancel': () => require('./syslogin').cancel(),
  'accounts:providers': () => Object.fromEntries(Object.entries(accounts.PROVIDERS).map(([k, v]) => [k, v.label])),
  'accounts:add': (p) => accounts.add(p, win),
  'accounts:remove': (id) => accounts.remove(id),
  'accounts:update': (id, patch) => accounts.update(id, patch),
  'accounts:reorder': (ids) => accounts.reorder(ids),
  'accounts:relogin': async (id) => {
    const acc = store.account(id);
    if (acc.provider === 'google' && store.get().settings.loginMethod !== 'embedded' && require('./syslogin').findBrowser()) {
      const r = await accounts.googleSystemLogin(acc, acc.email);
      if (r.email.toLowerCase() !== acc.email.toLowerCase()) throw new Error(`Bạn đã đăng nhập ${r.email}, không phải ${acc.email}`);
      return true;
    }
    const ses = browser.getSession(acc);
    if (acc.provider === 'google') {
      // v1.1.12 – đăng nhập TRONG ỨNG DỤNG: bỏ phiên cũ chép từ Chrome (Google đã gắn phiên đó vào Chrome nên không
      // làm mới được) và dùng nhận dạng đăng nhập đang chọn trong Cài đặt, để phiên mới thuộc hẳn về ứng dụng.
      await ses.clearStorageData({ storages: ['cookies', 'localstorage', 'indexdb', 'serviceworkers', 'cachestorage'] }).catch(() => {});
      const st = store.get().settings;
      browser.pinAccount(acc, st.loginUA || 'firefox', st.uaMajor);
    }
    const w = new BrowserWindow({ width: 520, height: 720, parent: win, autoHideMenuBar: true, title: 'Đăng nhập lại — ' + acc.email, webPreferences: { session: ses } });
    w.webContents.setUserAgent(browser.accountUA(acc));
    const url = acc.provider === 'google'
      ? `https://accounts.google.com/ServiceLogin?Email=${encodeURIComponent(acc.email)}&continue=https%3A%2F%2Fmail.google.com%2Fmail%2Fu%2F0%2F`
      : acc.mailUrl;
    w.loadURL(url).catch(() => {});
    return new Promise((res) => {
      w.webContents.on('did-navigate', (e, u) => { if (/^https:\/\/mail\.google\.com\/mail/.test(u)) setTimeout(() => { if (!w.isDestroyed()) w.close(); }, 800); });
      w.on('closed', () => res(true));
    });
  },

  'stats:cached': () => store.get().stats,
  'mail:inbox': (id) => google.inbox(id),
  'mail:quickSend': (id, msg) => (store.account(id).mail
    ? mail.send(id, { ...msg, html: msg.html || String(msg.body || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/\n/g, '<br>') })
    : google.send(id, msg)),
  'mail:presets': () => Object.fromEntries(Object.entries(mail.PRESETS).map(([k, v]) => [k, { label: v.label, imap: v.imap, smtp: v.smtp }])),
  'mail:info': (id) => mail.mailInfo(store.account(id)),
  'mail:configure': (id, cfg) => mail.configure(id, cfg),
  'mail:unconfigure': (id) => mail.unconfigure(id),
  'mail:appPassword': (id) => mail.createGoogleAppPassword(id, win),
  'mail:revealPassword': (id) => mail.revealPassword(id),
  'mail:addImap': (p) => mail.addImapAccount(p, accounts.createDirect),
  'mail:folders': (id) => mail.folders(id),
  'mail:cachedList': (id, box) => mail.cachedList(id, box),
  'mail:cachedUnified': () => mail.cachedUnified(),
  'mail:cachedFolders': (id) => mail.cachedFolders(id),
  'mail:prefetch': (id, box, uids) => { mail.prefetch(id, box, uids).catch(() => {}); return true; },
  'mail:list': (id, box, opts) => mail.list(id, box, opts),
  'mail:unified': (opts) => mail.unified(opts),
  'mail:get': (id, box, uid) => mail.get(id, box, uid),
  'mail:action': (id, box, uids, act, target) => mail.action(id, box, uids, act, target),
  'mail:send': (id, msg) => mail.send(id, msg),
  'mail:draft': (id, msg) => mail.saveDraft(id, msg),
  'mail:summary': (id) => mail.summary(id),
  'mail:saveAtt': (id, box, uid, i) => mail.saveAttachment(id, box, uid, i, win),
  'mail:openAtt': (id, box, uid, i) => mail.openAttachment(id, box, uid, i),
  'drive:storage': (id) => google.storage(id),
  'drive:folderUrl': (f) => google.driveFolderUrl(f),

  'transfer:capture': (id) => transfer.setCapture(id),
  'transfer:queue': () => transfer.listQueue(),
  'transfer:addLocal': async () => {
    const r = await dialog.showOpenDialog(win, { title: 'Chọn tệp để chuyển', properties: ['openFile', 'multiSelections'] });
    return r.canceled ? transfer.listQueue() : transfer.addLocal(r.filePaths);
  },
  'transfer:remove': (ids) => transfer.removeItems(ids),
  'transfer:links': (src, links) => transfer.downloadLinks(src, links),
  'transfer:upload': (ids, dest, folder) => transfer.upload(ids, dest, folder),
  'transfer:stop': () => transfer.stop(),
  'transfer:state': () => transfer.state(),

  'sync:jobs': () => transfer.jobs(),
  'sync:save': (job) => transfer.saveJob(job),
  'sync:delete': (id) => transfer.deleteJob(id),
  'sync:run': (id) => transfer.runJob(id),

  'dialog:files': async () => {
    const r = await dialog.showOpenDialog(win, { properties: ['openFile', 'multiSelections'] });
    return r.canceled ? [] : r.filePaths;
  },
  'dialog:media': async () => {
    const r = await dialog.showOpenDialog(win, { title: 'Chọn ảnh / video', properties: ['openFile', 'multiSelections'],
      filters: [{ name: 'Ảnh & video', extensions: ['jpg', 'jpeg', 'png', 'gif', 'webp', 'heic', 'heif', 'bmp', 'tif', 'tiff', 'raw', 'dng', 'cr2', 'nef', 'arw', 'mp4', 'mov', 'avi', 'mkv', 'm4v', '3gp', 'wmv'] }] });
    return r.canceled ? [] : r.filePaths;
  },
  'drive:pick': async (kind) => {
    const r = await dialog.showOpenDialog(win, kind === 'folder'
      ? { title: 'Chọn thư mục để tải lên Drive', properties: ['openDirectory', 'multiSelections'] }
      : { title: 'Chọn tệp để tải lên Drive', properties: ['openFile', 'multiSelections'] });
    return r.canceled ? [] : r.filePaths;
  },
  'drive:upload': (accId, wcId, paths, kind) => google.uploadVisible(accId, webContents.fromId(wcId), paths, kind,
    (p) => ipc.toMain('drive:progress', { accId, ...p })),
  'drive:folderUpload': (wcId, test) => google.folderUploadVisible(webContents.fromId(wcId), { testIntercept: !!test }),
  'drive:folders': (accId, folderId) => require('./drivetree').listFolders(accId, folderId),
  'drive:createFolder': (accId, parentId, name) => require('./drivetree').createFolder(accId, parentId, name),
  'drive:treeClose': (accId) => { require('./drivetree').close(accId); return true; },
  'drive:queueSelected': (wcId) => google.downloadEachSelected(webContents.fromId(wcId)),
  'drive:queueFolders': (accId, items) => { transfer.setCapture(accId); return google.queueFolders(accId, items); },
  'drive:download': (wcId) => google.downloadSelectedVisible(webContents.fromId(wcId)),
  'dialog:downloadDir': async () => {
    const r = await dialog.showOpenDialog(win, { title: 'Chọn thư mục lưu tệp tải về', properties: ['openDirectory', 'createDirectory'] });
    if (r.canceled) return store.get().settings;
    Object.assign(store.get().settings, { downloadDir: r.filePaths[0] }); store.save();
    return store.get().settings;
  },
  'shell:openPath': (p) => shell.openPath(p),
  'update:check': () => updater.check(),
  'update:download': () => updater.download(),
  'update:install': () => updater.install(),
  'guide:url': () => updater.guide(),
  'update:info': () => ({ url: updater.updateUrl(), portable: updater.isPortable(), version: pkg.version, last: store.get().settings.lastUpdateCheck || 0 }),
  'drive:newFolder': (wcId, name) => google.newFolderVisible(webContents.fromId(wcId), name),
  'photos:upload': (id, files) => google.uploadToPhotos(id, files),
  'dialog:folder': async () => {
    const r = await dialog.showOpenDialog(win, { properties: ['openDirectory'] });
    return r.canceled ? null : r.filePaths[0];
  },
  'shell:open': (url) => { if (/^(https?:\/\/|mailto:|tel:)/.test(url)) shell.openExternal(url); return true; },
  'shell:showItem': (p) => { shell.showItemInFolder(p); return true; },
  'shell:downloads': () => shell.openPath(store.get().settings.downloadDir || app.getPath('downloads')),
};

for (const [ch, fn] of Object.entries(handlers)) {
  ipcMain.handle(ch, async (e, ...args) => {
    try { return { ok: true, data: await fn(...args) }; }
    catch (err) { return { ok: false, error: err?.message || String(err) }; }
  });
}

// Chế độ chụp màn hình cho nhà phát triển: GCH_SHOT=<file.png> GCH_VIEW=<view>
if (process.env.GCH_SHOT) {
  app.whenReady().then(() => win.webContents.on('console-message', (e) => { if (e.level === 'error' || e.level === 'warning') console.log('[renderer]', e.message); }));
  app.whenReady().then(() => setTimeout(async () => {
    if (process.env.GCH_JS) await win.webContents.executeJavaScript(process.env.GCH_JS);
    if (process.env.GCH_VIEW) await win.webContents.executeJavaScript(`go(${JSON.stringify(process.env.GCH_VIEW)})`);
    await new Promise((r) => setTimeout(r, +(process.env.GCH_WAIT || 2500)));
    const img = await win.webContents.capturePage();
    require('fs').writeFileSync(process.env.GCH_SHOT, img.toPNG());
    app.exit(0);
  }, 3500));
}

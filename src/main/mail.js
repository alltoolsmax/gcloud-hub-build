// Trình quản lý thư trực tiếp qua IMAP (nhận) / SMTP (gửi) — giống Outlook / Thunderbird.
// Gmail: đăng nhập bằng Mật khẩu ứng dụng (App Password). Email doanh nghiệp: máy chủ IMAP/SMTP.
const { app, safeStorage, BrowserWindow, shell, dialog } = require('electron');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { ImapFlow } = require('imapflow');
const nodemailer = require('nodemailer');
const { simpleParser } = require('mailparser');
const crypto = require('crypto');
const store = require('./store');

// ---------- Mã hóa mật khẩu (Windows DPAPI) ----------
function enc(s) {
  if (!s) return '';
  return safeStorage.isEncryptionAvailable() ? 'enc:' + safeStorage.encryptString(s).toString('base64') : 'raw:' + Buffer.from(s).toString('base64');
}
function dec(s) {
  if (!s) return '';
  if (s.startsWith('enc:')) return safeStorage.decryptString(Buffer.from(s.slice(4), 'base64'));
  if (s.startsWith('raw:')) return Buffer.from(s.slice(4), 'base64').toString();
  return s;
}

const PRESETS = {
  gmail: { label: 'Gmail / Google Workspace', imap: { host: 'imap.gmail.com', port: 993, secure: true }, smtp: { host: 'smtp.gmail.com', port: 465, secure: true } },
  outlook: { label: 'Outlook / Hotmail / Microsoft 365', imap: { host: 'outlook.office365.com', port: 993, secure: true }, smtp: { host: 'smtp.office365.com', port: 587, secure: false } },
  yahoo: { label: 'Yahoo Mail', imap: { host: 'imap.mail.yahoo.com', port: 993, secure: true }, smtp: { host: 'smtp.mail.yahoo.com', port: 465, secure: true } },
  zoho: { label: 'Zoho Mail', imap: { host: 'imap.zoho.com', port: 993, secure: true }, smtp: { host: 'smtp.zoho.com', port: 465, secure: true } },
  icloud: { label: 'iCloud Mail', imap: { host: 'imap.mail.me.com', port: 993, secure: true }, smtp: { host: 'smtp.mail.me.com', port: 587, secure: false } },
  custom: { label: 'Máy chủ khác (cPanel, Mắt Bão, PA Việt Nam…)', imap: { host: '', port: 993, secure: true }, smtp: { host: '', port: 465, secure: true } },
};

function guessPreset(email) {
  const d = (email.split('@')[1] || '').toLowerCase();
  if (/^(gmail|googlemail)\.com$/.test(d)) return 'gmail';
  if (/^(outlook|hotmail|live|msn)\.[a-z.]+$/.test(d)) return 'outlook';
  if (/^yahoo\./.test(d)) return 'yahoo';
  if (/^(icloud|me|mac)\.com$/.test(d)) return 'icloud';
  if (/^zoho/.test(d)) return 'zoho';
  return 'custom';
}

// ---------- Kết nối IMAP: 'main' (danh sách/thao tác), 'read' (mở thư/tải trước) ----------
const clients = new Map();

function cfgOf(acc) {
  if (!acc.mail) throw new Error(`Tài khoản ${acc.email} chưa kết nối hộp thư`);
  return acc.mail;
}

function newClient(m) {
  const c = new ImapFlow({
    host: m.imap.host, port: +m.imap.port, secure: !!m.imap.secure,
    auth: { user: m.user, pass: dec(m.pass) },
    logger: false, emitLogs: false,
    tls: { rejectUnauthorized: !m.allowInsecure },
  });
  c.on('error', () => {});
  return c;
}

async function client(accId, role = 'main') {
  const key = accId + '|' + role;
  const existing = clients.get(key);
  if (existing) {
    const c = await existing.catch(() => null);
    if (c && c.usable) return c;
    clients.delete(key);
  }
  const acc = store.account(accId);
  const p = (async () => {
    const c = newClient(cfgOf(acc));
    c.on('close', () => { if (clients.get(key) === p) clients.delete(key); });
    await c.connect();
    return c;
  })();
  clients.set(key, p);
  try { return await p; } catch (e) { clients.delete(key); throw friendly(e, acc); }
}

function friendly(e, acc) {
  const msg = e?.responseText || e?.message || String(e);
  if (/AUTHENTICATIONFAILED|Invalid credentials|authentication failed|LOGIN failed|535/i.test(msg) || e?.authenticationFailed) {
    return new Error(`Sai mật khẩu hoặc tài khoản ${acc?.email || ''} chưa cho phép IMAP. ` +
      (acc?.mail?.preset === 'gmail' ? 'Gmail cần dùng Mật khẩu ứng dụng (không phải mật khẩu đăng nhập).' : 'Kiểm tra lại mật khẩu / mật khẩu ứng dụng.'));
  }
  if (/ENOTFOUND|EAI_AGAIN/.test(msg)) return new Error('Không tìm thấy máy chủ thư — kiểm tra địa chỉ máy chủ và kết nối mạng.');
  if (/ETIMEDOUT|ECONNREFUSED|ECONNRESET/.test(msg)) return new Error('Không kết nối được máy chủ thư (cổng hoặc mạng bị chặn).');
  return new Error(msg);
}

async function withBox(accId, boxPath, fn, role = 'main') {
  const c = await client(accId, role);
  const lock = await c.getMailboxLock(boxPath);
  try { return await fn(c); } finally { lock.release(); }
}

async function disconnect(accId) {
  stopWatch(accId);
  for (const role of ['main', 'read']) {
    const p = clients.get(accId + '|' + role);
    clients.delete(accId + '|' + role);
    if (p) { try { (await p).logout(); } catch {} }
  }
}

// ---------- Bộ nhớ đệm trên đĩa (mở thư tức thì như Gmail) ----------
const h = (x) => crypto.createHash('sha1').update(String(x)).digest('hex').slice(0, 16);
function cacheDir(accId) {
  const d = path.join(app.getPath('userData'), 'mailcache', accId);
  fs.mkdirSync(d, { recursive: true });
  return d;
}
function readJSON(f) { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } }
function writeJSON(f, v) { fs.writeFile(f, JSON.stringify(v), () => {}); }
const listFile = (accId, p) => path.join(cacheDir(accId), `list-${h(p)}.json`);
const bodyFile = (accId, p, uid) => path.join(cacheDir(accId), `body-${h(p)}-${uid}.json`);
const bodyMem = new Map(); // bộ đệm RAM cho nội dung thư

function cachedList(accId, boxPath) {
  try { store.account(accId); } catch { return null; }
  return readJSON(listFile(accId, boxPath));
}
function cachedUnified() {
  const accs = store.get().accounts.filter((a) => a.mail);
  const msgs = accs.flatMap((a) => cachedList(a.id, 'INBOX')?.messages || []);
  return msgs.length ? { messages: msgs.sort((a, b) => b.date - a.date), more: true } : null;
}
function cachedFolders(accId) { try { return readJSON(path.join(cacheDir(accId), 'folders.json')); } catch { return null; } }
function cachedBody(accId, boxPath, uid) {
  const k = `${accId}|${boxPath}|${uid}`;
  if (bodyMem.has(k)) return bodyMem.get(k);
  const b = readJSON(bodyFile(accId, boxPath, uid));
  if (b) memPut(k, b);
  return b;
}
function memPut(k, v) {
  bodyMem.set(k, v);
  if (bodyMem.size > 300) bodyMem.delete(bodyMem.keys().next().value);
}
function clearFolderCache(accId, boxPath) {
  const pre = `body-${h(boxPath)}-`;
  try { for (const f of fs.readdirSync(cacheDir(accId))) if (f.startsWith(pre)) fs.rm(path.join(cacheDir(accId), f), () => {}); } catch {}
  for (const k of [...bodyMem.keys()]) if (k.startsWith(`${accId}|${boxPath}|`)) bodyMem.delete(k);
}
// Giữ bộ đệm gọn: tối đa ~3000 thư / tài khoản
function pruneCache(accId) {
  try {
    const d = cacheDir(accId);
    const files = fs.readdirSync(d).filter((f) => f.startsWith('body-')).map((f) => ({ f, t: fs.statSync(path.join(d, f)).mtimeMs }));
    if (files.length <= 3000) return;
    files.sort((a, b) => a.t - b.t).slice(0, files.length - 2500).forEach((x) => fs.rm(path.join(d, x.f), () => {}));
  } catch {}
}

// ---------- Nhận thư mới tức thì (IMAP IDLE) ----------
const watchers = new Map();
function emitAll(ch, p) { BrowserWindow.getAllWindows().forEach((w) => !w.isDestroyed() && w.webContents.send(ch, p)); }
async function watch(accId) {
  if (watchers.has(accId)) return;
  const st = { stop: false, c: null, delay: 5000 };
  watchers.set(accId, st);
  const loop = async () => {
    while (!st.stop) {
      try {
        const acc = store.account(accId);
        const c = newClient(cfgOf(acc));
        st.c = c;
        await c.connect();
        await c.mailboxOpen('INBOX', { readOnly: true });
        st.delay = 5000;
        let t = null;
        c.on('exists', () => { clearTimeout(t); t = setTimeout(() => emitAll('mail:new', { accId }), 400); });
        c.on('flags', () => { clearTimeout(t); t = setTimeout(() => emitAll('mail:new', { accId, flagsOnly: true }), 800); });
        // Giữ kết nối ở chế độ IDLE: máy chủ đẩy thông báo ngay khi có thư mới
        const closed = new Promise((res) => c.once('close', res));
        (async () => { while (!st.stop && c.usable) { try { await c.idle(); } catch { break; } } })();
        await closed;
      } catch { /* thử lại sau */ }
      if (st.stop) break;
      await new Promise((r) => setTimeout(r, st.delay));
      st.delay = Math.min(st.delay * 2, 5 * 60000);
    }
  };
  loop();
}
function stopWatch(accId) {
  const st = watchers.get(accId);
  if (!st) return;
  st.stop = true;
  try { st.c?.logout(); } catch {}
  watchers.delete(accId);
}
function watchAll() { store.get().accounts.filter((a) => a.mail).forEach((a) => watch(a.id)); }

// ---------- Cấu hình ----------
async function testConfig(m) {
  const c = newClient(m);
  try { await c.connect(); await c.logout(); } catch (e) { throw friendly(e, { email: m.user, mail: m }); }
  const t = nodemailer.createTransport({ host: m.smtp.host, port: +m.smtp.port, secure: !!m.smtp.secure, auth: { user: m.user, pass: dec(m.pass) } });
  try { await t.verify(); } catch (e) { throw new Error('IMAP OK nhưng SMTP (gửi thư) lỗi: ' + (e.response || e.message)); }
}

async function configure(accId, { preset, user, password, imap, smtp, displayName }) {
  const acc = store.account(accId);
  const p = PRESETS[preset] || PRESETS.custom;
  const m = {
    preset,
    user: (user || acc.email).trim(),
    pass: enc(String(password || '').replace(/\s+/g, preset === 'gmail' ? '' : ' ').trim()),
    imap: { ...p.imap, ...(imap || {}) },
    smtp: { ...p.smtp, ...(smtp || {}) },
    displayName: displayName || acc.name || '',
  };
  if (!m.imap.host || !m.smtp.host) throw new Error('Hãy nhập địa chỉ máy chủ IMAP và SMTP');
  await testConfig(m);
  await disconnect(accId);
  acc.mail = m;
  store.save();
  watch(accId);
  return mailInfo(acc);
}

function mailInfo(acc) {
  return acc.mail ? { configured: true, preset: acc.mail.preset, user: acc.mail.user, imap: acc.mail.imap, smtp: acc.mail.smtp } : { configured: false, suggested: guessPreset(acc.email || '') };
}

async function unconfigure(accId) {
  const acc = store.account(accId);
  await disconnect(accId);
  try { fs.rmSync(path.join(app.getPath('userData'), 'mailcache', accId), { recursive: true, force: true }); } catch {}
  delete acc.mail;
  store.save();
  return true;
}

// Thêm tài khoản email chỉ dùng IMAP/SMTP (không cần đăng nhập trình duyệt)
async function addImapAccount({ email, name, preset, password, imap, smtp, user }, newAccountFn) {
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email || '')) throw new Error('Email không hợp lệ');
  const d = store.get();
  if (d.accounts.some((a) => a.email?.toLowerCase() === email.toLowerCase() && a.mail)) throw new Error('Email này đã có trong ứng dụng');
  const pr = PRESETS[preset] || PRESETS.custom;
  const m = {
    preset, user: (user || email).trim(), pass: enc(String(password || '').trim()),
    imap: { ...pr.imap, ...(imap || {}) }, smtp: { ...pr.smtp, ...(smtp || {}) }, displayName: name || '',
  };
  await testConfig(m);
  return newAccountFn({ provider: 'imap', email, name: name || email, mail: m });
}

// ---------- Tự động tạo Mật khẩu ứng dụng Google ----------
function createGoogleAppPassword(accId, parent) {
  const acc = store.account(accId);
  const { getSession } = require('./browser');
  return new Promise((resolve, reject) => {
    const win = new BrowserWindow({
      width: 560, height: 760, parent, autoHideMenuBar: true, title: 'Tạo mật khẩu ứng dụng — ' + acc.email,
      webPreferences: { session: getSession(acc) },
    });
    let done = false;
    win.loadURL('https://myaccount.google.com/apppasswords').catch(() => {});
    // Điền sẵn tên ứng dụng
    win.webContents.on('did-finish-load', () => {
      win.webContents.executeJavaScript(`(()=>{const i=document.querySelector('input[type=text]');if(i&&!i.value){i.focus();document.execCommand('insertText',false,'GCloud Hub');}})()`).catch(() => {});
    });
    const timer = setInterval(async () => {
      if (win.isDestroyed()) return;
      const text = await win.webContents.executeJavaScript('document.body ? document.body.innerText : ""').catch(() => '');
      const m = text.match(/\b([a-z]{4})\s([a-z]{4})\s([a-z]{4})\s([a-z]{4})\b/);
      if (m && !done) {
        done = true;
        clearInterval(timer);
        const pw = m.slice(1).join('');
        if (!win.isDestroyed()) win.destroy();
        // Không làm mất mật khẩu: luôn trả về để hiển thị cho người dùng, kể cả khi kết nối lỗi
        try {
          const info = await configure(accId, { preset: 'gmail', user: acc.email, password: pw });
          resolve({ ok: true, info, password: pw });
        } catch (e) {
          resolve({ ok: false, error: e.message, password: pw });
        }
      }
    }, 800);
    win.on('closed', () => { clearInterval(timer); if (!done) reject(new Error('Đã đóng cửa sổ trước khi tạo mật khẩu ứng dụng')); });
  });
}

// ---------- Thư mục ----------
const SPECIAL = {
  '\\Inbox': { name: 'Hộp thư đến', icon: 'inbox', order: 0 },
  '\\Flagged': { name: 'Có gắn sao', icon: 'star', order: 1 },
  '\\Important': { name: 'Quan trọng', icon: 'flag', order: 2 },
  '\\Sent': { name: 'Đã gửi', icon: 'send', order: 3 },
  '\\Drafts': { name: 'Thư nháp', icon: 'draft', order: 4 },
  '\\All': { name: 'Tất cả thư', icon: 'archive', order: 5 },
  '\\Archive': { name: 'Lưu trữ', icon: 'archive', order: 5 },
  '\\Junk': { name: 'Thư rác', icon: 'spam', order: 6 },
  '\\Trash': { name: 'Thùng rác', icon: 'trash', order: 7 },
};

async function folders(accId) {
  const c = await client(accId);
  const list = await c.list({ statusQuery: { unseen: true, messages: true } });
  const out = list
    .filter((b) => !b.flags?.has('\\Noselect') && !b.flags?.has('\\NonExistent'))
    .map((b) => {
      const su = b.path.toUpperCase() === 'INBOX' ? '\\Inbox' : b.specialUse;
      const sp = SPECIAL[su];
      return {
        path: b.path, special: su || null,
        name: sp?.name || b.name, icon: sp?.icon || 'folder', order: sp ? sp.order : 20,
        unread: b.status?.unseen || 0, total: b.status?.messages || 0,
      };
    })
    .sort((a, b) => a.order - b.order || a.name.localeCompare(b.name, 'vi'));
  writeJSON(path.join(cacheDir(accId), 'folders.json'), out);
  return out;
}

async function specialPath(accId, special) {
  const c = await client(accId);
  const list = await c.list();
  return list.find((b) => b.specialUse === special)?.path || null;
}

// ---------- Danh sách thư ----------
function addr(a) { return (a || []).map((x) => ({ name: x.name || '', address: x.address || '' })); }

function summarize(m, accId, boxPath) {
  const e = m.envelope || {};
  const bs = JSON.stringify(m.bodyStructure || {});
  return {
    accId, path: boxPath, uid: m.uid,
    subject: e.subject || '(Không có tiêu đề)',
    from: addr(e.from)[0] || { name: '', address: '' },
    to: addr(e.to),
    date: +(e.date || m.internalDate || 0),
    seen: m.flags?.has('\\Seen'), flagged: m.flags?.has('\\Flagged'), answered: m.flags?.has('\\Answered'),
    attach: /"disposition":"attachment"/i.test(bs),
    size: m.size || 0,
  };
}

const PAGE = 50;
const QUERY = { envelope: true, flags: true, uid: true, bodyStructure: true, internalDate: true, size: true };

async function list(accId, boxPath, { page = 0, search = '' } = {}) {
  const acc = store.account(accId);
  return withBox(accId, boxPath, async (c) => {
    const total = c.mailbox.exists || 0;
    let msgs = [];
    let more = false;
    if (search) {
      let uids;
      try {
        uids = acc.mail.preset === 'gmail' || /gmail\.com$/.test(acc.mail.imap.host)
          ? await c.search({ gmraw: search }, { uid: true })
          : await c.search({ or: [{ subject: search }, { from: search }, { to: search }, { body: search }] }, { uid: true });
      } catch { uids = await c.search({ or: [{ subject: search }, { from: search }] }, { uid: true }); }
      uids = (uids || []).sort((a, b) => b - a);
      const slice = uids.slice(page * PAGE, (page + 1) * PAGE);
      more = uids.length > (page + 1) * PAGE;
      if (slice.length) for await (const m of c.fetch(slice, QUERY, { uid: true })) msgs.push(summarize(m, accId, boxPath));
    } else if (total) {
      const hi = total - page * PAGE;
      const lo = Math.max(1, hi - PAGE + 1);
      more = lo > 1;
      if (hi >= 1) for await (const m of c.fetch(`${lo}:${hi}`, QUERY)) msgs.push(summarize(m, accId, boxPath));
    }
    msgs.sort((a, b) => b.date - a.date);
    const uidValidity = String(c.mailbox.uidValidity || '');
    if (!search && page === 0) {
      const old = cachedList(accId, boxPath);
      if (old && old.uidValidity && old.uidValidity !== uidValidity) clearFolderCache(accId, boxPath);
      writeJSON(listFile(accId, boxPath), { messages: msgs, more, total, uidValidity, at: Date.now() });
    }
    return { messages: msgs, more, total };
  });
}

// Hộp thư đến hợp nhất của mọi tài khoản đã kết nối
async function unified({ page = 0 } = {}) {
  const accs = store.get().accounts.filter((a) => a.mail);
  const results = await Promise.all(accs.map((a) => list(a.id, 'INBOX', { page }).catch((e) => ({ messages: [], more: false, error: e.message, accId: a.id }))));
  const messages = results.flatMap((r) => r.messages).sort((a, b) => b.date - a.date);
  return { messages, more: results.some((r) => r.more), errors: results.filter((r) => r.error).map((r) => ({ accId: r.accId, error: r.error })) };
}

// ---------- Đọc thư ----------
const parsedCache = new Map(); // key -> parsed mail (tệp đính kèm)
const keyOf = (accId, p, uid) => `${accId}|${p}|${uid}`;

async function parsed(accId, boxPath, uid) {
  const k = keyOf(accId, boxPath, uid);
  if (parsedCache.has(k)) return parsedCache.get(k);
  const src = await withBox(accId, boxPath, async (c) => {
    const m = await c.fetchOne(String(uid), { source: true }, { uid: true });
    if (!m) throw new Error('Thư không còn tồn tại');
    return m.source;
  }, 'read');
  const p = await simpleParser(src);
  parsedCache.set(k, p);
  if (parsedCache.size > 40) parsedCache.delete(parsedCache.keys().next().value);
  return p;
}

function inlineCid(html, attachments) {
  if (!html) return html;
  for (const a of attachments) {
    if (a.contentId && a.content && a.size < 3 * 1024 * 1024) {
      const cid = a.contentId.replace(/^<|>$/g, '');
      html = html.split('cid:' + cid).join(`data:${a.contentType};base64,${a.content.toString('base64')}`);
    }
  }
  return html;
}

function markSeen(accId, boxPath, uid) {
  withBox(accId, boxPath, (c) => c.messageFlagsAdd(String(uid), ['\\Seen'], { uid: true })).catch(() => {});
}

async function get(accId, boxPath, uid) {
  const cached = cachedBody(accId, boxPath, uid);
  if (cached) { markSeen(accId, boxPath, uid); return { ...cached, fromCache: true }; }
  const body = await buildBody(accId, boxPath, uid);
  markSeen(accId, boxPath, uid);
  return body;
}

// Tải trước nội dung thư (không đánh dấu đã đọc) để khi bấm là mở ngay
const prefetching = new Set();
async function prefetch(accId, boxPath, uids) {
  for (const uid of uids) {
    const k = `${accId}|${boxPath}|${uid}`;
    if (prefetching.has(k) || cachedBody(accId, boxPath, uid)) continue;
    prefetching.add(k);
    try { await buildBody(accId, boxPath, uid); } catch {} finally { prefetching.delete(k); }
  }
  pruneCache(accId);
  return true;
}

async function buildBody(accId, boxPath, uid) {
  const p = await parsed(accId, boxPath, uid);
  const atts = p.attachments || [];
  const textHtml = p.textAsHtml || `<pre>${(p.text || '').replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]))}</pre>`;
  const body = {
    accId, path: boxPath, uid,
    subject: p.subject || '(Không có tiêu đề)',
    from: p.from?.value?.[0] || { name: '', address: '' },
    replyTo: p.replyTo?.value || [],
    to: p.to ? [].concat(p.to).flatMap((x) => x.value) : [],
    cc: p.cc ? [].concat(p.cc).flatMap((x) => x.value) : [],
    date: +(p.date || 0),
    messageId: p.messageId || '',
    references: p.references ? [].concat(p.references) : [],
    html: inlineCid(p.html || '', atts) || textHtml,
    text: p.text || '',
    attachments: atts
      .map((a, i) => ({ i, filename: a.filename || `tep-dinh-kem-${i + 1}`, size: a.size, contentType: a.contentType, inline: a.related || (a.contentDisposition === 'inline' && !!a.contentId) }))
      .filter((a) => !a.inline),
  };
  if (body.html.length < 3 * 1024 * 1024) { memPut(`${accId}|${boxPath}|${uid}`, body); writeJSON(bodyFile(accId, boxPath, uid), body); }
  return body;
}

async function saveAttachment(accId, boxPath, uid, i, parent) {
  const p = await parsed(accId, boxPath, uid);
  const a = p.attachments[i];
  const r = await dialog.showSaveDialog(parent, { defaultPath: path.join(app.getPath('downloads'), a.filename || 'tep') });
  if (r.canceled) return null;
  fs.writeFileSync(r.filePath, a.content);
  shell.showItemInFolder(r.filePath);
  return r.filePath;
}

async function openAttachment(accId, boxPath, uid, i) {
  const p = await parsed(accId, boxPath, uid);
  const a = p.attachments[i];
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gch-'));
  const f = path.join(dir, (a.filename || 'tep').replace(/[\\/:*?"<>|]/g, '_'));
  fs.writeFileSync(f, a.content);
  await shell.openPath(f);
  return f;
}

// ---------- Thao tác ----------
async function action(accId, boxPath, uids, act, target) {
  const set = uids.map(String).join(',');
  const acc = store.account(accId);
  const isGmail = acc.mail?.preset === 'gmail';
  return withBox(accId, boxPath, async (c) => {
    const opt = { uid: true };
    switch (act) {
      case 'read': await c.messageFlagsAdd(set, ['\\Seen'], opt); break;
      case 'unread': await c.messageFlagsRemove(set, ['\\Seen'], opt); break;
      case 'flag': await c.messageFlagsAdd(set, ['\\Flagged'], opt); break;
      case 'unflag': await c.messageFlagsRemove(set, ['\\Flagged'], opt); break;
      case 'move': await c.messageMove(set, target, opt); break;
      case 'trash': {
        const trash = (await c.list()).find((b) => b.specialUse === '\\Trash')?.path;
        if (trash && trash !== boxPath) await c.messageMove(set, trash, opt);
        else await c.messageDelete(set, opt);
        break;
      }
      case 'delete': await c.messageDelete(set, opt); break;
      case 'spam': {
        const junk = (await c.list()).find((b) => b.specialUse === '\\Junk')?.path;
        if (!junk) throw new Error('Không tìm thấy thư mục Thư rác');
        await c.messageMove(set, junk, opt);
        break;
      }
      case 'archive': {
        if (isGmail) { await c.messageMove(set, (await c.list()).find((b) => b.specialUse === '\\All')?.path || '[Gmail]/All Mail', opt); break; }
        const arch = (await c.list()).find((b) => b.specialUse === '\\Archive')?.path;
        if (!arch) throw new Error('Máy chủ không có thư mục Lưu trữ');
        await c.messageMove(set, arch, opt);
        break;
      }
      default: throw new Error('Thao tác không hợp lệ');
    }
    uids.forEach((u) => {
      parsedCache.delete(keyOf(accId, boxPath, u));
      if (['move', 'trash', 'delete', 'spam', 'archive'].includes(act)) { bodyMem.delete(`${accId}|${boxPath}|${u}`); fs.rm(bodyFile(accId, boxPath, u), () => {}); }
    });
    return true;
  });
}

// ---------- Gửi thư ----------
async function send(accId, msg) {
  const acc = store.account(accId);
  const m = cfgOf(acc);
  const from = m.displayName ? `"${m.displayName.replace(/"/g, '')}" <${acc.email}>` : acc.email;
  const mail = {
    from, to: msg.to, cc: msg.cc || undefined, bcc: msg.bcc || undefined,
    subject: msg.subject || '',
    html: msg.html,
    text: msg.text || (msg.html || '').replace(/<br\s*\/?>/gi, '\n').replace(/<\/p>/gi, '\n').replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' '),
    attachments: (msg.attachments || []).map((p) => ({ filename: path.basename(p), path: p })),
  };
  if (msg.inReplyTo) { mail.inReplyTo = msg.inReplyTo; mail.references = [...(msg.references || []), msg.inReplyTo].join(' '); }
  if (msg.forward) {
    const p = await parsed(msg.forward.accId, msg.forward.path, msg.forward.uid);
    for (const a of p.attachments || []) if (!a.related) mail.attachments.push({ filename: a.filename, content: a.content, contentType: a.contentType });
  }
  const t = nodemailer.createTransport({ host: m.smtp.host, port: +m.smtp.port, secure: !!m.smtp.secure, auth: { user: m.user, pass: dec(m.pass) } });
  const info = await t.sendMail(mail).catch((e) => { throw new Error('Gửi thư thất bại: ' + (e.response || e.message)); });

  // Gmail tự lưu thư đã gửi; máy chủ khác cần chép vào thư mục Đã gửi
  if (m.preset !== 'gmail' && !/gmail\.com$/.test(m.smtp.host)) {
    try {
      const raw = await new (require('nodemailer/lib/mail-composer'))({ ...mail, messageId: info.messageId }).compile().build();
      const sent = await specialPath(accId, '\\Sent');
      if (sent) await (await client(accId)).append(sent, raw, ['\\Seen']);
    } catch {}
  }
  // đánh dấu đã trả lời
  if (msg.replyOf) action(msg.replyOf.accId, msg.replyOf.path, [msg.replyOf.uid], 'read').then(() =>
    withBox(msg.replyOf.accId, msg.replyOf.path, (c) => c.messageFlagsAdd(String(msg.replyOf.uid), ['\\Answered'], { uid: true }))).catch(() => {});
  return true;
}

// Lưu thư nháp
async function saveDraft(accId, msg) {
  const acc = store.account(accId);
  const raw = await new (require('nodemailer/lib/mail-composer'))({
    from: acc.email, to: msg.to, cc: msg.cc, bcc: msg.bcc, subject: msg.subject, html: msg.html,
    attachments: (msg.attachments || []).map((p) => ({ filename: path.basename(p), path: p })),
  }).compile().build();
  const drafts = await specialPath(accId, '\\Drafts');
  if (!drafts) throw new Error('Không tìm thấy thư mục Thư nháp');
  await (await client(accId)).append(drafts, raw, ['\\Draft', '\\Seen']);
  return true;
}

// ---------- Tóm tắt hộp thư đến (cho Tổng quan & thông báo) ----------
const lastUid = new Map();
async function summary(accId) {
  return withBox(accId, 'INBOX', async (c) => {
    const unseen = (await c.search({ seen: false }, { uid: true })) || [];
    unseen.sort((a, b) => b - a);
    const recent = [];
    const pick = unseen.slice(0, 15);
    if (pick.length) for await (const m of c.fetch(pick, QUERY, { uid: true })) recent.push(summarize(m, accId, 'INBOX'));
    recent.sort((a, b) => b.date - a.date);
    const maxUid = unseen[0] || 0;
    const prev = lastUid.get(accId);
    const fresh = prev == null ? [] : recent.filter((r) => r.uid > prev);
    lastUid.set(accId, Math.max(prev || 0, maxUid));
    return { unread: unseen.length, recent, fresh };
  });
}

// Xem lại mật khẩu đã lưu (chỉ trên máy này, đã mã hóa bằng Windows)
function revealPassword(accId) {
  const acc = store.account(accId);
  if (!acc.mail) throw new Error('Tài khoản chưa kết nối hộp thư');
  return { user: acc.mail.user, password: dec(acc.mail.pass), preset: acc.mail.preset };
}

module.exports = {
  revealPassword,
  cachedList, cachedUnified, cachedFolders, prefetch, watch, watchAll,
  PRESETS, guessPreset, configure, unconfigure, mailInfo, addImapAccount, createGoogleAppPassword,
  folders, list, unified, get, saveAttachment, openAttachment, action, send, saveDraft, summary, disconnect,
};

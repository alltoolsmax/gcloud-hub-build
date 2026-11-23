// Thêm / xóa tài khoản bằng cửa sổ đăng nhập trình duyệt thật
const { BrowserWindow, session } = require('electron');
const crypto = require('crypto');
const store = require('./store');
const { getSession, currentUA, partitionOf, sleep, applyUA, hidden, evalJS } = require('./browser');
const syslogin = require('./syslogin');

const GOOGLE_DONE = (u) => /^https:\/\/(mail\.google\.com\/mail|myaccount\.google\.com)/.test(u);

// Tìm email của phiên Google (Atom feed Gmail, hoặc trang Tài khoản Google)
async function googleEmailOf(acc) {
  const ses = getSession(acc);
  const em = await detectGoogleEmail(ses, null);
  if (em) return em;
  const w = await hidden(acc, 'https://myaccount.google.com/?hl=en');
  try {
    for (let i = 0; i < 20; i++) {
      const t = await evalJS(w, `(document.title+' '+(document.body?document.body.innerText:'')).match(/[\\w.+-]+@[\\w-]+(?:\\.[\\w-]+)+/)`);
      if (t) return t[0];
      await sleep(500);
    }
  } finally { if (!w.isDestroyed()) w.destroy(); }
  return null;
}

// Đăng nhập Google bằng Chrome/Edge thật rồi nạp phiên vào ứng dụng
async function googleSystemLogin(acc, loginHint) {
  const url = 'https://accounts.google.com/ServiceLogin?continue=' + encodeURIComponent('https://mail.google.com/mail/u/0/') + (loginHint ? '&Email=' + encodeURIComponent(loginHint) : '');
  const r = await syslogin.loginWithSystemBrowser(url, GOOGLE_DONE, {
    // Gmail: "Hộp thư đến (3) - ban@gmail.com - Gmail"; Tài khoản Google: "... - Google Account / Tài khoản Google"
    doneTitle: /([\w.+-]+@[\w-]+(?:\.[\w-]+)+.*\bGmail\b)|(\bGmail\b.*@)|(^(Google Account|Tài khoản Google)\b)/i,
    onReady: (kind) => require('electron').BrowserWindow.getAllWindows().forEach((w) => w.webContents.send('login:waiting', { kind })),
  });
  // Phải có cookie đăng nhập Google thật sự
  if (!r.cookies.some((c) => /(^|\.)google\.com$/.test(c.domain.replace(/^\./, '')) && /^(SID|__Secure-1PSID|__Secure-3PSID)$/.test(c.name))) {
    throw new Error('Chưa đăng nhập Google trong cửa sổ trình duyệt — hãy thử lại và chỉ đóng cửa sổ sau khi đã đăng nhập xong');
  }
  const st = store.get().settings;
  st.loginUA = r.browser.kind === 'edge' ? 'edge' : 'chrome';
  if (r.browser.major) st.uaMajor = r.browser.major;
  store.save();
  applyUA();
  const ses = getSession(acc);
  await ses.clearStorageData({ storages: ['cookies'] });
  await syslogin.importCookies(ses, r.cookies, (c) => /(^|\.)(google|youtube|gstatic|googleusercontent|gmail)\.[a-z.]+$/.test(c.domain.replace(/^\./, '')));
  const email = await googleEmailOf(acc);
  if (!email) throw new Error('Đã đăng nhập nhưng không đọc được phiên Google — hãy thử lại');
  return { email, browser: r.browser.kind };
}

const COLORS = ['#4f8cff', '#22c55e', '#f59e0b', '#ef4444', '#a855f7', '#06b6d4', '#ec4899', '#84cc16'];

const PROVIDERS = {
  google: {
    label: 'Google / Gmail / Google Workspace',
    loginUrl: 'https://accounts.google.com/ServiceLogin?continue=https%3A%2F%2Fmail.google.com%2Fmail%2Fu%2F0%2F',
    mailUrl: 'https://mail.google.com/mail/u/0/',
    done: (u) => /^https:\/\/mail\.google\.com\/mail\//.test(u) || /^https:\/\/myaccount\.google\.com/.test(u),
  },
  microsoft: {
    label: 'Outlook / Microsoft 365',
    loginUrl: 'https://outlook.office.com/mail/',
    mailUrl: 'https://outlook.office.com/mail/',
    done: (u) => /^https:\/\/outlook\.(office|office365|live)\.com\/mail/.test(u),
  },
  zoho: {
    label: 'Zoho Mail',
    loginUrl: 'https://mail.zoho.com/zm/',
    mailUrl: 'https://mail.zoho.com/zm/',
    done: (u) => /^https:\/\/mail\.zoho\.[a-z.]+\/zm\//.test(u),
  },
  custom: { label: 'Webmail khác (URL tùy chỉnh)', done: () => false },
  imap: { label: 'Email doanh nghiệp (IMAP/SMTP)', done: () => false },
};

function pub(a) {
  return { id: a.id, provider: a.provider, email: a.email, name: a.name, color: a.color, mailUrl: a.mailUrl, partition: partitionOf(a),
    mail: a.mail ? { configured: true, preset: a.mail.preset } : { configured: false } };
}

function list() { return store.get().accounts.map(pub); }

// Lấy email của tài khoản Google từ Atom feed của Gmail (dùng cookie của phiên)
async function detectGoogleEmail(ses, win) {
  if (!win) {
    try {
      const r = await ses.fetch('https://mail.google.com/mail/u/0/feed/atom', { credentials: 'include' });
      const m = (await r.text()).match(/<title>[^<]*?([\w.+-]+@[\w-]+(?:\.[\w-]+)+)<\/title>/);
      return m ? m[1] : null;
    } catch { return null; }
  }
  try {
    const r = await ses.fetch('https://mail.google.com/mail/u/0/feed/atom', { credentials: 'include' });
    const t = await r.text();
    const m = t.match(/<title>[^<]*?([\w.+-]+@[\w-]+(?:\.[\w-]+)+)<\/title>/);
    if (m) return m[1];
  } catch {}
  for (let i = 0; i < 20 && !win.isDestroyed(); i++) {
    const title = win.webContents.getTitle();
    const m = title.match(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/);
    if (m) return m[0];
    await sleep(500);
  }
  return null;
}

function add({ provider = 'google', email = '', name = '', url = '' }, parent) {
  const prov = PROVIDERS[provider];
  if (!prov) throw new Error('Nhà cung cấp không hợp lệ');
  const d = store.get();
  // Google: ưu tiên đăng nhập bằng trình duyệt thật (Google chặn trình duyệt nhúng)
  if (provider === 'google' && d.settings.loginMethod !== 'embedded' && syslogin.findBrowser()) {
    return (async () => {
      const acc = { id: crypto.randomUUID(), provider, email: '', name, color: COLORS[d.accounts.length % COLORS.length], mailUrl: prov.mailUrl };
      try {
        const r = await googleSystemLogin(acc);
        if (d.accounts.some((a) => a.provider === 'google' && a.email.toLowerCase() === r.email.toLowerCase())) {
          await getSession(acc).clearStorageData();
          throw new Error(`Tài khoản ${r.email} đã có trong ứng dụng`);
        }
        acc.email = r.email; acc.name = name || r.email;
        d.accounts.push(acc); store.save();
        return pub(acc);
      } catch (e) { await getSession(acc).clearStorageData().catch(() => {}); throw e; }
    })();
  }
  const acc = {
    id: crypto.randomUUID(), provider,
    email, name: name || email,
    color: COLORS[d.accounts.length % COLORS.length],
    mailUrl: provider === 'custom' ? url : prov.mailUrl,
  };
  const ses = getSession(acc);
  const ua = currentUA();

  return new Promise((resolve, reject) => {
    const win = new BrowserWindow({
      width: 520, height: 720, parent, modal: false, autoHideMenuBar: true,
      title: `Đăng nhập — ${prov.label}`, backgroundColor: '#ffffff',
      webPreferences: { session: ses },
    });
    win.webContents.setUserAgent(ua);
    win.webContents.setWindowOpenHandler(({ url: u }) => { win.loadURL(u); return { action: 'deny' }; });
    let finished = false;

    const finish = async () => {
      if (finished) return;
      finished = true;
      if (provider === 'google') {
        const em = await detectGoogleEmail(ses, win);
        if (!em) { finished = false; return; }
        if (d.accounts.some((a) => a.provider === 'google' && a.email.toLowerCase() === em.toLowerCase())) {
          if (!win.isDestroyed()) win.destroy();
          await ses.clearStorageData();
          return reject(new Error(`Tài khoản ${em} đã có trong ứng dụng`));
        }
        acc.email = em;
        acc.name = name || em;
      }
      d.accounts.push(acc);
      store.save();
      if (!win.isDestroyed()) win.destroy();
      resolve(pub(acc));
    };

    // Microsoft: tự đọc email trên trang Outlook sau khi đăng nhập, rồi tự đóng cửa sổ
    let msPoll = null;
    const msDetect = () => {
      if (msPoll || provider !== 'microsoft') return;
      let tries = 0;
      msPoll = setInterval(async () => {
        if (win.isDestroyed() || finished) return clearInterval(msPoll);
        const em = await win.webContents.executeJavaScript(`(()=>{const re=/[\\w.+-]+@[\\w-]+(?:\\.[\\w-]+)+/;
          const src=[document.title,...[...document.querySelectorAll('[aria-label],[title]')].map(e=>(e.getAttribute('aria-label')||'')+' '+(e.getAttribute('title')||'')),document.body?document.body.innerText.slice(0,20000):''];
          for(const t of src){const m=t&&t.match(re);if(m)return m[0]}return null})()`).catch(() => null);
        if (em || ++tries > 40) {
          clearInterval(msPoll);
          acc.email = em || acc.email || 'Tài khoản Microsoft';
          acc.name = name || acc.email;
          finished = true;
          d.accounts.push(acc); store.save();
          if (!win.isDestroyed()) win.destroy();
          resolve(pub(acc));
        }
      }, 1000);
    };
    win.webContents.on('did-navigate', (e, u) => { if (prov.done(u)) { if (provider === 'microsoft') msDetect(); else setTimeout(finish, 1200); } });
    win.webContents.on('did-navigate-in-page', (e, u) => { if (prov.done(u)) { if (provider === 'microsoft') msDetect(); else setTimeout(finish, 1200); } });
    win.on('closed', async () => {
      if (finished) return;
      // Với webmail tùy chỉnh/MS không tự nhận diện được: người dùng đóng cửa sổ = hoàn tất
      if (provider !== 'google') {
        acc.email ||= 'Tài khoản Microsoft'; acc.name ||= acc.email;
        const cookies = await ses.cookies.get({});
        if (cookies.length) { d.accounts.push(acc); store.save(); return resolve(pub(acc)); }
      }
      await ses.clearStorageData();
      reject(new Error('Đã hủy đăng nhập'));
    });
    win.loadURL(provider === 'custom' ? url : prov.loginUrl).catch(() => {});
  });
}

// Tạo tài khoản trực tiếp (email IMAP/SMTP — không cần đăng nhập trình duyệt)
function createDirect({ provider, email, name, mail }) {
  const d = store.get();
  const acc = { id: crypto.randomUUID(), provider, email, name: name || email, color: COLORS[d.accounts.length % COLORS.length], mail };
  d.accounts.push(acc);
  store.save();
  return pub(acc);
}

async function remove(id) {
  await require('./mail').disconnect(id).catch(() => {});
  const d = store.get();
  const acc = store.account(id);
  d.accounts = d.accounts.filter((a) => a.id !== id);
  delete d.stats[id];
  d.syncJobs.forEach((j) => { j.destAccs = (j.destAccs || []).filter((x) => x !== id); });
  store.save();
  await session.fromPartition(partitionOf(acc)).clearStorageData();
  return true;
}

function update(id, patch) {
  const acc = store.account(id);
  ['name', 'color'].forEach((k) => { if (patch[k] != null) acc[k] = patch[k]; });
  store.save();
  return pub(acc);
}

function reorder(ids) {
  const d = store.get();
  d.accounts.sort((a, b) => ids.indexOf(a.id) - ids.indexOf(b.id));
  store.save();
  return list();
}

module.exports = { googleSystemLogin, add, createDirect, pub, remove, list, update, reorder, PROVIDERS };

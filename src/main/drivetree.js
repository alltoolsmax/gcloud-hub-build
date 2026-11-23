// Cây thư mục Drive (chọn nơi chuyển đến, tạo thư mục mới) — dùng phiên đăng nhập của người dùng.
// Cách 1 (chính): gọi dịch vụ danh sách tệp mà chính trang Drive dùng, chạy bên trong một trang Drive ẩn.
// Cách 2/3 (dự phòng): đọc dữ liệu nhúng trong trang (_DRIVE_ivd) hoặc đọc từ giao diện.
const store = require('./store');
const { getSession, hidden, evalJS, waitFor, sleep, withLock } = require('./browser');

const FOLDER_MIME = 'application/vnd.google-apps.folder';
const ESC = { n: '\n', r: '\r', t: '\t', b: '\b', f: '\f', v: '\v', 0: '\0' };
const byName = (a, b) => a.name.localeCompare(b.name, 'vi', { numeric: true });

function decodeJsString(raw) {
  let out = '';
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i];
    if (c !== '\\') { out += c; continue; }
    const n = raw[++i];
    if (n === 'x') { out += String.fromCharCode(parseInt(raw.substr(i + 1, 2), 16)); i += 2; }
    else if (n === 'u') { out += String.fromCharCode(parseInt(raw.substr(i + 1, 4), 16)); i += 4; }
    else out += ESC[n] ?? n;
  }
  return out;
}

function parseDriveIvd(html) {
  const at = html.indexOf('_DRIVE_ivd');
  if (at < 0) return null;
  const eq = html.indexOf('=', at);
  const q1 = html.indexOf("'", eq);
  if (eq < 0 || q1 < 0) return null;
  let j = q1 + 1;
  while (j < html.length && html[j] !== "'") j += html[j] === '\\' ? 2 : 1;
  let arr;
  try { arr = JSON.parse(decodeJsString(html.slice(q1 + 1, j))); } catch { return null; }
  const items = Array.isArray(arr) && Array.isArray(arr[0]) ? arr[0] : [];
  return items.filter((e) => Array.isArray(e) && typeof e[0] === 'string')
    .map((e) => ({ id: e[0], name: String(e[2] ?? ''), mime: String(e[3] ?? '') }));
}

// ---- Trang Drive ẩn dùng làm "cầu nối" (giữ mở trong lúc người dùng duyệt cây) ----
const workers = new Map(); // accId -> { win, ready, timer }

function worker(accId) {
  let w = workers.get(accId);
  if (w && !w.win.isDestroyed()) { touch(accId, w); return w.ready.then(() => w.win); }
  const acc = store.account(accId);
  w = {};
  w.ready = (async () => {
    w.win = await hidden(acc, 'https://drive.google.com/drive/my-drive');
    await waitFor(w.win, `document.readyState === 'complete'`, 30000);
    if (/accounts\.google\.com/.test(w.win.webContents.getURL())) throw new Error('Phiên đăng nhập đã hết hạn — hãy đăng nhập lại ' + acc.email);
  })();
  workers.set(accId, w);
  touch(accId, w);
  return w.ready.then(() => w.win).catch((e) => { close(accId); throw e; });
}
function touch(accId, w) {
  clearTimeout(w.timer);
  w.timer = setTimeout(() => close(accId), 3 * 60000); // tự đóng sau 3 phút không dùng
}
function close(accId) {
  const w = workers.get(accId);
  workers.delete(accId);
  if (w?.win && !w.win.isDestroyed()) w.win.destroy();
}

// Gọi dịch vụ Drive từ bên trong trang Drive (đúng cách trang Drive tự làm: cookie + SAPISIDHASH)
const PAGE_CALL = `async (method, url, body) => {
  const ck = {};
  document.cookie.split('; ').forEach((c) => { const i = c.indexOf('='); if (i > 0) ck[c.slice(0, i)] = c.slice(i + 1); });
  const origin = location.origin, ts = Math.floor(Date.now() / 1000);
  const sha1 = async (s) => [...new Uint8Array(await crypto.subtle.digest('SHA-1', new TextEncoder().encode(s)))].map((b) => b.toString(16).padStart(2, '0')).join('');
  const auth = [];
  if (ck.SAPISID) auth.push('SAPISIDHASH ' + ts + '_' + await sha1(ts + ' ' + ck.SAPISID + ' ' + origin));
  if (ck['__Secure-1PAPISID']) auth.push('SAPISID1PHASH ' + ts + '_' + await sha1(ts + ' ' + ck['__Secure-1PAPISID'] + ' ' + origin));
  if (ck['__Secure-3PAPISID']) auth.push('SAPISID3PHASH ' + ts + '_' + await sha1(ts + ' ' + ck['__Secure-3PAPISID'] + ' ' + origin));
  if (!auth.length) return { ok: false, error: 'NO_SAPISID' };
  const keys = [...new Set(document.documentElement.innerHTML.match(/AIza[0-9A-Za-z_\\-]{35}/g) || [])];
  let last = 'NO_KEY';
  for (const key of keys) {
    try {
      const r = await fetch(url + (url.includes('?') ? '&' : '?') + 'key=' + key, {
        method, credentials: 'include',
        headers: { Authorization: auth.join(' '), 'X-Goog-AuthUser': '0', 'Content-Type': 'application/json' },
        body: body ? JSON.stringify(body) : undefined,
      });
      const t = await r.text();
      if (r.ok) return { ok: true, data: t ? JSON.parse(t) : null };
      last = r.status + ' ' + t.slice(0, 160);
    } catch (e) { last = String(e); }
  }
  return { ok: false, error: last };
}`;

async function pageCall(accId, method, url, body) {
  const win = await worker(accId);
  const r = await win.webContents.executeJavaScript(`(${PAGE_CALL})(${JSON.stringify(method)}, ${JSON.stringify(url)}, ${JSON.stringify(body || null)})`, true);
  if (!r?.ok) throw new Error('DRIVE_CALL ' + (r?.error || 'lỗi'));
  return r.data;
}

const API = 'https://clients6.google.com/drive/v2internal/files';

async function listViaService(accId, folderId) {
  const q = `'${(folderId || 'root').replace(/'/g, "\\'")}' in parents and mimeType = '${FOLDER_MIME}' and trashed = false`;
  const items = [];
  let pageToken = '';
  for (let i = 0; i < 20; i++) {
    const p = new URLSearchParams({ q, fields: 'nextPageToken,items(id,title)', maxResults: '1000', orderBy: 'title', supportsTeamDrives: 'true', includeTeamDriveItems: 'true' });
    if (pageToken) p.set('pageToken', pageToken);
    const d = await pageCall(accId, 'GET', `${API}?${p}`);
    (d.items || []).forEach((x) => items.push({ id: x.id, name: x.title }));
    if (!d.nextPageToken) break;
    pageToken = d.nextPageToken;
  }
  return items.sort(byName);
}

async function listFolders(accId, folderId) {
  const acc = store.account(accId);
  if (acc.provider !== 'google') throw new Error('Chỉ hỗ trợ Google Drive');
  // Cách 1
  try { return await listViaService(accId, folderId); }
  catch (e) { if (/hết hạn/.test(e.message)) throw e; console.warn('[drivetree] dịch vụ:', e.message); }
  // Cách 2: dữ liệu nhúng trong trang
  const url = folderId ? `https://drive.google.com/drive/folders/${encodeURIComponent(folderId)}` : 'https://drive.google.com/drive/my-drive';
  try {
    const r = await getSession(acc).fetch(url, { credentials: 'include' });
    const items = parseDriveIvd(await r.text());
    if (items && items.length) return items.filter((x) => x.mime === FOLDER_MIME).map(({ id, name }) => ({ id, name })).sort(byName);
  } catch {}
  // Cách 3: đọc từ giao diện (cuộn hết danh sách để tải đủ)
  return withLock(accId, async () => {
    const win = await hidden(acc, url + '?hl=en');
    try {
      await waitFor(win, `document.querySelector('[data-id]')`, 30000);
      await sleep(1200);
      await evalJS(win, `(async()=>{const m=document.querySelector('[role="main"] [role="grid"],[role="main"]');for(let i=0;i<20;i++){m.scrollTop=m.scrollHeight;await new Promise(r=>setTimeout(r,250))}})()`);
      const list = await evalJS(win, `(() => {
        const out = [], seen = new Set();
        document.querySelectorAll('[data-id]').forEach((el) => {
          const id = el.getAttribute('data-id');
          if (!id || id.length < 10 || seen.has(id)) return;
          const html = el.outerHTML.slice(0, 6000);
          if (!/folder|thư mục/i.test(html)) return;
          const name = (el.innerText || '').split('\\n').map((s) => s.trim()).filter(Boolean)[0];
          if (name) { seen.add(id); out.push({ id, name }); }
        });
        return out;
      })()`);
      return (list || []).sort(byName);
    } finally { if (!win.isDestroyed()) win.destroy(); }
  });
}

async function createFolder(accId, parentId, name) {
  name = String(name || '').trim();
  if (!name) throw new Error('Tên thư mục trống');
  try {
    const d = await pageCall(accId, 'POST', `${API}?supportsTeamDrives=true&fields=id,title`, {
      title: name, mimeType: FOLDER_MIME, parents: [{ id: parentId || 'root' }],
    });
    return { id: d.id, name: d.title || name };
  } catch (e) {
    if (/hết hạn/.test(e.message)) throw e;
    // Dự phòng: mở thư mục cha trong trang Drive ẩn và tạo bằng giao diện Drive
    const google = require('./google');
    const acc = store.account(accId);
    const win = await hidden(acc, parentId ? `https://drive.google.com/drive/folders/${parentId}` : 'https://drive.google.com/drive/my-drive');
    try {
      await waitFor(win, `document.querySelector('[role="main"]')`, 30000);
      await sleep(1500);
      await google.newFolderVisible(win.webContents, name);
      await sleep(2500);
    } finally { if (!win.isDestroyed()) win.destroy(); }
    const list = await listFolders(accId, parentId);
    return list.find((f) => f.name === name) || { id: '', name };
  }
}

module.exports = { listFolders, createFolder, close, parseDriveIvd, decodeJsString };

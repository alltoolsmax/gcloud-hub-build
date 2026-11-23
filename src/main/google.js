// Thao tác ngầm trên dịch vụ Google qua phiên trình duyệt (không dùng API):
//  - Đọc thư chưa đọc (Gmail Atom feed)
//  - Đọc dung lượng Drive/Gmail/Photos (trang Google One / Drive Storage)
//  - Gửi thư (cửa sổ soạn thư Gmail ẩn)
//  - Tải tệp lên Drive (cửa sổ Drive ẩn + kéo-thả mô phỏng qua DevTools Protocol)
const fs = require('fs');
const store = require('./store');
const { getSession, hidden, evalJS, waitFor, sleep, isLoginPage, withLock } = require('./browser');

const UNITS = { B: 1, BYTES: 1, KB: 1024, MB: 1024 ** 2, GB: 1024 ** 3, TB: 1024 ** 4, PB: 1024 ** 5 };
function toBytes(num, unit) {
  const n = parseFloat(String(num).replace(/,/g, '.').replace(/\.(?=.*\.)/g, ''));
  return Math.round(n * (UNITS[String(unit).toUpperCase()] || 1));
}

function decode(s = '') {
  return s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&');
}

// ---------------- Thư chưa đọc ----------------
async function inbox(accId) {
  const acc = store.account(accId);
  if (acc.provider !== 'google') return { supported: false, unread: null, entries: [] };
  const ses = getSession(acc);
  const r = await ses.fetch('https://mail.google.com/mail/u/0/feed/atom', { credentials: 'include', redirect: 'manual' });
  if (r.status === 401 || r.status >= 300) {
    return { supported: true, expired: true, unread: null, entries: [] };
  }
  const xml = await r.text();
  if (!xml.includes('<feed')) return { supported: true, expired: true, unread: null, entries: [] };
  const unread = +(xml.match(/<fullcount>(\d+)<\/fullcount>/)?.[1] || 0);
  const entries = [...xml.matchAll(/<entry>([\s\S]*?)<\/entry>/g)].map(([, e]) => {
    const g = (tag) => decode(e.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`))?.[1] || '');
    const link = decode(e.match(/<link[^>]*href="([^"]+)"/)?.[1] || '').replace(/^http:/, 'https:');
    return {
      accId,
      title: g('title') || '(Không có tiêu đề)',
      summary: g('summary'),
      date: +new Date(g('modified') || g('issued')),
      fromName: decode(e.match(/<author>\s*<name>([\s\S]*?)<\/name>/)?.[1] || ''),
      fromEmail: decode(e.match(/<author>[\s\S]*?<email>([\s\S]*?)<\/email>/)?.[1] || ''),
      link,
    };
  });
  const st = (store.get().stats[accId] ||= {});
  Object.assign(st, { unread, entries, inboxAt: Date.now() });
  store.save();
  return { supported: true, unread, entries };
}

// ---------------- Dung lượng ----------------
function parseStorage(text) {
  const out = { used: null, total: null, drive: null, gmail: null, photos: null };
  const t = text.replace(/ /g, ' ');
  let m = t.match(/([\d.,]+)\s*(bytes|KB|MB|GB|TB)\s+of\s+([\d.,]+)\s*(KB|MB|GB|TB|PB)\s+used/i);
  if (m) { out.used = toBytes(m[1], m[2]); out.total = toBytes(m[3], m[4]); }
  else {
    m = t.match(/([\d.,]+)\s*(bytes|KB|MB|GB|TB)\s+used/i);
    if (m) out.used = toBytes(m[1], m[2]);
  }
  const part = (label) => {
    const r = t.match(new RegExp(label + '[^\\d\\n]{0,20}\\n?\\s*([\\d.,]+)\\s*(bytes|KB|MB|GB|TB)', 'i'));
    return r ? toBytes(r[1], r[2]) : null;
  };
  out.drive = part('Google Drive') ?? part('\\bDrive\\b');
  out.gmail = part('Gmail');
  out.photos = part('Google Photos') ?? part('\\bPhotos\\b');
  return out;
}

async function storage(accId) {
  const acc = store.account(accId);
  if (acc.provider !== 'google') return null;
  return withLock(accId, async () => {
    const pages = ['https://one.google.com/storage?hl=en', 'https://drive.google.com/settings/storage?hl=en'];
    let result = null;
    for (const url of pages) {
      const win = await hidden(acc, url);
      try {
        await waitFor(win, `/\\b(of|used)\\b/i.test(document.body?.innerText||'') && /\\d\\s*(GB|MB|KB|TB)/.test(document.body.innerText)`, 25000);
        await sleep(1500);
        if (isLoginPage(win)) throw new Error('Phiên đăng nhập đã hết hạn — hãy đăng nhập lại tài khoản ' + acc.email);
        const text = (await evalJS(win, 'document.body.innerText')) || '';
        const s = parseStorage(text);
        if (s.used != null) {
          result = { ...(result || {}), ...Object.fromEntries(Object.entries(s).filter(([, v]) => v != null)) };
          if (result.total && (result.drive != null || result.gmail != null)) break;
        }
      } finally { if (!win.isDestroyed()) win.destroy(); }
    }
    if (!result) throw new Error('Không đọc được dung lượng của ' + acc.email);
    const st = (store.get().stats[accId] ||= {});
    st.storage = result; st.storageAt = Date.now();
    store.save();
    return result;
  });
}

// ---------------- Gửi thư ----------------
function attachViaInput(win, selector, files) {
  const dbg = win.webContents.debugger;
  return (async () => {
    if (!dbg.isAttached()) dbg.attach('1.3');
    const { root } = await dbg.sendCommand('DOM.getDocument', { depth: -1, pierce: true });
    const { nodeIds } = await dbg.sendCommand('DOM.querySelectorAll', { nodeId: root.nodeId, selector });
    if (!nodeIds.length) return false;
    await dbg.sendCommand('DOM.setFileInputFiles', { nodeId: nodeIds[nodeIds.length - 1], files });
    return true;
  })();
}

async function dropFiles(win, files, x, y) {
  const dbg = win.webContents.debugger;
  if (!dbg.isAttached()) dbg.attach('1.3');
  const data = { items: [], files, dragOperationsMask: 1 };
  for (const type of ['dragEnter', 'dragOver', 'drop']) {
    await dbg.sendCommand('Input.dispatchDragEvent', { type, x, y, data });
    await sleep(120);
  }
}

const CLICK = (sel) => `(()=>{const el=document.querySelector(${JSON.stringify(sel)});if(!el)return false;
  for(const t of ['mousedown','mouseup','click'])el.dispatchEvent(new MouseEvent(t,{bubbles:true,cancelable:true,view:window}));return true})()`;

async function sendGmail(acc, { to, cc, bcc, subject, body, attachments = [] }) {
  const q = new URLSearchParams({ view: 'cm', fs: '1', tf: '1', hl: 'en', to: to || '', su: subject || '' });
  if (cc) q.set('cc', cc);
  if (bcc) q.set('bcc', bcc);
  const win = await hidden(acc, 'https://mail.google.com/mail/u/0/?' + q);
  try {
    const box = 'div[role="textbox"][contenteditable="true"]';
    const ok = await waitFor(win, `document.querySelector('${box}')`, 40000);
    if (isLoginPage(win)) throw new Error('Phiên đăng nhập đã hết hạn — hãy đăng nhập lại ' + acc.email);
    if (!ok) throw new Error('Không mở được khung soạn thư Gmail');
    await sleep(800);
    await evalJS(win, `(()=>{const b=document.querySelector('${box}');b.focus();
      document.execCommand('insertText',false,${JSON.stringify(body || '')});return true})()`);
    if (attachments.length) {
      const attached = await attachViaInput(win, 'input[type=file][name="Filedata"]', attachments).catch(() => false);
      if (!attached) {
        const rect = await evalJS(win, `(()=>{const r=document.querySelector('${box}').getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+Math.min(r.height/2,120)}})()`);
        await dropFiles(win, attachments, rect.x, rect.y);
      }
      const totalSize = attachments.reduce((s, p) => s + (fs.statSync(p).size || 0), 0);
      await sleep(2500);
      // chờ thanh tiến trình tải tệp đính kèm biến mất
      await waitFor(win, `!document.querySelector('[role="progressbar"]') && !/Attaching|Uploading/i.test(document.body.innerText)`, Math.min(15 * 60000, 20000 + totalSize / 200)); // ~200KB/s tối thiểu
    }
    const clicked = await evalJS(win, CLICK('div[role="button"][data-tooltip*="Enter"]'));
    if (!clicked) {
      win.webContents.focus();
      win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Enter', modifiers: ['control'] });
      win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Enter', modifiers: ['control'] });
    }
    const sent = await waitFor(win, `!document.querySelector('${box}') || /Message sent|Sending/i.test(document.body.innerText)`, 30000);
    if (!sent) throw new Error('Gmail không xác nhận đã gửi — kiểm tra địa chỉ người nhận');
    await sleep(2500); // để Gmail hoàn tất gửi trước khi đóng
    return true;
  } finally { if (!win.isDestroyed()) win.destroy(); }
}

async function sendOutlook(acc, { to, cc, subject, body }) {
  const base = acc.mailUrl?.includes('live.com') ? 'https://outlook.live.com' : 'https://outlook.office.com';
  const q = new URLSearchParams({ to: to || '', subject: subject || '', body: body || '' });
  if (cc) q.set('cc', cc);
  const win = await hidden(acc, `${base}/mail/deeplink/compose?${q}`);
  try {
    const ok = await waitFor(win, `document.querySelector('button[aria-label="Send"],button[title^="Send"],button[aria-label="Gửi"],button[title^="Gửi"]')`, 45000);
    if (isLoginPage(win)) throw new Error('Phiên đăng nhập đã hết hạn — hãy đăng nhập lại ' + acc.email);
    if (!ok) throw new Error('Không mở được khung soạn thư Outlook');
    await sleep(1200);
    await evalJS(win, CLICK('button[aria-label="Send"],button[title^="Send"],button[aria-label="Gửi"],button[title^="Gửi"]'));
    await sleep(4000);
    return true;
  } finally { if (!win.isDestroyed()) win.destroy(); }
}

function send(accId, msg) {
  const acc = store.account(accId);
  return withLock(accId, () => {
    if (acc.provider === 'google') return sendGmail(acc, msg);
    if (acc.provider === 'microsoft') {
      if (msg.attachments?.length) throw new Error('Gửi kèm tệp từ khung soạn nhanh hiện chỉ hỗ trợ Gmail. Hãy dùng giao diện Outlook trong tab Thư.');
      return sendOutlook(acc, msg);
    }
    throw new Error('Soạn thư nhanh chưa hỗ trợ loại tài khoản này — hãy dùng giao diện webmail trong tab Thư');
  });
}

// ---------------- Tải lên Drive ----------------
function driveFolderUrl(folder) {
  if (!folder) return 'https://drive.google.com/drive/u/0/my-drive?hl=en';
  const id = folder.match(/folders\/([\w-]+)/)?.[1] || (/^[\w-]{10,}$/.test(folder) ? folder : null);
  return id ? `https://drive.google.com/drive/u/0/folders/${id}?hl=en` : 'https://drive.google.com/drive/u/0/my-drive?hl=en';
}

function uploadToDrive(accId, files, folder, onProgress = () => {}, sig = null) {
  const acc = store.account(accId);
  if (acc.provider !== 'google') throw new Error('Chỉ hỗ trợ tải lên Google Drive');
  return withLock(accId, async () => {
    const ses = getSession(acc);
    const win = await hidden(acc, driveFolderUrl(folder));
    let started = 0, done = 0;
    const want = files.length;
    ses.webRequest.onCompleted({ urls: ['https://*.google.com/*', 'https://*.googleapis.com/*'] }, (d) => {
      if (!/\/upload\//.test(d.url) || d.method === 'OPTIONS') return;
      if (!/upload_id=/.test(d.url)) { if (d.statusCode === 200) started++; return; }
      if (d.statusCode === 200 || d.statusCode === 201) { done++; onProgress({ done, total: want }); }
    });
    try {
      const ok = await waitFor(win, `document.querySelector('[role="main"]') && document.querySelector('[guidedhelpid="new_menu_button"],button[aria-label="New"]')`, 45000);
      if (isLoginPage(win)) throw new Error('Phiên đăng nhập đã hết hạn — hãy đăng nhập lại ' + acc.email);
      if (!ok) throw new Error('Không mở được Google Drive của ' + acc.email);
      await sleep(2000);

      // Cách 1: kéo-thả tệp vào khu vực chính của Drive
      const r = await evalJS(win, `(()=>{const m=document.querySelector('[role="main"]').getBoundingClientRect();return {x:m.x+m.width/2,y:m.y+m.height/2}})()`);
      await dropFiles(win, files, r.x, r.y);
      for (let i = 0; i < 20 && !started; i++) await sleep(400);

      // Cách 2: Mới → Tải tệp lên, chặn hộp thoại chọn tệp và gán tệp trực tiếp
      if (!started) {
        const dbg = win.webContents.debugger;
        await dbg.sendCommand('Page.enable');
        await dbg.sendCommand('Page.setInterceptFileChooserDialog', { enabled: true });
        const chooser = new Promise((res) => dbg.once('message', function h(e, method, params) {
          if (method === 'Page.fileChooserOpened') res(params); else dbg.once('message', h);
        }));
        await evalJS(win, CLICK('[guidedhelpid="new_menu_button"],button[aria-label="New"]'));
        await sleep(900);
        await evalJS(win, `(()=>{const el=[...document.querySelectorAll('[role="menuitem"]')].find(e=>/^\\s*File upload/i.test(e.innerText));
          if(!el)return false;for(const t of ['mousedown','mouseup','click'])el.dispatchEvent(new MouseEvent(t,{bubbles:true}));return true})()`);
        const params = await Promise.race([chooser, sleep(8000).then(() => null)]);
        if (!params) throw new Error('Không thể kích hoạt tải lên trên Drive (giao diện Drive có thể đã thay đổi)');
        await dbg.sendCommand('DOM.setFileInputFiles', { files, backendNodeId: params.backendNodeId });
      }

      const totalSize = files.reduce((s, p) => s + (fs.statSync(p).size || 0), 0);
      const limit = Date.now() + 60000 + totalSize / 150; // tối thiểu ~150KB/s
      while (done < want && Date.now() < limit) {
        if (sig?.aborted) throw new Error('Đã dừng theo yêu cầu');
        await sleep(700);
      }
      if (done < want) throw new Error(`Chỉ xác nhận được ${done}/${want} tệp đã tải lên ${acc.email}`);
      await sleep(1500);
      return { done };
    } finally {
      ses.webRequest.onCompleted(null);
      if (!win.isDestroyed()) win.destroy();
    }
  });
}

// ---------------- Tải ảnh lên Google Photos ----------------
function uploadToPhotos(accId, files, onProgress = () => {}) {
  const acc = store.account(accId);
  if (acc.provider !== 'google') throw new Error('Chỉ hỗ trợ tài khoản Google');
  return withLock(accId, async () => {
    const ses = getSession(acc);
    const win = await hidden(acc, 'https://photos.google.com/?hl=en');
    let started = 0, done = 0;
    const want = files.length;
    ses.webRequest.onCompleted({ urls: ['https://*.google.com/*', 'https://*.googleapis.com/*'] }, (d) => {
      if (!/\/upload/.test(d.url) || d.method === 'OPTIONS') return;
      if (!/upload_id=/.test(d.url)) { if (d.statusCode === 200) started++; return; }
      if (d.statusCode === 200 || d.statusCode === 201) { done++; onProgress({ done, total: want }); }
    });
    try {
      const ok = await waitFor(win, `document.querySelector('[role="main"]') || document.querySelector('c-wiz [jsname]')`, 45000);
      if (isLoginPage(win)) throw new Error('Phiên đăng nhập đã hết hạn — hãy đăng nhập lại ' + acc.email);
      if (!ok) throw new Error('Không mở được Google Photos của ' + acc.email);
      await sleep(2500);
      // Cách 1: kéo-thả vào trang Photos
      const r = await evalJS(win, `(()=>{const m=document.querySelector('[role="main"]')||document.body;const b=m.getBoundingClientRect();return {x:b.x+b.width/2,y:b.y+Math.max(200,b.height/2)}})()`);
      await dropFiles(win, files, r.x, r.y);
      for (let i = 0; i < 20 && !started; i++) await sleep(400);
      // Cách 2: bấm nút Upload và gán tệp vào hộp thoại chọn tệp
      if (!started) {
        const dbg = win.webContents.debugger;
        await dbg.sendCommand('Page.enable');
        await dbg.sendCommand('Page.setInterceptFileChooserDialog', { enabled: true });
        const chooser = new Promise((res) => dbg.once('message', function h(e, method, params) {
          if (method === 'Page.fileChooserOpened') res(params); else dbg.once('message', h);
        }));
        await evalJS(win, `(()=>{const el=[...document.querySelectorAll('button,[role=button]')].find(e=>/^upload/i.test((e.getAttribute('aria-label')||e.innerText||'').trim()));
          if(!el)return false;for(const t of ['mousedown','mouseup','click'])el.dispatchEvent(new MouseEvent(t,{bubbles:true}));return true})()`);
        await sleep(900);
        await evalJS(win, `(()=>{const el=[...document.querySelectorAll('[role=menuitem]')].find(e=>/computer|device/i.test(e.innerText));
          if(el)for(const t of ['mousedown','mouseup','click'])el.dispatchEvent(new MouseEvent(t,{bubbles:true}));return !!el})()`);
        const params = await Promise.race([chooser, sleep(8000).then(() => null)]);
        if (!params) throw new Error('Không kích hoạt được tải lên Google Photos (giao diện Photos có thể đã thay đổi)');
        await dbg.sendCommand('DOM.setFileInputFiles', { files, backendNodeId: params.backendNodeId });
      }
      const totalSize = files.reduce((t, p) => t + (fs.statSync(p).size || 0), 0);
      const limit = Date.now() + 60000 + totalSize / 150;
      while (done < want && Date.now() < limit) await sleep(700);
      if (done < want) throw new Error(`Chỉ xác nhận được ${done}/${want} tệp đã tải lên Google Photos`);
      await sleep(4000); // để Photos tạo mục ảnh trong thư viện
      return { done };
    } finally {
      ses.webRequest.onCompleted(null);
      if (!win.isDestroyed()) win.destroy();
    }
  });
}

// ---------------- Thao tác trên khung Drive đang hiển thị ----------------
const MENU_RE = {
  file: '^\\s*(File upload|Tải tệp lên|Tải lên tệp)',
  folder: '^\\s*(Folder upload|Tải thư mục lên|Tải lên thư mục)',
  newfolder: '^\\s*(New folder|Thư mục mới)',
};
async function clickNewMenu(wc, kind) {
  const js = (c) => wc.executeJavaScript(c, true).catch(() => null);
  await js(`(()=>{const b=document.querySelector('[guidedhelpid="new_menu_button"]')||[...document.querySelectorAll('button')].find(e=>/^(New|Mới)$/.test((e.innerText||'').trim()));
    if(!b)return false;for(const t of ['mousedown','mouseup','click'])b.dispatchEvent(new MouseEvent(t,{bubbles:true,view:window}));return true})()`);
  await sleep(700);
  return js(`(()=>{const re=new RegExp(${JSON.stringify(MENU_RE[kind])},'i');const el=[...document.querySelectorAll('[role="menuitem"]')].find(e=>re.test(e.innerText));
    if(!el)return false;for(const t of ['mousedown','mouseup','click'])el.dispatchEvent(new MouseEvent(t,{bubbles:true,view:window}));return true})()`);
}

// Tải tệp / thư mục lên thư mục Drive đang mở trong khung hiển thị
function uploadVisible(accId, wc, paths, kind = 'file', onProgress = () => {}) {
  const acc = store.account(accId);
  return withLock(accId, async () => {
    const ses = getSession(acc);
    let started = 0, done = 0;
    ses.webRequest.onCompleted({ urls: ['<all_urls>'] }, (d) => {
      if (!/\/upload\//.test(d.url) || d.method === 'OPTIONS') return;
      if (!/upload_id=/.test(d.url)) { if (d.statusCode === 200) started++; return; }
      if (d.statusCode === 200 || d.statusCode === 201) { done++; onProgress({ done }); }
    });
    const dbg = wc.debugger;
    let attachedHere = false;
    try {
      if (!dbg.isAttached()) { dbg.attach('1.3'); attachedHere = true; }
      // Cách 1: mở hộp chọn tệp của Drive nhưng tự gán tệp (không hiện hộp thoại)
      await dbg.sendCommand('Page.enable');
      await dbg.sendCommand('Page.setInterceptFileChooserDialog', { enabled: true });
      const chooser = new Promise((res) => dbg.once('message', function h(e, method, params) {
        if (method === 'Page.fileChooserOpened') res(params); else dbg.once('message', h);
      }));
      const clicked = await clickNewMenu(wc, kind);
      const params = clicked ? await Promise.race([chooser, sleep(6000).then(() => null)]) : null;
      if (params) {
        await dbg.sendCommand('DOM.setFileInputFiles', { files: paths, backendNodeId: params.backendNodeId });
      } else {
        // Cách 2: kéo-thả vào danh sách tệp
        await wc.executeJavaScript(`document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))`).catch(() => {});
        const r = await wc.executeJavaScript(`(()=>{const m=document.querySelector('[role="main"]')||document.body;const b=m.getBoundingClientRect();return {x:b.x+b.width/2,y:b.y+b.height/2}})()`);
        const data = { items: [], files: paths, dragOperationsMask: 1 };
        for (const type of ['dragEnter', 'dragOver', 'drop']) { await dbg.sendCommand('Input.dispatchDragEvent', { type, x: r.x, y: r.y, data }); await sleep(120); }
      }
      await dbg.sendCommand('Page.setInterceptFileChooserDialog', { enabled: false }).catch(() => {});
      for (let i = 0; i < 30 && !started && !done; i++) await sleep(400);
      if (!started && !done) throw new Error('Drive chưa bắt đầu tải lên — hãy mở một thư mục trong Drive rồi thử lại');
      // chờ hết lượt tải (không còn tiến triển trong 15 giây)
      let last = -1, idle = 0;
      while (idle < 15) { await sleep(1000); if (done === last) idle++; else { idle = 0; last = done; } }
      return { done };
    } finally {
      ses.webRequest.onCompleted(null);
      if (attachedHere && dbg.isAttached()) try { dbg.detach(); } catch {}
    }
  });
}

// Tải thư mục lên: mở hộp chọn thư mục của Windows ngay trong Drive (giữ nguyên cấu trúc thư mục con)
async function folderUploadVisible(wc, { testIntercept = false } = {}) {
  let got = null;
  if (testIntercept) {
    const dbg = wc.debugger;
    if (!dbg.isAttached()) dbg.attach('1.3');
    await dbg.sendCommand('Page.enable');
    await dbg.sendCommand('Page.setInterceptFileChooserDialog', { enabled: true });
    got = new Promise((res) => dbg.once('message', function h(e, m, p) { if (m === 'Page.fileChooserOpened') res(p); else dbg.once('message', h); }));
  }
  const ok = await clickNewMenu(wc, 'folder');
  if (!ok) throw new Error('Không tìm thấy chức năng tải thư mục của Drive — hãy mở Drive của tôi rồi thử lại');
  if (testIntercept) { const p = await Promise.race([got, sleep(5000).then(() => null)]); wc.debugger.detach(); return p; }
  return true;
}

// Tải các mục đang chọn trong Drive về máy (thư mục / nhiều mục: Drive tự nén .zip)
async function downloadSelectedVisible(wc) {
  const js = (c) => wc.executeJavaScript(c, true).catch(() => null);
  const n = await js(`document.querySelectorAll('[role="main"] [aria-selected="true"]').length`);
  if (!n) throw new Error('Hãy chọn (bấm vào) tệp hoặc thư mục trong Drive trước, giữ Ctrl để chọn nhiều mục');
  const CLICK = `for(const t of ['mousedown','mouseup','click'])el.dispatchEvent(new MouseEvent(t,{bubbles:true,view:window}));return true`;
  // 1) Nút "Tải xuống" trên thanh thao tác của Drive khi có mục được chọn
  let ok = await js(`(()=>{const el=[...document.querySelectorAll('[role="button"],button')].find(e=>/^(Download|Tải xuống)$/i.test((e.getAttribute('aria-label')||'').trim())&&e.offsetParent);if(!el)return false;${CLICK}})()`);
  if (ok) return { count: n };
  // 2) Menu chuột phải → Tải xuống
  await js(`(()=>{const el=document.querySelector('[role="main"] [aria-selected="true"]');const r=el.getBoundingClientRect();
    el.dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true,view:window,clientX:r.x+20,clientY:r.y+10,button:2}));return true})()`);
  for (let i = 0; i < 10 && !ok; i++) {
    await sleep(250);
    ok = await js(`(()=>{const el=[...document.querySelectorAll('[role="menuitem"]')].find(e=>/^\\s*(Download|Tải xuống)/i.test(e.innerText)&&e.offsetParent);if(!el)return false;${CLICK}})()`);
  }
  if (!ok) throw new Error('Không tìm thấy lệnh Tải xuống của Drive cho mục đã chọn');
  return { count: n };
}

// Đưa từng mục đang chọn vào hàng chờ: chọn lần lượt từng mục rồi tải xuống riêng
async function downloadEachSelected(wc) {
  const js = (c) => wc.executeJavaScript(c, true).catch(() => null);
  const ids = await js(`[...document.querySelectorAll('[role="main"] [aria-selected="true"]')]
    .map((e) => e.getAttribute('data-id') || e.closest('[data-id]')?.getAttribute('data-id')).filter(Boolean)`) || [];
  const uniq = [...new Set(ids)];
  if (uniq.length <= 1) return downloadSelectedVisible(wc);
  for (const id of uniq) {
    await js(`(()=>{const el=document.querySelector('[role="main"] [data-id="${id.replace(/"/g, '')}"]');if(!el)return false;
      for(const t of ['mousedown','mouseup','click'])el.dispatchEvent(new MouseEvent(t,{bubbles:true,view:window}));return true})()`);
    await sleep(500);
    try { await downloadSelectedVisible(wc); } catch {}
    await sleep(1200);
  }
  return { count: uniq.length, each: true };
}

// Tải các thư mục nguồn (theo id) vào hàng chờ chuyển: dùng MỘT cửa sổ ẩn, đi tới từng thư mục cha,
// chọn thư mục rồi tải xuống; CHỜ tải xong hẳn mới đóng cửa sổ (không hủy giữa chừng → không gây lỗi "Object destroyed").
// Người gọi phải bật transfer.setCapture(accId) trước để tệp tải về được đưa vào hàng chờ.
async function queueFolders(accId, items, sig = null) {
  const acc = store.account(accId);
  if (acc.provider !== 'google') throw new Error('Chỉ hỗ trợ Google Drive');
  const transfer = require('./transfer');
  const before = transfer.state().downloading;
  const win = await hidden(acc, 'https://drive.google.com/drive/my-drive?hl=en');
  let started = 0;
  const errors = [];
  try {
    for (const it of items) {
      if (sig?.aborted) break;
      const url = it.parentId
        ? `https://drive.google.com/drive/folders/${encodeURIComponent(it.parentId)}?hl=en`
        : 'https://drive.google.com/drive/my-drive?hl=en';
      try { await win.loadURL(url); } catch {}
      const ok = await waitFor(win, `document.querySelector('[data-id]')`, 30000);
      if (isLoginPage(win)) throw new Error('Phiên đăng nhập đã hết hạn — hãy đăng nhập lại ' + acc.email);
      if (!ok) { errors.push(it.name); continue; }
      await sleep(1500);
      const safe = String(it.id).replace(/"/g, '');
      const picked = await evalJS(win, `(()=>{const el=document.querySelector('[role="main"] [data-id="${safe}"]')||document.querySelector('[data-id="${safe}"]');
        if(!el)return false;for(const t of ['mousedown','mouseup','click'])el.dispatchEvent(new MouseEvent(t,{bubbles:true,view:window}));return true})()`);
      if (!picked) { errors.push(it.name); continue; }
      await sleep(500);
      try { await downloadSelectedVisible(win.webContents); started++; } catch (e) { errors.push(it.name); }
      await sleep(2000);
    }
    // CHỜ mọi tệp đang tải (do thao tác này tạo ra) hoàn tất trước khi đóng cửa sổ
    const end = Date.now() + 30 * 60000;
    while (!win.isDestroyed() && Date.now() < end) {
      if (sig?.aborted) break;
      const d = transfer.state().downloading;
      if (d <= before) break;
      await sleep(1000);
    }
  } finally {
    if (!win.isDestroyed()) win.destroy();
  }
  return { started, errors };
}

// Tạo thư mục mới trong thư mục Drive đang mở
async function newFolderVisible(wc, name) {
  const js = (c) => wc.executeJavaScript(c, true).catch(() => null);
  wc.focus();
  wc.sendInputEvent({ type: 'keyDown', keyCode: 'F', modifiers: ['shift'] });
  wc.sendInputEvent({ type: 'char', keyCode: 'F', modifiers: ['shift'] });
  wc.sendInputEvent({ type: 'keyUp', keyCode: 'F', modifiers: ['shift'] });
  const dialogInput = `document.querySelector('[role="dialog"] input[type="text"], [role="dialog"] input:not([type])')`;
  let ok = false;
  for (let i = 0; i < 10 && !ok; i++) { await sleep(300); ok = await js(`!!${dialogInput}`); }
  if (!ok) {
    await clickNewMenu(wc, 'newfolder');
    for (let i = 0; i < 15 && !ok; i++) { await sleep(300); ok = await js(`!!${dialogInput}`); }
  }
  if (!ok) throw new Error('Không mở được hộp tạo thư mục của Drive');
  await js(`(()=>{const i=${dialogInput};i.focus();i.select();document.execCommand('insertText',false,${JSON.stringify(name)});return true})()`);
  await sleep(250);
  const clicked = await js(`(()=>{const d=document.querySelector('[role="dialog"]');const b=[...d.querySelectorAll('button')].find(e=>/^(Create|Tạo)$/i.test(e.innerText.trim()));
    if(!b)return false;b.click();return true})()`);
  if (!clicked) { wc.sendInputEvent({ type: 'keyDown', keyCode: 'Enter' }); wc.sendInputEvent({ type: 'keyUp', keyCode: 'Enter' }); }
  return true;
}

module.exports = { queueFolders, downloadEachSelected, downloadSelectedVisible, folderUploadVisible, uploadVisible, newFolderVisible, uploadToPhotos, inbox, storage, send, uploadToDrive, parseStorage, driveFolderUrl };

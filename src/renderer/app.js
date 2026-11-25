/* global hub, Chart, icon, hydrateIcons */
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = (s = '') => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const S = {
  view: 'dashboard',
  accounts: [],
  stats: {},
  settings: {},
  ua: '',
  sel: { mail: 'all', mailWeb: null, drive: null, gemini: null, search: '', syncSrc: null },
  queue: [],
  jobs: [],
  charts: [],
  seen: new Set(),
  busy: 0,
};

const COLORS = { drive: '#5b8cff', gmail: '#ef4444', photos: '#f59e0b', other: '#a855f7', free: 'rgba(127,140,180,0.22)' };
const URLS = {
  drive: 'https://drive.google.com/drive/u/0/my-drive',
  gemini: 'https://gemini.google.com/app',
  photos: 'https://photos.google.com/',
  search: 'https://www.google.com/?hl=vi',
};

// ---------------- Tiện ích ----------------
function fmtBytes(b) {
  if (b == null || isNaN(b)) return '—';
  const u = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
  let i = 0;
  while (b >= 1024 && i < u.length - 1) { b /= 1024; i++; }
  return `${b >= 100 || i === 0 ? Math.round(b) : b.toFixed(b >= 10 ? 1 : 2)} ${u[i]}`;
}
const rtf = new Intl.RelativeTimeFormat('vi', { numeric: 'auto' });
function ago(t) {
  if (!t) return '';
  const s = (t - Date.now()) / 1000;
  const a = Math.abs(s);
  if (a < 60) return 'vừa xong';
  if (a < 3600) return rtf.format(Math.round(s / 60), 'minute');
  if (a < 86400) return rtf.format(Math.round(s / 3600), 'hour');
  if (a < 86400 * 7) return rtf.format(Math.round(s / 86400), 'day');
  return new Date(t).toLocaleDateString('vi-VN');
}
function initials(a) {
  const n = (a.name || a.email || '?').replace(/@.*/, '').trim();
  const p = n.split(/[\s._-]+/).filter(Boolean);
  return ((p[0]?.[0] || '?') + (p[1]?.[0] || '')).toUpperCase();
}
function avatar(a, size = '') {
  const prov = a.provider === 'google' ? 'g' : a.provider === 'microsoft' ? 'ms' : 'globe';
  return `<div class="avatar ${size}" style="background:${a.color}">${esc(initials(a))}<span class="pbadge">${icon(prov)}</span></div>`;
}
const google = () => S.accounts.filter((a) => a.provider === 'google');
const acc = (id) => S.accounts.find((a) => a.id === id);

function toast(msg, type = 'info', { sticky = false } = {}) {
  const el = document.createElement('div');
  el.className = 'toast ' + (type === 'ok' ? 'ok' : type === 'err' ? 'err' : '');
  const render = (m, t) => {
    el.className = 'toast ' + (t === 'ok' ? 'ok' : t === 'err' ? 'err' : '');
    el.innerHTML = (t === 'busy' ? '<span class="spinner"></span>' : '') + `<div>${m}</div>`;
  };
  render(msg, type);
  $('#toasts').appendChild(el);
  let timer;
  const close = (ms = 0) => { clearTimeout(timer); timer = setTimeout(() => el.remove(), ms); };
  if (!sticky && type !== 'busy') close(type === 'err' ? 7000 : 3500);
  return { update: (m, t = 'info') => { render(m, t); if (t !== 'busy') close(t === 'err' ? 7000 : 3500); }, close };
}

function bg(delta, text) {
  S.busy += delta;
  $('#bgStatus').innerHTML = S.busy > 0 ? `<span class="spinner"></span>${esc(text || 'Đang đồng bộ dữ liệu…')}` : '';
}

async function call(ch, ...args) { return hub.call(ch, ...args); }

// ---------------- Webview ----------------
function ensureWeb(stackId, account, url, key) {
  const stack = $('#' + stackId);
  key ||= account ? account.id : 'anon';
  stack.querySelector('.placeholder')?.remove();
  let wv = stack.querySelector(`webview[data-key="${key}"]`);
  if (!wv) {
    wv = document.createElement('webview');
    wv.dataset.key = key;
    wv.dataset.home = url;
    wv.setAttribute('partition', account ? account.partition : 'persist:search');
    wv.setAttribute('useragent', (account && account.ua) || S.ua);   // nhận dạng đã ghim của đúng tài khoản
    wv.setAttribute('allowpopups', '');
    wv.setAttribute('src', url);
    const bar = stack.querySelector('.loading-bar') || stack.appendChild(Object.assign(document.createElement('div'), { className: 'loading-bar' }));
    const tools = $(`.web-tools[data-stack="${stackId}"] .title`);
    wv.addEventListener('did-start-loading', () => { if (wv.classList.contains('on')) { bar.style.width = '70%'; bar.style.opacity = 1; } });
    wv.addEventListener('did-stop-loading', () => { bar.style.width = '100%'; setTimeout(() => { bar.style.opacity = 0; bar.style.width = 0; }, 300); });
    wv.addEventListener('page-title-updated', (e) => { if (wv.classList.contains('on') && tools) tools.textContent = e.title; });
    stack.appendChild(wv);
  }
  stack.querySelectorAll('webview').forEach((w) => w.classList.toggle('on', w === wv));
  const tools = $(`.web-tools[data-stack="${stackId}"] .title`);
  if (tools) { try { tools.textContent = wv.getTitle?.() || ''; } catch { tools.textContent = ''; } }
  return wv;
}

function placeholder(stackId, html) {
  const stack = $('#' + stackId);
  stack.querySelectorAll('webview').forEach((w) => w.classList.remove('on'));
  if (!stack.querySelector('.placeholder')) stack.insertAdjacentHTML('beforeend', `<div class="placeholder"><div>${html}</div></div>`);
  else stack.querySelector('.placeholder').innerHTML = `<div>${html}</div>`;
}

function dropWebviews(accId) {
  $$(`webview[data-key="${accId}"]`).forEach((w) => w.remove());
}

document.addEventListener('click', (e) => {
  const b = e.target.closest('.web-tools [data-act]');
  if (!b) return;
  const stackId = b.closest('.web-tools').dataset.stack;
  const wv = $(`#${stackId} webview.on`);
  if (!wv) return;
  const act = b.dataset.act;
  try {
    if (act === 'back' && wv.canGoBack()) wv.goBack();
    else if (act === 'forward' && wv.canGoForward()) wv.goForward();
    else if (act === 'reload') wv.reload();
    else if (act === 'home') wv.loadURL(wv.dataset.home);
    else if (act === 'external') call('shell:open', wv.getURL());
  } catch {}
});

// ---------------- Điều hướng ----------------
const TITLES = { account: 'Tài khoản', dashboard: 'Tổng quan', mail: 'Thư', drive: 'Google Drive', photos: 'Google Photos', sync: 'Đồng bộ Drive', gemini: 'AI Agent', search: 'Tìm kiếm mọi thứ', settings: 'Cài đặt' };
function go(view) {
  S.view = view;
  $$('#nav button').forEach((b) => b.classList.toggle('active', b.dataset.view === view));
  $$('.view').forEach((v) => v.classList.toggle('active', v.id === 'view-' + view));
  $('#pageTitle').textContent = TITLES[view];
  $('#dashRefresh').hidden = view !== 'dashboard';
  renderSidebar();
  ({ account: renderAccount, dashboard: renderDashboard, mail: renderMail, drive: renderDrive, photos: renderPhotos, sync: renderSync, gemini: renderGemini, search: renderSearch, settings: renderSettings })[view]();
  updateCapture();
}
$('#nav').addEventListener('click', (e) => { const b = e.target.closest('button[data-view]'); if (b) go(b.dataset.view); });

// ---------------- Sidebar ----------------
function renderSidebar() {
  $('#accCount').textContent = S.accounts.length || '';
  $('#sideAccounts').innerHTML = S.accounts.map((a) => {
    const u = S.stats[a.id]?.unread;
    return `<div class="side-acc ${S.view === 'account' && S.sel.account === a.id ? 'sel' : ''}" data-id="${a.id}" title="${esc(a.email)}">${avatar(a)}
      <div class="info"><b>${esc(a.name || a.email)}</b><small>${esc(a.email)}</small></div>
      <span class="badge" ${u ? '' : 'data-zero'}>${u > 99 ? '99+' : u || ''}</span></div>`;
  }).join('') || '<div class="muted small" style="padding:6px 12px">Chưa có tài khoản</div>';
  const total = S.accounts.reduce((s, a) => s + (S.stats[a.id]?.unread || 0), 0);
  const nb = $('#navUnread');
  nb.textContent = total ? (total > 999 ? '999+' : total) : '';
  total ? nb.removeAttribute('data-zero') : nb.setAttribute('data-zero', '');
}
$('#sideAccounts').addEventListener('click', (e) => {
  const el = e.target.closest('.side-acc');
  if (!el) return;
  S.sel.account = el.dataset.id;
  go('account');
});

// ---------------- Dữ liệu nền ----------------
async function refreshInbox(id, notify = true) {
  const a = acc(id);
  if (!a) return;
  const st = (S.stats[id] ||= {});
  try {
    if (a.mail?.configured) {
      const r = await call('mail:summary', id);
      st.expired = false; st.mailErr = null;
      st.unread = r.unread;
      st.entries = r.recent.map((m) => ({ accId: id, uid: m.uid, path: 'INBOX', title: m.subject, summary: '', date: m.date, fromName: m.from.name, fromEmail: m.from.address, link: `${id}|${m.uid}` }));
      if (notify && S.settings.notify !== false && 'Notification' in window) {
        for (const m of r.fresh.slice(0, 5)) {
          new Notification(`${m.from.name || m.from.address} → ${a.email}`, { body: m.subject }).onclick = () => { window.focus(); openEntry({ accId: id, uid: m.uid, path: 'INBOX' }); };
        }
      }
      return;
    }
    if (a.provider !== 'google') return;
    const r = await call('mail:inbox', id);
    if (r.temp) return;                     // lỗi tạm (mạng / Google bận): giữ nguyên trạng thái, không báo hết phiên
    st.expired = !!r.expired;
    if (!r.expired) { st.unread = r.unread; st.entries = r.entries; }
  } catch (err) { st.mailErr = err.message; console.warn(err); }
}

async function refreshStorage(id) {
  const a = acc(id);
  if (!a || a.provider !== 'google') return;
  bg(1, `Đang đọc dung lượng ${a.email}…`);
  try {
    const s = await call('drive:storage', id);
    (S.stats[id] ||= {}).storage = s;
    S.stats[id].storageAt = Date.now();
    S.stats[id].storageErr = null;
  } catch (err) {
    (S.stats[id] ||= {}).storageErr = err.message;
  } finally { bg(-1); }
}

async function refreshAll({ force = false } = {}) {
  const g = google();
  bg(1, 'Đang kiểm tra thư mới…');
  await Promise.all(S.accounts.map((a) => refreshInbox(a.id, false)));
  S.seenInit = true;
  bg(-1);
  rerender();
  for (const a of g) {
    const st = S.stats[a.id];
    if (force || !st?.storage || Date.now() - (st.storageAt || 0) > 6 * 3600e3) {
      await refreshStorage(a.id);
      rerender();
    }
  }
}

function rerender() {
  renderSidebar();
  if (S.view === 'dashboard') renderDashboard();
  if (S.view === 'account') renderAccount();
  if (S.view === 'mail') renderMailTree();
  if (S.view === 'drive') renderDriveStorage();
}

// ---------------- Tổng quan ----------------
function storageParts(s) {
  if (!s) return null;
  const used = s.used ?? 0;
  const known = (s.drive || 0) + (s.gmail || 0) + (s.photos || 0);
  const other = Math.max(0, used - known);
  const free = s.total ? Math.max(0, s.total - used) : 0;
  return { used, total: s.total, drive: s.drive || 0, gmail: s.gmail || 0, photos: s.photos || 0, other: known ? other : 0, onlyUsed: known ? 0 : used, free };
}

function renderDashboard() {
  S.charts.forEach((c) => c.destroy());
  S.charts = [];
  const root = $('#view-dashboard');
  if (!S.accounts.length) {
    root.innerHTML = `<div class="welcome"><div class="inner">
      <div class="big">${icon('cloud')}</div>
      <h2>Chào mừng đến GCloud Hub</h2>
      <p>Quản lý tất cả tài khoản Gmail, email doanh nghiệp, Google Drive và AI Agent trong một cửa sổ. Thêm tài khoản đầu tiên để bắt đầu.</p>
      <div class="feat"><div>${icon('mail')}Hộp thư hợp nhất</div><div>${icon('drive')}Nhiều Google Drive</div><div>${icon('sync')}Chuyển dữ liệu giữa Drive</div>
      <div>${icon('spark')}AI Agent tích hợp</div><div>${icon('search')}Tìm kiếm mọi thứ</div><div>${icon('db')}Biểu đồ dung lượng</div></div>
      <button class="btn primary" data-action="add">${icon('plus')}Thêm tài khoản</button></div></div>`;
    return;
  }
  const g = google();
  let used = 0, total = 0;
  g.forEach((a) => { const s = S.stats[a.id]?.storage; if (s) { used += s.used || 0; total += s.total || 0; } });
  const unread = S.accounts.reduce((s, a) => s + (S.stats[a.id]?.unread || 0), 0);
  const entries = S.accounts.flatMap((a) => (S.stats[a.id]?.entries || []).map((e) => ({ ...e, accId: a.id }))).sort((x, y) => y.date - x.date);

  root.innerHTML = `<div class="dash">
    <div class="kpis">
      <div class="card kpi"><div class="ico">${icon('users')}</div><div class="label">Tài khoản</div><div class="value">${S.accounts.length}</div><div class="hint">${g.length} Google · ${S.accounts.length - g.length} khác</div></div>
      <div class="card kpi"><div class="ico">${icon('db')}</div><div class="label">Dung lượng đã dùng</div><div class="value">${fmtBytes(used)}</div><div class="hint">trên tổng ${fmtBytes(total)}</div></div>
      <div class="card kpi"><div class="ico">${icon('mail')}</div><div class="label">Thư chưa đọc</div><div class="value">${unread}</div><div class="hint">trong hộp thư đến</div></div>
      <div class="card kpi"><div class="ico">${icon('cloud')}</div><div class="label">Còn trống</div><div class="value">${fmtBytes(Math.max(0, total - used))}</div><div class="hint">${total ? Math.round((used / total) * 100) : 0}% đã sử dụng</div></div>
    </div>
    <div class="dash-row">
      <div class="card"><h3>${icon('db')}So sánh dung lượng các tài khoản <span class="muted small" style="font-weight:500">(% hạn mức)</span></h3><div class="chart-box"><canvas id="cmpChart"></canvas></div></div>
      <div class="card"><h3>${icon('inbox')}Thư mới nhất<span class="grow"></span><button class="btn" style="padding:4px 10px" data-go="mail">Xem tất cả</button></h3>
        <div class="mail-mini">${entries.slice(0, 12).map((e, i) => {
          const a = acc(e.accId);
          return `<div class="item" data-i="${i}">${avatar(a, 'sm')}<div class="t"><b>${esc(e.fromName || e.fromEmail)}</b><small>${esc(e.title)}</small></div><small class="muted">${ago(e.date)}</small></div>`;
        }).join('') || `<div class="empty">${icon('check')}<div>Không có thư chưa đọc</div></div>`}</div></div>
    </div>
    <div class="acc-grid" id="accGrid">${S.accounts.map(accCard).join('')}</div>
  </div>`;


  $$('.mail-mini .item', root).forEach((el) => { el.onclick = () => { openEntry(entries[+el.dataset.i]); }; });
  $$('[data-open]', root).forEach((b) => { b.onclick = () => { const [v, id] = b.dataset.open.split(':'); if (v === 'mail') return openAccountMail(id); S.sel[v] = id; go(v); }; });
  $$('.acc-card .top', root).forEach((t) => { t.style.cursor = 'pointer'; t.onclick = () => { S.sel.account = t.closest('.acc-card').dataset.acc; go('account'); }; });
  $$('[data-refresh]', root).forEach((b) => { b.onclick = async () => { b.disabled = true; await refreshInbox(b.dataset.refresh); await refreshStorage(b.dataset.refresh); rerender(); }; });

  // biểu đồ so sánh
  const withS = g.filter((a) => S.stats[a.id]?.storage);
  const txt = getComputedStyle(document.body).getPropertyValue('--muted').trim();
  Chart.defaults.color = txt;
  Chart.defaults.font.family = 'Segoe UI, system-ui, sans-serif';
  if (withS.length) {
    const parts = withS.map((a) => storageParts(S.stats[a.id].storage));
    const ds = [
      ['Drive', 'drive'], ['Gmail', 'gmail'], ['Photos', 'photos'], ['Khác', 'other'], ['Đã dùng', 'onlyUsed'], ['Còn trống', 'free'],
    ].filter(([, k]) => parts.some((p) => p[k] > 0)).map(([label, k]) => ({
      label, key: k, data: parts.map((p) => (p.total ? +((p[k] / p.total) * 100).toFixed(1) : 0)),
      backgroundColor: k === 'onlyUsed' ? COLORS.drive : COLORS[k], borderRadius: 6, borderSkipped: false, barThickness: 22,
    }));
    S.charts.push(new Chart($('#cmpChart'), {
      type: 'bar',
      data: { labels: withS.map((a) => a.email), datasets: ds },
      options: {
        indexAxis: 'y', maintainAspectRatio: false, animation: { duration: 500 },
        scales: { x: { stacked: true, max: 100, grid: { color: 'rgba(127,140,180,0.12)' }, ticks: { callback: (v) => v + '%' } }, y: { stacked: true, grid: { display: false } } },
        plugins: { legend: { position: 'bottom', labels: { boxWidth: 10, boxHeight: 10, useBorderRadius: true, borderRadius: 3 } },
          tooltip: { callbacks: { label: (c) => `${c.dataset.label}: ${fmtBytes(parts[c.dataIndex][c.dataset.key])} (${c.raw}%)` } } },
      },
    }));
  } else {
    $('#cmpChart').parentElement.innerHTML = `<div class="empty">${S.busy ? '<span class="spinner"></span><div>Đang đọc dung lượng…</div>' : icon('db') + '<div>Chưa có dữ liệu dung lượng</div>'}</div>`;
  }
  // donut từng tài khoản
  g.forEach((a) => {
    const p = storageParts(S.stats[a.id]?.storage);
    const cv = $(`#donut-${a.id}`);
    if (!p || !cv) return;
    const data = [p.drive, p.gmail, p.photos, p.other + p.onlyUsed, p.free];
    S.charts.push(new Chart(cv, {
      type: 'doughnut',
      data: { labels: ['Drive', 'Gmail', 'Photos', 'Khác', 'Còn trống'], datasets: [{ data, backgroundColor: [COLORS.drive, COLORS.gmail, COLORS.photos, COLORS.other, COLORS.free], borderWidth: 0, hoverOffset: 4 }] },
      options: { cutout: '72%', plugins: { legend: { display: false }, tooltip: { callbacks: { label: (c) => `${c.label}: ${fmtBytes(c.raw)}` } } }, animation: { duration: 600 } },
    }));
  });
}

function accCard(a) {
  const st = S.stats[a.id] || {};
  const p = storageParts(st.storage);
  const pct = p?.total ? Math.round((p.used / p.total) * 100) : 0;
  const isG = a.provider === 'google';
  let body;
  if (!isG) body = a.mail?.configured
    ? `<div class="mailstat">${icon('inbox')}<div><b>${st.unread ?? '—'}</b> thư chưa đọc<br/><small class="muted">Hộp thư đã kết nối (IMAP/SMTP)</small></div></div>`
    : `<div class="hint-box">Chưa kết nối hộp thư. <a href="#" data-setupacc="${a.id}" style="color:var(--accent)">Kết nối ngay</a></div>`;
  else if (st.expired) body = `<div class="hint-box" style="border-color:rgba(239,68,68,.4);background:rgba(239,68,68,.08)">Phiên đăng nhập đã hết hạn. <a href="#" data-relogin="${a.id}" style="color:var(--accent)">Đăng nhập lại</a></div>`;
  else if (!p) body = `<div class="muted small" style="display:flex;gap:8px;align-items:center">${st.storageErr ? esc(st.storageErr) : '<span class="spinner"></span>Đang đọc dung lượng…'}</div>`;
  else body = `<div class="body"><div class="donut"><canvas id="donut-${a.id}"></canvas><div class="center"><div><b>${pct}%</b>đã dùng</div></div></div>
      <div class="legend">
        <div><i style="background:${COLORS.drive}"></i>Drive<span>${fmtBytes(p.drive || p.onlyUsed)}</span></div>
        <div><i style="background:${COLORS.gmail}"></i>Gmail<span>${fmtBytes(p.gmail)}</span></div>
        <div><i style="background:${COLORS.photos}"></i>Photos<span>${fmtBytes(p.photos)}</span></div>
        ${p.other ? `<div><i style="background:${COLORS.other}"></i>Khác<span>${fmtBytes(p.other)}</span></div>` : ''}
        <div><i style="background:${COLORS.free}"></i>Còn trống<span>${fmtBytes(p.free)}</span></div>
      </div></div>
      <div class="bar ${pct > 85 ? 'warn' : ''}"><div style="width:${pct}%"></div></div>
      <div class="small muted">${fmtBytes(p.used)} / ${fmtBytes(p.total)} · cập nhật ${ago(st.storageAt)}</div>`;
  return `<div class="card acc-card" data-acc="${a.id}" style="--c:${a.color}">
    <div class="top">${avatar(a, 'lg')}<div class="info"><b>${esc(a.name || a.email)}</b><small>${esc(a.email)}</small></div>
      ${st.unread ? `<span class="badge">${st.unread}</span>` : ''}</div>
    ${body}
    ${isG && !a.mail?.configured && !st.expired ? `<div class="small"><a href="#" data-setupacc="${a.id}" style="color:var(--accent)">${icon('key')} Kết nối hộp thư</a></div>` : ''}
    <div class="actions">
      <button class="btn" data-open="mail:${a.id}">${icon('mail')}Thư</button>
      ${isG ? `<button class="btn" data-open="drive:${a.id}">${icon('drive')}Drive</button><button class="btn" data-open="photos:${a.id}">${icon('image')}Photos</button><button class="btn" data-open="gemini:${a.id}">${icon('spark')}AI Agent</button>
      <button class="btn icon" data-refresh="${a.id}" title="Làm mới">${icon('refresh')}</button>` : ''}
    </div></div>`;
}

// ---------------- Trang chi tiết một tài khoản ----------------
function renderAccount() {
  S.charts.forEach((c) => c.destroy());
  S.charts = [];
  const root = $('#view-account');
  const a = acc(S.sel.account);
  if (!a) { go('dashboard'); return; }
  const st = S.stats[a.id] || {};
  const isG = a.provider === 'google';
  const p = storageParts(st.storage);
  const pct = p?.total ? Math.round((p.used / p.total) * 100) : 0;
  const mailOn = a.mail?.configured;
  const folders = Array.isArray(M.folders[a.id]) ? M.folders[a.id] : null;
  if (mailOn && !folders) loadFolders(a.id).then(() => { if (S.view === 'account' && S.sel.account === a.id) renderAccount(); });
  const entries = (st.entries || []).slice().sort((x, y) => y.date - x.date);
  const jobs = (S.jobs || []).filter((j) => (j.destAccs || []).includes(a.id));
  const provName = isG ? 'Google' : a.provider === 'microsoft' ? 'Microsoft' : 'Email IMAP/SMTP';
  const status = st.expired ? `<span class="pill error">Phiên hết hạn</span>` : `<span class="pill done">Đang hoạt động</span>`;

  root.innerHTML = `<div class="acct">
    <div class="card acct-head" style="--c:${a.color}">
      ${avatar(a, 'xl')}
      <div class="who"><h2>${esc(a.name || a.email)}</h2><div class="muted">${esc(a.email)}</div>
        <div class="tags"><span class="pill">${provName}</span>${status}${mailOn ? '<span class="pill done">Hộp thư đã kết nối</span>' : '<span class="pill">Chưa kết nối hộp thư</span>'}</div></div>
      <div class="acts">
        <button class="btn" data-acct="mail">${icon('mail')}Thư</button>
        ${isG ? `<button class="btn" data-acct="drive">${icon('drive')}Drive</button><button class="btn" data-acct="photos">${icon('image')}Photos</button><button class="btn" data-acct="gemini">${icon('spark')}AI Agent</button>` : ''}
        <button class="btn icon" data-acct="refresh" title="Làm mới">${icon('refresh')}</button>
        <button class="btn icon" data-acct="setup" title="Cài đặt hộp thư">${icon('key')}</button>
        ${a.provider !== 'imap' ? `<button class="btn icon" data-acct="relogin" title="Đăng nhập lại">${icon('login')}</button>` : ''}
      </div>
    </div>
    <div class="kpis">
      <div class="card kpi"><div class="ico">${icon('db')}</div><div class="label">Đã sử dụng</div><div class="value">${p ? fmtBytes(p.used) : '—'}</div><div class="hint">${p?.total ? pct + '% hạn mức' : isG ? 'đang đọc…' : 'không áp dụng'}</div></div>
      <div class="card kpi"><div class="ico">${icon('cloud')}</div><div class="label">Tổng dung lượng</div><div class="value">${p?.total ? fmtBytes(p.total) : '—'}</div><div class="hint">${st.storageAt ? 'cập nhật ' + ago(st.storageAt) : '&nbsp;'}</div></div>
      <div class="card kpi"><div class="ico">${icon('mail')}</div><div class="label">Thư chưa đọc</div><div class="value">${st.unread ?? '—'}</div><div class="hint">trong hộp thư đến</div></div>
      <div class="card kpi"><div class="ico">${icon('sync')}</div><div class="label">Còn trống</div><div class="value">${p?.total ? fmtBytes(p.free) : '—'}</div><div class="hint">${jobs.length} tác vụ đồng bộ</div></div>
    </div>
    <div class="acct-row">
      ${!isG && mailOn ? `<div class="card"><h3>${icon('inbox')}Thống kê hộp thư</h3>${folders ? (() => {
          const fs2 = folders.filter((f) => f.special && f.special !== '\\Flagged');
          const max = Math.max(1, ...fs2.map((f) => f.total));
          return `<div class="fbars">${fs2.map((f) => `<div class="fbar"><span class="fn">${icon(f.icon)}${esc(f.name)}</span>
            <span class="track"><i style="width:${Math.max(2, (f.total / max) * 100)}%"></i>${f.unread ? `<em style="width:${(f.unread / max) * 100}%"></em>` : ''}</span>
            <b>${f.total}</b><small>${f.unread ? f.unread + ' chưa đọc' : ''}</small></div>`).join('')}</div>`;
        })() : '<div class="empty"><span class="spinner"></span></div>'}</div>` : `<div class="card"><h3>${icon('db')}Phân bổ dung lượng</h3>
        ${p ? `<div class="acct-storage"><div class="donut big"><canvas id="acctDonut"></canvas><div class="center"><div><b>${pct}%</b>đã dùng</div></div></div>
          <div class="legend big">${[['Drive', p.drive || p.onlyUsed, COLORS.drive], ['Gmail', p.gmail, COLORS.gmail], ['Photos', p.photos, COLORS.photos], ['Khác', p.other, COLORS.other], ['Còn trống', p.free, COLORS.free]]
            .filter(([, v], i) => i < 3 || v > 0).map(([n, v, c]) => `<div><i style="background:${c}"></i>${n}<span>${fmtBytes(v)}${p.total ? ` · ${Math.round((v / p.total) * 100)}%` : ''}</span></div>`).join('')}
            <div class="bar ${pct > 85 ? 'warn' : ''}" style="margin-top:6px"><div style="width:${pct}%"></div></div>
            <div class="small muted">${fmtBytes(p.used)} / ${fmtBytes(p.total)}</div></div></div>`
          : `<div class="empty">${isG ? (st.storageErr ? esc(st.storageErr) : '<span class="spinner"></span><div>Đang đọc dung lượng…</div>') : icon('db') + '<div>Tài khoản email này không có dữ liệu dung lượng</div>'}</div>`}
      </div>`}
      <div class="card"><h3>${icon('inbox')}Thư chưa đọc mới nhất<span class="grow"></span><button class="btn" style="padding:4px 10px" data-acct="mail">Mở hộp thư</button></h3>
        <div class="mail-mini">${entries.slice(0, 12).map((e, i) => `<div class="item" data-ent="${i}"><div class="avatar sm" style="background:hsl(${[...(e.fromEmail || e.fromName || '?')].reduce((h, c) => (h * 31 + c.charCodeAt(0)) % 360, 0)} 55% 48%)">${esc((e.fromName || e.fromEmail || '?')[0].toUpperCase())}</div>
          <div class="t"><b>${esc(e.fromName || e.fromEmail)}</b><small>${esc(e.title)}</small></div><small class="muted">${ago(e.date)}</small></div>`).join('')
          || `<div class="empty">${mailOn || isG ? icon('check') + '<div>Không có thư chưa đọc</div>' : icon('key') + `<div>Chưa kết nối hộp thư</div><button class="btn primary" data-acct="setup" style="margin-top:8px">Kết nối ngay</button>`}</div>`}</div>
      </div>
    </div>
    <div class="acct-row three">
      <div class="card"><h3>${icon('folder')}Thư mục thư</h3>
        ${mailOn ? (folders ? `<div class="fold-list">${folders.filter((f) => f.special).map((f) => `<div data-fold="${esc(f.path)}" data-fname="${esc(f.name)}">${icon(f.icon)}<span>${esc(f.name)}</span><b>${f.unread ? f.unread : ''}</b><small>${f.total}</small></div>`).join('')}</div>` : '<div class="empty small"><span class="spinner"></span></div>')
          : `<div class="empty small">Kết nối hộp thư để xem thư mục</div>`}
      </div>
      <div class="card"><h3>${icon('sync')}Đồng bộ liên quan</h3>
        ${jobs.length ? jobs.map((j) => `<div class="mini-job">${icon('folder')}<span title="${esc(j.localPath)}">${esc(j.localPath.split(/[\\/]/).pop())}</span><small>${j.lastRun ? ago(j.lastRun) : 'chưa chạy'}</small></div>`).join('')
          : `<div class="empty small">Chưa có tác vụ đồng bộ tới tài khoản này</div>`}
      </div>
      <div class="card"><h3>${icon('gear')}Thông tin</h3>
        <div class="kv"><span>Loại tài khoản</span><b>${provName}</b></div>
        <div class="kv"><span>Hộp thư</span><b>${mailOn ? (a.mail.preset === 'gmail' ? 'Gmail (IMAP)' : 'IMAP/SMTP') : 'Chưa kết nối'}</b></div>
        <div class="kv"><span>Dung lượng cập nhật</span><b>${st.storageAt ? ago(st.storageAt) : '—'}</b></div>
        <div class="kv"><span>Màu nhận diện</span><b><i class="dot" style="background:${a.color}"></i>${a.color}</b></div>
      </div>
    </div>
  </div>`;

  $$('[data-acct]', root).forEach((b) => { b.onclick = async () => {
    const k = b.dataset.acct;
    if (k === 'mail') return openAccountMail(a.id);
    if (['drive', 'photos', 'gemini'].includes(k)) { S.sel[k] = a.id; return go(k); }
    if (k === 'setup') return openMailSetup(a.id);
    if (k === 'relogin') return relogin(a.id);
    if (k === 'refresh') { b.disabled = true; await refreshInbox(a.id, false); if (isG) await refreshStorage(a.id); if (mailOn) await loadFolders(a.id); renderAccount(); }
  }; });
  $$('[data-ent]', root).forEach((el) => { el.onclick = () => openEntry(entries[+el.dataset.ent]); });
  $$('[data-fold]', root).forEach((el) => { el.onclick = () => { go('mail'); selectBox({ kind: 'box', accId: a.id, path: el.dataset.fold, name: el.dataset.fname }); }; });
  if (p) {
    S.charts.push(new Chart($('#acctDonut'), {
      type: 'doughnut',
      data: { labels: ['Drive', 'Gmail', 'Photos', 'Khác', 'Còn trống'], datasets: [{ data: [p.drive || p.onlyUsed, p.gmail, p.photos, p.other, p.free], backgroundColor: [COLORS.drive, COLORS.gmail, COLORS.photos, COLORS.other, COLORS.free], borderWidth: 0, hoverOffset: 6 }] },
      options: { cutout: '70%', maintainAspectRatio: false, plugins: { legend: { display: false }, tooltip: { callbacks: { label: (c) => `${c.label}: ${fmtBytes(c.raw)}` } } } },
    }));
  }
}

// ---------------- Thanh chọn tài khoản (dùng cho Drive, Gemini) ----------------
function chipsHtml(list, selId, { all = false } = {}) {
  return (all ? `<button class="chip all ${selId === 'all' ? 'active' : ''}" data-id="all">Tất cả</button>` : '') +
    list.map((a) => {
      const u = S.stats[a.id]?.unread;
      return `<button class="chip ${selId === a.id ? 'active' : ''}" style="--c:${a.color}" data-id="${a.id}">${avatar(a, 'sm')}${esc(a.email)}${u ? `<span class="badge">${u}</span>` : ''}</button>`;
    }).join('');
}

// ---------------- Drive ----------------
function renderDrive() {
  const g = google();
  if (!acc(S.sel.drive) || acc(S.sel.drive).provider !== 'google') S.sel.drive = g[0]?.id || null;
  $('#driveChips').innerHTML = chipsHtml(g, S.sel.drive);
  $$('#driveChips .chip').forEach((c) => { c.onclick = () => { S.sel.drive = c.dataset.id; renderDrive(); }; });
  if (!S.sel.drive) { placeholder('driveStack', `Thêm một tài khoản Google để dùng Google Drive.<br/><button class="btn primary" data-action="add" style="margin-top:12px">${icon('plus')}Thêm tài khoản</button>`); $('#driveStorage').innerHTML = ''; return; }
  const wv = ensureWeb('driveStack', acc(S.sel.drive), URLS.drive);
  attachNavHider(wv, 'drive'); // mặc định hiện đầy đủ như Google; nút ☰ trên thanh để ẩn menu nếu muốn
  renderDriveStorage();
}
function renderDriveStorage() {
  const p = storageParts(S.stats[S.sel.drive]?.storage);
  if (!p) { $('#driveStorage').innerHTML = S.sel.drive ? '<span><span class="spinner"></span> đang đọc dung lượng…</span>' : ''; return; }
  const pct = p.total ? Math.round((p.used / p.total) * 100) : 0;
  $('#driveStorage').innerHTML = `${icon('db')}<div class="bar ${pct > 85 ? 'warn' : ''}"><div style="width:${pct}%"></div></div><span><b>${fmtBytes(p.used)}</b> / ${fmtBytes(p.total)} (${pct}%)</span>`;
  $('#driveStorage svg').style.cssText = 'width:16px;height:16px;color:var(--muted)';
}

// ---------------- Chờ đăng nhập bằng trình duyệt thật ----------------
hub.on('login:waiting', ({ kind }) => {
  $('#lwBrowser').textContent = { chrome: 'Chrome', edge: 'Edge', brave: 'Brave' }[kind] || 'trình duyệt';
  $('#loginWait').classList.add('open');
});
const closeLoginWait = () => $('#loginWait').classList.remove('open');

$('#lwCancel').onclick = () => { call('login:cancel'); closeLoginWait(); };

// ---------------- Cập nhật online ----------------
async function checkUpdate({ silent = false } = {}) {
  let r;
  try { r = await call('update:check'); }
  catch (e) { if (!silent) toast(esc(e.message), 'err'); return; }
  if (!r.available) { if (!silent) toast(`Bạn đang dùng phiên bản mới nhất (${esc(r.current)})`, 'ok'); return; }
  $('#updTitle').textContent = 'Có phiên bản mới';
  $('#updCur').textContent = 'v' + r.current;
  $('#updNew').textContent = 'v' + r.latest;
  $('#updNotes').innerHTML = r.notes ? esc(r.notes).replace(/\n/g, '<br>') : 'Cải thiện hiệu năng và sửa lỗi.';
  $('#updBar').style.display = 'none';
  $('#updGo').disabled = false;
  $('#updGo').innerHTML = icon('download') + 'Cập nhật ngay';
  $('#updLater').style.display = r.mandatory ? 'none' : '';
  $('#updClose').style.display = r.mandatory ? 'none' : '';
  $('#updModal').classList.add('open');
}
window.checkUpdate = checkUpdate;
$('#updGo').onclick = async () => {
  const b = $('#updGo');
  b.disabled = true; b.innerHTML = '<span class="spinner"></span>Đang tải…';
  $('#updBar').style.display = 'flex'; $('#updLater').style.display = 'none';
  try {
    await call('update:download');
    $('#updTitle').textContent = 'Đã tải xong bản cập nhật';
    b.innerHTML = '<span class="spinner"></span>Đang khởi động lại…';
    await call('update:install');
  } catch (e) {
    toast(esc(e.message), 'err');
    b.disabled = false; b.innerHTML = icon('refresh') + 'Thử lại'; $('#updLater').style.display = '';
  }
};
hub.on('update:progress', (p) => {
  const pct = p.total ? Math.round((p.got / p.total) * 100) : 0;
  $('#updBar div').style.width = pct + '%';
  $('#updBar span').textContent = `${fmtBytes(p.got)}${p.total ? ' / ' + fmtBytes(p.total) + ` (${pct}%)` : ''}`;
});
$('#abUpdate').onclick = () => { $('#aboutModal').classList.remove('open'); checkUpdate(); };

// ---------------- Hộp nhập liệu (thay cho prompt) ----------------
function askText(title, value = '', placeholder = '') {
  return new Promise((resolve) => {
    $('#askTitle').textContent = title;
    const i = $('#askInput');
    i.value = value; i.placeholder = placeholder;
    $('#askModal').classList.add('open');
    setTimeout(() => { i.focus(); i.select(); }, 50);
    const done = (v) => { $('#askModal').classList.remove('open'); $('#askOk').onclick = $('#askCancel').onclick = i.onkeydown = null; resolve(v); };
    $('#askOk').onclick = () => done(i.value.trim() || null);
    $('#askCancel').onclick = () => done(null);
    i.onkeydown = (e) => { if (e.key === 'Enter') done(i.value.trim() || null); if (e.key === 'Escape') done(null); };
  });
}
window.askText = askText;

// ---------------- Ẩn cột menu trái + logo của Google (Drive, Photos) ----------------
const NAV_JS = (hide, kind = '') => `(()=>{
  window.__gchHide = ${hide ? 'true' : 'false'};
  window.__gchKind = '${kind}';
  const restore = () => {
    document.querySelectorAll('[data-gch-hidden]').forEach(e => { e.style.removeProperty('display'); e.removeAttribute('data-gch-hidden'); });
    document.querySelectorAll('[data-gch-fix]').forEach(e => { ['margin-left','padding-left','grid-column','max-width','width'].forEach(p => e.style.removeProperty(p)); e.removeAttribute('data-gch-fix'); });
  };
  const run = () => {
    if (!window.__gchHide) return restore();
    const vh = innerHeight;
    const mark = (el) => { if (!el.hasAttribute('data-gch-hidden')) { el.setAttribute('data-gch-hidden', '1'); el.style.setProperty('display', 'none', 'important'); } };
    // cột điều hướng bên trái
    document.querySelectorAll('nav,[role="navigation"]').forEach(n => {
      const r = n.getBoundingClientRect();
      if (r.left > 30 || r.width < 120 || r.width > 380 || r.height < 60) return;
      let el = n;
      while (el.parentElement && el.parentElement !== document.body) {
        const pr = el.parentElement.getBoundingClientRect();
        if (pr.left <= 30 && pr.width <= r.width + 40 && pr.height >= r.height - 5) el = el.parentElement; else break;
      }
      el.setAttribute('data-gch-nav', '1');
      mark(el);
    });
    // Ẩn luôn khung bao ngoài cột menu khi bên trong không còn gì hiển thị
    document.querySelectorAll('[data-gch-nav]').forEach(n => {
      let el = n;
      while (el.parentElement && el.parentElement !== document.body) {
        const p = el.parentElement, pr = p.getBoundingClientRect();
        const visibleKids = [...p.children].filter(k => !k.hasAttribute('data-gch-hidden') && k.getBoundingClientRect().width > 0);
        if (pr.left <= 30 && pr.width > 0 && pr.width <= 420 && visibleKids.length === 0) { p.setAttribute('data-gch-nav', '1'); mark(p); el = p; } else break;
      }
    });
    // Bỏ khoảng trống: các khung bên trái không còn nội dung hiển thị → ẩn; vùng chính giãn hết chiều ngang
    const empty = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && !(el.innerText || '').trim() && !el.querySelector('img,video,canvas,input,iframe'); };
    const main = document.querySelector('[role="main"]');
    if (main) {
      let el = main;
      while (el && el !== document.body) {
        const p = el.parentElement;
        if (!p) break;
        for (const sib of p.children) {
          if (sib === el || sib.contains(main)) continue;
          const r = sib.getBoundingClientRect();
          if (r.left < 60 && r.width > 24 && r.width < 420 && r.height > vh * 0.3 && empty(sib)) mark(sib);
        }
        const cs = getComputedStyle(el);
        const fix = (prop, v) => { el.style.setProperty(prop, v, 'important'); el.setAttribute('data-gch-fix', '1'); };
        if (parseFloat(cs.marginLeft) > 40) fix('margin-left', '0');
        if (parseFloat(cs.paddingLeft) > 40) fix('padding-left', '0');
        // chỉ giãn khi mọi cột anh em đã bị ẩn (tránh vỡ bố cục)
        const others = [...p.children].filter((k) => k !== el && getComputedStyle(k).display !== 'none' && k.getBoundingClientRect().width > 0);
        if (getComputedStyle(p).display.includes('grid') && others.length === 0) fix('grid-column', '1 / -1');
        el = p;
      }
    }
    // Drive: chỉ giữ thư mục & tệp — ẩn thanh đầu trang Google, "Hỏi Gemini" và hàng bộ lọc
    if (window.__gchKind === 'drive') {
      document.querySelectorAll('header, [role="banner"]').forEach((h) => { const r = h.getBoundingClientRect(); if (r.top < 90 && r.height < 120) mark(h); });
      const CHIP = /^(Hỏi Gemini|Ask Gemini|Loại|Type|Người|People|Lần sửa đổi( gần đây nhất)?|Modified|Nguồn|Source|Vị trí|Location)$/i;
      const chips = [...document.querySelectorAll('[role="main"] button, [role="main"] [role="button"]')].filter((b) => CHIP.test((b.innerText || b.getAttribute('aria-label') || '').trim()));
      if (chips.length >= 2) {
        let row = chips[0].parentElement;
        while (row && row !== document.body && !chips.every((c) => row.contains(c))) row = row.parentElement;
        if (row && row !== document.body && row.getBoundingClientRect().height < 110) mark(row);
      } else chips.forEach((c) => mark(c));
    }
    // logo Google ở góc trên trái
    document.querySelectorAll('header a, [role="banner"] a').forEach(a => {
      const r = a.getBoundingClientRect();
      if (r.top < 80 && r.left < 280 && r.width > 0 && r.width < 260 && a.querySelector('img,svg')) mark(a);
    });
  };
  run();
  if (!window.__gchObs) {
    window.__gchObs = new MutationObserver(() => { clearTimeout(window.__gchT); window.__gchT = setTimeout(run, 200); });
    window.__gchObs.observe(document.documentElement, { childList: true, subtree: true });
  }
})()`;
const navHidden = { drive: false, photos: false }; // mặc định: HIỆN ĐẦY ĐỦ như Google (nút ☰ để ẩn nếu muốn)
function attachNavHider(wv, kind) {
  if (wv.dataset.navhider) return;
  wv.dataset.navhider = kind;
  const apply = () => wv.executeJavaScript(NAV_JS(navHidden[kind], kind)).catch(() => {});
  wv.addEventListener('dom-ready', apply);
  wv.addEventListener('did-navigate-in-page', apply);
}
function toggleNav(kind, stackId, btn) {
  navHidden[kind] = !navHidden[kind];
  $$(kind === 'drive' ? '#driveStack webview, #syncStack webview' : `#${stackId} webview`).forEach((w) => w.executeJavaScript(NAV_JS(navHidden[kind], kind)).catch(() => {}));
  btn.classList.toggle('on', !navHidden[kind]);
}

// ---------------- Thanh công cụ Drive ----------------
const HIDE_GOOGLE_NEW = `[guidedhelpid="new_menu_button"]{opacity:0!important;pointer-events:none!important;height:0!important;margin:0!important;overflow:hidden!important}`;
function driveWv() { return $('#driveStack webview.on'); }
function driveProgress(html) {
  const el = $('#drvProgress');
  el.innerHTML = html || '';
  el.classList.toggle('on', !!html);
}
async function driveUpload(kind) {
  const wv = driveWv();
  const a = acc(S.sel.drive);
  if (!wv || !a) return;
  const paths = await call('drive:pick', kind);
  if (!paths.length) return;
  const what = kind === 'folder' ? `${paths.length} thư mục` : `${paths.length} tệp`;
  driveProgress(`<span class="spinner"></span>Đang tải ${what} lên <b>${esc(a.email)}</b>…`);
  try {
    const r = await call('drive:upload', a.id, wv.getWebContentsId(), paths, kind);
    driveProgress('');
    toast(`Đã tải lên ${r.done} tệp vào Drive <b>${esc(a.email)}</b>`, 'ok');
    refreshStorage(a.id).then(renderDriveStorage);
  } catch (e) { driveProgress(''); toast(esc(e.message), 'err'); }
}
hub.on('drive:progress', (p) => {
  if ($('#drvProgress').classList.contains('on')) driveProgress(`<span class="spinner"></span>Đang tải lên… đã xong <b>${p.done}</b> tệp`);
});
$('#drvUpFile').onclick = () => driveUpload('file');
$('#drvUpFolder').onclick = async () => {
  const wv = driveWv();
  if (!wv) return;
  try {
    await call('drive:folderUpload', wv.getWebContentsId());
    toast('Chọn thư mục cần tải lên trong hộp thoại Windows — tiến trình hiển thị ở góc dưới Drive', 'info');
  } catch (e) { toast(esc(e.message), 'err'); }
};
$('#drvDownload').onclick = async () => {
  const wv = driveWv();
  if (!wv) return;
  try {
    const r = await call('drive:download', wv.getWebContentsId());
    toast(r.count > 1 ? `Drive đang nén ${r.count} mục thành tệp .zip để tải về…` : 'Đang tải xuống…', 'info');
  } catch (e) { toast(esc(e.message), 'err'); }
};
$('#drvOpenDl').onclick = () => call('shell:downloads');
$('#drvNav').onclick = (e) => toggleNav('drive', 'driveStack', e.currentTarget);
$('#phNav').onclick = (e) => toggleNav('photos', 'photosStack', e.currentTarget);
$('#drvNewFolder').onclick = async () => {
  const wv = driveWv();
  if (!wv) return;
  const name = await askText('Tên thư mục mới', 'Thư mục không có tiêu đề');
  if (!name) return;
  try { await call('drive:newFolder', wv.getWebContentsId(), name); toast(`Đã tạo thư mục <b>${esc(name)}</b>`, 'ok'); }
  catch (e) { toast(esc(e.message), 'err'); }
};
document.addEventListener('click', (e) => {
  const b = e.target.closest('[data-drive]');
  if (!b) return;
  const wv = driveWv();
  if (wv) wv.loadURL(b.dataset.drive).catch(() => {});
});
$('#drvSearchForm').onsubmit = (e) => {
  e.preventDefault();
  const q = $('#drvSearch').value.trim();
  const wv = driveWv();
  if (q && wv) wv.loadURL('https://drive.google.com/drive/u/0/search?q=' + encodeURIComponent(q)).catch(() => {});
};

// ---------------- Google Photos ----------------
function renderPhotos() {
  const g = google();
  if (!acc(S.sel.photos) || acc(S.sel.photos).provider !== 'google') S.sel.photos = g[0]?.id || null;
  $('#photosChips').innerHTML = chipsHtml(g, S.sel.photos);
  $$('#photosChips .chip').forEach((c) => { c.onclick = () => { S.sel.photos = c.dataset.id; renderPhotos(); }; });
  if (!S.sel.photos) { placeholder('photosStack', `Thêm một tài khoản Google để dùng Google Photos.<br/><button class="btn primary" data-action="add" style="margin-top:12px">${icon('plus')}Thêm tài khoản</button>`); $('#photosStorage').innerHTML = ''; return; }
  attachNavHider(ensureWeb('photosStack', acc(S.sel.photos), URLS.photos, 'photos-' + S.sel.photos), 'photos');
  const p = S.stats[S.sel.photos]?.storage;
  $('#photosStorage').innerHTML = p && p.photos != null
    ? `${icon('image')}<span>Ảnh & video đang dùng <b>${fmtBytes(p.photos)}</b>${p.total ? ` · còn trống ${fmtBytes(Math.max(0, p.total - p.used))}` : ''}</span>` : '';
}
document.addEventListener('click', (e) => {
  const b = e.target.closest('[data-photos]');
  if (!b) return;
  const wv = $('#photosStack webview.on');
  if (wv) wv.loadURL(b.dataset.photos).catch(() => {});
});
$('#photosUpload').onclick = async () => {
  const id = S.sel.photos;
  if (!id) return;
  const files = await call('dialog:media');
  if (!files.length) return;
  const a = acc(id);
  const t = toast(`Đang tải ${files.length} ảnh/video lên Google Photos của <b>${esc(a.email)}</b>…`, 'busy');
  try {
    await call('photos:upload', id, files);
    t.update(`Đã tải ${files.length} ảnh/video lên <b>${esc(a.email)}</b>`, 'ok');
    const wv = $('#photosStack webview.on'); if (wv) wv.reload();
  } catch (err) { t.update(esc(err.message), 'err'); }
};

// ---------------- Đồng bộ ----------------
let syncTab = 'transfer';
$('#syncTabs').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-tab]');
  if (!b) return;
  syncTab = b.dataset.tab;
  $$('#syncTabs button').forEach((x) => x.classList.toggle('active', x === b));
  $$('#view-sync .tabpane').forEach((p) => p.classList.toggle('active', p.id === 'tab-' + syncTab));
  renderSync();
});

function updateCapture() {
  const on = S.view === 'sync' && syncTab === 'transfer' && S.sel.syncSrc;
  call('transfer:capture', on ? S.sel.syncSrc : null);
}

function renderSync() {
  const g = google();
  if (!acc(S.sel.syncSrc)) S.sel.syncSrc = g[0]?.id || null;
  $('#syncSrc').innerHTML = g.map((a) => `<option value="${a.id}">${esc(a.email)}</option>`).join('') || '<option>Chưa có tài khoản Google</option>';
  if (S.sel.syncSrc) {
    $('#syncSrc').value = S.sel.syncSrc;
    const wv = ensureWeb('syncStack', acc(S.sel.syncSrc), URLS.drive, 'sync-' + S.sel.syncSrc);
    attachNavHider(wv, 'drive'); // hiện đầy đủ như Google
    renderSrcTree();
  }
  else placeholder('syncStack', 'Thêm ít nhất hai tài khoản Google để chuyển dữ liệu giữa các Drive.');
  const dests = g.filter((a) => a.id !== S.sel.syncSrc);
  renderDests(dests);
  const jc = new Set($$('#jobAccs input:checked').map((i) => i.value));
  $('#jobAccs').innerHTML = g.map((a) => `<label><input type="checkbox" value="${a.id}" ${jc.has(a.id) ? 'checked' : ''}/>${avatar(a, 'sm')}${esc(a.email)}</label>`).join('') || '<div class="muted small">Chưa có tài khoản Google.</div>';
  renderQueue();
  renderJobs();
  updateCapture();
}
// ---- Tài khoản chuyển đến + thư mục đích dạng cây ----
S.destSel = {};      // accId -> { id, path }
S.destOn = new Set();
S.srcSel = new Map();   // id -> { id, parentId, name, path } các thư mục nguồn đã tick
function renderDests(dests) {
  $('#destChecks').innerHTML = dests.map((a) => {
    const sel = S.destSel[a.id];
    const on = S.destOn.has(a.id);
    return `<div class="dest ${on ? 'on' : ''}" style="--c:${a.color}">
      <label><input type="checkbox" value="${a.id}" ${on ? 'checked' : ''}/>${avatar(a, 'sm')}<span class="em">${esc(a.email)}</span></label>
      <button class="dest-folder" data-pick="${a.id}" title="Chọn thư mục đích">${icon('folder')}<span>${esc(sel?.path || 'Drive của tôi')}</span>${icon('chevron')}</button>
    </div>`;
  }).join('') || '<div class="muted small">Cần thêm tài khoản Google khác để chuyển đến.</div>';
  $$('#destChecks input').forEach((i) => { i.onchange = () => { i.checked ? S.destOn.add(i.value) : S.destOn.delete(i.value); i.closest('.dest').classList.toggle('on', i.checked); }; });
  $$('#destChecks [data-pick]').forEach((b) => { b.onclick = () => openTree(b.dataset.pick); });
}

// Cây thư mục: tải lười từng cấp khi mở rộng
let TREE = null;
async function openTree(accId) {
  const a = acc(accId);
  TREE = { accId, sel: S.destSel[accId] || { id: '', path: 'Drive của tôi' }, nodes: new Map() };
  $('#treeTitle').textContent = 'Chọn thư mục — ' + a.email;
  $('#treePath').textContent = TREE.sel.path;
  $('#tree').innerHTML = `<div class="tnode root" data-id="" data-path="Drive của tôi"><div class="trow sel">
      <button class="tcaret open">${icon('chevron')}</button>${icon('drive')}<span>Drive của tôi</span></div><div class="tkids"></div></div>`;
  $('#treeModal').classList.add('open');
  const root = $('#tree .tnode');
  await expand(root);
  if (TREE.sel.id) { $$('#tree .trow').forEach((r) => r.classList.remove('sel')); }
}
async function expand(node, reload = false) {
  const kids = node.querySelector(':scope > .tkids');
  const caret = node.querySelector(':scope > .trow .tcaret');
  if (reload) delete node.dataset.loaded;
  if (node.dataset.loaded) { const open = !kids.hidden; kids.hidden = open; caret.classList.toggle('open', !open); return; }
  caret.classList.add('open');
  kids.hidden = false;
  kids.innerHTML = '<div class="tload"><span class="spinner"></span>Đang tải thư mục…</div>';
  try {
    const list = await call('drive:folders', TREE.accId, node.dataset.id || null);
    node.dataset.loaded = '1';
    kids.innerHTML = list.map((f) => `<div class="tnode" data-id="${esc(f.id)}" data-path="${esc(node.dataset.path + ' / ' + f.name)}">
        <div class="trow ${TREE.sel.id === f.id ? 'sel' : ''}"><button class="tcaret">${icon('chevron')}</button>${icon('folder')}<span>${esc(f.name)}</span></div><div class="tkids" hidden></div></div>`).join('')
      || '<div class="tload muted">Không có thư mục con</div>';
  } catch (e) {
    kids.innerHTML = `<div class="tload" style="color:var(--err)">${esc(e.message)}</div>`;
  }
}
$('#tree').addEventListener('click', (e) => {
  const node = e.target.closest('.tnode');
  if (!node) return;
  if (e.target.closest('.tcaret')) return expand(node);
  $$('#tree .trow').forEach((r) => r.classList.remove('sel'));
  node.querySelector(':scope > .trow').classList.add('sel');
  TREE.sel = { id: node.dataset.id, path: node.dataset.path };
  $('#treePath').textContent = TREE.sel.path;
});
$('#tree').addEventListener('dblclick', (e) => { const node = e.target.closest('.tnode'); if (node && !e.target.closest('.tcaret')) expand(node); });
// Tạo thư mục mới bên trong thư mục đang chọn
$('#treeNew').onclick = async () => {
  if (!TREE) return;
  const parentPath = TREE.sel.path || 'Drive của tôi';
  const name = await askText(`Tên thư mục mới (trong "${parentPath}")`, 'Thư mục mới');
  if (!name) return;
  const b = $('#treeNew'); b.disabled = true; b.innerHTML = '<span class="spinner"></span>Đang tạo…';
  try {
    const f = await call('drive:createFolder', TREE.accId, TREE.sel.id || null, name);
    const parent = TREE.sel.id ? $(`#tree .tnode[data-id="${CSS.escape(TREE.sel.id)}"]`) : $('#tree .tnode.root');
    await expand(parent, true);
    const kids = parent.querySelector(':scope > .tkids'); kids.hidden = false;
    parent.querySelector(':scope > .trow .tcaret').classList.add('open');
    const node = f.id && parent.querySelector(`:scope > .tkids > .tnode[data-id="${CSS.escape(f.id)}"]`);
    if (node) { node.querySelector('.trow').click(); node.scrollIntoView({ block: 'nearest' }); }
    toast(`Đã tạo thư mục <b>${esc(name)}</b>`, 'ok');
  } catch (e) { toast(esc(e.message), 'err'); }
  finally { b.disabled = false; b.innerHTML = icon('plus') + 'Thư mục mới'; }
};
$$('#treeModal [data-close]').forEach((b) => b.addEventListener('click', () => TREE && call('drive:treeClose', TREE.accId)));

$('#treeOk').onclick = () => {
  S.destSel[TREE.accId] = TREE.sel.id ? TREE.sel : { id: '', path: 'Drive của tôi' };
  S.destOn.add(TREE.accId);
  $('#treeModal').classList.remove('open');
  call('drive:treeClose', TREE.accId);
  renderDests(google().filter((a) => a.id !== S.sel.syncSrc));
};

// ---- Cây thư mục NGUỒN (chọn nhiều) để di chuyển ----
async function renderSrcTree(reload = false) {
  const el = $('#srcTree');
  if (!el) return;
  const a = acc(S.sel.syncSrc);
  if (!a) { el.innerHTML = '<div class="tload muted">Chưa chọn tài khoản nguồn</div>'; return; }
  if (!reload && el.dataset.acc === a.id && el.children.length) return;  // giữ nguyên nếu đã tải
  el.dataset.acc = a.id;
  S.srcSel.clear();
  el.innerHTML = `<div class="tnode root" data-id="" data-path="Drive của tôi">
    <div class="trow"><button class="tcaret open">${icon('chevron')}</button>${icon('drive')}<span>Drive của tôi</span></div>
    <div class="tkids"></div></div>`;
  await expandSrc(el.querySelector('.tnode.root'));
}
async function expandSrc(node, reload = false) {
  const kids = node.querySelector(':scope > .tkids');
  const caret = node.querySelector(':scope > .trow .tcaret');
  if (reload) delete node.dataset.loaded;
  if (node.dataset.loaded) { const open = !kids.hidden; kids.hidden = open; caret.classList.toggle('open', !open); return; }
  caret.classList.add('open'); kids.hidden = false;
  kids.innerHTML = '<div class="tload"><span class="spinner"></span>Đang tải thư mục…</div>';
  try {
    const list = await call('drive:folders', S.sel.syncSrc, node.dataset.id || null);
    node.dataset.loaded = '1';
    kids.innerHTML = list.map((f) => `<div class="tnode" data-id="${esc(f.id)}" data-parent="${esc(node.dataset.id || '')}" data-name="${esc(f.name)}" data-path="${esc(node.dataset.path + ' / ' + f.name)}">
        <div class="trow"><button class="tcaret">${icon('chevron')}</button><input type="checkbox" class="tck" ${S.srcSel.has(f.id) ? 'checked' : ''}/>${icon('folder')}<span>${esc(f.name)}</span></div>
        <div class="tkids" hidden></div></div>`).join('')
      || '<div class="tload muted">Không có thư mục con</div>';
  } catch (e) {
    kids.innerHTML = `<div class="tload" style="color:var(--err)">${esc(e.message)}</div>`;
  }
}
$('#srcTree').addEventListener('click', (e) => {
  const node = e.target.closest('.tnode');
  if (!node) return;
  if (e.target.closest('.tcaret')) return expandSrc(node);
  if (e.target.classList.contains('tck')) {
    const id = node.dataset.id;
    if (e.target.checked) S.srcSel.set(id, { id, parentId: node.dataset.parent || '', name: node.dataset.name, path: node.dataset.path });
    else S.srcSel.delete(id);
    node.querySelector(':scope > .trow').classList.toggle('on', e.target.checked);
    const n = S.srcSel.size;
    $('#doMove').innerHTML = icon('sync') + (n ? `Di chuyển ${n} thư mục đã chọn` : 'Di chuyển thư mục đã chọn');
    return;
  }
  // bấm vào tên = mở rộng
  if (!node.classList.contains('root')) expandSrc(node);
});
$('#srcReload') && ($('#srcReload').onclick = () => renderSrcTree(true));
$('#syncDrawerBtn') && ($('#syncDrawerBtn').onclick = () => { $('#syncDrawer').classList.add('open'); renderSrcTree(); });
$('#syncDrawerClose') && ($('#syncDrawerClose').onclick = () => $('#syncDrawer').classList.remove('open'));

// Di chuyển các thư mục nguồn đã tick sang tài khoản đích
$('#doMove').onclick = async () => {
  const items = [...S.srcSel.values()];
  if (!items.length) return toast('Hãy tick ít nhất một thư mục ở tài khoản nguồn', 'err');
  const dests = $$('#destChecks input:checked').map((i) => ({ accId: i.value, folderId: S.destSel[i.value]?.id || '' }));
  if (!dests.length) return toast('Hãy chọn tài khoản chuyển đến', 'err');
  S.uploading = true; S.stopped = false; updateTransferButtons();
  moveProg(`<span class="spinner"></span>Đang tải ${items.length} thư mục từ nguồn… (Drive nén .zip)`);
  S.pendingMove = { dests, armed: false };
  try {
    const r = await call('drive:queueFolders', S.sel.syncSrc, items.map((x) => ({ id: x.id, parentId: x.parentId, name: x.name })));
    if (r.errors && r.errors.length) toast('Không tải được: ' + r.errors.join(', '), 'err');
    if (!r.started) { S.pendingMove = null; S.uploading = false; updateTransferButtons(); moveProg(''); return toast('Không tải được thư mục nào từ nguồn', 'err'); }
    if (S.pendingMove) { S.pendingMove.armed = true; checkPendingMove(); }
  } catch (e) {
    S.pendingMove = null; S.uploading = false; updateTransferButtons(); moveProg('');
    toast(esc(e.message), 'err');
  }
};
function moveProg(html) { const el = $('#moveProg'); if (el) { el.innerHTML = html || ''; el.classList.toggle('on', !!html); } }
function checkPendingMove() {
  const pm = S.pendingMove;
  if (!pm || !pm.armed) return;
  if (S.queue.some((x) => x.status === 'downloading')) { moveProg(`<span class="spinner"></span>Đang tải thư mục từ nguồn…`); return; }
  const ready = S.queue.filter((x) => x.status === 'ready');
  S.pendingMove = null;
  if (!ready.length) { S.uploading = false; updateTransferButtons(); moveProg(''); return; }
  finishMove(pm.dests, ready.map((x) => x.id));
}
async function finishMove(dests, ids) {
  moveProg(`<span class="spinner"></span>Đang chuyển lên ${dests.length} tài khoản đích…`);
  try {
    const res = await call('transfer:upload', ids, dests, '');
    if (!S.stopped) {
      const ok = res.filter((r) => r.ok).length;
      toast(`Đã di chuyển xong (${ok}/${res.length} tài khoản đích)`, ok === res.length ? 'ok' : 'err');
    }
  } catch (e) { toast(esc(e.message), 'err'); }
  finally {
    S.uploading = false; S.stopped = false;
    S.srcSel.clear(); renderSrcTree(true);
    updateTransferButtons(); moveProg('');
  }
}

// Đưa các mục đang chọn trong Drive nguồn vào hàng chờ
$('#qFromDrive').onclick = async () => {
  const wv = $('#syncStack webview.on');
  if (!wv) return toast('Chưa mở Drive nguồn', 'err');
  const b = $('#qFromDrive');
  b.disabled = true;
  try {
    await call('transfer:capture', S.sel.syncSrc);
    const r = await call('drive:queueSelected', wv.getWebContentsId());
    toast(r.count > 1 ? `Đang đưa ${r.count} mục vào hàng chờ — xem tiến trình trong Hàng chờ` : 'Đang đưa mục đã chọn vào hàng chờ', 'info');
  } catch (e) { toast(esc(e.message), 'err'); }
  finally { b.disabled = false; }
};

$('#syncSrc').onchange = (e) => { S.sel.syncSrc = e.target.value; renderSync(); };

function renderQueue() {
  const sel = new Set($$('#queue input:checked').map((i) => i.value));
  const L = { downloading: 'Đang tải về', ready: 'Sẵn sàng', uploading: 'Đang chuyển', done: 'Đã chuyển', error: 'Lỗi' };
  $('#queue').innerHTML = S.queue.map((q) => {
    const dl = q.status === 'downloading';
    const pct = q.size ? Math.min(100, Math.round(((q.received || 0) / q.size) * 100)) : 0;
    return `<label class="${dl ? 'dl' : ''}"><input type="checkbox" value="${q.id}" ${dl ? 'disabled' : ''} ${!dl && (sel.has(q.id) || (!sel.size && q.status === 'ready')) ? 'checked' : ''}/>
      <span class="n" title="${esc(q.path)}">${esc(q.name)}${dl ? `<span class="qbar"><i style="width:${pct}%"></i></span>` : ''}</span>
      <span class="muted small">${dl ? (q.size ? pct + '%' : fmtBytes(q.received || 0)) : fmtBytes(q.size)}</span><span class="pill ${q.status}">${L[q.status] || q.status}</span></label>`;
  }).join('') || `<div class="empty small">${icon('inbox')}<div>Hàng chờ trống.<br/>Chọn tệp ở Drive nguồn rồi bấm <b>Thêm mục đã chọn vào hàng chờ</b>.</div></div>`;
  updateTransferButtons();
}
// Trạng thái nút Chuyển / Dừng
function updateTransferButtons() {
  const downloading = S.queue.some((q) => q.status === 'downloading');
  const uploading = !!S.uploading;
  if ($('#doTransfer')) {
    $('#doTransfer').disabled = uploading;
    $('#doTransfer').innerHTML = uploading ? '<span class="spinner"></span>Đang chuyển…' : icon('sync') + 'Chuyển các mục trong hàng chờ';
  }
  if ($('#doMove')) {
    $('#doMove').disabled = uploading || downloading;
    $('#doMove').innerHTML = (uploading || downloading) ? '<span class="spinner"></span>Đang di chuyển…' : icon('sync') + 'Di chuyển thư mục đã chọn';
  }
  $('#stopTransfer').hidden = !(downloading || uploading);
}
function log(html) {
  $('#transferLog').insertAdjacentHTML('afterbegin', `<div>${html}</div>`);
}
$('#qAll').onchange = (e) => $$('#queue input').forEach((i) => { i.checked = e.target.checked; });
$('#qLocal').onclick = async () => { S.queue = await call('transfer:addLocal'); renderQueue(); };
$('#qRemove').onclick = async () => { S.queue = await call('transfer:remove', $$('#queue input:checked').map((i) => i.value)); renderQueue(); };
$('#linkAdd').onclick = async () => {
  const links = $('#linkInput').value.split(/[\s,]+/).filter(Boolean);
  if (!links.length || !S.sel.syncSrc) return;
  const r = await call('transfer:links', S.sel.syncSrc, links);
  $('#linkInput').value = '';
  if (r.bad.length) toast(`Không nhận dạng được ${r.bad.length} liên kết (liên kết thư mục: hãy tải xuống từ Drive bên trái)`, 'err');
  else toast(`Đang tải ${links.length} tệp vào hàng chờ…`);
};
$('#doTransfer').onclick = async () => {
  const ids = $$('#queue input:checked').map((i) => i.value);
  const dests = $$('#destChecks input:checked').map((i) => ({ accId: i.value, folderId: S.destSel[i.value]?.id || '' }));
  if (!ids.length) return toast('Chọn ít nhất một tệp trong hàng chờ', 'err');
  if (!dests.length) return toast('Chọn ít nhất một tài khoản đích', 'err');
  S.uploading = true; updateTransferButtons();
  try {
    const res = await call('transfer:upload', ids, dests, '');
    if (!S.stopped) {
      const ok = res.filter((r) => r.ok).length;
      toast(`Hoàn tất: ${ok}/${res.length} tài khoản`, ok === res.length ? 'ok' : 'err');
    }
  } catch (e) { toast(esc(e.message), 'err'); }
  finally { S.uploading = false; S.stopped = false; updateTransferButtons(); }
};
$('#stopTransfer').onclick = async () => {
  S.stopped = true; S.pendingMove = null; moveProg('');
  const n = await call('transfer:stop');
  log('⏹ Đã dừng theo yêu cầu');
  toast(n ? 'Đã dừng' : 'Không có gì đang chạy', 'info');
};

hub.on('transfer:queue', (q) => { S.queue = q; if (S.view === 'sync') renderQueue(); checkPendingMove(); });
hub.on('transfer:status', (s) => {
  if (s.state === 'stopped' || s.state === 'finished') return;
  const m = { start: `⏳ Bắt đầu chuyển ${s.total} tệp lên <b>${esc(s.email)}</b>`, progress: `⬆️ ${esc(s.email)}: ${s.done}/${s.total}`, done: `✅ Đã chuyển ${s.total} tệp lên <b>${esc(s.email)}</b>`, error: `❌ ${esc(s.email)}: ${esc(s.error)}` }[s.state];
  if (s.state === 'progress') { const first = $('#transferLog div'); if (first && first.dataset.p === s.accId) { first.innerHTML = m; return; } }
  log(m);
  if (s.state === 'progress') $('#transferLog div').dataset.p = s.accId;
});
const dlToasts = {};
hub.on('download:progress', (d) => {
  if (!d.capturing) {
    const pct = d.total ? Math.round((d.received / d.total) * 100) : null;
    if (d.state === 'progressing') {
      if (!dlToasts[d.id]) dlToasts[d.id] = toast(`Đang tải xuống <b>${esc(d.name)}</b>…`, 'busy');
      dlToasts[d.id].update(`Đang tải xuống <b>${esc(d.name)}</b> ${pct != null ? pct + '%' : fmtBytes(d.received)}`, 'busy');
      return;
    }
    const t = dlToasts[d.id] || toast('', 'busy');
    delete dlToasts[d.id];
    if (d.state === 'completed') {
      t.update(`Đã tải xong <b>${esc(d.name)}</b> (${fmtBytes(d.received)}) — <a href="#" data-showfile="${esc(d.path)}">Mở thư mục</a>`, 'ok');
    } else if (d.state === 'cancelled') t.update(`Đã hủy tải <b>${esc(d.name)}</b>`, 'info');
    else t.update(`Tải xuống thất bại: <b>${esc(d.name)}</b>`, 'err');
    return;
  }
  // tệp đang vào hàng chờ: tiến trình hiển thị ngay trong danh sách hàng chờ
});

// --- tác vụ đồng bộ thư mục ---
$('#jobPick').onclick = async () => { const p = await call('dialog:folder'); if (p) $('#jobPath').value = p; };
$('#jobSave').onclick = async () => {
  const job = { localPath: $('#jobPath').value, destAccs: $$('#jobAccs input:checked').map((i) => i.value), folder: $('#jobFolder').value.trim(), intervalMin: +$('#jobInterval').value };
  if (!job.localPath) return toast('Chọn thư mục trên máy tính', 'err');
  if (!job.destAccs.length) return toast('Chọn ít nhất một Drive', 'err');
  S.jobs = await call('sync:save', job);
  $('#jobPath').value = ''; $('#jobFolder').value = '';
  renderJobs();
  toast('Đã lưu tác vụ đồng bộ', 'ok');
};
const jobState = {};
function renderJobs() {
  const iv = (m) => (!m ? 'Thủ công' : m < 60 ? `Mỗi ${m} phút` : m < 1440 ? `Mỗi ${m / 60} giờ` : 'Mỗi ngày');
  $('#jobList').innerHTML = S.jobs.map((j) => `<div class="job">
    <div class="top">${icon('folder')}<b title="${esc(j.localPath)}">${esc(j.localPath)}</b>
      <button class="btn" data-run="${j.id}">${icon('play')}Chạy</button><button class="btn icon danger" data-del="${j.id}">${icon('trash')}</button></div>
    <div class="chips">${j.destAccs.map((id) => acc(id)).filter(Boolean).map((a) => `<span class="chip" style="--c:${a.color};cursor:default">${avatar(a, 'sm')}${esc(a.email)}</span>`).join('')}</div>
    <div class="small muted">${iv(j.intervalMin)} · ${j.folder ? 'Thư mục Drive chỉ định' : 'Drive của tôi'} · ${j.lastRun ? 'Lần chạy cuối ' + ago(j.lastRun) : 'Chưa chạy'}
      ${j.lastError ? `<br/><span style="color:var(--err)">${esc(j.lastError)}</span>` : ''}</div>
    ${jobState[j.id] ? `<div class="small" style="color:var(--accent)">${jobState[j.id]}</div>` : ''}
  </div>`).join('') || `<div class="empty small">${icon('folder')}<div>Chưa có tác vụ nào</div></div>`;
  $$('[data-run]').forEach((b) => { b.onclick = async () => { b.disabled = true; try { const r = await call('sync:run', b.dataset.run); toast(`Đồng bộ xong: ${r.total ?? 0} tệp mới`, 'ok'); } catch (e) { toast(e.message, 'err'); } }; });
  $$('[data-del]').forEach((b) => { b.onclick = async () => { if (confirm('Xóa tác vụ đồng bộ này?')) { S.jobs = await call('sync:delete', b.dataset.del); renderJobs(); } }; });
}
hub.on('sync:status', (s) => {
  const a = acc(s.accId);
  jobState[s.id] = s.state === 'progress' ? `⬆️ ${esc(a?.email)}: ${s.done}/${s.total}` : s.state === 'start' ? `⏳ ${esc(a?.email)}: ${s.total} tệp cần tải` : s.state === 'error' ? '' : '';
  if (S.view === 'sync') renderJobs();
});
hub.on('sync:jobs', (j) => { S.jobs = j; if (S.view === 'sync') renderJobs(); });

// ---------------- Gemini ----------------
function renderGemini() {
  const g = google();
  if (!acc(S.sel.gemini)) S.sel.gemini = g[0]?.id || null;
  $('#geminiChips').innerHTML = chipsHtml(g, S.sel.gemini);
  $$('#geminiChips .chip').forEach((c) => { c.onclick = () => { S.sel.gemini = c.dataset.id; renderGemini(); }; });
  if (!S.sel.gemini) return placeholder('geminiStack', `Thêm một tài khoản Google để dùng AI Agent.<br/><button class="btn primary" data-action="add" style="margin-top:12px">${icon('plus')}Thêm tài khoản</button>`);
  ensureWeb('geminiStack', acc(S.sel.gemini), URLS.gemini);
}
$('#geminiNew').onclick = () => { const wv = $('#geminiStack webview.on'); if (wv) wv.loadURL(URLS.gemini); };

// ---------------- Search ----------------
let searchType = '';
function renderSearch() {
  const sel = S.sel.search;
  $('#searchAcc').innerHTML = `<option value="">🔒 Không đăng nhập</option>` + google().map((a) => `<option value="${a.id}">${esc(a.email)}</option>`).join('');
  $('#searchAcc').value = acc(sel) ? sel : '';
  ensureWeb('searchStack', acc(S.sel.search) || null, URLS.search);
  setTimeout(() => $('#searchInput').focus(), 50);
}
$('#searchAcc').onchange = (e) => { S.sel.search = e.target.value; renderSearch(); };
$('#searchTypes').addEventListener('click', (e) => {
  const b = e.target.closest('[data-t]');
  if (!b) return;
  searchType = b.dataset.t;
  $$('#searchTypes .chip').forEach((x) => x.classList.toggle('active', x === b));
  if ($('#searchInput').value.trim()) $('#searchForm').requestSubmit();
});
$('#searchForm').onsubmit = (e) => {
  e.preventDefault();
  const q = $('#searchInput').value.trim();
  if (!q) return;
  const url = searchType === 'maps'
    ? `https://www.google.com/maps/search/${encodeURIComponent(q)}`
    : `https://www.google.com/search?hl=vi&q=${encodeURIComponent(q)}${searchType ? '&tbm=' + searchType : ''}`;
  ensureWeb('searchStack', acc(S.sel.search) || null, URLS.search).loadURL(url).catch(() => {});
};

// ---------------- Cài đặt ----------------
async function renderSettings() {
  const info = await call('app:info');
  const st = S.settings;
  $('#settingsBody').innerHTML = `
  <div class="card">
    <h3>${icon('moon')}Giao diện</h3>
    <div class="set-row"><div class="t">Chủ đề<small>Giao diện tối hoặc sáng</small></div>
      <select id="setTheme"><option value="dark">Tối</option><option value="light">Sáng</option></select></div>
    <div class="set-row"><div class="t">Thông báo thư mới<small>Hiện thông báo Windows khi có thư mới (kiểm tra mỗi 2 phút)</small></div>
      <input type="checkbox" id="setNotify" ${st.notify !== false ? 'checked' : ''}/></div>
  </div>
  <div class="card">
    <h3>${icon('login')}Đăng nhập</h3>
    <div class="set-row"><div class="t">Nhận dạng trình duyệt khi đăng nhập<small>Nếu Google báo "This browser or app may not be secure", hãy đổi sang chế độ khác rồi bấm Thêm tài khoản lại.</small></div>
      <select id="setUA"><option value="firefox">Firefox (khuyên dùng)</option><option value="chrome">Chrome</option><option value="edge">Edge</option></select></div>
    <div class="set-row"><div class="t">Thư mục lưu tệp tải về<small id="dlDirTxt">${esc(st.downloadDir || 'Mặc định: thư mục Downloads của Windows')}</small></div>
      <button class="btn" id="pickDl">${icon('folder')}Đổi</button><button class="btn icon" id="openDl" title="Mở thư mục">${icon('external')}</button></div>
    <div class="set-row"><div class="t">Hỏi nơi lưu mỗi lần tải<small>Hiện hộp thoại chọn vị trí và tên tệp khi tải từ Drive/Photos</small></div>
      <input type="checkbox" id="askSave" ${st.askSave ? 'checked' : ''}/></div>
  </div>
  <div class="card full">
    <h3>${icon('download')}Cập nhật ứng dụng</h3>
    <div class="set-row"><div class="t">Phiên bản hiện tại: <b>v${esc(info.version)}</b><small id="updLast">${S.settings.lastUpdateCheck ? 'Kiểm tra lần cuối ' + ago(S.settings.lastUpdateCheck) : 'Chưa kiểm tra'}</small></div>
      <button class="btn primary" id="setCheckUpd">${icon('refresh')}Kiểm tra cập nhật</button></div>
    <div class="set-row"><div class="t">Tự động kiểm tra cập nhật<small>Kiểm tra khi mở ứng dụng và mỗi 6 giờ</small></div>
      <input type="checkbox" id="setAutoUpd" ${st.autoUpdate !== false ? 'checked' : ''}/></div>
  </div>
  <div class="card full">
    <h3>${icon('users')}Quản lý tài khoản<span class="grow"></span><button class="btn primary" data-action="add">${icon('plus')}Thêm</button></h3>
    ${S.accounts.map((a) => `<div class="set-row" data-id="${a.id}">
      ${avatar(a)}<div class="t"><input class="acc-name" value="${esc(a.name || '')}" placeholder="Tên hiển thị" style="padding:5px 9px;width:260px"/><small>${esc(a.email)} · ${a.provider === 'google' ? 'Google' : a.provider === 'microsoft' ? 'Microsoft' : 'Email IMAP/SMTP'}</small></div>
      <input type="color" class="acc-color" value="${a.color}" title="Màu nhận diện"/>
      <button class="btn acc-mail">${icon('key')}${a.mail?.configured ? 'Hộp thư' : 'Kết nối hộp thư'}</button>
      ${a.provider !== 'imap' ? `<button class="btn acc-relogin">${icon('login')}Đăng nhập lại</button>` : ''}
      <button class="btn danger acc-remove">${icon('trash')}Gỡ</button></div>`).join('') || '<div class="muted">Chưa có tài khoản.</div>'}
  </div>
  <div class="card full">
    <h3>${icon('cloud')}Thông tin</h3>
    <div class="small muted" style="line-height:1.7">GCloud Hub v${esc(info.version)} · Chromium ${esc(info.chrome)}<br/>
    Ứng dụng không dùng Google API và không lưu mật khẩu. Mỗi tài khoản đăng nhập trong một phiên trình duyệt riêng biệt (cookie được lưu trong thư mục AppData của bạn).
    Các thao tác nền (đọc dung lượng, gửi thư, tải lên Drive) chạy trong cửa sổ ẩn bằng chính phiên đó.</div>
  </div>`;
  $('#setTheme').value = st.theme || 'dark';
  $('#setUA').value = st.loginUA || 'firefox';
  $('#setTheme').onchange = async (e) => { S.settings = await call('settings:set', { theme: e.target.value }); document.documentElement.dataset.theme = e.target.value; };
  $('#setUA').onchange = async (e) => {
    S.settings = await call('settings:set', { loginUA: e.target.value });
    S.ua = (await call('app:info')).ua;
    $$('webview').forEach((w) => w.remove());
    toast('Đã áp dụng chế độ nhận dạng mới. Hãy thử thêm hoặc đăng nhập lại tài khoản.', 'ok');
  };
  $('#setNotify').onchange = async (e) => { S.settings = await call('settings:set', { notify: e.target.checked }); };
  $('#openDl').onclick = () => call('shell:downloads');
  $('#setCheckUpd').onclick = async () => { await checkUpdate(); S.settings = await call('settings:get'); $('#updLast').textContent = 'Kiểm tra lần cuối ' + ago(S.settings.lastUpdateCheck); };
  $('#setAutoUpd').onchange = async (e) => { S.settings = await call('settings:set', { autoUpdate: e.target.checked }); };
  $('#pickDl').onclick = async () => { S.settings = await call('dialog:downloadDir'); $('#dlDirTxt').textContent = S.settings.downloadDir || 'Mặc định: thư mục Downloads của Windows'; };
  $('#askSave').onchange = async (e) => { S.settings = await call('settings:set', { askSave: e.target.checked }); };
  $$('#settingsBody .set-row[data-id]').forEach((row) => {
    const id = row.dataset.id;
    $('.acc-name', row).onchange = async (e) => { await call('accounts:update', id, { name: e.target.value }); await loadAccounts(); };
    $('.acc-color', row).onchange = async (e) => { await call('accounts:update', id, { color: e.target.value }); await loadAccounts(); renderSettings(); };
    if ($('.acc-relogin', row)) $('.acc-relogin', row).onclick = () => relogin(id);
    $('.acc-mail', row).onclick = () => openMailSetup(id);
    $('.acc-remove', row).onclick = async () => {
      const a = acc(id);
      if (!confirm(`Gỡ tài khoản ${a.email} khỏi ứng dụng?\nPhiên đăng nhập và cookie của tài khoản này sẽ bị xóa.`)) return;
      dropWebviews(id);
      await call('accounts:remove', id);
      delete S.stats[id];
      await loadAccounts();
      renderSettings();
      toast(`Đã gỡ ${esc(a.email)}`, 'ok');
    };
  });
}

async function relogin(id) {
  try { await call('accounts:relogin', id); }
  catch (e) { toast(esc(e.message), 'err'); return; }
  finally { closeLoginWait(); }
  dropWebviews(id);
  await refreshInbox(id, false);
  await refreshStorage(id);
  rerender();
  if (S.view !== 'dashboard') go(S.view);
}
window.relogin = relogin;
window.go = go;

// ---------------- Thêm tài khoản ----------------
let provSel = '';
const PROV_UI = {
  google: { icon: 'g', t: 'Google', d: 'Gmail, Google Workspace — Drive, Photos, AI Agent & thư' },
  imap: { icon: 'mail', t: 'Email doanh nghiệp', d: 'Email tên miền riêng, Yahoo, Zoho… (IMAP/SMTP)' },
  microsoft: { icon: 'ms', t: 'Microsoft', d: 'Outlook, Hotmail, Microsoft 365' },
};
const HINTS = {
  imap: 'Ứng dụng kết nối trực tiếp tới máy chủ thư của bạn (giống Outlook). Thông tin máy chủ thường có trong email bàn giao của nhà cung cấp hosting/email.',
};
async function openAdd() {
  $('#provGrid').innerHTML = Object.entries(PROV_UI).map(([k, v]) => `<button class="prov ${k === provSel ? 'sel' : ''}" data-p="${k}"><div class="pi">${icon(v.icon)}</div><div><b>${v.t}</b><small>${v.d}</small></div></button>`).join('');
  // Google / Microsoft: bấm là mở ngay cửa sổ đăng nhập
  $$('#provGrid .prov').forEach((b) => { b.onclick = () => {
    if (b.dataset.p === 'imap') { provSel = 'imap'; return openAdd(); }
    startBrowserLogin(b.dataset.p);
  }; });
  const imapMode = provSel === 'imap';
  const ex = $('#provExtra');
  ex.style.display = imapMode ? 'flex' : 'none';
  $('#addHint').style.display = imapMode ? '' : 'none';
  $('#addModal .foot').style.display = imapMode ? '' : 'none';
  if (imapMode) {
    const draw = async (p, em) => {
      const email = em ?? $('#adEmail')?.value ?? '';
      const name = $('#adName')?.value || '';
      ex.innerHTML = await serverForm('ad', { email, preset: p, withEmail: true });
      if (name) $('#adName').value = name;
      bindServerForm('ad', (np, nem) => draw(np, nem));
    };
    await draw();
  }
  $('#addHint').textContent = HINTS.imap;
  $('#addGo').innerHTML = icon('check') + 'Kiểm tra & thêm';
  $('#addModal').classList.add('open');
}
window.openAdd = openAdd;
$('#addAccountBtn').onclick = () => { provSel = ''; openAdd(); };

async function startBrowserLogin(provider) {
  $('#addModal').classList.remove('open');
  const t = toast(`Đang mở cửa sổ đăng nhập ${provider === 'google' ? 'Google' : 'Microsoft'}…`, 'busy');
  try {
    const a = await call('accounts:add', { provider }).finally(() => { closeLoginWait(); });
    t.update(`Đã thêm <b>${esc(a.email)}</b>`, 'ok');
    await loadAccounts();
    if (a.provider === 'google') { refreshStorage(a.id).then(rerender); }
    openAccountMail(a.id);
  } catch (err) { t.update(esc(err.message), 'err'); }
}
$('#addGo').onclick = async () => {
  {
    const cfg = { ...readServerForm('ad'), email: $('#adEmail').value.trim(), name: $('#adName').value.trim() };
    if (!cfg.email || !cfg.password) return toast('Nhập email và mật khẩu', 'err');
    const btn = $('#addGo'); btn.disabled = true; btn.innerHTML = '<span class="spinner"></span>Đang kiểm tra kết nối…';
    try {
      const a = await call('mail:addImap', cfg);
      $('#addModal').classList.remove('open');
      toast(`Đã thêm <b>${esc(a.email)}</b>`, 'ok');
      await afterConnect(a.id);
      openAccountMail(a.id);
    } catch (err) { toast(esc(err.message), 'err'); }
    finally { btn.disabled = false; btn.innerHTML = icon('check') + 'Kiểm tra & thêm'; }
    return;
  }
};

document.addEventListener('click', (e) => {
  const sf = e.target.closest('[data-showfile]');
  if (sf) { e.preventDefault(); return call('shell:showItem', sf.dataset.showfile); }
  const t = e.target.closest('[data-action="add"],[data-go],[data-relogin],[data-setupacc]');
  if (!t) return;
  e.preventDefault();
  if (t.dataset.action === 'add') { provSel = ''; openAdd(); }
  else if (t.dataset.go) go(t.dataset.go);
  else if (t.dataset.relogin) relogin(t.dataset.relogin);
  else if (t.dataset.setupacc) openMailSetup(t.dataset.setupacc);
});
$$('[data-close]').forEach((b) => { b.onclick = () => b.closest('.modal-bg').classList.remove('open'); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') $$('.modal-bg.open').forEach((m) => { if (!['pwModal', 'loginWait', 'updModal'].includes(m.id)) m.classList.remove('open'); }); });

// ---------------- Dòng tính năng nổi bật ----------------
function startTicker() {
  let k = 0;
  const show = () => {
    const h = APP_INFO.highlights[k++ % APP_INFO.highlights.length];
    const el = $('#ticker');
    el.classList.remove('in');
    setTimeout(() => { el.innerHTML = `<span class="tk-ico">${icon(h.icon)}</span><span>${esc(h.text)}</span>`; el.classList.add('in'); }, 250);
  };
  show();
  setInterval(show, 4500);
}

function heroHtml() {
  const g = google().length;
  const feats = [['mail', 'Hộp thư hợp nhất'], ['drive', 'Nhiều Google Drive'], ['image', 'Google Photos'], ['sync', 'Đồng bộ Drive'], ['spark', 'AI Agent'], ['search', 'Tìm kiếm mọi thứ'], ['shield', 'Không lưu mật khẩu']];
  return `<div class="hero">
    <div class="hero-main">
      <div class="hero-title"><span class="hero-badge">${icon('bolt')}${esc(APP_INFO.name)} by ${esc(APP_INFO.author)}</span>
        <h2 title="Đăng nhập một lần, quản lý tất cả: thư, Drive, Photos, AI Agent và tìm kiếm ngay trong ứng dụng.">${esc(APP_INFO.slogan)}</h2></div>
      <div class="hero-feats">${feats.map(([i, t]) => `<span>${icon(i)}${t}</span>`).join('')}</div>
    </div>
    <div class="hero-side">
      <div class="hero-stat"><b>${S.accounts.length}</b><small>tài khoản</small></div>
      <div class="hero-stat"><b>${g}</b><small>Google Drive</small></div>
      <button class="btn primary" id="dashRefresh" title="Làm mới tất cả">${icon('refresh')}Làm mới</button>
    </div>
  </div>`;
}

$('#dashRefresh').onclick = async () => {
  const b = $('#dashRefresh');
  b.classList.add('spin'); b.disabled = true;
  try { await refreshAll({ force: true }); } finally { b.classList.remove('spin'); b.disabled = false; }
};

// ---------------- Thông tin ứng dụng ----------------
async function openAbout() {
  const info = await call('app:info');
  $('#abName').innerHTML = `${esc(APP_INFO.name)} <span class="by">by ${esc(APP_INFO.author)}</span>`;
  $('#abVer').textContent = `Phiên bản ${info.version}`;
  $('#abSlogan').textContent = APP_INFO.slogan;
  $('#abCopy').innerHTML = `© ${APP_INFO.year} <b>${esc(APP_INFO.owner)}</b> (${esc(APP_INFO.author)}). Bảo lưu mọi quyền.<br/>
    Phần mềm được phát triển và giữ bản quyền bởi ${esc(APP_INFO.owner)}. Nghiêm cấm sao chép, chỉnh sửa hoặc phân phối lại khi chưa có sự đồng ý bằng văn bản của tác giả.<br/>
    <span class="muted small">Gmail, Google Drive, Gemini và Google là nhãn hiệu của Google LLC. Ứng dụng này không liên kết với Google.</span>`;
  $('#abContact').innerHTML = `<div class="contact-author">${icon('user')}<span>Tác giả</span><b>${esc(APP_INFO.owner)}</b></div>
    <div class="contact-logos">${APP_INFO.contact.map((c) => `<button class="clogo" data-href="${esc(c.href)}" title="${esc(c.label)}" style="--b:${c.color}">
      <span class="lg">${c.icon ? icon(c.icon) : `<em class="${c.text.length === 1 ? 'one' : ''}">${esc(c.text)}</em>`}<img src="../../assets/logos/${c.key}.png" alt="" /></span><small>${esc(c.label)}</small></button>`).join('')}</div>`;
  $$('#abContact .clogo img').forEach((img) => { img.onload = () => img.parentElement.classList.add('has-img'); img.onerror = () => img.remove(); });
  $$('#abContact [data-href]').forEach((r) => { r.onclick = () => call('shell:open', r.dataset.href); });
  const dn = APP_INFO.donate;
  $('#abCoffee').innerHTML = `
    <div class="cf-head"><span class="cup">☕</span><b>${esc(dn.title)}</b></div>
    <p>${esc(dn.text)}</p>
    <div class="cf-body">
      <div class="cf-qr"><img src="../../assets/vietqr-bidv.png" alt="Mã QR chuyển khoản BIDV" /><small>Quét bằng app ngân hàng bất kỳ</small></div>
      <div class="cf-info">
        <div><small>Ngân hàng</small><b>${esc(dn.bank)}</b></div>
        <div><small>Số tài khoản</small><b class="acc-no">${esc(dn.account)}</b>
          <button class="btn icon" id="cfCopy" title="Sao chép số tài khoản">${icon('draft')}</button></div>
        <div><small>Chủ tài khoản</small><b>${esc(dn.holder)}</b></div>
      </div>
    </div>`;
  $('#cfCopy').onclick = async () => { await navigator.clipboard.writeText(dn.account); toast('Đã sao chép số tài khoản', 'ok'); };
  hydrateIcons($('#aboutModal'));
  $('#aboutModal').classList.add('open');
}
window.openAbout = openAbout;
$('#aboutBtn').onclick = openAbout;
$('#authorBtn').onclick = openAbout;
$('#exploreBtn').onclick = () => call('shell:open', 'https://mrhuynh.net/tools');
$('#guideBtn').onclick = async () => {
  try { const u = await call('guide:url'); if (u) call('shell:open', u); }
  catch (e) { call('shell:open', 'https://mrhuynh.net/tools'); }
};

// ---------------- Khởi động ----------------
async function loadAccounts() {
  S.accounts = await call('accounts:list');
  renderSidebar();
  if (S.view !== 'settings') go(S.view);
}

async function init() {
  hydrateIcons();
  startTicker();
  const info = await call('app:info');
  S.ua = info.ua;
  S.settings = await call('settings:get');
  document.documentElement.dataset.theme = S.settings.theme || 'dark';
  const cached = await call('stats:cached');
  S.stats = cached || {};
  Object.values(S.stats).forEach((s) => (s.entries || []).forEach((e) => S.seen.add(e.link)));
  S.queue = await call('transfer:queue');
  S.jobs = await call('sync:jobs');
  await loadAccounts();
  if ('Notification' in window && Notification.permission === 'default') Notification.requestPermission();
  refreshAll();
  const autoUpd = () => { if (S.settings.autoUpdate !== false) checkUpdate({ silent: true }); };
  setTimeout(autoUpd, 8000);
  setInterval(autoUpd, 6 * 3600e3);
  setInterval(async () => {
    if (S.settings.notify === false) S.seenInit = false;
    await Promise.all(S.accounts.map((a) => refreshInbox(a.id, true)));
    if (S.view === 'mail') mailPoll();
    S.seenInit = true;
    rerender();
  }, 120000);
  setInterval(() => { if (S.view === 'dashboard') renderDashboard(); }, 60000);
}
// Chỉ khởi động khi mọi script (kể cả mailui.js) đã tải xong
window.addEventListener('DOMContentLoaded', init);

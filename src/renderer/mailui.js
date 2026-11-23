/* global S, $, $$, esc, icon, call, acc, avatar, toast, fmtBytes, go, hub, rerender, refreshInbox, renderSidebar, loadAccounts, hydrateIcons */
// =================== Trình quản lý thư kiểu Outlook ===================
const M = {
  sel: { kind: 'unified' },   // { kind:'unified' } | { kind:'box', accId, path, name }
  folders: {},                // accId -> [folders] | { error }
  collapsed: new Set(),
  msgs: [], page: 0, more: false, search: '',
  checked: new Set(),
  open: null,                 // thư đang đọc
  loading: false,
  reqId: 0,
};
const mailAccounts = () => S.accounts.filter((a) => a.mail?.configured);
const keyOf = (m) => `${m.accId}|${m.path}|${m.uid}`;

// ---------- Định dạng ----------
function mDate(t, full = false) {
  if (!t) return '';
  const d = new Date(t), now = new Date();
  if (full) return d.toLocaleString('vi-VN', { weekday: 'long', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
  if (d.toDateString() === now.toDateString()) return d.toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit' });
  const y = new Date(now); y.setDate(now.getDate() - 1);
  if (d.toDateString() === y.toDateString()) return 'Hôm qua';
  if (d.getFullYear() === now.getFullYear()) return d.toLocaleDateString('vi-VN', { day: '2-digit', month: '2-digit' });
  return d.toLocaleDateString('vi-VN');
}
function hue(s = '') { let h = 0; for (const c of s) h = (h * 31 + c.charCodeAt(0)) % 360; return h; }
function personAvatar(p, size = '') {
  const n = (p?.name || p?.address || '?').trim();
  const parts = n.replace(/["']/g, '').split(/[\s@._-]+/).filter(Boolean);
  const ini = ((parts[0]?.[0] || '?') + (parts.length > 1 ? parts[parts.length - 1][0] : '')).toUpperCase();
  return `<div class="avatar ${size}" style="background:hsl(${hue(p?.address || n)} 55% 48%)">${esc(ini)}</div>`;
}
const pName = (p) => p?.name || p?.address || '';
const pFull = (p) => (p?.name ? `${p.name} <${p.address}>` : p?.address || '');

// ---------- Cây thư mục ----------
async function loadFolders(accId) {
  if (!M.folders[accId]) { const c = await call('mail:cachedFolders', accId).catch(() => null); if (c) { M.folders[accId] = c; renderMailTree(); } }
  try { M.folders[accId] = await call('mail:folders', accId); } catch (e) { if (!Array.isArray(M.folders[accId])) M.folders[accId] = { error: e.message }; }
}

function renderMailTree() {
  const accs = S.accounts;
  const totalUnread = mailAccounts().reduce((s, a) => s + (M.folders[a.id]?.find?.((f) => f.special === '\\Inbox')?.unread ?? S.stats[a.id]?.unread ?? 0), 0);
  const isSel = (accId, p) => M.sel.kind === 'box' && M.sel.accId === accId && M.sel.path === p;
  let html = `<div class="mc-node top ${M.sel.kind === 'unified' ? 'sel' : ''}" data-unified>
      ${icon('inbox')}<span class="n">Tất cả hộp thư đến</span>${totalUnread ? `<span class="cnt">${totalUnread}</span>` : ''}</div>`;
  for (const a of accs) {
    const f = M.folders[a.id];
    const col = M.collapsed.has(a.id);
    html += `<div class="mc-acc" style="--c:${a.color}">
      <div class="mc-acc-head" data-toggle="${a.id}">${icon('chevron', col ? 'rot' : '')}${avatar(a, 'sm')}<span class="n" title="${esc(a.email)}">${esc(a.email)}</span></div>`;
    if (!col) {
      if (!a.mail?.configured) {
        html += `<div class="mc-setup" data-setup="${a.id}">${icon('key')}<span>Kết nối hộp thư</span></div>`;
      } else if (!f) {
        html += `<div class="mc-node muted"><span class="spinner"></span><span class="n">Đang tải thư mục…</span></div>`;
      } else if (f.error) {
        html += `<div class="mc-node err" data-setup="${a.id}" title="${esc(f.error)}">${icon('spam')}<span class="n">Lỗi kết nối — bấm để sửa</span></div>`;
      } else {
        const special = f.filter((x) => x.special);
        const labels = f.filter((x) => !x.special);
        html += special.concat(labels).map((x) => `<div class="mc-node ${isSel(a.id, x.path) ? 'sel' : ''} ${x.special ? '' : 'label'}" data-acc="${a.id}" data-path="${esc(x.path)}" data-name="${esc(x.name)}">
          ${icon(x.icon)}<span class="n">${esc(x.name)}</span>${x.unread && x.special !== '\\Sent' && x.special !== '\\Drafts' ? `<span class="cnt">${x.unread}</span>` : x.special === '\\Drafts' && x.total ? `<span class="cnt soft">${x.total}</span>` : ''}</div>`).join('');
      }
    }
    html += '</div>';
  }
  if (!accs.length) html += `<div class="empty small">${icon('mail')}<div>Chưa có tài khoản</div><button class="btn primary" data-action="add" style="margin-top:8px">${icon('plus')}Thêm tài khoản</button></div>`;
  $('#mcTree').innerHTML = html;
}

$('#mcTree').addEventListener('click', (e) => {
  const t = e.target.closest('[data-unified],[data-toggle],[data-setup],[data-path]');
  if (!t) return;
  if (t.dataset.toggle) { M.collapsed.has(t.dataset.toggle) ? M.collapsed.delete(t.dataset.toggle) : M.collapsed.add(t.dataset.toggle); return renderMailTree(); }
  if (t.dataset.setup) return openMailSetup(t.dataset.setup);
  if (t.hasAttribute('data-unified')) selectBox({ kind: 'unified' });
  else selectBox({ kind: 'box', accId: t.dataset.acc, path: t.dataset.path, name: t.dataset.name });
});

function selectBox(sel) {
  M.sel = sel;
  M.search = '';
  $('#mcSearch').value = '';
  M.open = null;
  renderRead();
  renderMailTree();
  loadList(true);
}

// ---------- Danh sách thư ----------
async function loadList(reset = true) {
  if (reset) { M.page = 0; M.msgs = []; M.checked.clear(); }
  const id = ++M.reqId;
  M.loading = true;
  // Hiện ngay danh sách đã lưu trên máy, rồi cập nhật từ máy chủ ở nền
  if (reset && !M.search) {
    const c = M.sel.kind === 'unified' ? await call('mail:cachedUnified').catch(() => null) : await call('mail:cachedList', M.sel.accId, M.sel.path).catch(() => null);
    if (c && id === M.reqId && !M.msgs.length) { M.msgs = c.messages; M.more = c.more; }
  }
  renderList();
  try {
    let r;
    if (M.sel.kind === 'unified') {
      if (!mailAccounts().length) { M.loading = false; return renderList(); }
      r = await call('mail:unified', { page: M.page });
      (r.errors || []).forEach((x) => { M.folders[x.accId] = { error: x.error }; });
      if (r.errors?.length) renderMailTree();
    } else {
      r = await call('mail:list', M.sel.accId, M.sel.path, { page: M.page, search: M.search });
    }
    if (id !== M.reqId) return;
    M.msgs = reset ? r.messages : M.msgs.concat(r.messages);
    M.more = r.more;
    M.total = r.total;
    prefetchTop(r.messages);
  } catch (e) {
    if (id !== M.reqId) return;
    toast(esc(e.message), 'err');
  } finally {
    if (id === M.reqId) { M.loading = false; renderList(); }
  }
}

// Tải trước nội dung ~20 thư đầu (theo từng tài khoản/thư mục)
function prefetchTop(msgs) {
  const groups = {};
  msgs.slice(0, 20).forEach((m) => { (groups[`${m.accId}|${m.path}`] ||= []).push(m.uid); });
  Object.entries(groups).forEach(([k, uids]) => { const [a, ...p] = k.split('|'); call('mail:prefetch', a, p.join('|'), uids); });
}

function renderList() {
  const unified = M.sel.kind === 'unified';
  $('#mcBoxName').textContent = unified ? 'Tất cả hộp thư đến' : M.sel.name;
  $('#mcRefresh').classList.toggle('spin', M.loading);
  $('#mcBoxInfo').textContent = M.search ? `Kết quả cho “${M.search}”` : unified ? `${mailAccounts().length} tài khoản` : (M.sel.accId ? acc(M.sel.accId)?.email || '' : '');
  $('#mcSearch').placeholder = unified ? 'Chọn một thư mục để tìm…' : 'Tìm thư (người gửi, tiêu đề, nội dung)…';
  $('#mcSearch').disabled = unified;
  $('#mcBulk').classList.toggle('on', M.checked.size > 0);
  $('#mcCheckAll').checked = M.msgs.length > 0 && M.checked.size === M.msgs.length;
  let html = '';
  if (!M.msgs.length && M.loading) html = `<div class="empty"><span class="spinner"></span><div style="margin-top:8px">Đang tải thư…</div></div>`;
  else if (!M.msgs.length) {
    html = unified && !mailAccounts().length
      ? `<div class="empty">${icon('key')}<div>Chưa có hộp thư nào được kết nối.<br/>Chọn <b>Kết nối hộp thư</b> ở cột bên trái.</div></div>`
      : `<div class="empty">${icon('inbox')}<div>${M.search ? 'Không tìm thấy thư phù hợp' : 'Thư mục trống'}</div></div>`;
  } else {
    let lastGroup = '';
    html = M.msgs.map((m, i) => {
      const g = groupOf(m.date);
      const head = g !== lastGroup ? `<div class="mc-group">${g}</div>` : '';
      lastGroup = g;
      const a = acc(m.accId);
      const sel = M.open && keyOf(M.open) === keyOf(m);
      const isSent = M.sel.kind === 'box' && /Đã gửi|Thư nháp/.test(M.sel.name);
      const who = isSent ? { name: 'Đến: ' + (m.to.map(pName).join(', ') || '(chưa có)'), address: m.to[0]?.address } : m.from;
      return `${head}<div class="mc-item ${m.seen ? '' : 'unread'} ${sel ? 'sel' : ''} ${M.checked.has(keyOf(m)) ? 'checked' : ''}" data-i="${i}" style="--c:${a?.color || 'transparent'}">
        <label class="ck"><input type="checkbox" ${M.checked.has(keyOf(m)) ? 'checked' : ''} data-ck="${i}"/></label>
        ${personAvatar(isSent ? m.to[0] : m.from)}
        <div class="t">
          <div class="r1"><span class="from">${esc(pName(who))}</span>${m.attach ? icon('clip', 'ai') : ''}<span class="date">${mDate(m.date)}</span></div>
          <div class="r2"><span class="subj">${m.answered ? icon('reply', 'ai') : ''}${esc(m.subject)}</span>
            <button class="star ${m.flagged ? 'on' : ''}" data-star="${i}" title="${m.flagged ? 'Bỏ gắn sao' : 'Gắn sao'}">${icon('star')}</button></div>
          ${unified ? `<div class="acc">${esc(a?.email || '')}</div>` : ''}
        </div></div>`;
    }).join('');
    if (M.more) html += `<button class="btn mc-more" id="mcMore" ${M.loading ? 'disabled' : ''}>${M.loading ? '<span class="spinner"></span>' : ''}Tải thêm thư cũ hơn</button>`;
  }
  $('#mcItems').innerHTML = html;
}

function groupOf(t) {
  const d = new Date(t), now = new Date();
  const days = Math.floor((new Date(now.toDateString()) - new Date(d.toDateString())) / 864e5);
  if (days <= 0) return 'Hôm nay';
  if (days === 1) return 'Hôm qua';
  if (days < 7) return 'Tuần này';
  if (d.getMonth() === now.getMonth() && d.getFullYear() === now.getFullYear()) return 'Tháng này';
  return `Tháng ${d.getMonth() + 1}/${d.getFullYear()}`;
}

$('#mcItems').addEventListener('click', async (e) => {
  if (e.target.id === 'mcMore') { M.page++; return loadList(false); }
  const ck = e.target.closest('[data-ck]');
  if (ck) { const m = M.msgs[+ck.dataset.ck]; ck.checked ? M.checked.add(keyOf(m)) : M.checked.delete(keyOf(m)); return renderList(); }
  if (e.target.closest('.ck')) return;
  const st = e.target.closest('[data-star]');
  if (st) { const m = M.msgs[+st.dataset.star]; return doAction([m], m.flagged ? 'unflag' : 'flag'); }
  const it = e.target.closest('.mc-item');
  if (it) openMessage(M.msgs[+it.dataset.i]);
});

let hoverT = null;
$('#mcItems').addEventListener('mouseover', (e) => {
  const it = e.target.closest('.mc-item');
  if (!it) return;
  clearTimeout(hoverT);
  hoverT = setTimeout(() => { const m = M.msgs[+it.dataset.i]; if (m) call('mail:prefetch', m.accId, m.path, [m.uid]); }, 120);
});

$('#mcCheckAll').onchange = (e) => { M.checked = e.target.checked ? new Set(M.msgs.map(keyOf)) : new Set(); renderList(); };
$('#mcRefresh').onclick = () => { mailPoll(); loadList(true); };
$('#mcSearchForm').onsubmit = (e) => { e.preventDefault(); if (M.sel.kind !== 'box') return; M.search = $('#mcSearch').value.trim(); loadList(true); };
$('#mcBulk').addEventListener('click', (e) => {
  const b = e.target.closest('[data-bulk]');
  if (!b) return;
  doAction(M.msgs.filter((m) => M.checked.has(keyOf(m))), b.dataset.bulk);
});

// ---------- Thao tác ----------
async function doAction(msgs, act, target) {
  if (!msgs.length) return;
  const groups = {};
  msgs.forEach((m) => { (groups[`${m.accId}|${m.path}`] ||= []).push(m); });
  // cập nhật giao diện trước cho mượt
  const removing = ['trash', 'spam', 'archive', 'move', 'delete'].includes(act);
  msgs.forEach((m) => {
    if (act === 'read') m.seen = true; if (act === 'unread') m.seen = false;
    if (act === 'flag') m.flagged = true; if (act === 'unflag') m.flagged = false;
  });
  if (removing) {
    const ks = new Set(msgs.map(keyOf));
    M.msgs = M.msgs.filter((m) => !ks.has(keyOf(m)));
    if (M.open && ks.has(keyOf(M.open))) { M.open = null; renderRead(); }
  } else if (M.open) {
    const o = msgs.find((m) => keyOf(m) === keyOf(M.open));
    if (o) { M.open.flagged = o.flagged; M.open.seen = o.seen; renderRead(); }
  }
  M.checked.clear();
  renderList();
  try {
    await Promise.all(Object.values(groups).map((g) => call('mail:action', g[0].accId, g[0].path, g.map((m) => m.uid), act, target)));
    const L = { trash: 'Đã chuyển vào Thùng rác', spam: 'Đã chuyển vào Thư rác', archive: 'Đã lưu trữ', move: 'Đã di chuyển', delete: 'Đã xóa vĩnh viễn' };
    if (L[act]) toast(`${L[act]} ${msgs.length} thư`, 'ok');
    refreshCounts(Object.keys(groups).map((k) => k.split('|')[0]));
  } catch (e) {
    toast(esc(e.message), 'err');
    loadList(true);
  }
}

async function refreshCounts(accIds) {
  await Promise.all([...new Set(accIds)].map(async (id) => { await loadFolders(id); await refreshInbox(id, false); }));
  renderMailTree();
  renderSidebar();
}

// ---------- Đọc thư ----------
async function openMessage(m) {
  M.open = { ...m, loading: true };
  renderList();
  const slow = setTimeout(() => { if (M.open?.loading && keyOf(M.open) === keyOf(m)) renderRead(); }, 120);
  try {
    const d = await call('mail:get', m.accId, m.path, m.uid);
    if (!M.open || keyOf(M.open) !== keyOf(m)) return;
    clearTimeout(slow);
    M.open = { ...m, ...d, seen: true, loading: false };
    if (!m.seen) { m.seen = true; renderList(); refreshCounts([m.accId]); }
    renderRead();
  } catch (e) {
    clearTimeout(slow);
    M.open = { ...m, loading: false, error: e.message };
    renderRead();
  }
}

function renderRead() {
  const el = $('#mcRead');
  const o = M.open;
  if (!o) {
    el.innerHTML = `<div class="empty mc-empty">${icon('mailopen')}<div><b>Chọn một thư để đọc</b><br/>Nhận, đọc, trả lời và quản lý thư của mọi tài khoản ngay tại đây.</div></div>`;
    return;
  }
  const a = acc(o.accId);
  const folders = Array.isArray(M.folders[o.accId]) ? M.folders[o.accId].filter((f) => f.path !== o.path && f.special !== '\\Flagged') : [];
  el.innerHTML = `
    <div class="rd-tools">
      <button class="btn" data-rd="reply" title="Trả lời (R)">${icon('reply')}<span class="lbl">Trả lời</span></button>
      <button class="btn" data-rd="replyall" title="Trả lời tất cả (Shift+R)">${icon('replyall')}<span class="lbl">Trả lời tất cả</span></button>
      <button class="btn" data-rd="forward" title="Chuyển tiếp">${icon('forward')}<span class="lbl">Chuyển tiếp</span></button>
      <span class="sep"></span>
      <button class="btn icon" data-rd="archive" title="Lưu trữ">${icon('archive')}</button>
      <button class="btn icon" data-rd="${o.flagged ? 'unflag' : 'flag'}" title="${o.flagged ? 'Bỏ gắn sao' : 'Gắn sao'}" style="${o.flagged ? 'color:#f59e0b' : ''}">${icon('star')}</button>
      <button class="btn icon" data-rd="unread" title="Đánh dấu chưa đọc">${icon('mail')}</button>
      <button class="btn icon" data-rd="spam" title="Báo cáo thư rác">${icon('spam')}</button>
      <button class="btn icon danger" data-rd="trash" title="Xóa (Delete)">${icon('trash')}</button>
      <div class="grow"></div>
      ${folders.length ? `<select id="rdMove" title="Di chuyển tới thư mục"><option value="">Di chuyển…</option>${folders.map((f) => `<option value="${esc(f.path)}">${esc(f.name)}</option>`).join('')}</select>` : ''}
    </div>
    <div class="rd-scroll">
      <h2 class="rd-subj">${esc(o.subject)}</h2>
      <div class="rd-from">
        ${personAvatar(o.from, 'lg')}
        <div class="who">
          <div><b>${esc(o.from?.name || o.from?.address)}</b> <span class="muted">&lt;${esc(o.from?.address)}&gt;</span></div>
          ${o.to ? `<div class="small muted">Đến: ${esc(o.to.map(pFull).join(', '))}</div>` : ''}
          ${o.cc?.length ? `<div class="small muted">Cc: ${esc(o.cc.map(pFull).join(', '))}</div>` : ''}
        </div>
        <div class="when small muted">${mDate(o.date, true)}<br/><span class="acc-tag" style="--c:${a?.color}">${esc(a?.email || '')}</span></div>
      </div>
      ${o.attachments?.length ? `<div class="rd-atts">${o.attachments.map((t) => `<div class="att" data-att="${t.i}" title="Bấm để mở">
          <span class="ext">${esc((t.filename.split('.').pop() || '').slice(0, 4).toUpperCase())}</span>
          <div class="ai"><b>${esc(t.filename)}</b><small>${fmtBytes(t.size)}</small></div>
          <button class="btn icon" data-save="${t.i}" title="Lưu về máy">${icon('download')}</button></div>`).join('')}</div>` : ''}
      <div class="rd-body">${o.loading ? '<div class="empty"><span class="spinner"></span></div>' : o.error ? `<div class="empty" style="color:var(--err)">${esc(o.error)}</div>` : '<iframe id="rdFrame" sandbox="allow-same-origin allow-popups allow-popups-to-escape-sandbox"></iframe>'}</div>
    </div>`;
  if (!o.loading && !o.error) {
    const f = $('#rdFrame');
    const base = `<!doctype html><html><head><meta charset="utf-8"><base target="_blank">
      <style>html,body{margin:0;padding:0;background:#fff;color:#1f2937;font:14px/1.55 'Segoe UI',system-ui,sans-serif;word-wrap:break-word;overflow-wrap:anywhere}
      body{padding:18px 20px}img{max-width:100%;height:auto}pre{white-space:pre-wrap}blockquote{margin:0 0 0 6px;padding-left:12px;border-left:3px solid #d1d5db;color:#4b5563}a{color:#2563eb}</style></head><body>`;
    f.srcdoc = base + o.html + '</body></html>';
    f.onload = () => {
      const fit = () => { try { f.style.height = f.contentDocument.documentElement.scrollHeight + 4 + 'px'; } catch {} };
      fit();
      f.contentDocument.querySelectorAll('img').forEach((img) => img.addEventListener('load', fit));
      setTimeout(fit, 400);
    };
  }
}

$('#mcRead').addEventListener('click', (e) => {
  const o = M.open;
  if (!o) return;
  const sv = e.target.closest('[data-save]');
  if (sv) { e.stopPropagation(); return call('mail:saveAtt', o.accId, o.path, o.uid, +sv.dataset.save).catch((x) => toast(esc(x.message), 'err')); }
  const at = e.target.closest('[data-att]');
  if (at) return call('mail:openAtt', o.accId, o.path, o.uid, +at.dataset.att).catch((x) => toast(esc(x.message), 'err'));
  const b = e.target.closest('[data-rd]');
  if (!b) return;
  const act = b.dataset.rd;
  if (act === 'reply' || act === 'replyall' || act === 'forward') return openCompose({ mode: act, src: o });
  const m = M.msgs.find((x) => keyOf(x) === keyOf(o)) || o;
  doAction([m], act);
});
$('#mcRead').addEventListener('change', (e) => {
  if (e.target.id === 'rdMove' && e.target.value && M.open) {
    const m = M.msgs.find((x) => keyOf(x) === keyOf(M.open)) || M.open;
    doAction([m], 'move', e.target.value);
  }
});

document.addEventListener('keydown', (e) => {
  if (S.view !== 'mail' || $$('.modal-bg.open').length || /INPUT|TEXTAREA|SELECT/.test(document.activeElement?.tagName) || document.activeElement?.isContentEditable) return;
  if (e.key === 'Delete') {
    const sel = M.checked.size ? M.msgs.filter((m) => M.checked.has(keyOf(m))) : M.open ? [M.msgs.find((x) => keyOf(x) === keyOf(M.open)) || M.open] : [];
    doAction(sel, 'trash');
  } else if ((e.key === 'ArrowDown' || e.key === 'ArrowUp') && M.msgs.length) {
    const i = M.open ? M.msgs.findIndex((x) => keyOf(x) === keyOf(M.open)) : -1;
    const n = Math.max(0, Math.min(M.msgs.length - 1, i + (e.key === 'ArrowDown' ? 1 : -1)));
    openMessage(M.msgs[n]);
    $$('#mcItems .mc-item')[n]?.scrollIntoView({ block: 'nearest' });
    e.preventDefault();
  } else if (e.key.toLowerCase() === 'r' && M.open && !e.ctrlKey) openCompose({ mode: e.shiftKey ? 'replyall' : 'reply', src: M.open });
  else if (e.key.toLowerCase() === 'n' && !e.ctrlKey) openCompose({});
});

// ---------- Soạn thư ----------
let CP = { attachments: [], extra: {} };
function quoteBlock(o) {
  return `<br><br><div class="gch-quote"><div style="color:#6b7280">Vào ${esc(mDate(o.date, true))}, ${esc(pFull(o.from))} đã viết:</div>
    <blockquote style="margin:6px 0 0 4px;padding-left:12px;border-left:3px solid #d1d5db">${o.html || esc(o.text || '')}</blockquote></div>`;
}
function fwdBlock(o) {
  return `<br><br><div class="gch-quote">---------- Thư được chuyển tiếp ----------<br>
    Từ: ${esc(pFull(o.from))}<br>Ngày: ${esc(mDate(o.date, true))}<br>Tiêu đề: ${esc(o.subject)}<br>Đến: ${esc((o.to || []).map(pFull).join(', '))}<br><br>${o.html || esc(o.text || '')}</div>`;
}

function openCompose({ mode = 'new', src = null, to = '', subject = '', body = '' } = {}) {
  const senders = mailAccounts();
  if (!senders.length) {
    toast('Hãy kết nối hộp thư cho ít nhất một tài khoản trước khi gửi thư', 'err');
    if (S.accounts[0]) openMailSetup(S.accounts[0].id);
    return;
  }
  $('#cFrom').innerHTML = senders.map((a) => `<option value="${a.id}">${esc(a.name && a.name !== a.email ? `${a.name} <${a.email}>` : a.email)}</option>`).join('');
  const pref = src?.accId || (M.sel.kind === 'box' ? M.sel.accId : null);
  if (pref && senders.some((a) => a.id === pref)) $('#cFrom').value = pref;
  CP = { attachments: [], extra: {} };
  let cTo = to, cCc = '', cSubj = subject, html = body ? esc(body).replace(/\n/g, '<br>') : '';
  const me = (src && acc(src.accId)?.email || '').toLowerCase();
  if (src && (mode === 'reply' || mode === 'replyall')) {
    const replyTo = src.replyTo?.length ? src.replyTo : [src.from];
    cTo = replyTo.map((p) => p.address).join(', ');
    if (mode === 'replyall') {
      const others = [...(src.to || []), ...(src.cc || [])].map((p) => p.address).filter((x) => x && x.toLowerCase() !== me && !cTo.includes(x));
      cCc = [...new Set(others)].join(', ');
    }
    cSubj = /^(re|tl)\s*:/i.test(src.subject) ? src.subject : 'Re: ' + src.subject;
    html = quoteBlock(src);
    CP.extra = { inReplyTo: src.messageId, references: src.references, replyOf: { accId: src.accId, path: src.path, uid: src.uid } };
  } else if (src && mode === 'forward') {
    cSubj = /^(fwd?|tt)\s*:/i.test(src.subject) ? src.subject : 'Fwd: ' + src.subject;
    html = fwdBlock(src);
    CP.extra = { forward: { accId: src.accId, path: src.path, uid: src.uid } };
    CP.fwdCount = src.attachments?.length || 0;
  }
  $('#cpTitle').textContent = { reply: 'Trả lời', replyall: 'Trả lời tất cả', forward: 'Chuyển tiếp' }[mode] || 'Thư mới';
  $('#cTo').value = cTo; $('#cCc').value = cCc; $('#cBcc').value = ''; $('#cSubject').value = cSubj;
  $('#composeModal').classList.toggle('show-cc', !!cCc);
  $('#cBody').innerHTML = html;
  renderAttach();
  $('#composeModal').classList.add('open');
  setTimeout(() => {
    const f = cTo ? $('#cBody') : $('#cTo');
    f.focus();
    if (f === $('#cBody')) { const r = document.createRange(); r.setStart(f, 0); r.collapse(true); const s = getSelection(); s.removeAllRanges(); s.addRange(r); }
  }, 60);
}
window.openCompose = openCompose;

function renderAttach() {
  const fwd = CP.fwdCount ? `<span class="fwd">${icon('clip')}Kèm ${CP.fwdCount} tệp của thư gốc</span>` : '';
  $('#cAttach').innerHTML = fwd + CP.attachments.map((p, i) => `<span>${icon('clip')}${esc(p.split(/[\\/]/).pop())}<button data-i="${i}">✕</button></span>`).join('');
  $$('#cAttach button').forEach((b) => { b.onclick = () => { CP.attachments.splice(+b.dataset.i, 1); renderAttach(); }; });
}

function composeData() {
  return {
    to: $('#cTo').value.trim(), cc: $('#cCc').value.trim(), bcc: $('#cBcc').value.trim(),
    subject: $('#cSubject').value, html: `<div style="font-family:Segoe UI,Arial,sans-serif;font-size:14px">${$('#cBody').innerHTML}</div>`,
    text: $('#cBody').innerText, attachments: [...CP.attachments], ...CP.extra,
  };
}

$('#composeBtn')?.remove();
$('#mcNew').onclick = () => openCompose({});
$('#cCcToggle').onclick = () => $('#composeModal').classList.toggle('show-cc');
$('#cAttachBtn').onclick = async () => { CP.attachments.push(...(await call('dialog:files'))); renderAttach(); };
$('#cpToolbar').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-cmd]');
  if (!b) return;
  e.preventDefault();
  $('#cBody').focus();
  if (b.dataset.cmd === 'createLink') {
    const sel = getSelection(); const range = sel.rangeCount ? sel.getRangeAt(0).cloneRange() : null;
    askText('Địa chỉ liên kết', 'https://').then((u) => {
      if (!u) return;
      $('#cBody').focus();
      if (range) { sel.removeAllRanges(); sel.addRange(range); }
      if (range && !range.collapsed) document.execCommand('createLink', false, u);
      else document.execCommand('insertHTML', false, `<a href="${esc(u)}">${esc(u)}</a>`);
    });
    return;
  }
  document.execCommand(b.dataset.cmd, false, null);
});
$('#cpToolbar').addEventListener('mousedown', (e) => { if (e.target.closest('button')) e.preventDefault(); });
$('#cpToolbar').addEventListener('change', (e) => {
  const c = e.target.dataset.cmd;
  if (!c || !e.target.value) return;
  $('#cBody').focus();
  document.execCommand(c, false, e.target.value);
  if (c === 'fontSize') e.target.value = '';
});
$('#cSend').onclick = async () => {
  const msg = composeData();
  if (!msg.to && !msg.cc && !msg.bcc) return toast('Hãy nhập người nhận', 'err');
  if (!msg.subject) { $('#cSubject').focus(); return toast('Hãy nhập tiêu đề thư', 'err'); }
  const from = acc($('#cFrom').value);
  $('#composeModal').classList.remove('open');
  const t = toast(`Đang gửi từ <b>${esc(from.email)}</b>…`, 'busy');
  try {
    await call('mail:send', from.id, msg);
    t.update(`Đã gửi thư tới <b>${esc(msg.to || msg.cc || msg.bcc)}</b>`, 'ok');
    if (M.open && msg.replyOf && keyOf(M.open) === `${msg.replyOf.accId}|${msg.replyOf.path}|${msg.replyOf.uid}`) {
      const m = M.msgs.find((x) => keyOf(x) === keyOf(M.open)); if (m) { m.answered = true; renderList(); }
    }
    loadFolders(from.id).then(renderMailTree);
  } catch (e) {
    t.update(esc(e.message), 'err');
    $('#composeModal').classList.add('open');
  }
};
$('#cDraft').onclick = async () => {
  const from = acc($('#cFrom').value);
  try { await call('mail:draft', from.id, composeData()); toast('Đã lưu vào Thư nháp', 'ok'); $('#composeModal').classList.remove('open'); loadFolders(from.id).then(renderMailTree); }
  catch (e) { toast(esc(e.message), 'err'); }
};
$('#composeModal').addEventListener('keydown', (e) => { if (e.key === 'Enter' && e.ctrlKey) { e.preventDefault(); $('#cSend').click(); } });
hub.on('mail:mailto', (url) => {
  const u = new URL(url);
  openCompose({ to: decodeURIComponent(u.pathname), subject: u.searchParams.get('subject') || '', body: u.searchParams.get('body') || '' });
});

// ---------- Kết nối hộp thư ----------
let PRESETS = null;
async function presets() { return (PRESETS ||= await call('mail:presets')); }
function guessPreset(email) {
  const d = (email.split('@')[1] || '').toLowerCase();
  if (/^(gmail|googlemail)\.com$/.test(d)) return 'gmail';
  if (/^(outlook|hotmail|live|msn)\./.test(d)) return 'outlook';
  if (/^yahoo\./.test(d)) return 'yahoo';
  if (/^(icloud|me|mac)\.com$/.test(d)) return 'icloud';
  return 'custom';
}

// Form máy chủ dùng chung (thiết lập & thêm tài khoản)
async function serverForm(prefix, { email = '', preset = null, withEmail = false } = {}) {
  const P = await presets();
  preset ||= guessPreset(email);
  const p = P[preset] || P.custom;
  const dom = (email.split('@')[1] || 'congty.com');
  return `
    ${withEmail ? `<div class="row"><label class="field" style="flex:1"><span>Email</span><input id="${prefix}Email" value="${esc(email)}" placeholder="ban@congty.com"/></label>
      <label class="field" style="flex:1"><span>Tên hiển thị khi gửi</span><input id="${prefix}Name" placeholder="Nguyễn Văn A"/></label></div>` : ''}
    <label class="field"><span>Nhà cung cấp</span><select id="${prefix}Preset">${Object.entries(P).map(([k, v]) => `<option value="${k}" ${k === preset ? 'selected' : ''}>${esc(v.label)}</option>`).join('')}</select></label>
    <label class="field"><span>Mật khẩu ${preset === 'gmail' ? 'ứng dụng (16 ký tự)' : '(hoặc mật khẩu ứng dụng)'}</span><input id="${prefix}Pass" type="password" placeholder="Nhập mật khẩu" autocomplete="new-password"/></label>
    <details class="adv" ${preset === 'custom' ? 'open' : ''}><summary>Cài đặt máy chủ nâng cao</summary>
      <label class="field"><span>Tên đăng nhập (mặc định là email)</span><input id="${prefix}User" placeholder="${esc(email || 'ban@congty.com')}"/></label>
      <div class="row">
        <label class="field" style="flex:2"><span>Máy chủ IMAP (nhận)</span><input id="${prefix}IH" value="${esc(p.imap.host || (preset === 'custom' ? 'mail.' + dom : ''))}"/></label>
        <label class="field" style="flex:1"><span>Cổng</span><input id="${prefix}IP" value="${p.imap.port}"/></label>
        <label class="field ssl"><span>SSL</span><input type="checkbox" id="${prefix}IS" ${p.imap.secure ? 'checked' : ''}/></label>
      </div>
      <div class="row">
        <label class="field" style="flex:2"><span>Máy chủ SMTP (gửi)</span><input id="${prefix}SH" value="${esc(p.smtp.host || (preset === 'custom' ? 'mail.' + dom : ''))}"/></label>
        <label class="field" style="flex:1"><span>Cổng</span><input id="${prefix}SP" value="${p.smtp.port}"/></label>
        <label class="field ssl"><span>SSL</span><input type="checkbox" id="${prefix}SS" ${p.smtp.secure ? 'checked' : ''}/></label>
      </div>
    </details>`;
}
function bindServerForm(prefix, rerenderFn) {
  const sel = $(`#${prefix}Preset`);
  if (sel) sel.onchange = () => rerenderFn(sel.value);
  const em = $(`#${prefix}Email`);
  if (em) em.onchange = () => { const g = guessPreset(em.value); if (g !== $(`#${prefix}Preset`).value) rerenderFn(g, em.value); };
}
function readServerForm(prefix) {
  return {
    preset: $(`#${prefix}Preset`).value,
    password: $(`#${prefix}Pass`).value,
    user: $(`#${prefix}User`).value.trim() || undefined,
    imap: { host: $(`#${prefix}IH`).value.trim(), port: +$(`#${prefix}IP`).value, secure: $(`#${prefix}IS`).checked },
    smtp: { host: $(`#${prefix}SH`).value.trim(), port: +$(`#${prefix}SP`).value, secure: $(`#${prefix}SS`).checked },
  };
}

async function openMailSetup(accId, preset) {
  const a = acc(accId);
  if (!a) return;
  $('#suTitle').textContent = 'Kết nối hộp thư — ' + a.email;
  const isG = a.provider === 'google';
  const err = M.folders[accId]?.error;
  $('#suBody').innerHTML = `
    ${err ? `<div class="hint-box" style="border-color:rgba(239,68,68,.4);background:rgba(239,68,68,.08);margin-bottom:12px">${esc(err)}</div>` : ''}
    <p class="muted small" style="margin:0 0 12px;line-height:1.6">Ứng dụng kết nối trực tiếp tới máy chủ thư bằng IMAP (nhận) và SMTP (gửi) — giống Outlook. Mật khẩu được mã hóa bằng Windows và chỉ lưu trên máy này.</p>
    ${isG ? `<div class="su-auto">
        <div class="ico">${icon('key')}</div>
        <div><b>Tự động tạo mật khẩu ứng dụng (khuyên dùng)</b>
          <small>Mở trang Google trong phiên đã đăng nhập. Bấm <b>Tạo</b> — ứng dụng sẽ tự lấy mật khẩu và kết nối. Yêu cầu tài khoản đã bật <a href="#" data-ext="https://myaccount.google.com/signinoptions/twosv">Xác minh 2 bước</a>.</small></div>
        <button class="btn primary" id="suAuto">${icon('bolt')}Tạo tự động</button>
      </div>
      <div class="su-or"><span>hoặc nhập thủ công</span></div>` : ''}
    <div id="suForm" class="su-form"></div>
    <div class="foot">
      ${a.mail?.configured ? `<button class="btn danger" id="suRemove">${icon('trash')}Ngắt kết nối</button><button class="btn" id="suReveal">${icon('key')}Hiện mật khẩu đã lưu</button><div class="grow"></div>` : ''}
      <button class="btn" data-close>Hủy</button>
      <button class="btn primary" id="suGo">${icon('check')}Kết nối</button>
    </div>`;
  const draw = async (p) => {
    $('#suForm').innerHTML = await serverForm('su', { email: a.email, preset: p || preset || (isG ? 'gmail' : null) });
    bindServerForm('su', (np) => draw(np));
  };
  await draw();
  $$('#suBody [data-close]').forEach((b) => { b.onclick = () => $('#setupModal').classList.remove('open'); });
  $$('#suBody [data-ext]').forEach((l) => { l.onclick = (e) => { e.preventDefault(); call('shell:open', l.dataset.ext); }; });
  if (isG) $('#suAuto').onclick = async () => {
    $('#setupModal').classList.remove('open');
    const t = toast('Đang mở trang Mật khẩu ứng dụng của Google… Nhập tên bất kỳ rồi bấm <b>Tạo</b>.', 'busy');
    try {
      const r = await call('mail:appPassword', accId);
      t.close();
      showPassword(accId, r);
      if (r.ok) await afterConnect(accId);
    } catch (e) { t.update(esc(e.message), 'err'); }
  };
  $('#suGo').onclick = async () => {
    const cfg = readServerForm('su');
    if (!cfg.password) return toast('Nhập mật khẩu', 'err');
    const btn = $('#suGo'); btn.disabled = true; btn.innerHTML = '<span class="spinner"></span>Đang kiểm tra…';
    try {
      await call('mail:configure', accId, cfg);
      $('#setupModal').classList.remove('open');
      toast(`Đã kết nối hộp thư <b>${esc(a.email)}</b>`, 'ok');
      await afterConnect(accId);
    } catch (e) { toast(esc(e.message), 'err'); btn.disabled = false; btn.innerHTML = icon('check') + 'Kết nối'; }
  };
  const rv = $('#suReveal');
  if (rv) rv.onclick = async () => {
    try { const r = await call('mail:revealPassword', accId); $('#setupModal').classList.remove('open'); showPassword(accId, { ok: true, password: r.password, saved: true }); }
    catch (e) { toast(esc(e.message), 'err'); }
  };
  const rm = $('#suRemove');
  if (rm) rm.onclick = async () => {
    if (!confirm('Ngắt kết nối hộp thư của tài khoản này?')) return;
    await call('mail:unconfigure', accId);
    delete M.folders[accId];
    $('#setupModal').classList.remove('open');
    await loadAccounts();
  };
  $('#setupModal').classList.add('open');
}
window.openMailSetup = openMailSetup;

async function afterConnect(accId) {
  delete M.folders[accId];
  await loadAccounts();
  await loadFolders(accId);
  await refreshInbox(accId, false);
  rerender();
  if (S.view === 'mail') { renderMailTree(); selectBox({ kind: 'box', accId, path: 'INBOX', name: 'Hộp thư đến' }); }
}
window.afterConnect = afterConnect;

// ---------- Vào trang Thư ----------
let mailInited = false;
function renderMail() {
  renderMailTree();
  if (!mailInited) {
    mailInited = true;
    renderRead();
    Promise.all(mailAccounts().map((a) => loadFolders(a.id))).then(renderMailTree);
    loadList(true);
  } else renderList();
}

function openAccountMail(accId) {
  const a = acc(accId);
  go('mail');
  if (!a?.mail?.configured) return openMailSetup(accId);
  selectBox({ kind: 'box', accId, path: 'INBOX', name: 'Hộp thư đến' });
}
window.openAccountMail = openAccountMail;

function openEntry(e) {
  const a = acc(e.accId);
  if (!a) return;
  if (!a.mail?.configured || !e.uid) return openAccountMail(e.accId);
  go('mail');
  if (!(M.sel.kind === 'box' && M.sel.accId === e.accId && M.sel.path === 'INBOX')) selectBox({ kind: 'box', accId: e.accId, path: 'INBOX', name: 'Hộp thư đến' });
  openMessage({ accId: e.accId, path: 'INBOX', uid: e.uid, subject: e.title, from: { name: e.fromName, address: e.fromEmail }, to: [], date: e.date, seen: false });
}
window.openEntry = openEntry;

// Kiểm tra thư mới định kỳ khi đang ở trang Thư
async function mailPoll() {
  await Promise.all(mailAccounts().map((a) => loadFolders(a.id)));
  renderMailTree();
  if (!M.search && M.page === 0 && (M.sel.kind === 'unified' || M.sel.path === 'INBOX')) {
    const before = new Set(M.msgs.map(keyOf));
    const r = M.sel.kind === 'unified' ? await call('mail:unified', { page: 0 }).catch(() => null) : await call('mail:list', M.sel.accId, M.sel.path, { page: 0 }).catch(() => null);
    if (r && M.page === 0 && !M.search) {
      const fresh = r.messages.filter((m) => !before.has(keyOf(m)));
      if (fresh.length || r.messages.length !== M.msgs.length) { M.msgs = r.messages; M.more = r.more; renderList(); }
    }
  }
}
window.mailPoll = mailPoll;

// Thư mới đến (máy chủ báo ngay qua IMAP IDLE)
let newT = {};
hub.on('mail:new', ({ accId, flagsOnly }) => {
  clearTimeout(newT[accId]);
  newT[accId] = setTimeout(async () => {
    await refreshInbox(accId, !flagsOnly);
    renderSidebar();
    if (S.view === 'dashboard') rerender();
    if (S.view === 'mail') {
      await loadFolders(accId); renderMailTree();
      if (!M.search && M.page === 0 && (M.sel.kind === 'unified' || (M.sel.accId === accId && M.sel.path === 'INBOX'))) mailPoll();
    }
  }, 300);
});

// ---------- Hộp hiển thị mật khẩu (không tự đóng) ----------
function showPassword(accId, r) {
  const a = acc(accId);
  const pw = r.password || '';
  const pretty = pw.length === 16 ? pw.replace(/(.{4})(?=.)/g, '$1 ') : pw;
  $('#pwTitle').textContent = r.saved ? 'Mật khẩu đã lưu — ' + a.email : 'Mật khẩu ứng dụng — ' + a.email;
  $('#pwValue').textContent = pretty;
  $('#pwStatus').innerHTML = r.saved ? '' : r.ok
    ? `<div class="hint-box pw-ok">${icon('check')} Đã kết nối hộp thư thành công. Mật khẩu đã được lưu (mã hóa) trên máy này — bạn có thể sao chép để dùng cho thiết bị khác.</div>`
    : `<div class="hint-box pw-err">Kết nối chưa thành công: ${esc(r.error || '')}</div>`;
  $('#pwNote').innerHTML = r.saved
    ? 'Chỉ hiển thị trên máy này. Đừng chia sẻ mật khẩu này cho người khác.'
    : 'Google chỉ hiển thị mật khẩu này <b>một lần</b>. Hãy sao chép và cất giữ nếu bạn cần dùng lại.';
  $('#pwFoot').innerHTML = (!r.ok && !r.saved ? `<button class="btn" id="pwRetry">${icon('refresh')}Thử kết nối lại</button>` : '') + `<button class="btn primary" id="pwClose">Đóng</button>`;
  $('#pwCopy').onclick = async () => { await navigator.clipboard.writeText(pw); $('#pwCopy').innerHTML = icon('check') + 'Đã sao chép'; setTimeout(() => { $('#pwCopy').innerHTML = icon('draft') + 'Sao chép'; }, 2000); };
  $('#pwClose').onclick = () => $('#pwModal').classList.remove('open');
  const rt = $('#pwRetry');
  if (rt) rt.onclick = async () => {
    rt.disabled = true; rt.innerHTML = '<span class="spinner"></span>Đang kết nối…';
    try { await call('mail:configure', accId, { preset: 'gmail', password: pw }); showPassword(accId, { ok: true, password: pw }); await afterConnect(accId); }
    catch (e) { showPassword(accId, { ok: false, password: pw, error: e.message }); }
  };
  $('#pwModal').classList.add('open');
}
window.showPassword = showPassword;

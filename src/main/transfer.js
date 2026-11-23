// Chuyển dữ liệu giữa các Drive: bắt tệp tải xuống từ Drive nguồn vào hàng chờ,
// rồi tải lên (ngầm) Drive đích. Đồng bộ thư mục máy tính → nhiều Drive theo lịch.
const { app, BrowserWindow, Notification } = require('electron');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const store = require('./store');

let captureAcc = null;  // tài khoản đang bật chế độ "bắt tệp tải xuống"
const queue = [];        // { id, name, path, size, received, srcAcc, status }
const downloads = new Map(); // id -> DownloadItem đang tải vào hàng chờ
let job = null;              // { aborted } khi đang chuyển
let lastEmit = 0, emitTimer = null;

function emitQueue(throttle = false) {
  if (throttle && Date.now() - lastEmit < 300) {
    clearTimeout(emitTimer);
    emitTimer = setTimeout(() => emitQueue(), 300);
    return;
  }
  lastEmit = Date.now();
  emit('transfer:queue', listQueue());
}

function staging() {
  const d = path.join(app.getPath('userData'), 'transfer');
  fs.mkdirSync(d, { recursive: true });
  return d;
}

const { toMain } = require('./ipc');
function emit(ch, payload) { toMain(ch, payload); }

function uniquePath(dir, name) {
  let p = path.join(dir, name);
  const ext = path.extname(name), base = path.basename(name, ext);
  for (let i = 1; fs.existsSync(p); i++) p = path.join(dir, `${base} (${i})${ext}`);
  return p;
}

function attachDownloads(ses, accId) {
  ses.on('will-download', (e, item) => {
    const name = item.getFilename();
    const capturing = accId && captureAcc === accId;
    const st = store.get().settings;
    let dest = null;
    if (capturing) dest = uniquePath(staging(), name);
    else if (!st.askSave) {
      const dir = st.downloadDir && fs.existsSync(st.downloadDir) ? st.downloadDir : app.getPath('downloads');
      dest = uniquePath(dir, name);
    }
    if (dest) item.setSavePath(dest);
    else item.setSaveDialogOptions({ title: 'Lưu tệp tải về', defaultPath: path.join(st.downloadDir || app.getPath('downloads'), name) });
    const dlId = crypto.randomUUID();
    if (capturing) {
      // Hiện ngay trong hàng chờ kèm tiến trình (không bật thông báo riêng cho từng tệp)
      const q = { id: dlId, name: path.basename(dest), path: dest, size: item.getTotalBytes(), received: 0, srcAcc: accId, status: 'downloading' };
      queue.push(q);
      downloads.set(dlId, item);
      emitQueue();
      item.on('updated', () => {
        try { q.received = item.getReceivedBytes(); q.size = item.getTotalBytes() || q.size; } catch {}
        emitQueue(true);
      });
      item.once('done', (ev, state) => {
        downloads.delete(dlId);
        let total = 0;
        try { total = item.getTotalBytes(); } catch {}
        if (state === 'completed') {
          q.status = 'ready';
          try { q.size = q.received = total || fs.statSync(dest).size; } catch { q.size = q.received = total || q.size; }
        } else {
          const i = queue.indexOf(q);
          if (i >= 0) queue.splice(i, 1);
          fs.rm(dest, () => {});
        }
        emitQueue();
      });
      return;
    }
    emit('download:progress', { id: dlId, name, state: 'progressing', received: 0, total: item.getTotalBytes(), capturing });
    item.on('updated', () => { try { emit('download:progress', { id: dlId, name, state: 'progressing', received: item.getReceivedBytes(), total: item.getTotalBytes(), capturing }); } catch {} });
    item.once('done', (ev, state) => { try { emit('download:progress', { id: dlId, name, state, received: item.getReceivedBytes(), total: item.getTotalBytes(), capturing, path: item.getSavePath() || dest }); } catch {} });
  });
}

function setCapture(accId) { captureAcc = accId || null; return true; }
function listQueue() { return queue.map((q) => ({ ...q })); }

function addLocal(paths) {
  for (const p of paths) {
    const st = fs.statSync(p);
    if (st.isFile()) queue.push({ id: crypto.randomUUID(), name: path.basename(p), path: p, size: st.size, srcAcc: null, status: 'ready', local: true });
  }
  emit('transfer:queue', listQueue());
  return listQueue();
}

function removeItems(ids) {
  for (const id of ids) {
    const i = queue.findIndex((q) => q.id === id);
    if (i < 0) continue;
    const [it] = queue.splice(i, 1);
    const dl = downloads.get(id);
    if (dl) { try { dl.cancel(); } catch {} downloads.delete(id); }
    if (!it.local) fs.rm(it.path, () => {});
  }
  emit('transfer:queue', listQueue());
  return listQueue();
}

// Tải tệp từ đường dẫn chia sẻ Drive/Docs bằng phiên của tài khoản nguồn
function linkToDownloadUrl(link) {
  const id = link.match(/\/d\/([\w-]{10,})/)?.[1] || link.match(/[?&]id=([\w-]{10,})/)?.[1] || (/^[\w-]{20,}$/.test(link.trim()) ? link.trim() : null);
  if (!id) return null;
  if (/docs\.google\.com\/document/.test(link)) return `https://docs.google.com/document/d/${id}/export?format=docx`;
  if (/docs\.google\.com\/spreadsheets/.test(link)) return `https://docs.google.com/spreadsheets/d/${id}/export?format=xlsx`;
  if (/docs\.google\.com\/presentation/.test(link)) return `https://docs.google.com/presentation/d/${id}/export/pptx`;
  if (/\/folders\//.test(link)) return null;
  return `https://drive.usercontent.google.com/download?id=${id}&export=download&confirm=t`;
}

function downloadLinks(srcAcc, links) {
  const { getSession } = require('./browser');
  const ses = getSession(store.account(srcAcc));
  const bad = [];
  setCapture(srcAcc);
  for (const l of links) {
    const u = linkToDownloadUrl(l);
    if (!u) { bad.push(l); continue; }
    ses.downloadURL(u);
  }
  return { bad };
}

async function upload(itemIds, destAccs, folder) {
  const google = require('./google');
  const items = queue.filter((q) => itemIds.includes(q.id) && q.status !== 'downloading');
  if (!items.length) throw new Error('Chưa chọn tệp nào (hoặc tệp vẫn đang tải về hàng chờ)');
  if (job) throw new Error('Đang chuyển — hãy đợi xong hoặc bấm Dừng');
  const sig = (job = { aborted: false });
  const results = [];
  try {
  for (const d of destAccs) {
    if (sig.aborted) break;
    // d: id tài khoản, hoặc { accId, folderId } khi chọn thư mục từ cây
    const accId = typeof d === 'string' ? d : d.accId;
    const target = typeof d === 'string' ? folder : (d.folderId || '');
    const acc = store.account(accId);
    items.forEach((it) => { it.status = 'uploading'; });
    emit('transfer:queue', listQueue());
    emit('transfer:status', { accId, email: acc.email, state: 'start', total: items.length });
    try {
      // chia lô 20 tệp để Drive xử lý ổn định
      for (let i = 0; i < items.length; i += 20) {
        if (sig.aborted) throw new Error('Đã dừng theo yêu cầu');
        const batch = items.slice(i, i + 20);
        await google.uploadToDrive(accId, batch.map((b) => b.path), target, (p) =>
          emit('transfer:status', { accId, email: acc.email, state: 'progress', done: i + p.done, total: items.length }), sig);
      }
      emit('transfer:status', { accId, email: acc.email, state: 'done', total: items.length });
      results.push({ accId, ok: true });
    } catch (e) {
      emit('transfer:status', { accId, email: acc.email, state: 'error', error: e.message });
      results.push({ accId, ok: false, error: e.message });
    }
  }
  } finally { job = null; }
  const allOk = results.length && results.every((r) => r.ok);
  items.forEach((it) => { it.status = sig.aborted ? 'ready' : allOk ? 'done' : 'error'; });
  emit('transfer:queue', listQueue());
  emit('transfer:status', { state: sig.aborted ? 'stopped' : 'finished' });
  return results;
}

// Dừng bất cứ lúc nào: hủy tệp đang tải về hàng chờ + dừng lượt chuyển đang chạy
function stop() {
  let n = 0;
  for (const [id, item] of downloads) { try { item.cancel(); n++; } catch {} downloads.delete(id); }
  if (job) { job.aborted = true; n++; }
  return n;
}
function state() { return { downloading: downloads.size, uploading: !!job }; }

// ---------------- Đồng bộ thư mục máy tính → Drive ----------------
function walk(dir, base = dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name.startsWith('.') || e.name === 'desktop.ini' || e.name === 'Thumbs.db') continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, base, out);
    else if (e.isFile()) { const st = fs.statSync(p); out.push({ rel: path.relative(base, p), path: p, mtime: st.mtimeMs, size: st.size }); }
  }
  return out;
}

function jobs() { return store.get().syncJobs; }

function saveJob(job) {
  const d = store.get();
  if (!job.id) { job.id = crypto.randomUUID(); job.uploaded = {}; d.syncJobs.push(job); }
  else Object.assign(d.syncJobs.find((j) => j.id === job.id) || {}, job);
  store.save();
  schedule();
  return jobs();
}

function deleteJob(id) {
  const d = store.get();
  d.syncJobs = d.syncJobs.filter((j) => j.id !== id);
  store.save();
  schedule();
  return jobs();
}

const running = new Set();
async function runJob(id) {
  const job = jobs().find((j) => j.id === id);
  if (!job) throw new Error('Không tìm thấy tác vụ');
  if (running.has(id)) return { skipped: true };
  running.add(id);
  const google = require('./google');
  try {
    if (!fs.existsSync(job.localPath)) throw new Error('Thư mục không tồn tại: ' + job.localPath);
    const files = walk(job.localPath);
    job.uploaded ||= {};
    let total = 0;
    for (const accId of job.destAccs) {
      const up = (job.uploaded[accId] ||= {});
      const pending = files.filter((f) => up[f.rel] !== f.mtime);
      emit('sync:status', { id, accId, state: 'start', total: pending.length });
      for (let i = 0; i < pending.length; i += 20) {
        const batch = pending.slice(i, i + 20);
        await google.uploadToDrive(accId, batch.map((f) => f.path), job.folder, (p) =>
          emit('sync:status', { id, accId, state: 'progress', done: i + p.done, total: pending.length }));
        batch.forEach((f) => { up[f.rel] = f.mtime; });
        store.save();
      }
      total += pending.length;
      emit('sync:status', { id, accId, state: 'done', total: pending.length });
    }
    job.lastRun = Date.now(); job.lastError = null;
    store.save();
    if (total && Notification.isSupported()) new Notification({ title: 'GCloud Hub', body: `Đã đồng bộ ${total} tệp từ "${path.basename(job.localPath)}"` }).show();
    return { total };
  } catch (e) {
    job.lastError = e.message; job.lastRun = Date.now();
    store.save();
    emit('sync:status', { id, state: 'error', error: e.message });
    throw e;
  } finally { running.delete(id); emit('sync:jobs', jobs()); }
}

let timers = [];
function schedule() {
  timers.forEach(clearInterval);
  timers = jobs().filter((j) => j.intervalMin > 0).map((j) => setInterval(() => runJob(j.id).catch(() => {}), j.intervalMin * 60000));
}

module.exports = { stop, state, attachDownloads, setCapture, listQueue, addLocal, removeItems, downloadLinks, upload, jobs, saveJob, deleteJob, runJob, schedule };

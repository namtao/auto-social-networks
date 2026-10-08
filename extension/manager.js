const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const daysText = (d) => d == null ? '' : d < 1 ? 'hôm nay' : `${Math.round(d)} ngày trước`;
const ago = (iso) => {
  const min = (Date.now() - new Date(iso)) / 60000;
  if (min < 60) return `${Math.max(1, Math.round(min))} phút trước`;
  if (min < 1440) return `${Math.round(min / 60)} giờ trước`;
  return `${Math.round(min / 1440)} ngày trước`;
};
const avatar = (r, square) => r.avatar ? `<img class="av${square ? ' square' : ''}" src="${esc(r.avatar)}" loading="lazy" referrerpolicy="no-referrer" alt="">` : '<span class="av"></span>';
const nameLink = (r) => r.url ? `<a href="${esc(r.url)}" target="_blank" rel="noopener">${esc(r.name)}</a>` : esc(r.name);

const KINDS = {
  posts: {
    label: 'Bài viết', readonly: true, search: ['text', 'summary', 'author', 'source'],
    sort: { key: 'posted_at', dir: -1 },
    columns: [
      { key: 'posted_at', label: 'Thời gian', render: (r) => `<span title="${esc(new Date(r.posted_at).toLocaleString('vi-VN'))}${r.exact_time ? '' : ' (giờ thu bài)'}">${ago(r.posted_at)}${r.exact_time ? '' : '*'}</span>` },
      { key: 'source', label: 'Nguồn', render: (r) => esc(r.source) },
      { key: 'score', label: 'Điểm', num: true, render: (r) => r.score == null ? '<span class="meta">chưa chấm</span>' : `<span class="badge ${r.score >= state.threshold ? 'good' : ''}">${r.score}</span>` },
      { key: 'author', label: 'Bài viết', wrap: true, render: (r) =>
          `<strong>${esc(r.author || '')}</strong>${r.is_ad ? ' <span class="badge">QC</span>' : ''}` +
          `<div>${esc(r.summary || '')}</div>` +
          (r.summary ? '' : `<div class="post-text">${esc((r.text || '').slice(0, 280))}</div>`) +
          (r.link ? ` <a href="${esc(r.link)}" target="_blank" rel="noopener">Mở bài ↗</a>` : '') },
      { key: 'skipped', label: '', nosort: true, render: (r) => `<button class="btn small" data-skip>${r.skipped ? 'Hiện lại' : 'Bỏ qua'}</button>` },
    ],
    filters: [
      { type: 'check', key: 'latest', label: 'Chỉ bài mới quét', default: true },
      { type: 'check', key: 'from_source', label: 'Chỉ bài từ nguồn đã chọn', default: true },
      { type: 'min', key: 'score', label: 'Điểm ≥' },
      { type: 'select', key: 'source', label: 'Nguồn' },
      { type: 'not', key: 'is_ad', label: 'Ẩn quảng cáo', default: true },
      { type: 'not', key: 'skipped', label: 'Ẩn bài đã bỏ qua', default: true },
    ],
  },
  friends: {
    label: 'Bạn bè', actions: { unfriend: { label: 'Hủy kết bạn', danger: true } }, search: ['name'],
    columns: [
      { key: 'avatar', label: '', nosort: true, render: (r) => avatar(r) },
      { key: 'name', label: 'Tên', render: nameLink },
      { key: 'locked', label: 'Trạng thái', render: (r) => r.locked ? '<span class="badge">Đã khóa</span>' : '' },
      { key: 'mutual', label: 'Bạn chung', num: true },
      { key: 'gender', label: 'Giới tính' },
      { key: 'id', label: 'ID' },
    ],
    filters: [
      { type: 'check', key: 'locked', label: 'Chỉ tài khoản đã khóa' },
      { type: 'max', key: 'mutual', label: 'Bạn chung ≤' },
      { type: 'select', key: 'gender', label: 'Giới tính' },
    ],
  },
  pages: {
    label: 'Trang', actions: { unfollow_page: { label: 'Bỏ theo dõi', danger: true } }, source: 'page', search: ['name', 'category'],
    columns: [
      { key: 'avatar', label: '', nosort: true, render: (r) => avatar(r) },
      { key: 'name', label: 'Tên', render: nameLink },
      { key: 'category', label: 'Loại trang' },
      { key: 'liked', label: 'Đã thích', render: (r) => r.liked ? '✓' : '' },
      { key: 'verified', label: 'Xác minh', render: (r) => r.verified ? '✓' : '' },
      { key: 'id', label: 'ID' },
    ],
    filters: [
      { type: 'source', label: 'Chỉ nguồn quét' },
      { type: 'select', key: 'category', label: 'Loại' },
    ],
  },
  groups: {
    label: 'Nhóm', source: 'group', search: ['name'],
    // "flag" is set on a row once the action succeeded; the row then stays in the list.
    actions: {
      leave_group: { label: 'Rời nhóm', danger: true },
      unfollow_group: { label: 'Bỏ theo dõi', flag: 'unfollowed' },
      mute_group: { label: 'Tắt thông báo', flag: 'muted' },
    },
    columns: [
      { key: 'avatar', label: '', nosort: true, render: (r) => avatar(r, true) },
      { key: 'name', label: 'Tên', wrap: true, render: nameLink },
      { key: 'visited_days', label: 'Bạn vào lần cuối', num: true, render: (r) => esc(r.visited) },
      { key: 'last_post_days', label: 'Bài mới nhất', num: true, render: (r) => daysText(r.last_post_days) },
      { key: 'admin', label: 'Quản trị', render: (r) => r.admin ? '✓' : '' },
      { key: 'unfollowed', label: 'Đã bỏ theo dõi', render: (r) => r.unfollowed ? '✓' : '' },
      { key: 'muted', label: 'Đã tắt thông báo', render: (r) => r.muted ? '✓' : '' },
      { key: 'id', label: 'ID' },
    ],
    filters: [
      { type: 'source', label: 'Chỉ nguồn quét' },
      { type: 'min', key: 'visited_days', label: 'Không vào ≥ (ngày)' },
      { type: 'min', key: 'last_post_days', label: 'Không có bài mới ≥ (ngày)' },
    ],
  },
};

const store = {
  get: (k, d) => { try { return localStorage.getItem(k) ?? d; } catch { return d; } },
  set: (k, v) => { try { localStorage.setItem(k, v); } catch {} },
};
// Always land on the posts list; the filters typed in earlier are remembered per tab.
const state = { kind: 'posts', mode: store.get('mode', 'row'), data: {}, selected: {}, sort: {}, filters: {},
                search: '', sources: [], threshold: 7, days: 3, lastRun: null, llm: true, telegram: true };
for (const [k, v] of Object.entries(KINDS)) {
  state.selected[k] = new Set();
  state.sort[k] = v.sort || { key: 'name', dir: 1 };
  state.filters[k] = Object.fromEntries(v.filters.filter((f) => f.default !== undefined).map((f) => [f.key, f.default]));
}
try { const saved = JSON.parse(store.get('filters', '{}')); for (const k in saved) if (KINDS[k]) Object.assign(state.filters[k], saved[k]); } catch {}
let jobRunning = false;

// Every Facebook call runs in the service worker (background.js), which answers {ok, data, error}.
async function api(path, body) {
  const res = await chrome.runtime.sendMessage({ path, body });
  if (!res?.ok) throw new Error(res?.error || 'Extension không phản hồi');
  return res.data;
}
function showError(msg) { $('error').hidden = !msg; $('error').textContent = msg || ''; }
const isSource = (r) => state.sources.some((s) => s.kind === KINDS[state.kind].source && s.id === r.id);

function rows() {
  const kind = KINDS[state.kind], f = state.filters[state.kind];
  const q = state.search.trim().toLowerCase();
  const items = (state.data[state.kind]?.items || []).filter((r) => {
    if (q && !kind.search.some((k) => String(r[k] ?? '').toLowerCase().includes(q))) return false;
    for (const flt of kind.filters) {
      const v = f[flt.key ?? flt.type];
      if (v === undefined || v === '' || v === false) continue;
      const x = r[flt.key];
      if (flt.type === 'source' && !isSource(r)) return false;
      if (flt.type === 'check' && !x) return false;
      if (flt.type === 'not' && x) return false;
      if (flt.type === 'max' && (x == null || x > +v)) return false;
      if (flt.type === 'min' && (x == null || x < +v)) return false;
      if (flt.type === 'select' && x !== v) return false;
    }
    return true;
  });
  const { key, dir } = state.sort[state.kind];
  const val = (r) => (typeof r[key] === 'boolean' ? +r[key] : r[key]);
  return items.sort((a, b) => {
    const x = val(a), y = val(b);
    if (x == null && y == null) return 0;
    if (x == null) return 1;
    if (y == null) return -1;
    return (typeof x === 'number' ? x - y : String(x).localeCompare(String(y), 'vi')) * dir;
  });
}

function renderFilters() {
  const kind = KINDS[state.kind], f = state.filters[state.kind];
  const items = state.data[state.kind]?.items || [];
  $('filters').innerHTML = kind.filters.map((flt) => {
    const key = flt.key ?? flt.type;
    if (['check', 'not', 'source'].includes(flt.type)) return `<label class="filter"><input type="checkbox" data-filter="${key}" ${f[key] ? 'checked' : ''}> ${flt.label}</label>`;
    if (flt.type === 'select') {
      const opts = [...new Set(items.map((r) => r[key]).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'vi'));
      return `<label class="filter">${flt.label} <select data-filter="${key}"><option value="">Tất cả</option>${opts.map((o) => `<option ${o === f[key] ? 'selected' : ''}>${esc(o)}</option>`).join('')}</select></label>`;
    }
    return `<label class="filter">${flt.label} <input type="number" min="0" data-filter="${key}" value="${esc(f[key] ?? '')}"></label>`;
  }).join(' ');
}

function renderTabs() {
  $('tabs').innerHTML = Object.entries(KINDS).map(([k, v]) => {
    const n = state.data[k]?.items?.length;
    return `<button class="tab" role="tab" data-kind="${k}" aria-selected="${k === state.kind}">${v.label}${n != null ? ` <span class="n">${n}</span>` : ''}</button>`;
  }).join('') + `<button class="tab" role="tab" data-kind="settings" aria-selected="${state.kind === 'settings'}">Cài đặt</button>`;
}

function render() {
  renderTabs();
  const settingsView = state.kind === 'settings';
  $('list-view').hidden = settingsView;
  $('settings').hidden = !settingsView;
  $('mode').hidden = $('mode-label').hidden = settingsView || !!KINDS[state.kind].readonly;
  if (settingsView) return;
  const kind = KINDS[state.kind], list = rows(), sel = state.selected[state.kind];
  const data = state.data[state.kind];
  const bulk = state.mode === 'bulk' && !kind.readonly;
  const rowActions = state.mode === 'row' && !kind.readonly;
  for (const b of $('mode').children) b.setAttribute('aria-pressed', b.dataset.mode === state.mode);
  $('scan-box').hidden = !kind.readonly;
  $('llm-notice').hidden = !kind.readonly || state.llm;
  $('scan-digest').disabled = !state.telegram;
  $('scan-digest').parentElement.title = state.telegram ? '' : 'Điền bot token và chat ID ở tab Cài đặt để gửi digest';
  $('bulk-box').hidden = !bulk;
  $('src-on').hidden = $('src-off').hidden = !kind.source;
  $('updated').textContent = kind.readonly
    ? (state.sources.length ? `Nguồn quét: ${state.sources.length} · lấy bài trong ${state.days} ngày gần nhất` : 'Chưa chọn nguồn: “Quét ngay” lấy bài trên feed trang chủ') +
      (state.lastRun ? ` · quét lần cuối ${new Date(state.lastRun).toLocaleString('vi-VN')}` : '')
    : data?.updated ? 'Cập nhật: ' + new Date(data.updated).toLocaleString('vi-VN') : '';

  const { key, dir } = state.sort[state.kind];
  const cols = kind.columns;
  const head = [];
  if (bulk) head.push(`<th class="nosort"><input type="checkbox" id="check-all" ${list.length && list.every((r) => sel.has(r.id)) ? 'checked' : ''} aria-label="Chọn tất cả"></th>`);
  if (kind.source) head.push('<th data-sort="__source" title="Nguồn quét bài">Quét</th>');
  head.push(...cols.map((c) => `<th ${c.nosort ? 'class="nosort"' : `data-sort="${c.key}" class="${c.num ? 'num' : ''}"`}>${c.label}${c.key === key ? (dir > 0 ? ' ▲' : ' ▼') : ''}</th>`));
  if (rowActions) head.push('<th class="nosort actions"></th>');
  $('thead').innerHTML = `<tr>${head.join('')}</tr>`;

  const span = head.length;
  if (!data?.items?.length) {
    $('tbody').innerHTML = `<tr><td colspan="${span}" class="empty">${kind.readonly
      ? 'Chưa có bài. Bấm “Quét ngay” để lấy bài trên feed trang chủ, hoặc chọn nguồn bằng ☆ ở tab Trang hoặc Nhóm trước.'
      : data ? 'Không có mục nào.' : 'Chưa có dữ liệu. Bấm “Làm mới” để tải từ Facebook.'}</td></tr>`;
  } else if (!list.length) {
    const none = kind.readonly && state.filters.posts.latest && !data.items.some((r) => r.latest)
      ? 'Lần quét gần nhất không có bài mới. Bỏ tick “Chỉ bài mới quét” để xem bài cũ.' : 'Không có mục nào khớp bộ lọc.';
    $('tbody').innerHTML = `<tr><td colspan="${span}" class="empty">${none}</td></tr>`;
  } else {
    $('tbody').innerHTML = list.map((r) => {
      const cells = [];
      if (bulk) cells.push(`<td><input type="checkbox" data-select ${sel.has(r.id) ? 'checked' : ''}></td>`);
      if (kind.source) { const on = isSource(r); cells.push(`<td><button class="star ${on ? 'on' : ''}" data-star title="${on ? 'Bỏ khỏi nguồn quét' : 'Thêm vào nguồn quét'}">${on ? '★' : '☆'}</button></td>`); }
      cells.push(...cols.map((c) => `<td class="${c.num ? 'num' : ''} ${c.wrap ? 'wrap' : ''}">${c.render ? c.render(r) : esc(r[c.key])}</td>`));
      if (rowActions) cells.push(`<td class="actions">${Object.entries(kind.actions).map(([m, a]) =>
        `<button class="btn small ${a.danger ? 'outline-danger' : ''}" data-act="${m}" ${jobRunning || r[a.flag] ? 'disabled' : ''}>${a.label}</button>`).join(' ')}</td>`);
      return `<tr class="${bulk && sel.has(r.id) ? 'selected' : ''}" data-id="${esc(r.id)}">${cells.join('')}</tr>`;
    }).join('');
  }
  const total = data?.items?.length || 0;
  $('count').textContent = `Hiển thị ${list.length}/${total}` + (bulk ? ` · Đã chọn ${sel.size}` : '');
  $('acts').innerHTML = Object.entries(kind.actions || {}).map(([m, a]) =>
    `<button class="btn ${a.danger ? 'danger' : ''}" data-act="${m}" ${!sel.size || jobRunning ? 'disabled' : ''}>${a.label}${sel.size ? ` (${sel.size})` : ''}</button>`).join(' ');
  $('src-on').disabled = $('src-off').disabled = !sel.size;
  $('scan').disabled = jobRunning;
}

async function pollJob() {
  const job = await api('job');
  jobRunning = job.running;
  $('job').hidden = !job.label;
  if (job.label) {
    $('job-text').textContent = job.running
      ? `${job.label}: ${job.done}/${job.total}${job.current ? ' · ' + job.current : ''}`
      : `${job.label}: xong ${job.done}/${job.total}` + (job.summary ? ` · ${job.summary}` : '') +
        (job.error ? ` · dừng do lỗi: ${job.error}` : job.done < job.total ? ' · đã dừng' : '');
    $('job-bar').style.width = (job.total ? (100 * job.done) / job.total : 0) + '%';
    $('job-cancel').hidden = !job.running;
  }
  if (job.kind && !job.running && pollJob.wasRunning) {
    // A finished scan shows only what it found, even if the filter was turned off before.
    if (job.kind === 'posts') { state.filters.posts.latest = true; store.set('filters', JSON.stringify(state.filters)); }
    await load(job.kind); await loadSources(); renderFilters();
  }
  pollJob.wasRunning = job.running;
  render();
  if (job.running) setTimeout(pollJob, 1500);
}

async function load(kind) {
  const data = await api(kind);
  if (kind === 'posts') {
    state.threshold = data.threshold; state.days = data.days; state.lastRun = data.last_run;
    state.llm = data.llm; state.telegram = data.telegram;
    for (const r of data.items) { r.source = r.source || 'Feed trang chủ'; }
  }
  state.data[kind] = data;
  const ids = new Set(data.items.map((r) => r.id));
  state.selected[kind] = new Set([...state.selected[kind]].filter((id) => ids.has(id)));
}
async function loadSources() { state.sources = await api('sources'); }
async function setSources(ids, on) {
  state.sources = await api('sources', { kind: state.kind, ids, on });
  render();
}
async function skipPost(row) {
  showError('');
  try { await api('posts/skip', { ids: [row.id], skip: !row.skipped }); row.skipped = !row.skipped; render(); }
  catch (err) { showError(err.message); }
}
async function runAction(method, ids, what) {
  const action = KINDS[state.kind].actions[method];
  const notes = [action.danger && 'Không hoàn tác được.',
                 ids.length > 1 && 'Mỗi thao tác cách nhau 3–7 giây; tác vụ tự dừng nếu Facebook báo lỗi.'].filter(Boolean);
  if (!confirm(`${action.label} ${what}?` + (notes.length ? '\n\n' + notes.join(' ') : ''))) return;
  showError('');
  try { await api(`${state.kind}/action`, { method, ids }); state.selected[state.kind].clear(); pollJob(); }
  catch (err) { showError(err.message); }
}

function goTo(k) {
  state.kind = k;
  if (k === 'settings') loadSettings().catch((err) => showError(err.message));
  else renderFilters();
  render();
}
$('tabs').addEventListener('click', (e) => {
  const k = e.target.closest('[data-kind]')?.dataset.kind;
  if (k) goTo(k);
});
document.addEventListener('click', (e) => {
  const k = e.target.closest('[data-goto]')?.dataset.goto;
  if (k) { e.preventDefault(); goTo(k); }
});
// Avatars from Facebook's CDN expire; hide a broken one instead of showing the browser's icon.
document.addEventListener('error', (e) => { if (e.target.classList?.contains('av')) e.target.style.visibility = 'hidden'; }, true);
$('mode').addEventListener('click', (e) => {
  const m = e.target.closest('[data-mode]')?.dataset.mode;
  if (!m) return;
  state.mode = m; store.set('mode', m); render();
});
$('search').addEventListener('input', (e) => { state.search = e.target.value; render(); });
$('filters').addEventListener('input', (e) => {
  const el = e.target.closest('[data-filter]');
  if (!el) return;
  state.filters[state.kind][el.dataset.filter] = el.type === 'checkbox' ? el.checked : el.value;
  store.set('filters', JSON.stringify(state.filters));
  render();
});
$('thead').addEventListener('click', (e) => {
  if (e.target.id === 'check-all') {
    const sel = state.selected[state.kind];
    for (const r of rows()) e.target.checked ? sel.add(r.id) : sel.delete(r.id);
    return render();
  }
  let key = e.target.closest('[data-sort]')?.dataset.sort;
  if (!key) return;
  if (key === '__source') { for (const r of state.data[state.kind]?.items || []) r.__source = isSource(r); }
  const s = state.sort[state.kind];
  state.sort[state.kind] = { key, dir: s.key === key ? -s.dir : key === '__source' ? -1 : 1 };
  render();
});
$('tbody').addEventListener('click', (e) => {
  if (e.target.closest('a')) return;
  const tr = e.target.closest('tr[data-id]');
  if (!tr) return;
  const id = tr.dataset.id, row = state.data[state.kind].items.find((r) => String(r.id) === id);
  if (e.target.closest('[data-skip]')) return skipPost(row);
  if (e.target.closest('[data-star]')) return setSources([id], !isSource(row));
  const act = e.target.closest('[data-act]');
  if (act) return runAction(act.dataset.act, [id], `“${row.name}”`);
  if (state.mode !== 'bulk' || KINDS[state.kind].readonly) return;
  const sel = state.selected[state.kind];
  sel.has(id) ? sel.delete(id) : sel.add(id);
  render();
});
$('acts').addEventListener('click', (e) => {
  const m = e.target.closest('[data-act]')?.dataset.act;
  if (m) runAction(m, [...state.selected[state.kind]], `${state.selected[state.kind].size} mục`);
});
$('src-on').addEventListener('click', () => setSources([...state.selected[state.kind]], true));
$('src-off').addEventListener('click', () => setSources([...state.selected[state.kind]], false));
$('refresh').addEventListener('click', async () => {
  const btn = $('refresh'), kind = state.kind;
  btn.disabled = true; btn.textContent = KINDS[kind].readonly ? 'Đang tải…' : 'Đang tải từ Facebook…'; showError('');
  try {
    if (!KINDS[kind].readonly) await api(`${kind}/refresh`, {});
    await load(kind); renderFilters();
  } catch (err) { showError('Làm mới lỗi: ' + err.message); }
  finally { btn.disabled = false; btn.textContent = 'Làm mới'; render(); }
});
$('scan').addEventListener('click', async () => {
  showError('');
  try { await api('scan', { digest: $('scan-digest').checked }); pollJob(); }
  catch (err) { showError(err.message); }
});
$('export').addEventListener('click', () => {
  const kind = KINDS[state.kind], sel = state.selected[state.kind];
  const list = state.mode === 'bulk' && sel.size ? rows().filter((r) => sel.has(r.id)) : rows();
  const keys = kind.readonly
    ? ['posted_at', 'source', 'author', 'score', 'summary', 'link', 'text']
    : [...kind.columns.map((c) => c.key).filter((k) => k !== 'avatar'), 'url'].filter((k, i, a) => a.indexOf(k) === i);
  const cell = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const csv = [keys.join(','), ...list.map((r) => keys.map((k) => cell(k === 'visited_days' ? r.visited : r[k])).join(','))].join('\r\n');
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8' }));
  a.download = `facebook-${state.kind}-${new Date().toISOString().slice(0, 10)}.csv`;
  a.click();
  URL.revokeObjectURL(a.href);
});
$('job-cancel').addEventListener('click', () => api('job/cancel', {}));

// --- Settings tab --------------------------------------------------------------------------------

const FIELDS = ['llmUrl', 'llmKey', 'llmModel', 'scoreThreshold', 'interests', 'sourceDays',
                'telegramToken', 'telegramChatId', 'autoRun', 'runTimes', 'remoteOpsUrl'];
// Hosts the manifest already grants; any other LLM or config host is asked for when saving.
const GRANTED = /(^|\.)facebook\.com$|^api\.telegram\.org$|^gist\.githubusercontent\.com$/;
const FROM = { learned: 'Tự học', remote: 'Từ xa', bundled: 'Kèm extension' };
const when = (t) => (t ? new Date(t).toLocaleString('vi-VN') : '');

function readForm() {
  return Object.fromEntries(FIELDS.map((f) => {
    const el = $('s-' + f);
    return [f, el.type === 'checkbox' ? el.checked : el.value.trim()];
  }));
}

function hostPatterns(s) {
  const patterns = [];
  for (const url of [s.llmUrl, s.remoteOpsUrl]) {
    try {
      const u = new URL(url);
      if (!GRANTED.test(u.hostname)) patterns.push(`${u.protocol}//${u.hostname}/*`);
    } catch { /* empty or invalid URL: nothing to grant */ }
  }
  return [...new Set(patterns)];
}

// Must run before any other await in a click handler: Chrome asks only during a user gesture.
async function grantHosts(s) {
  const origins = hostPatterns(s);
  if (!origins.length || await chrome.permissions.request({ origins })) return;
  throw new Error(`Cần cho phép truy cập ${origins.join(', ')} thì extension mới gọi được địa chỉ này.`);
}

async function loadSettings() {
  const s = await api('settings');
  for (const f of FIELDS) {
    const el = $('s-' + f);
    if (el.type === 'checkbox') el.checked = !!s[f]; else el.value = s[f] ?? '';
  }
  loadModels({ ask: false });
  const last = await api('settings/auto-run');
  $('auto-run-status').textContent = last
    ? `Lần chạy tự động gần nhất: ${when(last.at)} · ${last.status === 'ok' ? 'xong' : 'lỗi'}${last.note ? ' · ' + last.note : ''}` : '';
  renderOps(await api('ops'));
}

function renderOps(st) {
  const r = st.remote;
  $('ops-meta').innerHTML = r
    ? `Đã tải từ URL lúc ${esc(when(r.fetched_at))}` + (r.updated ? ` · nội dung file sửa lần cuối ${esc(when(r.updated))}` : '') +
      (r.error ? ` · <span class="err">lỗi: ${esc(r.error)}</span>` : '')
    : 'Chưa tải cấu hình từ xa.';
  $('ops-body').innerHTML = st.rows.map(({ key, candidates: [c, ...rest] }) => c
    ? `<tr><td>${esc(key)}</td><td><code>${esc(c.name)}</code></td><td><code>${esc(c.doc_id)}</code></td>` +
      `<td>${FROM[c.from]}${c.from === 'learned' ? ` <span class="meta">${esc(when(c.at))}</span>` : ''}</td>` +
      `<td class="meta">${rest.map((x) => `${FROM[x.from]}: ${esc(x.doc_id)}`).join('<br>')}</td></tr>`
    : `<tr><td>${esc(key)}</td><td colspan="4" class="err">Chưa có doc_id</td></tr>`).join('');
}

// OpenAI-compatible servers list their models at <base>/models; a bare host such as
// http://localhost:20128 usually serves them under /v1, so that is tried first.
const llmBases = (raw) => {
  const u = raw.trim().replace(/\/+$/, '');
  return /\/v1$/.test(u) ? [u] : [`${u}/v1`, u];
};

async function loadModels({ ask }) {
  const raw = $('s-llmUrl').value;
  const status = $('models-status');
  if (!raw.trim()) { status.textContent = ''; return; }
  try {
    if (ask) await grantHosts({ llmUrl: raw });
    else {
      const origins = hostPatterns({ llmUrl: raw });
      if (origins.length && !(await chrome.permissions.contains({ origins }))) {
        status.textContent = 'Bấm “Tải model” để cho phép extension truy cập địa chỉ này và tải danh sách model.';
        return;
      }
    }
    status.textContent = 'Đang tải danh sách model…';
    const key = $('s-llmKey').value.trim();
    const errors = [];
    for (const base of llmBases(raw)) {
      try {
        const res = await fetch(`${base}/models`, { headers: key ? { Authorization: `Bearer ${key}` } : {}, signal: AbortSignal.timeout(15000) });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const ids = [...new Set(((await res.json()).data || []).map((m) => m.id).filter(Boolean))].sort();
        if (!ids.length) throw new Error('danh sách model trống');
        $('s-llmUrl').value = base;
        $('model-list').innerHTML = ids.map((id) => `<option value="${esc(id)}"></option>`).join('');
        const model = $('s-llmModel').value.trim();
        status.innerHTML = `<span class="ok">Đã tải ${ids.length} model từ ${esc(base)}.</span>` +
          (model && !ids.includes(model) ? ` <span class="err">Model đang chọn “${esc(model)}” không có trong danh sách.</span>` : '') +
          (model ? '' : ' Gõ vào ô Model để lọc rồi chọn một model.');
        return;
      } catch (err) {
        errors.push(`${base}: ${err.message}`);
      }
    }
    throw new Error(`Không tải được danh sách model (${errors.join('; ')}).`);
  } catch (err) {
    status.innerHTML = `<span class="err">${esc(err.message)}</span>`;
  }
}

$('llm-models').addEventListener('click', () => loadModels({ ask: true }));
$('s-llmUrl').addEventListener('change', () => loadModels({ ask: false }));

$('save').addEventListener('click', async () => {
  const s = readForm();
  $('save-result').textContent = '';
  try {
    await grantHosts(s);
    await api('settings', s);
    $('save-result').innerHTML = '<span class="ok">Đã lưu.</span>';
    await loadSettings();
    await load('posts');
  } catch (err) {
    $('save-result').innerHTML = `<span class="err">${esc(err.message)}</span>`;
  }
});

$('llm-test').addEventListener('click', async () => {
  const s = readForm();
  const out = $('llm-test-result');
  out.textContent = 'Đang gọi…';
  try {
    await grantHosts(s);
    const { reply } = await api('llm/test', s);
    out.innerHTML = `<span class="ok">Kết nối được. Model trả lời: ${esc(reply)}</span>`;
  } catch (err) {
    out.innerHTML = `<span class="err">${esc(err.message)}</span>`;
  }
});

$('ops-refresh').addEventListener('click', async () => {
  const btn = $('ops-refresh');
  btn.disabled = true;
  try {
    renderOps(await api('ops/refresh', {}));
  } catch (err) {
    showError(err.message);
    renderOps(await api('ops'));
  } finally {
    btn.disabled = false;
  }
});

(async () => {
  const results = await Promise.allSettled([loadSources(), ...Object.keys(KINDS).map(load)]);
  const failed = results.filter((r) => r.status === 'rejected').map((r) => r.reason.message);
  if (failed.length) showError(failed.join(' · '));
  renderFilters();
  await pollJob();
})();

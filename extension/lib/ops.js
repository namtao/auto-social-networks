// Where the GraphQL doc_ids come from. Facebook rotates them, so each operation has up to three
// candidates, tried newest first:
//   learned - read passively from the requests Facebook's own web app sends while the person
//             browses (webRequest), so they are current the moment Facebook rotates one;
//   remote  - ops.json fetched from remoteOpsUrl, which the maintainer updates without a release;
//   bundled - ops.json shipped inside the extension.
// Feed templates (the pagination query a group or page timeline sends) also keep their variables.

const LEARNED_KEY = 'learned';
const REMOTE_KEY = 'remoteOps';
const TOUCH_MS = 3600e3; // refresh a learned entry's "last seen" at most hourly, not on every request

let bundled = null;
let learned = null; // in-memory copy of storage[LEARNED_KEY]
let watched = null; // friendly names worth learning: every op and feed name in bundled/remote
const own = new Map(); // "name|doc_id" -> requests this extension is sending right now

export async function bundledOps() {
  bundled ??= await (await fetch(chrome.runtime.getURL('ops.json'))).json();
  return bundled;
}

export async function remoteOps() {
  return (await chrome.storage.local.get(REMOTE_KEY))[REMOTE_KEY] || null;
}

async function getLearned() {
  learned ??= (await chrome.storage.local.get(LEARNED_KEY))[LEARNED_KEY] || {};
  return learned;
}

function validRegistry(data) {
  return data && typeof data.ops === 'object' && Object.values(data.ops).every((o) => o.name && /^\d+$/.test(o.doc_id));
}

export async function refreshRemote(url) {
  if (!url) return null;
  const entry = { url, fetched_at: Date.now(), data: null, error: '' };
  try {
    const res = await fetch(url, { cache: 'no-store' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    if (!validRegistry(data)) throw new Error('file không đúng định dạng ops.json');
    entry.data = data;
  } catch (err) {
    // Keep the last good copy: a temporary outage must not drop working doc_ids.
    entry.data = (await remoteOps())?.data || null;
    entry.error = err.message;
  }
  await chrome.storage.local.set({ [REMOTE_KEY]: entry });
  watched = null;
  if (entry.error) throw new Error(`Tải cấu hình từ xa lỗi: ${entry.error}`);
  return entry;
}

async function watchedNames() {
  if (!watched) {
    const regs = [await bundledOps(), (await remoteOps())?.data].filter(Boolean);
    watched = new Set(regs.flatMap((r) => [...Object.values(r.ops || {}), ...Object.values(r.feed || {})].map((o) => o.name)));
  }
  return watched;
}

const isFeed = async (name) => [await bundledOps(), (await remoteOps())?.data]
  .some((r) => Object.values(r?.feed || {}).some((t) => t.name === name));

// Our own calls go through webRequest too; never learn from them, they may carry a stale doc_id.
export function markOwn(name, docId, delta) {
  const k = `${name}|${docId}`;
  const n = (own.get(k) || 0) + delta;
  n > 0 ? own.set(k, n) : own.delete(k);
}

function formField(details) {
  const form = details.requestBody?.formData;
  if (form) return (k) => form[k]?.[0];
  const raw = details.requestBody?.raw;
  if (!raw?.length) return () => undefined;
  const bytes = raw.filter((p) => p.bytes).map((p) => new Uint8Array(p.bytes));
  const all = new Uint8Array(bytes.reduce((n, b) => n + b.length, 0));
  bytes.reduce((at, b) => (all.set(b, at), at + b.length), 0);
  const params = new URLSearchParams(new TextDecoder().decode(all));
  return (k) => params.get(k) ?? undefined;
}

// webRequest.onBeforeRequest listener for https://*.facebook.com/api/graphql/*.
export function observe(details) {
  if (details.method !== 'POST') return;
  const get = formField(details);
  const name = get('fb_api_req_friendly_name');
  const docId = get('doc_id');
  if (!name || !/^\d+$/.test(docId || '') || own.has(`${name}|${docId}`)) return;
  const variables = get('variables');
  learn(name, docId, variables).catch((err) => console.warn('learn', name, err));
}

async function learn(name, docId, variablesText) {
  if (!(await watchedNames()).has(name)) return;
  const map = await getLearned();
  const old = map[name];
  const now = Date.now();
  let variables = null;
  if (await isFeed(name)) {
    try { variables = JSON.parse(variablesText); } catch { return; }
  }
  if (old && old.doc_id === docId && now - old.at < TOUCH_MS) return;
  map[name] = { doc_id: docId, at: now, ...(variables ? { variables } : {}) };
  await chrome.storage.local.set({ [LEARNED_KEY]: map });
}

export async function learnedAt(name) {
  return (await getLearned())[name]?.at || 0;
}

function dedupe(list) {
  const seen = new Set();
  return list
    .sort((a, b) => b.at - a.at)
    .filter((c) => {
      const k = `${c.name}|${c.doc_id}`;
      return !seen.has(k) && seen.add(k);
    });
}

const registryAt = (reg) => Date.parse(reg?.updated || '') || 0;

// Every known {name, doc_id, from, at} for an operation key, newest first.
export async function candidates(key) {
  const b = await bundledOps();
  const remote = (await remoteOps())?.data;
  const map = await getLearned();
  const list = [];
  for (const [reg, from] of [[remote, 'remote'], [b, 'bundled']]) {
    const op = reg?.ops?.[key];
    if (op) list.push({ name: op.name, doc_id: op.doc_id, from, at: registryAt(reg) });
  }
  // Learned entries win ties: they were seen on Facebook itself.
  for (const name of new Set(list.map((c) => c.name))) {
    if (map[name]) list.push({ name, doc_id: map[name].doc_id, from: 'learned', at: map[name].at + 1 });
  }
  return dedupe(list);
}

// Feed templates {name, doc_id, variables, from, at} for "group" or "page", newest first.
export async function feedCandidates(kind) {
  const b = await bundledOps();
  const remote = (await remoteOps())?.data;
  const map = await getLearned();
  const list = [];
  for (const [reg, from] of [[remote, 'remote'], [b, 'bundled']]) {
    const t = reg?.feed?.[kind];
    if (t?.variables) list.push({ ...t, from, at: registryAt(reg) });
  }
  for (const name of new Set(list.map((c) => c.name))) {
    const l = map[name];
    if (l?.variables) list.push({ name, doc_id: l.doc_id, variables: l.variables, from: 'learned', at: l.at + 1 });
  }
  return dedupe(list);
}

export async function status() {
  const b = await bundledOps();
  const remote = await remoteOps();
  const keys = [...new Set([...Object.keys(b.ops), ...Object.keys(remote?.data?.ops || {})])];
  const rows = [];
  for (const key of keys) rows.push({ key, candidates: await candidates(key) });
  for (const kind of ['home', 'group', 'page']) rows.push({ key: `feed:${kind}`, candidates: await feedCandidates(kind) });
  return {
    rows: rows.map((r) => ({ key: r.key, candidates: r.candidates.map(({ variables, ...c }) => c) })),
    remote: remote && { url: remote.url, fetched_at: remote.fetched_at, error: remote.error, updated: remote.data?.updated },
    bundled_updated: b.updated,
  };
}

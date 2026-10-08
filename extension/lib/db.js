// Posts and run log in IndexedDB, local to this browser profile.

const DB_NAME = 'fb-digest';

let opening = null;

function open() {
  opening ??= new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      const posts = db.createObjectStore('posts', { keyPath: 'id', autoIncrement: true });
      posts.createIndex('key', 'key', { unique: true });
      posts.createIndex('link', 'link');
      db.createObjectStore('runs', { keyPath: 'id', autoIncrement: true });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return opening;
}

const done = (req) => new Promise((resolve, reject) => {
  req.onsuccess = () => resolve(req.result);
  req.onerror = () => reject(req.error);
});

async function store(name, mode = 'readonly') {
  return (await open()).transaction(name, mode).objectStore(name);
}

const all = async (name) => done((await store(name)).getAll());

export const now = () => new Date().toISOString();

// Stable identity across runs. The raw text changes between runs (relative timestamps, reaction
// counts), so hash only the longest lines with digits removed: those are the post body.
async function postKey(text) {
  const norm = (s) => s.replace(/\d+/g, '').replace(/\s+/g, ' ').trim();
  const lines = [...new Set(text.split('\n').map((l) => norm(l).toLowerCase()))];
  const body = lines.filter((l) => l.length >= 20).sort((a, b) => b.length - a.length).slice(0, 3);
  const basis = body.sort().join('\n') || norm(text);
  const hash = await crypto.subtle.digest('SHA-1', new TextEncoder().encode(basis));
  return [...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

// Insert unseen posts; return how many were new. A post scanned from a page/group is also skipped
// when its link is already stored, so an edited post (new text, same permalink) is not stored twice.
export async function addPosts(posts) {
  const rows = await Promise.all(posts.map(async (p) => ({ ...p, key: await postKey(p.text) })));
  const tx = (await open()).transaction('posts', 'readwrite');
  const os = tx.objectStore('posts');
  let added = 0;
  for (const p of rows) {
    if (await done(os.index('key').count(p.key))) continue;
    if (p.source && p.link && await done(os.index('link').count(p.link))) continue;
    await done(os.add({
      key: p.key, link: p.link || null, text: p.text, collected_at: now(), posted_at: p.posted_at || null,
      source: p.source || null, scored_at: null, score: null, sent_at: null, skipped_at: null,
    }));
    added++;
  }
  return added;
}

export async function logRun(startedAt, collected, added, status, note = '') {
  await done((await store('runs', 'readwrite')).add({ started_at: startedAt, collected, new: added, status, note }));
}

export async function lastRun() {
  const runs = await all('runs');
  return runs.reduce((a, r) => (!a || r.started_at > a.started_at ? r : a), null);
}

export async function unscored() {
  return (await all('posts')).filter((p) => !p.scored_at).map(({ id, text }) => ({ id, text }));
}

async function update(ids, fn) {
  const os = await store('posts', 'readwrite');
  for (const id of ids) {
    const row = await done(os.get(id));
    if (row) await done(os.put(fn(row)));
  }
}

export async function saveScore(id, s) {
  await update([id], (r) => ({ ...r, scored_at: now(), is_ad: s.is_ad, is_suggested: s.is_suggested, author: s.author,
                                summary: s.summary, score: s.score, tags: s.tags, reason: s.reason }));
}

export async function digestCandidates(threshold) {
  return (await all('posts'))
    .filter((p) => !p.sent_at && !p.skipped_at && p.score != null && p.score >= threshold && !p.is_ad)
    .sort((a, b) => b.score - a.score || a.id - b.id);
}

export async function recentPosts(limit = 5000) {
  // A post is stored only the first time it is seen, so collected_at at or after the latest run's
  // start marks the posts that run found for the first time.
  const latest = (await lastRun())?.started_at;
  return (await all('posts'))
    .map((p) => ({
      id: p.id, link: p.link, author: p.author, summary: p.summary, score: p.score, tags: p.tags, is_ad: p.is_ad,
      source: p.source, sent_at: p.sent_at, text: p.text.slice(0, 600), skipped: !!p.skipped_at,
      posted_at: p.posted_at || p.collected_at, exact_time: !!p.posted_at, from_source: !!p.source,
      latest: !!latest && p.collected_at >= latest,
    }))
    .sort((a, b) => (a.posted_at < b.posted_at ? 1 : -1))
    .slice(0, limit);
}

export async function setSkipped(ids, skipped) {
  await update(ids, (r) => ({ ...r, skipped_at: skipped ? now() : null }));
}

export async function markSent(ids) {
  const at = now();
  await update(ids, (r) => ({ ...r, sent_at: at }));
}

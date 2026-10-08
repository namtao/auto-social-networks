// Service worker: runs every Facebook task for the manager page, the scheduled runs, and learns
// fresh doc_ids from the requests Facebook's own web app sends.

import * as account from './lib/account.js';
import * as db from './lib/db.js';
import { SessionExpired, apiSession, ensureHeaderRule, sleep, uniform } from './lib/fb.js';
import * as ops from './lib/ops.js';
import { collectFeed, scanSources } from './lib/scan.js';
import { chat, scorePending } from './lib/scorer.js';
import { getSettings, getSources, llmReady, saveSettings, saveSources, telegramReady } from './lib/settings.js';
import * as telegram from './lib/telegram.js';

const MANAGER = chrome.runtime.getURL('manager.html');
const ACTION_DELAY = [3000, 7000]; // between two actions: Facebook throttles accounts that act in bursts
const MIN_FEED_POSTS = 5; // fewer from the home feed usually means Facebook changed its layout
const RUN_JITTER_MS = 30 * 60e3;
const REMOTE_REFRESH_MIN = 360;

// list kind -> {action: [label, flag]}. An action without a flag removes the item from the list;
// one with a flag keeps it and sets that flag, which survives a refresh.
const ACTIONS = {
  friends: { unfriend: ['Hủy kết bạn', null] },
  pages: { unfollow_page: ['Bỏ theo dõi', null] },
  groups: {
    leave_group: ['Rời nhóm', null],
    unfollow_group: ['Bỏ theo dõi', 'unfollowed'],
    mute_group: ['Tắt thông báo', 'muted'],
  },
};
const SOURCE_KINDS = { pages: 'page', groups: 'group' };

// Registered synchronously at top level so a request wakes the worker.
chrome.webRequest.onBeforeRequest.addListener(ops.observe, { urls: ['https://*.facebook.com/api/graphql/*'] }, ['requestBody']);
// Session rules are dropped when the browser restarts; reinstall the header rule on every start.
ensureHeaderRule().catch((err) => console.warn('header rule', err));

// --- Cached lists --------------------------------------------------------------------------------

async function loadList(kind) {
  return (await chrome.storage.local.get(`list:${kind}`))[`list:${kind}`] || { updated: null, items: [] };
}

async function saveList(kind, items, updated) {
  const data = { updated: updated || new Date().toISOString(), items };
  await chrome.storage.local.set({ [`list:${kind}`]: data });
  return data;
}

async function setSources(kind, ids, on) {
  const sourceKind = SOURCE_KINDS[kind];
  const wanted = new Set(ids.map(String));
  const sources = (await getSources()).filter((x) => !(x.kind === sourceKind && wanted.has(x.id)));
  if (on) {
    for (const i of (await loadList(kind)).items) {
      if (wanted.has(i.id)) sources.push({ kind: sourceKind, id: i.id, name: i.name, url: i.url });
    }
  }
  return saveSources(sources);
}

// --- One Facebook task at a time -----------------------------------------------------------------

let busy = false;
let job = { running: false };

const publicJob = () => Object.fromEntries(Object.entries(job).filter(([k]) => k !== 'cancel'));

async function exclusive(fn) {
  if (busy) throw new Error('Đang có một tác vụ chạy; chờ xong hoặc bấm Dừng.');
  busy = true;
  // An extension API call every 20 s keeps the worker alive through long sleeps and LLM calls.
  const keepAlive = setInterval(() => chrome.runtime.getPlatformInfo(), 20e3);
  try {
    return await fn();
  } finally {
    clearInterval(keepAlive);
    busy = false;
  }
}

function launch(kind, label, total, fn) {
  if (busy) throw new Error('Đang có một tác vụ chạy; chờ xong hoặc bấm Dừng.');
  const j = { running: true, kind, label, total, done: 0, current: '', error: null, summary: '', cancel: false };
  job = j;
  // done resolves to the job itself, so a caller can read its summary once it finishes.
  const done = exclusive(async () => {
    try {
      await fn(j);
      return j;
    } catch (err) {
      console.error(`Task ${label} failed at ${j.current}`, err);
      j.error = j.current ? `${j.current}: ${err.message}` : err.message;
      throw err;
    } finally {
      j.running = false;
      j.current = '';
    }
  });
  return { job: publicJob(), done };
}

async function refreshList(kind) {
  return exclusive(async () => {
    const items = await account.LISTS[kind](await apiSession());
    // A flag Facebook could not be asked about (the settings query failed) keeps its cached value.
    const old = new Map((await loadList(kind)).items.map((i) => [i.id, i]));
    const flags = Object.values(ACTIONS[kind]).map(([, f]) => f).filter(Boolean);
    for (const i of items) for (const f of flags) if (i[f] === undefined && old.get(i.id)?.[f]) i[f] = true;
    return saveList(kind, items);
  });
}

function startActions(kind, method, ids) {
  if (!ACTIONS[kind]?.[method]) throw new Error(`Thao tác không hợp lệ: ${method}`);
  const [label, flag] = ACTIONS[kind][method];
  return launch(kind, label, ids.length, async (j) => {
    const names = new Map((await loadList(kind)).items.map((i) => [i.id, i.name]));
    const ctx = await apiSession();
    for (const [n, id] of ids.entries()) {
      if (j.cancel) break;
      if (n) await sleep(uniform(...ACTION_DELAY));
      j.current = names.get(id) || id;
      await account.ACTIONS[method](ctx, id); // throws on the first failure: usually Facebook throttling
      j.done++;
      const cache = await loadList(kind);
      if (flag) {
        await saveList(kind, cache.items.map((i) => (i.id === id ? { ...i, [flag]: true } : i)), cache.updated);
        continue;
      }
      await saveList(kind, cache.items.filter((i) => i.id !== id), cache.updated);
      if (SOURCE_KINDS[kind]) await setSources(kind, [id], false);
    }
  });
}

// Collect (chosen sources, else the home feed), store, score with the LLM, optionally send the digest.
function startScan(sendDigest) {
  return getSources().then((sources) => launch('posts', 'Quét bài', (sources.length || 1) + 1 + (sendDigest ? 1 : 0),
    async (j) => {
      const s = await getSettings();
      const started = db.now();
      const counts = { collected: 0, added: 0 };
      let status = 'error';
      let note = '';
      j.current = 'Mở Facebook';
      try {
        const ctx = await apiSession();
        if (sources.length) {
          await scanSources(ctx, sources, s.sourceDays, async (src, posts) => {
            counts.collected += posts.length;
            counts.added += await db.addPosts(posts);
            j.done++;
            j.current = src.name;
          }, () => j.cancel);
          // Keep the page profile ids resolved during this scan for the next one.
          const resolved = new Map(sources.filter((x) => x.profile_id).map((x) => [x.id, x.profile_id]));
          await saveSources((await getSources()).map((x) => (resolved.has(x.id) ? { ...x, profile_id: resolved.get(x.id) } : x)));
        } else {
          j.current = 'Lấy bài trên feed trang chủ';
          const feed = await collectFeed(ctx, (n) => { j.current = `Lấy bài trên feed trang chủ: ${n} bài`; }, () => j.cancel);
          counts.collected = feed.posts.length;
          counts.added = await db.addPosts(feed.posts);
          j.done++;
          if (feed.stopped) note = `Dừng sớm sau ${counts.collected} bài: ${feed.stopped}`;
        }
        // A few posts in the window is normal for chosen pages/groups; only an empty scan is suspicious.
        const minimum = sources.length ? 1 : MIN_FEED_POSTS;
        status = j.cancel ? 'cancelled' : counts.collected < minimum ? 'too_few' : 'ok';
        if (status === 'too_few' && !note) {
          j.warning = note = `Chỉ thu được ${counts.collected} bài (ngưỡng ${minimum}). Có thể Facebook đổi giao diện hoặc không tải thêm bài khi cuộn.`;
        }
      } catch (err) {
        status = err instanceof SessionExpired ? 'session_expired' : 'error';
        note = err.message;
        throw err;
      } finally {
        // Logged even when stopped or failed: the posts tab marks what the latest run found.
        await db.logRun(started, counts.collected, counts.added, status, note);
      }
      if (j.cancel) return;
      const parts = [`${counts.collected} bài, ${counts.added} bài mới`];
      if (note) parts.push(note);
      j.done = sources.length || 1;
      if (llmReady(s)) {
        j.current = 'Chấm điểm bằng LLM';
        parts.push(`chấm điểm ${await scorePending(s)} bài`);
      } else {
        parts.push('chưa chấm điểm vì chưa cấu hình LLM');
      }
      j.done++;
      if (sendDigest) {
        j.current = 'Gửi digest Telegram';
        if (!telegramReady(s)) parts.push('chưa gửi digest vì chưa cấu hình Telegram');
        else {
          const rows = await db.digestCandidates(s.scoreThreshold);
          if (rows.length) {
            await telegram.sendDigest(s, rows);
            await db.markSent(rows.map((r) => r.id));
          }
          parts.push(`gửi ${rows.length} bài qua Telegram`);
        }
        j.done++;
      }
      j.summary = parts.join(', ');
    }));
}

// --- Scheduled runs ------------------------------------------------------------------------------

function parseTimes(text) {
  return String(text || '').split(/[,;\s]+/).map((t) => t.match(/^(\d{1,2})[:h](\d{2})$/))
    .filter((m) => m && +m[1] < 24 && +m[2] < 60).map((m) => [+m[1], +m[2]]);
}

function slots(times, now) {
  const out = [];
  for (const dayOffset of [-1, 0, 1]) {
    for (const [h, m] of times) {
      const d = new Date(now);
      d.setDate(d.getDate() + dayOffset);
      d.setHours(h, m, 0, 0);
      out.push(d.getTime());
    }
  }
  return out.sort((a, b) => a - b);
}

async function ensureSchedule() {
  await chrome.alarms.clear('auto-run');
  const s = await getSettings();
  const times = parseTimes(s.runTimes);
  if (!s.autoRun || !times.length) return;
  const now = Date.now();
  const { lastAutoRun, autoRunEnabledAt } = await chrome.storage.local.get(['lastAutoRun', 'autoRunEnabledAt']);
  const previous = slots(times, now).filter((t) => t <= now).at(-1);
  const anchor = Math.max(lastAutoRun?.at || 0, autoRunEnabledAt || 0);
  // Like a persistent timer: a slot missed while the browser was closed runs soon after startup.
  const when = anchor && anchor < previous
    ? now + 60e3
    : slots(times, now).find((t) => t > now) + Math.random() * RUN_JITTER_MS;
  await chrome.alarms.create('auto-run', { when });
}

async function autoRun() {
  if (busy) {
    await chrome.alarms.create('auto-run', { when: Date.now() + 10 * 60e3 });
    return;
  }
  const s = await getSettings();
  const record = { at: Date.now(), status: 'ok', note: '' };
  try {
    const j = await (await startScan(telegramReady(s) && llmReady(s))).done;
    record.note = j.summary;
    if (j.warning) await telegram.alert(s, j.warning);
  } catch (err) {
    record.status = 'error';
    record.note = err.message;
    await telegram.alert(s, err instanceof SessionExpired
      ? `Facebook yêu cầu đăng nhập/xác minh. Mở Facebook trên trình duyệt để đăng nhập lại. (${err.message})`
      : `Lượt chạy tự động lỗi: ${err.message}`);
  } finally {
    await chrome.storage.local.set({ lastAutoRun: record });
    await ensureSchedule();
  }
}

async function refreshRemoteOps() {
  try {
    await ops.refreshRemote((await getSettings()).remoteOpsUrl);
  } catch (err) {
    console.warn(err.message);
  }
}

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'auto-run') autoRun();
  if (alarm.name === 'remote-ops') refreshRemoteOps();
});

async function setup() {
  await chrome.alarms.create('remote-ops', { periodInMinutes: REMOTE_REFRESH_MIN });
  await ensureSchedule();
  await refreshRemoteOps();
}

chrome.runtime.onStartup.addListener(setup);
chrome.runtime.onInstalled.addListener(async ({ reason }) => {
  await setup();
  if (reason === 'install') await openManager();
});

async function openManager() {
  const [tab] = await chrome.tabs.query({ url: MANAGER });
  if (tab) {
    await chrome.tabs.update(tab.id, { active: true });
    await chrome.windows.update(tab.windowId, { focused: true });
  } else {
    await chrome.tabs.create({ url: MANAGER });
  }
}

chrome.action.onClicked.addListener(openManager);

// --- Messages from the manager page --------------------------------------------------------------

async function saveAllSettings(patch) {
  const before = await getSettings();
  const s = await saveSettings(patch);
  if (s.autoRun && !before.autoRun) await chrome.storage.local.set({ autoRunEnabledAt: Date.now() });
  await ensureSchedule();
  if (s.remoteOpsUrl !== before.remoteOpsUrl) await refreshRemoteOps();
  return s;
}

async function testLlm(patch) {
  const s = { ...(await getSettings()), ...patch };
  s.llmUrl = String(s.llmUrl || '').trim().replace(/\/+$/, '');
  if (!llmReady(s)) throw new Error('Cần điền URL và chọn model.');
  const reply = await chat(s, 'Reply with the single word OK.', 'ping');
  return { reply: String(reply).slice(0, 200) };
}

async function postsView() {
  const s = await getSettings();
  return {
    items: await db.recentPosts(), days: s.sourceDays, threshold: s.scoreThreshold,
    last_run: (await db.lastRun())?.started_at || null, llm: llmReady(s), telegram: telegramReady(s),
  };
}

async function route(path, body) {
  const [kind, verb] = path.split('/');
  if (ACTIONS[kind]) {
    if (!verb) return loadList(kind);
    if (verb === 'refresh') return refreshList(kind);
    if (verb === 'action') {
      const { job: j, done } = startActions(kind, String(body.method), (body.ids || []).map(String));
      done.catch(() => {}); // the error is shown through the job
      return j;
    }
  }
  switch (path) {
    case 'job': return publicJob();
    case 'job/cancel': job.cancel = true; return publicJob();
    case 'sources': return body ? setSources(body.kind, body.ids || [], !!body.on) : getSources();
    case 'posts': return postsView();
    case 'posts/skip':
      await db.setSkipped((body.ids || []).map(Number), !!body.skip);
      return { ok: true };
    case 'scan': {
      const { job: j, done } = await startScan(!!body?.digest);
      done.catch(() => {}); // the error is shown through the job
      return j;
    }
    case 'settings': return body ? saveAllSettings(body) : getSettings();
    case 'settings/auto-run': return (await chrome.storage.local.get('lastAutoRun')).lastAutoRun || null;
    case 'llm/test': return testLlm(body || {});
    case 'ops': return ops.status();
    case 'ops/refresh':
      await ops.refreshRemote((await getSettings()).remoteOpsUrl);
      return ops.status();
    default: throw new Error(`Không có API ${path}`);
  }
}

chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  if (sender.id !== chrome.runtime.id || !sender.url?.startsWith(MANAGER)) return false;
  route(msg.path, msg.body).then(
    (data) => reply({ ok: true, data }),
    (err) => reply({ ok: false, error: err.message || String(err) }),
  );
  return true;
});

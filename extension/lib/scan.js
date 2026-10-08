// Collect posts: from chosen pages/groups through their feed GraphQL query, or from the home feed
// by scrolling it like a person would.

import { FB, FacebookError, checkSession, closeWindow, fetchPage, first, graphql, jsonLines, openWindow,
         scrollBy, sleep, uniform } from './fb.js';
import { bundledOps, feedCandidates, learnedAt } from './ops.js';

const MIN_TEXT = 20; // photo-only posts give the LLM nothing to score
const FAST_MAX_CALLS = 12; // per source, about 3 posts per call
const SCAN_CONCURRENCY = 4;
const SOURCE_SCROLL_ROUNDS = 8;
// Home feed
const MAX_POSTS = 60;
const HOME_MAX_CALLS = 15; // about 5-10 posts per call
const SCROLL_ROUNDS = 60;
const MAX_IDLE_ROUNDS = 8; // rounds without a new post before assuming the feed stopped loading

export function sourceUrl(src) {
  if (src.kind === 'group') return `${FB}/groups/${src.id}/?sorting_setting=CHRONOLOGICAL`;
  return src.url || `${FB}/${src.id}`;
}

// Collect every top-level Story in obj into found[post_id], filling fields still missing.
export function stories(obj, found) {
  if (Array.isArray(obj)) { for (const v of obj) stories(v, found); return; }
  if (!obj || typeof obj !== 'object') return;
  if (obj.__typename !== 'Story' || !obj.post_id) { for (const v of Object.values(obj)) stories(v, found); return; }
  const s = found[obj.post_id] ||= { post_id: obj.post_id, time: null, text: '', author: '', url: '' };
  s.time ||= first(obj, 'creation_time', Number.isInteger);
  if (!s.text) s.text = first(obj, 'message', (v) => v && typeof v === 'object' && v.text)?.text || '';
  if (!s.author) s.author = first(obj, 'actors', (v) => Array.isArray(v) && v[0]?.name)?.[0].name || '';
  s.url ||= first(obj, 'url', (v) => typeof v === 'string' && ['/posts/', 'permalink', 'story_fbid'].some((m) => v.includes(m))) || '';
  // Paid ads carry their ad payload here; organic stories have it null.
  s.ad ||= !!first(obj, 'sponsored_data', (v) => v && typeof v === 'object');
}

const since = (days) => Date.now() / 1000 - days * 86400;
const oldest = (found) => Math.min(...Object.values(found).map((s) => s.time).filter(Boolean));

// src is null for the home feed.
function toPosts(found, src, from) {
  return Object.values(found)
    .filter((s) => s.time && s.time >= from && !s.ad && s.text.trim().length >= MIN_TEXT)
    .map((s) => ({
      text: `${s.author}\n${s.text}`.trim(),
      link: s.url || `${FB}/${s.post_id}`,
      posted_at: new Date(s.time * 1000).toISOString(),
      source: src?.name ?? null,
    }));
}

// A page's timeline belongs to its linked profile, whose id only appears in the page HTML.
async function profileId(src) {
  if (!src.profile_id) {
    // Fetch by path: page urls may lack "www.", which would make the request cross-origin.
    const path = new URL(sourceUrl(src)).pathname;
    const { html } = await fetchPage(path);
    const m = (html || '').match(/"userVanity":"[^"]*","userID":"(\d+)"/) || (html || '').match(/"userID":"(\d+)"/);
    if (!m) throw new FacebookError('không tìm thấy ID hồ sơ của trang');
    src.profile_id = m[1];
  }
  return src.profile_id;
}

// Fast path: replay the feed pagination query the page itself sends, without rendering anything.
async function fastScan(ctx, src, days, template) {
  const from = since(days);
  const nodeId = src.kind === 'page' ? await profileId(src) : src.id;
  const variables = { ...template.variables, id: nodeId, cursor: null };
  if ('youthIntegrityHostID' in variables) variables.youthIntegrityHostID = nodeId;
  const found = {};
  for (let call = 0; call < FAST_MAX_CALLS; call++) {
    if (call) await sleep(uniform(300, 800));
    const reply = await graphql(ctx, template.name, template.doc_id, variables);
    const objs = [...jsonLines(reply.text)];
    if (reply.status !== 200 || !objs.length || (objs[0].errors && !objs[0].data)) {
      throw new FacebookError(`${template.name}: HTTP ${reply.status} ${reply.text.slice(0, 200)}`);
    }
    const before = Object.keys(found).length;
    for (const o of objs) stories(o, found);
    if (call === 0 && !Object.keys(found).length) throw new FacebookError(`${template.name} không trả về bài nào`);
    const info = objs.map((o) => first(o, 'page_info', (v) => v && typeof v === 'object' && 'end_cursor' in v)).find(Boolean) || {};
    const cursor = info.end_cursor;
    if (!info.has_next_page || !cursor || cursor === variables.cursor || Object.keys(found).length === before
        || oldest(found) < from) break;
    variables.cursor = cursor;
  }
  return toPosts(found, src, from);
}

async function fastScanAny(ctx, src, days, templates) {
  const errors = [];
  for (const t of templates) {
    try {
      return await fastScan(ctx, src, days, t);
    } catch (err) {
      errors.push(`[${t.from}] ${err.message}`);
    }
  }
  throw new FacebookError(errors.join(' | ') || 'chưa có mẫu request');
}

function embeddedJson() {
  return [...document.querySelectorAll('script[type="application/json"]')]
    .map((s) => s.textContent).filter((t) => t.includes('creation_time'));
}

async function feedName(kind) {
  return (await feedCandidates(kind))[0]?.name || (await bundledOps()).feed[kind].name;
}

// Slow path: open src and scroll like a person. The first posts come from JSON embedded in the
// page; scrolling makes the page send its feed query, which ops.observe() learns as a template,
// and the rest of the window is then read through the fast path with that fresh template.
async function slowScan(ctx, win, src, days) {
  const from = since(days);
  const name = await feedName(src.kind);
  const started = Date.now();
  await win.navigate(sourceUrl(src));
  await sleep(uniform(5000, 7000));
  const found = {};
  for (const text of (await win.exec(embeddedJson)) || []) {
    try { stories(JSON.parse(text), found); } catch { /* not JSON */ }
  }
  for (let i = 0; i < SOURCE_SCROLL_ROUNDS && (await learnedAt(name)) < started; i++) {
    await win.exec(scrollBy, [uniform(3, 4.5)]);
    await sleep(uniform(2000, 3500));
  }
  const posts = toPosts(found, src, from);
  if ((await learnedAt(name)) < started) return posts;
  const fresh = (await feedCandidates(src.kind)).filter((t) => t.from === 'learned');
  const more = await fastScanAny(ctx, src, days, fresh).catch(() => []);
  const links = new Set(more.map((p) => p.link));
  return [...more, ...posts.filter((p) => !links.has(p.link))];
}

function shuffle(list) {
  const a = [...list];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// Scan every source: fast path in parallel, slow path (one shared window) for any that fail.
// onDone(src, posts) is awaited after each source; a failing source is logged and skipped.
export async function scanSources(ctx, sources, days, onDone, cancelled) {
  const started = Date.now();
  const failed = [];
  const queue = shuffle(sources);
  const templates = {
    group: await feedCandidates('group'),
    page: await feedCandidates('page'),
  };

  async function worker() {
    for (let src = queue.shift(); src; src = queue.shift()) {
      if (cancelled()) return;
      try {
        const got = await fastScanAny(ctx, src, days, templates[src.kind]);
        await onDone(src, got);
      } catch (err) {
        console.warn(`Fast scan of ${src.name} failed; retrying by opening it`, err.message);
        failed.push(src);
      }
    }
  }
  await Promise.all(Array.from({ length: SCAN_CONCURRENCY }, worker));

  let win = null;
  try {
    for (const src of failed) {
      if (cancelled()) break;
      let got = null;
      // A template learned during this scan (by an earlier slow scan) may fix the fast path.
      const fresh = (await feedCandidates(src.kind)).filter((t) => t.from === 'learned' && t.at > started);
      if (fresh.length) got = await fastScanAny(ctx, src, days, fresh).catch(() => null);
      if (!got) {
        try {
          win ??= await openWindow('about:blank');
          got = await slowScan(ctx, win, src, days);
        } catch (err) {
          console.warn(`Scanning ${src.name} failed`, err);
          got = [];
        }
      }
      await onDone(src, got);
    }
  } finally {
    await closeWindow(win);
  }
}

// Injected into the feed tab; resolves to [{text, link}] for the posts currently in the DOM.
// Deliberately "dumb": no author/content parsing, the LLM does that from the raw text. The one
// exception is paid ads, which carry a cheap and reliable marker (see SPONSORED).
async function collectVisible() {
  const MIN_LEN = 40;
  const MAX_LEN = 6000;
  // FB scrambles the "Sponsored" label; in innerText it collapses to a line holding only a
  // WORD JOINER where an organic post shows its timestamp.
  const SPONSORED = /^[ \t]*⁠[ \t]*$/m;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  // Keep only the outermost match so comments (also role="article") are not returned separately.
  const nodes = [...document.querySelectorAll('[role="feed"] > div, [aria-posinset], [role="article"]')];
  const matched = new Set(nodes);
  const posts = nodes.filter((el) => {
    for (let p = el.parentElement; p; p = p.parentElement) if (matched.has(p)) return false;
    return true;
  });
  // Expand truncated bodies and hover links (FB fills some permalink hrefs on hover).
  const MORE = /^(see more|xem thêm)$/i;
  for (const post of posts) {
    for (const btn of post.querySelectorAll('[role="button"]')) if (MORE.test(btn.innerText.trim())) btn.click();
    for (const a of post.querySelectorAll('a')) a.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
  }
  await sleep(300 + Math.random() * 300);
  // Most specific first: a post permalink beats a video/reel link, which beats a photo link.
  const LINK_PREFERENCE = [/\/posts\/|\/permalink|story_fbid=|\/story\.php/, /\/(reel|videos)\/|\/watch\/\?v=/, /\/photo|fbid=/];
  const postLink = (post) => {
    const anchors = [...post.querySelectorAll('a[href]')].filter((a) => !a.href.includes('/hashtag/'));
    for (const re of LINK_PREFERENCE) {
      const a = anchors.find((x) => re.test(x.href));
      if (a) return a;
    }
    return null;
  };
  const cleanLink = (href) => {
    const url = new URL(href);
    for (const key of [...url.searchParams.keys()]) if (key.startsWith('__')) url.searchParams.delete(key);
    return url.toString();
  };
  return posts
    .map((post) => {
      const a = postLink(post);
      return { text: post.innerText.trim().slice(0, MAX_LEN), link: a ? cleanLink(a.href) : null };
    })
    .filter((p) => p.text.length >= MIN_LEN && !SPONSORED.test(p.text));
}

// Home feed through the pagination query the web app sends while the person scrolls it.
async function homeFeedApi(ctx, template, onProgress, cancelled) {
  const found = {};
  let cursor = null;
  for (let call = 0; call < HOME_MAX_CALLS && !cancelled(); call++) {
    if (call) await sleep(uniform(800, 1800));
    // A fresh query id and no "recently viewed" list, as on a fresh page load.
    const variables = { ...template.variables, cursor, recentVPVs: [], clientQueryId: crypto.randomUUID() };
    const reply = await graphql(ctx, template.name, template.doc_id, variables);
    const objs = [...jsonLines(reply.text)];
    if (reply.status !== 200 || !objs.length || (objs[0].errors && !objs[0].data)) {
      throw new FacebookError(`${template.name}: HTTP ${reply.status} ${reply.text.slice(0, 200)}`);
    }
    for (const o of objs) stories(o, found);
    if (call === 0 && !Object.keys(found).length) throw new FacebookError(`${template.name} không trả về bài nào`);
    const count = toPosts(found, null, 0).length;
    onProgress(count);
    if (count >= MAX_POSTS) break;
    const info = objs.map((o) => first(o, 'page_info', (v) => v && typeof v === 'object' && 'end_cursor' in v)).find(Boolean) || {};
    if (info.has_next_page === false || !info.end_cursor || info.end_cursor === cursor) break;
    cursor = info.end_cursor;
  }
  return toPosts(found, null, 0).slice(0, MAX_POSTS);
}

// Home feed posts, read in the background through the API. Only when every known template fails
// does it scroll the feed in a window, which also lets ops.observe() learn the current template.
// Returns {posts, stopped}, where stopped explains an early stop that kept the posts found before it.
export async function collectFeed(ctx, onProgress, cancelled) {
  const errors = [];
  for (const t of await feedCandidates('home')) {
    try {
      return { posts: await homeFeedApi(ctx, t, onProgress, cancelled), stopped: '' };
    } catch (err) {
      errors.push(`[${t.from}] ${err.message}`);
    }
  }
  console.warn('Home feed API failed; scrolling the feed instead', errors.join(' | '));
  const started = Date.now();
  const scrolled = await scrollFeed(onProgress, cancelled);
  // Scrolling made the page send its current feed query; read the feed through that instead of
  // the page text, which carries less (no post time) and more noise.
  const fresh = (await feedCandidates('home')).filter((t) => t.from === 'learned' && t.at > started);
  for (const t of fresh) {
    try {
      return { posts: await homeFeedApi(ctx, t, onProgress, cancelled), stopped: '' };
    } catch (err) {
      console.warn('Home feed API still failing with the learned template', err.message);
    }
  }
  return scrolled;
}

// Scroll the home feed in a window of its own and read the posts from the page.
async function scrollFeed(onProgress, cancelled) {
  const win = await openWindow(`${FB}/`);
  try {
    await sleep(uniform(6000, 10000));
    await win.guard(() => checkSession(win.tabId));
    const posts = new Map();
    let idle = 0;
    let stopped = '';
    for (let round = 0; round < SCROLL_ROUNDS && !cancelled(); round++) {
      const before = posts.size;
      try {
        for (const p of (await win.exec(collectVisible)) || []) {
          const key = p.link || p.text.slice(0, 200);
          // Keep the longest version: a later round may see the expanded body.
          if (p.text.length > (posts.get(key)?.text.length || 0)) posts.set(key, p);
        }
        onProgress(posts.size);
        if (posts.size >= MAX_POSTS) break;
        idle = posts.size === before ? idle + 1 : 0;
        if (idle >= MAX_IDLE_ROUNDS) {
          console.warn(`Feed stopped loading new posts after ${posts.size} posts`);
          break;
        }
        if (idle) {
          // Nudge lazy-loading: step back up a little and give the feed time to fetch.
          await win.exec(scrollBy, [-uniform(0.3, 0.6)]);
          await sleep(uniform(2000, 4000));
        }
        await win.exec(scrollBy, [uniform(0.8, 1.5)]);
        await sleep(uniform(1000, 2500));
      } catch (err) {
        if (!posts.size) throw err;
        // Window closed or page crashed mid-run: keep what was already collected.
        stopped = err.message;
        break;
      }
    }
    return { posts: [...posts.values()].map((p) => ({ ...p, posted_at: null, source: null })), stopped };
  } finally {
    await closeWindow(win);
  }
}

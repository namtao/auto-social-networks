// Talk to Facebook with the person's own logged-in session. API calls and page fetches run from the
// service worker, so nothing opens on screen; only work that must render and scroll a page (the home
// feed, or opening a source to learn its feed query) uses a small window.

import { candidates, markOwn } from './ops.js';

export const FB = 'https://www.facebook.com';
const STALE_HINT = 'Facebook có thể đã đổi doc_id: hãy làm thao tác này một lần bằng tay trên Facebook để extension tự học, '
  + 'hoặc bấm "Cập nhật cấu hình" trong tab Cài đặt.';
const NOT_LOGGED_IN = 'Chưa đăng nhập Facebook trên trình duyệt này, hoặc Facebook yêu cầu xác minh. '
  + 'Mở facebook.com để đăng nhập rồi thử lại.';
// Without a browser-like Accept header Facebook answers page requests with an empty body.
const HTML_HEADERS = { accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8' };
const HEADER_RULE_ID = 1;

export class FacebookError extends Error {}
export class SessionExpired extends FacebookError {}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const uniform = (a, b) => a + Math.random() * (b - a);

// The service worker's requests carry Origin: chrome-extension://…, which Facebook's API rejects.
// A session rule gives this extension's own tab-less requests the site's origin, as the web app has.
export async function ensureHeaderRule() {
  await chrome.declarativeNetRequest.updateSessionRules({
    removeRuleIds: [HEADER_RULE_ID],
    addRules: [{
      id: HEADER_RULE_ID,
      priority: 1,
      action: {
        type: 'modifyHeaders',
        requestHeaders: [
          { header: 'origin', operation: 'set', value: FB },
          { header: 'referer', operation: 'set', value: `${FB}/` },
          { header: 'sec-fetch-site', operation: 'set', value: 'same-origin' },
        ],
      },
      condition: { urlFilter: `|${FB}/`, tabIds: [chrome.tabs.TAB_ID_NONE], initiatorDomains: [chrome.runtime.id] },
    }],
  });
}

// GET a facebook.com page with the person's cookies; returns {url, html} after redirects.
export async function fetchPage(path) {
  const res = await fetch(new URL(path, FB), { credentials: 'include', headers: HTML_HEADERS });
  return { url: res.url, html: await res.text() };
}

// The person's id and the page tokens every API call needs, read from the home page.
export async function apiSession() {
  await ensureHeaderRule();
  let page;
  try {
    page = await fetchPage('/');
  } catch (err) {
    throw new FacebookError(`Không kết nối được Facebook: ${err.message}`);
  }
  const { url, html } = page;
  const user = (html.match(/"USER_ID":"(\d+)"/) || [])[1];
  const dtsg = (html.match(/"DTSGInitialData",\[\],\{"token":"([^"]+)"/) || [])[1];
  const lsd = (html.match(/"LSD",\[\],\{"token":"([^"]+)"/) || [])[1] || '';
  if (!user || user === '0' || !dtsg || /^\/(login|checkpoint|two_step_verification)/.test(new URL(url).pathname)) {
    throw new SessionExpired(NOT_LOGGED_IN);
  }
  return { user, dtsg, lsd };
}

export async function exec(tabId, func, args = []) {
  const [res] = await chrome.scripting.executeScript({ target: { tabId }, world: 'MAIN', func, args });
  return res?.result;
}

function sessionInfo() {
  return {
    user: (document.cookie.match(/(?:^|; )c_user=(\d+)/) || [])[1] || '',
    loggedOut: /^\/(login|checkpoint|two_step_verification)/.test(location.pathname)
      || !!document.querySelector('input[name="pass"]'),
  };
}

export async function checkSession(tabId) {
  const info = await exec(tabId, sessionInfo);
  if (!info?.user || info.loggedOut) throw new SessionExpired(NOT_LOGGED_IN);
  return info.user;
}

// Lazy-loading lists only grow while the page renders, which a background tab does not do, so
// anything that scrolls gets a small window of its own.
const WINDOW_CLOSED = 'Cửa sổ Facebook mà extension mở để quét đã bị đóng nên tác vụ dừng lại. '
  + 'Cứ để cửa sổ đó chạy, nó tự đóng khi xong.';

class ScanWindow {
  constructor(created) {
    this.windowId = created.id;
    this.tabId = created.tabs[0].id;
    this.closed = false;
    // Chrome may swap in a prerendered tab with a new id when the page navigates.
    this.onReplaced = (added, removed) => { if (removed === this.tabId) this.tabId = added; };
    this.onRemoved = (id) => { if (id === this.windowId) this.closed = true; };
    chrome.tabs.onReplaced.addListener(this.onReplaced);
    chrome.windows.onRemoved.addListener(this.onRemoved);
  }

  // Runs fn, turning the "No tab with id" style errors of a closed window into a clear message.
  async guard(fn) {
    if (this.closed) throw new FacebookError(WINDOW_CLOSED);
    try {
      return await fn();
    } catch (err) {
      const gone = this.closed || !(await chrome.windows.get(this.windowId).catch(() => null));
      throw gone ? new FacebookError(WINDOW_CLOSED) : err;
    }
  }

  exec(func, args = []) {
    return this.guard(() => exec(this.tabId, func, args));
  }

  waitComplete() {
    return this.guard(async () => {
      const end = Date.now() + 45000;
      while (Date.now() < end) {
        if ((await chrome.tabs.get(this.tabId)).status === 'complete') return;
        await sleep(500);
      }
      throw new FacebookError('Trang Facebook tải quá lâu.');
    });
  }

  async navigate(url) {
    await this.guard(() => chrome.tabs.update(this.tabId, { url }));
    await sleep(800);
    await this.waitComplete();
  }

  async close() {
    chrome.tabs.onReplaced.removeListener(this.onReplaced);
    chrome.windows.onRemoved.removeListener(this.onRemoved);
    if (!this.closed) await chrome.windows.remove(this.windowId).catch(() => {});
  }
}

export async function openWindow(url) {
  const win = new ScanWindow(await chrome.windows.create({ url, type: 'popup', width: 1100, height: 900, focused: true }));
  try {
    await win.waitComplete();
  } catch (err) {
    await win.close();
    throw err;
  }
  return win;
}

export async function closeWindow(win) {
  await win?.close();
}

export function scrollBy(fraction) {
  window.scrollBy({ top: Math.round(window.innerHeight * fraction), behavior: 'smooth' });
}

// POST a GraphQL request the way the web app does; returns {status, text}.
export async function graphql(ctx, name, docId, variables) {
  markOwn(name, docId, 1);
  try {
    const body = new URLSearchParams({
      av: ctx.user, __user: ctx.user, __a: '1', fb_dtsg: ctx.dtsg, lsd: ctx.lsd,
      fb_api_caller_class: 'RelayModern', fb_api_req_friendly_name: name,
      variables: JSON.stringify(variables), server_timestamps: 'true', doc_id: docId,
    });
    const res = await fetch(`${FB}/api/graphql/`, {
      method: 'POST', body, credentials: 'include',
      headers: { 'x-fb-friendly-name': name, 'x-fb-lsd': ctx.lsd },
    });
    return { status: res.status, text: await res.text() };
  } catch (err) {
    throw new FacebookError(`${name}: không gọi được API Facebook: ${err.message}`);
  } finally {
    // The webRequest event for this call has fired by the time the response is read.
    markOwn(name, docId, -1);
  }
}

// Breadth-first search for obj[...][key] passing accept(), not entering shared stories.
export function first(obj, key, accept) {
  const queue = [obj];
  while (queue.length) {
    const o = queue.shift();
    if (Array.isArray(o)) queue.push(...o);
    else if (o && typeof o === 'object') {
      if (key in o && accept(o[key])) return o[key];
      for (const [k, v] of Object.entries(o)) if (k !== 'attached_story') queue.push(v);
    }
  }
  return null;
}

// GraphQL responses stream deferred fragments as extra JSON lines.
export function* jsonLines(text) {
  for (const line of text.split('\n')) {
    if (!line.startsWith('{')) continue;
    try { yield JSON.parse(line); } catch { /* partial line */ }
  }
}

// Runs operation `key` with each known doc_id, newest first, until Facebook accepts one.
// accept(data) lets a mutation reject a reply whose payload is empty (a stale doc_id often answers
// with null fields rather than an error).
export async function gql(ctx, key, variables, accept = () => true) {
  const list = await candidates(key);
  if (!list.length) throw new FacebookError(`Không có doc_id cho thao tác ${key}.`);
  const errors = [];
  for (const c of list) {
    const reply = await graphql(ctx, c.name, c.doc_id, variables);
    const first = reply.text.split('\n', 1)[0];
    let body;
    try {
      body = JSON.parse(first);
    } catch {
      errors.push(`[${c.from}] HTTP ${reply.status}, phản hồi không phải JSON: ${first.slice(0, 150)}`);
      continue;
    }
    if (body.errors && !body.data) {
      errors.push(`[${c.from}] ${body.errors[0]?.message || JSON.stringify(body.errors[0]).slice(0, 150)}`);
      continue;
    }
    const data = body.data || {};
    if (accept(data)) return data;
    errors.push(`[${c.from}] ${JSON.stringify(body).slice(0, 200)}`);
  }
  throw new FacebookError(`${list[0].name}: ${errors.join(' | ')}. ${STALE_HINT}`);
}

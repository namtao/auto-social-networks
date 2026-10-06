import asyncio
import json
import logging
import random
import re
import time
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import parse_qs, urlsplit

import zendriver as zd
from zendriver import cdp

from .config import SOURCES_FILE, Settings

COLLECT_JS = (Path(__file__).with_name("collector.js")).read_text(encoding="utf-8")
LOGGED_OUT_JS = (
    "/^\\/(login|checkpoint|two_step_verification)/.test(location.pathname)"
    " || !!document.querySelector('input[name=\"pass\"]')"
)
LOGIN_TIMEOUT_S = 15 * 60
WINDOW_SIZE = "1280,1400"
SCROLL_SPEED = 2000  # px/s of the synthesized scroll gesture
MAX_IDLE_ROUNDS = 8  # rounds without a new post before assuming the feed stopped loading

log = logging.getLogger(__name__)


class SessionExpired(Exception):
    """Facebook shows a login or checkpoint page instead of the feed."""


async def _start_browser(s: Settings, headless: bool) -> zd.Browser:
    return await zd.start(
        user_data_dir=s.profile_dir,
        headless=headless,
        browser=s.browser,
        browser_executable_path=s.browser_path,
        # The default window is ~800x600: each scroll then moves less than one post.
        browser_args=[f"--window-size={WINDOW_SIZE}"],
    )


async def _close(browser: zd.Browser) -> None:
    """Close the browser gracefully so it writes the session cookies to disk.

    zendriver's stop() checks Popen.returncode without polling, so it always SIGKILLs
    the browser after 3 s, which loses cookies that were not flushed yet.
    """
    process = browser._process
    try:
        await browser.connection.send(cdp.browser.close())
        for _ in range(80):
            if process is None or process.poll() is not None:
                break
            await asyncio.sleep(0.25)
    except Exception:
        pass  # browser already gone; stop() below cleans up
    await browser.stop()


async def _open(browser: zd.Browser, s: Settings, url: str):
    tab = await browser.get(url)
    if s.minimized and not s.headless:
        await tab.minimize()
        # A minimized window loses focus; keep the page believing it is focused.
        await tab.send(cdp.emulation.set_focus_emulation_enabled(True))
    return tab


async def _logged_in(browser: zd.Browser) -> bool:
    cookies = await browser.cookies.get_all()
    return any(c.name == "c_user" and c.domain.endswith("facebook.com") for c in cookies)


async def login(s: Settings) -> None:
    """Open the dedicated profile headful so the user can log in by hand once."""
    browser = await _start_browser(s, headless=False)
    try:
        await browser.get("https://www.facebook.com/")
        print("Log in to Facebook in the browser window; this closes by itself once logged in.")
        for _ in range(LOGIN_TIMEOUT_S // 3):
            await asyncio.sleep(3)
            try:
                logged_in = await _logged_in(browser)
            except Exception as exc:
                raise SessionExpired("browser window was closed before login completed") from exc
            if logged_in:
                await asyncio.sleep(5)  # let Facebook finish setting the remaining cookies
                print("Logged in, session saved.")
                return
        raise SessionExpired("login not completed within the time limit")
    finally:
        await _close(browser)


async def collect(s: Settings) -> list[dict]:
    """Scroll the feed like a person would and return [{text, link}] for every post seen."""
    browser = await _start_browser(s, headless=s.headless)
    try:
        tab = await _open(browser, s, s.feed_url)
        await tab.sleep(random.uniform(6, 10))
        if not await _logged_in(browser) or await tab.evaluate(LOGGED_OUT_JS):
            raise SessionExpired(await tab.evaluate("location.href"))

        posts: dict[str, dict] = {}
        idle_rounds = 0
        for _ in range(s.scroll_rounds):
            before = len(posts)
            try:
                for post in await tab.evaluate(COLLECT_JS, await_promise=True) or []:
                    key = post["link"] or post["text"][:200]
                    # Keep the longest version: a later round may see the expanded body.
                    if len(post["text"]) > len(posts.get(key, {}).get("text", "")):
                        posts[key] = post
                if len(posts) >= s.max_posts:
                    break
                idle_rounds = idle_rounds + 1 if len(posts) == before else 0
                if idle_rounds >= MAX_IDLE_ROUNDS:
                    log.warning("Feed stopped loading new posts after %d posts", len(posts))
                    break
                if idle_rounds:
                    # Nudge lazy-loading: step back up a little and give the feed time to fetch.
                    await tab.scroll_up(random.randint(30, 60), speed=SCROLL_SPEED)
                    await tab.sleep(random.uniform(2, 4))
                await tab.scroll_down(random.randint(80, 150), speed=SCROLL_SPEED)
                await tab.sleep(random.uniform(*s.scroll_delay))
            except Exception:
                if not posts:
                    raise
                # Browser died or was closed mid-run: keep what was already collected.
                log.warning("Browser lost after %d posts, stopping early", len(posts), exc_info=True)
                break
        return list(posts.values())
    finally:
        await _close(browser)


# --- Chosen pages/groups -------------------------------------------------------------------------
# A page or group renders its first posts from JSON embedded in the HTML and fetches the rest as
# GraphQL while scrolling. Both carry Story objects with the exact creation_time, which the DOM
# hides, so posts are read from that JSON instead of the page text.

EMBEDDED_JSON_JS = (
    "[...document.querySelectorAll('script[type=\"application/json\"]')]"
    ".map((s) => s.textContent).filter((t) => t.includes('creation_time'))"
)
SOURCE_SCROLL_ROUNDS = 8  # upper bound; scanning stops once posts are older than the SOURCE_DAYS window
MIN_TEXT = 20  # photo-only posts give the LLM nothing to score


def load_sources() -> list[dict]:
    """[{kind: "page"|"group", id, name, url}] chosen in the web UI."""
    try:
        return json.loads(SOURCES_FILE.read_text(encoding="utf-8"))
    except FileNotFoundError:
        return []


def source_url(src: dict) -> str:
    if src["kind"] == "group":
        return f"https://www.facebook.com/groups/{src['id']}/?sorting_setting=CHRONOLOGICAL"
    return src.get("url") or f"https://www.facebook.com/{src['id']}"


def _first(obj, key: str, accept):
    """Breadth-first search for obj[...][key] passing accept(), not entering shared stories."""
    queue = [obj]
    while queue:
        o = queue.pop(0)
        if isinstance(o, dict):
            if key in o and accept(o[key]):
                return o[key]
            queue += [v for k, v in o.items() if k != "attached_story"]
        elif isinstance(o, list):
            queue += o
    return None


def _stories(obj, found: dict) -> None:
    """Collect every top-level Story in obj into found[post_id], filling fields still missing."""
    if isinstance(obj, list):
        for v in obj:
            _stories(v, found)
        return
    if not isinstance(obj, dict):
        return
    if obj.get("__typename") != "Story" or not obj.get("post_id"):
        for v in obj.values():
            _stories(v, found)
        return
    story = found.setdefault(obj["post_id"], {"post_id": obj["post_id"], "time": None, "text": "", "author": "", "url": ""})
    if not story["time"]:
        story["time"] = _first(obj, "creation_time", lambda v: isinstance(v, int))
    if not story["text"]:
        message = _first(obj, "message", lambda v: isinstance(v, dict) and v.get("text"))
        story["text"] = message["text"] if message else ""
    if not story["author"]:
        actors = _first(obj, "actors", lambda v: isinstance(v, list) and v and isinstance(v[0], dict) and v[0].get("name"))
        story["author"] = actors[0]["name"] if actors else ""
    if not story["url"]:
        story["url"] = _first(
            obj, "url", lambda v: isinstance(v, str) and any(m in v for m in ("/posts/", "permalink", "story_fbid"))
        ) or ""


def _json_lines(text: str):
    # GraphQL responses stream deferred fragments as extra JSON lines.
    for line in text.splitlines():
        if line.startswith("{"):
            try:
                yield json.loads(line)
            except json.JSONDecodeError:
                pass


def _since(days: int) -> float:
    """Oldest post time to keep: the last `days` days counted back from now."""
    return time.time() - days * 86400


def _to_posts(found: dict, src: dict, since: float) -> list[dict]:
    posts = []
    for s in found.values():
        if not s["time"] or s["time"] < since or len(s["text"].strip()) < MIN_TEXT:
            continue
        posts.append({
            "text": f"{s['author']}\n{s['text']}".strip(),
            "link": s["url"] or f"https://www.facebook.com/{s['post_id']}",
            "posted_at": datetime.fromtimestamp(s["time"], timezone.utc),
            "source": src["name"],
        })
    return posts


async def scan_source(tab, src: dict, days: int, templates: dict | None = None) -> list[dict]:
    """Slow path: open src and scroll like a person, reading posts from the page's JSON.

    Also records the feed pagination request the page sends into templates[kind], so the fast
    path can replay it for every other source of that kind.
    """
    loop = asyncio.get_running_loop()
    since = _since(days)
    graphql: set[str] = set()
    pending = []

    def on_request(ev):
        if not isinstance(ev, cdp.network.RequestWillBeSent) or "/api/graphql" not in ev.request.url:
            return
        graphql.add(ev.request_id)
        form = parse_qs(ev.request.post_data or "")
        name = (form.get("fb_api_req_friendly_name") or [""])[0]
        if templates is not None and name == FEED_QUERIES[src["kind"]]:
            templates[src["kind"]] = {"name": name, "doc_id": form["doc_id"][0], "variables": json.loads(form["variables"][0])}

    def on_finished(ev):
        # zendriver may call handlers outside the loop, so schedule the body fetch thread-safely.
        if isinstance(ev, cdp.network.LoadingFinished) and ev.request_id in graphql:
            pending.append(asyncio.run_coroutine_threadsafe(tab.send(cdp.network.get_response_body(ev.request_id)), loop))

    found: dict = {}

    def drain() -> None:
        for fut in [f for f in pending if f.done()]:
            pending.remove(fut)
            try:
                body, is_base64 = fut.result()
            except Exception:
                continue  # response evicted or not a text body
            if not is_base64:
                for obj in _json_lines(body):
                    _stories(obj, found)

    await tab.send(cdp.network.enable())
    tab.add_handler(cdp.network.RequestWillBeSent, on_request)
    tab.add_handler(cdp.network.LoadingFinished, on_finished)
    try:
        await tab.get(source_url(src))
        await tab.sleep(random.uniform(5, 7))
        for text in await tab.evaluate(EMBEDDED_JSON_JS) or []:
            _stories(json.loads(text), found)
        for _ in range(SOURCE_SCROLL_ROUNDS):
            await tab.scroll_down(random.randint(300, 450), speed=SCROLL_SPEED * 2)
            await tab.sleep(random.uniform(2, 3.5))
            drain()
            times = [s["time"] for s in found.values() if s["time"]]
            if times and min(times) < since:
                break
        await tab.sleep(1.5)
        drain()
    finally:
        tab.remove_handlers(cdp.network.RequestWillBeSent, on_request)
        tab.remove_handlers(cdp.network.LoadingFinished, on_finished)
    return _to_posts(found, src, since)


# Fast path: replay the feed pagination query the page itself sends, from inside a facebook.com
# tab, without rendering anything. Facebook returns about 3 posts per call.
FEED_QUERIES = {"group": "GroupsCometFeedRegularStoriesPaginationQuery", "page": "ProfileCometTimelineFeedRefetchQuery"}
FEED_TEMPLATES_FILE = SOURCES_FILE.with_name("feed_queries.json")
FAST_MAX_CALLS = 12  # per source, i.e. about 36 posts
SCAN_CONCURRENCY = 4

GRAPHQL_JS = r"""
(async (name, docId, variables) => {
  const html = document.documentElement.innerHTML;
  const pick = (module, re) => { try { return window.require(module); } catch (e) { const m = html.match(re); return m && m[1]; } };
  const dtsg = pick('DTSGInitialData', /"DTSGInitialData",\[\],\{"token":"([^"]+)"/);
  const lsd = pick('LSD', /"LSD",\[\],\{"token":"([^"]+)"/);
  const user = (document.cookie.match(/(?:^|; )c_user=(\d+)/) || [])[1];
  const body = new URLSearchParams({
    av: user, __user: user, __a: '1', fb_dtsg: dtsg.token || dtsg, lsd: lsd.token || lsd,
    fb_api_caller_class: 'RelayModern', fb_api_req_friendly_name: name,
    variables: JSON.stringify(variables), server_timestamps: 'true', doc_id: docId,
  });
  const res = await fetch('/api/graphql/', {
    method: 'POST', body, credentials: 'include',
    headers: { 'x-fb-friendly-name': name, 'x-fb-lsd': lsd.token || lsd },
  });
  return JSON.stringify({ status: res.status, text: await res.text() });
})
"""


async def graphql(tab, name: str, doc_id: str, variables: dict) -> dict:
    """POST a GraphQL query from inside the logged-in tab; returns {status, text}."""
    raw = await tab.evaluate(
        f"({GRAPHQL_JS})({json.dumps(name)}, {json.dumps(doc_id)}, {json.dumps(variables)})", await_promise=True
    )
    if not isinstance(raw, str):  # the page script threw, e.g. a token was not found
        raise RuntimeError(f"{name}: lỗi khi gọi API trong trang: {raw}")
    return json.loads(raw)


def load_templates() -> dict:
    try:
        return json.loads(FEED_TEMPLATES_FILE.read_text(encoding="utf-8"))
    except FileNotFoundError:
        return {}


def save_sources(sources: list[dict]) -> list[dict]:
    SOURCES_FILE.parent.mkdir(exist_ok=True)
    SOURCES_FILE.write_text(json.dumps(sources, ensure_ascii=False, indent=1), encoding="utf-8")
    return sources


async def _profile_id(tab, src: dict) -> str:
    """A page's timeline belongs to its linked profile, whose id only appears in the page HTML."""
    if not src.get("profile_id"):
        # Fetch by path: page urls may lack "www.", which would make the request cross-origin.
        path = urlsplit(source_url(src)).path
        html = await tab.evaluate(f"fetch({json.dumps(path)}, {{credentials: 'include'}}).then(r => r.text())", await_promise=True)
        m = re.search(r'"userVanity":"[^"]*","userID":"(\d+)"', html or "") or re.search(r'"userID":"(\d+)"', html or "")
        if not m:
            raise RuntimeError("không tìm thấy ID hồ sơ của trang")
        src["profile_id"] = m.group(1)
    return src["profile_id"]


async def fast_scan(tab, src: dict, days: int, template: dict) -> list[dict]:
    since = _since(days)
    node_id = await _profile_id(tab, src) if src["kind"] == "page" else src["id"]
    variables = {**template["variables"], "id": node_id, "cursor": None}
    if "youthIntegrityHostID" in variables:
        variables["youthIntegrityHostID"] = node_id
    found: dict = {}
    for call in range(FAST_MAX_CALLS):
        if call:
            await asyncio.sleep(random.uniform(0.3, 0.8))
        reply = await graphql(tab, template["name"], template["doc_id"], variables)
        objs = list(_json_lines(reply["text"]))
        if reply["status"] != 200 or not objs or (objs[0].get("errors") and not objs[0].get("data")):
            raise RuntimeError(f"{template['name']}: HTTP {reply['status']} {reply['text'][:200]}")
        before = len(found)
        for obj in objs:
            _stories(obj, found)
        if call == 0 and not found:
            raise RuntimeError(f"{template['name']} không trả về bài nào")  # e.g. wrong id type
        info = next((pi for obj in objs if (pi := _first(obj, "page_info", lambda v: isinstance(v, dict) and "end_cursor" in v))), {})
        times = [s["time"] for s in found.values() if s["time"]]
        cursor = info.get("end_cursor")
        if not info.get("has_next_page") or not cursor or cursor == variables["cursor"] or len(found) == before \
                or (times and min(times) < since):
            break
        variables["cursor"] = cursor
    return _to_posts(found, src, since)


async def scan_sources(tab, sources: list[dict], days: int, on_done=None, cancelled=lambda: False) -> list[dict]:
    """Scan every source; fast path in parallel where a learned template exists, slow path otherwise.

    on_done(src, posts) is awaited after each source; a failing source is logged and skipped.
    """
    templates = load_templates()
    learned = dict(templates)
    posts: list[dict] = []

    async def finish(src, got):
        posts.extend(got)
        if on_done:
            await on_done(src, got)

    async def slow(src):
        try:
            got = await scan_source(tab, src, days, learned)
            log.info("Scanned %s (browser): %d posts", src["name"], len(got))
        except Exception:
            log.warning("Scanning %s failed", src["name"], exc_info=True)
            got = []
        await finish(src, got)

    order = random.sample(sources, len(sources))
    # One slow scan per kind without a template teaches the fast path for the rest.
    for kind in {s["kind"] for s in order}:
        if kind not in learned and not cancelled():
            src = next(s for s in order if s["kind"] == kind)
            order.remove(src)
            await slow(src)

    gate = asyncio.Semaphore(SCAN_CONCURRENCY)
    fallback = []

    async def fast(src):
        async with gate:
            if cancelled():
                return
            try:
                got = await fast_scan(tab, src, days, learned[src["kind"]])
                log.info("Scanned %s: %d posts", src["name"], len(got))
                await finish(src, got)
            except Exception as exc:
                log.warning("Fast scan of %s failed (%s); retrying in the browser", src["name"], exc)
                fallback.append(src)

    await asyncio.gather(*(fast(s) for s in order if s["kind"] in learned))
    # Sources whose kind never got a template, or whose fast scan failed, share the one tab: serial.
    for src in [s for s in order if s["kind"] not in learned] + fallback:
        if cancelled():
            break
        await slow(src)

    if learned != templates:
        FEED_TEMPLATES_FILE.write_text(json.dumps(learned, ensure_ascii=False), encoding="utf-8")
    # Keep the page profile ids resolved during this scan for the next one.
    resolved = {s["id"]: s["profile_id"] for s in sources if s.get("profile_id")}
    save_sources([{**s, "profile_id": resolved[s["id"]]} if s["id"] in resolved else s for s in load_sources()])
    return posts


async def collect_sources(s: Settings, sources: list[dict]) -> list[dict]:
    """Scan every chosen page/group; a failing source is skipped, not fatal."""
    browser = await _start_browser(s, headless=s.headless)
    try:
        tab = await _open(browser, s, "https://www.facebook.com/")
        await tab.sleep(random.uniform(4, 6))
        if not await _logged_in(browser) or await tab.evaluate(LOGGED_OUT_JS):
            raise SessionExpired(await tab.evaluate("location.href"))
        return await scan_sources(tab, sources, s.source_days)
    finally:
        await _close(browser)

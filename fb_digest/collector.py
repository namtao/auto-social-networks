import asyncio
import logging
import random
from pathlib import Path

import zendriver as zd
from zendriver import cdp

from .config import Settings

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
        tab = await browser.get(s.feed_url)
        if s.minimized and not s.headless:
            await tab.minimize()
            # A minimized window loses focus; keep the page believing it is focused.
            await tab.send(cdp.emulation.set_focus_emulation_enabled(True))
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

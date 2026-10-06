"""Collect the Facebook feed, score posts with an LLM and send a Telegram digest."""

import argparse
import asyncio
import logging
import sys

from . import collector, scorer, telegram
from .config import load_settings
from .store import Store, now

log = logging.getLogger("fb_digest")


def run_collect(s, store: Store) -> bool:
    """Collect the chosen pages/groups (or the feed when none are chosen), store new posts and
    alert on anything abnormal. Return success."""
    started = now()
    sources = collector.load_sources()
    try:
        posts = asyncio.run(collector.collect_sources(s, sources) if sources else collector.collect(s))
    except collector.SessionExpired as exc:
        store.log_run(started, 0, 0, "session_expired", str(exc))
        telegram.alert(s, f"Facebook yêu cầu đăng nhập/checkpoint ({exc}). Chạy `fb-digest login`.")
        return False
    except Exception as exc:
        log.exception("Collect failed")
        store.log_run(started, 0, 0, "error", repr(exc))
        telegram.alert(s, f"Thu bài lỗi: {exc!r}")
        return False

    new = store.add_posts(posts)
    # A few posts in SOURCE_DAYS is normal for chosen pages/groups; only an empty scan is suspicious.
    minimum = 1 if sources else s.min_posts
    status = "ok" if len(posts) >= minimum else "too_few"
    store.log_run(started, len(posts), new, status)
    log.info("Collected %d posts, %d new", len(posts), new)
    if status == "too_few":
        telegram.alert(
            s,
            f"Chỉ thu được {len(posts)} bài (ngưỡng {minimum}). "
            "Có thể Facebook đổi giao diện hoặc không tải thêm bài khi cuộn.",
        )
    return True


def run_score(s, store: Store) -> None:
    log.info("Scored %d posts", scorer.score_pending(s, store))


def run_digest(s, store: Store) -> None:
    rows = store.digest_candidates(s.score_threshold)
    if not rows:
        log.info("Nothing above threshold %d", s.score_threshold)
        return
    telegram.send_digest(s, rows)
    store.mark_sent([r["id"] for r in rows])
    log.info("Sent digest with %d posts", len(rows))


def main() -> None:
    parser = argparse.ArgumentParser(prog="fb-digest", description=__doc__)
    parser.add_argument(
        "command",
        nargs="?",
        default="run",
        choices=["login", "run", "collect", "score", "digest", "manage"],
        help="run = collect + score + digest (default); manage = web UI for friends/pages/groups",
    )
    args = parser.parse_args()
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")

    s = load_settings()
    if args.command == "login":
        asyncio.run(collector.login(s))
        return
    if args.command == "manage":
        from .manager import serve

        serve(s)
        return

    try:
        store = Store(s.database_url)
    except Exception as exc:
        log.exception("Database connection failed")
        telegram.alert(s, f"Không kết nối được Postgres: {type(exc).__name__}")
        sys.exit(1)
    ok = True
    if args.command in ("run", "collect"):
        ok = run_collect(s, store)
    try:
        if args.command in ("run", "score"):
            run_score(s, store)
        if args.command in ("run", "digest"):
            run_digest(s, store)
    except Exception as exc:
        log.exception("Scoring or digest failed")
        telegram.alert(s, f"Chấm điểm/gửi digest lỗi: {exc!r}")
        ok = False
    sys.exit(0 if ok else 1)


if __name__ == "__main__":
    main()

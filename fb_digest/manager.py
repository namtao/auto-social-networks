"""Local web UI: clean up friends, followed pages and joined groups, and scan chosen pages/groups.

Serves manager.html on 127.0.0.1 plus a small JSON API. One headless browser (Account) lives on a
background asyncio loop and starts on first use; every browser task (list refresh, bulk action,
scan) takes the same lock because they share one tab. Bulk actions run one at a time with a
random pause in between, because Facebook throttles accounts that act in bursts.
"""

import asyncio
import json
import logging
import random
import threading
import webbrowser
from datetime import datetime
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from . import collector, scorer
from .account import Account
from .config import DATA_DIR, Settings
from .main import run_digest
from .store import Store, now

HOST, PORT = "127.0.0.1", 8765
CACHE_DIR = DATA_DIR / "manage"
PAGE = Path(__file__).with_name("manager.html")
ACTION_DELAY = (3, 7)  # seconds between two actions
# list kind -> (Account method, label shown in the UI)
ACTIONS = {
    "friends": ("unfriend", "Hủy kết bạn"),
    "pages": ("unfollow_page", "Bỏ theo dõi"),
    "groups": ("leave_group", "Rời nhóm"),
}
SOURCE_KINDS = {"pages": "page", "groups": "group"}

log = logging.getLogger(__name__)


def _cache_path(kind: str) -> Path:
    return CACHE_DIR / f"{kind}.json"


def load(kind: str) -> dict:
    try:
        return json.loads(_cache_path(kind).read_text(encoding="utf-8"))
    except FileNotFoundError:
        return {"updated": None, "items": []}


def save(kind: str, items: list[dict], updated: str | None = None) -> dict:
    data = {"updated": updated or datetime.now().isoformat(timespec="seconds"), "items": items}
    _cache_path(kind).write_text(json.dumps(data, ensure_ascii=False), encoding="utf-8")
    return data


def set_sources(kind: str, ids: list[str], on: bool) -> list[dict]:
    """Add or remove pages/groups (by id) from the scan sources."""
    source_kind = SOURCE_KINDS[kind]
    ids = set(ids)
    sources = [x for x in collector.load_sources() if not (x["kind"] == source_kind and x["id"] in ids)]
    if on:
        sources += [{"kind": source_kind, "id": i["id"], "name": i["name"], "url": i["url"]}
                    for i in load(kind)["items"] if i["id"] in ids]
    return collector.save_sources(sources)


class Manager:
    def __init__(self, s: Settings):
        self.s = s
        self.account = Account(s)
        self.loop = asyncio.new_event_loop()
        threading.Thread(target=self.loop.run_forever, daemon=True).start()
        self.lock = asyncio.Lock()  # one browser tab: never run two browser tasks at once
        self.job: dict = {"running": False}
        self._store: Store | None = None
        CACHE_DIR.mkdir(exist_ok=True)

    def run(self, coro):
        return asyncio.run_coroutine_threadsafe(coro, self.loop).result()

    @property
    def store(self) -> Store:
        # Opened on first use so the cleanup tabs keep working without Postgres.
        if self._store is None:
            self._store = Store(self.s.database_url)
        return self._store

    async def _ready(self) -> None:
        if self.account.browser is None:
            await self.account.start()

    async def refresh(self, kind: str) -> dict:
        async with self.lock:
            await self._ready()
            return save(kind, await getattr(self.account, kind)())

    def _launch(self, kind: str, label: str, total: int, coro) -> dict:
        if self.job.get("running"):
            coro.close()
            raise RuntimeError("Đang có một tác vụ chạy; chờ xong hoặc bấm Dừng.")
        self.job = {"running": True, "kind": kind, "label": label, "total": total, "done": 0, "current": "",
                    "error": None, "summary": "", "cancel": False}
        asyncio.run_coroutine_threadsafe(self._guard(coro), self.loop)
        return self.public_job()

    async def _guard(self, coro) -> None:
        job = self.job
        try:
            await coro
        except Exception as exc:
            log.exception("Task %s failed at %s", job["label"], job["current"])
            job["error"] = f"{job['current']}: {exc}" if job["current"] else str(exc)
        finally:
            job["running"] = False
            job["current"] = ""

    def start_actions(self, kind: str, ids: list[str]) -> dict:
        return self._launch(kind, ACTIONS[kind][1], len(ids), self._run_actions(kind, ids))

    async def _run_actions(self, kind: str, ids: list[str]) -> None:
        job = self.job
        names = {i["id"]: i["name"] for i in load(kind)["items"]}
        action = getattr(self.account, ACTIONS[kind][0])
        for n, item_id in enumerate(ids):
            if job["cancel"]:
                break
            if n:
                await asyncio.sleep(random.uniform(*ACTION_DELAY))
            job["current"] = names.get(item_id, item_id)
            async with self.lock:
                await self._ready()
                await action(item_id)  # raises on the first failure: usually Facebook throttling
            job["done"] += 1
            cache = load(kind)
            save(kind, [i for i in cache["items"] if i["id"] != item_id], cache["updated"])
            if kind in SOURCE_KINDS:
                set_sources(kind, [item_id], on=False)

    def start_scan(self, send_digest: bool) -> dict:
        sources = collector.load_sources()
        if not sources:
            raise RuntimeError("Chưa chọn nguồn: bấm ☆ ở tab Trang hoặc Nhóm.")
        total = len(sources) + 1 + int(send_digest)
        return self._launch("posts", "Quét bài", total, self._run_scan(sources, send_digest))

    async def _run_scan(self, sources: list[dict], send_digest: bool) -> None:
        job, s, store = self.job, self.s, self.store
        started, counts = now(), {"collected": 0, "new": 0}

        async def on_done(src, posts):
            counts["collected"] += len(posts)
            counts["new"] += await asyncio.to_thread(store.add_posts, posts)
            job["done"] += 1
            job["current"] = src["name"]

        job["current"] = "Mở Facebook"
        async with self.lock:
            await self._ready()
            await collector.scan_sources(self.account.tab, sources, s.source_days, on_done, lambda: job["cancel"])
        if job["cancel"]:
            return
        await asyncio.to_thread(store.log_run, started, counts["collected"], counts["new"], "ok")
        job["done"] = len(sources)
        job["current"] = "Chấm điểm bằng LLM"
        scored = await asyncio.to_thread(scorer.score_pending, s, store)
        job["done"] += 1
        if send_digest:
            job["current"] = "Gửi digest Telegram"
            await asyncio.to_thread(run_digest, s, store)
            job["done"] += 1
        job["summary"] = f"{counts['collected']} bài trong {s.source_days} ngày gần nhất, {counts['new']} bài mới, chấm điểm {scored} bài"

    def public_job(self) -> dict:
        return {k: v for k, v in self.job.items() if k != "cancel"}


def _handler(mgr: Manager):
    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *args):
            pass

        def _send(self, status: int, body: bytes, content_type: str) -> None:
            self.send_response(status)
            self.send_header("Content-Type", content_type)
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def _json(self, status: int, data) -> None:
            body = json.dumps(data, ensure_ascii=False, default=lambda o: o.isoformat()).encode()
            self._send(status, body, "application/json; charset=utf-8")

        def _local(self) -> bool:
            # Rejects DNS-rebinding hosts; POSTs must also be JSON, which a cross-site page can
            # only send after a CORS preflight that this server never approves.
            return self.headers.get("Host", "").split(":")[0] in ("127.0.0.1", "localhost")

        def do_GET(self):
            if not self._local():
                return self._json(403, {"error": "forbidden"})
            parts = self.path.split("?")[0].strip("/").split("/")
            try:
                if parts == [""]:
                    return self._send(200, PAGE.read_bytes(), "text/html; charset=utf-8")
                if parts == ["api", "job"]:
                    return self._json(200, mgr.public_job())
                if parts == ["api", "sources"]:
                    return self._json(200, collector.load_sources())
                if parts == ["api", "posts"]:
                    return self._json(200, {"items": mgr.store.recent_posts(), "days": mgr.s.source_days,
                                            "threshold": mgr.s.score_threshold})
                if len(parts) == 2 and parts[0] == "api" and parts[1] in ACTIONS:
                    return self._json(200, load(parts[1]))
                self._json(404, {"error": "not found"})
            except Exception as exc:
                log.exception("Request %s failed", self.path)
                self._json(500, {"error": str(exc)})

        def do_POST(self):
            if not self._local() or not self.headers.get("Content-Type", "").startswith("application/json"):
                return self._json(403, {"error": "forbidden"})
            body = json.loads(self.rfile.read(int(self.headers.get("Content-Length") or 0)) or b"{}")
            parts = self.path.strip("/").split("/")
            try:
                if parts == ["api", "job", "cancel"]:
                    mgr.job["cancel"] = True
                    return self._json(200, mgr.public_job())
                if parts == ["api", "posts", "skip"]:
                    ids = [int(i) for i in body.get("ids") or []]
                    mgr.store.set_skipped(ids, bool(body.get("skip", True)))
                    return self._json(200, {"ids": ids, "skipped": bool(body.get("skip", True))})
                if parts == ["api", "scan"]:
                    return self._json(200, mgr.start_scan(bool(body.get("digest"))))
                if parts == ["api", "sources"] and body.get("kind") in SOURCE_KINDS:
                    ids = [str(i) for i in body.get("ids") or []]
                    return self._json(200, set_sources(body["kind"], ids, bool(body.get("on"))))
                if len(parts) == 3 and parts[0] == "api" and parts[1] in ACTIONS:
                    if parts[2] == "refresh":
                        return self._json(200, mgr.run(mgr.refresh(parts[1])))
                    if parts[2] == "action":
                        ids = [str(i) for i in body.get("ids") or []]
                        return self._json(200, mgr.start_actions(parts[1], ids))
                self._json(404, {"error": "not found"})
            except Exception as exc:
                log.exception("Request %s failed", self.path)
                self._json(500, {"error": str(exc)})

    return Handler


def serve(s: Settings) -> None:
    mgr = Manager(s)
    server = ThreadingHTTPServer((HOST, PORT), _handler(mgr))
    url = f"http://{HOST}:{PORT}/"
    print(f"Trang quản lý: {url}  (Ctrl+C để dừng)")
    webbrowser.open(url)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
        mgr.run(mgr.account.close())

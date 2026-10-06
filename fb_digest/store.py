import hashlib
import re
from datetime import datetime, timezone

import psycopg
from psycopg.rows import dict_row
from psycopg.types.json import Jsonb

# Prefixed table names: the database may be shared with other applications.
SCHEMA = """
CREATE TABLE IF NOT EXISTS fb_posts (
    id BIGSERIAL PRIMARY KEY,
    key TEXT UNIQUE NOT NULL,
    link TEXT,
    text TEXT NOT NULL,
    collected_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    scored_at TIMESTAMPTZ,
    is_ad BOOLEAN,
    is_suggested BOOLEAN,
    author TEXT,
    summary TEXT,
    score INTEGER,
    tags JSONB,
    reason TEXT,
    sent_at TIMESTAMPTZ
);
-- Set for posts scanned from a chosen page/group; feed posts carry no reliable timestamp.
ALTER TABLE fb_posts ADD COLUMN IF NOT EXISTS posted_at TIMESTAMPTZ;
ALTER TABLE fb_posts ADD COLUMN IF NOT EXISTS source TEXT;
CREATE INDEX IF NOT EXISTS fb_posts_link_idx ON fb_posts (link);
-- Set when the person dismisses a post in the web UI; such posts never go into a digest.
ALTER TABLE fb_posts ADD COLUMN IF NOT EXISTS skipped_at TIMESTAMPTZ;
CREATE TABLE IF NOT EXISTS fb_runs (
    id BIGSERIAL PRIMARY KEY,
    started_at TIMESTAMPTZ NOT NULL,
    collected INTEGER NOT NULL,
    new INTEGER NOT NULL,
    status TEXT NOT NULL,
    note TEXT
);
"""
# The newest column above; when it exists the schema is current and no DDL runs.
SCHEMA_MARKER = ("fb_posts", "skipped_at")


def now() -> datetime:
    return datetime.now(timezone.utc)


def post_key(text: str) -> str:
    """Stable identity across runs.

    The raw text changes between runs (relative timestamps, reaction counts), so hash
    only the longest lines with digits removed: those are the post body.
    """
    lines = {
        re.sub(r"\s+", " ", re.sub(r"\d+", "", line)).strip().lower()
        for line in text.splitlines()
    }
    body = sorted((l for l in lines if len(l) >= 20), key=len, reverse=True)[:3]
    basis = "\n".join(sorted(body)) or re.sub(r"\s+", " ", re.sub(r"\d+", "", text))
    return hashlib.sha1(basis.encode()).hexdigest()


class Store:
    def __init__(self, database_url: str):
        # One autocommit connection shared by threads (web server, parallel scans and scoring):
        # every statement commits on its own, so no explicit transaction may be opened on it.
        self.db = psycopg.connect(database_url, row_factory=dict_row, autocommit=True)
        # DDL takes an exclusive table lock even when nothing changes, which queues behind any
        # open transaction and blocks every later query; run it only when the schema is behind.
        current = self.db.execute(
            "SELECT 1 FROM information_schema.columns WHERE table_name = %s AND column_name = %s", SCHEMA_MARKER
        ).fetchone()
        if not current:
            self.db.execute("SET lock_timeout = '10s'")
            self.db.execute(SCHEMA)

    def add_posts(self, posts: list[dict]) -> int:
        """Insert unseen posts; return how many were new.

        A post scanned from a page/group is also skipped when its link is already stored, so an
        edited post (new text, same permalink) is not stored twice.
        """
        new = 0
        for p in posts:
            cur = self.db.execute(
                """INSERT INTO fb_posts (key, link, text, posted_at, source)
                   SELECT %(key)s, %(link)s, %(text)s, %(posted_at)s, %(source)s
                   WHERE %(source)s::text IS NULL
                      OR NOT EXISTS (SELECT 1 FROM fb_posts WHERE link = %(link)s)
                   ON CONFLICT (key) DO NOTHING""",
                {"key": post_key(p["text"]), "link": p["link"], "text": p["text"],
                 "posted_at": p.get("posted_at"), "source": p.get("source")},
            )
            new += cur.rowcount
        return new

    def log_run(self, started_at: datetime, collected: int, new: int, status: str, note: str = "") -> None:
        self.db.execute(
            "INSERT INTO fb_runs (started_at, collected, new, status, note) VALUES (%s, %s, %s, %s, %s)",
            (started_at, collected, new, status, note),
        )

    def unscored(self) -> list[dict]:
        return self.db.execute("SELECT id, text FROM fb_posts WHERE scored_at IS NULL ORDER BY id").fetchall()

    def save_score(self, post_id: int, score: dict) -> None:
        self.db.execute(
            """UPDATE fb_posts SET scored_at = now(), is_ad = %s, is_suggested = %s, author = %s,
               summary = %s, score = %s, tags = %s, reason = %s WHERE id = %s""",
            (
                score["is_ad"],
                score["is_suggested"],
                score["author"],
                score["summary"],
                score["score"],
                Jsonb(score["tags"]),
                score["reason"],
                post_id,
            ),
        )

    def digest_candidates(self, threshold: int) -> list[dict]:
        return self.db.execute(
            """SELECT id, link, author, summary, score, tags FROM fb_posts
               WHERE sent_at IS NULL AND skipped_at IS NULL AND score >= %s AND NOT is_ad
               ORDER BY score DESC, id""",
            (threshold,),
        ).fetchall()

    def recent_posts(self, limit: int = 5000) -> list[dict]:
        # A post is stored only the first time it is seen, so collected_at at or after the latest
        # run's start marks the posts that run found for the first time.
        return self.db.execute(
            """SELECT id, link, author, summary, score, tags, is_ad, source, sent_at, left(text, 600) AS text,
                      skipped_at IS NOT NULL AS skipped,
                      coalesce(posted_at, collected_at) AS posted_at, posted_at IS NOT NULL AS exact_time,
                      collected_at >= (SELECT max(started_at) FROM fb_runs) AS latest
               FROM fb_posts ORDER BY coalesce(posted_at, collected_at) DESC LIMIT %s""",
            (limit,),
        ).fetchall()

    def last_run_at(self) -> datetime | None:
        return self.db.execute("SELECT max(started_at) AS at FROM fb_runs").fetchone()["at"]

    def set_skipped(self, post_ids: list[int], skipped: bool) -> None:
        self.db.execute(
            "UPDATE fb_posts SET skipped_at = CASE WHEN %s THEN now() END WHERE id = ANY(%s)", (skipped, post_ids)
        )

    def mark_sent(self, post_ids: list[int]) -> None:
        self.db.execute("UPDATE fb_posts SET sent_at = now() WHERE id = ANY(%s)", (post_ids,))

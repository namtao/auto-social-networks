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
CREATE TABLE IF NOT EXISTS fb_runs (
    id BIGSERIAL PRIMARY KEY,
    started_at TIMESTAMPTZ NOT NULL,
    collected INTEGER NOT NULL,
    new INTEGER NOT NULL,
    status TEXT NOT NULL,
    note TEXT
);
"""


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
        self.db = psycopg.connect(database_url, row_factory=dict_row, autocommit=True)
        self.db.execute(SCHEMA)

    def add_posts(self, posts: list[dict]) -> int:
        """Insert unseen posts; return how many were new."""
        new = 0
        with self.db.transaction():
            for p in posts:
                cur = self.db.execute(
                    "INSERT INTO fb_posts (key, link, text) VALUES (%s, %s, %s) ON CONFLICT (key) DO NOTHING",
                    (post_key(p["text"]), p["link"], p["text"]),
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
               WHERE sent_at IS NULL AND score >= %s AND NOT is_ad
               ORDER BY score DESC, id""",
            (threshold,),
        ).fetchall()

    def mark_sent(self, post_ids: list[int]) -> None:
        self.db.execute("UPDATE fb_posts SET sent_at = now() WHERE id = ANY(%s)", (post_ids,))

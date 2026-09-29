import os
from dataclasses import dataclass
from pathlib import Path

from dotenv import load_dotenv

ROOT = Path(__file__).resolve().parent.parent
DATA_DIR = ROOT / "data"


@dataclass(frozen=True)
class Settings:
    feed_url: str
    browser: str
    browser_path: str | None
    headless: bool
    minimized: bool
    profile_dir: Path
    database_url: str
    scroll_rounds: int
    scroll_delay: tuple[float, float]
    max_posts: int
    min_posts: int
    llm_url: str
    llm_model: str
    llm_timeout: int
    batch_size: int
    score_threshold: int
    interests: str
    telegram_token: str | None
    telegram_chat_id: str | None


def _env(name: str, default: str = "") -> str:
    return os.environ.get(name, "").strip() or default


def load_settings() -> Settings:
    load_dotenv(ROOT / ".env")
    interests_file = ROOT / _env("INTERESTS_FILE", "interests.txt")
    if not interests_file.exists():
        interests_file = ROOT / "interests.example.txt"
    DATA_DIR.mkdir(exist_ok=True)
    return Settings(
        feed_url=_env("FEED_URL", "https://www.facebook.com/"),
        browser=_env("BROWSER", "auto"),
        browser_path=_env("BROWSER_PATH") or None,
        headless=_env("HEADLESS", "false").lower() in ("1", "true", "yes"),
        minimized=_env("MINIMIZED", "false").lower() in ("1", "true", "yes"),
        profile_dir=DATA_DIR / "browser-profile",
        database_url=os.environ["DATABASE_URL"],
        scroll_rounds=int(_env("SCROLL_ROUNDS", "60")),
        scroll_delay=(float(_env("SCROLL_DELAY_MIN", "1")), float(_env("SCROLL_DELAY_MAX", "2.5"))),
        max_posts=int(_env("MAX_POSTS", "60")),
        min_posts=int(_env("MIN_POSTS", "5")),
        llm_url=_env("LLM_URL", "http://localhost:20128/v1").rstrip("/"),
        llm_model=_env("LLM_MODEL", "antigravity/claude-sonnet-5"),
        llm_timeout=int(_env("LLM_TIMEOUT", "600")),
        batch_size=int(_env("SCORE_BATCH_SIZE", "8")),
        score_threshold=int(_env("SCORE_THRESHOLD", "7")),
        interests=interests_file.read_text(encoding="utf-8"),
        telegram_token=_env("TELEGRAM_BOT_TOKEN") or None,
        telegram_chat_id=_env("TELEGRAM_CHAT_ID") or None,
    )

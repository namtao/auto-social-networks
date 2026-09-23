import json
import logging
import urllib.request
from html import escape

from .config import Settings

log = logging.getLogger(__name__)

MAX_MESSAGE = 4000  # Telegram limit is 4096 characters


def send(s: Settings, html: str) -> None:
    """Send an HTML message, or print it when Telegram is not configured."""
    if not (s.telegram_token and s.telegram_chat_id):
        print(html)
        return
    body = json.dumps(
        {
            "chat_id": s.telegram_chat_id,
            "text": html,
            "parse_mode": "HTML",
            "link_preview_options": {"is_disabled": True},
        }
    ).encode()
    request = urllib.request.Request(
        f"https://api.telegram.org/bot{s.telegram_token}/sendMessage",
        data=body,
        headers={"Content-Type": "application/json"},
    )
    with urllib.request.urlopen(request, timeout=30) as response:
        response.read()


def alert(s: Settings, text: str) -> None:
    """Best effort: a failing alert must not hide the error that triggered it."""
    try:
        send(s, f"⚠️ <b>FB digest</b>: {escape(text)}")
    except Exception:
        log.exception("Could not send alert: %s", text)


def format_post(row) -> str:
    tags = " ".join(f"#{t.replace(' ', '_')}" for t in row["tags"] or [])
    author = escape(row["author"] or "?")
    title = f'<a href="{escape(row["link"])}">{author}</a>' if row["link"] else f"<b>{author}</b>"
    return f"<b>[{row['score']}]</b> {title}\n{escape(row['summary'] or '')}\n{tags}".strip()


def send_digest(s: Settings, rows) -> None:
    """Pack posts into as few messages as fit under Telegram's size limit."""
    chunks, current = [], f"📰 <b>FB digest</b> ({len(rows)} bài)"
    for row in rows:
        entry = format_post(row)
        if len(current) + len(entry) + 2 > MAX_MESSAGE:
            chunks.append(current)
            current = entry
        else:
            current += "\n\n" + entry
    chunks.append(current)
    for chunk in chunks:
        send(s, chunk)

import json
import logging
import urllib.request

from pydantic import BaseModel, ValidationError

from .config import Settings
from .store import Store

log = logging.getLogger(__name__)

# Keeps a batch inside the model context; the body of a post is rarely longer.
MAX_POST_CHARS = 3000

SYSTEM_PROMPT = """You triage a person's Facebook news feed so they only read what matters.

Each <post> is the raw innerText of one feed item: author name, relative time, body,
reaction counts and button labels are mixed together, and some items are ads
("Sponsored", "Được tài trợ"), suggestions ("Suggested for you", "Gợi ý cho bạn",
"Follow"/"Theo dõi" next to the author), "People you may know" blocks or other widgets.

Return one item per post with:
- id: the post id attribute, unchanged
- is_ad: true for sponsored content or obvious selling posts from pages
- is_suggested: true when Facebook recommends it from someone the person does not follow.
  This is informational only: suggested posts can be valuable, score them on content.
- author: the person, page or group that posted it ("" if unclear)
- summary: one or two sentences in Vietnamese describing the actual content
- score: integer 0-10 for how much this person would want to read it, based on their interests below.
  Be strict; being on-topic is not enough, judge how useful the post is to this person:
  9-10: on a listed interest AND concrete, new and actionable (a job that fits, a significant
        news event, an in-depth analysis, a personal announcement from someone close).
        Rare: at most one or two in twenty posts.
  7-8:  clearly on a listed interest with real substance the person would learn from.
  4-6:  loosely related, generic, self-promotion, or little substance.
  0-3:  off-interest, ads, drama, emotional stories unrelated to the interests.
  If the text is too short to tell what the post is about (image-only, a few-word caption),
  score at most 4.
- tags: 1-3 short lowercase topic tags
- reason: one short Vietnamese sentence explaining the score

The person's interests:
{interests}"""


class PostScore(BaseModel):
    id: int
    is_ad: bool
    is_suggested: bool
    author: str
    summary: str
    score: int
    tags: list[str]
    reason: str


class ScoreBatch(BaseModel):
    items: list[PostScore]


def _chat(s: Settings, system: str, user: str) -> str:
    """Call Ollama /api/chat with the reply constrained to the ScoreBatch JSON schema."""
    body = json.dumps(
        {
            "model": s.ollama_model,
            "messages": [
                {"role": "system", "content": system},
                {"role": "user", "content": user},
            ],
            "format": ScoreBatch.model_json_schema(),
            "stream": False,
            "think": False,
            "options": {"temperature": 0, "num_ctx": s.ollama_num_ctx},
        }
    ).encode()
    request = urllib.request.Request(
        f"{s.ollama_url}/api/chat",
        data=body,
        # Cloudflare in front of the server rejects the default "Python-urllib" agent with 403.
        headers={"Content-Type": "application/json", "User-Agent": "fb-digest/0.1"},
    )
    with urllib.request.urlopen(request, timeout=s.ollama_timeout) as response:
        reply = json.load(response)
    if reply.get("done_reason") == "length":
        raise RuntimeError("Model output hit the context/length limit; lower SCORE_BATCH_SIZE")
    return reply["message"]["content"]


def _score_batch(s: Settings, rows: list[dict]) -> ScoreBatch:
    posts = "\n\n".join(
        f'<post id="{r["id"]}">\n{r["text"][:MAX_POST_CHARS]}\n</post>' for r in rows
    )
    content = _chat(s, SYSTEM_PROMPT.format(interests=s.interests), posts)
    try:
        return ScoreBatch.model_validate_json(content)
    except ValidationError as exc:
        raise RuntimeError(f"Model returned invalid JSON: {exc}") from exc


def score_pending(s: Settings, store: Store) -> int:
    """Score every unscored post in batches; return how many got a score."""
    rows = store.unscored()
    scored = 0
    for start in range(0, len(rows), s.batch_size):
        batch = rows[start : start + s.batch_size]
        result = _score_batch(s, batch)
        ids = {r["id"] for r in batch}
        for item in result.items:
            if item.id in ids:
                store.save_score(item.id, item.model_dump())
                scored += 1
        # Posts the model skipped stay unscored and are retried on the next run.
    return scored

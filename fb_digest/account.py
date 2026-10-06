"""List and clean up friends, followed pages and joined groups via Facebook's own GraphQL API.

Every request is a fetch() sent from inside a logged-in facebook.com tab, the same way the web app
sends it, so it carries the real session, tokens and browser fingerprint. The doc_ids below were
recorded from the web app; when Facebook rotates one, calls fail with FacebookError naming the
operation, and the new doc_id can be read from the browser's network tab.
"""

import base64
import json
import re
import time

import zendriver as zd

from . import collector
from .config import Settings

FRIENDS_QUERY = ("ProfileCometAppCollectionSelfFriendsListRendererPaginationQuery", "28450137841316320")
ACTIVE_FRIENDS_QUERY = ("FriendingCometFriendsListPaginationQuery", "26206414195674994")
PAGES_QUERY =("PagesCometAllLikedPagesSectionPaginationQuery", "28129101006740727")
GROUPS_QUERY = ("GroupsLeftRailYourGroupsPaginatedQuery", "9658982227546884")
UNFRIEND = ("FriendingCometUnfriendMutation", "24028849793460009")
UNFOLLOW_PAGE = ("usePageCometUnfollowMutation", "23977842521823837")
LEAVE_FORUM = ("GroupCometLeaveForumMutation", "28493416426984190")
LEAVE_GROUP = ("useGroupLeaveMutation", "38666184769662540")

GROUPS_PAGE = "https://www.facebook.com/groups/joins/?nav_source=tab"
FRIENDS_PAGE = "https://www.facebook.com/me/friends_all"

# Every joined group as {url, name, visited}; "visited" is the "Lần truy cập gần đây nhất" text.
GROUP_CARDS_JS = r"""
(() => [...document.querySelectorAll('[role="main"] [role="listitem"]')].map((li) => {
  const a = li.querySelector('a[href*="/groups/"]');
  const lines = li.innerText.split('\n').map((l) => l.trim()).filter(Boolean);
  const at = lines.findIndex((l) => /truy cập gần đây nhất|last visited/i.test(l));
  return a && { url: a.href, name: lines[0], visited: at >= 0 ? lines[at + 1] || '' : '' };
}).filter(Boolean))()
"""

UNITS_DAYS = {"phút": 1 / 1440, "giờ": 1 / 24, "ngày": 1, "tuần": 7, "tháng": 30, "năm": 365,
              "minute": 1 / 1440, "hour": 1 / 24, "day": 1, "week": 7, "month": 30, "year": 365}


class FacebookError(Exception):
    """Facebook rejected a request, or the session is not logged in."""


def days_ago(text: str) -> float | None:
    """'8 tuần trước' -> 56.0; None when the text has no recognizable age."""
    m = re.search(r"(\d+)\s*(phút|giờ|ngày|tuần|tháng|năm|minute|hour|day|week|month|year)", text or "")
    return round(int(m.group(1)) * UNITS_DAYS[m.group(2)], 2) if m else None


def _group_url(url: str) -> str:
    return url.split("?")[0].rstrip("/").lower()


class Account:
    """One headless browser on the bot profile; every call needs a facebook.com tab."""

    def __init__(self, s: Settings):
        self.s = s
        self.browser: zd.Browser | None = None
        self.tab = None
        self.user_id = ""

    async def start(self) -> None:
        self.browser = await collector._start_browser(self.s, headless=True)
        self.tab = await self.browser.get("https://www.facebook.com/")
        await self.tab.sleep(4)
        if not await collector._logged_in(self.browser):
            await self.close()
            raise FacebookError("Chưa đăng nhập Facebook; chạy `fb-digest login` trước.")
        self.user_id = next(c.value for c in await self.browser.cookies.get_all() if c.name == "c_user")

    async def close(self) -> None:
        if self.browser:
            await collector._close(self.browser)
        self.browser = self.tab = None

    async def _graphql(self, op: tuple[str, str], variables: dict) -> dict:
        name, doc_id = op
        try:
            reply = await collector.graphql(self.tab, name, doc_id, variables)
        except RuntimeError as exc:
            raise FacebookError(str(exc)) from exc
        # Deferred fragments arrive as extra JSON lines; the first one holds the main payload.
        first = reply["text"].split("\n", 1)[0]
        try:
            body = json.loads(first)
        except json.JSONDecodeError:
            raise FacebookError(f"{name}: HTTP {reply['status']}, phản hồi không phải JSON: {first[:200]}")
        if body.get("errors") and not body.get("data"):
            raise FacebookError(f"{name}: {body['errors'][0].get('message', body['errors'][0])}")
        return body.get("data") or {}

    async def _paginate(self, op, variables: dict, connection) -> list[dict]:
        """Follow a Relay connection to the end; connection(data) returns {edges, page_info}."""
        nodes, cursor = [], None
        for _ in range(200):
            conn = connection(await self._graphql(op, {**variables, "cursor": cursor})) or {}
            edges = conn.get("edges") or []
            nodes += [e["node"] for e in edges if e.get("node")]
            info = conn.get("page_info") or {}
            cursor = info.get("end_cursor") or (edges[-1].get("cursor") if edges else None)
            if not edges or not cursor or info.get("has_next_page") is False:
                break
            await self.tab.sleep(0.5)
        return nodes

    async def friends(self) -> list[dict]:
        await self.tab.get(FRIENDS_PAGE)
        await self.tab.sleep(5)
        # The friends collection id is an opaque base64 "app_collection:pfbid…" embedded in the page.
        html = await self.tab.evaluate("document.documentElement.innerHTML")
        collections = list(dict.fromkeys(re.findall(r"YXBwX2NvbGxlY3Rpb246[A-Za-z0-9+/=]+", html)))
        if not collections:
            raise FacebookError("Không tìm thấy danh sách bạn bè trên trang friends_all.")
        variables = {"count": 30, "scale": 1, "search": None, "id": collections[0],
                     "__relay_internal__pv__FBProfile_enable_perf_improv_gkrelayprovider": True}
        nodes = await self._paginate(FRIENDS_QUERY, variables, lambda d: (d.get("node") or {}).get("pageItems"))
        # The friending list skips deactivated accounts that the profile collection still holds,
        # so a friend missing from it is locked; it also carries gender and the mutual count.
        active = {
            n["id"]: n for n in await self._paginate(
                ACTIVE_FRIENDS_QUERY, {"count": 30, "name": None, "scale": 1},
                lambda d: (d.get("viewer") or {}).get("all_friends"),
            )
        }
        friends = []
        for n in nodes:
            # node.id is base64 "app_item:<viewer>:<app>:<n>::<friend id>".
            friend_id = base64.b64decode(n["id"] + "==").decode(errors="ignore").rsplit(":", 1)[-1]
            info = active.get(friend_id) or {}
            subtitle = (info.get("social_context") or {}).get("text") or (n.get("subtitle_text") or {}).get("text") or ""
            mutual = re.search(r"(\d+)\s*(bạn chung|mutual)", subtitle)
            friends.append({
                "id": friend_id,
                "name": (n.get("title") or {}).get("text") or info.get("name") or "",
                "url": n.get("url") or info.get("url") or f"https://www.facebook.com/profile.php?id={friend_id}",
                "mutual": int(mutual.group(1)) if mutual else None,  # FB shows hometown etc. instead
                "gender": {"MALE": "Nam", "FEMALE": "Nữ"}.get(info.get("gender"), ""),
                "avatar": (n.get("image_v2") or info.get("profile_picture") or {}).get("uri", ""),
                "locked": friend_id not in active,
            })
        return friends

    async def pages(self) -> list[dict]:
        variables = {"count": 30, "ranking_model": "INTEGRITY_SIGNALS", "scale": 1, "id": self.user_id,
                     "__relay_internal__pv__StoriesRingrelayprovider": False}
        nodes = await self._paginate(
            PAGES_QUERY, variables, lambda d: (d.get("node") or {}).get("sorted_liked_and_followed_pages")
        )
        return [{
            "id": n["id"],
            "name": n.get("name") or "",
            "url": n.get("url") or "",
            "category": n.get("category_name") or "",
            "verified": bool(n.get("is_verified")),
            "liked": bool(n.get("is_viewer_fan")),
            "following": n.get("subscribe_status") == "IS_SUBSCRIBED",
            "avatar": (n.get("profile_picture") or {}).get("uri", ""),
        } for n in nodes]

    async def _joined_groups(self) -> list[tuple[dict, bool]]:
        """Every joined group node, paired with whether the viewer administers it."""
        joined = []
        for list_type, admin in (("NON_ADMIN_MODERATOR_GROUPS", False), ("ADMIN_MODERATOR_GROUPS", True)):
            variables = {"count": 30, "listType": list_type, "scale": 1}
            try:
                nodes = await self._paginate(
                    GROUPS_QUERY, variables, lambda d: (((d.get("viewer") or {}).get("groups_tab") or {}).get("tab_groups_list"))
                )
            except FacebookError:
                if admin:
                    continue  # the admin list type is optional
                raise
            joined += [(n, admin) for n in nodes]
        return joined

    async def groups(self) -> list[dict]:
        groups: dict[str, dict] = {}
        for n, admin in await self._joined_groups():
            groups[_group_url(n.get("url") or n["id"])] = {
                "id": n["id"],
                "name": n.get("name") or "",
                "url": n.get("url") or f"https://www.facebook.com/groups/{n['id']}/",
                "admin": admin,
                "avatar": (n.get("profile_picture_48") or {}).get("uri", ""),
                "last_post_days": round((time.time() - n["last_post_time"]) / 86400, 1)
                if n.get("last_post_time") else None,
                "visited": "",
                "visited_days": None,
            }
        # "Last visited" only exists on the joined-groups page, so read it from there.
        await self.tab.get(GROUPS_PAGE)
        await self.tab.sleep(5)
        seen = -1
        for _ in range(40):
            cards = await self.tab.evaluate(GROUP_CARDS_JS)
            if len(cards) == seen:
                break
            seen = len(cards)
            await self.tab.scroll_down(400, speed=4000)
            await self.tab.sleep(1.5)
        for card in cards:
            g = groups.get(_group_url(card["url"]))
            if g:
                g["visited"] = card["visited"]
                g["visited_days"] = days_ago(card["visited"])
        return list(groups.values())

    async def _mutate(self, op, input_: dict, extra: dict | None = None) -> dict:
        variables = {"input": {**input_, "actor_id": self.user_id, "client_mutation_id": "1"}, **(extra or {})}
        return await self._graphql(op, variables)

    async def unfriend(self, user_id: str) -> None:
        data = await self._mutate(UNFRIEND, {"source": "friending_jewel", "unfriended_user_id": user_id}, {"scale": 1})
        if not data.get("friend_remove"):
            raise FacebookError(f"Hủy kết bạn {user_id} không thành công: {json.dumps(data)[:200]}")

    async def unfollow_page(self, page_id: str) -> None:
        data = await self._mutate(UNFOLLOW_PAGE, {"subscribe_location": "PAGE_FAN", "unsubscribee_id": page_id})
        if not data.get("actor_unsubscribe"):
            raise FacebookError(f"Bỏ theo dõi trang {page_id} không thành công: {json.dumps(data)[:200]}")

    async def leave_group(self, group_id: str) -> None:
        # Facebook has two kinds of group, each with its own leave mutation; the wrong one answers
        # null with a generic "field_exception" error, so try both.
        attempts = (
            (LEAVE_FORUM,
             {"attribution_id_v2": "GroupsCometJoinsRoot.react,comet.groups.joins,via_cold_start,,,,,", "group_id": group_id},
             {"inviteShortLinkKey": None, "isChainingRecommendationUnit": False, "ordering": ["viewer_added"],
              "scale": 1, "groupID": group_id,
              "__relay_internal__pv__GroupsCometGYSJUnifiedUnitCardImageHeightrelayprovider": 150,
              "__relay_internal__pv__GroupsCometGroupChatLazyLoadLastMessageSnippetrelayprovider": False}),
            (LEAVE_GROUP,
             {"action_source": "COMET_GROUP_PAGE", "attribution_id_v2": "CometGroupDiscussionRoot.react,comet.group,via_cold_start,,,,,",
              "group_id": group_id, "readd_policy": "ALLOW_READD"},
             {"groupID": group_id, "ordering": ["viewer_added"], "scale": 1}),
        )
        replies = []
        for op, input_, extra in attempts:
            try:
                data = await self._mutate(op, input_, extra)
            except FacebookError as exc:
                replies.append(str(exc))
                continue
            if any(data.values()):
                return
            replies.append(json.dumps(data))
        # Both also answer null when the viewer is no longer a member (left elsewhere, or removed
        # by an admin since the list was cached); that group is already gone.
        if any(n["id"] == group_id for n, _ in await self._joined_groups()):
            raise FacebookError(f"Rời nhóm {group_id} không thành công: {' | '.join(replies)[:300]}")

// List and clean up friends, followed pages and joined groups via Facebook's own GraphQL API.
// Everything runs from the service worker (see fb.js), so no tab or window opens.

import { FB, FacebookError, fetchPage, first, gql, sleep, uniform } from './fb.js';

const GROUP_ATTRIBUTION = 'CometGroupDiscussionRoot.react,comet.group,via_cold_start,,,,,';

// "8 giờ trước", "3 tuần trước"… from a unix time, like Facebook's "Lần truy cập gần đây nhất".
function agoText(unix) {
  const min = Math.max(1, Math.round((Date.now() / 1000 - unix) / 60));
  const steps = [[60, 1, 'phút'], [1440, 60, 'giờ'], [10080, 1440, 'ngày'], [43200, 10080, 'tuần'], [525600, 43200, 'tháng']];
  for (const [below, unit, label] of steps) if (min < below) return `${Math.round(min / unit)} ${label} trước`;
  return `${Math.round(min / 525600)} năm trước`;
}

// Follow a Relay connection to the end; connection(data) returns {edges, page_info}.
async function paginate(ctx, key, variables, connection) {
  const nodes = [];
  let cursor = null;
  for (let i = 0; i < 200; i++) {
    const conn = connection(await gql(ctx, key, { ...variables, cursor })) || {};
    const edges = conn.edges || [];
    nodes.push(...edges.filter((e) => e.node).map((e) => e.node));
    const info = conn.page_info || {};
    cursor = info.end_cursor || (edges.length ? edges.at(-1).cursor : null);
    if (!edges.length || !cursor || info.has_next_page === false) break;
    await sleep(500);
  }
  return nodes;
}

function decodeFriendId(nodeId) {
  // node.id is base64 "app_item:<viewer>:<app>:<n>::<friend id>".
  try {
    const padded = nodeId + '='.repeat((4 - (nodeId.length % 4)) % 4);
    return atob(padded).split(':').at(-1);
  } catch {
    return nodeId;
  }
}

export async function friends(ctx) {
  // The friends collection id is an opaque base64 "app_collection:pfbid…" embedded in the page.
  const { html } = await fetchPage('/me/friends_all');
  const collection = html.match(/YXBwX2NvbGxlY3Rpb246[A-Za-z0-9+/=]+/);
  if (!collection) throw new FacebookError('Không tìm thấy danh sách bạn bè trên trang friends_all.');
  const variables = { count: 30, scale: 1, search: null, id: collection[0],
                      __relay_internal__pv__FBProfile_enable_perf_improv_gkrelayprovider: true };
  const nodes = await paginate(ctx, 'friends', variables, (d) => d.node?.pageItems);
  // The friending list skips deactivated accounts that the profile collection still holds,
  // so a friend missing from it is locked; it also carries gender and the mutual count.
  const active = new Map((await paginate(ctx, 'active_friends', { count: 30, name: null, scale: 1 },
    (d) => d.viewer?.all_friends)).map((n) => [n.id, n]));
  return nodes.map((n) => {
    const id = decodeFriendId(n.id);
    const info = active.get(id) || {};
    const subtitle = info.social_context?.text || n.subtitle_text?.text || '';
    const mutual = subtitle.match(/(\d+)\s*(bạn chung|mutual)/);
    return {
      id,
      name: n.title?.text || info.name || '',
      url: n.url || info.url || `${FB}/profile.php?id=${id}`,
      mutual: mutual ? +mutual[1] : null, // FB shows hometown etc. instead
      gender: { MALE: 'Nam', FEMALE: 'Nữ' }[info.gender] || '',
      avatar: (n.image_v2 || info.profile_picture || {}).uri || '',
      locked: !active.has(id),
    };
  });
}

export async function pages(ctx) {
  const variables = { count: 30, ranking_model: 'INTEGRITY_SIGNALS', scale: 1, id: ctx.user,
                      __relay_internal__pv__StoriesRingrelayprovider: false };
  const nodes = await paginate(ctx, 'pages', variables, (d) => d.node?.sorted_liked_and_followed_pages);
  return nodes.map((n) => ({
    id: n.id,
    name: n.name || '',
    url: n.url || '',
    category: n.category_name || '',
    verified: !!n.is_verified,
    liked: !!n.is_viewer_fan,
    following: n.subscribe_status === 'IS_SUBSCRIBED',
    avatar: n.profile_picture?.uri || '',
  }));
}

// Every joined group node, paired with whether the viewer administers it.
async function joinedGroups(ctx) {
  const joined = [];
  for (const [listType, admin] of [['NON_ADMIN_MODERATOR_GROUPS', false], ['ADMIN_MODERATOR_GROUPS', true]]) {
    try {
      const nodes = await paginate(ctx, 'groups', { count: 30, listType, scale: 1 },
        (d) => d.viewer?.groups_tab?.tab_groups_list);
      joined.push(...nodes.map((n) => [n, admin]));
    } catch (err) {
      if (!admin) throw err; // the admin list type is optional
    }
  }
  return joined;
}

export async function groups(ctx) {
  const byId = new Map();
  for (const [n, admin] of await joinedGroups(ctx)) {
    byId.set(n.id, {
      id: n.id,
      name: n.name || '',
      url: n.url || `${FB}/groups/${n.id}/`,
      admin,
      avatar: n.profile_picture_48?.uri || '',
      last_post_days: n.last_post_time ? Math.round((Date.now() / 1000 - n.last_post_time) / 8640) / 10 : null,
      visited: '',
      visited_days: null,
    });
  }
  // "Last visited" comes from the query behind the "Nhóm của bạn" page; the left-rail list lacks it.
  try {
    const visits = await paginate(ctx, 'groups_visited', { count: 20, ordering: ['integrity_signals'], scale: 1 },
      (d) => d.viewer?.all_joined_groups?.tab_groups_list);
    for (const n of visits) {
      const g = byId.get(n.id);
      if (g && n.viewer_last_visited_time) {
        g.visited = agoText(n.viewer_last_visited_time);
        g.visited_days = Math.round((Date.now() / 1000 - n.viewer_last_visited_time) / 864) / 100;
      }
    }
  } catch (err) {
    console.warn('Reading when groups were last visited failed', err.message);
  }
  await readGroupSettings(ctx, [...byId.values()]);
  return [...byId.values()];
}

const STATUS_CONCURRENCY = 4;

// The joined-groups list does not say whether a group is followed or muted; each group's
// "Đã tham gia" menu and its notification dialog do, through one small query each.
async function readGroupSettings(ctx, groups) {
  const queue = [...groups];
  let ok = 0;
  let failed = 0;
  async function worker() {
    for (let g = queue.shift(); g; g = queue.shift()) {
      // Every call failing means Facebook rotated these doc_ids: stop rather than send 2 x N errors.
      if (failed >= 3 && !ok) return;
      try {
        const follow = await gql(ctx, 'group_follow_status', { groupID: g.id },
          (d) => first(d, 'if_viewer_can_change_follow_setting', (v) => v?.subscribe_status));
        g.unfollowed = first(follow, 'if_viewer_can_change_follow_setting', (v) => v?.subscribe_status).subscribe_status === 'CAN_SUBSCRIBE';
        const notif = await gql(ctx, 'group_notification_settings', { groupID: g.id },
          (d) => first(d, 'viewer_subscription_level', (v) => typeof v === 'string'));
        // Muted the way mute_group does it: in-app and push notifications both off.
        g.muted = first(notif, 'viewer_subscription_level', (v) => typeof v === 'string') === 'OFF'
          && first(notif, 'viewer_push_subscription_level', (v) => typeof v === 'string') === 'OFF';
        ok++;
      } catch (err) {
        failed++;
        console.warn(`Reading settings of group ${g.name} failed`, err.message);
      }
      await sleep(uniform(200, 500));
    }
  }
  await Promise.all(Array.from({ length: STATUS_CONCURRENCY }, worker));
}

function mutate(ctx, key, input, extra = {}, accept) {
  const variables = { input: { ...input, actor_id: ctx.user, client_mutation_id: '1' }, ...extra };
  return gql(ctx, key, variables, accept);
}

export async function unfriend(ctx, userId) {
  await mutate(ctx, 'unfriend', { source: 'friending_jewel', unfriended_user_id: userId }, { scale: 1 },
    (d) => d.friend_remove);
}

export async function unfollow_page(ctx, pageId) {
  await mutate(ctx, 'unfollow_page', { subscribe_location: 'PAGE_FAN', unsubscribee_id: pageId }, {},
    (d) => d.actor_unsubscribe);
}

export async function leave_group(ctx, groupId) {
  // Facebook has two kinds of group, each with its own leave mutation; the wrong one answers
  // null with a generic "field_exception" error, so try both.
  const attempts = [
    ['leave_forum',
      { attribution_id_v2: 'GroupsCometJoinsRoot.react,comet.groups.joins,via_cold_start,,,,,', group_id: groupId },
      { inviteShortLinkKey: null, isChainingRecommendationUnit: false, ordering: ['viewer_added'],
        scale: 1, groupID: groupId,
        __relay_internal__pv__GroupsCometGYSJUnifiedUnitCardImageHeightrelayprovider: 150,
        __relay_internal__pv__GroupsCometGroupChatLazyLoadLastMessageSnippetrelayprovider: false }],
    ['leave_group',
      { action_source: 'COMET_GROUP_PAGE', attribution_id_v2: GROUP_ATTRIBUTION,
        group_id: groupId, readd_policy: 'ALLOW_READD' },
      { groupID: groupId, ordering: ['viewer_added'], scale: 1 }],
  ];
  const replies = [];
  for (const [key, input, extra] of attempts) {
    try {
      await mutate(ctx, key, input, extra, (d) => Object.values(d).some(Boolean));
      return;
    } catch (err) {
      replies.push(err.message);
    }
  }
  // Both also answer null when the viewer is no longer a member (left elsewhere, or removed
  // by an admin since the list was cached); that group is already gone.
  if ((await joinedGroups(ctx)).some(([n]) => n.id === groupId)) {
    throw new FacebookError(`Rời nhóm ${groupId} không thành công: ${replies.join(' | ').slice(0, 300)}`);
  }
}

// Stay a member but stop seeing the group's posts in the feed.
export async function unfollow_group(ctx, groupId) {
  await mutate(ctx, 'unfollow_group', { attribution_id_v2: GROUP_ATTRIBUTION, group_id: groupId, subscribe_location: 'PROFILE' },
    {}, (d) => d.group_unsubscribe);
}

// Turn the group's notifications off, like picking "Tắt" under "Quản lý thông báo".
export async function mute_group(ctx, groupId) {
  // The dialog saves the in-app level and the push level with two separate mutations.
  await mutate(ctx, 'group_notifications', { group_id: groupId, setting: 'OFF', source: 'comet_group_page' }, {},
    (d) => d.group_update_subscription_level);
  await mutate(ctx, 'group_push', { group_id: groupId, setting: 'OFF' }, {},
    (d) => d.group_update_push_subscription_level);
}

export const LISTS = { friends, pages, groups };
export const ACTIONS = { unfriend, unfollow_page, leave_group, unfollow_group, mute_group };

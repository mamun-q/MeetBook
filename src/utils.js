// Pure, testable utility logic for MeetBook (no DOM / Firebase imports).

export const USERNAME_RE = /^[a-zA-Z0-9_.]{3,24}$/;

export function validateUsername(name) {
  if (typeof name !== 'string') return { ok: false, error: 'Username is required.' };
  const trimmed = name.trim();
  if (trimmed.length < 3) return { ok: false, error: 'Username must be at least 3 characters.' };
  if (trimmed.length > 24) return { ok: false, error: 'Username must be at most 24 characters.' };
  if (!USERNAME_RE.test(trimmed)) {
    return { ok: false, error: 'Use only letters, numbers, dots and underscores.' };
  }
  if (trimmed.startsWith('.') || trimmed.endsWith('.')) {
    return { ok: false, error: 'Username cannot start or end with a dot.' };
  }
  const reserved = ['admin', 'meetbook', 'support', 'system', 'moderator'];
  if (reserved.includes(trimmed.toLowerCase())) return { ok: false, error: 'That username is reserved.' };
  return { ok: true, value: trimmed.toLowerCase() };
}

export function validateEmail(email) {
  return typeof email === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim());
}

export function validatePassword(pw) {
  if (typeof pw !== 'string' || pw.length < 6) return { ok: false, error: 'Password must be at least 6 characters.' };
  return { ok: true };
}

export function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

export function timeAgo(ts, now = Date.now()) {
  const diff = Math.max(0, now - Number(ts || 0));
  const sec = Math.floor(diff / 1000);
  if (sec < 45) return 'just now';
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h`;
  const day = Math.floor(hr / 24);
  if (day < 7) return `${day}d`;
  const week = Math.floor(day / 7);
  if (week < 5) return `${week}w`;
  return new Date(Number(ts)).toLocaleDateString();
}

export function initials(name) {
  const parts = String(name || '?').trim().split(/\s+/).slice(0, 2);
  return parts.map((p) => p[0]?.toUpperCase() || '').join('') || '?';
}

export function avatarColor(seed) {
  const colors = ['#1877f2', '#42b883', '#e5534b', '#f0883e', '#8957e5', '#1f6feb', '#bf3989', '#0a7ea4'];
  let hash = 0;
  const s = String(seed || '');
  for (let i = 0; i < s.length; i++) hash = (hash * 31 + s.charCodeAt(i)) >>> 0;
  return colors[hash % colors.length];
}

// --- Post privacy -------------------------------------------------------
// The audience of a post is DENORMALIZED onto the document at creation
// time as `audienceIds`, because Firestore list queries are only allowed
// when the security rules are provable from the query constraints — the
// rules cannot join to friendships/groups while evaluating a feed query.
// postAudience computes the stored { visibility, audienceIds } pair:
//  - normal public / only-me posts: audienceIds = [] (visibility decides)
//  - normal friends posts: audienceIds = author's current friend ids
//  - close-friends posts: audienceIds = author's current close-friend ids
//  - group posts: the GROUP's privacy governs — public group -> stored
//    visibility 'public', audienceIds []; private group -> stored
//    visibility 'private', audienceIds = the group's current members
//  - page posts arrive here as plain public posts (no group) -> [].
export function postAudience({ visibility = 'public', group = null, authorFriendIds = [], authorCloseFriendIds = [] } = {}) {
  if (group) {
    if (group.privacy === 'private') {
      return { visibility: 'private', audienceIds: [...new Set((group.members || []).filter(Boolean))] };
    }
    return { visibility: 'public', audienceIds: [] };
  }
  const vis = visibility || 'public';
  if (vis === 'friends') {
    return { visibility: 'friends', audienceIds: [...new Set((authorFriendIds || []).filter(Boolean))] };
  }
  if (vis === 'close') {
    return { visibility: 'close', audienceIds: [...new Set((authorCloseFriendIds || []).filter(Boolean))] };
  }
  return { visibility: vis, audienceIds: [] };
}

// visibility: 'public' | 'friends' | 'close' | 'only-me' (group posts store
// the group's effective visibility; private-group posts store 'private' and
// are gated by canViewGroupPost, not this helper). 'close' behaves exactly
// like 'friends': the audience snapshot decides, with the live friendship
// set as fallback.
// ctx: { viewerId, authorId, friendIds:Set|Array, blockedIds:Set|Array }
export function canViewPost(post, ctx) {
  if (!post || !ctx) return false;
  const blocked = ctx.blockedIds instanceof Set ? ctx.blockedIds : new Set(ctx.blockedIds || []);
  if (blocked.has(post.authorId)) return false;
  if (post.authorId === ctx.viewerId) return true;
  const vis = post.visibility || 'public';
  if (vis === 'public') return true;
  if (vis === 'only-me') return false;
  if (vis === 'friends' || vis === 'close') {
    // Denormalized audience first (what live mode actually delivers);
    // fall back to the live friendship check so demo behaviour and
    // pre-audienceIds posts behave exactly as before.
    if (Array.isArray(post.audienceIds) && post.audienceIds.includes(ctx.viewerId)) return true;
    const friends = ctx.friendIds instanceof Set ? ctx.friendIds : new Set(ctx.friendIds || []);
    return friends.has(post.authorId);
  }
  return false;
}

export function filterVisiblePosts(posts, ctx) {
  return (posts || []).filter((p) => canViewPost(p, ctx));
}

export function paginate(items, page = 1, pageSize = 10) {
  const start = (Math.max(1, page) - 1) * pageSize;
  return {
    items: (items || []).slice(start, start + pageSize),
    page,
    pageSize,
    total: (items || []).length,
    hasMore: start + pageSize < (items || []).length
  };
}

// --- Rate limiting ------------------------------------------------------
// Sliding-window limiter used by the demo client and mirrored in Functions.
export class RateLimiter {
  constructor({ limit = 10, windowMs = 60_000 } = {}) {
    this.limit = limit;
    this.windowMs = windowMs;
    this.events = new Map();
  }

  check(key, now = Date.now()) {
    const arr = (this.events.get(key) || []).filter((t) => now - t < this.windowMs);
    if (arr.length >= this.limit) {
      this.events.set(key, arr);
      return { allowed: false, remaining: 0, retryAfterMs: this.windowMs - (now - arr[0]) };
    }
    arr.push(now);
    this.events.set(key, arr);
    return { allowed: true, remaining: this.limit - arr.length, retryAfterMs: 0 };
  }

  reset(key) {
    if (key) this.events.delete(key);
    else this.events.clear();
  }
}

// Duplicate-task protection helper (bot runner / optimistic UI).
export function dedupeKey(parts) {
  return parts.map((p) => String(p ?? '')).join(':');
}

export function extractMentions(text) {
  const out = [];
  const re = /@([a-zA-Z0-9_.]{3,24})/g;
  let m;
  while ((m = re.exec(String(text || ''))) !== null) out.push(m[1].toLowerCase());
  return [...new Set(out)];
}

export function truncate(text, max = 140) {
  const s = String(text || '');
  return s.length <= max ? s : `${s.slice(0, max - 1)}…`;
}

export function uid(prefix = 'id') {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 9)}`;
}

// --- Groups & Pages -------------------------------------------------------
// Group shape: { name, description, privacy: 'public'|'private', cover,
//   createdBy, members: [uid], createdAt } — membership lives on the group
//   document itself; the creator is always a member and acts as group admin.
// Page shape: { name, category, about, avatar, cover, ownerId,
//   followers: [uid], createdAt }.
export function normaliseGroup(input = {}, creatorId = '', now = Date.now()) {
  const members = [...new Set([creatorId, ...(Array.isArray(input.members) ? input.members : [])].filter(Boolean))];
  return {
    name: String(input.name || '').trim().slice(0, 80),
    description: String(input.description || '').trim().slice(0, 500),
    privacy: input.privacy === 'private' ? 'private' : 'public',
    cover: String(input.cover || ''),
    createdBy: creatorId || String(input.createdBy || ''),
    members,
    createdAt: Number(input.createdAt) || now
  };
}

export function normalisePage(input = {}, ownerId = '', now = Date.now()) {
  return {
    name: String(input.name || '').trim().slice(0, 80),
    category: String(input.category || '').trim().slice(0, 60) || 'Community',
    about: String(input.about || '').trim().slice(0, 500),
    avatar: String(input.avatar || ''),
    cover: String(input.cover || ''),
    ownerId: ownerId || String(input.ownerId || ''),
    followers: [...new Set((Array.isArray(input.followers) ? input.followers : []).filter(Boolean))],
    createdAt: Number(input.createdAt) || now
  };
}

export function isGroupMember(group, uidValue) {
  if (!group || !uidValue) return false;
  return group.createdBy === uidValue || (group.members || []).includes(uidValue);
}

// Discoverability: public groups are visible to everyone signed in; private
// groups only to their members/creator.
export function canViewGroup(group, viewerId) {
  if (!group || !viewerId) return false;
  if (group.privacy !== 'private') return true;
  return isGroupMember(group, viewerId);
}

// Group posts ignore the post-level visibility field — the GROUP's privacy
// governs. Public group -> any signed-in viewer; private group -> members
// (and the creator) only. The author always sees their own post, and posts
// by blocked authors stay hidden, mirroring canViewPost.
export function canViewGroupPost(post, group, viewerId, blockedIds) {
  if (!post || !viewerId) return false;
  const blocked = blockedIds instanceof Set ? blockedIds : new Set(blockedIds || []);
  if (blocked.has(post.authorId)) return false;
  if (post.authorId === viewerId) return true;
  if (!group) return false;
  if (group.privacy !== 'private') return true;
  // Private group: current members, plus anyone in the post's
  // denormalized audience (members at creation time — this is also the
  // only path by which live mode delivers these posts at all).
  return isGroupMember(group, viewerId) || (post.audienceIds || []).includes(viewerId);
}

// --- Stories --------------------------------------------------------------
// Stories are PHOTO/TEXT only (never video) and live for 24 hours.
// Story shape: { authorId, image, text, bg, visibility: 'public'|'friends',
//   audienceIds, views: [uid], createdAt } — the audience is denormalized
// exactly like posts (see postAudience): friends stories snapshot the
// author's accepted friend ids at creation time, public stories carry [].
// That keeps the Firestore read rule provable from the client's queries.

export const STORY_TTL_MS = 24 * 3600_000;

// Preset gradient backgrounds for text stories. `key` is what gets stored
// on the story document; `css` is the rendered background.
export const STORY_BACKGROUNDS = [
  { key: 'sunset', css: 'linear-gradient(135deg, #f83600, #f9d423)' },
  { key: 'ocean', css: 'linear-gradient(135deg, #1877f2, #42b883)' },
  { key: 'grape', css: 'linear-gradient(135deg, #8957e5, #bf3989)' },
  { key: 'forest', css: 'linear-gradient(135deg, #0a7ea4, #14532d)' },
  { key: 'ember', css: 'linear-gradient(135deg, #e5534b, #8957e5)' }
];

export function storyBackgroundCss(key) {
  const found = STORY_BACKGROUNDS.find((b) => b.key === key);
  return (found || STORY_BACKGROUNDS[0]).css;
}

// Firestore returns server timestamps as Timestamp objects; the rest of
// the app works in epoch milliseconds. Normalise numbers, Dates,
// Timestamp-like objects ({ toMillis }) and { seconds } shapes to ms.
export function tsToMs(value) {
  if (value == null) return 0;
  if (typeof value === 'number') return Number.isFinite(value) ? value : 0;
  if (value instanceof Date) return value.getTime();
  if (typeof value.toMillis === 'function') return value.toMillis();
  if (typeof value.seconds === 'number') return value.seconds * 1000 + Math.floor((value.nanoseconds || 0) / 1e6);
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

// A story is active strictly inside its 24-hour window:
// createdAt > now - 24h (a story exactly 24h old has expired).
export function isStoryActive(story, now = Date.now()) {
  if (!story) return false;
  const created = tsToMs(story.createdAt);
  return created > 0 && created > now - STORY_TTL_MS;
}

export function activeStories(stories, now = Date.now()) {
  return (stories || []).filter((s) => isStoryActive(s, now));
}

// Group active stories by author for the home-feed rail: each group holds
// the author's stories oldest-first (viewer playback order) and groups are
// ordered by their newest story, most recent first.
export function groupStoriesByAuthor(stories, now = Date.now()) {
  const byAuthor = new Map();
  for (const s of activeStories(stories, now)) {
    if (!byAuthor.has(s.authorId)) byAuthor.set(s.authorId, []);
    byAuthor.get(s.authorId).push(s);
  }
  return [...byAuthor.entries()]
    .map(([authorId, list]) => {
      const sorted = [...list].sort((a, b) => tsToMs(a.createdAt) - tsToMs(b.createdAt));
      return { authorId, stories: sorted, latestAt: tsToMs(sorted[sorted.length - 1]?.createdAt) };
    })
    .sort((a, b) => b.latestAt - a.latestAt);
}

// Story visibility mirrors canViewPost: author always, blocked authors
// never, public for everyone, friends via the denormalized audienceIds
// with the live friendship set as fallback.
// ctx: { viewerId, friendIds:Set|Array, blockedIds:Set|Array }
export function canViewStory(story, ctx) {
  if (!story || !ctx) return false;
  const blocked = ctx.blockedIds instanceof Set ? ctx.blockedIds : new Set(ctx.blockedIds || []);
  if (blocked.has(story.authorId)) return false;
  if (story.authorId === ctx.viewerId) return true;
  const vis = story.visibility || 'public';
  if (vis === 'public') return true;
  if (vis === 'friends') {
    if (Array.isArray(story.audienceIds) && story.audienceIds.includes(ctx.viewerId)) return true;
    const friends = ctx.friendIds instanceof Set ? ctx.friendIds : new Set(ctx.friendIds || []);
    return friends.has(story.authorId);
  }
  return false;
}

// Case-insensitive name search used by the Groups/Pages discover pages.
// An empty query returns a copy of the full list.
export function searchByName(items, queryText) {
  const q = String(queryText || '').trim().toLowerCase();
  const list = [...(items || [])];
  if (!q) return list;
  return list.filter((x) => String(x?.name || '').toLowerCase().includes(q));
}

// --- Polls ------------------------------------------------------------------
// A post may carry `poll: { options: [{id, text}], votes: { uid: optionId } }`.
// Votes are a MAP keyed by voter uid, so casting/changing a vote is a plain
// engagement update on the post document (the posts update rule pins the
// body/visibility/audience but leaves engagement fields writable).

// Tally a poll: per-option vote counts and rounded percentages, plus the
// total number of voters. Votes pointing at a removed/unknown option are
// ignored.
export function pollResults(post) {
  const poll = post?.poll;
  if (!poll || !Array.isArray(poll.options)) return { options: [], totalVotes: 0 };
  const counts = new Map(poll.options.map((o) => [o.id, 0]));
  let total = 0;
  for (const optionId of Object.values(poll.votes || {})) {
    if (counts.has(optionId)) { counts.set(optionId, counts.get(optionId) + 1); total += 1; }
  }
  return {
    totalVotes: total,
    options: poll.options.map((o) => {
      const votes = counts.get(o.id) || 0;
      return { id: o.id, text: o.text, votes, pct: total ? Math.round((votes / total) * 100) : 0 };
    })
  };
}

// Pure vote application: returns the NEW votes map with uid's vote set to
// optionId (re-voting simply overwrites — that is how changing a vote
// works). Unknown options / missing uid leave the votes unchanged.
export function castPollVote(poll, uidValue, optionId) {
  const votes = { ...(poll?.votes || {}) };
  if (!poll || !uidValue || !(poll.options || []).some((o) => o.id === optionId)) return votes;
  votes[uidValue] = optionId;
  return votes;
}

// Normalise the composer's raw option strings into a poll object: trims,
// drops blanks, dedupes, keeps 2–4 options. Returns null when fewer than
// two usable options remain (the caller then posts without a poll).
export function normalisePoll(optionTexts) {
  const seen = new Set();
  const options = [];
  for (const raw of optionTexts || []) {
    const text = String(raw || '').trim().slice(0, 60);
    if (!text || seen.has(text.toLowerCase())) continue;
    seen.add(text.toLowerCase());
    options.push({ id: `opt${options.length + 1}`, text });
    if (options.length === 4) break;
  }
  if (options.length < 2) return null;
  return { options, votes: {} };
}

// --- Feelings ---------------------------------------------------------------
// Preset feelings for the composer. The KEY is stored on the post
// (`feeling` field); label/emoji are looked up at render time.
export const FEELINGS = [
  { key: 'happy', emoji: '😊', label: 'happy' },
  { key: 'loved', emoji: '🥰', label: 'loved' },
  { key: 'excited', emoji: '🤩', label: 'excited' },
  { key: 'sad', emoji: '😢', label: 'sad' },
  { key: 'tired', emoji: '😴', label: 'tired' },
  { key: 'grateful', emoji: '🙏', label: 'grateful' },
  { key: 'celebrating', emoji: '🎉', label: 'celebrating' }
];

export function feelingByKey(key) {
  return FEELINGS.find((f) => f.key === key) || null;
}

// --- Events -----------------------------------------------------------------
// Event shape: { title, description, dateTime (epoch ms), location, cover,
//   createdBy, visibility: 'public'|'friends', audienceIds, going: [uid],
//   interested: [uid], createdAt }. The audience is denormalized with the
//   same postAudience() helper posts use, so the Firestore read rule and
//   the live listeners stay provable (public / createdBy == me /
//   audienceIds contains me).
export function normaliseEvent(input = {}, creatorId = '', now = Date.now()) {
  return {
    title: String(input.title || '').trim().slice(0, 120),
    description: String(input.description || '').trim().slice(0, 1000),
    dateTime: Number(input.dateTime) || 0,
    location: String(input.location || '').trim().slice(0, 120),
    cover: String(input.cover || ''),
    createdBy: creatorId || String(input.createdBy || ''),
    visibility: input.visibility === 'friends' ? 'friends' : 'public',
    audienceIds: [...new Set((Array.isArray(input.audienceIds) ? input.audienceIds : []).filter(Boolean))],
    going: [...new Set((Array.isArray(input.going) ? input.going : []).filter(Boolean))],
    interested: [...new Set((Array.isArray(input.interested) ? input.interested : []).filter(Boolean))],
    createdAt: Number(input.createdAt) || now
  };
}

// Mirrors canViewPost for events (creator field is `createdBy`, and there
// is no only-me): creator always, blocked creators never, public for
// everyone, friends via the denormalized audienceIds with the live
// friendship set as fallback.
// ctx: { viewerId, friendIds:Set|Array, blockedIds:Set|Array }
export function canViewEvent(event, ctx) {
  if (!event || !ctx) return false;
  const blocked = ctx.blockedIds instanceof Set ? ctx.blockedIds : new Set(ctx.blockedIds || []);
  if (blocked.has(event.createdBy)) return false;
  if (event.createdBy === ctx.viewerId) return true;
  const vis = event.visibility || 'public';
  if (vis === 'public') return true;
  if (vis === 'friends') {
    if (Array.isArray(event.audienceIds) && event.audienceIds.includes(ctx.viewerId)) return true;
    const friends = ctx.friendIds instanceof Set ? ctx.friendIds : new Set(ctx.friendIds || []);
    return friends.has(event.createdBy);
  }
  return false;
}

// The main events list shows only events that have not yet happened,
// soonest first. (Past events stay reachable by direct link.)
export function upcomingEvents(events, now = Date.now()) {
  return (events || [])
    .filter((e) => e && Number(e.dateTime) >= now)
    .sort((a, b) => Number(a.dateTime) - Number(b.dateTime));
}

// --- Memories ---------------------------------------------------------------
// "On this day": the viewer's OWN posts from the same calendar month/day
// in earlier years. Computed client-side from already-synced posts — no
// extra collection or query. Returns [{ post, yearsAgo }] newest memory
// (fewest years ago) last... actually sorted by yearsAgo ascending so the
// most recent anniversary comes first.
export function memoriesFor(posts, viewerId, now = Date.now()) {
  if (!viewerId) return [];
  const today = new Date(now);
  const out = [];
  for (const p of posts || []) {
    if (!p || p.authorId !== viewerId) continue;
    const created = tsToMs(p.createdAt);
    if (!created) continue;
    const d = new Date(created);
    if (d.getFullYear() >= today.getFullYear()) continue;
    if (d.getMonth() === today.getMonth() && d.getDate() === today.getDate()) {
      out.push({ post: p, yearsAgo: today.getFullYear() - d.getFullYear() });
    }
  }
  return out.sort((a, b) => a.yearsAgo - b.yearsAgo || b.post.createdAt - a.post.createdAt);
}

// --- Page reviews -----------------------------------------------------------
// Review shape: { pageId, authorId, rating (1–5), text, createdAt }.
export function averageRating(reviews) {
  const list = (reviews || []).filter((r) => Number(r?.rating) >= 1 && Number(r?.rating) <= 5);
  if (!list.length) return { average: 0, count: 0 };
  const sum = list.reduce((acc, r) => acc + Number(r.rating), 0);
  return { average: Math.round((sum / list.length) * 10) / 10, count: list.length };
}

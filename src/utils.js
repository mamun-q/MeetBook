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
  // Defensive: accept epoch ms, Dates and Firestore Timestamp shapes —
  // a raw Timestamp reaching here used to render as a 1970s date.
  const ms = tsToMs(ts);
  const diff = Math.max(0, now - ms);
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
  return new Date(ms).toLocaleDateString();
}

// Return a copy of a Firestore document's data with the named time fields
// converted from Timestamp shapes to epoch milliseconds (tsToMs). The
// remote mappers in api.js run every mirrored document through this so
// the rest of the app only ever sees numbers — a pending serverTimestamp()
// (null) is left untouched and converts to 0 via tsToMs at read time.
export function normaliseTimeFields(obj, fields) {
  if (!obj || typeof obj !== 'object') return obj;
  const out = { ...obj };
  for (const f of fields || []) {
    if (out[f] !== undefined && out[f] !== null) out[f] = tsToMs(out[f]);
  }
  return out;
}

// --- Auth errors ----------------------------------------------------------
// Firebase Auth errors carry machine codes ("auth/invalid-credential")
// and raw messages like "Firebase: Error (auth/weak-password)." — neither
// belongs in front of a user. Map the common codes to friendly text; any
// other Firebase-flavoured message collapses to a generic line, while
// our own plain-English errors pass through unchanged.
const AUTH_ERROR_MESSAGES = {
  'auth/invalid-credential': 'Wrong email or password.',
  'auth/invalid-login-credentials': 'Wrong email or password.',
  'auth/user-not-found': 'Wrong email or password.',
  'auth/wrong-password': 'Wrong email or password.',
  'auth/email-already-in-use': 'An account with that email already exists.',
  'auth/weak-password': 'Password is too weak — use at least 6 characters.',
  'auth/too-many-requests': 'Too many attempts — please wait a few minutes and try again.',
  'auth/network-request-failed': 'Network problem — check your connection and try again.',
  'auth/invalid-email': 'That email address looks invalid.',
  'auth/popup-closed-by-user': 'The sign-in popup was closed before finishing.',
  'auth/cancelled-popup-request': 'The sign-in popup was closed before finishing.',
  'auth/user-disabled': 'This account has been disabled.',
  'auth/operation-not-allowed': 'That sign-in method is not enabled for this app.'
};

export function friendlyAuthError(err) {
  if (!err) return 'Something went wrong. Please try again.';
  const fromMessage = typeof err.message === 'string'
    ? err.message.match(/\((auth\/[a-z0-9-]+)\)/i)?.[1]
    : null;
  const code = err.code || fromMessage || '';
  if (AUTH_ERROR_MESSAGES[code]) return AUTH_ERROR_MESSAGES[code];
  const msg = String(err.message || err);
  if (/^Firebase:/i.test(msg) || /\(auth\//i.test(msg)) return 'Something went wrong. Please try again.';
  return msg;
}

// --- Roles & account status (Super Admin Control Center, Pack A) --------
// users.role ∈ 'user' | 'analyst' | 'moderator' | 'admin' | 'superadmin'
// (bot accounts carry role 'bot'). The helpers below are the single client
// source of truth for staff gating; firestore.rules enforces the same
// ladder server-side (isAdmin / isSuperAdmin / isModerator), so hiding a
// button here is never the only protection. ANALYST is read-only staff:
// isStaff() is true but every action gate below excludes analysts.
export const STAFF_ROLES = ['analyst', 'moderator', 'admin', 'superadmin'];
export const ASSIGNABLE_ROLES = ['user', 'analyst', 'moderator', 'admin', 'superadmin'];

export function isStaff(user) {
  return Boolean(user) && !user.isBot && STAFF_ROLES.includes(user.role);
}

// Moderation work: report review and (elsewhere) content actions.
export function canModerate(user) {
  return Boolean(user) && !user.isBot && ['moderator', 'admin', 'superadmin'].includes(user.role);
}

// Full operational admins (the pre-Pack-A "admin" checks map to this).
export function isAdminRole(user) {
  return Boolean(user) && !user.isBot && ['admin', 'superadmin'].includes(user.role);
}

export function isSuperAdmin(user) {
  return Boolean(user) && !user.isBot && user.role === 'superadmin';
}

export function isAnalyst(user) {
  return Boolean(user) && !user.isBot && user.role === 'analyst';
}

// users.status ∈ 'active' | 'suspended' | 'banned'; an absent/unknown
// status means active (accounts predate the field).
export function accountStatus(user) {
  const s = user?.status;
  return s === 'suspended' || s === 'banned' ? s : 'active';
}

// May `actor` run status/verify actions (suspend, ban, restore, verify)
// on `target`? Admins and superadmins only; never on yourself, never on
// a bot (bots live in the Bot panel), and never on a superadmin — a
// superadmin manages admins, but no one manages another superadmin.
export function canManageUser(actor, target) {
  if (!isAdminRole(actor) || !target || target.isBot) return false;
  if (actor.id === target.id) return false;
  if (target.role === 'superadmin') return false;
  return true;
}

// May `actor` change `target`'s role (or delete the account)? Superadmin
// only, never your own role, never a bot's, and one superadmin cannot
// demote another superadmin.
export function canChangeRole(actor, target) {
  if (!isSuperAdmin(actor) || !target || target.isBot) return false;
  if (actor.id === target.id) return false;
  if (target.role === 'superadmin') return false;
  return true;
}

// --- Reports, platform stats & analytics (Super Admin Pack B) -----------
// Report lifecycle (Pack B): 'pending' → 'review' → 'resolved' /
// 'rejected', with 'escalated' for cases kicked upstairs. Reports filed
// before Pack B carry the legacy vocabulary ('open' / 'actioned' /
// 'dismissed') — reportStatus() normalises those onto the new statuses
// so counts, filters and badges agree everywhere without a migration.
export const REPORT_STATUSES = ['pending', 'review', 'resolved', 'rejected', 'escalated'];
export const REPORT_CATEGORIES = ['fake', 'harassment', 'spam', 'inappropriate', 'impersonation', 'bot', 'other'];
export const REPORT_OUTCOMES = ['none', 'content-removed', 'user-warned', 'user-suspended'];

export function reportStatus(report) {
  const s = String(report?.status || '');
  if (s === 'open') return 'pending';
  if (s === 'actioned') return 'resolved';
  if (s === 'dismissed') return 'rejected';
  return REPORT_STATUSES.includes(s) ? s : 'pending';
}

export function reportCategory(report) {
  const c = String(report?.category || '');
  return REPORT_CATEGORIES.includes(c) ? c : 'other';
}

// Statuses that still need a moderator's attention (nav badge count).
export function reportNeedsAttention(report) {
  return ['pending', 'review', 'escalated'].includes(reportStatus(report));
}

// "Online now" — the same freshness rule as the right rail
// (views.isFreshOnline): the online flag must be set AND the lastSeen
// heartbeat younger than 10 minutes; docs without lastSeen fall back to
// the flag alone.
export const ONLINE_FRESH_MS = 10 * 60_000;
export function isOnlineNow(user, now = Date.now()) {
  if (!user?.online) return false;
  const seen = Number(user.lastSeen) || 0;
  if (!seen) return true;
  return now - seen < ONLINE_FRESH_MS;
}

// Comments on a post = top-level comments + their replies.
export function countPostComments(post) {
  return (post?.comments || []).reduce((n, c) => n + 1 + (c.replies || []).length, 0);
}

// Every Overview number, computed from the dataset the admin client
// actually holds. `aggregates` (api.loadAdminStats, live mode only) may
// carry server-side totals for posts/messages and scan-derived
// comments/likes sums; any metric it does not cover falls back to the
// mirrored dataset and is flagged in `sources` ('server' | 'loaded') so
// the UI can label it honestly instead of inventing precision.
export function platformStats(d, now = Date.now(), aggregates = null) {
  const DAY = 24 * 3600_000;
  const humans = (d.users || []).filter((u) => !u.isBot);
  const within = (ts, ms) => { const t = Number(ts) || 0; return t > 0 && now - t < ms; };
  const mirrorComments = (d.posts || []).reduce((n, p) => n + countPostComments(p), 0);
  const mirrorLikes = (d.posts || []).reduce((n, p) => n + (p.likes || []).length, 0);
  const serverNum = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
  const aggPosts = serverNum(aggregates?.postsTotal);
  const aggMessages = serverNum(aggregates?.messagesTotal);
  const aggComments = serverNum(aggregates?.commentsTotal);
  const aggLikes = serverNum(aggregates?.likesTotal);
  const bots = d.bots || [];
  return {
    totalUsers: humans.length,
    // Every users doc the client holds, bot accounts included — the
    // number the Admin → Users table actually lists. totalUsers above
    // stays humans-only (growth/online metrics are about people); the
    // Overview headline uses totalAccounts with the split spelled out
    // so the two surfaces can never silently disagree (Audit fix #12).
    totalAccounts: (d.users || []).length,
    botAccounts: (d.users || []).filter((u) => u.isBot).length,
    newToday: humans.filter((u) => within(u.createdAt, DAY)).length,
    new7d: humans.filter((u) => within(u.createdAt, 7 * DAY)).length,
    new30d: humans.filter((u) => within(u.createdAt, 30 * DAY)).length,
    onlineNow: humans.filter((u) => isOnlineNow(u, now)).length,
    activeUsers7d: humans.filter((u) => within(u.lastSeen, 7 * DAY)).length,
    totalPosts: aggPosts ?? (d.posts || []).length,
    totalComments: aggComments ?? mirrorComments,
    totalLikes: aggLikes ?? mirrorLikes,
    totalMessages: aggMessages ?? (d.messages || []).length,
    totalBots: bots.length,
    activeBots: bots.filter((b) => b.active !== false).length,
    disabledBots: bots.filter((b) => b.active === false).length,
    pendingReports: (d.reports || []).filter((r) => reportStatus(r) === 'pending').length,
    sources: {
      posts: aggPosts !== null ? 'server' : 'loaded',
      comments: aggComments !== null ? 'server' : 'loaded',
      likes: aggLikes !== null ? 'server' : 'loaded',
      messages: aggMessages !== null ? 'server' : 'loaded'
    }
  };
}

// Local-calendar day helpers for the analytics series.
export function dayStartMs(ts) {
  const dt = new Date(ts);
  dt.setHours(0, 0, 0, 0);
  return dt.getTime();
}
export function dayKeyOf(ts) {
  const dt = new Date(ts);
  const m = String(dt.getMonth() + 1).padStart(2, '0');
  const day = String(dt.getDate()).padStart(2, '0');
  return `${dt.getFullYear()}-${m}-${day}`;
}

// Per-day analytics series for the last `days` days (oldest → newest),
// aggregates only — no private user data. Engagement for a day is the
// likes + comments ON POSTS CREATED THAT DAY (labelled as such in the
// UI). Reports are grouped by the day they were FILED and their CURRENT
// status. Bot authorship is read from the author's users doc (isBot).
export function analyticsSeries(d, days = 30, now = Date.now()) {
  const span = Math.max(1, Math.min(365, Number(days) || 30));
  const todayStart = dayStartMs(now);
  const rows = [];
  const byDay = new Map();
  for (let i = span - 1; i >= 0; i--) {
    const start = todayStart - i * 24 * 3600_000;
    const row = {
      day: dayKeyOf(start), start,
      registrations: 0, totalUsers: 0, posts: 0, engagement: 0,
      botPosts: 0, humanPosts: 0,
      reportsPending: 0, reportsReview: 0, reportsResolved: 0, reportsRejected: 0, reportsEscalated: 0, reportsTotal: 0
    };
    rows.push(row);
    byDay.set(row.day, row);
  }
  const usersByIdMap = new Map((d.users || []).map((u) => [u.id, u]));
  const humans = (d.users || []).filter((u) => !u.isBot);
  for (const u of humans) {
    const row = byDay.get(dayKeyOf(u.createdAt || 0));
    if (row) row.registrations += 1;
  }
  // Cumulative growth: everyone registered before the series window
  // counts toward the first day; each later day adds its registrations.
  let cumulative = humans.filter((u) => dayStartMs(u.createdAt || 0) < rows[0].start).length;
  for (const row of rows) { cumulative += row.registrations; row.totalUsers = cumulative; }
  for (const p of d.posts || []) {
    const row = byDay.get(dayKeyOf(p.createdAt || 0));
    if (!row) continue;
    row.posts += 1;
    row.engagement += (p.likes || []).length + countPostComments(p);
    if (usersByIdMap.get(p.authorId)?.isBot) row.botPosts += 1; else row.humanPosts += 1;
  }
  const statusField = { pending: 'reportsPending', review: 'reportsReview', resolved: 'reportsResolved', rejected: 'reportsRejected', escalated: 'reportsEscalated' };
  for (const r of d.reports || []) {
    const row = byDay.get(dayKeyOf(r.createdAt || 0));
    if (!row) continue;
    row.reportsTotal += 1;
    row[statusField[reportStatus(r)]] += 1;
  }
  return rows;
}

export function seriesToCsv(rows) {
  const header = ['day', 'registrations', 'totalUsers', 'posts', 'engagement', 'botPosts', 'humanPosts', 'reportsTotal', 'reportsPending', 'reportsReview', 'reportsResolved', 'reportsRejected', 'reportsEscalated'];
  const lines = [header.join(',')];
  for (const r of rows || []) lines.push(header.map((k) => String(r[k] ?? '')).join(','));
  return lines.join('\n');
}

// --- Possible-spam heuristics (Content module) ---------------------------
// Client-side HEURISTICS over the posts the admin client has loaded —
// suggestions for human review, never verdicts. A post is flagged when
// any rule fires:
//  - 'repeat': its author posted near-identical text 3+ times;
//  - 'links': the text contains 3+ links;
//  - 'burst': the author posted 5+ posts inside any 10-minute window.
// Returns [{ post, flags: [...] }] newest first.
export function spamSuspects(posts) {
  const norm = (text) => String(text || '').toLowerCase().replace(/\s+/g, ' ').trim();
  const linkCount = (text) => (String(text || '').match(/https?:\/\/|www\./gi) || []).length;
  const flagged = new Map();
  const add = (post, flag) => {
    if (!flagged.has(post.id)) flagged.set(post.id, { post, flags: [] });
    const entry = flagged.get(post.id);
    if (!entry.flags.includes(flag)) entry.flags.push(flag);
  };
  const list = [...(posts || [])];
  // Repeat-text groups per author.
  const groups = new Map();
  for (const p of list) {
    const key = `${p.authorId}::${norm(p.text)}`;
    if (!norm(p.text)) continue;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(p);
  }
  for (const group of groups.values()) {
    if (group.length >= 3) for (const p of group) add(p, 'repeat');
  }
  for (const p of list) if (linkCount(p.text) >= 3) add(p, 'links');
  // Burst windows per author.
  const byAuthor = new Map();
  for (const p of list) {
    if (!byAuthor.has(p.authorId)) byAuthor.set(p.authorId, []);
    byAuthor.get(p.authorId).push(p);
  }
  for (const mine of byAuthor.values()) {
    const sorted = [...mine].sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
    for (let i = 0; i < sorted.length; i++) {
      const window = sorted.filter((p) => (p.createdAt || 0) - (sorted[i].createdAt || 0) < 10 * 60_000 && (p.createdAt || 0) >= (sorted[i].createdAt || 0));
      if (window.length >= 5) for (const p of window) add(p, 'burst');
    }
  }
  return [...flagged.values()].sort((a, b) => (b.post.createdAt || 0) - (a.post.createdAt || 0));
}

// --- Pluralisation ----------------------------------------------------------
// "1 Member" vs "3 Members": plural(3, 'Member', 'Members').
export function plural(count, singular, pluralForm) {
  const n = Number(count) || 0;
  return `${n} ${n === 1 ? singular : (pluralForm ?? singular)}`;
}

// --- Mutual friends -----------------------------------------------------------
// Accepted-friend id set for a user, computed from a friendships array
// (works on the mirrored dataset in either mode).
export function acceptedFriendIds(friendships, uidValue) {
  const ids = new Set();
  for (const f of friendships || []) {
    if (f.status !== 'accepted') continue;
    if (f.from === uidValue) ids.add(f.to);
    if (f.to === uidValue) ids.add(f.from);
  }
  return ids;
}

// Ids that are accepted friends of BOTH users.
export function mutualFriends(friendships, aId, bId) {
  if (!aId || !bId || aId === bId) return [];
  const aFriends = acceptedFriendIds(friendships, aId);
  return [...acceptedFriendIds(friendships, bId)].filter((id) => aFriends.has(id));
}

export function mutualFriendCount(friendships, aId, bId) {
  return mutualFriends(friendships, aId, bId).length;
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
//    visibility 'private', audienceIds = the group's current members.
//    NOTE: for group posts the stored pair is only a marker — reads
//    follow CURRENT group membership at read time (see
//    canViewGroupPost), never this creation-time snapshot, so later
//    joiners see older posts and former members lose them.
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

// Merge several post lists into one, deduped by post id. Later lists win
// for a shared id, so callers pass the most authoritative source last
// (the live sync merges [local echo, public, audience, own] — a post the
// "public" AND "audience" listeners both deliver must appear exactly
// once, with the server copy replacing the optimistic echo).
export function mergePostLists(...lists) {
  const byIdMap = new Map();
  for (const list of lists) {
    for (const p of list || []) {
      if (p && p.id) byIdMap.set(p.id, p);
    }
  }
  return [...byIdMap.values()];
}

// Collapse exact-duplicate notifications for display: same recipient,
// type, actor and body text within `windowMs` of the kept (newest) copy
// counts as one. Live mode can hold duplicate DOCUMENTS for a single
// event (e.g. a friend request sent twice before the first sync came
// back); the notifications view renders the collapsed list so the user
// never sees the same line three or four times. Input order is
// preserved (callers pass newest-first); the input is not mutated.
export function collapseDuplicateNotifications(list, windowMs = 3600_000) {
  const keptAt = new Map();
  const out = [];
  for (const n of list || []) {
    if (!n) continue;
    const key = `${n.userId}|${n.type}|${n.actorId}|${n.text}`;
    const kept = keptAt.get(key);
    if (kept !== undefined && Math.abs(kept - (n.createdAt || 0)) <= windowMs) continue;
    keptAt.set(key, n.createdAt || 0);
    out.push(n);
  }
  return out;
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
  // Private group: CURRENT members only. The post's stored audienceIds
  // (members at creation time) deliberately do NOT grant access here:
  // they are a creation-time snapshot, so keying off them hid older
  // posts from members who joined later and kept showing them to
  // members who had left or been removed. Live delivery follows the
  // same read-time rule (the group-posts slice in api.js fetches by
  // current membership; the posts RLS policy checks the group's
  // current members), so this gate and delivery agree.
  return isGroupMember(group, viewerId);
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
  { key: 'happy', emoji: '😊', label: 'happy', labelKey: 'feelingHappy' },
  { key: 'loved', emoji: '🥰', label: 'loved', labelKey: 'feelingLoved' },
  { key: 'excited', emoji: '🤩', label: 'excited', labelKey: 'feelingExcited' },
  { key: 'sad', emoji: '😢', label: 'sad', labelKey: 'feelingSad' },
  { key: 'tired', emoji: '😴', label: 'tired', labelKey: 'feelingTired' },
  { key: 'grateful', emoji: '🙏', label: 'grateful', labelKey: 'feelingGrateful' },
  { key: 'celebrating', emoji: '🎉', label: 'celebrating', labelKey: 'feelingCelebrating' }
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

// --- Bot conversation summaries (Pack C, Bot Control Center) ---------------
// Metadata ONLY for the bot details Conversations tab: which 1-1
// conversations a bot takes part in, how many messages each holds and
// when the last one landed — never message bodies. Live mode cannot
// derive this from the mirrored dataset (it only holds the signed-in
// admin's own chats), so api.loadBotAdminData precomputes it into
// d.botConvMeta[botId]; when that is present it wins, otherwise the
// summaries are computed from the synced conversations/messages
// (demo mode holds everything).
export function botConversationSummaries(d, botId) {
  const pre = d?.botConvMeta?.[botId];
  if (Array.isArray(pre)) {
    return pre
      .map((c) => ({ id: c.id, otherId: c.otherId || '', isGroup: Boolean(c.isGroup), count: Number(c.count) || 0, lastAt: Number(c.lastAt) || 0 }))
      .sort((a, b) => b.lastAt - a.lastAt);
  }
  const out = [];
  for (const conv of d?.conversations || []) {
    if (conv.isGroup) continue;
    const parts = conv.participants || [];
    if (parts.length !== 2 || !parts.includes(botId)) continue;
    const msgs = (d.messages || []).filter((m) => m.conversationId === conv.id);
    out.push({
      id: conv.id,
      otherId: parts.find((p) => p !== botId) || '',
      isGroup: false,
      count: msgs.length,
      lastAt: msgs.reduce((mx, m) => Math.max(mx, Number(m.createdAt) || 0), Number(conv.createdAt) || 0)
    });
  }
  return out.sort((a, b) => b.lastAt - a.lastAt);
}

// --- Client error collector (Pack C, System Health) --------------------------
// A tiny ring of the most recent uncaught errors ON THIS DEVICE, kept in
// localStorage so the admin Health page can show what the client has
// actually hit. main.js feeds it from window 'error' events; nothing is
// ever sent anywhere — it is a local diagnostic, labelled as such.
const CLIENT_ERRORS_KEY = 'meetbook_client_errors';
const CLIENT_ERRORS_MAX = 10;

export function recordClientError(message, at = Date.now()) {
  try {
    const list = recentClientErrors();
    list.unshift({ message: String(message || 'Unknown error').slice(0, 300), at: Number(at) || Date.now() });
    localStorage.setItem(CLIENT_ERRORS_KEY, JSON.stringify(list.slice(0, CLIENT_ERRORS_MAX)));
  } catch { /* storage unavailable — diagnostics are best-effort */ }
}

export function recentClientErrors() {
  try {
    const raw = localStorage.getItem(CLIENT_ERRORS_KEY);
    const list = raw ? JSON.parse(raw) : [];
    return Array.isArray(list) ? list.filter((e) => e && typeof e.message === 'string') : [];
  } catch { return []; }
}

// --- Chat Pack: typing / replies / message reactions / themes / pins --------
// Pure helpers behind the Messenger upgrades. Storage shapes (identical in
// demo state and Firestore docs):
//  - conversations.typing: { [uid]: epochMs } — a heartbeat map; an entry
//    counts as "typing now" only while it is younger than TYPING_FRESH_MS,
//    so a crashed/closed client stops showing within seconds with no
//    cleanup write.
//  - conversations.theme: a CHAT_THEMES id ('default' when unset).
//  - messages.replyToId / replyToName / replyToText: a send-time snapshot
//    of the quoted message, so the quote renders even when the original
//    is outside the loaded window.
//  - messages.reactions: { [emoji]: [uid, ...] } — toggle semantics, one
//    entry per user per emoji; a user may hold several different emojis.
//  - messages.pinned / pinnedBy / pinnedAt: any participant may pin.

export const TYPING_FRESH_MS = 4000;

// Uids (other than the viewer) whose typing heartbeat is still fresh.
export function typingUserIds(conv, viewerId, now = Date.now()) {
  const map = conv?.typing || {};
  return Object.keys(map).filter((id) => id !== viewerId
    && typeof map[id] === 'number' && map[id] > 0 && now - map[id] < TYPING_FRESH_MS);
}

// True when a focus shift stays inside ONE form: the element losing
// focus and the element gaining it are owned by the same form (both
// form ids known and equal). The message composer's blur handler uses
// this to tell "pressed one of the composer's own controls" (above
// all the Send button — focus moves input -> button before the click
// can submit) apart from "genuinely left the composer". Clearing the
// typing entry in the first case is destructive: setTyping notifies
// the render listeners synchronously, and the resulting re-render
// rebuilds the thread mid-press, destroying the form and the button
// before they can submit.
export function focusMovesWithinForm(currentFormId, nextFormId) {
  return Boolean(currentFormId) && currentFormId === nextFormId;
}

// ------------------------------------------------------------ thread scroll
// Messenger thread stability: the app re-renders by rebuilding the
// whole DOM, so an open conversation's scroll position survives only
// if main.js captures it before the swap and restores it after. The
// DECISIONS live here as pure functions over plain measurements
// ({ id, top, height } rows, tops relative to the scroll container's
// content origin) so they are unit-testable without a DOM; main.js
// only measures and applies.
//
// The model is the standard chat one: the view is either PINNED to
// the tail (the user is at the bottom — new messages keep it glued
// there) or ANCHORED to the message row the user is reading (the
// first row whose bottom edge is past scrollTop, plus the offset of
// scrollTop inside that row). While anchored, NOTHING may move the
// view: a re-render restores exactly that row at exactly that offset,
// even when rows above it changed height (images loading in).
export const THREAD_PIN_THRESHOLD_PX = 48;

export function isThreadPinned({ scrollTop, scrollHeight, clientHeight }) {
  return scrollHeight - scrollTop - clientHeight <= THREAD_PIN_THRESHOLD_PX;
}

export function pickScrollAnchor(rows, scrollTop) {
  for (const r of rows || []) {
    if (r.top + r.height > scrollTop) return { id: r.id, offset: scrollTop - r.top };
  }
  return null;
}

export function anchoredScrollTop(rows, anchor) {
  if (!anchor) return null;
  const row = (rows || []).find((r) => r.id === anchor.id);
  return row ? row.top + anchor.offset : null;
}

// What a (re)built thread should do with its scroll position:
// 'bottom' for a fresh conversation (or one the user left pinned),
// 'anchor' when a captured reading position exists for THIS
// conversation.
export function threadRestoreMode(captured, convId) {
  if (!captured || captured.convId !== convId || captured.pinned) return 'bottom';
  return 'anchor';
}

// Should the view still count as pinned after a scroll event? A
// phone fires scroll events for RESIZES too: when the browser
// chrome shows/hides or the keyboard opens, the thread box's
// clientHeight changes and the browser adjusts/clamps scrollTop —
// no user gesture involved. Recomputing the pin from raw metrics
// there silently UNGLUES a user who was happily at the tail: the
// box shrank, the distance-to-bottom grew past the threshold, and
// the intent flipped to an anchor. So: when the box height changed
// since the previous event, the pin state is carried over as-is
// (a resize neither pins nor unpins); only a same-height event —
// a real scroll of the content — re-evaluates it from the metrics.
export function threadPinnedAfterScroll({ wasPinned, clientHeightBefore, scrollTop, scrollHeight, clientHeight }) {
  if (wasPinned != null && clientHeightBefore != null && clientHeight !== clientHeightBefore) return Boolean(wasPinned);
  return isThreadPinned({ scrollTop, scrollHeight, clientHeight });
}

// The displayable body of a page review. The create path stores the
// text under `text` (form field -> saveReview -> doc), and that is
// the canonical field; tolerate legacy docs written as body/comment
// and normalize whitespace-only text to '' so the renderer can omit
// the body of a stars-only review instead of showing a blank gap
// (Audit fix #8).
export function reviewText(review) {
  if (!review) return '';
  return String(review.text || review.body || review.comment || '').trim();
}

// Which RSVP toast an event-RSVP toggle shows. api.toggleEventRsvp
// resolves a BOOLEAN (true = the RSVP is now active, false = it was
// removed) — the toast key must come from that boolean, never from a
// property read on it (Audit fix #4: `!res.active` on a boolean is
// always true, so every toggle toasted "RSVP removed").
export function rsvpToastKey(nowActive, kind) {
  if (!nowActive) return 'rsvpRemoved';
  return kind === 'going' ? 'rsvpGoing' : 'rsvpInterested';
}

// Should a toast created at `createdAt` be dropped by a clearToasts
// pass at `now` that only clears toasts at least `minAgeMs` old? The
// hashchange handler clears with a grace window so feedback raised by
// the very action that navigated (login/logout/register raise their
// toast, THEN set location.hash) is not wiped in the same tick by the
// navigation it caused (Audit fix #3).
export function shouldClearToast(createdAt, now, minAgeMs = 0) {
  const at = Number(createdAt) || 0;
  if (!minAgeMs) return true;
  return now - at >= minAgeMs;
}

// The fixed reaction set offered on messages (Facebook-style six).
export const MESSAGE_REACTIONS = ['❤️', '😂', '😮', '😢', '😡', '👍'];

// Toggle one user's reaction of one emoji. Returns a NEW map (the input
// is never mutated); empty emoji lists are dropped so the stored map
// stays clean.
export function toggleEmojiReaction(reactions, emoji, userId) {
  const next = {};
  for (const [e, uids] of Object.entries(reactions || {})) {
    if (Array.isArray(uids) && uids.length) next[e] = [...uids];
  }
  if (!emoji || !userId) return next;
  const list = next[emoji] || [];
  if (list.includes(userId)) {
    const kept = list.filter((u) => u !== userId);
    if (kept.length) next[emoji] = kept; else delete next[emoji];
  } else {
    next[emoji] = [...list, userId];
  }
  return next;
}

// [{ emoji, count, uids }] for the chips row: most-reacted first, ties
// broken by the fixed MESSAGE_REACTIONS order so chips don't reshuffle.
export function reactionChips(reactions) {
  const order = new Map(MESSAGE_REACTIONS.map((e, i) => [e, i]));
  return Object.entries(reactions || {})
    .filter(([, uids]) => Array.isArray(uids) && uids.length)
    .map(([emoji, uids]) => ({ emoji, count: uids.length, uids: [...uids] }))
    .sort((a, b) => b.count - a.count || (order.get(a.emoji) ?? 99) - (order.get(b.emoji) ?? 99));
}

// One-line snippet of a message for quotes, the pinned bar and the
// pinned list: the text itself, or a media placeholder (the same
// emoji-label style the conversation list preview already uses).
export function messageSnippet(message, max = 120) {
  if (!message) return '';
  if (message.text) return truncate(message.text, max);
  if (message.audio) return '🎤 Voice message';
  if (message.image) return '📷 Photo';
  return '';
}

// The reply snapshot stored on a message sent as a reply: who wrote the
// original plus a ≤120-char snippet of it.
export function replySnapshot(original, senderName = '') {
  if (!original?.id) return null;
  return {
    replyToId: original.id,
    replyToName: String(senderName || ''),
    replyToText: messageSnippet(original, 120)
  };
}

// Pinned messages of a conversation, most recently pinned first.
export function pinnedMessages(messages) {
  return (messages || []).filter((m) => m?.pinned)
    .sort((a, b) => (Number(b.pinnedAt) || 0) - (Number(a.pinnedAt) || 0));
}

// Chat themes: `bubble` is the CSS background for the viewer's OWN
// message bubbles (applied through the --bubble-mine custom property),
// `tint` a subtle thread background, `gradient` the picker swatch.
// 'default' carries empty values so the stock look applies untouched.
export const CHAT_THEMES = [
  { id: 'default', gradient: '', bubble: '', tint: '' },
  { id: 'ocean', gradient: 'linear-gradient(135deg,#38bdf8,#2563eb)', bubble: 'linear-gradient(135deg,#0ea5e9,#2563eb)', tint: 'rgba(14,165,233,.07)' },
  { id: 'sunset', gradient: 'linear-gradient(135deg,#fbbf24,#ef4444)', bubble: 'linear-gradient(135deg,#f59e0b,#ef4444)', tint: 'rgba(245,158,11,.07)' },
  { id: 'grape', gradient: 'linear-gradient(135deg,#a78bfa,#d946ef)', bubble: 'linear-gradient(135deg,#8b5cf6,#c026d3)', tint: 'rgba(139,92,246,.08)' },
  { id: 'forest', gradient: 'linear-gradient(135deg,#4ade80,#0d9488)', bubble: 'linear-gradient(135deg,#22c55e,#0f766e)', tint: 'rgba(34,197,94,.07)' },
  { id: 'rose', gradient: 'linear-gradient(135deg,#fb7185,#db2777)', bubble: 'linear-gradient(135deg,#f43f5e,#db2777)', tint: 'rgba(244,63,94,.07)' },
  { id: 'midnight', gradient: 'linear-gradient(135deg,#64748b,#0f172a)', bubble: 'linear-gradient(135deg,#475569,#1e293b)', tint: 'rgba(100,116,139,.10)' },
  { id: 'peach', gradient: 'linear-gradient(135deg,#fdba74,#f472b6)', bubble: 'linear-gradient(135deg,#fb923c,#ec4899)', tint: 'rgba(251,146,60,.08)' },
  { id: 'royal', gradient: 'linear-gradient(135deg,#818cf8,#7c3aed)', bubble: 'linear-gradient(135deg,#6366f1,#7c3aed)', tint: 'rgba(99,102,241,.08)' }
];

export function chatTheme(id) {
  return CHAT_THEMES.find((th) => th.id === id) || CHAT_THEMES[0];
}

// ------------------------------------------------- Messenger Complete Pack
// Facebook-style message lifecycle helpers (pure, unit-tested).

// How long after sending the author may still edit a message.
export const EDIT_WINDOW_MS = 15 * 60 * 1000;

// True when `text` is nothing but emoji (and whitespace) — Facebook
// renders those big and bubble-less. Grapheme-aware via Intl.Segmenter
// where available so ZWJ sequences (👨‍👩‍👧) count as ONE emoji.
export function isEmojiOnlyText(text, maxEmoji = 3) {
  const s = String(text || '').trim();
  if (!s) return false;
  let count = 0;
  const segmenter = typeof Intl !== 'undefined' && Intl.Segmenter ? new Intl.Segmenter(undefined, { granularity: 'grapheme' }) : null;
  const parts = segmenter ? [...segmenter.segment(s)].map((x) => x.segment) : [...s];
  for (const part of parts) {
    if (!part.trim()) continue;
    // A grapheme counts as emoji when it carries the Extended_Pictographic
    // property or is a regional-indicator / keycap / skin-tone sequence.
    if (!/(\p{Extended_Pictographic}|\p{Regional_Indicator}|️|⃣)/u.test(part)) return false;
    count += 1;
    if (count > maxEmoji) return false;
  }
  return count > 0;
}

// The author may edit only their own text message, only inside the
// edit window, and never once it has been unsent.
export function canEditMessage(message, userId, now = Date.now()) {
  if (!message || message.senderId !== userId) return false;
  if (message.unsent || message.audio || message.image) return false;
  if (!String(message.text || '').trim()) return false;
  return now - Number(message.createdAt || 0) <= EDIT_WINDOW_MS;
}

// A message is visible to `userId` unless they removed it for
// themselves (hiddenFor) — unsent messages stay visible as tombstones.
export function isMessageVisibleTo(message, userId) {
  return !(message?.hiddenFor || []).includes(userId);
}

// Per-user conversation flags (archive / mute) live as uid arrays on
// the conversation document so they sync across the user's devices.
export function isConversationFlagged(conv, flag, userId) {
  return (conv?.[flag] || []).includes(userId);
}

// ------------------------------------------------------------ Fun Pack
// Sticker packs: curated emoji sets sent as sticker messages and
// rendered large, Messenger-style. Emoji glyphs need no image assets,
// so packs work offline and cost nothing to host.
export const STICKER_PACKS = [
  { id: 'faces', label: 'Faces', stickers: ['😀', '😂', '🤣', '😍', '🥳', '😎', '🤯', '🥺'] },
  { id: 'love', label: 'Love', stickers: ['❤️', '💖', '💘', '😘', '🥰', '💌', '🌹', '💍'] },
  { id: 'animals', label: 'Animals', stickers: ['🐶', '🐱', '🦊', '🐼', '🦁', '🐸', '🦄', '🐙'] },
  { id: 'food', label: 'Food', stickers: ['🍕', '🍔', '🍰', '🍩', '☕', '🧋', '🍓', '🍉'] },
  { id: 'party', label: 'Party', stickers: ['🎉', '🎂', '🎁', '🎈', '🥂', '🎶', '🏆', '🚀'] }
];

// Extended reaction set behind the picker's "more" grid — any of these
// can be a reaction, not just the six quick ones in MESSAGE_REACTIONS.
export const REACTION_EMOJI_SET = ['❤️', '😂', '😮', '😢', '😡', '👍', '👎', '🔥', '🎉', '😍', '🥰', '😎', '🤔', '😴', '🙏', '👏', '💯', '😱'];

// Chat polls ride on a message: poll = { question, options: [{ id,
// text, votes: [uid] }] }. Voting is one-per-person: picking another
// option moves the vote, picking the same option again withdraws it.
export function chatPollVote(poll, optionId, userId) {
  if (!poll || !Array.isArray(poll.options)) return poll;
  const options = poll.options.map((o) => ({ ...o, votes: (o.votes || []).filter((v) => v !== userId) }));
  const target = options.find((o) => o.id === optionId);
  const hadVoted = (poll.options.find((o) => o.id === optionId)?.votes || []).includes(userId);
  if (target && !hadVoted) target.votes = [...target.votes, userId];
  return { ...poll, options };
}

export function chatPollTotal(poll) {
  return (poll?.options || []).reduce((sum, o) => sum + (o.votes || []).length, 0);
}

// Per-conversation nicknames: conv.nicknames = { userId: nickname },
// set by any participant and visible to everyone in the chat.
export function nicknameFor(conv, userId, fallback = '') {
  const nick = conv?.nicknames?.[userId];
  return (typeof nick === 'string' && nick.trim()) ? nick : fallback;
}

export function mapsUrl(location) {
  if (!location) return '#';
  return `https://www.google.com/maps?q=${location.lat},${location.lng}`;
}

// ------------------------------------------------------- Useful Pack
// Vanish mode: messages sent while a conversation's vanish flag is on
// carry an expiresAt; once past it, every client simply stops showing
// them (the doc stays as an empty shell — Spark has no server timer).
export const VANISH_TTL_MS = 60_000;

export function isVanishExpired(message, now = Date.now()) {
  return Boolean(message?.vanish && message.expiresAt && now > message.expiresAt);
}

// Timed mute: mutedBy holds the flag, mutedUntil[uid] the expiry.
// No expiry entry = muted until manually unmuted.
export function isMutedNow(conv, userId, now = Date.now()) {
  if (!isConversationFlagged(conv, 'mutedBy', userId)) return false;
  const until = conv?.mutedUntil?.[userId];
  return !until || until > now;
}

// A 1-1 conversation is a message request when the other person is not
// my friend (and not a bot) and I have not accepted the chat yet.
export function isMessageRequest(conv, userId, friendIds, usersByIdMap) {
  if (!conv || conv.isGroup) return false;
  const otherId = (conv.participants || []).find((p) => p !== userId);
  if (!otherId) return false;
  if (usersByIdMap?.[otherId]?.isBot) return false;
  if (friendIds && typeof friendIds.has === 'function' && friendIds.has(otherId)) return false;
  return !(conv.acceptedBy || []).includes(userId);
}

export function formatBytes(bytes) {
  const n = Number(bytes) || 0;
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

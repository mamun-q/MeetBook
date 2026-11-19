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
// visibility: 'public' | 'friends' | 'only-me'
// ctx: { viewerId, authorId, friendIds:Set|Array, blockedIds:Set|Array }
export function canViewPost(post, ctx) {
  if (!post || !ctx) return false;
  const blocked = ctx.blockedIds instanceof Set ? ctx.blockedIds : new Set(ctx.blockedIds || []);
  if (blocked.has(post.authorId)) return false;
  if (post.authorId === ctx.viewerId) return true;
  const vis = post.visibility || 'public';
  if (vis === 'public') return true;
  if (vis === 'only-me') return false;
  if (vis === 'friends') {
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

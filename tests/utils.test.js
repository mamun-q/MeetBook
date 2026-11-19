import { describe, it, expect } from 'vitest';
import {
  validateUsername, validateEmail, validatePassword, canViewPost,
  filterVisiblePosts, paginate, RateLimiter, extractMentions, timeAgo, dedupeKey
} from '../src/utils.js';

describe('validateUsername', () => {
  it('accepts valid usernames and lowercases them', () => {
    expect(validateUsername('Ayesha.R')).toEqual({ ok: true, value: 'ayesha.r' });
    expect(validateUsername('tanvir_h99').ok).toBe(true);
  });
  it('rejects too short, too long, bad chars, reserved and dot-edges', () => {
    expect(validateUsername('ab').ok).toBe(false);
    expect(validateUsername('a'.repeat(25)).ok).toBe(false);
    expect(validateUsername('bad name').ok).toBe(false);
    expect(validateUsername('admin').ok).toBe(false);
    expect(validateUsername('.dot').ok).toBe(false);
    expect(validateUsername('dot.').ok).toBe(false);
    expect(validateUsername('').ok).toBe(false);
    expect(validateUsername(null).ok).toBe(false);
  });
});

describe('email & password validation', () => {
  it('validates emails', () => {
    expect(validateEmail('a@b.co')).toBe(true);
    expect(validateEmail('nope')).toBe(false);
    expect(validateEmail('a@b')).toBe(false);
  });
  it('requires 6+ char passwords', () => {
    expect(validatePassword('123456').ok).toBe(true);
    expect(validatePassword('12345').ok).toBe(false);
  });
});

describe('post privacy filter', () => {
  const ctx = { viewerId: 'me', friendIds: new Set(['friend1']), blockedIds: new Set(['blocked1']) };
  const posts = [
    { id: '1', authorId: 'stranger', visibility: 'public' },
    { id: '2', authorId: 'friend1', visibility: 'friends' },
    { id: '3', authorId: 'stranger', visibility: 'friends' },
    { id: '4', authorId: 'stranger', visibility: 'only-me' },
    { id: '5', authorId: 'me', visibility: 'only-me' },
    { id: '6', authorId: 'blocked1', visibility: 'public' },
    { id: '7', authorId: 'friend1', visibility: 'public' }
  ];
  it('shows public + friend-visible + own posts, hides others and blocked', () => {
    const visible = filterVisiblePosts(posts, ctx).map((p) => p.id);
    expect(visible).toEqual(['1', '2', '5', '7']);
  });
  it('canViewPost handles array friend lists', () => {
    expect(canViewPost(posts[1], { viewerId: 'me', friendIds: ['friend1'], blockedIds: [] })).toBe(true);
    expect(canViewPost(posts[2], { viewerId: 'me', friendIds: [], blockedIds: [] })).toBe(false);
  });
});

describe('paginate', () => {
  it('pages and reports hasMore', () => {
    const items = Array.from({ length: 25 }, (_, i) => i);
    expect(paginate(items, 1, 10).items).toHaveLength(10);
    expect(paginate(items, 1, 10).hasMore).toBe(true);
    expect(paginate(items, 3, 10).items).toHaveLength(5);
    expect(paginate(items, 3, 10).hasMore).toBe(false);
    expect(paginate([], 1, 10).total).toBe(0);
  });
});

describe('RateLimiter', () => {
  it('allows up to the limit then blocks within the window', () => {
    const rl = new RateLimiter({ limit: 3, windowMs: 1000 });
    const t0 = 1_000_000;
    expect(rl.check('k', t0).allowed).toBe(true);
    expect(rl.check('k', t0 + 10).allowed).toBe(true);
    expect(rl.check('k', t0 + 20).allowed).toBe(true);
    const blocked = rl.check('k', t0 + 30);
    expect(blocked.allowed).toBe(false);
    expect(blocked.retryAfterMs).toBeGreaterThan(0);
    expect(rl.check('k', t0 + 1001).allowed).toBe(true); // window slid
  });
  it('tracks keys independently and resets', () => {
    const rl = new RateLimiter({ limit: 1, windowMs: 1000 });
    expect(rl.check('a', 0).allowed).toBe(true);
    expect(rl.check('b', 0).allowed).toBe(true);
    expect(rl.check('a', 1).allowed).toBe(false);
    rl.reset('a');
    expect(rl.check('a', 2).allowed).toBe(true);
  });
});

describe('mentions, timeAgo, dedupeKey', () => {
  it('extracts unique lowercase mentions', () => {
    expect(extractMentions('hi @Ayesha.R and @tanvir_h, cc @ayesha.r')).toEqual(['ayesha.r', 'tanvir_h']);
    expect(extractMentions('no mentions')).toEqual([]);
  });
  it('formats relative time', () => {
    const now = 10_000_000;
    expect(timeAgo(now - 10_000, now)).toBe('just now');
    expect(timeAgo(now - 5 * 60_000, now)).toBe('5m');
    expect(timeAgo(now - 3 * 3600_000, now)).toBe('3h');
    expect(timeAgo(now - 2 * 24 * 3600_000, now)).toBe('2d');
  });
  it('builds stable dedupe keys', () => {
    expect(dedupeKey(['bot1', 42, null])).toBe('bot1:42:');
  });
});

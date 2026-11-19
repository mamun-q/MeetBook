import { describe, it, expect } from 'vitest';
import {
  pollResults, castPollVote, normalisePoll,
  upcomingEvents, canViewEvent, normaliseEvent,
  memoriesFor, postAudience, canViewPost, averageRating
} from '../src/utils.js';

// Free Features Pack: polls, events, memories, close friends, page reviews.

describe('pollResults', () => {
  const post = {
    poll: {
      options: [{ id: 'a', text: 'A' }, { id: 'b', text: 'B' }, { id: 'c', text: 'C' }],
      votes: { u1: 'a', u2: 'a', u3: 'b', u4: 'gone' } // 'gone' is not an option
    }
  };
  it('counts votes per option and ignores votes for unknown options', () => {
    const res = pollResults(post);
    expect(res.totalVotes).toBe(3);
    expect(res.options.map((o) => [o.id, o.votes])).toEqual([['a', 2], ['b', 1], ['c', 0]]);
  });
  it('computes rounded percentages that reflect the split', () => {
    const res = pollResults(post);
    expect(res.options.map((o) => o.pct)).toEqual([67, 33, 0]);
  });
  it('handles missing/empty polls', () => {
    expect(pollResults(null)).toEqual({ options: [], totalVotes: 0 });
    expect(pollResults({})).toEqual({ options: [], totalVotes: 0 });
    expect(pollResults({ poll: { options: [{ id: 'a', text: 'A' }], votes: {} } }).totalVotes).toBe(0);
  });
});

describe('castPollVote', () => {
  const poll = { options: [{ id: 'a', text: 'A' }, { id: 'b', text: 'B' }], votes: { u1: 'a' } };
  it('adds a new vote without mutating the original map', () => {
    const next = castPollVote(poll, 'u2', 'b');
    expect(next).toEqual({ u1: 'a', u2: 'b' });
    expect(poll.votes).toEqual({ u1: 'a' });
  });
  it('changing a vote overwrites the previous choice', () => {
    expect(castPollVote(poll, 'u1', 'b')).toEqual({ u1: 'b' });
  });
  it('rejects unknown options and missing uids', () => {
    expect(castPollVote(poll, 'u2', 'nope')).toEqual({ u1: 'a' });
    expect(castPollVote(poll, '', 'a')).toEqual({ u1: 'a' });
  });
});

describe('normalisePoll', () => {
  it('trims, dedupes and keeps at most 4 options', () => {
    const poll = normalisePoll([' Winter ', 'Monsoon', 'winter', '', 'Spring', 'Autumn', 'Extra']);
    expect(poll.options.map((o) => o.text)).toEqual(['Winter', 'Monsoon', 'Spring', 'Autumn']);
    expect(poll.votes).toEqual({});
  });
  it('returns null with fewer than two usable options', () => {
    expect(normalisePoll(['only'])).toBeNull();
    expect(normalisePoll(['', '  '])).toBeNull();
    expect(normalisePoll([])).toBeNull();
  });
});

describe('events: upcoming filter + audience', () => {
  const now = new Date(2026, 5, 15, 12, 0).getTime(); // 15 Jun 2026, local noon
  const mk = (id, dateTime, extra = {}) => normaliseEvent({ title: id, dateTime, ...extra }, 'creator', now);
  it('upcomingEvents hides past events and sorts soonest first', () => {
    const events = [mk('later', now + 72 * 3600e3), mk('past', now - 3600e3), mk('soon', now + 3600e3)];
    expect(upcomingEvents(events, now).map((e) => e.title)).toEqual(['soon', 'later']);
  });
  it('normaliseEvent defaults to public and dedupes RSVP lists', () => {
    const e = mk('x', now + 1000, { going: ['u1', 'u1', ''], visibility: 'friends' });
    expect(e.visibility).toBe('friends');
    expect(e.going).toEqual(['u1']);
    expect(mk('y', now + 1000).visibility).toBe('public');
  });
  it('canViewEvent: public for all, friends via audience snapshot or friendship', () => {
    const pub = mk('pub', now + 1000);
    const fr = mk('fr', now + 1000, { visibility: 'friends', audienceIds: ['u_in'] });
    expect(canViewEvent(pub, { viewerId: 'u_out', friendIds: [], blockedIds: [] })).toBe(true);
    expect(canViewEvent(fr, { viewerId: 'u_in', friendIds: [], blockedIds: [] })).toBe(true);
    expect(canViewEvent(fr, { viewerId: 'u_out', friendIds: ['creator'], blockedIds: [] })).toBe(true);
    expect(canViewEvent(fr, { viewerId: 'u_out', friendIds: [], blockedIds: [] })).toBe(false);
    expect(canViewEvent(fr, { viewerId: 'creator', friendIds: [], blockedIds: [] })).toBe(true);
    expect(canViewEvent(pub, { viewerId: 'u_in', friendIds: [], blockedIds: ['creator'] })).toBe(false);
  });
});

describe('memoriesFor (on this day)', () => {
  // Local-noon timestamps keep month/day stable in every timezone.
  const at = (y, m, d) => new Date(y, m, d, 12, 0).getTime();
  const now = at(2026, 5, 15);
  const posts = [
    { id: 'm1', authorId: 'me', createdAt: at(2025, 5, 15), text: 'one year ago' },
    { id: 'm2', authorId: 'me', createdAt: at(2023, 5, 15), text: 'three years ago' },
    { id: 'today', authorId: 'me', createdAt: at(2026, 5, 15), text: 'today — not a memory' },
    { id: 'other-day', authorId: 'me', createdAt: at(2025, 5, 16), text: 'wrong day' },
    { id: 'other-month', authorId: 'me', createdAt: at(2025, 4, 15), text: 'wrong month' },
    { id: 'not-mine', authorId: 'someone', createdAt: at(2025, 5, 15), text: 'not my post' }
  ];
  it('matches only my posts from the same month/day in earlier years', () => {
    const out = memoriesFor(posts, 'me', now);
    expect(out.map((m) => m.post.id)).toEqual(['m1', 'm2']);
    expect(out.map((m) => m.yearsAgo)).toEqual([1, 3]);
  });
  it('returns nothing without a viewer or posts', () => {
    expect(memoriesFor(posts, '', now)).toEqual([]);
    expect(memoriesFor([], 'me', now)).toEqual([]);
    expect(memoriesFor(null, 'me', now)).toEqual([]);
  });
});

describe('close friends audience', () => {
  it('postAudience snapshots closeFriends for close posts', () => {
    expect(postAudience({ visibility: 'close', authorCloseFriendIds: ['c1', 'c2', 'c1', ''] }))
      .toEqual({ visibility: 'close', audienceIds: ['c1', 'c2'] });
    expect(postAudience({ visibility: 'close' })).toEqual({ visibility: 'close', audienceIds: [] });
  });
  it('canViewPost treats close like friends: audience snapshot first, friendship fallback', () => {
    const post = { id: 'p', authorId: 'author', visibility: 'close', audienceIds: ['c1'] };
    expect(canViewPost(post, { viewerId: 'c1', friendIds: [], blockedIds: [] })).toBe(true);
    expect(canViewPost(post, { viewerId: 'plain-friend', friendIds: ['author'], blockedIds: [] })).toBe(true);
    expect(canViewPost(post, { viewerId: 'stranger', friendIds: [], blockedIds: [] })).toBe(false);
    expect(canViewPost(post, { viewerId: 'author', friendIds: [], blockedIds: [] })).toBe(true);
    expect(canViewPost(post, { viewerId: 'c1', friendIds: [], blockedIds: ['author'] })).toBe(false);
  });
});

describe('averageRating', () => {
  it('averages valid 1–5 ratings, rounded to one decimal, with a count', () => {
    expect(averageRating([{ rating: 5 }, { rating: 4 }, { rating: 4 }])).toEqual({ average: 4.3, count: 3 });
    expect(averageRating([{ rating: 5 }])).toEqual({ average: 5, count: 1 });
  });
  it('ignores out-of-range ratings and handles empties', () => {
    expect(averageRating([{ rating: 0 }, { rating: 9 }, { rating: 3 }])).toEqual({ average: 3, count: 1 });
    expect(averageRating([])).toEqual({ average: 0, count: 0 });
    expect(averageRating(null)).toEqual({ average: 0, count: 0 });
  });
});

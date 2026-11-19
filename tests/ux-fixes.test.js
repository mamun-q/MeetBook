// UX Audit Fix Pack — regression tests for the pure logic behind the
// fixes: friendly auth errors, pluralisation, mutual friends, and the
// Firestore Timestamp → epoch-ms normalisation that repairs post dates.
import { describe, it, expect } from 'vitest';
import {
  tsToMs, timeAgo, normaliseTimeFields, friendlyAuthError,
  plural, acceptedFriendIds, mutualFriends, mutualFriendCount
} from '../src/utils.js';
import { postCardHtml } from '../src/components.js';

describe('friendlyAuthError', () => {
  const wrap = (code, message = `Firebase: Error (${code}).`) => Object.assign(new Error(message), { code });

  it('maps credential failures to one friendly line, never raw Firebase text', () => {
    for (const code of ['auth/invalid-credential', 'auth/user-not-found', 'auth/wrong-password', 'auth/invalid-login-credentials']) {
      const msg = friendlyAuthError(wrap(code));
      expect(msg).toBe('Wrong email or password.');
      expect(msg).not.toContain('Firebase');
    }
  });

  it('maps the other common codes', () => {
    expect(friendlyAuthError(wrap('auth/email-already-in-use'))).toBe('An account with that email already exists.');
    expect(friendlyAuthError(wrap('auth/weak-password'))).toBe('Password is too weak — use at least 6 characters.');
    expect(friendlyAuthError(wrap('auth/too-many-requests'))).toBe('Too many attempts — please wait a few minutes and try again.');
    expect(friendlyAuthError(wrap('auth/network-request-failed'))).toBe('Network problem — check your connection and try again.');
    expect(friendlyAuthError(wrap('auth/invalid-email'))).toBe('That email address looks invalid.');
    expect(friendlyAuthError(wrap('auth/popup-closed-by-user'))).toBe('The sign-in popup was closed before finishing.');
  });

  it('detects the code inside a raw message when err.code is missing', () => {
    expect(friendlyAuthError(new Error('Firebase: Error (auth/weak-password).'))).toBe('Password is too weak — use at least 6 characters.');
  });

  it('collapses unknown Firebase errors and keeps plain app errors readable', () => {
    expect(friendlyAuthError(wrap('auth/internal-error'))).toBe('Something went wrong. Please try again.');
    expect(friendlyAuthError(new Error('That username is already taken.'))).toBe('That username is already taken.');
    expect(friendlyAuthError(null)).toBe('Something went wrong. Please try again.');
  });
});

describe('plural', () => {
  it('uses the singular form only for exactly 1', () => {
    expect(plural(1, 'Member', 'Members')).toBe('1 Member');
    expect(plural(0, 'Member', 'Members')).toBe('0 Members');
    expect(plural(2, 'Follower', 'Followers')).toBe('2 Followers');
    expect(plural(1, 'Going', 'Going')).toBe('1 Going');
  });
});

describe('mutual friends', () => {
  const friendships = [
    { from: 'me', to: 'a', status: 'accepted' },
    { from: 'me', to: 'b', status: 'accepted' },
    { from: 'x', to: 'a', status: 'accepted' },
    { from: 'b', to: 'x', status: 'accepted' },
    { from: 'c', to: 'x', status: 'accepted' },
    { from: 'me', to: 'x', status: 'pending' }, // pending never counts
    { from: 'd', to: 'x', status: 'accepted' }
  ];
  it('acceptedFriendIds only counts accepted edges, both directions', () => {
    expect([...acceptedFriendIds(friendships, 'me')].sort()).toEqual(['a', 'b']);
    expect([...acceptedFriendIds(friendships, 'x')].sort()).toEqual(['a', 'b', 'c', 'd']);
  });
  it('mutualFriends intersects accepted sets', () => {
    expect(mutualFriends(friendships, 'me', 'x').sort()).toEqual(['a', 'b']);
    expect(mutualFriendCount(friendships, 'me', 'x')).toBe(2);
    expect(mutualFriendCount(friendships, 'me', 'nobody')).toBe(0);
  });
});

describe('timestamp normalisation (the 1970 post-dates bug)', () => {
  it('tsToMs converts a Firestore Timestamp shape to epoch ms', () => {
    const nowSec = Math.floor(Date.now() / 1000);
    expect(tsToMs({ seconds: nowSec, nanoseconds: 123000000 })).toBe(nowSec * 1000 + 123);
    expect(tsToMs({ toMillis: () => 424242 })).toBe(424242);
    expect(tsToMs(1700000000000)).toBe(1700000000000);
    expect(tsToMs(null)).toBe(0);
  });

  it('timeAgo of a normalised Timestamp renders "just now", not a 1970s date', () => {
    const nowSec = Math.floor(Date.now() / 1000);
    expect(timeAgo(tsToMs({ seconds: nowSec, nanoseconds: 0 }))).toBe('just now');
    expect(timeAgo(tsToMs({ seconds: nowSec - 3600, nanoseconds: 0 }))).toBe('1h');
  });

  it('timeAgo also accepts a raw Timestamp shape directly', () => {
    const nowSec = Math.floor(Date.now() / 1000);
    expect(timeAgo({ seconds: nowSec, nanoseconds: 0 })).toBe('just now');
  });

  it('normaliseTimeFields converts a post-shaped doc\'s time fields to ms', () => {
    const nowSec = Math.floor(Date.now() / 1000);
    const post = {
      id: 'p1', text: 'hello',
      createdAt: { seconds: nowSec, nanoseconds: 500000000 },
      editedAt: null,
      comments: [{ id: 'c1', createdAt: { seconds: nowSec - 60, nanoseconds: 0 }, replies: [{ id: 'r1', createdAt: { seconds: nowSec - 30, nanoseconds: 0 } }] }]
    };
    const out = normaliseTimeFields(post, ['createdAt', 'editedAt']);
    expect(out.createdAt).toBe(nowSec * 1000 + 500);
    expect(out.editedAt).toBe(null); // untouched: field was empty
    expect(out.text).toBe('hello'); // other fields untouched
    // The mapper pattern used for nested comment times:
    const comment = normaliseTimeFields(post.comments[0], ['createdAt']);
    expect(comment.createdAt).toBe((nowSec - 60) * 1000);
    expect(timeAgo(out.createdAt)).toBe('just now');
  });
});

describe('post stats line (no misleading "0 likes")', () => {
  const meUser = { id: 'me', name: 'Me', username: 'me' };
  const author = { id: 'a1', name: 'Asha', username: 'asha' };
  const ctx = { me: meUser, usersById: { me: meUser, a1: author }, d: { groups: [], pages: [] } };
  const basePost = {
    id: 'p1', authorId: 'a1', text: 'hi', image: '', visibility: 'public',
    likes: [], reactions: {}, comments: [], shares: 0, savedBy: [], createdAt: Date.now()
  };

  it('shows the combined total next to the top emojis when reactions exist but likes are 0', () => {
    const html = postCardHtml({ ...basePost, reactions: { u1: '❤️', u2: '❤️', u3: '😮' } }, ctx);
    expect(html).toContain('❤️😮 3');
    expect(html).not.toContain('0 likes');
  });

  it('likes and reactions add into one total', () => {
    const html = postCardHtml({ ...basePost, likes: ['u1', 'u2'], reactions: { u3: '👍' } }, ctx);
    expect(html).toContain('👍 3');
  });

  it('hides the stats row entirely when there is no engagement', () => {
    const html = postCardHtml({ ...basePost }, ctx);
    expect(html).not.toContain('post-stats');
  });

  it('keeps a comments/shares-only row anchored without a reaction total', () => {
    const html = postCardHtml({ ...basePost, comments: [{ id: 'c1', authorId: 'a1', text: 'x', createdAt: Date.now(), replies: [] }], shares: 2 }, ctx);
    expect(html).toContain('post-stats');
    expect(html).toContain('1 comment');
    expect(html).toContain('2 shares');
    expect(html).not.toContain('likes');
  });
});

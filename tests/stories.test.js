import { describe, it, expect } from 'vitest';
import {
  STORY_TTL_MS, STORY_BACKGROUNDS, storyBackgroundCss, tsToMs,
  isStoryActive, activeStories, groupStoriesByAuthor, canViewStory, postAudience
} from '../src/utils.js';
import { LOCALES } from '../src/i18n.js';

// Stories are photo/text only and expire after 24 hours. Their audience is
// denormalized exactly like posts (postAudience): public -> [], friends ->
// the author's accepted friend ids at creation time.

const H = 3600_000;
const NOW = 1_700_000_000_000;
const story = (over = {}) => ({
  id: 'st', authorId: 'author', image: '', text: 'hi', bg: 'sunset',
  visibility: 'public', audienceIds: [], views: [], createdAt: NOW - 1 * H, ...over
});

describe('story expiry (24h window)', () => {
  it('a fresh story is active', () => {
    expect(isStoryActive(story(), NOW)).toBe(true);
    expect(isStoryActive(story({ createdAt: NOW }), NOW)).toBe(true);
  });
  it('a story just inside 24h is still active', () => {
    expect(isStoryActive(story({ createdAt: NOW - STORY_TTL_MS + 1000 }), NOW)).toBe(true);
    expect(isStoryActive(story({ createdAt: NOW - 23 * H }), NOW)).toBe(true);
  });
  it('a story exactly 24h old has expired', () => {
    expect(isStoryActive(story({ createdAt: NOW - STORY_TTL_MS }), NOW)).toBe(false);
  });
  it('older stories are expired', () => {
    expect(isStoryActive(story({ createdAt: NOW - 25 * H }), NOW)).toBe(false);
    expect(isStoryActive(story({ createdAt: NOW - 7 * 24 * H }), NOW)).toBe(false);
  });
  it('missing/invalid stories are never active', () => {
    expect(isStoryActive(null, NOW)).toBe(false);
    expect(isStoryActive(story({ createdAt: 0 }), NOW)).toBe(false);
    expect(isStoryActive(story({ createdAt: undefined }), NOW)).toBe(false);
  });
  it('activeStories filters the expired ones out', () => {
    const list = [story({ id: 'a' }), story({ id: 'b', createdAt: NOW - 30 * H }), story({ id: 'c', createdAt: NOW - 2 * H })];
    expect(activeStories(list, NOW).map((s) => s.id)).toEqual(['a', 'c']);
    expect(activeStories([], NOW)).toEqual([]);
    expect(activeStories(undefined, NOW)).toEqual([]);
  });
  it('Firestore Timestamp-shaped createdAt values are honoured', () => {
    const ts = { toMillis: () => NOW - 2 * H };
    expect(isStoryActive(story({ createdAt: ts }), NOW)).toBe(true);
    const old = { seconds: Math.floor((NOW - 30 * H) / 1000), nanoseconds: 0 };
    expect(isStoryActive(story({ createdAt: old }), NOW)).toBe(false);
  });
});

describe('tsToMs', () => {
  it('passes numbers through and zeroes junk', () => {
    expect(tsToMs(123)).toBe(123);
    expect(tsToMs(null)).toBe(0);
    expect(tsToMs(undefined)).toBe(0);
    expect(tsToMs('nope')).toBe(0);
  });
  it('converts Dates and Timestamp-likes', () => {
    expect(tsToMs(new Date(5000))).toBe(5000);
    expect(tsToMs({ toMillis: () => 7000 })).toBe(7000);
    expect(tsToMs({ seconds: 3, nanoseconds: 500_000_000 })).toBe(3500);
  });
});

describe('groupStoriesByAuthor', () => {
  it('groups by author, oldest-first inside a group, newest group first', () => {
    const list = [
      story({ id: 'a1', authorId: 'ann', createdAt: NOW - 5 * H }),
      story({ id: 'b1', authorId: 'bob', createdAt: NOW - 1 * H }),
      story({ id: 'a2', authorId: 'ann', createdAt: NOW - 2 * H })
    ];
    const groups = groupStoriesByAuthor(list, NOW);
    expect(groups.map((g) => g.authorId)).toEqual(['bob', 'ann']);
    expect(groups[1].stories.map((s) => s.id)).toEqual(['a1', 'a2']);
    expect(groups[0].latestAt).toBe(NOW - 1 * H);
  });
  it('expired stories never reach a group', () => {
    const list = [story({ id: 'old', authorId: 'ann', createdAt: NOW - 26 * H })];
    expect(groupStoriesByAuthor(list, NOW)).toEqual([]);
  });
});

describe('story audience (postAudience reuse, as createStory computes it)', () => {
  it('public stories carry an empty audience', () => {
    expect(postAudience({ visibility: 'public', authorFriendIds: ['u_a'] }))
      .toEqual({ visibility: 'public', audienceIds: [] });
  });
  it('friends stories snapshot the author\'s accepted friend ids', () => {
    expect(postAudience({ visibility: 'friends', authorFriendIds: ['u_a', 'u_b', 'u_a'] }))
      .toEqual({ visibility: 'friends', audienceIds: ['u_a', 'u_b'] });
  });
});

describe('canViewStory', () => {
  const friendsStory = story({ visibility: 'friends', audienceIds: ['u_in'] });
  it('the author always sees their own story', () => {
    expect(canViewStory(friendsStory, { viewerId: 'author', friendIds: [], blockedIds: [] })).toBe(true);
  });
  it('public stories are visible to everyone not blocking the author', () => {
    expect(canViewStory(story(), { viewerId: 'anyone', friendIds: [], blockedIds: [] })).toBe(true);
    expect(canViewStory(story(), { viewerId: 'anyone', friendIds: [], blockedIds: ['author'] })).toBe(false);
  });
  it('friends stories need audience membership or a live friendship', () => {
    expect(canViewStory(friendsStory, { viewerId: 'u_in', friendIds: [], blockedIds: [] })).toBe(true);
    expect(canViewStory(friendsStory, { viewerId: 'u_out', friendIds: ['author'], blockedIds: [] })).toBe(true);
    expect(canViewStory(friendsStory, { viewerId: 'u_out', friendIds: [], blockedIds: [] })).toBe(false);
  });
});

describe('story backgrounds', () => {
  it('has unique keys with css, and falls back to the first preset', () => {
    const keys = STORY_BACKGROUNDS.map((b) => b.key);
    expect(new Set(keys).size).toBe(keys.length);
    for (const b of STORY_BACKGROUNDS) expect(b.css).toContain('gradient');
    expect(storyBackgroundCss('ocean')).toBe(STORY_BACKGROUNDS.find((b) => b.key === 'ocean').css);
    expect(storyBackgroundCss('nope')).toBe(STORY_BACKGROUNDS[0].css);
    expect(storyBackgroundCss()).toBe(STORY_BACKGROUNDS[0].css);
  });
});

describe('story i18n keys exist in both locales', () => {
  it('en and bn both define every story/intro/settings key', () => {
    const keys = ['stories', 'createStory', 'yourStory', 'storyText', 'storyTextPlaceholder', 'storyBackground',
      'noStories', 'seenBy', 'viewers', 'noViewersYet', 'deleteStory', 'searchConversations',
      'defaultPostPrivacy', 'intro', 'worksAt', 'studiedAt', 'livesIn', 'fromPlace', 'nickname',
      'work', 'education', 'currentCity', 'hometown', 'relationship', 'website', 'aboutThisGroup', 'createdOn'];
    for (const key of keys) {
      expect(LOCALES.en[key], `en:${key}`).toBeTruthy();
      expect(LOCALES.bn[key], `bn:${key}`).toBeTruthy();
    }
  });
});

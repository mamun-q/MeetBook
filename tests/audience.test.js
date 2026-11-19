import { describe, it, expect } from 'vitest';
import { postAudience, canViewPost, canViewGroupPost, normaliseGroup } from '../src/utils.js';

// The audience denormalization that makes Firestore list queries provable:
// posts store { visibility, audienceIds } computed at creation time, and
// the read rule + live listeners key off those stored fields only.

describe('postAudience', () => {
  it('public and only-me posts carry an empty audience', () => {
    expect(postAudience({ visibility: 'public' })).toEqual({ visibility: 'public', audienceIds: [] });
    expect(postAudience({ visibility: 'only-me' })).toEqual({ visibility: 'only-me', audienceIds: [] });
    expect(postAudience({})).toEqual({ visibility: 'public', audienceIds: [] });
    expect(postAudience()).toEqual({ visibility: 'public', audienceIds: [] });
  });
  it('friends posts snapshot the author\'s current friend ids (deduped)', () => {
    expect(postAudience({ visibility: 'friends', authorFriendIds: ['u_a', 'u_b'] }))
      .toEqual({ visibility: 'friends', audienceIds: ['u_a', 'u_b'] });
    expect(postAudience({ visibility: 'friends', authorFriendIds: ['u_a', 'u_a', ''] }).audienceIds)
      .toEqual(['u_a']);
    expect(postAudience({ visibility: 'friends' }).audienceIds).toEqual([]);
  });
  it('page posts (public, no group) stay public with an empty audience', () => {
    expect(postAudience({ visibility: 'public', group: null })).toEqual({ visibility: 'public', audienceIds: [] });
  });
  it('public group posts are stored as plain public posts', () => {
    const group = normaliseGroup({ name: 'Pub', members: ['u_m'] }, 'u_creator');
    expect(postAudience({ visibility: 'friends', group })).toEqual({ visibility: 'public', audienceIds: [] });
  });
  it('private group posts fold the group privacy into visibility + members audience', () => {
    const group = normaliseGroup({ name: 'Priv', privacy: 'private', members: ['u_m', 'u_m'] }, 'u_creator');
    const out = postAudience({ visibility: 'public', group });
    expect(out.visibility).toBe('private');
    expect(out.audienceIds).toEqual(['u_creator', 'u_m']); // creator seated first, deduped
  });
});

describe('canViewPost with denormalized audienceIds', () => {
  const friendsPost = { id: 'p', authorId: 'author', visibility: 'friends', audienceIds: ['u_in'] };
  it('a viewer in audienceIds can view even without a live friendship entry', () => {
    expect(canViewPost(friendsPost, { viewerId: 'u_in', friendIds: [], blockedIds: [] })).toBe(true);
  });
  it('the friendIds fallback still applies (demo / pre-audienceIds posts)', () => {
    expect(canViewPost(friendsPost, { viewerId: 'u_out', friendIds: ['author'], blockedIds: [] })).toBe(true);
    const legacy = { id: 'p', authorId: 'author', visibility: 'friends' }; // no audienceIds at all
    expect(canViewPost(legacy, { viewerId: 'u_out', friendIds: new Set(['author']), blockedIds: [] })).toBe(true);
  });
  it('a viewer in neither audience nor friends cannot view', () => {
    expect(canViewPost(friendsPost, { viewerId: 'u_out', friendIds: [], blockedIds: [] })).toBe(false);
    expect(canViewPost({ ...friendsPost, audienceIds: [] }, { viewerId: 'u_out', friendIds: [], blockedIds: [] })).toBe(false);
  });
  it('blocked authors stay hidden even for audience members', () => {
    expect(canViewPost(friendsPost, { viewerId: 'u_in', friendIds: [], blockedIds: ['author'] })).toBe(false);
  });
});

describe('canViewGroupPost with denormalized audienceIds', () => {
  const priv = normaliseGroup({ name: 'Priv', privacy: 'private', members: ['u_member'] }, 'u_creator');
  // Private-group posts are stored with visibility 'private' and the
  // creation-time members as audienceIds.
  const privPost = { id: 'p', authorId: 'u_member', groupId: 'g_priv', visibility: 'private', audienceIds: ['u_creator', 'u_member', 'u_former'] };
  it('current members can view (member check unchanged)', () => {
    expect(canViewGroupPost(privPost, priv, 'u_member')).toBe(true);
    expect(canViewGroupPost(privPost, priv, 'u_creator')).toBe(true);
  });
  it('a viewer in audienceIds can view even if no longer a group member', () => {
    expect(canViewGroupPost(privPost, priv, 'u_former')).toBe(true);
  });
  it('a viewer in neither members nor audience cannot view', () => {
    expect(canViewGroupPost(privPost, priv, 'u_stranger')).toBe(false);
    expect(canViewGroupPost({ ...privPost, audienceIds: [] }, priv, 'u_stranger')).toBe(false);
  });
});

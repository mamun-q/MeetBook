import { describe, it, expect } from 'vitest';
import {
  normaliseGroup, normalisePage, isGroupMember, canViewGroup,
  canViewGroupPost, canViewPost, searchByName
} from '../src/utils.js';
import { LOCALES } from '../src/i18n.js';

describe('normaliseGroup', () => {
  it('defaults to public, trims fields and always seats the creator as a member', () => {
    const g = normaliseGroup({ name: '  Dhaka Photography Club  ', description: ' Shots of the city. ' }, 'u_ayesha', 1234);
    expect(g.name).toBe('Dhaka Photography Club');
    expect(g.description).toBe('Shots of the city.');
    expect(g.privacy).toBe('public');
    expect(g.createdBy).toBe('u_ayesha');
    expect(g.members).toEqual(['u_ayesha']);
    expect(g.createdAt).toBe(1234);
    expect(g.cover).toBe('');
  });
  it('keeps private privacy and dedupes members (creator listed once)', () => {
    const g = normaliseGroup({ name: 'Kitchen Circle', privacy: 'private', members: ['u_priya', 'u_ayesha', 'u_ayesha'] }, 'u_priya');
    expect(g.privacy).toBe('private');
    expect(g.members).toEqual(['u_priya', 'u_ayesha']);
  });
  it('treats any non-private value as public and caps long names', () => {
    expect(normaliseGroup({ name: 'x', privacy: 'secret' }, 'u1').privacy).toBe('public');
    expect(normaliseGroup({ name: 'n'.repeat(120) }, 'u1').name).toHaveLength(80);
  });
});

describe('normalisePage', () => {
  it('defaults the category and dedupes followers', () => {
    const p = normalisePage({ name: ' Dhaka Eats ', about: ' Food finds. ', followers: ['u1', 'u1', 'u2'] }, 'u_priya', 99);
    expect(p.name).toBe('Dhaka Eats');
    expect(p.category).toBe('Community');
    expect(p.about).toBe('Food finds.');
    expect(p.ownerId).toBe('u_priya');
    expect(p.followers).toEqual(['u1', 'u2']);
    expect(p.createdAt).toBe(99);
  });
  it('keeps an explicit category', () => {
    expect(normalisePage({ name: 'Tech Tonic', category: 'Technology' }, 'u_tanvir').category).toBe('Technology');
  });
});

describe('group membership & discoverability', () => {
  const pub = normaliseGroup({ name: 'Pub', members: ['u_member'] }, 'u_creator');
  const priv = normaliseGroup({ name: 'Priv', privacy: 'private', members: ['u_member'] }, 'u_creator');
  it('isGroupMember covers creator, members and strangers', () => {
    expect(isGroupMember(pub, 'u_creator')).toBe(true);
    expect(isGroupMember(pub, 'u_member')).toBe(true);
    expect(isGroupMember(pub, 'u_stranger')).toBe(false);
    expect(isGroupMember(null, 'u_member')).toBe(false);
    expect(isGroupMember(pub, '')).toBe(false);
  });
  it('canViewGroup: public for everyone, private for members only', () => {
    expect(canViewGroup(pub, 'u_stranger')).toBe(true);
    expect(canViewGroup(priv, 'u_stranger')).toBe(false);
    expect(canViewGroup(priv, 'u_member')).toBe(true);
    expect(canViewGroup(priv, 'u_creator')).toBe(true);
    expect(canViewGroup(priv, '')).toBe(false);
  });
});

describe('canViewGroupPost (group privacy governs, not post visibility)', () => {
  const pub = normaliseGroup({ name: 'Pub', members: ['u_member'] }, 'u_creator');
  const priv = normaliseGroup({ name: 'Priv', privacy: 'private', members: ['u_member'] }, 'u_creator');
  // Group posts carry visibility 'public' in the document — the group decides.
  const postIn = (groupId, authorId = 'u_member') => ({ id: 'p', authorId, groupId, visibility: 'public' });
  it('public group posts are readable by any signed-in viewer', () => {
    expect(canViewGroupPost(postIn('g_pub'), pub, 'u_stranger')).toBe(true);
    expect(canViewGroupPost(postIn('g_pub'), pub, 'u_member')).toBe(true);
  });
  it('private group posts are readable only by members and the creator', () => {
    expect(canViewGroupPost(postIn('g_priv'), priv, 'u_stranger')).toBe(false);
    expect(canViewGroupPost(postIn('g_priv'), priv, 'u_member')).toBe(true);
    expect(canViewGroupPost(postIn('g_priv', 'u_stranger'), priv, 'u_stranger')).toBe(true); // own post
    expect(canViewGroupPost(postIn('g_priv'), priv, 'u_creator')).toBe(true);
  });
  it('hides posts by blocked authors and posts whose group is gone', () => {
    expect(canViewGroupPost(postIn('g_pub'), pub, 'u_stranger', new Set(['u_member']))).toBe(false);
    expect(canViewGroupPost(postIn('g_gone'), null, 'u_stranger')).toBe(false);
    expect(canViewGroupPost(postIn('g_gone'), undefined, 'u_member')).toBe(true); // author fallback
    expect(canViewGroupPost(null, pub, 'u_member')).toBe(false);
  });
});

describe('page posts use the ordinary post visibility rules', () => {
  const pagePost = { id: 'pp', authorId: 'u_priya', pageId: 'pg_eats', pageName: 'Dhaka Eats', visibility: 'public' };
  it('any signed-in viewer can see a public page post (home feed inclusion)', () => {
    expect(canViewPost(pagePost, { viewerId: 'u_stranger', friendIds: [], blockedIds: [] })).toBe(true);
    expect(canViewPost(pagePost, { viewerId: 'u_follower', friendIds: [], blockedIds: [] })).toBe(true);
  });
  it('page posts by blocked owners stay hidden', () => {
    expect(canViewPost(pagePost, { viewerId: 'u_stranger', friendIds: [], blockedIds: ['u_priya'] })).toBe(false);
  });
});

describe('searchByName (groups/pages discover)', () => {
  const items = [{ name: 'Dhaka Photography Club' }, { name: 'Tech Tonic' }, { name: 'Dhaka Eats' }];
  it('matches case-insensitively on substrings', () => {
    expect(searchByName(items, 'dhaka').map((x) => x.name)).toEqual(['Dhaka Photography Club', 'Dhaka Eats']);
    expect(searchByName(items, 'TONIC')).toHaveLength(1);
    expect(searchByName(items, 'zzz')).toEqual([]);
  });
  it('an empty query returns a copy of everything', () => {
    const all = searchByName(items, '  ');
    expect(all).toHaveLength(3);
    expect(all).not.toBe(items);
    expect(searchByName(null, 'x')).toEqual([]);
  });
});

describe('i18n groups/pages strings', () => {
  it('has groups and pages keys in both locales', () => {
    for (const key of ['groups', 'pages', 'createGroup', 'createPage', 'joinGroup', 'leaveGroup', 'members', 'followers', 'noGroups', 'noPages']) {
      expect(LOCALES.en[key]).toBeTruthy();
      expect(LOCALES.bn[key]).toBeTruthy();
    }
  });
});

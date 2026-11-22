// Group-post visibility follows CURRENT membership — LIVE mode
// against the fake Supabase. Regression for the bug proven by the
// 2026-11-22 browser E2E: a private group's existing posts were
// invisible to a member who joined later, because the post's
// audienceIds snapshot the member list at creation time and every
// read path (RLS posts_select, the client's post slices) keyed off
// that snapshot. The reverse direction leaked the same way: a
// removed member kept "seeing" the group's older posts through the
// stale snapshot (the view gate's audience fallback).
//
// Contract pinned here:
//  - a member added AFTER a group post was created sees the post
//    (mirror + group page), via the read-time membership slice;
//  - a member REMOVED after the post was created no longer sees it
//    on the group page, even though the fake (no RLS) still delivers
//    the row to their mirror via the audience slice — the view gate
//    is what must refuse it;
//  - a non-member never sees it.
import { describe, it, expect, vi, beforeAll } from 'vitest';

vi.mock('../src/supabase.js', async () => {
  const fake = await import('./fake-supabase.js');
  return {
    supabaseReady: true, isSupabaseConfigured: true,
    supabaseConfig: { url: 'https://fake.supabase.co', publishableKey: 'fake', projectRef: 'fake' },
    supabase: fake.fakeClient
  };
});

const mem = new Map();
globalThis.localStorage = {
  getItem: (k) => (mem.has(k) ? mem.get(k) : null),
  setItem: (k, v) => mem.set(k, String(v)),
  removeItem: (k) => mem.delete(k)
};
globalThis.document = { dispatchEvent: () => true };

let api;
let fake;
let V;
const settle = async () => { await new Promise((r) => setTimeout(r, 15)); await new Promise((r) => setTimeout(r, 15)); };
const settleDeep = async () => { await settle(); await settle(); await settle(); };
const mirrorPost = (id) => api.data().posts.find((p) => p.id === id);
const groupPageHtml = (id) => V.groupView(api.data(), api.me(), id);

const userRow = (name, username, email) => ({
  name, username, email, role: 'user', isBot: false, bio: '', avatar: '', cover: '',
  followers: [], following: [], closeFriends: [], settings: {}
});

beforeAll(async () => {
  fake = (await import('./fake-supabase.js')).fakeControl;
  fake.reset();
  fake.usersByEmail = { 'creator@example.com': 'human1', 'joiner@example.com': 'human2', 'member@example.com': 'human3' };
  fake.seed('users', 'human1', userRow('Group Creator', 'creator', 'creator@example.com'));
  fake.seed('users', 'human2', userRow('Late Joiner', 'joiner', 'joiner@example.com'));
  fake.seed('users', 'human3', userRow('Founding Member', 'member', 'member@example.com'));

  // Private group: creator + founding member. The joiner is NOT in.
  fake.seed('groups', 'gpriv', {
    name: 'Private Circle', description: '', privacy: 'private', cover: '',
    createdBy: 'human1', members: ['human1', 'human3'], createdAt: Date.now() - 120_000
  });
  // The post, stored exactly as createPost/postAudience stores a
  // private-group post: visibility 'private', audienceIds = the
  // members AT CREATION TIME (creator + founding member — the later
  // joiner is absent, the soon-to-be-removed member is present).
  fake.seed('posts', 'p_old', {
    authorId: 'human1', text: 'SECRET GROUP POST', image: '', visibility: 'private',
    audienceIds: ['human1', 'human3'],
    createdAt: Date.now() - 60_000, editedAt: 0, likes: [], reactions: {},
    comments: [], shares: 0, sharedFrom: '', savedBy: [], groupId: 'gpriv', pageId: '',
    pageName: '', pageAvatar: '', poll: null, location: '', feeling: '', pinned: false
  });

  fake.seed('botSettings', 'global', { enabled: true });
  fake.seed('config', 'app', { maintenanceMode: false });

  api = await import('../src/api.js');
  V = await import('../src/views.js');
  api.onAuthReady(() => {});
});

describe('group posts follow current membership (live mode)', () => {
  it('a non-member does not receive the private group post', async () => {
    await api.login('joiner@example.com', 'password123');
    await settleDeep();
    expect(api.me().id).toBe('human2');
    expect(mirrorPost('p_old')).toBeUndefined();
    expect(groupPageHtml('gpriv')).not.toContain('SECRET GROUP POST');
  });

  it('the joiner requests and the creator approves', async () => {
    expect(await api.toggleGroupMembership('gpriv')).toBe('requested');
    await api.logout();
    await api.login('creator@example.com', 'password123');
    await settleDeep();
    // The creator sees the post (author) and the pending request.
    expect(mirrorPost('p_old')).toBeTruthy();
    const req = api.data().groupRequests.find((r) => r.id === 'gpriv_human2');
    expect(req).toBeTruthy();
    expect(req.status).toBe('pending');
    expect(await api.respondGroupRequest('gpriv_human2', true)).toBe('approved');
    expect(fake.get('groups', 'gpriv').members).toEqual(expect.arrayContaining(['human1', 'human3', 'human2']));
    await api.logout();
  });

  it('a member who joined AFTER the post was created can see it', async () => {
    await api.login('joiner@example.com', 'password123');
    await settleDeep();
    expect(api.me().id).toBe('human2');
    // Delivered by the read-time membership slice, not the snapshot
    // (human2 is NOT in the post's stored audienceIds).
    expect(fake.get('posts', 'p_old').audienceIds).not.toContain('human2');
    expect(mirrorPost('p_old')).toBeTruthy();
    expect(groupPageHtml('gpriv')).toContain('SECRET GROUP POST');
    await api.logout();
  });

  it('a founding member sees the post — until the creator removes them', async () => {
    await api.login('member@example.com', 'password123');
    await settleDeep();
    expect(api.me().id).toBe('human3');
    expect(groupPageHtml('gpriv')).toContain('SECRET GROUP POST');
    await api.logout();

    await api.login('creator@example.com', 'password123');
    await settleDeep();
    expect(await api.removeGroupMember('gpriv', 'human3')).toBe(true);
    expect(fake.get('groups', 'gpriv').members).not.toContain('human3');
    await api.logout();
  });

  it('a removed member no longer sees the group\'s older posts', async () => {
    await api.login('member@example.com', 'password123');
    await settleDeep();
    expect(api.me().id).toBe('human3');
    // human3 IS in the post's stored audienceIds (creation-time
    // snapshot) — that must no longer grant access anywhere the post
    // is rendered.
    expect(fake.get('posts', 'p_old').audienceIds).toContain('human3');
    const page = groupPageHtml('gpriv');
    expect(page).not.toContain('SECRET GROUP POST');
    const search = V.searchView(api.data(), api.me(), 'SECRET GROUP');
    expect(search).not.toContain('SECRET GROUP POST');
    await api.logout();
  });
});

describe('group page while the first groups sync is still landing', () => {
  it('shows a loading state instead of "could not be found" when told sync is pending', () => {
    const d = { groups: [], posts: [], groupRequests: [], users: [], friendships: [], blocks: [] };
    const meUser = { id: 'human2', name: 'Late Joiner', settings: {} };
    const loading = V.groupView(d, meUser, 'gunknown', { loading: true });
    expect(loading).toContain('Loading');
    expect(loading).not.toContain('could not be found');
    const settled = V.groupView(d, meUser, 'gunknown');
    expect(settled).toContain('could not be found');
  });

  it('reports groups sync as settled once boot has landed', async () => {
    await api.login('joiner@example.com', 'password123');
    await settleDeep();
    expect(api.groupsSyncPending()).toBe(false);
    await api.logout();
  });
});

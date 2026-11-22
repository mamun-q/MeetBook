// Private-group discovery (group_discovery RPC) — LIVE mode against
// the fake Supabase. Pins the Facebook-style contract:
//  - a private group the user does NOT belong to still lands in the
//    mirror after boot sync, as a metadata-only row (metaOnly,
//    server memberCount, members []) — discoverable, requestable;
//  - a group the user DOES belong to keeps its FULL row (discovery
//    must never downgrade it);
//  - the join-request path works end to end against a metadata-only
//    group (request row addressed to the creator, withdraw removes);
//  - the views show the private group with its member count and a
//    members-only notice, and never leak its posts to a non-member.
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
const settleDeep = async () => { await settle(); await settle(); };
const mirrorGroup = (id) => api.data().groups.find((g) => g.id === id);

const userRow = (name, username, email) => ({
  name, username, email, role: 'user', isBot: false, bio: '', avatar: '', cover: '',
  followers: [], following: [], closeFriends: [], settings: {}
});
const groupRow = (name, privacy, createdBy, members, extra = {}) => ({
  name, description: '', privacy, cover: '', createdBy, members,
  createdAt: Date.now() - 60_000, ...extra
});

beforeAll(async () => {
  fake = (await import('./fake-supabase.js')).fakeControl;
  fake.reset();
  fake.usersByEmail = { 'me@example.com': 'human1', 'friend@example.com': 'human2', 'third@example.com': 'human3' };
  fake.seed('users', 'human1', userRow('Mamun Hossen', 'your.name', 'me@example.com'));
  fake.seed('users', 'human2', userRow('Ayesha Khan', 'ayesha', 'friend@example.com'));
  fake.seed('users', 'human3', userRow('Tanvir Ahmed', 'tanvir', 'third@example.com'));

  // A private group human1 does NOT belong to (2 members).
  fake.seed('groups', 'gsecret', groupRow('Secret Study Circle', 'private', 'human2', ['human2', 'human3'], {
    description: 'Members only club', cover: 'cover-secret'
  }));
  // A private group human1 DOES belong to.
  fake.seed('groups', 'gown', groupRow('Family Private', 'private', 'human2', ['human2', 'human1']));
  // A public group human1 does not belong to.
  fake.seed('groups', 'gpub', groupRow('Open Public', 'public', 'human2', ['human2', 'human3']));

  // A post inside the secret group — must never reach a non-member's
  // group page even though the fake delivers every post row.
  fake.seed('posts', 'post_secret', {
    authorId: 'human2', text: 'SECRET POST TEXT', image: '', visibility: 'public', audienceIds: [],
    createdAt: Date.now() - 30_000, editedAt: 0, likes: [], reactions: {},
    comments: [], shares: 0, sharedFrom: '', savedBy: [], groupId: 'gsecret', pageId: '',
    pageName: '', pageAvatar: '', poll: null, location: '', feeling: '', pinned: false
  });

  fake.seed('botSettings', 'global', { enabled: true });
  fake.seed('config', 'app', { maintenanceMode: false });

  api = await import('../src/api.js');
  V = await import('../src/views.js');
  api.onAuthReady(() => {});
  await api.login('me@example.com', 'password123');
  await settleDeep();
});

describe('group discovery (live mode)', () => {
  it('mirrors a non-member private group as metadata-only with its member count', () => {
    const g = mirrorGroup('gsecret');
    expect(g).toBeTruthy();
    expect(g.metaOnly).toBe(true);
    expect(g.name).toBe('Secret Study Circle');
    expect(g.description).toBe('Members only club');
    expect(g.cover).toBe('cover-secret');
    expect(g.privacy).toBe('private');
    expect(g.createdBy).toBe('human2');
    expect(g.memberCount).toBe(2);
    // The member LIST must not ride along — empty by design.
    expect(g.members).toEqual([]);
  });

  it('never downgrades a group the user belongs to — the full row wins', () => {
    const own = mirrorGroup('gown');
    expect(own).toBeTruthy();
    expect(own.metaOnly).toBeFalsy();
    expect(own.members).toEqual(expect.arrayContaining(['human2', 'human1']));
    const pub = mirrorGroup('gpub');
    expect(pub.metaOnly).toBeFalsy();
    expect(pub.members).toEqual(expect.arrayContaining(['human2', 'human3']));
  });

  it('lets a non-member request to join a metadata-only private group, then withdraw', async () => {
    expect(await api.toggleGroupMembership('gsecret')).toBe('requested');
    const row = fake.get('groupRequests', 'gsecret_human1');
    expect(row).toBeTruthy();
    expect(row.userId).toBe('human1');
    expect(row.groupId).toBe('gsecret');
    expect(row.status).toBe('pending');
    // The request is addressed to the creator via BOTH spellings the
    // schema/RLS key off — resolved from the discovery row's
    // createdBy, since the full group row is not readable here.
    expect(row.groupOwnerId).toBe('human2');
    expect(row.groupAdminId).toBe('human2');
    // The creator was notified.
    expect(fake.all('notifications').some((n) => n.userId === 'human2' && n.type === 'group_request')).toBe(true);
    // Toggling again withdraws it.
    expect(await api.toggleGroupMembership('gsecret')).toBe('withdrawn');
    expect(fake.get('groupRequests', 'gsecret_human1')).toBeUndefined();
  });

  it('renders the private group in Discover + its page with count and notice, leaking no posts', () => {
    const d = api.data();
    const meUser = api.me();
    const list = V.groupsView(d, meUser);
    expect(list).toContain('Secret Study Circle');
    expect(list).toContain('2 Members');
    const page = V.groupView(d, meUser, 'gsecret');
    expect(page).toContain('Secret Study Circle');
    expect(page).toContain('2 Members');
    expect(page).toContain('visible to members only');
    expect(page).toContain('Request to join');
    expect(page).not.toContain('SECRET POST TEXT');
    const search = V.searchView(d, meUser, 'Secret Study');
    expect(search).toContain('Secret Study Circle');
    expect(search).toContain('Private');
    expect(search).not.toContain('SECRET POST TEXT');
  });
});

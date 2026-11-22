// Friend-request mirror immediacy (2026-11-22, Limon's report:
// "request দিয়ে reload না দিলে দেখাচ্ছে না গেছে কিনা") — LIVE mode
// against the fake Supabase. Pins that sendFriendRequest,
// respondFriendRequest (accept + decline) and cancelFriendRequest
// patch the local friendships mirror as soon as their write lands,
// so profile buttons and the Friends page update WITHOUT a reload
// instead of waiting for the realtime refetch.
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
const settle = async () => { await new Promise((r) => setTimeout(r, 15)); await new Promise((r) => setTimeout(r, 15)); };
const rel = (a, b) => api.data().friendships.find((f) => (f.from === a && f.to === b) || (f.from === b && f.to === a));
const notesFor = (userId, type) => fake.all('notifications').filter((n) => n.userId === userId && (!type || n.type === type));

const seedUser = (id, name, username, email) => fake.seed('users', id, {
  name, username, email, role: 'user', isBot: false, bio: '',
  followers: [], following: [], closeFriends: [], settings: {}
});

beforeAll(async () => {
  fake = (await import('./fake-supabase.js')).fakeControl;
  fake.reset();
  fake.usersByEmail = { 'me@example.com': 'human1', 'friend@example.com': 'human2', 'third@example.com': 'human3' };
  seedUser('human1', 'Mamun Hossen', 'your.name', 'me@example.com');
  seedUser('human2', 'Ayesha Khan', 'ayesha', 'friend@example.com');
  seedUser('human3', 'Tanvir Ahmed', 'tanvir', 'third@example.com');
  api = await import('../src/api.js');
  api.onAuthReady(() => {});
  await api.login('me@example.com', 'password123');
  await settle();
});

describe('friend request mirror immediacy (live mode)', () => {
  it('sendFriendRequest shows the pending request in the mirror at once', async () => {
    expect(rel('human1', 'human2')).toBeFalsy();
    await api.sendFriendRequest('human2');
    // No settle(): the mirror must already carry the row, or the
    // profile button stays on "Add Friend" until a reload.
    const f = rel('human1', 'human2');
    expect(f).toBeTruthy();
    expect(f.status).toBe('pending');
    expect(f.from).toBe('human1');
    expect(notesFor('human2', 'friend_request')).toHaveLength(1);
  });

  it('cancelFriendRequest removes the request from the mirror at once', async () => {
    const f = rel('human1', 'human2');
    await api.cancelFriendRequest(f.id);
    expect(rel('human1', 'human2')).toBeFalsy();
    expect(fake.all('friendships')).toHaveLength(0);
  });

  it('respondFriendRequest accept flips the mirror to accepted at once and notifies the sender', async () => {
    await api.sendFriendRequest('human2');
    await api.logout();
    await settle();
    await api.login('friend@example.com', 'password123');
    await settle();
    const f = rel('human1', 'human2');
    expect(f?.status).toBe('pending');
    await api.respondFriendRequest(f.id, true);
    expect(rel('human1', 'human2')?.status).toBe('accepted');
    expect(notesFor('human1', 'friend_accept')).toHaveLength(1);
  });

  it('respondFriendRequest decline removes the request from the mirror at once', async () => {
    await api.logout();
    await settle();
    await api.login('third@example.com', 'password123');
    await settle();
    await api.sendFriendRequest('human1');
    await api.logout();
    await settle();
    await api.login('me@example.com', 'password123');
    await settle();
    const f = rel('human3', 'human1');
    expect(f?.status).toBe('pending');
    await api.respondFriendRequest(f.id, false);
    expect(rel('human3', 'human1')).toBeFalsy();
  });
});

// Full Audit #3 (2026-11-21) — LIVE-mode regression: accepting a
// friend request never notified the sender (only the demo branch
// sent friend_accept). The recipient accepts; the sender must get a
// friend_accept notification document.
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

const HUMAN1 = { name: 'Hasan Human', username: 'hasan', email: 'hasan@example.com', role: 'user', isBot: false, followers: [], following: [], closeFriends: [], settings: {} };
const HUMAN2 = { name: 'Ayesha Khan', username: 'ayesha', email: 'ayesha@example.com', role: 'user', isBot: false, followers: [], following: [], closeFriends: [], settings: {} };

beforeAll(async () => {
  fake = (await import('./fake-supabase.js')).fakeControl;
  fake.reset();
  fake.usersByEmail = { 'hasan@example.com': 'human1', 'ayesha@example.com': 'human2' };
  fake.seed('users', 'human1', HUMAN1);
  fake.seed('users', 'human2', HUMAN2);
  // human2 -> human1 request, deterministic id like sendFriendRequest writes.
  fake.seed('friendships', 'human2_human1', { from: 'human2', to: 'human1', status: 'pending', createdAt: Date.now() - 1000 });
  api = await import('../src/api.js');
  api.onAuthReady(() => {});
  await api.login('hasan@example.com', 'whatever');
  await settle();
});

describe('friend_accept notification (Audit #3)', () => {
  it('accepting a request notifies the sender in live mode', async () => {
    await api.respondFriendRequest('human2_human1', true);
    await settle();
    expect(fake.get('friendships', 'human2_human1').status).toBe('accepted');
    const notes = fake.all('notifications').filter((n) => n.type === 'friend_accept');
    expect(notes.length).toBe(1);
    expect(notes[0].userId).toBe('human2');
    expect(notes[0].actorId).toBe('human1');
  });
});

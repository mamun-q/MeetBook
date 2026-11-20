// Full Audit #2 (2026-11-21) — LIVE-mode regressions on the fake-
// Firestore harness:
//  A1 the messages listener must keep the NEWEST 500 messages
//     (ascending + limit returned the OLDEST 500, so new DMs silently
//     stopped arriving past 500 total messages).
//  A2 toggleFollow performs both writes and notifies the target
//     (the rules now allow the one-field followers delta).
//  A6 respondFriendRequest: the SENDER cannot accept their own
//     request; the recipient can.
//  A4 openConversation creates a 1-1 thread under a deterministic id,
//     so concurrent opens can never mint a duplicate.
//  A17 joinConversationByCode is a no-op success for existing members.
import { describe, it, expect, vi, beforeAll, afterEach } from 'vitest';

vi.mock('../src/firebase.js', () => ({
  firebaseReady: true, isFirebaseConfigured: true, firebaseConfig: {},
  app: {}, auth: { fake: 'auth' }, db: { fake: 'db' }, storage: null, googleProvider: null
}));
vi.mock('firebase/firestore', async () => await import('./fake-firestore.js'));
vi.mock('firebase/auth', async () => (await import('./fake-firestore.js')).fakeAuth);
vi.mock('firebase/storage', () => ({
  ref: () => ({}), uploadBytes: async () => ({}), getDownloadURL: async () => ''
}));

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
  fake = (await import('./fake-firestore.js')).fakeControl;
  fake.reset();
  fake.usersByEmail = { 'hasan@example.com': 'human1', 'ayesha@example.com': 'human2' };
  fake.seed('users', 'human1', HUMAN1);
  fake.seed('users', 'human2', HUMAN2);
  api = await import('../src/api.js');
  api.onAuthReady(() => {});
  await api.login('hasan@example.com', 'whatever');
  await settle();
});

afterEach(() => { vi.unstubAllGlobals(); });

describe('A1 messages listener keeps the newest messages', () => {
  it('past 500 messages, the latest DM is in the mirror and the oldest is not', async () => {
    for (let i = 0; i < 505; i++) {
      fake.seed('messages', `bulk_${i}`, {
        conversationId: 'c_bulk', participants: ['human1', 'human2'], senderId: 'human2',
        text: `bulk ${i}`, image: '', audio: '', createdAt: 1_000_000 + i * 1000, status: 'sent', readBy: ['human2']
      });
    }
    await settle();
    const ids = new Set(api.data().messages.map((m) => m.id));
    expect(ids.has('bulk_504')).toBe(true);  // the newest message arrived
    expect(ids.has('bulk_0')).toBe(false);   // the oldest fell out of the window
  });
});

describe('A2 toggleFollow (non-admin)', () => {
  it('follow writes both sides and notifies; unfollow removes both', async () => {
    await api.toggleFollow('human2');
    await settle();
    expect(fake.get('users', 'human1').following).toContain('human2');
    expect(fake.get('users', 'human2').followers).toContain('human1');
    expect(fake.all('notifications').some((n) => n.userId === 'human2' && n.type === 'follow' && n.actorId === 'human1')).toBe(true);
    await api.toggleFollow('human2');
    await settle();
    expect(fake.get('users', 'human1').following).not.toContain('human2');
    expect(fake.get('users', 'human2').followers).not.toContain('human1');
  });
});

describe('A6 friend request consent', () => {
  it('the sender cannot accept their own request; the recipient can', async () => {
    fake.seed('friendships', 'fr1', { from: 'human1', to: 'human2', status: 'pending', createdAt: Date.now() });
    await settle();
    await expect(api.respondFriendRequest('fr1', true)).rejects.toThrow(/Only the person who received/);
    expect(fake.get('friendships', 'fr1').status).toBe('pending');
    await api.logout();
    await api.login('ayesha@example.com', 'whatever');
    await settle();
    await api.respondFriendRequest('fr1', true);
    expect(fake.get('friendships', 'fr1').status).toBe('accepted');
    await api.logout();
    await api.login('hasan@example.com', 'whatever');
    await settle();
  });
});

describe('A4 openConversation deterministic id', () => {
  it('two opens for the same pair return one shared thread', async () => {
    const a = await api.openConversation('human2');
    const b = await api.openConversation('human2');
    expect(a.id).toBe('dm_human1_human2');
    expect(b.id).toBe(a.id);
    const pairConvs = fake.all('conversations').filter((c) => !c.isGroup
      && (c.participants || []).length === 2
      && c.participants.includes('human1') && c.participants.includes('human2'));
    expect(pairConvs).toHaveLength(1);
  });
});

describe('A17 join by invite code when already a member', () => {
  it('resolves the conversation instead of a permission error', async () => {
    fake.seed('conversations', 'g1', { isGroup: true, title: 'Test Group', participants: ['human1', 'human2'], createdBy: 'human2', joinCode: 'inv_test1', createdAt: Date.now() });
    fake.seed('invites', 'inv_test1', { conversationId: 'g1', createdBy: 'human2', createdAt: Date.now() });
    await settle();
    await expect(api.joinConversationByCode('inv_test1')).resolves.toBe('g1');
  });
});

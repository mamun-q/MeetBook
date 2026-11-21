// Like-shake fix (2026-11-21) — LIVE-mode regressions:
//  L1 engagement patches (toggleLike) update the mirror WITHOUT
//     dispatching 'meetbook:data' — every dispatch is a full-page
//     re-render in main.js, and a like used to trigger three of them
//     (optimistic patch + handler render + Firestore echo), which on
//     a phone reads as the screen shaking.
//  L2 the posts merge suppresses no-change snapshot echoes: when the
//     server copy is identical to the mirror, no data event fires.
import { describe, it, expect, vi, beforeAll } from 'vitest';

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
let dataEvents = 0;
globalThis.document = { dispatchEvent: (e) => { if (e && e.type === 'meetbook:data') dataEvents++; return true; } };

let api;
let fake;
const settle = async () => { await new Promise((r) => setTimeout(r, 15)); await new Promise((r) => setTimeout(r, 15)); };

const HUMAN1 = { name: 'Hasan Human', username: 'hasan', email: 'hasan@example.com', role: 'user', isBot: false, followers: [], following: [], closeFriends: [], settings: {} };
const HUMAN2 = { name: 'Ayesha Khan', username: 'ayesha', email: 'ayesha@example.com', role: 'user', isBot: false, followers: [], following: [], closeFriends: [], settings: {} };
const POST = {
  authorId: 'human2', text: 'hello world', image: '', visibility: 'public',
  audienceIds: ['human1', 'human2'], createdAt: 1700000000000, editedAt: 0,
  likes: [], reactions: {}, comments: [], shares: 0, sharedFrom: '', savedBy: [],
  groupId: '', pageId: '', pageName: '', pageAvatar: '', poll: null, location: '', feeling: '', pinned: false
};

beforeAll(async () => {
  fake = (await import('./fake-firestore.js')).fakeControl;
  fake.reset();
  fake.usersByEmail = { 'hasan@example.com': 'human1', 'ayesha@example.com': 'human2' };
  fake.seed('users', 'human1', HUMAN1);
  fake.seed('users', 'human2', HUMAN2);
  fake.seed('posts', 'post1', POST);
  api = await import('../src/api.js');
  api.onAuthReady(() => {});
  await api.login('hasan@example.com', 'whatever');
  await settle();
});

describe('L1/L2 like does not re-render the page', () => {
  it('the post is mirrored before liking', () => {
    expect(api.data().posts.some((p) => p.id === 'post1')).toBe(true);
  });

  it('toggleLike patches the mirror silently (zero data events, even after the echo settles)', async () => {
    dataEvents = 0;
    const pending = api.toggleLike('post1');
    // The optimistic patch runs synchronously and must not emit.
    expect(dataEvents).toBe(0);
    await pending;
    await settle();
    const post = api.data().posts.find((p) => p.id === 'post1');
    expect(post.likes).toContain('human1');
    expect(fake.get('posts', 'post1').likes).toContain('human1');
    // The Firestore echo of my own like is identical to the mirror —
    // the merge must suppress it instead of re-rendering the page.
    expect(dataEvents).toBe(0);
  });

  it('a no-change re-delivery of the same post fires no data event', async () => {
    await settle();
    dataEvents = 0;
    fake.seed('posts', 'post1', fake.get('posts', 'post1'));
    await settle();
    expect(dataEvents).toBe(0);
  });

  it('unlike is silent too and restores the empty likes list', async () => {
    dataEvents = 0;
    await api.toggleLike('post1');
    await settle();
    const post = api.data().posts.find((p) => p.id === 'post1');
    expect(post.likes).not.toContain('human1');
    expect(dataEvents).toBe(0);
  });

  it('a REAL change from someone else still emits (suppression is not a mute)', async () => {
    await settle();
    dataEvents = 0;
    const raw = fake.get('posts', 'post1');
    fake.seed('posts', 'post1', { ...raw, likes: ['human2'] });
    await settle();
    expect(dataEvents).toBeGreaterThan(0);
    expect(api.data().posts.find((p) => p.id === 'post1').likes).toContain('human2');
  });
});

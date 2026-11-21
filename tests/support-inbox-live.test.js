// Support Inbox (2026-11-21) — LIVE-mode regression: the whole flow
// against the fake Firestore. A report filed by one user must carry
// targetAuthorId; a staff decision must delete the content, write
// both doorbell notifications, surface in the author's supportReports
// mirror (the per-user listeners), accept the author's appeal, and a
// staff appeal decision must preserve the appeal text and notify.
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
globalThis.document = { dispatchEvent: () => true };

let api;
let fake;
const settle = async () => { await new Promise((r) => setTimeout(r, 15)); await new Promise((r) => setTimeout(r, 15)); };

const USER = (name, username) => ({ name, username, email: `${username}@example.com`, role: 'user', isBot: false, followers: [], following: [], closeFriends: [], settings: {} });

beforeAll(async () => {
  fake = (await import('./fake-firestore.js')).fakeControl;
  fake.reset();
  fake.usersByEmail = { 'rita@example.com': 'reporter1', 'adam@example.com': 'author1', 'boss@example.com': 'boss1' };
  fake.seed('users', 'reporter1', USER('Rita Reporter', 'rita'));
  fake.seed('users', 'author1', USER('Adam Author', 'adam'));
  fake.seed('users', 'boss1', { ...USER('Boss Admin', 'boss'), email: 'boss@example.com', role: 'admin' });
  fake.seed('posts', 'post1', {
    authorId: 'author1', text: 'Buy my miracle coins now', image: '', visibility: 'public', audienceIds: [],
    createdAt: Date.now() - 60_000, editedAt: 0, likes: [], reactions: {}, comments: [], shares: 0,
    sharedFrom: '', savedBy: [], groupId: '', pageId: '', pageName: '', pageAvatar: ''
  });
  api = await import('../src/api.js');
  api.onAuthReady(() => {});
});

describe('Support Inbox flow (live)', () => {
  let repId;

  it('a filed report carries targetAuthorId from creation', async () => {
    await api.login('rita@example.com', 'whatever');
    await settle();
    await api.reportContent('post', 'post1', 'Obvious scam', { category: 'spam' });
    await settle();
    const reps = fake.all('reports');
    expect(reps.length).toBe(1);
    repId = reps[0].id;
    expect(reps[0]).toMatchObject({ reporterId: 'reporter1', targetType: 'post', targetId: 'post1', targetAuthorId: 'author1', status: 'pending' });
  });

  it('a staff decision deletes the content and rings both doorbells', async () => {
    await api.login('boss@example.com', 'whatever');
    await settle();
    await api.adminDecideReport(repId, 'resolve', { outcome: 'content-removed', reason: 'Scam confirmed' });
    await settle();
    expect(fake.get('posts', 'post1')).toBeUndefined();
    expect(fake.get('reports', repId)).toMatchObject({ status: 'resolved' });
    expect(fake.get('reports', repId).decision).toMatchObject({ outcome: 'content-removed', reason: 'Scam confirmed' });
    const notes = fake.all('notifications');
    expect(notes.some((n) => n.userId === 'reporter1' && n.type === 'report_decision')).toBe(true);
    expect(notes.some((n) => n.userId === 'author1' && n.type === 'moderation_notice')).toBe(true);
  });

  it('the author sees the report in supportReports and can appeal it', async () => {
    await api.login('adam@example.com', 'whatever');
    await settle();
    const mine = (api.data().supportReports || []).find((r) => r.id === repId);
    expect(mine).toBeTruthy();
    expect(mine.decision?.outcome).toBe('content-removed');
    await api.appealReport(repId, 'Please reconsider — it was satire');
    await settle();
    expect(fake.get('reports', repId).appeal).toMatchObject({ status: 'requested', text: 'Please reconsider — it was satire', byId: 'author1' });
    await expect(api.appealReport(repId, 'Second appeal')).rejects.toThrow();
  });

  it('a staff appeal decision preserves the text and notifies the author', async () => {
    await api.login('boss@example.com', 'whatever');
    await settle();
    await api.adminSetReportAppeal(repId, 'accepted', 'Overturned on review');
    await settle();
    expect(fake.get('reports', repId).appeal).toMatchObject({ status: 'accepted', reason: 'Overturned on review', text: 'Please reconsider — it was satire' });
    const notes = fake.all('notifications').filter((n) => n.type === 'appeal_decision');
    expect(notes.length).toBe(1);
    expect(notes[0].userId).toBe('author1');
  });
});

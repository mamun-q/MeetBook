// Support Inbox (2026-11-21) — LIVE-mode regression: the whole flow
// against the fake Firestore. A report filed by one user must carry
// targetAuthorId; a staff decision must delete the content, write
// both doorbell notifications, surface in the author's supportReports
// mirror (the per-user listeners), accept the author's appeal, and a
// staff appeal decision must preserve the appeal text and notify.
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

const USER = (name, username) => ({ name, username, email: `${username}@example.com`, role: 'user', isBot: false, followers: [], following: [], closeFriends: [], settings: {} });

beforeAll(async () => {
  fake = (await import('./fake-supabase.js')).fakeControl;
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

  // Isolation regression (2026-11-21 fix pack): deciding a SECOND
  // report must never write appeal fields onto it from the first
  // report's decided appeal, nor disturb the first report — and the
  // second report carries its own targetLabel snapshot from creation.
  it('a second report stays appeal-free when the first report\'s appeal is decided', async () => {
    fake.seed('posts', 'post2', {
      authorId: 'author1', text: 'Second post about miracle gems', image: '', visibility: 'public', audienceIds: [],
      createdAt: Date.now() - 30_000, editedAt: 0, likes: [], reactions: {}, comments: [], shares: 0,
      sharedFrom: '', savedBy: [], groupId: '', pageId: '', pageName: '', pageAvatar: ''
    });
    await settle();
    await api.login('rita@example.com', 'whatever');
    await settle();
    await api.reportContent('post', 'post2', 'More scams', { category: 'spam' });
    await settle();
    const rep2 = fake.all('reports').find((r) => r.targetId === 'post2');
    expect(rep2).toBeTruthy();
    expect(rep2.targetLabel).toBe('Second post about miracle gems');
    expect(rep2.appeal).toMatchObject({ status: 'none' });

    await api.login('boss@example.com', 'whatever');
    await settle();
    await api.adminDecideReport(rep2.id, 'resolve', { outcome: 'none', reason: 'Looks fine' });
    await settle();
    expect(fake.get('reports', rep2.id).decision).toMatchObject({ outcome: 'none' });
    expect(fake.get('reports', rep2.id).appeal).toMatchObject({ status: 'none' });
    expect(fake.get('reports', repId).appeal).toMatchObject({ status: 'accepted', text: 'Please reconsider — it was satire' });
  });
});

// ------------------------------------------------------- appeal guard
// Regression (2026-11-21): a staff accept/decline landed on a report
// whose appeal was never filed (a stray tap set 'accepted' on a live
// no-action report). adminSetReportAppeal must no-op — return null,
// write nothing, ring no doorbell — unless the current appeal status
// is 'requested'. Marking 'requested' by hand stays allowed.
describe('Appeal guard (live)', () => {
  let rep3Id;
  const doorbells = () => fake.all('notifications').filter((n) => n.type === 'appeal_decision').length;

  it('setup: a third report with no appeal behind it', async () => {
    fake.seed('posts', 'post3', {
      authorId: 'author1', text: 'A perfectly ordinary third post', image: '', visibility: 'public', audienceIds: [],
      createdAt: Date.now() - 10_000, editedAt: 0, likes: [], reactions: {}, comments: [], shares: 0,
      sharedFrom: '', savedBy: [], groupId: '', pageId: '', pageName: '', pageAvatar: ''
    });
    await api.login('rita@example.com', 'whatever');
    await settle();
    await api.reportContent('post', 'post3', 'Testing the guard', { category: 'other' });
    await settle();
    const rep3 = fake.all('reports').find((r) => r.targetId === 'post3');
    expect(rep3).toBeTruthy();
    rep3Id = rep3.id;
    expect(rep3.appeal).toMatchObject({ status: 'none' });
  });

  it('accept and decline from appeal-none are null no-ops — no write, no doorbell', async () => {
    await api.login('boss@example.com', 'whatever');
    await settle();
    const before = doorbells();
    expect(await api.adminSetReportAppeal(rep3Id, 'accepted', 'Stray tap')).toBeNull();
    await settle();
    expect(fake.get('reports', rep3Id).appeal).toMatchObject({ status: 'none' });
    expect(await api.adminSetReportAppeal(rep3Id, 'declined', 'Stray tap')).toBeNull();
    await settle();
    expect(fake.get('reports', rep3Id).appeal).toMatchObject({ status: 'none' });
    expect(doorbells()).toBe(before);
  });

  it('mark-requested from none still works, and the filed appeal can then be accepted', async () => {
    await api.login('boss@example.com', 'whatever');
    await settle();
    const marked = await api.adminSetReportAppeal(rep3Id, 'requested');
    await settle();
    expect(marked).toMatchObject({ status: 'requested' });
    expect(fake.get('reports', rep3Id).appeal).toMatchObject({ status: 'requested', byId: 'boss1' });
    const before = doorbells();
    const accepted = await api.adminSetReportAppeal(rep3Id, 'accepted', 'Off-app appeal upheld');
    await settle();
    expect(accepted).toMatchObject({ status: 'accepted', reason: 'Off-app appeal upheld' });
    expect(fake.get('reports', rep3Id).appeal).toMatchObject({ status: 'accepted', reason: 'Off-app appeal upheld' });
    // Staff-filed appeal (byId == the deciding admin) rings no doorbell:
    expect(doorbells()).toBe(before);
    // A decided appeal cannot be re-decided either:
    expect(await api.adminSetReportAppeal(rep3Id, 'declined', 'Changed my mind')).toBeNull();
    await settle();
    expect(fake.get('reports', rep3Id).appeal).toMatchObject({ status: 'accepted' });
  });
});

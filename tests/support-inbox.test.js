// Support Inbox (2026-11-21) — the user-side mirror of the Reports
// Center. View tests run against synthetic fixtures; the flow tests
// run the REAL api.js in demo mode (firebase mocked out): report →
// staff decision → reporter's inbox + author's notice + appeal →
// staff appeal decision, with notifications at each step.
import { describe, it, expect, vi, beforeAll } from 'vitest';

vi.mock('../src/firebase.js', () => ({
  firebaseReady: false, isFirebaseConfigured: false, firebaseConfig: {},
  app: null, auth: null, db: null, storage: null, googleProvider: null
}));

const mem = new Map();
globalThis.localStorage = {
  getItem: (k) => (mem.has(k) ? mem.get(k) : null),
  setItem: (k, v) => mem.set(k, String(v)),
  removeItem: (k) => mem.delete(k)
};

let V;
let api;
let store;

beforeAll(async () => {
  V = await import('../src/views.js');
  store = await import('../src/store.js');
  api = await import('../src/api.js');
});

const NOW = Date.now();
const USERS = [
  { id: 'u_rep', name: 'Rita Reporter', username: 'rita', isBot: false },
  { id: 'u_auth', name: 'Adam Author', username: 'adam', isBot: false },
  { id: 'u_other', name: 'Olivia Other', username: 'olivia', isBot: false },
  { id: 'u_none', name: 'Nina Nobody', username: 'nina', isBot: false }
];
const mkData = (reports) => ({
  users: USERS,
  posts: [
    { id: 'p1', authorId: 'u_auth', text: 'A perfectly ordinary post', likes: [], comments: [] },
    { id: 'p2', authorId: 'u_rep', text: 'My own edgy post', likes: [], comments: [] }
  ],
  reports,
  supportReports: []
});
const decided = (outcome, extra = {}) => ({ byId: 'boss', byName: 'Boss', at: NOW - 60_000, reason: 'Checked it', outcome, action: 'resolve', ...extra });

// ------------------------------------------------------------------ views
describe('supportInboxView', () => {
  const reports = [
    { id: 'r1', reporterId: 'u_rep', targetType: 'post', targetId: 'p1', targetAuthorId: 'u_auth', reason: 'Spam links', category: 'spam', status: 'pending', createdAt: NOW - 5000, decision: null, appeal: { status: 'none' } },
    { id: 'r2', reporterId: 'u_rep', targetType: 'user', targetId: 'u_auth', targetAuthorId: 'u_auth', reason: 'Harassing me', category: 'harassment', status: 'resolved', createdAt: NOW - 4000, decision: decided('user-warned'), appeal: { status: 'none' } },
    { id: 'r3', reporterId: 'u_rep', targetType: 'post', targetId: 'p1', targetAuthorId: 'u_auth', reason: 'Looks fine actually', category: 'other', status: 'rejected', createdAt: NOW - 3000, decision: decided('none', { action: 'reject' }), appeal: { status: 'none' } },
    { id: 'r4', reporterId: 'u_other', targetType: 'post', targetId: 'p2', targetAuthorId: 'u_rep', reason: 'Edgy spam', category: 'spam', status: 'resolved', createdAt: NOW - 2000, decision: decided('content-removed', { reason: 'Spam confirmed' }), appeal: { status: 'none' } },
    { id: 'r5', reporterId: 'u_other', targetType: 'user', targetId: 'u_rep', targetAuthorId: 'u_rep', reason: 'Impersonation', category: 'impersonation', status: 'resolved', createdAt: NOW - 1000, decision: decided('user-warned', { reason: 'First warning' }), appeal: { status: 'requested', text: 'It was satire', byId: 'u_rep', at: NOW - 500 } },
    { id: 'r6', reporterId: 'u_other', targetType: 'post', targetId: 'p1', targetAuthorId: 'u_auth', reason: 'Not about me', category: 'spam', status: 'resolved', createdAt: NOW - 900, decision: decided('content-removed', { reason: 'Definitely spam' }), appeal: { status: 'none' } }
  ];

  it('renders my reports with pending, action-taken and no-violation states', () => {
    const html = V.supportInboxView(mkData(reports), USERS[0]);
    expect(html).toContain('My reports');
    expect(html).toContain('Awaiting a decision'); // r1 pending
    expect(html).toContain('Action taken'); // r2 resolved with outcome
    expect(html).toContain('No violation found'); // r3 rejected
    expect(html).toContain('Spam links'); // my own report reason is visible to me
  });

  it('renders notices about my content with a one-shot appeal control', () => {
    const html = V.supportInboxView(mkData(reports), USERS[0]);
    expect(html).toContain('Notices about my content');
    expect(html).toContain('Content removed'); // r4 outcome badge
    expect(html).toContain('Spam confirmed'); // r4 staff reason
    expect(html).toContain('data-act="support-appeal-open"'); // r4 can be appealed
    expect(html).toContain('Appeal requested'); // r5 already appealed
    expect(html).toContain('It was satire'); // r5 appeal text shown back
    // The already-appealed notice offers no second appeal button:
    const appealButtons = html.split('data-act="support-appeal-open"').length - 1;
    expect(appealButtons).toBe(1);
  });

  it('shows nothing of other people\'s reports or notices', () => {
    const html = V.supportInboxView(mkData(reports), USERS[0]);
    expect(html).not.toContain('Not about me'); // r6 is neither filed by nor about u_rep
    expect(html).not.toContain('Definitely spam');
    const other = V.supportInboxView(mkData(reports), USERS[3]);
    expect(other).toContain('You have not submitted any reports yet.');
    expect(other).toContain('No actions have been taken on your content.');
  });

  it('supportDecisionSummary maps statuses honestly', () => {
    expect(V.supportDecisionSummary({ status: 'pending', decision: null })).toBe('Awaiting a decision');
    expect(V.supportDecisionSummary({ status: 'review', decision: decided('none', { action: 'review' }) })).toBe('Awaiting a decision');
    expect(V.supportDecisionSummary({ status: 'resolved', decision: decided('content-removed') })).toBe('Action taken');
    expect(V.supportDecisionSummary({ status: 'resolved', decision: decided('none') })).toBe('Reviewed — no action taken');
    expect(V.supportDecisionSummary({ status: 'rejected', decision: decided('none', { action: 'reject' }) })).toBe('No violation found');
  });

  it('admin reports view gains an appeals filter showing the user\'s appeal text', () => {
    const d = mkData(reports);
    const staff = { id: 'boss', name: 'Boss', username: 'boss', role: 'admin', isBot: false };
    const html = V.reportsView(d, staff, { status: 'appeals' });
    expect(html).toContain('Appeals (1)');
    expect(html).toContain('It was satire');
    expect(html).not.toContain('Spam links'); // pending report is not an appeal
  });
});

// ------------------------------------------------------------- demo flow
describe('Support Inbox flow (demo path)', () => {
  let authorId;
  let postId;
  let repId;

  it('report → decision → inbox notices + notifications', async () => {
    const author = await api.register({ name: 'Inbox Author', username: 'inbox.author', email: 'inbox.author@example.com', password: 'demo1234' });
    authorId = author.id;
    const post = await api.createPost({ text: 'Buy my miracle coins now', visibility: 'public' });
    postId = post.id;

    const reporter = await api.register({ name: 'Inbox Reporter', username: 'inbox.reporter', email: 'inbox.reporter@example.com', password: 'demo1234' });
    const rep = await api.reportContent('post', postId, 'Obvious scam', { category: 'spam' });
    repId = rep.id;
    expect(rep.targetAuthorId).toBe(authorId); // stamped at creation

    await api.login('admin@meetbook.app', 'admin123');
    await api.adminDecideReport(repId, 'resolve', { outcome: 'content-removed', reason: 'Scam confirmed' });

    const s = store.getState();
    expect(s.posts.some((p) => p.id === postId)).toBe(false); // hard delete
    const saved = s.reports.find((r) => r.id === repId);
    expect(saved.status).toBe('resolved');
    expect(saved.decision).toMatchObject({ outcome: 'content-removed', reason: 'Scam confirmed' });
    // Doorbells: reporter hears the decision, author hears the action.
    expect(s.notifications.some((n) => n.userId === reporter.id && n.type === 'report_decision')).toBe(true);
    expect(s.notifications.some((n) => n.userId === authorId && n.type === 'moderation_notice')).toBe(true);
  });

  it('author files ONE appeal; staff decide it; text survives; author is notified', async () => {
    await api.login('inbox.author@example.com', 'demo1234');
    const appeal = await api.appealReport(repId, 'It was a joke post');
    expect(appeal).toMatchObject({ status: 'requested', text: 'It was a joke post', byId: authorId });
    // One appeal only:
    await expect(api.appealReport(repId, 'Second try')).rejects.toThrow();
    // The reporter cannot appeal a decision about someone else's content:
    await api.login('inbox.reporter@example.com', 'demo1234');
    await expect(api.appealReport(repId, 'Not mine')).rejects.toThrow();

    await api.login('admin@meetbook.app', 'admin123');
    await api.adminSetReportAppeal(repId, 'declined', 'Confirmed scam');
    const s = store.getState();
    const saved = s.reports.find((r) => r.id === repId);
    expect(saved.appeal).toMatchObject({ status: 'declined', reason: 'Confirmed scam', text: 'It was a joke post' });
    expect(s.notifications.some((n) => n.userId === authorId && n.type === 'appeal_decision')).toBe(true);
  });

  it('a rejected report notifies the reporter with the no-violation outcome', async () => {
    await api.login('inbox.reporter@example.com', 'demo1234');
    const rep = await api.reportContent('user', authorId, 'Seems suspicious', { category: 'fake' });
    const noticesBefore = store.getState().notifications.filter((n) => n.userId === authorId && n.type === 'moderation_notice').length;
    await api.login('admin@meetbook.app', 'admin123');
    await api.adminDecideReport(rep.id, 'reject', { reason: 'Legit account' });
    const s = store.getState();
    const note = s.notifications.find((n) => n.userId === s.users.find((u) => u.username === 'inbox.reporter').id && n.type === 'report_decision' && n.text.includes('no violation'));
    expect(note).toBeTruthy();
    // No action was taken on the author, so no new notice and no appeal:
    expect(s.notifications.filter((n) => n.userId === authorId && n.type === 'moderation_notice').length).toBe(noticesBefore);
    await api.login('inbox.author@example.com', 'demo1234');
    await expect(api.appealReport(rep.id, 'But why')).rejects.toThrow();
  });
});

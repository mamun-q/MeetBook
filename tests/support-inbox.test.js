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

// ------------------------------------------------------- target labels
// Regression (2026-11-21 fix pack): the target line used the admin
// stats label ("Total posts") as its prefix and, once the decision
// hard-deleted the post, fell back to the raw doc id. The report now
// carries a targetLabel snapshot from creation; legacy reports fall
// back to the author name — never "Total posts", never a doc id.
describe('report target labels', () => {
  const staff = { id: 'boss', name: 'Boss', username: 'boss', role: 'admin', isBot: false };
  const withSnapshot = { id: 'r10', reporterId: 'u_rep', targetType: 'post', targetId: 'gone1', targetAuthorId: 'u_auth', targetLabel: 'Buy my miracle coins now', reason: 'Scam', category: 'spam', status: 'resolved', createdAt: NOW - 800, decision: decided('content-removed'), appeal: { status: 'none' } };
  const legacy = { id: 'r11', reporterId: 'u_rep', targetType: 'post', targetId: 'gone2', targetAuthorId: 'u_auth', reason: 'Spam', category: 'spam', status: 'resolved', createdAt: NOW - 700, decision: decided('content-removed'), appeal: { status: 'none' } };

  it('inbox notice shows the stamped snapshot after the post is deleted', () => {
    const html = V.supportInboxView(mkData([withSnapshot]), USERS[1]); // Adam Author
    expect(html).toContain('Buy my miracle coins now');
    expect(html).not.toContain('Total posts');
    expect(html).not.toContain('gone1');
  });

  it('legacy report without a snapshot falls back to the author name, never the doc id', () => {
    const html = V.supportInboxView(mkData([legacy]), USERS[1]);
    expect(html).toContain('Adam Author');
    expect(html).not.toContain('Total posts');
    expect(html).not.toContain('gone2');
  });

  it('admin card keeps the snapshot after resolution and never shows the raw id', () => {
    const html = V.reportsView(mkData([withSnapshot, legacy]), staff, {});
    expect(html).toContain('Buy my miracle coins now');
    expect(html).toContain('Adam Author');
    expect(html).not.toContain('Total posts');
    expect(html).not.toContain('gone1');
    expect(html).not.toContain('gone2');
  });

  it('a photo-only post renders the Photo post label', () => {
    const photo = { ...withSnapshot, id: 'r12', targetId: 'gone3', targetLabel: '', targetPhoto: true };
    const html = V.supportInboxView(mkData([photo]), USERS[1]);
    expect(html).toContain('Photo post');
    expect(html).not.toContain('gone3');
  });
});

// ---------------------------------------------------- appeal isolation
// Regression (2026-11-21 fix pack): a live E2E appeared to show one
// report's accepted appeal on ANOTHER report's admin card. The card
// renders strictly from its own report doc — pin that isolation.
describe('reportsView appeal isolation', () => {
  const staff = { id: 'boss', name: 'Boss', username: 'boss', role: 'admin', isBot: false };
  const accepted = { id: 'r20', reporterId: 'u_rep', targetType: 'post', targetId: 'p1', targetAuthorId: 'u_auth', reason: 'Spam', category: 'spam', status: 'resolved', createdAt: NOW - 600, decision: decided('content-removed'), appeal: { status: 'accepted', text: 'It was satire', byId: 'u_auth', reason: 'Overturned' } };
  const noAppeal = { id: 'r21', reporterId: 'u_rep', targetType: 'post', targetId: 'p2', targetAuthorId: 'u_rep', reason: 'Other', category: 'other', status: 'resolved', createdAt: NOW - 500, decision: decided('none'), appeal: { status: 'none' } };

  it('an accepted appeal on one report never leaks onto another report\'s card', () => {
    const html = V.reportsView(mkData([accepted, noAppeal]), staff, {});
    expect(html.split('Appeal accepted').length - 1).toBe(1);
    expect(html.split('does not automatically restore').length - 1).toBe(1);
    expect(html).toContain('No appeal');
  });

  it('a report with no appeal renders No appeal and no appeal-decision text', () => {
    const html = V.reportsView(mkData([noAppeal]), staff, {});
    expect(html).toContain('No appeal');
    expect(html).not.toContain('Appeal accepted');
    expect(html).not.toContain('does not automatically restore');
  });
});

// ---------------------------------------------------- decided appeals
// Regression (2026-11-21 fix pack): the inbox notice dropped the
// user's own appeal text once staff decided the appeal.
describe('supportInboxView decided appeals', () => {
  const mk = (appeal) => ({ id: 'r30', reporterId: 'u_other', targetType: 'post', targetId: 'p2', targetAuthorId: 'u_rep', reason: 'Edgy', category: 'spam', status: 'resolved', createdAt: NOW - 400, decision: decided('content-removed'), appeal });

  it('keeps the user\'s appeal text visible after the appeal is accepted', () => {
    const html = V.supportInboxView(mkData([mk({ status: 'accepted', text: 'It was satire', byId: 'u_rep', reason: 'Overturned on review' })]), USERS[0]);
    expect(html).toContain('Appeal accepted');
    expect(html).toContain('It was satire');
    expect(html).toContain('Overturned on review');
  });

  it('keeps the user\'s appeal text visible after the appeal is declined', () => {
    const html = V.supportInboxView(mkData([mk({ status: 'declined', text: 'It was satire', byId: 'u_rep', reason: 'Still spam' })]), USERS[0]);
    expect(html).toContain('Appeal declined');
    expect(html).toContain('It was satire');
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

// --------------------------------------------- target snapshot (demo)
// reportContent stamps a human-readable targetLabel at creation; the
// inbox and the Reports Center keep showing it after the decision
// hard-deletes the post (previously: "Total posts" + the raw doc id).
describe('report target snapshot (demo path)', () => {
  it('stamps targetLabel; inbox + admin keep it after the hard delete', async () => {
    const author = await api.register({ name: 'Snap Author', username: 'snap.author', email: 'snap.author@example.com', password: 'demo1234' });
    const post = await api.createPost({ text: 'Limited offer: crypto gems for everyone', visibility: 'public' });
    await api.register({ name: 'Snap Reporter', username: 'snap.reporter', email: 'snap.reporter@example.com', password: 'demo1234' });
    const rep = await api.reportContent('post', post.id, 'Scam', { category: 'spam' });
    expect(rep.targetLabel).toBe('Limited offer: crypto gems for everyone');

    await api.login('admin@meetbook.app', 'admin123');
    await api.adminDecideReport(rep.id, 'resolve', { outcome: 'content-removed', reason: 'Scam' });

    const d = api.data();
    const inbox = V.supportInboxView(d, d.users.find((u) => u.id === author.id));
    expect(inbox).toContain('Limited offer: crypto gems for everyone');
    expect(inbox).not.toContain('Total posts');
    expect(inbox).not.toContain(post.id);

    const staffUser = d.users.find((u) => u.role === 'admin' || u.role === 'superadmin');
    const admin = V.reportsView(d, staffUser, {});
    expect(admin).toContain('Limited offer: crypto gems for everyone');
    expect(admin).not.toContain('Total posts');
    expect(admin).not.toContain(post.id);
  });

  it('a photo-only post stamps targetPhoto instead of a text label', async () => {
    await api.login('snap.author@example.com', 'demo1234');
    const post = await api.createPost({ text: '', image: 'https://example.com/gems.png', visibility: 'public' });
    await api.login('snap.reporter@example.com', 'demo1234');
    const rep = await api.reportContent('post', post.id, 'Scam pic', { category: 'spam' });
    expect(rep.targetLabel).toBe('');
    expect(rep.targetPhoto).toBe(true);
  });
});

// ------------------------------------------------------- appeal guard
// Regression (2026-11-21): staff appeal controls could accept/decline
// an appeal that was never filed — a stray tap set 'accepted' on a
// live no-action report. The view now renders Accept/Decline ONLY for
// a 'requested' appeal, and adminSetReportAppeal no-ops (null, no
// write, no audit, no doorbell) on accept/decline from any other
// state. Marking 'requested' by hand stays allowed (off-app appeals).
describe('reportsView appeal controls (guard)', () => {
  const staff = { id: 'boss', name: 'Boss', username: 'boss', role: 'admin', isBot: false };
  const mk = (appeal) => ({ id: 'r40', reporterId: 'u_rep', targetType: 'post', targetId: 'p1', targetAuthorId: 'u_auth', reason: 'Spam', category: 'spam', status: 'resolved', createdAt: NOW - 300, decision: decided('none'), appeal });
  const buttons = (html) => ({
    requested: html.includes('data-appeal="requested"'),
    accepted: html.includes('data-appeal="accepted"'),
    declined: html.includes('data-appeal="declined"')
  });

  it('a report with NO appeal offers only Mark-requested — no Accept/Decline', () => {
    const html = V.reportsView(mkData([mk({ status: 'none' })]), staff, {});
    expect(buttons(html)).toEqual({ requested: true, accepted: false, declined: false });
  });

  it('a report with a FILED appeal offers Accept + Decline', () => {
    const html = V.reportsView(mkData([mk({ status: 'requested', text: 'Please recheck', byId: 'u_auth' })]), staff, {});
    expect(buttons(html)).toEqual({ requested: false, accepted: true, declined: true });
  });

  it('a decided appeal shows its state line and no appeal buttons', () => {
    const acc = V.reportsView(mkData([mk({ status: 'accepted', text: 'Please recheck', byId: 'u_auth', reason: 'Overturned' })]), staff, {});
    expect(acc).toContain('Appeal accepted');
    expect(buttons(acc)).toEqual({ requested: false, accepted: false, declined: false });
    const dec = V.reportsView(mkData([mk({ status: 'declined', text: 'Please recheck', byId: 'u_auth', reason: 'Still spam' })]), staff, {});
    expect(dec).toContain('Appeal declined');
    expect(buttons(dec)).toEqual({ requested: false, accepted: false, declined: false });
  });
});

describe('appeal guard (demo path)', () => {
  let repId;
  let authorId;

  it('accept/decline on a report with no filed appeal are null no-ops', async () => {
    const author = await api.register({ name: 'Guard Author', username: 'guard.author', email: 'guard.author@example.com', password: 'demo1234' });
    authorId = author.id;
    const post = await api.createPost({ text: 'Totally legitimate crypto gems', visibility: 'public' });
    await api.register({ name: 'Guard Reporter', username: 'guard.reporter', email: 'guard.reporter@example.com', password: 'demo1234' });
    const rep = await api.reportContent('post', post.id, 'Looks like a scam', { category: 'spam' });
    repId = rep.id;
    await api.login('admin@meetbook.app', 'admin123');
    // The live incident shape: a decided, no-action report.
    await api.adminDecideReport(repId, 'resolve', { outcome: 'none', reason: 'Looks fine' });

    const logsBefore = store.getState().adminLogs.filter((l) => l.action === 'report-appeal').length;
    const doorbellsBefore = store.getState().notifications.filter((n) => n.type === 'appeal_decision').length;
    expect(await api.adminSetReportAppeal(repId, 'accepted', 'Stray tap')).toBeNull();
    expect(await api.adminSetReportAppeal(repId, 'declined', 'Stray tap')).toBeNull();
    const s = store.getState();
    expect(s.reports.find((r) => r.id === repId).appeal).toMatchObject({ status: 'none' });
    expect(s.adminLogs.filter((l) => l.action === 'report-appeal').length).toBe(logsBefore); // no audit for a non-action
    expect(s.notifications.filter((n) => n.type === 'appeal_decision').length).toBe(doorbellsBefore); // no doorbell
  });

  it('mark-requested still works from none, and then accept lands', async () => {
    await api.login('admin@meetbook.app', 'admin123');
    const marked = await api.adminSetReportAppeal(repId, 'requested');
    expect(marked).toMatchObject({ status: 'requested' });
    const accepted = await api.adminSetReportAppeal(repId, 'accepted', 'Off-app appeal upheld');
    expect(accepted).toMatchObject({ status: 'accepted', reason: 'Off-app appeal upheld' });
    const s = store.getState();
    expect(s.reports.find((r) => r.id === repId).appeal).toMatchObject({ status: 'accepted' });
    // Staff-filed appeal (byId == the deciding admin) rings no doorbell:
    expect(s.notifications.some((n) => n.type === 'appeal_decision' && n.userId === authorId)).toBe(false);
    // A decided appeal cannot be re-decided:
    expect(await api.adminSetReportAppeal(repId, 'declined', 'Changed my mind')).toBeNull();
    expect(store.getState().reports.find((r) => r.id === repId).appeal).toMatchObject({ status: 'accepted' });
  });
});

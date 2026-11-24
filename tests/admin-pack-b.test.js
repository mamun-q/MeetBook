// Super Admin Pack B — overview stats, analytics series + CSV, spam
// heuristics, Reports Center decisions. Pure-helper and view tests run
// against synthetic fixtures; the decision tests run the REAL api.js
// in demo mode (firebase mocked out), mirroring tests/admin-pack-a.
import { describe, it, expect, vi, beforeAll } from 'vitest';

vi.mock('../src/supabase.js', () => ({
  supabaseReady: false, isSupabaseConfigured: false, supabaseConfig: {}, supabase: null
}));

const mem = new Map();
globalThis.localStorage = {
  getItem: (k) => (mem.has(k) ? mem.get(k) : null),
  setItem: (k, v) => mem.set(k, String(v)),
  removeItem: (k) => mem.delete(k)
};

import {
  platformStats, analyticsSeries, seriesToCsv, spamSuspects,
  reportStatus, reportCategory, reportNeedsAttention, isOnlineNow, countPostComments
} from '../src/utils.js';

let V;
let api;
let store;

beforeAll(async () => {
  V = { ...(await import('../src/views.js')), ...(await import('../src/adminViews.js')) };
  store = await import('../src/store.js');
  api = await import('../src/api.js');
});

const DAY = 24 * 3600_000;
const NOW = 1_760_000_000_000; // fixed reference instant for fixtures

// ---------------------------------------------------------------- stats
describe('platformStats', () => {
  const d = {
    users: [
      { id: 'h1', isBot: false, online: true, lastSeen: NOW - 60_000, createdAt: NOW - 2 * 3600_000 },
      { id: 'h2', isBot: false, online: true, lastSeen: NOW - 30 * 60_000, createdAt: NOW - 3 * DAY },
      { id: 'h3', isBot: false, online: false, lastSeen: NOW - 2 * DAY, createdAt: NOW - 20 * DAY },
      { id: 'h4', isBot: false, online: false, lastSeen: NOW - 40 * DAY, createdAt: NOW - 60 * DAY },
      { id: 'b1', isBot: true, online: true, lastSeen: NOW, createdAt: NOW - 100 * DAY }
    ],
    posts: [
      { id: 'p1', authorId: 'h1', likes: ['h2', 'h3'], comments: [{ id: 'c1', replies: [{ id: 'r1' }, { id: 'r2' }] }, { id: 'c2', replies: [] }] },
      { id: 'p2', authorId: 'h2', likes: ['h1'], comments: [] }
    ],
    messages: [{ id: 'm1' }, { id: 'm2' }, { id: 'm3' }],
    bots: [{ id: 'bot1', active: true }, { id: 'bot2', active: false }, { id: 'bot3' }],
    reports: [
      { id: 'r1', status: 'pending' }, { id: 'r2', status: 'open' },
      { id: 'r3', status: 'review' }, { id: 'r4', status: 'resolved' }
    ]
  };

  it('computes users, windows, presence and activity from the dataset', () => {
    const s = platformStats(d, NOW);
    expect(s.totalUsers).toBe(4); // bots excluded
    expect(s.newToday).toBe(1);
    expect(s.new7d).toBe(2);
    expect(s.new30d).toBe(3);
    expect(s.onlineNow).toBe(1); // h2's lastSeen is 30 min old — stale
    expect(s.activeUsers7d).toBe(3); // h1, h2, h3
    expect(s.pendingReports).toBe(2); // 'pending' + legacy 'open'
  });

  it('sums comments (incl. replies) and likes across posts', () => {
    const s = platformStats(d, NOW);
    expect(s.totalPosts).toBe(2);
    expect(s.totalComments).toBe(4); // c1 + 2 replies + c2
    expect(s.totalLikes).toBe(3);
    expect(s.totalMessages).toBe(3);
    expect(s.sources).toEqual({ posts: 'loaded', comments: 'loaded', likes: 'loaded', messages: 'loaded' });
  });

  it('counts bots by enabled state', () => {
    const s = platformStats(d, NOW);
    expect(s.totalBots).toBe(3);
    expect(s.activeBots).toBe(2); // active:true + active absent
    expect(s.disabledBots).toBe(1);
  });

  it('prefers server aggregates per metric and flags the rest as loaded', () => {
    const s = platformStats(d, NOW, { postsTotal: 900, messagesTotal: 5000, commentsTotal: null, likesTotal: null });
    expect(s.totalPosts).toBe(900);
    expect(s.totalMessages).toBe(5000);
    expect(s.totalComments).toBe(4); // fell back to the mirror
    expect(s.totalLikes).toBe(3);
    expect(s.sources.posts).toBe('server');
    expect(s.sources.messages).toBe('server');
    expect(s.sources.comments).toBe('loaded');
    expect(s.sources.likes).toBe('loaded');
  });

  it('isOnlineNow applies the 10-minute freshness rule with flag fallback', () => {
    expect(isOnlineNow({ online: true, lastSeen: NOW - 9 * 60_000 }, NOW)).toBe(true);
    expect(isOnlineNow({ online: true, lastSeen: NOW - 11 * 60_000 }, NOW)).toBe(false);
    expect(isOnlineNow({ online: true, lastSeen: 0 }, NOW)).toBe(true); // legacy doc: flag alone
    expect(isOnlineNow({ online: false, lastSeen: NOW }, NOW)).toBe(false);
    expect(countPostComments({ comments: [{ replies: [{}] }, {}] })).toBe(3);
  });
});

// ------------------------------------------------------------ analytics
describe('analyticsSeries + CSV', () => {
  const todayStart = (() => { const x = new Date(NOW); x.setHours(0, 0, 0, 0); return x.getTime(); })();
  const d = {
    users: [
      { id: 'old', isBot: false, createdAt: todayStart - 40 * DAY },
      { id: 'u1', isBot: false, createdAt: todayStart - 2 * DAY + 1000 },
      { id: 'u2', isBot: false, createdAt: todayStart - 2 * DAY + 2000 },
      { id: 'u3', isBot: false, createdAt: todayStart + 3000 },
      { id: 'bt', isBot: true, createdAt: todayStart - 2 * DAY + 4000 }
    ],
    posts: [
      { id: 'p1', authorId: 'u1', createdAt: todayStart - 2 * DAY + 5000, likes: ['u2'], comments: [{ id: 'c', replies: [] }] },
      { id: 'p2', authorId: 'bt', createdAt: todayStart - 2 * DAY + 6000, likes: [], comments: [] },
      { id: 'p3', authorId: 'u3', createdAt: todayStart + 7000, likes: ['u1', 'u2'], comments: [] },
      { id: 'pOld', authorId: 'old', createdAt: todayStart - 40 * DAY, likes: ['u1'], comments: [] }
    ],
    reports: [
      { id: 'r1', createdAt: todayStart - 2 * DAY + 8000, status: 'resolved' },
      { id: 'r2', createdAt: todayStart - 2 * DAY + 9000, status: 'open' }, // legacy → pending
      { id: 'r3', createdAt: todayStart + 1000, status: 'escalated' }
    ]
  };

  it('builds per-day registrations, cumulative growth, posts and engagement', () => {
    const rows = analyticsSeries(d, 7, NOW);
    expect(rows).toHaveLength(7);
    const twoDaysAgo = rows[4]; // rows[0] is 6 days ago, rows[6] is today
    const today = rows[6];
    expect(twoDaysAgo.registrations).toBe(2); // bot registration excluded
    expect(twoDaysAgo.posts).toBe(2);
    expect(twoDaysAgo.engagement).toBe(2); // p1: 1 like + 1 comment
    expect(twoDaysAgo.botPosts).toBe(1);
    expect(twoDaysAgo.humanPosts).toBe(1);
    expect(today.registrations).toBe(1);
    expect(today.engagement).toBe(2); // p3's two likes
    // Cumulative: 1 pre-window user + registrations along the way.
    expect(rows[0].totalUsers).toBe(1);
    expect(today.totalUsers).toBe(4);
  });

  it('groups reports by filed day and CURRENT status (legacy mapped)', () => {
    const rows = analyticsSeries(d, 7, NOW);
    expect(rows[4].reportsTotal).toBe(2);
    expect(rows[4].reportsResolved).toBe(1);
    expect(rows[4].reportsPending).toBe(1); // legacy 'open'
    expect(rows[6].reportsEscalated).toBe(1);
  });

  it('excludes out-of-window activity', () => {
    const rows = analyticsSeries(d, 7, NOW);
    expect(rows.reduce((n, r) => n + r.posts, 0)).toBe(3); // pOld is outside
    expect(rows.reduce((n, r) => n + r.registrations, 0)).toBe(3);
  });

  it('seriesToCsv emits the header and one line per day', () => {
    const csv = seriesToCsv(analyticsSeries(d, 7, NOW));
    const lines = csv.split('\n');
    expect(lines).toHaveLength(8);
    expect(lines[0]).toBe('day,registrations,totalUsers,posts,engagement,botPosts,humanPosts,reportsTotal,reportsPending,reportsReview,reportsResolved,reportsRejected,reportsEscalated');
    expect(lines[7].split(',')[1]).toBe('1'); // today's registrations
    expect(lines[7].split(',')[2]).toBe('4'); // today's cumulative users
  });
});

// ----------------------------------------------------------------- spam
describe('spamSuspects heuristics', () => {
  const post = (id, authorId, text, createdAt) => ({ id, authorId, text, createdAt, likes: [], comments: [] });
  const base = NOW;

  it('flags near-identical text posted 3+ times by one author, not twice', () => {
    const posts = [
      post('a1', 'u1', 'Buy now!  Great deal', base),
      post('a2', 'u1', 'buy now! great deal', base + 1000),
      post('a3', 'u1', 'BUY NOW! GREAT DEAL', base + 2000),
      post('b1', 'u2', 'same text', base),
      post('b2', 'u2', 'same text', base + 1000)
    ];
    const out = spamSuspects(posts);
    expect(out.map((x) => x.post.id).sort()).toEqual(['a1', 'a2', 'a3']);
    expect(out[0].flags).toContain('repeat');
  });

  it('flags posts containing 3+ links', () => {
    const posts = [
      post('l1', 'u1', 'see http://a.io and www.b.io plus https://c.io', base),
      post('l2', 'u1', 'one http://a.io link only', base + 1000)
    ];
    const out = spamSuspects(posts);
    expect(out).toHaveLength(1);
    expect(out[0].post.id).toBe('l1');
    expect(out[0].flags).toContain('links');
  });

  it('flags an author bursting 5+ posts inside 10 minutes', () => {
    const posts = Array.from({ length: 5 }, (_, i) => post(`s${i}`, 'u9', `unique thought ${i}`, base + i * 60_000));
    posts.push(post('calm', 'u8', 'a normal post', base));
    const out = spamSuspects(posts);
    expect(out.map((x) => x.post.id).sort()).toEqual(['s0', 's1', 's2', 's3', 's4']);
    expect(out[0].flags).toContain('burst');
    const four = spamSuspects(posts.slice(0, 4));
    expect(four).toHaveLength(0);
  });
});

// ------------------------------------------------------- report helpers
describe('report status/category normalisation', () => {
  it('maps the legacy vocabulary onto the Pack B lifecycle', () => {
    expect(reportStatus({ status: 'open' })).toBe('pending');
    expect(reportStatus({ status: 'actioned' })).toBe('resolved');
    expect(reportStatus({ status: 'dismissed' })).toBe('rejected');
    expect(reportStatus({ status: 'review' })).toBe('review');
    expect(reportStatus({ status: 'escalated' })).toBe('escalated');
    expect(reportStatus({})).toBe('pending');
    expect(reportCategory({ category: 'spam' })).toBe('spam');
    expect(reportCategory({ category: 'nonsense' })).toBe('other');
    expect(reportCategory({})).toBe('other');
    expect(reportNeedsAttention({ status: 'open' })).toBe(true);
    expect(reportNeedsAttention({ status: 'escalated' })).toBe(true);
    expect(reportNeedsAttention({ status: 'resolved' })).toBe(false);
  });
});

// ---------------------------------------------------------------- views
describe('Pack B admin views', () => {
  const viewer = { id: 'boss', name: 'Boss', username: 'boss', role: 'admin', isBot: false };
  const mkData = () => ({
    users: [
      { id: 'h1', name: 'Hana', username: 'hana', isBot: false, online: true, lastSeen: Date.now(), createdAt: Date.now() - DAY },
      { id: 'bt1', name: 'Bolt', username: 'bolt', isBot: true, online: false, lastSeen: 0, createdAt: Date.now() - 9 * DAY }
    ],
    posts: [{ id: 'p1', authorId: 'h1', text: 'hello world', createdAt: Date.now(), likes: ['bt1'], comments: [{ id: 'c1', authorId: 'bt1', text: 'nice', createdAt: Date.now(), replies: [] }] }],
    messages: [], bots: [{ id: 'bot1', active: true }], reports: [], friendships: [], config: {}, adminStats: null
  });

  it('overview renders computed stats and labels live fallbacks', () => {
    const html = V.adminOverviewView(mkData(), viewer, { firebase: true, projectId: 'meetbook-d8a44' });
    expect(html).toContain('Total comments');
    expect(html).toContain('from loaded data'); // no aggregates in live mode → labelled fallback
    const withAgg = V.adminOverviewView({ ...mkData(), adminStats: { postsTotal: 42, messagesTotal: 7, commentsTotal: 3, likesTotal: 5 } }, viewer, { firebase: true, projectId: 'x' });
    expect(withAgg).toContain('<b>42</b>');
    expect(withAgg).not.toContain('from loaded data');
  });

  it('analytics view renders SVG charts and the data table', () => {
    const html = V.adminAnalyticsView(mkData(), viewer, { days: 7 });
    expect(html).toContain('<svg');
    expect(html).toContain('User growth');
    expect(html).toContain('data-act="admin-export-analytics"');
    expect(html).toContain('Aggregates only');
  });

  it('content spam tab labels heuristics and lists suspects', () => {
    const d = mkData();
    d.posts = Array.from({ length: 3 }, (_, i) => ({ id: `sp${i}`, authorId: 'h1', text: 'win money fast', createdAt: Date.now() + i, likes: [], comments: [] }));
    const html = V.adminContentView(d, viewer, { tab: 'spam' });
    expect(html).toContain('Heuristic suggestions');
    expect(html).toContain('Same text 3+ times');
    expect(html).toContain('data-act="admin-content-delete-post"');
  });

  it('report form offers all seven categories', () => {
    const html = V.reportFormHtml('post', 'p1');
    for (const c of ['fake', 'harassment', 'spam', 'inappropriate', 'impersonation', 'bot', 'other']) {
      expect(html).toContain(`value="${c}"`);
    }
  });

  it('reports view shows category, evidence, decision history and filters by status', () => {
    const d = mkData();
    d.users.push({ id: 'rep1', name: 'Rita Reporter', username: 'rita', isBot: false });
    d.reports = [
      { id: 'repA', reporterId: 'rep1', targetType: 'message', targetId: 'm9', reason: 'Threats', category: 'harassment', status: 'pending', createdAt: Date.now(), evidence: { messageId: 'm9', text: 'I will find you', senderId: 'h1' }, decision: null, appeal: { status: 'none' } },
      { id: 'repB', reporterId: 'rep1', targetType: 'user', targetId: 'h1', reason: 'Fake', category: 'fake', status: 'resolved', createdAt: Date.now(), decision: { byId: 'boss', byName: 'Boss', at: Date.now(), reason: 'Confirmed fake', outcome: 'user-warned', action: 'resolve' }, appeal: { status: 'requested' } }
    ];
    const all = V.reportsView(d, viewer, {});
    expect(all).toContain('Harassment');
    expect(all).toContain('I will find you'); // evidence snapshot only
    expect(all).toContain('User warned'); // decision history outcome
    expect(all).toContain('Confirmed fake');
    expect(all).toContain('Appeal requested');
    const pendingOnly = V.reportsView(d, viewer, { status: 'pending' });
    expect(pendingOnly).toContain('Threats');
    expect(pendingOnly).not.toContain('Confirmed fake');
    expect(pendingOnly).toContain('data-act="report-resolve-open"');
  });
});

// ------------------------------------------- report decisions (demo api)
describe('Reports Center decisions (demo path)', () => {
  it('reportContent files a Pack B-shaped report; message reports snapshot evidence', async () => {
    await api.login('ayesha@example.com', 'demo123');
    const rep = await api.reportContent('post', 'p_2', 'Spammy bot post', { category: 'spam' });
    expect(rep).toMatchObject({ targetType: 'post', targetId: 'p_2', category: 'spam', status: 'pending', decision: null, appeal: { status: 'none' } });
    const msgRep = await api.reportContent('message', 'm_1', 'Creepy message', { category: 'harassment' });
    expect(msgRep.evidence).toMatchObject({ messageId: 'm_1', senderId: 'bot_sage' });
    expect(msgRep.evidence.text).toContain('Hello! I am Sage');
    expect(msgRep.evidence).not.toHaveProperty('conversation'); // never the thread
    const bad = await api.reportContent('user', 'u_tanvir', 'x', { category: 'bogus' });
    expect(bad.category).toBe('other'); // unknown categories normalise
  });

  it('review + resolve(user-warned) update the report, notify the user and audit', async () => {
    const s0 = store.getState();
    const rep = s0.reports.find((r) => r.targetType === 'post' && r.targetId === 'p_2');
    await api.login('admin@meetbook.app', 'admin123');
    const reviewed = await api.adminDecideReport(rep.id, 'review', { reason: 'Looking into it' });
    expect(reviewed.status).toBe('review');
    let s = store.getState();
    expect(s.reports.find((r) => r.id === rep.id).decision).toMatchObject({ byId: 'u_admin', byName: 'MeetBook Admin', reason: 'Looking into it', action: 'review' });
    expect(s.adminLogs[0]).toMatchObject({ action: 'report-review', targetType: 'report', targetId: rep.id });

    // A fresh user report resolved with a warning.
    await api.login('ayesha@example.com', 'demo123');
    const warnRep = await api.reportContent('user', 'u_tanvir', 'Harassing me in comments', { category: 'harassment' });
    await api.login('admin@meetbook.app', 'admin123');
    await api.adminDecideReport(warnRep.id, 'resolve', { outcome: 'user-warned', reason: 'Harassment confirmed' });
    s = store.getState();
    const saved = s.reports.find((r) => r.id === warnRep.id);
    expect(saved.status).toBe('resolved');
    expect(saved.decision).toMatchObject({ outcome: 'user-warned', reason: 'Harassment confirmed' });
    const notif = s.notifications.find((n) => n.userId === 'u_tanvir' && n.type === 'warning');
    expect(notif).toBeTruthy();
    expect(notif.text).toContain('Harassment confirmed');
    expect(s.adminLogs[0]).toMatchObject({ action: 'report-resolve', targetId: warnRep.id });
  });

  it('resolve(content-removed) actually deletes the reported post', async () => {
    await api.login('ayesha@example.com', 'demo123');
    const rep = await api.reportContent('post', 'p_4', 'Inappropriate', { category: 'inappropriate' });
    await api.login('admin@meetbook.app', 'admin123');
    await api.adminDecideReport(rep.id, 'resolve', { outcome: 'content-removed', reason: 'Guideline violation' });
    const s = store.getState();
    expect(s.posts.some((p) => p.id === 'p_4')).toBe(false);
    expect(s.reports.find((r) => r.id === rep.id).status).toBe('resolved');
  });

  it('resolve(user-suspended) suspends a user target through the existing guards', async () => {
    const created = await api.register({ name: 'Bad Actor', username: 'bad.actor', email: 'bad@example.com', password: 'demo1234' });
    const rep = await api.reportContent('user', created.id, 'Fake account', { category: 'fake' });
    // ^ filed by the new user against themselves is odd but harmless; refile as ayesha:
    await api.login('ayesha@example.com', 'demo123');
    const rep2 = await api.reportContent('user', created.id, 'Fake account', { category: 'fake' });
    expect(rep.targetId).toBe(created.id);
    await api.login('admin@meetbook.app', 'admin123');
    await api.adminDecideReport(rep2.id, 'resolve', { outcome: 'user-suspended', reason: 'Confirmed fake' });
    const s = store.getState();
    expect(s.users.find((u) => u.id === created.id).status).toBe('suspended');
  });

  it('reject and escalate transitions are recorded and audited', async () => {
    await api.login('ayesha@example.com', 'demo123');
    const rep = await api.reportContent('user', 'u_priya', 'Impersonation', { category: 'impersonation' });
    await api.login('admin@meetbook.app', 'admin123');
    await api.adminDecideReport(rep.id, 'escalate', { reason: 'Needs senior review' });
    let s = store.getState();
    expect(s.reports.find((r) => r.id === rep.id).status).toBe('escalated');
    await api.adminDecideReport(rep.id, 'reject', { reason: 'Not a violation' });
    s = store.getState();
    const saved = s.reports.find((r) => r.id === rep.id);
    expect(saved.status).toBe('rejected');
    expect(saved.decision.action).toBe('reject');
    expect(s.adminLogs[0]).toMatchObject({ action: 'report-reject', targetId: rep.id });
  });

  it('appeal management updates the report and audits', async () => {
    const s0 = store.getState();
    const rep = s0.reports.find((r) => r.status === 'rejected');
    // Appeal guard (2026-11-21): accept/decline only land on a FILED
    // appeal, so staff first mark it requested (an appeal received
    // outside the app), then accept it.
    await api.adminSetReportAppeal(rep.id, 'requested');
    await api.adminSetReportAppeal(rep.id, 'accepted', 'New evidence provided');
    const s = store.getState();
    expect(s.reports.find((r) => r.id === rep.id).appeal).toMatchObject({ status: 'accepted', byId: 'u_admin', reason: 'New evidence provided' });
    expect(s.adminLogs[0]).toMatchObject({ action: 'report-appeal', targetId: rep.id });
  });

  it('moderators can decide but cannot suspend through a report outcome', async () => {
    await api.login('ayesha@example.com', 'demo123');
    const rep = await api.reportContent('user', 'u_priya', 'Spam DMs', { category: 'spam' });
    store.mutate((s) => { s.users.find((u) => u.id === 'u_tanvir').role = 'moderator'; });
    await api.login('tanvir@example.com', 'demo123');
    const ok = await api.adminDecideReport(rep.id, 'review', { reason: 'Triaging' });
    expect(ok.status).toBe('review');
    // Suspension is behind canManageUser (admins only): the decision
    // must fail AND leave the report untouched.
    await expect(api.adminDecideReport(rep.id, 'resolve', { outcome: 'user-suspended', reason: 'Ban them' })).rejects.toThrow();
    const s = store.getState();
    expect(s.reports.find((r) => r.id === rep.id).status).toBe('review');
    expect(s.users.find((u) => u.id === 'u_priya').status).not.toBe('suspended');
    // The moderator's successful decision was still audited.
    expect(s.adminLogs.some((l) => l.action === 'report-review' && l.adminId === 'u_tanvir')).toBe(true);
  });

  it('non-staff cannot decide reports or delete content', async () => {
    await api.login('ayesha@example.com', 'demo123');
    const s = store.getState();
    const rep = s.reports[0];
    await expect(api.adminDecideReport(rep.id, 'reject', {})).rejects.toThrow(/Moderators only/);
    await expect(api.adminDeletePost('p_1', 'x')).rejects.toThrow(/Moderators only/);
    await expect(api.adminDeleteComment('p_3', 'c_2', 'x')).rejects.toThrow(/Moderators only/);
  });

  it('adminDeletePost / adminDeleteComment remove content and audit', async () => {
    await api.login('admin@meetbook.app', 'admin123');
    await api.adminDeleteComment('p_3', 'c_2r', 'Off-topic reply');
    let s = store.getState();
    const p3 = s.posts.find((p) => p.id === 'p_3');
    expect(p3.comments[0].replies.some((r) => r.id === 'c_2r')).toBe(false);
    expect(s.adminLogs[0]).toMatchObject({ action: 'delete-comment', targetType: 'post', targetId: 'p_3', reason: 'Off-topic reply' });
    await api.adminDeletePost('p_1', 'Spam campaign');
    s = store.getState();
    expect(s.posts.some((p) => p.id === 'p_1')).toBe(false);
    expect(s.adminLogs[0]).toMatchObject({ action: 'delete-post', targetId: 'p_1', reason: 'Spam campaign' });
  });
});

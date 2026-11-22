// Mirror-immediacy audit (2026-11-22): the "live write never patches
// the local mirror" bug class, swept across EVERY write path in
// src/api.js. The three earlier packs fixed follows, post/profile
// writes, echoes and friend requests; this file pins the rest —
// group/page/event/story/review writes, blocks, conversation
// creation + read receipts, invite joins, filed reports + appeals,
// and the admin/bot/announcement/config writes. Every assertion runs
// IMMEDIATELY after the awaited call (no settle), so only a real
// mirror patch — not the realtime refetch — can satisfy it.
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
const settleDeep = async () => { await settle(); await settle(); };

const mirrorUser = (id) => api.data().users.find((u) => u.id === id);
const mirrorPost = (id) => api.data().posts.find((p) => p.id === id);
const mirrorGroup = (id) => api.data().groups.find((g) => g.id === id);
const mirrorPage = (id) => api.data().pages.find((p) => p.id === id);
const mirrorEvent = (id) => api.data().events.find((e) => e.id === id);
const mirrorStory = (id) => api.data().stories.find((s) => s.id === id);
const mirrorConv = (id) => api.data().conversations.find((c) => c.id === id);
const mirrorMsg = (id) => api.data().messages.find((m) => m.id === id);
const mirrorReq = (id) => api.data().groupRequests.find((r) => r.id === id);
const mirrorReport = (id) => api.data().reports.find((r) => r.id === id);
const mirrorSupport = (id) => api.data().supportReports.find((r) => r.id === id);

const userRow = (name, username, email, role = 'user') => ({
  name, username, email, role, isBot: false, bio: '', avatar: '', cover: '',
  followers: [], following: [], closeFriends: [], settings: {}
});
const postRow = (id, authorId, text, extra = {}) => ({
  authorId, text, image: '', visibility: 'public', audienceIds: [],
  createdAt: Date.now() - 60_000, editedAt: 0, likes: [], reactions: {},
  comments: [], shares: 0, sharedFrom: '', savedBy: [], groupId: '', pageId: '',
  pageName: '', pageAvatar: '', poll: null, location: '', feeling: '', pinned: false, ...extra
});
const reportRow = (extra = {}) => ({
  reporterId: 'human2', targetType: 'post', targetId: 'post_mine', targetAuthorId: 'human1',
  reason: 'Spam', category: 'spam', status: 'pending', decision: null,
  appeal: { status: 'none' }, targetLabel: 'a post', createdAt: Date.now() - 60_000, ...extra
});

beforeAll(async () => {
  fake = (await import('./fake-supabase.js')).fakeControl;
  fake.reset();
  fake.usersByEmail = {
    'me@example.com': 'human1', 'friend@example.com': 'human2', 'third@example.com': 'human3',
    'four@example.com': 'human4', 'admin@example.com': 'admin1'
  };
  fake.seed('users', 'human1', userRow('Mamun Hossen', 'your.name', 'me@example.com'));
  fake.seed('users', 'human2', userRow('Ayesha Khan', 'ayesha', 'friend@example.com'));
  fake.seed('users', 'human3', userRow('Tanvir Ahmed', 'tanvir', 'third@example.com'));
  fake.seed('users', 'human4', userRow('Rima Begum', 'rima', 'four@example.com'));
  fake.seed('users', 'admin1', userRow('MeetBook Admin', 'admin', 'admin@example.com', 'superadmin'));

  fake.seed('posts', 'post_theirs', postRow('post_theirs', 'human2', 'Ayesha post'));
  fake.seed('posts', 'post_mine', postRow('post_mine', 'human1', 'My post'));
  fake.seed('posts', 'post_pg', postRow('post_pg', 'human2', 'Group post', { groupId: 'g1' }));
  fake.seed('posts', 'post_gdel', postRow('post_gdel', 'human1', 'Doomed group post', { groupId: 'g_del' }));
  fake.seed('posts', 'post_h4', postRow('post_h4', 'human4', 'Rima post'));

  fake.seed('stories', 'story1', { authorId: 'human2', image: '', text: 'Ayesha story', bg: 'sunset', visibility: 'public', audienceIds: [], views: [], createdAt: Date.now() - 60_000 });
  fake.seed('stories', 'story2', { authorId: 'human1', image: '', text: 'My story', bg: 'sunset', visibility: 'public', audienceIds: [], views: [], createdAt: Date.now() - 60_000 });

  const groupRow = (name, privacy, createdBy, members) => ({ name, description: '', privacy, cover: '', createdBy, members, createdAt: Date.now() - 60_000 });
  fake.seed('groups', 'g1', groupRow('Group One', 'public', 'human1', ['human1', 'human2']));
  fake.seed('groups', 'g3', groupRow('Group Three', 'public', 'human2', ['human2']));
  fake.seed('groups', 'g4', groupRow('Group Four', 'private', 'human1', ['human1']));
  fake.seed('groups', 'g_del', groupRow('Doomed Group', 'public', 'human1', ['human1']));
  const reqRow = (userId) => ({ groupId: 'g4', groupOwnerId: 'human1', userId, status: 'pending', createdAt: Date.now() - 60_000 });
  fake.seed('groupRequests', 'g4_human2', reqRow('human2'));
  fake.seed('groupRequests', 'g4_human3', reqRow('human3'));

  fake.seed('pages', 'pg1', { name: 'Ayesha Page', category: 'Community', about: '', avatar: '', cover: '', ownerId: 'human2', followers: [], createdAt: Date.now() - 60_000 });
  fake.seed('pages', 'pg2', { name: 'My Page', category: 'Community', about: '', avatar: '', cover: '', ownerId: 'human1', followers: [], createdAt: Date.now() - 60_000 });

  const eventRow = (title, createdBy) => ({ title, description: '', dateTime: Date.now() + 86_400_000, location: '', cover: '', visibility: 'public', audienceIds: [], createdBy, going: [], interested: [], createdAt: Date.now() - 60_000 });
  fake.seed('events', 'ev1', eventRow('Event One', 'human2'));
  fake.seed('events', 'ev2', eventRow('Event Two', 'human1'));

  fake.seed('conversations', 'conv1', { participants: ['human1', 'human2'], createdAt: Date.now() - 60_000 });
  fake.seed('conversations', 'gconv', { participants: ['human2', 'human3'], isGroup: true, title: 'Invite GC', createdBy: 'human2', joinCode: 'code123', createdAt: Date.now() - 60_000 });
  fake.seed('conversations', 'convAdmin', { participants: ['admin1', 'human2'], createdAt: Date.now() - 60_000 });
  const msgRow = (conversationId, participants, senderId, text, readBy) => ({ conversationId, participants, senderId, text, image: '', audio: '', createdAt: Date.now() - 30_000, status: 'sent', readBy });
  fake.seed('messages', 'msg1', msgRow('conv1', ['human1', 'human2'], 'human2', 'hi', ['human2']));
  fake.seed('messages', 'msg2', msgRow('conv1', ['human1', 'human2'], 'human2', 'again', []));
  fake.seed('messages', 'msg_bad', msgRow('convAdmin', ['admin1', 'human2'], 'human2', 'spam message', ['human2']));
  fake.seed('invites', 'code123', { conversationId: 'gconv', createdBy: 'human2', createdAt: Date.now() - 60_000 });

  fake.seed('reports', 'rep1', reportRow({ reporterId: 'human2', status: 'resolved', decision: { byId: 'admin1', byName: 'MeetBook Admin', at: Date.now() - 50_000, reason: '', outcome: 'content-removed', action: 'resolve' } }));
  fake.seed('reports', 'rep2', reportRow({ reporterId: 'human1', targetType: 'user', targetId: 'human3', targetAuthorId: 'human3' }));
  fake.seed('reports', 'rep3', reportRow({ reporterId: 'human1', targetType: 'message', targetId: 'msg_bad', targetAuthorId: 'human2' }));
  fake.seed('reports', 'rep4', reportRow({
    reporterId: 'human2', status: 'resolved',
    decision: { byId: 'admin1', byName: 'MeetBook Admin', at: Date.now() - 50_000, reason: '', outcome: 'content-removed', action: 'resolve' },
    appeal: { status: 'requested', text: 'Please reconsider', byId: 'human1', byName: 'Mamun Hossen', at: Date.now() - 40_000, reason: '' }
  }));

  fake.seed('botSettings', 'global', { enabled: true });
  fake.seed('config', 'app', { maintenanceMode: false });

  api = await import('../src/api.js');
  api.onAuthReady(() => {});
  await api.login('me@example.com', 'password123');
  await settleDeep();
});

describe('mirror immediacy — posts, stories, groups, pages, events (user session)', () => {
  it('togglePinPost flips the mirror pin at once', async () => {
    expect(mirrorPost('post_pg').pinned).toBe(false);
    expect(await api.togglePinPost('post_pg')).toBe(true);
    expect(mirrorPost('post_pg').pinned).toBe(true); // no settle: the patch, not the refetch
    // Settle between dependent toggles (the friend-request tests'
    // sequencing): a refetch still in flight from the first write
    // could otherwise land mid-second-toggle carrying the pre-write
    // snapshot — the trailing refetch corrects it, but the pin under
    // test is each call's OWN immediacy.
    await settle();
    expect(await api.togglePinPost('post_pg')).toBe(false);
    expect(mirrorPost('post_pg').pinned).toBe(false);
  });

  it('markStoryViewed records the view in the mirror at once', async () => {
    await api.markStoryViewed('story1');
    expect(mirrorStory('story1').views).toContain('human1');
    expect(fake.get('stories', 'story1').views).toContain('human1');
  });

  it('deleteStory removes the story from the mirror at once', async () => {
    await api.deleteStory('story2');
    expect(mirrorStory('story2')).toBeUndefined();
    expect(fake.get('stories', 'story2')).toBeUndefined();
  });

  it('updateGroup patches the mirror at once, and a missing group throws', async () => {
    await api.updateGroup('g1', { description: 'New description' });
    expect(mirrorGroup('g1').description).toBe('New description');
    expect(fake.get('groups', 'g1').description).toBe('New description');
    await expect(api.updateGroup('g_gone', { description: 'x' })).rejects.toThrow();
  });

  it('deleteGroup removes the group and its posts from the mirror at once', async () => {
    await api.deleteGroup('g_del');
    expect(mirrorGroup('g_del')).toBeUndefined();
    expect(mirrorPost('post_gdel')).toBeUndefined();
    expect(fake.get('groups', 'g_del')).toBeUndefined();
  });

  it('toggleGroupMembership flips mirror membership at once (public join + leave)', async () => {
    expect(await api.toggleGroupMembership('g3')).toBe('joined');
    expect(mirrorGroup('g3').members).toContain('human1');
    expect(await api.toggleGroupMembership('g3')).toBe('left');
    expect(mirrorGroup('g3').members).not.toContain('human1');
  });

  it('respondGroupRequest mirrors the decision and the new member at once', async () => {
    expect(await api.respondGroupRequest('g4_human2', true)).toBe('approved');
    expect(mirrorReq('g4_human2').status).toBe('approved');
    expect(mirrorGroup('g4').members).toContain('human2');
    expect(await api.respondGroupRequest('g4_human3', false)).toBe('rejected');
    expect(mirrorReq('g4_human3').status).toBe('rejected');
  });

  it('removeGroupMember drops the member from the mirror at once', async () => {
    await api.removeGroupMember('g1', 'human2');
    expect(mirrorGroup('g1').members).not.toContain('human2');
    expect(fake.get('groups', 'g1').members).not.toContain('human2');
  });

  it('createPage mirrors the new page at once', async () => {
    const pg = await api.createPage({ name: 'Fresh Page', category: 'Community', about: '', avatar: '', cover: '' });
    expect(mirrorPage(pg.id)?.name).toBe('Fresh Page');
    expect(fake.get('pages', pg.id)).toBeTruthy();
  });

  it('updatePage patches the mirror at once, and a missing page throws', async () => {
    await api.updatePage('pg2', { about: 'About v2' });
    expect(mirrorPage('pg2').about).toBe('About v2');
    await expect(api.updatePage('pg_gone', { about: 'x' })).rejects.toThrow();
  });

  it('deletePage removes the page from the mirror at once', async () => {
    const pg = await api.createPage({ name: 'Doomed Page', category: 'Community', about: '', avatar: '', cover: '' });
    await api.deletePage(pg.id);
    expect(mirrorPage(pg.id)).toBeUndefined();
    expect(fake.get('pages', pg.id)).toBeUndefined();
  });

  it('saveReview mirrors create + edit at once, deleteReview removes at once', async () => {
    const saved = await api.saveReview('pg1', { rating: 5, text: 'Great page' });
    const inMirror = () => api.data().reviews.find((r) => r.id === saved.id);
    expect(inMirror()?.rating).toBe(5);
    await api.saveReview('pg1', { rating: 3, text: 'Changed my mind' });
    expect(inMirror()?.rating).toBe(3);
    expect(inMirror()?.text).toBe('Changed my mind');
    await api.deleteReview(saved.id);
    expect(inMirror()).toBeUndefined();
    expect(fake.get('reviews', saved.id)).toBeUndefined();
  });

  it('toggleEventRsvp flips the mirror RSVP lists at once', async () => {
    expect(await api.toggleEventRsvp('ev1', 'going')).toBe(true);
    expect(mirrorEvent('ev1').going).toContain('human1');
    expect(await api.toggleEventRsvp('ev1', 'going')).toBe(false);
    expect(mirrorEvent('ev1').going).not.toContain('human1');
  });

  it('deleteEvent removes the event from the mirror at once', async () => {
    await api.deleteEvent('ev2');
    expect(mirrorEvent('ev2')).toBeUndefined();
    expect(fake.get('events', 'ev2')).toBeUndefined();
  });
});

describe('mirror immediacy — reports, blocks, messaging (user session)', () => {
  it('reportContent files the report into the mirror Support Inbox at once', async () => {
    await api.reportContent('post', 'post_theirs', 'Spam content');
    const filed = api.data().supportReports.find((r) => r.targetId === 'post_theirs' && r.reporterId === 'human1');
    expect(filed).toBeTruthy();
    expect(filed.status).toBe('pending');
  });

  it('toggleBlock mirrors block and unblock at once', async () => {
    expect(await api.toggleBlock('human2')).toBe(true);
    expect(api.data().blocks.some((b) => b.target === 'human2' && b.by === 'human1')).toBe(true);
    // The stored row carries exactly the live table's columns
    // (id/by/target/createdAt) — see tests/blocks-live.test.js.
    expect(Object.keys(fake.get('blocks', 'human1_human2')).sort()).toEqual(['by', 'createdAt', 'id', 'target']);
    expect(await api.toggleBlock('human2')).toBe(false);
    expect(api.data().blocks.some((b) => b.target === 'human2')).toBe(false);
    expect(fake.get('blocks', 'human1_human2')).toBeUndefined();
  });

  it('createGroupConversation mirrors the new conversation at once', async () => {
    const conv = await api.createGroupConversation({ title: 'Test GC', memberIds: ['human2', 'human3'] });
    expect(mirrorConv(conv.id)?.title).toBe('Test GC');
    expect(fake.get('conversations', conv.id)).toBeTruthy();
  });

  it('markConversationRead mirrors readBy/status at once', async () => {
    await api.markConversationRead('conv1');
    expect(mirrorMsg('msg1').readBy).toContain('human1');
    expect(mirrorMsg('msg1').status).toBe('read');
    expect(mirrorMsg('msg2').readBy).toContain('human1');
    expect(fake.get('messages', 'msg1').readBy).toContain('human1');
  });

  it('joinConversationByCode lands the joined conversation in the mirror at once', async () => {
    expect(mirrorConv('gconv')).toBeUndefined();
    const convId = await api.joinConversationByCode('code123');
    expect(convId).toBe('gconv');
    expect(mirrorConv('gconv')?.participants).toContain('human1');
    expect(fake.get('conversations', 'gconv').participants).toContain('human1');
  });

  it('appealReport mirrors the filed appeal at once', async () => {
    await api.appealReport('rep1', 'Please review again');
    expect(mirrorSupport('rep1')?.appeal?.status).toBe('requested');
    expect(mirrorSupport('rep1')?.appeal?.text).toBe('Please review again');
    expect(fake.get('reports', 'rep1').appeal.status).toBe('requested');
  });
});

describe('mirror immediacy — admin session', () => {
  let quillId = '';

  beforeAll(async () => {
    await api.logout();
    await settle();
    await api.login('admin@example.com', 'password123');
    await settleDeep();
  });

  it('adminSetRole patches the mirror user and the audit log at once', async () => {
    await api.adminSetRole('human3', 'moderator');
    expect(mirrorUser('human3').role).toBe('moderator');
    expect(fake.get('users', 'human3').role).toBe('moderator');
    // logAdminAction's own mirror pin: the entry is in the Admin
    // Logs mirror slice in the same call stack, not on the refetch.
    expect(api.data().adminLogs.some((l) => l.action === 'set-role' && l.targetId === 'human3')).toBe(true);
  });

  it('adminSetUserStatus patches the mirror at once', async () => {
    await api.adminSetUserStatus('human3', 'suspended');
    expect(mirrorUser('human3').status).toBe('suspended');
    await api.adminSetUserStatus('human3', 'active');
    expect(mirrorUser('human3').status).toBe('active');
  });

  it('adminSetVerified patches the mirror at once', async () => {
    await api.adminSetVerified('human3', true);
    expect(mirrorUser('human3').verified).toBe(true);
    expect(fake.get('users', 'human3').verified).toBe(true);
  });

  it('adminDecideReport mirrors the decision at once', async () => {
    const res = await api.adminDecideReport('rep2', 'resolve', { outcome: 'user-warned', reason: 'First warning' });
    expect(res.status).toBe('resolved');
    expect(mirrorReport('rep2').status).toBe('resolved');
    expect(mirrorReport('rep2').decision.outcome).toBe('user-warned');
    expect(fake.get('reports', 'rep2').status).toBe('resolved');
  });

  it('adminDecideReport content-removed (message) drops the message from the mirror at once', async () => {
    expect(mirrorMsg('msg_bad')).toBeTruthy();
    await api.adminDecideReport('rep3', 'resolve', { outcome: 'content-removed' });
    expect(mirrorMsg('msg_bad')).toBeUndefined();
    expect(fake.get('messages', 'msg_bad')).toBeUndefined();
  });

  it('adminSetReportAppeal mirrors the appeal decision at once', async () => {
    const appeal = await api.adminSetReportAppeal('rep4', 'accepted', 'Overturned');
    expect(appeal.status).toBe('accepted');
    expect(mirrorReport('rep4').appeal.status).toBe('accepted');
    expect(fake.get('reports', 'rep4').appeal.status).toBe('accepted');
  });

  it('adminSetMaintenance flips the mirrored config at once', async () => {
    await api.adminSetMaintenance(true);
    expect(api.data().config.maintenanceMode).toBe(true);
    await api.adminSetMaintenance(false);
    expect(api.data().config.maintenanceMode).toBe(false);
  });

  it('adminSavePlatformSettings merges into the mirrored config at once', async () => {
    await api.adminSavePlatformSettings({ platformName: 'MeetBook QA' });
    expect(api.data().config.platformName).toBe('MeetBook QA');
    expect(fake.get('config', 'app').platformName).toBe('MeetBook QA');
  });

  it('announcements mirror create, (de)activation and delete at once', async () => {
    const ann = await api.createAnnouncement({ title: 'Hello', body: 'Big news' });
    const inMirror = () => api.data().announcements.find((a) => a.id === ann.id);
    expect(inMirror()?.title).toBe('Hello');
    await api.setAnnouncementActive(ann.id, false);
    expect(inMirror()?.active).toBe(false);
    await api.deleteAnnouncement(ann.id);
    expect(inMirror()).toBeUndefined();
    expect(fake.get('announcements', ann.id)).toBeUndefined();
  });

  it('saveBot mirrors the bot, its brain stamp and its public profile at once', async () => {
    const saved = await api.saveBot({
      name: 'Quill', username: 'quill.bot', bio: 'Quiet book bot.', avatar: '',
      personality: { traits: ['calm'], tone: 'soft', interests: ['books'], systemPrompt: 'You are Quill.' }
    });
    quillId = saved.id;
    expect(api.data().bots.find((b) => b.id === quillId)?.name).toBe('Quill');
    expect(api.data().botBrains[quillId]?.systemPrompt).toBe('You are Quill.');
    expect(mirrorUser(quillId)?.username).toBe('quill.bot');
    const updated = await api.saveBot({ ...saved, bio: 'Updated bio.' });
    expect(updated.id).toBe(quillId);
    expect(api.data().bots.find((b) => b.id === quillId)?.bio).toBe('Updated bio.');
    expect(mirrorUser(quillId)?.bio).toBe('Updated bio.');
  });

  it('addBotMemory / deleteBotMemory mirror the memory list at once', async () => {
    const entry = await api.addBotMemory(quillId, 'Likes rainy-day poems.');
    expect((api.data().botMemories[quillId] || []).some((m) => m.id === entry.id)).toBe(true);
    await api.deleteBotMemory(quillId, entry.id);
    expect((api.data().botMemories[quillId] || []).some((m) => m.id === entry.id)).toBe(false);
    expect(fake.get('botMemories', quillId).items).toEqual([]);
  });

  it('setGlobalBotEnabled flips the mirrored kill switch at once', async () => {
    await api.setGlobalBotEnabled(false);
    expect(api.data().botSettings.global.enabled).toBe(false);
    await api.setGlobalBotEnabled(true);
    expect(api.data().botSettings.global.enabled).toBe(true);
  });

  it('deleteBot mirrors the teardown at once', async () => {
    await api.deleteBot(quillId);
    expect(api.data().bots.some((b) => b.id === quillId)).toBe(false);
    expect(mirrorUser(quillId)).toBeUndefined();
    expect(api.data().botBrains[quillId]).toBeUndefined();
    expect(fake.get('bots', quillId)).toBeUndefined();
  });

  it('adminDeleteUser removes the user and their posts from the mirror at once', async () => {
    await api.adminDeleteUser('human4');
    expect(mirrorUser('human4')).toBeUndefined();
    expect(mirrorPost('post_h4')).toBeUndefined();
    expect(fake.get('users', 'human4')).toBeUndefined();
    expect(fake.get('posts', 'post_h4')).toBeUndefined();
  });
});

// Super Admin Pack C — Bot Control Center details tabs, announcements,
// platform settings + registration gate, system health, Gemini model
// threading. View tests run against synthetic fixtures; the API tests
// run the REAL api.js in demo mode (firebase mocked out), mirroring
// tests/admin-pack-a/b.
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

import { botConversationSummaries, recordClientError } from '../src/utils.js';
import { generateGeminiText, botModel, GEMINI_MODEL } from '../src/gemini.js';
import { normaliseBot } from '../src/botLogic.js';

let V;
let api;

beforeAll(async () => {
  V = await import('../src/views.js');
  api = await import('../src/api.js');
  await api.login('admin@meetbook.app', 'admin123'); // demo admin session
});

// ------------------------------------------------------------ fixtures
const NOW = Date.now();
const admin = { id: 'u_admin', name: 'MeetBook Admin', username: 'admin.team', email: 'admin@meetbook.app', role: 'admin', isBot: false };
const botFixture = {
  id: 'bot_x', name: 'TestBot', username: 'test.bot', avatar: '', bio: 'A fixture bot.',
  model: 'gemini-1.5-flash', active: true, createdAt: NOW - 10 * 24 * 3600_000,
  personality: { traits: ['curious'], tone: 'bright', interests: ['space'], systemPrompt: 'You are TestBot, a fixture AI bot.' },
  limits: { postsPerDay: 3, commentsPerDay: 10, likesPerDay: 20, messagesPerDay: 5, minIntervalMs: 900000 }
};
const fixtureD = {
  users: [
    admin,
    { id: 'u_h', name: 'Hasan Human', username: 'hasan.h', role: 'user', isBot: false },
    { id: 'bot_x', name: 'TestBot', username: 'test.bot', role: 'bot', isBot: true }
  ],
  bots: [botFixture],
  botBrains: { bot_x: { botId: 'bot_x', systemPrompt: 'You are TestBot, a fixture AI bot.', provider: 'gemini', model: 'gemini-1.5-flash', updatedAt: NOW - 3600_000 } },
  botMemories: { bot_x: [{ id: 'mem1', text: 'TestBot remembers the fixture comet.', createdAt: NOW - 1000, updatedAt: NOW - 1000, pinned: true }] },
  posts: [
    { id: 'p_bot', authorId: 'bot_x', text: 'A generated fixture post about comets.', image: '', visibility: 'public', audienceIds: [], createdAt: NOW - 7200_000, likes: [], reactions: {}, comments: [], shares: 0, savedBy: [] },
    { id: 'p_h', authorId: 'u_h', text: 'A human post.', image: '', visibility: 'public', audienceIds: [], createdAt: NOW - 8000_000, likes: [], reactions: {}, comments: [{ id: 'c1', authorId: 'bot_x', text: 'A bot comment on the human post.', createdAt: NOW - 7000_000, replies: [] }], shares: 0, savedBy: [] }
  ],
  conversations: [{ id: 'conv_x', participants: ['u_h', 'bot_x'], isGroup: false, createdAt: NOW - 9000_000 }],
  messages: [
    { id: 'm1', conversationId: 'conv_x', participants: ['u_h', 'bot_x'], senderId: 'u_h', text: 'PRIVATE_BODY_SHOULD_NOT_RENDER', createdAt: NOW - 8000_000, readBy: [] },
    { id: 'm2', conversationId: 'conv_x', participants: ['u_h', 'bot_x'], senderId: 'bot_x', text: 'A bot reply body.', createdAt: NOW - 7000_000, readBy: [] }
  ],
  botActivities: [{ id: 'a1', botId: 'bot_x', action: 'post', detail: 'Posted about comets.', createdAt: NOW - 7200_000, status: 'ok' }],
  botLogs: [{ id: 'l1', botId: 'bot_x', level: 'info', message: 'Fixture log line.', createdAt: NOW - 7200_000 }],
  botSettings: { global: { enabled: true }, counters: { bot_x: { postsToday: 1, commentsToday: 2, likesToday: 3, messagesToday: 1, lastActionAt: NOW - 3600_000 } } },
  botSecrets: { geminiApiKey: '' },
  aiUsage: { callsToday: 4, tokensToday: 900, updatedAt: NOW },
  reports: [], announcements: [], conversationsMeta: {}
};

// ------------------------------------------------------- model threading
describe('Gemini model threading', () => {
  it('normaliseBot keeps the per-bot model and defaults to empty', () => {
    expect(normaliseBot({ name: 'A', model: 'gemini-1.5-flash' }).model).toBe('gemini-1.5-flash');
    expect(normaliseBot({ name: 'A' }).model).toBe('');
    expect(botModel({ model: 'gemini-1.5-flash' })).toBe('gemini-1.5-flash');
    expect(botModel({})).toBe(GEMINI_MODEL);
    expect(botModel(null)).toBe(GEMINI_MODEL);
  });

  it('generateGeminiText calls the bot\'s own model in the provider URL', async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: true, status: 200,
      json: async () => ({ candidates: [{ content: { parts: [{ text: 'Generated!' }] } }] })
    }));
    const text = await generateGeminiText({
      apiKey: 'KEY', bot: { ...botFixture }, memories: [], context: { kind: 'post' }, fetchImpl
    });
    expect(text).toBe('Generated!');
    const [url] = fetchImpl.mock.calls[0];
    expect(url).toContain('models/gemini-1.5-flash:generateContent');
  });

  it('generateGeminiText falls back to the platform default model when unset', async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: true, status: 200,
      json: async () => ({ candidates: [{ content: { parts: [{ text: 'Default model text' }] } }] })
    }));
    await generateGeminiText({ apiKey: 'KEY', bot: { ...botFixture, model: '' }, memories: [], context: { kind: 'post' }, fetchImpl });
    const [url] = fetchImpl.mock.calls[0];
    expect(url).toContain(`models/${GEMINI_MODEL}:generateContent`);
  });
});

// ------------------------------------------------------- details tabs
describe('botDetailsView tabs', () => {
  const render = (tab) => V.botDetailsView(fixtureD, admin, 'bot_x', tab);

  it('overview shows identity, counters, brain stamp and counts', () => {
    const html = render('overview');
    expect(html).toContain('TestBot');
    expect(html).toContain('gemini'); // brain provider
    expect(html).toContain('A generated fixture post about comets.');
    expect(html).toContain('Posts');
  });

  it('brain tab shows the system prompt editor and provider/model', () => {
    const html = render('brain');
    expect(html).toContain('bot-brain-form');
    expect(html).toContain('You are TestBot, a fixture AI bot.');
    expect(html).toContain('gemini-1.5-flash');
  });

  it('personality tab renders editable traits, tone, interests and bio', () => {
    const html = render('personality');
    expect(html).toContain('bot-personality-form');
    expect(html).toContain('curious');
    expect(html).toContain('bright');
    expect(html).toContain('A fixture bot.');
  });

  it('memory tab lists the bot\'s own memories with add/delete controls', () => {
    const html = render('memory');
    expect(html).toContain('TestBot remembers the fixture comet.');
    expect(html).toContain('data-bot-memory-form="bot_x"');
    expect(html).toContain('bot-memory-delete');
  });

  it('activity tab derives posts, comments and reply counts from data', () => {
    const html = render('activity');
    expect(html).toContain('A generated fixture post about comets.');
    expect(html).toContain('A bot comment on the human post.');
    expect(html).toContain('Posted about comets.'); // botActivities row
  });

  it('conversations tab shows metadata only — never message bodies', () => {
    const html = render('conversations');
    expect(html).toContain('Hasan Human');
    expect(html).toContain('2'); // message count
    expect(html).not.toContain('PRIVATE_BODY_SHOULD_NOT_RENDER');
    expect(html).not.toContain('A bot reply body.');
  });

  it('usage tab shows counters vs limits and the platform-wide AI usage note', () => {
    const html = render('usage');
    expect(html).toContain('platform-wide');
    expect(html).toContain('/ 3 per day'); // posts limit
  });

  it('settings tab has the toggle, limits form with model select, and delete', () => {
    const html = render('settings');
    expect(html).toContain('bot-settings-form');
    expect(html).toContain('bot-toggle');
    expect(html).toContain('bot-delete');
    expect(html).toContain('gemini-1.5-flash'); // model select options/current
  });

  it('logs tab renders this bot\'s log rows', () => {
    expect(render('logs')).toContain('Fixture log line.');
  });

  it('unknown bot and unknown tab degrade gracefully', () => {
    expect(V.botDetailsView(fixtureD, admin, 'nope', 'overview')).toContain('Bot not found');
    expect(render('bogus')).toContain('TestBot'); // falls back to overview
  });
});

// ------------------------------------------------- conversation summaries
describe('botConversationSummaries', () => {
  it('computes counts and last activity from synced data', () => {
    const sums = botConversationSummaries(fixtureD, 'bot_x');
    expect(sums).toHaveLength(1);
    expect(sums[0]).toMatchObject({ id: 'conv_x', otherId: 'u_h', count: 2 });
    expect(sums[0].lastAt).toBe(NOW - 7000_000);
  });

  it('prefers precomputed live metadata (botConvMeta) when present', () => {
    const d2 = { ...fixtureD, botConvMeta: { bot_x: [{ id: 'conv_z', otherId: 'u_h', isGroup: false, count: 9, lastAt: 123 }] } };
    const sums = botConversationSummaries(d2, 'bot_x');
    expect(sums).toEqual([{ id: 'conv_z', otherId: 'u_h', isGroup: false, count: 9, lastAt: 123 }]);
  });
});

// ------------------------------------------------------- memory via api
describe('bot memory add/delete (demo path, audited)', () => {
  it('adds and deletes a memory for a bot and writes audit entries', async () => {
    const before = api.data().botMemories.bot_nova.length;
    const entry = await api.addBotMemory('bot_nova', 'Nova fixture memory for Pack C.');
    expect(api.data().botMemories.bot_nova.some((m) => m.id === entry.id)).toBe(true);
    expect(api.data().botMemories.bot_nova.length).toBe(before + 1);
    await api.deleteBotMemory('bot_nova', entry.id);
    expect(api.data().botMemories.bot_nova.some((m) => m.id === entry.id)).toBe(false);
    const actions = api.data().adminLogs.map((l) => l.action);
    expect(actions).toContain('bot-memory-add');
    expect(actions).toContain('bot-memory-delete');
  });
});

// ------------------------------------------------------- announcements
describe('announcements', () => {
  it('the seeded announcement renders in the feed banner for a user', () => {
    const d = api.data();
    const ayesha = d.users.find((u) => u.id === 'u_ayesha');
    const banner = V.announcementsHtml(d, ayesha);
    expect(banner).toContain('Welcome to MeetBook');
    const feed = V.feedView(d, ayesha, 1);
    expect(feed).toContain('Welcome to MeetBook');
  });

  it('create → banner shows it; dismiss → banner hides it for that user only', async () => {
    const ann = await api.createAnnouncement({ title: 'Pack C maintenance window', body: 'Brief downtime tonight.' });
    const d = api.data();
    expect(d.announcements.some((a) => a.id === ann.id && a.active)).toBe(true);
    const ayesha = d.users.find((u) => u.id === 'u_ayesha');
    expect(V.announcementsHtml(d, ayesha)).toContain('Pack C maintenance window');
    await api.updateSettings('u_ayesha', { dismissedAnnouncements: [ann.id] });
    const d2 = api.data();
    const ayesha2 = d2.users.find((u) => u.id === 'u_ayesha');
    expect(V.announcementsHtml(d2, ayesha2)).not.toContain('Pack C maintenance window');
    const tanvir = d2.users.find((u) => u.id === 'u_tanvir');
    expect(V.announcementsHtml(d2, tanvir)).toContain('Pack C maintenance window');
    expect(d2.adminLogs.some((l) => l.action === 'announcement-create')).toBe(true);
  });

  it('rate guard refuses a second announcement within a minute', async () => {
    await expect(api.createAnnouncement({ title: 'Too soon', body: 'spam' })).rejects.toThrow(/wait a minute/);
  });

  it('toggle + delete work and are audited', async () => {
    const target = api.data().announcements.find((a) => a.title === 'Pack C maintenance window');
    await api.setAnnouncementActive(target.id, false);
    expect(api.data().announcements.find((a) => a.id === target.id).active).toBe(false);
    await api.deleteAnnouncement(target.id, 'test cleanup');
    expect(api.data().announcements.some((a) => a.id === target.id)).toBe(false);
    const actions = api.data().adminLogs.map((l) => l.action);
    expect(actions).toContain('announcement-deactivate');
    expect(actions).toContain('announcement-delete');
  });

  it('adminNotifyUser writes a normal notification for exactly one user', async () => {
    const before = api.data().notifications.filter((n) => n.userId === 'u_priya').length;
    await api.adminNotifyUser('u_priya', { title: 'Hello Priya', body: 'A direct admin note.' });
    const mine = api.data().notifications.filter((n) => n.userId === 'u_priya');
    expect(mine.length).toBe(before + 1);
    expect(mine[0].text).toContain('Hello Priya');
    expect(mine[0].type).toBe('admin');
    expect(api.data().adminLogs.some((l) => l.action === 'notify-user')).toBe(true);
  });

  it('non-admins cannot create announcements', async () => {
    await api.login('ayesha@example.com', 'demo123');
    await expect(api.createAnnouncement({ title: 'Nope', body: 'nope' })).rejects.toThrow(/Admins only/);
    await api.login('admin@meetbook.app', 'admin123');
  });
});

// ------------------------------------------------------------- health
describe('adminHealthView', () => {
  it('renders honest statuses, document counts and recorded client errors', () => {
    recordClientError('Fixture boom error');
    const html = V.adminHealthView(fixtureD, admin, { firebase: false, projectId: 'meetbook-d8a44' });
    expect(html).toContain('meetbook-d8a44');
    expect(html).toContain('Not deployed. The bot engine runs from the bot runner');
    expect(html).toContain('hosted on Cloudinary');
    expect(html).toContain('Document counts only');
    expect(html).toContain('Fixture boom error');
  });

  it('shows the checking state when no probe has run in live mode', () => {
    const html = V.adminHealthView({ ...fixtureD, healthProbe: null }, admin, { firebase: true, projectId: 'meetbook-d8a44' });
    expect(html).toContain('No probe yet');
  });

  it('shows a failed probe honestly', () => {
    const d2 = { ...fixtureD, healthProbe: { ok: false, ms: 12, at: NOW, error: 'permission-denied' } };
    const html = V.adminHealthView(d2, admin, { firebase: true, projectId: 'meetbook-d8a44' });
    expect(html).toContain('Check failed');
    expect(html).toContain('permission-denied');
  });
});

// ------------------------------------------- platform settings + register
describe('platform settings and the registration gate', () => {
  it('saves platform name + default language and audits the save', async () => {
    await api.adminSavePlatformSettings({ platformName: 'MeetBook Test', defaultLanguage: 'bn' });
    expect(api.data().config.platformName).toBe('MeetBook Test');
    expect(api.data().config.defaultLanguage).toBe('bn');
    expect(api.data().adminLogs.some((l) => l.action === 'settings-save')).toBe(true);
  });

  it('rejects an empty platform name', async () => {
    await expect(api.adminSavePlatformSettings({ platformName: '   ' })).rejects.toThrow(/cannot be empty/);
  });

  it('closed registration refuses new accounts (client gate); reopening restores it', async () => {
    await api.adminSavePlatformSettings({ registrationOpen: false });
    expect(api.data().config.registrationOpen).toBe(false);
    await expect(api.register({
      name: 'Blocked User', username: 'blocked.user', email: 'blocked@example.com', password: 'demo123'
    })).rejects.toThrow(/Registration is currently closed/);
    await api.adminSavePlatformSettings({ registrationOpen: true });
    const created = await api.register({
      name: 'Allowed User', username: 'allowed.user', email: 'allowed@example.com', password: 'demo123'
    });
    expect(created.username).toBe('allowed.user');
    // Registration signed us in as the new user — restore the admin session.
    await api.login('admin@meetbook.app', 'admin123');
  });
});

import { describe, it, expect, vi } from 'vitest';
import * as V from '../src/views.js';
import { userNameHtml, postCardHtml } from '../src/components.js';
import { buildBotPrompt, templateBotMessageReply, normaliseBot, BOT_PRESENCE_RULES } from '../src/botLogic.js';
import { buildGeminiPrompt } from '../src/gemini.js';

// Bot Natural Presence pack (owner rule, 2026-11-22): in every normal
// user surface a bot account renders EXACTLY like a human user — no AI
// badge, no "AI Bot" label, no special "Chat with bot" action, no
// "AI Bot post ·" text stamp, no "(AI Bot)" notification label. Bot
// identification survives ONLY in the Admin panel. The bot prompts
// carry the matching behaviour rule: never announce being an AI, but
// answer honestly when DIRECTLY asked whether it is human / a bot.

vi.mock('../src/firebase.js', () => ({
  firebaseReady: false, isFirebaseConfigured: false, firebaseConfig: {},
  app: null, auth: null, db: null, storage: null, googleProvider: null
}));

const NOW = Date.now();
const H = 3600_000;

const me = { id: 'u_me', name: 'Mamun Hossen', username: 'md.mamun', email: 'me@example.com', role: 'user', isBot: false, online: true, followers: [], following: [], closeFriends: [], settings: {}, createdAt: NOW - 90 * 24 * H };
const admin = { id: 'u_admin', name: 'MeetBook Official', username: 'meetbook.official', email: 'admin@example.com', role: 'superadmin', isBot: false, online: true, followers: [], following: [], closeFriends: [], settings: {}, createdAt: NOW - 90 * 24 * H };
const human = { id: 'u_hasan', name: 'Hasan Ali', username: 'hasan', email: 'h@example.com', role: 'user', isBot: false, online: true, followers: [], following: [], closeFriends: [], settings: {}, createdAt: NOW - 30 * 24 * H };
const botUser = { id: 'bot_nova', name: 'Nova', username: 'nova.bot', email: '', role: 'bot', isBot: true, botId: 'bot_nova', online: true, lastSeen: NOW, bio: 'Curious about space, science and big questions.', followers: [], following: [], closeFriends: [], settings: {}, createdAt: NOW - 20 * 24 * H };
const botDef = {
  id: 'bot_nova', name: 'Nova', username: 'nova.bot', avatar: '', bio: botUser.bio, active: true,
  provider: '', model: '',
  personality: { traits: ['curious', 'witty'], tone: 'bright and playful', interests: ['space', 'science'], systemPrompt: 'You are Nova, a curious member of MeetBook who loves space and science.' },
  limits: { postsPerDay: 3, commentsPerDay: 10, likesPerDay: 20, messagesPerDay: 5, minIntervalMs: 900000 },
  createdAt: NOW - 20 * 24 * H
};

const botPost = {
  id: 'p_bot', authorId: 'bot_nova', text: 'A new exoplanet was found nearby. What would you name it?', image: '', visibility: 'public', audienceIds: [],
  createdAt: NOW - 2 * H, editedAt: 0, likes: [], reactions: {}, shares: 0, sharedFrom: '', savedBy: [], groupId: '', pageId: '', pageName: '', pageAvatar: '',
  comments: [
    { id: 'c_h', authorId: 'u_hasan', text: 'I would call it Nova Prime!', createdAt: NOW - H, replies: [] },
    { id: 'c_b', authorId: 'bot_nova', text: 'Ha, I like that name!', createdAt: NOW - H / 2, replies: [] }
  ]
};
const humanPost = {
  id: 'p_hum', authorId: 'u_hasan', text: 'Morning walk by the river today.', image: '', visibility: 'public', audienceIds: [],
  createdAt: NOW - 3 * H, editedAt: 0, likes: [], reactions: {}, shares: 0, sharedFrom: '', savedBy: [], groupId: '', pageId: '', pageName: '', pageAvatar: '',
  comments: [{ id: 'c_b2', authorId: 'bot_nova', text: 'Sounds peaceful!', createdAt: NOW - 2 * H, replies: [] }]
};

const d = {
  users: [me, admin, human, botUser],
  posts: [botPost, humanPost],
  friendships: [],
  conversations: [{ id: 'conv_bot', participants: ['u_me', 'bot_nova'], isGroup: false, createdAt: NOW - 5 * H }],
  messages: [
    { id: 'm1', conversationId: 'conv_bot', participants: ['u_me', 'bot_nova'], senderId: 'bot_nova', text: 'Hi! Seen any good stars lately?', image: '', audio: '', createdAt: NOW - 4 * H, status: 'read', readBy: ['u_me', 'bot_nova'] },
    { id: 'm2', conversationId: 'conv_bot', participants: ['u_me', 'bot_nova'], senderId: 'u_me', text: 'Not yet, too cloudy.', image: '', audio: '', createdAt: NOW - 3 * H, status: 'read', readBy: ['u_me', 'bot_nova'] }
  ],
  notifications: [
    { id: 'n1', userId: 'u_me', type: 'comment', actorId: 'bot_nova', text: 'Nova commented on your post.', postId: 'p_hum', conversationId: '', read: false, createdAt: NOW - 2 * H }
  ],
  stories: [], groups: [], pages: [], events: [], reports: [], announcements: [],
  bots: [botDef], botBrains: {}, botMemories: { bot_nova: [] }, botActivities: [], botLogs: [],
  botSettings: { counters: {}, global: { enabled: true } }, botSecrets: {}, aiUsage: {}, config: {}
};

const NO_AI_MARKERS = ['badge-bot', 'AI Bot', 'Chat with bot', 'AI Bot post ·', '(AI Bot)'];

describe('Natural Presence — user surfaces carry no AI identification', () => {
  it('userNameHtml renders a bot name with no bot badge (verified badge still works for humans)', () => {
    const html = userNameHtml(botUser);
    expect(html).toContain('Nova');
    for (const m of NO_AI_MARKERS) expect(html).not.toContain(m);
    expect(userNameHtml({ ...human, verified: true })).toContain('badge-verified');
  });

  it('a bot post card and its comments render with no AI badge', () => {
    const usersById = Object.fromEntries(d.users.map((u) => [u.id, u]));
    const html = postCardHtml(botPost, { usersById, me, friendIds: new Set(), pagesById: {} });
    expect(html).toContain('exoplanet');
    expect(html).toContain('Nova Prime!');
    for (const m of NO_AI_MARKERS) expect(html).not.toContain(m);
    // A bot comment on a human post is likewise unmarked.
    const html2 = postCardHtml(humanPost, { usersById, me, friendIds: new Set(), pagesById: {} });
    expect(html2).toContain('Sounds peaceful!');
    for (const m of NO_AI_MARKERS) expect(html2).not.toContain(m);
  });

  it('the feed renders bot posts like any other post', () => {
    const html = V.feedView(d, me);
    expect(html).toContain('exoplanet');
    for (const m of NO_AI_MARKERS) expect(html).not.toContain(m);
  });

  it('chat list + thread header show the bot as a normal contact', () => {
    const list = V.messagesView(d, me);
    expect(list).toContain('Nova');
    for (const m of NO_AI_MARKERS) expect(list).not.toContain(m);
    const thread = V.messagesView(d, me, 'conv_bot');
    expect(thread).toContain('Nova');
    expect(thread).not.toContain('· AI Bot');
    for (const m of NO_AI_MARKERS) expect(thread).not.toContain(m);
  });

  it('a bot profile looks like a human profile — Add Friend included', () => {
    const html = V.profileView(d, me, 'bot_nova');
    expect(html).toContain('Nova');
    expect(html).toContain('data-act="send-request"');
    for (const m of NO_AI_MARKERS) expect(html).not.toContain(m);
  });

  it('friends + search people cards treat the bot like a person', () => {
    const friends = V.friendsView(d, me);
    for (const m of NO_AI_MARKERS) expect(friends).not.toContain(m);
    const search = V.searchView(d, me, 'Nova');
    expect(search).toContain('Nova');
    for (const m of NO_AI_MARKERS) expect(search).not.toContain(m);
  });

  it('notifications from a bot carry no (AI Bot) label', () => {
    const html = V.notificationsView(d, me);
    expect(html).toContain('Nova commented on your post.');
    for (const m of NO_AI_MARKERS) expect(html).not.toContain(m);
  });
});

describe('Natural Presence — prompts carry the behaviour + honesty rules', () => {
  it('the shared presence rules say: never announce, always answer a direct question honestly', () => {
    expect(BOT_PRESENCE_RULES).toContain('Do NOT announce or volunteer that you are an AI');
    expect(BOT_PRESENCE_RULES).toContain('DIRECTLY asks whether you are human');
    expect(BOT_PRESENCE_RULES).toContain('তুমি কি মানুষ?');
    expect(BOT_PRESENCE_RULES).toContain('Never claim to be human when directly asked');
    expect(BOT_PRESENCE_RULES).toContain('honestly and warmly that you are an AI friend on MeetBook');
  });

  it('buildGeminiPrompt includes the rules and no "clearly an AI" framing', () => {
    const prompt = buildGeminiPrompt(botDef, [], { kind: 'post' });
    expect(prompt).toContain('Do NOT announce or volunteer that you are an AI');
    expect(prompt).toContain('Never claim to be human when directly asked');
    expect(prompt).not.toContain('clearly an AI');
    expect(prompt).not.toContain('an AI bot on MeetBook');
  });

  it('buildBotPrompt includes the rules and drops the old "identify as an AI bot" line', () => {
    const prompt = buildBotPrompt(botDef, [], 'a post about cricket');
    expect(prompt).toContain('Do NOT announce or volunteer that you are an AI');
    expect(prompt).toContain('DIRECTLY asks whether you are human');
    expect(prompt).not.toContain('identify as an AI bot when asked');
  });

  it('the default system prompt no longer frames the bot as an AI', () => {
    const fresh = normaliseBot({ name: 'Rio' });
    expect(fresh.personality.systemPrompt).toContain('Rio');
    expect(fresh.personality.systemPrompt).not.toContain('AI');
  });

  it('template DM replies stay natural — except a direct question, which gets the honest answer', () => {
    const casual = templateBotMessageReply(botDef, 'I bought a new telescope!');
    expect(casual).not.toContain('AI bot');
    expect(casual).not.toContain('an AI');
    const askedEn = templateBotMessageReply(botDef, 'Wait — are you a bot?');
    expect(askedEn).toContain('I am an AI friend');
    const askedBn = templateBotMessageReply(botDef, 'তুমি কি মানুষ?');
    expect(askedBn).toContain('I am an AI friend');
  });
});

describe('Natural Presence — Admin still identifies bots fully', () => {
  it('the Bot Control Center keeps the AI Bot badge and panel heading', () => {
    const html = V.botsView(d, admin);
    expect(html).toContain('AI Bot Admin Panel');
    expect(html).toContain('badge-bot');
    expect(html).toContain('AI Bot');
  });

  it('the admin bot detail header keeps the AI Bot badge', () => {
    const html = V.botDetailsView(d, admin, 'bot_nova', 'overview');
    expect(html).toContain('badge-bot');
  });

  it('the admin users table still marks the bot row with 🤖', () => {
    const html = V.adminUsersView(d, admin, {});
    expect(html).toContain('🤖');
  });
});

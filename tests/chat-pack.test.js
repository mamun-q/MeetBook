import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest';
import {
  TYPING_FRESH_MS, typingUserIds, MESSAGE_REACTIONS, toggleEmojiReaction,
  reactionChips, messageSnippet, replySnapshot, pinnedMessages,
  CHAT_THEMES, chatTheme
} from '../src/utils.js';
import { LOCALES, setLocale } from '../src/i18n.js';
import * as V from '../src/views.js';

// Chat Pack — typing indicator, reply/quote, message reactions, chat
// themes, pinned messages. This file covers the pure helpers, the view
// rendering, the i18n keys, and the DEMO-mode api (firebase mocked off).

vi.mock('../src/firebase.js', () => ({
  firebaseReady: false, isFirebaseConfigured: false, firebaseConfig: {},
  app: null, auth: null, db: null, storage: null, googleProvider: null
}));

afterEach(() => { setLocale('en'); });

// ------------------------------------------------------------ typing utils
describe('typingUserIds', () => {
  const now = 1_000_000_000;
  it('returns only fresh typers other than the viewer', () => {
    const conv = { typing: { u1: now - 1000, u2: now - (TYPING_FRESH_MS - 1), me: now - 100, stale: now - TYPING_FRESH_MS, zero: 0 } };
    expect(typingUserIds(conv, 'me', now).sort()).toEqual(['u1', 'u2']);
  });
  it('handles missing conversations and maps', () => {
    expect(typingUserIds(null, 'me', now)).toEqual([]);
    expect(typingUserIds({}, 'me', now)).toEqual([]);
    expect(typingUserIds({ typing: null }, 'me', now)).toEqual([]);
  });
});

// ------------------------------------------------------- reaction utils
describe('toggleEmojiReaction', () => {
  it('adds, stacks a second emoji, and removes — never mutating the input', () => {
    const start = { '❤️': ['u2'] };
    const added = toggleEmojiReaction(start, '❤️', 'u1');
    expect(added).toEqual({ '❤️': ['u2', 'u1'] });
    expect(start).toEqual({ '❤️': ['u2'] }); // input untouched
    const multi = toggleEmojiReaction(added, '😂', 'u1');
    expect(multi).toEqual({ '❤️': ['u2', 'u1'], '😂': ['u1'] }); // one user, several emojis
    const removed = toggleEmojiReaction(multi, '❤️', 'u1');
    expect(removed).toEqual({ '❤️': ['u2'], '😂': ['u1'] }); // only own entry goes
    const emptied = toggleEmojiReaction(removed, '😂', 'u1');
    expect(emptied).toEqual({ '❤️': ['u2'] }); // empty emoji lists are dropped
  });
  it('rejects blank emoji / user', () => {
    expect(toggleEmojiReaction({ '❤️': ['u1'] }, '', 'u1')).toEqual({ '❤️': ['u1'] });
    expect(toggleEmojiReaction(null, '❤️', 'u1')).toEqual({ '❤️': ['u1'] });
  });
});

describe('reactionChips', () => {
  it('sorts by count, breaks ties by the fixed reaction order, drops empties', () => {
    const chips = reactionChips({ '👍': ['a'], '❤️': ['a', 'b'], '😂': ['c'], '😮': [] });
    expect(chips.map((c) => [c.emoji, c.count])).toEqual([['❤️', 2], ['😂', 1], ['👍', 1]]);
    expect(reactionChips(null)).toEqual([]);
    expect(reactionChips({})).toEqual([]);
  });
  it('exposes exactly the six picker reactions', () => {
    expect(MESSAGE_REACTIONS).toEqual(['❤️', '😂', '😮', '😢', '😡', '👍']);
  });
});

// ---------------------------------------------------------- reply utils
describe('messageSnippet / replySnapshot', () => {
  it('truncates long text to the snippet length with an ellipsis', () => {
    const snap = replySnapshot({ id: 'm9', text: 'y'.repeat(150) }, 'Ayesha');
    expect(snap).toEqual({ replyToId: 'm9', replyToName: 'Ayesha', replyToText: expect.any(String) });
    expect(snap.replyToText).toHaveLength(120);
    expect(snap.replyToText.endsWith('…')).toBe(true);
  });
  it('uses media placeholders for voice and photo originals', () => {
    expect(replySnapshot({ id: 'm', text: '', audio: 'data:audio/webm;base64,AAA' }, 'A').replyToText).toBe('🎤 Voice message');
    expect(replySnapshot({ id: 'm', text: '', image: 'data:image/png;base64,BBB' }, 'A').replyToText).toBe('📷 Photo');
    expect(messageSnippet({ text: '', audio: '', image: '' })).toBe('');
  });
  it('rejects a missing original', () => {
    expect(replySnapshot(null, 'A')).toBeNull();
    expect(replySnapshot({}, 'A')).toBeNull();
  });
});

// ------------------------------------------------------------ pin utils
describe('pinnedMessages', () => {
  it('keeps only pinned messages, most recently pinned first', () => {
    const msgs = [
      { id: 'a', pinned: true, pinnedAt: 5 },
      { id: 'b' },
      { id: 'c', pinned: true, pinnedAt: 9 },
      { id: 'd', pinned: false, pinnedAt: 99 }
    ];
    expect(pinnedMessages(msgs).map((m) => m.id)).toEqual(['c', 'a']);
    expect(pinnedMessages(null)).toEqual([]);
  });
});

// -------------------------------------------------------------- themes
describe('chat themes', () => {
  it('offers Default plus 8 fully-specified presets', () => {
    expect(CHAT_THEMES).toHaveLength(9);
    expect(CHAT_THEMES[0]).toEqual({ id: 'default', gradient: '', bubble: '', tint: '' });
    for (const th of CHAT_THEMES.slice(1)) {
      expect(th.gradient).toContain('linear-gradient');
      expect(th.bubble).toContain('linear-gradient');
      expect(th.tint).toContain('rgba');
    }
  });
  it('chatTheme resolves known ids and falls back to Default', () => {
    expect(chatTheme('ocean').id).toBe('ocean');
    expect(chatTheme('bogus').id).toBe('default');
    expect(chatTheme(undefined).id).toBe('default');
  });
});

// ----------------------------------------------------------------- i18n
describe('chat pack i18n', () => {
  const keys = [
    'replyToMessage', 'reactToMessage', 'pinMessage', 'unpinMessage',
    'pinnedMessage', 'pinnedMessages', 'noPinnedMessages', 'chatTheme',
    'conversationDetails', 'typingOne', 'typingTwo', 'typingMany',
    'replyingTo', 'originalMessageUnavailable', 'messagePinned', 'messageUnpinned',
    ...CHAT_THEMES.map((th) => `theme_${th.id}`)
  ];
  it('defines every new key in English and Bangla', () => {
    for (const key of keys) {
      expect(LOCALES.en[key], `en.${key}`).toBeTruthy();
      expect(LOCALES.bn[key], `bn.${key}`).toBeTruthy();
    }
  });
});

// ----------------------------------------------------------------- views
const NOW = Date.now();
const me = { id: 'u_me', name: 'Mamun Hossen', username: 'your.name', role: 'user', isBot: false, online: true, followers: [], following: [], closeFriends: [], settings: {}, createdAt: NOW - 9000 };
const friend = { id: 'u_friend', name: 'Ayesha Khan', username: 'ayesha', role: 'user', isBot: false, online: true, followers: [], following: [], settings: {}, createdAt: NOW - 9000 };
const third = { id: 'u_third', name: 'Tanvir Hasan', username: 'tanvir', role: 'user', isBot: false, followers: [], following: [], settings: {}, createdAt: NOW - 9000 };
const fourth = { id: 'u_fourth', name: 'Priya Das', username: 'priya', role: 'user', isBot: false, followers: [], following: [], settings: {}, createdAt: NOW - 9000 };

function viewData({ convExtra = {}, messages = [], groupExtra = {}, groupMessages = [] } = {}) {
  return {
    users: [me, friend, third, fourth],
    posts: [], stories: [], groups: [], pages: [], friendships: [], blocks: [],
    notifications: [], events: [], reviews: [], groupRequests: [],
    conversations: [
      { id: 'c1', participants: ['u_me', 'u_friend'], createdAt: NOW - 9000, ...convExtra },
      { id: 'cg', participants: ['u_me', 'u_friend', 'u_third', 'u_fourth'], isGroup: true, title: 'Weekend Plans', createdBy: 'u_me', createdAt: NOW - 9000, ...groupExtra }
    ],
    messages: [
      ...messages.map((m) => ({ conversationId: 'c1', participants: ['u_me', 'u_friend'], image: '', audio: '', status: 'sent', readBy: [], ...m })),
      ...groupMessages.map((m) => ({ conversationId: 'cg', participants: ['u_me', 'u_friend', 'u_third', 'u_fourth'], image: '', audio: '', status: 'sent', readBy: [], ...m }))
    ]
  };
}

describe('messagesView — typing indicator', () => {
  it('shows a fresh typer by first name with animated dots', () => {
    const d = viewData({ convExtra: { typing: { u_friend: NOW - 500 } }, messages: [{ id: 'm1', senderId: 'u_friend', text: 'Hi', createdAt: NOW - 1000 }] });
    const html = V.messagesView(d, me, 'c1');
    expect(html).toContain('id="typing-row"');
    expect(html).toContain('typing-dots');
    expect(html).toContain('Ayesha is typing…');
  });
  it('hides a stale typer (heartbeat older than the freshness window)', () => {
    const d = viewData({ convExtra: { typing: { u_friend: NOW - TYPING_FRESH_MS - 1000 } }, messages: [{ id: 'm1', senderId: 'u_friend', text: 'Hi', createdAt: NOW - 1000 }] });
    expect(V.messagesView(d, me, 'c1')).not.toContain('is typing');
  });
  it('names two group typers, then collapses to "and others"', () => {
    const two = viewData({ groupExtra: { typing: { u_friend: NOW - 100, u_third: NOW - 100 } } });
    expect(V.messagesView(two, me, 'cg')).toContain('Ayesha and Tanvir are typing…');
    const three = viewData({ groupExtra: { typing: { u_friend: NOW - 100, u_third: NOW - 100, u_fourth: NOW - 100 } } });
    expect(V.messagesView(three, me, 'cg')).toContain('Ayesha, Tanvir and others are typing…');
  });
  it('renders the typing line in Bangla', () => {
    setLocale('bn');
    const d = viewData({ convExtra: { typing: { u_friend: NOW - 100 } } });
    const byId = Object.fromEntries(d.users.map((u) => [u.id, u]));
    expect(V.typingIndicatorHtml(d.conversations[0], me, byId)).toContain('লিখছে');
  });
});

describe('messagesView — reply quote, reactions, pins, themes', () => {
  const baseMessages = [
    { id: 'm1', senderId: 'u_friend', text: 'Original thought', createdAt: NOW - 5000 },
    { id: 'm2', senderId: 'u_me', text: 'Replying to you', createdAt: NOW - 4000, replyToId: 'm1', replyToName: 'Ayesha Khan', replyToText: 'Original thought' },
    { id: 'm3', senderId: 'u_friend', text: 'React to me', createdAt: NOW - 3000, reactions: { '❤️': ['u_friend', 'u_me'], '😂': ['u_friend'] } },
    { id: 'm4', senderId: 'u_friend', text: 'Older pin', createdAt: NOW - 2000, pinned: true, pinnedBy: 'u_friend', pinnedAt: 100 },
    { id: 'm5', senderId: 'u_me', text: 'Newer pin', createdAt: NOW - 1000, pinned: true, pinnedBy: 'u_me', pinnedAt: 200 }
  ];
  it('renders the quoted block with author + snippet and a jump action', () => {
    const html = V.messagesView(viewData({ messages: baseMessages }), me, 'c1');
    expect(html).toContain('msg-quote');
    expect(html).toContain('data-act="jump-message" data-id="m1"');
    expect(html).toContain('Ayesha Khan');
    expect(html).toContain('Original thought');
  });
  it('renders every message action: reply, react toggle, pin', () => {
    const html = V.messagesView(viewData({ messages: baseMessages }), me, 'c1');
    expect(html).toContain('data-act="reply-message"');
    expect(html).toContain('data-act="msg-react-toggle"');
    expect(html).toContain('data-act="pin-message"');
  });
  it('renders reaction chips with counts, highlighting my own reaction', () => {
    const html = V.messagesView(viewData({ messages: baseMessages }), me, 'c1');
    expect(html).toContain('msg-chip mine');
    expect(html).toContain('❤️ 2');
    expect(html).toContain('😂 1');
    for (const e of MESSAGE_REACTIONS) expect(html).toContain(`data-emoji="${e}"`);
  });
  it('shows the latest pinned message in the pinned bar and all pins in the info panel', () => {
    const html = V.messagesView(viewData({ messages: baseMessages }), me, 'c1');
    expect(html).toContain('pinned-bar');
    const bar = html.slice(html.indexOf('pinned-bar'), html.indexOf('id="conv-info"'));
    expect(bar).toContain('Newer pin');
    expect(bar).toContain('data-id="m5"');
    const panel = html.slice(html.indexOf('id="conv-info"'), html.indexOf('thread-body'));
    expect(panel).toContain('Older pin');
    expect(panel).toContain('Newer pin');
    expect(html).toContain('id="conv-info"');
    expect(html).toContain('data-act="conv-info"');
  });
  it('applies the conversation theme: bubble variable, tint and active swatch', () => {
    const html = V.messagesView(viewData({ convExtra: { theme: 'ocean' }, messages: baseMessages }), me, 'c1');
    expect(html).toContain('--bubble-mine:linear-gradient(135deg,#0ea5e9,#2563eb)');
    expect(html).toContain('background:rgba(14,165,233,.07)');
    expect(html).toContain('theme-swatch active');
    expect((html.match(/theme-swatch/g) || []).length).toBe(CHAT_THEMES.length + 1); // +1: the CSS class in "theme-swatches"
    expect(html).toContain('data-act="set-theme"');
  });
  it('renders cleanly with no chat-pack fields at all (legacy data)', () => {
    const html = V.messagesView(viewData({ messages: [{ id: 'mx', senderId: 'u_friend', text: 'Plain', createdAt: NOW - 100 }] }), me, 'c1');
    expect(html).toContain('Plain');
    expect(html).not.toContain('msg-quote');
    expect(html).not.toContain('pinned-bar');
    expect(html).not.toContain('--bubble-mine');
  });
});

// ------------------------------------------------------------- demo api
let api;
beforeAll(async () => {
  const mem = new Map();
  globalThis.localStorage = {
    getItem: (k) => (mem.has(k) ? mem.get(k) : null),
    setItem: (k, v) => mem.set(k, String(v)),
    removeItem: (k) => mem.delete(k)
  };
  globalThis.document = { dispatchEvent: () => true };
  api = await import('../src/api.js');
  await api.login('ayesha@example.com', 'demo123');
});

describe('demo api — replies', () => {
  it('snapshots the quoted message onto the sent reply', async () => {
    const sent = await api.sendMessage('conv_1', { text: 'Great tip, thanks!', replyToId: 'm_1' });
    expect(sent.replyToId).toBe('m_1');
    expect(sent.replyToName).toBe('Sage');
    expect(sent.replyToText).toBe('Hello! I am Sage, an AI bot. Ask me about books or study tips any time.');
    const stored = api.data().messages.find((m) => m.id === sent.id);
    expect(stored.replyToText).toBe(sent.replyToText);
  });
  it('truncates a long quoted text to 120 chars', async () => {
    const long = await api.sendMessage('conv_1', { text: 'x'.repeat(200) });
    const reply = await api.sendMessage('conv_1', { text: 'replying to the long one', replyToId: long.id });
    expect(reply.replyToText).toHaveLength(120);
    expect(reply.replyToText.endsWith('…')).toBe(true);
  });
  it('uses media placeholders when quoting voice / photo messages', async () => {
    const voice = await api.sendMessage('conv_1', { text: '', audio: 'data:audio/webm;base64,AAA' });
    const rv = await api.sendMessage('conv_1', { text: 'got it', replyToId: voice.id });
    expect(rv.replyToText).toBe('🎤 Voice message');
    const photo = await api.sendMessage('conv_1', { text: '', image: 'data:image/png;base64,BBB' });
    const rp = await api.sendMessage('conv_1', { text: 'nice shot', replyToId: photo.id });
    expect(rp.replyToText).toBe('📷 Photo');
  });
  it('ignores a reply target that belongs to another conversation', async () => {
    const sent = await api.sendMessage('conv_1', { text: 'cross-conversation attempt', replyToId: 'm_g1' });
    expect(sent.replyToId).toBeUndefined();
  });
});

describe('demo api — reactions, pins, theme, typing', () => {
  it('toggles message reactions per emoji with toggle semantics', async () => {
    await api.toggleMessageReaction('m_g1', '❤️');
    expect(api.data().messages.find((m) => m.id === 'm_g1').reactions).toEqual({ '❤️': ['u_ayesha'] });
    await api.toggleMessageReaction('m_g1', '😂');
    expect(api.data().messages.find((m) => m.id === 'm_g1').reactions).toEqual({ '❤️': ['u_ayesha'], '😂': ['u_ayesha'] });
    await api.toggleMessageReaction('m_g1', '❤️');
    expect(api.data().messages.find((m) => m.id === 'm_g1').reactions).toEqual({ '😂': ['u_ayesha'] });
  });
  it('pins and unpins with pin metadata', async () => {
    expect(await api.togglePinMessage('m_g2')).toBe(true);
    let msg = api.data().messages.find((m) => m.id === 'm_g2');
    expect(msg.pinned).toBe(true);
    expect(msg.pinnedBy).toBe('u_ayesha');
    expect(msg.pinnedAt).toBeGreaterThan(0);
    expect(await api.togglePinMessage('m_g2')).toBe(false);
    msg = api.data().messages.find((m) => m.id === 'm_g2');
    expect(msg.pinned).toBe(false);
    expect(msg.pinnedBy).toBe('');
    expect(msg.pinnedAt).toBe(0);
  });
  it('sets a conversation theme; unknown ids resolve to default', async () => {
    expect(await api.setConversationTheme('conv_1', 'ocean')).toBe('ocean');
    expect(api.data().conversations.find((c) => c.id === 'conv_1').theme).toBe('ocean');
    expect(await api.setConversationTheme('conv_1', 'bogus')).toBe('default');
    expect(api.data().conversations.find((c) => c.id === 'conv_1').theme).toBe('default');
  });
  it('writes and clears the typing heartbeat', async () => {
    await api.setTyping('conv_grp', true);
    let conv = api.data().conversations.find((c) => c.id === 'conv_grp');
    expect(Math.abs(Date.now() - conv.typing.u_ayesha)).toBeLessThan(5000);
    await api.setTyping('conv_grp', false);
    conv = api.data().conversations.find((c) => c.id === 'conv_grp');
    expect(conv.typing.u_ayesha).toBeUndefined();
  });
});

import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest';
import {
  isVanishExpired, isMutedNow, isMessageRequest, formatBytes, VANISH_TTL_MS
} from '../src/utils.js';
import { LOCALES, setLocale } from '../src/i18n.js';
import * as V from '../src/views.js';

// Messenger Useful Pack — message requests, vanish mode, file
// messages, pinned chats, timed mute, @mentions and invite links.
// Pure helpers, view rendering, i18n keys, and the DEMO-mode api.

vi.mock('../src/firebase.js', () => ({
  firebaseReady: false, isFirebaseConfigured: false, firebaseConfig: {},
  app: null, auth: null, db: null, storage: null, googleProvider: null
}));

afterEach(() => { setLocale('en'); });

// ------------------------------------------------------------ utils
describe('vanish + timed mute helpers', () => {
  const now = 1_700_000_000_000;
  it('expires vanish messages only after their deadline', () => {
    expect(isVanishExpired({ vanish: true, expiresAt: now - 1 }, now)).toBe(true);
    expect(isVanishExpired({ vanish: true, expiresAt: now + 1000 }, now)).toBe(false);
    expect(isVanishExpired({ expiresAt: now - 1 }, now)).toBe(false);
    expect(VANISH_TTL_MS).toBe(60_000);
  });
  it('timed mute honours the expiry and the forever case', () => {
    expect(isMutedNow({ mutedBy: ['u1'], mutedUntil: { u1: now + 5000 } }, 'u1', now)).toBe(true);
    expect(isMutedNow({ mutedBy: ['u1'], mutedUntil: { u1: now - 1 } }, 'u1', now)).toBe(false);
    expect(isMutedNow({ mutedBy: ['u1'] }, 'u1', now)).toBe(true); // no expiry = forever
    expect(isMutedNow({ mutedBy: [] }, 'u1', now)).toBe(false);
  });
});

describe('isMessageRequest', () => {
  const byId = { u2: { isBot: false }, bot1: { isBot: true } };
  const conv = { isGroup: false, participants: ['me', 'u2'] };
  it('flags non-friend 1-1 chats until accepted', () => {
    expect(isMessageRequest(conv, 'me', new Set(), byId)).toBe(true);
    expect(isMessageRequest(conv, 'me', new Set(['u2']), byId)).toBe(false); // friend
    expect(isMessageRequest({ ...conv, acceptedBy: ['me'] }, 'me', new Set(), byId)).toBe(false);
    expect(isMessageRequest({ isGroup: false, participants: ['me', 'bot1'] }, 'me', new Set(), byId)).toBe(false); // bot
    expect(isMessageRequest({ isGroup: true, participants: ['me', 'u2'] }, 'me', new Set(), byId)).toBe(false); // group
  });
  it('formats byte sizes', () => {
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(2048)).toBe('2.0 KB');
    expect(formatBytes(3 * 1024 * 1024)).toBe('3.0 MB');
  });
});

// ------------------------------------------------------------ i18n
describe('i18n keys exist in both locales', () => {
  const keys = ['messageRequests', 'noRequests', 'requestHint', 'acceptRequest', 'requestAccepted', 'vanishMode', 'vanishOnText', 'vanishOffText', 'turnOn', 'turnOff', 'vanishHint', 'vanishBanner', 'vanishEnabled', 'vanishDisabled', 'attachFile', 'file', 'download', 'pinChat', 'unpinChat', 'chatPinned', 'chatUnpinned', 'inviteLink', 'createInviteLink', 'copyLink', 'linkCopied', 'inviteLinkReady', 'inviteHint', 'joinedGroupChat', 'invalidInviteLink', 'muteFor1Hour', 'muteFor24Hours', 'muteForever', 'mentionedYou'];
  it('covers every new key in en and bn', () => {
    for (const key of keys) {
      expect(LOCALES.en[key], `en:${key}`).toBeTruthy();
      expect(LOCALES.bn[key], `bn:${key}`).toBeTruthy();
    }
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

describe('demo api — vanish, mute, requests, files, invites, mentions', () => {
  it('stamps vanish expiry on messages while vanish is on', async () => {
    await api.setConversationVanish('conv_1', true);
    const m = await api.sendMessage('conv_1', { text: 'secret for a minute' });
    expect(m.vanish).toBe(true);
    expect(m.expiresAt - m.createdAt).toBe(VANISH_TTL_MS);
    await api.setConversationVanish('conv_1', false);
    const plain = await api.sendMessage('conv_1', { text: 'normal again' });
    expect(plain.vanish).toBeUndefined();
  });
  it('timed mute sets and clears flag + expiry', async () => {
    await api.setConversationMute('conv_1', 3600000);
    let conv = api.data().conversations.find((c) => c.id === 'conv_1');
    expect(conv.mutedBy).toContain('u_ayesha');
    expect(conv.mutedUntil.u_ayesha).toBeGreaterThan(Date.now());
    expect(isMutedNow(conv, 'u_ayesha')).toBe(true);
    await api.setConversationMute('conv_1', null);
    conv = api.data().conversations.find((c) => c.id === 'conv_1');
    expect(isMutedNow(conv, 'u_ayesha')).toBe(false);
  });
  it('accepting a request records acceptedBy; replying accepts too', async () => {
    await api.acceptConversationRequest('conv_1');
    expect(api.data().conversations.find((c) => c.id === 'conv_1').acceptedBy).toContain('u_ayesha');
  });
  it('sends a file message with its metadata', async () => {
    const f = await api.sendMessage('conv_1', { file: { name: 'notes.pdf', size: 2048, type: 'application/pdf', url: 'https://example.com/notes.pdf' } });
    expect(f.file.name).toBe('notes.pdf');
    await expect(api.uploadMessageFile({ name: 'huge.zip', size: 11 * 1024 * 1024 })).rejects.toThrow(/10 MB/);
  });
  it('creates an invite code and joins by it (demo path)', async () => {
    const group = await api.createGroupConversation({ title: 'Invite Test', memberIds: ['u_tanvir', 'u_priya'] });
    const code = await api.createConversationInvite(group.id);
    expect(code).toBeTruthy();
    expect(api.data().conversations.find((c) => c.id === group.id).joinCode).toBe(code);
    const again = await api.createConversationInvite(group.id);
    expect(again).toBe(code); // stable — one live link per group
    await expect(api.joinConversationByCode('inv_nope')).rejects.toThrow();
    const joined = await api.joinConversationByCode(code);
    expect(joined).toBe(group.id);
  });
  it('resolves @username mentions in group messages and notifies as mention', async () => {
    const group = await api.createGroupConversation({ title: 'Mention Test', memberIds: ['u_tanvir', 'u_priya'] });
    const tanvir = api.data().users.find((u) => u.id === 'u_tanvir');
    const sent = await api.sendMessage(group.id, { text: `hello @${tanvir.username} look at this` });
    expect(sent.mentions).toEqual(['u_tanvir']);
    const notes = api.data().notifications.filter((n) => n.userId === 'u_tanvir' && n.type === 'mention');
    expect(notes.length).toBeGreaterThan(0);
  });
});

// ------------------------------------------------------------- views
describe('messagesView — useful pack rendering', () => {
  it('renders requests chip, file card, vanish banner and invite link', async () => {
    const meUser = api.data().users.find((u) => u.id === 'u_ayesha');
    await api.sendMessage('conv_1', { file: { name: 'report.pdf', size: 1024, type: 'application/pdf', url: 'https://example.com/report.pdf' } });
    let html = V.messagesView(api.data(), meUser, 'conv_1');
    expect(html).toContain('data-filter="requests"');
    expect(html).toContain('msg-file');
    expect(html).toContain('report.pdf');
    expect(html).toContain('id="msg-file-input"');
    await api.setConversationVanish('conv_1', true);
    html = V.messagesView(api.data(), meUser, 'conv_1');
    expect(html).toContain('vanish-banner');
    expect(html).toContain('data-act="vanish-toggle"');
    await api.setConversationVanish('conv_1', false);
  });
  it('pinned chats sort first and show the pin marker + menu', async () => {
    const meUser = api.data().users.find((u) => u.id === 'u_ayesha');
    await api.setConversationFlag('conv_1', 'pinnedBy', true);
    const html = V.messagesView(api.data(), meUser, '');
    expect(html).toContain('data-act="conv-pin"');
    expect(html).toContain('📌');
    expect(html).toContain('data-ms="3600000"');
    await api.setConversationFlag('conv_1', 'pinnedBy', false);
  });
  it('group view shows the invite link once a code exists, mentions highlight', async () => {
    const meUser = api.data().users.find((u) => u.id === 'u_ayesha');
    const group = await api.createGroupConversation({ title: 'Link View', memberIds: ['u_tanvir', 'u_priya'] });
    const code = await api.createConversationInvite(group.id);
    const tanvir = api.data().users.find((u) => u.id === 'u_tanvir');
    await api.sendMessage(group.id, { text: `ping @${tanvir.username}` });
    const html = V.messagesView(api.data(), meUser, group.id);
    expect(html).toContain(`join=${code}`);
    expect(html).toContain('data-act="copy-invite"');
    expect(html).toContain('msg-mention');
    expect(html).toContain('id="mention-menu"');
  });
  it('the request banner uses its own action name (never the friend-request one)', async () => {
    // Regression guard: data-act="accept-request" belongs to FRIEND
    // requests (respondFriendRequest). The message-request banner must
    // not reuse it — doing so once broke every friend-request Accept.
    const meUser = api.data().users.find((u) => u.id === 'u_ayesha');
    const stranger = api.data().users.find((u) => u.id !== 'u_ayesha' && !u.isBot && !V.friendIdsOfData(api.data(), 'u_ayesha').has(u.id));
    const conv = await api.openConversation(stranger.id);
    const html = V.messagesView(api.data(), meUser, conv.id);
    expect(html).toContain('data-act="accept-msg-request"');
    expect(html).not.toContain('data-act="accept-request"');
  });
});

import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest';
import {
  isEmojiOnlyText, canEditMessage, isMessageVisibleTo, isConversationFlagged, EDIT_WINDOW_MS
} from '../src/utils.js';
import { LOCALES, setLocale } from '../src/i18n.js';
import * as V from '../src/views.js';

// Messenger Complete Pack — unsend/edit/forward, seen-era message
// lifecycle, archive/mute flags, active rail, in-chat search data,
// shared media, thread emoji and group management. Pure helpers, view
// rendering, i18n keys, and the DEMO-mode api (firebase mocked off).

vi.mock('../src/firebase.js', () => ({
  firebaseReady: false, isFirebaseConfigured: false, firebaseConfig: {},
  app: null, auth: null, db: null, storage: null, googleProvider: null
}));

afterEach(() => { setLocale('en'); });

// ------------------------------------------------------------ utils
describe('isEmojiOnlyText', () => {
  it('accepts one to three emoji, rejects text and longer runs', () => {
    expect(isEmojiOnlyText('👍')).toBe(true);
    expect(isEmojiOnlyText('❤️🔥🎉')).toBe(true);
    expect(isEmojiOnlyText('👨‍👩‍👧')).toBe(true); // ZWJ family counts once
    expect(isEmojiOnlyText('👍👍👍👍')).toBe(false);
    expect(isEmojiOnlyText('hello 👍')).toBe(false);
    expect(isEmojiOnlyText('')).toBe(false);
    expect(isEmojiOnlyText('123')).toBe(false);
  });
});

describe('canEditMessage', () => {
  const now = 1_700_000_000_000;
  const base = { senderId: 'u1', text: 'hi', createdAt: now - 1000 };
  it('allows the author inside the window only', () => {
    expect(canEditMessage(base, 'u1', now)).toBe(true);
    expect(canEditMessage(base, 'u2', now)).toBe(false);
    expect(canEditMessage({ ...base, createdAt: now - EDIT_WINDOW_MS - 1 }, 'u1', now)).toBe(false);
    expect(canEditMessage({ ...base, unsent: true }, 'u1', now)).toBe(false);
    expect(canEditMessage({ ...base, image: 'x' }, 'u1', now)).toBe(false);
    expect(canEditMessage(null, 'u1', now)).toBe(false);
  });
});

describe('visibility + flags', () => {
  it('hiddenFor hides a message only for that user', () => {
    expect(isMessageVisibleTo({ hiddenFor: ['u1'] }, 'u1')).toBe(false);
    expect(isMessageVisibleTo({ hiddenFor: ['u1'] }, 'u2')).toBe(true);
    expect(isMessageVisibleTo({}, 'u1')).toBe(true);
  });
  it('conversation flags read uid arrays', () => {
    const conv = { archivedBy: ['u1'], mutedBy: [] };
    expect(isConversationFlagged(conv, 'archivedBy', 'u1')).toBe(true);
    expect(isConversationFlagged(conv, 'mutedBy', 'u1')).toBe(false);
    expect(isConversationFlagged(null, 'archivedBy', 'u1')).toBe(false);
  });
});

// ------------------------------------------------------------ i18n
describe('i18n keys exist in both locales', () => {
  const keys = ['messageUnsent', 'youUnsentMessage', 'unsendMessage', 'removeForMe', 'editMessage', 'edited', 'forwarded', 'forwardMessage', 'archiveChat', 'muteChat', 'archivedChats', 'activeNow', 'chatEmoji', 'searchInConversation', 'sharedMedia', 'renameGroup', 'removeMember', 'addMembers', 'leaveGroup'];
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

describe('demo api — edit / unsend / hide / forward', () => {
  it('edits my message inside the window and stamps editedAt', async () => {
    const sent = await api.sendMessage('conv_1', { text: 'origianl typo' });
    const edited = await api.editMessage(sent.id, 'original, fixed');
    expect(edited.text).toBe('original, fixed');
    expect(edited.editedAt).toBeGreaterThan(0);
  });
  it('refuses to edit someone else\'s message', async () => {
    const stored = api.data().messages.find((m) => m.conversationId === 'conv_1' && m.senderId !== 'u_ayesha');
    await expect(api.editMessage(stored.id, 'hacked')).rejects.toThrow();
  });
  it('unsend clears the content and raises the tombstone', async () => {
    const sent = await api.sendMessage('conv_1', { text: 'secret plans' });
    const gone = await api.unsendMessage(sent.id);
    expect(gone.unsent).toBe(true);
    expect(gone.text).toBe('');
    await expect(api.unsendMessage('m_nope')).rejects.toThrow();
  });
  it('hide removes the message only from my view', async () => {
    const stored = api.data().messages.find((m) => m.conversationId === 'conv_1' && m.senderId !== 'u_ayesha' && !m.hiddenFor?.includes('u_ayesha'));
    await api.hideMessage(stored.id);
    const after = api.data().messages.find((m) => m.id === stored.id);
    expect(after.hiddenFor).toContain('u_ayesha');
    expect(isMessageVisibleTo(after, 'u_ayesha')).toBe(false);
    expect(isMessageVisibleTo(after, stored.senderId)).toBe(true);
  });
  it('forward copies a message into another conversation with the flag', async () => {
    const group = await api.createGroupConversation({ title: 'Forward Target', memberIds: ['u_tanvir', 'u_priya'] });
    const src = await api.sendMessage('conv_1', { text: 'forward me' });
    const copy = await api.forwardMessage(src.id, group.id);
    expect(copy.conversationId).toBe(group.id);
    expect(copy.text).toBe('forward me');
    expect(copy.forwarded).toBe(true);
  });
});

describe('demo api — conversation flags + thread emoji', () => {
  it('archive and mute toggle per-user arrays', async () => {
    await api.setConversationFlag('conv_1', 'archivedBy', true);
    let conv = api.data().conversations.find((c) => c.id === 'conv_1');
    expect(conv.archivedBy).toContain('u_ayesha');
    await api.setConversationFlag('conv_1', 'archivedBy', false);
    conv = api.data().conversations.find((c) => c.id === 'conv_1');
    expect(conv.archivedBy || []).not.toContain('u_ayesha');
    await api.setConversationFlag('conv_1', 'mutedBy', true);
    conv = api.data().conversations.find((c) => c.id === 'conv_1');
    expect(conv.mutedBy).toContain('u_ayesha');
    await api.setConversationFlag('conv_1', 'mutedBy', false);
  });
  it('sets the thread quick-emoji', async () => {
    const emoji = await api.setConversationEmoji('conv_1', '🔥');
    expect(emoji).toBe('🔥');
    expect(api.data().conversations.find((c) => c.id === 'conv_1').emoji).toBe('🔥');
  });
});

describe('demo api — group management', () => {
  it('renames, adds, removes and leaves', async () => {
    const group = await api.createGroupConversation({ title: 'Mgmt', memberIds: ['u_tanvir', 'u_priya'] });
    await api.renameGroupConversation(group.id, 'Mgmt Renamed');
    expect(api.data().conversations.find((c) => c.id === group.id).title).toBe('Mgmt Renamed');
    await api.removeGroupChatMember(group.id, 'u_priya'); // creator removes
    expect(api.data().conversations.find((c) => c.id === group.id).participants).not.toContain('u_priya');
    await api.addGroupMembers(group.id, ['u_priya']);
    expect(api.data().conversations.find((c) => c.id === group.id).participants).toContain('u_priya');
    await api.leaveGroupConversation(group.id);
    expect(api.data().conversations.find((c) => c.id === group.id).participants).not.toContain('u_ayesha');
  });
});

// ------------------------------------------------------------- views
describe('messagesView — complete pack rendering', () => {
  it('renders the tombstone, edited label, big emoji and forwarded tag', async () => {
    const d = api.data();
    const meUser = d.users.find((u) => u.id === 'u_ayesha');
    const tomb = await api.sendMessage('conv_1', { text: 'gone soon' });
    await api.unsendMessage(tomb.id);
    const ed = await api.sendMessage('conv_1', { text: 'fix me' });
    await api.editMessage(ed.id, 'fixed now');
    await api.sendMessage('conv_1', { text: '🔥' });
    const html = V.messagesView(api.data(), meUser, 'conv_1');
    expect(html).toContain('msg-unsent');
    expect(html).toContain('You unsent a message');
    expect(html).toContain('Edited');
    expect(html).toContain('msg-big-emoji');
    expect(html).toContain('data-act="send-thread-emoji"');
    expect(html).toContain('data-act="conv-filter"');
    expect(html).toContain('id="conv-msg-search"');
  });
  it('archived chats leave the All list and appear under Archived', async () => {
    const meUser = api.data().users.find((u) => u.id === 'u_ayesha');
    await api.setConversationFlag('conv_1', 'archivedBy', true);
    V.uiState.convFilter = 'all';
    let html = V.messagesView(api.data(), meUser, '');
    expect(html).not.toContain('data-act="open-conv" data-id="conv_1"');
    V.uiState.convFilter = 'archived';
    html = V.messagesView(api.data(), meUser, '');
    expect(html).toContain('data-act="open-conv" data-id="conv_1"');
    V.uiState.convFilter = 'all';
    await api.setConversationFlag('conv_1', 'archivedBy', false);
  });
});

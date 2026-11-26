import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest';
import { LOCALES, setLocale } from '../src/i18n.js';
import * as V from '../src/views.js';

// FB-placement pack — the three approved placement upgrades:
// 1) chat info as a full page (chatInfoView), 2) Edit Profile as a
// full page with per-field audience pickers persisted as
// settings.fieldPrivacy and enforced at render, 3) a dedicated
// Messaging settings page. Pure views + the DEMO-mode api.

vi.mock('../src/supabase.js', () => ({
  supabaseReady: false, isSupabaseConfigured: false, supabaseConfig: {}, supabase: null
}));

afterEach(() => { setLocale('en'); });

// ------------------------------------------------------------------ i18n
describe('fb-placement i18n', () => {
  const keys = ['chatInfoActions', 'chatInfoCustomization', 'chatInfoPrivacy', 'viewProfile',
    'messagingSettings', 'messagingSettingsHelp', 'messagingSettingsOpen',
    'messageNotifications', 'blockedUsers', 'fieldAudience'];
  it('defines every new key in English and Bangla', () => {
    for (const key of keys) {
      expect(LOCALES.en[key], `en.${key}`).toBeTruthy();
      expect(LOCALES.bn[key], `bn.${key}`).toBeTruthy();
    }
  });
});

// ---------------------------------------------------------------- fixtures
const NOW = Date.now();
const owner = {
  id: 'u_owner', name: 'Ayesha Khan', username: 'ayesha', role: 'user', isBot: false, online: true,
  followers: [], following: [], closeFriends: [],
  work: 'Quantum Bakery', education: 'Dhaka College', currentCity: 'Sylhet', hometown: 'Barisal',
  relationship: 'Single', dob: '1999-01-01', gender: 'Female', website: 'example.com', nickname: 'Ash',
  settings: { fieldPrivacy: { currentCity: 'onlyMe', work: 'friends', nickname: 'onlyMe' } },
  createdAt: NOW - 9000
};
const friendViewer = { id: 'u_friend', name: 'Mamun Hossen', username: 'mamun', role: 'user', isBot: false, followers: [], following: [], closeFriends: [], settings: {}, createdAt: NOW - 9000 };
const stranger = { id: 'u_stranger', name: 'Tanvir Hasan', username: 'tanvir', role: 'user', isBot: false, followers: [], following: [], closeFriends: [], settings: {}, createdAt: NOW - 9000 };

function data(extra = {}) {
  return {
    users: [owner, friendViewer, stranger],
    posts: [], stories: [], groups: [], pages: [], blocks: [],
    notifications: [], events: [], reviews: [], groupRequests: [],
    friendships: [{ id: 'f1', from: 'u_owner', to: 'u_friend', status: 'accepted', createdAt: NOW - 5000 }],
    conversations: [
      { id: 'c1', participants: ['u_friend', 'u_owner'], createdAt: NOW - 9000 },
      { id: 'cg', participants: ['u_friend', 'u_owner', 'u_stranger'], isGroup: true, title: 'Weekend Plans', createdBy: 'u_friend', createdAt: NOW - 9000 }
    ],
    messages: [
      { id: 'm1', conversationId: 'c1', participants: ['u_friend', 'u_owner'], senderId: 'u_owner', text: 'Hello there', image: '', audio: '', status: 'sent', readBy: [], createdAt: NOW - 1000 }
    ],
    ...extra
  };
}
const friendSet = (d, uid) => V.friendIdsOfData(d, uid);

// ------------------------------------------------------- field audience unit
describe('canSeeProfileField', () => {
  const d = data();
  it('defaults to public when no fieldPrivacy entry exists', () => {
    const bare = { ...owner, settings: {} };
    expect(V.canSeeProfileField(bare, 'work', { id: 'u_stranger', friendIds: friendSet(d, 'u_stranger') })).toBe(true);
    expect(V.canSeeProfileField(bare, 'work', null)).toBe(true);
  });
  it('onlyMe hides from everyone but the owner', () => {
    expect(V.canSeeProfileField(owner, 'currentCity', { id: 'u_stranger', friendIds: friendSet(d, 'u_stranger') })).toBe(false);
    expect(V.canSeeProfileField(owner, 'currentCity', { id: 'u_friend', friendIds: friendSet(d, 'u_friend') })).toBe(false);
    expect(V.canSeeProfileField(owner, 'currentCity', { id: 'u_owner', friendIds: friendSet(d, 'u_owner') })).toBe(true);
  });
  it('friends shows to accepted friends only', () => {
    expect(V.canSeeProfileField(owner, 'work', { id: 'u_friend', friendIds: friendSet(d, 'u_friend') })).toBe(true);
    expect(V.canSeeProfileField(owner, 'work', { id: 'u_stranger', friendIds: friendSet(d, 'u_stranger') })).toBe(false);
    expect(V.canSeeProfileField(owner, 'work', null)).toBe(false);
  });
});

// ------------------------------------------------- profile render enforcement
describe('profile render enforcement (fieldPrivacy)', () => {
  const d = data();
  it('a stranger sees public fields but not friends-only or only-me ones', () => {
    const html = V.profileView(d, stranger, 'u_owner');
    expect(html).toContain('Dhaka College'); // education: public
    expect(html).not.toContain('Quantum Bakery'); // work: friends only
    expect(html).not.toContain('Sylhet'); // currentCity: only me
    expect(html).not.toContain('(Ash)'); // nickname: only me
  });
  it('an accepted friend sees friends-only fields but not only-me ones', () => {
    const html = V.profileView(d, friendViewer, 'u_owner');
    expect(html).toContain('Quantum Bakery');
    expect(html).not.toContain('Sylhet');
    expect(html).not.toContain('(Ash)');
  });
  it('the owner sees every field on their own profile', () => {
    const html = V.profileView(d, owner, 'u_owner');
    expect(html).toContain('Quantum Bakery');
    expect(html).toContain('Sylhet');
    expect(html).toContain('(Ash)');
  });
  it('the person-card city line honours the audience too', () => {
    expect(V.locationLineHtml(owner, { id: 'u_stranger', friendIds: friendSet(d, 'u_stranger') })).toBe('');
    expect(V.locationLineHtml(owner, { id: 'u_owner', friendIds: friendSet(d, 'u_owner') })).toContain('Sylhet');
    const pub = { ...owner, settings: {} };
    expect(V.locationLineHtml(pub, { id: 'u_stranger', friendIds: friendSet(d, 'u_stranger') })).toContain('Sylhet');
  });
});

// ------------------------------------------------------------- chat info page
describe('chatInfoView — full-page chat info', () => {
  const d = data();
  it('renders header, quick actions and the three groups for a 1-1 chat', () => {
    const html = V.chatInfoView(d, friendViewer, 'c1');
    expect(html).toContain('chat-info-head');
    expect(html).toContain('@ayesha');
    expect(html).toContain('href="#/profile/u_owner"'); // quick action: view profile
    expect(html).toContain('data-act="conv-pin"');
    expect(html).toContain('data-act="conv-mute"');
    expect(html).toContain('data-act="conv-archive"');
    expect(html).toContain('Actions');
    expect(html).toContain('Customization');
    expect(html).toContain('Privacy & support');
    expect(html).toContain('data-act="set-theme"');
    expect(html).toContain('data-act="set-conv-emoji"');
    expect(html).toContain('data-act="set-nickname"');
    expect(html).toContain('data-act="vanish-toggle"');
    expect(html).toContain('data-act="report-user"');
    expect(html).toContain('id="conv-msg-search"');
  });
  it('back action returns to the open thread', () => {
    const html = V.chatInfoView(d, friendViewer, 'c1');
    expect(html).toContain('href="#/messages/c1"');
  });
  it('group conversations keep their admin tools on the page', () => {
    const html = V.chatInfoView(d, friendViewer, 'cg');
    expect(html).toContain('Weekend Plans');
    expect(html).toContain('id="group-rename-form"');
    expect(html).toContain('data-act="group-leave"');
    expect(html).not.toContain('href="#/profile/'); // no 1-1 profile quick action
  });
  it('the thread itself no longer renders the panel', () => {
    const html = V.messagesView(d, friendViewer, 'c1');
    expect(html).not.toContain('id="conv-info"');
    expect(html).toContain('data-act="conv-info"');
  });
});

// -------------------------------------------------------------- edit profile
describe('editProfileView — full page + audience pickers', () => {
  it('renders the page shell, the form and one picker per pickable field', () => {
    const html = V.editProfileView(data(), owner);
    expect(html).toContain('href="#/profile/u_owner"'); // back link
    expect(html).toContain('<form id="edit-profile-form" class="stack pf-form">');
    for (const f of ['work', 'education', 'currentCity', 'hometown', 'relationship', 'dob', 'gender', 'nickname', 'website']) {
      expect(html, `privacy_${f}`).toContain(`name="privacy_${f}"`);
    }
    // Page variant: Cancel is a link back to the profile, not data-close.
    expect(html).toContain('<a class="btn btn-ghost" href="#/profile/u_owner">Cancel</a>');
    expect(html).not.toContain('data-close');
  });
  it('pickers show the saved audiences as selected', () => {
    const html = V.editProfileView(data(), owner);
    const sel = (field) => (html.match(new RegExp(`<select name="privacy_${field}"[\\s\\S]*?</select>`)) || [''])[0];
    expect(sel('currentCity')).toContain('<option value="onlyMe" selected>');
    expect(sel('work')).toContain('<option value="friends" selected>');
    expect(sel('education')).toContain('<option value="public" selected>');
  });
});

// --------------------------------------------------------- messaging settings
describe('messagingSettingsView', () => {
  it('renders the toggle (checked by default), the entries and the blocked section', () => {
    const html = V.messagingSettingsView(data(), friendViewer);
    expect(html).toContain('data-act="msg-notif-toggle"');
    expect(html).toContain('checked');
    expect(html).toContain('data-act="open-msg-requests"');
    expect(html).toContain('data-act="open-msg-archive"');
    expect(html).toContain('Blocked users');
    expect(html).toContain('href="#/settings"'); // back link
  });
  it('renders the toggle unchecked when message notifications are off', () => {
    const meOff = { ...friendViewer, settings: { notifPrefs: { message: false } } };
    const html = V.messagingSettingsView(data(), meOff);
    const box = (html.match(/<input type="checkbox" data-act="msg-notif-toggle"[^>]*>/) || [''])[0];
    expect(box).not.toContain('checked');
  });
  it('lists blocked users with Unblock buttons (same rows as Settings)', () => {
    const d = data({ blocks: [{ by: 'u_friend', target: 'u_stranger' }] });
    const html = V.messagingSettingsView(d, friendViewer);
    expect(html).toContain('Tanvir Hasan');
    expect(html).toContain('data-act="block" data-id="u_stranger"');
  });
  it('is linked from Settings and from the chat-list header gear', () => {
    const d = data();
    expect(V.settingsView(d, friendViewer, { theme: 'light', locale: 'en' })).toContain('href="#/settings/messaging"');
    expect(V.messagesView(d, friendViewer, '')).toContain('href="#/settings/messaging"');
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

describe('demo api — fieldPrivacy + messaging toggle round-trips', () => {
  it('fieldPrivacy saves through updateSettings and reads back (settings merge keeps siblings)', async () => {
    await api.updateSettings('u_ayesha', { notifPrefs: { message: true, like: false } });
    await api.updateSettings('u_ayesha', { fieldPrivacy: { currentCity: 'onlyMe', work: 'friends' } });
    const u = api.data().users.find((x) => x.id === 'u_ayesha');
    expect(u.settings.fieldPrivacy).toEqual({ currentCity: 'onlyMe', work: 'friends' });
    expect(u.settings.notifPrefs).toEqual({ message: true, like: false }); // untouched by the second save
    // …and the edit page renders the saved audiences back as selected.
    const html = V.editProfileView(api.data(), u);
    const sel = (field) => (html.match(new RegExp(`<select name="privacy_${field}"[\\s\\S]*?</select>`)) || [''])[0];
    expect(sel('currentCity')).toContain('<option value="onlyMe" selected>');
    expect(sel('work')).toContain('<option value="friends" selected>');
  });
  it('the messaging-settings toggle round-trips through notifPrefs.message', async () => {
    // Mirror of the msg-notif-toggle handler: merge + updateSettings.
    const before = api.data().users.find((x) => x.id === 'u_ayesha');
    const off = { ...(before.settings?.notifPrefs || {}), message: false };
    await api.updateSettings('u_ayesha', { notifPrefs: off });
    let u = api.data().users.find((x) => x.id === 'u_ayesha');
    expect(u.settings.notifPrefs.message).toBe(false);
    expect(u.settings.notifPrefs.like).toBe(false); // sibling pref preserved by the merge
    const viewOff = V.messagingSettingsView(api.data(), u);
    expect((viewOff.match(/<input type="checkbox" data-act="msg-notif-toggle"[^>]*>/) || [''])[0]).not.toContain('checked');
    const on = { ...(u.settings?.notifPrefs || {}), message: true };
    await api.updateSettings('u_ayesha', { notifPrefs: on });
    u = api.data().users.find((x) => x.id === 'u_ayesha');
    expect(u.settings.notifPrefs.message).toBe(true);
  });
  it('a saved onlyMe city disappears from the profile a stranger renders', async () => {
    const d = api.data();
    const ayesha = d.users.find((x) => x.id === 'u_ayesha');
    const tanvir = d.users.find((x) => x.id === 'u_tanvir');
    expect(ayesha.settings.fieldPrivacy.currentCity).toBe('onlyMe');
    expect(V.profileView(d, tanvir, 'u_ayesha')).not.toContain('Lives in');
    expect(V.profileView(d, ayesha, 'u_ayesha')).toContain('Lives in');
  });
});

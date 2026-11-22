// Audit Fix Pack (2026-11-20) — regression tests for the defects the
// full-site live audit found: #4 RSVP toast inversion, #3 toast wipe
// (helper level; the DOM-level login test lives in
// audit-fixes-login.test.js), #5 conv-info panel state, #6 reaction
// hit area, #7 profile strips (see also mobile-fixes.test.js), #8
// review body mapping, #9 event button label + avatar overlap, #10
// self-notifications (demo paths here, live paths in
// audit-fixes-live.test.js), #11 Bangla gaps, #12 admin counts.
import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { rsvpToastKey, shouldClearToast, reviewText, platformStats } from '../src/utils.js';
import { LOCALES, setLocale, t } from '../src/i18n.js';
import { toast, clearToasts } from '../src/components.js';
import * as V from '../src/views.js';

vi.mock('../src/supabase.js', () => ({
  supabaseReady: false, isSupabaseConfigured: false, supabaseConfig: {}, supabase: null
}));

let api;
beforeAll(async () => { api = await import('../src/api.js'); });
afterEach(() => { setLocale('en'); vi.unstubAllGlobals(); });

const NOW = Date.now();
const me = { id: 'u_me', name: 'Mamun Hossen', username: 'your.name', email: 'me@example.com', role: 'superadmin', isBot: false, online: true, followers: [], following: [], closeFriends: [], settings: {}, createdAt: NOW - 9000 };
const friend = { id: 'u_friend', name: 'Ayesha Khan', username: 'ayesha', email: 'friend@example.com', role: 'user', isBot: false, followers: [], following: [], settings: {}, createdAt: NOW - 9000 };
const novaUser = { id: 'bot_nova', name: 'Nova', username: 'nova.bot', role: 'bot', isBot: true, followers: [], following: [], settings: {}, createdAt: NOW - 9000 };
const baseData = (extra = {}) => ({
  users: [me, friend], posts: [], stories: [], groups: [], pages: [], friendships: [], blocks: [],
  notifications: [], events: [], reviews: [], groupRequests: [], conversations: [], messages: [],
  bots: [], botSettings: {}, botSecrets: {}, botRunner: {}, aiUsage: {}, config: { platformName: 'MeetBook' },
  announcements: [], adminLogs: [], reports: [], ...extra
});

// ---------------------------------------------------------------- #4 RSVP
describe('#4 rsvpToastKey — the toast follows the boolean toggleEventRsvp returns', () => {
  it('maps the boolean result to the honest toast key', () => {
    expect(rsvpToastKey(true, 'going')).toBe('rsvpGoing');
    expect(rsvpToastKey(true, 'interested')).toBe('rsvpInterested');
    expect(rsvpToastKey(false, 'going')).toBe('rsvpRemoved');
    expect(rsvpToastKey(false, 'interested')).toBe('rsvpRemoved');
  });
  it('the keys exist in both locales', () => {
    for (const k of ['rsvpGoing', 'rsvpInterested', 'rsvpRemoved']) {
      expect(LOCALES.en[k], `en.${k}`).toBeTruthy();
      expect(LOCALES.bn[k], `bn.${k}`).toBeTruthy();
    }
  });
  it('api.toggleEventRsvp (demo) really resolves booleans: add -> true, remove -> false', async () => {
    api.resetDemo();
    await api.login('ayesha@example.com', 'demo123');
    const ev = await api.createEvent({ title: 'Audit picnic', description: '', dateTime: NOW + 7 * 24 * 3600_000, location: 'Park', visibility: 'public' });
    expect(await api.toggleEventRsvp(ev.id, 'going')).toBe(true);
    expect(await api.toggleEventRsvp(ev.id, 'going')).toBe(false);
    await api.logout();
  });
});

// ------------------------------------------------------- #3 toast lifetime
describe('#3 shouldClearToast — fresh toasts survive their own navigation', () => {
  it('a toast younger than the grace window is kept', () => {
    expect(shouldClearToast(NOW, NOW + 100, 1500)).toBe(false);
    expect(shouldClearToast(NOW, NOW + 1499, 1500)).toBe(false);
  });
  it('a toast older than the grace window is cleared', () => {
    expect(shouldClearToast(NOW, NOW + 1500, 1500)).toBe(true);
    expect(shouldClearToast(NOW, NOW + 60_000, 1500)).toBe(true);
  });
  it('without a grace window everything clears (old behaviour)', () => {
    expect(shouldClearToast(NOW, NOW, 0)).toBe(true);
    expect(shouldClearToast(undefined, NOW, 0)).toBe(true);
  });
});

describe('#3 components toast/clearToasts honour the creation stamp', () => {
  function stubDom() {
    const root = { children: [], appendChild(el) { this.children.push(el); } };
    vi.stubGlobal('document', {
      getElementById: (id) => (id === 'toast-root' ? root : null),
      createElement: () => ({
        className: '', textContent: '', dataset: {},
        classList: { add() {}, remove() {} },
        removed: false,
        remove() { this.removed = true; const i = root.children.indexOf(this); if (i >= 0) root.children.splice(i, 1); }
      })
    });
    return root;
  }
  it('clearToasts(1500) keeps a just-raised toast; clearToasts() drops it', () => {
    vi.useFakeTimers();
    const root = stubDom();
    toast('Welcome back!', 'success');
    expect(root.children).toHaveLength(1);
    expect(Number(root.children[0].dataset.at)).toBeGreaterThan(0);
    clearToasts(1500); // the hashchange grace pass right after login
    expect(root.children).toHaveLength(1);
    vi.advanceTimersByTime(2000);
    clearToasts(1500); // a later navigation clears it normally
    expect(root.children).toHaveLength(0);
    vi.useRealTimers();
  });
});

// ------------------------------------------------------- #5 conv-info state
describe('#5 messagesView renders the info panel open when uiState says so', () => {
  const d = baseData({
    conversations: [{ id: 'c1', participants: ['u_me', 'u_friend'], createdAt: NOW - 9000 }],
    messages: [{ id: 'm1', conversationId: 'c1', participants: ['u_me', 'u_friend'], senderId: 'u_friend', text: 'Hi', image: '', audio: '', createdAt: NOW - 1000, status: 'sent', readBy: ['u_friend'] }]
  });
  afterEach(() => { V.uiState.convInfoFor = ''; });
  it('closed by default', () => {
    expect(V.messagesView(d, me, 'c1')).toContain('<div id="conv-info" class="conv-info hidden">');
  });
  it('stays open across a re-render (e.g. after picking a theme) when uiState.convInfoFor matches', () => {
    V.uiState.convInfoFor = 'c1';
    const html = V.messagesView(d, me, 'c1');
    expect(html).toContain('<div id="conv-info" class="conv-info">');
    expect(html).not.toContain('<div id="conv-info" class="conv-info hidden">');
  });
  it('a different conversation still renders closed', () => {
    V.uiState.convInfoFor = 'some-other-conv';
    expect(V.messagesView(d, me, 'c1')).toContain('<div id="conv-info" class="conv-info hidden">');
  });
});

// ------------------------------------------------------------- #8 reviews
describe('#8 reviewText — the field the create path writes, plus legacy aliases', () => {
  it('reads the canonical `text` field', () => {
    expect(reviewText({ text: 'Lovely page' })).toBe('Lovely page');
    expect(reviewText({ text: '  padded  ' })).toBe('padded');
  });
  it('falls back to legacy body/comment fields', () => {
    expect(reviewText({ body: 'Legacy body' })).toBe('Legacy body');
    expect(reviewText({ comment: 'Legacy comment' })).toBe('Legacy comment');
    expect(reviewText({ text: '', body: 'Body wins when text is empty' })).toBe('Body wins when text is empty');
  });
  it('stars-only / whitespace reviews have no body', () => {
    expect(reviewText({ rating: 5 })).toBe('');
    expect(reviewText({ text: '   ' })).toBe('');
    expect(reviewText(null)).toBe('');
  });
  it('pageView renders a legacy-body review and omits the body of a stars-only one', () => {
    const page = { id: 'pg1', name: 'Test Page', category: 'Community', about: '', avatar: '', ownerId: 'u_friend', followers: [], createdAt: NOW - 9000 };
    const dd = baseData({
      pages: [page],
      reviews: [
        { id: 'r1', pageId: 'pg1', authorId: 'u_friend', rating: 4, body: 'Legacy words here', createdAt: NOW - 2000 },
        { id: 'r2', pageId: 'pg1', authorId: 'u_me', rating: 5, createdAt: NOW - 1000 }
      ]
    });
    const html = V.pageView(dd, me, 'pg1');
    expect(html).toContain('Legacy words here');
    // The stars-only review still renders (name + stars) — with no
    // dangling <br/> body slot in its row.
    const start = html.indexOf('Mamun Hossen');
    const seg = html.slice(start, html.indexOf('</div>', start));
    expect(seg).toContain('stars');
    expect(seg).not.toContain('<br/>');
  });
});

// --------------------------------------------------------------- #9 events
describe('#9 event buttons and header layout', () => {
  const ev = (going) => ({
    id: 'e1', title: 'Audit Meetup', description: 'Desc', dateTime: NOW + 3 * 24 * 3600_000,
    location: 'Dhaka', cover: '', createdBy: 'u_friend', visibility: 'public', audienceIds: [],
    going, interested: [], createdAt: NOW - 1000
  });
  it('detail button shows the check icon only when the viewer is going', () => {
    const goingBtn = (html) => (html.match(/data-kind="going"[^>]*>([\s\S]*?)<\/button>/) || [])[1] || '';
    const notGoing = V.eventView(baseData({ events: [ev([])] }), me, 'e1');
    expect(goingBtn(notGoing)).toContain(`${t('going')} (0)`);
    expect(goingBtn(notGoing)).not.toContain('ic-check');
    const going = V.eventView(baseData({ events: [ev(['u_me'])] }), me, 'e1');
    expect(goingBtn(going)).toContain('ic-check');
    expect(goingBtn(going)).toContain(`${t('going')} (1)`);
  });
  it('card button shows the check icon only when the viewer is going', () => {
    const goingBtn = (html) => (html.match(/data-kind="going"[^>]*>([\s\S]*?)<\/button>/) || [])[1] || '';
    const notGoing = V.eventsView(baseData({ events: [ev([])] }), me);
    expect(goingBtn(notGoing)).not.toContain('ic-check');
    const going = V.eventsView(baseData({ events: [ev(['u_me'])] }), me);
    expect(goingBtn(going)).toContain('ic-check');
    expect(goingBtn(going)).toContain(t('going'));
  });
  it('the big-avatar overlap rule is scoped to direct children, so nested avatars (event host) are untouched', () => {
    const css = readFileSync(new URL('../src/styles.css', import.meta.url), 'utf8');
    expect(css).toContain('.profile-meta > .avatar');
    expect(css).not.toContain('.profile-meta .avatar,');
  });
});

// ------------------------------------------------------------------ #6 CSS
describe('#6 reaction buttons have a >=36px hit area', () => {
  it('styles.css gives .reaction-btn min 36px targets', () => {
    const css = readFileSync(new URL('../src/styles.css', import.meta.url), 'utf8');
    const rule = css.match(/\.reaction-btn \{[^}]*\}/)?.[0] || '';
    expect(rule).toContain('min-width: 36px');
    expect(rule).toContain('min-height: 36px');
  });
});

// ------------------------------------------------- #10 self-notifications
describe('#10 demo mode: acting on your own post never notifies yourself', () => {
  it('self-like, self-comment and self-mention create no notification; another user\'s like does', async () => {
    api.resetDemo();
    await api.login('ayesha@example.com', 'demo123');
    const meId = api.me().id;
    const post = await api.createPost({ text: 'My own post @ayesha.r', visibility: 'public' });
    const before = api.data().notifications.filter((n) => n.userId === meId && n.actorId === meId);
    await api.toggleLike(post.id);
    await api.addComment(post.id, 'a note to self');
    const selfNotes = api.data().notifications.filter((n) => n.userId === meId && n.actorId === meId);
    expect(selfNotes).toEqual(before); // nothing new from my own actions
    expect(selfNotes.some((n) => n.type === 'like' || n.type === 'comment' || n.type === 'mention')).toBe(false);
    await api.logout();
    await api.login('tanvir@example.com', 'demo123');
    await api.toggleLike(post.id);
    const control = api.data().notifications.filter((n) => n.userId === meId && n.type === 'like');
    expect(control).toHaveLength(1); // someone else's like DOES notify
    await api.logout();
  });
});

// -------------------------------------------------------------------- #11
describe('#11 Bangla gaps closed', () => {
  it('search/admin/bots labels come from i18n with proper Bangla', () => {
    setLocale('en');
    expect(t('search')).toBe('Search');
    expect(t('admin')).toBe('Admin');
    expect(t('bots')).toBe('AI Bots');
    setLocale('bn');
    expect(t('search')).toBe('খুঁজুন');
    expect(t('admin')).toBe('অ্যাডমিন');
    expect(t('bots')).toBe('এআই বট');
  });
  it('no hardcoded Search buttons or nav labels remain in main/views', () => {
    const main = readFileSync(new URL('../src/main.js', import.meta.url), 'utf8');
    const views = readFileSync(new URL('../src/views.js', import.meta.url), 'utf8');
    expect(main + views).not.toContain('>Search</button>');
    expect(main).toContain("navItem('#/admin', icon('shield'), t('admin'))");
    expect(main).toContain("navItem('#/admin/bots', icon('bot'), t('bots'))");
    expect(views).toContain("${t('search')}</button>");
  });
});

// -------------------------------------------------------------------- #12
describe('#12 admin counts: Overview counts every account, bots broken out', () => {
  it('platformStats separates total accounts from humans and bot accounts', () => {
    const s = platformStats(baseData({ users: [me, friend, novaUser] }), NOW);
    expect(s.totalUsers).toBe(2);      // humans only (unchanged semantics)
    expect(s.botAccounts).toBe(1);     // bot USER docs
    expect(s.totalAccounts).toBe(3);   // what the Users table lists
  });
  it('the Overview headline shows the all-accounts total with the split', () => {
    const html = V.adminOverviewView(baseData({ users: [me, friend, novaUser] }), me, { firebase: false, projectId: 'demo' });
    expect(html).toContain('<b>3</b>');
    expect(html).toMatch(/ic-user[\s\S]*?> 2 ·/);
    expect(html).toMatch(/ic-bot[\s\S]*?> 1</);
  });
});

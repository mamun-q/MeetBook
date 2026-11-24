// Friends Pack (2026-11-25) — Fexbo-style Friends & Connections
// restyle, approved by Limon as an IMPROVEMENT of the existing page
// (no new features, no new data): header card + subtitle, segmented
// tabs (Requests / Friends / Discover with real counts) reusing the
// .tabs/.tab system and the conv-filter state pattern, a green
// "Lives in" line from the profile's EXISTING currentCity, and
// photo-header Discover cards scoped to the Friends view only.
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { setLocale } from '../src/i18n.js';
import * as V from '../src/views.js';

vi.mock('../src/supabase.js', () => ({
  supabaseReady: false, isSupabaseConfigured: false, supabaseConfig: {}, supabase: null
}));

const views = readFileSync(new URL('../src/views.js', import.meta.url), 'utf8');
const main = readFileSync(new URL('../src/main.js', import.meta.url), 'utf8');
const css = readFileSync(new URL('../src/styles.css', import.meta.url), 'utf8');

const NOW = Date.now();
const me = { id: 'u_me', name: 'Mamun Hossen', username: 'your.name', email: 'me@example.com', role: 'user', isBot: false, online: true, followers: [], following: [], closeFriends: [], settings: {}, createdAt: NOW - 9000 };
const cityUser = { id: 'u_city', name: 'Dhaka Person', username: 'dhaka.person', email: 'c@example.com', role: 'user', isBot: false, followers: [], following: [], settings: {}, createdAt: NOW - 8000, currentCity: 'Dhaka', cover: 'https://res.cloudinary.com/demo/image/upload/v1/cover.jpg' };
const plainUser = { id: 'u_plain', name: 'Plain Person', username: 'plain.person', email: 'p@example.com', role: 'user', isBot: false, followers: [], following: [], settings: {}, createdAt: NOW - 7000 };
const baseData = (extra = {}) => ({
  users: [me, cityUser, plainUser], posts: [], stories: [], groups: [], pages: [], friendships: [], blocks: [],
  notifications: [], events: [], reviews: [], groupRequests: [], conversations: [], messages: [],
  bots: [], botSettings: {}, botSecrets: {}, botRunner: {}, aiUsage: {}, config: { platformName: 'MeetBook' },
  announcements: [], adminLogs: [], reports: [], ...extra
});

beforeEach(() => { setLocale('en'); V.uiState.friendsTab = ''; });

describe('friends pack — header + segmented tabs', () => {
  it('renders the header card with the subtitle in both locales', () => {
    const html = V.friendsView(baseData(), me);
    expect(html).toContain('class="card friends-head"');
    expect(html).toContain('Manage friend requests, connect with people and discover new friends.');
    setLocale('bn');
    expect(V.friendsView(baseData(), me)).toContain('বন্ধুর অনুরোধ সামলান');
  });

  it('renders three tabs with real counts and the friends-tab action', () => {
    const d = baseData({
      friendships: [
        { id: 'f_in', from: 'u_city', to: 'u_me', status: 'pending', createdAt: NOW - 1000 },
        { id: 'f_out', from: 'u_me', to: 'u_plain', status: 'pending', createdAt: NOW - 2000 }
      ]
    });
    const html = V.friendsView(d, me);
    expect(html).toContain('class="tabs friends-tabs"');
    expect(html).toContain('data-act="friends-tab" data-tab="requests"');
    expect(html).toContain('data-act="friends-tab" data-tab="friends"');
    expect(html).toContain('data-act="friends-tab" data-tab="discover"');
    expect(html).toContain('Requests received (2)'); // incoming + outgoing
    expect(html).toContain('Your friends (0)');
    expect(html).toContain('Suggested for you (0)'); // both users are related via pending rows
  });

  it('defaults to Requests when a request is pending, Discover otherwise', () => {
    const withReq = V.friendsView(baseData({
      friendships: [{ id: 'f_in', from: 'u_city', to: 'u_me', status: 'pending', createdAt: NOW - 1000 }]
    }), me);
    expect(withReq).toContain('data-tab="requests" role="tab" aria-selected="true"');
    expect(withReq).toContain('<div class="friends-panel" data-panel="requests">'); // visible panel
    expect(withReq).toContain('<div class="friends-panel" data-panel="friends" hidden>');
    const noReq = V.friendsView(baseData(), me);
    expect(noReq).toContain('data-tab="discover" role="tab" aria-selected="true"');
    expect(noReq).toContain('<div class="friends-panel" data-panel="discover">');
    expect(noReq).toContain('<div class="friends-panel" data-panel="requests" hidden>');
  });

  it('respects an explicitly chosen tab from uiState', () => {
    V.uiState.friendsTab = 'friends';
    const html = V.friendsView(baseData({
      friendships: [{ id: 'f_in', from: 'u_city', to: 'u_me', status: 'pending', createdAt: NOW - 1000 }]
    }), me);
    expect(html).toContain('data-tab="friends" role="tab" aria-selected="true"');
    expect(html).toContain('<div class="friends-panel" data-panel="friends">');
    expect(html).toContain('<div class="friends-panel" data-panel="requests" hidden>');
    // All panels stay in the DOM (as on the old stacked page) — only visibility flips.
    expect(html).toContain('data-act="accept-request"');
  });

  it('main.js wires friends-tab exactly like conv-filter and the name is used nowhere else', () => {
    expect(main).toContain("case 'friends-tab': V.uiState.friendsTab = actEl.dataset.tab || 'discover'; render(); break;");
    expect(views).toContain('friendsTab');
    // The only data-act="friends-tab" occurrences in the app are the 3 tab buttons.
    expect((views.match(/data-act="friends-tab"/g) || []).length).toBe(3);
    expect(main).not.toContain('data-act="friends-tab"');
  });
});

describe('friends pack — existing actions untouched', () => {
  it('keeps every original friend action name on its panel', () => {
    const req = V.friendsView(baseData({
      friendships: [
        { id: 'f_in', from: 'u_city', to: 'u_me', status: 'pending', createdAt: NOW - 1000 },
        { id: 'f_out', from: 'u_me', to: 'u_plain', status: 'pending', createdAt: NOW - 2000 }
      ]
    }), me);
    expect(req).toContain('data-act="accept-request" data-id="f_in"');
    expect(req).toContain('data-act="reject-request" data-id="f_in"');
    expect(req).toContain('data-act="cancel-request" data-id="f_out"');
    V.uiState.friendsTab = 'friends';
    const fr = V.friendsView(baseData({
      friendships: [{ id: 'f_acc', from: 'u_me', to: 'u_city', status: 'accepted', createdAt: NOW - 3000 }]
    }), me);
    expect(fr).toContain('data-act="toggle-close-friend"');
    expect(fr).toContain('data-act="message-user"');
    expect(fr).toContain('data-act="remove-friend" data-id="f_acc"');
    V.uiState.friendsTab = 'discover';
    const dis = V.friendsView(baseData(), me);
    expect(dis).toContain('data-act="send-request" data-id="u_city"');
    expect(dis).toContain('data-act="send-request" data-id="u_plain"');
  });
});

describe('friends pack — Lives in line (existing currentCity only)', () => {
  it('locationLineHtml renders only when currentCity is set', () => {
    expect(V.locationLineHtml(cityUser)).toContain('class="loc-line"');
    expect(V.locationLineHtml(cityUser)).toContain('Lives in Dhaka');
    expect(V.locationLineHtml(plainUser)).toBe('');
    expect(V.locationLineHtml(null)).toBe('');
  });

  it('shows on Friends-page cards and in the feed rail suggestions', () => {
    const html = V.friendsView(baseData(), me); // discover tab: both users suggested
    expect(html).toContain('Lives in Dhaka');
    const rail = V.rightRail(baseData(), me);
    expect(rail).toContain('Lives in Dhaka');
    expect(rail).toContain('Dhaka Person');
  });

  it('the CSS line uses the existing accent (green) token, no hardcoded green', () => {
    expect(css).toMatch(/\.loc-line \{[^}]*color: var\(--accent\)/);
  });
});

describe('friends pack — Discover photo header, friends view only', () => {
  it('discover cards get a photo header: cover image (600w, lazy) or gradient', () => {
    const html = V.friendsView(baseData(), me);
    expect(html).toContain('person-card person-card--photo');
    expect(html).toContain('class="person-photo"><img src="https://res.cloudinary.com/demo/image/upload/f_auto,q_auto,w_600,c_limit/v1/cover.jpg"');
    expect(html).toContain('loading="lazy" decoding="async"');
    expect(html).toContain('<div class="person-photo"></div>'); // plainUser: gradient header
    expect(html).toContain('class="person-ava"');
  });

  it('non-discover person cards keep the plain card (no photo header)', () => {
    const html = V.friendsView(baseData({
      friendships: [{ id: 'f_in', from: 'u_city', to: 'u_me', status: 'pending', createdAt: NOW - 1000 }]
    }), me);
    const requestsPanel = html.slice(html.indexOf('data-panel="requests"'), html.indexOf('data-panel="friends"'));
    expect(requestsPanel).toContain('card person-card');
    expect(requestsPanel).not.toContain('person-card--photo');
    expect(requestsPanel).not.toContain('person-photo');
  });

  it('groups/pages discovery cards are unchanged (no photo header leaks)', () => {
    const groups = V.groupsView(baseData({ groups: [{ id: 'g1', name: 'Test Group', privacy: 'public', description: 'x', members: [], createdBy: 'u_city', cover: '' }] }), me);
    expect(groups).not.toContain('person-card--photo');
    const pages = V.pagesView(baseData({ pages: [{ id: 'p1', name: 'Test Page', category: 'Website', about: 'x', ownerId: 'u_city', followers: [], cover: '', avatar: '' }] }), me);
    expect(pages).not.toContain('person-card--photo');
  });

  it('photo-header CSS is scoped and light (no backdrop-filter)', () => {
    expect(css).toContain('.person-card--photo { padding: 0; overflow: hidden; }');
    expect(css).toMatch(/\.person-photo \{[^}]*height: 84px/);
    const block = css.slice(css.indexOf('/* Friends Pack'));
    expect(block).not.toContain('backdrop-filter');
  });
});

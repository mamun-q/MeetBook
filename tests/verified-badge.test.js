import { describe, it, expect, vi } from 'vitest';
import * as V from '../src/views.js';
import {
  isVerifiedUser, isVerifiedPage, verifiedBadgeHtml, pageVerifiedBadgeHtml,
  userNameHtml, postCardHtml, OFFICIAL_PAGE_ID
} from '../src/components.js';
import { iconFill, hasIcon } from '../src/icons.js';

// Verified Badge pack (Professional Pack item 2, 2026-11-22): the blue
// seal is DERIVED from role — superadmin/admin accounts (MeetBook
// Official, Limon) and pages owned by staff carry it next to their
// name everywhere names render. The Admin-granted users.verified flag
// keeps working alongside. No new column, no SQL change.

vi.mock('../src/supabase.js', () => ({
  supabaseReady: false, isSupabaseConfigured: false, supabaseConfig: {}, supabase: null
}));

const NOW = Date.now();
const H = 3600_000;

const me = { id: 'u_me', name: 'Mamun Hossen', username: 'md.mamun', role: 'superadmin', isBot: false, online: true, followers: [], following: [], closeFriends: [], settings: {}, createdAt: NOW - 90 * 24 * H };
const official = { id: 'u_official', name: 'MeetBook Official', username: 'meetbook.official', role: 'superadmin', isBot: false, online: true, followers: [], following: [], closeFriends: [], settings: {}, createdAt: NOW - 90 * 24 * H };
const admin = { id: 'u_admin', name: 'Admin Ayesha', username: 'ayesha.admin', role: 'admin', isBot: false, online: true, followers: [], following: [], closeFriends: [], settings: {}, createdAt: NOW - 80 * 24 * H };
const human = { id: 'u_hasan', name: 'Hasan Ali', username: 'hasan', role: 'user', isBot: false, online: true, followers: [], following: [], closeFriends: [], settings: {}, createdAt: NOW - 30 * 24 * H };
const flagged = { id: 'u_flag', name: 'Flagged Farhana', username: 'farhana', role: 'user', verified: true, isBot: false, online: false, followers: [], following: [], closeFriends: [], settings: {}, createdAt: NOW - 20 * 24 * H };
const botUser = { id: 'bot_nova', name: 'Nova', username: 'nova.bot', role: 'bot', isBot: true, botId: 'bot_nova', online: true, followers: [], following: [], closeFriends: [], settings: {}, createdAt: NOW - 20 * 24 * H };

const officialPage = { id: OFFICIAL_PAGE_ID, name: 'MeetBook Official', category: 'Website', avatar: '', cover: '', about: 'The official page.', ownerId: 'u_official', followers: ['u_me'], createdAt: NOW - 90 * 24 * H };
const humanPage = { id: 'pg_hasan', name: 'Hasan Photography', category: 'Photography', avatar: '', cover: '', about: '', ownerId: 'u_hasan', followers: [], createdAt: NOW - 10 * 24 * H };

describe('isVerifiedUser — the role-derived predicate', () => {
  it('staff roles are verified', () => {
    expect(isVerifiedUser(official)).toBe(true);
    expect(isVerifiedUser(me)).toBe(true);
    expect(isVerifiedUser(admin)).toBe(true);
  });
  it('normal users and moderators are not', () => {
    expect(isVerifiedUser(human)).toBe(false);
    expect(isVerifiedUser({ ...human, role: 'moderator' })).toBe(false);
    expect(isVerifiedUser({ ...human, role: undefined })).toBe(false);
  });
  it('bots are not — unless one is staff', () => {
    expect(isVerifiedUser(botUser)).toBe(false);
    expect(isVerifiedUser({ ...botUser, role: 'admin' })).toBe(true);
  });
  it('the Admin-granted verified flag still counts', () => {
    expect(isVerifiedUser(flagged)).toBe(true);
    expect(isVerifiedUser({ ...human, verified: false })).toBe(false);
  });
  it('missing users are not verified', () => {
    expect(isVerifiedUser(null)).toBe(false);
    expect(isVerifiedUser(undefined)).toBe(false);
  });
});

describe('badge markup', () => {
  it('the badge-check icon exists as a filled seal with a white check', () => {
    expect(hasIcon('badge-check')).toBe(true);
    const svg = iconFill('badge-check');
    expect(svg).toContain('ic-badge-check');
    expect(svg).toContain('fill="#fff"');
  });
  it('verifiedBadgeHtml renders the seal only for verified users', () => {
    const html = verifiedBadgeHtml(official);
    expect(html).toContain('verified-badge');
    expect(html).toContain('ic-badge-check');
    expect(html).toContain('role="img"');
    expect(verifiedBadgeHtml(human)).toBe('');
    expect(verifiedBadgeHtml(botUser)).toBe('');
    expect(verifiedBadgeHtml(null)).toBe('');
  });
  it('userNameHtml puts the seal next to staff names only', () => {
    expect(userNameHtml(official)).toContain('verified-badge');
    expect(userNameHtml(admin)).toContain('verified-badge');
    expect(userNameHtml(human)).not.toContain('verified-badge');
    expect(userNameHtml(botUser)).not.toContain('verified-badge');
  });
  it('a crafted name stays escaped and the badge still lands after it', () => {
    const evil = { ...official, name: 'Evil <img src=x onerror=alert(1)>' };
    const html = userNameHtml(evil);
    expect(html).not.toContain('<img src=x');
    expect(html).toContain('&lt;img');
    expect(html.indexOf('&lt;img')).toBeLessThan(html.indexOf('verified-badge'));
  });
});

describe('page verification — derived from the owner', () => {
  const usersById = Object.fromEntries([me, official, admin, human].map((u) => [u.id, u]));
  it('the Official page is verified through its staff owner', () => {
    expect(isVerifiedPage(officialPage, usersById)).toBe(true);
    expect(pageVerifiedBadgeHtml(officialPage, usersById)).toContain('verified-badge');
  });
  it('a page owned by a normal user is not verified', () => {
    expect(isVerifiedPage(humanPage, usersById)).toBe(false);
    expect(pageVerifiedBadgeHtml(humanPage, usersById)).toBe('');
  });
  it('an owner-less snapshot of the Official page still verifies by id', () => {
    const snapshot = { id: OFFICIAL_PAGE_ID, name: 'MeetBook Official', avatar: '', category: '' };
    expect(isVerifiedPage(snapshot, {})).toBe(true);
    expect(isVerifiedPage({ id: 'pg_other', name: 'Other' }, {})).toBe(false);
    expect(isVerifiedPage(null, usersById)).toBe(false);
  });
});

describe('render-level — post cards and views carry the seal', () => {
  const usersById = Object.fromEntries([me, official, admin, human, botUser].map((u) => [u.id, u]));
  const pagesById = { [officialPage.id]: officialPage, [humanPage.id]: humanPage };
  const basePost = {
    image: '', visibility: 'public', audienceIds: [], editedAt: 0, likes: [], reactions: {}, shares: 0,
    sharedFrom: '', savedBy: [], groupId: '', pageId: '', pageName: '', pageAvatar: '', comments: []
  };
  const ctx = { usersById, me, friendIds: new Set(), pagesById };

  it('a post by MeetBook Official shows the seal; a normal user post does not', () => {
    const staffPost = { ...basePost, id: 'p_staff', authorId: 'u_official', text: 'Welcome to MeetBook.', createdAt: NOW - H };
    expect(postCardHtml(staffPost, ctx)).toContain('verified-badge');
    const humanPost = { ...basePost, id: 'p_human', authorId: 'u_hasan', text: 'Morning walk.', createdAt: NOW - H };
    expect(postCardHtml(humanPost, ctx)).not.toContain('verified-badge');
  });

  it('a comment by an admin shows the seal', () => {
    const post = {
      ...basePost, id: 'p_c', authorId: 'u_hasan', text: 'Hello all.', createdAt: NOW - 2 * H,
      comments: [{ id: 'c1', authorId: 'u_admin', text: 'Welcome!', createdAt: NOW - H, replies: [] }]
    };
    expect(postCardHtml(post, ctx)).toContain('verified-badge');
  });

  it('a page post by the Official page shows the seal; a normal page post does not', () => {
    const pagePost = { ...basePost, id: 'p_page', authorId: 'u_official', pageId: officialPage.id, pageName: officialPage.name, text: 'Announcement.', createdAt: NOW - H };
    expect(postCardHtml(pagePost, ctx)).toContain('verified-badge');
    const humanPagePost = { ...basePost, id: 'p_hpage', authorId: 'u_hasan', pageId: humanPage.id, pageName: humanPage.name, text: 'New photos.', createdAt: NOW - H };
    expect(postCardHtml(humanPagePost, ctx)).not.toContain('verified-badge');
  });

  const d = {
    users: [me, official, admin, human, botUser],
    posts: [], friendships: [], conversations: [
      { id: 'conv_off', participants: ['u_me', 'u_official'], isGroup: false, createdAt: NOW - 5 * H },
      { id: 'conv_bot', participants: ['u_me', 'bot_nova'], isGroup: false, createdAt: NOW - 5 * H }
    ],
    messages: [
      { id: 'm1', conversationId: 'conv_off', senderId: 'u_official', text: 'Hello from the team.', createdAt: NOW - 4 * H, readBy: ['u_me'] },
      { id: 'm2', conversationId: 'conv_bot', senderId: 'bot_nova', text: 'Hi there.', createdAt: NOW - 4 * H, readBy: ['u_me'] }
    ],
    notifications: [
      { id: 'n1', userId: 'u_me', type: 'comment', actorId: 'u_official', text: 'MeetBook Official commented on your post.', postId: '', conversationId: '', read: false, createdAt: NOW - H },
      { id: 'n2', userId: 'u_me', type: 'comment', actorId: 'bot_nova', text: 'Nova commented on your post.', postId: '', conversationId: '', read: false, createdAt: NOW - 2 * H }
    ],
    stories: [], groups: [], pages: [officialPage, humanPage], events: [], reports: [], announcements: [],
    bots: [], botBrains: {}, botMemories: {}, botActivities: [], botLogs: [],
    botSettings: { counters: {}, global: { enabled: true } }, botSecrets: {}, aiUsage: {}, config: {}
  };

  it('the profile header of a staff account shows the seal', () => {
    expect(V.profileView(d, me, 'u_official')).toContain('verified-badge');
    expect(V.profileView(d, me, 'u_hasan')).not.toContain('verified-badge');
  });

  it('the Official page header shows the seal; a normal page header does not', () => {
    expect(V.pageView(d, me, officialPage.id)).toContain('verified-badge');
    expect(V.pageView(d, me, humanPage.id)).not.toContain('verified-badge');
  });

  it('conversation list + thread header show the seal for staff, not for a bot', () => {
    const listOff = V.messagesView(d, me, 'conv_off');
    expect(listOff).toContain('verified-badge');
    const listBot = V.messagesView(d, me, 'conv_bot');
    expect(listBot).not.toContain('verified-badge');
  });

  it('a notification from a staff actor carries the seal after their name', () => {
    const html = V.notificationsView(d, me);
    expect(html).toContain('verified-badge');
    // The bot's notification stays plain (its text renders verbatim).
    expect(html).toContain('Nova commented on your post.');
  });

  it('search + friends people cards show the seal for staff only', () => {
    const search = V.searchView(d, me, 'MeetBook');
    expect(search).toContain('verified-badge');
    const searchHuman = V.searchView(d, me, 'Hasan');
    expect(searchHuman).not.toContain('verified-badge');
  });
});

// Mobile Fix Pack — regression tests for the pure logic and view
// rendering behind the fixes: post merge dedupe, notification
// collapse, the Memories route, localized strings, search coverage,
// chat markup, the danger-zone split, autocomplete attributes, the
// Super Admin badge, and the data-dependent profile strips.
import { describe, it, expect, afterEach } from 'vitest';
import { mergePostLists, collapseDuplicateNotifications, memoriesFor } from '../src/utils.js';
import { setLocale, t } from '../src/i18n.js';
import { userNameHtml, postCardHtml } from '../src/components.js';
import * as viewsNs from '../src/views.js';
import * as adminViewsNs from '../src/adminViews.js';
const V = { ...viewsNs, ...adminViewsNs }; // admin views live in adminViews.js (lazy chunk); merged for call-site compatibility

afterEach(() => { setLocale('en'); });

// ------------------------------------------------------------ fixtures
const NOW = Date.now();
const memDate = new Date(NOW);
memDate.setFullYear(memDate.getFullYear() - 2);
const me = {
  id: 'u_me', name: 'Mamun Hossen', username: 'your.name', email: 'me@example.com',
  role: 'superadmin', verified: true, isBot: false, online: true, lastSeen: NOW,
  followers: ['u_friend'], following: [], closeFriends: [], settings: {},
  createdAt: NOW - 300 * 24 * 3600_000
};
const friend = {
  id: 'u_friend', name: 'Ayesha Khan', username: 'ayesha', email: 'friend@example.com',
  role: 'user', isBot: false, followers: [], following: [], settings: {},
  createdAt: NOW - 200 * 24 * 3600_000, lastSeen: NOW
};
const nova = {
  id: 'bot_nova', name: 'Nova', username: 'nova.bot', role: 'bot', isBot: true,
  followers: [], following: [], settings: {}, createdAt: NOW - 100 * 24 * 3600_000
};
const post = (id, extra = {}) => ({
  id, authorId: 'u_friend', text: 'A post.', image: '', visibility: 'public', audienceIds: [],
  createdAt: NOW - 3600_000, editedAt: 0, likes: [], reactions: {}, comments: [],
  shares: 0, sharedFrom: '', savedBy: [], groupId: '', pageId: '', pageName: '', pageAvatar: '',
  poll: null, location: '', feeling: '', pinned: false, ...extra
});
const d = {
  users: [me, friend, nova],
  posts: [
    post('p_memory', { authorId: 'u_me', text: 'Memory from two years ago', createdAt: memDate.getTime() }),
    post('p_nova', { authorId: 'bot_nova', text: 'Nova loves space facts.' }),
    post('p_photo', { authorId: 'u_me', text: 'My photo post', image: 'data:image/png;base64,AAA' }),
    post('p_friend_photo', { authorId: 'u_friend', text: 'Beach day', image: 'data:image/png;base64,BBB' }),
    post('p_group', { authorId: 'u_friend', text: 'Group discussion about books', groupId: 'g1' }),
    post('p_page', { authorId: 'u_friend', text: 'Page update', pageId: 'pg1', pageName: 'MeetBook Test Page' })
  ],
  friendships: [{ id: 'f1', from: 'u_me', to: 'u_friend', status: 'accepted', createdAt: NOW - 9000_000 }],
  blocks: [],
  conversations: [
    { id: 'conv1', participants: ['u_me', 'u_friend'], isGroup: false, createdAt: NOW - 7200_000 },
    { id: 'conv2', participants: ['u_me', 'u_friend', 'bot_nova'], isGroup: true, title: 'Weekend Plans', createdAt: NOW - 3600_000 }
  ],
  messages: [
    { id: 'm1', conversationId: 'conv1', participants: ['u_me', 'u_friend'], senderId: 'u_friend', text: 'Hello Mamun, this is a rather long message that should truncate nicely in the list', image: '', audio: '', createdAt: NOW - 1000, status: 'sent', readBy: ['u_friend'] }
  ],
  notifications: [
    { id: 'n1', userId: 'u_me', type: 'friend_request', actorId: 'u_friend', text: 'Ayesha Khan sent you a friend request.', read: false, createdAt: NOW },
    { id: 'n2', userId: 'u_me', type: 'friend_request', actorId: 'u_friend', text: 'Ayesha Khan sent you a friend request.', read: false, createdAt: NOW - 1000 },
    { id: 'n3', userId: 'u_me', type: 'friend_request', actorId: 'u_friend', text: 'Ayesha Khan sent you a friend request.', read: false, createdAt: NOW - 2000 },
    { id: 'n4', userId: 'u_me', type: 'friend_request', actorId: 'u_friend', text: 'Ayesha Khan sent you a friend request.', read: false, createdAt: NOW - 3000 },
    { id: 'n5', userId: 'u_me', type: 'friend_request', actorId: 'u_friend', text: 'Ayesha Khan sent you a friend request.', read: false, createdAt: NOW - 2 * 3600_000 },
    { id: 'n6', userId: 'u_me', type: 'like', actorId: 'bot_nova', text: 'Nova liked your post.', read: false, createdAt: NOW - 5000 }
  ],
  groups: [{ id: 'g1', name: 'Test Group', description: 'A group.', privacy: 'public', members: ['u_me', 'u_friend'], createdBy: 'u_friend', createdAt: NOW - 5000_000 }],
  pages: [{ id: 'pg1', name: 'MeetBook Test Page', category: 'Community', about: 'A page.', avatar: '', ownerId: 'u_friend', followers: ['u_me'], createdAt: NOW - 5000_000 }],
  stories: [], events: [], reviews: [], announcements: [], bots: [], botSettings: {},
  config: { platformName: 'MeetBook' }
};
const ctx = V.viewCtx(d, me);

// ------------------------------------------------------- #7 merge dedupe
describe('mergePostLists', () => {
  it('dedupes by id across the three listener lists, later lists win', () => {
    const merged = mergePostLists(
      [{ id: 'a', v: 1 }],
      [{ id: 'a', v: 2 }, { id: 'b', v: 1 }],
      [{ id: 'c', v: 1 }]
    );
    expect(merged.map((p) => p.id)).toEqual(['a', 'b', 'c']);
    expect(merged.find((p) => p.id === 'a').v).toBe(2);
  });
  it('tolerates empty / missing lists', () => {
    expect(mergePostLists([], null, [{ id: 'x' }])).toEqual([{ id: 'x' }]);
    expect(mergePostLists()).toEqual([]);
  });
});

describe('collapseDuplicateNotifications', () => {
  const n = (id, extra = {}) => ({ id, userId: 'u_me', type: 'friend_request', actorId: 'u_friend', text: 'Ayesha Khan sent you a friend request.', createdAt: NOW, ...extra });
  it('collapses exact duplicates within the hour, keeping the newest', () => {
    const out = collapseDuplicateNotifications([n('a'), n('b', { createdAt: NOW - 1000 }), n('c', { createdAt: NOW - 2000 })]);
    expect(out.map((x) => x.id)).toEqual(['a']);
  });
  it('keeps copies more than an hour apart, and different text/actors', () => {
    const out = collapseDuplicateNotifications([
      n('a'), n('b', { createdAt: NOW - 2 * 3600_000 }),
      n('c', { text: 'Different text.' }),
      n('d', { actorId: 'bot_nova', text: 'Nova sent you a friend request.' })
    ]);
    expect(out.map((x) => x.id)).toEqual(['a', 'b', 'c', 'd']);
  });
  it('does not mutate the input', () => {
    const input = [n('a'), n('b')];
    collapseDuplicateNotifications(input);
    expect(input).toHaveLength(2);
  });
});

// ------------------------------------------------------- #3 memories route
describe('memoriesView', () => {
  it('renders the on-this-day post as a full card', () => {
    const html = V.memoriesView(d, me);
    expect(html).toContain('Memory from two years ago');
    expect(html).toContain('2');
    expect(html).toContain('post-card');
  });
  it('renders an empty state when there is no memory today', () => {
    const empty = { ...d, posts: d.posts.filter((p) => p.id !== 'p_memory') };
    expect(memoriesFor(empty.posts, me.id)).toEqual([]);
    expect(V.memoriesView(empty, me)).toContain(t('memoriesEmpty'));
  });
  it('the left rail and the memories view both link #/memories', () => {
    expect(V.leftRail(d, me)).toContain('#/memories');
  });
});

// ------------------------------------------------------- #7b notifications view
describe('notificationsView', () => {
  it('collapses the four identical friend-request documents into one line', () => {
    const html = V.notificationsView(d, me);
    const count = html.split('sent you a friend request').length - 1;
    expect(count).toBe(2); // one for the within-hour cluster, one for the 2h-old copy
    expect(html).toContain('Mark all read');
  });
  it('localizes notification bodies and chrome in Bangla', () => {
    setLocale('bn');
    const html = V.notificationsView(d, me);
    expect(html).toContain('আপনাকে বন্ধুর অনুরোধ পাঠিয়েছেন');
    expect(html).toContain('সব পড়া হিসেবে চিহ্নিত করুন');
    expect(html).toContain('আপনার পোস্টে লাইক দিয়েছেন');
  });
});

// ------------------------------------------------------- #9 Bangla gaps
describe('Bangla strings', () => {
  it('feed composer privacy options, photo label and feelings are translated', () => {
    setLocale('bn');
    const html = V.feedView(d, me, 1);
    expect(html).toContain('শুধু আমি');
    expect(html).toContain('পাবলিক');
    expect(html).toContain('ছবি');
    expect(html).toContain('খুশি');
    expect(html).not.toContain('>🌍 Public<');
    expect(html).not.toContain('>🔒 Only me<');
  });
  it('comment placeholder and empty state are translated', () => {
    setLocale('bn');
    const html = postCardHtml(post('px', { comments: [] }), ctx);
    expect(html).toContain('একটি মন্তব্য লিখুন');
    expect(html).toContain('এখনও কোনো মন্তব্য নেই');
  });
  it('settings policy links and privacy options are translated', () => {
    setLocale('bn');
    const html = V.settingsView(d, me, { theme: 'light', locale: 'bn' });
    expect(html).toContain('গোপনীয়তা নীতি');
    expect(html).toContain('পরিষেবার শর্তাবলী');
    expect(html).toContain('কমিউনিটি নির্দেশিকা');
    expect(html).toContain('শুধু আমি');
  });
});

// ------------------------------------------------------- #15 search
describe('searchView', () => {
  it('finds a bot post by the author name', () => {
    const html = V.searchView(d, me, 'Nova');
    expect(html).toContain('Nova loves space facts.');
  });
  it('finds group posts and page posts', () => {
    expect(V.searchView(d, me, 'books')).toContain('Group discussion about books');
    expect(V.searchView(d, me, 'Page update')).toContain('Page update');
  });
});

// ------------------------------------------------------- #15 settings danger zone
describe('settingsView danger zone', () => {
  it('delete-account sits in its own danger-zone card, after Log out', () => {
    const html = V.settingsView(d, me, { theme: 'light', locale: 'en' });
    expect(html).toContain('danger-zone');
    expect(html).toContain('Danger zone');
    expect(html.indexOf('data-act="logout"')).toBeLessThan(html.indexOf('data-act="delete-account"'));
    expect(html.indexOf('danger-zone')).toBeLessThan(html.indexOf('data-act="delete-account"'));
    expect(html.split('data-act="delete-account"').length - 1).toBe(1);
  });
});

// ------------------------------------------------------- #5/#8/#13 chat
describe('messagesView', () => {
  it('anchors the emoji panel inside a composer wrapper above the form', () => {
    const html = V.messagesView(d, me, 'conv1');
    expect(html).toContain('composer-wrap');
    expect(html).toContain('id="emoji-panel"');
    expect(html.indexOf('composer-wrap')).toBeLessThan(html.indexOf('id="emoji-panel"'));
    expect(html).toContain('emoji-btn');
  });
  it('attaches photos through a label bound to the file input, with a preview slot', () => {
    const html = V.messagesView(d, me, 'conv1');
    expect(html).toContain('id="msg-image-input"');
    expect(html).toContain('for="msg-image-input"');
    expect(html).toContain('id="message-preview"');
  });
  it('renders the full preview with CSS ellipsis instead of a mid-word JS slice', () => {
    const html = V.messagesView(d, me, 'conv1');
    expect(html).toContain('conv-preview');
    expect(html).toContain('Hello Mamun, this is a rather long message that should truncate nicely in the list');
  });
  it('keeps the report flag inline with the message footer', () => {
    const html = V.messagesView(d, me, 'conv1');
    expect(html).toContain('msg-foot');
    expect(html).toContain('msg-report-btn');
  });
});

// ------------------------------------------------------- #1/#10/#14 headers
describe('profile / page headers', () => {
  it('profile header renders the name inside .profile-meta after the cover', () => {
    const html = V.profileView(d, me, 'u_me');
    expect(html).toContain('<div class="cover"');
    expect(html).toContain('<div class="profile-meta">');
    expect(html.indexOf('<div class="cover"')).toBeLessThan(html.indexOf('<div class="profile-meta">'));
    expect(html).toContain('Mamun Hossen');
  });
  it('renders Photos and Friends strips when the user has photo posts and friends', () => {
    const html = V.profileView(d, me, 'u_me');
    expect(html).toContain('strip-card');
    expect(html).toContain('Photos');
    expect(html).toContain('Friends');
  });
  it('renders Photos and Friends strips with empty states for a user with no photo posts and no friends (Audit fix #7)', () => {
    const emptyUser = { ...friend, id: 'u_empty', name: 'Empty User', username: 'empty' };
    const dd = { ...d, users: [...d.users, emptyUser], posts: d.posts.filter((p) => p.authorId !== 'u_empty') };
    const html = V.profileView(dd, me, 'u_empty');
    // The strips always render now — with clean empty states instead
    // of vanishing — so the profile layout is consistent.
    expect(html).toContain('strip-card');
    expect(html).toContain('Photos');
    expect(html).toContain('Friends');
    expect(html).toContain('No photos yet.');
    expect(html).toContain('No friends yet.');
    expect(html).not.toContain('photos-grid');
  });
  it('page header does not append a Page badge to the page name', () => {
    const html = V.pageView(d, me, 'pg1');
    const h2 = html.slice(html.indexOf('<h2>'), html.indexOf('</h2>'));
    expect(h2).toContain('MeetBook Test Page');
    expect(h2).not.toContain('badge');
  });
  it('review header separates name, stars and time', () => {
    const dd = { ...d, reviews: [{ id: 'r1', pageId: 'pg1', authorId: 'u_friend', rating: 5, text: 'Great page', createdAt: NOW - 1000 }] };
    const html = V.pageView(dd, me, 'pg1');
    expect(html).toContain('Ayesha Khan</b> <span class="stars">');
    expect(html).toContain('· ');
  });
});

// ------------------------------------------------------- #2 admin tables
describe('adminUsersView', () => {
  it('marks date/status/username cells no-wrap and keeps the scrollable table', () => {
    const html = V.adminUsersView(d, me, {});
    expect(html).toContain('admin-users-table');
    expect(html).toContain('table-wrap');
    expect(html).toContain('cell-nowrap');
    expect(html).toContain('cell-email');
  });
});

// ------------------------------------------------------- #16 autocomplete
describe('authView autocomplete', () => {
  it('login uses username / current-password', () => {
    const html = V.authView('login');
    expect(html).toContain('autocomplete="username"');
    expect(html).toContain('autocomplete="current-password"');
  });
  it('register uses new-password for both password fields', () => {
    const html = V.authView('register');
    expect((html.match(/autocomplete="new-password"/g) || []).length).toBe(2);
    expect(html).toContain('autocomplete="name"');
  });
});

// ------------------------------------------------------- (A) Super Admin badge
describe('userNameHtml Super Admin badge', () => {
  it('superadmin renders a distinct gold Super Admin badge', () => {
    const html = userNameHtml({ name: 'S', username: 's', role: 'superadmin' });
    expect(html).toContain('badge-superadmin');
    expect(html).toContain('Super Admin');
    expect(html).not.toContain('badge-admin');
  });
  it('admin keeps the plain Admin badge', () => {
    const html = userNameHtml({ name: 'A', username: 'a', role: 'admin' });
    expect(html).toContain('badge-admin');
    expect(html).not.toContain('badge-superadmin');
  });
  it('localizes both badges in Bangla', () => {
    setLocale('bn');
    expect(userNameHtml({ name: 'S', username: 's', role: 'superadmin' })).toContain('সুপার অ্যাডমিন');
    expect(userNameHtml({ name: 'A', username: 'a', role: 'admin' })).toContain('অ্যাডমিন');
  });
});

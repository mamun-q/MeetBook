// Full Audit #3 (2026-11-21) — notification deep-link targets.
// Group/page/event notifications used to carry no target id at all,
// so tapping them dumped the user on the home feed. The view must
// stamp every target the notif-open handler routes on.
import { describe, it, expect } from 'vitest';
import * as V from '../src/views.js';

const NOW = Date.now();
const me = { id: 'u_me', name: 'Mamun', username: 'md.mamun', role: 'user', isBot: false, followers: [], following: [], settings: {}, createdAt: NOW - 1000 };
const actor = { id: 'u_actor', name: 'Ayesha Khan', username: 'ayesha', role: 'user', isBot: false, followers: [], following: [], settings: {}, createdAt: NOW - 2000 };

const note = (id, extra = {}) => ({
  id, userId: 'u_me', type: 'like', actorId: 'u_actor', text: 'Ayesha Khan liked your post.',
  postId: '', conversationId: '', read: false, createdAt: NOW, ...extra
});

const d = {
  users: [me, actor],
  posts: [], friendships: [], blocks: [], conversations: [], messages: [],
  notifications: [
    note('n_group', { type: 'group_join', groupId: 'g42', text: 'Ayesha Khan joined your group "Book Club".' }),
    note('n_page', { type: 'page_follow', pageId: 'pg7', text: 'Ayesha Khan started following your page "Notes".' }),
    note('n_event', { type: 'event_rsvp', eventId: 'ev9', text: 'Ayesha Khan is going to your event "Meetup".' }),
    note('n_post', { type: 'like', postId: 'p55' }),
    note('n_msg', { type: 'message', conversationId: 'conv3', text: 'Ayesha Khan sent you a message.' }),
  ],
  groups: [], pages: [], events: [], stories: [], memories: [], groupRequests: [],
  bots: [], botSettings: {}, botSecrets: {}, config: {}, aiUsage: {}, providerHealth: {},
  botMemories: {}, botActivities: [], botLogs: [], reports: [], announcements: [],
  adminStats: null, botRunner: null, friendshipsLoaded: true
};

describe('notificationsView target stamps (Audit #3)', () => {
  const html = V.notificationsView(d, me);
  it('stamps the group id so group notifications open the group', () => {
    expect(html).toContain('data-group="g42"');
  });
  it('stamps the page id and event id', () => {
    expect(html).toContain('data-page="pg7"');
    expect(html).toContain('data-event="ev9"');
  });
  it('stamps actor, post and conversation ids', () => {
    expect(html).toContain('data-actor="u_actor"');
    expect(html).toContain('data-post="p55"');
    expect(html).toContain('data-conv="conv3"');
  });
});

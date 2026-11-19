// Mobile Fix Pack — live-mode optimistic updates (fake Firestore):
// like / reaction / save / poll vote / comment / create-post / share
// apply to the local mirror immediately (before the snapshot lands),
// createPost echoes under a temp id and settles to exactly one copy,
// and sendFriendRequest never duplicates its notification.
import { describe, it, expect, vi, beforeAll } from 'vitest';

vi.mock('../src/firebase.js', () => ({
  firebaseReady: true, isFirebaseConfigured: true, firebaseConfig: {},
  app: {}, auth: { fake: 'auth' }, db: { fake: 'db' }, storage: null, googleProvider: null
}));
vi.mock('firebase/firestore', async () => await import('./fake-firestore.js'));
vi.mock('firebase/auth', async () => (await import('./fake-firestore.js')).fakeAuth);
vi.mock('firebase/storage', () => ({
  ref: () => ({}), uploadBytes: async () => ({}), getDownloadURL: async () => ''
}));

const mem = new Map();
globalThis.localStorage = {
  getItem: (k) => (mem.has(k) ? mem.get(k) : null),
  setItem: (k, v) => mem.set(k, String(v)),
  removeItem: (k) => mem.delete(k)
};
globalThis.document = { dispatchEvent: () => true };

let api;
let fake;
const settle = async () => { await new Promise((r) => setTimeout(r, 15)); await new Promise((r) => setTimeout(r, 15)); };
const mirrorPost = (id) => api.data().posts.find((p) => p.id === id);

beforeAll(async () => {
  fake = (await import('./fake-firestore.js')).fakeControl;
  fake.reset();
  fake.usersByEmail = { 'me@example.com': 'human1', 'friend@example.com': 'human2' };
  fake.seed('users', 'human1', { name: 'Mamun Hossen', username: 'your.name', email: 'me@example.com', role: 'user', isBot: false, followers: [], following: [], closeFriends: [], settings: {} });
  fake.seed('users', 'human2', { name: 'Ayesha Khan', username: 'ayesha', email: 'friend@example.com', role: 'user', isBot: false, followers: [], following: [], closeFriends: [], settings: {} });
  fake.seed('posts', 'post1', {
    authorId: 'human2', text: 'Hello world from Ayesha', image: '', visibility: 'public', audienceIds: [],
    createdAt: Date.now() - 60_000, editedAt: 0, likes: [], reactions: {}, comments: [], shares: 0,
    sharedFrom: '', savedBy: [], groupId: '', pageId: '', pageName: '', pageAvatar: ''
  });
  fake.seed('posts', 'post2', {
    authorId: 'human2', text: 'Poll post', image: '', visibility: 'public', audienceIds: [],
    createdAt: Date.now() - 50_000, editedAt: 0, likes: [], reactions: {}, comments: [], shares: 0,
    sharedFrom: '', savedBy: [], groupId: '', pageId: '', pageName: '', pageAvatar: '',
    poll: { options: [{ id: 'o1', text: 'Yes' }, { id: 'o2', text: 'No' }], votes: {} }
  });
  api = await import('../src/api.js');
  api.onAuthReady(() => {});
  await api.login('me@example.com', 'password123');
  await settle();
});

describe('live optimistic engagement', () => {
  it('like flips the mirror immediately and persists in Firestore', async () => {
    const likeCall = api.toggleLike('post1');
    expect(mirrorPost('post1').likes).toContain('human1');
    await likeCall;
    await settle();
    expect(mirrorPost('post1').likes).toContain('human1');
    expect(fake.get('posts', 'post1').likes).toContain('human1');
  });

  it('unlike removes the like from the mirror immediately', async () => {
    const unlikeCall = api.toggleLike('post1');
    expect(mirrorPost('post1').likes).not.toContain('human1');
    await unlikeCall;
    await settle();
    expect(fake.get('posts', 'post1').likes).not.toContain('human1');
  });

  it('reaction and save patch the mirror immediately', async () => {
    const reactCall = api.toggleReaction('post1', '❤️');
    expect(mirrorPost('post1').reactions.human1).toBe('❤️');
    await reactCall;
    const saveCall = api.toggleSave('post1');
    expect(mirrorPost('post1').savedBy).toContain('human1');
    await saveCall;
    await settle();
    expect(fake.get('posts', 'post1').reactions.human1).toBe('❤️');
    expect(fake.get('posts', 'post1').savedBy).toContain('human1');
  });

  it('poll vote patches the mirror immediately', async () => {
    const voteCall = api.votePoll('post2', 'o1');
    expect(mirrorPost('post2').poll.votes.human1).toBe('o1');
    await voteCall;
    await settle();
    expect(fake.get('posts', 'post2').poll.votes.human1).toBe('o1');
  });

  it('comment appears in the mirror immediately', async () => {
    const commentCall = api.addComment('post1', 'Nice post!');
    expect(mirrorPost('post1').comments.some((c) => c.text === 'Nice post!')).toBe(true);
    const comment = await commentCall;
    expect(comment.text).toBe('Nice post!');
    await settle();
    expect(fake.get('posts', 'post1').comments.some((c) => c.id === comment.id)).toBe(true);
    expect(mirrorPost('post1').comments.some((c) => c.id === comment.id)).toBe(true);
  });

  it('createPost echoes immediately and settles to exactly one copy', async () => {
    const createCall = api.createPost({ text: 'Echo post body', visibility: 'public' });
    const echoed = api.data().posts.filter((p) => p.text === 'Echo post body');
    expect(echoed).toHaveLength(1);
    expect(echoed[0].id).toMatch(/^local_/);
    const created = await createCall;
    expect(created.id).not.toMatch(/^local_/);
    await settle();
    const settled = api.data().posts.filter((p) => p.text === 'Echo post body');
    expect(settled).toHaveLength(1);
    expect(settled[0].id).toBe(created.id);
  });

  it('share echoes immediately and bumps the share count in the mirror', async () => {
    const before = mirrorPost('post1').shares;
    const shareCall = api.sharePost('post1');
    expect(api.data().posts.filter((p) => p.sharedFrom === 'human2')).toHaveLength(1);
    expect(mirrorPost('post1').shares).toBe(before + 1);
    await shareCall;
    await settle();
    expect(api.data().posts.filter((p) => p.sharedFrom === 'human2')).toHaveLength(1);
    expect(fake.get('posts', 'post1').shares).toBe(before + 1);
  });
});

describe('live friend-request dedupe', () => {
  it('calling sendFriendRequest twice writes exactly one notification', async () => {
    await api.sendFriendRequest('human2');
    await settle();
    await api.sendFriendRequest('human2');
    await settle();
    const notifs = fake.all('notifications').filter((n) => n.userId === 'human2' && n.type === 'friend_request');
    expect(notifs).toHaveLength(1);
    const friendships = fake.all('friendships');
    expect(friendships).toHaveLength(1);
    expect(friendships[0].status).toBe('pending');
  });
});

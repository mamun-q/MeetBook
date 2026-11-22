// Supabase write-path fixes (2026-11-22 live sweep) — LIVE mode
// against the fake Supabase, which now models Postgres's RETURNING
// visibility rule for notifications (an INSERT ... RETURNING a row
// the caller may not SELECT fails with 42501). Pins:
//  - createNotification stores cross-user notifications (it must
//    insert WITHOUT .select()); page follows therefore succeed and
//    like notifications actually land instead of being swallowed.
//  - toggleFollow / toggleFollowPage compute their followers delta
//    from fresh server rows and patch the mirror immediately, so
//    follow → unfollow → follow is a clean toggle end to end.
//  - editPost throws on a zero-row update instead of letting the UI
//    toast success, and patches the mirror with the confirmed text.
//  - deletePost removes the post from the mirror at once.
//  - updateProfile patches the mirror with the confirmed write.
//  - createGroup / createEvent / createStory mirror the confirmed
//    row at once (local echoes) and never duplicate it once the
//    realtime slice delivers the server copy.
import { describe, it, expect, vi, beforeAll } from 'vitest';

vi.mock('../src/supabase.js', async () => {
  const fake = await import('./fake-supabase.js');
  return {
    supabaseReady: true, isSupabaseConfigured: true,
    supabaseConfig: { url: 'https://fake.supabase.co', publishableKey: 'fake', projectRef: 'fake' },
    supabase: fake.fakeClient
  };
});

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
const mirrorUser = (id) => api.data().users.find((u) => u.id === id);
const mirrorPost = (id) => api.data().posts.find((p) => p.id === id);
const notesFor = (userId, type) => fake.all('notifications').filter((n) => n.userId === userId && (!type || n.type === type));

const postRow = (id, authorId, text) => ({
  authorId, text, image: '', visibility: 'public', audienceIds: [],
  createdAt: Date.now() - 60_000, editedAt: 0, likes: [], reactions: {},
  comments: [], shares: 0, sharedFrom: '', savedBy: [], groupId: '', pageId: '',
  pageName: '', pageAvatar: '', poll: null, location: '', feeling: '', pinned: false
});

beforeAll(async () => {
  fake = (await import('./fake-supabase.js')).fakeControl;
  fake.reset();
  fake.usersByEmail = { 'me@example.com': 'human1', 'friend@example.com': 'human2' };
  fake.seed('users', 'human1', { name: 'Mamun Hossen', username: 'your.name', email: 'me@example.com', role: 'user', isBot: false, bio: '', followers: [], following: [], closeFriends: [], settings: {} });
  fake.seed('users', 'human2', { name: 'Ayesha Khan', username: 'ayesha', email: 'friend@example.com', role: 'user', isBot: false, bio: '', followers: [], following: [], closeFriends: [], settings: {} });
  fake.seed('pages', 'pg1', { name: 'Ayesha Page', category: 'Community', about: '', avatar: '', cover: '', ownerId: 'human2', followers: [], createdAt: Date.now() - 60_000 });
  fake.seed('posts', 'post_theirs', postRow('post_theirs', 'human2', 'Ayesha post'));
  fake.seed('posts', 'post_mine', postRow('post_mine', 'human1', 'Original text'));
  api = await import('../src/api.js');
  api.onAuthReady(() => {});
  await api.login('me@example.com', 'password123');
  await settle();
});

describe('live write fixes — follows and notifications', () => {
  it('toggleFollow writes both sides, notifies, and flips the mirror at once', async () => {
    const nowFollowing = await api.toggleFollow('human2');
    expect(nowFollowing).toBe(true);
    expect(fake.get('users', 'human1').following).toContain('human2');
    expect(fake.get('users', 'human2').followers).toContain('human1');
    // Mirror reflects the confirmed follow WITHOUT waiting for a refetch.
    expect(mirrorUser('human2').followers).toContain('human1');
    expect(mirrorUser('human1').following).toContain('human2');
    // The follow notification is stored for the target (regression:
    // a RETURNING insert used to 42501 and lose it silently).
    expect(notesFor('human2', 'follow').length).toBe(1);
    await settle();
  });

  it('toggleFollow again is a clean unfollow (the sweep could not test this)', async () => {
    const nowFollowing = await api.toggleFollow('human2');
    expect(nowFollowing).toBe(false);
    expect(fake.get('users', 'human1').following).not.toContain('human2');
    expect(fake.get('users', 'human2').followers).not.toContain('human1');
    expect(mirrorUser('human2').followers).not.toContain('human1');
    await settle();
    // And following once more still works — no no-diff RLS error.
    expect(await api.toggleFollow('human2')).toBe(true);
    expect(fake.get('users', 'human2').followers).toContain('human1');
    await api.toggleFollow('human2');
    await settle();
  });

  it('toggleFollowPage succeeds and stores the page_follow notification', async () => {
    const nowFollowing = await api.toggleFollowPage('pg1');
    expect(nowFollowing).toBe(true);
    expect(fake.get('pages', 'pg1').followers).toContain('human1');
    expect(api.data().pages.find((p) => p.id === 'pg1').followers).toContain('human1');
    expect(notesFor('human2', 'page_follow').length).toBe(1);
    await settle();
  });

  it('liking another user\'s post stores a like notification for its author', async () => {
    await api.toggleLike('post_theirs');
    await settle();
    expect(notesFor('human2', 'like').length).toBe(1);
  });
});

describe('live write fixes — posts and profile', () => {
  it('editPost persists and patches the mirror immediately', async () => {
    await api.editPost('post_mine', 'Edited text');
    expect(fake.get('posts', 'post_mine').text).toBe('Edited text');
    expect(mirrorPost('post_mine').text).toBe('Edited text'); // no settle: mirror already patched
    await settle();
  });

  it('editPost on a missing post throws instead of faking success', async () => {
    await expect(api.editPost('post_gone', 'x')).rejects.toThrow();
  });

  it('deletePost removes the post from the mirror at once', async () => {
    await api.deletePost('post_mine');
    expect(mirrorPost('post_mine')).toBeUndefined(); // no settle: gone immediately
    expect(fake.get('posts', 'post_mine')).toBeUndefined();
    await settle();
    expect(mirrorPost('post_mine')).toBeUndefined();
  });

  it('updateProfile persists the bio and patches the mirror at once', async () => {
    await api.updateProfile('human1', { bio: 'Hello from the test' });
    expect(fake.get('users', 'human1').bio).toBe('Hello from the test');
    expect(mirrorUser('human1').bio).toBe('Hello from the test'); // no settle
    await settle();
  });
});

describe('live write fixes — created content is visible to its creator at once', () => {
  it('createGroup mirrors the group immediately and never duplicates it', async () => {
    const g = await api.createGroup({ name: 'Sweep Group', description: '', privacy: 'public', cover: '' });
    expect(api.data().groups.filter((x) => x.id === g.id).length).toBe(1); // no settle: echo present
    await settle();
    expect(api.data().groups.filter((x) => x.id === g.id).length).toBe(1); // server copy replaced the echo
    expect(fake.get('groups', g.id).name).toBe('Sweep Group');
  });

  it('createEvent mirrors the event immediately and never duplicates it', async () => {
    const ev = await api.createEvent({ title: 'Sweep Event', description: '', dateTime: Date.now() + 86_400_000, location: '', cover: '', visibility: 'public' });
    expect(api.data().events.filter((x) => x.id === ev.id).length).toBe(1);
    await settle();
    expect(api.data().events.filter((x) => x.id === ev.id).length).toBe(1);
    expect(fake.get('events', ev.id).title).toBe('Sweep Event');
  });

  it('createStory mirrors the story immediately and never duplicates it', async () => {
    const st = await api.createStory({ text: 'Sweep story', image: '', bg: 'sunset', visibility: 'public' });
    expect(api.data().stories.filter((x) => x.id === st.id).length).toBe(1);
    await settle();
    expect(api.data().stories.filter((x) => x.id === st.id).length).toBe(1);
    expect(fake.get('stories', st.id).text).toBe('Sweep story');
  });
});

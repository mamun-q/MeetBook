// Demo/offline data store. When Firebase env config is absent the whole app
// runs against this store, persisted in localStorage, with seeded people,
// posts and AI bots so every feature is genuinely usable before (and while)
// Firebase is wired up. The data shapes mirror the Firestore schema exactly.
import { uid } from './utils.js';
import { normaliseBot, DEFAULT_BOT_LIMITS } from './botLogic.js';

const KEY = 'meetbook_demo_v2';
const listeners = new Set();

export function subscribe(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function emit() {
  for (const fn of listeners) {
    try { fn(state); } catch { /* listener errors must not break the store */ }
  }
}

const now = Date.now();
const H = 3600_000;

function seed() {
  const users = [
    { id: 'u_admin', name: 'MeetBook Admin', username: 'admin.team', email: 'admin@meetbook.app', password: 'admin123', bio: 'Platform administrator.', avatar: '', cover: '', role: 'admin', isBot: false, online: true, createdAt: now - 90 * 24 * H, followers: [], following: [], settings: {} },
    { id: 'u_ayesha', name: 'Ayesha Rahman', username: 'ayesha.r', email: 'ayesha@example.com', password: 'demo123', bio: 'Photographer 📷 | Dhaka | Chasing light and stories.', avatar: '', cover: '', role: 'user', isBot: false, online: true, createdAt: now - 60 * 24 * H, followers: [], following: [], settings: {} },
    { id: 'u_tanvir', name: 'Tanvir Hasan', username: 'tanvir.h', email: 'tanvir@example.com', password: 'demo123', bio: 'Software engineer. Coffee first, code second.', avatar: '', cover: '', role: 'user', isBot: false, online: false, createdAt: now - 45 * 24 * H, followers: [], following: [], settings: {} },
    { id: 'u_priya', name: 'Priya Das', username: 'priya.d', email: 'priya@example.com', password: 'demo123', bio: 'Book lover and amateur chef. Here for good conversations.', avatar: '', cover: '', role: 'user', isBot: false, online: true, createdAt: now - 30 * 24 * H, followers: [], following: [], settings: {} }
  ];

  const botDefs = [
    { id: 'bot_nova', name: 'Nova', username: 'nova.bot', bio: 'AI Bot · Curious about space, science and big questions.', personality: { traits: ['curious', 'witty'], tone: 'bright and playful', interests: ['space', 'science', 'technology'], systemPrompt: 'You are Nova, a curious AI bot on MeetBook who loves space and science. You are clearly an AI bot. Keep posts short, bright and curious.' } },
    { id: 'bot_pixel', name: 'Pixel', username: 'pixel.bot', bio: 'AI Bot · Into art, design and photography prompts.', personality: { traits: ['creative', 'gentle'], tone: 'warm and artistic', interests: ['art', 'photography', 'design'], systemPrompt: 'You are Pixel, a creative AI bot on MeetBook who loves art and photography. You are clearly an AI bot. Be gentle and encouraging.' } },
    { id: 'bot_sage', name: 'Sage', username: 'sage.bot', bio: 'AI Bot · Shares calm thoughts, books and study tips.', personality: { traits: ['calm', 'thoughtful'], tone: 'calm and wise', interests: ['books', 'mindfulness', 'study tips'], systemPrompt: 'You are Sage, a calm AI bot on MeetBook who shares book thoughts and study tips. You are clearly an AI bot. Be thoughtful and brief.' } }
  ];
  const bots = botDefs.map((b, i) => normaliseBot({ ...b, active: true, limits: { ...DEFAULT_BOT_LIMITS }, createdAt: now - (20 - i) * 24 * H }));
  for (const b of bots) {
    users.push({ id: b.id, name: b.name, username: b.username, email: '', password: '', bio: b.bio, avatar: '', cover: '', role: 'bot', isBot: true, botId: b.id, online: true, createdAt: b.createdAt, followers: [], following: [], settings: {} });
  }

  const posts = [
    { id: 'p_1', authorId: 'u_ayesha', text: 'Golden hour over the Buriganga today. Dhaka can be quietly beautiful when you slow down. 🌇', image: '', visibility: 'public', createdAt: now - 2 * H, editedAt: 0, likes: ['u_tanvir', 'bot_pixel'], reactions: { u_tanvir: '❤️' }, comments: [ { id: 'c_1', authorId: 'bot_pixel', text: 'The light in this city really is special. Lovely share!', createdAt: now - 1.5 * H, replies: [] } ], shares: 1, sharedFrom: '', savedBy: [] },
    { id: 'p_2', authorId: 'bot_nova', text: 'AI Bot post · A new exoplanet was found in the habitable zone of a nearby star. If you could name a planet, what would you call it?', image: '', visibility: 'public', createdAt: now - 4 * H, editedAt: 0, likes: ['u_priya'], reactions: {}, comments: [], shares: 0, sharedFrom: '', savedBy: [] },
    { id: 'p_3', authorId: 'u_tanvir', text: 'Shipped my first open-source PR today. Small fix, big feeling. Keep going, everyone. 💪', image: '', visibility: 'public', createdAt: now - 7 * H, editedAt: 0, likes: ['u_ayesha', 'u_priya', 'bot_nova'], reactions: { u_priya: '👏' }, comments: [ { id: 'c_2', authorId: 'u_priya', text: 'Congrats! First of many.', createdAt: now - 6 * H, replies: [ { id: 'c_2r', authorId: 'u_tanvir', text: 'Thank you! 🙏', createdAt: now - 5.5 * H } ] } ], shares: 0, sharedFrom: '', savedBy: [] },
    { id: 'p_4', authorId: 'bot_sage', text: 'AI Bot post · Book note of the day: re-reading a favourite chapter slowly teaches you more than rushing a new book. What are you reading?', image: '', visibility: 'public', createdAt: now - 10 * H, editedAt: 0, likes: [], reactions: {}, comments: [], shares: 0, sharedFrom: '', savedBy: [] },
    { id: 'p_5', authorId: 'u_priya', text: 'Tried a new mishti doi recipe and it actually set properly this time. Small kitchen victories count. 🍮', image: '', visibility: 'friends', createdAt: now - 12 * H, editedAt: 0, likes: ['u_ayesha'], reactions: {}, comments: [], shares: 0, sharedFrom: '', savedBy: [] }
  ];

  return {
    users,
    sessionUid: '',
    posts,
    friendships: [
      { id: 'f_1', from: 'u_ayesha', to: 'u_tanvir', status: 'accepted', createdAt: now - 20 * 24 * H },
      { id: 'f_2', from: 'u_ayesha', to: 'u_priya', status: 'accepted', createdAt: now - 18 * 24 * H },
      { id: 'f_3', from: 'u_tanvir', to: 'u_priya', status: 'accepted', createdAt: now - 15 * 24 * H }
    ],
    blocks: [], // {by, target}
    conversations: [
      { id: 'conv_1', participants: ['u_ayesha', 'bot_sage'], createdAt: now - 26 * H }
    ],
    messages: [
      { id: 'm_1', conversationId: 'conv_1', senderId: 'bot_sage', text: 'Hello! I am Sage, an AI bot. Ask me about books or study tips any time.', image: '', createdAt: now - 26 * H, status: 'read', readBy: ['bot_sage'] }
    ],
    notifications: [],
    reports: [],
    bots,
    botBrains: Object.fromEntries(bots.map((b) => [b.id, { botId: b.id, systemPrompt: b.personality.systemPrompt, model: 'template-fallback', provider: 'gemini-ready', updatedAt: now - 24 * H }])),
    botMemories: Object.fromEntries(bots.map((b) => [b.id, [
      { id: uid('mem'), text: `${b.name} enjoys talking about ${b.personality.interests.join(' and ')}.`, createdAt: now - 5 * 24 * H, updatedAt: now - 5 * 24 * H, pinned: true },
      { id: uid('mem'), text: 'People on MeetBook respond warmly to questions at the end of a post.', createdAt: now - 2 * 24 * H, updatedAt: now - 2 * 24 * H, pinned: false }
    ]])),
    botActivities: [
      { id: uid('act'), botId: 'bot_nova', action: 'post', detail: 'Posted about a habitable-zone exoplanet.', createdAt: now - 4 * H, status: 'ok' },
      { id: uid('act'), botId: 'bot_pixel', action: 'comment', detail: 'Commented on Ayesha\'s post.', createdAt: now - 1.5 * H, status: 'ok' }
    ],
    botLogs: [
      { id: uid('log'), botId: 'bot_nova', level: 'info', message: 'Runner cycle completed: 1 post created.', createdAt: now - 4 * H }
    ],
    botSettings: { global: { enabled: true }, counters: {} },
    config: { maintenanceMode: false },
    aiUsage: { callsToday: 7, tokensToday: 2140, updatedAt: now }
  };
}

function load() {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (parsed && Array.isArray(parsed.users) && Array.isArray(parsed.posts)) return parsed;
    }
  } catch { /* corrupted storage -> reseed */ }
  return seed();
}

let state = load();

export function getState() {
  return state;
}

export function save() {
  try { localStorage.setItem(KEY, JSON.stringify(state)); } catch { /* storage full/blocked */ }
  emit();
}

export function mutate(fn) {
  fn(state);
  save();
  return state;
}

export function resetDemo() {
  state = seed();
  save();
}

export function findUser(id) {
  return state.users.find((u) => u.id === id) || null;
}

export function userByUsername(username) {
  return state.users.find((u) => u.username === String(username || '').toLowerCase()) || null;
}

export function friendIdsOf(uidValue) {
  const ids = new Set();
  for (const f of state.friendships) {
    if (f.status !== 'accepted') continue;
    if (f.from === uidValue) ids.add(f.to);
    if (f.to === uidValue) ids.add(f.from);
  }
  return ids;
}

export function blockedIdsOf(uidValue) {
  return new Set(state.blocks.filter((b) => b.by === uidValue).map((b) => b.target));
}

export function notify(userId, type, actorId, text, extra = {}) {
  if (userId === actorId) return;
  const target = findUser(userId);
  const prefs = target?.settings?.notifPrefs || {};
  if (prefs[type] === false) return;
  state.notifications.unshift({
    id: uid('n'), userId, type, actorId, text,
    postId: extra.postId || '', conversationId: extra.conversationId || '',
    read: false, createdAt: Date.now()
  });
}

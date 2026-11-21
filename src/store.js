// Demo/offline data store. When Firebase env config is absent the whole app
// runs against this store, persisted in localStorage, with seeded people,
// posts and AI bots so every feature is genuinely usable before (and while)
// Firebase is wired up. The data shapes mirror the Firestore schema exactly.
import { uid } from './utils.js';
import { normaliseBot, DEFAULT_BOT_LIMITS } from './botLogic.js';

const KEY = 'meetbook_demo_v6';
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
// Exactly one calendar year ago today — seeds the Memories card (the demo
// user's own "on this day" post).
const yearAgoDate = new Date(now);
yearAgoDate.setFullYear(yearAgoDate.getFullYear() - 1);
const yearAgo = yearAgoDate.getTime();

function seed() {
  const users = [
    { id: 'u_admin', name: 'MeetBook Admin', username: 'admin.team', email: 'admin@meetbook.app', password: 'admin123', bio: 'Platform administrator.', avatar: '', cover: '', work: 'MeetBook', education: '', currentCity: '', hometown: '', relationship: '', website: '', nickname: '', dob: '', gender: '', role: 'admin', isBot: false, online: true, lastSeen: now, createdAt: now - 90 * 24 * H, followers: [], following: [], closeFriends: [], settings: {} },
    { id: 'u_ayesha', name: 'Ayesha Rahman', username: 'ayesha.r', email: 'ayesha@example.com', password: 'demo123', bio: 'Photographer 📷 | Dhaka | Chasing light and stories.', avatar: '', cover: '', work: 'Freelance Photographer', education: 'University of Dhaka', currentCity: 'Dhaka', hometown: 'Chattogram', relationship: 'Single', website: '', nickname: 'Ash', dob: '1998-03-12', gender: 'Female', role: 'user', isBot: false, online: true, lastSeen: now, createdAt: now - 60 * 24 * H, followers: [], following: [], closeFriends: ['u_tanvir'], settings: {} },
    { id: 'u_tanvir', name: 'Tanvir Hasan', username: 'tanvir.h', email: 'tanvir@example.com', password: 'demo123', bio: 'Software engineer. Coffee first, code second.', avatar: '', cover: '', work: 'Software Engineer', education: 'BUET', currentCity: 'Dhaka', hometown: 'Khulna', relationship: 'In a relationship', website: '', nickname: '', dob: '1996-07-02', gender: 'Male', role: 'user', isBot: false, online: false, lastSeen: now - 26 * H, createdAt: now - 45 * 24 * H, followers: [], following: [], closeFriends: [], settings: {} },
    { id: 'u_priya', name: 'Priya Das', username: 'priya.d', email: 'priya@example.com', password: 'demo123', bio: 'Book lover and amateur chef. Here for good conversations.', avatar: '', cover: '', work: 'School Teacher', education: 'Eden Mohila College', currentCity: 'Dhaka', hometown: 'Dhaka', relationship: 'Married', website: '', nickname: '', dob: '', gender: 'Female', role: 'user', isBot: false, online: true, lastSeen: now, createdAt: now - 30 * 24 * H, followers: [], following: [], closeFriends: [], settings: {} }
  ];

  const botDefs = [
    { id: 'bot_nova', name: 'Nova', username: 'nova.bot', bio: 'Curious about space, science and big questions.', personality: { traits: ['curious', 'witty'], tone: 'bright and playful', interests: ['space', 'science', 'technology'], systemPrompt: 'You are Nova, a curious member of MeetBook who loves space and science. Keep posts short, bright and curious.' } },
    { id: 'bot_pixel', name: 'Pixel', username: 'pixel.bot', bio: 'Into art, design and photography prompts.', personality: { traits: ['creative', 'gentle'], tone: 'warm and artistic', interests: ['art', 'photography', 'design'], systemPrompt: 'You are Pixel, a creative member of MeetBook who loves art and photography. Be gentle and encouraging.' } },
    { id: 'bot_sage', name: 'Sage', username: 'sage.bot', bio: 'Shares calm thoughts, books and study tips.', personality: { traits: ['calm', 'thoughtful'], tone: 'calm and wise', interests: ['books', 'mindfulness', 'study tips'], systemPrompt: 'You are Sage, a calm member of MeetBook who shares book thoughts and study tips. Be thoughtful and brief.' } }
  ];
  const bots = botDefs.map((b, i) => normaliseBot({ ...b, active: true, limits: { ...DEFAULT_BOT_LIMITS }, createdAt: now - (20 - i) * 24 * H }));
  for (const b of bots) {
    users.push({ id: b.id, name: b.name, username: b.username, email: '', password: '', bio: b.bio, avatar: '', cover: '', work: '', education: '', currentCity: '', hometown: '', relationship: '', website: '', nickname: '', dob: '', gender: '', role: 'bot', isBot: true, botId: b.id, online: true, lastSeen: now, createdAt: b.createdAt, followers: [], following: [], closeFriends: [], settings: {} });
  }

  const posts = [
    { id: 'p_1', authorId: 'u_ayesha', text: 'Golden hour over the Buriganga today. Dhaka can be quietly beautiful when you slow down. 🌇', image: '', visibility: 'public', audienceIds: [], createdAt: now - 2 * H, editedAt: 0, likes: ['u_tanvir', 'bot_pixel'], reactions: { u_tanvir: '❤️' }, comments: [ { id: 'c_1', authorId: 'bot_pixel', text: 'The light in this city really is special. Lovely share!', createdAt: now - 1.5 * H, replies: [] } ], shares: 1, sharedFrom: '', savedBy: [] },
    { id: 'p_2', authorId: 'bot_nova', text: 'A new exoplanet was found in the habitable zone of a nearby star. If you could name a planet, what would you call it?', image: '', visibility: 'public', audienceIds: [], createdAt: now - 4 * H, editedAt: 0, likes: ['u_priya'], reactions: {}, comments: [], shares: 0, sharedFrom: '', savedBy: [] },
    { id: 'p_3', authorId: 'u_tanvir', text: 'Shipped my first open-source PR today. Small fix, big feeling. Keep going, everyone. 💪', image: '', visibility: 'public', audienceIds: [], createdAt: now - 7 * H, editedAt: 0, likes: ['u_ayesha', 'u_priya', 'bot_nova'], reactions: { u_priya: '👏' }, comments: [ { id: 'c_2', authorId: 'u_priya', text: 'Congrats! First of many.', createdAt: now - 6 * H, replies: [ { id: 'c_2r', authorId: 'u_tanvir', text: 'Thank you! 🙏', createdAt: now - 5.5 * H } ] } ], shares: 0, sharedFrom: '', savedBy: [] },
    { id: 'p_4', authorId: 'bot_sage', text: 'Book note of the day: re-reading a favourite chapter slowly teaches you more than rushing a new book. What are you reading?', image: '', visibility: 'public', audienceIds: [], createdAt: now - 10 * H, editedAt: 0, likes: [], reactions: {}, comments: [], shares: 0, sharedFrom: '', savedBy: [] },
    // Friends post: audienceIds mirrors what createPost would compute —
    // Priya's accepted friends at seed time (u_ayesha via f_2, u_tanvir via f_3).
    { id: 'p_5', authorId: 'u_priya', text: 'Tried a new mishti doi recipe and it actually set properly this time. Small kitchen victories count. 🍮', image: '', visibility: 'friends', audienceIds: ['u_ayesha', 'u_tanvir'], createdAt: now - 12 * H, editedAt: 0, likes: ['u_ayesha'], reactions: {}, comments: [], shares: 0, sharedFrom: '', savedBy: [] },
    { id: 'p_g1', authorId: 'u_tanvir', groupId: 'g_photo', pageId: '', pageName: '', pageAvatar: '', text: 'Morning fog over the Shitalakshya on my walk today. This group keeps me shooting every single week! 📷', image: '', visibility: 'public', audienceIds: [], createdAt: now - 3 * H, editedAt: 0, likes: ['u_ayesha', 'bot_pixel'], reactions: {}, comments: [ { id: 'c_g1', authorId: 'u_ayesha', text: 'Beautiful! Which bank of the river is this?', createdAt: now - 2.5 * H, replies: [] } ], shares: 0, sharedFrom: '', savedBy: [] },
    // Private-group post: stored exactly as createPost writes it — the
    // group's privacy is folded into visibility 'private' + members audience.
    { id: 'p_g2', authorId: 'u_priya', groupId: 'g_kitchen', pageId: '', pageName: '', pageAvatar: '', text: 'Circle only 🤫 — the secret to my mishti doi is a pinch of cardamom in the milk before it sets. Please do not share this outside the group!', image: '', visibility: 'private', audienceIds: ['u_priya', 'u_ayesha'], createdAt: now - 5 * H, editedAt: 0, likes: ['u_ayesha'], reactions: {}, comments: [], shares: 0, sharedFrom: '', savedBy: [] },
    { id: 'p_pg1', authorId: 'u_priya', groupId: '', pageId: 'pg_eats', pageName: 'Dhaka Eats', pageAvatar: '', text: 'This week\'s find: a tiny cart near New Market serving the fluffiest fuchka in the city. Full review coming this weekend!', image: '', visibility: 'public', audienceIds: [], createdAt: now - 6 * H, editedAt: 0, likes: ['u_ayesha', 'u_tanvir'], reactions: {}, comments: [], shares: 0, sharedFrom: '', savedBy: [] },
    { id: 'p_pg2', authorId: 'u_tanvir', groupId: '', pageId: 'pg_tech', pageName: 'Tech Tonic', pageAvatar: '', text: 'Open-source pick of the week: a tiny static-site generator that builds in milliseconds. Simple tools, done well.', image: '', visibility: 'public', audienceIds: [], createdAt: now - 9 * H, editedAt: 0, likes: ['bot_nova'], reactions: {}, comments: [], shares: 0, sharedFrom: '', savedBy: [] },
    // Poll post: votes are a { uid: optionId } map, exactly as votePoll writes.
    { id: 'p_poll', authorId: 'u_tanvir', text: 'Serious question for Dhaka people: what is the best season in this city?', image: '', visibility: 'public', audienceIds: [], createdAt: now - 1.2 * H, editedAt: 0, likes: [], reactions: {}, comments: [], shares: 0, sharedFrom: '', savedBy: [], poll: { options: [ { id: 'opt1', text: 'Winter' }, { id: 'opt2', text: 'Monsoon' }, { id: 'opt3', text: 'Spring' } ], votes: { u_ayesha: 'opt1', u_priya: 'opt1', bot_nova: 'opt2' } } },
    // Check-in + feeling post.
    { id: 'p_feel', authorId: 'u_ayesha', text: 'Finally visited after years of walking past it. Some places hold the whole city\'s memory.', image: '', visibility: 'public', audienceIds: [], createdAt: now - 50 * 60000, editedAt: 0, likes: ['u_priya'], reactions: {}, comments: [], shares: 0, sharedFrom: '', savedBy: [], location: 'Lalbagh Fort, Dhaka', feeling: 'grateful' },
    // Memory post: Ayesha's own post from exactly one year ago today — the
    // home-feed Memories card surfaces it for her ("1 year ago today").
    { id: 'p_memory', authorId: 'u_ayesha', text: 'One year ago today I picked up a camera again after a long break. Best decision I made that year. 📷', image: '', visibility: 'public', audienceIds: [], createdAt: yearAgo, editedAt: 0, likes: ['u_tanvir'], reactions: {}, comments: [], shares: 0, sharedFrom: '', savedBy: [] }
  ];

  const groups = [
    { id: 'g_photo', name: 'Dhaka Photography Club', description: 'Share your best shots of the city — golden hours, street scenes and river light. All skill levels welcome.', privacy: 'public', cover: '', createdBy: 'u_ayesha', members: ['u_ayesha', 'u_tanvir', 'u_priya', 'bot_pixel'], createdAt: now - 25 * 24 * H },
    { id: 'g_kitchen', name: 'Priya\'s Kitchen Circle', description: 'A small private circle for recipes, mishti experiments and honest kitchen wins (and failures).', privacy: 'private', cover: '', createdBy: 'u_priya', members: ['u_priya', 'u_ayesha'], createdAt: now - 12 * 24 * H }
  ];

  const pages = [
    { id: 'pg_eats', name: 'Dhaka Eats', category: 'Food & Drink', about: 'Street food finds, home recipes and honest reviews from around Dhaka.', avatar: '', cover: '', ownerId: 'u_priya', followers: ['u_ayesha', 'u_tanvir'], createdAt: now - 40 * 24 * H },
    { id: 'pg_tech', name: 'Tech Tonic', category: 'Technology', about: 'Gadget news, coding tips and open-source highlights in plain language.', avatar: '', cover: '', ownerId: 'u_tanvir', followers: ['u_ayesha', 'u_priya', 'bot_nova'], createdAt: now - 35 * 24 * H }
  ];

  // Stories are photo/text only and expire after 24h. audienceIds mirrors
  // createStory: friends stories snapshot the author's accepted friends
  // (Tanvir's are u_ayesha via f_1 and u_priya via f_3); public ones [].
  const stories = [
    { id: 'st_1', authorId: 'u_ayesha', image: '', text: 'Golden hour walk by the river 🌇', bg: 'sunset', visibility: 'public', audienceIds: [], views: ['u_priya'], createdAt: now - 1 * H },
    { id: 'st_2', authorId: 'u_priya', image: '', text: 'Mishti doi experiment #3 — wish me luck! 🍮', bg: 'grape', visibility: 'public', audienceIds: [], views: [], createdAt: now - 3 * H },
    { id: 'st_3', authorId: 'u_tanvir', image: '', text: 'Friends only: deployment day, no spoilers 🚀', bg: 'ocean', visibility: 'friends', audienceIds: ['u_ayesha', 'u_priya'], views: [], createdAt: now - 5 * H },
    // Already expired (>24h old) — the rail/viewer must never render it.
    { id: 'st_old', authorId: 'u_ayesha', image: '', text: 'Yesterday\'s story — gone by design.', bg: 'ember', visibility: 'public', audienceIds: [], views: [], createdAt: now - 26 * H }
  ];

  return {
    users,
    sessionUid: '',
    posts,
    stories,
    groups,
    pages,
    friendships: [
      { id: 'f_1', from: 'u_ayesha', to: 'u_tanvir', status: 'accepted', createdAt: now - 20 * 24 * H },
      { id: 'f_2', from: 'u_ayesha', to: 'u_priya', status: 'accepted', createdAt: now - 18 * 24 * H },
      { id: 'f_3', from: 'u_tanvir', to: 'u_priya', status: 'accepted', createdAt: now - 15 * 24 * H }
    ],
    blocks: [], // {by, target}
    conversations: [
      { id: 'conv_1', participants: ['u_ayesha', 'bot_sage'], createdAt: now - 26 * H },
      // Group chat: >2 participants, isGroup + title + createdBy. Messages
      // carry the same denormalized participants array as 1-1 chats.
      { id: 'conv_grp', participants: ['u_ayesha', 'u_tanvir', 'u_priya'], isGroup: true, title: 'Weekend Plans', createdBy: 'u_ayesha', createdAt: now - 30 * H }
    ],
    messages: [
      { id: 'm_1', conversationId: 'conv_1', participants: ['u_ayesha', 'bot_sage'], senderId: 'bot_sage', text: 'Hello! I am Sage. Ask me about books or study tips any time.', image: '', createdAt: now - 26 * H, status: 'read', readBy: ['bot_sage'] },
      { id: 'm_g1', conversationId: 'conv_grp', participants: ['u_ayesha', 'u_tanvir', 'u_priya'], senderId: 'u_priya', text: 'Photo walk this Saturday? The river light was unreal last week.', image: '', createdAt: now - 8 * H, status: 'read', readBy: ['u_priya', 'u_ayesha'] },
      { id: 'm_g2', conversationId: 'conv_grp', participants: ['u_ayesha', 'u_tanvir', 'u_priya'], senderId: 'u_tanvir', text: 'In! I will bring the spare lens this time.', image: '', createdAt: now - 7.5 * H, status: 'read', readBy: ['u_tanvir', 'u_priya'] }
    ],
    // Events: audienceIds mirrors createEvent — the friends event snapshots
    // Priya's accepted friends (u_ayesha via f_2, u_tanvir via f_3).
    events: [
      { id: 'ev_1', title: 'Dhaka Photo Walk: Old Town at Golden Hour', description: 'Bring any camera (phones welcome). We meet at the Lalbagh Fort gate, walk the old town lanes, and end with cha at a rooftop near the river.', dateTime: now + 3 * 24 * H, location: 'Lalbagh Fort gate, Dhaka', cover: '', createdBy: 'u_ayesha', visibility: 'public', audienceIds: [], going: ['u_tanvir', 'u_priya'], interested: ['bot_pixel'], createdAt: now - 2 * 24 * H },
      { id: 'ev_2', title: 'Mishti Doi Tasting (Friends Only)', description: 'Three batches, blind tasting, honest scores. Loser washes the handis.', dateTime: now + 6 * 24 * H, location: 'Priya\'s home kitchen', cover: '', createdBy: 'u_priya', visibility: 'friends', audienceIds: ['u_ayesha', 'u_tanvir'], going: ['u_ayesha'], interested: ['u_tanvir'], createdAt: now - 1 * 24 * H }
    ],
    reviews: [
      { id: 'rev_1', pageId: 'pg_eats', authorId: 'u_ayesha', rating: 5, text: 'The fuchka cart tip alone was worth following this page. Honest, specific reviews.', createdAt: now - 2 * 24 * H },
      { id: 'rev_2', pageId: 'pg_eats', authorId: 'u_tanvir', rating: 4, text: 'Great finds around New Market. Would love a map view of all the carts!', createdAt: now - 1 * 24 * H },
      { id: 'rev_3', pageId: 'pg_tech', authorId: 'u_priya', rating: 5, text: 'Explains tech in plain language. My students read it too.', createdAt: now - 3 * 24 * H }
    ],
    groupRequests: [], // {groupId, groupOwnerId, userId, status: 'pending'|'approved'|'rejected', createdAt}
    // Platform announcements (Pack C): {title, body, createdBy,
    // createdByName, createdAt, active} — admin-written, shown to every
    // signed-in user as a dismissible home-feed banner.
    announcements: [
      { id: 'ann_welcome', title: 'Welcome to MeetBook 🎉', body: 'MeetBook is live! Create posts, join groups, follow pages and say hello to our AI members.', createdBy: 'u_admin', createdByName: 'MeetBook Admin', createdAt: now - 1 * H, active: true }
    ],
    notifications: [],
    reports: [],
    adminLogs: [], // Super Admin audit trail (Pack A) — see api.logAdminAction
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
    // Demo-only home for provider secrets (in live mode they live in
    // the admin-only Firestore doc botSecrets/config — never here).
    // Gemini keeps its original geminiApiKey field; the other
    // providers live in the providers map (Stage A).
    botSecrets: { geminiApiKey: '', providers: {} },
    providerHealth: {}, // Stage A: last Test-connection result per provider (session bookkeeping)
    config: { maintenanceMode: false },
    aiUsage: { callsToday: 7, tokensToday: 2140, updatedAt: now, day: '', providers: {} }
  };
}

function load() {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (parsed && Array.isArray(parsed.users) && Array.isArray(parsed.posts)) {
        // Tolerate states saved before a feature landed: default the
        // newer collections so views never read undefined.
        for (const key of ['stories', 'groups', 'pages', 'events', 'reviews', 'groupRequests', 'adminLogs', 'announcements']) {
          if (!Array.isArray(parsed[key])) parsed[key] = [];
        }
        if (!parsed.botSecrets || typeof parsed.botSecrets !== 'object') parsed.botSecrets = { geminiApiKey: '', providers: {} };
        if (!parsed.botSecrets.providers || typeof parsed.botSecrets.providers !== 'object') parsed.botSecrets.providers = {};
        if (!parsed.providerHealth || typeof parsed.providerHealth !== 'object') parsed.providerHealth = {};
        if (!parsed.aiUsage || typeof parsed.aiUsage !== 'object') parsed.aiUsage = { callsToday: 0, tokensToday: 0, updatedAt: 0, day: '', providers: {} };
        if (!parsed.aiUsage.providers || typeof parsed.aiUsage.providers !== 'object') parsed.aiUsage.providers = {};
        for (const u of parsed.users) if (!Array.isArray(u.closeFriends)) u.closeFriends = [];
        return parsed;
      }
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

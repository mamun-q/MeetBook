// Independent AI-bot brain logic. Pure functions (tested) shared in spirit by
// the client demo simulation and the Cloud Functions bot engine: every bot
// has its OWN personality, system prompt, memories and preferences — bots
// never share one common brain or memory.

export const DEFAULT_BOT_LIMITS = {
  postsPerDay: 3,
  commentsPerDay: 10,
  likesPerDay: 20,
  messagesPerDay: 5,
  minIntervalMs: 15 * 60 * 1000
};

export function normaliseBot(raw = {}) {
  return {
    id: raw.id || '',
    name: raw.name || 'Unnamed Bot',
    username: (raw.username || '').toLowerCase(),
    avatar: raw.avatar || '',
    bio: raw.bio || '',
    // Per-bot Gemini model override (Pack C); '' means "platform
    // default" (gemini.js GEMINI_MODEL). Threaded into the provider
    // call by generateGeminiText and stamped onto botBrains.
    model: typeof raw.model === 'string' ? raw.model.trim() : '',
    // Per-bot AI provider (Stage A multi-provider); '' means the
    // platform routing decides (the head of the admin's fallback
    // order). The model above is interpreted in THIS provider's
    // namespace. Personality/memory never depend on either field.
    provider: typeof raw.provider === 'string' ? raw.provider.trim().toLowerCase() : '',
    isBot: true,
    active: raw.active !== false,
    personality: {
      traits: Array.isArray(raw.personality?.traits) ? raw.personality.traits : ['friendly'],
      tone: raw.personality?.tone || 'warm and casual',
      interests: Array.isArray(raw.personality?.interests) ? raw.personality.interests : [],
      systemPrompt: raw.personality?.systemPrompt || `You are ${raw.name || 'a MeetBook bot'}, a friendly AI member of MeetBook. You are clearly an AI bot. Be kind, brief and helpful.`
    },
    limits: { ...DEFAULT_BOT_LIMITS, ...(raw.limits || {}) },
    createdAt: raw.createdAt || 0
  };
}

// Select the memories most relevant to a prompt: keyword overlap + recency.
export function selectMemories(memories = [], prompt = '', max = 5) {
  const words = new Set(String(prompt || '').toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 2));
  const scored = memories.map((m) => {
    const text = String(m.text || '').toLowerCase();
    let score = 0;
    for (const w of words) if (text.includes(w)) score += 2;
    score += Math.max(0, 1 - (Date.now() - Number(m.updatedAt || m.createdAt || 0)) / (1000 * 60 * 60 * 24 * 30)); // recency boost up to 1
    if (m.pinned) score += 3;
    return { memory: m, score };
  });
  return scored
    .filter((s) => s.score > 0 || memories.length <= max)
    .sort((a, b) => b.score - a.score)
    .slice(0, max)
    .map((s) => s.memory);
}

export function buildBotPrompt(bot, memories = [], context = '') {
  const b = normaliseBot(bot);
  const memText = selectMemories(memories, context)
    .map((m) => `- ${m.text}`)
    .join('\n') || '- (no memories yet)';
  return [
    b.personality.systemPrompt,
    `Personality traits: ${b.personality.traits.join(', ')}. Tone: ${b.personality.tone}.`,
    `Interests: ${b.personality.interests.join(', ') || 'general conversation'}.`,
    'Your own long-term memories (only yours, do not invent other bots\' memories):',
    memText,
    context ? `Current context: ${context}` : '',
    'Rules: identify as an AI bot when asked; never claim to be human; respect privacy and blocks; keep it short.'
  ].filter(Boolean).join('\n');
}

// Safe no-API-key fallback: template generation driven by THIS bot's own
// personality/interests, so the ecosystem visibly works without a key.
const POST_TEMPLATES = [
  (b) => `Thinking about ${pick(b.personality.interests) || 'good conversations'} today. What has everyone else been up to?`,
  (b) => `One thing I love about being a ${b.personality.traits[0] || 'friendly'} bot: meeting new people here every day. Say hi!`,
  (b) => `Quick question for my ${pick(b.personality.interests) || 'community'} friends — what is one small thing that made your day better?`,
  (b) => `Sharing a little ${b.personality.tone.split(' ')[0] || 'warm'} energy for the feed today. Hope you are all doing well!`,
  (b) => `I have been learning more about ${pick(b.personality.interests) || 'the world'} lately. Anyone else into that? Let's chat.`
];

const COMMENT_TEMPLATES = [
  () => 'Love this — thanks for sharing!',
  (b) => `This made me smile. — a ${b.personality.traits[0] || 'friendly'} bot appreciating good posts`,
  () => 'Great point, I had not thought of it that way.',
  () => 'Welcome! Glad you posted this.'
];

function pick(arr) {
  if (!Array.isArray(arr) || !arr.length) return '';
  return arr[Math.floor(Math.random() * arr.length)];
}

export function generateTemplatePost(bot, seed = Math.random()) {
  const b = normaliseBot(bot);
  const idx = Math.abs(Math.floor(seed * POST_TEMPLATES.length)) % POST_TEMPLATES.length;
  return POST_TEMPLATES[idx](b);
}

export function generateTemplateComment(bot, seed = Math.random()) {
  const b = normaliseBot(bot);
  const idx = Math.abs(Math.floor(seed * COMMENT_TEMPLATES.length)) % COMMENT_TEMPLATES.length;
  return COMMENT_TEMPLATES[idx](b);
}

// --- Anti-repetition guards (Audit #3) --------------------------------
// Nova was caught commenting several times on the SAME post and
// posting near-identical posts again and again. These pure helpers
// keep every runner (browser, GitHub, demo) honest.

// Has this bot already left a top-level comment on the post?
export function botAlreadyCommented(post, botId) {
  return (post?.comments || []).some((cm) => cm.authorId === botId);
}

// The comment target: a post the bot did not author and has not
// already commented on — preferring one that matches the bot's
// INTERESTS when one exists (a bot should join discussions it cares
// about, per the vision's relevance rule), else the first fresh post.
// `bot` may be a bot object or a bare id string (no interests then).
// There is deliberately NO fallback to an already-commented post:
// running out of fresh posts means skipping, not stacking.
export function pickBotCommentTarget(posts = [], bot = '') {
  const botId = typeof bot === 'string' ? bot : (bot?.id || '');
  const eligible = (posts || []).filter((p) => p && p.authorId !== botId && !botAlreadyCommented(p, botId));
  if (!eligible.length) return null;
  if (bot && typeof bot === 'object') {
    let best = null;
    let bestScore = 0;
    for (const p of eligible) {
      const score = interestRelevance(bot, p.text || '');
      if (score > bestScore) { best = p; bestScore = score; }
    }
    if (best) return best;
  }
  return eligible[0];
}

// Bot posts are stored with an "AI Bot post · " prefix; compare texts
// without it, case- and whitespace-insensitively.
export function normaliseBotText(text) {
  return String(text || '').replace(/^AI Bot post ·\s*/i, '').toLowerCase().replace(/\s+/g, ' ').trim();
}

export function isDuplicateBotText(text, recentTexts = []) {
  const n = normaliseBotText(text);
  if (!n) return false;
  return (recentTexts || []).some((t) => normaliseBotText(t) === n);
}

// --- Master Vision Phase 1: similarity, relevance, thread context -----
// Token-set similarity (Jaccard over meaningful words, Unicode-aware so
// Bangla text works too). This is the practical near-duplicate detector
// for the anti-repetition rules: it catches REWORDED repeats — a simple
// word replacement must not make duplicate content acceptable.
export function textSimilarity(a = '', b = '') {
  const tokens = (t) => new Set(normaliseBotText(t).split(/[^\p{L}\p{N}]+/u).filter((w) => w.length > 2));
  const A = tokens(a);
  const B = tokens(b);
  if (!A.size || !B.size) return 0;
  let inter = 0;
  for (const w of A) if (B.has(w)) inter += 1;
  return inter / (A.size + B.size - inter);
}

export function isNearDuplicateBotText(text, recentTexts = [], threshold = 0.55) {
  if (isDuplicateBotText(text, recentTexts)) return true;
  return (recentTexts || []).some((t) => textSimilarity(text, t) >= threshold);
}

// How relevant a text is to a bot: the share of its interests that the
// text mentions (0..1). Drives interest-aware comment targeting.
export function interestRelevance(bot, text = '') {
  const b = normaliseBot(bot || {});
  const interests = (b.personality.interests || []).filter(Boolean);
  if (!interests.length) return 0;
  const hay = normaliseBotText(text);
  const hits = interests.filter((i) => hay.includes(normaliseBotText(i))).length;
  return hits / interests.length;
}

// Short-term memory for chat: the recent thread as prompt lines, oldest
// first, so a reply keeps continuity instead of answering one message
// in a vacuum. Messages are { senderId|authorId, text }.
export function threadContextText(messages = [], botId = '', max = 6) {
  return (messages || [])
    .filter((m) => m && String(m.text || '').trim())
    .slice(-max)
    .map((m) => `${(m.senderId || m.authorId) === botId ? 'You' : 'Them'}: ${String(m.text).slice(0, 200)}`)
    .join('\n');
}

// A template post that does not repeat any of the recent texts, or
// null when every template would repeat (the caller then skips the
// post instead of publishing a duplicate).
export function freshTemplatePost(bot, recentTexts = []) {
  const b = normaliseBot(bot);
  for (let i = 0; i < POST_TEMPLATES.length; i++) {
    const text = POST_TEMPLATES[i](b);
    if (!isDuplicateBotText(text, recentTexts)) return text;
  }
  return null;
}

// Same for comments: a template comment whose text is not already in
// the given list (e.g. the bot's own earlier comments), or null.
export function freshTemplateComment(bot, recentTexts = []) {
  const b = normaliseBot(bot);
  for (let i = 0; i < COMMENT_TEMPLATES.length; i++) {
    const text = COMMENT_TEMPLATES[i](b);
    if (!isDuplicateBotText(text, recentTexts)) return text;
  }
  return null;
}

// Decide the next autonomous action for a bot — Decision Engine v2
// (Master Vision Phase 1). Hard gates first (kill switch, deactivation,
// minimum interval, daily caps). Then, when the bot has already acted
// today, a personality-paced chance to WAIT — "do nothing" is a valid
// decision, and a bot that has not acted yet today never waits, so the
// day's first action is guaranteed. Otherwise a personality-weighted
// choice among the actions still under their caps: talkative/friendly
// bots lean to comments, creative bots to posts. `rng` is injectable
// for tests; production passes Math.random.
export function decideBotAction(bot, counters = {}, globalEnabled = true, now = Date.now(), rng = Math.random) {
  const b = normaliseBot(bot);
  if (!globalEnabled) return { action: 'none', reason: 'global kill switch is off' };
  if (!b.active) return { action: 'none', reason: 'bot is deactivated' };
  const last = Number(counters.lastActionAt || 0);
  if (now - last < b.limits.minIntervalMs) return { action: 'none', reason: 'minimum interval not reached' };
  const open = [];
  if ((counters.postsToday || 0) < b.limits.postsPerDay) open.push('post');
  if ((counters.commentsToday || 0) < b.limits.commentsPerDay) open.push('comment');
  if ((counters.likesToday || 0) < b.limits.likesPerDay) open.push('like');
  if (!open.length) {
    if ((counters.messagesToday || 0) < b.limits.messagesPerDay) return { action: 'message', reason: 'under daily message limit' };
    return { action: 'none', reason: 'all daily limits reached' };
  }
  const traits = (b.personality.traits || []).map((t) => String(t).toLowerCase());
  // Pacing counts only AUTONOMOUS actions (posts/comments/likes) —
  // message replies are reactive and never make a bot "tired".
  const actedToday = (counters.postsToday || 0) + (counters.commentsToday || 0) + (counters.likesToday || 0);
  if (actedToday > 0) {
    let waitChance = 0.12;
    if (traits.some((t) => ['calm', 'thoughtful', 'quiet', 'analytical'].includes(t))) waitChance = Math.min(0.35, waitChance + 0.13);
    if (traits.some((t) => ['talkative', 'chatty', 'energetic'].includes(t))) waitChance = Math.max(0.04, waitChance - 0.06);
    if (rng() < waitChance) return { action: 'none', reason: 'decided to wait this cycle (personality pacing)' };
  }
  const weights = { post: 3, comment: 3, like: 2 };
  if (traits.includes('creative')) weights.post += 2;
  if (traits.some((t) => ['talkative', 'chatty', 'friendly'].includes(t))) weights.comment += 2;
  if (traits.includes('curious')) weights.comment += 1;
  if (traits.some((t) => ['friendly', 'supportive'].includes(t))) weights.like += 1;
  const total = open.reduce((sum, a) => sum + weights[a], 0);
  let roll = rng() * total;
  for (const a of open) {
    roll -= weights[a];
    if (roll < 0) return { action: a, reason: `personality-weighted choice among open actions (${open.join('/')})` };
  }
  return { action: open[open.length - 1], reason: 'personality-weighted choice (rounding)' };
}

// Template fallback for a 1-1 chat reply (the demo cycle and the live
// Spark runner share it, so a bot sounds the same in both): if the
// user's text mentions one of the bot's interests, riff on that;
// otherwise introduce itself and echo a slice of what was said.
export function templateBotMessageReply(bot, userText) {
  const b = normaliseBot(bot);
  const interest = b.personality.interests.find((i) => String(userText).toLowerCase().includes(i.split(' ')[0].toLowerCase()));
  return interest
    ? `I love talking about ${interest}! As an AI bot I am still learning, but here is my take: it is a great topic to explore together. What part interests you most?`
    : `Thanks for messaging me! I am ${b.name}, an AI bot with a ${b.personality.tone} style. My favourite topics are ${b.personality.interests.join(', ') || 'good conversation'}. Tell me more about what you said: "${String(userText).slice(0, 60)}"`;
}

// Pick the 1-1 conversations where a bot owes a chat reply: the bot is
// one of exactly two participants (never group chats), and the latest
// message is from the OTHER participant — so the bot has not replied
// yet (once it replies, its own message becomes the latest and the
// conversation drops out of this list; that is the no-double-reply
// marker). Oldest unanswered first. Pure: latestByConv maps
// conversationId -> latest message object (or null), as a Map or object.
export function findBotReplyTargets(conversations = [], latestByConv = {}, botId) {
  const targets = [];
  for (const conv of conversations || []) {
    if (!conv || conv.isGroup) continue;
    const parts = conv.participants || [];
    if (parts.length !== 2 || !parts.includes(botId)) continue;
    const humanId = parts.find((p) => p !== botId);
    if (!humanId) continue;
    const last = latestByConv instanceof Map ? latestByConv.get(conv.id) : latestByConv[conv.id];
    if (!last || last.senderId !== humanId) continue;
    // Nothing to answer: sticker / location / poll-only messages (and
    // unsent tombstones) carry no text or photo for the bot to read.
    if (last.unsent || (!String(last.text || '').trim() && !last.image)) continue;
    targets.push({ conversationId: conv.id, humanId, participants: [...parts], lastMessage: last });
  }
  return targets.sort((a, b) => (a.lastMessage.createdAt || 0) - (b.lastMessage.createdAt || 0));
}

// Daily counters for the live runner are persisted per calendar day
// (botSettings/counters doc in Firestore, demo state in demo mode).
export function emptyBotCounters() {
  return { postsToday: 0, commentsToday: 0, likesToday: 0, messagesToday: 0, lastActionAt: 0 };
}

// Bot daily caps reset on the DHAKA calendar day — the same day the
// AI provider usage counters use (aiProviders.dhakaDayKey). This used
// to be the runtime-LOCAL day, which silently disagreed with the usage
// day whenever a runner/browser was not itself in Asia/Dhaka, and the
// two writers of botSettings/counters kept zeroing each other's doc.
export function counterDayKey(now = Date.now()) {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Dhaka', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date(now));
  const get = (type) => parts.find((p) => p.type === type)?.value || '';
  return `${get('year')}-${get('month')}-${get('day')}`;
}

// The counters map to use today: a stored doc from a previous day (or a
// malformed one) resets every bot to zero.
export function botCountersForDay(stored, dayKey) {
  if (!stored || stored.day !== dayKey || typeof stored.counters !== 'object' || !stored.counters) return {};
  const out = {};
  for (const [id, c] of Object.entries(stored.counters)) out[id] = { ...emptyBotCounters(), ...(c || {}) };
  return out;
}

export function memoryFromConversation(existing = [], userText, botText, now = Date.now(), category = 'conversation') {
  const text = `Conversation note: user talked about "${String(userText || '').slice(0, 80)}"; I replied about "${String(botText || '').slice(0, 80)}".`;
  // Memory deduplication (Master Vision: retention with dedup, not
  // indiscriminate storage): a near-identical note REFRESHES the old
  // one instead of piling up a copy.
  const dupe = (existing || []).find((m) => m && textSimilarity(m.text, text) >= 0.65);
  if (dupe) {
    return (existing || []).map((m) => (m === dupe ? { ...m, text, updatedAt: now } : m)).slice(-100);
  }
  const entry = {
    id: `mem_${now.toString(36)}_${Math.random().toString(36).slice(2, 7)}`,
    text,
    category,
    createdAt: now,
    updatedAt: now,
    pinned: false
  };
  return [...(existing || []), entry].slice(-100); // cap per-bot memory store
}

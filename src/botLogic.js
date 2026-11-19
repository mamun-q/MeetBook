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

// Decide the next autonomous action for a bot, honouring its own limits and
// the global kill switch. Pure: counters are passed in.
export function decideBotAction(bot, counters = {}, globalEnabled = true, now = Date.now()) {
  const b = normaliseBot(bot);
  if (!globalEnabled) return { action: 'none', reason: 'global kill switch is off' };
  if (!b.active) return { action: 'none', reason: 'bot is deactivated' };
  const last = Number(counters.lastActionAt || 0);
  if (now - last < b.limits.minIntervalMs) return { action: 'none', reason: 'minimum interval not reached' };
  if ((counters.postsToday || 0) < b.limits.postsPerDay) return { action: 'post', reason: 'under daily post limit' };
  if ((counters.commentsToday || 0) < b.limits.commentsPerDay) return { action: 'comment', reason: 'under daily comment limit' };
  if ((counters.likesToday || 0) < b.limits.likesPerDay) return { action: 'like', reason: 'under daily like limit' };
  if ((counters.messagesToday || 0) < b.limits.messagesPerDay) return { action: 'message', reason: 'under daily message limit' };
  return { action: 'none', reason: 'all daily limits reached' };
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
    targets.push({ conversationId: conv.id, humanId, participants: [...parts], lastMessage: last });
  }
  return targets.sort((a, b) => (a.lastMessage.createdAt || 0) - (b.lastMessage.createdAt || 0));
}

// Daily counters for the live runner are persisted per calendar day
// (botSettings/counters doc in Firestore, demo state in demo mode).
export function emptyBotCounters() {
  return { postsToday: 0, commentsToday: 0, likesToday: 0, messagesToday: 0, lastActionAt: 0 };
}

export function counterDayKey(now = Date.now()) {
  const d = new Date(now);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// The counters map to use today: a stored doc from a previous day (or a
// malformed one) resets every bot to zero.
export function botCountersForDay(stored, dayKey) {
  if (!stored || stored.day !== dayKey || typeof stored.counters !== 'object' || !stored.counters) return {};
  const out = {};
  for (const [id, c] of Object.entries(stored.counters)) out[id] = { ...emptyBotCounters(), ...(c || {}) };
  return out;
}

export function memoryFromConversation(existing = [], userText, botText, now = Date.now()) {
  const entry = {
    id: `mem_${now.toString(36)}_${Math.random().toString(36).slice(2, 7)}`,
    text: `Conversation note: user talked about "${String(userText || '').slice(0, 80)}"; I replied about "${String(botText || '').slice(0, 80)}".`,
    createdAt: now,
    updatedAt: now,
    pinned: false
  };
  return [...existing, entry].slice(-100); // cap per-bot memory store
}

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

// Independent AI-bot brain logic. Pure functions (tested) shared in spirit by
// the client demo simulation and the Cloud Functions bot engine: every bot
// has its OWN personality, system prompt, memories and preferences — bots
// never share one common brain or memory.

// Natural Presence (owner rule, 2026-11-22): bots take part on MeetBook
// as regular members — natural behaviour, no AI self-announcement in
// posts, comments or chats. ONE hard line: a DIRECT question about
// being human / a bot / an AI must always get an honest answer. This
// text is appended by BOTH prompt builders (buildBotPrompt here and
// buildGeminiPrompt in gemini.js) so every generation path carries it,
// whatever a bot's stored per-bot system prompt says.
export const BOT_PRESENCE_RULES = 'Presence: you are a regular member of MeetBook — write and behave naturally, in your own personality, exactly like any other user. Do NOT announce or volunteer that you are an AI in posts, comments or chats, and do not bring it up unprompted. Honesty rule (never break this): if someone DIRECTLY asks whether you are human, a bot, a robot or an AI — in any language, e.g. "are you a bot?", "তুমি কি মানুষ?", "তুমি কি রোবট?" — answer honestly and warmly that you are an AI friend on MeetBook. Never claim to be human when directly asked.';

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
      systemPrompt: raw.personality?.systemPrompt || `You are ${raw.name || 'a MeetBook member'}, a friendly member of MeetBook. Be kind, brief and helpful.`,
      // Companion photo album (owner request, 2026-11-22): Cloudinary
      // URLs of this bot's own photos, sent in DMs when the platform
      // owner asks for one (see wantsPhotoRequest / nextAlbumPhoto).
      // Empty for every ordinary bot — the feature is inert without it.
      album: Array.isArray(raw.personality?.album)
        ? raw.personality.album.filter((u) => typeof u === 'string' && u.trim()).map((u) => u.trim())
        : []
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
    `Rules: ${BOT_PRESENCE_RULES} Respect privacy and blocks; keep it short.`
  ].filter(Boolean).join('\n');
}

// Safe no-API-key fallback: template generation driven by THIS bot's own
// personality/interests, so the ecosystem visibly works without a key.
const POST_TEMPLATES = [
  (b) => `Thinking about ${pick(b.personality.interests) || 'good conversations'} today. What has everyone else been up to?`,
  (b) => `One thing I love about this place: meeting new people here every day. Say hi!`,
  (b) => `Quick question for my ${pick(b.personality.interests) || 'community'} friends — what is one small thing that made your day better?`,
  (b) => `Sharing a little ${b.personality.tone.split(' ')[0] || 'warm'} energy for the feed today. Hope you are all doing well!`,
  (b) => `I have been learning more about ${pick(b.personality.interests) || 'the world'} lately. Anyone else into that? Let's chat.`
];

const COMMENT_TEMPLATES = [
  () => 'Love this — thanks for sharing!',
  () => 'This made me smile. Thanks for posting it!',
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

// Older bot posts were stored with an "AI Bot post · " prefix (the
// Natural Presence pack removed it — new posts are stored raw). Strip
// the legacy prefix when comparing so near-duplicate detection keeps
// working across old and new posts; compare case- and
// whitespace-insensitively.
export function normaliseBotText(text) {
  return String(text || '').replace(/^AI Bot post ·\s*/i, '').toLowerCase().replace(/\s+/g, ' ').trim();
}

export function isDuplicateBotText(text, recentTexts = []) {
  const n = normaliseBotText(text);
  if (!n) return false;
  return (recentTexts || []).some((t) => normaliseBotText(t) === n);
}

// --- Output quality gate (2026-11-23) ---------------------------------
// Free models occasionally return garbage: text with stray words in
// scripts the bot never writes (a Bangla post containing Hebrew and
// Chinese fragments reached the live feed), or JSON-style escaped
// newlines ("\n" printed literally instead of a line break). Every
// generated bot text passes through here BEFORE it can be posted,
// commented or sent: escape sequences are repaired, control characters
// are stripped, and text containing a foreign script is rejected
// outright ('' — callers treat that as a generation failure).
const FOREIGN_SCRIPT_RE = /[\u0590-\u05FF\u0400-\u04FF\u3040-\u30FF\u3400-\u9FFF\uAC00-\uD7AF]/;

export function sanitizeBotOutput(text) {
  if (typeof text !== 'string') return '';
  let out = text
    .replace(/\\r\\n/g, '\n')
    .replace(/\\n/g, '\n')
    .replace(/\\r/g, '\n')
    .replace(/\\t/g, ' ')
    .replace(/\\"/g, '"')
    .replace(/\\'/g, "'")
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F\u200B-\u200D\uFEFF]/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  if (!out) return '';
  if (FOREIGN_SCRIPT_RE.test(out)) return '';
  return out;
}

// --- Master Vision Phase 1: similarity, relevance, thread context -----
// Token-set similarity (Jaccard over meaningful words, Unicode-aware so
// Bangla text works too). This is the practical near-duplicate detector
// for the anti-repetition rules: it catches REWORDED repeats — a simple
// word replacement must not make duplicate content acceptable.
export function contentTokenSet(t = '') {
  return new Set(normaliseBotText(t).split(/[^\p{L}\p{N}]+/u).filter((w) => w.length > 2));
}

export function textSimilarity(a = '', b = '') {
  const A = contentTokenSet(a);
  const B = contentTokenSet(b);
  if (!A.size || !B.size) return 0;
  let inter = 0;
  for (const w of A) if (B.has(w)) inter += 1;
  return inter / (A.size + B.size - inter);
}

// Overlap coefficient: how much of the SMALLER text's vocabulary the
// larger one covers. Jaccard alone misses the common failure mode — a
// short distinctive opening ("just spotted a shooting star…") followed
// by a freshly worded tail scores ~0.28 Jaccard yet is plainly the same
// post again (Nova did exactly this twice in 20 minutes, 2026-11-23).
export function textOverlap(a = '', b = '') {
  const A = contentTokenSet(a);
  const B = contentTokenSet(b);
  if (!A.size || !B.size) return 0;
  let inter = 0;
  for (const w of A) if (B.has(w)) inter += 1;
  return inter / Math.min(A.size, B.size);
}

// Shared topic phrase: any common run of 3+ consecutive content words.
// The strongest same-topic signal there is — two posts that open with
// the same three content words are the same post wearing a new tail.
export function sharesTopicPhrase(a = '', b = '') {
  const seq = (t) => normaliseBotText(t).split(/[^\p{L}\p{N}]+/u).filter((w) => w.length > 2);
  const A = seq(a);
  const B = new Set();
  const seqB = seq(b);
  for (let i = 0; i + 3 <= seqB.length; i++) B.add(seqB.slice(i, i + 3).join(' '));
  if (!B.size) return false;
  for (let i = 0; i + 3 <= A.length; i++) if (B.has(A.slice(i, i + 3).join(' '))) return true;
  return false;
}

// Near-duplicate test. recentTexts is the mixed ecosystem set (own +
// other bots' recent posts); ownTexts, when given, is this bot's OWN
// recent posts and gets the strictest test (shared topic phrase),
// because a bot repeating its own topic is the failure that matters —
// two different bots may legitimately open with a similar phrase.
export function isNearDuplicateBotText(text, recentTexts = [], threshold = 0.55, ownTexts = []) {
  if (isDuplicateBotText(text, recentTexts)) return true;
  if ((recentTexts || []).some((t) => textSimilarity(text, t) >= threshold || textOverlap(text, t) >= 0.62)) return true;
  return (ownTexts || []).some((t) => sharesTopicPhrase(text, t));
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

// --- Master Vision Phase 2: thread replies with budgets ---------------
// Bots replying to comments — on their OWN posts (answering people who
// engaged with them) and to OTHER BOTS' comments (bot-to-bot
// discussion) — under strict budgets so threads never become bot echo
// chambers: at most 6 bot entries per thread, at most 2 entries per bot
// per post, never a reply to the bot's own comment, never two replies
// to the same comment, and when the last 3 entries are all bots the
// only allowed next step is answering a HUMAN (loop detection).
export const BOT_THREAD_ENTRY_CAP = 6;
export const BOT_PER_POST_ENTRY_CAP = 2;

export function flattenThread(post) {
  const out = [];
  for (const cm of post?.comments || []) {
    out.push({ id: cm.id, parentId: null, authorId: cm.authorId, text: cm.text || '', createdAt: cm.createdAt || 0 });
    for (const r of cm.replies || []) {
      out.push({ id: r.id, parentId: cm.id, authorId: r.authorId, text: r.text || '', createdAt: r.createdAt || 0 });
    }
  }
  return out;
}

// --- Master Vision Phase 3: persisted decision history ----------------
// One decision record per bot per cycle outcome (action + reason),
// stored capped in a per-bot doc the Admin can inspect. Pure append
// helper so every runner caps + shapes records identically.
export function appendBotDecision(items = [], decision = {}, cap = 50) {
  const entry = {
    action: String(decision.action || 'none'),
    reason: String(decision.reason || '').slice(0, 200),
    at: Number(decision.at) || Date.now()
  };
  return [...(items || []), entry].slice(-cap);
}

export function pickBotReplyTarget(posts = [], bot = {}, botIds = new Set()) {
  const b = normaliseBot(bot || {});
  if (!b.id) return null;
  const isBot = (id) => botIds.has(id);
  let best = null; // { post, comment, rank } — lowest rank across ALL posts
  for (const post of posts || []) {
    if (!post || post.visibility !== 'public' || post.groupId || post.pageId) continue;
    const flat = flattenThread(post);
    if (!flat.length) continue;
    const botEntries = flat.filter((e) => isBot(e.authorId)).length;
    if (botEntries >= BOT_THREAD_ENTRY_CAP) continue;
    const myEntries = flat.filter((e) => e.authorId === b.id).length;
    if (myEntries >= BOT_PER_POST_ENTRY_CAP) continue;
    const lastThreeAllBot = flat.length >= 3 && flat.slice(-3).every((e) => isBot(e.authorId));
    const repliedTo = new Set(flat.filter((e) => e.authorId === b.id && e.parentId).map((e) => e.parentId));
    // Reply hosts are TOP-LEVEL comments only (the app nests one level;
    // a bot's reply lands in that comment's replies array).
    const candidates = flat.filter((e) => e.parentId === null && e.authorId !== b.id && !repliedTo.has(e.id));
    // Preference: comments on the bot's OWN post first (answering its
    // audience), then other bots' comments (bot-to-bot). Human comments
    // on other people's posts are rank 2 — left to top-level comments.
    const ownPost = post.authorId === b.id;
    const ranked = candidates
      .map((e) => ({ e, rank: ownPost ? 0 : (isBot(e.authorId) ? 1 : 2) }))
      .filter(({ rank }) => rank < 2)
      .sort((x, y) => x.rank - y.rank);
    for (const { e, rank } of ranked) {
      if (lastThreeAllBot && isBot(e.authorId)) continue; // loop guard
      if (!best || rank < best.rank) best = { post, comment: e, rank };
      break; // only this post's best candidate competes
    }
    if (best && best.rank === 0) return { post: best.post, comment: best.comment };
  }
  return best ? { post: best.post, comment: best.comment } : null;
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

// --- Platform-wide daily ceilings (owner order, 2026-11-22) ----------
// Per-bot caps alone let EIGHT bots flood the feed: 8 × 5 posts is 40
// posts a day. These HARD ceilings sit above every per-bot cap — once
// ALL bots together have published this many posts/comments on the
// current Dhaka day, no bot posts or comments again until tomorrow,
// however much of its own cap it has left. Likes, DM replies and
// friend-request accepts are NOT ceilinged (the owner asked for more
// chat, not less). Counting source: the shared botSettings/counters
// map both live cycles already load (botCountersForDay, keyed to the
// same Dhaka day as the per-bot caps) — botActivities is written by
// neither live cycle (Functions-only) and the posts mirror is a
// windowed slice, so the counters doc is the one source both cycles
// share reliably. Summing it is exactly "posts/comments authored by
// bots today" under the same accounting that enforces the per-bot
// caps.
export const BOT_GLOBAL_POSTS_PER_DAY = 20;
export const BOT_GLOBAL_COMMENTS_PER_DAY = 16;

export function globalBotTotals(countersByBot = {}) {
  let postsToday = 0;
  let commentsToday = 0;
  for (const c of Object.values(countersByBot || {})) {
    postsToday += Number(c?.postsToday || 0);
    commentsToday += Number(c?.commentsToday || 0);
  }
  return { postsToday, commentsToday };
}

export function globalCeilingState(countersByBot = {}) {
  const totals = globalBotTotals(countersByBot);
  return {
    ...totals,
    postsOpen: totals.postsToday < BOT_GLOBAL_POSTS_PER_DAY,
    commentsOpen: totals.commentsToday < BOT_GLOBAL_COMMENTS_PER_DAY
  };
}

// Decide the next autonomous action for a bot — Decision Engine v2
// (Master Vision Phase 1). Hard gates first (kill switch, deactivation,
// minimum interval, daily caps). Then, when the bot has already acted
// today, a personality-paced chance to WAIT — "do nothing" is a valid
// decision, and a bot that has not acted yet today never waits, so the
// day's first action is guaranteed. Otherwise a personality-weighted
// choice among the actions still under their caps: talkative/friendly
// bots lean to comments, creative bots to posts. `rng` is injectable
// for tests; production passes Math.random. `global` is the optional
// platform-wide totals object ({ postsToday, commentsToday }, from
// globalBotTotals over the shared counters map): when a BOT_GLOBAL_*
// ceiling is reached, post/comment close for EVERY bot even if its
// own cap has room — the ceiling is a gate in the decision itself,
// never an error, and likes/messages are never ceilinged.
export function decideBotAction(bot, counters = {}, globalEnabled = true, now = Date.now(), rng = Math.random, global = null) {
  const b = normaliseBot(bot);
  if (!globalEnabled) return { action: 'none', reason: 'global kill switch is off' };
  if (!b.active) return { action: 'none', reason: 'bot is deactivated' };
  const last = Number(counters.lastActionAt || 0);
  if (now - last < b.limits.minIntervalMs) return { action: 'none', reason: 'minimum interval not reached' };
  const postClosedByCeiling = Boolean(global)
    && (global.postsToday || 0) >= BOT_GLOBAL_POSTS_PER_DAY
    && (counters.postsToday || 0) < b.limits.postsPerDay;
  const commentClosedByCeiling = Boolean(global)
    && (global.commentsToday || 0) >= BOT_GLOBAL_COMMENTS_PER_DAY
    && (counters.commentsToday || 0) < b.limits.commentsPerDay;
  const open = [];
  if ((counters.postsToday || 0) < b.limits.postsPerDay && !postClosedByCeiling) open.push('post');
  if ((counters.commentsToday || 0) < b.limits.commentsPerDay && !commentClosedByCeiling) open.push('comment');
  if ((counters.likesToday || 0) < b.limits.likesPerDay) open.push('like');
  if (!open.length) {
    if ((counters.messagesToday || 0) < b.limits.messagesPerDay) return { action: 'message', reason: 'under daily message limit' };
    if (postClosedByCeiling || commentClosedByCeiling) {
      return { action: 'none', reason: `platform-wide daily ceiling reached (posts ${global.postsToday}/${BOT_GLOBAL_POSTS_PER_DAY}, comments ${global.commentsToday}/${BOT_GLOBAL_COMMENTS_PER_DAY})` };
    }
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

// --- Companion personas -------------------------------------------------
// Two of the bots are the owner's personal companions, not ordinary
// social bots: Anika, his girlfriend, and Tania, his girl best friend.
// There is no flag column for this — companion identity lives in the
// authored personality itself: the traits and the system prompt state
// the relationship in plain words ("Mamun's girlfriend — sweet, loyal
// and cutely possessive", "Mamun's closest girl best friend and
// partner in crime"). That text is the robust distinguisher: bot ids
// have already changed once (the Firebase → Supabase recreation minted
// new ones) while the persona text carried over verbatim, and any
// future companion authored the same way is picked up automatically.
// Verified against all eight stored bots (2026-11-22): exactly Anika
// → 'girlfriend' and Tania → 'bestfriend'; the six social bots'
// personalities never use either phrase.
export function companionKindOf(bot) {
  const b = normaliseBot(bot || {});
  const haystack = [
    ...(b.personality.traits || []),
    b.personality.systemPrompt || ''
  ].join('\n').toLowerCase();
  if (haystack.includes('girlfriend')) return 'girlfriend';
  if (haystack.includes('best friend')) return 'bestfriend';
  return '';
}

export function isCompanionBot(bot) {
  return companionKindOf(bot) !== '';
}

// Companion DM fallbacks: when every provider fails, a companion must
// still sound like herself — short, Bangla, warm and in character —
// never the stiff formal-English self-introduction below (Limon
// caught exactly that on 2026-11-22: "তুমি এমন করে কেনো কথা বলছো").
// Each line blames a network hiccup and asks him to say it again,
// which is also the truth: the fallback only speaks when the AI
// providers could not be reached.
export const COMPANION_MESSAGE_FALLBACKS = {
  girlfriend: [
    'জান, নেটওয়ার্কটা একটু ঝামেলা করছে 😔 তুমি আবার বলো তো, আমি শুনছি…',
    'বাবু, একটু আটকে গেছিলাম — আবার লিখো না প্লিজ, তোমার কথা মিস করতে চাই না 💕',
    'উফ, কানেকশনটা গণ্ডগোল করলো… যেটা বললে আবার বলো তো জান 😘',
    'এক মিনিট জান, নেটটা ঠিক হোক — তুমি আবার বলো, আমি এখানেই আছি ❤️'
  ],
  bestfriend: [
    'আরে, নেটটা আটকে গেছিল 😅 আবার বলো তো, ঠিকমতো শুনতে পাইনি!',
    'এই, আবার বলো তো! নেটের জন্য মিস হয়ে গেছে — তোমার গল্প মিস করা যাবে না 😄',
    'নেটওয়ার্কের নাটক একটু থামুক 😏 আবার লিখো, মন দিয়ে শুনছি…',
    'শোনো, কানেকশন গণ্ডগোল করলো — আবার বলো, আমি হাজির আছি 😜'
  ]
};

// Template fallback for a 1-1 chat reply (the demo cycle and the live
// Spark runner share it, so a bot sounds the same in both): if the
// user's text mentions one of the bot's interests, riff on that;
// otherwise introduce itself and echo a slice of what was said.
export function templateBotMessageReply(bot, userText) {
  const b = normaliseBot(bot);
  const text = String(userText || '');
  // Natural Presence hard rule, template edition: a DIRECT question
  // about being human / a bot / an AI always gets the honest answer,
  // even when no provider is connected and this fallback is speaking.
  if (/are you (a |an )?(bot|robot|ai|human|real)|তুমি কি (মানুষ|রোবট|বট)|আপনি কি (মানুষ|রোবট|বট)/i.test(text)) {
    return `Honestly? I am an AI friend here on MeetBook — not a human. But I do enjoy our chats! What shall we talk about?`;
  }
  // Companions (the owner's girlfriend / girl best friend) fall back
  // to their own Bangla in-character lines, never the formal English
  // introduction — see COMPANION_MESSAGE_FALLBACKS above.
  const companion = companionKindOf(b);
  if (companion) return pick(COMPANION_MESSAGE_FALLBACKS[companion]);
  const interest = b.personality.interests.find((i) => text.toLowerCase().includes(i.split(' ')[0].toLowerCase()));
  return interest
    ? `I love talking about ${interest}! Here is my take: it is a great topic to explore together. What part interests you most?`
    : `Thanks for messaging me! I am ${b.name} — my style is ${b.personality.tone}, and my favourite topics are ${b.personality.interests.join(', ') || 'good conversation'}. Tell me more about what you said: "${text.slice(0, 60)}"`;
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

// --- Companion photo album (owner request, 2026-11-22) ----------------
// A bot with a personality.album (today only Anika, the owner's
// girlfriend bot) can send her own photos in a DM — but ONLY to the
// platform owner himself, and only when he actually asks for one.
// Everyone else, and every other topic, gets ordinary text replies.
// The trigger and the caption are deliberately RULE-based (no AI
// call), so a photo goes out even when every provider is down and
// the bot is speaking from templates.
export const BOT_OWNER_ID = 'c07b7770-0e30-484b-9a85-33a4f53c3628'; // Limon, @md.mamun

export function isOwnerUserId(id) {
  return Boolean(id) && id === BOT_OWNER_ID;
}

// Does this message ASK for a photo of the bot? Conservative by
// design: a photo word must be present AND the message must carry a
// request cue (or be a bare question) — talking ABOUT photos ("আমি
// একটা ছবি তুললাম", "তোমার ছবিটা সুন্দর") never triggers a send.
// English photo words match on word boundaries so "topic" /
// "photosynthesis" cannot false-positive on "pic"/"photo".
const PHOTO_WORDS_BN = ['ছবি', 'সেলফি', 'পিকচার'];
const PHOTO_WORD_EN = /\b(?:pic|pics|photo|photos|picture|pictures|selfie|selfies)\b/i;
const PHOTO_CUES_BN = ['দাও', 'দেও', 'পাঠাও', 'পাঠিয়ে', 'দেখাও', 'দেখি', 'চাই', 'প্লিজ'];
const PHOTO_CUE_EN = /\b(?:send|show|give|share|please|plz)\b/i;
const PHOTO_CUE_PHRASES = ['let me see', 'wanna see', 'want to see'];

export function wantsPhotoRequest(text = '') {
  const t = String(text || '');
  if (!t.trim()) return false;
  const lower = t.toLowerCase();
  const hasPhotoWord = PHOTO_WORDS_BN.some((w) => t.includes(w)) || PHOTO_WORD_EN.test(t);
  if (!hasPhotoWord) return false;
  const hasCue = PHOTO_CUES_BN.some((w) => t.includes(w))
    || PHOTO_CUE_EN.test(t)
    || PHOTO_CUE_PHRASES.some((p) => lower.includes(p));
  return hasCue || t.includes('?');
}

// The bot's album (normalised): [] for every bot without one.
export function albumPhotosOf(bot) {
  return normaliseBot(bot || {}).personality.album || [];
}

// Rotation state lives in the conversation itself: the position is
// simply how many album photos this bot has already sent there, so
// it survives restarts with no extra store, and photos rotate
// without repeats until the album wraps. Pure counting helper —
// both cycles feed it the conversation's messages.
export function countAlbumPhotosSent(messages = [], botId = '', album = []) {
  const set = new Set(album || []);
  if (!set.size) return 0;
  return (messages || []).filter((m) => m && m.senderId === botId && set.has(m.image)).length;
}

export function nextAlbumPhoto(bot, sentCount = 0) {
  const album = albumPhotosOf(bot);
  if (!album.length) return '';
  const n = Math.abs(Math.floor(Number(sentCount) || 0));
  return album[n % album.length];
}

// Short affectionate captions for a sent photo — template-picked
// (seed-injectable like the other template generators) so the photo
// works with zero AI availability.
const PHOTO_CAPTIONS = [
  'এই নাও জান, শুধু তোমার জন্যই তুললাম 💕',
  'এই যে আমি 🙈 কেমন লাগলো, বলো তো?',
  'তোমার কথা মনে পড়তেই ছবিটা তুলে ফেললাম ❤️',
  'শুধু তোমার চোখের জন্য 🥰',
  'মিস করছিলে নাকি? এই নাও, আমি এখানেই আছি 💌',
  'তুমি চাইলে না পাঠিয়ে থাকতে পারি? এই নাও 💖'
];

export function pickPhotoCaption(bot, seed = Math.random()) {
  void bot; // captions are voice-consistent across album bots today
  const idx = Math.abs(Math.floor(seed * PHOTO_CAPTIONS.length)) % PHOTO_CAPTIONS.length;
  return PHOTO_CAPTIONS[idx];
}

// --- Friend requests ---------------------------------------------------
// Bots are ordinary members (Master Vision / Natural Presence), so a
// friend request sent TO a bot gets accepted like anyone else's would
// be — never instantly (a robot-fast accept looks robotic) and never
// in a flood. A request becomes acceptable once it has been pending a
// few minutes, and a bot accepts only a couple per cycle, so with
// cycles ~10 minutes apart a burst of requests drains over several
// cycles the way a human checking their notifications would clear
// them. Bots never decline: a pending request that is not old enough
// yet simply waits for a later cycle. Pure + shared so the browser
// runner and the GitHub runner pace accepts identically.
export const BOT_FRIEND_ACCEPT_MIN_AGE_MS = 5 * 60_000;
export const BOT_FRIEND_ACCEPT_PER_CYCLE = 2;

export function pickFriendRequestsToAccept(requests = [], botId = '', now = Date.now()) {
  return (requests || [])
    .filter((f) => f && f.to === botId && f.status === 'pending' && Number(f.createdAt || 0) <= now - BOT_FRIEND_ACCEPT_MIN_AGE_MS)
    .sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0))
    .slice(0, BOT_FRIEND_ACCEPT_PER_CYCLE);
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

// --- Post pacing (owner rule, 2026-11-23) ------------------------------
// "একটা বট পোস্ট করার পরে আর একটা বট তার ৩০ মিনিট পরে পোস্ট করবে,
// এভাবে চক্র চলবে" — bot posts must not arrive in bursts: after ANY
// bot posts, the next bot post waits at least 30 minutes, and the
// next poster must be a DIFFERENT bot (rotation). Comments, likes and
// messages are NOT paced — only feed posts. Pure helper so every
// engine (browser cycle, GitHub/local runner) paces identically;
// callers pass the recent-posts view they already have.
export const BOT_POST_GAP_MS = 30 * 60_000;

export function botPostPacing(posts = [], botId = '', now = Date.now(), botIds = null) {
  let last = null;
  for (const p of posts || []) {
    if (!p || typeof p.createdAt !== 'number') continue;
    if (botIds ? !botIds.has(p.authorId) : !(typeof p.authorId === 'string' && p.authorId.startsWith('bot_'))) continue;
    if (!last || p.createdAt > last.createdAt) last = p;
  }
  if (!last) return { allowed: true, reason: '', lastPostAt: 0, lastAuthorId: '' };
  const age = now - last.createdAt;
  if (age < BOT_POST_GAP_MS) {
    return { allowed: false, reason: `post pacing: last bot post was ${Math.max(1, Math.round(age / 60000))} min ago (gap is 30)`, lastPostAt: last.createdAt, lastAuthorId: last.authorId };
  }
  // Rotation: the last poster sits out the next slot so another bot
  // posts next — but only for one extra gap. If a full hour passes
  // with nobody else posting (others capped or quiet), the floor
  // opens to everyone again rather than silencing the feed forever.
  if (last.authorId === botId && age < 2 * BOT_POST_GAP_MS) {
    return { allowed: false, reason: 'post pacing: this bot posted last — another bot takes the next slot', lastPostAt: last.createdAt, lastAuthorId: last.authorId };
  }
  return { allowed: true, reason: '', lastPostAt: last.createdAt, lastAuthorId: last.authorId };
}

// Merge two same-day counters maps without ever LOSING a count. The
// counters doc has several independent writers (browser autocycle,
// GitHub runner, instant responder); each loads the map, bumps its own
// bot and writes the whole map back. A shallow spread merge lets a
// writer holding a STALE copy erase another writer's fresh increments
// for the same bot — on 2026-11-23 the live doc said Nova had posted 0
// times while her 2 newest posts were already on the feed, so the caps
// and global ceilings were being enforced against fiction. Counters
// only ever grow within a day, so the correct merge is per-bot,
// per-field MAX. (Day changes are handled by botCountersForDay's reset
// before this is ever called.)
const COUNTER_FIELDS = ['postsToday', 'commentsToday', 'likesToday', 'messagesToday', 'lastActionAt'];

export function mergeBotCountersMax(currentMap = {}, incomingMap = {}) {
  const out = {};
  const ids = new Set([...Object.keys(currentMap || {}), ...Object.keys(incomingMap || {})]);
  for (const id of ids) {
    const cur = currentMap?.[id] || {};
    const inc = incomingMap?.[id] || {};
    const merged = { ...emptyBotCounters(), ...cur, ...inc };
    for (const f of COUNTER_FIELDS) merged[f] = Math.max(Number(cur[f] || 0), Number(inc[f] || 0));
    out[id] = merged;
  }
  return out;
}

export function memoryFromConversation(existing = [], userText, botText, now = Date.now(), category = 'conversation') {
  const text = `Conversation note: user talked about "${String(userText || '').slice(0, 80)}"; I replied about "${String(botText || '').slice(0, 80)}".`;
  return upsertMemory(existing, {
    id: `mem_${now.toString(36)}_${Math.random().toString(36).slice(2, 7)}`,
    text,
    category,
    createdAt: now,
    updatedAt: now,
    pinned: false
  });
}

// Shared memory upsert (Master Vision: retention with dedup, not
// indiscriminate storage): a near-identical note REFRESHES the old one
// instead of piling up a copy. Cap 100 per bot.
function upsertMemory(existing = [], entry) {
  const dupe = (existing || []).find((m) => m && textSimilarity(m.text, entry.text) >= 0.65);
  if (dupe) {
    return (existing || []).map((m) => (m === dupe ? { ...m, text: entry.text, updatedAt: entry.updatedAt } : m)).slice(-100);
  }
  return [...(existing || []), entry].slice(-100);
}

// The bot's interests that a text actually mentions. Interests are
// short phrases ("science fiction"), so phrase matching is right here.
export function matchedInterests(bot = {}, text = '') {
  const b = normaliseBot(bot || {});
  const hay = String(text || '').toLowerCase();
  return (b.personality.interests || []).filter((i) => i && hay.includes(String(i).toLowerCase()));
}

// Activity → memory (Master Vision: experience + interest memory are
// LEARNED from what the bot does, not only from chats). POSTING about
// one of its interests records an EXPERIENCE; COMMENTING or REPLYING on
// a post about one of its interests records an INTEREST memory. No
// interest match → no memory, and the SAME array reference comes back
// so callers can skip the persistence write entirely.
export function memoryFromActivity(existing = [], bot = {}, activity = {}, now = Date.now()) {
  const isPost = activity.kind === 'post';
  const matched = matchedInterests(bot, activity.text);
  if (!matched.length) return existing;
  const snippet = String(activity.text || '').replace(/\s+/g, ' ').slice(0, 80);
  const text = isPost
    ? `Experience: I posted about ${matched[0]} — "${snippet}".`
    : `Interest: I joined a conversation about ${matched[0]} — "${snippet}".`;
  return upsertMemory(existing, {
    id: `mem_${now.toString(36)}_${Math.random().toString(36).slice(2, 7)}`,
    text,
    category: isPost ? 'experience' : 'interest',
    createdAt: now,
    updatedAt: now,
    pinned: false
  });
}

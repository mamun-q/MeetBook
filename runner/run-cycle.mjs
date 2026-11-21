// MeetBook autonomous bot runner (Stage C) — runs ONE bot cycle from
// GitHub Actions on a schedule, so bots reply even when no admin browser
// is open. It mirrors the browser runner in src/api.js (runLiveBotCycle)
// step for step — same counters doc, same caps, same kill switch, same
// message/post shapes — and reuses the app's own pure modules
// (src/botLogic.js for decisions/prompts/templates, src/aiProviders.js
// for the multi-provider router and usage accounting), so behaviour can
// never drift between the two runners.
//
// Access: the runner signs in with the shared MeetBook Official admin
// account (RUNNER_EMAIL / RUNNER_PASSWORD GitHub Secrets) through the
// normal Supabase client SDK — the exact same access the admin's own
// browser has, enforced by the same Postgres RLS policies. Provider
// keys are NOT duplicated into GitHub Secrets — they are read from the
// admin-only botSecrets/config row, exactly where the Admin panel
// stores them, and usage counters are written back there.
import { createClient } from '@supabase/supabase-js';
import { DEFAULT_SUPABASE_CONFIG } from '../src/supabase.js';
import { uid as genId } from '../src/utils.js';
import {
  normaliseBot, findBotReplyTargets, decideBotAction,
  templateBotMessageReply, generateTemplatePost, generateTemplateComment,
  emptyBotCounters, counterDayKey, botCountersForDay, memoryFromConversation,
  pickBotCommentTarget, pickBotReplyTarget, appendBotDecision, memoryFromActivity, isDuplicateBotText, isNearDuplicateBotText, threadContextText, freshTemplatePost
} from '../src/botLogic.js';
import {
  resolveAiConfig, generateRouted, normaliseUsageMap, usageTotals,
  dhakaDayKey, getLastRoutedFailure, resetLastRoutedFailure
} from '../src/aiProviders.js';

const email = process.env.RUNNER_EMAIL;
const password = process.env.RUNNER_PASSWORD;
if (!email || !password) {
  console.error('RUNNER_EMAIL / RUNNER_PASSWORD secrets are not set — cannot run.');
  process.exit(1);
}

// The runner's own client: a one-shot Node process needs no session
// persistence, token refresh or URL detection — just this run's
// sign-in. Config values come from src/supabase.js so the project and
// publishable key can never drift from the app's.
const supabase = createClient(DEFAULT_SUPABASE_CONFIG.url, DEFAULT_SUPABASE_CONFIG.publishableKey, {
  auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false }
});

// ---------------------------------------------------------------------
// Supabase data-access helpers — the same throw-on-error contract (and
// names) as src/api.js's sb* layer, so the cycle code below reads
// exactly like the browser runner's. Rows arrive already shaped like
// the old Firestore documents (quoted camelCase columns, epoch-ms
// bigints as numbers), so no field mapping is needed anywhere.
// ---------------------------------------------------------------------
function sbError(error, context) {
  const err = new Error(error?.message || `Supabase request failed${context ? ` (${context})` : ''}`);
  if (error?.code) err.code = error.code;
  if (error?.details) err.details = error.details;
  return err;
}

async function sbSelect(table, build) {
  let q = supabase.from(table).select('*');
  if (build) q = build(q);
  const { data, error } = await q;
  if (error) throw sbError(error, table);
  return data || [];
}

async function sbGet(table, id) {
  const { data, error } = await supabase.from(table).select('*').eq('id', id).maybeSingle();
  if (error) throw sbError(error, table);
  return data || null;
}

async function sbInsert(table, row) {
  const { data, error } = await supabase.from(table).insert(row).select();
  if (error) throw sbError(error, table);
  return data?.[0] || row;
}

// Partial-column upsert: only the given columns are written, existing
// columns survive — the Postgres equivalent of Firestore's
// setDoc(..., { merge: true }).
async function sbUpsert(table, row, opts = {}) {
  const { data, error } = await supabase.from(table).upsert(row, opts).select();
  if (error) throw sbError(error, table);
  return data?.[0] || row;
}

async function sbUpdate(table, id, patch) {
  const { data, error } = await supabase.from(table).update(patch).eq('id', id).select();
  if (error) throw sbError(error, table);
  return data?.[0] || null;
}

// AI usage accounting — identical math to api.js bumpAiUsage; attempts
// are accumulated in memory and persisted once at the end of the cycle.
let aiUsage = null;
function bumpUsage(providerId, attempt) {
  const day = dhakaDayKey();
  const base = aiUsage && aiUsage.day === day ? aiUsage : { day, providers: {} };
  const providers = normaliseUsageMap(base.providers);
  const p = providers[providerId];
  if (p) {
    // One routed call can be several REAL provider requests (Gemini's
    // model chain); attempt.attempts carries the true count.
    const attempts = Math.max(1, Number(attempt.attempts) || 1);
    p.calls += attempts;
    p.errors += attempt.ok ? attempts - 1 : attempts;
    if (attempt.usage) {
      p.promptTokens += attempt.usage.promptTokens || 0;
      p.completionTokens += attempt.usage.completionTokens || 0;
    }
    if (attempt.exhausted) p.exhaustedUntil = Date.now() + 24 * 3600_000;
  }
  const totals = usageTotals(providers);
  aiUsage = { day, providers, callsToday: totals.calls, tokensToday: totals.tokens, updatedAt: Date.now() };
}

async function generateBotText(bot, memories, context, templateText, secretsDoc, platformConfig) {
  const config = resolveAiConfig(secretsDoc || {}, platformConfig || {});
  const usageToday = aiUsage && aiUsage.day === dhakaDayKey() ? normaliseUsageMap(aiUsage.providers) : normaliseUsageMap(null);
  const res = await generateRouted({
    bot, memories, context, config, usageToday,
    onAttempt: (providerId, attempt) => bumpUsage(providerId, attempt)
  });
  if (res) return { text: res.text, provider: res.provider, model: res.model };
  return { text: templateText, provider: 'template-fallback', model: 'template-fallback' };
}

async function recordBotBrain(bot, provider, model) {
  try {
    await sbUpsert('botBrains', {
      id: bot.id, botId: bot.id, systemPrompt: bot.personality.systemPrompt, provider,
      model: model || 'template-fallback', updatedAt: Date.now()
    });
  } catch { /* bookkeeping only */ }
}

// The bot's public users-row profile — the same shape src/api.js's
// ensureBotUserDoc writes (the users policies let an admin create
// exactly this: isBot == true, role 'bot').
function botUserProfile(bot) {
  return {
    name: bot.name, username: bot.username, email: '', bio: bot.bio, avatar: bot.avatar, cover: '',
    work: '', education: '', currentCity: '', hometown: '', relationship: '', website: '', nickname: '',
    dob: '', gender: '', role: 'bot', isBot: true, botId: bot.id, online: true, lastSeen: Date.now(),
    createdAt: bot.createdAt || Date.now(), followers: [], following: [], closeFriends: [], settings: {}
  };
}

// Create the bot's users row if missing; if it exists, only sync the
// identity fields (never clobber followers/following that accumulated).
async function ensureBotUserDoc(bot) {
  const existing = await sbGet('users', bot.id);
  if (!existing) {
    await sbInsert('users', { id: bot.id, ...botUserProfile(bot) });
    return;
  }
  if (existing.name !== bot.name || existing.username !== bot.username || existing.avatar !== bot.avatar || existing.bio !== bot.bio) {
    await sbUpdate('users', bot.id, { name: bot.name, username: bot.username, avatar: bot.avatar, bio: bot.bio });
  }
}

// Same discovery as the browser runner's findLiveReplyTargets.
async function findReplyTargets(bot) {
  const convRows = await sbSelect('conversations', (q) => q.contains('participants', [bot.id]).limit(50));
  const convs = convRows.slice(0, 20);
  const latestByConv = new Map();
  for (const conv of convs) {
    if (conv.isGroup) continue;
    const msgRows = await sbSelect('messages', (q) => q.eq('conversationId', conv.id).order('createdAt', { ascending: false }).limit(1));
    latestByConv.set(conv.id, msgRows[0] || null);
  }
  return findBotReplyTargets(convs, latestByConv, bot.id);
}

async function latestMessage(conversationId) {
  const rows = await sbSelect('messages', (q) => q.eq('conversationId', conversationId).order('createdAt', { ascending: false }).limit(1));
  return rows[0] || null;
}

async function main() {
  const { data: signInData, error: signInError } = await supabase.auth.signInWithPassword({ email, password });
  if (signInError) throw signInError;
  const meRow = await sbGet('users', signInData.user.id);
  const myRole = meRow ? String(meRow.role || '') : '';
  if (!['admin', 'superadmin'].includes(myRole)) {
    console.error(`Runner account ${email} is not an admin (role: ${myRole || 'none'}) — refusing to run.`);
    process.exit(1);
  }
  console.log(`Signed in as ${email} (role: ${myRole}).`);

  // Claim the current 3-minute autocycle window — the SAME row the
  // browser runner claims (atomically: a single upsert with
  // ignoreDuplicates lands the row for exactly one claimant and
  // returns it; everyone else gets an empty result). If an admin
  // browser already ran this window, skip: two runners acting on the
  // same counter snapshot used to exceed daily caps and lose each
  // other's increments.
  const windowKey = Math.floor(Date.now() / (3 * 60 * 1000));
  let claimed = false;
  try {
    const { data: claimedRows, error: claimError } = await supabase.from('botRunners')
      .upsert({ id: `autocycle_${windowKey}`, kind: 'gh-actions-runner', window: windowKey, by: signInData.user.id, createdAt: Date.now(), status: 'claimed' }, { onConflict: 'id', ignoreDuplicates: true })
      .select();
    if (claimError) throw claimError;
    claimed = Boolean(claimedRows?.length);
  } catch { claimed = false; }
  if (!claimed) {
    console.log('Bot cycle skipped: this window was already claimed by another runner.');
    return;
  }

  const globalRow = await sbGet('botSettings', 'global');
  const globalEnabled = !globalRow || globalRow.enabled !== false;
  if (!globalEnabled) {
    console.log('Bot cycle skipped: global bot kill switch is off.');
    return;
  }
  const [botRows, secretsRow, configRow, countersRow] = await Promise.all([
    sbSelect('bots', (q) => q.limit(100)),
    sbGet('botSecrets', 'config'),
    sbGet('config', 'app'),
    sbGet('botSettings', 'counters')
  ]);
  const bots = botRows.map((row) => normaliseBot(row));
  const secretsDoc = secretsRow || {};
  if (secretsDoc.aiUsage && secretsDoc.aiUsage.day === dhakaDayKey()) {
    aiUsage = { day: secretsDoc.aiUsage.day, providers: normaliseUsageMap(secretsDoc.aiUsage.providers) };
  }
  const platformConfig = configRow || {};
  const day = counterDayKey();
  const counters = countersRow ? botCountersForDay(countersRow, day) : {};

  resetLastRoutedFailure();
  const results = [];
  const decisions = [];
  const note = (bot, action, reason = '') => decisions.push({ botId: bot.id, action, reason });
  for (const bot of bots) {
    const c = { ...emptyBotCounters(), ...(counters[bot.id] || {}) };
    let targets = [];
    try { targets = await findReplyTargets(bot); } catch (err) { results.push(`${bot.name} → DM scan error: ${err.message}`); note(bot, 'error', err.message); }
    if (!bot.active) {
      if (targets.length) { results.push(`${bot.name} → deactivated, ${targets.length} unanswered DM(s) waiting`); note(bot, 'none', `deactivated — ${targets.length} unanswered DM(s) waiting`); }
      continue;
    }
    counters[bot.id] = c;
    try {
      try { await ensureBotUserDoc(bot); } catch { /* actions below surface real errors */ }
      const memRow = await sbGet('botMemories', bot.id);
      let memories = memRow ? (memRow.items || []) : [];
      let acted = false;

      // --- chat reply (one per cycle, messages/day cap is the gate) ---
      if (targets.length && c.messagesToday >= bot.limits.messagesPerDay) {
        results.push(`${bot.name} → ${targets.length} unanswered DM(s), daily message limit reached (${c.messagesToday}/${bot.limits.messagesPerDay})`);
        note(bot, 'none', `daily message limit reached (${c.messagesToday}/${bot.limits.messagesPerDay}) — ${targets.length} unanswered DM(s)`);
      } else if (targets.length) {
        const target = targets[0];
        const fresh = await latestMessage(target.conversationId);
        if (fresh && fresh.senderId === target.humanId) {
          // Short-term memory: recent thread context (single-column
          // order + limit — the (conversationId, createdAt) index
          // serves it, no extra round-trips).
          const threadMsgs = await sbSelect('messages', (q) => q.eq('conversationId', target.conversationId).order('createdAt', { ascending: true }).limit(50));
          const gen = await generateBotText(bot, memories, { kind: 'message', text: fresh.text, thread: threadContextText(threadMsgs, bot.id) }, templateBotMessageReply(bot, fresh.text), secretsDoc, platformConfig);
          await sbInsert('messages', {
            id: genId('m'),
            conversationId: target.conversationId, participants: [...target.participants],
            senderId: bot.id, text: gen.text, image: '', audio: '',
            createdAt: Date.now(), status: 'sent', readBy: [bot.id]
          });
          // Count NOW — a notification/memory failure after this
          // point must not leave a delivered message uncounted.
          c.messagesToday += 1;
          if (target.humanId !== bot.id) {
            await sbInsert('notifications', {
              id: genId('n'),
              userId: target.humanId, type: 'message', actorId: bot.id,
              text: `${bot.name} sent you a message.`, postId: '', conversationId: target.conversationId,
              read: false, createdAt: Date.now()
            });
          }
          const updatedMemories = memoryFromConversation(memories, fresh.text, gen.text);
          try { await sbUpsert('botMemories', { id: bot.id, botId: bot.id, items: updatedMemories }); memories = updatedMemories; } catch { /* best-effort */ }
          await recordBotBrain(bot, gen.provider, gen.model);
          acted = true;
          results.push(`${bot.name} → message (via ${gen.provider})`);
          note(bot, 'message', `via ${gen.provider}`);
        }
      }

      // --- autonomous action (post / comment / like) ---
      const decision = decideBotAction(bot, c, true);
      if (decision.action === 'post') {
        const ownRows = await sbSelect('posts', (q) => q.eq('authorId', bot.id).limit(10));
        // Cross-bot anti-duplicate: also compare against OTHER bots'
        // recent posts (Master Vision: ecosystem-wide uniqueness).
        const botIds = new Set(bots.map((b) => b.id));
        const recentRows = await sbSelect('posts', (q) => q.order('createdAt', { ascending: false }).limit(30));
        const crossTexts = recentRows.filter((p) => p.authorId !== bot.id && botIds.has(p.authorId)).slice(0, 10).map((p) => p.text);
        const recentTexts = [...ownRows.map((p) => p.text), ...crossTexts];
        let gen = await generateBotText(bot, memories, { kind: 'post' }, generateTemplatePost(bot), secretsDoc, platformConfig);
        if (isNearDuplicateBotText(gen.text, recentTexts)) {
          // Repeated a recent post — swap in a fresh template once;
          // if every variant repeats, skip the post entirely.
          const fresh = freshTemplatePost(bot, recentTexts);
          if (!fresh) { results.push(`${bot.name} → skipped post (would repeat a recent post)`); note(bot, 'none', 'skipped post (would repeat a recent post)'); gen = null; }
          else gen = { ...gen, text: fresh, provider: 'template', model: '' };
        }
        if (gen) {
        // NOTE: the Firestore post doc carried `generatedBy` (the AI
        // provider stamp); the Postgres posts table has NO such column
        // (PostgREST rejects unknown columns), so the stamp lives only
        // in botBrains now — see runner/PHASE4_NOTES.md.
        await sbInsert('posts', {
          id: genId('p'),
          authorId: bot.id, text: gen.text, image: '',
          visibility: 'public', audienceIds: [],
          createdAt: Date.now(), editedAt: 0,
          likes: [], reactions: {}, comments: [], shares: 0, sharedFrom: '', savedBy: [],
          groupId: '', pageId: '', pageName: '', pageAvatar: '',
          poll: null, location: '', feeling: '', pinned: false
        });
        await recordBotBrain(bot, gen.provider, gen.model);
        c.postsToday += 1;
        c.lastActionAt = Date.now();
        const actMem = memoryFromActivity(memories, bot, { kind: 'post', text: gen.text });
        if (actMem !== memories) { try { await sbUpsert('botMemories', { id: bot.id, botId: bot.id, items: actMem }); memories = actMem; } catch { /* best-effort */ } }
        acted = true;
        results.push(`${bot.name} → post (via ${gen.provider})`);
          note(bot, 'post', `via ${gen.provider}`);
        }
      } else if (decision.action === 'comment') {
        const allPosts = await sbSelect('posts', (q) => q.order('createdAt', { ascending: false }).limit(30));
        const botIds = new Set(bots.map((b) => b.id));
        // Phase 2: reply before a new top-level comment (thread
        // budgets + loop detection live in pickBotReplyTarget).
        const replyTarget = pickBotReplyTarget(allPosts, bot, botIds);
        if (replyTarget) {
          const hostPost = replyTarget.post;
          const hostComment = replyTarget.comment;
          const blockRow = await sbGet('blocks', `${hostComment.authorId}_${bot.id}`);
          if (!blockRow) {
            const gen = await generateBotText(bot, memories, { kind: 'comment', text: hostComment.text }, generateTemplateComment(bot), secretsDoc, platformConfig);
            const freshRow = await sbGet('posts', hostPost.id);
            const freshComments = freshRow ? (freshRow.comments || []) : (hostPost.comments || []);
            const host = freshComments.find((cm) => cm.id === hostComment.id);
            if (host) {
              host.replies = [...(host.replies || []), { id: genId('c'), authorId: bot.id, text: gen.text, createdAt: Date.now() }];
              await sbUpdate('posts', hostPost.id, { comments: freshComments });
              c.commentsToday += 1;
              c.lastActionAt = Date.now();
              const actMem = memoryFromActivity(memories, bot, { kind: 'comment', text: hostPost.text });
              if (actMem !== memories) { try { await sbUpsert('botMemories', { id: bot.id, botId: bot.id, items: actMem }); memories = actMem; } catch { /* best-effort */ } }
              if (!botIds.has(hostComment.authorId)) {
                await sbInsert('notifications', {
                  id: genId('n'),
                  userId: hostComment.authorId, type: 'comment', actorId: bot.id,
                  text: `${bot.name} replied to your comment.`, postId: hostPost.id, conversationId: '',
                  read: false, createdAt: Date.now()
                });
              }
              await recordBotBrain(bot, gen.provider, gen.model);
              acted = true;
              results.push(`${bot.name} → comment reply (via ${gen.provider})`);
              note(bot, 'comment-reply', `via ${gen.provider}`);
            }
          }
        } else {
        const candidates = allPosts
          .filter((p) => p.visibility === 'public' && !p.groupId && !p.pageId && p.authorId !== bot.id);
        // One comment per post, ever: no fallback to a post the bot
        // already commented on (that fallback stacked repeat comments
        // onto the same post).
        const target = pickBotCommentTarget(candidates, bot);
        if (target) {
          const blockRow = await sbGet('blocks', `${target.authorId}_${bot.id}`);
          if (!blockRow) {
            const gen = await generateBotText(bot, memories, { kind: 'comment', text: target.text }, generateTemplateComment(bot), secretsDoc, platformConfig);
            const comment = { id: genId('c'), authorId: bot.id, text: gen.text, createdAt: Date.now(), replies: [] };
            // Re-read the post AFTER generating (the browser cycle
            // does this too): appending to the pre-generation snapshot
            // used to silently erase any human comment added while
            // the bot was "thinking".
            const freshRow = await sbGet('posts', target.id);
            const freshComments = freshRow ? (freshRow.comments || []) : (target.comments || []);
            await sbUpdate('posts', target.id, { comments: [...freshComments, comment] });
            c.commentsToday += 1;
            c.lastActionAt = Date.now();
            const actMem = memoryFromActivity(memories, bot, { kind: 'comment', text: target.text });
            if (actMem !== memories) { try { await sbUpsert('botMemories', { id: bot.id, botId: bot.id, items: actMem }); memories = actMem; } catch { /* best-effort */ } }
            if (target.authorId !== bot.id) {
              await sbInsert('notifications', {
                id: genId('n'),
                userId: target.authorId, type: 'comment', actorId: bot.id,
                text: `${bot.name} commented on your post.`, postId: target.id, conversationId: '',
                read: false, createdAt: Date.now()
              });
            }
            await recordBotBrain(bot, gen.provider, gen.model);
            acted = true;
            results.push(`${bot.name} → comment (via ${gen.provider})`);
            note(bot, 'comment', `via ${gen.provider}`);
          }
        }
        }
      } else if (decision.action === 'like') {
        const likeRows = await sbSelect('posts', (q) => q.order('createdAt', { ascending: false }).limit(30));
        const target = likeRows
          // PUBLIC posts only, like the comment filter — the runner
          // signs in as an admin and can READ every post, so without
          // this check bots liked friends-only posts they were never
          // in the audience for.
          .find((p) => p.visibility === 'public' && !p.groupId && !p.pageId && p.authorId !== bot.id && !(p.likes || []).includes(bot.id));
        if (target) {
          // No arrayUnion in PostgREST: append to the row's current
          // likes and write the whole array back (the browser cycle
          // writes likes the same way).
          await sbUpdate('posts', target.id, { likes: [...(target.likes || []), bot.id] });
          c.likesToday += 1;
          c.lastActionAt = Date.now();
          acted = true;
          results.push(`${bot.name} → like`);
          note(bot, 'like');
        }
      }
      if (!acted && !targets.length) { results.push(`${bot.name} → none (${decision.reason})`); note(bot, 'none', decision.reason); }
    } catch (err) {
      results.push(`${bot.name} → error: ${err.message}`);
      note(bot, 'error', err.message);
    }
  }

  // Counters merge per bot, exactly like api.js saveLiveBotCounters:
  // read the stored row and merge this cycle's counters over it, so a
  // cycle never wipes another writer's increments for OTHER bots
  // (a whole-row overwrite would be last-writer-wins). Same-day only;
  // a stale-day row is replaced wholesale, matching
  // botCountersForDay's reset semantics.
  try {
    const current = await sbGet('botSettings', 'counters');
    const merged = current && current.day === day ? { ...(current.counters || {}), ...counters } : counters;
    await sbUpsert('botSettings', { id: 'counters', day, counters: merged, updatedAt: Date.now() });
  } catch { /* best-effort — the in-memory counters still gated this cycle */ }
  // Phase 3: persist decision history (botRunners/decisions_<botId>,
  // admin read/write; capped at 50 per bot). Best-effort per bot.
  {
    const byBot = new Map();
    for (const dcn of decisions) {
      if (!byBot.has(dcn.botId)) byBot.set(dcn.botId, []);
      byBot.get(dcn.botId).push(dcn);
    }
    for (const [botId, entries] of byBot) {
      try {
        const rowId = `decisions_${botId}`;
        const row = await sbGet('botRunners', rowId);
        let items = row ? (row.items || []) : [];
        for (const e of entries) items = appendBotDecision(items, { ...e, at: Date.now() });
        await sbUpsert('botRunners', { id: rowId, botId, items, updatedAt: Date.now() });
      } catch { /* best-effort */ }
    }
  }
  if (aiUsage) {
    await sbUpsert('botSecrets', {
      id: 'config',
      aiUsage: { day: aiUsage.day, providers: aiUsage.providers }, updatedAt: Date.now()
    });
  }
  const failure = getLastRoutedFailure();
  console.log(`Bot cycle complete: ${results.join(' · ') || 'no bots'}${failure ? ` · AI failure: ${failure} (template fallback used)` : ''}`);
}

main().then(() => process.exit(0)).catch((err) => {
  console.error(`Bot cycle failed: ${err.stack || err.message}`);
  process.exit(1);
});

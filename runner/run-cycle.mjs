// MeetBook autonomous bot runner (Stage C) — runs ONE bot cycle from
// GitHub Actions on a schedule, so bots reply even when no admin browser
// is open. It mirrors the browser runner in src/api.js (runLiveBotCycle)
// step for step — same counters doc, same caps, same kill switch, same
// message/post shapes — and reuses the app's own pure modules
// (src/botLogic.js for decisions/prompts/templates, src/aiProviders.js
// for the multi-provider router and usage accounting), so behaviour can
// never drift between the two runners.
//
// Access: a Firebase service-account key (GitHub Secret
// FIREBASE_SERVICE_ACCOUNT) via the Admin SDK, which bypasses Firestore
// rules. Provider keys are NOT duplicated into GitHub Secrets — they are
// read from the admin-only botSecrets/config doc, exactly where the
// Admin panel stores them, and usage counters are written back there.
import { initializeApp, cert } from 'firebase-admin/app';
import { getFirestore, FieldValue } from 'firebase-admin/firestore';
import {
  normaliseBot, findBotReplyTargets, decideBotAction,
  templateBotMessageReply, generateTemplatePost, generateTemplateComment,
  emptyBotCounters, counterDayKey, botCountersForDay, memoryFromConversation
} from '../src/botLogic.js';
import {
  resolveAiConfig, generateRouted, normaliseUsageMap, usageTotals,
  dhakaDayKey, getLastRoutedFailure, resetLastRoutedFailure
} from '../src/aiProviders.js';

const raw = process.env.FIREBASE_SERVICE_ACCOUNT;
if (!raw) {
  console.error('FIREBASE_SERVICE_ACCOUNT secret is not set — cannot run.');
  process.exit(1);
}
let serviceAccount;
try {
  serviceAccount = JSON.parse(raw);
} catch {
  console.error('FIREBASE_SERVICE_ACCOUNT is not valid JSON.');
  process.exit(1);
}
initializeApp({ credential: cert(serviceAccount) });
const db = getFirestore();

const tsMs = (v) => (typeof v === 'number' ? v : (v && typeof v.toMillis === 'function' ? v.toMillis() : 0));

// AI usage accounting — identical math to api.js bumpAiUsage; attempts
// are accumulated in memory and persisted once at the end of the cycle.
let aiUsage = null;
function bumpUsage(providerId, attempt) {
  const day = dhakaDayKey();
  const base = aiUsage && aiUsage.day === day ? aiUsage : { day, providers: {} };
  const providers = normaliseUsageMap(base.providers);
  const p = providers[providerId];
  if (p) {
    p.calls += 1;
    if (!attempt.ok) p.errors += 1;
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
    await db.doc(`botBrains/${bot.id}`).set({
      botId: bot.id, systemPrompt: bot.personality.systemPrompt, provider,
      model: model || 'template-fallback', updatedAt: Date.now()
    }, { merge: true });
  } catch { /* bookkeeping only */ }
}

async function ensureBotUserDoc(bot) {
  const ref = db.doc(`users/${bot.id}`);
  const snap = await ref.get();
  if (!snap.exists) {
    await ref.set({
      name: bot.name, username: bot.username, avatar: bot.avatar, bio: bot.bio,
      isBot: true, role: 'bot', createdAt: Date.now()
    });
    return;
  }
  const u = snap.data();
  if (u.name !== bot.name || u.username !== bot.username || u.avatar !== bot.avatar || u.bio !== bot.bio) {
    await ref.update({ name: bot.name, username: bot.username, avatar: bot.avatar, bio: bot.bio });
  }
}

// Same discovery as the browser runner's findLiveReplyTargets.
async function findReplyTargets(bot) {
  const convSnap = await db.collection('conversations').where('participants', 'array-contains', bot.id).limit(50).get();
  const convs = convSnap.docs.map((d) => ({ id: d.id, ...d.data() })).slice(0, 20);
  const latestByConv = new Map();
  for (const conv of convs) {
    if (conv.isGroup) continue;
    const msgSnap = await db.collection('messages').where('conversationId', '==', conv.id).orderBy('createdAt', 'desc').limit(1).get();
    const latest = msgSnap.docs[0];
    latestByConv.set(conv.id, latest ? { id: latest.id, ...latest.data(), createdAt: tsMs(latest.data().createdAt) } : null);
  }
  return findBotReplyTargets(convs, latestByConv, bot.id);
}

async function latestMessage(conversationId) {
  const snap = await db.collection('messages').where('conversationId', '==', conversationId).orderBy('createdAt', 'desc').limit(1).get();
  const d = snap.docs[0];
  return d ? { id: d.id, ...d.data(), createdAt: tsMs(d.data().createdAt) } : null;
}

async function main() {
  const globalSnap = await db.doc('botSettings/global').get();
  const globalEnabled = !globalSnap.exists || globalSnap.data().enabled !== false;
  if (!globalEnabled) {
    console.log('Bot cycle skipped: global bot kill switch is off.');
    return;
  }
  const [botsSnap, secretsSnap, configSnap, countersSnap] = await Promise.all([
    db.collection('bots').limit(100).get(),
    db.doc('botSecrets/config').get(),
    db.doc('config/app').get(),
    db.doc('botSettings/counters').get()
  ]);
  const bots = botsSnap.docs.map((d) => normaliseBot({ id: d.id, ...d.data() }));
  const secretsDoc = secretsSnap.exists ? secretsSnap.data() : {};
  if (secretsDoc.aiUsage && secretsDoc.aiUsage.day === dhakaDayKey()) {
    aiUsage = { day: secretsDoc.aiUsage.day, providers: normaliseUsageMap(secretsDoc.aiUsage.providers) };
  }
  const platformConfig = configSnap.exists ? configSnap.data() : {};
  const day = counterDayKey();
  const counters = countersSnap.exists ? botCountersForDay(countersSnap.data(), day) : {};

  resetLastRoutedFailure();
  const results = [];
  for (const bot of bots) {
    const c = { ...emptyBotCounters(), ...(counters[bot.id] || {}) };
    let targets = [];
    try { targets = await findReplyTargets(bot); } catch (err) { results.push(`${bot.name} → DM scan error: ${err.message}`); }
    if (!bot.active) {
      if (targets.length) results.push(`${bot.name} → deactivated, ${targets.length} unanswered DM(s) waiting`);
      continue;
    }
    counters[bot.id] = c;
    try {
      try { await ensureBotUserDoc(bot); } catch { /* actions below surface real errors */ }
      const memSnap = await db.doc(`botMemories/${bot.id}`).get();
      const memories = memSnap.exists ? (memSnap.data().items || []) : [];
      let acted = false;

      // --- chat reply (one per cycle, messages/day cap is the gate) ---
      if (targets.length && c.messagesToday >= bot.limits.messagesPerDay) {
        results.push(`${bot.name} → ${targets.length} unanswered DM(s), daily message limit reached (${c.messagesToday}/${bot.limits.messagesPerDay})`);
      } else if (targets.length) {
        const target = targets[0];
        const fresh = await latestMessage(target.conversationId);
        if (fresh && fresh.senderId === target.humanId) {
          const gen = await generateBotText(bot, memories, { kind: 'message', text: fresh.text }, templateBotMessageReply(bot, fresh.text), secretsDoc, platformConfig);
          await db.collection('messages').add({
            conversationId: target.conversationId, participants: [...target.participants],
            senderId: bot.id, text: gen.text, image: '', audio: '',
            createdAt: Date.now(), status: 'sent', readBy: [bot.id]
          });
          if (target.humanId !== bot.id) {
            await db.collection('notifications').add({
              userId: target.humanId, type: 'message', actorId: bot.id,
              text: `${bot.name} sent you a message.`, postId: '', conversationId: target.conversationId,
              read: false, createdAt: Date.now()
            });
          }
          const updatedMemories = memoryFromConversation(memories, fresh.text, gen.text);
          try { await db.doc(`botMemories/${bot.id}`).set({ botId: bot.id, items: updatedMemories }); } catch { /* best-effort */ }
          await recordBotBrain(bot, gen.provider, gen.model);
          c.messagesToday += 1;
          acted = true;
          results.push(`${bot.name} → message (via ${gen.provider})`);
        }
      }

      // --- autonomous action (post / comment / like) ---
      const decision = decideBotAction(bot, c, true);
      if (decision.action === 'post') {
        const gen = await generateBotText(bot, memories, { kind: 'post' }, generateTemplatePost(bot), secretsDoc, platformConfig);
        await db.collection('posts').add({
          authorId: bot.id, text: `AI Bot post · ${gen.text}`, image: '',
          visibility: 'public', audienceIds: [],
          createdAt: FieldValue.serverTimestamp(), editedAt: 0,
          likes: [], reactions: {}, comments: [], shares: 0, sharedFrom: '', savedBy: [],
          groupId: '', pageId: '', pageName: '', pageAvatar: '',
          poll: null, location: '', feeling: '', pinned: false, generatedBy: gen.provider
        });
        await recordBotBrain(bot, gen.provider, gen.model);
        c.postsToday += 1;
        c.lastActionAt = Date.now();
        acted = true;
        results.push(`${bot.name} → post (via ${gen.provider})`);
      } else if (decision.action === 'comment') {
        const postsSnap = await db.collection('posts').orderBy('createdAt', 'desc').limit(30).get();
        const candidates = postsSnap.docs
          .map((d) => ({ id: d.id, ...d.data() }))
          .filter((p) => p.visibility === 'public' && !p.groupId && !p.pageId && p.authorId !== bot.id);
        const target = candidates.find((p) => !(p.comments || []).some((cm) => cm.authorId === bot.id)) || candidates[0];
        if (target) {
          const blockSnap = await db.doc(`blocks/${target.authorId}_${bot.id}`).get();
          if (!blockSnap.exists()) {
            const gen = await generateBotText(bot, memories, { kind: 'comment', text: target.text }, generateTemplateComment(bot), secretsDoc, platformConfig);
            const comment = { id: `c_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`, authorId: bot.id, text: gen.text, createdAt: Date.now(), replies: [] };
            await db.doc(`posts/${target.id}`).update({ comments: [...(target.comments || []), comment] });
            if (target.authorId !== bot.id) {
              await db.collection('notifications').add({
                userId: target.authorId, type: 'comment', actorId: bot.id,
                text: `${bot.name} (AI Bot) commented on your post.`, postId: target.id, conversationId: '',
                read: false, createdAt: Date.now()
              });
            }
            await recordBotBrain(bot, gen.provider, gen.model);
            c.commentsToday += 1;
            c.lastActionAt = Date.now();
            acted = true;
            results.push(`${bot.name} → comment (via ${gen.provider})`);
          }
        }
      } else if (decision.action === 'like') {
        const postsSnap = await db.collection('posts').orderBy('createdAt', 'desc').limit(30).get();
        const target = postsSnap.docs
          .map((d) => ({ id: d.id, ...d.data() }))
          .find((p) => !p.groupId && !p.pageId && p.authorId !== bot.id && !(p.likes || []).includes(bot.id));
        if (target) {
          await db.doc(`posts/${target.id}`).update({ likes: FieldValue.arrayUnion(bot.id) });
          c.likesToday += 1;
          c.lastActionAt = Date.now();
          acted = true;
          results.push(`${bot.name} → like`);
        }
      }
      if (!acted && !targets.length) results.push(`${bot.name} → none (${decision.reason})`);
    } catch (err) {
      results.push(`${bot.name} → error: ${err.message}`);
    }
  }

  await db.doc('botSettings/counters').set({ day, counters, updatedAt: Date.now() });
  if (aiUsage) {
    await db.doc('botSecrets/config').set({ aiUsage: { day: aiUsage.day, providers: aiUsage.providers }, updatedAt: Date.now() }, { merge: true });
  }
  const failure = getLastRoutedFailure();
  console.log(`Bot cycle complete: ${results.join(' · ') || 'no bots'}${failure ? ` · AI failure: ${failure} (template fallback used)` : ''}`);
}

main().then(() => process.exit(0)).catch((err) => {
  console.error(`Bot cycle failed: ${err.stack || err.message}`);
  process.exit(1);
});

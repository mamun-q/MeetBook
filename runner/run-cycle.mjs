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
// normal Firebase client SDK — the exact same access the admin's own
// browser has, enforced by the same Firestore rules. Provider keys are
// NOT duplicated into GitHub Secrets — they are read from the admin-only
// botSecrets/config doc, exactly where the Admin panel stores them, and
// usage counters are written back there.
import { initializeApp } from 'firebase/app';
import { getAuth, signInWithEmailAndPassword } from 'firebase/auth';
import {
  getFirestore, collection, doc, getDoc, getDocs, addDoc, setDoc, updateDoc,
  query, where, orderBy, limit, serverTimestamp, arrayUnion, runTransaction
} from 'firebase/firestore';
import { DEFAULT_FIREBASE_CONFIG } from '../src/firebase-config.js';
import {
  normaliseBot, findBotReplyTargets, decideBotAction,
  templateBotMessageReply, generateTemplatePost, generateTemplateComment,
  emptyBotCounters, counterDayKey, botCountersForDay, memoryFromConversation,
  pickBotCommentTarget, pickBotReplyTarget, isDuplicateBotText, isNearDuplicateBotText, threadContextText, freshTemplatePost
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

const app = initializeApp(DEFAULT_FIREBASE_CONFIG);
const auth = getAuth(app);
const db = getFirestore(app);

const tsMs = (v) => (typeof v === 'number' ? v : (v && typeof v.toMillis === 'function' ? v.toMillis() : 0));
const withMs = (data) => ({ ...data, createdAt: tsMs(data.createdAt) });

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
    await setDoc(doc(db, 'botBrains', bot.id), {
      botId: bot.id, systemPrompt: bot.personality.systemPrompt, provider,
      model: model || 'template-fallback', updatedAt: Date.now()
    }, { merge: true });
  } catch { /* bookkeeping only */ }
}

async function ensureBotUserDoc(bot) {
  const ref = doc(db, 'users', bot.id);
  const snap = await getDoc(ref);
  if (!snap.exists()) {
    await setDoc(ref, {
      name: bot.name, username: bot.username, avatar: bot.avatar, bio: bot.bio,
      isBot: true, role: 'bot', createdAt: Date.now()
    });
    return;
  }
  const u = snap.data();
  if (u.name !== bot.name || u.username !== bot.username || u.avatar !== bot.avatar || u.bio !== bot.bio) {
    await updateDoc(ref, { name: bot.name, username: bot.username, avatar: bot.avatar, bio: bot.bio });
  }
}

// Same discovery as the browser runner's findLiveReplyTargets.
async function findReplyTargets(bot) {
  const convSnap = await getDocs(query(collection(db, 'conversations'), where('participants', 'array-contains', bot.id), limit(50)));
  const convs = convSnap.docs.map((d) => ({ id: d.id, ...withMs(d.data()) })).slice(0, 20);
  const latestByConv = new Map();
  for (const conv of convs) {
    if (conv.isGroup) continue;
    const msgSnap = await getDocs(query(collection(db, 'messages'), where('conversationId', '==', conv.id), orderBy('createdAt', 'desc'), limit(1)));
    const latest = msgSnap.docs[0];
    latestByConv.set(conv.id, latest ? { id: latest.id, ...withMs(latest.data()) } : null);
  }
  return findBotReplyTargets(convs, latestByConv, bot.id);
}

async function latestMessage(conversationId) {
  const snap = await getDocs(query(collection(db, 'messages'), where('conversationId', '==', conversationId), orderBy('createdAt', 'desc'), limit(1)));
  const d = snap.docs[0];
  return d ? { id: d.id, ...withMs(d.data()) } : null;
}

async function main() {
  const cred = await signInWithEmailAndPassword(auth, email, password);
  const meSnap = await getDoc(doc(db, 'users', cred.user.uid));
  const myRole = meSnap.exists() ? String(meSnap.data().role || '') : '';
  if (!['admin', 'superadmin'].includes(myRole)) {
    console.error(`Runner account ${email} is not an admin (role: ${myRole || 'none'}) — refusing to run.`);
    process.exit(1);
  }
  console.log(`Signed in as ${email} (role: ${myRole}).`);

  // Claim the current 3-minute autocycle window — the SAME doc the
  // browser runner claims (atomically, via transaction). If an admin
  // browser already ran this window, skip: two runners acting on the
  // same counter snapshot used to exceed daily caps and lose each
  // other's increments.
  const windowKey = Math.floor(Date.now() / (3 * 60 * 1000));
  const claimRef = doc(db, 'botRunners', `autocycle_${windowKey}`);
  const claimed = await runTransaction(db, async (tx) => {
    const snap = await tx.get(claimRef);
    if (snap.exists()) return false;
    tx.set(claimRef, { kind: 'gh-actions-runner', window: windowKey, by: cred.user.uid, createdAt: Date.now(), status: 'claimed' });
    return true;
  }).catch(() => false);
  if (!claimed) {
    console.log('Bot cycle skipped: this window was already claimed by another runner.');
    return;
  }

  const globalSnap = await getDoc(doc(db, 'botSettings', 'global'));
  const globalEnabled = !globalSnap.exists() || globalSnap.data().enabled !== false;
  if (!globalEnabled) {
    console.log('Bot cycle skipped: global bot kill switch is off.');
    return;
  }
  const [botsSnap, secretsSnap, configSnap, countersSnap] = await Promise.all([
    getDocs(query(collection(db, 'bots'), limit(100))),
    getDoc(doc(db, 'botSecrets', 'config')),
    getDoc(doc(db, 'config', 'app')),
    getDoc(doc(db, 'botSettings', 'counters'))
  ]);
  const bots = botsSnap.docs.map((d) => normaliseBot({ id: d.id, ...withMs(d.data()) }));
  const secretsDoc = secretsSnap.exists() ? secretsSnap.data() : {};
  if (secretsDoc.aiUsage && secretsDoc.aiUsage.day === dhakaDayKey()) {
    aiUsage = { day: secretsDoc.aiUsage.day, providers: normaliseUsageMap(secretsDoc.aiUsage.providers) };
  }
  const platformConfig = configSnap.exists() ? configSnap.data() : {};
  const day = counterDayKey();
  const counters = countersSnap.exists() ? botCountersForDay(countersSnap.data(), day) : {};

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
      const memSnap = await getDoc(doc(db, 'botMemories', bot.id));
      const memories = memSnap.exists() ? (memSnap.data().items || []) : [];
      let acted = false;

      // --- chat reply (one per cycle, messages/day cap is the gate) ---
      if (targets.length && c.messagesToday >= bot.limits.messagesPerDay) {
        results.push(`${bot.name} → ${targets.length} unanswered DM(s), daily message limit reached (${c.messagesToday}/${bot.limits.messagesPerDay})`);
      } else if (targets.length) {
        const target = targets[0];
        const fresh = await latestMessage(target.conversationId);
        if (fresh && fresh.senderId === target.humanId) {
          // Short-term memory: recent thread context (single-field
          // query + client sort — no composite index needed).
          const threadSnap = await getDocs(query(collection(db, 'messages'), where('conversationId', '==', target.conversationId), limit(50)));
          const threadMsgs = threadSnap.docs.map((d) => d.data()).sort((a, b) => (a.createdAt?.toMillis?.() ?? a.createdAt ?? 0) - (b.createdAt?.toMillis?.() ?? b.createdAt ?? 0));
          const gen = await generateBotText(bot, memories, { kind: 'message', text: fresh.text, thread: threadContextText(threadMsgs, bot.id) }, templateBotMessageReply(bot, fresh.text), secretsDoc, platformConfig);
          await addDoc(collection(db, 'messages'), {
            conversationId: target.conversationId, participants: [...target.participants],
            senderId: bot.id, text: gen.text, image: '', audio: '',
            createdAt: Date.now(), status: 'sent', readBy: [bot.id]
          });
          // Count NOW — a notification/memory failure after this
          // point must not leave a delivered message uncounted.
          c.messagesToday += 1;
          if (target.humanId !== bot.id) {
            await addDoc(collection(db, 'notifications'), {
              userId: target.humanId, type: 'message', actorId: bot.id,
              text: `${bot.name} sent you a message.`, postId: '', conversationId: target.conversationId,
              read: false, createdAt: Date.now()
            });
          }
          const updatedMemories = memoryFromConversation(memories, fresh.text, gen.text);
          try { await setDoc(doc(db, 'botMemories', bot.id), { botId: bot.id, items: updatedMemories }); } catch { /* best-effort */ }
          await recordBotBrain(bot, gen.provider, gen.model);
          acted = true;
          results.push(`${bot.name} → message (via ${gen.provider})`);
        }
      }

      // --- autonomous action (post / comment / like) ---
      const decision = decideBotAction(bot, c, true);
      if (decision.action === 'post') {
        const ownSnap = await getDocs(query(collection(db, 'posts'), where('authorId', '==', bot.id), limit(10)));
        // Cross-bot anti-duplicate: also compare against OTHER bots'
        // recent posts (Master Vision: ecosystem-wide uniqueness).
        const botIds = new Set(bots.map((b) => b.id));
        const recentSnap = await getDocs(query(collection(db, 'posts'), orderBy('createdAt', 'desc'), limit(30)));
        const crossTexts = recentSnap.docs.map((d) => d.data()).filter((p) => p.authorId !== bot.id && botIds.has(p.authorId)).slice(0, 10).map((p) => p.text);
        const recentTexts = [...ownSnap.docs.map((d) => d.data().text), ...crossTexts];
        let gen = await generateBotText(bot, memories, { kind: 'post' }, generateTemplatePost(bot), secretsDoc, platformConfig);
        if (isNearDuplicateBotText(gen.text, recentTexts)) {
          // Repeated a recent post — swap in a fresh template once;
          // if every variant repeats, skip the post entirely.
          const fresh = freshTemplatePost(bot, recentTexts);
          if (!fresh) { results.push(`${bot.name} → skipped post (would repeat a recent post)`); gen = null; }
          else gen = { ...gen, text: fresh, provider: 'template', model: '' };
        }
        if (gen) {
        await addDoc(collection(db, 'posts'), {
          authorId: bot.id, text: `AI Bot post · ${gen.text}`, image: '',
          visibility: 'public', audienceIds: [],
          createdAt: serverTimestamp(), editedAt: 0,
          likes: [], reactions: {}, comments: [], shares: 0, sharedFrom: '', savedBy: [],
          groupId: '', pageId: '', pageName: '', pageAvatar: '',
          poll: null, location: '', feeling: '', pinned: false, generatedBy: gen.provider
        });
        await recordBotBrain(bot, gen.provider, gen.model);
        c.postsToday += 1;
        c.lastActionAt = Date.now();
        acted = true;
        results.push(`${bot.name} → post (via ${gen.provider})`);
        }
      } else if (decision.action === 'comment') {
        const postsSnap = await getDocs(query(collection(db, 'posts'), orderBy('createdAt', 'desc'), limit(30)));
        const allPosts = postsSnap.docs.map((d) => ({ id: d.id, ...d.data() }));
        const botIds = new Set(bots.map((b) => b.id));
        // Phase 2: reply before a new top-level comment (thread
        // budgets + loop detection live in pickBotReplyTarget).
        const replyTarget = pickBotReplyTarget(allPosts, bot, botIds);
        if (replyTarget) {
          const hostPost = replyTarget.post;
          const hostComment = replyTarget.comment;
          const blockSnap = await getDoc(doc(db, 'blocks', `${hostComment.authorId}_${bot.id}`));
          if (!blockSnap.exists()) {
            const gen = await generateBotText(bot, memories, { kind: 'comment', text: hostComment.text }, generateTemplateComment(bot), secretsDoc, platformConfig);
            const freshSnap = await getDoc(doc(db, 'posts', hostPost.id));
            const freshComments = freshSnap.exists() ? (freshSnap.data().comments || []) : (hostPost.comments || []);
            const host = freshComments.find((cm) => cm.id === hostComment.id);
            if (host) {
              host.replies = [...(host.replies || []), { id: `c_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`, authorId: bot.id, text: gen.text, createdAt: Date.now() }];
              await updateDoc(doc(db, 'posts', hostPost.id), { comments: freshComments });
              c.commentsToday += 1;
              c.lastActionAt = Date.now();
              if (!botIds.has(hostComment.authorId)) {
                await addDoc(collection(db, 'notifications'), {
                  userId: hostComment.authorId, type: 'comment', actorId: bot.id,
                  text: `${bot.name} (AI Bot) replied to your comment.`, postId: hostPost.id, conversationId: '',
                  read: false, createdAt: Date.now()
                });
              }
              await recordBotBrain(bot, gen.provider, gen.model);
              acted = true;
              results.push(`${bot.name} → comment reply (via ${gen.provider})`);
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
          const blockSnap = await getDoc(doc(db, 'blocks', `${target.authorId}_${bot.id}`));
          if (!blockSnap.exists()) {
            const gen = await generateBotText(bot, memories, { kind: 'comment', text: target.text }, generateTemplateComment(bot), secretsDoc, platformConfig);
            const comment = { id: `c_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`, authorId: bot.id, text: gen.text, createdAt: Date.now(), replies: [] };
            // Re-read the post AFTER generating (the browser cycle
            // does this too): appending to the pre-generation snapshot
            // used to silently erase any human comment added while
            // the bot was "thinking".
            const freshSnap = await getDoc(doc(db, 'posts', target.id));
            const freshComments = freshSnap.exists() ? (freshSnap.data().comments || []) : (target.comments || []);
            await updateDoc(doc(db, 'posts', target.id), { comments: [...freshComments, comment] });
            c.commentsToday += 1;
            c.lastActionAt = Date.now();
            if (target.authorId !== bot.id) {
              await addDoc(collection(db, 'notifications'), {
                userId: target.authorId, type: 'comment', actorId: bot.id,
                text: `${bot.name} (AI Bot) commented on your post.`, postId: target.id, conversationId: '',
                read: false, createdAt: Date.now()
              });
            }
            await recordBotBrain(bot, gen.provider, gen.model);
            acted = true;
            results.push(`${bot.name} → comment (via ${gen.provider})`);
          }
        }
        }
      } else if (decision.action === 'like') {
        const postsSnap = await getDocs(query(collection(db, 'posts'), orderBy('createdAt', 'desc'), limit(30)));
        const target = postsSnap.docs
          .map((d) => ({ id: d.id, ...d.data() }))
          // PUBLIC posts only, like the comment filter — the runner
          // signs in as an admin and can READ every post, so without
          // this check bots liked friends-only posts they were never
          // in the audience for.
          .find((p) => p.visibility === 'public' && !p.groupId && !p.pageId && p.authorId !== bot.id && !(p.likes || []).includes(bot.id));
        if (target) {
          await updateDoc(doc(db, 'posts', target.id), { likes: arrayUnion(bot.id) });
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

  // merge: true — deep-merges the counters map per bot instead of
  // overwriting the whole doc (last-writer-wins lost increments).
  await setDoc(doc(db, 'botSettings', 'counters'), { day, counters, updatedAt: Date.now() }, { merge: true });
  if (aiUsage) {
    await setDoc(doc(db, 'botSecrets', 'config'), { aiUsage: { day: aiUsage.day, providers: aiUsage.providers }, updatedAt: Date.now() }, { merge: true });
  }
  const failure = getLastRoutedFailure();
  console.log(`Bot cycle complete: ${results.join(' · ') || 'no bots'}${failure ? ` · AI failure: ${failure} (template fallback used)` : ''}`);
}

main().then(() => process.exit(0)).catch((err) => {
  console.error(`Bot cycle failed: ${err.stack || err.message}`);
  process.exit(1);
});

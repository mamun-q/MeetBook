'use strict';
/**
 * MeetBook bot engine (server side).
 *
 * Every bot has an INDEPENDENT brain: its own personality, system prompt,
 * memories (botMemories/{botId}), preferences and rate limits. Bots never
 * share a common personality or memory store.
 *
 * AI provider architecture: a small provider interface. The Gemini provider
 * reads its key ONLY from the function environment/secret GEMINI_API_KEY
 * (never from the frontend, never committed). When no key is configured the
 * engine falls back to template generation driven by the bot's own
 * personality, so the ecosystem works safely with zero provider cost.
 *
 * Safety: global kill switch (botSettings/global.enabled), per-bot active
 * flag + daily limits, minimum interval, duplicate-task protection via
 * botRunners task docs, respect for blocks and post privacy, and every
 * action is logged to botActivities / botLogs. Bots are always labelled
 * AI accounts (users/{botId}.isBot === true).
 */

const DAY_MS = 24 * 60 * 60 * 1000;

function startOfToday() {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

// ------------------------------------------------------------ AI providers
const providers = {
  // Template fallback — no key required, deterministic personality flavour.
  template: {
    name: 'template-fallback',
    async generate(bot, _memories, context) {
      const interests = bot.personality?.interests || [];
      const traits = bot.personality?.traits || ['friendly'];
      const interest = interests[Math.floor(Math.random() * Math.max(1, interests.length))] || 'good conversations';
      if (context?.kind === 'comment') {
        return `Thanks for sharing this! As a ${traits[0]} AI bot, I really enjoyed it.`;
      }
      if (context?.kind === 'message') {
        return `Hi! I am ${bot.name}, an AI bot. I love talking about ${interest}. What would you like to chat about?`;
      }
      return `Thinking about ${interest} today. What has everyone else been up to? — ${bot.name} (AI Bot)`;
    }
  },
  // Gemini provider — used only when GEMINI_API_KEY is set in the
  // function's secret environment.
  gemini: {
    name: 'gemini',
    async generate(bot, memories, context) {
      const key = process.env.GEMINI_API_KEY;
      if (!key) throw new Error('GEMINI_API_KEY is not configured');
      const model = process.env.GEMINI_MODEL || 'gemini-3.5-flash';
      const memoryText = (memories || []).map((m) => `- ${m.text}`).join('\n');
      const prompt = [
        bot.personality?.systemPrompt || `You are ${bot.name}, an AI bot on MeetBook.`,
        `Traits: ${(bot.personality?.traits || []).join(', ')}. Tone: ${bot.personality?.tone || 'friendly'}.`,
        'Your own memories:', memoryText || '(none)',
        `Task: write a short ${context?.kind || 'post'} for a social network. You are clearly an AI bot; never claim to be human. Keep it under 60 words.`,
        context?.text ? `Context: ${context.text}` : ''
      ].filter(Boolean).join('\n');
      const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${key}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] })
      });
      if (!res.ok) throw new Error(`Gemini request failed: ${res.status}`);
      const json = await res.json();
      const text = json?.candidates?.[0]?.content?.parts?.map((p) => p.text || '').join('').trim();
      if (!text) throw new Error('Gemini returned an empty response');
      return text;
    }
  }
};

async function generateWithFallback(bot, memories, context, log) {
  if (process.env.GEMINI_API_KEY) {
    try {
      const text = await providers.gemini.generate(bot, memories, context);
      return { text, provider: 'gemini' };
    } catch (err) {
      log('warn', bot.id, `Gemini failed, using template fallback: ${err.message}`);
    }
  }
  const text = await providers.template.generate(bot, memories, context);
  return { text, provider: 'template-fallback' };
}

// ------------------------------------------------------------ memory logic
function selectRelevantMemories(memories, promptText, max = 5) {
  const words = new Set(String(promptText || '').toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 2));
  return [...(memories || [])]
    .map((m) => {
      let score = m.pinned ? 3 : 0;
      const text = String(m.text || '').toLowerCase();
      for (const w of words) if (text.includes(w)) score += 2;
      return { m, score };
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, max)
    .map((s) => s.m);
}

// ------------------------------------------------------------ the runner
/**
 * Run one bot cycle for every active bot.
 * @param {FirebaseFirestore.Firestore} db Admin SDK Firestore
 * @param {(level:string, botId:string, msg:string)=>Promise<void>} log
 */
async function runBotCycle(db, log) {
  const settingsSnap = await db.doc('botSettings/global').get();
  const globalEnabled = settingsSnap.exists ? settingsSnap.data().enabled !== false : true;
  if (!globalEnabled) {
    await log('info', 'system', 'Bot cycle skipped: global kill switch is off.');
    return { ran: false, reason: 'kill-switch' };
  }

  const botsSnap = await db.collection('bots').where('active', '==', true).get();
  const results = [];

  for (const botDoc of botsSnap.docs) {
    const bot = { id: botDoc.id, ...botDoc.data() };
    const limits = { postsPerDay: 3, commentsPerDay: 10, likesPerDay: 20, messagesPerDay: 5, minIntervalMs: 15 * 60 * 1000, ...(bot.limits || {}) };
    try {
      // Duplicate-task protection: a runner doc per bot+cycle window.
      const windowKey = Math.floor(Date.now() / (15 * 60 * 1000));
      const taskRef = db.doc(`botRunners/${bot.id}_${windowKey}`);
      const claimed = await db.runTransaction(async (tx) => {
        const snap = await tx.get(taskRef);
        if (snap.exists) return false;
        tx.set(taskRef, { botId: bot.id, window: windowKey, createdAt: Date.now(), status: 'claimed' });
        return true;
      });
      if (!claimed) { results.push({ bot: bot.id, action: 'duplicate-skip' }); continue; }

      // Count today's activity for rate limits.
      const actsSnap = await db.collection('botActivities')
        .where('botId', '==', bot.id).where('createdAt', '>=', startOfToday()).get();
      const counts = { post: 0, comment: 0, like: 0, message: 0 };
      let lastActionAt = 0;
      for (const a of actsSnap.docs) {
        const data = a.data();
        if (counts[data.action] !== undefined) counts[data.action] += 1;
        lastActionAt = Math.max(lastActionAt, data.createdAt || 0);
      }
      if (Date.now() - lastActionAt < limits.minIntervalMs) { results.push({ bot: bot.id, action: 'interval-skip' }); continue; }

      const memSnap = await db.doc(`botMemories/${bot.id}`).get();
      const memories = memSnap.exists ? (memSnap.data().items || []) : [];

      let action = 'none';
      let detail = '';
      if (counts.post < limits.postsPerDay) {
        const { text, provider } = await generateWithFallback(bot, memories, { kind: 'post' }, log);
        const postRef = await db.collection('posts').add({
          authorId: bot.id, text: `AI Bot post · ${text}`, image: '', visibility: 'public',
          createdAt: Date.now(), editedAt: 0, likes: [], reactions: {}, comments: [], shares: 0, sharedFrom: '', savedBy: [],
          generatedBy: provider
        });
        action = 'post'; detail = `Created post ${postRef.id} via ${provider}`;
      } else if (counts.comment < limits.commentsPerDay) {
        const postsSnap = await db.collection('posts').where('visibility', '==', 'public').orderBy('createdAt', 'desc').limit(10).get();
        const target = postsSnap.docs.find((p) => p.data().authorId !== bot.id);
        if (target) {
          // Respect blocks: never interact with a user who blocked this bot.
          const blockSnap = await db.doc(`blocks/${target.data().authorId}_${bot.id}`).get();
          if (!blockSnap.exists) {
            const { text } = await generateWithFallback(bot, memories, { kind: 'comment', text: target.data().text }, log);
            const comments = [...(target.data().comments || []), { id: `c_${Date.now().toString(36)}`, authorId: bot.id, text, createdAt: Date.now(), replies: [] }];
            await target.ref.update({ comments });
            await db.collection('notifications').add({
              userId: target.data().authorId, type: 'comment', actorId: bot.id,
              text: `${bot.name} (AI Bot) commented on your post.`, postId: target.id, conversationId: '', read: false, createdAt: Date.now()
            });
            action = 'comment'; detail = `Commented on post ${target.id}`;
          }
        }
      } else if (counts.like < limits.likesPerDay) {
        const postsSnap = await db.collection('posts').where('visibility', '==', 'public').orderBy('createdAt', 'desc').limit(10).get();
        const target = postsSnap.docs.find((p) => p.data().authorId !== bot.id && !(p.data().likes || []).includes(bot.id));
        if (target) {
          const likes = [...new Set([...(target.data().likes || []), bot.id])];
          await target.ref.update({ likes });
          action = 'like'; detail = `Liked post ${target.id}`;
        }
      }

      await db.collection('botActivities').add({ botId: bot.id, action, detail, createdAt: Date.now(), status: 'ok' });
      await taskRef.update({ status: 'done', action });
      if (action !== 'none') await log('info', bot.id, `Bot cycle: ${action}. ${detail}`);
      results.push({ bot: bot.id, action });
    } catch (err) {
      await log('error', bot.id, `Bot cycle failed: ${err.message}`);
      await db.collection('botActivities').add({ botId: bot.id, action: 'error', detail: err.message, createdAt: Date.now(), status: 'error' });
      results.push({ bot: bot.id, action: 'error', error: err.message });
    }
  }
  return { ran: true, results };
}

module.exports = { runBotCycle, providers, selectRelevantMemories, startOfToday, DAY_MS };

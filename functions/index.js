'use strict';
/**
 * MeetBook Cloud Functions (firebase-functions v2, Node 20).
 *
 * Deploy requires the Blaze plan: `firebase deploy --only functions`.
 * Until then the web app runs fully on client + Firestore rules; these
 * functions add server-side enforcement and the autonomous bot engine.
 *
 * Secrets: set the AI key with `firebase functions:secrets:set GEMINI_API_KEY`
 * — it is read from process.env inside the bot engine and NEVER shipped to
 * the frontend.
 */
const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { onDocumentCreated } = require('firebase-functions/v2/firestore');
const { onSchedule } = require('firebase-functions/v2/scheduler');
const { onRequest } = require('firebase-functions/v2/https');
const admin = require('firebase-admin');
const { runBotCycle } = require('./botEngine');

admin.initializeApp();
const db = admin.firestore();

// ------------------------------------------------------------ helpers
async function log(level, botId, message) {
  await db.collection('botLogs').add({ level, botId: botId || 'system', message, createdAt: Date.now() });
  if (level === 'error') console.error(message); else console.log(message);
}

async function requireAdmin(request) {
  if (!request.auth) throw new HttpsError('unauthenticated', 'Sign in required.');
  const snap = await db.doc(`users/${request.auth.uid}`).get();
  if (!snap.exists || snap.data().role !== 'admin') {
    throw new HttpsError('permission-denied', 'Admin role required (verified server-side).');
  }
  return snap.data();
}

// Simple per-user sliding-window rate limit stored in _rateLimits docs.
async function rateLimit(key, limit, windowMs) {
  const ref = db.doc(`_rateLimits/${key}`);
  const now = Date.now();
  const ok = await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const events = snap.exists ? (snap.data().events || []).filter((t) => now - t < windowMs) : [];
    if (events.length >= limit) return false;
    events.push(now);
    tx.set(ref, { events, updatedAt: now });
    return true;
  });
  if (!ok) throw new HttpsError('resource-exhausted', 'Rate limit exceeded. Please slow down.');
}

// ------------------------------------------------------------ callables
/** Admin-only: set another user's role (user/admin). */
exports.setUserRole = onCall(async (request) => {
  await requireAdmin(request);
  await rateLimit(`setRole_${request.auth.uid}`, 20, 60_000);
  const { uid, role } = request.data || {};
  if (!uid || !['user', 'admin'].includes(role)) throw new HttpsError('invalid-argument', 'Provide uid and role (user|admin).');
  await db.doc(`users/${uid}`).update({ role });
  await log('info', 'system', `Admin ${request.auth.uid} set role of ${uid} to ${role}.`);
  return { ok: true, uid, role };
});

/** Authenticated: file a report (mirrors the client write, with validation). */
exports.reportContent = onCall(async (request) => {
  if (!request.auth) throw new HttpsError('unauthenticated', 'Sign in required.');
  await rateLimit(`report_${request.auth.uid}`, 10, 60_000);
  const { targetType, targetId, reason } = request.data || {};
  if (!['post', 'user', 'comment', 'message'].includes(targetType) || !targetId) {
    throw new HttpsError('invalid-argument', 'Provide a valid targetType and targetId.');
  }
  const ref = await db.collection('reports').add({
    reporterId: request.auth.uid, targetType, targetId,
    reason: String(reason || 'Inappropriate content').slice(0, 500),
    status: 'open', createdAt: Date.now()
  });
  return { ok: true, reportId: ref.id };
});

/** Admin-only: trigger one bot cycle on demand (same engine as the schedule). */
exports.runBotCycleNow = onCall(async (request) => {
  await requireAdmin(request);
  const result = await runBotCycle(db, log);
  return { ok: true, ...result };
});

/** Admin-only: global bot kill switch. */
exports.setBotKillSwitch = onCall(async (request) => {
  await requireAdmin(request);
  const enabled = Boolean(request.data?.enabled);
  await db.doc('botSettings/global').set({ enabled }, { merge: true });
  await log('info', 'system', `Global bot kill switch set to ${enabled ? 'ENABLED' : 'STOPPED'} by ${request.auth.uid}.`);
  return { ok: true, enabled };
});

// ------------------------------------------------------------ triggers
/** Fan out notifications when a post is created (mentions). */
exports.onPostCreate = onDocumentCreated('posts/{postId}', async (event) => {
  const post = event.data?.data();
  if (!post) return;
  const mentions = [...new Set([...String(post.text || '').matchAll(/@([a-zA-Z0-9_.]{3,24})/g)].map((m) => m[1].toLowerCase()))];
  for (const username of mentions) {
    const snap = await db.collection('users').where('username', '==', username).limit(1).get();
    for (const userDoc of snap.docs) {
      if (userDoc.id === post.authorId) continue;
      await db.collection('notifications').add({
        userId: userDoc.id, type: 'mention', actorId: post.authorId,
        text: 'You were mentioned in a post.', postId: event.params.postId,
        conversationId: '', read: false, createdAt: Date.now()
      });
    }
  }
});

/** When a human messages a bot, let the bot engine draft a reply. */
exports.botOnMessage = onDocumentCreated('messages/{messageId}', async (event) => {
  const msg = event.data?.data();
  if (!msg) return;
  const convSnap = await db.doc(`conversations/${msg.conversationId}`).get();
  if (!convSnap.exists) return;
  const participants = convSnap.data().participants || [];
  const otherId = participants.find((p) => p !== msg.senderId);
  if (!otherId) return;
  const otherSnap = await db.doc(`users/${otherId}`).get();
  if (!otherSnap.exists || !otherSnap.data().isBot) return; // only bot recipients

  const settingsSnap = await db.doc('botSettings/global').get();
  if (settingsSnap.exists && settingsSnap.data().enabled === false) return;
  const botSnap = await db.doc(`bots/${otherId}`).get();
  if (!botSnap.exists || botSnap.data().active === false) return;

  // Respect blocks both ways.
  const blockSnap = await db.doc(`blocks/${msg.senderId}_${otherId}`).get();
  if (blockSnap.exists) return;

  const bot = { id: otherId, ...botSnap.data() };
  const memSnap = await db.doc(`botMemories/${otherId}`).get();
  const memories = memSnap.exists ? (memSnap.data().items || []) : [];
  const { providers } = require('./botEngine');
  let reply;
  try {
    reply = process.env.GEMINI_API_KEY
      ? await providers.gemini.generate(bot, memories, { kind: 'message', text: msg.text })
      : await providers.template.generate(bot, memories, { kind: 'message', text: msg.text });
  } catch (err) {
    await log('error', otherId, `botOnMessage generation failed: ${err.message}`);
    reply = await providers.template.generate(bot, memories, { kind: 'message', text: msg.text });
  }
  await db.collection('messages').add({
    conversationId: msg.conversationId, senderId: otherId, text: reply, image: '',
    createdAt: Date.now(), status: 'delivered', readBy: [otherId]
  });
  // Update the bot's own memory with a note about this conversation.
  const note = {
    id: `mem_${Date.now().toString(36)}`, pinned: false, createdAt: Date.now(), updatedAt: Date.now(),
    text: `Chatted with a user about "${String(msg.text || '').slice(0, 80)}".`
  };
  await db.doc(`botMemories/${otherId}`).set({ botId: otherId, items: [...memories.slice(-99), note] }, { merge: true });
  await db.collection('botActivities').add({ botId: otherId, action: 'message', detail: 'Replied to a message.', createdAt: Date.now(), status: 'ok' });
});

// ------------------------------------------------------------ schedules
/** Autonomous bot runner: every 15 minutes (honours kill switch + limits). */
exports.botRunner = onSchedule('every 15 minutes', async () => {
  const result = await runBotCycle(db, log);
  console.log('botRunner result:', JSON.stringify(result));
});

/** Daily housekeeping: prune old runner task docs and stale rate limits. */
exports.dailyHousekeeping = onSchedule('every day 03:00', async () => {
  const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;
  const runners = await db.collection('botRunners').where('createdAt', '<', cutoff).limit(400).get();
  const batch = db.batch();
  runners.forEach((d) => batch.delete(d.ref));
  await batch.commit();
  console.log(`dailyHousekeeping pruned ${runners.size} runner docs.`);
});

// ------------------------------------------------------------ health
exports.health = onRequest(async (req, res) => {
  res.json({ ok: true, service: 'meetbook-functions', projectId: process.env.GCLOUD_PROJECT || 'meetbook-d8a44', time: new Date().toISOString() });
});

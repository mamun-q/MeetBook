// MeetBook application shell: routing, rendering, event delegation, theme,
// PWA install handling and realtime refresh.
import * as api from './api.js';
import { firebaseReady, firebaseConfig } from './firebase.js';
import { subscribe as storeSubscribe, mutate as demoMutate } from './store.js';
import { setLocale, t } from './i18n.js';
import { escapeHtml, uid as genId, timeAgo, storyBackgroundCss, normalisePoll } from './utils.js';
import { toast, openModal, closeModal, confirmModal, avatarHtml } from './components.js';
import * as V from './views.js';

// ------------------------------------------------------------- preferences
const PREF_KEY = 'meetbook_prefs_v1';
const prefs = (() => {
  try { return { theme: 'light', locale: 'en', ...JSON.parse(localStorage.getItem(PREF_KEY) || '{}') }; }
  catch { return { theme: 'light', locale: 'en' }; }
})();
function savePrefs() { try { localStorage.setItem(PREF_KEY, JSON.stringify(prefs)); } catch { /* ignore */ } }
function applyPrefs() {
  document.documentElement.dataset.theme = prefs.theme;
  setLocale(prefs.locale);
}
applyPrefs();

// ------------------------------------------------------------- app state
let feedPage = 1;
let deferredInstallPrompt = null;
const appEl = document.getElementById('app');

function parseRoute() {
  const hash = location.hash.replace(/^#\/?/, '');
  const [pathPart, queryPart] = hash.split('?');
  const seg = pathPart.split('/').filter(Boolean);
  const query = new URLSearchParams(queryPart || '');
  return { seg, query, raw: hash };
}

function me() { return api.me(); }

function unreadCount(d, user) {
  return d.notifications.filter((n) => n.userId === user.id && !n.read).length;
}
function unreadMsgCount(d, user) {
  return d.messages.filter((m) => m.senderId !== user.id && !(m.readBy || []).includes(user.id) && d.conversations.find((c) => c.id === m.conversationId)?.participants.includes(user.id)).length;
}

// ------------------------------------------------------------- rendering
function headerHtml(d, user) {
  const un = unreadCount(d, user);
  const um = unreadMsgCount(d, user);
  return `<header class="topbar">
    <a class="brand" href="#/">MeetBook</a>
    <form id="search-form" class="search-box" role="search">
      <input name="q" placeholder="${t('searchPlaceholder')}" autocomplete="off" />
      <button class="btn btn-primary btn-sm" type="submit">Search</button>
    </form>
    <a class="icon-btn mobile-search" href="#/search" title="Search" aria-label="Search">🔎</a>
    <nav class="topnav">
      <a href="#/" title="${t('home')}">🏠</a>
      <a href="#/friends" title="${t('friends')}">👥</a>
      <a href="#/events" title="${t('events')}">📅</a>
      <a href="#/groups" title="${t('groups')}">🏘️</a>
      <a href="#/pages" title="${t('pages')}">📄</a>
      <a href="#/messages" title="${t('messages')}">💬${um ? `<span class="nav-badge">${um}</span>` : ''}</a>
      <a href="#/notifications" title="${t('notifications')}">🔔${un ? `<span class="nav-badge">${un}</span>` : ''}</a>
      ${user.role === 'admin' ? '<a href="#/admin" title="Admin">🛡️</a><a href="#/bots" title="AI Bots">🤖</a>' : ''}
      <button class="icon-btn" data-act="toggle-theme" title="Theme">${prefs.theme === 'dark' ? '☀️' : '🌙'}</button>
      ${deferredInstallPrompt ? '<button class="btn btn-ghost btn-sm install-btn" data-act="install-app">⬇️ Install</button>' : ''}
      <a href="#/profile/${user.id}" class="row gap-sm topnav-avatar">${avatarHtml(user, 34)}</a>
      <button class="btn btn-ghost btn-sm logout-btn" data-act="logout">${t('logout')}</button>
    </nav>
  </header>`;
}

// Mobile-only bottom navigation (CSS hides it above 720px, where the topbar
// and left rail already provide navigation). Mirrors the topnav's icons,
// badges and destinations, with a text label under each icon.
function bottomNavHtml(d, user, route, seg) {
  const un = unreadCount(d, user);
  const um = unreadMsgCount(d, user);
  const item = (href, icon, label, active, badge = 0) => `<a class="bottom-nav-item ${active ? 'active' : ''}" href="${href}">${icon}${badge ? `<span class="nav-badge">${badge}</span>` : ''}<span class="bottom-nav-label">${label}</span></a>`;
  return `<nav class="bottom-nav" aria-label="Primary">
    ${item('#/', '🏠', t('home'), route === '')}
    ${item('#/friends', '👥', t('friends'), route === 'friends')}
    ${item('#/groups', '🏘️', t('groups'), route === 'groups' || route === 'group')}
    ${item('#/pages', '📄', t('pages'), route === 'pages' || route === 'page')}
    ${item('#/messages', '💬', t('messages'), route === 'messages', um)}
    ${item('#/notifications', '🔔', t('notifications'), route === 'notifications', un)}
    ${item(`#/profile/${user.id}`, avatarHtml(user, 24), t('profile'), route === 'profile' && seg[1] === user.id)}
  </nav>`;
}

export function render() {
  const d = api.data();
  const user = me();
  const { seg, query } = parseRoute();
  const route = seg[0] || '';

  if (!user) {
    const mode = route === 'register' ? 'register' : 'login';
    if (['help', 'terms', 'privacy', 'guidelines'].includes(route)) {
      appEl.innerHTML = `<div class="auth-wrap-col">${V.staticView(route)}<p class="center"><a href="#/login">← Back to login</a></p></div>`;
      return;
    }
    appEl.innerHTML = V.authView(mode);
    return;
  }

  const maintenance = d.config?.maintenanceMode && user.role !== 'admin';
  let body = '';
  switch (route) {
    case '': body = V.feedView(d, user, feedPage); break;
    case 'friends': body = V.friendsView(d, user); break;
    case 'events': body = V.eventsView(d, user); break;
    case 'event': body = V.eventView(d, user, seg[1] || ''); break;
    case 'groups': body = V.groupsView(d, user, query.get('q') || ''); break;
    case 'group': body = V.groupView(d, user, seg[1] || ''); break;
    case 'pages': body = V.pagesView(d, user, query.get('q') || ''); break;
    case 'page': body = V.pageView(d, user, seg[1] || ''); break;
    case 'messages': body = V.messagesView(d, user, seg[1] || ''); setTimeout(setupThread, 30); break;
    case 'notifications': body = V.notificationsView(d, user); break;
    case 'profile': body = V.profileView(d, user, seg[1] || user.id); break;
    case 'search': body = V.searchView(d, user, query.get('q') || ''); break;
    case 'saved': body = V.savedView(d, user); break;
    case 'settings': body = V.settingsView(d, user, prefs); break;
    case 'admin': body = user.role === 'admin' ? V.adminView(d, user, { firebase: firebaseReady, projectId: firebaseConfig.projectId }) : `<div class="page narrow">${'<div class="card empty-state"><p>Admins only.</p></div>'}</div>`; break;
    case 'bots': body = user.role === 'admin' ? V.botsView(d, user) : `<div class="page narrow"><div class="card empty-state"><p>Admins only.</p></div></div>`; break;
    case 'help': case 'terms': case 'privacy': case 'guidelines': body = V.staticView(route); break;
    case 'login': case 'register': location.hash = '#/'; return;
    default: body = V.feedView(d, user, feedPage);
  }

  appEl.innerHTML = `
    ${headerHtml(d, user)}
    ${maintenance ? '<div class="maintenance-banner">🛠️ MeetBook is briefly under maintenance. You can browse, but changes may be paused.</div>' : ''}
    ${!firebaseReady ? `<div class="demo-banner">🧪 ${t('demoMode')} — sign in with a demo account or create one. <button class="link-btn" data-act="dismiss-demo">Dismiss</button></div>` : ''}
    <div class="shell">${body}</div>
    <footer class="footer muted small">MeetBook · People + clearly-labelled AI bots · <a href="#/help">Help</a> · <a href="#/terms">Terms</a> · <a href="#/privacy">Privacy</a> · <a href="#/guidelines">Guidelines</a></footer>
    ${bottomNavHtml(d, user, route, seg)}`;

  maybeBrowserNotify(d, user);
}

function scrollThread() {
  const el = document.getElementById('thread-body');
  if (el) el.scrollTop = el.scrollHeight;
}

function setupThread() {
  scrollThread();
  // Voice messages need MediaRecorder + getUserMedia; hide the mic
  // button entirely where they are unavailable.
  const btn = document.getElementById('voice-btn');
  if (btn && !voiceSupported()) btn.style.display = 'none';
}

// ------------------------------------------------- foreground web notifications
// When the user enables "Browser notifications" (Settings → Notifications)
// and grants permission, NEW notifications that arrive through the existing
// realtime listeners while the app is open also pop a Web Notification.
// The seen-id set is seeded on first sight so history never replays; only
// notifications created after this session started can pop.
//
// FUTURE (FCM): background push (app closed) would plug in here — it
// needs Firebase Cloud Messaging plus a server-side sender (Cloud
// Functions on Blaze) calling the FCM API for the user's registration
// tokens. Out of scope on the Spark plan; foreground-only by design.
const seenNotificationIds = new Set();
let notifWatchStartedAt = 0;
function maybeBrowserNotify(d, user) {
  if (!('Notification' in window)) return;
  const mine = (d.notifications || []).filter((n) => n.userId === user.id);
  if (!notifWatchStartedAt) {
    notifWatchStartedAt = Date.now();
    for (const n of mine) seenNotificationIds.add(n.id);
    return;
  }
  if (!user.settings?.browserNotifications || Notification.permission !== 'granted') {
    for (const n of mine) seenNotificationIds.add(n.id);
    return;
  }
  for (const n of mine) {
    if (seenNotificationIds.has(n.id)) continue;
    seenNotificationIds.add(n.id);
    if (n.read || n.actorId === user.id || Number(n.createdAt) < notifWatchStartedAt) continue;
    try { new Notification('MeetBook', { body: n.text || 'You have a new notification.' }); } catch { /* permission raced */ }
  }
  if (seenNotificationIds.size > 1000) { // keep the set bounded
    const keep = mine.slice(0, 200).map((n) => n.id);
    seenNotificationIds.clear();
    for (const id of keep) seenNotificationIds.add(id);
  }
}

// ------------------------------------------------------------- voice messages
// MediaRecorder capture for Messenger voice notes. Audio is stored as a
// base64 data URL on the message (audio/webm in most browsers), capped at
// 60 seconds and ~700KB — Firestore documents cap at 1MB, so anything
// bigger is rejected with a toast instead of being sent.
const VOICE_MAX_MS = 60_000;
const VOICE_MAX_DATA_URL = 950_000; // ~700KB of audio once base64-decoded
let voiceRec = null; // { recorder, stream, chunks, startedAt, timer, convId, blob }

function voiceSupported() {
  return typeof window !== 'undefined' && 'MediaRecorder' in window && Boolean(navigator.mediaDevices?.getUserMedia);
}

async function startVoiceRecording(convId) {
  if (!voiceSupported()) { toast('Voice recording is not supported in this browser.', 'error'); return; }
  if (voiceRec) return;
  let stream;
  try { stream = await navigator.mediaDevices.getUserMedia({ audio: true }); }
  catch { toast('Microphone access was denied.', 'error'); return; }
  const recorder = new MediaRecorder(stream);
  const rec = { recorder, stream, chunks: [], startedAt: Date.now(), timer: null, convId, blob: null };
  recorder.ondataavailable = (ev) => { if (ev.data?.size) rec.chunks.push(ev.data); };
  recorder.onstop = () => {
    rec.blob = new Blob(rec.chunks, { type: recorder.mimeType || 'audio/webm' });
    stream.getTracks().forEach((tr) => tr.stop());
  };
  voiceRec = rec;
  recorder.start(250);
  document.getElementById('voice-ui')?.classList.remove('hidden');
  document.getElementById('message-form')?.classList.add('hidden');
  const timeEl = document.getElementById('voice-time');
  rec.timer = setInterval(() => {
    const elapsed = Date.now() - rec.startedAt;
    if (timeEl) timeEl.textContent = `${Math.floor(elapsed / 60000)}:${String(Math.floor(elapsed / 1000) % 60).padStart(2, '0')}`;
    if (elapsed >= VOICE_MAX_MS && recorder.state === 'recording') recorder.stop(); // hard cap: auto-stop at 60s
  }, 250);
}

function endVoiceRecording() {
  if (!voiceRec) return;
  clearInterval(voiceRec.timer);
  if (voiceRec.recorder.state === 'recording') voiceRec.recorder.stop();
  voiceRec.stream?.getTracks().forEach((tr) => tr.stop());
}

function resetVoiceUi() {
  endVoiceRecording();
  voiceRec = null;
  document.getElementById('voice-ui')?.classList.add('hidden');
  document.getElementById('message-form')?.classList.remove('hidden');
}

async function sendVoiceRecording() {
  const rec = voiceRec;
  if (!rec) return;
  endVoiceRecording();
  // Give onstop a tick to assemble the blob.
  await new Promise((r) => setTimeout(r, 60));
  const blob = rec.blob || new Blob(rec.chunks, { type: 'audio/webm' });
  const convId = rec.convId;
  resetVoiceUi();
  if (!blob.size) { toast('Nothing was recorded.', 'error'); return; }
  const dataUrl = await new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  }).catch(() => '');
  if (!dataUrl) { toast('Could not read the recording.', 'error'); return; }
  if (dataUrl.length > VOICE_MAX_DATA_URL) {
    toast('That voice message is too long to send (about 60 seconds max).', 'error');
    return;
  }
  const sent = await handle(api.sendMessage(convId, { text: '', image: '', audio: dataUrl }), 'Voice message sent.');
  if (sent) { render(); scrollThread(); }
}

// ------------------------------------------------------------- story viewer
// Full-screen overlay rendered into its own root (separate from #app and
// #modal-root, so realtime re-renders never disturb it). The queue is the
// flattened rail order from views.storyQueueFor: author groups in rail
// order, each author's stories oldest-first. Opening an author starts at
// their first unviewed story (or their first story when all are viewed).
let storySession = null; // { queue: [story], idx }

function storyRootEl() {
  let root = document.getElementById('story-root');
  if (!root) {
    root = document.createElement('div');
    root.id = 'story-root';
    document.body.appendChild(root);
  }
  return root;
}

function openStoryViewer(authorId) {
  const d = api.data();
  const user = me();
  if (!user) return;
  const queue = V.storyQueueFor(d, user);
  const mine = queue.map((s, i) => (s.authorId === authorId ? i : -1)).filter((i) => i >= 0);
  if (!mine.length) return;
  const start = mine.find((i) => queue[i].authorId !== user.id && !(queue[i].views || []).includes(user.id)) ?? mine[0];
  storySession = { queue, idx: start };
  renderStoryViewer();
}

function closeStoryViewer() {
  storySession = null;
  storyRootEl().innerHTML = '';
}

function storyNav(delta) {
  if (!storySession) return;
  const next = storySession.idx + delta;
  if (next < 0) return;
  if (next >= storySession.queue.length) { closeStoryViewer(); return; }
  storySession.idx = next;
  renderStoryViewer();
}

function renderStoryViewer() {
  if (!storySession) return;
  const d = api.data();
  const user = me();
  const s = storySession.queue[storySession.idx];
  if (!s || !user) { closeStoryViewer(); return; }
  const byId = V.usersById(d);
  const author = byId[s.authorId];
  const isMine = s.authorId === user.id;
  const authorStories = storySession.queue.filter((q) => q.authorId === s.authorId);
  const posInAuthor = authorStories.indexOf(s);
  const viewers = (s.views || []).map((id) => byId[id]).filter(Boolean);
  const stage = s.image
    ? `<img class="story-stage-img" src="${escapeHtml(s.image)}" alt="" />${s.text ? `<div class="story-caption">${escapeHtml(s.text)}</div>` : ''}`
    : `<div class="story-stage-text" style="background:${storyBackgroundCss(s.bg)}"><p>${escapeHtml(s.text)}</p></div>`;
  storyRootEl().innerHTML = `
  <div class="story-viewer" role="dialog" aria-modal="true" aria-label="${t('stories')}">
    <div class="story-top">
      <div class="story-segments">${authorStories.map((q) => `<span class="story-seg ${authorStories.indexOf(q) <= posInAuthor ? 'done' : ''}"></span>`).join('')}</div>
      <div class="story-author">
        ${avatarHtml(author, 34)}
        <span class="grow"><b>${escapeHtml(author?.name || '')}</b> <span class="story-time">${timeAgo(s.createdAt)}</span></span>
        ${isMine ? `<button class="story-icon-btn" data-act="story-delete" aria-label="${t('deleteStory')}">🗑️</button>` : ''}
        <button class="story-icon-btn" data-act="story-close" aria-label="Close">✕</button>
      </div>
    </div>
    <div class="story-stage">
      ${stage}
      <button class="story-zone left" data-act="story-prev" aria-label="Previous">‹</button>
      <button class="story-zone right" data-act="story-next" aria-label="Next">›</button>
    </div>
    ${isMine ? `<div class="story-footer">👁 ${viewers.length} ${t('viewers')}${viewers.length ? ` · ${t('seenBy')}: ${viewers.map((v) => escapeHtml(v.name)).join(', ')}` : ` · ${t('noViewersYet')}`}</div>` : ''}
  </div>`;
  // Viewing someone else's story records the view (rules allow exactly
  // this views-only append); fire-and-forget so playback never blocks.
  if (!isMine) api.markStoryViewed(s.id).catch(() => {});
}

document.addEventListener('keydown', (e) => {
  if (!storySession) return;
  if (e.key === 'Escape') closeStoryViewer();
  if (e.key === 'ArrowRight') storyNav(1);
  if (e.key === 'ArrowLeft') storyNav(-1);
});

function softRender() {
  if (voiceRec) return; // never re-render mid-recording — it would wipe the recording UI
  const tag = document.activeElement?.tagName;
  if (['INPUT', 'TEXTAREA', 'SELECT'].includes(tag)) return; // don't yank focus while typing
  render();
}

// Realtime: demo store subscription + Firestore mirror events.
storeSubscribe(() => softRender());
document.addEventListener('meetbook:data', () => softRender());
window.addEventListener('hashchange', () => { feedPage = 1; render(); window.scrollTo({ top: 0 }); });

// Infinite scroll for the feed (the Load more button is the fallback).
window.addEventListener('scroll', () => {
  const { seg } = parseRoute();
  if ((seg[0] || '') !== '' || !me()) return;
  if (window.innerHeight + window.scrollY > document.body.offsetHeight - 600) {
    const btn = document.querySelector('[data-act="feed-more"]');
    if (btn) { feedPage = Number(btn.dataset.page || feedPage + 1); render(); }
  }
}, { passive: true });

// ------------------------------------------------------------- helpers
async function handle(promise, successMsg) {
  try {
    const r = await promise;
    if (successMsg) toast(successMsg, 'success');
    render();
    return r;
  } catch (err) {
    toast(err.message || 'Something went wrong.', 'error');
    return null;
  }
}

function fileFrom(form, name) {
  const input = form.querySelector(`input[name="${name}"]`);
  return input?.files?.[0] || null;
}

// ------------------------------------------------------------- click actions
document.addEventListener('click', async (e) => {
  const nav = e.target.closest('[data-nav]');
  if (nav) { location.hash = nav.dataset.nav; return; }

  const closeBtn = e.target.closest('[data-close]');
  if (closeBtn) { closeModal(); return; }

  const menuBtn = e.target.closest('[data-menu]');
  if (menuBtn) {
    const menu = document.getElementById(`menu-${menuBtn.dataset.menu}`);
    document.querySelectorAll('.menu').forEach((m) => { if (m !== menu) m.classList.add('hidden'); });
    menu?.classList.toggle('hidden');
    return;
  }

  const actEl = e.target.closest('[data-act]');
  if (!actEl) return;
  const act = actEl.dataset.act;
  const d = api.data();
  const user = me();
  const postEl = actEl.closest('[data-post]');
  const postId = postEl?.dataset.post;

  switch (act) {
    case 'dismiss-demo': actEl.parentElement.remove(); break;
    case 'toggle-theme': prefs.theme = prefs.theme === 'dark' ? 'light' : 'dark'; savePrefs(); applyPrefs(); render(); break;
    case 'install-app': if (deferredInstallPrompt) { deferredInstallPrompt.prompt(); deferredInstallPrompt = null; } break;
    case 'logout': await handle(api.logout(), 'Logged out.'); location.hash = '#/login'; break;
    case 'google-login': await handle(api.loginWithGoogle(), 'Welcome to MeetBook!'); if (me()) location.hash = '#/'; break;
    case 'forgot': {
      const email = document.querySelector('#login-form input[name="email"]')?.value || user?.email || '';
      if (!email) { toast('Enter your email first, then tap Forgot password.', 'error'); break; }
      await handle(api.resetPassword(email), 'Password reset email sent (check your inbox).');
      break;
    }
    case 'like': await handle(api.toggleLike(postId)); break;
    case 'poll-vote': await handle(api.votePoll(postId, actEl.dataset.option)); break;
    case 'toggle-pin': { const pinned = await handle(api.togglePinPost(postId)); if (pinned !== null) toast(pinned ? 'Pinned as announcement.' : 'Announcement unpinned.', 'success'); break; }
    case 'dismiss-memories': V.uiState.memoriesDismissed = true; render(); break;
    case 'react': await handle(api.toggleReaction(postId, actEl.dataset.emoji)); break;
    case 'share': await handle(api.sharePost(postId), 'Post shared to your timeline.'); break;
    case 'save-post': document.getElementById(`menu-${postId}`)?.classList.add('hidden'); await handle(api.toggleSave(postId), 'Saved list updated.'); break;
    case 'focus-comment': postEl?.querySelector('.comment-form input')?.focus(); break;
    case 'edit-post': {
      const post = d.posts.find((p) => p.id === postId);
      const modal = openModal(`<h3>Edit post</h3><form id="edit-post-form" data-id="${postId}" class="stack"><textarea name="text" rows="4" maxlength="2000">${escapeHtml(post?.text || '')}</textarea><div class="row gap end"><button class="btn btn-ghost" type="button" data-close>Cancel</button><button class="btn btn-primary" type="submit">Save</button></div></form>`);
      modal.querySelector('[data-close]').onclick = closeModal;
      break;
    }
    case 'delete-post': if (await confirmModal('Delete post?', 'This post and its comments will be removed.')) await handle(api.deletePost(postId), 'Post deleted.'); break;
    case 'admin-delete-post': if (await confirmModal('Remove this post?', 'Admin moderation: the post will be deleted for everyone.')) await handle(api.deletePost(actEl.dataset.id), 'Post removed.'); break;
    case 'report-post': {
      const reason = prompt('Why are you reporting this post? (spam, abuse, misinformation…)');
      if (reason) await handle(api.reportContent('post', postId, reason), 'Thanks — our moderators will review it.');
      break;
    }
    case 'report-user': {
      const reason = prompt('Why are you reporting this user?');
      if (reason) await handle(api.reportContent('user', actEl.dataset.id, reason), 'Thanks — our moderators will review it.');
      break;
    }
    case 'delete-comment': {
      const commentId = actEl.dataset.comment;
      if (await confirmModal('Delete comment?', 'This comment/reply will be removed.')) await handle(api.deleteComment(postId, commentId), 'Comment deleted.');
      break;
    }
    case 'reply-toggle': {
      const form = postEl.querySelector(`[data-reply-form="${actEl.dataset.comment}"]`);
      form?.classList.toggle('hidden');
      form?.querySelector('input')?.focus();
      break;
    }
    case 'feed-more': feedPage = Number(actEl.dataset.page || 2); render(); break;
    case 'create-story': { const modal = openModal(V.storyFormHtml()); modal.querySelector('[data-close]').onclick = closeModal; break; }
    case 'view-story': openStoryViewer(actEl.dataset.author); break;
    case 'story-close': closeStoryViewer(); break;
    case 'story-prev': storyNav(-1); break;
    case 'story-next': storyNav(1); break;
    case 'story-delete': {
      const current = storySession?.queue[storySession.idx];
      if (current && await confirmModal('Delete this story?', 'It will be removed immediately for everyone.')) {
        await handle(api.deleteStory(current.id), 'Story deleted.');
        storySession.queue = storySession.queue.filter((q) => q.id !== current.id);
        if (!storySession.queue.length) closeStoryViewer();
        else { storySession.idx = Math.min(storySession.idx, storySession.queue.length - 1); renderStoryViewer(); }
      }
      break;
    }
    case 'send-request': await handle(api.sendFriendRequest(actEl.dataset.id), 'Friend request sent.'); break;
    case 'accept-request': await handle(api.respondFriendRequest(actEl.dataset.id, true), 'You are now friends!'); break;
    case 'reject-request': await handle(api.respondFriendRequest(actEl.dataset.id, false), 'Request removed.'); break;
    case 'remove-friend': if (await confirmModal('Remove connection?', 'This friendship/request will be removed.')) await handle(api.removeFriendship(actEl.dataset.id), 'Removed.'); break;
    case 'follow': await handle(api.toggleFollow(actEl.dataset.id)); break;
    case 'toggle-close-friend': { const nowClose = await handle(api.toggleCloseFriend(actEl.dataset.id)); if (nowClose !== null) toast(nowClose ? 'Added to your close friends.' : 'Removed from close friends.', 'success'); break; }
    case 'create-event': { const modal = openModal(V.eventFormHtml()); modal.querySelector('[data-close]').onclick = closeModal; break; }
    case 'delete-event': if (await confirmModal('Delete event?', 'The event and its RSVPs will be removed.')) { await handle(api.deleteEvent(actEl.dataset.id), 'Event deleted.'); location.hash = '#/events'; } break;
    case 'rsvp': await handle(api.toggleEventRsvp(actEl.dataset.id, actEl.dataset.kind)); break;
    case 'delete-review': if (await confirmModal('Delete your review?', 'Your rating and review text will be removed.')) await handle(api.deleteReview(actEl.dataset.id), 'Review deleted.'); break;
    case 'create-group': { const modal = openModal(V.groupFormHtml(null)); modal.querySelector('[data-close]').onclick = closeModal; break; }
    case 'edit-group': { const g = (d.groups || []).find((x) => x.id === actEl.dataset.id); const modal = openModal(V.groupFormHtml(g)); modal.querySelector('[data-close]').onclick = closeModal; break; }
    case 'delete-group': if (await confirmModal('Delete group?', 'The group and all of its posts will be removed. This cannot be undone.')) { await handle(api.deleteGroup(actEl.dataset.id), 'Group deleted.'); location.hash = '#/groups'; } break;
    case 'toggle-group-join': {
      const result = await handle(api.toggleGroupMembership(actEl.dataset.id));
      if (result === 'requested') toast('Join request sent — the group creator will review it.', 'success');
      else if (result === 'withdrawn') toast('Join request withdrawn.', 'success');
      else if (result === 'joined') toast('You joined the group.', 'success');
      else if (result === 'left') toast('You left the group.', 'success');
      break;
    }
    case 'approve-group-request': await handle(api.respondGroupRequest(actEl.dataset.id, true), 'Request approved — member added.'); break;
    case 'reject-group-request': await handle(api.respondGroupRequest(actEl.dataset.id, false), 'Request rejected.'); break;
    case 'remove-member': if (await confirmModal('Remove this member?', 'They will lose access to this group and its posts.')) await handle(api.removeGroupMember(actEl.dataset.group, actEl.dataset.id), 'Member removed.'); break;
    case 'create-page': { const modal = openModal(V.pageFormHtml(null)); modal.querySelector('[data-close]').onclick = closeModal; break; }
    case 'edit-page': { const p = (d.pages || []).find((x) => x.id === actEl.dataset.id); const modal = openModal(V.pageFormHtml(p)); modal.querySelector('[data-close]').onclick = closeModal; break; }
    case 'delete-page': if (await confirmModal('Delete page?', 'The page and all of its posts will be removed. This cannot be undone.')) { await handle(api.deletePage(actEl.dataset.id), 'Page deleted.'); location.hash = '#/pages'; } break;
    case 'follow-page': await handle(api.toggleFollowPage(actEl.dataset.id)); break;
    case 'block': {
      const target = d.users.find((u) => u.id === actEl.dataset.id);
      const willBlock = !(d.blocks || []).some((b) => b.by === user.id && b.target === target?.id);
      if (!willBlock || await confirmModal(`Block ${target?.name}?`, 'They will not be able to see your posts or message you.')) await handle(api.toggleBlock(target.id), willBlock ? 'User blocked.' : 'User unblocked.');
      break;
    }
    case 'message-user': {
      const conv = await handle(api.openConversation(actEl.dataset.id));
      if (conv) location.hash = `#/messages/${conv.id}`;
      break;
    }
    case 'open-conv': await handle(api.markConversationRead(actEl.dataset.id)); location.hash = `#/messages/${actEl.dataset.id}`; render(); break;
    case 'create-group-chat': { const modal = openModal(V.groupChatFormHtml(d, user)); modal.querySelector('[data-close]').onclick = closeModal; break; }
    case 'voice-toggle': { const convId = document.getElementById('message-form')?.dataset.conv; if (convId) await startVoiceRecording(convId); break; }
    case 'voice-cancel': resetVoiceUi(); break;
    case 'voice-send': await sendVoiceRecording(); break;
    case 'notif-read-all': await handle(api.markAllNotificationsRead(), 'All caught up.'); break;
    case 'notif-open': {
      await handle(api.markNotificationRead(actEl.dataset.id));
      if (actEl.dataset.conv) location.hash = `#/messages/${actEl.dataset.conv}`;
      else location.hash = '#/';
      break;
    }
    case 'edit-profile': {
      const modal = openModal(V.editProfileHtml(user));
      modal.querySelector('[data-close]').onclick = closeModal;
      break;
    }
    case 'change-password': await handle(api.resetPassword(user.email), 'Password reset email sent (live mode). In demo mode use your demo password.'); break;
    case 'delete-account': if (await confirmModal('Delete your account?', 'Your profile and posts will be removed. This cannot be undone.')) { await handle(api.deleteAccount(), 'Account deleted.'); location.hash = '#/register'; } break;
    case 'admin-role': await handle(api.adminSetRole(actEl.dataset.id, actEl.dataset.role), 'Role updated.'); break;
    case 'report-action': await handle(api.adminResolveReport(actEl.dataset.id, actEl.dataset.action), 'Report handled.'); break;
    case 'reset-demo': if (!firebaseReady && await confirmModal('Reset demo data?', 'Local demo data returns to its seeded state.')) { api.resetDemo(); toast('Demo data reset.', 'success'); render(); } else if (firebaseReady) toast('Demo reset is only available in demo mode.', 'error'); break;
    case 'bot-kill-switch': await handle(api.setGlobalBotEnabled(actEl.dataset.on === '1'), actEl.dataset.on === '1' ? 'Bots enabled.' : 'All bots stopped.'); break;
    case 'bot-run-cycle': {
      const r = api.runDemoBotCycle();
      toast(r.ran ? `Bot cycle ran: ${r.results.map((x) => `${x.bot} → ${x.action}`).join(', ')}` : `Bot cycle skipped: ${r.reason}`, r.ran ? 'success' : 'error');
      render();
      break;
    }
    case 'bot-new': { const modal = openModal(V.botFormHtml(null)); modal.querySelector('[data-close]').onclick = closeModal; break; }
    case 'bot-edit': { const bot = d.bots.find((b) => b.id === actEl.dataset.id); const modal = openModal(V.botFormHtml(bot)); modal.querySelector('[data-close]').onclick = closeModal; break; }
    case 'bot-toggle': { const bot = d.bots.find((b) => b.id === actEl.dataset.id); if (bot) await handle(api.saveBot({ ...bot, active: !bot.active }), bot.active ? 'Bot deactivated.' : 'Bot activated.'); break; }
    case 'bot-delete': if (await confirmModal('Delete this bot?', 'The bot account, its brain and its memories will be removed.')) await handle(api.deleteBot(actEl.dataset.id), 'Bot deleted.'); break;
    case 'bot-memory-delete': await handle(api.deleteBotMemory(actEl.dataset.bot, actEl.dataset.id), 'Memory removed.'); break;
    default: break;
  }
});

// ------------------------------------------------------------- form handling
document.addEventListener('submit', async (e) => {
  const form = e.target;
  e.preventDefault();
  const fd = new FormData(form);
  const user = me();

  if (form.id === 'search-form' || form.id === 'search-page-form') {
    const q = String(fd.get('q') || '').trim();
    location.hash = `#/search?q=${encodeURIComponent(q)}`;
    return;
  }
  if (form.id === 'login-form') {
    const r = await handle(api.login(String(fd.get('email')), String(fd.get('password'))), 'Welcome back!');
    if (r) location.hash = '#/';
    return;
  }
  if (form.id === 'register-form') {
    const r = await handle(api.register({ name: String(fd.get('name')), username: String(fd.get('username')), email: String(fd.get('email')), password: String(fd.get('password')) }), 'Account created — welcome to MeetBook!');
    if (r) location.hash = '#/';
    return;
  }
  if (form.id === 'composer-form') {
    const file = fileFrom(form, 'image');
    const image = file ? await api.uploadImage(file, `posts/${user.id}/${Date.now()}_${file.name}`).catch((err) => { toast(err.message, 'error'); return ''; }) : '';
    const poll = form.querySelector('[name="hasPoll"]')?.checked
      ? normalisePoll(fd.getAll('pollOption').map((v) => String(v)))
      : null;
    if (form.querySelector('[name="hasPoll"]')?.checked && !poll) toast('A poll needs at least two options — posting without the poll.', 'error');
    const r = await handle(api.createPost({
      text: String(fd.get('text') || ''), image, visibility: String(fd.get('visibility') || 'public'),
      poll, location: String(fd.get('location') || ''), feeling: String(fd.get('feeling') || '')
    }), 'Post published.');
    if (r) { feedPage = 1; render(); }
    return;
  }
  if (form.id === 'event-form') {
    const coverFile = fileFrom(form, 'cover');
    const cover = coverFile ? await api.uploadImage(coverFile, `events/${user.id}/${Date.now()}_${coverFile.name}`).catch((err) => { toast(err.message, 'error'); return ''; }) : '';
    const dateTime = new Date(String(fd.get('dateTime') || '')).getTime();
    const r = await handle(api.createEvent({
      title: String(fd.get('title') || ''), description: String(fd.get('description') || ''),
      dateTime, location: String(fd.get('location') || ''), cover,
      visibility: String(fd.get('visibility') || 'public')
    }), 'Event created.');
    if (r) { closeModal(); location.hash = `#/event/${r.id}`; }
    return;
  }
  if (form.id === 'review-form') {
    const r = await handle(api.saveReview(form.dataset.page, { rating: Number(fd.get('rating') || 0), text: String(fd.get('text') || '') }), 'Review saved.');
    if (r) render();
    return;
  }
  if (form.id === 'group-chat-form') {
    const memberIds = fd.getAll('member').map((v) => String(v));
    const r = await handle(api.createGroupConversation({ title: String(fd.get('title') || ''), memberIds }), 'Group chat created.');
    if (r) { closeModal(); location.hash = `#/messages/${r.id}`; }
    return;
  }
  if (form.id === 'groups-search-form') {
    location.hash = `#/groups?q=${encodeURIComponent(String(fd.get('q') || '').trim())}`;
    return;
  }
  if (form.id === 'pages-search-form') {
    location.hash = `#/pages?q=${encodeURIComponent(String(fd.get('q') || '').trim())}`;
    return;
  }
  if (form.id === 'group-composer-form') {
    const file = fileFrom(form, 'image');
    const image = file ? await api.uploadImage(file, `posts/${user.id}/${Date.now()}_${file.name}`).catch((err) => { toast(err.message, 'error'); return ''; }) : '';
    await handle(api.createPost({ text: String(fd.get('text') || ''), image, visibility: 'public', groupId: form.dataset.group }), 'Posted to the group.');
    return;
  }
  if (form.id === 'page-composer-form') {
    const file = fileFrom(form, 'image');
    const image = file ? await api.uploadImage(file, `posts/${user.id}/${Date.now()}_${file.name}`).catch((err) => { toast(err.message, 'error'); return ''; }) : '';
    await handle(api.createPagePost(form.dataset.page, { text: String(fd.get('text') || ''), image }), 'Posted as page.');
    return;
  }
  if (form.id === 'group-form') {
    const existing = (api.data().groups || []).find((g) => g.id === form.dataset.id);
    const fields = { name: String(fd.get('name')), description: String(fd.get('description') || ''), privacy: String(fd.get('privacy') || 'public') };
    const coverFile = fileFrom(form, 'cover');
    if (coverFile) fields.cover = await api.uploadImage(coverFile, `groups/${existing?.id || 'new'}/cover`).catch((err) => { toast(err.message, 'error'); return existing?.cover || ''; });
    if (existing) {
      const r = await handle(api.updateGroup(existing.id, fields), 'Group updated.');
      if (r) closeModal();
    } else {
      const r = await handle(api.createGroup({ ...fields, cover: fields.cover || '' }), 'Group created.');
      if (r) { closeModal(); location.hash = `#/group/${r.id}`; }
    }
    return;
  }
  if (form.id === 'page-form') {
    const existing = (api.data().pages || []).find((p) => p.id === form.dataset.id);
    const fields = { name: String(fd.get('name')), category: String(fd.get('category') || ''), about: String(fd.get('about') || '') };
    const avatarFile = fileFrom(form, 'avatar');
    const coverFile = fileFrom(form, 'cover');
    if (avatarFile) fields.avatar = await api.uploadImage(avatarFile, `pages/${existing?.id || 'new'}/avatar`).catch((err) => { toast(err.message, 'error'); return existing?.avatar || ''; });
    if (coverFile) fields.cover = await api.uploadImage(coverFile, `pages/${existing?.id || 'new'}/cover`).catch((err) => { toast(err.message, 'error'); return existing?.cover || ''; });
    if (existing) {
      const r = await handle(api.updatePage(existing.id, fields), 'Page updated.');
      if (r) closeModal();
    } else {
      const r = await handle(api.createPage({ ...fields, avatar: fields.avatar || '', cover: fields.cover || '' }), 'Page created.');
      if (r) { closeModal(); location.hash = `#/page/${r.id}`; }
    }
    return;
  }
  if (form.dataset.commentForm) {
    const text = String(fd.get('text') || '').trim();
    if (text) await handle(api.addComment(form.dataset.commentForm, text));
    return;
  }
  if (form.dataset.replyForm !== undefined && form.classList.contains('reply-form')) {
    const postEl = form.closest('[data-post]');
    const text = String(fd.get('text') || '').trim();
    if (text && postEl) await handle(api.addComment(postEl.dataset.post, text, form.dataset.replyForm));
    return;
  }
  if (form.id === 'message-form') {
    const convId = form.dataset.conv;
    const file = fileFrom(form, 'image');
    const image = file ? await api.uploadImage(file, `messages/${convId}/${Date.now()}_${file.name}`).catch((err) => { toast(err.message, 'error'); return ''; }) : '';
    const text = String(fd.get('text') || '');
    const sent = await handle(api.sendMessage(convId, { text, image }));
    if (sent) {
      render(); scrollThread();
      // Demo-mode bot replies: the bot answers from its OWN personality+memory.
      // 1-1 conversations only — bots never auto-reply inside group chats.
      if (!firebaseReady) {
        const conv = api.data().conversations.find((c) => c.id === convId);
        const otherId = conv && !conv.isGroup && conv.participants.length === 2
          ? conv.participants.find((p) => p !== user.id)
          : null;
        const other = api.data().users.find((u) => u.id === otherId);
        if (other?.isBot) {
          setTimeout(() => {
            const reply = api.demoBotReply(otherId, text);
            if (reply) {
              demoMutate((s) => {
                s.messages.push({ id: genId('m'), conversationId: convId, senderId: otherId, text: reply, image: '', createdAt: Date.now(), status: 'delivered', readBy: [otherId] });
              });
              render(); scrollThread();
            }
          }, 900);
        }
      }
    }
    return;
  }
  if (form.id === 'edit-post-form') {
    await handle(api.editPost(form.dataset.id, String(fd.get('text') || '')), 'Post updated.');
    closeModal();
    return;
  }
  if (form.id === 'edit-profile-form') {
    const patch = {
      name: String(fd.get('name')), username: String(fd.get('username')), bio: String(fd.get('bio')),
      nickname: String(fd.get('nickname') || '').trim(),
      work: String(fd.get('work') || '').trim(), education: String(fd.get('education') || '').trim(),
      currentCity: String(fd.get('currentCity') || '').trim(), hometown: String(fd.get('hometown') || '').trim(),
      relationship: String(fd.get('relationship') || ''), website: String(fd.get('website') || '').trim()
    };
    const avatarFile = fileFrom(form, 'avatar');
    const coverFile = fileFrom(form, 'cover');
    if (avatarFile) patch.avatar = await api.uploadImage(avatarFile, `avatars/${user.id}`).catch((err) => { toast(err.message, 'error'); return user.avatar; });
    if (coverFile) patch.cover = await api.uploadImage(coverFile, `covers/${user.id}`).catch((err) => { toast(err.message, 'error'); return user.cover; });
    const r = await handle(api.updateProfile(user.id, patch), 'Profile updated.');
    if (r !== null) closeModal();
    return;
  }
  if (form.id === 'notif-prefs-form') {
    const notifPrefs = {};
    for (const type of ['friend_request', 'like', 'comment', 'reply', 'message', 'mention', 'follow']) notifPrefs[type] = form.querySelector(`[name="${type}"]`)?.checked !== false;
    await handle(api.updateSettings(user.id, { notifPrefs }), 'Preferences saved.');
    // Browser notifications: enabling asks for permission right away;
    // the flag is stored either way so the toggle reflects the choice.
    const wantBrowser = form.querySelector('[name="browserNotifications"]')?.checked === true;
    if (wantBrowser && 'Notification' in window && Notification.permission === 'default') {
      await Notification.requestPermission().catch(() => 'denied');
    }
    if (wantBrowser && 'Notification' in window && Notification.permission !== 'granted') {
      toast('Browser notifications are blocked for this site — allow them in your browser settings.', 'error');
    }
    await handle(api.updateSettings(user.id, { browserNotifications: wantBrowser }));
    return;
  }
  if (form.id === 'privacy-prefs-form') {
    await handle(api.updateSettings(user.id, { defaultPostPrivacy: String(fd.get('defaultPostPrivacy') || 'public') }), 'Privacy saved.');
    return;
  }
  if (form.id === 'story-form') {
    const file = fileFrom(form, 'image');
    const image = file ? await api.uploadImage(file, `stories/${user.id}/${Date.now()}_${file.name}`).catch((err) => { toast(err.message, 'error'); return ''; }) : '';
    const r = await handle(api.createStory({ text: String(fd.get('text') || ''), image, bg: String(fd.get('bg') || 'sunset'), visibility: String(fd.get('visibility') || 'public') }), 'Story posted — it will disappear in 24 hours.');
    if (r) closeModal();
    return;
  }
  if (form.id === 'bot-form') {
    const split = (v) => String(v || '').split(',').map((s) => s.trim()).filter(Boolean);
    const existing = api.data().bots.find((b) => b.id === form.dataset.id);
    const bot = {
      ...(existing || {}),
      id: form.dataset.id || genId('bot'),
      name: String(fd.get('name')), username: String(fd.get('username')).toLowerCase(),
      bio: String(fd.get('bio') || ''),
      active: existing ? existing.active : true,
      personality: {
        traits: split(fd.get('traits')), tone: String(fd.get('tone') || 'friendly'),
        interests: split(fd.get('interests')), systemPrompt: String(fd.get('systemPrompt') || '')
      },
      limits: {
        postsPerDay: Number(fd.get('postsPerDay') || 3), commentsPerDay: Number(fd.get('commentsPerDay') || 10),
        likesPerDay: Number(fd.get('likesPerDay') || 20), messagesPerDay: Number(fd.get('messagesPerDay') || 5),
        minIntervalMs: existing?.limits?.minIntervalMs ?? 15 * 60 * 1000
      }
    };
    const r = await handle(api.saveBot(bot), existing ? 'Bot updated.' : 'Bot created.');
    if (r) closeModal();
    return;
  }
  if (form.dataset.botMemoryForm) {
    const text = String(fd.get('text') || '').trim();
    if (text) await handle(api.addBotMemory(form.dataset.botMemoryForm, text), 'Memory added.');
    return;
  }
});

// Composer image preview + poll toggle + locale select + maintenance toggle (change events)
document.addEventListener('change', async (e) => {
  if (e.target.name === 'hasPoll' && e.target.closest('#composer-form')) {
    document.getElementById('poll-fields')?.classList.toggle('hidden', !e.target.checked);
  }
  if (e.target.id === 'locale-select') {
    prefs.locale = e.target.value; savePrefs(); applyPrefs(); render();
  }
  if (e.target.id === 'maintenance-toggle') {
    await handle(api.adminSetMaintenance(e.target.checked), e.target.checked ? 'Maintenance mode on.' : 'Maintenance mode off.');
  }
  if (e.target.name === 'image' && e.target.closest('#composer-form')) {
    const file = e.target.files?.[0];
    const preview = document.getElementById('composer-preview');
    if (file && preview) {
      const url = URL.createObjectURL(file);
      preview.innerHTML = `<img class="post-image" src="${url}" alt="Selected photo preview" />`;
    }
  }
});

// Mark a conversation read when its thread is opened.
document.addEventListener('meetbook:route', () => {});

// Conversation-list search: pure DOM filter over the rendered conv items
// (matched on the other person's name, stored lowercase in data-search),
// so typing never triggers a re-render that would lose input focus.
document.addEventListener('input', (e) => {
  if (e.target.id !== 'conv-search') return;
  const q = e.target.value.trim().toLowerCase();
  document.querySelectorAll('.conv-item[data-search]').forEach((el) => {
    el.style.display = !q || (el.dataset.search || '').includes(q) ? '' : 'none';
  });
});

// ------------------------------------------------------------- PWA
window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); deferredInstallPrompt = e; softRender(); });
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js').catch((err) => console.warn('SW registration failed:', err));
  });
}

// Presence heartbeat (demo + live profile flag).
setInterval(() => { const u = me(); if (u) api.setOnline(u.id, true); }, 60_000);

// ------------------------------------------------------------- boot
api.onAuthReady(() => render());
render();

// MeetBook application shell: routing, rendering, event delegation, theme,
// PWA install handling and realtime refresh.
import * as api from './api.js';
import { firebaseReady, firebaseConfig } from './firebase.js';
import { subscribe as storeSubscribe, mutate as demoMutate } from './store.js';
import { setLocale, t } from './i18n.js';
import { escapeHtml, uid as genId } from './utils.js';
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
    <nav class="topnav">
      <a href="#/" title="${t('home')}">🏠</a>
      <a href="#/friends" title="${t('friends')}">👥</a>
      <a href="#/messages" title="${t('messages')}">💬${um ? `<span class="nav-badge">${um}</span>` : ''}</a>
      <a href="#/notifications" title="${t('notifications')}">🔔${un ? `<span class="nav-badge">${un}</span>` : ''}</a>
      ${user.role === 'admin' ? '<a href="#/admin" title="Admin">🛡️</a><a href="#/bots" title="AI Bots">🤖</a>' : ''}
      <button class="icon-btn" data-act="toggle-theme" title="Theme">${prefs.theme === 'dark' ? '☀️' : '🌙'}</button>
      ${deferredInstallPrompt ? '<button class="btn btn-ghost btn-sm" data-act="install-app">⬇️ Install</button>' : ''}
      <a href="#/profile/${user.id}" class="row gap-sm">${avatarHtml(user, 34)}</a>
      <button class="btn btn-ghost btn-sm" data-act="logout">${t('logout')}</button>
    </nav>
  </header>`;
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
    case 'messages': body = V.messagesView(d, user, seg[1] || ''); setTimeout(scrollThread, 30); break;
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
    <footer class="footer muted small">MeetBook · People + clearly-labelled AI bots · <a href="#/help">Help</a> · <a href="#/terms">Terms</a> · <a href="#/privacy">Privacy</a> · <a href="#/guidelines">Guidelines</a></footer>`;
}

function scrollThread() {
  const el = document.getElementById('thread-body');
  if (el) el.scrollTop = el.scrollHeight;
}

function softRender() {
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
    case 'send-request': await handle(api.sendFriendRequest(actEl.dataset.id), 'Friend request sent.'); break;
    case 'accept-request': await handle(api.respondFriendRequest(actEl.dataset.id, true), 'You are now friends!'); break;
    case 'reject-request': await handle(api.respondFriendRequest(actEl.dataset.id, false), 'Request removed.'); break;
    case 'remove-friend': if (await confirmModal('Remove connection?', 'This friendship/request will be removed.')) await handle(api.removeFriendship(actEl.dataset.id), 'Removed.'); break;
    case 'follow': await handle(api.toggleFollow(actEl.dataset.id)); break;
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

  if (form.id === 'search-form') {
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
    const r = await handle(api.createPost({ text: String(fd.get('text') || ''), image, visibility: String(fd.get('visibility') || 'public') }), 'Post published.');
    if (r) { feedPage = 1; render(); }
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
      if (!firebaseReady) {
        const conv = api.data().conversations.find((c) => c.id === convId);
        const otherId = conv?.participants.find((p) => p !== user.id);
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
    const patch = { name: String(fd.get('name')), username: String(fd.get('username')), bio: String(fd.get('bio')) };
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

// Composer image preview + locale select + maintenance toggle (change events)
document.addEventListener('change', async (e) => {
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

// Shared UI components: avatars, toasts, modals, post cards.
import { escapeHtml, initials, avatarColor, timeAgo } from './utils.js';
import { t } from './i18n.js';

export function toast(message, type = 'info') {
  const root = document.getElementById('toast-root');
  if (!root) return;
  const el = document.createElement('div');
  el.className = `toast toast-${type}`;
  el.textContent = message;
  root.appendChild(el);
  setTimeout(() => el.classList.add('show'), 10);
  setTimeout(() => { el.classList.remove('show'); setTimeout(() => el.remove(), 300); }, 3600);
}

export function openModal(html) {
  const root = document.getElementById('modal-root');
  root.innerHTML = `<div class="modal-backdrop" data-close-modal><div class="modal" role="dialog" aria-modal="true">${html}</div></div>`;
  root.querySelector('[data-close-modal]').addEventListener('click', (e) => {
    if (e.target.hasAttribute('data-close-modal')) closeModal();
  });
  return root.querySelector('.modal');
}

export function closeModal() {
  document.getElementById('modal-root').innerHTML = '';
}

export function confirmModal(title, body) {
  return new Promise((resolve) => {
    const modal = openModal(`
      <h3>${escapeHtml(title)}</h3>
      <p class="muted">${escapeHtml(body)}</p>
      <div class="row gap end">
        <button class="btn btn-ghost" data-no>${t('cancel')}</button>
        <button class="btn btn-danger" data-yes>Confirm</button>
      </div>`);
    modal.querySelector('[data-no]').onclick = () => { closeModal(); resolve(false); };
    modal.querySelector('[data-yes]').onclick = () => { closeModal(); resolve(true); };
  });
}

export function avatarHtml(user, size = 40) {
  if (!user) return '';
  if (user.avatar) return `<img class="avatar" style="width:${size}px;height:${size}px" src="${escapeHtml(user.avatar)}" alt="${escapeHtml(user.name)}" loading="lazy" />`;
  return `<span class="avatar avatar-fallback" style="width:${size}px;height:${size}px;background:${avatarColor(user.username || user.name)}" aria-hidden="true">${escapeHtml(initials(user.name))}</span>`;
}

export function userNameHtml(user) {
  if (!user) return '<span class="muted">Unknown user</span>';
  const botBadge = user.isBot ? `<span class="badge badge-bot" title="This is an AI bot account">${t('aiBot')}</span>` : '';
  const adminBadge = user.role === 'admin' ? '<span class="badge badge-admin">Admin</span>' : '';
  return `<span class="user-name">${escapeHtml(user.name)} ${botBadge}${adminBadge}</span>`;
}

export function postCardHtml(post, ctx) {
  const { usersById, me, friendIds } = ctx;
  const author = usersById[post.authorId];
  const liked = post.likes?.includes(me?.id);
  const saved = post.savedBy?.includes(me?.id);
  const myReaction = post.reactions?.[me?.id] || '';
  const reactionCounts = {};
  for (const e of Object.values(post.reactions || {})) reactionCounts[e] = (reactionCounts[e] || 0) + 1;
  const reactionLine = Object.entries(reactionCounts).map(([e, n]) => `${e} ${n}`).join(' · ');
  const comments = (post.comments || []).map((c) => commentHtml(c, post, ctx)).join('');
  const sharedNote = post.sharedFrom ? `<div class="shared-note">🔁 Shared from ${escapeHtml(usersById[post.sharedFrom]?.name || 'a post')}</div>` : '';
  const visIcon = post.visibility === 'friends' ? '👥' : post.visibility === 'only-me' ? '🔒' : '🌍';
  return `
  <article class="card post-card" data-post="${post.id}">
    ${sharedNote}
    <header class="post-head">
      <a href="#/profile/${post.authorId}" class="row gap-sm">${avatarHtml(author, 44)}<span>
        ${userNameHtml(author)}<br/>
        <span class="muted small">@${escapeHtml(author?.username || '')} · ${timeAgo(post.createdAt)} · ${visIcon}${post.editedAt ? ' · edited' : ''}</span>
      </span></a>
      <div class="post-menu-wrap">
        <button class="icon-btn" data-menu="${post.id}" aria-label="Post options">•••</button>
        <div class="menu hidden" id="menu-${post.id}">
          ${post.authorId === me?.id ? `<button data-act="edit-post">✏️ ${t('edit')}</button><button data-act="delete-post">🗑️ ${t('delete')}</button>` : ''}
          <button data-act="save-post">${saved ? '🔖 ' + t('saved') : '🔖 ' + t('save')}</button>
          ${post.authorId !== me?.id ? `<button data-act="report-post">🚩 ${t('report')}</button>` : ''}
        </div>
      </div>
    </header>
    <p class="post-text">${linkify(post.text)}</p>
    ${post.image ? `<img class="post-image" src="${escapeHtml(post.image)}" alt="Post photo" loading="lazy" />` : ''}
    <div class="post-stats muted small">
      <span>${post.likes?.length || 0} likes</span>
      ${reactionLine ? `<span>${escapeHtml(reactionLine)}</span>` : ''}
      <span>${(post.comments || []).length} comments</span>
      <span>${post.shares || 0} shares</span>
    </div>
    <div class="post-actions">
      <button class="action-btn ${liked ? 'active' : ''}" data-act="like">${liked ? '❤️' : '🤍'} ${t('like')}</button>
      <button class="action-btn" data-act="focus-comment">💬 ${t('comment')}</button>
      <button class="action-btn" data-act="share">🔁 ${t('share')}</button>
      <span class="reaction-bar">
        ${['❤️', '😆', '😮', '😢', '👏'].map((e) => `<button class="reaction-btn ${myReaction === e ? 'active' : ''}" data-act="react" data-emoji="${e}" aria-label="React ${e}">${e}</button>`).join('')}
      </span>
    </div>
    <div class="comments">${comments || '<p class="muted small">No comments yet.</p>'}</div>
    <form class="comment-form" data-comment-form="${post.id}">
      ${avatarHtml(me, 32)}
      <input name="text" placeholder="Write a comment…" autocomplete="off" maxlength="500" />
      <button class="btn btn-primary btn-sm" type="submit">${t('send')}</button>
    </form>
  </article>`;
}

function commentHtml(c, post, ctx) {
  const { usersById, me } = ctx;
  const author = usersById[c.authorId];
  const replies = (c.replies || []).map((r) => {
    const ra = usersById[r.authorId];
    return `<div class="comment reply">
      ${avatarHtml(ra, 28)}
      <div class="comment-body"><b>${escapeHtml(ra?.name || '')}</b> ${ra?.isBot ? `<span class="badge badge-bot">${t('aiBot')}</span>` : ''} ${linkify(r.text)}
      <div class="muted small">${timeAgo(r.createdAt)}${r.authorId === me?.id || post.authorId === me?.id ? ` · <button class="link-btn" data-act="delete-comment" data-comment="${r.id}">delete</button>` : ''}</div></div>
    </div>`;
  }).join('');
  return `<div class="comment">
    ${avatarHtml(author, 32)}
    <div class="comment-body">
      <b>${escapeHtml(author?.name || '')}</b> ${author?.isBot ? `<span class="badge badge-bot">${t('aiBot')}</span>` : ''} ${linkify(c.text)}
      <div class="muted small">${timeAgo(c.createdAt)} · <button class="link-btn" data-act="reply-toggle" data-comment="${c.id}">Reply</button>${c.authorId === me?.id || post.authorId === me?.id ? ` · <button class="link-btn" data-act="delete-comment" data-comment="${c.id}">delete</button>` : ''}</div>
      <form class="reply-form hidden" data-reply-form="${c.id}">
        <input name="text" placeholder="Write a reply…" autocomplete="off" maxlength="500" />
        <button class="btn btn-primary btn-sm" type="submit">${t('send')}</button>
      </form>
      ${replies}
    </div>
  </div>`;
}

export function linkify(text) {
  return escapeHtml(text || '').replace(/@([a-zA-Z0-9_.]{3,24})/g, '<span class="mention">@$1</span>');
}

export function emptyState(icon, text) {
  return `<div class="card empty-state"><div class="empty-icon">${icon}</div><p class="muted">${escapeHtml(text)}</p></div>`;
}

export function loadingHtml(text = 'Loading…') {
  return `<div class="card empty-state"><div class="spinner" aria-hidden="true"></div><p class="muted">${escapeHtml(text)}</p></div>`;
}

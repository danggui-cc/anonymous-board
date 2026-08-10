'use strict';

const AVATARS = ['🐱','🐶','🦊','🐼','🐧','🦉','🐢','🐙','🦁','🐯','🐸','🐵','🐰','🐻'];
const COLORS = ['#E3EFE8','#E6F6FF','#FFF1E6','#E9FBF0','#FDEAF3','#F3EEFF','#FFF7E0'];
const TOKEN_KEY = 'yyx_tokens';
const LOCAL_KEY = 'yyx_local';

let MODE = 'backend';
let QID = '';

const $ = (s) => document.querySelector(s);
const qView = $('#questionView');
const qCat = $('#qCat');
const qTitle = $('#qTitle');
const qDate = $('#qDate');
const qContent = $('#qContent');
const qAuthor = $('#qAuthor');
const qDel = $('#qDel');
const replyInput = $('#replyInput');
const replyBtn = $('#replyBtn');
const replyMsg = $('#replyMsg');
const replyCount = $('#replyCount');
const repliesNum = $('#repliesNum');
const replyList = $('#replyList');
const replyEmpty = $('#replyEmpty');
const modeBadge = $('#modeBadge');
const toast = $('#toast');
const adminBtn = $('#adminBtn');
const adminPanel = $('#adminPanel');
const adminKeyInput = $('#adminKeyInput');
const adminUnlockBtn = $('#adminUnlock');
const adminExit = $('#adminExit');
const adminBadge = $('#adminBadge');
const replyQuote = $('#replyQuote');
const replyQuoteCancel = $('#replyQuoteCancel');
let ADMIN = false;
let quoteTarget = null;
let currentReplies = [];

function getTokens() { try { return JSON.parse(localStorage.getItem(TOKEN_KEY)) || {}; } catch (e) { return {}; } }
function setToken(id, t) { const x = getTokens(); x[id] = t; localStorage.setItem(TOKEN_KEY, JSON.stringify(x)); }
function getLocal() { try { return JSON.parse(localStorage.getItem(LOCAL_KEY)) || []; } catch (e) { return []; } }
function setLocal(a) { localStorage.setItem(LOCAL_KEY, JSON.stringify(a)); }
function makeId() { return (crypto.randomUUID ? crypto.randomUUID() : 'id-' + Date.now() + '-' + Math.random().toString(36).slice(2)); }
function makeToken() { const a = crypto.getRandomValues(new Uint8Array(18)); return btoa(String.fromCharCode(...a)).replace(/[+/=]/g, ''); }
function showToast(m) { toast.textContent = m; toast.classList.remove('hidden'); clearTimeout(showToast._t); showToast._t = setTimeout(() => toast.classList.add('hidden'), 2600); }
function escapeHtml(s) { return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
function fmtDate(ts) { const d = new Date(ts); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} · ${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`; }
function hashIdx(str, mod) { let h = 0; for (let i = 0; i < str.length; i++) h = (h * 31 + str.charCodeAt(i)) >>> 0; return h % mod; }
function escapeAttr(s) { return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
function copyText(t) {
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(t).then(() => showToast('已复制链接')).catch(() => fallbackCopy(t));
  } else fallbackCopy(t);
}
function fallbackCopy(t) {
  const ta = document.createElement('textarea'); ta.value = t; document.body.appendChild(ta); ta.select();
  try { document.execCommand('copy'); showToast('已复制链接'); } catch (e) { showToast('复制失败，请手动复制'); }
  document.body.removeChild(ta);
}

// 所有权（用于首页消息通知聚合）
const OWNED_KEY = 'yyx_owned';
function getOwned() { try { return JSON.parse(localStorage.getItem(OWNED_KEY)) || {}; } catch (e) { return {}; } }
function setOwned(id, info) { const x = getOwned(); x[id] = info; localStorage.setItem(OWNED_KEY, JSON.stringify(x)); }

// ---------- 数据访问 ----------
async function apiGetQuestion(id) {
  if (MODE === 'backend') {
    const res = await fetch('/api/questions/' + id);
    if (!res.ok) throw new Error('问题不存在');
    return res.json();
  }
  const q = getLocal().find((x) => x.id === id);
  if (!q) throw new Error('问题不存在');
  return { question: { id: q.id, title: q.title, content: q.content, category: q.category, createdAt: q.createdAt }, replies: (q.replies || []).slice() };
}
async function apiCreateReply(id, content, quoteId) {
  const me = YuyanIdentity.getOrCreateVisitor(id); // 同一问题内本人身份一致
  if (MODE === 'backend') {
    const body = { content, author: me };
    if (quoteId) body.quoteId = quoteId;
    const res = await fetch('/api/questions/' + id + '/replies', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const d = await res.json(); if (!res.ok) throw new Error(d.error || '留言失败'); return d;
  }
  const arr = getLocal(); const q = arr.find((x) => x.id === id);
  if (!q) throw new Error('问题不存在');
  const rid = makeId(); const token = makeToken();
  const reply = { id: rid, content, createdAt: Date.now(), deleteToken: token, author: me };
  if (quoteId) {
    reply.quoteId = quoteId;
    const byId = {}; currentReplies.forEach((r) => { byId[r.id] = r; });
    const quoted = byId[quoteId];
    if (quoted) reply.rootId = quoted.rootId || quoted.id; // 两级嵌套：挂到所属一级留言下
  }
  q.replies = q.replies || []; q.replies.push(reply);
  setLocal(arr); return { id: rid, deleteToken: token };
}
async function apiDeleteQuestion(id, token) {
  if (MODE === 'backend') {
    const res = await fetch('/api/questions/' + id, { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token }) });
    const d = await res.json(); if (!res.ok) throw new Error(d.error || '删除失败'); return true;
  }
  setLocal(getLocal().filter((x) => x.id !== id)); return true;
}
async function apiDeleteReply(rid, token) {
  if (MODE === 'backend') {
    const res = await fetch('/api/replies/' + rid, { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token }) });
    const d = await res.json(); if (!res.ok) throw new Error(d.error || '删除失败'); return true;
  }
  const arr = getLocal();
  arr.forEach((q) => { if (q.replies) q.replies = q.replies.filter((r) => r.id !== rid); });
  setLocal(arr); return true;
}

// ---------- 渲染 ----------
function renderQuestion(q) {
  qCat.textContent = '#' + q.category;
  qTitle.textContent = q.title || '（无标题）';
  const a = YuyanIdentity.authorOf(q);
  qAuthor.innerHTML = '<span class="reply-avatar small" style="background:' + escapeAttr(a.color || '#E3EFE8') + '">' + (a.avatar || '🙂') + '</span>' +
    '<span class="q-author-name">' + escapeHtml(a.nickname || '匿名用户') + '</span>' +
    '<span class="q-author-tag">提问</span>';
  qDate.textContent = fmtDate(q.createdAt);
  qContent.textContent = q.content;
  const tokens = getTokens();
  const owned = !!tokens[q.id];
  if (owned) setOwned(q.id, { type: 'question' });
  if (ADMIN || owned) {
    qDel.classList.remove('hidden');
    qDel.textContent = (ADMIN && !owned) ? '🛡 删除(管理)' : '🗑 删除我的问题';
    qDel.onclick = ADMIN ? () => adminDeleteQuestion() : () => deleteQuestion();
  } else {
    qDel.classList.add('hidden');
    qDel.onclick = null;
  }
}
function authorHtml(item) {
  const a = YuyanIdentity.authorOf(item);
  return { name: escapeHtml(a.nickname || '匿名用户'), avatar: a.avatar || '🙂', color: a.color || '#E3EFE8' };
}

// 引用预览（单级）：展示"本条所引用的内容"，层级仅保留两级（一级留言 + 其下二级回复）
function quotePreviewHtml(quoteId, byId) {
  const q = quoteId && byId[quoteId];
  if (!q) return '';
  const a = authorHtml(q);
  return '<div class="reply-quote"><span class="rq-author">@' + a.name + '</span>：“' + escapeHtml((q.content || '').slice(0, 110)) + '”</div>';
}

const COLLAPSE_THRESHOLD = 3;

// 构建一条留言节点；depth>0 表示二级回复；kids 为挂载在一级留言下的二级回复
function buildNode(r, byId, tokens, depth, kids) {
  const a = authorHtml(r);
  const owned = !!tokens[r.id];
  const delBtn = owned
    ? '<button class="reply-del" data-id="' + r.id + '">删除</button>'
    : (ADMIN ? '<button class="reply-del admin" data-id="' + r.id + '">🛡</button>' : '');
  const quoteBtn = '<button class="reply-quote-btn" data-id="' + r.id + '" title="引用这条留言">引用</button>';
  const el = document.createElement('div');
  el.className = 'reply-item' + (depth > 0 ? ' nested' : '');
  el.dataset.rid = r.id;
  el.innerHTML =
    '<div class="reply-avatar" style="background:' + a.color + '">' + a.avatar + '</div>' +
    '<div class="reply-body">' +
      '<div class="reply-meta">' +
        '<span class="reply-name">' + a.name + '</span>' +
        '<span class="reply-time">' + fmtDate(r.createdAt) + '</span>' +
        quoteBtn + delBtn +
      '</div>' +
      quotePreviewHtml(r.quoteId, byId) +
      '<p class="reply-text">' + escapeHtml(r.content) + '</p>' +
    '</div>';
  if (kids && kids.length) {
    const childWrap = document.createElement('div');
    childWrap.className = 'reply-children';
    renderKids(childWrap, kids, byId, tokens);
    el.querySelector('.reply-body').appendChild(childWrap);
  }
  return el;
}

// 渲染一级留言下的二级回复；同一条一级留言下 ≥3 条二级回复则默认折叠（保留前 2 条 + 展开按钮）
function renderKids(childWrap, kids, byId, tokens) {
  childWrap.innerHTML = '';
  const expanded = childWrap.dataset.expanded === '1';
  const show = expanded ? kids : kids.slice(0, 2);
  show.forEach((k) => childWrap.appendChild(buildNode(k, byId, tokens, 1, null)));
  if (kids.length >= COLLAPSE_THRESHOLD) {
    const toggle = document.createElement('button');
    toggle.className = 'reply-expand';
    toggle.textContent = expanded ? '收起 ▴' : '展开剩余 ' + (kids.length - 2) + ' 条回复 ▾';
    toggle.addEventListener('click', () => {
      childWrap.dataset.expanded = expanded ? '0' : '1';
      renderKids(childWrap, kids, byId, tokens);
    });
    childWrap.appendChild(toggle);
  }
}

// 两级嵌套渲染：一级留言（针对问题的新留言）+ 其下二级回复（对留言的回应）
function renderReplies(replies) {
  currentReplies = replies;
  repliesNum.textContent = replies.length;
  replyCount.textContent = replies.length + ' 条回复';
  replyEmpty.style.display = replies.length ? 'none' : 'block';
  const tokens = getTokens();
  const byId = {};
  replies.forEach((r) => { byId[r.id] = r; });
  const kidsMap = {};           // 一级留言 id -> 其二级回复数组
  const roots = [];
  replies.forEach((r) => {
    if (r.rootId && byId[r.rootId]) (kidsMap[r.rootId] = kidsMap[r.rootId] || []).push(r);
    else roots.push(r);
  });
  roots.sort((a, b) => a.createdAt - b.createdAt);
  Object.keys(kidsMap).forEach((k) => kidsMap[k].sort((a, b) => a.createdAt - b.createdAt));
  replyList.innerHTML = '';
  roots.forEach((r) => replyList.appendChild(buildNode(r, byId, tokens, 0, kidsMap[r.id] || [])));
  if (location.hash) {
    const h = decodeURIComponent(location.hash.slice(1));
    const target = replyList.querySelector('[data-rid="' + (window.CSS && CSS.escape ? CSS.escape(h) : h) + '"]');
    if (target) setTimeout(() => target.scrollIntoView({ behavior: 'smooth', block: 'center' }), 50);
  }
}
replyList.addEventListener('click', (e) => {
  const qbtn = e.target.closest('.reply-quote-btn');
  if (qbtn) { startQuote(qbtn.dataset.id); return; }
  const btn = e.target.closest('.reply-del');
  if (!btn) return;
  const rid = btn.dataset.id;
  if (ADMIN) adminDeleteReply(rid);
  else deleteReply(rid);
});

// ---------- 引用回复 ----------
function startQuote(id) {
  const r = currentReplies.find((x) => x.id === id);
  if (!r) return;
  quoteTarget = { id, snippet: r.content };
  replyQuote.querySelector('.rq-text').textContent = '引用：' + r.content.slice(0, 120);
  replyQuote.classList.remove('hidden');
  replyInput.focus();
}
function cancelQuote() { quoteTarget = null; replyQuote.classList.add('hidden'); }
replyQuoteCancel.addEventListener('click', cancelQuote);

// ---------- 操作 ----------
async function deleteQuestion() {
  if (!confirm('确定删除这个问题吗？其下所有回复也会一并删除，不可恢复。')) return;
  const token = getTokens()[QID] || '';
  try { await apiDeleteQuestion(QID, token); showToast('已删除'); setTimeout(() => location.href = 'index.html', 800); }
  catch (e) { showToast(e.message || '删除失败'); }
}
async function submitReply() {
  const content = replyInput.value.trim();
  if (!content) { replyMsg.textContent = '留言内容不能为空'; replyMsg.className = 'composer-msg err'; return; }
  replyBtn.disabled = true; replyMsg.textContent = '';
  const qid = quoteTarget ? quoteTarget.id : null;
  try {
    const d = await apiCreateReply(QID, content, qid);
    setToken(d.id, d.deleteToken);
    setOwned(d.id, { type: 'reply', questionId: QID });
    replyInput.value = '';
    cancelQuote();
    await reload();
    showToast('留言成功');
  } catch (e) { replyMsg.textContent = e.message || '留言失败'; replyMsg.className = 'composer-msg err'; }
  finally { replyBtn.disabled = false; }
}
async function deleteReply(rid) {
  if (!confirm('确定删除这条回复吗？')) return;
  const token = getTokens()[rid] || '';
  try { await apiDeleteReply(rid, token); showToast('已删除'); await reload(); }
  catch (e) { showToast(e.message || '删除失败'); }
}
async function reload() {
  try {
    const data = await apiGetQuestion(QID);
    renderQuestion(data.question);
    renderReplies(data.replies || []);
  } catch (e) { showToast(e.message); }
}

// ---------- 管理员 ----------
function loadAdmin() { ADMIN = !!localStorage.getItem('yyx_admin'); }
function enterAdminMode() {
  ADMIN = true;
  adminBadge.classList.remove('hidden');
  adminPanel.classList.add('hidden');
  adminBtn.classList.add('hidden');
  adminExit.classList.remove('hidden');
  adminKeyInput.value = '';
  reload();
}
function exitAdminMode() {
  ADMIN = false;
  localStorage.removeItem('yyx_admin');
  adminBadge.classList.add('hidden');
  adminBtn.classList.remove('hidden');
  adminExit.classList.add('hidden');
  reload();
}
async function adminUnlock() {
  const key = adminKeyInput.value.trim();
  if (!key) { showToast('请输入口令'); return; }
  if (MODE === 'backend') {
    try {
      const res = await fetch('/api/admin/verify', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ key }) });
      if (!res.ok) { showToast('口令错误'); return; }
    } catch (e) { showToast('验证失败'); return; }
  }
  localStorage.setItem('yyx_admin', key);
  enterAdminMode();
  showToast('已进入管理模式');
}
async function adminDeleteQuestion() {
  if (!confirm('管理员操作：确定删除该问题及其全部回复？')) return;
  try {
    if (MODE === 'backend') {
      const key = localStorage.getItem('yyx_admin') || '';
      const res = await fetch('/api/admin/questions/' + QID, { method: 'DELETE', headers: { 'x-admin-key': key } });
      if (!res.ok) { const d = await res.json().catch(() => ({})); throw new Error(d.error || '删除失败'); }
    } else {
      setLocal(getLocal().filter((x) => x.id !== QID));
    }
    showToast('已删除'); setTimeout(() => { location.href = 'index.html'; }, 800);
  } catch (e) { showToast(e.message || '删除失败'); }
}
async function adminDeleteReply(rid) {
  if (!confirm('管理员操作：确定删除这条回复？')) return;
  try {
    if (MODE === 'backend') {
      const key = localStorage.getItem('yyx_admin') || '';
      const res = await fetch('/api/admin/replies/' + rid, { method: 'DELETE', headers: { 'x-admin-key': key } });
      if (!res.ok) { const d = await res.json().catch(() => ({})); throw new Error(d.error || '删除失败'); }
    } else {
      const arr = getLocal();
      arr.forEach((q) => { if (q.replies) q.replies = q.replies.filter((r) => r.id !== rid); });
      setLocal(arr);
    }
    showToast('已删除'); await reload();
  } catch (e) { showToast(e.message || '删除失败'); }
}

// ---------- 模式 ----------
async function detectMode() {
  try { const res = await fetch('/api/questions'); if (res.ok) { const d = await res.json(); if (Array.isArray(d.questions)) { MODE = 'backend'; return; } } } catch (e) {}
  MODE = 'local';
}

// ---------- 启动 ----------
(async function start() {
  const params = new URLSearchParams(location.search);
  QID = params.get('id');
  const m = params.get('manage');
  const mr = params.get('manageReply');
  if (m) { setToken(QID, m); setOwned(QID, { type: 'question' }); history.replaceState(null, '', 'question.html?id=' + QID); showToast('已载入管理令牌，可删除该问题'); }
  if (mr) {
    const dot = mr.indexOf('.');
    if (dot > 0) { setToken(mr.slice(0, dot), mr.slice(dot + 1)); setOwned(mr.slice(0, dot), { type: 'reply', questionId: QID }); }
    history.replaceState(null, '', 'question.html?id=' + QID); showToast('已载入留言管理令牌，可删除该回复');
  }
  if (!QID) { showToast('缺少问题 ID'); return; }
  await detectMode();
  modeBadge.textContent = MODE === 'backend' ? '● 共享模式' : '● 本地模式';
  modeBadge.className = 'mode-badge ' + (MODE === 'backend' ? 'online' : 'local');
  replyBtn.addEventListener('click', submitReply);
  replyInput.addEventListener('keydown', (e) => { if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') submitReply(); });
  adminBtn.addEventListener('click', () => adminPanel.classList.toggle('hidden'));
  adminUnlockBtn.addEventListener('click', adminUnlock);
  adminExit.addEventListener('click', exitAdminMode);
  adminKeyInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') adminUnlock(); });
  loadAdmin();
  try {
    const data = await apiGetQuestion(QID);
    renderQuestion(data.question);
    renderReplies(data.replies || []);
    if (ADMIN) { adminBadge.classList.remove('hidden'); adminBtn.classList.add('hidden'); adminExit.classList.remove('hidden'); }
  } catch (e) { showToast(e.message); }
})();

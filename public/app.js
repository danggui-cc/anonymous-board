'use strict';

const CATEGORIES = [
  '内核探寻', '审美与灵感', '创作流与技艺', '定价与价值感',
  '沟通与边界', '运营与系统', '能量与身心养护', '其他',
];
const TOKEN_KEY = 'yyx_tokens';
const LOCAL_KEY = 'yyx_local'; // 本地模式：[{id,title,content,category,createdAt,deleteToken,replies:[{id,content,createdAt,deleteToken}]}]

let MODE = 'backend';
let curCat = '全部';
let curQ = '';
let curSort = 'time';
let ADMIN = false;
let curFeatured = false;

const $ = (s) => document.querySelector(s);
const titleInput = $('#titleInput');
const contentInput = $('#contentInput');
const categoryInput = $('#categoryInput');
const postBtn = $('#postBtn');
const charCount = $('#charCount');
const composerMsg = $('#composerMsg');
const searchInput = $('#searchInput');
const allBtn = $('#allBtn');
const catDropdown = $('#catDropdown');
const featuredBtn = $('#featuredBtn');
const adminMenu = $('#adminMenu');
const questionList = $('#questionList');
const refreshBtn = $('#refreshBtn');
const modeBadge = $('#modeBadge');
const toast = $('#toast');
const sortTime = $('#sortTime');
const sortHeat = $('#sortHeat');
const adminPanel = $('#adminPanel');
const adminKeyInput = $('#adminKeyInput');
const adminUnlockBtn = $('#adminUnlock');
const adminExit = $('#adminExit');
const askOpenBtn = $('#askOpenBtn');
const askModal = $('#askModal');
const askCloseBtn = $('#askCloseBtn');
const notifBadge = $('#notifBadge');
const meBtn = $('#meBtn');

// ---------- 存储 ----------
function getTokens() { try { return JSON.parse(localStorage.getItem(TOKEN_KEY)) || {}; } catch (e) { return {}; } }
function setToken(id, t) { const x = getTokens(); x[id] = t; localStorage.setItem(TOKEN_KEY, JSON.stringify(x)); }
function getLocal() { try { return JSON.parse(localStorage.getItem(LOCAL_KEY)) || []; } catch (e) { return []; } }
function setLocal(a) { localStorage.setItem(LOCAL_KEY, JSON.stringify(a)); }
function makeId() { return (crypto.randomUUID ? crypto.randomUUID() : 'id-' + Date.now() + '-' + Math.random().toString(36).slice(2)); }
function makeToken() { const a = crypto.getRandomValues(new Uint8Array(18)); return btoa(String.fromCharCode(...a)).replace(/[+/=]/g, ''); }

function showToast(m) { toast.textContent = m; toast.classList.remove('hidden'); clearTimeout(showToast._t); showToast._t = setTimeout(() => toast.classList.add('hidden'), 2600); }
function escapeHtml(s) { return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
function fmtDate(ts) { const d = new Date(ts); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; }
function escapeAttr(s) { return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
function copyText(t, msg) {
  const ok = msg || '已复制链接';
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(t).then(() => showToast(ok)).catch(() => fallbackCopy(t, ok));
  } else fallbackCopy(t, ok);
}
function fallbackCopy(t, msg) {
  const ta = document.createElement('textarea'); ta.value = t; document.body.appendChild(ta); ta.select();
  try { document.execCommand('copy'); showToast(msg || '已复制链接'); } catch (e) { showToast('复制失败，请手动复制'); }
  document.body.removeChild(ta);
}
// ---------- 所有权 & 消息通知 ----------
const OWNED_KEY = 'yyx_owned';
const SEEN_KEY = 'yyx_seen';
function getOwned() { try { return JSON.parse(localStorage.getItem(OWNED_KEY)) || {}; } catch (e) { return {}; } }
function setOwned(id, info) { const x = getOwned(); x[id] = info; localStorage.setItem(OWNED_KEY, JSON.stringify(x)); }
function getSeen() { try { return JSON.parse(localStorage.getItem(SEEN_KEY)) || []; } catch (e) { return []; } }
function markSeen(ids) { const s = new Set(getSeen()); ids.forEach((i) => s.add(i)); localStorage.setItem(SEEN_KEY, JSON.stringify([...s])); }

async function apiGetQuestionRaw(id) {
  if (MODE === 'backend') {
    try { const res = await fetch('/api/questions/' + id); if (!res.ok) return null; return res.json(); }
    catch (e) { return null; }
  }
  const q = getLocal().find((x) => x.id === id);
  if (!q) return null;
  return { question: { id: q.id, title: q.title, category: q.category, createdAt: q.createdAt }, replies: (q.replies || []).slice() };
}

async function computeNotifications() {
  const owned = getOwned();
  const ids = Object.keys(owned);
  if (!ids.length) return [];
  const qIds = new Set();
  ids.forEach((id) => { const info = owned[id]; if (info.type === 'question') qIds.add(id); else if (info.type === 'reply' && info.questionId) qIds.add(info.questionId); });
  const cache = {};
  for (const qid of qIds) cache[qid] = await apiGetQuestionRaw(qid);
  const notifs = [];
  const used = new Set();
  ids.forEach((id) => {
    const info = owned[id];
    if (info.type === 'question') {
      const d = cache[id]; if (!d) return;
      (d.replies || []).forEach((r) => {
        if (owned[r.id]) return;
        const key = 'q:' + r.id; if (used.has(key)) return; used.add(key);
        notifs.push({ kind: 'question', qid: id, qtitle: d.question.title || '（无标题）', text: r.content, time: r.createdAt, replyId: r.id });
      });
    } else if (info.type === 'reply' && info.questionId) {
      const d = cache[info.questionId]; if (!d) return;
      (d.replies || []).forEach((r) => {
        if (r.quoteId === id && !owned[r.id]) {
          const key = 'r:' + r.id; if (used.has(key)) return; used.add(key);
          notifs.push({ kind: 'reply', qid: info.questionId, qtitle: d.question.title || '（无标题）', text: r.content, time: r.createdAt, replyId: r.id });
        }
      });
    }
  });
  notifs.sort((a, b) => b.time - a.time);
  return notifs;
}

async function refreshNotif() {
  const notifs = await computeNotifications();
  const seen = new Set(getSeen());
  const unread = notifs.filter((n) => !seen.has(n.replyId)).length;
  if (unread > 0) { notifBadge.textContent = unread > 99 ? '99+' : String(unread); notifBadge.classList.remove('hidden'); }
  else { notifBadge.classList.add('hidden'); }
}

// ---------- 数据访问（双模式）----------
async function apiList({ category, q, featured }) {
  if (MODE === 'backend') {
    const p = new URLSearchParams();
    if (category && category !== '全部' && !featured) p.set('category', category);
    if (q) p.set('q', q);
    if (featured) p.set('featured', '1');
    p.set('sort', curSort);
    const res = await fetch('/api/questions?' + p.toString());
    const d = await res.json();
    return d.questions || [];
  }
  let arr = getLocal().slice();
  if (featured) arr = arr.filter((x) => x.featured);
  else if (category && category !== '全部') arr = arr.filter((x) => x.category === category);
  if (q) { q = q.toLowerCase(); arr = arr.filter((x) => (x.title || '').toLowerCase().includes(q) || (x.content || '').toLowerCase().includes(q)); }
  arr.sort((a, b) => {
    if (curSort === 'heat') {
      const diff = (b.replies || []).length - (a.replies || []).length;
      if (diff !== 0) return diff;
    }
    return b.createdAt - a.createdAt;
  });
  return arr.map((x) => ({ id: x.id, title: x.title, content: x.content, category: x.category, createdAt: x.createdAt, replyCount: (x.replies || []).length, featured: !!x.featured }));
}

async function apiCreateQuestion({ title, content, category, author }) {
  const ownerId = YuyanIdentity.getUid();
  if (MODE === 'backend') {
    const res = await fetch('/api/questions', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title, content, category, author, ownerId }) });
    const d = await res.json();
    if (!res.ok) throw new Error(d.error || '提交失败');
    return d;
  }
  const id = makeId(); const token = makeToken();
  const q = { id, title, content, category, createdAt: Date.now(), deleteToken: token, replies: [], author: author || null, ownerId };
  const arr = getLocal(); arr.push(q); setLocal(arr);
  return { id, deleteToken: token };
}

async function apiDeleteQuestion(id, token) {
  if (MODE === 'backend') {
    const res = await fetch('/api/questions/' + id, { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token }) });
    const d = await res.json(); if (!res.ok) throw new Error(d.error || '删除失败'); return true;
  }
  setLocal(getLocal().filter((x) => x.id !== id)); return true;
}

// ---------- 渲染 ----------
function buildCards(list) {
  if (!list.length) {
    questionList.innerHTML = '<div class="empty-tip">还没有相关问题，换个关键词或成为第一个发布的人 🌱</div>';
    return;
  }
  questionList.innerHTML = '';
  list.forEach((q) => {
    const card = document.createElement('div');
    card.className = 'question-card';
    card.dataset.id = q.id;
    const a = YuyanIdentity.authorOf(q);
    const authorHtml = `<div class="q-card-author">` +
      `<span class="reply-avatar small" style="background:${escapeAttr(a.color || '#E3EFE8')}">${a.avatar || '🙂'}</span>` +
      `<span class="q-author-name">${escapeHtml(a.nickname || '匿名用户')}</span></div>`;
    const title = q.title ? `<h3 class="q-card-title">${escapeHtml(q.title)}</h3>` : '';
    const featuredBadge = q.featured ? `<span class="post-topic featured">${ICONS.star} 精选</span>` : '';
    const adminBtnHtml = ADMIN ? `<button class="card-admin" data-id="${escapeAttr(q.id)}" data-featured="${q.featured ? 1 : 0}" title="管理">${ICONS.shield} 管理</button>` : '';
    card.innerHTML = `
      ${authorHtml}
      <div class="q-card-top"><span class="post-topic">#${escapeHtml(q.category)}</span>${featuredBadge}${adminBtnHtml}</div>
      ${title}
      <p class="q-snippet">${escapeHtml(q.content)}</p>
      <div class="q-card-foot">
        <span>${fmtDate(q.createdAt)}</span>
        <span class="q-replies">${ICONS.chat} ${q.replyCount || 0} 回复</span>
      </div>`;
    card.addEventListener('click', (e) => {
      if (e.target.closest('.card-admin') || e.target.closest('.card-del')) return;
      location.href = 'question.html?id=' + q.id;
    });
    questionList.appendChild(card);
  });
}

async function loadQuestions() {
  questionList.innerHTML = '<div class="empty-tip">加载中…</div>';
  try {
    const list = await apiList({ category: curCat, q: curQ, featured: curFeatured });
    buildCards(list);
  } catch (e) {
    questionList.innerHTML = '<div class="empty-tip">加载失败，请刷新。</div>';
  }
}

// ---------- 分类筛选 UI ----------
function renderCats() {
  // 下拉
  catDropdown.innerHTML = '';
  ['全部', ...CATEGORIES].forEach((c) => {
    const b = document.createElement('button');
    b.textContent = c;
    if (c === curCat) b.classList.add('active');
    b.addEventListener('click', () => { setCategory(c); catDropdown.classList.add('hidden'); });
    catDropdown.appendChild(b);
  });
}
function setCategory(c) {
  curCat = c;
  if (curFeatured) { curFeatured = false; featuredBtn.classList.remove('active'); }
  renderCats();
  loadQuestions();
}
allBtn.addEventListener('click', () => catDropdown.classList.toggle('hidden'));
document.addEventListener('click', (e) => {
  if (!e.target.closest('.filter-all')) catDropdown.classList.add('hidden');
});

// ---------- 精选筛选 ----------
featuredBtn.addEventListener('click', () => {
  curFeatured = !curFeatured;
  featuredBtn.classList.toggle('active', curFeatured);
  if (curFeatured) catDropdown.classList.add('hidden');
  loadQuestions();
});

// ---------- 管理员操作菜单（删除 / 精选 / 取消精选）----------
let adminTarget = null;
function openAdminMenu(btn) {
  const id = btn.dataset.id;
  const isFeat = btn.dataset.featured === '1';
  adminTarget = { id, featured: isFeat };
  adminMenu.innerHTML = '';
  const del = document.createElement('button');
  del.className = 'admin-menu-item danger'; del.dataset.act = 'delete'; del.innerHTML = ICONS.trash + ' 删除';
  const feat = document.createElement('button');
  feat.className = 'admin-menu-item'; feat.dataset.act = isFeat ? 'unfeature' : 'feature';
  feat.innerHTML = isFeat ? ICONS.star + ' 取消精选' : ICONS.star + ' 精选';
  adminMenu.appendChild(del); adminMenu.appendChild(feat);
  const rect = btn.getBoundingClientRect();
  adminMenu.style.top = (window.scrollY + rect.bottom + 6) + 'px';
  adminMenu.style.left = Math.max(8, window.scrollX + rect.right - 168) + 'px';
  adminMenu.classList.remove('hidden');
}
function closeAdminMenu() { adminMenu.classList.add('hidden'); adminTarget = null; }
adminMenu.addEventListener('click', async (e) => {
  const act = e.target.dataset.act;
  if (!act || !adminTarget) return;
  const { id, featured } = adminTarget;
  closeAdminMenu();
  if (act === 'delete') {
    if (!confirm('管理员操作：确定删除该问题及其全部回复？')) return;
    await adminDeleteQuestion(id);
  } else if (act === 'feature') {
    try { await apiSetFeatured(id, true); showToast('已设为精选'); } catch (err) { showToast(err.message || '操作失败'); }
    await loadQuestions();
  } else if (act === 'unfeature') {
    try { await apiSetFeatured(id, false); showToast('已取消精选'); } catch (err) { showToast(err.message || '操作失败'); }
    await loadQuestions();
  }
});
document.addEventListener('click', (e) => {
  if (!e.target.closest('#adminMenu') && !e.target.closest('.card-admin')) closeAdminMenu();
});

// ---------- 提问弹窗 ----------
function openAskModal() {
  composerMsg.textContent = '';
  askModal.classList.remove('hidden');
  askModal.setAttribute('aria-hidden', 'false');
  updateCharCount();
  setTimeout(() => contentInput.focus(), 60);
}
function closeAskModal() {
  askModal.classList.add('hidden');
  askModal.setAttribute('aria-hidden', 'true');
}
askOpenBtn.addEventListener('click', openAskModal);
askCloseBtn.addEventListener('click', closeAskModal);
askModal.addEventListener('click', (e) => { if (e.target.dataset.close) closeAskModal(); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !askModal.classList.contains('hidden')) closeAskModal(); });

// ---------- 发帖 ----------
async function submitQuestion() {
  const content = contentInput.value.trim();
  if (!content) { composerMsg.textContent = '内容不能为空'; composerMsg.className = 'composer-msg err'; return; }
  postBtn.disabled = true; composerMsg.textContent = '';
  try {
    const me = YuyanIdentity.genIdentity();
    const d = await apiCreateQuestion({ title: titleInput.value.trim(), content, category: categoryInput.value, author: me });
    setToken(d.id, d.deleteToken);
    YuyanIdentity.setVisitor(d.id, me); // 同一问题下本人身份保持一致
    setOwned(d.id, { type: 'question' });
    titleInput.value = ''; contentInput.value = ''; updateCharCount();
    closeAskModal();
    await loadQuestions();
    refreshNotif();
    showToast('发布成功');
  } catch (e) {
    composerMsg.textContent = e.message || '发布失败'; composerMsg.className = 'composer-msg err';
  } finally { postBtn.disabled = false; }
}

// ---------- 搜索（防抖）----------
let searchTimer;
searchInput.addEventListener('input', () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => { curQ = searchInput.value.trim(); loadQuestions(); }, 300);
});

// ---------- 交互 ----------
function updateCharCount() { charCount.textContent = `${contentInput.value.length}/2000`; }
contentInput.addEventListener('input', updateCharCount);
postBtn.addEventListener('click', submitQuestion);
refreshBtn.addEventListener('click', loadQuestions);
contentInput.addEventListener('keydown', (e) => { if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') submitQuestion(); });

// ---------- 模式 ----------
async function detectMode() {
  try {
    const res = await fetch('/api/questions');
    if (res.ok) { const d = await res.json(); if (Array.isArray(d.questions)) { MODE = 'backend'; return; } }
  } catch (e) {}
  MODE = 'local';
}
// ---------- 排序 ----------
function setSort(s) {
  curSort = s;
  sortTime.classList.toggle('active', s === 'time');
  sortHeat.classList.toggle('active', s === 'heat');
  loadQuestions();
}
sortTime.addEventListener('click', () => setSort('time'));
sortHeat.addEventListener('click', () => setSort('heat'));

// ---------- 管理员 ----------
function loadAdmin() { ADMIN = !!localStorage.getItem('yyx_admin'); }
function enterAdminMode() {
  ADMIN = true;
  if (adminPanel) {
    adminPanel.classList.remove('locked');
    adminPanel.classList.add('unlocked');
    const label = adminPanel.querySelector('.admin-label');
    if (label) label.textContent = '管理模式';
  }
  if (adminKeyInput) adminKeyInput.value = '';
  loadQuestions();
}
function exitAdminMode() {
  ADMIN = false;
  localStorage.removeItem('yyx_admin');
  if (adminPanel) {
    adminPanel.classList.remove('unlocked');
    adminPanel.classList.add('locked');
    const label = adminPanel.querySelector('.admin-label');
    if (label) label.textContent = '管理员口令';
  }
  loadQuestions();
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
async function adminDeleteQuestion(id) {
  if (!confirm('管理员操作：确定删除该问题及其全部回复？')) return;
  try {
    if (MODE === 'backend') {
      const key = localStorage.getItem('yyx_admin') || '';
      const res = await fetch('/api/admin/questions/' + id, { method: 'DELETE', headers: { 'x-admin-key': key } });
      if (!res.ok) { const d = await res.json().catch(() => ({})); throw new Error(d.error || '删除失败'); }
    } else {
      setLocal(getLocal().filter((x) => x.id !== id));
    }
    showToast('已删除');
    await loadQuestions();
  } catch (e) { showToast(e.message || '删除失败'); }
}
async function apiSetFeatured(id, val) {
  if (MODE === 'backend') {
    const key = localStorage.getItem('yyx_admin') || '';
    const res = await fetch('/api/admin/questions/' + id, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', 'x-admin-key': key },
      body: JSON.stringify({ featured: val }),
    });
    if (!res.ok) { const d = await res.json().catch(() => ({})); throw new Error(d.error || '操作失败'); }
    return true;
  }
  const arr = getLocal();
  const q = arr.find((x) => x.id === id);
  if (q) q.featured = val;
  setLocal(arr);
  return true;
}
if (adminUnlockBtn) adminUnlockBtn.addEventListener('click', adminUnlock);
if (adminExit) adminExit.addEventListener('click', exitAdminMode);
if (adminKeyInput) adminKeyInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') adminUnlock(); });
questionList.addEventListener('click', (e) => {
  const ab = e.target.closest('.card-admin');
  if (ab) { e.stopPropagation(); openAdminMenu(ab); return; }
  const btn = e.target.closest('.card-del');
  if (btn) adminDeleteQuestion(btn.dataset.id);
});

// ---------- 启动 ----------
(async function start() {
  CATEGORIES.forEach((c) => { const o = document.createElement('option'); o.value = c; o.textContent = c; categoryInput.appendChild(o); });
  categoryInput.value = '其他';
  YuyanIdentity.getOrCreateUid();
  await detectMode();
  renderCats();
  if (adminPanel) adminPanel.classList.add('locked');
  loadAdmin();
  if (ADMIN) enterAdminMode();
  await loadQuestions();
  refreshNotif();
  setInterval(refreshNotif, 20000);
})();

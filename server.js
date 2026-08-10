'use strict';

/**
 * 欲言信箱 —— 匿名提问箱后端（纯 Node.js，零依赖）
 *
 * 数据模型：
 *  - questions: { id, title, content, category, createdAt, deleteToken }
 *  - replies:   { id, questionId, content, createdAt, deleteToken, quoteId?, rootId? }
 *                rootId 为所属一级留言的 id（null/缺省表示一级留言），用于两级嵌套
 *
 * 全部匿名；问题/回复均凭私密令牌删除（支持跨设备，通过管理链接）。
 * 字段存储为原始文本，XSS 防护在前端渲染时做转义。
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = process.env.PORT || 3000;
const PUBLIC_DIR = path.join(__dirname, 'public');
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const DATA_FILE = path.join(DATA_DIR, 'data.json');

const CATEGORIES = [
  '内核探寻', '审美与灵感', '创作流与技艺', '定价与价值感',
  '沟通与边界', '运营与系统', '能量与身心养护', '其他',
];

const MAX_TITLE = 80;
const MAX_CONTENT = 4000;
const MAX_CATEGORY = 20;

// 管理员口令：部署时通过环境变量 ADMIN_KEY 覆盖，用于清理违规内容
const ADMIN_KEY = process.env.ADMIN_KEY || 'change-me-admin';

// ---------- 存储 ----------
function ensureStore() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(DATA_FILE)) {
    fs.writeFileSync(DATA_FILE, JSON.stringify({ questions: [], replies: [] }, null, 2));
  }
}
function readStore() {
  ensureStore();
  try {
    const s = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    if (!Array.isArray(s.questions)) s.questions = [];
    if (!Array.isArray(s.replies)) s.replies = [];
    return s;
  } catch (e) {
    return { questions: [], replies: [] };
  }
}
function writeStore(store) {
  ensureStore();
  fs.writeFileSync(DATA_FILE, JSON.stringify(store, null, 2));
}

// ---------- 工具 ----------
function sendJSON(res, status, obj) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(JSON.stringify(obj));
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > 1e6) { reject(new Error('payload too large')); req.destroy(); return; }
      data += chunk;
    });
    req.on('end', () => {
      if (!data) return resolve({});
      try { resolve(JSON.parse(data)); } catch (e) { reject(new Error('invalid json')); }
    });
    req.on('error', reject);
  });
}
function makeToken() { return crypto.randomBytes(18).toString('base64url'); }
function makeId() { return crypto.randomUUID(); }
function clip(s, n) { s = String(s || ''); return s.length > n ? s.slice(0, n) : s; }
function inCategories(c) { return CATEGORIES.includes(c); }

// ---------- 静态 ----------
const MIME = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8', '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon', '.png': 'image/png', '.json': 'application/json; charset=utf-8',
};
function serveStatic(req, res) {
  let urlPath = decodeURIComponent(req.url.split('?')[0]);
  if (urlPath === '/') urlPath = '/index.html';
  const safe = path.normalize(urlPath).replace(/^(\.\.[/\\])+/, '');
  const filePath = path.join(PUBLIC_DIR, safe);
  if (!filePath.startsWith(PUBLIC_DIR)) { res.writeHead(403); res.end('Forbidden'); return; }
  fs.readFile(filePath, (err, buf) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Not Found'); return;
    }
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    res.end(buf);
  });
}

// ---------- API ----------
async function handleApi(req, res, url) {
  const parts = url.pathname.split('/').filter(Boolean);
  const method = req.method;
  const q = url.searchParams;

  // GET /api/questions?category=&q=&sort=
  if (method === 'GET' && parts.length === 2 && parts[1] === 'questions') {
    const store = readStore();
    const cat = (q.get('category') || '全部').trim();
    const kw = (q.get('q') || '').trim().toLowerCase();
    const sort = (q.get('sort') || 'time').trim();
    let list = store.questions.slice();
    if (cat && cat !== '全部') list = list.filter((p) => p.category === cat);
    if (kw) list = list.filter((p) =>
      (p.title || '').toLowerCase().includes(kw) ||
      (p.content || '').toLowerCase().includes(kw));
    // 预计算每个问题的回复数
    const rc = {};
    store.replies.forEach((r) => { rc[r.questionId] = (rc[r.questionId] || 0) + 1; });
    list.sort((a, b) => {
      if (sort === 'heat') {
        const diff = (rc[b.id] || 0) - (rc[a.id] || 0);
        if (diff !== 0) return diff;
      }
      return b.createdAt - a.createdAt;
    });
    const out = list.map((p) => ({
      id: p.id, title: p.title, content: p.content, category: p.category,
      createdAt: p.createdAt, author: p.author || null,
      replyCount: rc[p.id] || 0,
    }));
    return sendJSON(res, 200, { questions: out, total: out.length, categories: CATEGORIES });
  }

  // POST /api/questions
  if (method === 'POST' && parts.length === 2 && parts[1] === 'questions') {
    let body; try { body = await readBody(req); } catch (e) { return sendJSON(res, 400, { error: '请求格式错误' }); }
    const content = (body.content || '').toString().trim();
    const title = (body.title || '').toString().trim();
    let category = (body.category || '其他').toString().trim();
    if (!content) return sendJSON(res, 400, { error: '内容不能为空' });
    if (!inCategories(category)) category = '其他';
    // 可选匿名身份（昵称/头像/颜色），由前端按"同一留言区内一致"的规则生成
    let author = null;
    if (body.author && typeof body.author === 'object') {
      const a = body.author;
      if (typeof a.nickname === 'string' && a.nickname.trim()) {
        author = {
          nickname: clip(a.nickname, 24),
          avatar: typeof a.avatar === 'string' ? clip(a.avatar, 8) : '',
          color: typeof a.color === 'string' ? clip(a.color, 9) : '',
        };
      }
    }
    const post = {
      id: makeId(),
      title: clip(title, MAX_TITLE),
      content: clip(content, MAX_CONTENT),
      category,
      createdAt: Date.now(),
      deleteToken: makeToken(),
      author,
    };
    const store = readStore();
    store.questions.push(post);
    writeStore(store);
    return sendJSON(res, 201, { id: post.id, deleteToken: post.deleteToken, message: '提交成功' });
  }

  // GET /api/questions/:id  (详情 + 回复)
  if (method === 'GET' && parts.length === 3 && parts[1] === 'questions') {
    const id = parts[2];
    const store = readStore();
    const qst = store.questions.find((p) => p.id === id);
    if (!qst) return sendJSON(res, 404, { error: '问题不存在' });
    const replies = store.replies
      .filter((r) => r.questionId === id)
      .sort((a, b) => a.createdAt - b.createdAt)
      .map((r) => ({ id: r.id, content: r.content, createdAt: r.createdAt, quoteId: r.quoteId || null, rootId: r.rootId || null, author: r.author || null }));
    return sendJSON(res, 200, {
      question: { id: qst.id, title: qst.title, content: qst.content, category: qst.category, createdAt: qst.createdAt, author: qst.author || null },
      replies,
    });
  }

  // DELETE /api/questions/:id
  if (method === 'DELETE' && parts.length === 3 && parts[1] === 'questions') {
    const id = parts[2];
    let token = '';
    try { const b = await readBody(req); token = b.token || ''; } catch (e) {}
    if (!token) token = req.headers['x-delete-token'] || '';
    const store = readStore();
    const idx = store.questions.findIndex((p) => p.id === id);
    if (idx === -1) return sendJSON(res, 404, { error: '问题不存在' });
    if (store.questions[idx].deleteToken !== token) return sendJSON(res, 403, { error: '令牌不正确，无法删除他人发言' });
    // 连带删除其回复
    store.replies = store.replies.filter((r) => r.questionId !== id);
    store.questions.splice(idx, 1);
    writeStore(store);
    return sendJSON(res, 200, { message: '已删除' });
  }

  // POST /api/questions/:id/replies
  if (method === 'POST' && parts.length === 4 && parts[1] === 'questions' && parts[3] === 'replies') {
    const id = parts[2];
    let body; try { body = await readBody(req); } catch (e) { return sendJSON(res, 400, { error: '请求格式错误' }); }
    const content = (body.content || '').toString().trim();
    if (!content) return sendJSON(res, 400, { error: '回复内容不能为空' });
    const store = readStore();
    if (!store.questions.find((p) => p.id === id)) return sendJSON(res, 404, { error: '问题不存在' });
    // 引用回复（可选）：仅当被引用回复属于同一问题时才接受
    let quoteId = (body.quoteId || '').toString().trim();
    if (quoteId && !store.replies.some((r) => r.id === quoteId && r.questionId === id)) quoteId = '';
    // 两级嵌套：rootId = 被引用留言的所属一级留言（被引用者本身是一级则为其自身）
    let rootId = undefined;
    if (quoteId) {
      const quoted = store.replies.find((r) => r.id === quoteId);
      if (quoted) rootId = quoted.rootId || quoted.id;
    }
    // 可选匿名身份
    let author = null;
    if (body.author && typeof body.author === 'object') {
      const a = body.author;
      if (typeof a.nickname === 'string' && a.nickname.trim()) {
        author = {
          nickname: clip(a.nickname, 24),
          avatar: typeof a.avatar === 'string' ? clip(a.avatar, 8) : '',
          color: typeof a.color === 'string' ? clip(a.color, 9) : '',
        };
      }
    }
    const reply = {
      id: makeId(), questionId: id,
      content: clip(content, MAX_CONTENT), createdAt: Date.now(), deleteToken: makeToken(),
      quoteId: quoteId || undefined, rootId: rootId || undefined, author,
    };
    store.replies.push(reply);
    writeStore(store);
    return sendJSON(res, 201, { id: reply.id, deleteToken: reply.deleteToken, message: '回复成功' });
  }

  // DELETE /api/replies/:id
  if (method === 'DELETE' && parts.length === 3 && parts[1] === 'replies') {
    const id = parts[2];
    let token = '';
    try { const b = await readBody(req); token = b.token || ''; } catch (e) {}
    if (!token) token = req.headers['x-delete-token'] || '';
    const store = readStore();
    const idx = store.replies.findIndex((r) => r.id === id);
    if (idx === -1) return sendJSON(res, 404, { error: '回复不存在' });
    if (store.replies[idx].deleteToken !== token) return sendJSON(res, 403, { error: '令牌不正确，无法删除他人回复' });
    store.replies.splice(idx, 1);
    writeStore(store);
    return sendJSON(res, 200, { message: '已删除' });
  }

  // POST /api/admin/verify  校验管理员口令
  if (method === 'POST' && parts.length === 3 && parts[1] === 'admin' && parts[2] === 'verify') {
    let body; try { body = await readBody(req); } catch (e) { return sendJSON(res, 400, { error: '请求格式错误' }); }
    const key = (body && body.key) || '';
    if (key === ADMIN_KEY) return sendJSON(res, 200, { ok: true });
    return sendJSON(res, 401, { error: '管理员口令错误' });
  }

  // DELETE /api/admin/questions/:id  管理员删除问题（连带回复）
  if (method === 'DELETE' && parts.length === 4 && parts[1] === 'admin' && parts[2] === 'questions') {
    const key = req.headers['x-admin-key'] || '';
    if (key !== ADMIN_KEY) return sendJSON(res, 401, { error: '未授权：管理员口令不正确' });
    const id = parts[3];
    const store = readStore();
    const idx = store.questions.findIndex((p) => p.id === id);
    if (idx === -1) return sendJSON(res, 404, { error: '问题不存在' });
    store.replies = store.replies.filter((r) => r.questionId !== id);
    store.questions.splice(idx, 1);
    writeStore(store);
    return sendJSON(res, 200, { message: '已删除' });
  }

  // DELETE /api/admin/replies/:id  管理员删除回复
  if (method === 'DELETE' && parts.length === 4 && parts[1] === 'admin' && parts[2] === 'replies') {
    const key = req.headers['x-admin-key'] || '';
    if (key !== ADMIN_KEY) return sendJSON(res, 401, { error: '未授权：管理员口令不正确' });
    const id = parts[3];
    const store = readStore();
    const idx = store.replies.findIndex((r) => r.id === id);
    if (idx === -1) return sendJSON(res, 404, { error: '回复不存在' });
    store.replies.splice(idx, 1);
    writeStore(store);
    return sendJSON(res, 200, { message: '已删除' });
  }

  return sendJSON(res, 404, { error: '接口不存在' });
}

// ---------- 服务器 ----------
const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  if (url.pathname.startsWith('/api/')) {
    handleApi(req, res, url).catch(() => sendJSON(res, 500, { error: '服务器错误' }));
    return;
  }
  serveStatic(req, res);
});

ensureStore();
server.listen(PORT, () => {
  console.log(`欲言信箱已启动: http://localhost:${PORT}`);
});

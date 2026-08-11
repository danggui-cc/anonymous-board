'use strict';

/**
 * 欲言信箱 —— 存储层
 *
 * 支持两种后端（自动选择）：
 *  1) PostgreSQL（腾讯云 CloudBase SQL 型数据库，推荐用于生产部署）
 *     - 当环境变量配置了 DATABASE_URL 时启用
 *     - 数据存于云端 PostgreSQL，所有浏览器/设备共享，重启/重部署不丢
 *     - CloudBase 云托管与 SQL 型数据库同环境，可直接通过内网连接串访问
 *  2) 本地文件模式（file，兜底 / 本地开发）
 *     - 数据写在 DATA_DIR/data.json，仅本机可见，重部署容器会丢
 *
 * 放弃的方案（仅作记录，勿回退）：
 *  - LeanCloud 国内版：已停止新用户注册、即将下线。
 *  - MongoDB Atlas（AWS 境外）：从 CloudBase 容器直连 *.mongodb.net 被网络层拦截
 *    （DNS 解析失败 + TLS 握手告警），实测不可用。
 *  - CloudBase 自带文档型数据库 / @cloudbase/node-sdk：云托管默认不注入凭据
 *    （TCB_ENV 等全 false），node-sdk 无法初始化，走不通。
 *  - 腾讯云 TencentDB for MongoDB：可行但需单独购买实例并配置内网互联；
 *    现在优先使用 CloudBase 自带的 PostgreSQL，零额外购买、同环境内网可达。
 */

const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');

// ---------- 模式选择 ----------
const DATABASE_URL = process.env.DATABASE_URL || '';
const EXPLICIT_STORAGE = process.env.STORAGE || '';

const MODE = (EXPLICIT_STORAGE === 'file')
  ? 'file'
  : (DATABASE_URL ? 'pg' : 'file');

// 文件模式路径
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const DATA_FILE = path.join(DATA_DIR, 'data.json');

// ===================================================================
//  PostgreSQL 后端（腾讯云 CloudBase SQL 型数据库）
// ===================================================================

let _pool = null;
let _connecting = null;

function getPool() {
  if (_pool) return _pool;
  if (!DATABASE_URL) throw new Error('DATABASE_URL 未配置，无法使用 pg 模式');
  _pool = new Pool({
    connectionString: DATABASE_URL,
    // CloudBase PostgreSQL 通常需要 SSL；若内网连接串已包含 sslmode 则这里不重复
    // 额外加 5 秒连接超时，避免偶发抖动导致接口挂死
    connectionTimeoutMillis: 5000,
    idleTimeoutMillis: 30000,
    max: 10,
  });
  _pool.on('error', (err) => {
    console.error('[pg] 连接池错误:', err && err.message);
  });
  return _pool;
}

async function query(sql, params) {
  const pool = getPool();
  const client = await pool.connect();
  try {
    const res = await client.query(sql, params);
    return res;
  } finally {
    client.release();
  }
}

async function ensureTables() {
  await query(`
    CREATE TABLE IF NOT EXISTS questions (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL DEFAULT '',
      content TEXT NOT NULL DEFAULT '',
      category TEXT NOT NULL DEFAULT '其他',
      createdAt BIGINT NOT NULL,
      deleteToken TEXT NOT NULL DEFAULT '',
      author JSONB,
      ownerId TEXT NOT NULL DEFAULT '',
      featured BOOLEAN NOT NULL DEFAULT FALSE
    );
  `);
  await query(`
    CREATE INDEX IF NOT EXISTS idx_questions_createdAt ON questions (createdAt DESC);
  `);
  await query(`
    CREATE INDEX IF NOT EXISTS idx_questions_category ON questions (category);
  `);
  await query(`
    CREATE INDEX IF NOT EXISTS idx_questions_ownerId ON questions (ownerId);
  `);

  await query(`
    CREATE TABLE IF NOT EXISTS replies (
      id TEXT PRIMARY KEY,
      questionId TEXT NOT NULL,
      content TEXT NOT NULL DEFAULT '',
      createdAt BIGINT NOT NULL,
      deleteToken TEXT NOT NULL DEFAULT '',
      quoteId TEXT,
      rootId TEXT,
      author JSONB,
      ownerId TEXT NOT NULL DEFAULT ''
    );
  `);
  await query(`
    CREATE INDEX IF NOT EXISTS idx_replies_questionId ON replies (questionId);
  `);
  await query(`
    CREATE INDEX IF NOT EXISTS idx_replies_createdAt ON replies (createdAt ASC);
  `);
  await query(`
    CREATE INDEX IF NOT EXISTS idx_replies_ownerId ON replies (ownerId);
  `);

  await query(`
    CREATE TABLE IF NOT EXISTS accounts (
      id TEXT PRIMARY KEY,
      salt TEXT NOT NULL,
      pwdHash TEXT NOT NULL
    );
  `);
}

function parseAuthor(authorRaw) {
  if (!authorRaw) return null;
  if (typeof authorRaw === 'string') {
    try { authorRaw = JSON.parse(authorRaw); } catch { return null; }
  }
  if (typeof authorRaw !== 'object') return null;
  if (typeof authorRaw.nickname !== 'string' || !authorRaw.nickname.trim()) return null;
  return {
    nickname: authorRaw.nickname.slice(0, 24),
    avatar: typeof authorRaw.avatar === 'string' ? authorRaw.avatar.slice(0, 8) : '',
    color: typeof authorRaw.color === 'string' ? authorRaw.color.slice(0, 9) : '',
  };
}

function mapQuestion(row) {
  if (!row) return null;
  return {
    id: row.id,
    title: row.title || '',
    content: row.content || '',
    category: row.category || '其他',
    createdAt: Number(row.createdat || row.createdAt) || 0,
    deleteToken: row.deletetoken || row.deleteToken || '',
    author: parseAuthor(row.author),
    ownerId: row.ownerid || row.ownerId || '',
    featured: !!row.featured,
  };
}

function mapReply(row) {
  if (!row) return null;
  return {
    id: row.id,
    questionId: row.questionid || row.questionId,
    content: row.content || '',
    createdAt: Number(row.createdat || row.createdAt) || 0,
    quoteId: row.quoteid || row.quoteId || null,
    rootId: row.rootid || row.rootId || null,
    author: parseAuthor(row.author),
    deleteToken: row.deletetoken || row.deleteToken || '',
    ownerId: row.ownerid || row.ownerId || '',
  };
}

const pgStore = {
  async init() {
    try {
      await ensureTables();
      console.log('[storage] PostgreSQL 连接成功，表已就绪（模式 pg）');
    } catch (e) {
      console.error('[storage] PostgreSQL 初始化失败（仅告警，进程继续）:', e && e.message);
      throw e; // 让 server.js 记录日志，但不退出
    }
  },
  async listQuestions() {
    const res = await query('SELECT * FROM questions ORDER BY createdAt DESC');
    return res.rows.map(mapQuestion);
  },
  async getQuestion(id) {
    const res = await query('SELECT * FROM questions WHERE id = $1', [id]);
    return mapQuestion(res.rows[0]);
  },
  async createQuestion(q) {
    await query(
      `INSERT INTO questions (id, title, content, category, createdAt, deleteToken, author, ownerId, featured)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [
        q.id, q.title || '', q.content || '', q.category || '其他', q.createdAt || Date.now(),
        q.deleteToken || '', q.author ? JSON.stringify(q.author) : null,
        q.ownerId || '', !!q.featured,
      ]
    );
    return q;
  },
  async deleteQuestion(id, token) {
    const qres = await query('SELECT * FROM questions WHERE id = $1', [id]);
    if (!qres.rows[0]) return { ok: false, code: 404 };
    const q = mapQuestion(qres.rows[0]);
    if (q.deleteToken !== token) return { ok: false, code: 403 };
    await query('DELETE FROM replies WHERE questionId = $1', [id]);
    await query('DELETE FROM questions WHERE id = $1', [id]);
    return { ok: true };
  },
  async adminDeleteQuestion(id) {
    const qres = await query('SELECT * FROM questions WHERE id = $1', [id]);
    if (!qres.rows[0]) return { ok: false, code: 404 };
    await query('DELETE FROM replies WHERE questionId = $1', [id]);
    await query('DELETE FROM questions WHERE id = $1', [id]);
    return { ok: true };
  },
  async listReplies(qid) {
    const res = await query('SELECT * FROM replies WHERE questionId = $1 ORDER BY createdAt ASC', [qid]);
    return res.rows.map(mapReply);
  },
  async createReply(r) {
    await query(
      `INSERT INTO replies (id, questionId, content, createdAt, deleteToken, quoteId, rootId, author, ownerId)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [
        r.id, r.questionId, r.content || '', r.createdAt || Date.now(),
        r.deleteToken || '', r.quoteId || null, r.rootId || null,
        r.author ? JSON.stringify(r.author) : null, r.ownerId || '',
      ]
    );
    return r;
  },
  async deleteReply(id, token) {
    const rres = await query('SELECT * FROM replies WHERE id = $1', [id]);
    if (!rres.rows[0]) return { ok: false, code: 404 };
    const r = mapReply(rres.rows[0]);
    if (r.deleteToken !== token) return { ok: false, code: 403 };
    await query('DELETE FROM replies WHERE id = $1', [id]);
    return { ok: true };
  },
  async adminDeleteReply(id) {
    const rres = await query('SELECT * FROM replies WHERE id = $1', [id]);
    if (!rres.rows[0]) return { ok: false, code: 404 };
    await query('DELETE FROM replies WHERE id = $1', [id]);
    return { ok: true };
  },
  async setFeatured(id, val) {
    const qres = await query('SELECT * FROM questions WHERE id = $1', [id]);
    if (!qres.rows[0]) return { ok: false, code: 404 };
    await query('UPDATE questions SET featured = $1 WHERE id = $2', [!!val, id]);
    return { ok: true };
  },
  async replyCounts() {
    const res = await query('SELECT questionId, COUNT(*) AS cnt FROM replies GROUP BY questionId');
    const counts = {};
    for (const row of res.rows) {
      if (row.questionid) counts[row.questionid] = Number(row.cnt) || 0;
    }
    return counts;
  },
  async createUser(u) {
    const res = await query('SELECT id FROM accounts WHERE id = $1', [u.id]);
    if (res.rows[0]) return { existed: true };
    await query('INSERT INTO accounts (id, salt, pwdHash) VALUES ($1, $2, $3)', [u.id, u.salt, u.pwdHash]);
    return { existed: false };
  },
  async getUserSalt(id) {
    const res = await query('SELECT salt FROM accounts WHERE id = $1', [id]);
    return res.rows[0] ? res.rows[0].salt : null;
  },
  async verifyUser(id, pwdHash) {
    const res = await query('SELECT pwdHash FROM accounts WHERE id = $1', [id]);
    return !!res.rows[0] && res.rows[0].pwdhash === pwdHash;
  },
  async listMyQuestions(ownerId) {
    const res = await query('SELECT * FROM questions WHERE ownerId = $1 ORDER BY createdAt DESC', [ownerId]);
    return res.rows.map(mapQuestion);
  },
  async listMyReplies(ownerId) {
    const res = await query('SELECT * FROM replies WHERE ownerId = $1 ORDER BY createdAt DESC', [ownerId]);
    return res.rows.map(mapReply);
  },
  async debug() {
    const info = {
      MODE, EXPLICIT_STORAGE, mode: MODE,
      pgConfigured: !!DATABASE_URL,
    };
    if (MODE === 'pg') {
      try {
        const res = await query('SELECT COUNT(*) AS q FROM questions');
        const rres = await query('SELECT COUNT(*) AS c FROM replies');
        info.pg = {
          ok: true,
          questionCount: Number(res.rows[0].q) || 0,
          replyCount: Number(rres.rows[0].c) || 0,
        };
      } catch (e) {
        info.pg = { ok: false, name: e && e.name, message: e && e.message };
      }
    }
    return info;
  },
};

// ===================================================================
//  本地文件后端（file，兜底 / 本地开发）
// ===================================================================

function readFile() {
  try {
    const raw = fs.readFileSync(DATA_FILE, 'utf8');
    return JSON.parse(raw);
  } catch {
    return { questions: [], replies: [], users: [] };
  }
}
function writeFile(data) {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2), 'utf8');
}

const fileStore = {
  async init() {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    console.log('[storage] 文件模式（mode=file），数据写入', DATA_FILE);
  },
  async listQuestions() {
    const d = readFile();
    return (d.questions || []).slice().sort((a, b) => b.createdAt - a.createdAt);
  },
  async getQuestion(id) {
    const d = readFile();
    return d.questions.find((q) => q.id === id) || null;
  },
  async createQuestion(q) {
    const d = readFile();
    d.questions.push(q);
    writeFile(d);
    return q;
  },
  async deleteQuestion(id, token) {
    const d = readFile();
    const q = d.questions.find((x) => x.id === id);
    if (!q) return { ok: false, code: 404 };
    if (q.deleteToken !== token) return { ok: false, code: 403 };
    d.questions = d.questions.filter((x) => x.id !== id);
    d.replies = d.replies.filter((x) => x.questionId !== id);
    writeFile(d);
    return { ok: true };
  },
  async adminDeleteQuestion(id) {
    const d = readFile();
    const q = d.questions.find((x) => x.id === id);
    if (!q) return { ok: false, code: 404 };
    d.questions = d.questions.filter((x) => x.id !== id);
    d.replies = d.replies.filter((x) => x.questionId !== id);
    writeFile(d);
    return { ok: true };
  },
  async listReplies(qid) {
    const d = readFile();
    return (d.replies || []).filter((r) => r.questionId === qid).sort((a, b) => a.createdAt - b.createdAt);
  },
  async createReply(r) {
    const d = readFile();
    d.replies.push(r);
    writeFile(d);
    return r;
  },
  async deleteReply(id, token) {
    const d = readFile();
    const r = d.replies.find((x) => x.id === id);
    if (!r) return { ok: false, code: 404 };
    if (r.deleteToken !== token) return { ok: false, code: 403 };
    d.replies = d.replies.filter((x) => x.id !== id);
    writeFile(d);
    return { ok: true };
  },
  async adminDeleteReply(id) {
    const d = readFile();
    const r = d.replies.find((x) => x.id === id);
    if (!r) return { ok: false, code: 404 };
    d.replies = d.replies.filter((x) => x.id !== id);
    writeFile(d);
    return { ok: true };
  },
  async setFeatured(id, val) {
    const d = readFile();
    const q = d.questions.find((x) => x.id === id);
    if (!q) return { ok: false, code: 404 };
    q.featured = !!val;
    writeFile(d);
    return { ok: true };
  },
  async replyCounts() {
    const d = readFile();
    const counts = {};
    for (const r of d.replies || []) {
      if (r.questionId) counts[r.questionId] = (counts[r.questionId] || 0) + 1;
    }
    return counts;
  },
  async createUser(u) {
    const d = readFile();
    const existing = d.users.find((x) => x.id === u.id);
    if (existing) return { existed: true };
    d.users.push(u);
    writeFile(d);
    return { existed: false };
  },
  async getUserSalt(id) {
    const d = readFile();
    const a = d.users.find((x) => x.id === id);
    return a ? a.salt : null;
  },
  async verifyUser(id, pwdHash) {
    const d = readFile();
    const a = d.users.find((x) => x.id === id);
    return !!a && a.pwdHash === pwdHash;
  },
  async listMyQuestions(ownerId) {
    const d = readFile();
    return (d.questions || []).filter((q) => q.ownerId === ownerId)
      .sort((a, b) => b.createdAt - a.createdAt);
  },
  async listMyReplies(ownerId) {
    const d = readFile();
    return (d.replies || []).filter((r) => r.ownerId === ownerId)
      .sort((a, b) => b.createdAt - a.createdAt);
  },
  async debug() {
    return { MODE, EXPLICIT_STORAGE, mode: MODE, file: DATA_FILE };
  },
};

// ---------- 导出 ----------
const store = MODE === 'pg' ? pgStore : fileStore;
store.mode = MODE;
store.init = MODE === 'pg' ? pgStore.init : fileStore.init;
module.exports = store;

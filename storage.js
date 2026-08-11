'use strict';

/**
 * 欲言信箱 —— 存储层
 *
 *  模式：
 *   - 文件模式（file）：本地 / 无云环境时使用，数据写入 data/data.json
 *   - MongoDB 模式（mongo）：部署到云容器（CloudBase / 任意平台）时使用，
 *     连接 MongoDB Atlas 免费集群，数据持久、跨设备共享、重启不丢。
 *
 *  模式选择（优先级从高到低）：
 *   - 显式环境变量 STORAGE=file | mongo
 *   - 若设置了 MONGODB_URI，自动走 mongo（Atlas 连接串）
 *   - 否则走 file 兜底
 *
 *  说明：曾尝试 CloudBase 自带云数据库（tcb），但免费体验版不提供可用数据库，
 *  故改为 MongoDB Atlas（免费 M0 集群），从容器内可直连。
 *
 *  对外全部为 async 方法，server.js 无需关心底层实现。
 */

const fs = require('fs');
const path = require('path');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const DATA_FILE = path.join(DATA_DIR, 'data.json');
const USERS_FILE = path.join(DATA_DIR, 'users.json');

// ---------------- 模式选择 ----------------
function detectMode() {
  if (process.env.STORAGE === 'file') return 'file';
  if (process.env.STORAGE === 'mongo') return 'mongo';
  if (process.env.MONGODB_URI) return 'mongo';
  return 'file';
}
const MODE = detectMode();
const EXPLICIT_STORAGE = !!process.env.STORAGE;
// mongo/file 都是共享或本地存储，失败不应静默降级到另一个（避免数据分片/丢失）。
function allowFallback() {
  if (MODE === 'mongo' || MODE === 'file') return false;
  return true;
}

// ================= 文件模式（本地兜底） =================
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
function readUsers() {
  ensureStore();
  try { const s = JSON.parse(fs.readFileSync(USERS_FILE, 'utf8')); return Array.isArray(s) ? s : []; }
  catch (e) { return []; }
}
function writeUsers(arr) { ensureStore(); fs.writeFileSync(USERS_FILE, JSON.stringify(arr, null, 2)); }

const fileBackend = {
  async init() { ensureStore(); },
  async listQuestions() { return readStore().questions.slice(); },
  async getQuestion(id) { return readStore().questions.find((p) => p.id === id) || null; },
  async createQuestion(q) {
    const s = readStore();
    s.questions.push(q);
    writeStore(s);
    return q;
  },
  async deleteQuestion(id, token) {
    const s = readStore();
    const idx = s.questions.findIndex((p) => p.id === id);
    if (idx === -1) return { ok: false, code: 404 };
    if (s.questions[idx].deleteToken !== token) return { ok: false, code: 403 };
    s.replies = s.replies.filter((r) => r.questionId !== id);
    s.questions.splice(idx, 1);
    writeStore(s);
    return { ok: true };
  },
  async adminDeleteQuestion(id) {
    const s = readStore();
    const idx = s.questions.findIndex((p) => p.id === id);
    if (idx === -1) return { ok: false, code: 404 };
    s.replies = s.replies.filter((r) => r.questionId !== id);
    s.questions.splice(idx, 1);
    writeStore(s);
    return { ok: true };
  },
  async setFeatured(id, val) {
    const s = readStore();
    const q = s.questions.find((p) => p.id === id);
    if (!q) return { ok: false, code: 404 };
    q.featured = !!val;
    writeStore(s);
    return { ok: true };
  },
  async listReplies(questionId) {
    return readStore().replies
      .filter((r) => r.questionId === questionId)
      .sort((a, b) => a.createdAt - b.createdAt);
  },
  async createReply(reply) {
    const s = readStore();
    s.replies.push(reply);
    writeStore(s);
    return reply;
  },
  async deleteReply(id, token) {
    const s = readStore();
    const idx = s.replies.findIndex((r) => r.id === id);
    if (idx === -1) return { ok: false, code: 404 };
    if (s.replies[idx].deleteToken !== token) return { ok: false, code: 403 };
    s.replies.splice(idx, 1);
    writeStore(s);
    return { ok: true };
  },
  async adminDeleteReply(id) {
    const s = readStore();
    const idx = s.replies.findIndex((r) => r.id === id);
    if (idx === -1) return { ok: false, code: 404 };
    s.replies.splice(idx, 1);
    writeStore(s);
    return { ok: true };
  },
  async replyCounts() {
    const s = readStore();
    const rc = {};
    s.replies.forEach((r) => { rc[r.questionId] = (rc[r.questionId] || 0) + 1; });
    return rc;
  },
  async listAllReplies() { return readStore().replies.slice(); },
  async createUser(user) {
    const arr = readUsers();
    if (arr.find((u) => u.id === user.id)) return { ok: true, existed: true };
    arr.push(user); writeUsers(arr);
    return { ok: true, existed: false };
  },
  async getUserSalt(id) {
    const u = readUsers().find((x) => x.id === id);
    return u ? u.salt : null;
  },
  async verifyUser(id, pwdHash) {
    const u = readUsers().find((x) => x.id === id);
    return !!(u && u.pwdHash === pwdHash);
  },
};

// ================= MongoDB 模式（Atlas 免费集群） =================
let _mongo = null;
let _mongoHealthy = null;

async function getMongo() {
  if (_mongo) return _mongo;
  const { MongoClient } = require('mongodb');
  const uri = process.env.MONGODB_URI;
  if (!uri) throw new Error('MONGODB_URI 未配置');
  const client = new MongoClient(uri, {
    serverSelectionTimeoutMS: 8000,
    maxPoolSize: 10,
  });
  await client.connect();
  const db = client.db(process.env.MONGODB_DB || 'yuyan');
  _mongo = { client, db };
  return _mongo;
}

const mongoBackend = {
  async init() {
    try {
      const { db } = await getMongo();
      await db.command({ ping: 1 });
      _mongoHealthy = true;
      console.log('[storage] MongoDB 连接成功 (mode=mongo)');
    } catch (e) {
      _mongoHealthy = false;
      console.error('[storage] MongoDB 连接失败:', e && e.message);
    }
  },
  async listQuestions() {
    const { db } = await getMongo();
    return await db.collection('questions').find({}, { projection: { _id: 0 } }).toArray();
  },
  async getQuestion(id) {
    const { db } = await getMongo();
    return await db.collection('questions').findOne({ id }, { projection: { _id: 0 } });
  },
  async createQuestion(q) {
    const { db } = await getMongo();
    await db.collection('questions').insertOne({ ...q });
    return q;
  },
  async deleteQuestion(id, token) {
    const { db } = await getMongo();
    const q = await db.collection('questions').findOne({ id });
    if (!q) return { ok: false, code: 404 };
    if (q.deleteToken !== token) return { ok: false, code: 403 };
    await db.collection('questions').deleteOne({ id });
    await db.collection('replies').deleteMany({ questionId: id });
    return { ok: true };
  },
  async adminDeleteQuestion(id) {
    const { db } = await getMongo();
    const q = await db.collection('questions').findOne({ id });
    if (!q) return { ok: false, code: 404 };
    await db.collection('questions').deleteOne({ id });
    await db.collection('replies').deleteMany({ questionId: id });
    return { ok: true };
  },
  async setFeatured(id, val) {
    const { db } = await getMongo();
    const q = await db.collection('questions').findOne({ id });
    if (!q) return { ok: false, code: 404 };
    await db.collection('questions').updateOne({ id }, { $set: { featured: !!val } });
    return { ok: true };
  },
  async listReplies(questionId) {
    const { db } = await getMongo();
    return await db.collection('replies')
      .find({ questionId }, { projection: { _id: 0 } })
      .sort({ createdAt: 1 })
      .toArray();
  },
  async createReply(reply) {
    const { db } = await getMongo();
    await db.collection('replies').insertOne({ ...reply });
    return reply;
  },
  async deleteReply(id, token) {
    const { db } = await getMongo();
    const r = await db.collection('replies').findOne({ id });
    if (!r) return { ok: false, code: 404 };
    if (r.deleteToken !== token) return { ok: false, code: 403 };
    await db.collection('replies').deleteOne({ id });
    return { ok: true };
  },
  async adminDeleteReply(id) {
    const { db } = await getMongo();
    const r = await db.collection('replies').findOne({ id });
    if (!r) return { ok: false, code: 404 };
    await db.collection('replies').deleteOne({ id });
    return { ok: true };
  },
  async replyCounts() {
    const { db } = await getMongo();
    const docs = await db.collection('replies')
      .find({}, { projection: { _id: 0, questionId: 1 } })
      .toArray();
    const rc = {};
    docs.forEach((r) => { rc[r.questionId] = (rc[r.questionId] || 0) + 1; });
    return rc;
  },
  async listAllReplies() {
    const { db } = await getMongo();
    return await db.collection('replies').find({}, { projection: { _id: 0 } }).toArray();
  },
  async createUser(user) {
    const { db } = await getMongo();
    const existing = await db.collection('users').findOne({ id: user.id });
    if (existing) return { ok: true, existed: true };
    await db.collection('users').insertOne({ ...user });
    return { ok: true, existed: false };
  },
  async getUserSalt(id) {
    const { db } = await getMongo();
    const u = await db.collection('users').findOne({ id }, { projection: { _id: 0 } });
    return u ? u.salt : null;
  },
  async verifyUser(id, pwdHash) {
    const { db } = await getMongo();
    const u = await db.collection('users').findOne({ id }, { projection: { _id: 0 } });
    return !!(u && u.pwdHash === pwdHash);
  },
};

// ================= 统一分发 =================
const backend = MODE === 'mongo' ? mongoBackend : fileBackend;

const store = {
  // 当前实际生效的存储模式
  get mode() { return MODE; },

  // 启动时可调用：建立连接 / 确保本地文件存在（失败不致命，端口照常监听）
  async init() {
    try { if (backend.init) await backend.init(); }
    catch (e) { console.error('[storage] init 失败:', e && e.message); }
  },

  listQuestions() { return backend.listQuestions(); },
  getQuestion(id) { return backend.getQuestion(id); },
  createQuestion(q) { return backend.createQuestion(q); },
  deleteQuestion(id, token) { return backend.deleteQuestion(id, token); },
  adminDeleteQuestion(id) { return backend.adminDeleteQuestion(id); },
  setFeatured(id, val) { return backend.setFeatured(id, val); },
  listReplies(questionId) { return backend.listReplies(questionId); },
  createReply(reply) { return backend.createReply(reply); },
  deleteReply(id, token) { return backend.deleteReply(id, token); },
  adminDeleteReply(id) { return backend.adminDeleteReply(id); },
  replyCounts() { return backend.replyCounts(); },
  listAllReplies() { return backend.listAllReplies(); },
  createUser(user) { return backend.createUser(user); },
  getUserSalt(id) { return backend.getUserSalt(id); },
  verifyUser(id, pwdHash) { return backend.verifyUser(id, pwdHash); },

  // 按 ownerId 列出"我的提问"（含回复数）
  async listMyQuestions(ownerId) {
    const all = await backend.listQuestions();
    const rc = await backend.replyCounts();
    return all
      .filter((p) => p.ownerId === ownerId)
      .map((p) => ({
        id: p.id, title: p.title, content: p.content, category: p.category,
        createdAt: p.createdAt, author: p.author || null, replyCount: rc[p.id] || 0,
      }));
  },

  // 按 ownerId 列出"我的留言"（含所属 questionId，供前端补足标题）
  async listMyReplies(ownerId) {
    const all = await backend.listAllReplies();
    return (all || [])
      .filter((r) => r.ownerId === ownerId)
      .map((r) => ({
        id: r.id, content: r.content, createdAt: r.createdAt, questionId: r.questionId,
        quoteId: r.quoteId || null, rootId: r.rootId || null, author: r.author || null,
      }));
  },

  // ---------- 诊断（排障用，不影响业务）----------
  async debug() {
    const info = {
      MODE, EXPLICIT_STORAGE,
      mode: MODE,
      mongoUriSet: !!process.env.MONGODB_URI,
      _mongoHealthy,
    };
    if (MODE === 'mongo') {
      try {
        const { db } = await getMongo();
        await db.command({ ping: 1 });
        const sample = await db.collection('questions').find({}, { projection: { _id: 0 } }).limit(1).toArray();
        info.mongo = { ok: true, questionsSample: sample.length };
        info.mongoCounts = {
          questions: await db.collection('questions').countDocuments(),
          replies: await db.collection('replies').countDocuments(),
        };
      } catch (e) {
        info.mongo = {
          ok: false,
          name: e && e.name,
          code: e && e.code,
          message: e && e.message,
        };
      }
    }
    return info;
  },
};

module.exports = store;

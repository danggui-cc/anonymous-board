'use strict';

/**
 * 欲言信箱 —— 存储层
 *
 * 支持两种后端（自动选择）：
 *  1) MongoDB（腾讯云 TencentDB for MongoDB，推荐用于生产部署）
 *     - 当环境变量配置了 MONGODB_URI 时启用
 *     - 数据存于云端 MongoDB，所有浏览器/设备共享，重启/重部署不丢
 *     - 必须与 CloudBase 云托管【同地域】，并通过云托管「内网互联」打通 VPC，
 *       容器才能用内网地址直连（公网/境外地址在容器里被墙或不可达）
 *  2) 本地文件模式（file，兜底 / 本地开发）
 *     - 数据写在 DATA_DIR/data.json，仅本机可见，重部署容器会丢
 *
 * 放弃的方案（仅作记录，勿回退）：
 *  - LeanCloud 国内版：已停止新用户注册、即将下线。
 *  - MongoDB Atlas（AWS 境外）：从 CloudBase 容器直连 *.mongodb.net 被网络层拦截
 *    （DNS 解析失败 + TLS 握手告警），实测不可用。
 *  - CloudBase 自带云数据库 / @cloudbase/node-sdk：云托管默认不注入凭据
 *    （TCB_ENV 等全 false），node-sdk 无法初始化，走不通。
 *  => 唯一又稳又不被墙的路：腾讯云境内 MongoDB + 云托管内网互联。
 */

const fs = require('fs');
const path = require('path');
const { MongoClient } = require('mongodb');

// ---------- 模式选择 ----------
const MONGO_URI = process.env.MONGODB_URI || '';
const MONGO_DB = process.env.MONGODB_DB || 'yuyan'; // 业务库名（与连接串中的认证库无关）
const EXPLICIT_STORAGE = process.env.STORAGE || '';

const MODE = (EXPLICIT_STORAGE === 'file')
  ? 'file'
  : (MONGO_URI ? 'mongo' : 'file');

// 文件模式路径
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const DATA_FILE = path.join(DATA_DIR, 'data.json');

// ===================================================================
//  MongoDB 后端（腾讯云 TencentDB for MongoDB，境内 + 内网互联）
// ===================================================================

let _client = null;
let _db = null;
let _connecting = null;

async function getDb() {
  if (_db) return _db;
  if (_connecting) return _connecting.then(() => _db);
  if (!MONGO_URI) throw new Error('MONGODB_URI 未配置，无法使用 mongo 模式');
  _connecting = (async () => {
    const client = new MongoClient(MONGO_URI, {
      serverSelectionTimeoutMS: 8000,
      socketTimeoutMS: 15000,
      maxPoolSize: 10,
    });
    await client.connect();
    _db = client.db(MONGO_DB);
    _connecting = null;
    return _db;
  })();
  return _connecting;
}

async function col(name) {
  const db = await getDb();
  return db.collection(name);
}

function mapQuestion(q) {
  if (!q) return null;
  return {
    id: q._id,
    title: q.title || '',
    content: q.content || '',
    category: q.category || '其他',
    createdAt: q.createdAt || 0,
    deleteToken: q.deleteToken || '',
    author: q.author || null,
    ownerId: q.ownerId || '',
    featured: !!q.featured,
  };
}
function mapReply(r) {
  if (!r) return null;
  return {
    id: r._id,
    questionId: r.questionId,
    content: r.content || '',
    createdAt: r.createdAt || 0,
    quoteId: r.quoteId || null,
    rootId: r.rootId || null,
    author: r.author || null,
    deleteToken: r.deleteToken || '',
    ownerId: r.ownerId || '',
  };
}

const mongoStore = {
  async init() {
    // 轻量探活：能连通即记录，失败仅告警，不影响进程
    try {
      const db = await getDb();
      await db.command({ ping: 1 });
      console.log('[storage] MongoDB 连接成功（模式 mongo）');
    } catch (e) {
      console.error('[storage] MongoDB 探活失败（仅告警，进程继续）:', e && e.message);
    }
  },
  async listQuestions() {
    const c = await col('questions');
    const arr = await c.find({}).sort({ createdAt: -1 }).toArray();
    return arr.map(mapQuestion);
  },
  async getQuestion(id) {
    const c = await col('questions');
    return mapQuestion(await c.findOne({ _id: id }));
  },
  async createQuestion(q) {
    const c = await col('questions');
    await c.insertOne({
      _id: q.id,
      title: q.title || '',
      content: q.content || '',
      category: q.category || '其他',
      createdAt: q.createdAt || Date.now(),
      deleteToken: q.deleteToken || '',
      author: q.author || null,
      ownerId: q.ownerId || '',
      featured: false,
    });
    return q;
  },
  async deleteQuestion(id, token) {
    const c = await col('questions');
    const q = await c.findOne({ _id: id });
    if (!q) return { ok: false, code: 404 };
    if (q.deleteToken !== token) return { ok: false, code: 403 };
    const rc = await col('replies');
    await rc.deleteMany({ questionId: id });
    await c.deleteOne({ _id: id });
    return { ok: true };
  },
  async adminDeleteQuestion(id) {
    const c = await col('questions');
    const q = await c.findOne({ _id: id });
    if (!q) return { ok: false, code: 404 };
    const rc = await col('replies');
    await rc.deleteMany({ questionId: id });
    await c.deleteOne({ _id: id });
    return { ok: true };
  },
  async listReplies(qid) {
    const c = await col('replies');
    const arr = await c.find({ questionId: qid }).sort({ createdAt: 1 }).toArray();
    return arr.map(mapReply);
  },
  async createReply(r) {
    const c = await col('replies');
    await c.insertOne({
      _id: r.id,
      questionId: r.questionId,
      content: r.content || '',
      createdAt: r.createdAt || Date.now(),
      deleteToken: r.deleteToken || '',
      quoteId: r.quoteId || null,
      rootId: r.rootId || null,
      author: r.author || null,
      ownerId: r.ownerId || '',
    });
    return r;
  },
  async deleteReply(id, token) {
    const c = await col('replies');
    const r = await c.findOne({ _id: id });
    if (!r) return { ok: false, code: 404 };
    if (r.deleteToken !== token) return { ok: false, code: 403 };
    await c.deleteOne({ _id: id });
    return { ok: true };
  },
  async adminDeleteReply(id) {
    const c = await col('replies');
    const r = await c.findOne({ _id: id });
    if (!r) return { ok: false, code: 404 };
    await c.deleteOne({ _id: id });
    return { ok: true };
  },
  async setFeatured(id, val) {
    const c = await col('questions');
    const q = await c.findOne({ _id: id });
    if (!q) return { ok: false, code: 404 };
    await c.updateOne({ _id: id }, { $set: { featured: !!val } });
    return { ok: true };
  },
  async replyCounts() {
    const c = await col('replies');
    const arr = await c.find({}, { projection: { questionId: 1 } }).toArray();
    const counts = {};
    for (const r of arr) {
      if (r.questionId) counts[r.questionId] = (counts[r.questionId] || 0) + 1;
    }
    return counts;
  },
  async createUser(u) {
    const c = await col('accounts');
    const existing = await c.findOne({ _id: u.id });
    if (existing) return { existed: true };
    await c.insertOne({ _id: u.id, salt: u.salt, pwdHash: u.pwdHash });
    return { existed: false };
  },
  async getUserSalt(id) {
    const c = await col('accounts');
    const a = await c.findOne({ _id: id }, { projection: { salt: 1 } });
    return a ? a.salt : null;
  },
  async verifyUser(id, pwdHash) {
    const c = await col('accounts');
    const a = await c.findOne({ _id: id });
    return !!a && a.pwdHash === pwdHash;
  },
  async listMyQuestions(ownerId) {
    const c = await col('questions');
    const arr = await c.find({ ownerId }).sort({ createdAt: -1 }).toArray();
    return arr.map(mapQuestion);
  },
  async listMyReplies(ownerId) {
    const c = await col('replies');
    const arr = await c.find({ ownerId }).sort({ createdAt: -1 }).toArray();
    return arr.map(mapReply);
  },
  async debug() {
    const info = {
      MODE, EXPLICIT_STORAGE, mode: MODE,
      mongoConfigured: !!MONGO_URI,
      mongoDb: MONGO_DB,
    };
    if (MODE === 'mongo') {
      try {
        const db = await getDb();
        await db.command({ ping: 1 });
        const qc = await col('questions');
        const rc = await col('replies');
        info.mongo = {
          ok: true,
          questionCount: await qc.countDocuments({}),
          replyCount: await rc.countDocuments({}),
        };
      } catch (e) {
        info.mongo = { ok: false, name: e && e.name, message: e && e.message };
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
const store = MODE === 'mongo' ? mongoStore : fileStore;
store.mode = MODE;
store.init = MODE === 'mongo' ? mongoStore.init : fileStore.init;
module.exports = store;

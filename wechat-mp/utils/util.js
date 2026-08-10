// 欲言信箱 —— 小程序通用工具

function fmtDate(ts, withTime) {
  const d = new Date(ts);
  const p = (n) => String(n).padStart(2, '0');
  const base = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  if (withTime) return `${base} ${p(d.getHours())}:${p(d.getMinutes())}`;
  return base;
}

function randomStr(len) {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let s = '';
  for (let i = 0; i < len; i++) s += chars.charAt(Math.floor(Math.random() * chars.length));
  return s;
}

function makeId() {
  return randomStr(20);
}

module.exports = { fmtDate, randomStr, makeId };

'use strict';
/*
 * 欲言信箱 —— 匿名身份生成（共享模块）
 *
 * 规则（对应需求）：同一个"留言区"（即同一个问题）内，同一位留言者保持
 * 同一个随机昵称 / 头像 / 颜色；换一个问题则重新随机。
 * 昵称库含两类：①清新风格（前缀+后缀，如"灵气少女"）；②动植物趣味昵称
 * （前缀短语+动物/植物名词，如"爱吃竹子的小熊猫""天天向上的大竹子"）。
 *
 * 实现方式：发布问题时按问题 id 在 localStorage 存一份"访客身份"，该问题下
 * 本人后续的所有留言都复用这份身份；身份随发言数据一起存到后端，因此所有
 * 浏览者看到的是同一个昵称（展示一致性）。无身份数据时按 id 确定性兜底，
 * 保证刷新后不变。
 */
(function () {
  const NICK_PRE = ['灵气', '公子', '温柔', '清冷', '慵懒', '元气', '神秘', '佛系', '酷飒', '软萌',
    '痞帅', '知性', '落拓', '澄澈', '疏离', '热忱', '傲娇', '通透', '儒雅', '飒沓',
    '森系', '雾感', '薄荷', '奶油', '盐系', '清欢', '听风', '拾光', '栖野', '微光'];
  const NICK_SUF = ['少女', '公子', '旅人', '诗人', '匠人', '行者', '听者', '隐者', '园丁', '画师',
    '歌者', '过客', '少年', '先生', '姑娘', '学徒', '主理人', '哥', '客', '友'];
  const AV = ['🐱', '🐶', '🦊', '🐼', '🐧', '🦉', '🐢', '🐙', '🦁', '🐯', '🐸', '🐵', '🐰', '🐻',
    '🌿', '🍃', '🌸', '🌟', '🪷', '🌙'];
  const COLOR = ['#E3EFE8', '#E6F6FF', '#FFF1E6', '#E9FBF0', '#FDEAF3', '#F3EEFF', '#FFF7E0', '#EAF4F4', '#FBEFF6'];

  // 动植物趣味昵称：前缀（动作/状态短语）+ 动物/植物名词
  const FUN_PRE = [
    '爱吃竹子的', '天天向上的', '爱睡觉的', '慢吞吞的', '圆滚滚的',
    '毛茸茸的', '爱晒太阳的', '躲在树洞的', '偷偷摸鱼的', '认真搬砖的',
    '爱发呆的', '一闪一闪的', '蹦蹦跳跳的', '爱看云朵的', '不慌不忙的',
    '胖乎乎的', '爱臭美的', '顶着露珠的', '哼着歌的', '爱追风的',
    '懒洋洋的', '亮晶晶的', '爱打盹的', '好奇心重的', '慢半拍的',
    '爱囤零食的', '喜欢发光的', '踩着落叶的', '爱钻牛角尖的', '想躺平的',
  ];
  const FUN_NOUN = [
    '小熊猫', '大熊猫', '小松鼠', '小刺猬', '小狐狸', '小兔子', '小鲸鱼',
    '小蜗牛', '小青蛙', '小企鹅', '老乌龟', '小蜜蜂', '小蝴蝶', '小猫咪',
    '大老虎', '小羊驼', '小麋鹿', '小海獭', '小浣熊', '小水獭', '小考拉',
    '小锦鲤', '小橘猫', '小麻雀', '小瓢虫', '小刺豚', '小珊瑚', '胖橘猫',
    '银杏树', '小蘑菇', '含羞草', '向日葵', '小蒲公英', '红枫叶', '小荷花',
    '小竹子', '大竹子', '小雏菊', '小苔藓', '小松树', '小芦苇', '小榕树',
  ];

  function pick(arr, r) { return arr[Math.floor(r * arr.length) % arr.length]; }

  // 约一半概率生成"动植物趣味昵称"，其余沿用原有的清新风格
  function genIdentity() {
    const r1 = Math.random(), r2 = Math.random(), r3 = Math.random(), r4 = Math.random();
    if (Math.random() < 0.5) {
      return {
        nickname: pick(FUN_PRE, r1) + pick(FUN_NOUN, r2),
        avatar: pick(AV, r3),
        color: pick(COLOR, r4),
      };
    }
    return {
      nickname: pick(NICK_PRE, r1) + pick(NICK_SUF, r2),
      avatar: pick(AV, r3),
      color: pick(COLOR, r4),
    };
  }

  const VISITOR_KEY = 'yyx_visitor_';
  function getVisitor(qid) {
    try { return JSON.parse(localStorage.getItem(VISITOR_KEY + qid)); } catch (e) { return null; }
  }
  function setVisitor(qid, v) {
    try { localStorage.setItem(VISITOR_KEY + qid, JSON.stringify(v)); } catch (e) {}
  }
  // 同一问题下，本人身份保持一致；首次出现时生成并缓存
  function getOrCreateVisitor(qid) {
    let v = getVisitor(qid);
    if (!v) { v = genIdentity(); setVisitor(qid, v); }
    return v;
  }

  // 确定性兜底：无存储身份时，按 id 生成稳定昵称（刷新/跨端一致）
  function deterministicAuthor(seed) {
    const s = String(seed || '');
    let h = 0;
    for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
    if ((h & 1) === 1) {
      return {
        nickname: pick(FUN_PRE, (h & 0xffff) / 0xffff) + pick(FUN_NOUN, ((h >> 6) & 0xffff) / 0xffff),
        avatar: pick(AV, ((h >> 12) & 0xffff) / 0xffff),
        color: pick(COLOR, ((h >> 18) & 0xffff) / 0xffff),
      };
    }
    return {
      nickname: pick(NICK_PRE, (h & 0xffff) / 0xffff) + pick(NICK_SUF, ((h >> 6) & 0xffff) / 0xffff),
      avatar: pick(AV, ((h >> 12) & 0xffff) / 0xffff),
      color: pick(COLOR, ((h >> 18) & 0xffff) / 0xffff),
    };
  }

  // 取某条发言的展示身份（优先存好的，否则按 id 兜底）
  function authorOf(item) {
    if (item && item.author && item.author.nickname) return item.author;
    return deterministicAuthor(item ? item.id : '');
  }

  window.YuyanIdentity = {
    genIdentity, getVisitor, setVisitor, getOrCreateVisitor,
    deterministicAuthor, authorOf, NICK_PRE, NICK_SUF, AV, COLOR,
  };
})();

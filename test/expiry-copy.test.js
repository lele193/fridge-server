/**
 * expiry-copy.test.js —— 右侧文案的三档规则。
 *
 *   已过期                     → 「已过期 N 天」（反白）
 *   有保质期且 ≤ 10 天          → 「还剩 N 天 · X 份」
 *   其余（没设保质期 / 还早）    → 「放了 N 天 · X 份」
 *
 * 为什么要分档而不是「有保质期就显示还剩几天」：用户说「保质期半年」的时候
 * 「还剩 180 天」没有任何行动价值，那时候「放了 12 天」才是他会行动的依据。
 * 临期提示的价值在于「该动了」，不在于复述日期。
 *
 * 特别要盯住 expireAt = 0：那是「没设保质期」，不是「今天到期」。
 * 早先的写法会把这类东西显示成「还剩 0 天」，整屏看着全是临期。
 */

const test = require('node:test');
const assert = require('assert');

const { renderHome } = require('../lib/screen');
const { FRAME } = require('../lib/render');

const DAY = 86400000;
const NOW = new Date('2026-09-29T12:00:00Z').getTime();

/** 渲染一屏，把右侧区域（x >= 250）的位图解出来看有没有墨迹 */
function rightSideInk(items) {
  const s = renderHome(items, { now: NOW, household: '我家', total: items.length, expiring: 0 });
  const rle = Buffer.from(s.data, 'base64');
  const fb = Buffer.alloc(15000);
  let w = 0;
  for (let i = 0; i < rle.length; i += 2) {
    for (let k = 0; k < rle[i] && w < 15000; k++) fb[w++] = rle[i + 1];
  }
  let ink = 0;
  for (let y = 46; y < 68; y++) {
    for (let x = 250; x < FRAME.W; x++) {
      if ((fb[y * 50 + (x >> 3)] >> (7 - (x & 7))) & 1) ink++;
    }
  }
  return ink;
}

/** 同一个字符串渲染两次必须同 hash —— 文案变了 hash 才会变 */
function hashOf(items) {
  return renderHome(items, { now: NOW, household: '我家', total: items.length, expiring: 0 }).hash;
}

const mk = (over = {}) => ({
  id: '1', name: '鸡蛋', qty: 1, unit: '份',
  createdAt: NOW - 2 * DAY, expireAt: 0, ...over,
});

test('expireAt = 0（没设保质期）走「放了 N 天」，不显示「还剩 0 天」', () => {
  const items = [mk({ expireAt: 0 })];
  assert.ok(rightSideInk(items) > 0, '右侧应该有字');
  // 「还剩 0 天」比「放了 2 天」多一个字，墨迹量不同
  const noDate = hashOf(items);
  const asIfToday = hashOf([mk({ expireAt: NOW })]);
  assert.notStrictEqual(noDate, asIfToday, '没设保质期 ≠ 今天到期，两者文案必须不同');
});

test('保质期 3 天 → 「还剩 3 天」，墨迹量少于「放了 N 天」那一档', () => {
  const soon = rightSideInk([mk({ expireAt: NOW + 3 * DAY })]);
  const far = rightSideInk([mk({ expireAt: NOW + 60 * DAY })]);
  assert.ok(soon > 0 && far > 0);
  assert.notStrictEqual(soon, far, '3 天内和 60 天后必须是两种文案');
});

test('保质期 10 天和 11 天是分界（EXPIRY_SOON_DAYS = 10）', () => {
  const at10 = hashOf([mk({ expireAt: NOW + 10 * DAY })]);
  const at11 = hashOf([mk({ expireAt: NOW + 11 * DAY })]);
  const far = hashOf([mk({ expireAt: NOW + 60 * DAY })]);
  assert.notStrictEqual(at10, at11, '10 天和 11 天分属两档');
  assert.strictEqual(at11, far, '超过 10 天都走「放了 N 天」那一档');
});

test('已过期 → 反白标签，不走「还剩」那一档', () => {
  const s = renderHome([mk({ expireAt: NOW - 3 * DAY })], {
    now: NOW, household: '我家', total: 1, expiring: 0,
  });
  const rle = Buffer.from(s.data, 'base64');
  const fb = Buffer.alloc(15000);
  let w = 0;
  for (let i = 0; i < rle.length; i += 2) {
    for (let k = 0; k < rle[i] && w < 15000; k++) fb[w++] = rle[i + 1];
  }
  // 反白标签是涂黑一块再翻字：那块区域的黑点数应该远多于普通文字
  let dark = 0;
  for (let y = 46; y < 68; y++) {
    for (let x = 250; x < FRAME.W; x++) {
      if ((fb[y * 50 + (x >> 3)] >> (7 - (x & 7))) & 1) dark++;
    }
  }
  const plain = (() => {
    const s2 = renderHome([mk({ expireAt: 0 })], { now: NOW, household: '我家', total: 1, expiring: 0 });
    const r2 = Buffer.from(s2.data, 'base64');
    const f2 = Buffer.alloc(15000);
    let w2 = 0;
    for (let i = 0; i < r2.length; i += 2) {
      for (let k = 0; k < r2[i] && w2 < 15000; k++) f2[w2++] = r2[i + 1];
    }
    let d = 0;
    for (let y = 46; y < 68; y++) {
      for (let x = 250; x < FRAME.W; x++) {
        if ((f2[y * 50 + (x >> 3)] >> (7 - (x & 7))) & 1) d++;
      }
    }
    return d;
  })();
  assert.ok(dark > plain * 3, `反白块应该是一片黑，实际 ${dark} vs 普通文字 ${plain}`);
});

test('今天到期（days = 0）算「还剩 0 天」而不是「已过期」', () => {
  const today = hashOf([mk({ expireAt: NOW + 3600000 })]);   // 还剩 1 小时
  const expired = hashOf([mk({ expireAt: NOW - 3600000 })]); // 过了 1 小时
  assert.notStrictEqual(today, expired, '今天到期和已经过期是两回事');
});

test('回归：默认到期日是 9999 年，不是 0', () => {
  const { NO_EXPIRY } = require('../lib/repo');
  const { renderHome } = require('../lib/screen');

  /* 0 在时间戳里是 1970-01-01。漏掉「为 0 当没有」的判断就会算出
   * days = (0 - now)/DAY = -20726 → 屏幕显示「已过期 20726 天」，
   * 而且这个数每天还在涨。踩过，所以钉死。 */
  assert.ok(NO_EXPIRY > Date.UTC(9999, 0, 1), '默认到期日必须在 9999 年之后');

  /* 屏上表现必须一致：两条都显示「放了 N 天 · 6 份」。
   * 0 走 daysLeft 的 null 分支，9999 年走大正数分支，
   * 两条分支殊途同归 —— 换句话说换掉默认值不影响用户看到的东西，
   * 只是把「万一漏判就是 -20726 天」这个雷拆了。 */
  assert.strictEqual(
    hashOf([mk({ expireAt: 0 })]),
    hashOf([mk({ expireAt: NO_EXPIRY })]),
    '0 和 9999 年在屏上必须长得一样（都是「放了 N 天」那一档）',
  );
});

test('9999 年不会被判成临期，且排在过期项之后', () => {
  const { NO_EXPIRY, isExpired, sortForDisplay } = require('../lib/repo');
  const noDate = { id: 1, name: '排骨', qty: 1, expireAt: NO_EXPIRY, createdAt: NOW - 2 * DAY };
  const old = { id: 2, name: '三文鱼', qty: 1, expireAt: NOW - 1 * DAY, createdAt: NOW - 9 * DAY };

  assert.strictEqual(isExpired(noDate, NOW), false, '9999 年不算过期');
  assert.deepStrictEqual(
    sortForDisplay([noDate, old], NOW).map((x) => x.name),
    ['三文鱼', '排骨'],
    '过期的排前面，9999 年的排后面',
  );
});

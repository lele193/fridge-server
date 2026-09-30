/**
 * expireAt 的单位与范围 —— 回归测试。
 *
 * 起因：固件 DoAdd 里 `mktime()` 返回「秒」却直接和毫秒天数相加，
 * 于是用户说「保质期十天后」存进去的是 1970 年附近的值，
 * 屏幕上显示「已过期 20695 天」。20695 = 1970-01-01 到今天的天数 ——
 * 这个数字本身就是「单位错了」的证据。
 *
 * 这里测两端：云端要独立守住（不能指望固件永远传对），
 * 且和固件的合法取值区间一致。
 */
const test = require('node:test');
const assert = require('node:assert');

const DAY = 86400000;

/* 与 lib/endpoints.js 里的判据保持一致。改动时两边都要改。 */
const MIN_EXP_MS = 1e12;   // 2001-09-09
const MAX_EXP_MS = 4e12;   // 2096-05-12

/** 云端判定：什么值算「用户明确说了保质期」 */
function decideExpireAt(raw) {
  const v = Number(raw);
  if (Number.isFinite(v) && v >= MIN_EXP_MS && v <= MAX_EXP_MS) return v;
  return null;   // → NO_EXPIRY
}

test('正常的毫秒时间戳被接受', () => {
  const now = Date.now();
  const exp = Math.floor(now / DAY) * DAY + 10 * DAY;   // 10 天后零点
  assert.strictEqual(decideExpireAt(exp), exp);
});

test('秒级时间戳被拒 —— 这就是「已过期 20695 天」的成因', () => {
  // 2024-01-31 的秒级时间戳。固件那次传的就是它。
  const SECONDS = 1706659200;
  assert.strictEqual(decideExpireAt(SECONDS), null);

  // 确认它确实会被误显示成 1970 年的日期
  const asMs = new Date(SECONDS);
  assert.strictEqual(asMs.getUTCFullYear(), 1970);
});

test('0 和缺省值 = 「没设保质期」，不是「永久」', () => {
  assert.strictEqual(decideExpireAt(0), null);
  assert.strictEqual(decideExpireAt(undefined), null);
  assert.strictEqual(decideExpireAt(''), null);
  assert.strictEqual(decideExpireAt(null), null);
});

test('天数值（10 = 10 天）被拒 —— 不能当时间戳', () => {
  // 固件如果忘了乘 1000，天数会被直接塞进 expireAt
  for (const d of [1, 3, 10, 30, 365]) {
    assert.strictEqual(decideExpireAt(d), null, `天数 ${d} 不该被当成时间戳`);
  }
});

test('超出上限的值被拒（> 10 年）', () => {
  assert.strictEqual(decideExpireAt(MAX_EXP_MS + 1), null);
  // 固件属性里 expireDays 上限 3650，对应约 10 年
  const tenYears = Date.now() + 3650 * DAY;
  assert.strictEqual(decideExpireAt(tenYears), tenYears);
});

test('NaN / 负数 / 非数字被拒', () => {
  for (const v of [NaN, -1, -86400000, 'abc', {}, []]) {
    assert.strictEqual(decideExpireAt(v), null, `${String(v)} 不该被接受`);
  }
});

test('固件 DoAdd 的换算：mktime 是秒，必须乘 1000', () => {
  // 复现固件那行代码的正确与错误两种写法。
  // 用「当前时间」而不是固定常数 —— 固定值会随日历漂移，
  // 断言「新时间在将来」在跨年之后必然失败（踩过一次）。
  const seconds = Math.floor(Date.now() / 1000);
  const days = 10;

  const WRONG = seconds + days * DAY;            // 原来：秒 + 毫秒 = 混单位
  const RIGHT = seconds * 1000 + days * DAY;     // 现在：毫秒 + 毫秒

  // 错的落回 1970 年，且被云端拒
  assert.ok(new Date(WRONG).getUTCFullYear() < 2001,
    `错误写法应落在 2001 年之前，实际 ${new Date(WRONG).toISOString()}`);
  assert.strictEqual(decideExpireAt(WRONG), null);

  // 对的是合理的未来时间，且被云端接受
  assert.strictEqual(decideExpireAt(RIGHT), RIGHT);
  assert.ok(new Date(RIGHT).getTime() > Date.now(), '正确写法应落在将来');
});

test('两条路径的合法区间一致（固件上限 3650 天 ↔ 云端上界）', () => {
  // 固件 Property("expireDays", Integer, 0, 0, 3650)
  const maxByFirmware = Date.now() + 3650 * DAY;
  assert.ok(decideExpireAt(maxByFirmware) !== null, '固件允许的最大天数应被云端接受');

  // 云端上界 4e12 毫秒 ≈ 2096 年，远大于固件的 10 年上限
  const maxByCloud = MAX_EXP_MS;
  assert.ok(maxByCloud > maxByFirmware, '云端上界应宽于固件上限');
});

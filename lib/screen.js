/**
 * screen.js —— 冰箱列表页的实际排版。
 *
 * 排版全在云端做，固件只灌位图（README：「固件不做排版」）。所以改版式
 * 只要改这里，不用重刷设备 —— 但墨水屏全刷一秒多且肉眼可见地闪，
 * 一次 sync 只刷一次，聊天字幕不能来一句刷一次。
 */

const {
  FRAME, RESERVED, Canvas, text, measure, ellipsize, rleEncode, fontAt, glyphOf,
} = require('./render');

const MARGIN = 10;

/* 版式自上而下：
 *   0 .. 31   反白条：左边「我家冰箱」，右边「N 样在库」，都是黑底白字
 *   40        点状分隔线
 *   46 起     列表第一行
 *
 * 「N 样在库」原来单独占一行（在反白条下面），后来挪进了反白条右侧。
 * 墨水屏上黑条是唯一的强对比锚点，计数放在里面比放在白底上显眼得多；
 * 而且省下一行 30px 的高度，列表能多显示一行（6 → 7 行）。
 *
 * 条高 BAR_H 才是列表起点该参考的东西：RULE_Y 从它下面量，不是从
 * BAR_H。留 8px 呼吸位，LIST_TOP 再往下留 6px，点状线不会贴着第一行。 */
const BAR_H = 32;
const RULE_Y = BAR_H + 8;
const LIST_TOP = RULE_Y + 6;
const LIST_ROW_H = 30;
const MAX_ROWS = Math.floor((RESERVED.y - 4 - LIST_TOP) / LIST_ROW_H);

/** 剩余天数的分档：跟固件端 speakQueue 的 level 命名保持一致 */
function levelOf(days) {
  if (days < 0) return 'OD';
  if (days === 0) return 'D0';
  return 'D-1';
}

/** level 的显示文案 */
function levelText(days) {
  if (days < 0) return '已过期';
  if (days === 0) return '今天';
  if (days === 1) return '明天';
  return `${days}天`;
}

/** 食材已在冰箱里放了几天（按入库时间算，非保质期） */
function storedDays(createdAt, now) {
  if (!createdAt) return 0;
  return Math.max(0, Math.floor((now - createdAt) / 86400000));
}

/** 虚线：原作者的版式用点状分隔，实线太重 */
function dline(cv, x, y, w, on = 2, off = 2) {
  for (let i = 0; i < w; i += on + off) {
    for (let k = 0; k < on; k++) cv.dot(x + i + k, y);
  }
}

/**
 * 一串字在指定字号下的墨迹范围（相对基线）。
 *
 * text()/invertText() 的 y 是**行盒顶**，基线在 y + ascent，所以调用点
 * 真正想说的是「这行字放在带的正中间」，得先量墨迹。不量的话，20px 的
 * 「我家冰箱」（墨迹 18px）和 24px 的计数「4」（墨迹 19px）会一头高一头低，
 * 而计数又紧贴右边缘，看着就像右上角缺了一块。
 *
 * g.top 是墨迹顶端离基线多少（向上为正），所以底端在 g.top - g.h 处。
 */
function inkMetrics(str, size) {
  let top = -Infinity, bot = Infinity;
  for (const ch of String(str)) {
    const g = glyphOf(size, ch);
    if (!g || !g.h) continue;
    if (g.top > top) top = g.top;
    if (g.top - g.h < bot) bot = g.top - g.h;
  }
  if (!Number.isFinite(top)) return { top: 0, height: 0 };
  return { top, height: top - bot };
}

/**
 * 让一串字在 bandTop..bandTop+bandH 这条带里垂直居中，返回该传给
 * text()/invertText() 的 y（行盒顶）。
 *
 * inkTop = y + ascent - g.top，所以要反解 y = inkTop - ascent + g.top。
 */
function lineTopForCentered(str, size, bandTop, bandH) {
  const font = fontAt(size);
  const m = inkMetrics(str, size);
  if (!m.height || !font) return bandTop;
  const inkTop = bandTop + (bandH - m.height) / 2;
  return Math.round(inkTop - font.ascent + m.top);
}

/**
 * 在**已涂黑的区域**上画反白文字。
 *
 * 1bpp 只有一个位，「黑底白字」只能靠翻色实现。对每个字形内的像素：
 *   原字是黑点(1) → 翻成白（清除）
 *   原字是空白(0) → 翻成黑（落墨）
 *
 * **只翻字形覆盖的那块矩形，字外不动。** 早期版本先把整个 adv×h
 * 矩形清白再补黑点，结果字与字之间的空隙也成了白色 —— 屏幕上就是
 * 每个字被一圈白框包着、彼此粘连。
 */
function invertText(cv, str, x, y, size) {
  const font = fontAt(size);
  let cx = x;
  for (const ch of String(str)) {
    const g = glyphOf(size, ch);
    if (!g) { cx += (font ? font.ascent : size) * 0.6; continue; }
    const top = y + font.ascent - g.top;
    if (g.pixels) {
      const stride = (g.w + 7) >> 3;
      for (let row = 0; row < g.h; row++) {
        const py = top + row;
        if (py < 0 || py >= cv.h) continue;
        for (let px = 0; px < g.w; px++) {
          const bit = (g.pixels[row * stride + (px >> 3)] >> (7 - (px & 7))) & 1;
          const absX = cx + px;
          if (absX < 0 || absX >= cv.w) continue;
          if (bit) cv.clear(absX, py, 1, 1);   // 原黑点 → 白
          else cv.dot(absX, py);               // 原空白 → 黑
        }
      }
    }
    cx += g.adv;
  }
  return cx;
}

function daysLeft(expireAt, now) {
  if (!expireAt) return null;
  return Math.ceil((expireAt - now) / 86400000);
}

/**
 * 渲染首页。
 *
 * @param items   已按到期时间排好序的食材
 * @param opts.now       当前服务端时间（ms）
 * @param opts.household 家庭名
 * @param opts.total     该家庭的食材总数（含被折叠的）
 * @param opts.expiring  3 天内到期的数量
 */
function renderHome(items, opts = {}) {
  const now = opts.now ?? Date.now();
  const cv = new Canvas(FRAME.W, FRAME.H);

  // ── 顶部反白条：左边标题，右边「N 样在库」 ──
  // 墨水屏是 1bpp，反白条是最好的视觉锚点。字用 invertText 画，
  // 白底紧贴字形 —— 用 clear+text 的写法会在黑条上留下一圈白框。
  //
  // **两串字都按墨迹垂直居中，不按基线。** 条高 BAR_H = 32，
  // 标题（20px，18px 高）和「样在库」（20px，18px 高）墨迹高度一致，
  // 数字用 24px（19px 高）；直接给 y 会出现一头高一头低。
  cv.fill(0, 0, FRAME.W, BAR_H);
  const title = opts.household ? `${opts.household}冰箱` : '冰箱';
  invertText(cv, title, MARGIN, lineTopForCentered(title, 20, 0, BAR_H), 20);

  /* 计数整组右对齐：数字 24px + 「样在库」20px。
   *
   * 分两次画而不是拼成一句话 —— invertText 一��只吃一个字号，
   * 数字用大字才压得住。组宽 = 数字宽 + 6px 间隔 + 后缀宽，
   * 整组从右边缘往左排，右边距和标题左边距都是 MARGIN。 */
  const total = opts.total ?? items.length;
  const suffix = items.length ? '样在库' : '样';
  const num = String(total);
  const NUM_SIZE = 24;
  const SUF_SIZE = 20;
  const GAP = 6;
  const numW = measure(num, NUM_SIZE);
  const sufW = measure(suffix, SUF_SIZE);
  const groupRight = FRAME.W - MARGIN;
  const sufX = groupRight - sufW;
  const numX = sufX - GAP - numW;

  invertText(cv, num, numX, lineTopForCentered(num, NUM_SIZE, 0, BAR_H), NUM_SIZE);
  invertText(cv, suffix, sufX, lineTopForCentered(suffix, SUF_SIZE, 0, BAR_H), SUF_SIZE);

  // ── 分隔线 ──
  dline(cv, MARGIN, RULE_Y, FRAME.W - MARGIN * 2);

  // ── 列表 ──
  if (!items.length) {
    text(cv, '冰箱是空的', MARGIN, LIST_TOP + 40, 24);
    text(cv, '说「加入 鸡蛋」就能加进来', MARGIN, LIST_TOP + 76, 16);
    return finish(cv);
  }

  const shown = items.slice(0, MAX_ROWS);
  shown.forEach((it, i) => {
    const y = LIST_TOP + i * LIST_ROW_H;
    const days = daysLeft(it.expireAt, now);

    // 右侧文案：过期用「已过期 N 天」，否则「放了 N 天 · X 份」
    const put = it.qty > 1 ? `${it.qty} 份` : '1 份';
    const right = days !== null && days < 0
      ? `已过期 ${Math.abs(days)} 天`
      : `放了 ${storedDays(it.createdAt, now)} 天 · ${put}`;
    const rightW = measure(right, 16);

    text(cv, ellipsize(it.name, 20, FRAME.W - MARGIN * 2 - rightW - 16), MARGIN, y, 20);

    // 过期的那行右侧反白，一眼能扫到。
    // 用 invertText：白底紧贴字形。之前 fill+clear+text 的写法把 clear
    // 范围取成 rightW+2，两侧多出的白边让「份」这类窄字看着像糊在一起。
    const bad = days !== null && days < 0;
    if (bad) {
      const rx = FRAME.W - MARGIN - rightW;
      const BADGE_H = 22;
      cv.fill(rx, y + 1, rightW + 4, BADGE_H);
      // 反白块高 22、字号 16 的墨迹 16px —— 同样按墨迹居中，
      // 别拿 y+3 硬凑，否则「已过期」四个字会整体偏下。
      invertText(cv, right, rx + 2, lineTopForCentered(right, 16, y + 1, BADGE_H), 16);
    } else {
      text(cv, right, FRAME.W - MARGIN - rightW, y + 2, 16);
    }

    // 行间点线
    if (i < shown.length - 1) dline(cv, MARGIN, y + 26, FRAME.W - MARGIN * 2);
  });

  // ── 底部摘要（避开右边的固件自绘区） ──
  /* 底部不画摘要 —— 原作者的版式底部只有固件自绘的时间和电量，
   * 左边留白比塞一行小字干净。 */
  return finish(cv);
}

/** 渲染空/错状态，云端出错时也能给屏一个有意义的画面 */
function renderNotice(title, sub) {
  const cv = new Canvas(FRAME.W, FRAME.H);
  text(cv, title, MARGIN, 100, 32);
  if (sub) text(cv, ellipsize(sub, 16, FRAME.W - MARGIN * 2), MARGIN, 150, 16);
  return finish(cv);
}

/**
 * 收尾：强制清空固件自绘区，再算 hash。
 *
 * hash 覆盖的是**清理之后**的 RLE —— 设备回报 hash 时比的就是这个值。
 * 顺序反了的话每次 sync 都会判成「变了」，墨水屏全刷一遍又一遍，
 * 一块墨水屏的刷新次数是有限的。
 */
function finish(cv) {
  cv.clear(RESERVED.x, RESERVED.y, RESERVED.w, RESERVED.h);
  const rle = rleEncode(cv.buf);
  const { createHash } = require('crypto');
  const hash = createHash('sha256').update(rle).digest('hex').slice(0, 40);
  return { data: rle.toString('base64'), hash, bytes: rle.length, raw: cv.buf };
}

module.exports = {
  renderHome, renderNotice, levelOf, levelText, daysLeft, storedDays,
  MAX_ROWS, MARGIN, BAR_H, inkMetrics, lineTopForCentered,
};

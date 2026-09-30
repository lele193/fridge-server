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
 *   0 .. 35   反白条：左边「我家冰箱」，右边「N 样在库」，都是黑底白字
 *   42 起     列表第一行，8 行 × 28px，到 y≈258
 *   268       底部点状分割线
 *   272 起    固件自绘区（时间 + 电量），云端不碰
 *
 * 「N 样在库」原来单独占一行（在反白条下面），后来挪进了反白条右侧。
 * 墨水屏上黑条是唯一的强对比锚点，计数放在里面比放在白底上显眼得多；
 * 而且省下一行 30px 的高度，列表能多显示一行（6 → 7 行）。
 *
 * **列表上方那条点状线去掉了**：黑条下沿本身就是一条硬边，再叠一条点线
 * 是双重强调 —— 空隙还被它一分为二，反而显得挤。
 *
 * ── 7 行 → 8 行，以及后来「均分」的账 ──
 *
 * 实测（tools 里量过，不靠估）：一行的墨迹占 y+1 .. y+20，**20px 是反白块
 * 贡献的**（名字 20px 字只有 18px，右边 16px 字只有 15px）。
 *
 * 关键约束是**上下两头都在抢空间**：黑条要长（字要 32px），底部点线要贴
 * 固件时间条（272）。中间能给的只有 42..258 = 216px，8 行正好 28px 一行 ——
 * 不是凑出来的，是**除出来的**（216 ÷ 8 = 27，向上取整到 28 留 8px 余量）。
 *
 * 8 行 28px 是这套版式的天花板：再高黑条就装不下 32px 的字，
 * 再低第 8 行的反白块就撞上点线。 */
const BAR_H = 36;
const LIST_TOP = BAR_H + 6;
const LIST_ROW_H = 28;
const ROW_DLINE_DY = 24;   /* 行间点线距行顶 */

/* 底部那条点状分割线。**这是唯一定死位置的线** —— MAX_ROWS 由它算，
 * 所以「最多几行」和「分割线在哪」永远是同一件事，不会各自漂移。
 *
 * 268：固件时间条从 272 起，点线留 4px 就贴上去了。之前是 260（隔 12px），
 * 再之前 262（隔 10px）—— 一路往下压，因为列表变短腾出了空间，
 * 而分割线贴着下边界才说得清「时间那行属于下面这块」。 */
const RULE_Y = 268;

/* 8 行。**不写成 floor((RULE_Y - 留白) / LIST_ROW_H)** ——
 * 那样算出来是 7：点线上方留 4px 的要求在 8 行时太苛刻（实际隔了 10px，
 * 够得很）。硬写 8 但把推导留在注释里，是为了以后改版式时，
 * 谁都能看出「8 是怎么来的、为什么不是 floor 出来的」。
 *
 * 推导：可用区 LIST_TOP(42) .. RULE_Y(268) = 226px，
 * 8 行要 226/8 = 28.25 → 行高取 28（第 8 行反白块落在 258，离点线 10px）。 */
const MAX_ROWS = 8;

/* 反白块高度：16px 字的墨迹是 15px，上下各留 2.5px。 */
const BADGE_H = 20;

/* 距保质期还有多少天以内，就改成显示「还剩 N 天」而不是「放了 N 天」。
 *
 * 10 天是按「一周之内该安排吃掉」定的：保质期还剩三个月的豆奶粉，
 * 「还剩 90 天」说了等于没说，而「放了 20 天」才是用户会行动的依据。
 * 临期提示的价值在于「该动了」，不在于复述日期。 */
const EXPIRY_SOON_DAYS = 10;

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
  // **两串字都按墨迹垂直居中，不按基线。** 条高 BAR_H = 36，
  // 两边都用 32px（墨迹 30px，居中后占 3..32）—— 同字号才有一头高一头低
  // 的问题；直接给 y 会出现一头高一头低。
  cv.fill(0, 0, FRAME.W, BAR_H);
  const title = opts.household ? `${opts.household}冰箱` : '冰箱';
  const BAR_SIZE = 32;
  invertText(cv, title, MARGIN, lineTopForCentered(title, BAR_SIZE, 0, BAR_H), BAR_SIZE);

  /* 反白条右侧：单页时是「N 样在库」，多页时改成「第 N/M 页」。
   *
   * 为什么多页时不显示总数：翻页的时候用户关心的是「还有没有下一页」，
   * 总数在每页都一样，是废话。页码才是这时候唯一有用的信息。
   * 数字用 24px（和「样在库」里的数字同级），「/」「页」用 20px。
   *
   * 分两次画而不是拼成一句话 —— invertText 一次只吃一个字号，
   * 数字用大字才压得住。 */
  const total = opts.total ?? items.length;
  const pageCount = opts.pageCount ?? 1;
  const multiPage = pageCount > 1;

  let bigStr, smallStr, GAP = 6;
  if (multiPage) {
    bigStr = `${opts.page ?? 1}/${pageCount}`;
    smallStr = '页';
  } else {
    bigStr = String(total);
    smallStr = items.length ? '样在库' : '样';
  }
  /* **两边统一 32px。**
   *
   * 原来是数字 24px + 后缀 20px 混排，看着是「标题小、数字大」。
   * 用户要的是「这栏字再大一点」—— 混排字号在 32px 字模下没有意义
   * （28 会归到 24 档），所以干脆两边都用 32。
   *
   * 32px 墨迹 30px 高，条高 36 上下各留 3px，正好。 */
  const NUM_SIZE = 32;
  const SUF_SIZE = 32;
  const numW = measure(bigStr, NUM_SIZE);
  const sufW = measure(smallStr, SUF_SIZE);
  const groupRight = FRAME.W - MARGIN;
  const sufX = groupRight - sufW;
  const numX = sufX - GAP - numW;

  invertText(cv, bigStr, numX, lineTopForCentered(bigStr, NUM_SIZE, 0, BAR_H), NUM_SIZE);
  invertText(cv, smallStr, sufX, lineTopForCentered(smallStr, SUF_SIZE, 0, BAR_H), SUF_SIZE);

  // ── 列表 ──
  const listed = items;
  if (!listed.length) {
    text(cv, '冰箱是空的', MARGIN, LIST_TOP + 40, 24);
    text(cv, '说「加入 鸡蛋」就能加进来', MARGIN, LIST_TOP + 76, 16);
    return finish(cv);
  }

  /* 只画当前页那几行。**items 由调用方按页切好**（endpoints.js 的 sync），
   * 这里不再自己 slice —— 渲染层不知道总共多少项，页码是调用方的概念。
   * 保险起见仍然截到 MAX_ROWS：调用方漏切也不会画到固件自绘区上。 */
  const shown = listed.slice(0, MAX_ROWS);
  shown.forEach((it, i) => {
    const y = LIST_TOP + i * LIST_ROW_H;
    const days = daysLeft(it.expireAt, now);

    /* 右侧文案，三档：
     *   已过期           → 「已过期 N 天」，反白
     *   有保质期且 ≤ 10 天 → 「还剩 N 天 · X 份」
     *   其余              → 「放了 N 天 · X 份」
     *
     * 为什么要分档：用户说「保质期 3 天」的时候，关心的是还剩几天；
     * 但说的是「保质期半年」的时候，「还剩 180 天」没有任何行动价值，
     * 那时候「放了 12 天」才是他真正要看的。10 天是分界线。
     *
     * **没设保质期（expireAt = 0）永远走第三档。** daysLeft 对 expireAt=0
     * 返回 null，days 就是 null，第二个条件不成立 —— 不会误显示成
     * 「还剩 0 天」把一堆没日期的东西全标成临期。 */
    const put = it.qty > 1 ? `${it.qty} 份` : '1 份';
    let right;
    if (days !== null && days < 0) {
      right = `已过期 ${Math.abs(days)} 天`;
    } else if (days !== null && days <= EXPIRY_SOON_DAYS) {
      right = `还剩 ${days} 天 · ${put}`;
    } else {
      right = `放了 ${storedDays(it.createdAt, now)} 天 · ${put}`;
    }
    const rightW = measure(right, 16);

    text(cv, ellipsize(it.name, 20, FRAME.W - MARGIN * 2 - rightW - 16), MARGIN, y, 20);

    // 过期的那行右侧反白，一眼能扫到。
    // 用 invertText：白底紧贴字形。之前 fill+clear+text 的写法把 clear
    // 范围取成 rightW+2，两侧多出的白边让「份」这类窄字看着像糊在一起。
    const bad = days !== null && days < 0;
    if (bad) {
      const rx = FRAME.W - MARGIN - rightW;
      cv.fill(rx, y + 1, rightW + 4, BADGE_H);
      // 反白块高 22、字号 16 的墨迹 16px —— 同样按墨迹居中，
      // 别拿 y+3 硬凑，否则「已过期」四个字会整体偏下。
      invertText(cv, right, rx + 2, lineTopForCentered(right, 16, y + 1, BADGE_H), 16);
    } else {
      text(cv, right, FRAME.W - MARGIN - rightW, y + 2, 16);
    }

    // 行间点线
    if (i < shown.length - 1) dline(cv, MARGIN, y + ROW_DLINE_DY, FRAME.W - MARGIN * 2);
  });

  // ── 底部：列表与固件自绘区之间的分割线 ──
  /* 右下角那行「09-30 11:35 100%」是**固件**画的（状态条带局刷，y=272 起），
   * 云端只知道那块地方要留空 —— RESERVED。
   *
   * 之前那条时间信息和上面的食材列表之间什么都没有，视觉上糊成一片：
   * 不知道那行小字是列表的一部分还是系统状态。加一条点线把两块分开，
   * 和列表行之间的分隔线同一个视觉语言。
   *
   * 位置 RULE_Y = 262：列表墨迹到 247，时间条从 272 起 ——
   * 上面留 15px，下面留 10px，**偏下**，读起来是「时间那行属于下面这块」。
   *
   * 为什么不是取正中（260）：8 行版式下列表变短了，原来 249..272 那段
   * 空隙的上半截空出来，点线就该往下让。用户说的「离时间条近一点」正是
   * 这个意思 —— 分割线的语义是「归哪边」，贴着下边界才说得清。 */
  dline(cv, MARGIN, RULE_Y, FRAME.W - MARGIN * 2);

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

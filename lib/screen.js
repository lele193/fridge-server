/**
 * screen.js —— 冰箱列表页的实际排版。
 *
 * 排版全在云端做，固件只灌位图（README：「固件不做排版」）。所以改版式
 * 只要改这里，不用重刷设备 —— 但墨水屏全刷一秒多且肉眼可见地闪，
 * 一次 sync 只刷一次，聊天字幕不能来一句刷一次。
 */

const { FRAME, RESERVED, Canvas, text, measure, ellipsize, rleEncode } = require('./render');

const MARGIN = 10;
const HEADER_H = 40;

/** 列表区可用高度：顶掉页头，再避开固件自绘区 */
const LIST_TOP = HEADER_H + 4;
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

  // ── 顶部反头条：标题 + 大号计数 ──
  // 墨水屏是 1bpp，反白条是最好的视觉锚点，一眼就知道这是冰箱页。
  cv.fill(0, 0, FRAME.W, HEADER_H - 8);
  const title = opts.household ? `${opts.household}冰箱` : '冰箱';
  // 标题画成白色：先填黑，再把字区域刷白再画字
  {
    const tw = measure(title, 20);
    cv.clear(MARGIN - 1, 6, tw + 2, 20);
    text(cv, title, MARGIN, 5, 20);
  }
  const cnt = String(items.length);
  {
    const cw = measure(cnt, 24);
    const cx = FRAME.W - MARGIN - cw;
    cv.clear(cx - 1, 3, cw + 2, 24);
    text(cv, cnt, cx, 3, 24);
  }

  // ── 计数说明行 ──
  const total = opts.total ?? items.length;
  const unitTxt = items.length ? '样在库' : '样';
  {
    const lbl = `${total} ${unitTxt}`;
    text(cv, lbl, MARGIN, HEADER_H, 20);
  }
  dline(cv, MARGIN, HEADER_H + 26, FRAME.W - MARGIN * 2);

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

    // 过期的那行整体反白，一眼能扫到
    const bad = days !== null && days < 0;
    if (bad) {
      const rx = FRAME.W - MARGIN - rightW;
      cv.fill(rx - 4, y + 1, rightW + 8, 20);
      cv.clear(rx - 1, y + 2, rightW + 2, 16);
      text(cv, right, rx, y + 2, 16);
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

module.exports = { renderHome, renderNotice, levelOf, levelText, daysLeft, MAX_ROWS, MARGIN, HEADER_H };

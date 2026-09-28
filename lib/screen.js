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

  // ── 页头 ──
  const title = opts.household ? `${opts.household}的冰箱` : '我的冰箱';
  text(cv, title, MARGIN, 4, 20);
  text(cv, `${new Date(now).getMonth() + 1}月${new Date(now).getDate()}日`,
    FRAME.W - MARGIN - measure(`${new Date(now).getMonth() + 1}月${new Date(now).getDate()}日`, 16),
    8, 16);
  cv.hline(MARGIN, HEADER_H - 6, FRAME.W - MARGIN * 2);

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

    // 名称：留出右侧天数和数量的位置
    const badgeW = measure(levelText(days ?? -1), 16) + 8;
    const qtyTxt = it.qty > 1 ? `×${it.qty}` : '';
    const qtyW = qtyTxt ? measure(qtyTxt, 16) : 0;
    const nameMax = FRAME.W - MARGIN * 2 - badgeW - qtyW - 10;

    text(cv, ellipsize(it.name, 20, nameMax), MARGIN, y, 20);

    if (qtyTxt) {
      text(cv, qtyTxt, FRAME.W - MARGIN - badgeW - qtyW, y + 6, 16);
    }

    // 到期徽标：过期反白，一眼能扫到
    if (days !== null) {
      const bw = measure(levelText(days), 16) + 10;
      const bx = FRAME.W - MARGIN - bw;
      const by = y + 2;
      const bh = 20;
      const bad = days < 0;
      if (bad) cv.fill(bx, by, bw, bh);
      cv.rect(bx, by, bw, bh);
      const fillColor = bad;
      // 反白块上的字要反过来：先画黑框，再把字区域刷白，再画字
      if (fillColor) {
        cv.fill(bx + 1, by + 1, bw - 2, bh - 2);
        text(cv, levelText(days), bx + 5, by + 1, 16);
      } else {
        text(cv, levelText(days), bx + 5, by + 1, 16);
      }
    }
  });

  // ── 底部摘要（避开右边的固件自绘区） ──
  const total = opts.total ?? items.length;
  let summary = `共 ${total} 项`;
  if (opts.expiring) summary += ` · ${opts.expiring} 项将过期`;
  if (total > shown.length) summary += ` · 还有 ${total - shown.length} 项`;
  text(cv, ellipsize(summary, 16, RESERVED.x - MARGIN * 2), MARGIN, RESERVED.y - 2, 16);

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

/**
 * render.js —— 把冰箱内容渲染成 400×300 的 1bpp 位图。
 *
 * 屏幕契约（改任何一处都要同步固件）：
 *   - PROTO_SCREEN_W/H = 400/300，PROTO_SCREEN_BYTES = 15000
 *   - 1bpp，行跨度 50 字节，位序 MSB 在左
 *   - 整帧 RLE 后 base64 下发，编码是 (count, value) 交替，count ≥ 1
 *
 * **右下角 {256,264,136,20} 由固件自绘**（时间 + 电量）并只局刷那一块。
 * 云端保证不往这块画 —— 两端各硬编码一份，改错了没有编译期提示，
 * 表现是固件把云端的字擦掉。固件那边是 zectrix_note4_board.cc 里的
 * kSelfDrawRect，本文件与之成对。
 */

const FRAME = {
  W: 400,
  H: 300,
  get BYTES() { return (this.W * this.H) >> 3; },
  get STRIDE() { return this.W >> 3; },
};

/** 固件自绘区，云端必须留空。
 *
 *  **x=0 / w=400：整条底栏都归固件。** 原来只有右侧 136px（x=256），
 *  于是固件的「读取中」三个点（相对条带 x=10）实际落在屏幕 x=266，
 *  和日期挤在一起，而左边三分之一空着 —— 三段布局摆不开。
 *  加宽之后：左 x≈10 动画点、中 x≈194 静音斜杠、右 x≈390 日期电量。
 *
 *  **加宽不损失任何绘制区**：底部这块本来就是空的可擦区，云端从没往这
 *  画过（点状分割线在 262，条带从 272 起，中间 10px 是刻意留的呼吸位）。
 *
 *  y=272 是固件 UpdateStatusStrip 的 ST_Y（条带 272..291）。这里写 270，
 *  比实际条带高 2px 当安全余量：留白多留一点没关系，撞上去就被擦了。
 *
 *  **这个值是「云端不许画」的上界，不是版式的一部分** —— MAX_ROWS 由
 *  screen.js 的 RULE_Y 算，不再由它算。之前它同时兼这两个角色，
 *  于是「挪一下时间条」会连带改变「一页显示几行」，两个不相干的决定
 *  绑在一个数字上。 */
const RESERVED = { x: 0, y: 270, w: 400, h: 20 };

// ────────────────────────── 画布 ──────────────────────────

class Canvas {
  constructor(w = FRAME.W, h = FRAME.H) {
    this.w = w;
    this.h = h;
    this.stride = w >> 3;
    this.buf = Buffer.alloc(this.stride * h); // 全 0 = 全白
  }

  /** 画一个黑点，坐标越界直接忽略（墨水屏没有半像素可言） */
  dot(x, y) {
    x |= 0; y |= 0;
    if (x < 0 || x >= this.w || y < 0 || y >= this.h) return;
    this.buf[y * this.stride + (x >> 3)] |= 0x80 >> (x & 7);
  }

  clear(x, y, w, h) {
    for (let yy = y; yy < y + h; yy++) {
      if (yy < 0 || yy >= this.h) continue;
      for (let xx = x; xx < x + w; xx++) {
        if (xx < 0 || xx >= this.w) continue;
        this.buf[yy * this.stride + (xx >> 3)] &= ~(0x80 >> (xx & 7));
      }
    }
  }

  hline(x, y, w) {
    for (let i = 0; i < w; i++) this.dot(x + i, y);
  }

  vline(x, y, h) {
    for (let i = 0; i < h; i++) this.dot(x, y + i);
  }

  rect(x, y, w, h) {
    this.hline(x, y, w);
    this.hline(x, y + h - 1, w);
    this.vline(x, y, h);
    this.vline(x + w - 1, y, h);
  }

  /** 实心矩形，裁剪到画布内 */
  fill(x, y, w, h) {
    for (let yy = y; yy < y + h; yy++) {
      if (yy < 0 || yy >= this.h) continue;
      const x0 = Math.max(0, x);
      const x1 = Math.min(this.w, x + w);
      for (let xx = x0; xx < x1; xx++) this.dot(xx, yy);
    }
  }

  /** 整帧涂黑（或涂白），用于反色显示 */
  invert() {
    for (let i = 0; i < this.buf.length; i++) this.buf[i] = ~this.buf[i] & 0xff;
  }
}

// ────────────────────────── 字模 ──────────────────────────

const atlas = require('./font-atlas.json');

/** 取指定像素尺寸的字模表；没有这个尺寸就退到最接近的 */
function fontAt(size) {
  if (atlas[size]) return atlas[size];
  const avail = Object.keys(atlas).map(Number).sort((a, b) => a - b);
  if (!avail.length) return null;
  const best = avail.reduce((a, b) => (Math.abs(b - size) < Math.abs(a - size) ? b : a));
  return atlas[best];
}

const glyphCache = new Map();

/** 解码并缓存一个字的位图 */
function glyphOf(size, ch) {
  const key = `${size}/${ch}`;
  if (glyphCache.has(key)) return glyphCache.get(key);

  const font = fontAt(size);
  let g = font && font.glyphs[ch];
  if (!g) {
    // 字模表里没有：退回全角方框，至少能看出「有个字不认识」，
    // 而不是静默少一个字导致整行往左缩
    const box = font ? font : { ascent: size, descent: 2 };
    const h = size - 1;
    g = { adv: size, w: size, h, top: 0, bmp: boxRectBitmap(size, h) };
  }
  const out = { ...g, pixels: g.bmp ? Buffer.from(g.bmp, 'base64') : null };
  glyphCache.set(key, out);
  return out;
}

/** 一个 size×h 的空心方框位图（用来看不见的字） */
function boxRectBitmap(w, h) {
  const stride = (w + 7) >> 3;
  const b = Buffer.alloc(stride * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (y === 0 || y === h - 1 || x === 0 || x === w - 1) {
        b[y * stride + (x >> 3)] |= 0x80 >> (x & 7);
      }
    }
  }
  return b.toString('base64');
}

/**
 * 画一行文字。
 * @param opts.x, opts.y  左上角 y 与基线的距离按 opts.baseline 处理
 * @returns 画完后的 x（便于接着画）
 */
function text(cv, str, x, y, size, opts = {}) {
  const font = fontAt(size);
  if (!font) return x;
  const maxW = opts.maxWidth ?? Infinity;
  const baselineY = y + (opts.baseline ?? font.ascent);
  let cx = x;
  const limit = x + maxW;

  for (const ch of String(str)) {
    const g = glyphOf(size, ch);
    if (cx >= limit) break;
    if (g.pixels) {
      const stride = (g.w + 7) >> 3;
      const gy0 = baselineY - g.top;
      for (let row = 0; row < g.h; row++) {
        const py = gy0 + row;
        if (py < 0 || py >= cv.h) continue;
        // 只画落在画布内的横向范围，右侧裁掉的部分也要占位
        const x0 = Math.max(0, cx);
        const x1 = Math.min(cv.w, cx + g.w);
        if (x1 <= x0) continue;
        for (let px = x0; px < x1; px++) {
          const sx = px - cx;
          if (g.pixels[row * stride + (sx >> 3)] & (0x80 >> (sx & 7))) cv.dot(px, py);
        }
      }
    }
    cx += g.adv;
  }
  return cx;
}

/** 量一段文字的宽度（不画） */
function measure(str, size) {
  let w = 0;
  for (const ch of String(str)) w += glyphOf(size, ch).adv;
  return w;
}

/** 按像素宽度截断文本，尾部补省略号。数字/日期这类短文本优先保住尾部。 */
function ellipsize(str, size, maxW) {
  const s = String(str);
  if (measure(s, size) <= maxW) return s;
  const dot = glyphOf(size, '…');
  if (!dot) return s;
  const budget = maxW - dot.adv;
  let w = 0, out = '';
  for (const ch of s) {
    const a = glyphOf(size, ch).adv;
    if (w + a > budget) break;
    out += ch; w += a;
  }
  return out + '…';
}

// ────────────────────────── RLE ──────────────────────────

/**
 * RLE 编码：(count, value) 交替，count 1..255。
 * 与固件 rle_decode 严格对应 —— 那个函数遇到 count==0 直接判解码失败，
 * 宁可保留旧位图也不刷一张花的。
 */
function rleEncode(buf) {
  if (buf.length === 0) return Buffer.alloc(0);
  const out = Buffer.alloc(buf.length * 2);
  let o = 0;
  let v = buf[0], n = 1;
  for (let i = 1; i < buf.length; i++) {
    if (buf[i] === v && n < 255) {
      n++;
    } else {
      out[o++] = n; out[o++] = v;
      v = buf[i]; n = 1;
    }
  }
  out[o++] = n; out[o++] = v;
  return out.subarray(0, o);
}

/** RLE 解码，固件 rle_decode 的镜像，用于自测 */
function rleDecode(buf, outCap) {
  if (!buf || buf.length % 2 !== 0) return -1;
  const out = Buffer.alloc(outCap);
  let w = 0;
  for (let i = 0; i < buf.length; i += 2) {
    const n = buf[i];
    const v = buf[i + 1];
    if (n === 0) return -1;
    if (w + n > outCap) return -1;
    for (let k = 0; k < n; k++) out[w++] = v;
  }
  return w;
}

module.exports = {
  FRAME, RESERVED, Canvas, fontAt, glyphOf, text, measure, ellipsize,
  rleEncode, rleDecode,
};

/**
 * build-font.js —— 把 TTF/TTC 光栅化成 1bpp 位图字模。
 *
 * 产物：lib/font-atlas.json
 *   { "<size>": { ascent, descent, lineHeight, glyphs: { "鸡": {adv,w,h,bmp} } } }
 *
 * 为什么是 1bpp：屏幕就是 400×300 1bpp（PROTO_SCREEN_BYTES = 15000），
 * 云端渲染出来的位图要一个字节不差地灌进固件的帧缓冲。中间再过一道
 * 8 位灰度只会白白撑大 base64 —— 墨水屏本来也只有黑白。
 *
 * 光栅化自己写而不用 canvas：opentype.js 的画布后端依赖 node-canvas
 * （要编译原生模块），而云端只需要「字形轮廓 → 黑白点阵」这一件事。
 */

const fs = require('fs');
const path = require('path');
const { loadFont } = require('./ttc.js');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'lib', 'font-atlas.json');

/** 屏幕实际会用到的像素尺寸。多个尺寸各烘焙一份 —— 1bpp 缩放会糊，
 *  所以宁可多占几十 KB，也不要运行时缩放。 */
const SIZES = [16, 20, 24, 32];

/** 超采样倍数。4×4 采样让斜边和曲线不至于出现明显的台阶。 */
const SS = 4;

// ────────────────────────── 读字符集 ──────────────────────────

function readCharset() {
  const file = path.join(__dirname, 'charset.txt');
  const chars = new Set();

  // ASCII 可打印范围固定包含：屏幕要显示日期、数量、配对码。
  for (let c = 0x20; c <= 0x7e; c++) chars.add(String.fromCharCode(c));

  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    const s = line.trim();
    if (!s || s.startsWith('#')) continue;
    for (const ch of s) {
      if (ch === ' ' || ch === '\t') continue;
      chars.add(ch);
    }
  }
  return [...chars];
}

// ────────────────────────── 光栅化 ──────────────────────────

/**
 * 把一条轮廓路径填成点阵。
 * 扫描线法：对每条扫描线求出与路径的所有交点，成对填色。
 * SS×SS 超采样后再按半数取样。
 *
 * @param commands 轮廓命令（opentype 坐标系，y 向下）
 * @param size     点阵宽度（= 像素字号）
 * @param baseline 基线在点阵里的 y 坐标
 * @param boxH     点阵高度（基线以上 + 降部）
 */
function rasterize(commands, size, baseline, boxH) {
  const W = size;
  const H = boxH;
  const acc = new Float32Array(W * H);

  // opentype.js 的坐标系 y 向下，getPath 已经换算好，这里直接用命令里的绝对点。
  const edges = [];
  let cx = 0, cy = 0, sx = 0, sy = 0;
  const push = (x0, y0, x1, y1) => {
    if (y0 !== y1) edges.push([x0, y0, x1, y1]);
  };
  for (const c of commands) {
    switch (c.type) {
      /* **M 只移动笔尖，不画线。**
       *
       * 早先这里写的是 push(cx, cy, c.x, c.y) —— 每个新轮廓都被上一个轮廓
       * 的起点连了一条假边。汉字一笔有五六个轮廓（口=2，冰=4），于是每
       * 条假边都会在某几条扫描线上多切出两个交点，奇偶配对整体错位一格：
       * 竖边被填成斜边、字腔跑到错的位置、笔画断成白点。屏幕上的
       * 「冰字上有白点」「样在库认不清」就是这么来的。
       *
       * 轮廓的收口交给 Z，真正的闭合边在那里 push。 */
      case 'M': cx = sx = c.x; cy = sy = c.y; break;
      case 'L': push(cx, cy, c.x, c.y); cx = c.x; cy = c.y; break;
      case 'C': {
        // 贝塞尔按足够多的折线段近似：墨水屏的分辨率下 24 段绰绰有余，
        // 而精确求交要解三次方程，收益和成本不成比例。
        const STEPS = 24;
        let px = cx, py = cy;
        for (let i = 1; i <= STEPS; i++) {
          const t = i / STEPS, u = 1 - t;
          const x = u * u * u * cx + 3 * u * u * t * c.x1 + 3 * u * t * t * c.x2 + t * t * t * c.x;
          const y = u * u * u * cy + 3 * u * u * t * c.y1 + 3 * u * t * t * c.y2 + t * t * t * c.y;
          push(px, py, x, y);
          px = x; py = y;
        }
        cx = c.x; cy = c.y;
        break;
      }
      case 'Q': {
        const STEPS = 16;
        let px = cx, py = cy;
        for (let i = 1; i <= STEPS; i++) {
          const t = i / STEPS, u = 1 - t;
          const x = u * u * cx + 2 * u * t * c.x1 + t * t * c.x;
          const y = u * u * cy + 2 * u * t * c.y1 + t * t * c.y;
          push(px, py, x, y);
          px = x; py = y;
        }
        cx = c.x; cy = c.y;
        break;
      }
      case 'Z': push(cx, cy, sx, sy); cx = sx; cy = sy; break;
    }
  }
  if (edges.length === 0) return { W, H, bits: new Uint8Array(W * H) };

  for (let sy2 = 0; sy2 < H * SS; sy2++) {
    const y = (sy2 + 0.5) / SS;
    const xs = [];
    for (const [x0, y0, x1, y1] of edges) {
      if ((y >= y0 && y < y1) || (y >= y1 && y < y0)) {
        xs.push(x0 + ((y - y0) / (y1 - y0)) * (x1 - x0));
      }
    }
    if (xs.length < 2) continue;
    xs.sort((a, b) => a - b);
    for (let i = 0; i + 1 < xs.length; i += 2) {
      const xa = xs[i], xb = xs[i + 1];
      for (let sx2 = 0; sx2 < W * SS; sx2++) {
        const x = (sx2 + 0.5) / SS;
        if (x >= xa && x < xb) acc[Math.floor(sy2 / SS) * W + Math.floor(sx2 / SS)] += 1;
      }
    }
  }

  // 覆盖过半的子采样点算实心。1bpp 没有抗锯齿的余地，取半数是标准做法。
  const need = (SS * SS) / 2;
  const bits = new Uint8Array(W * H);
  for (let i = 0; i < bits.length; i++) bits[i] = acc[i] >= need ? 1 : 0;
  return { W, H, bits };
}

/** 裁掉四周全空的行/列，压缩存储与实际排版宽度 */
function tightCrop(raster) {
  let top = raster.H, bottom = -1, left = raster.W, right = -1;
  for (let y = 0; y < raster.H; y++) {
    for (let x = 0; x < raster.W; x++) {
      if (raster.bits[y * raster.W + x]) {
        if (y < top) top = y;
        if (y > bottom) bottom = y;
        if (x < left) left = x;
        if (x > right) right = x;
      }
    }
  }
  if (bottom < 0) return { W: 0, H: 0, top: 0, bits: new Uint8Array(0) };

  const W = right - left + 1, H = bottom - top + 1;
  const bits = new Uint8Array(W * H);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) bits[y * W + x] = raster.bits[(y + top) * raster.W + (x + left)];
  }
  return { W, H, top, bits };
}

/** 打包成每行 ceil(W/8) 字节，再 base64 —— base64 在 JSON 里比转义二进制安全得多 */
function packBase64(W, H, bits) {
  const stride = (W + 7) >> 3;
  const out = Buffer.alloc(stride * H);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      if (bits[y * W + x]) out[y * stride + (x >> 3)] |= 0x80 >> (x & 7);
    }
  }
  return out.toString('base64');
}

// ────────────────────────── 主流程 ──────────────────────────

function build() {
  const fontFile = process.argv[2] || '/System/Library/Fonts/STHeiti Medium.ttc';
  const fontIndex = Number(process.argv[3] || 1);
  const { font } = loadFont(fontFile, fontIndex);
  const chars = readCharset();

  console.error(`字体: ${fontFile} #${fontIndex}  字形数 ${font.numGlyphs}`);
  console.error(`字符集: ${chars.length} 个字符 × ${SIZES.length} 个尺寸`);

  const atlas = {};
  for (const size of SIZES) {
    const scale = size / font.unitsPerEm;

    // 基线度量先定：整个点阵盒子的高度由 ascender+descender 决定。
    // 取 OS/2 的 sTypo* 值按比例缩放；缺字段时退回经验值。
    const os2 = font.tables.os2 || {};
    const upem = font.unitsPerEm;
    const asc = Math.round((os2.sTypoAscender ?? upem * 0.88) * scale);
    const desc = Math.round(Math.abs(os2.sTypoDescender ?? upem * -0.12) * scale);
    const boxH = asc + desc;

    const glyphs = {};
    let missing = 0;

    for (const ch of chars) {
      const g = font.charToGlyph(ch);
      if (!g || g.index === 0) { missing++; continue; }
      // 基线放在盒子的 asc 处：getPath 的 y 原点在基线上，字形向上生长（y 为负）。
      // 基线留在 y=0 的话扫描线只扫得到降部，中文和数字会全是空的。
      const path_ = g.getPath(0, asc, size);
      const raster = rasterize(path_.commands, size, asc, boxH);
      const cropped = tightCrop(raster);
      glyphs[ch] = {
        adv: Math.round(g.advanceWidth * scale),
        w: cropped.W,
        h: cropped.H,
        // 裁剪后字形从自身顶部开始存；top 记录它离基线多远，排版时要加回去，
        // 否则「，」和「一」这种贴边的字会整体错位。
        top: asc - cropped.top,
        bmp: cropped.W ? packBase64(cropped.W, cropped.H, cropped.bits) : '',
      };
    }

    atlas[size] = { ascent: asc, descent: desc, lineHeight: asc + desc, glyphs };
    const bytes = Buffer.byteLength(JSON.stringify(atlas[size]));
    console.error(`  ${size}px: ${Object.keys(glyphs).length} 字形（缺 ${missing}）${(bytes / 1024).toFixed(0)}KB`);
  }

  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(atlas));
  const total = (fs.statSync(OUT).size / 1024).toFixed(0);
  console.error(`写入 ${path.relative(ROOT, OUT)}  共 ${total}KB`);
}

build();

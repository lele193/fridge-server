/**
 * screen-preview.js —— 把整屏渲染结果打成 ASCII，确认排版与自绘区。
 * 用法：node tools/screen-preview.js
 */
const fs = require('fs');
const { renderHome } = require('../lib/screen');
const { FRAME, RESERVED, rleDecode } = require('../lib/render');

const DAY = 86400000;
const now = Date.now();

/** 固件 rle_decode 的逐字移植：解出来的才是设备真正会看到的画面 */
function firmwareDecode(bytes) {
  const out = Buffer.alloc(FRAME.BYTES);
  let w = 0;
  for (let i = 0; i < bytes.length; i += 2) {
    const n = bytes[i];
    const v = bytes[i + 1];
    if (n === 0) throw new Error('RLE 出现 count=0，固件会判解码失败');
    if (w + n > out.length) throw new Error('RLE 解码溢出');
    for (let k = 0; k < n; k++) out[w++] = v;
  }
  return { fb: out, written: w };
}

/* 画满 8 行 —— 预览的职责是暴露版式问题，而版式问题只在**行数拉满**时
 * 才暴露（最后一行会不会撞点线、第 8 行放不放得下）。
 *
 * 特意塞一个「已过期」的行：反白块是整行最高的元素（20px），
 * 短行根本测不出它和下一行的间距够不够。 */
const screen = renderHome([
  { _id: '1', name: '鸡蛋', qty: 6, unit: '个', expireAt: now + 1 * DAY },
  { _id: '2', name: '牛奶', qty: 1, unit: '盒', expireAt: now + 2 * DAY },
  { _id: '3', name: '过期的酸奶', qty: 2, unit: '杯', expireAt: now - 1 * DAY },
  { _id: '4', name: '上海青', qty: 1, unit: '把', expireAt: now + 5 * DAY },
  { _id: '5', name: '三文鱼', qty: 1, unit: '块', expireAt: now + 9 * DAY },
  { _id: '6', name: '长毛的豆腐', qty: 1, unit: '盒', expireAt: now - 3 * DAY },
  { _id: '7', name: '燕麦片', qty: 2, unit: '袋', expireAt: now + 30 * DAY },
  { _id: '8', name: '坚果', qty: 1, unit: '罐', expireAt: 0 },
], { now, household: '我家', total: 34, expiring: 3 });

// 走一遍固件的解码路径，确认下发的字节真能被 rle_decode 还原
const rle = Buffer.from(screen.data, 'base64');
const { fb, written } = firmwareDecode(rle);
const n = rleDecode(rle, FRAME.BYTES);
console.log(`RLE ${rle.length} 字节 → 解码 ${written}/${FRAME.BYTES} 字节  hash=${screen.hash}`);
if (written !== FRAME.BYTES || n !== FRAME.BYTES) {
  console.error('解码长度不对，设备会保留旧位图不刷新');
  process.exit(1);
}

const H_SCALE = 2; // 终端一行显示两个像素高，宽一点
let black = 0;
for (let y = 0; y < FRAME.H; y += H_SCALE) {
  let line = '';
  for (let x = 0; x < FRAME.W; x++) {
    const bit = (fb[y * FRAME.STRIDE + (x >> 3)] >> (7 - (x & 7))) & 1;
    if (bit) black++;
    line += bit ? '██' : '  ';
  }
  console.log(line);
}
console.log(`\n黑点 ${black} 个`);

// 自绘区必须是纯白（0）：固件自己画时间和电量，云端画了会被擦掉
let reservedBlack = 0;
for (let y = RESERVED.y; y < RESERVED.y + RESERVED.h; y++) {
  for (let x = RESERVED.x; x < RESERVED.x + RESERVED.w; x++) {
    if ((fb[y * FRAME.STRIDE + (x >> 3)] >> (7 - (x & 7))) & 1) reservedBlack++;
  }
}
console.log(`固件自绘区 {${RESERVED.x},${RESERVED.y},${RESERVED.w},${RESERVED.h}} 黑点 = ${reservedBlack} ` +
  (reservedBlack === 0 ? '✓ 全白' : '✗ 被云端画了，会被固件擦掉'));

/**
 * 顺手写一张 PNG。
 *
 * ASCII 预览看不出「挤不挤」「对不对齐」—— 那些都是像素级的事，
 * 盯着 300 行等宽字符猜很累。1bpp 位图写成 8 位灰度 PNG（黑=0 白=255），
 * 用 zlib 压（Node 自带），零依赖。
 *
 * 另外把固件自绘区叠一层浅灰，方便确认「云端没画进去、固件那块空着」。
 */
function writePng(path) {
  const zlib = require('zlib');
  const { W, H } = FRAME;
  const raw = Buffer.alloc(H * (W + 1));
  for (let y = 0; y < H; y++) {
    const o = y * (W + 1);
    raw[o] = 0; // filter: None
    for (let x = 0; x < W; x++) {
      const bit = (fb[y * FRAME.STRIDE + (x >> 3)] >> (7 - (x & 7))) & 1;
      let v = bit ? 0 : 255;
      // 自绘区叠浅灰（232），一眼看出固件那块留白了
      if (y >= RESERVED.y && y < RESERVED.y + RESERVED.h &&
          x >= RESERVED.x && x < RESERVED.x + RESERVED.w) {
        v = bit ? 0 : 232;
      }
      raw[o + 1 + x] = v;
    }
  }
  const crcTable = [];
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crcTable[n] = c >>> 0;
  }
  const crc = (buf) => {
    let c = 0xffffffff;
    for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const c = Buffer.alloc(4);
    c.writeUInt32BE(crc(body));
    return Buffer.concat([len, body, c]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(W, 0);
  ihdr.writeUInt32BE(H, 4);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 0;  // color type: grayscale
  fs.writeFileSync(path, Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]));
  console.log(`已写 ${path}（浅灰块 = 固件自绘区）`);
}

if (process.env.PREVIEW_PNG) writePng(process.env.PREVIEW_PNG);

process.exit(reservedBlack === 0 ? 0 : 1);

/**
 * screen-preview.js —— 把整屏渲染结果打成 ASCII，确认排版与自绘区。
 * 用法：node tools/screen-preview.js
 */
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

const screen = renderHome([
  { _id: '1', name: '鸡蛋', qty: 6, unit: '个', expireAt: now + 1 * DAY },
  { _id: '2', name: '牛奶', qty: 1, unit: '盒', expireAt: now + 2 * DAY },
  { _id: '3', name: '过期的酸奶', qty: 2, unit: '杯', expireAt: now - 1 * DAY },
  { _id: '4', name: '上海青', qty: 1, unit: '把', expireAt: now + 5 * DAY },
  { _id: '5', name: '三文鱼', qty: 1, unit: '块', expireAt: now + 9 * DAY },
], { now, household: '我家', total: 12, expiring: 3 });

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
process.exit(reservedBlack === 0 ? 0 : 1);

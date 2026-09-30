/**
 * preview.js —— 把字模以 ASCII 画到终端，肉眼确认光栅化对不对。
 * 用法：node tools/preview.js 24 "鸡蛋 3天"
 */
const atlas = require('../lib/font-atlas.json');

const size = Number(process.argv[2] || 24);
const text = process.argv[3] || '冰箱食材 3天 剩 ABC 123';

const A = atlas[size];
if (!A) {
  console.error(`没有 ${size}px 的字模，可用：${Object.keys(atlas).join(', ')}`);
  process.exit(1);
}

const placed = [];
let x = 0;
for (const ch of text) {
  const g = A.glyphs[ch];
  if (!g) continue;
  placed.push({ g, x });
  x += g.adv;
}
const width = Math.max(0, x);
const baseline = Math.max(6, ...placed.map((p) => p.g.top));
const rows = [];
for (let y = 0; y < baseline + A.descent + 2; y++) {
  let line = '';
  for (const { g } of placed) {
    if (g.w === 0) { line += ' '.repeat(g.adv); continue; }
    const bmp = Buffer.from(g.bmp, 'base64');
    const stride = (g.w + 7) >> 3;
    const gy = y - (baseline - g.top);
    for (let i = 0; i < g.adv; i++) {
      let bit = 0;
      if (i < g.w && gy >= 0 && gy < g.h) {
        bit = (bmp[gy * stride + (i >> 3)] >> (7 - (i & 7))) & 1;
      }
      line += bit ? '█' : '·';
    }
  }
  rows.push(line);
}
console.log(`${size}px  "${text}"  adv=${width} ascent=${A.ascent} descent=${A.descent}`);
console.log('┌' + '─'.repeat(width) + '┐');
for (const r of rows) console.log('│' + r.padEnd(width, '·') + '│');
console.log('└' + '─'.repeat(width) + '┘');

/**
 * check-charset.js —— 列出当前屏幕版式里所有会被画上去、但字模里没有的字。
 *
 * 为什么需要这个：渲染器遇到缺字会画一个空心方框，不报错、不抛异常。
 * 屏幕上就是「□」——之前排查显示问题时，方框查了半天才发现是字模缺字，
 * 而字模是构建期烘焙的，改版式时极易漏字。
 *
 * 改 renderHome 的文案后跑一次：
 *     node tools/check-charset.js
 * 输出为空（只打印 OK）才算齐。
 */

const atlas = require('../lib/font-atlas.json');
const { levelText, storedDays } = require('../lib/screen');

/** 渲染器会画的所有文案。字号只影响取哪个字模表，这里按 20px 查。 */
function allTexts() {
  const now = Date.UTC(2026, 8, 29, 12, 0, 0);
  const items = [
    { name: '鸡蛋', qty: 1, createdAt: now, expireAt: now + 3 * 86400000 },
    { name: '酸奶', qty: 2, createdAt: now - 9 * 86400000, expireAt: now - 2 * 86400000 },
  ];
  const out = [];

  out.push('冰箱');                      // household 为空时的页头
  out.push('我家冰箱');                  // 有家庭名时的页头
  out.push(`${items.length} 样在库`);     // 计数行
  out.push('冰箱是空的');                // 空列表
  out.push('说「加入 鸡蛋」就能加进来');  // 空列表提示

  for (const it of items) {
    out.push(it.name);
    out.push(`放了 ${storedDays(it.createdAt, now)} 天 · ${it.qty} 份`);
    out.push('已过期 2 天');
    out.push(levelText(0));
    out.push(levelText(1));
    out.push(levelText(5));
  }
  return out;
}

function main() {
  const font = atlas['20'] || atlas[Object.keys(atlas)[0]];
  if (!font) {
    console.error('字模是空的，先跑 npm run build:font');
    process.exit(1);
  }

  const missing = new Map();
  for (const t of allTexts()) {
    for (const ch of t) {
      if (ch === ' ' || ch === '\n') continue;
      if (!font.glyphs[ch]) {
        if (!missing.has(ch)) missing.set(ch, []);
        missing.get(ch).push(t);
      }
    }
  }

  if (missing.size === 0) {
    console.log('OK —— 当前版式用到的字全部在字模里');
    return;
  }

  console.log('缺 ' + missing.size + ' 个字：\n');
  for (const [ch, where] of missing) {
    console.log(`  ${ch}   出现在: ${[...new Set(where)].join(' / ')}`);
  }
  console.log('\n把它们加进 tools/charset.txt 后跑：npm run build:font');
  process.exit(1);
}

main();

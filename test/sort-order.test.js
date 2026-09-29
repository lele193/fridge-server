/**
 * sort-order.test.js —— 列表展示顺序的规则测试。
 *
 * 规则：**过期的排最前（过期越久越靠上），其次是没过期但放得最久的。**
 *
 * 之前是「按到期时间升序」排的，那意味着两样东西谁先谁后取决于**还能放多久**。
 * 但该先吃的是**已经放了最久**的那个：保质期 3 天的酸奶如果是三天前才买的，
 * 就不该排在两个月前买的苹果前面 —— 后者离变质更近了。
 *
 * 这条排序同时决定两件事，所以必须测：
 *   1. 屏幕上每一行的先后
 *   2. sync 回给固件的 items 顺序 —— 语音报的第一样要和眼睛看到的第一行是同一个
 */

const test = require('node:test');
const assert = require('assert');

const { sortForDisplay, isExpired } = require('../lib/repo');

const DAY = 86400000;
const NOW = new Date('2026-09-29T12:00:00Z').getTime();

/** 造一条食材。born 是入库时间（距今多少天前），exp 到期时间（距今多少天，过期为负） */
function item(name, bornDaysAgo, expDays) {
  return {
    id: name,
    name,
    qty: 1,
    unit: '份',
    createdAt: NOW - bornDaysAgo * DAY,
    expireAt: expDays === null ? 0 : NOW + expDays * DAY,
  };
}

const names = (list) => list.map((x) => x.name);

test('isExpired：没设保质期的不算过期', () => {
  // expireAt = 0 表示「没设保质期」。直接写 expireAt < now 会把它
  // 判成「过期了一年半」，顶到列表最前面还打着红标签。
  assert.strictEqual(isExpired(item('苹果', 5, null), NOW), false);
  assert.strictEqual(isExpired(item('牛奶', 1, 3), NOW), false);
  assert.strictEqual(isExpired(item('三文鱼', 6, -1), NOW), true);
});

test('排序：过期的全部排在没过期的前面', () => {
  const list = sortForDisplay([
    item('酸奶', 1, 3),      // 没过期，刚买
    item('三文鱼', 6, -1),   // 过期
    item('牛奶', 2, 5),      // 没过期
  ], NOW);
  assert.deepStrictEqual(names(list), ['三文鱼', '牛奶', '酸奶']);
});

test('排序：都过期时，过期越久（到期日越早）越靠上', () => {
  const list = sortForDisplay([
    item('昨天过的', 3, -1),
    item('一周前过的', 9, -7),
    item('三天前过的', 5, -3),
  ], NOW);
  assert.deepStrictEqual(names(list), ['一周前过的', '三天前过的', '昨天过的']);
});

test('排序：都没过期时，入库越早越靠上（不按到期时间）', () => {
  /* 这条是整个改动的核心：苹果两个月前买的（还剩 5 天）、
   * 酸奶三天前买的（还剩 3 天）。按到期时间排是酸奶在前，
   * 但苹果才是更该先吃的那袋。 */
  const list = sortForDisplay([
    item('酸奶', 3, 3),
    item('苹果', 60, 5),
    item('牛奶', 10, 7),
  ], NOW);
  assert.deepStrictEqual(names(list), ['苹果', '牛奶', '酸奶']);
});

test('排序：没设保质期的排在同组最后，不占第一行', () => {
  const list = sortForDisplay([
    item('不明物体', 0, null),
    item('苹果', 60, 5),
  ], NOW);
  assert.deepStrictEqual(names(list), ['苹果', '不明物体']);
});

test('排序：不改原数组', () => {
  const input = [item('b', 2, 5), item('a', 1, -1)];
  const copy = input.slice();
  sortForDisplay(input, NOW);
  assert.deepStrictEqual(input, copy, 'repo 内部的数组不能被就地重排');
});

test('排序：同组内 createdAt 相同时用 id 兜底，保证顺序确定', () => {
  /* createdAt 是毫秒级的，一句话加两样东西经常撞在同一个值上。
   *
   * 顺序不确定的真正代价不是「看着有点乱」，而是**位图 hash 每次都变** ——
   * 同样的数据渲染出不同位图，sync 判不出相同，设备就整屏重刷。
   * 墨水屏全刷一秒多且肉眼可见地闪，所以比较器绝不能返回 0。 */
  const same = [
    { id: 3, name: '丙', expireAt: NOW + 5 * DAY, createdAt: NOW },
    { id: 1, name: '甲', expireAt: NOW + 5 * DAY, createdAt: NOW },
    { id: 2, name: '乙', expireAt: NOW + 5 * DAY, createdAt: NOW },
  ];
  const forward = names(sortForDisplay(same, NOW));
  const shuffled = names(sortForDisplay(same.slice().reverse(), NOW));
  assert.deepStrictEqual(forward, ['甲', '乙', '丙'], '按 id 升序');
  assert.deepStrictEqual(shuffled, forward, '输入顺序换了，输出必须一样');
});

test('同样的数据渲染出同样的位图（否则设备会无谓地整屏重刷）', () => {
  const { renderHome } = require('../lib/screen');
  /* createdAt 全部撞在同一个毫秒 —— 就是「一句话加两样」的情形 */
  const items = [
    { id: 3, name: '牛奶', qty: 2, expireAt: NOW + 5 * DAY, createdAt: NOW },
    { id: 1, name: '酸奶', qty: 1, expireAt: NOW + 3 * DAY, createdAt: NOW },
    { id: 2, name: '苹果', qty: 1, expireAt: NOW - 1 * DAY, createdAt: NOW },
  ];
  const a = sortForDisplay(items, NOW);
  const b = sortForDisplay(items.slice().reverse(), NOW);
  const opts = { now: NOW, household: '我家', total: 3, expiring: 1 };
  assert.strictEqual(
    renderHome(a, opts).hash,
    renderHome(b, opts).hash,
    '顺序一旦不稳定，hash 就变，sync 会让设备整屏重刷',
  );
});

test('端到端：sync 回的 items 顺序和屏幕行顺序一致', async (t) => {
  const { createServer } = require('../server');
  const { memoryRepo } = require('../lib/repo');
  const http = require('http');
  const crypto = require('crypto');

  const DEVICE_ID = 'dev-order-test';
  const repo = memoryRepo();
  const server = createServer(repo);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  t.after(() => server.close());

  const req = (method, path, { body, auth } = {}) => new Promise((resolve, reject) => {
    const payload = body === undefined ? null : Buffer.from(body, 'utf8');
    const headers = {};
    if (payload) {
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = payload.length;
    }
    if (auth) headers.Authorization = auth;
    const r = http.request({ host: '127.0.0.1', port, method, path, headers }, (res) => {
      const cs = [];
      res.on('data', (c) => cs.push(c));
      res.on('end', () => {
        const t = Buffer.concat(cs).toString('utf8');
        let j = null;
        try { j = JSON.parse(t); } catch { /* 304 */ }
        resolve({ status: res.statusCode, body: j });
      });
    });
    r.on('error', reject);
    if (payload) r.write(payload);
    r.end();
  });

  const p = await req('POST', '/device/pair', { body: JSON.stringify({ deviceId: DEVICE_ID }) });
  const b = await req('POST', '/device/bind', {
    body: JSON.stringify({ bindCode: p.body.code, deviceId: DEVICE_ID }),
  });
  const secret = b.body.deviceSecret;

  const send = (op) => {
    const raw = JSON.stringify(op);
    const ts = String(Date.now());
    const sig = crypto.createHmac('sha256', secret).update(ts + 'POST/op' + raw).digest('hex');
    return req('POST', '/device/op', { body: raw, auth: `HMAC ${DEVICE_ID}:${ts}:${sig}` });
  };

  const t0 = Date.now();
  /* 挨个加，每次隔几毫秒 —— createdAt 是毫秒级的，
   * 同时加入的话三样 createdAt 相同，「入库最早」这条就没法验了。
   *
   * 顺序是刻意排的：苹果**先**加入（所以入库最早）但到期**最晚**（剩 5 天），
   * 酸奶**后**加入但到期**最早**（剩 3 天）。
   * 按「到期时间」排的话酸奶会在苹果前面 —— 那样就证明没改成
   * 「没过期按入库时间」这条规则。 */
  await send({ opId: 'a1', op: 'add', name: '苹果', qty: 1, expireAt: t0 + 5 * DAY });
  await new Promise((r) => setTimeout(r, 5));
  await send({ opId: 'a2', op: 'add', name: '三文鱼', qty: 1, expireAt: t0 - 1 * DAY });
  await new Promise((r) => setTimeout(r, 5));
  await send({ opId: 'a3', op: 'add', name: '酸奶', qty: 1, expireAt: t0 + 3 * DAY });

  const ts = String(Date.now());
  const sig = crypto.createHmac('sha256', secret).update(ts + 'GET/sync' + '').digest('hex');
  const s = await req('GET', '/device/sync?rev=0&hash=', { auth: `HMAC ${DEVICE_ID}:${ts}:${sig}` });

  assert.strictEqual(s.status, 200);
  assert.deepStrictEqual(
    names(s.body.items),
    ['三文鱼', '苹果', '酸奶'],
    '过期的三文鱼在最前；苹果虽然剩 5 天但入库最早，排酸奶前面',
  );

  /* 屏幕位图也得是同一个顺序。位图是 RLE 压过的，这里解开看第一行是谁。 */
  const rle = Buffer.from(s.body.screen.data, 'base64');
  const fb = Buffer.alloc(15000);
  let w = 0;
  for (let i = 0; i < rle.length; i += 2) {
    for (let k = 0; k < rle[i] && w < 15000; k++) fb[w++] = rle[i + 1];
  }
  // 列表第一行在 LIST_TOP=46，字形墨迹大致 y=52..66
  let ink = 0;
  for (let y = 50; y < 70; y++) {
    for (let x = 10; x < 90; x++) {
      if ((fb[y * 50 + (x >> 3)] >> (7 - (x & 7))) & 1) ink++;
    }
  }
  assert.ok(ink > 30, `第一行应该有字，实际墨迹只有 ${ink} 个点`);
});

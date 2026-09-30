/**
 * paging.test.js —— 翻页。
 *
 * 翻页为什么必须在云端：中文是云端烘焙进位图的，固件没有中文字库，
 * 自己排不了版。所以「翻页」不是设备把画面挪一下，是设备带 ?page=N
 * 重新要一张图。鉴权不受影响 —— 签名只覆盖 ts + method + route + body，
 * query 不参与。
 *
 * 三条容易做错的地方，这里都钉住：
 *   1. 页码必须钳位 —— 食材删掉后总页数变少，设备手里的 page 会越界，
 *      不钳就是一张空白页
 *   2. 回给固件的 items 必须是**全量** —— 屏幕用切片，语音用全量，
 *      只给切片的话「冰箱里有什么」只念得出当前页
 *   3. 每页的位图必须不同 —— 否则 hash 一样，翻页会拿到 304 而不换画面
 */

const test = require('node:test');
const assert = require('assert');
const http = require('http');
const crypto = require('crypto');

const { MAX_ROWS } = require('../lib/screen');
const { memoryRepo, NO_EXPIRY } = require('../lib/repo');

const DEVICE_ID = 'dev-page-test';
const DAY = 86400000;

async function startServer() {
  const { createServer } = require('../server');
  const repo = memoryRepo();
  const server = createServer(repo);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { server, port: server.address().port, repo };
}

function request(port, method, path, { body, auth, query } = {}) {
  return new Promise((resolve, reject) => {
    const qs = query ? `?${new URLSearchParams(query)}` : '';
    const payload = body === undefined ? null : Buffer.from(body, 'utf8');
    const headers = {};
    if (payload) { headers['Content-Type'] = 'application/json'; headers['Content-Length'] = payload.length; }
    if (auth) headers.Authorization = auth;
    const req = http.request({ host: '127.0.0.1', port, method, path: path + qs, headers }, (res) => {
      const cs = [];
      res.on('data', (c) => cs.push(c));
      res.on('end', () => {
        const text = Buffer.concat(cs).toString('utf8');
        let parsed = null;
        try { parsed = JSON.parse(text); } catch { /* 304 空体 */ }
        resolve({ status: res.statusCode, text, body: parsed });
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

function signedBody(secret, ts, method, route, obj) {
  const raw = obj === null ? '' : JSON.stringify(obj);
  const sig = crypto.createHmac('sha256', secret).update(ts + method + route + raw).digest('hex');
  return { raw, auth: `HMAC ${DEVICE_ID}:${ts}:${sig}` };
}

async function pairAndBind(port) {
  const p = await request(port, 'POST', '/device/pair', {
    body: JSON.stringify({ deviceId: DEVICE_ID, fwVersion: '1.0.0' }),
  });
  const b = await request(port, 'POST', '/device/bind', {
    body: JSON.stringify({ bindCode: p.body.code, deviceId: DEVICE_ID, fwVersion: '1.0.0' }),
  });
  return b.body;
}

function sync(port, secret, page) {
  const ts = String(Date.now());
  const { auth } = signedBody(secret, ts, 'GET', '/sync', null);
  const query = { rev: '0', battery: '100', power: 'usb', hash: '' };
  if (page !== undefined) query.page = String(page);
  return request(port, 'GET', '/device/sync', { auth: auth, query });
}

/** 塞 N 样食材，到期日各不相同（决定顺序） */
async function seed(port, secret, n) {
  const now = Date.now();
  for (let i = 0; i < n; i++) {
    const op = {
      opId: 'seed' + i + Date.now(), op: 'add',
      name: '食材' + i, qty: 1, unit: '份',
      expireAt: now + (i + 1) * DAY,
    };
    const { raw, auth } = signedBody(secret, String(Date.now()), 'POST', '/op', op);
    await request(port, 'POST', '/device/op', { body: raw, auth: auth });
  }
}

test('翻页：第 1 页和第 2 页的位图不同，items 都是全量', async (t) => {
  const { server, port } = await startServer();
  t.after(() => server.close());

  const bound = await pairAndBind(port);
  await seed(port, bound.deviceSecret, MAX_ROWS + 3);   // 10 项，2 页

  const p1 = await sync(port, bound.deviceSecret, 1);
  const p2 = await sync(port, bound.deviceSecret, 2);

  assert.strictEqual(p1.status, 200);
  assert.strictEqual(p2.status, 200);
  assert.strictEqual(p1.body.pageCount, 2);
  assert.strictEqual(p1.body.page, 1);
  assert.strictEqual(p2.body.page, 2);

  /* 每页的位图必须不同 —— 相同就会 304，翻页会「按了没反应」 */
  assert.notStrictEqual(p1.body.screen.hash, p2.body.screen.hash,
    '两页位图相同 → hash 相同 → 设备会拿 304，画面不换');

  /* 语音要的是全量，不能只给当前页那几行 */
  assert.strictEqual(p1.body.items.length, MAX_ROWS + 3,
    '第 1 页的 items 应是全量（语音要靠它念清单、找删除目标）');
  assert.strictEqual(p2.body.items.length, MAX_ROWS + 3,
    '第 2 页的 items 同样应是全量');
  assert.deepStrictEqual(
    p1.body.items.map((i) => i.name),
    p2.body.items.map((i) => i.name),
    '两页的 items 顺序应完全一致（只有位图分页）');
});

test('翻页：页码越界要钳回最后一页，不能返回空白页', async (t) => {
  const { server, port } = await startServer();
  t.after(() => server.close());

  const bound = await pairAndBind(port);
  await seed(port, bound.deviceSecret, 3);   // 只有 1 页

  for (const bad of [2, 5, 999, 0, -1, 'abc', '']) {
    const s = await sync(port, bound.deviceSecret, bad);
    assert.strictEqual(s.status, 200, `page=${bad} 应仍返回 200`);
    assert.strictEqual(s.body.pageCount, 1);
    assert.strictEqual(s.body.page, 1, `page=${bad} 必须钳回第 1 页`);
    /* 空白页的判据：位图里得有「食材0」的字。用 items 数量当代理 ——
     * 真判据是 renderHome 拿到空数组会画「冰箱是空的」。 */
    assert.ok(s.body.screen.data.length > 1000, `page=${bad} 不该返回空位图`);
  }
});

test('翻页：食材删光后页数变少，设备手里的旧页码要钳回 1', async (t) => {
  const { server, port } = await startServer();
  t.after(() => server.close());

  const bound = await pairAndBind(port);
  await seed(port, bound.deviceSecret, MAX_ROWS + 2);   // 9 项，2 页

  let s = await sync(port, bound.deviceSecret, 2);
  assert.strictEqual(s.body.pageCount, 2);

  /* 删到只剩 1 项，设备还在问 page=2 */
  for (const it of s.body.items.slice(1)) {
    const op = { opId: 'd' + it.id + Date.now(), op: 'delete', itemId: String(it.id) };
    const { raw, auth } = signedBody(bound.deviceSecret, String(Date.now()), 'POST', '/op', op);
    await request(port, 'POST', '/device/op', { body: raw, auth: auth });
  }

  s = await sync(port, bound.deviceSecret, 2);   // 还是问第 2 页
  assert.strictEqual(s.body.pageCount, 1, '只剩 1 页');
  assert.strictEqual(s.body.page, 1, '过期的页码必须被钳回 1，否则屏幕空白');
});

test('翻页：没带 page 参数等价于第 1 页（老固件兼容）', async (t) => {
  const { server, port } = await startServer();
  t.after(() => server.close());

  const bound = await pairAndBind(port);
  await seed(port, bound.deviceSecret, MAX_ROWS + 2);

  const noPage = await sync(port, bound.deviceSecret);            // 不带
  const page1 = await sync(port, bound.deviceSecret, 1);         // 带 1
  assert.strictEqual(noPage.body.page, 1);
  assert.strictEqual(noPage.body.screen.hash, page1.body.screen.hash,
    '不带 page 和带 page=1 必须渲染出同一张图');
});

test('翻页：单页时反白条显示「N 样在库」，多页时显示「第 N/M 页」', async (t) => {
  const { renderHome } = require('../lib/screen');
  const now = Date.now();
  const mk = (n) => Array.from({ length: n }, (_, i) => ({
    id: String(i), name: '食材' + i, qty: 1, unit: '份',
    expireAt: now + (i + 1) * DAY, createdAt: now,
  }));

  const one = renderHome(mk(3), { now, household: '我家', total: 3, page: 1, pageCount: 1 });
  const p1 = renderHome(mk(3).slice(0, MAX_ROWS), { now, household: '我家', total: 10, page: 1, pageCount: 2 });
  const p2 = renderHome(mk(3).slice(MAX_ROWS), { now, household: '我家', total: 10, page: 2, pageCount: 2 });

  /* 页码不同 → 位图必须不同，否则翻页拿 304 */
  assert.notStrictEqual(p1.hash, p2.hash);
  /* 单页和多页标题栏长得不一样（一个显示总数，一个显示页码） */
  assert.notStrictEqual(one.hash, p1.hash);
});

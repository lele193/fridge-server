/**
 * railway.test.js —— 跑在真实 TCP socket 上的端到端测试。
 *
 * 为什么不用 mock：这次要验的**恰恰是 raw body**。
 * 云函数版从 event.body 拿结构化数据，Railway 版必须拿到字节完全一致的
 * 原始请求体。用 mock 打不到这个点 —— 只有真发一次 HTTP 请求，
 * 才能确认中间没有任何环节动过那些字节。
 */

const test = require('node:test');
const assert = require('assert');
const http = require('http');
const crypto = require('crypto');

const { createRepo, memoryRepo } = require('../lib/repo');
const auth = require('../lib/auth');

const DEVICE_ID = 'dev001122334455';
const FW = '1.0.0';

// ────────────────────────── 起服务 ──────────────────────────

/** 跟固件一样把 body 拼成字符串再签，不是先 parse 再签 */
function signedBody(secret, ts, method, route, obj) {
  const raw = obj === null ? '' : JSON.stringify(obj);
  const sig = crypto.createHmac('sha256', secret).update(ts + method + route + raw).digest('hex');
  return { raw, auth: `HMAC ${DEVICE_ID}:${ts}:${sig}` };
}

/** 发一个真实 HTTP 请求，返回状态码与解析后的 body */
function request(port, method, path, { body, authHeader, query } = {}) {
  return new Promise((resolve, reject) => {
    const qs = query ? `?${new URLSearchParams(query)}` : '';
    const payload = body === undefined ? null : Buffer.from(body, 'utf8');
    const headers = {};
    if (payload) {
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = payload.length;
    }
    if (authHeader) headers.Authorization = authHeader;

    const req = http.request({ host: '127.0.0.1', port, method, path: path + qs, headers }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let parsed = null;
        try { parsed = JSON.parse(text); } catch { /* 304 时是空串 */ }
        resolve({ status: res.statusCode, headers: res.headers, text, body: parsed });
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

/** 启一个真的 server 实例，走 server.js 的完整响应路径 */
async function startServer() {
  const { createServer } = require('../server');
  const repo = memoryRepo();
  const server = createServer(repo);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { server, port: server.address().port, repo };
}

async function pairAndBind(port) {
  const p = await request(port, 'POST', '/device/pair', {
    body: JSON.stringify({ deviceId: DEVICE_ID, fwVersion: FW }),
  });
  assert.strictEqual(p.status, 200, `pair 失败: ${p.text}`);
  const code = p.body.code;

  const b = await request(port, 'POST', '/device/bind', {
    body: JSON.stringify({ bindCode: code, deviceId: DEVICE_ID, fwVersion: FW }),
  });
  assert.strictEqual(b.status, 200, `bind 失败: ${b.text}`);
  assert.strictEqual(b.body.ok, true);
  return b.body;
}

// ────────────────────────── 测试 ──────────────────────────

test('真实 socket：pair → bind → sync 全流程', async (t) => {
  const { server, port } = await startServer();
  t.after(() => server.close());

  const bound = await pairAndBind(port);
  assert.ok(bound.deviceSecret, '应下发密钥');
  assert.ok(bound.householdId.startsWith('hh_'));

  const ts = String(Date.now());
  const { auth: ah } = signedBody(bound.deviceSecret, ts, 'GET', '/sync', null);

  const s = await request(port, 'GET', '/device/sync', { authHeader: ah, query: { rev: '0', battery: '90', power: 'bat', hash: '' } });
  assert.strictEqual(s.status, 200, s.text);
  assert.ok(s.body.screen.data, '应带位图');
  assert.ok(Array.isArray(s.body.items));
});

test('真实 socket：签名对不上就是 401（raw body 被改动过）', async (t) => {
  const { server, port } = await startServer();
  t.after(() => server.close());
  const bound = await pairAndBind(port);

  // 故意用「解析后再序列化」的 body 去签 —— 字段序或空格一变就对不上
  const ts = String(Date.now());
  const obj = { opId: 'x1', op: 'add', name: '鸡蛋' };
  const reordered = { op: 'add', name: '鸡蛋', opId: 'x1' };
  const sig = crypto.createHmac('sha256', bound.deviceSecret)
    .update(ts + 'POST' + '/op' + JSON.stringify(reordered)).digest('hex');

  const r = await request(port, 'POST', '/device/op', {
    body: JSON.stringify(obj),
    authHeader: `HMAC ${DEVICE_ID}:${ts}:${sig}`,
  });
  assert.strictEqual(r.status, 401, '字节不一致时必须 401，这正是要防的');
});

test('真实 socket：相同字节就能通过（证明上条不是被别的因素拒的）', async (t) => {
  const { server, port } = await startServer();
  t.after(() => server.close());
  const bound = await pairAndBind(port);

  const ts = String(Date.now());
  const { raw, auth: ah } = signedBody(bound.deviceSecret, ts, 'POST', '/op', { opId: 'x1', op: 'add', name: '鸡蛋' });
  const r = await request(port, 'POST', '/device/op', { body: raw, authHeader: ah });
  assert.strictEqual(r.status, 200, r.text);
});

test('真实 socket：304 无 body 且带 X-Next-Poll', async (t) => {
  const { server, port } = await startServer();
  t.after(() => server.close());
  const bound = await pairAndBind(port);

  const mk = (query) => {
    const ts = String(Date.now());
    const { auth: ah } = signedBody(bound.deviceSecret, ts, 'GET', '/sync', null);
    return request(port, 'GET', '/device/sync', { authHeader: ah, query });
  };

  const first = await mk({ rev: '0', battery: '90', power: 'bat', hash: '' });
  assert.strictEqual(first.status, 200);

  const second = await mk({ rev: String(first.body.rev), battery: '90', power: 'bat', hash: first.body.screen.hash });
  assert.strictEqual(second.status, 304);
  assert.strictEqual(second.text, '', '304 不能有 body');
  assert.strictEqual(second.headers['x-next-poll'], '180');
});

test('真实 socket：shop 的 added 是数组（固件按数组计数）', async (t) => {
  const { server, port } = await startServer();
  t.after(() => server.close());
  const bound = await pairAndBind(port);

  const ts = String(Date.now());
  const { raw, auth: ah } = signedBody(bound.deviceSecret, ts, 'POST', '/op', { opId: 's1', op: 'shop', names: '纸巾、垃圾袋' });
  const r = await request(port, 'POST', '/device/op', { body: raw, authHeader: ah });
  assert.strictEqual(r.status, 200, r.text);
  assert.ok(Array.isArray(r.body.added), 'added 必须是数组');
  assert.strictEqual(r.body.added.length, 2);
});

test('真实 socket：opId 重放只生效一次', async (t) => {
  const { server, port } = await startServer();
  t.after(() => server.close());
  const bound = await pairAndBind(port);

  for (let i = 0; i < 3; i++) {
    const ts = String(Date.now());
    const { raw, auth: ah } = signedBody(bound.deviceSecret, ts, 'POST', '/op', { opId: 'same', op: 'add', name: '鸡蛋' });
    await request(port, 'POST', '/device/op', { body: raw, authHeader: ah });
  }

  const ts = String(Date.now());
  const { auth: ah } = signedBody(bound.deviceSecret, ts, 'GET', '/sync', null);
  const s = await request(port, 'GET', '/device/sync', { authHeader: ah, query: { hash: '' } });
  assert.strictEqual(s.body.items.length, 1, '重放三次仍应只有一条');
});

test('真实 socket：时间戳超窗 401', async (t) => {
  const { server, port } = await startServer();
  t.after(() => server.close());
  const bound = await pairAndBind(port);

  const ts = String(Date.now() - 6 * 60 * 1000);
  const { auth: ah } = signedBody(bound.deviceSecret, ts, 'GET', '/sync', null);
  const r = await request(port, 'GET', '/device/sync', { authHeader: ah, query: { hash: '' } });
  assert.strictEqual(r.status, 401);
});

test('真实 socket：未知端点 404、错误方法 405', async (t) => {
  const { server, port } = await startServer();
  t.after(() => server.close());

  const a = await request(port, 'POST', '/device/nope', { body: '{}' });
  assert.strictEqual(a.status, 404);

  const b = await request(port, 'POST', '/device/sync', { body: '{}' });
  assert.strictEqual(b.status, 405, 'sync 只接受 GET');
});

test('生产入口能加载且不因缺 DATABASE_URL 崩溃', async () => {
  // createRepo 在没有 DATABASE_URL 时应降级到 memory 并给出警告，而不是抛错
  const repo = await createRepo();
  assert.ok(repo.kind === 'memory' || repo.kind === 'postgres');
  assert.strictEqual(typeof repo.listActiveItems, 'function');
});

/* ── 下面两条是「食材重复」和「删不掉」的回归测试 ──
 *
 * 之前两个 repo 都把数据库行（snake_case）原样透出去，而调用方读的是
 * camelCase，于是 sync 回给固件的 expireAt / createdAt 恒为 0；
 * 同时 id 一个是数字一个是字符串，delete / eaten 全部 missing:true。
 * 表现就是：语音说删除没反应，食材越加越多。
 */
test('回归：sync 回的 expireAt / createdAt 不是 0', async (t) => {
  const { server, port } = await startServer();
  t.after(() => server.close());

  const bound = await pairAndBind(port);
  const now = Date.now();
  const expireAt = now + 3 * 86400000;

  const op = { opId: 'op-add-1', op: 'add', name: '鸡蛋', qty: 6, unit: '份', expireAt };
  const { raw, auth: ah } = signedBody(bound.deviceSecret, String(now), 'POST', '/op', op);
  const a = await request(port, 'POST', '/device/op', { body: raw, authHeader: ah });
  assert.strictEqual(a.status, 200, a.text);

  const ts = String(Date.now());
  const { auth: sh } = signedBody(bound.deviceSecret, ts, 'GET', '/sync', null);
  const s = await request(port, 'GET', '/device/sync', { authHeader: sh, query: { rev: '0', hash: '' } });

  assert.strictEqual(s.status, 200, s.text);
  assert.strictEqual(s.body.items.length, 1);
  // 这两个字段曾经恒为 0，屏幕上的「放了 N 天」因此永远是 0
  assert.strictEqual(s.body.items[0].expireAt, expireAt, 'expireAt 必须原样带回来');
  assert.ok(s.body.items[0].createdAt > 0, 'createdAt 不能是 0');
});

test('回归：delete 用字符串 itemId 也能删掉（固件就是拿字符串回传的）', async (t) => {
  const { server, port } = await startServer();
  t.after(() => server.close());

  const bound = await pairAndBind(port);
  const now = Date.now();

  const add = { opId: 'op-add-a', op: 'add', name: '牛奶', qty: 2, expireAt: now + 86400000 };
  let { raw, auth: ah } = signedBody(bound.deviceSecret, String(now), 'POST', '/op', add);
  await request(port, 'POST', '/device/op', { body: raw, authHeader: ah });

  let ts = String(Date.now());
  let { auth: sh } = signedBody(bound.deviceSecret, ts, 'GET', '/sync', null);
  let s = await request(port, 'GET', '/device/sync', { authHeader: sh, query: { rev: '0', hash: '' } });
  const item = s.body.items[0];
  assert.ok(item.id, '应有 itemId');

  // 固件从 sync 拿到的就是字符串，原样回传
  const del = { opId: 'op-del-a', op: 'delete', itemId: String(item.id) };
  ({ raw, auth: ah } = signedBody(bound.deviceSecret, String(Date.now()), 'POST', '/op', del));
  const d = await request(port, 'POST', '/device/op', { body: raw, authHeader: ah });
  assert.strictEqual(d.status, 200, d.text);
  assert.notStrictEqual(d.body.missing, true, '以前这里恒为 missing:true，删除全部无效');

  ts = String(Date.now());
  ({ auth: sh } = signedBody(bound.deviceSecret, ts, 'GET', '/sync', null));
  s = await request(port, 'GET', '/device/sync', { authHeader: sh, query: { rev: '0', hash: '' } });
  assert.strictEqual(s.body.items.length, 0, '删掉之后不该还在列表里');
});

test('GET /healthz 免鉴权，并报出用的是哪种存储', async (t) => {
  const { server, port } = await startServer();
  t.after(() => server.close());

  const h = await request(port, 'GET', '/healthz');
  assert.strictEqual(h.status, 200, h.text);
  assert.strictEqual(h.body.ok, true);
  // 测试用内存实现，所以是 memory / persistent:false
  assert.strictEqual(h.body.store, 'memory');
  assert.strictEqual(h.body.persistent, false);
  assert.ok(typeof h.body.uptimeSec === 'number');
});

/* ── 保质期：用户说了就显示倒计时，没说就只显示「放了 N 天」 ──
 *
 * 固件只在用户明确说了日子时才发 expireAt 字段（见 device.c
 * device_op_add），没说就整个字段不出现。
 *
 * 早先服务端会兜底成「7 天后过期」，于是用户从没提过保质期的东西，
 * 屏幕上会显示「还剩 7 天」—— 看着像系统知道，实际是凭空捏的日期，
 * 一周后还会翻脸变成「已过期」。不猜比猜错好。 */
test('add：没说保质期就是「没有」，不编一个到期日出来', async (t) => {
  const { server, port } = await startServer();
  t.after(() => server.close());

  const bound = await pairAndBind(port);
  const now = Date.now();
  const said = now + 3 * 86400000;

  const post = async (op) => {
    const { raw, auth } = signedBody(
      bound.deviceSecret, String(Date.now()), 'POST', '/op', op);
    return request(port, 'POST', '/device/op', { body: raw, authHeader: auth });
  };
  const sync = async () => {
    const ts = String(Date.now());
    const { auth } = signedBody(bound.deviceSecret, ts, 'GET', '/sync', null);
    const s = await request(port, 'GET', '/device/sync', {
      authHeader: auth, query: { rev: '0', hash: '' },
    });
    return s.body.items;
  };

  // 用户说了「保质期三天」
  await post({ opId: 'x1', op: 'add', name: '牛奶', qty: 1, expireAt: said });
  // 用户没说 —— expireAt 字段整个不存在
  await post({ opId: 'x2', op: 'add', name: '排骨', qty: 1 });
  // 传了 0 / 垃圾值：同样当没提
  await post({ opId: 'x3', op: 'add', name: '青菜', qty: 1, expireAt: 0 });
  await post({ opId: 'x4', op: 'add', name: '豆腐', qty: 1, expireAt: '不是数字' });

  const items = await sync();
  const by = (n) => items.find((i) => i.name === n);

  assert.strictEqual(by('牛奶').expireAt, said, '用户说了三天就该原样存三天');

  const { NO_EXPIRY } = require('../lib/repo');
  for (const n of ['排骨', '青菜', '豆腐']) {
    assert.strictEqual(by(n).expireAt, NO_EXPIRY,
      `${n} 没说保质期，expireAt 必须是「不会过期」，不能编一个日期出来`);
    /* 必须是公元 9999 年，不能是 0。0 在时间戳里是 1970-01-01，
     * 任何一处漏掉「为 0 当没有」的判断都会算出 days = -20726，
     * 屏幕上显示「已过期 20726 天」，而且这个数每天还在涨。
     * 这个坑真踩过，所以钉死。 */
    assert.ok(by(n).expireAt > Date.UTC(9999, 0, 1),
      '默认到期日必须是 9999 年，不能是 0（0 = 1970 年，会被算成过期两万年）');
  }

  /* 端到端确认：没说保质期的，屏幕上是「放了 N 天」而不是「还剩 N 天」。
   * 0 会让 daysLeft 返回 null，renderHome 的三档里落到第三档。 */
  const { renderHome } = require('../lib/screen');
  const noDate = renderHome([{ ...by('排骨'), name: '排骨' }], {
    now: Date.now(), household: '我家', total: 1, expiring: 0,
  });
  const hasDate = renderHome([{ ...by('牛奶'), name: '牛奶' }], {
    now: Date.now(), household: '我家', total: 1, expiring: 1,
  });
  assert.notStrictEqual(noDate.hash, hasDate.hash,
    '没保质期和有保质期必须渲染成不同的位图');
});

test('add：不带 unit 时存的是「份」而不是乱码', async (t) => {
  const { server, port } = await startServer();
  t.after(() => server.close());

  const bound = await pairAndBind(port);
  const { raw, auth } = signedBody(bound.deviceSecret, String(Date.now()), 'POST', '/op',
    { opId: 'u1', op: 'add', name: '鸡蛋', qty: 1 });
  await request(port, 'POST', '/device/op', { body: raw, authHeader: auth });

  const ts = String(Date.now());
  const { auth: sh } = signedBody(bound.deviceSecret, ts, 'GET', '/sync', null);
  const s = await request(port, 'GET', '/device/sync', {
    authHeader: sh, query: { rev: '0', hash: '' },
  });
  const unit = s.body.items[0].unit;
  // 固件早先的默认值是「ä»½」——中文被双重编码（UTF-8 字节当 Latin-1 又编了一次）
  assert.ok(!/[\u00c0-\u00ff]/.test(unit), `unit 不该含拉丁扩展字符，实际是「${unit}」`);
  assert.strictEqual(unit, '份');
});

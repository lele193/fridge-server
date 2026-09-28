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

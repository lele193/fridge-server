/**
 * 网页端接口的端到端测试。
 *
 * 原来 lib/web.js 用 express 挂在 server.js 上，但那段代码**从来没被接线**
 * （server.js 里没有 require，也没有挂路由），所以它一次都没真正跑过 ——
 * 仓库里那 7 个路由看起来是对的，实际全是死代码。
 *
 * 现在改成 server.js 原生的 { status, body } 风格，这些测试就是防止
 * 它再退回「能读懂但跑不起来」的状态。
 *
 * 起一个真的 http server 打真的请求，而不是直接调函数 ——
 * body 解析、路由分发、鉴权头，这些都只在真请求里才会出错。
 */

const test = require('node:test');
const assert = require('node:assert');
const http = require('http');

process.env.WEB_TOKEN = 'test-token';
process.env.WEB_DEVICE_ID = 'dev-web';

const { createRepo } = require('../lib/repo');
const { createServer } = require('../server');

let server;
let port;

test.before(async () => {
  const repo = await createRepo({ memory: true });
  await repo.upsertDevice('dev-web', { householdId: 'hh-test', deviceSecret: 's' });
  server = createServer(repo);
  await new Promise((r) => server.listen(0, r));
  port = server.address().port;
});

test.after(() => { if (server) server.close(); });

function call(method, p, body, token = 'test-token') {
  return new Promise((resolve) => {
    const data = body === undefined ? null : JSON.stringify(body);
    const headers = { 'Content-Type': 'application/json' };
    if (token) headers['X-Token'] = token;
    const req = http.request(
      { host: 'localhost', port, method, path: p, headers },
      (r) => {
        let b = '';
        r.on('data', (c) => { b += c; });
        r.on('end', () => resolve({ status: r.statusCode, body: b, headers: r.headers }));
      },
    );
    if (data) req.write(data);
    req.end();
  });
}

test('首页返回 HTML，不是 JSON', async () => {
  const r = await call('GET', '/');
  assert.strictEqual(r.status, 200);
  assert.match(r.headers['content-type'], /text\/html/);
  assert.match(r.body, /<html/i);
});

test('无 token 一律 401，且不泄露数据', async () => {
  const r = await call('GET', '/web/fridge', undefined, null);
  assert.strictEqual(r.status, 401);
  assert.ok(!r.body.includes('items'));
});

test('错的 token 也是 401', async () => {
  const r = await call('GET', '/web/fridge', undefined, 'wrong');
  assert.strictEqual(r.status, 401);
});

test('GET /web/fridge 初始为空', async () => {
  const r = await call('GET', '/web/fridge');
  assert.strictEqual(r.status, 200);
  assert.deepStrictEqual(JSON.parse(r.body), { items: [] });
});

test('POST /web/add 能加进去，GET 能读出来', async () => {
  const add = await call('POST', '/web/add', { name: '汤圆', qty: 2 });
  assert.strictEqual(add.status, 200, add.body);

  const list = await call('GET', '/web/fridge');
  const items = JSON.parse(list.body).items;
  assert.strictEqual(items.length, 1);
  assert.strictEqual(items[0].name, '汤圆');
  assert.strictEqual(items[0].qty, 2);
});

test('add 缺 name 返回 400，不静默成功', async () => {
  const r = await call('POST', '/web/add', {});
  assert.strictEqual(r.status, 400);
  assert.match(JSON.parse(r.body).error, /name/);
});

test('add 的 body 是被正确解析的（不是 "[object Object]"）', async () => {
  // 回归：readRawBody 返回 {raw, truncated}，拿返回值直接 parse
  // 会变成 parse("[object Object]")，报一个很难懂的错
  const r = await call('POST', '/web/add', { name: '粽子' });
  assert.strictEqual(r.status, 200, r.body);
  assert.ok(!r.body.includes('object Object'));
});

test('没设保质期时存的是 NO_EXPIRY，不是 0', async () => {
  // 0 会被 repo.addItem 归一成 NO_EXPIRY（9999 年）。
  // 存 0 本身没问题，但**必须能过范围检查**（1e12~4e12 毫秒），
  // 否则渲染时会被当成 1970 年。
  const r = await call('GET', '/web/fridge');
  const it = JSON.parse(r.body).items.find((i) => i.name === '粽子');
  const exp = Number(it.expireAt);
  assert.ok(exp >= 1e12, `expireAt=${exp} 不在毫秒时间戳范围内`);
});

test('POST /web/eat 标记吃完后从清单消失', async () => {
  const list = JSON.parse((await call('GET', '/web/fridge')).body).items;
  const target = list.find((i) => i.name === '粽子');

  const r = await call('POST', '/web/eat', { id: target.id });
  assert.strictEqual(r.status, 200, r.body);

  const after = JSON.parse((await call('GET', '/web/fridge')).body).items;
  assert.ok(!after.some((i) => i.name === '粽子'), '吃完后不该还��清单里');
});

test('POST /web/delete 删掉一条', async () => {
  await call('POST', '/web/add', { name: '年糕' });
  const list = JSON.parse((await call('GET', '/web/fridge')).body).items;
  const target = list.find((i) => i.name === '年糕');

  const r = await call('POST', '/web/delete', { id: target.id });
  assert.strictEqual(r.status, 200, r.body);

  const after = JSON.parse((await call('GET', '/web/fridge')).body).items;
  assert.ok(!after.some((i) => i.name === '年糕'));
});

test('delete 缺 id 返回 400', async () => {
  const r = await call('POST', '/web/delete', {});
  assert.strictEqual(r.status, 400);
});

test('购物清单：加、读、标记已买', async () => {
  const add = await call('POST', '/web/shop', { names: ['豆腐', '青菜'] });
  assert.strictEqual(add.status, 200, add.body);

  const list = JSON.parse((await call('GET', '/web/shopping')).body).items;
  assert.ok(list.length >= 2, `购物清单应有至少 2 项，实际 ${list.length}`);

  const buy = await call('POST', '/web/buy', { id: list[0].id });
  assert.strictEqual(buy.status, 200, buy.body);

  const after = JSON.parse((await call('GET', '/web/shopping')).body).items;
  assert.strictEqual(after.length, list.length - 1);
});

test('shop 支持顿号/逗号分隔的字符串', async () => {
  const r = await call('POST', '/web/shop', { names: '排骨、鸡蛋' });
  assert.strictEqual(r.status, 200, r.body);
  const list = JSON.parse((await call('GET', '/web/shopping')).body).items;
  assert.ok(list.some((i) => i.name === '排骨'));
  assert.ok(list.some((i) => i.name === '鸡蛋'));
});

test('未知接口返回 404，不是 500', async () => {
  const r = await call('GET', '/web/nope');
  assert.strictEqual(r.status, 404);
});

test('设备端 /healthz 不受网页端 token 影响', async () => {
  const r = await call('GET', '/healthz', undefined, null);
  assert.strictEqual(r.status, 200);
  assert.strictEqual(JSON.parse(r.body).ok, true);
});

test('设备端接口仍然要签名 —— 网页端的 token 不能顶替', async () => {
  const r = await call('GET', '/device/sync?rev=0', undefined, 'test-token');
  assert.strictEqual(r.status, 401, '拿网页 token 调设备接口应该被拒');
});
/**
 * postgres-sql.test.js —— 用一个假 pg 把「SQL 里的列名对不对」验掉。
 *
 * **为什么需要这个测试。**
 *
 * 内存实现不拼 SQL，所以 camelCase / snake_case 混用、单复数错、
 * 列名写错这些错误，在 `npm test` 全绿的情况下 unnoticed 直到接上真数据库
 * 才炸。而且炸得很彻底：upsertDevice 在 pair / bind / touchDevice 三条
 * 路径上都被调用，列名一错就是**配对和绑定全线 500**。
 *
 * 真实项目里已经栽过两次：
 *   - upsertDevice 把调用方的 camelCase 键直接拼进 UPDATE，
 *     Postgres 折成小写 lastseenat → "column does not exist"
 *   - setShoppingStatus 的 extra 键同理，boughtItemId → boughtitemid，
 *     而列名是 bought_item_id
 *
 * **做法。** 假 pg 记录所有语句；CREATE TABLE 顺手把表结构记下来当白名单，
 * 之后每条 UPDATE 的 SET 目标、INSERT 的列清单都对着白名单核。
 * 白名单从 init() 自己建的表里来，不手抄一份 —— 改了 schema 不会漏。
 *
 * 这样就不需要真数据库也能守住这条线。
 */

const test = require('node:test');
const assert = require('assert');

const { postgresRepo, connectionString } = require('../lib/repo');

// ────────────────────────── 假 pg ──────────────────────────

/** CREATE TABLE name ( col type, ... ) → { name: Set<col> } */
function parseCreateTable(sql) {
  const m = sql.match(/CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(\w+)\s*\(([\s\S]*?)\n\s*\)\s*`/i)
    || sql.match(/CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(\w+)\s*\(([\s\S]*?)\)\s*;?\s*$/i);
  if (!m) return null;
  const cols = new Set();
  for (const line of m[2].split('\n')) {
    const t = line.trim();
    if (!t) continue;
    const c = t.match(/^(\w+)\s+(BIGINT|INTEGER|SERIAL|TEXT|NUMERIC|BOOLEAN|REAL|INT)/i);
    if (c) cols.add(c[1]);
  }
  return { table: m[1], cols };
}

/** 从 UPDATE ... SET a = $1, b = $2 里取出列名 */
function parseUpdateSet(sql) {
  const m = sql.match(/^UPDATE\s+(\w+)\s+SET\s+([\s\S]*?)\s+WHERE/i);
  if (!m) return null;
  const cols = [];
  for (const part of m[2].split(',')) {
    const c = part.trim().match(/^(\w+)\s*=/);
    if (c) cols.push(c[1]);
  }
  return { table: m[1], cols };
}

/** 从 INSERT INTO t (a, b) 里取出列名 */
function parseInsertCols(sql) {
  const m = sql.match(/^INSERT\s+INTO\s+(\w+)\s*\(([^)]*)\)/i);
  if (!m) return null;
  return { table: m[1], cols: m[2].split(',').map((s) => s.trim()).filter(Boolean) };
}

/**
 * 记录所有语句 + 用建出来的表当列名白名单做校验。
 * query() 返回空结果集 —— 这些测试只看 SQL 形状，不看数据。
 *
 * @param opts.deviceExists  devices 的单行查询是否返回一行。
 *   true  → upsertDevice 走 UPDATE 分支
 *   false → 走 INSERT 分支
 *   两条分支拼的列名方式不同（SET a=$1 vs INSERT INTO (a,b)），
 *   所以两条都得跑一遍，缺一条就有一半 SQL 没被执行过。
 */
function fakePg(opts = {}) {
  const deviceExists = opts.deviceExists === true;
  const schema = new Map();   // table -> Set<col>
  const statements = [];
  const violations = [];

  const check = (sql) => {
    const upd = parseUpdateSet(sql);
    const ins = parseInsertCols(sql);
    if (!upd && !ins) return;
    const { table, cols } = upd || ins;
    const known = schema.get(table);
    if (!known) return;                       // 表还没建（理论上不会）
    for (const c of cols) {
      if (!known.has(c)) {
        violations.push({
          sql: sql.replace(/\s+/g, ' ').slice(0, 140),
          table,
          column: c,
          hint: /[a-z][A-Z]/.test(c)
            ? 'camelCase —— Postgres 会折成全小写，八成是忘了映射'
            : '白名单里没有这一列',
        });
      }
    }
  };

  const pool = {
    on() {},
    query(text) {
      const sql = typeof text === 'string' ? text : text.text;
      statements.push(sql);
      const ct = parseCreateTable(sql);
      if (ct) schema.set(ct.table, ct.cols);
      check(sql);
      /* devices 的单行查询要**按需**返回一行。
       *
       * upsertDevice 有两条分支 —— 有记录走 UPDATE 的 SET，没有走 INSERT 的
       * 列清单。假 pg 一律返回空结果集的话永远走 INSERT，UPDATE 那条 SQL 一
       * 次都没被执行过，列名映射写错了测试还是绿的。
       * （把映射改回 camelCase 之后那条测试确实是绿的 —— 亲自踩过。）
       *
       * items 同理：getItem 得有行，adjustQty 才会继续往下走。 */
      if (/^\s*SELECT\s+\*\s+FROM\s+devices\b/i.test(sql) && deviceExists) {
        return Promise.resolve({
          rows: [{ device_id: 'dev1', secret: 's', household_id: 'hh1', last_seen_at: 1 }],
          rowCount: 1,
        });
      }
      if (/^\s*SELECT\s+\*\s+FROM\s+items\b/i.test(sql)) {
        return Promise.resolve({ rows: [{ id: 1, household_id: 'hh1', qty: 2 }], rowCount: 1 });
      }
      return Promise.resolve({ rows: [], rowCount: 0 });
    },
  };

  // pg 的形状是 { Pool } —— postgresRepo 里面自己 new pg.Pool(...)
  const pg = { Pool: function Pool() { return pool; } };
  return { pg, pool, statements, schema, violations };
}

// ────────────────────────── 测试 ──────────────────────────

test('postgresRepo：建表语句自己就是列名白名单', async () => {
  const pg = fakePg();
  const repo = postgresRepo(pg.pg);
  await repo.init();

  assert.ok(pg.schema.has('items'), 'items 表应已建');
  assert.ok(pg.schema.has('devices'), 'devices 表应已建');
  assert.ok(pg.schema.get('items').has('expire_at'), 'items.expire_at 应在白名单里');
  assert.ok(pg.schema.get('devices').has('last_seen_at'));
  assert.ok(pg.schema.get('devices').has('fw_version'));
  assert.ok(pg.schema.get('shopping').has('bought_item_id'));
  assert.deepStrictEqual(pg.violations, [], '建表阶段不该有列名问题');
});

test('postgresRepo：upsertDevice 的两条分支列名都要在白名单里', async () => {
  /* 分支一：设备已存在 → UPDATE devices SET ... */
  const upd = fakePg({ deviceExists: true });
  const repoUpd = postgresRepo(upd.pg);
  await repoUpd.init();

  // 这三个正是 endpoints.js 实际传的形状
  await repoUpd.upsertDevice('dev1', {
    secret: 's', householdId: null, fwVersion: '1.0.0', lastSeenAt: 1,
  }, 1);
  await repoUpd.upsertDevice('dev1', { lastSeenAt: 2 }, 2);
  await repoUpd.upsertDevice('dev1', { householdId: 'hh1' }, 3);
  await repoUpd.upsertDevice('dev1', { battery: 90, power: 'usb' }, 4);

  const updates = upd.statements.filter((s) => /^UPDATE\s+devices/i.test(s));
  assert.strictEqual(updates.length, 4, `应该发出 4 条 UPDATE devices，实际 ${updates.length}`);
  assert.deepStrictEqual(upd.violations, [], 'UPDATE 分支:\n' + JSON.stringify(upd.violations, null, 2));

  /* 分支二：设备不存在 → INSERT INTO devices (...) */
  const ins = fakePg({ deviceExists: false });
  const repoIns = postgresRepo(ins.pg);
  await repoIns.init();
  await repoIns.upsertDevice('dev9', {
    secret: 's', householdId: null, fwVersion: '1.0.0', lastSeenAt: 1,
  }, 1);

  assert.ok(
    ins.statements.some((s) => /^INSERT INTO devices/i.test(s)),
    '应该真的走到 INSERT 分支，否则这条断言是空转',
  );
  assert.deepStrictEqual(ins.violations, [], 'INSERT 分支:\n' + JSON.stringify(ins.violations, null, 2));
});

test('postgresRepo：setShoppingStatus 的 bought_item_id 不能拼成 boughtItemId', async () => {
  const pg = fakePg();
  const repo = postgresRepo(pg.pg);
  await repo.init();

  await repo.setShoppingStatus('hh1', 1, 'stocked', 42);
  await repo.setShoppingStatus('hh1', 1, 'bought', null);

  assert.deepStrictEqual(pg.violations, [], JSON.stringify(pg.violations, null, 2));
});

test('postgresRepo：整条业务链路的 SQL 都不含非法列名', async () => {
  const pg = fakePg();
  const repo = postgresRepo(pg.pg);
  await repo.init();

  await repo.getDevice('dev1');
  await repo.touchDevice('dev1', { battery: '90', power: 'bat' }, 1);
  await repo.getHousehold('hh1');
  await repo.ensureHousehold('hh1', '我家', 1);
  await repo.listActiveItems('hh1', 200);
  await repo.addItem('hh1', { name: '鸡蛋', qty: 6, expireAt: 123 }, 1);
  await repo.getItem('hh1', 1);
  await repo.setItemStatus('hh1', 1, 'deleted', 1);
  await repo.adjustQty('hh1', 1, -1, 1);
  await repo.listShopping('hh1', 'pending');
  await repo.addShopping('hh1', { name: '牛奶', qty: 2 }, 1);
  await repo.getValidPairCode('dev1', 1);
  await repo.createPairCode('dev1', '123456', 2, 1);
  await repo.bindPairCode('123456', 'hh1', 1);
  await repo.seenOp('hh1', 'op1');
  await repo.markOp('hh1', 'op1', 1);

  assert.deepStrictEqual(
    pg.violations, [],
    '以下 SQL 引用了不存在的列：\n' + pg.violations.map((v) => `  ${v.table}.${v.column}\n    ${v.hint}\n    ${v.sql}`).join('\n'),
  );
  assert.ok(pg.statements.length > 20, `应该记录到不少语句，实际 ${pg.statements.length}`);
});

test('回归：列名白名单能真的抓到 camelCase（证明上面几条不是空转）', () => {
  const pg = fakePg();
  pg.pool.query('CREATE TABLE IF NOT EXISTS devices (\n  device_id TEXT PRIMARY KEY,\n  last_seen_at BIGINT\n)');
  // 故意用 camelCase —— 正是修掉的那个 bug
  pg.pool.query('UPDATE devices SET lastSeenAt = $1 WHERE device_id = $2');

  assert.strictEqual(pg.violations.length, 1);
  assert.strictEqual(pg.violations[0].column, 'lastSeenAt');
  assert.match(pg.violations[0].hint, /camelCase/);
});

/* ── 连接串兜底 ──
 * Railway 各版本注入的变量不一样：有的给 DATABASE_URL，有的只给
 * PGHOST / PGUSER / PGPASSWORD / PGDATABASE / PGPPORT。只认 DATABASE_URL
 * 的话，后者那条路整个走不通 —— 这正是面板上引用一直解析不出来时
 * 最该有的退路。 */
test('connectionString：有 DATABASE_URL 就用它', () => {
  const saved = { ...process.env };
  process.env.DATABASE_URL = 'postgresql://u:p@h:5432/db';
  process.env.PGHOST = 'other';
  try {
    assert.strictEqual(connectionString(), 'postgresql://u:p@h:5432/db');
  } finally {
    process.env = saved;
  }
});

test('connectionString：没有 DATABASE_URL 就用 PG* 拼一个', () => {
  const saved = { ...process.env };
  delete process.env.DATABASE_URL;
  Object.assign(process.env, {
    PGHOST: 'postgres.railway.internal',
    PGPORT: '5432',
    PGUSER: 'postgres',
    PGPASSWORD: 'p@ss:w/rd',
    PGDATABASE: 'railway',
  });
  try {
    // 密码里的 @ : / 必须转义，否则 pg 会把后半段当成 host，
    // 报的是 "password authentication failed" —— 看着像密码错，其实在别处
    assert.strictEqual(
      connectionString(),
      'postgresql://postgres:p%40ss%3Aw%2Frd@postgres.railway.internal:5432/railway',
    );
  } finally {
    process.env = saved;
  }
});

test('connectionString：一个都没给就返回 null（调用方据此降级到内存）', () => {
  const saved = { ...process.env };
  for (const k of Object.keys(process.env)) {
    if (/^(DATABASE|PG)/i.test(k)) delete process.env[k];
  }
  try {
    assert.strictEqual(connectionString(), null);
  } finally {
    process.env = saved;
  }
});

/* ── 回归：getDevice / getHousehold 也要转 camelCase ──
 *
 * 早先只给 getItem / listActiveItems / listShopping 加了行映射，
 * 漏了 getDevice 和 getHousehold。内存实现存的是 camelCase 键，
 * 所以测试全绿；一接上真 Postgres，行是 snake_case，
 * `device.householdId` 变成 undefined —— bind 返回 ok，
 * 紧接着 sync 就 409「设备尚未绑定到家庭」。
 *
 * 这条测试用假 pg 吐一行 snake_case 的 devices 记录，
 * 守住「repo 吐出来的必须是 camelCase」这条契约。 */
test('回归：getDevice / getHousehold 的返回值是 camelCase', async () => {
  const pg = fakePg();
  const repo = postgresRepo(pg.pg);
  await repo.init();

  /* 换成会返回数据的假 pg：SELECT * FROM devices 吐一行真实的表结构 */
  pg.pool.query = (text) => {
    const sql = typeof text === 'string' ? text : text.text;
    pg.statements.push(sql);
    if (/^\s*SELECT\s+\*\s+FROM\s+devices\b/i.test(sql)) {
      return Promise.resolve({
        rows: [{
          device_id: 'dev1', secret: 's', household_id: 'hh1',
          fw_version: '1.0.0', battery: 90, power: 'usb',
          last_seen_at: 111, created_at: 222,
        }],
        rowCount: 1,
      });
    }
    if (/^\s*SELECT\s+\*\s+FROM\s+households\b/i.test(sql)) {
      return Promise.resolve({
        rows: [{ id: 1, household_id: 'hh1', name: '我家', created_at: 222 }],
        rowCount: 1,
      });
    }
    return Promise.resolve({ rows: [], rowCount: 0 });
  };

  const d = await repo.getDevice('dev1');
  assert.ok(d, '应该查到设备');
  assert.strictEqual(d.householdId, 'hh1',
    'householdId 必须是 camelCase —— snake_case 的 household_id 会被读成 undefined，sync 直接 409');
  assert.strictEqual(d.deviceId, 'dev1');
  assert.strictEqual(d.fwVersion, '1.0.0');
  assert.strictEqual(d.lastSeenAt, 111);

  const h = await repo.getHousehold('hh1');
  assert.ok(h, '应该查到家庭');
  assert.strictEqual(h.householdId, 'hh1');
  assert.strictEqual(h.name, '我家');
});

test('回归：两个 repo 吐出来的设备对象形状一致（不然只有接库时才炸）', async () => {
  const { memoryRepo } = require('../lib/repo');
  const mem = memoryRepo();
  await mem.upsertDevice('dev1', {
    secret: 's', householdId: 'hh1', fwVersion: '1.0.0', lastSeenAt: 111,
  });

  const pg = fakePg();
  const pgr = postgresRepo(pg.pg);
  await pgr.init();
  pg.pool.query = (text) => {
    const sql = typeof text === 'string' ? text : text.text;
    if (/^\s*SELECT\s+\*\s+FROM\s+devices\b/i.test(sql)) {
      return Promise.resolve({
        rows: [{
          device_id: 'dev1', secret: 's', household_id: 'hh1',
          fw_version: '1.0.0', last_seen_at: 111, created_at: 222,
        }],
        rowCount: 1,
      });
    }
    return Promise.resolve({ rows: [], rowCount: 0 });
  };

  const a = await mem.getDevice('dev1');
  const b = await pgr.getDevice('dev1');
  /* 内存那条会多一个 battery/power 的 undefined，删掉再比键集合 */
  const keys = (o) => Object.keys(o).filter((k) => o[k] !== undefined).sort();
  assert.deepStrictEqual(keys(b), keys(a),
    '内存实现和 Postgres 实现吐出来的键必须一样，否则只有接库时才发现');
});

/* ── 回归：BIGINT 必须转成 number ──
 *
 * node-postgres 对 int8（Postgres 的 BIGINT）默认返回**字符串**，这是精度
 * 保护：int8 最大 9.2e18，JSON number 只能精确到 2^53。
 *
 * 之前所有测试都是绿的，因为假 pg 返回的是 **number**。真库返回字符串，
 * 于是 expireAt / createdAt 一路传到 sync 的 JSON 里变成 "253402300799000"。
 *
 * 后果在固件那边：cJSON_IsNumber() 对 JSON 字符串返回 false，
 * `expire_at = cJSON_IsNumber(v) ? ... : 0` 于是把两个时间都读成 0 ——
 * 语音里所有食材都说「放了 0 天」，DescribeExpiring 永远列不出东西。
 *
 * 下面这些数字都故意写成字符串，还带着真实 BIGINT 那种可能的精度。 */
const AS_BIGINT_STRING = true;

test('回归：BIGINT 列返回字符串时，必须转成 number', async () => {
  const pg = fakePg();
  const repo = postgresRepo(pg.pg);
  await repo.init();

  pg.pool.query = (text) => {
    const sql = typeof text === 'string' ? text : text.text;
    if (/^\s*SELECT\s+\*\s+FROM\s+items\b/i.test(sql)) {
      return Promise.resolve({
        rows: [{
          id: 1, household_id: 'hh1', name: '排骨', qty: 1, unit: '斤',
          // 真库就是这样：int8 回来是字符串
          expire_at: '253402300799000', created_at: '1790733525222', status: 'fresh',
        }],
        rowCount: 1,
      });
    }
    return Promise.resolve({ rows: [], rowCount: 0 });
  };

  const items = await repo.listActiveItems('hh1', 200);
  assert.strictEqual(items.length, 1);
  assert.strictEqual(typeof items[0].expireAt, 'number',
    `expireAt 必须是 number，实际是 ${typeof items[0].expireAt}（${items[0].expireAt}）`);
  assert.strictEqual(typeof items[0].createdAt, 'number',
    `createdAt 必须是 number，实际是 ${typeof items[0].createdAt}`);
  assert.strictEqual(items[0].expireAt, 253402300799000);
  assert.strictEqual(items[0].createdAt, 1790733525222);

  /* 转成 number 之后日期算得出来 —— 字符串直接给 new Date 是 Invalid Date */
  assert.ok(Number.isFinite(new Date(items[0].expireAt).getTime()),
    '转成 number 之后必须能构造合法 Date');
});

test('回归：sync 回给固件的 expireAt/createdAt 是 JSON number 而不是字符串', async (t) => {
  const { createServer } = require('../server');
  const http = require('http');
  const crypto = require('crypto');

  /* 用真 Postgres 路径，但让假 pg 按真驱动那样返回字符串 */
  const pg = fakePg();
  const repo = postgresRepo(pg.pg);
  await repo.init();

  pg.pool.query = (text) => {
    const sql = typeof text === 'string' ? text : text.text;
    if (/FROM\s+devices\b/i.test(sql) && /SELECT/i.test(sql)) {
      return Promise.resolve({ rows: [{ device_id: 'dev1', secret: 's', household_id: 'hh1', created_at: '1000' }], rowCount: 1 });
    }
    if (/FROM\s+households\b/i.test(sql) && /SELECT/i.test(sql)) {
      return Promise.resolve({ rows: [{ household_id: 'hh1', name: '我家', created_at: '1000' }], rowCount: 1 });
    }
    if (/FROM\s+items\b/i.test(sql) && /SELECT/i.test(sql)) {
      return Promise.resolve({
        rows: [{
          id: 1, household_id: 'hh1', name: '排骨', qty: 1, unit: '斤',
          expire_at: '253402300799000', created_at: '1790733525222', status: 'fresh',
        }],
        rowCount: 1,
      });
    }
    return Promise.resolve({ rows: [], rowCount: 0 });
  };

  const server = createServer(repo);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  t.after(() => server.close());

  const req = (method, path, { body, auth } = {}) => new Promise((resolve, reject) => {
    const payload = body === undefined ? null : Buffer.from(body, 'utf8');
    const headers = {};
    if (payload) { headers['Content-Type'] = 'application/json'; headers['Content-Length'] = payload.length; }
    if (auth) headers.Authorization = auth;
    const r = http.request({ host: '127.0.0.1', port, method, path, headers }, (res) => {
      const cs = [];
      res.on('data', (c) => cs.push(c));
      res.on('end', () => {
        const t = Buffer.concat(cs).toString('utf8');
        let j = null;
        try { j = JSON.parse(t); } catch { /* 304 */ }
        resolve({ status: res.statusCode, text: t, body: j });
      });
    });
    r.on('error', reject);
    if (payload) r.write(payload);
    r.end();
  });

  const ts = String(Date.now());
  const sig = crypto.createHmac('sha256', 's').update(ts + 'GET/sync' + '').digest('hex');
  const s = await req('GET', '/device/sync?rev=0&hash=', { auth: `HMAC dev1:${ts}:${sig}` });
  assert.strictEqual(s.status, 200, s.text);

  /* 直接在原始 JSON 文本里找这两个字段的引号情况 ——
   * 字符串会写成 "expireAt":"253402300799000" */
  assert.ok(/"expireAt":\s*\d/.test(s.text),
    'expireAt 必须是 JSON number（固件用 cJSON_IsNumber 判断，字符串会被读成 0）');
  assert.ok(/"createdAt":\s*\d/.test(s.text),
    'createdAt 必须是 JSON number');
  assert.strictEqual(typeof s.body.items[0].expireAt, 'number');
});

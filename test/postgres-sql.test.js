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

const { postgresRepo } = require('../lib/repo');

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

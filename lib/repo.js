/**
 * repo.js —— 数据访问层，三种实现按可用性依次降级。
 *
 *   1. postgres  有 DATABASE_URL 时用（Railway 自带 Postgres）
 *   2. sqlite    本地开发用（./data/fridge.db，需 node:sqlite）
 *   3. memory    都没有时用，重启丢数据
 *
 * 三者接口完全一致，端点代码不关心底下是哪个。
 *
 * **Railway 上一定要配 Postgres。** 不配会落到 memory，容器一重启
 * 食材清单就消失，而且不报错，最难排查。
 */

const crypto = require('crypto');

// ────────────────────────── 密钥与工具 ──────────────────────────

/** 32 字节 hex。固件 nvs 缓冲 72 字节，64 个 hex 字符刚好留余量 */
function newSecret() {
  return crypto.randomBytes(32).toString('hex');
}

function newHouseholdId() {
  return `hh_${crypto.randomBytes(8).toString('hex')}`;
}

/** 6 位数字配对码，固件屏上显示的就是它 */
function newBindCode() {
  return String(Math.floor(100000 + Math.random() * 900000));
}

const DAY = 86400000;
const PAIR_CODE_TTL_MS = 10 * 60 * 1000;

// ────────────────────────── Postgres 实现 ──────────────────────────

/**
 * 用 pg 驱动。Railway 的 Postgres 与服务同项目，走内网。
 * @param pg  require('pg') 的结果
 */
function postgresRepo(pg) {
  const pool = new pg.Pool({
    connectionString: process.env.DATABASE_URL,
    max: Number(process.env.PG_POOL_MAX) || 5,
    // Railway 的 Postgres 空闲会断连，稳妥一点
    idleTimeoutMillis: 30000,
  });

  pool.on('error', (err) => console.error('[pg] 空闲连接出错:', err.message));

  const q = (text, params) => pool.query(text, params);

  return {
    kind: 'postgres',

    async init() {
      await q(`CREATE TABLE IF NOT EXISTS devices (
        device_id    TEXT PRIMARY KEY,
        secret       TEXT NOT NULL,
        household_id TEXT,
        fw_version   TEXT,
        battery      INTEGER,
        power        TEXT,
        last_seen_at BIGINT,
        created_at   BIGINT NOT NULL
      )`);

      await q(`CREATE TABLE IF NOT EXISTS households (
        id          SERIAL PRIMARY KEY,
        household_id TEXT UNIQUE NOT NULL,
        name        TEXT NOT NULL,
        created_at  BIGINT NOT NULL
      )`);

      await q(`CREATE TABLE IF NOT EXISTS items (
        id           SERIAL PRIMARY KEY,
        household_id TEXT NOT NULL,
        name         TEXT NOT NULL,
        qty          INTEGER NOT NULL DEFAULT 1,
        unit         TEXT NOT NULL DEFAULT '份',
        expire_at    BIGINT,
        status       TEXT NOT NULL DEFAULT 'fresh',
        created_at   BIGINT NOT NULL
      )`);

      await q(`CREATE TABLE IF NOT EXISTS shopping (
        id             SERIAL PRIMARY KEY,
        household_id   TEXT NOT NULL,
        name           TEXT NOT NULL,
        qty            INTEGER NOT NULL DEFAULT 1,
        unit           TEXT NOT NULL DEFAULT '份',
        status         TEXT NOT NULL DEFAULT 'pending',
        bought_item_id INTEGER,
        created_at     BIGINT NOT NULL
      )`);

      await q(`CREATE TABLE IF NOT EXISTS pair_codes (
        id           SERIAL PRIMARY KEY,
        code         TEXT UNIQUE NOT NULL,
        device_id    TEXT NOT NULL,
        household_id TEXT,
        created_at   BIGINT NOT NULL,
        expires_at   BIGINT NOT NULL
      )`);

      // opId 幂等表：固件离线队列重放靠它去重
      await q(`CREATE TABLE IF NOT EXISTS seen_ops (
        id           SERIAL PRIMARY KEY,
        household_id TEXT NOT NULL,
        op_id        TEXT NOT NULL,
        created_at   BIGINT NOT NULL,
        UNIQUE (household_id, op_id)
      )`);

      // sync 的主查询：household_id + status + expire_at
      await q('CREATE INDEX IF NOT EXISTS items_hh_status_expire ON items (household_id, status, expire_at)');
      await q('CREATE INDEX IF NOT EXISTS shopping_hh_status ON shopping (household_id, status)');
      await q('CREATE INDEX IF NOT EXISTS pair_codes_device ON pair_codes (device_id, created_at DESC)');
      await q('CREATE INDEX IF NOT EXISTS devices_hh ON devices (household_id)');
    },

    async getDevice(deviceId) {
      const { rows } = await q('SELECT * FROM devices WHERE device_id = $1', [deviceId]);
      return rows[0] || null;
    },

    /**
     * 插入或更新设备记录。
     * fields 的键直接当列名用，所以只传上面定义过的字段
     * （secret / household_id / fw_version / battery / power / last_seen_at）。
     */
    async upsertDevice(deviceId, fields, now = Date.now()) {
      const keys = Object.keys(fields).filter((k) => fields[k] !== undefined);
      if (!keys.length) return this.getDevice(deviceId);

      const existing = await this.getDevice(deviceId);

      if (existing) {
        const params = keys.map((k) => fields[k]);
        params.push(deviceId);
        const sets = keys.map((k, i) => `${k} = $${i + 1}`);
        await q(`UPDATE devices SET ${sets.join(', ')} WHERE device_id = $${params.length}`, params);
        return { ...existing, ...fields };
      }

      const cols = ['device_id', 'created_at', ...keys];
      const params = [deviceId, now, ...keys.map((k) => fields[k])];
      const ph = cols.map((_, i) => `$${i + 1}`).join(', ');
      const { rows } = await q(
        `INSERT INTO devices (${cols.join(', ')}) VALUES (${ph}) ON CONFLICT (device_id) DO NOTHING RETURNING *`,
        params,
      );
      return rows[0] || this.getDevice(deviceId);
    },

    /** sync 每次调用都更新一次，顺带记电量 */
    async touchDevice(deviceId, query = {}, now = Date.now()) {
      const battery = Number.isFinite(Number(query.battery)) ? Number(query.battery) : null;
      if (battery === null && !query.power) {
        await q('UPDATE devices SET last_seen_at = $2 WHERE device_id = $1', [deviceId, now]);
        return;
      }
      await q(
        `UPDATE devices SET last_seen_at = $2, battery = COALESCE($3, battery), power = COALESCE($4, power)
         WHERE device_id = $1`,
        [deviceId, now, battery, query.power || null],
      );
    },

    async getHousehold(householdId) {
      if (!householdId) return null;
      const { rows } = await q('SELECT * FROM households WHERE household_id = $1', [householdId]);
      return rows[0] || null;
    },

    async ensureHousehold(householdId, name, now = Date.now()) {
      const existing = await this.getHousehold(householdId);
      if (existing) {
        if (name && existing.name !== name) {
          await q('UPDATE households SET name = $2 WHERE household_id = $1', [householdId, name]);
          return { ...existing, name };
        }
        return existing;
      }
      const { rows } = await q(
        'INSERT INTO households (household_id, name, created_at) VALUES ($1,$2,$3) ON CONFLICT (household_id) DO NOTHING RETURNING *',
        [householdId, name || '我家', now],
      );
      return rows[0] || this.getHousehold(householdId);
    },

    async listActiveItems(householdId, limit = 200) {
      // expire_at 为空的排最后：COALESCE 把 null 顶到最大
      const { rows } = await q(
        `SELECT * FROM items
         WHERE household_id = $1 AND status = 'fresh'
         ORDER BY COALESCE(expire_at, 9223372036854775807) ASC
         LIMIT $2`,
        [householdId, limit],
      );
      return rows;
    },

    async getItem(householdId, id) {
      const { rows } = await q('SELECT * FROM items WHERE household_id = $1 AND id = $2', [householdId, id]);
      return rows[0] || null;
    },

    async addItem(householdId, { name, qty = 1, unit = '份', expireAt = 0 }, now = Date.now()) {
      const { rows } = await q(
        'INSERT INTO items (household_id, name, qty, unit, expire_at, status, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *',
        [householdId, name, qty, unit, expireAt, 'fresh', now],
      );
      return rows[0];
    },

    async setItemStatus(householdId, id, status, now = Date.now()) {
      await q('UPDATE items SET status = $3 WHERE household_id = $1 AND id = $2', [householdId, id, status]);
    },

    async adjustQty(householdId, id, delta) {
      const item = await this.getItem(householdId, id);
      if (!item) return null;
      const next = (item.qty || 1) + delta;
      if (next <= 0) {
        await q('UPDATE items SET qty = 0, status = $3 WHERE household_id = $1 AND id = $2', [householdId, id, 'eaten']);
        return { ...item, qty: 0, status: 'eaten' };
      }
      await q('UPDATE items SET qty = $3 WHERE household_id = $1 AND id = $2', [householdId, id, next]);
      return { ...item, qty: next };
    },

    async listShopping(householdId, status = 'pending') {
      const { rows } = await q(
        'SELECT * FROM shopping WHERE household_id = $1 AND status = $2 ORDER BY created_at DESC LIMIT 200',
        [householdId, status],
      );
      return rows;
    },

    async addShopping(householdId, { name, qty = 1, unit = '份' }, now = Date.now()) {
      const { rows } = await q(
        'INSERT INTO shopping (household_id, name, qty, unit, status, created_at) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *',
        [householdId, name, qty, unit, 'pending', now],
      );
      return rows[0];
    },

    async setShoppingStatus(householdId, id, status, extra = {}) {
      const cols = ['status = $3'];
      const params = [householdId, id, status];
      for (const [k, v] of Object.entries(extra)) {
        params.push(v);
        cols.push(`${k} = $${params.length}`);
      }
      await q(`UPDATE shopping SET ${cols.join(', ')} WHERE household_id = $1 AND id = $2`, params);
    },

    async getValidPairCode(deviceId, now = Date.now()) {
      const { rows } = await q(
        'SELECT * FROM pair_codes WHERE device_id = $1 AND expires_at > $2 ORDER BY created_at DESC LIMIT 1',
        [deviceId, now],
      );
      return rows[0] || null;
    },

    async createPairCode(deviceId, code, expiresAt, now = Date.now()) {
      const { rows } = await q(
        'INSERT INTO pair_codes (code, device_id, household_id, created_at, expires_at) VALUES ($1,$2,NULL,$3,$4) RETURNING *',
        [code, deviceId, now, expiresAt],
      );
      return rows[0];
    },

    async bindPairCode(code, householdId) {
      await q('UPDATE pair_codes SET household_id = $2 WHERE code = $1', [code, householdId]);
    },

    /** 见过这个 opId 吗？见过就说明是队列重放 */
    async seenOp(householdId, opId) {
      const { rowCount } = await q('SELECT 1 FROM seen_ops WHERE household_id = $1 AND op_id = $2', [householdId, opId]);
      return rowCount > 0;
    },

    async markOp(householdId, opId, now = Date.now()) {
      await q('INSERT INTO seen_ops (household_id, op_id, created_at) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING',
        [householdId, opId, now]);
    },
  };
}

// ────────────────────────── 内存实现（兜底 / 单测） ──────────────────────────

function memoryRepo() {
  const s = { devices: new Map(), households: new Map(), items: [], shopping: [], pairCodes: [], ops: new Set() };
  let seq = 0;
  const nid = () => ++seq;

  return {
    kind: 'memory',
    async init() {},
    async getDevice(id) { return s.devices.get(id) || null; },
    async upsertDevice(id, fields) {
      const d = s.devices.get(id) || { device_id: id, created_at: Date.now() };
      Object.assign(d, fields);
      s.devices.set(id, d);
      return d;
    },
    async touchDevice(id, query) {
      const d = s.devices.get(id);
      if (!d) return;
      d.last_seen_at = Date.now();
      if (query.battery != null) d.battery = Number(query.battery);
      if (query.power) d.power = query.power;
    },
    async getHousehold(id) { return id ? (s.households.get(id) || null) : null; },
    async ensureHousehold(id, name) {
      let h = s.households.get(id);
      if (!h) { h = { id: nid(), household_id: id, name: name || '我家', created_at: Date.now() }; s.households.set(id, h); }
      else if (name) h.name = name;
      return h;
    },
    async listActiveItems(hh, limit = 200) {
      return s.items
        .filter((i) => i.household_id === hh && i.status === 'fresh')
        .sort((a, b) => (a.expire_at ?? Number.MAX_SAFE_INTEGER) - (b.expire_at ?? Number.MAX_SAFE_INTEGER))
        .slice(0, limit);
    },
    async getItem(hh, id) { return s.items.find((i) => i.household_id === hh && i.id === id) || null; },
    async addItem(hh, { name, qty = 1, unit = '份', expireAt = 0 }) {
      const it = { id: nid(), household_id: hh, name, qty, unit, expire_at: expireAt, status: 'fresh', created_at: Date.now() };
      s.items.push(it);
      return it;
    },
    async setItemStatus(hh, id, status) {
      const it = s.items.find((i) => i.household_id === hh && i.id === id);
      if (it) it.status = status;
    },
    async adjustQty(hh, id, delta) {
      const it = s.items.find((i) => i.household_id === hh && i.id === id);
      if (!it) return null;
      const next = (it.qty || 1) + delta;
      if (next <= 0) { it.qty = 0; it.status = 'eaten'; } else it.qty = next;
      return it;
    },
    async listShopping(hh, status = 'pending') {
      return s.shopping.filter((x) => x.household_id === hh && x.status === status)
        .sort((a, b) => b.created_at - a.created_at);
    },
    async addShopping(hh, { name, qty = 1, unit = '份' }) {
      const x = { id: nid(), household_id: hh, name, qty, unit, status: 'pending', created_at: Date.now() };
      s.shopping.push(x);
      return x;
    },
    async setShoppingStatus(hh, id, status, extra = {}) {
      const x = s.shopping.find((v) => v.household_id === hh && v.id === id);
      if (x) Object.assign(x, { status }, extra);
    },
    async getValidPairCode(deviceId, now = Date.now()) {
      return s.pairCodes
        .filter((c) => c.device_id === deviceId && c.expires_at > now)
        .sort((a, b) => b.created_at - a.created_at)[0] || null;
    },
    async createPairCode(deviceId, code, expiresAt) {
      const c = { id: nid(), code, device_id: deviceId, household_id: null, created_at: Date.now(), expires_at: expiresAt };
      s.pairCodes.push(c);
      return c;
    },
    async bindPairCode(code, hh) {
      const c = s.pairCodes.find((x) => x.code === code);
      if (c) c.household_id = hh;
    },
    async seenOp(hh, opId) { return s.ops.has(`${hh}|${opId}`); },
    async markOp(hh, opId) { s.ops.add(`${hh}|${opId}`); },
  };
}

// ────────────────────────── 选择实现 ──────────────────────────

/**
 * 按可用性挑一个。返回的 repo 一定已经 init 完。
 * @param opts.force  'postgres' | 'memory'，测试时用来固定
 */
async function createRepo(opts = {}) {
  if (opts.force === 'memory') return memoryRepo();

  if (process.env.DATABASE_URL) {
    let pg;
    try {
      pg = require('pg');
    } catch {
      throw new Error(
        '设了 DATABASE_URL 但没装 pg 驱动。请跑：npm i pg\n' +
        '（Railway 上要在项目依赖里，否则部署时模块找不到）',
      );
    }
    const repo = postgresRepo(pg);
    await repo.init();
    console.log('[repo] 使用 PostgreSQL');
    return repo;
  }

  const repo = memoryRepo();
  await repo.init();
  console.warn(
    '[repo] ⚠ 没有 DATABASE_URL，使用内存存储。\n' +
    '       进程一重启数据就没了，且不报错。\n' +
    '       Railway 上请添加 Postgres 数据库（会自动注入 DATABASE_URL）。',
  );
  return repo;
}

module.exports = {
  createRepo, memoryRepo, postgresRepo,
  newSecret, newHouseholdId, newBindCode,
  DAY, PAIR_CODE_TTL_MS,
};

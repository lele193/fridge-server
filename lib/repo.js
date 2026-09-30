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

/** 用户没提保质期时存什么。
 *
 *  **是公元 9999 年，不是 0。** 这个选择是被坑出来的。
 *
 *  早先存 0，而 0 在时间戳里的含义是 1970-01-01。于是任何一处漏掉
 * 「expireAt 为 0 要当没有」的判断，都会算出
 *  days = (0 - now) / 86400000 = -20726
 *  屏幕上就是「已过期 20726 天」—— 而且这个数**每天还在涨**，
 *  看起来像系统知道，其实是一个 1970 年的日期减出来的。
 *
 *  语义上「9999 年」也更贴切：**不会过期就是不会过期**，
 *  不需要一个魔法值去代表「空」。这样 daysLeft 不用特判 0，
 *  自然算出一个很大的正数，落在「还早」那一档，走「放了 N 天」。
 *
 *  数值范围确认过：
 *   - Postgres items.expire_at 是 BIGINT（9.2e18），装得下
 *   - 固件 sync_item_t.expire_at 是 int64_t，cJSON 用 valuedouble
 *     （double 53 位尾数）转，2.5e14 可精确表示
 *   - Progress() 里 span = expire_at - created_at 仍是正的，
 *     Progress ≈ 0，DescribeExpiring 不会把它列进「该吃了」
 */
const NO_EXPIRY = Date.UTC(9999, 11, 31, 23, 59, 59);

// ────────────────────────── 行 → 领域对象 ──────────────────────────

/**
 * 表里的行是 snake_case（expire_at / created_at / household_id），
 * 而**所有调用方**读的都是 camelCase（expireAt / createdAt）。
 *
 * 以前两个实现都直接把行透出去，于是 `it.expireAt` 恒为 undefined：
 *   - sync 回给固件的 expireAt / createdAt 永远是 0
 *   - renderHome 的 storedDays 恒为 0（「放了 N 天」永远是 0）
 *   - 过期那行永远不触发反白标签
 * 而 Postgres 那边是同样的问题 —— 只是还没接上数据库，没暴露出来。
 *
 * 统一在这里转，两个实现共用一份，字段名以后不会再走岔。
 */
/**
 * BIGINT（int8）在 node-postgres 里默认返回**字符串**。
 *
 * 这是精度保护：int8 最大 9.2e18，JSON number 只能精确到 2^53，
 * 直接转 Number 有丢末位的风险。pg 的选择是返回字符串。
 *
 * 但我们的时间戳是毫秒（1.8e12 / 2.5e14），远小于 2^53，转 Number 无损。
 * 不转的话：
 *   - 固件 cJSON_IsNumber() 对 JSON 字符串返回 false，
 *     expire_at / created_at 全变成 0 → 语音里所有食材都说「放了 0 天」，
 *     DescribeExpiring 永远列不出东西（span = 0 - 0 = 0）
 *   - 服务端 new Date("253402300799000") 直接 Invalid Date
 *
 * 时间戳列一律过这个函数；用户输入的字符串（名字等）不受影响。
 */
function asNumber(v) {
  if (v === null || v === undefined) return 0;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : 0;
}

function rowToDevice(r) {
  if (!r) return null;
  return {
    deviceId: r.device_id,
    secret: r.secret,
    householdId: r.household_id,
    fwVersion: r.fw_version,
    battery: r.battery,
    power: r.power,
    lastSeenAt: asNumber(r.last_seen_at),
    createdAt: asNumber(r.created_at),
  };
}

function rowToHousehold(r) {
  if (!r) return null;
  return {
    id: r.id,
    householdId: r.household_id,
    name: r.name,
    createdAt: asNumber(r.created_at),
  };
}

function rowToItem(r) {
  if (!r) return null;
  return {
    id: r.id ?? r._id,
    householdId: r.household_id,
    name: r.name,
    qty: r.qty,
    unit: r.unit,
    expireAt: asNumber(r.expire_at),
    createdAt: asNumber(r.created_at),
    status: r.status,
  };
}

function rowToShopping(r) {
  if (!r) return null;
  return {
    id: r.id ?? r._id,
    householdId: r.household_id,
    name: r.name,
    qty: r.qty,
    unit: r.unit,
    status: r.status,
    createdAt: asNumber(r.created_at),
  };
}

/**
 * itemId 归一成数字再比。
 *
 * sync 把 id 序列化成字符串发给固件，固件原样回传，endpoints 再 String() 一次；
 * 内存仓库的 id 是数字，严格相等比不过 —— delete / eaten / stock 全部
 * 返回 missing:true，表现为「语音说删除没反应，食材一直不走」。
 * Postgres 的 id 是整型列，参数会被隐式转换，本来是对的；但这里统一归一，
 * 两个实现行为一致，不再靠数据库类型巧合。
 */
function sameId(a, b) {
  if (a == null || b == null) return false;
  return String(a) === String(b);
}

/**
 * devices 表：camelCase 字段名 → 列名。
 *
 * **不能把调用方给的键直接拼进 SQL。** Postgres 会把未加引号的标识符折成
 * 小写，`lastSeenAt` 变成 `lastseenat`，报 "column does not exist" ——
 * 而 upsertDevice 在 pair / bind / touchDevice 三条路径上都被调用，
 * 也就是说**一接上数据库，配对和绑定就全线崩**。
 *
 * 顺带这也是唯一的 SQL 注入面：白名单之外的键直接丢掉，不进语句。
 */
const DEVICE_COLUMNS = {
  secret: 'secret',
  householdId: 'household_id',
  fwVersion: 'fw_version',
  battery: 'battery',
  power: 'power',
  lastSeenAt: 'last_seen_at',
  createdAt: 'created_at',
};

// ────────────────────────── 展示顺序 ──────────────────────────

/**
 * 这个食材算不算已经过期。
 *
 * **expireAt 为 0/null 表示「没设保质期」，不算过期。**
 * 早先直接写 `expireAt < now` 会把这类食材判成「过期了一年半」，
 * 顶到列表最前面还打着红标签 —— 明显不对。
 * 判据要和 screen.js 的 daysLeft() 保持一致：!expireAt 直接返回 null。
 */
function isExpired(item, now) {
  const exp = item.expireAt ?? item.expire_at ?? 0;
  return Number(exp) > 0 && Number(exp) < now;
}

/**
 * 列表展示顺序：**过期的排最前，其次是离到期最近的。**
 *
 *   1. 已过期 → 全部排在没过期的前面；组内按 expireAt 升序，
 *      也就是过期越久（到期日越早）越靠上 —— 最该扔的那袋在第一行
 *   2. 未过期 → 按 expireAt 升序，到期越近越靠上 —— 最该先吃的那袋在前面
 *   3. 到期时间完全相同 → 按 createdAt 升序，后放的排后面（先买的先吃）
 *   4. 还相同 → 按 id 升序兜底
 *
 * 第 2 条改过一次：原来是「未过期按入库时间排」（先进先出）。
 * 那样排的含义是「放得最久的先吃」，但用户要的是「快到期的先吃」——
 * 保质期 3 天的酸奶三天前才买，就不该排在两个月前买的苹果前面。
 *
 * 排序放在这里（而不是 renderHome）是必要的：sync 回给固件的 items
 * 顺序和屏幕上的行顺序必须一致，否则语音报出来的第一样
 * 和眼睛看到的第一行不是同一个东西。
 */
function sortForDisplay(items, now = Date.now()) {
  return items.slice().sort((a, b) => {
    /* 第一刀：过期的全部排在没过期的前面。
     *
     * 这一刀必须在最外层 —— 组内才轮到各自的排序键。 */
    const aOver = isExpired(a, now);
    const bOver = isExpired(b, now);
    if (aOver !== bOver) return aOver ? -1 : 1;

    /* 第二刀：组内按到期时间升序。
     *
     * 两组用**同一个键**，规则才简单也好解释：
     *   过期组 → 到期日越早 = 过期越久 = 越该先扔 → 越靠前
     *   未过期组 → 到期日越近 = 越该先吃 → 越靠前
     *
     * **非正数的到期日一律当 NO_EXPIRY（9999 年）处理，落到同组最后。**
     * 这不是假设的风险，是真踩过：expireAt 一旦是 0（时间戳里的 1970 年），
     * isExpired 的 `exp > 0` 判据会放它过去（不算过期），但作为排序键
     * 0 是全场最小值 —— 一个「没说过保质期」的东西会凭空顶到第一行。
     * 在比较器里也归一一次，任何没换成 NO_EXPIRY 的路径都被兜住。 */
    const expOf = (it) => {
      const v = asNumber(it.expireAt ?? it.expire_at);
      return v > 0 ? v : NO_EXPIRY;
    };
    const aExp = expOf(a);
    const bExp = expOf(b);
    if (aExp !== bExp) return aExp - bExp;

    /* 第三刀：到期时间完全相同 → 后放的排后面。
     *
     * 先买的先吃。同一天买的同一样东西，先前那袋在前。
     * createdAt 是毫秒级的，两样东西经常撞在同一个值上，所以最后
     * 还要用 id 兜底 —— 比较器绝不能返回 0，顺序一晃位图 hash 就变，
     * sync 判不出相同，设备就整屏重刷（墨水屏一秒多且肉眼可见地闪）。 */
    const aBorn = asNumber(a.createdAt ?? a.created_at);
    const bBorn = asNumber(b.createdAt ?? b.created_at);
    if (aBorn !== bBorn) return aBorn - bBorn;
    return (a.id ?? 0) - (b.id ?? 0);
  });
}

// ────────────────────────── 连接串 ──────────────────────────

/**
 * 连接串从哪来。
 *
 * 优先 DATABASE_URL —— Railway 连 Postgres 时注入的就是它。
 * 但如果面板上只给了 PGHOST / PGUSER / PGPASSWORD / PGDATABASE / PGPORT
 * （不同版本的注入策略不一样），就自己拼一个，省得整条路都走不通。
 *
 * 返回 null 表示一个都没给，调用方据此降级到内存实现。
 */
function connectionString() {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;

  const { PGHOST, PGUSER, PGPASSWORD, PGDATABASE, PGPORT } = process.env;
  if (!PGHOST || !PGUSER) return null;

  /* 密码里的特殊字符必须转义，否则 @ : / 会被当成 URL 分隔符，
   * 解析出来的用户名或密码是错的 —— 表现是
   * "password authentication failed"，看着像密码错了，其实是被截断了。 */
  const user = encodeURIComponent(PGUSER);
  const pass = PGPASSWORD ? `:${encodeURIComponent(PGPASSWORD)}` : '';
  const port = PGPORT ? `:${PGPORT}` : '';
  const db = PGDATABASE ? `/${PGDATABASE}` : '';
  return `postgresql://${user}${pass}@${PGHOST}${port}${db}`;
}

// ────────────────────────── Postgres 实现 ──────────────────────────

/**
 * 用 pg 驱动。Railway 的 Postgres 与服务同项目，走内网。
 * @param pg  require('pg') 的结果
 * @param connString 连接串，默认从环境变量推
 */
function postgresRepo(pg, connString = connectionString()) {
  const pool = new pg.Pool({
    connectionString: connString,
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
      return rowToDevice(rows[0]);
    },

    /**
     * 插入或更新设备记录。
     * fields 用 camelCase（映射见 DEVICE_COLUMNS），值全部走参数绑定。
     */
    async upsertDevice(deviceId, fields, now = Date.now()) {
      const keys = Object.keys(fields)
        .filter((k) => DEVICE_COLUMNS[k] && fields[k] !== undefined);
      if (!keys.length) return this.getDevice(deviceId);

      const existing = await this.getDevice(deviceId);

      if (existing) {
        const params = keys.map((k) => fields[k]);
        params.push(deviceId);
        const sets = keys.map((k, i) => `${DEVICE_COLUMNS[k]} = $${i + 1}`);
        await q(`UPDATE devices SET ${sets.join(', ')} WHERE device_id = $${params.length}`, params);
        return { ...existing, ...fields };
      }

      const cols = ['device_id', 'created_at', ...keys.map((k) => DEVICE_COLUMNS[k])];
      const params = [deviceId, now, ...keys.map((k) => fields[k])];
      const ph = cols.map((_, i) => `$${i + 1}`).join(', ');
      const { rows } = await q(
        `INSERT INTO devices (${cols.join(', ')}) VALUES (${ph}) ON CONFLICT (device_id) DO NOTHING RETURNING *`,
        params,
      );
      return rowToDevice(rows[0]) || this.getDevice(deviceId);
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
      return rowToHousehold(rows[0]);
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
      return rowToHousehold(rows[0]) || this.getHousehold(householdId);
    },

    async listActiveItems(householdId, limit = 200, now = Date.now()) {
      const { rows } = await q(
        'SELECT * FROM items WHERE household_id = $1 AND status = $2 LIMIT $3',
        [householdId, 'fresh', limit * 4],   // 多取一些，排完序再截断
      );
      /* 排序不能交给 SQL：规则是「过期的排前 + 组内过期最久优先，
       * 其次未过期按入库时间」，跨了两个不同列和两种方向，
       * 写成 ORDER BY CASE WHEN ... THEN ... 比在 JS 里排更难读也更容易写错。
       * 而且 JS 排一份，内存实现和 Postgres 实现行为必然一致。 */
      return sortForDisplay(rows.map(rowToItem), now).slice(0, limit);
    },

    async getItem(householdId, id) {
      const { rows } = await q('SELECT * FROM items WHERE household_id = $1 AND id = $2', [householdId, id]);
      return rowToItem(rows[0]);
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

    /* 一次性把所有过期的标成 deleted，返回被清掉的条目。
     *
     * 为什么需要「一次性」：逐条 delete 要固件先列出所有过期的、
     * 再一个个传 id 上来。而「清掉过期的」是个**集合操作**，
     * 让设备端自己去数据库里挑，比让它先拉全量再逐个传更省（34 条
     * 清单的语音往返能到几十次），也不会因为中途失败漏删一半。
     *
     * 返回名字和数量是为了让设备能如实回答「清掉了哪几样」——
     * 破坏性操作必须给出回执，用户才知道自己的冰箱变成了什么样。 */
    async cleanExpired(householdId, now = Date.now()) {
      /* **`q()` 返回的是 `{ rows }`，不是数组本身。** 原来直接
       * `rows.map(...)` 会在线上抛 TypeError，用户那边表现为
       * 「没能清理，等会再试」—— 而函数名和代码读着都对，
       * 只看 diff 看不出来。仓库里所有其他 q() 调用都写了
       * `const { rows } = await q(...)`，只有这里漏了。
       *
       * 顺带把 status 条件收紧成 `= 'fresh'`：和 listActiveItems
       * 同口径。原写法 `status <> 'deleted'` 会把 'eaten'（吃完了）
       * 和 'bought'（购物清单转来）也当成在冰箱里而清掉。 */
      const { rows } = await q(
        `UPDATE items SET status = 'deleted'
          WHERE household_id = $1 AND status = 'fresh' AND expire_at > 0 AND expire_at < $2
          RETURNING *`,
        [householdId, now],
      );
      return rows.map(rowToItem);
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
      return rows.map(rowToShopping);
    },

    async addShopping(householdId, { name, qty = 1, unit = '份' }, now = Date.now()) {
      const { rows } = await q(
        'INSERT INTO shopping (household_id, name, qty, unit, status, created_at) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *',
        [householdId, name, qty, unit, 'pending', now],
      );
      return rows[0];
    },

    /**
     * boughtItemId 是**具名参数**，不是塞进来的列名片段。
     * 原来签名是 (hh, id, status, extra)，extra 的键直接拼进 SQL：
     * 调用方传的是 boughtItemId，Postgres 折成 boughtitemid，
     * 而列名是 bought_item_id —— stock 操作一接数据库就报
     * "column does not exist"。值仍然走参数绑定。
     */
    async setShoppingStatus(householdId, id, status, boughtItemId = null) {
      await q(
        'UPDATE shopping SET status = $3, bought_item_id = $4 WHERE household_id = $1 AND id = $2',
        [householdId, id, status, boughtItemId],
      );
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
    /* 内存实现直接用 camelCase 键，跟 rowToDevice 的输出形状保持一致。
     * 早先这里存的是 device_id / created_at（照抄表名），而 pair/bind/sync
     * 读的是 device.householdId —— 键名对不上，测试全绿但一换 Postgres 就 409。 */
    async getDevice(id) { return s.devices.get(id) || null; },
    async upsertDevice(id, fields) {
      const d = s.devices.get(id) || { deviceId: id, createdAt: Date.now() };
      Object.assign(d, fields);
      s.devices.set(id, d);
      return d;
    },
    async touchDevice(id, query) {
      const d = s.devices.get(id);
      if (!d) return;
      d.lastSeenAt = Date.now();
      if (query.battery != null) d.battery = Number(query.battery);
      if (query.power) d.power = query.power;
    },
    async getHousehold(id) { return id ? (s.households.get(id) || null) : null; },
    async ensureHousehold(id, name) {
      let h = s.households.get(id);
      if (!h) { h = { id: nid(), householdId: id, name: name || '我家', createdAt: Date.now() }; s.households.set(id, h); }
      else if (name) h.name = name;
      return h;
    },
    async listActiveItems(hh, limit = 200, now = Date.now()) {
      return sortForDisplay(
        s.items.filter((i) => i.household_id === hh && i.status === 'fresh').map(rowToItem),
        now,
      ).slice(0, limit);
    },
    async getItem(hh, id) { return rowToItem(s.items.find((i) => i.household_id === hh && sameId(i.id, id))); },
    async addItem(hh, { name, qty = 1, unit = '份', expireAt = 0 }) {
      const it = { id: nid(), household_id: hh, name, qty, unit, expire_at: expireAt, status: 'fresh', created_at: Date.now() };
      s.items.push(it);
      return rowToItem(it);
    },
    async setItemStatus(hh, id, status) {
      const it = s.items.find((i) => i.household_id === hh && sameId(i.id, id));
      if (it) it.status = status;
    },
    /* 见 postgresRepo 里同名函数的注释。 */
    async cleanExpired(hh, now = Date.now()) {
      const hit = [];
      for (const it of s.items) {
        if (it.household_id !== hh) continue;
        if (it.status !== 'fresh') continue;   /* 口径和 listActiveItems 一致 */
        if (!(Number(it.expire_at) > 0 && Number(it.expire_at) < now)) continue;
        it.status = 'deleted';
        hit.push(rowToItem(it));
      }
      return hit;
    },
    async adjustQty(hh, id, delta) {
      const it = s.items.find((i) => i.household_id === hh && sameId(i.id, id));
      if (!it) return null;
      const next = (it.qty || 1) + delta;
      if (next <= 0) { it.qty = 0; it.status = 'eaten'; } else it.qty = next;
      return rowToItem(it);
    },
    async listShopping(hh, status = 'pending') {
      return s.shopping
        .filter((x) => x.household_id === hh && x.status === status)
        .sort((a, b) => b.created_at - a.created_at)
        .map(rowToShopping);
    },
    async addShopping(hh, { name, qty = 1, unit = '份' }) {
      const x = { id: nid(), household_id: hh, name, qty, unit, status: 'pending', created_at: Date.now() };
      s.shopping.push(x);
      return rowToShopping(x);
    },
    async setShoppingStatus(hh, id, status, boughtItemId = null) {
      const x = s.shopping.find((v) => v.household_id === hh && sameId(v.id, id));
      if (x) Object.assign(x, { status, bought_item_id: boughtItemId });
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

  const conn = connectionString();
  if (conn) {
    let pg;
    try {
      pg = require('pg');
    } catch {
      throw new Error(
        '设了 DATABASE_URL 但没装 pg 驱动。请跑：npm i pg\n' +
        '（Railway 上要在项目依赖里，否则部署时模块找不到）',
      );
    }
    const repo = postgresRepo(pg, conn);
    await repo.init();
    console.log(`[repo] 使用 PostgreSQL（${process.env.DATABASE_URL ? 'DATABASE_URL' : 'PG* 变量拼装'}）`);
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
  newSecret, newHouseholdId, newBindCode, connectionString,
  sortForDisplay, isExpired,
  DAY, PAIR_CODE_TTL_MS, NO_EXPIRY,
};

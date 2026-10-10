/**
 * web.js —— 网页端的 7 个接口，**用现有的路由分发实现，不引入 express。**
 *
 * ── 为什么不用 express ──
 *
 * 原来的写法（github 那个提交）是 `express.Router()` + `req.app.locals.repo`。
 * 但 server.js 顶部写着「不要为了图省事换 express」，理由很硬：
 *
 *   · express 常驻 **5~8 MB** 内存，而实测这台设备的余量只有约 20 KB
 *     （云端是 Railway 机器，但架构上照着这个约束写不会后悔）
 *   · 每个请求新建 req/res 上下文对象
 *   · 服务器就一个进程、7 个接口，引一整个框架不划算
 *
 * 所以改成 server.js 原生的 `{ status, body }` 风格：
 * 复用同一个 `repo`、同一套 `sendJson`、同一个错误处理。
 * **新增依赖：0。**
 *
 * ── 和设备端（/device/*）的区别 ──
 *
 * 设备端用 HMAC 签名（设备算得出密钥），网页端是人在手机浏览器上操作，
 * 算签名不现实，所以用 token。两者不共用鉴权代码。
 *
 * token 从 WEB_TOKEN 环境变量读，**没有默认值** ——
 * 原来的写法硬编码了 'fridge2026'，那等于任何人都能改你的冰箱。
 */

const { NO_EXPIRY } = require('./repo');

/** 取 token：优先 X-Token 头，其次 ?token=（方便直接贴链接调试）。 */
function tokenOf(ctx) {
  return ctx.headers['x-token'] || ctx.query.token || '';
}

/** 没配 WEB_TOKEN 就一律拒绝，而不是放行 —— 少一个环境变量不该变成无鉴权。 */
function authFail() {
  return {
    status: 401,
    body: { error: '未授权：请在网页里填访问密码（服务端需配置 WEB_TOKEN 环境变量）' },
  };
}

/**
 * 网页端代表哪一户。
 *
 * 原来写死 `repo.getDevice('web')` —— 那是**假设**有一个 id 叫 'web' 的
 * 设备行。实际上设备 id 是 `dev` + MAC 派生的 12 位十六进制。
 *
 * 改成从配置读（WEB_HOUSEHOLD 之外用 WEB_DEVICE），读不到就明确报错，
 * **而不是静默返回空清单** —— 后者会让人以为「冰箱是空的」。
 */
async function householdOf(repo) {
  const devId = process.env.WEB_DEVICE_ID;
  if (!devId) return { error: '服务端未配置 WEB_DEVICE_ID，无法确定是哪一户' };
  const device = await repo.getDevice(devId);
  if (!device || !device.householdId) return { error: '设备尚未绑定到家庭' };
  return { hid: device.householdId };
}

const err = (status, e) => ({ status, body: { error: e } });
const ok = (body = {}) => ({ status: 200, body });

/**
 * 处理 /web/* 请求。**不是每个都是 async** —— GET 是，返回 Promise。
 */
async function handle(ctx, repo) {
  // 鉴权在 dispatch 层做（那里知道 ctx.headers），这里只管业务
  if (tokenOf(ctx) !== (process.env.WEB_TOKEN || '')) return authFail();

  const { hid, error } = await householdOf(repo);
  if (error) return err(409, error);

  const now = Date.now();
  const p = ctx.body || {};
  const name = String(ctx.path || '').replace('/web', '');

  switch (name) {
    /* ── 清单 ── */
    case '/fridge': {
      const items = await repo.listActiveItems(hid, 200, now);
      return ok({
        items: items.map((i) => ({
          id: String(i.id ?? i._id),
          name: i.name,
          qty: i.qty,
          unit: i.unit,
          expireAt: i.expireAt,
          createdAt: i.createdAt,
        })),
      });
    }
    case '/shopping': {
      const items = await repo.listShopping(hid, 'pending');
      return ok({
        items: items.map((i) => ({ id: String(i.id ?? i._id), name: i.name, status: i.status })),
      });
    }

    /* ── 冰箱操作 ── */
    case '/add': {
      if (!p.name) return err(400, '缺少 name');
      /* **保质期一律存 0**，由服务端归一成 NO_EXPIRY。
       *
       * 原来这里算 `今天零点 + expireDays * 86400000` —— 那是固件的做法，
       * 云端不该重复。而且固件那个换算曾经漏乘 1000（秒当毫秒），
       * 同一个公式抄两遍就是同一个 bug 抄两次。 */
      /* **归一化必须在这里做，addItem 不会做。**
       *
       * 原来写 `expireAt: 0` 并注释「addItem 会归一成 NO_EXPIRY」——
       * 读代码时确实是这么以为的，实际 addItem 原样存 0。
       * 而 0 落到渲染层是「1970-01-01」，屏幕上会显示
       * 「已过期 20000 多天」。测试抓到的就是这个。
       *
       * 归一化逻辑在 repo.sortForDisplay 里，但那是**排序时**才做的，
       * 存进去的还是 0。所以写入前自己转。 */
      await repo.addItem(hid, {
        name: String(p.name),
        qty: Number(p.qty) > 0 ? Number(p.qty) : 1,
        unit: p.unit || '份',
        expireAt: p.expireDays > 0 ? now + Number(p.expireDays) * 86400000 : NO_EXPIRY,
      }, now);
      return ok();
    }
    case '/delete': {
      if (!p.id) return err(400, '缺少 id');
      await repo.setItemStatus(hid, String(p.id), 'deleted', now);
      return ok();
    }
    case '/eat': {
      if (!p.id) return err(400, '缺少 id');
      await repo.setItemStatus(hid, String(p.id), 'eaten', now);
      return ok();
    }

    /* ── 购物清单 ── */
    case '/shop': {
      /* **addShopping 一次只加一条**（签名是 `{name, qty, unit}`），
       * 不是收数组。原来直接 `addShopping(hid, names)` 把整个数组
       * 当成 `{name: [...]}` 塞进去，数据库里会存一条名字是
       * "豆腐,青菜" 的怪东西 —— 测试抓到「加了 2 项只有 1 项」。
       *
       * 顿号/逗号/空格都算分隔符：语音转写出来「豆腐 青菜 排骨」
       * 这种带空格的情况很常见。 */
      const raw = Array.isArray(p.names) ? p.names.join(',') : (p.names || p.name || '');
      const names = String(raw).split(/[、,，\s]+/).filter(Boolean);
      if (!names.length) return err(400, '缺少 names');
      for (const n of names) {
        await repo.addShopping(hid, { name: n, qty: 1, unit: '份' }, now);
      }
      return ok({ added: names.length });
    }
    case '/buy': {
      if (!p.id) return err(400, '缺少 id');
      await repo.setShoppingStatus(hid, String(p.id), 'bought', now);
      return ok();
    }

    default:
      return err(404, '未知的网页端接口');
  }
}

module.exports = { handle, tokenOf, authFail };
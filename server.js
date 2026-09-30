/**
 * server.js —— 冰箱管家服务端（Node HTTP，适配 Railway 等普通容器平台）。
 *
 * 与云开发云函数版本的唯一实质差别在**怎么拿到原始请求体**：
 *
 *   云函数  event.body 是微信/腾讯云给的结构化字段
 *   这里    必须是字节完全一致的原始 body
 *
 * 而验签算的就是这个 body 的字节。中间任何一次 JSON.parse +
 * JSON.stringify 都会改变字节（键序、空格、转义），签名立刻对不上，
 * 而 401 的报文长得跟密钥错误一模一样 —— 排查方向会被完全带偏。
 *
 * 所以这里手写 HTTP 解析并在任何解析之前把 body 存成字符串，
 * 一个字节都不动。**不要为了图省事换 express。**
 *
 * 端点与固件 main/boards/zectrix-note4/proto.h 一一对应。
 */

const http = require('http');
const { URL } = require('url');

const auth = require('./lib/auth');
const endpoints = require('./lib/endpoints');
const { createRepo } = require('./lib/repo');
const webRoutes = require('./lib/web');
const path = require('path');
const fs = require('fs');

/** 固件 net.c 的 BODY_MAX 是 256KB，这里留一点余量 */
const MAX_BODY = 256 * 1024;

/* 进程启动时刻。放进 /healthz 是为了对比 uptimeSec —— uptime 归零就说明
 * Railway 刚重新部署过；两次查询之间数据还在，才真的说明落库了。 */
const STARTED_AT_ISO = new Date().toISOString();

const PORT = Number(process.env.PORT) || 8080;
const LOG = process.env.LOG_LEVEL === 'debug';

// ────────────────────────── 请求体收集 ──────────────────────────

/**
 * 把请求体读成**字符串**，不解析。
 * @returns {Promise<{raw: string, truncated: boolean}>}
 */
function readRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let len = 0;
    let truncated = false;

    req.on('data', (c) => {
      len += c.length;
      if (len > MAX_BODY) {
        // 超出上限就丢弃后续，但要把已收到的部分交出去，
        // 让验签失败得明明白白而不是静默截断出一个更费解的签名不匹配
        if (!truncated) truncated = true;
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve({ raw: Buffer.concat(chunks).toString('utf8'), truncated }));
    req.on('error', reject);
  });
}

// ────────────────────────── 响应 ──────────────────────────

function sendJson(res, status, data, headers = {}) {
  const body = Buffer.from(JSON.stringify(data), 'utf8');
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': body.length,
    ...headers,
  });
  res.end(body);
}

/** 304 不能有 body，也不能有 Content-Length */
function send304(res, nextPollSec) {
  res.writeHead(304, {
    'X-Next-Poll': String(nextPollSec),
    'Cache-Control': 'no-store',
  });
  res.end();
}

// ────────────────────────── 路由 ──────────────────────────

/**
 * 端点表。auth=true 的走 HMAC 验签。
 * 路径是 Express 风格：/device/sync 等。
 */
const ROUTES = {
  'POST /device/pair': { auth: false },
  'POST /device/bind': { auth: false },
  'GET /device/sync': { auth: true },
  'POST /device/op': { auth: true },
  'POST /device/ack': { auth: true },
  'POST /device/voice': { auth: true },
};

/**
 * 处理一个请求，返回 { status, body, headers? } 或 304 描述。
 * **不碰 res** —— 写响应是 createServer 的事，这样 304 才能被特殊处理。
 */
async function handle(req, repo) {
  const started = Date.now();
  let url;
  try {
    url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  } catch {
    return { status: 400, body: { error: 'URL 无法解析' } };
  }

  /* 健康检查。**免鉴权、只回仓库类型，不泄露任何业务数据。**
   *
   * 存在的理由：Railway 面板上「变量到底生效没有」要靠猜 —— 保存后
   * 是自动重新部署，还是要手动点 Deploy，各版本界面不一样。有一个
   * 能从外面直接读的信号，就不用去猜界面。
   *
   * repo.kind === 'postgres' 才算真的接上数据库；'memory' 说明
   * DATABASE_URL 没注入，进程一重启数据就没。
   */
  if (url.pathname === '/healthz') {
    return {
      status: 200,
      body: {
        ok: true,
        store: repo.kind,                       // 'postgres' | 'memory'
        persistent: repo.kind === 'postgres',   // 重启后数据还在吗
        /* 诊断：只报「有哪些环境变量」，不报值。
         * store=memory 而 hasDatabaseUrl=false → 变量加到别的服务上了
         *                            （最常见：加在了 Postgres 自己那张卡）
         * store=memory 而 hasDatabaseUrl=true  → 值是空的或引用没解析出来 */
        hasDatabaseUrl: Boolean(process.env.DATABASE_URL),
        pgVars: Object.keys(process.env)
          .filter((k) => /^PG|POSTGRES|DATABASE/i.test(k))
          .sort(),
        service: process.env.RAILWAY_SERVICE_NAME || '',
        project: process.env.RAILWAY_PROJECT_NAME || '',
        uptimeSec: Math.round(process.uptime()),
        startedAt: STARTED_AT_ISO,
      },
    };
  }

  // 路径归一到端点名，规则与固件 proto_route_of 一致（剥 /device 前缀与尾斜杠）
  const route = auth.routeOf(url.pathname);
  if (!route) {
    return {
      status: 404,
      body: { error: `未知端点 ${url.pathname}`, hint: '应为 /device/{pair,bind,sync,op,ack,voice}' },
    };
  }

  const method = req.method.toUpperCase();
  // 直接查「方法 + 端点名」，路径前缀用不用都无所谓
  const entry = ROUTES[`${method} /device${route}`];

  if (!entry) {
    const want = route === '/sync' ? 'GET' : 'POST';
    return { status: 405, body: { error: `${route} 不接受 ${method}`, hint: `应为 ${want}` } };
  }

  const { raw, truncated } = await readRawBody(req);
  if (truncated) {
    return { status: 413, body: { error: '请求体过大' } };
  }

  // 固件把 body 指针原样传进签名：GET 时 body 是 NULL，参与签名的是空串
  const signBody = raw || '';

  let deviceId = null;
  if (entry.auth) {
    const result = await auth.verify({
      header: req.headers.authorization,
      method,
      route,
      body: signBody,
      lookupSecret: async (id) => {
        const d = await repo.getDevice(id);
        return d ? d.secret : null;
      },
    });
    if (!result.ok) {
      console.error(`[auth] ${method} ${route} — ${result.reason}`);
      return { status: 401, body: { error: 'unauthorized' } };
    }
    deviceId = result.deviceId;
  }

  // 签名通过之后才解析 JSON：解析失败说明对方发的是坏 JSON，
  // 与鉴权无关，错误信息要能区分开
  let body = {};
  if (signBody) {
    try {
      body = JSON.parse(signBody);
    } catch (err) {
      return { status: 400, body: { error: `请求体不是合法 JSON: ${err.message}` } };
    }
  }

  const query = Object.fromEntries(url.searchParams.entries());

  const ctx = { method, route, raw: signBody, body, query, headers: req.headers, deviceId };
  const result = await route_(route, ctx, repo);

  if (LOG) {
    console.log(`[${new Date().toISOString()}] ${method} ${url.pathname} → ${result.status} (${Date.now() - started}ms)`);
  }
  return result;
}

/** 分发到具体端点实现 */
function route_(route, ctx, repo) {
  switch (route) {
    case '/pair':  return endpoints.pair(repo, ctx);
    case '/bind':  return endpoints.bind(repo, ctx);
    case '/sync':  return endpoints.sync(repo, ctx);
    case '/op':    return endpoints.op(repo, ctx);
    case '/ack':   return endpoints.ack(repo, ctx);
    case '/voice': return endpoints.voice(repo, ctx);
    default:       return { status: 404, body: { error: '未知端点' } };
  }
}

// ────────────────────────── 启动 ──────────────────────────

/**
 * 包一层 http server：handle 只**返回**响应描述，写响应这一步在这里。
 *
 * 拆成两半是因为 304 的写法特殊：它没有 body，也不能有 Content-Length，
 * 而端点函数不该关心这些传输层细节。
 */
function createServer(repo) {
  return http.createServer(async (req, res) => {
    try {
      // 网页端路由
      if (req.url.startsWith('/web/')) {
        // 简单 token 认证
        const token = req.headers['x-token'] || new URL(req.url, 'http://x').searchParams.get('token');
        const WEB_TOKEN = process.env.WEB_TOKEN || 'fridge2026';
        if (token !== WEB_TOKEN) {
          res.writeHead(401, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: '未授权' }));
          return;
        }
        // 解析 POST body
        let body = '';
        req.on('data', c => body += c);
        req.on('end', async () => {
          try {
            req.body = body ? JSON.parse(body) : {};
          } catch {}
          req.app = { locals: { repo } };
          const router = require('./lib/web');
          // 简单路由匹配
          const path = req.url.split('?')[0].replace('/web', '') || '/';
          if (path === '/fridge' && req.method === 'GET') {
            const items = await getFridgeItems(repo);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(items));
          } else if (path === '/add' && req.method === 'POST') {
            await addFridgeItem(repo, req.body);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: true }));
          } else if (path === '/delete' && req.method === 'POST') {
            await deleteFridgeItem(repo, req.body.id);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: true }));
          } else if (path === '/eat' && req.method === 'POST') {
            await eatFridgeItem(repo, req.body.id);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: true }));
          } else if (path === '/shopping' && req.method === 'GET') {
            const items = await getShoppingItems(repo);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(items));
          } else if (path === '/shop' && req.method === 'POST') {
            await addShoppingItems(repo, req.body.names);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: true }));
          } else if (path === '/buy' && req.method === 'POST') {
            await buyShoppingItem(repo, req.body.id);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: true }));
          } else {
            res.writeHead(404, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: '未知端点' }));
          }
        });
        return;
      }

      // 首页返回网页
      if (req.url === '/' || req.url === '/index.html') {
        const html = fs.readFileSync(path.join(__dirname, 'public', 'index.html'), 'utf8');
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(html);
        return;
      }

      const r = await handle(req, repo);
      if (!r) {
        // handle 没返回东西说明已经自己写过响应了
        if (!res.writableEnded) res.end();
        return;
      }
      if (r.status === 304) return send304(res, r.nextPollSec);
      sendJson(res, r.status, r.body, r.headers);
    } catch (err) {
      console.error('[server] 未捕获异常:', err);
      if (!res.headersSent) {
        sendJson(res, 500, { error: '服务端内部错误' });
      } else if (!res.writableEnded) {
        res.end();
      }
    }
  });
}

// 网页端辅助函数
async function getWebHousehold(repo) {
  const device = await repo.getDevice('web');
  if (!device || !device.householdId) return null;
  return device.householdId;
}

async function getFridgeItems(repo) {
  const hh = await getWebHousehold(repo);
  if (!hh) return { error: '未绑定家庭，请先在设备上完成配对' };
  const items = await repo.listActiveItems(hh, 999);
  return {
    items: items.map(i => ({
      id: String(i.id),
      name: i.name,
      qty: i.qty,
      unit: i.unit,
      expireAt: i.expireAt,
      createdAt: i.createdAt,
    }))
  };
}

async function addFridgeItem(repo, body) {
  const hh = await getWebHousehold(repo);
  if (!hh) throw new Error('未绑定家庭');
  const { name, qty = 1, expireDays = 0 } = body;
  if (!name) throw new Error('缺少 name');
  let expireAt = 0;
  if (expireDays > 0) {
    const midnight = new Date(); midnight.setHours(0, 0, 0, 0);
    expireAt = midnight.getTime() + expireDays * 86400000;
  }
  await repo.addItem(hh, { name, qty, expireAt });
}

async function deleteFridgeItem(repo, id) {
  const hh = await getWebHousehold(repo);
  if (!hh) throw new Error('未绑定家庭');
  await repo.setItemStatus(hh, id, 'deleted', Date.now());
}

async function eatFridgeItem(repo, id) {
  const hh = await getWebHousehold(repo);
  if (!hh) throw new Error('未绑定家庭');
  await repo.setItemStatus(hh, id, 'eaten', Date.now());
}

async function getShoppingItems(repo) {
  const hh = await getWebHousehold(repo);
  if (!hh) return { error: '未绑定家庭' };
  const items = await repo.listShopping(hh, 'pending');
  return {
    items: items.map(i => ({
      id: String(i.id),
      name: i.name,
      status: i.status,
    }))
  };
}

async function addShoppingItems(repo, names) {
  const hh = await getWebHousehold(repo);
  if (!hh) throw new Error('未绑定家庭');
  const nameList = names.split(/[,，、\s]+/).filter(Boolean);
  for (const n of nameList) {
    await repo.addShopping(hh, { name: n, qty: 1, unit: '份' });
  }
}

async function buyShoppingItem(repo, id) {
  const hh = await getWebHousehold(repo);
  if (!hh) throw new Error('未绑定家庭');
  await repo.setShoppingStatus(hh, id, 'bought');
}

async function main() {
  const repo = await createRepo();
  const server = createServer(repo);

  server.listen(PORT, '0.0.0.0', () => {
    console.log(`冰箱管家服务端已启动: http://0.0.0.0:${PORT}`);
    console.log(`数据库: ${repo.kind}`);
    if (process.env.RAILWAY_STATIC_URL) console.log(`Railway 域名: ${process.env.RAILWAY_STATIC_URL}`);
  });
}

if (require.main === module) {
  main().catch((err) => {
    console.error('启动失败:', err);
    process.exit(1);
  });
}

module.exports = { createServer, handle, readRawBody, MAX_BODY };

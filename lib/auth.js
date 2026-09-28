/**
 * auth.js —— HMAC-SHA256 验签，与固件 proto.c / device.c 逐字对齐。
 *
 * 签名串 = ts + method + route + body，**无分隔符**。
 * route 是端点名（"/sync"），不是完整 URL 路径 —— 固件 build_url 拼的是
 * base + "/device" + route，签的却是 route 本身。
 *
 * Authorization: HMAC <deviceId>:<ts>:<sig 小写 hex>
 *
 * body 用**收到的原始字节**参与签名，不能用 JSON.stringify(event) 重新拼：
 * 空格、字段顺序、任何转义只要差一点，签名就地对不上，而 401 的报文
 * 长得跟密钥错误一模一样。
 */

const crypto = require('crypto');

/** 与固件 AUTH_FAIL_LIMIT 配套：ts 允许 ±5 分钟 */
const TS_WINDOW_MS = 5 * 60 * 1000;

const ROUTES = ['/sync', '/op', '/ack', '/voice', '/bind', '/pair'];

/**
 * 归一化路径到端点名，规则与固件 proto_route_of 一致：
 * 认 /device/sync、/sync、/sync/ 等等价形态。
 * @returns {string|null} 认不出来返回 null
 */
function routeOf(path) {
  if (typeof path !== 'string') return null;
  let p = path;
  const i = p.indexOf('/device');
  if (i >= 0) p = p.slice(i + '/device'.length);
  p = p.replace(/\/+$/, '');
  return ROUTES.includes(p) ? p : null;
}

/** 拼签名串：ts + method + route + body */
function signingString(ts, method, route, body) {
  return ts + method + route + (body || '');
}

/** 算十六进制签名 */
function sign(secret, ts, method, route, body) {
  return crypto.createHmac('sha256', secret).update(signingString(ts, method, route, body), 'utf8').digest('hex');
}

/** 定长比较，避免时序侧信道；长度不等也要走完流程再返回 false */
function safeEqual(a, b) {
  const ba = Buffer.from(String(a), 'utf8');
  const bb = Buffer.from(String(b), 'utf8');
  if (ba.length !== bb.length) {
    // 仍然做一次比较，让不同长度的耗时和等长时接近
    crypto.timingSafeEqual(ba, ba);
    return false;
  }
  return crypto.timingSafeEqual(ba, bb);
}

/**
 * 解析并校验 Authorization 头。
 * @returns {{ok:true, deviceId:string, ts:string}} | {{ok:false, reason:string}}
 */
function parseHeader(header, nowMs = Date.now()) {
  if (!header || typeof header !== 'string') return { ok: false, reason: '缺少 Authorization 头' };
  if (!header.startsWith('HMAC ')) return { ok: false, reason: 'Authorization 头格式不对（应为 "HMAC <id>:<ts>:<sig>"）' };

  const rest = header.slice(5);
  // deviceId 里没有冒号，ts 和 sig 是 hex，所以从**右边**切两次最稳
  const sigSep = rest.lastIndexOf(':');
  if (sigSep < 0) return { ok: false, reason: 'Authorization 头缺少签名字段' };
  const idSep = rest.lastIndexOf(':', sigSep - 1);
  if (idSep < 0) return { ok: false, reason: 'Authorization 头缺少时间戳字段' };

  const deviceId = rest.slice(0, idSep);
  const ts = rest.slice(idSep + 1, sigSep);
  const signature = rest.slice(sigSep + 1);

  if (!deviceId) return { ok: false, reason: 'deviceId 为空' };
  if (!/^\d+$/.test(ts)) return { ok: false, reason: `时间戳不是十进制数字串：${JSON.stringify(ts)}` };

  const tsNum = Number(ts);
  if (Math.abs(nowMs - tsNum) > TS_WINDOW_MS) {
    const skew = Math.round((tsNum - nowMs) / 1000);
    return {
      ok: false,
      reason: `时间戳超出 ±5 分钟窗口（设备时间与服务端相差 ${skew > 0 ? '+' : ''}${skew} 秒）。` +
        '设备要先通过 SNTP 对时（固件 net.c 里的 net_time_sync），否则所有请求都会被判失败',
    };
  }

  return { ok: true, deviceId, ts, signature };
}

/**
 * 完整验签：解析头 → 取设备密钥 → 重算签名 → 定长比较。
 *
 * @param opts.header     Authorization 头原文
 * @param opts.method     大写方法名（GET/POST）
 * @param opts.route      端点名（"/sync" 等），已由 routeOf 归一
 * @param opts.body       收到的原始请求体字符串，无体传空串
 * @param opts.lookupSecret  async (deviceId) => secret|null
 * @param opts.nowMs      可注入，便于测试
 */
async function verify({ header, method, route, body, lookupSecret, nowMs = Date.now() }) {
  const parsed = parseHeader(header, nowMs);
  if (!parsed.ok) return parsed;

  const secret = await lookupSecret(parsed.deviceId);
  if (!secret) {
    return { ok: false, reason: `设备 ${parsed.deviceId} 不存在或没有密钥（是否还没绑定？）` };
  }

  const expected = sign(secret, parsed.ts, method, route, body || '');
  if (!safeEqual(expected, parsed.signature)) {
    return {
      ok: false,
      reason: '签名不匹配。签名串 = ts + method + route + body，body 必须是收到的原始字节',
    };
  }
  return { ok: true, deviceId: parsed.deviceId, ts: parsed.ts };
}

module.exports = { routeOf, signingString, sign, safeEqual, parseHeader, verify, TS_WINDOW_MS, ROUTES };

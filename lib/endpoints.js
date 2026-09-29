/**
 * endpoints.js —— 六个端点的业务实现。
 *
 * 与 index.js（云函数版）共用同一套逻辑，但返回 { status, body } 而不是
 * 完整的 HTTP 响应 —— 响应怎么写由 server.js 决定，这样 304 才能被
 * 正确地写成「无 body」。
 */

const { renderHome, levelOf, levelText, daysLeft } = require('./screen');
const { newSecret, newHouseholdId, newBindCode, DEFAULT_EXPIRY_DAYS } = require('./repo');

const DEFAULT_POLL_SEC = 180;
const PAIR_CODE_TTL_MS = 10 * 60 * 1000;
const SYNC_ITEM_LIMIT = 60;
const PENDING = 'fresh';

const ok = (body, headers) => ({ status: 200, body, headers });
const err = (status, error, hint) => ({ status, body: { error, ...(hint ? { hint } : {}) } });

// ────────────────────────── pair / bind ──────────────────────────

/**
 * pair：设备开机申请配对码，免鉴权（此刻它还没有密钥）。
 * 已绑定到家庭的设备直接下发密钥，不用再走码。
 */
async function pair(repo, ctx) {
  const { deviceId, fwVersion } = ctx.body;
  if (!deviceId || typeof deviceId !== 'string') return err(400, '缺少 deviceId');

  const now = Date.now();
  const device = await repo.getDevice(deviceId);

  // 认领条件是**已绑定到家庭**，光有密钥不算：首次 pair 就会写 secret，
  // 那时 householdId 还是 null
  if (device && device.secret && device.householdId) {
    const hh = await repo.getHousehold(device.householdId);
    return ok({
      claimed: true,
      deviceSecret: device.secret,
      householdId: device.householdId,
      householdName: (hh && hh.name) || '我家',
    });
  }

  if (!device) {
    await repo.upsertDevice(deviceId, {
      secret: newSecret(), householdId: null,
      fwVersion: fwVersion || '1.0.0', lastSeenAt: now,
    }, now);
  } else {
    await repo.upsertDevice(deviceId, { lastSeenAt: now }, now);
  }

  // 10 分钟内复用同一个码：用户还没输完就换码，屏幕上数字一直变
  let pc = await repo.getValidPairCode(deviceId, now);
  if (!pc) pc = await repo.createPairCode(deviceId, newBindCode(), now + PAIR_CODE_TTL_MS, now);

  return ok({ code: pc.code, expiresInSec: Math.floor(PAIR_CODE_TTL_MS / 1000) });
}

/** bind：提交配对码换密钥，免鉴权。 */
async function bind(repo, ctx) {
  const { bindCode, deviceId } = ctx.body;
  if (!bindCode || !deviceId) return err(400, '缺少 bindCode 或 deviceId');

  const now = Date.now();
  const pc = await repo.getValidPairCode(deviceId, now);
  if (!pc || pc.code !== String(bindCode)) {
    return err(404, '配对码无效或已过期（10 分钟有效，且要与同一台设备配对）');
  }

  const device = await repo.getDevice(deviceId);
  if (!device) return err(404, '设备不存在，请先调用 /device/pair');

  let householdId = device.householdId || pc.householdId;
  if (!householdId) {
    householdId = newHouseholdId();
    await repo.upsertDevice(deviceId, { householdId }, now);
  }
  const hh = await repo.ensureHousehold(householdId, '我家', now);
  await repo.bindPairCode(pc.code, householdId, now);

  return ok({ ok: true, deviceSecret: device.secret, householdId, householdName: hh.name });
}

// ────────────────────────── sync ──────────────────────────

/**
 * sync：拉列表 + 位图。唯一会带位图的端点，也是省电的关键。
 */
async function sync(repo, ctx) {
  const device = await repo.getDevice(ctx.deviceId);
  if (!device) return err(404, '设备不存在');
  if (!device.householdId) return err(409, '设备尚未绑定到家庭，请先完成配对');

  const now = Date.now();
  await repo.touchDevice(device.deviceId, ctx.query, now);

  const items = await repo.listActiveItems(device.householdId, SYNC_ITEM_LIMIT);
  const hh = await repo.getHousehold(device.householdId);

  const expiring = items.filter((i) => {
    const d = daysLeft(i.expireAt, now);
    return d !== null && d >= 0 && d <= 3;
  });

  const screen = renderHome(items, {
    now,
    household: (hh && hh.name) || '我家',
    total: items.length,
    expiring: expiring.length,
  });

  // 判据是**设备手里的 hash**，不是云端记的 rev：设备重刷后位图丢了
  // 而云端不知道的话，只看 rev 就永远不再下发，屏幕停在空白
  const curHash = ctx.query.hash || '';
  if (curHash && curHash === screen.hash) {
    // 304 时一个像素都不许动
    return { status: 304, nextPollSec: DEFAULT_POLL_SEC };
  }

  return ok({
    // rev 存进 int32（固件 device.c 的 jnum 返回 long，ESP32 上是 4 字节）。
    // 毫秒时间戳 1.79e12 塞进去会溢出成 0x7FFFFFFF —— 不影响 304 判断
    // （那靠 screen.hash），但日志里看到 max int 很误导，排查时容易以为
    // 出过界。用秒级时间戳就落在 int32 范围内。
    rev: Math.floor(now / 1000),
    nextPollSec: DEFAULT_POLL_SEC,
    serverTime: now,
    screen: { data: screen.data, hash: screen.hash },
    items: items.map((i) => ({
      id: String(i.id ?? i._id),
      name: i.name,
      qty: i.qty,
      unit: i.unit,
      expireAt: i.expireAt || 0,
      createdAt: i.createdAt || 0,
    })),
    itemsTruncated: items.length >= SYNC_ITEM_LIMIT,
    stats: { days: 0, eaten: 0, lost: 0, topLostName: '', topLostCount: 0 },
    speakQueue: expiring.slice(0, 3).map((i) => ({
      itemId: String(i.id ?? i._id),
      level: levelOf(daysLeft(i.expireAt, now)),
      text: `${i.name}${levelText(daysLeft(i.expireAt, now))}到期`,
    })),
  }, { 'X-Next-Poll': String(DEFAULT_POLL_SEC) });
}

// ────────────────────────── op ──────────────────────────

/** 五种操作：add / delete / eaten / shop / stock */
async function op(repo, ctx) {
  const device = await repo.getDevice(ctx.deviceId);
  if (!device) return err(404, '设备不存在');
  if (!device.householdId) return err(409, '设备尚未绑定到家庭');

  const hid = device.householdId;
  const now = Date.now();
  const { op: name, opId } = ctx.body;

  // 幂等：opId 唯一，NVS 离线队列重放会重复发。少了这道闸，重放一次多一个蛋
  if (opId) {
    if (await repo.seenOp(hid, opId)) return ok({ ok: true, deduped: true });
    await repo.markOp(hid, opId, now);
  }

  switch (name) {
    case 'add': {
      const itemName = String(ctx.body.name || '').trim();
      if (!itemName) return err(400, 'add 缺少 name');

      /* expireAt 分三种情况，别用 `Number(x) || 默认` 一笔带过：
       *   字段没传        → 用户没提保质期，用兜底天数
       *   传了正数毫秒    → 用户明确说了（「保质期三天」换算来的），照用
       *   传了 0 / 垃圾值 → 同样当没提
       * `Number(0) || 默认` 恰好也能落到同一结果，但读代码的人会以为
       * 「0 会被原样存进去」，而实际不是 —— 显式写成三分支更不容易被改错。 */
      const rawExp = Number(ctx.body.expireAt);
      const userSaid = Number.isFinite(rawExp) && rawExp > 0;
      const expireAt = userSaid ? rawExp : now + DEFAULT_EXPIRY_DAYS * 86400000;

      const it = await repo.addItem(hid, {
        name: itemName,
        qty: Number(ctx.body.qty) > 0 ? Number(ctx.body.qty) : 1,
        unit: ctx.body.unit || '份',
        expireAt,
      }, now);
      return ok({ ok: true, itemId: String(it.id ?? it._id) });
    }

    case 'delete': {
      const itemId = String(ctx.body.itemId || '');
      if (!itemId) return err(400, 'delete 缺少 itemId');
      if (!(await repo.getItem(hid, itemId))) return ok({ ok: true, missing: true });
      await repo.setItemStatus(hid, itemId, 'deleted', now);
      return ok({ ok: true });
    }

    case 'eaten': {
      const itemId = String(ctx.body.itemId || '');
      if (!itemId) return err(400, 'eaten 缺少 itemId');
      const item = await repo.getItem(hid, itemId);
      if (!item) return ok({ ok: true, missing: true });
      const n = Number(ctx.body.qty) > 0 ? Number(ctx.body.qty) : (item.qty || 1);
      await repo.adjustQty(hid, itemId, -n, now);
      return ok({ ok: true });
    }

    case 'shop': {
      const names = String(ctx.body.names || '').split(/[,，、\s]+/).filter(Boolean);
      if (!names.length) return err(400, 'shop 缺少 names');
      // added/skipped 必须是**数组**：固件走 cJSON_GetArraySize，
      // 给数字会被判成 0 条，设备上会报「加了 0 项」
      const added = [];
      for (const n of names) {
        const s = await repo.addShopping(hid, { name: n, qty: 1, unit: '份' }, now);
        added.push(String(s.id ?? s._id));
      }
      return ok({ ok: true, added, skipped: [] });
    }

    case 'stock': {
      const bought = await repo.listShopping(hid, 'bought');
      const stocked = [];
      for (const s of bought) {
        const it = await repo.addItem(hid, {
          name: s.name, qty: s.qty || 1, unit: s.unit || '份', expireAt: now + 7 * 86400000,
        }, now);
        await repo.setShoppingStatus(hid, s.id, 'stocked', it.id);
        stocked.push(s.name);
      }
      return ok({ ok: true, stocked });
    }

    default:
      return err(400, `未知 op: ${name}`);
  }
}

// ────────────────────────── ack / voice ──────────────────────────

/** ack：设备回报到期分档，用于播报去重。服务端目前不参与，只回 ok。 */
async function ack(repo, ctx) {
  if (!ctx.body.itemId) return err(400, 'ack 缺少 itemId');
  return ok({ ok: true });
}

/** voice：语音上传。接 ASR + 云端 AI 后在这里实现。 */
async function voice() {
  return ok({
    asrText: '', intent: '', executed: false,
    reply: { builtinPhraseId: '', text: '语音功能尚未配置' },
  });
}

module.exports = { pair, bind, sync, op, ack, voice, DEFAULT_POLL_SEC, PENDING };

/**
 * endpoints.js —— 六个端点的业务实现。
 *
 * 与 index.js（云函数版）共用同一套逻辑，但返回 { status, body } 而不是
 * 完整的 HTTP 响应 —— 响应怎么写由 server.js 决定，这样 304 才能被
 * 正确地写成「无 body」。
 */

const { renderHome, levelOf, levelText, daysLeft, MAX_ROWS } = require('./screen');
const { newSecret, newHouseholdId, newBindCode, NO_EXPIRY } = require('./repo');

const DEFAULT_POLL_SEC = 180;
const PAIR_CODE_TTL_MS = 10 * 60 * 1000;
const SYNC_ITEM_LIMIT = 999;
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

  const all = await repo.listActiveItems(device.householdId, SYNC_ITEM_LIMIT);
  const hh = await repo.getHousehold(device.householdId);

  const expiring = all.filter((i) => {
    const d = daysLeft(i.expireAt, now);
    return d !== null && d >= 0 && d <= 3;
  });

  /* 翻页：设备按下键时带 ?page=N，云端只渲染那一页。
   *
   * 为什么分页必须在云端：中文是云端烘焙进位图的，固件没有中文字库，
   * 自己排不了版（见 screen.js 开头）。所以翻页不是「设备把画面挪一下」，
   * 是「设备换个页码重新要一张图」。
   *
   * **页码要钳位，不能信设备传来的值。** 食材被删掉之后总页数会变少，
   * 设备手里那个 page 可能已经越界（原来 3 页，删到只剩 1 页，设备还在
   * 问 page=2）。不钳的话 slice 出来是空数组，屏幕会变成一张空白页，
   * 而用户根本不知道发生了什么。
   *
   * 0 和负数也当 0 之外的值处理：page 是 1-based，非正数一律归到第 1 页。 */
  const pageCount = Math.max(1, Math.ceil(all.length / MAX_ROWS));
  let page = Math.floor(Number(ctx.query.page));
  if (!Number.isFinite(page) || page < 1) page = 1;
  if (page > pageCount) page = pageCount;
  const items = all.slice((page - 1) * MAX_ROWS, page * MAX_ROWS);

  const screen = renderHome(items, {
    now,
    household: (hh && hh.name) || '我家',
    total: all.length,
    expiring: expiring.length,
    page,
    pageCount,
  });

  // 判据是**设备手里的 hash**，不是云端记的 rev：设备重刷后位图丢了
  // 而云端不知道的话，只看 rev 就永远不再下发，屏幕停在空白
  //
  // 位图是按页渲染的，页码不同 → 位图不同 → hash 不同。所以翻页时
  // 设备手里那把上一页的 hash 必然对不上，这里一定返回 200 而不是 304。
  // 这一点是翻页能成立的前提，不能改成「只看 rev」。
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
    /* 翻页信息。设备按下键时靠这两个数决定往哪翻、总共几页。
     * pageCount 变了（食材被删）时设备下一轮就知道该夹回有效范围。 */
    page,
    pageCount,
    /* **时间戳必须是 JSON number，不能是字符串。**
     *
     * 固件那边是 `cJSON_IsNumber(v) ? (int64_t)v->valuedouble : 0` ——
     * JSON 字符串会让 cJSON_IsNumber 返回 false，expire_at / created_at
     * 直接变成 0：语音里所有食材都说「放了 0 天」，DescribeExpiring 永远
     * 列不出东西（span = 0 - 0）。
     *
     * 这个坑的来源是 node-postgres 对 BIGINT 返回字符串（精度保护），
     * 已在 repo 层用 asNumber 统一转掉；这里再 Number() 一次是双保险，
     * 内存实现和任何未来的实现都逃不掉。 */
    /* **这里给的是全量，不是当前页那几行。**
     *
     * 屏幕渲染用切片（items 变量），但设备手上的食材清单必须是全部 ——
     * 否则「冰箱里有什么」只念得出当前页，删除别的页的东西会找不到，
     * DescribeExpiring 也会漏掉不在本页的临期食材。 */
    items: all.map((i) => ({
      id: String(i.id ?? i._id),
      name: i.name,
      qty: Number(i.qty) || 1,
      unit: i.unit,
      expireAt: Number(i.expireAt) || 0,
      createdAt: Number(i.createdAt) || 0,
    })),
    itemsTruncated: all.length >= SYNC_ITEM_LIMIT,
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

      /* expireAt 只认用户**明确说过**的那个值，没说就是「没设保质期」（0）。
       *
       * 早先这里兜底成 now + 7 天，理由是「语音加东西总得有个到期日」——
       * 但那个日期**用户从没说过**，屏幕上会显示成「还剩 7 天」，
       * 看起来像是系统知道，其实纯属编的。七天之后又变成「放了 7 天」，
       * 中间还夹着一句「已过期」，全是一个不存在的事实演绎出来的。
       *
       * 不猜比猜错好：没提就是没有，屏幕只显示「放了 N 天」——
       * 那是从入库时间数出来的**事实**。要显示倒计时，用户说一声就有。 */
      /* **合理性范围检查，不只是 > 0。**
       *
       * 原来只判 `rawExp > 0`，于是「秒级时间戳」能蒙混过关：2654697600
       * （2024-01-31 的秒）被当成毫秒，存进去就是 1970-01-31，屏幕上
       * 显示「已过期 20695 天」。固件那边已经修了（mktime 返回秒却直接
       * 和毫秒天数相加），但云端要独立地守住这条线 —— 固件会更新、
       * 别的客户端也会接进来，不能指望调用方永远传对。
       *
       * 1e12 毫秒 = 2001-09-09。合理区间上界取 4e12（2096 年），
       * 与 tools 里 3650 天（十年）的上限相称。 */
      const MIN_EXP_MS = 1e12;   // 2001-09-09
      const MAX_EXP_MS = 4e12;   // 2096-05-12
      const rawExp = Number(ctx.body.expireAt);
      let userSaid = Number.isFinite(rawExp) && rawExp >= MIN_EXP_MS && rawExp <= MAX_EXP_MS;
      if (Number.isFinite(rawExp) && rawExp > 0 && !userSaid) {
        console.warn(`[add] 丢弃离谱的 expireAt=${rawExp}（合理区间 ${MIN_EXP_MS}~${MAX_EXP_MS}），按「没设保质期」处理`);
      }
      const expireAt = userSaid ? rawExp : NO_EXPIRY;

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

    /* **一次性清掉所有过期的。**
     *
     * 为什么必须有这个 op：用户说「把过期的都清掉」是个**集合操作**，
     * 而设备原来只有 remove（按名字删单个）。模型只能先 list 全部、
     * 自己挑出过期的、再一个个传 id —— 34 条清单要几十次语音往返，
     * 中途任何一步失败就只删了一半，而用户听到的却是「清好了」。
     *
     * 而且 1970 年那种坏数据（expire_at 单位错）会永远排在列表最前，
     * 逐个删需要先念出名字；交给数据库一次做完更干净。
     *
     * 破坏性操作，**必须回执**：返回清掉了哪几样、多少样，
     * 设备据此如实回答，用户才知道自己的冰箱变成了什么样。 */
    case 'clean_expired': {
      const hit = await repo.cleanExpired(hid, now);
      if (hit.length === 0) return ok({ ok: true, removed: [], count: 0 });
      return ok({
        ok: true,
        count: hit.length,
        removed: hit.map((i) => ({ id: String(i.id ?? i._id), name: i.name, qty: i.qty })),
      });
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

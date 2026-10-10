/**
 * web.js — 网页端接口。
 *
 * 与设备端（/device/*）不同，这套接口用简单的 token 认证，
 * 专为手机浏览器设计，返回 JSON 给前端页面消费。
 */

const express = require('express');
const router = express.Router();

// 简单的 token 认证（生产环境应使用更安全的方案）
const WEB_TOKEN = process.env.WEB_TOKEN || 'fridge2026';

function auth(req, res, next) {
  const token = req.headers['x-token'] || req.query.token;
  if (token !== WEB_TOKEN) {
    return res.status(401).json({ error: '未授权，请提供正确的访问密码' });
  }
  next();
}

// 获取冰箱清单
router.get('/fridge', auth, async (req, res) => {
  try {
    const repo = req.app.locals.repo;
    const device = await repo.getDevice('web');
    if (!device || !device.householdId) {
      return res.json({ error: '未绑定家庭，请先在设备上完成配对' });
    }
    const items = await repo.listActiveItems(device.householdId, 999);
    res.json({
      items: items.map(i => ({
        id: String(i.id),
        name: i.name,
        qty: i.qty,
        unit: i.unit,
        expireAt: i.expireAt,
        createdAt: i.createdAt,
      }))
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 添加食材
router.post('/add', auth, async (req, res) => {
  try {
    const repo = req.app.locals.repo;
    const device = await repo.getDevice('web');
    if (!device || !device.householdId) {
      return res.status(409).json({ error: '未绑定家庭' });
    }
    const { name, qty = 1, expireDays = 0 } = req.body;
    if (!name) return res.status(400).json({ error: '缺少 name' });

    let expireAt = 0;
    if (expireDays > 0) {
      const now = Date.now();
      const midnight = new Date(now);
      midnight.setHours(0, 0, 0, 0);
      expireAt = midnight.getTime() + expireDays * 86400000;
    }

    await repo.addItem(device.householdId, { name, qty, expireAt });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 删除食材
router.post('/delete', auth, async (req, res) => {
  try {
    const repo = req.app.locals.repo;
    const device = await repo.getDevice('web');
    if (!device || !device.householdId) {
      return res.status(409).json({ error: '未绑定家庭' });
    }
    const { id } = req.body;
    if (!id) return res.status(400).json({ error: '缺少 id' });
    await repo.setItemStatus(device.householdId, id, 'deleted', Date.now());
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 标记吃完
router.post('/eat', auth, async (req, res) => {
  try {
    const repo = req.app.locals.repo;
    const device = await repo.getDevice('web');
    if (!device || !device.householdId) {
      return res.status(409).json({ error: '未绑定家庭' });
    }
    const { id } = req.body;
    if (!id) return res.status(400).json({ error: '缺少 id' });
    await repo.setItemStatus(device.householdId, id, 'eaten', Date.now());
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 购物清单
router.get('/shopping', auth, async (req, res) => {
  try {
    const repo = req.app.locals.repo;
    const device = await repo.getDevice('web');
    if (!device || !device.householdId) {
      return res.json({ error: '未绑定家庭' });
    }
    const items = await repo.listShopping(device.householdId, 'pending');
    res.json({
      items: items.map(i => ({
        id: String(i.id),
        name: i.name,
        status: i.status,
      }))
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 添加购物项
router.post('/shop', auth, async (req, res) => {
  try {
    const repo = req.app.locals.repo;
    const device = await repo.getDevice('web');
    if (!device || !device.householdId) {
      return res.status(409).json({ error: '未绑定家庭' });
    }
    const { names } = req.body;
    if (!names) return res.status(400).json({ error: '缺少 names' });
    const nameList = names.split(/[,，、\s]+/).filter(Boolean);
    for (const n of nameList) {
      await repo.addShopping(device.householdId, { name: n, qty: 1, unit: '份' });
    }
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 标记已购买
router.post('/buy', auth, async (req, res) => {
  try {
    const repo = req.app.locals.repo;
    const device = await repo.getDevice('web');
    if (!device || !device.householdId) {
      return res.status(409).json({ error: '未绑定家庭' });
    }
    const { id } = req.body;
    if (!id) return res.status(400).json({ error: '缺少 id' });
    await repo.setShoppingStatus(device.householdId, id, 'bought');
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;

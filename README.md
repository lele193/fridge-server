# 冰箱管家服务端

固件（[fridge-manager](https://github.com/wangyihan201909-dotcom/fridge-manager)）的云端。
设备侧协议是六个 HTTPS 端点 + HMAC-SHA256 鉴权，本仓库是配套实现。

```
设备 (ESP32-S3)  ──HTTPS──▶  云函数 (CloudBase)  ──▶  云开发数据库
```

## 目录

| 路径 | 作用 |
|---|---|
| `cloudfunction/device/index.js` | 六个端点的路由与业务逻辑，repo 由外部注入 |
| `cloudfunction/device/main.js` | 云函数真正的入口，注入 CloudBase 客户端 |
| `cloudfunction/device/lib/auth.js` | HMAC 验签，与固件 `proto.c` / `device.c` 对齐 |
| `cloudfunction/device/lib/render.js` | 400×300 1bpp 画布 + RLE 编解码 |
| `cloudfunction/device/lib/screen.js` | 列表页排版 |
| `cloudfunction/device/lib/font-atlas.json` | 预烘焙字模（生成物，454 字 × 4 尺寸，221KB） |
| `cloudfunction/device/lib/db.js` | 数据访问层，含索引定义 |
| `tools/setup-db.js` | 建集合与索引，幂等 |
| `tools/build-font.js` | 从系统字体烘焙字模 |
| `tools/ttc.js` | 从 macOS 的 `.ttc` 抽出子字体 |
| `test/protocol.test.js` | 17 个端到端测试，不需要任何云凭据 |

## 本地

```bash
node --test test/protocol.test.js     # 协议自测
node tools/screen-preview.js          # 整屏渲染预览（ASCII）
node tools/preview.js 24 "鸡蛋 3天"    # 单行字模预览
```

测试用内存版 repo（`memoryRepo()`），接口与 `cloudBaseRepo()` 完全一致，
所以协议正确性可以完全离线验证。

## 部署

### 1. 开环境

[云开发控制台](https://console.cloud.tencent.com/tcb) → 新建环境，地域选上海。
记下**环境 ID**。

固件要填的地址就是 `https://<环境ID>.ap-shanghai.app.tcloudbase.com`
（见 `fridge-manager/main/boards/zectrix-note4/fridge_config.example.h`）。
这个域名由公共 CA 签发，固件用 ESP-IDF 内置的 Mozilla 根证书包就能验，不需要自己分发证书。

### 2. 建集合与索引

需要腾讯云 API 密钥（[获取](https://console.cloud.tencent.com/cam/capi)），
只认环境变量，不接受命令行传参：

```bash
export TCB_ENV=<环境ID>
export TCB_SECRET_ID=<SecretId>
export TCB_SECRET_KEY=<SecretKey>
npm i @cloudbase/node-sdk
npm run setup:db -- --env "$TCB_ENV"
```

幂等，可以反复跑。会建 5 个集合：

| 集合 | 关键索引 |
|---|---|
| `devices` | `deviceId`（唯一） |
| `households` | `householdId`（唯一） |
| `items` | `householdId + status + expireAt` ← sync 的主查询 |
| `shopping` | `householdId + status` |
| `pair_codes` | `code`（唯一） |

### 3. 传云函数

```bash
cd cloudfunction/device
npx @cloudbase/cli functions:deploy device
```

或者在控制台的云函数页面上传 `cloudfunction/device/` 目录。
**入口文件选 `main.js`**，不是 `index.js`（后者要手动注入依赖）。

### 4. 配 HTTP 访问

云开发控制台 → 云函数 → `device` → **HTTP 访问服务** → 新建。
路径填 `/device/{proxy}` 或 `/device/*`，并**开启「路径透传」**。

> 路径透传必须开。不开的话六个端点共用同一个 `event.path`，
> 服务端没法区分 sync 和 op，固件那边会全部 404。

### 5. 填固件配置

```bash
cd fridge-manager/main/boards/zectrix-note4
cp fridge_config.example.h fridge_config.h
# 把 FRIDGE_CLOUD_BASE 改成你的域名
```

## 协议要点

改任何一边都要同步另一边，固件侧参考 `proto.h` / `device.c`。

**签名串** = `ts + method + route + body`，无分隔符。`route` 是端点名
（`/sync`），不是完整路径。`Authorization: HMAC <deviceId>:<ts>:<hex>`。
`ts` 是毫秒且 ±5 分钟有效——设备必须先 SNTP 对时，否则每个请求都 401，
而报错长得跟密钥错误一模一样。

**304 时一个像素都不许下发。** 判据是设备上报的 `hash`，不是云端记的 `rev`：
设备重刷后位图丢了而云端不知道的话，只看 rev 就永远不再下发，屏幕停在空白。

**右下角 `{256,264,136,20}` 固件自绘**（时间 + 电量），云端保证不往这块画。
`render.js` 的 `RESERVED` 与固件 `zectrix_note4_board.cc` 的自绘区成对，
改错了没有编译期提示，表现是固件把云端的字擦掉。`screen-preview.js` 会检查这块全白。

**`op` 的 `added` / `skipped` 必须是数组**，不是数字。固件用
`cJSON_GetArraySize` 计数，给数字会被判成 0 条，设备上会报「加了 0 项」。

**`opId` 幂等**：固件的离线队列重放会重复发同样的 `opId`，没有这道闸，
队列重放一次就多加一个鸡蛋。

## 还没做的

- `voice` 端点：当前固定返回「语音功能尚未配置」。接 ASR + 云端 AI 后在那里实现。
- MCP 工具（`self.fridge.list` / `add` / `eaten` …）：云端 AI 操作冰箱的入口。
- `stats`：目前只填了 `days`，`eaten` / `lost` / `topLostName` 是占位。
- 屏幕只做了列表首页，配对页和错误页用了通用排版。

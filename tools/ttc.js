/**
 * ttc.js —— 从 .ttc（TrueType Collection）里抽出单个字体，重建成独立 sfnt。
 *
 * 为什么需要：macOS 的中文字体（PingFang / Songti / STHeiti）全是 .ttc，
 * 而 opentype.js 只认 'ttcf' 之外的 sfnt 头，直接 parse 会报
 * "Unsupported OpenType signature ttcf"。它的 parseBuffer 是从缓冲区
 * 偏移 0 读表目录的，所以不能直接把子字体的那一段切出来喂给它 ——
 * 切出来之后所有表的 offset 还是相对整个 .ttc 的，全错位。
 *
 * 做法：按子字体的表目录重新拼一个独立字体，把每张表拷到新缓冲区并
 * 改写 offset。校验和（head.checkSumAdjustment）不修 —— opentype.js
 * 不校验，sfnt 规范里它也只被校验工具用。
 */

const fs = require('fs');

/** 从 .ttc 读出第 index 个子字体的 sfnt 版本与全部表记录 */
function readTtcIndex(buf, index = 0) {
  const tag = buf.toString('ascii', 0, 4);
  if (tag !== 'ttcf') throw new Error(`不是 .ttc 文件（tag=${JSON.stringify(tag)}）`);

  const numFonts = buf.readUInt32BE(8);
  if (index < 0 || index >= numFonts) {
    throw new Error(`子字体下标越界：index=${index}，文件里只有 ${numFonts} 个`);
  }

  const fontOffset = buf.readUInt32BE(12 + index * 4);
  const sfntVersion = buf.readUInt32BE(fontOffset);
  const numTables = buf.readUInt16BE(fontOffset + 4);

  const tables = [];
  for (let i = 0; i < numTables; i++) {
    const rec = fontOffset + 12 + i * 16;
    tables.push({
      tag: buf.toString('ascii', rec, rec + 4),
      checksum: buf.readUInt32BE(rec + 4),
      offset: buf.readUInt32BE(rec + 8),
      length: buf.readUInt32BE(rec + 12),
    });
  }

  return { sfntVersion, numTables, tables, numFonts };
}

/** 列出 .ttc 里每个子字体的 sfnt 版本，方便挑一个可用的 */
function listFonts(file) {
  const buf = fs.readFileSync(file);
  return readTtcIndex(buf, 0).numFonts;
}

/** opentype.js 认识的 cmap 子表格式；其余的会在 parse 时直接抛错 */
const SUPPORTED_CMAP_FORMATS = new Set([0, 4, 12, 14]);

/**
 * 裁掉 cmap 里 opentype.js 不支持的子表。
 *
 * opentype.js 遍历 encodingRecord 时**遇到第一个看不懂的格式就抛异常**，
 * 而不是跳过继续找下一个。macOS 的中文字体几乎都会同时带一张
 * (platform 0, encoding 4, format 12) 的全量表和一张 Mac 专用的
 * format 6 / format 2 表 —— 只要 format 12 排在前面也照样炸。
 * 规范允许一张 cmap 只挂少量子表，删掉 Mac 专用的那张之后
 * 字形覆盖完全不变（platform 0 本来就是 Unicode 编码）。
 */
function pruneCmap(cmap) {
  const n = cmap.readUInt16BE(2);
  const keep = [];
  for (let i = 0; i < n; i++) {
    const p = 4 + i * 8;
    const offset = cmap.readUInt32BE(p + 4);
    const format = cmap.readUInt16BE(offset);
    if (SUPPORTED_CMAP_FORMATS.has(format)) {
      keep.push({
        platformID: cmap.readUInt16BE(p),
        encodingID: cmap.readUInt16BE(p + 2),
        offset,
      });
    }
  }
  if (keep.length === 0 || keep.length === n) {
    return { data: cmap, dropped: 0 };
  }

  const body = Buffer.concat(
    keep.map((k) => cmap.subarray(k.offset)),
  );
  const head = Buffer.alloc(4 + keep.length * 8);
  head.writeUInt16BE(0, 0); // version
  head.writeUInt16BE(keep.length, 2);
  let cursor = head.length;
  keep.forEach((k, i) => {
    const p = 4 + i * 8;
    head.writeUInt16BE(k.platformID, p);
    head.writeUInt16BE(k.encodingID, p + 2);
    head.writeUInt32BE(cursor, p + 4);
    cursor += cmap.length - k.offset;
  });

  return { data: Buffer.concat([head, body]), dropped: n - keep.length };
}

/**
 * 把 .ttc 的第 index 个子字体重建成独立 sfnt 缓冲区。
 * @returns {Buffer} 可直接交给 opentype.parse 的单字体字节
 */
function extractFromTtc(file, index = 0) {
  const buf = fs.readFileSync(file);
  const { sfntVersion, tables } = readTtcIndex(buf, index);

  // 先把每张表取出（cmap 顺带裁剪），再统一排布 —— 裁剪会改变表长，
  // 如果边拷贝边算 offset 就得写两遍。
  const parts = tables.map((t) => {
    const raw = buf.subarray(t.offset, t.offset + t.length);
    if (t.tag !== 'cmap') return { tag: t.tag, checksum: t.checksum, data: raw };
    const { data, dropped } = pruneCmap(Buffer.from(raw));
    if (dropped) {
      console.error(`  cmap: 丢掉 ${dropped} 张 opentype.js 不支持的子表`);
    }
    return { tag: t.tag, checksum: t.checksum, data };
  });

  const align4 = (n) => (n + 3) & ~3;
  const headerSize = 12 + parts.length * 16;
  let cursor = align4(headerSize);
  for (const p of parts) cursor = align4(cursor + p.data.length);

  const out = Buffer.alloc(cursor, 0);
  out.writeUInt32BE(sfntVersion, 0);

  // 表目录里的 searchRange / entrySelector / rangeShift：二进制搜索提示，
  // 解析器不看，但按规范填上免得某些工具报「字体损坏」。
  // 头部布局是 sfntVersion(4) numTables(2) searchRange(2) entrySelector(2) rangeShift(2)。
  const pow2 = Math.floor(Math.log2(parts.length));
  const searchRange = 16 * 2 ** pow2;
  out.writeUInt16BE(parts.length, 4);
  out.writeUInt16BE(searchRange, 6);
  out.writeUInt16BE(pow2, 8);
  out.writeUInt16BE(parts.length * 16 - searchRange, 10);

  let off = align4(headerSize);
  parts.forEach((p, i) => {
    const rec = 12 + i * 16;
    out.write(p.tag, rec, 4, 'ascii');
    out.writeUInt32BE(p.checksum, rec + 4);
    out.writeUInt32BE(off, rec + 8);
    out.writeUInt32BE(p.data.length, rec + 12);
    p.data.copy(out, off);
    off = align4(off + p.data.length);
  });

  return out;
}

/** 打开字体文件：.ttf/.otf 直接读，.ttc 抽第一个子字体 */
function loadFont(file, index = 0) {
  const opentype = require('opentype.js');
  const fd = fs.openSync(file, 'r');
  const tag = Buffer.alloc(4);
  fs.readSync(fd, tag, 0, 4, 0);
  fs.closeSync(fd);

  const isTtc = tag.toString('ascii') === 'ttcf';
  const data = isTtc ? extractFromTtc(file, index) : fs.readFileSync(file);
  const buf = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
  return { font: opentype.parse(buf), isTtc };
}

module.exports = { loadFont, extractFromTtc, listFonts, readTtcIndex };

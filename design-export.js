// =====================================================================================
// 設計：匯出與專案檔（網頁版專用，外掛不需要；updater.js／deploy.js 的 SKIP 會略過 design-*）
//
// - PNG：在 IHDR 後插入 pHYs；JPG：墊白底、寫入 JFIF 密度。預設 300 DPI、品質 0.95、1 倍；匯出彈窗可改倍率、品質、DPI、頁面範圍。
// - ZIP：只儲存、不壓縮的寫入器（CRC-32、本地檔頭、中央目錄）。
// - 專案檔：{app:'QuickPatterntool-design', version:1, doc}，資產以 data URL 內嵌，最長邊縮到 2048。
// 依接縫原則，CRC-32／ZIP／pHYs／JFIF 都自備一份（不引用 app.js、deploy.js、collage.js）。
// render、fonts、core 一律在「用到時」才從 QPTDesign 讀（或由參數注入），不在載入時假設存在。
// 瀏覽器掛在 QPTDesign.export，node 用 module.exports（test/design-export.test.js）。
// =====================================================================================
(function (root) {
  'use strict';

  const APP_ID = 'QuickPatterntool-design';
  const MAX_ASSET_SIDE = 2048;
  const JPG_QUALITY = 0.95;
  const MAX_OUTPUT_SIDE = 8192;          // 匯出倍率放大後的長邊上限（瀏覽器 canvas 太大會畫不出來）
  const NOT_PROJECT = '不是有效的設計專案檔';
  const NO_CLIPBOARD = '這個瀏覽器不支援複製圖片，請改用下載';

  const lazy = name => (root.QPTDesign && root.QPTDesign[name]) || null;

  // ---- CRC-32 ---------------------------------------------------------------------
  let crcTable = null;
  function crc32(bytes) {
    if (!crcTable) {
      crcTable = new Uint32Array(256);
      for (let n = 0; n < 256; n++) {
        let c = n;
        for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
        crcTable[n] = c >>> 0;
      }
    }
    let crc = 0xFFFFFFFF;
    for (let i = 0; i < bytes.length; i++) crc = crcTable[(crc ^ bytes[i]) & 0xFF] ^ (crc >>> 8);
    return (crc ^ 0xFFFFFFFF) >>> 0;
  }
  const u32be = (b, o, v) => { b[o] = (v >>> 24) & 255; b[o + 1] = (v >>> 16) & 255; b[o + 2] = (v >>> 8) & 255; b[o + 3] = v & 255; };

  // ---- PNG：pHYs --------------------------------------------------------------------
  const PNG_SIG = [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A];
  // 在 IHDR 之後插入 pHYs（PNG 規定它要在 IDAT 前）；本來就有 pHYs 就換掉，不重複。不是 PNG 就原樣回傳。
  function pngWithDpi(bytes, dpi) {
    dpi = dpi || 300;
    if (bytes.length < 33 || PNG_SIG.some((v, i) => bytes[i] !== v)) return bytes;
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const ppm = Math.round(dpi / 0.0254);
    const phys = new Uint8Array(21);                         // 長度4＋型別4＋資料9＋CRC4
    u32be(phys, 0, 9);
    phys.set([0x70, 0x48, 0x59, 0x73], 4);                    // "pHYs"
    u32be(phys, 8, ppm); u32be(phys, 12, ppm); phys[16] = 1;  // 單位：公尺
    u32be(phys, 17, crc32(phys.subarray(4, 17)));
    const parts = [bytes.subarray(0, 8)];
    let off = 8, inserted = false;
    while (off + 12 <= bytes.length) {
      const len = dv.getUint32(off);
      const type = String.fromCharCode(bytes[off + 4], bytes[off + 5], bytes[off + 6], bytes[off + 7]);
      const end = Math.min(bytes.length, off + 12 + len);
      if (type !== 'pHYs') parts.push(bytes.subarray(off, end));
      if (type === 'IHDR' && !inserted) { parts.push(phys); inserted = true; }
      off = end;
    }
    if (!inserted) return bytes;
    return concat(parts);
  }

  // ---- JPG：JFIF 密度 -----------------------------------------------------------------
  function jpgWithDpi(bytes, dpi) {
    dpi = dpi || 300;
    const b = bytes;
    const ok = b.length >= 18 && b[0] === 0xFF && b[1] === 0xD8 && b[2] === 0xFF && b[3] === 0xE0 &&
      b[6] === 0x4A && b[7] === 0x46 && b[8] === 0x49 && b[9] === 0x46 && b[10] === 0;
    if (!ok) return bytes;
    const out = new Uint8Array(b);
    out[13] = 1;                                              // 單位：每英寸點數
    out[14] = dpi >> 8; out[15] = dpi & 255; out[16] = dpi >> 8; out[17] = dpi & 255;
    return out;
  }

  function concat(parts) {
    let n = 0;
    for (const p of parts) n += p.length;
    const out = new Uint8Array(n);
    let o = 0;
    for (const p of parts) { out.set(p, o); o += p.length; }
    return out;
  }

  // ---- ZIP（只儲存、不壓縮）-------------------------------------------------------------
  function buildZip(entries, date) {
    date = date || new Date();
    const enc = new TextEncoder();
    const dosTime = (date.getHours() << 11) | (date.getMinutes() << 5) | (date.getSeconds() >> 1);
    const dosDate = ((date.getFullYear() - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate();
    const local = [], central = [];
    let offset = 0;
    for (const e of entries) {
      const name = enc.encode(e.name);
      const crc = crc32(e.bytes);
      const lh = new Uint8Array(30), l = new DataView(lh.buffer);
      l.setUint32(0, 0x04034b50, true); l.setUint16(4, 20, true); l.setUint16(6, 0x0800, true);   // 0x0800＝檔名為 UTF-8
      l.setUint16(8, 0, true); l.setUint16(10, dosTime, true); l.setUint16(12, dosDate, true);
      l.setUint32(14, crc, true); l.setUint32(18, e.bytes.length, true); l.setUint32(22, e.bytes.length, true);
      l.setUint16(26, name.length, true); l.setUint16(28, 0, true);
      local.push(lh, name, e.bytes);
      const ch = new Uint8Array(46), c = new DataView(ch.buffer);
      c.setUint32(0, 0x02014b50, true); c.setUint16(4, 20, true); c.setUint16(6, 20, true); c.setUint16(8, 0x0800, true);
      c.setUint16(10, 0, true); c.setUint16(12, dosTime, true); c.setUint16(14, dosDate, true);
      c.setUint32(16, crc, true); c.setUint32(20, e.bytes.length, true); c.setUint32(24, e.bytes.length, true);
      c.setUint16(28, name.length, true); c.setUint32(42, offset, true);
      central.push(ch, name);
      offset += 30 + name.length + e.bytes.length;
    }
    const centralSize = central.reduce((n, p) => n + p.length, 0);
    const end = new Uint8Array(22), ev = new DataView(end.buffer);
    ev.setUint32(0, 0x06054b50, true);
    ev.setUint16(8, entries.length, true); ev.setUint16(10, entries.length, true);
    ev.setUint32(12, centralSize, true); ev.setUint32(16, offset, true);
    return concat([...local, ...central, end]);
  }

  // ---- 渲染輸出 -----------------------------------------------------------------------
  const pad2 = n => String(n).padStart(2, '0');
  const toBytes = async blob => new Uint8Array(await blob.arrayBuffer());

  // env = { fonts, images, stickers, loadImages(doc) → Promise, render?, createCanvas? }（由 UI 提供）
  async function renderPage(doc, pageIndex, env, opts) {
    const fmt = (opts && opts.fmt) || 'png';
    const scale = (opts && opts.scale) || 1;
    const page = doc.pages[pageIndex];
    if (!page) throw new Error('找不到這一頁');
    const W = Math.round(page.w * scale), H = Math.round(page.h * scale);
    if (!(scale > 0) || Math.max(W, H) > MAX_OUTPUT_SIDE) throw new Error(`輸出尺寸 ${W}×${H} 太大，長邊不能超過 ${MAX_OUTPUT_SIDE}px，請改用較小的倍率`);
    // 一律先等字型與影像，避免第一次匯出悄悄換成備用字型
    if (!(opts && opts.skipFontWait) && env.fonts && env.fonts.ready) await env.fonts.ready(doc);
    if (env.loadImages) await env.loadImages(doc);
    const R = env.render || lazy('render');
    if (!R) throw new Error('渲染模組尚未載入');
    const canvas = env.createCanvas ? env.createCanvas(W, H) : root.document.createElement('canvas');
    canvas.width = W; canvas.height = H;
    const ctx = canvas.getContext('2d');
    const draw = () => {
      ctx.clearRect(0, 0, W, H);
      if (fmt === 'jpg') { ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, W, H); }   // JPG 沒有透明，墊白
      return R.render(ctx, page, { scale, images: env.images, stickers: env.stickers, fonts: env.fonts });
    };
    let res = draw();
    if (res && res.pending && env.loadImages) { await env.loadImages(doc); res = draw(); }
    return canvas;
  }

  function canvasToBlob(canvas, fmt, quality) {
    return new Promise((resolve, reject) => canvas.toBlob(
      b => (b ? resolve(b) : reject(new Error('產生圖片失敗'))),
      fmt === 'jpg' ? 'image/jpeg' : 'image/png', fmt === 'jpg' ? quality : undefined));
  }
  // opts = { scale=1, quality=0.95（只有 JPG）, dpi=300, skipFontWait }（匯出彈窗的設定）
  async function exportPage(doc, i, fmt, env, opts) {
    opts = opts || {};
    fmt = fmt === 'jpg' ? 'jpg' : 'png';
    const quality = Math.min(1, Math.max(0.5, opts.quality || JPG_QUALITY));
    const dpi = opts.dpi || 300;
    const canvas = await renderPage(doc, i, env, { fmt, scale: opts.scale || 1, skipFontWait: !!opts.skipFontWait });
    const bytes = await toBytes(await canvasToBlob(canvas, fmt, quality));
    return new Blob([fmt === 'jpg' ? jpgWithDpi(bytes, dpi) : pngWithDpi(bytes, dpi)], { type: fmt === 'jpg' ? 'image/jpeg' : 'image/png' });
  }
  // opts 同 exportPage，另加 pages（0 起算的頁碼陣列；不給就是全部頁）。檔名用原本的頁碼 page-02.png…
  async function exportZip(doc, fmt, env, opts) {
    opts = opts || {};
    fmt = fmt === 'jpg' ? 'jpg' : 'png';
    const pages = opts.pages || doc.pages.map((_, i) => i);
    const entries = [];
    // 字型只等一次（字型請求卡住時，不會每頁各等一次）；之後每頁不再等
    if (env && env.fonts && env.fonts.ready) await env.fonts.ready(doc);
    for (const i of pages) {
      const blob = await exportPage(doc, i, fmt, env, Object.assign({}, opts, { skipFontWait: true }));
      entries.push({ name: `page-${pad2(i + 1)}.${fmt}`, bytes: await toBytes(blob) });
    }
    return new Blob([buildZip(entries)], { type: 'application/zip' });
  }
  async function copyPage(doc, i, env, opts) {
    const nav = (env && env.navigator) || root.navigator;
    const CI = (env && env.ClipboardItem) || root.ClipboardItem;
    if (!nav || !nav.clipboard || !nav.clipboard.write || typeof CI !== 'function') return { ok: false, reason: NO_CLIPBOARD };
    try {
      const blob = await exportPage(doc, i, 'png', env, opts);
      await nav.clipboard.write([new CI({ 'image/png': blob })]);
      return { ok: true };
    } catch (e) { return { ok: false, reason: NO_CLIPBOARD }; }
  }

  // 頁面範圍「1-3, 5」→ { ok:true, pages:[0,1,2,4] }（0 起算、排序去重）；全形數字與連字號也收
  function parsePages(str, total) {
    const s = String(str || '').replace(/[０-９]/g, c => String.fromCharCode(c.charCodeAt(0) - 0xFEE0))
      .replace(/[－—–~～]/g, '-').replace(/[，、]/g, ',').replace(/\s+/g, '');
    const bad = { ok: false, reason: `頁面範圍看不懂，請寫成像「1-3, 5」這樣（共 ${total} 頁）` };
    if (!s) return bad;
    const set = new Set();
    for (const part of s.split(',')) {
      const m = /^(\d+)(?:-(\d+))?$/.exec(part);
      if (!m) return bad;
      const a = +m[1], b = m[2] ? +m[2] : a;
      if (a < 1 || b > total || a > b) return { ok: false, reason: `頁面範圍要在 1～${total} 之間，而且前面的數字不能比後面大` };
      for (let i = a; i <= b; i++) set.add(i - 1);
    }
    return { ok: true, pages: [...set].sort((x, y) => x - y) };
  }

  // ---- 專案檔 -------------------------------------------------------------------------
  async function blobToDataUrl(blob) {
    const b = await toBytes(blob);
    let s = '';
    for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode.apply(null, b.subarray(i, i + 0x8000));
    return `data:${blob.type || 'application/octet-stream'};base64,${btoa(s)}`;
  }
  function dataUrlToBlob(url) {
    const m = /^data:([^;,]*)((?:;[^;,]*)*),([\s\S]*)$/.exec(String(url));
    if (!m || !/;base64/.test(m[2])) return null;
    try {
      const bin = atob(m[3]);
      const b = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) b[i] = bin.charCodeAt(i);
      return new Blob([b], { type: m[1] || 'application/octet-stream' });
    } catch (e) { return null; }
  }
  // 解碼圖片：優先 createImageBitmap；失敗（例如格式不支援）退回 <img>＋Object URL；仍失敗丟繁中錯誤
  async function decodeBlob(blob) {
    try {
      if (typeof root.createImageBitmap === 'function') return await root.createImageBitmap(blob);
    } catch (e) { /* 退回 <img> */ }
    try {
      const url = root.URL.createObjectURL(blob);
      try {
        const img = root.document.createElement('img');
        await new Promise((resolve, reject) => { img.onload = resolve; img.onerror = () => reject(new Error('decode')); img.src = url; });
        return { width: img.naturalWidth || img.width, height: img.naturalHeight || img.height, close() {}, source: img };
      } finally { root.URL.revokeObjectURL(url); }
    } catch (e) { throw new Error('無法讀取圖片，請換一張圖片再試'); }
  }
  // 預設縮圖實作（canvas）：最長邊超過 maxSide 才縮。
  // SVG 是向量，直接沿用原檔；只有原檔是 JPEG 才輸出 JPEG，其他格式（含透明的 WebP／GIF／AVIF）一律輸出 PNG 以保留透明。
  async function downscaleBlob(blob, maxSide) {
    if (blob.type === 'image/svg+xml') return blob;
    const bmp = await decodeBlob(blob);
    const long = Math.max(bmp.width, bmp.height);
    if (long <= maxSide) { if (bmp.close) bmp.close(); return blob; }
    const k = maxSide / long;
    const c = root.document.createElement('canvas');
    c.width = Math.max(1, Math.round(bmp.width * k)); c.height = Math.max(1, Math.round(bmp.height * k));
    const ctx = c.getContext('2d');
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(bmp.source || bmp, 0, 0, c.width, c.height);
    if (bmp.close) bmp.close();
    const jpeg = blob.type === 'image/jpeg';
    return new Promise((resolve, reject) => c.toBlob(b => (b ? resolve(b) : reject(new Error('縮小圖片失敗'))), jpeg ? 'image/jpeg' : 'image/png', jpeg ? 0.92 : undefined));
  }

  // blobs：{ [assetId]: Blob }。回傳 JSON 字串；沒被引用的資產不寫進檔案。
  async function serializeProject(doc, blobs, opts) {
    opts = opts || {};
    const down = opts.downscale || downscaleBlob;
    const core = opts.core || lazy('core');
    const copy = JSON.parse(JSON.stringify(doc));
    if (core && core.pruneAssets) core.pruneAssets(copy);
    for (const id of Object.keys(copy.assets || {})) {
      const blob = blobs && blobs[id];
      if (!blob) throw new Error(`資產 ${id} 缺少圖片資料，無法存檔`);
      const meta = copy.assets[id];
      const small = await down(blob, MAX_ASSET_SIDE);
      const long = Math.max(meta.w || 0, meta.h || 0);
      if (long > MAX_ASSET_SIDE) {                         // 資產尺寸跟著縮（比例不變，版面不受影響）
        const k = MAX_ASSET_SIDE / long;
        meta.w = Math.max(1, Math.round(meta.w * k)); meta.h = Math.max(1, Math.round(meta.h * k));
      }
      if (small.type) meta.mime = small.type;
      meta.data = await blobToDataUrl(small);
    }
    return JSON.stringify({ app: APP_ID, version: copy.version || 1, doc: copy });
  }

  // input：File／Blob／字串。依序檢查：大小 → JSON → app → migrate → 資產解碼。失敗不丟錯，回 {ok:false,reason}
  async function parseProject(input, opts) {
    opts = opts || {};
    const maxBytes = opts.maxBytes != null ? opts.maxBytes : 100 * 1024 * 1024;
    const fail = reason => ({ ok: false, reason });
    try {
      const size = typeof input === 'string' ? new Blob([input]).size : input.size;
      if (size > maxBytes) return fail('檔案超過 100MB');
      const text = typeof input === 'string' ? input : await input.text();
      let obj;
      try { obj = JSON.parse(text); } catch (e) { return fail(NOT_PROJECT); }
      if (!obj || typeof obj !== 'object' || obj.app !== APP_ID || !obj.doc || typeof obj.doc !== 'object') return fail(NOT_PROJECT);
      if (Number(obj.version) > 1) return fail('這個檔案是用較新版本的設計工具建立的，請先更新後再開啟');
      // 先把 data 取出來，因為 migrate 不一定保留資產的額外欄位
      const datas = {};
      const rawAssets = obj.doc.assets && typeof obj.doc.assets === 'object' ? obj.doc.assets : {};
      for (const id of Object.keys(rawAssets)) datas[id] = rawAssets[id] && rawAssets[id].data;
      const migrate = opts.migrate || (lazy('core') && lazy('core').migrate);
      if (!migrate) return fail('無法讀取專案檔（核心模組尚未載入）');
      const r = migrate(obj.doc);
      if (!r || !r.ok) return fail((r && r.reason) || NOT_PROJECT);
      const doc = r.doc, blobs = {};
      for (const id of Object.keys(doc.assets || {})) {
        const blob = typeof datas[id] === 'string' ? dataUrlToBlob(datas[id]) : null;
        if (!blob) return fail(NOT_PROJECT);
        blobs[id] = blob;
        delete doc.assets[id].data;
      }
      return { ok: true, doc, blobs };
    } catch (e) { return fail(NOT_PROJECT); }
  }

  const api = {
    crc32, pngWithDpi, jpgWithDpi, buildZip,
    renderPage, exportPage, exportZip, copyPage, parsePages, MAX_OUTPUT_SIDE,
    serializeProject, parseProject, downscaleBlob,
    APP_ID,
  };
  const Q = root.QPTDesign = root.QPTDesign || {};
  Q['export'] = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);

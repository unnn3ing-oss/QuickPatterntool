// 設計：匯出（位元組工具、ZIP、專案檔序列化／解析）。不碰 DOM。
const test = require('node:test');
const assert = require('node:assert/strict');
const X = require('../design-export.js');

const PNG1 = new Uint8Array(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64'));
const dv = b => new DataView(b.buffer, b.byteOffset, b.byteLength);
const str = (b, o, n) => String.fromCharCode(...b.subarray(o, o + n));
const chunks = b => { const out = []; let o = 8; while (o < b.length) { const len = dv(b).getUint32(o); out.push({ type: str(b, o + 4, 4), off: o, len }); o += 12 + len; } return out; };
const HAS_ZH = /[一-鿿]/;

test('crc32("123456789") === 0xCBF43926', () => {
  assert.equal(X.crc32(new TextEncoder().encode('123456789')), 0xCBF43926);
  assert.equal(X.crc32(new Uint8Array(0)), 0);
});

test('pngWithDpi 插在 IHDR 後，CRC 正確，重複呼叫只有一個 pHYs', () => {
  const out = X.pngWithDpi(PNG1, 300);
  assert.equal(str(out, 33 + 4, 4), 'pHYs', '第 33 位元組起是 pHYs 區塊');
  assert.equal(str(out, 12, 4), 'IHDR');
  const v = dv(out);
  assert.equal(v.getUint32(33), 9);
  assert.equal(v.getUint32(41), 11811);
  assert.equal(v.getUint32(45), 11811);
  assert.equal(out[49], 1);
  assert.equal(v.getUint32(50), X.crc32(out.subarray(37, 50)));
  assert.equal(out.length, PNG1.length + 21);
  const again = X.pngWithDpi(out, 300);
  assert.equal(chunks(again).filter(c => c.type === 'pHYs').length, 1);
  assert.deepEqual(Array.from(again), Array.from(out));
  // 其他區塊都還在，順序不變
  assert.deepEqual(chunks(out).map(c => c.type), ['IHDR', 'pHYs', 'IDAT', 'IEND']);
});

test('pngWithDpi 換掉舊的 pHYs（不同 dpi）', () => {
  const a = X.pngWithDpi(PNG1, 72);
  const b = X.pngWithDpi(a, 300);
  assert.equal(chunks(b).filter(c => c.type === 'pHYs').length, 1);
  assert.equal(dv(b).getUint32(41), 11811);
});

test('pngWithDpi 不是 PNG 就原樣回傳', () => {
  const junk = new Uint8Array(100).fill(7);
  assert.equal(X.pngWithDpi(junk), junk);
});

test('jpgWithDpi 改 JFIF 密度；不是 JFIF 原樣回傳', () => {
  const j = new Uint8Array(30);
  j.set([0xFF, 0xD8, 0xFF, 0xE0, 0, 16, 0x4A, 0x46, 0x49, 0x46, 0, 1, 1, 0, 0, 1, 0, 1, 0, 0]);
  const out = X.jpgWithDpi(j, 300);
  assert.equal(out[13], 1);
  assert.deepEqual([out[14], out[15], out[16], out[17]], [0x01, 0x2C, 0x01, 0x2C]);
  assert.equal(j[13], 0, '不改動輸入');
  const exif = new Uint8Array(30); exif.set([0xFF, 0xD8, 0xFF, 0xE1]);
  assert.equal(X.jpgWithDpi(exif, 300), exif);
});

test('buildZip 單檔位元組結構', () => {
  const date = new Date(2024, 4, 17, 13, 45, 30);
  const z = X.buildZip([{ name: 'a.txt', bytes: new TextEncoder().encode('hi') }], date);
  const v = dv(z);
  assert.equal(v.getUint32(0, true), 0x04034b50);
  assert.equal(v.getUint16(6, true), 0x0800, 'UTF-8 檔名旗標');
  assert.equal(v.getUint16(8, true), 0, '方法 0＝只儲存');
  assert.equal(v.getUint16(10, true), (13 << 11) | (45 << 5) | 15);
  assert.equal(v.getUint16(12, true), ((2024 - 1980) << 9) | (5 << 5) | 17);
  assert.equal(v.getUint32(14, true), X.crc32(new TextEncoder().encode('hi')));
  assert.equal(v.getUint32(18, true), 2);
  assert.equal(v.getUint32(22, true), 2);
  assert.equal(v.getUint16(26, true), 5);
  assert.equal(str(z, 30, 5), 'a.txt');
  assert.equal(str(z, 35, 2), 'hi');
  const cd = 30 + 5 + 2;
  assert.equal(v.getUint32(cd, true), 0x02014b50);
  assert.equal(v.getUint32(cd + 16, true), X.crc32(new TextEncoder().encode('hi')));
  assert.equal(v.getUint32(cd + 42, true), 0, '本地檔頭位移');
  assert.equal(str(z, cd + 46, 5), 'a.txt');
  const eocd = cd + 46 + 5;
  assert.equal(v.getUint32(eocd, true), 0x06054b50);
  assert.equal(v.getUint16(eocd + 8, true), 1);
  assert.equal(v.getUint16(eocd + 10, true), 1);
  assert.equal(v.getUint32(eocd + 12, true), 46 + 5, '中央目錄大小');
  assert.equal(v.getUint32(eocd + 16, true), cd, '中央目錄位移');
  assert.equal(z.length, eocd + 22);
});

test('buildZip 多檔順序、檔名與位移', () => {
  const e = [
    { name: 'page-01.png', bytes: new Uint8Array([1, 2, 3]) },
    { name: 'page-02.png', bytes: new Uint8Array([4, 5]) },
    { name: '頁面-03.png', bytes: new Uint8Array(0) },
  ];
  const z = X.buildZip(e);
  const v = dv(z);
  const eocd = z.length - 22;
  assert.equal(v.getUint16(eocd + 10, true), 3);
  let o = v.getUint32(eocd + 16, true);
  const names = [], offs = [];
  for (let i = 0; i < 3; i++) {
    assert.equal(v.getUint32(o, true), 0x02014b50);
    const nl = v.getUint16(o + 28, true);
    names.push(new TextDecoder().decode(z.subarray(o + 46, o + 46 + nl)));
    offs.push(v.getUint32(o + 42, true));
    o += 46 + nl;
  }
  assert.deepEqual(names, ['page-01.png', 'page-02.png', '頁面-03.png']);
  assert.equal(offs[0], 0);
  assert.equal(offs[1], 30 + 11 + 3);
  for (const off of offs) assert.equal(v.getUint32(off, true), 0x04034b50);
  assert.deepEqual(Array.from(z.subarray(30 + 11, 30 + 11 + 3)), [1, 2, 3]);
});

const goodDoc = () => ({ version: 1, pages: [{ id: 'p1', w: 100, h: 100, bg: { type: 'solid', color: '#fff' }, objects: [{ id: 'o1', type: 'image', asset: 'a1' }] }], assets: { a1: { name: 'x.png', w: 4000, h: 2000, mime: 'image/png' } } });
const okMigrate = d => ({ ok: true, doc: d });

test('parseProject 拒絕壞檔，reason 都有中文', async () => {
  const cases = [
    ['非 JSON', 'not json{', {}, null],
    ['app 不對', JSON.stringify({ app: 'other', version: 1, doc: goodDoc() }), {}, null],
    ['沒有 doc', JSON.stringify({ app: 'QuickPatterntool-design', version: 1 }), {}, null],
    ['超過大小', JSON.stringify({ app: 'QuickPatterntool-design', version: 1, doc: goodDoc() }), { maxBytes: 10 }, /100MB/],
    ['缺少 migrate', JSON.stringify({ app: 'QuickPatterntool-design', version: 1, doc: goodDoc() }), {}, null],
  ];
  for (const [name, text, opts, re] of cases) {
    const r = await X.parseProject(text, { migrate: name === '缺少 migrate' ? undefined : okMigrate, ...opts });
    assert.equal(r.ok, false, name);
    assert.match(r.reason, HAS_ZH, name);
    if (re) assert.match(r.reason, re, name);
  }
  assert.equal((await X.parseProject('not json{', { migrate: okMigrate })).reason, '不是有效的設計專案檔');
});

test('parseProject 沿用 migrate 的 reason；Blob 輸入也可', async () => {
  const text = JSON.stringify({ app: 'QuickPatterntool-design', version: 1, doc: { version: 2 } });
  const r = await X.parseProject(new Blob([text]), { migrate: () => ({ ok: false, reason: '這個檔案來自較新版本，請更新工具' }) });
  assert.equal(r.ok, false);
  assert.equal(r.reason, '這個檔案來自較新版本，請更新工具');
});

test('parseProject 資產缺資料時拒絕', async () => {
  const text = JSON.stringify({ app: 'QuickPatterntool-design', version: 1, doc: goodDoc() });   // a1 沒有 data
  const r = await X.parseProject(text, { migrate: okMigrate });
  assert.equal(r.ok, false);
  assert.match(r.reason, HAS_ZH);
});

test('serializeProject → parseProject 來回一致；downscale 收到 2048；沒被引用的資產不寫入', async () => {
  const doc = goodDoc();
  doc.assets.a2 = { name: 'unused.png', w: 10, h: 10, mime: 'image/png' };
  const blobs = { a1: new Blob([PNG1], { type: 'image/png' }), a2: new Blob([new Uint8Array([9])], { type: 'image/png' }) };
  const seen = [];
  const core = { pruneAssets: d => { const used = new Set(); for (const p of d.pages) for (const o of p.objects) if (o.asset) used.add(o.asset); const gone = Object.keys(d.assets).filter(k => !used.has(k)); gone.forEach(k => delete d.assets[k]); return gone; } };
  const before = JSON.stringify(doc);
  const json = await X.serializeProject(doc, blobs, { core, downscale: async (b, side) => { seen.push(side); return b; } });
  assert.equal(JSON.stringify(doc), before, '不改動原文件');
  assert.deepEqual(seen, [2048]);
  const obj = JSON.parse(json);
  assert.equal(obj.app, 'QuickPatterntool-design');
  assert.equal(obj.version, 1);
  assert.deepEqual(Object.keys(obj.doc.assets), ['a1']);
  assert.match(obj.doc.assets.a1.data, /^data:image\/png;base64,/);
  assert.equal(obj.doc.assets.a1.w, 2048, '資產尺寸跟著縮');
  assert.equal(obj.doc.assets.a1.h, 1024);

  const r = await X.parseProject(json, { migrate: okMigrate });
  assert.equal(r.ok, true);
  assert.deepEqual(Object.keys(r.blobs), ['a1']);
  assert.equal(r.doc.assets.a1.data, undefined, 'data 不留在記憶體文件');
  assert.deepEqual(Array.from(new Uint8Array(await r.blobs.a1.arrayBuffer())), Array.from(PNG1));
  assert.equal(r.blobs.a1.type, 'image/png');
  assert.deepEqual(r.doc.pages, doc.pages);
});

test('serializeProject 缺少 blob 時丟中文錯誤', async () => {
  await assert.rejects(X.serializeProject(goodDoc(), {}, { core: { pruneAssets() {} }, downscale: async b => b }), HAS_ZH);
});

test('exportPage：先等字型再渲染，PNG 帶 pHYs；exportZip 檔名 page-01.png…', async () => {
  const order = [];
  const doc = { pages: [{ id: 'p1', w: 8, h: 8, objects: [] }, { id: 'p2', w: 8, h: 8, objects: [] }] };
  const env = {
    fonts: { ready: async () => { order.push('fonts'); return true; } },
    loadImages: async () => { order.push('images'); },
    images: {}, stickers: {},
    render: { render: () => { order.push('render'); return { pending: false }; } },
    createCanvas: () => ({ width: 0, height: 0, getContext: () => ({ clearRect() {}, fillRect() {} }), toBlob: (cb, type) => cb(new Blob([type === 'image/png' ? PNG1 : new Uint8Array([0xFF, 0xD8, 0xFF, 0xE0, 0, 16, 0x4A, 0x46, 0x49, 0x46, 0, 1, 1, 0, 0, 1, 0, 1, 0, 0])], { type })) }),
  };
  const png = new Uint8Array(await (await X.exportPage(doc, 0, 'png', env)).arrayBuffer());
  assert.deepEqual(order, ['fonts', 'images', 'render']);
  assert.equal(str(png, 37, 4), 'pHYs');
  const jpg = new Uint8Array(await (await X.exportPage(doc, 1, 'jpg', env)).arrayBuffer());
  assert.equal(jpg[15], 0x2C);

  const zip = new Uint8Array(await (await X.exportZip(doc, 'png', env)).arrayBuffer());
  const v = dv(zip);
  const eocd = zip.length - 22;
  assert.equal(v.getUint16(eocd + 10, true), 2);
  const text = Buffer.from(zip).toString('latin1');
  assert.ok(text.includes('page-01.png') && text.includes('page-02.png'));
});

test('copyPage 不支援剪貼簿時回繁中原因', async () => {
  const r = await X.copyPage({ pages: [] }, 0, { navigator: {}, ClipboardItem: undefined });
  assert.deepEqual(r, { ok: false, reason: '這個瀏覽器不支援複製圖片，請改用下載' });
});

// ---- downscaleBlob（用 stub 模擬瀏覽器的 createImageBitmap／canvas／<img>）----
function withBrowserStubs(stubs, fn) {
  const g = globalThis, keys = ['createImageBitmap', 'document'], saved = {}, hadDoc = 'document' in g;
  keys.forEach(k => { saved[k] = g[k]; });
  Object.assign(g, stubs);
  const restore = () => keys.forEach(k => { if (saved[k] === undefined) delete g[k]; else g[k] = saved[k]; });
  return Promise.resolve().then(fn).finally(restore);
}
const fakeDoc = (outTypes, imgSize) => ({
  createElement: tag => {
    if (tag === 'img') {
      const img = { naturalWidth: imgSize.w, naturalHeight: imgSize.h };
      Object.defineProperty(img, 'src', { set() { setTimeout(() => img.onload && img.onload(), 0); } });
      return img;
    }
    return { width: 0, height: 0, getContext: () => ({ drawImage() {} }), toBlob: (cb, type) => { outTypes.push(type); cb(new Blob([new Uint8Array([1])], { type })); } };
  },
});

test('downscaleBlob：SVG 直接沿用原 Blob，不呼叫 createImageBitmap', async () => {
  const svg = new Blob(['<svg xmlns="http://www.w3.org/2000/svg"/>'], { type: 'image/svg+xml' });
  let called = 0;
  await withBrowserStubs({ createImageBitmap: async () => { called++; throw new Error('InvalidStateError'); } }, async () => {
    assert.equal(await X.downscaleBlob(svg, 2048), svg);
  });
  assert.equal(called, 0);
});

test('downscaleBlob：createImageBitmap 失敗時退回 <img> 解碼；仍失敗丟繁中錯誤', async () => {
  const outs = [];
  const big = new Blob([PNG1], { type: 'image/png' });
  await withBrowserStubs({ createImageBitmap: async () => { throw new Error('InvalidStateError'); }, document: fakeDoc(outs, { w: 4000, h: 2000 }) }, async () => {
    const r = await X.downscaleBlob(big, 2048);
    assert.equal(r.type, 'image/png');
    assert.deepEqual(outs, ['image/png']);
  });
  const bad = { createElement: () => { const img = {}; Object.defineProperty(img, 'src', { set() { setTimeout(() => img.onerror && img.onerror(), 0); } }); return img; } };
  await withBrowserStubs({ createImageBitmap: async () => { throw new Error('InvalidStateError'); }, document: bad }, async () => {
    await assert.rejects(X.downscaleBlob(big, 2048), HAS_ZH);
  });
});

test('downscaleBlob：只有 JPEG 輸出 JPEG，WebP／GIF／AVIF 一律輸出 PNG（保留透明）', async () => {
  for (const [mime, want] of [['image/jpeg', 'image/jpeg'], ['image/webp', 'image/png'], ['image/gif', 'image/png'], ['image/avif', 'image/png'], ['image/png', 'image/png']]) {
    const outs = [];
    await withBrowserStubs({ createImageBitmap: async () => ({ width: 4000, height: 3000, close() {} }), document: fakeDoc(outs, {}) }, async () => {
      const r = await X.downscaleBlob(new Blob([new Uint8Array([1, 2])], { type: mime }), 2048);
      assert.equal(r.type, want, mime);
    });
    assert.deepEqual(outs, [want], mime);
  }
});

test('serializeProject：資產 mime 同步成實際輸出格式', async () => {
  const doc = goodDoc(); doc.assets.a1.mime = 'image/webp';
  const json = await X.serializeProject(doc, { a1: new Blob([PNG1], { type: 'image/webp' }) }, { core: { pruneAssets() {} }, downscale: async b => new Blob([b], { type: 'image/png' }) });
  const a = JSON.parse(json).doc.assets.a1;
  assert.equal(a.mime, 'image/png');
  assert.match(a.data, /^data:image\/png;base64,/);
});

test('exportZip：字型只等一次（ready 永不 resolve 時只呼叫一次；單頁匯出仍會等）', async () => {
  let n = 0;
  const doc = { pages: [{ id: 'p1', w: 8, h: 8, objects: [] }, { id: 'p2', w: 8, h: 8, objects: [] }, { id: 'p3', w: 8, h: 8, objects: [] }] };
  const mk = ready => ({
    fonts: { ready }, loadImages: async () => {}, images: {}, stickers: {},
    render: { render: () => ({ pending: false }) },
    createCanvas: () => ({ width: 0, height: 0, getContext: () => ({ clearRect() {}, fillRect() {} }), toBlob: (cb, type) => cb(new Blob([PNG1], { type })) }),
  });
  const zip = new Uint8Array(await (await X.exportZip(doc, 'png', mk(async () => { n++; return true; }))).arrayBuffer());
  assert.equal(n, 1, '3 頁 ZIP 只等一次字型');
  assert.equal(dv(zip).getUint16(zip.length - 22 + 10, true), 3);
  n = 0;
  await X.exportPage(doc, 0, 'png', mk(async () => { n++; return true; }));
  assert.equal(n, 1, '單頁匯出行為不變');
});

test('parseProject：外層 version 大於 1 時拒絕，原因含「較新版本」', async () => {
  const text = JSON.stringify({ app: 'QuickPatterntool-design', version: 2, doc: goodDoc() });
  let migrated = 0;
  const r = await X.parseProject(text, { migrate: d => { migrated++; return { ok: true, doc: d }; } });
  assert.equal(r.ok, false);
  assert.match(r.reason, /較新版本/);
  assert.equal(migrated, 0);
});

// ---- 匯出規格（彈窗用）：倍率、JPG 品質、DPI、頁面範圍 ----------------------------------
function specEnv(log) {
  return {
    images: {}, stickers: {},
    render: { render: (ctx, page, opts) => { log.push({ scale: opts.scale }); return { pending: false }; } },
    createCanvas: () => {
      const c = { width: 0, height: 0, getContext: () => ({ clearRect() {}, fillRect() {} }),
        toBlob: (cb, type, q) => { log.push({ w: c.width, h: c.height, type, q }); cb(new Blob([type === 'image/png' ? PNG1 : new Uint8Array([0xFF, 0xD8, 0xFF, 0xE0, 0, 16, 0x4A, 0x46, 0x49, 0x46, 0, 1, 1, 0, 0, 1, 0, 1, 0, 0])], { type })); } };
      return c;
    },
  };
}

test('exportPage：scale 改變輸出像素並傳給 render；JPG 品質與 DPI 可調', async () => {
  const log = [];
  const doc = { pages: [{ id: 'p1', w: 100, h: 50, objects: [] }] };
  const png = new Uint8Array(await (await X.exportPage(doc, 0, 'png', specEnv(log), { scale: 2, dpi: 72 })).arrayBuffer());
  assert.deepEqual(log.slice(0, 2), [{ scale: 2 }, { w: 200, h: 100, type: 'image/png', q: undefined }]);
  const phys = chunks(png).find(c => c.type === 'pHYs');
  assert.equal(dv(png).getUint32(phys.off + 8), Math.round(72 / 0.0254));
  log.length = 0;
  const jpg = new Uint8Array(await (await X.exportPage(doc, 0, 'jpg', specEnv(log), { quality: 0.8, dpi: 72 })).arrayBuffer());
  assert.equal(log[1].q, 0.8);
  assert.equal(jpg[14] * 256 + jpg[15], 72);
});

test('exportPage：倍率讓長邊超過 MAX_OUTPUT_SIDE 時回繁中錯誤', async () => {
  const doc = { pages: [{ id: 'p1', w: 4096, h: 100, objects: [] }] };
  await assert.rejects(X.exportPage(doc, 0, 'png', specEnv([]), { scale: 3 }), e => HAS_ZH.test(e.message));
  assert.equal(X.MAX_OUTPUT_SIDE, 8192);
});

test('exportZip：只匯出指定頁，檔名用原本的頁碼', async () => {
  const doc = { pages: [1, 2, 3, 4].map(i => ({ id: 'p' + i, w: 8, h: 8, objects: [] })) };
  const zip = new Uint8Array(await (await X.exportZip(doc, 'jpg', specEnv([]), { pages: [1, 3] })).arrayBuffer());
  assert.equal(dv(zip).getUint16(zip.length - 22 + 10, true), 2);
  const text = Buffer.from(zip).toString('latin1');
  assert.ok(text.includes('page-02.jpg') && text.includes('page-04.jpg') && !text.includes('page-01.jpg'));
});

test('parsePages：範圍字串轉成 0 起算的頁碼', () => {
  assert.deepEqual(X.parsePages('1-3, 5', 6), { ok: true, pages: [0, 1, 2, 4] });
  assert.deepEqual(X.parsePages('3,1,3', 4), { ok: true, pages: [0, 2] });
  assert.deepEqual(X.parsePages(' ２－３ ', 4), { ok: true, pages: [1, 2] });   // 全形數字與連字號
  for (const bad of ['', '0', '7', '3-1', 'a', '1-', '1,,2']) {
    const r = X.parsePages(bad, 6);
    assert.equal(r.ok, false, bad);
    assert.match(r.reason, HAS_ZH);
  }
});

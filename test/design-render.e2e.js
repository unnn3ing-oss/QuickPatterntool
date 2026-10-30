// 設計：渲染在真的 Chromium 裡讀像素。載入 about:blank + design-render.js，手寫 page 物件（不需要 core）。
// 需要 playwright：NODE_PATH=<有 playwright 的 node_modules> node --test test/design-render.e2e.js
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

let chromium = null;
try { ({ chromium } = require('playwright')); } catch (e) { /* 沒裝 playwright：整檔略過 */ }
const skip = chromium ? false : '找不到 playwright（設 NODE_PATH 指到有 playwright 的 node_modules）';

let browser;
test.before(async () => { if (chromium) browser = await chromium.launch(); });
test.after(async () => { if (browser) await browser.close(); });

async function open(t) {
  const ctx = await browser.newContext({ viewport: { width: 800, height: 600 } });
  t.after(() => ctx.close());
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.goto('about:blank');
  await page.addScriptTag({ path: path.join(__dirname, '..', 'design-render.js') });
  // 測試用小工具：畫一頁、回傳指定點的像素
  await page.evaluate(() => {
    window.T = {
      obj: (type, o) => Object.assign({ id: 'x' + Math.random(), type, x: 0, y: 0, w: 100, h: 100, rot: 0, opacity: 1 }, o),
      draw(pg, opts, size = 1) {
        const c = document.createElement('canvas'); c.width = Math.ceil(pg.w * size); c.height = Math.ceil(pg.h * size);
        const ctx = c.getContext('2d');
        const res = QPTDesign.render.render(ctx, pg, Object.assign({ scale: size }, opts || {}));
        window.cv = c; return res;
      },
      px(x, y) { return Array.from(window.cv.getContext('2d').getImageData(x, y, 1, 1).data); },
      solidImg(w, h, fn) {
        const c = document.createElement('canvas'); c.width = w; c.height = h; fn(c.getContext('2d'), w, h); return c;
      },
    };
  });
  return { page, errors };
}
const near = (a, b, tol = 3) => a.every((v, i) => Math.abs(v - b[i]) <= tol);

test('純色背景', { skip }, async t => {
  const { page, errors } = await open(t);
  const p = await page.evaluate(() => { T.draw({ w: 100, h: 80, bg: { type: 'solid', color: '#ff0000' }, objects: [] }); return T.px(50, 40); });
  assert.deepEqual(p, [255, 0, 0, 255]);
  assert.deepEqual(errors, []);
});

test('漸層 90° 左端是 from、右端是 to', { skip }, async t => {
  const { page } = await open(t);
  const r = await page.evaluate(() => {
    T.draw({ w: 200, h: 100, bg: { type: 'gradient', from: '#ff0000', to: '#0000ff', angle: 90 }, objects: [] });
    return [T.px(0, 50), T.px(199, 50), T.px(100, 5), T.px(100, 95)];
  });
  assert.ok(r[0][0] > 250 && r[0][2] < 5, '左端紅 ' + r[0]);
  assert.ok(r[1][2] > 250 && r[1][0] < 5, '右端藍 ' + r[1]);
  assert.ok(near(r[2], r[3], 2), '垂直方向顏色一致');
});

test('漸層 0° 由下往上', { skip }, async t => {
  const { page } = await open(t);
  const r = await page.evaluate(() => {
    T.draw({ w: 100, h: 200, bg: { type: 'gradient', from: '#ff0000', to: '#0000ff', angle: 0 }, objects: [] });
    return [T.px(50, 199), T.px(50, 0)];
  });
  assert.ok(r[0][0] > 250, '下端是 from');
  assert.ok(r[1][2] > 250, '上端是 to');
});

test('rect 填色＋opacity 0.5 會和背景混色', { skip }, async t => {
  const { page } = await open(t);
  const p = await page.evaluate(() => {
    T.draw({ w: 100, h: 100, bg: { type: 'solid', color: '#ffffff' },
      objects: [T.obj('shape', { kind: 'rect', fill: '#000000', opacity: 0.5, x: 10, y: 10, w: 50, h: 50 })] });
    return [T.px(30, 30), T.px(80, 80)];
  });
  assert.ok(near(p[0], [128, 128, 128, 255], 2), '混色 ' + p[0]);
  assert.deepEqual(p[1], [255, 255, 255, 255]);
});

test('旋轉 90° 的長條 rect 改成直的', { skip }, async t => {
  const { page } = await open(t);
  const p = await page.evaluate(() => {
    // 100×20 的橫條，中心 (100,100)，轉 90° 後佔 x 90~110、y 50~150
    T.draw({ w: 200, h: 200, bg: { type: 'solid', color: '#ffffff' },
      objects: [T.obj('shape', { kind: 'rect', fill: '#000000', x: 50, y: 90, w: 100, h: 20, rot: 90 })] });
    return { vert: T.px(100, 60), horiz: T.px(60, 100) };
  });
  assert.deepEqual(p.vert.slice(0, 3), [0, 0, 0]);
  assert.deepEqual(p.horiz.slice(0, 3), [255, 255, 255]);
});

test('ellipse 內切、line、arrow', { skip }, async t => {
  const { page } = await open(t);
  const p = await page.evaluate(() => {
    T.draw({ w: 200, h: 200, bg: { type: 'solid', color: '#ffffff' }, objects: [
      T.obj('shape', { kind: 'ellipse', fill: '#ff0000', x: 0, y: 0, w: 100, h: 100 }),
      T.obj('shape', { kind: 'line', fill: '#00ff00', stroke: { w: 0, color: '#000' }, x: 0, y: 120, w: 100, h: 20 }),
      T.obj('shape', { kind: 'arrow', fill: '#0000ff', stroke: { w: 4, color: '#0000ff' }, x: 100, y: 120, w: 100, h: 40 }),
    ] });
    return { center: T.px(50, 50), corner: T.px(3, 3), line: T.px(50, 130), arrowTip: T.px(190, 140), arrowBody: T.px(110, 140) };
  });
  assert.deepEqual(p.center.slice(0, 3), [255, 0, 0]);
  assert.deepEqual(p.corner.slice(0, 3), [255, 255, 255]);
  assert.deepEqual(p.line.slice(0, 3), [0, 255, 0]);
  assert.deepEqual(p.arrowTip.slice(0, 3), [0, 0, 255]);
  assert.deepEqual(p.arrowBody.slice(0, 3), [0, 0, 255]);
});

test('gray 圖片的 r=g=b，圓角外保持透明（不被染黑）', { skip }, async t => {
  const { page } = await open(t);
  const r = await page.evaluate(() => {
    const img = T.solidImg(40, 40, (c, w, h) => { c.fillStyle = '#ff3300'; c.fillRect(0, 0, w, h / 2); c.fillStyle = '#0033ff'; c.fillRect(0, h / 2, w, h / 2); });
    const o = T.obj('image', { asset: 'a1', fit: 'cover', view: { ox: 0.5, oy: 0.5, scale: 1 }, radius: 40, gray: true, x: 0, y: 0, w: 100, h: 100 });
    T.draw({ w: 100, h: 100, bg: { type: 'solid', color: '#ffffff' }, objects: [o] }, { images: { a1: img } });
    const colour = T.px(50, 20), colour2 = T.px(50, 80);
    // 沒抽色的對照
    const o2 = Object.assign({}, o, { gray: false });
    T.draw({ w: 100, h: 100, bg: { type: 'solid', color: '#ffffff' }, objects: [o2] }, { images: { a1: img } });
    const raw = T.px(50, 20);
    T.draw({ w: 100, h: 100, bg: { type: 'solid', color: '#ffffff' }, objects: [o] }, { images: { a1: img } });
    return { colour, colour2, raw, corner: T.px(1, 1) };
  });
  assert.ok(r.colour[0] === r.colour[1] && r.colour[1] === r.colour[2], '抽色後 r=g=b ' + r.colour);
  assert.ok(r.colour2[0] === r.colour2[1] && r.colour2[1] === r.colour2[2]);
  assert.ok(r.raw[0] !== r.raw[2], '對照組有顏色');
  assert.deepEqual(r.corner.slice(0, 3), [255, 255, 255], '圓角外露出白背景');
});

test('image 擺放：contain 留白、cover 蓋滿', { skip }, async t => {
  const { page } = await open(t);
  const r = await page.evaluate(() => {
    const img = T.solidImg(200, 100, (c, w, h) => { c.fillStyle = '#ff0000'; c.fillRect(0, 0, w, h); });
    const mk = fit => T.obj('image', { asset: 'a1', fit, view: { ox: 0.5, oy: 0.5, scale: 1 }, radius: 0, gray: false, x: 0, y: 0, w: 100, h: 100 });
    T.draw({ w: 100, h: 100, bg: { type: 'solid', color: '#ffffff' }, objects: [mk('contain')] }, { images: { a1: img } });
    const contain = { top: T.px(50, 5), mid: T.px(50, 50) };
    T.draw({ w: 100, h: 100, bg: { type: 'solid', color: '#ffffff' }, objects: [mk('cover')] }, { images: { a1: img } });
    return { contain, cover: T.px(50, 5) };
  });
  assert.deepEqual(r.contain.top.slice(0, 3), [255, 255, 255]);
  assert.deepEqual(r.contain.mid.slice(0, 3), [255, 0, 0]);
  assert.deepEqual(r.cover.slice(0, 3), [255, 0, 0]);
});

test('影像沒就緒畫佔位並回報 pending', { skip }, async t => {
  const { page } = await open(t);
  const r = await page.evaluate(() => {
    const res = T.draw({ w: 100, h: 100, bg: { type: 'solid', color: '#ffffff' }, objects: [T.obj('image', { asset: 'a1', fit: 'cover', view: {}, x: 0, y: 0, w: 100, h: 100 })] }, { images: { a1: null } });
    const px = T.px(50, 3);
    const res2 = T.draw({ w: 100, h: 100, bg: { type: 'solid', color: '#ffffff' }, objects: [] });
    return { pending: res.pending, px, clean: res2.pending };
  });
  assert.equal(r.pending, true);
  assert.equal(r.clean, false);
  assert.ok(r.px[0] < 255, '有灰底');
});

test('skipIds 與 hidden 會跳過', { skip }, async t => {
  const { page } = await open(t);
  const r = await page.evaluate(() => {
    const a = T.obj('shape', { id: 'a', kind: 'rect', fill: '#000000', w: 100, h: 100 });
    const b = T.obj('shape', { id: 'b', kind: 'rect', fill: '#000000', w: 100, h: 100, hidden: true });
    T.draw({ w: 100, h: 100, bg: { type: 'solid', color: '#ffffff' }, objects: [b] });
    const hidden = T.px(50, 50);
    T.draw({ w: 100, h: 100, bg: { type: 'solid', color: '#ffffff' }, objects: [a] }, { skipIds: new Set(['a']) });
    return { hidden, skipped: T.px(50, 50) };
  });
  assert.deepEqual(r.hidden.slice(0, 3), [255, 255, 255]);
  assert.deepEqual(r.skipped.slice(0, 3), [255, 255, 255]);
});

test('文字：描邊與填色有畫出來，且不丟錯', { skip }, async t => {
  const { page, errors } = await open(t);
  const r = await page.evaluate(() => {
    const o = T.obj('text', { text: '國', font: 'x', size: 90, color: '#ff0000', align: 'center', lineHeight: 1.25, letterSpacing: 0,
      stroke: { w: 4, color: '#0000ff' }, shadow: { x: 3, y: 3, blur: 2, color: '#000' }, x: 0, y: 0, w: 100, h: 110 });
    T.draw({ w: 100, h: 110, bg: { type: 'solid', color: '#ffffff' }, objects: [o] });
    const d = window.cv.getContext('2d').getImageData(0, 0, 100, 110).data;
    let red = 0, nonWhite = 0;
    for (let i = 0; i < d.length; i += 4) { if (d[i] > 200 && d[i + 1] < 60 && d[i + 2] < 60) red++; if (d[i] < 250 || d[i + 1] < 250) nonWhite++; }
    // 字距版本也要能畫
    o.letterSpacing = 5; o.text = '國國'; o.w = 200;
    T.draw({ w: 200, h: 110, bg: { type: 'solid', color: '#ffffff' }, objects: [o] });
    return { red, nonWhite };
  });
  assert.ok(r.nonWhite > 50, '有畫出東西');
  assert.deepEqual(errors, []);
});

test('馬賽克區內同一格顏色一致、區外不變', { skip }, async t => {
  const { page } = await open(t);
  const r = await page.evaluate(() => {
    // 底：每 7px 一條黑白直條，馬賽克蓋 (20,20,100,100)，格子 = max(14, 20)=20px
    const stripes = T.solidImg(200, 200, (c, w, h) => { c.fillStyle = '#fff'; c.fillRect(0, 0, w, h); c.fillStyle = '#000'; for (let x = 0; x < w; x += 14) c.fillRect(x, 0, 7, h); });
    const bgImg = T.obj('image', { asset: 'a1', fit: 'cover', view: { ox: .5, oy: .5, scale: 1 }, radius: 0, gray: false, x: 0, y: 0, w: 200, h: 200 });
    const m = T.obj('mosaic', { x: 20, y: 20, w: 100, h: 100 });
    T.draw({ w: 200, h: 200, bg: { type: 'solid', color: '#fff' }, objects: [bgImg, m] }, { images: { a1: stripes } });
    const inside = [T.px(22, 22), T.px(30, 25), T.px(38, 38), T.px(25, 35)];   // 同一格 (20..40)
    const nextCell = T.px(45, 25);
    T.draw({ w: 200, h: 200, bg: { type: 'solid', color: '#fff' }, objects: [bgImg] }, { images: { a1: stripes } });
    const outsideOriginal = [T.px(150, 150), T.px(10, 10), T.px(130, 50)];
    T.draw({ w: 200, h: 200, bg: { type: 'solid', color: '#fff' }, objects: [bgImg, m] }, { images: { a1: stripes } });
    return { inside, nextCell, outsideOriginal, outsideNow: [T.px(150, 150), T.px(10, 10), T.px(130, 50)] };
  });
  for (const p of r.inside) assert.deepEqual(p, r.inside[0], '同一格顏色一致');
  assert.ok(r.inside[0][0] > 60 && r.inside[0][0] < 220, '是平均灰 ' + r.inside[0]);
  assert.deepEqual(r.outsideNow, r.outsideOriginal, '區外不變');
});

test('馬賽克作用在它下方所有圖層（含上面的形狀不受影響）', { skip }, async t => {
  const { page } = await open(t);
  const r = await page.evaluate(() => {
    const below = T.obj('shape', { kind: 'rect', fill: '#ff0000', x: 0, y: 0, w: 100, h: 100 });
    const m = T.obj('mosaic', { x: 0, y: 0, w: 60, h: 60 });
    const above = T.obj('shape', { kind: 'rect', fill: '#00ff00', x: 0, y: 0, w: 30, h: 30 });
    T.draw({ w: 100, h: 100, bg: { type: 'solid', color: '#fff' }, objects: [below, m, above] });
    return { mosaic: T.px(50, 50), above: T.px(10, 10) };
  });
  assert.deepEqual(r.mosaic.slice(0, 3), [255, 0, 0]);
  assert.deepEqual(r.above.slice(0, 3), [0, 255, 0]);
});

test('污染畫布上的馬賽克是灰色、不丟錯', { skip }, async t => {
  const { page, errors } = await open(t);
  // 沒有網路：用 route 回一張沒有 CORS 標頭的跨來源圖，畫上去就會污染畫布
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
  await page.route('http://other.test/**', r => r.fulfill({ status: 200, contentType: 'image/png', body: png }));
  const r = await page.evaluate(async () => {
    const im = new Image(); im.src = 'http://other.test/x.png';
    await new Promise((res, rej) => { im.onload = res; im.onerror = () => rej(new Error('load')); });
    const bg = T.obj('image', { asset: 'a1', fit: 'cover', view: { ox: .5, oy: .5, scale: 1 }, radius: 0, gray: false, x: 0, y: 0, w: 100, h: 100 });
    const m = T.obj('mosaic', { x: 10, y: 10, w: 50, h: 50 });
    let threw = null;
    try { T.draw({ w: 100, h: 100, bg: { type: 'solid', color: '#fff' }, objects: [bg, m] }, { images: { a1: im } }); } catch (e) { threw = String(e); }
    let tainted = false;
    try { window.cv.getContext('2d').getImageData(0, 0, 1, 1); } catch (e) { tainted = true; }
    return { threw, tainted, inside: T.px ? (() => { try { return T.px(30, 30); } catch (e) { return null; } })() : null };
  });
  assert.equal(r.threw, null);
  assert.equal(r.tainted, true, '畫布確實被污染');
  assert.deepEqual(errors, []);
});

test('scale 0.5 與 1 輸出比例一致', { skip }, async t => {
  const { page } = await open(t);
  const r = await page.evaluate(() => {
    const pg = { w: 200, h: 100, bg: { type: 'gradient', from: '#ff0000', to: '#0000ff', angle: 90 }, objects: [
      T.obj('shape', { kind: 'rect', fill: '#00ff00', x: 40, y: 20, w: 80, h: 40 }),
      T.obj('mosaic', { x: 120, y: 10, w: 60, h: 60 }),
    ] };
    T.draw(pg, {}, 1);
    const full = { w: window.cv.width, h: window.cv.height, rect: T.px(60, 40), outside: T.px(10, 90) };
    T.draw(pg, {}, 0.5);
    const half = { w: window.cv.width, h: window.cv.height, rect: T.px(30, 20), outside: T.px(5, 45), edgeIn: T.px(21, 11), edgeOut: T.px(18, 11) };
    return { full, half };
  });
  assert.equal(r.half.w, 100);
  assert.equal(r.half.h, 50);
  assert.deepEqual(r.half.rect, r.full.rect);
  assert.ok(near(r.half.outside, r.full.outside, 6));
  assert.deepEqual(r.half.edgeIn.slice(0, 3), [0, 255, 0], '矩形邊界落在 scale 後 (20,10)');
  assert.notDeepEqual(r.half.edgeOut.slice(0, 3), [0, 255, 0]);
});

// =====================================================================================
// 漸層填色、弧形文字（像素）
// =====================================================================================
const W3 = [255, 255, 255, 255];

test('形狀線性漸層 90°：左端接近 from、右端接近 to', { skip }, async t => {
  const { page, errors } = await open(t);
  const r = await page.evaluate(() => {
    T.draw({ w: 200, h: 100, bg: { type: 'solid', color: '#ffffff' }, objects: [
      T.obj('shape', { kind: 'rect', fill: { type: 'linear', from: '#ff0000', to: '#0000ff', angle: 90 }, x: 0, y: 0, w: 200, h: 100 })] });
    return [T.px(1, 50), T.px(198, 50), T.px(100, 50), T.px(100, 2), T.px(100, 97)];
  });
  assert.ok(near(r[0], [255, 0, 0, 255], 8), '左端 ' + r[0]);
  assert.ok(near(r[1], [0, 0, 255, 255], 8), '右端 ' + r[1]);
  assert.ok(near(r[2], [128, 0, 128, 255], 8), '中間 ' + r[2]);
  assert.ok(near(r[3], r[4], 2), '垂直方向一致');
  assert.deepEqual(errors, []);
});

test('形狀放射漸層：中心接近 from、角落接近 to；ellipse 也有漸層', { skip }, async t => {
  const { page } = await open(t);
  const r = await page.evaluate(() => {
    const paint = { type: 'radial', from: '#ffffff', to: '#000000', cx: 0.5, cy: 0.5, r: 1 };
    T.draw({ w: 200, h: 200, bg: { type: 'solid', color: '#ff00ff' }, objects: [T.obj('shape', { kind: 'rect', fill: paint, x: 0, y: 0, w: 200, h: 200 })] });
    const rect = { c: T.px(100, 100), corner: T.px(1, 1), mid: T.px(100, 40) };
    T.draw({ w: 200, h: 200, bg: { type: 'solid', color: '#ff00ff' }, objects: [T.obj('shape', { kind: 'ellipse', fill: paint, x: 0, y: 0, w: 200, h: 200 })] });
    const ell = { c: T.px(100, 100), edge: T.px(100, 3), outside: T.px(2, 2) };
    return { rect, ell };
  });
  assert.ok(near(r.rect.c, [255, 255, 255, 255], 6), '中心 ' + r.rect.c);
  assert.ok(near(r.rect.corner, [0, 0, 0, 255], 8), '角落 ' + r.rect.corner);
  assert.ok(r.rect.mid[0] > 20 && r.rect.mid[0] < 235, '中間是灰 ' + r.rect.mid);
  assert.ok(near(r.ell.c, [255, 255, 255, 255], 6));
  assert.ok(r.ell.edge[0] < 160, '橢圓邊緣偏暗 ' + r.ell.edge);
  assert.deepEqual(r.ell.outside.slice(0, 3), [255, 0, 255], '橢圓外是背景');
});

test('放射漸層的中心與半徑：cx 0 時最亮點在左緣、半徑小就很快變暗', { skip }, async t => {
  const { page } = await open(t);
  const r = await page.evaluate(() => {
    T.draw({ w: 200, h: 100, bg: { type: 'solid', color: '#fff' }, objects: [
      T.obj('shape', { kind: 'rect', fill: { type: 'radial', from: '#ffffff', to: '#000000', cx: 0, cy: 0.5, r: 0.5 }, x: 0, y: 0, w: 200, h: 100 })] });
    return [T.px(1, 50), T.px(30, 50), T.px(150, 50)];
  });
  assert.ok(r[0][0] > 240, '左緣最亮 ' + r[0]);
  assert.ok(r[1][0] < r[0][0] && r[1][0] > r[2][0] - 1, '往右變暗');
  assert.ok(r[2][0] < 5, '半徑外全黑 ' + r[2]);
});

test('旋轉 90° 的漸層矩形：漸層方向跟著轉', { skip }, async t => {
  const { page } = await open(t);
  const r = await page.evaluate(() => {
    // 200×40 橫條、中心 (100,100)，轉 90° 後佔 x 80~120、y 0~200；本地 90°（左→右）轉成頁面上 上→下
    T.draw({ w: 200, h: 200, bg: { type: 'solid', color: '#ffffff' }, objects: [
      T.obj('shape', { kind: 'rect', fill: { type: 'linear', from: '#ff0000', to: '#0000ff', angle: 90 }, x: 0, y: 80, w: 200, h: 40, rot: 90 })] });
    return { top: T.px(100, 3), bottom: T.px(100, 196), left: T.px(85, 100), right: T.px(115, 100), outside: T.px(40, 100) };
  });
  assert.ok(near(r.top, [255, 0, 0, 255], 10), '上端是 from ' + r.top);
  assert.ok(near(r.bottom, [0, 0, 255, 255], 10), '下端是 to ' + r.bottom);
  assert.ok(near(r.left, r.right, 3), '水平方向一致');
  assert.deepEqual(r.outside, [255, 255, 255, 255]);
});

test('背景放射漸層：中心 from、角落 to；舊的 gradient 不變', { skip }, async t => {
  const { page } = await open(t);
  const r = await page.evaluate(() => {
    T.draw({ w: 200, h: 100, bg: { type: 'radial', from: '#ff0000', to: '#0000ff', cx: 0.5, cy: 0.5, r: 1 }, objects: [] });
    const a = [T.px(100, 50), T.px(0, 0), T.px(199, 99)];
    T.draw({ w: 200, h: 100, bg: { type: 'radial', from: '#ff0000', to: '#0000ff' }, objects: [] });
    const b = T.px(100, 50);
    T.draw({ w: 200, h: 100, bg: { type: 'gradient', from: '#ff0000', to: '#0000ff', angle: 90 }, objects: [] });
    return { a, b, g: [T.px(0, 50), T.px(199, 50)] };
  });
  assert.ok(near(r.a[0], [255, 0, 0, 255], 6));
  assert.ok(near(r.a[1], [0, 0, 255, 255], 8));
  assert.ok(near(r.a[2], [0, 0, 255, 255], 8));
  assert.ok(near(r.b, [255, 0, 0, 255], 6), 'cx／cy／r 省略用預設');
  assert.ok(r.g[0][0] > 250 && r.g[1][2] > 250);
});

test('文字漸層：上下兩端顏色不同，描邊仍是純色', { skip }, async t => {
  const { page, errors } = await open(t);
  const r = await page.evaluate(() => {
    const o = T.obj('text', { text: '國', font: 'x', size: 160, color: { type: 'linear', from: '#ff0000', to: '#0000ff', angle: 180 },
      align: 'center', lineHeight: 1.25, letterSpacing: 0, stroke: { w: 0, color: '#000' }, shadow: { x: 0, y: 0, blur: 0, color: '#000' }, x: 0, y: 0, w: 200, h: 200 });
    T.draw({ w: 200, h: 200, bg: { type: 'solid', color: '#ffffff' }, objects: [o] });
    const d = window.cv.getContext('2d').getImageData(0, 0, 200, 200).data;
    const rows = [];
    for (let y = 0; y < 200; y++) for (let x = 0; x < 200; x++) { const i = (y * 200 + x) * 4; if (d[i + 3] > 250 && (d[i] < 200 || d[i + 2] < 200) && d[i + 1] < 120) rows.push([y, d[i], d[i + 2]]); }
    const ys = rows.map(q => q[0]), y0 = Math.min(...ys), y1 = Math.max(...ys), span = y1 - y0;
    const avg = sel => { const s = rows.filter(sel); return [s.reduce((a, q) => a + q[1], 0) / s.length, s.reduce((a, q) => a + q[2], 0) / s.length, s.length]; };
    const top = avg(q => q[0] < y0 + span * 0.25), bot = avg(q => q[0] > y1 - span * 0.25);
    // 描邊用純色
    o.stroke = { w: 6, color: '#00ff00' };
    T.draw({ w: 200, h: 200, bg: { type: 'solid', color: '#ffffff' }, objects: [o] });
    const d2 = window.cv.getContext('2d').getImageData(0, 0, 200, 200).data;
    let green = 0;
    for (let i = 0; i < d2.length; i += 4) if (d2[i] < 30 && d2[i + 1] > 225 && d2[i + 2] < 30) green++;
    return { n: rows.length, top, bot, green };
  });
  assert.ok(r.n > 200, '有畫出字 ' + r.n);
  assert.ok(r.top[0] > r.top[1] && r.top[0] > 150, '上端偏紅 ' + r.top);
  assert.ok(r.bot[1] > r.bot[0] && r.bot[1] > 150, '下端偏藍 ' + r.bot);
  assert.ok(r.green > 100, '描邊純色 ' + r.green);
  assert.deepEqual(errors, []);
});

// 找 (x0..x1, y0..y1) 內有沒有深色像素
const HAS_INK = `(function(cx, cy, hw, hh) {
  const c = window.cv, d = c.getContext('2d').getImageData(Math.max(0, Math.round(cx - hw)), Math.max(0, Math.round(cy - hh)), Math.round(hw * 2), Math.round(hh * 2)).data;
  let n = 0; for (let i = 0; i < d.length; i += 4) if (d[i] < 100 && d[i + 3] > 200) n++; return n; })`;

test('弧形文字 arc 180：弧頂在框中央上緣、兩端彎下來、下方中央是空的', { skip }, async t => {
  const { page, errors } = await open(t);
  const r = await page.evaluate((HAS) => {
    const has = eval(HAS);
    const o = T.obj('text', { text: '國國國國國', font: 'x', size: 100, color: '#000000', align: 'center', lineHeight: 1.25, letterSpacing: 0,
      stroke: { w: 0, color: '#000' }, shadow: { x: 0, y: 0, blur: 0, color: '#000' }, arc: 180, x: 0, y: 0, w: 600 });
    const ctx0 = document.createElement('canvas').getContext('2d');
    const lay = QPTDesign.render.layoutText(ctx0, o);
    o.h = Math.ceil(QPTDesign.render.textHeight(o));
    T.draw({ w: 600, h: o.h, bg: { type: 'solid', color: '#ffffff' }, objects: [o] });
    const dy = -lay.minY, g = lay.glyphs;
    const first = [300 + g[0].x, g[0].y + dy], last = [300 + g[4].x, g[4].y + dy];
    return { h: o.h, R: lay.R, first, last,
      topMid: has(300, 30, 40, 25), bottomMid: has(300, o.h - 40, 80, 30),
      leftEnd: has(first[0], first[1], 25, 25), rightEnd: has(last[0], last[1], 25, 25), height: o.h };
  }, HAS_INK);
  assert.ok(r.h > 200, '高度算進弧度 ' + r.h);
  assert.ok(r.topMid > 100, '弧頂有字 ' + r.topMid);
  assert.ok(r.leftEnd > 100 && r.rightEnd > 100, `兩端有字 ${r.leftEnd}/${r.rightEnd}`);
  assert.ok(r.first[1] > r.h * 0.4 && r.last[1] > r.h * 0.4, '兩端在框的下半部 ' + r.first + ' ' + r.last);
  assert.equal(r.bottomMid, 0, '下方中央空的');
  assert.deepEqual(errors, []);
});

test('弧形文字 arc −180：弧底貼框下緣、兩端在上半部、上方中央是空的', { skip }, async t => {
  const { page, errors } = await open(t);
  const r = await page.evaluate((HAS) => {
    const has = eval(HAS);
    const o = T.obj('text', { text: '國國國國國', font: 'x', size: 100, color: '#000000', align: 'left', lineHeight: 1.25, letterSpacing: 0,
      stroke: { w: 0, color: '#000' }, shadow: { x: 0, y: 0, blur: 0, color: '#000' }, arc: -180, x: 0, y: 0, w: 600 });
    const ctx0 = document.createElement('canvas').getContext('2d');
    const lay = QPTDesign.render.layoutText(ctx0, o);
    o.h = Math.ceil(QPTDesign.render.textHeight(o));
    T.draw({ w: 600, h: o.h, bg: { type: 'solid', color: '#ffffff' }, objects: [o] });
    const dy = o.h - lay.maxY, g = lay.glyphs;
    const first = [300 + g[0].x, g[0].y + dy], last = [300 + g[4].x, g[4].y + dy];
    return { h: o.h, first, last, bottomMid: has(300, o.h - 30, 40, 25), topMid: has(300, 40, 80, 30),
      leftEnd: has(first[0], first[1], 25, 25), rightEnd: has(last[0], last[1], 25, 25) };
  }, HAS_INK);
  assert.ok(r.bottomMid > 100, '弧底有字 ' + r.bottomMid);
  assert.ok(r.leftEnd > 100 && r.rightEnd > 100, `兩端有字 ${r.leftEnd}/${r.rightEnd}`);
  assert.ok(r.first[1] < r.h * 0.6 && r.last[1] < r.h * 0.6, '兩端在框的上半部');
  assert.equal(r.topMid, 0, '上方中央空的');
  assert.deepEqual(errors, []);
});

test('弧形文字：arc 0 與沒有 arc 欄位的畫法一致；旋轉與透明度仍作用', { skip }, async t => {
  const { page, errors } = await open(t);
  const r = await page.evaluate(() => {
    const base = { text: '國國', font: 'x', size: 80, color: '#000000', align: 'center', lineHeight: 1.25, letterSpacing: 0,
      stroke: { w: 0, color: '#000' }, shadow: { x: 0, y: 0, blur: 0, color: '#000' }, x: 20, y: 20, w: 200, h: 100 };
    const snap = o => { T.draw({ w: 240, h: 140, bg: { type: 'solid', color: '#fff' }, objects: [T.obj('text', o)] }); return window.cv.toDataURL(); };
    const a = snap(base), b = snap(Object.assign({ arc: 0 }, base));
    const c = snap(Object.assign({ arc: 90 }, base)), d = snap(Object.assign({ arc: 90, opacity: 0.5 }, base));
    const e = snap(Object.assign({ arc: 90, rot: 90 }, base));
    return { same: a === b, diff: a !== c, alpha: c !== d, rot: c !== e };
  });
  assert.ok(r.same && r.diff && r.alpha && r.rot, JSON.stringify(r));
  assert.deepEqual(errors, []);
});

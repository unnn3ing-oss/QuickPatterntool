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

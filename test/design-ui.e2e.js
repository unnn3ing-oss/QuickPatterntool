// 網頁版「設計」分頁（design-ui.js）在真的 Chromium 裡的測試：載入 index.html（file://），點「設計」分頁操作。
// 需要 playwright：NODE_PATH=<有 playwright 的 node_modules> node --test test/design-ui.e2e.js
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

let chromium = null;
try { ({ chromium } = require('playwright')); } catch (e) { /* 沒裝 playwright：整檔略過 */ }
const skip = chromium ? false : '找不到 playwright（設 NODE_PATH 指到有 playwright 的 node_modules）';

const PAGE = 'file://' + path.join(__dirname, '..', 'index.html');
let browser;
test.before(async () => { if (chromium) browser = await chromium.launch({ args: ['--allow-file-access-from-files'] }); });   // file:// 下貼圖才讀得到像素
test.after(async () => { if (browser) await browser.close(); });

async function open(t, opts = {}) {
  const { init, ...ctxOpts } = opts;
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, acceptDownloads: true, ...ctxOpts });
  t.after(() => ctx.close());
  if (init) await ctx.addInitScript(init);
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  page.on('dialog', d => d.accept());
  await page.route('https://**', r => r.abort());   // 沙盒沒有網路；Google Fonts 會載入失敗
  await page.goto(PAGE);
  await page.click('#toolsClose').catch(() => {});
  await page.click('#funcDesignBtn');
  await page.waitForFunction(() => window.QPTDesign && QPTDesign.ui && QPTDesign.ui.state.zoom > 0);
  await page.evaluate(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))));
  return { ctx, page, errors };
}

// ---- 小工具 ----
const S = page => page.evaluate(() => { const s = QPTDesign.ui.state; return { zoom: s.zoom, panX: s.panX, panY: s.panY, pageId: s.pageId, sel: s.selection.slice() }; });
const docJson = page => page.evaluate(() => QPTDesign.core.serialize(QPTDesign.ui.getDoc()));
const curPage = page => page.evaluate(() => { const s = QPTDesign.ui.state; return JSON.parse(JSON.stringify(s.doc.pages.find(p => p.id === s.pageId))); });
const obj = (page, id) => page.evaluate(id => { const f = QPTDesign.core.findObject(QPTDesign.ui.getDoc(), id); return f && JSON.parse(JSON.stringify(f.obj)); }, id);
const status = page => page.locator('#dzStatus').textContent();
// 頁面座標 → 螢幕座標
const toScreen = (page, x, y) => page.evaluate(([x, y]) => {
  const s = QPTDesign.ui.state, r = document.getElementById('dzStage').getBoundingClientRect();
  return { x: r.left + s.panX + x * s.zoom, y: r.top + s.panY + y * s.zoom };
}, [x, y]);
// 畫布像素（頁面座標）
const px = (page, x, y) => page.evaluate(([x, y]) => {
  const c = document.getElementById('dzCanvas'), p = QPTDesign.ui.state.doc.pages.find(q => q.id === QPTDesign.ui.state.pageId);
  const k = c.width / p.w;
  return Array.from(c.getContext('2d').getImageData(Math.floor(x * k), Math.floor(y * k), 1, 1).data);
}, [x, y]);
const flush = page => page.evaluate(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))));
async function add(page, what) {
  const before = (await curPage(page)).objects.length;
  await page.click(`#designApp [data-add="${what}"]`);
  await page.waitForFunction(n => { const s = QPTDesign.ui.state; return s.doc.pages.find(p => p.id === s.pageId).objects.length > n; }, before);
  await flush(page);   // 選取框、把手在下一個畫格才重畫
  const s = await S(page);
  return s.sel[0];
}
async function drag(page, from, to, { steps = 8, shift = false, hold = null } = {}) {
  await page.mouse.move(from.x, from.y);
  if (shift) await page.keyboard.down('Shift');
  await page.mouse.down();
  await page.mouse.move(to.x, to.y, { steps });
  if (hold) await hold();
  await page.mouse.up();
  if (shift) await page.keyboard.up('Shift');
  await flush(page);
}
const center = async (page, id) => { const o = await obj(page, id); return toScreen(page, o.x + o.w / 2, o.y + o.h / 2); };

// 一張測試圖（左紅右藍），寫到暫存檔
async function makeImage(page, w = 400, h = 300) {
  const b64 = await page.evaluate(([w, h]) => { const c = document.createElement('canvas'); c.width = w; c.height = h; const x = c.getContext('2d');
    x.fillStyle = '#e02020'; x.fillRect(0, 0, w / 2, h); x.fillStyle = '#2040e0'; x.fillRect(w / 2, 0, w / 2, h);
    return c.toDataURL('image/png').split(',')[1]; }, [w, h]);
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'qpt-dz-')), 'photo.png');
  fs.writeFileSync(file, Buffer.from(b64, 'base64'));
  return file;
}

// =====================================================================================
// Task 6：分頁接縫、版面骨架、畫布檢視、頁面列、背景
// =====================================================================================
test('點「設計」分頁顯示 #designApp、其他 app 隱藏', { skip }, async t => {
  const { page, errors } = await open(t);
  const vis = await page.evaluate(() => ['layoutApp', 'watermarkApp', 'collageApp', 'resizeApp', 'editApp', 'designApp']
    .map(id => [id, document.getElementById(id).hidden]));
  assert.deepEqual(Object.fromEntries(vis), { layoutApp: true, watermarkApp: true, collageApp: true, resizeApp: true, editApp: true, designApp: false });
  assert.equal(await page.getAttribute('#funcDesignBtn', 'aria-pressed'), 'true');
  // 版面：左工具列、中間舞台、右屬性面板
  const [tools, stage, panel] = await Promise.all(['#dzTools', '#dzStage', '#dzPanel'].map(s => page.locator(s).boundingBox()));
  assert.ok(tools.x < stage.x && stage.x + stage.width <= panel.x + 1, '工具列在左、面板在右');
  // 切回圖片套版再切回來，設計分頁的內容還在
  await page.click('#funcLayoutBtn');
  assert.equal(await page.evaluate(() => document.getElementById('designApp').hidden), true);
  await page.click('#funcDesignBtn');
  assert.deepEqual(errors, []);
});

test('預設一頁 1080×1080；第一次顯示自動符合視窗', { skip }, async t => {
  const { page, errors } = await open(t);
  const p = await curPage(page);
  assert.equal(p.w, 1080); assert.equal(p.h, 1080);
  assert.equal(await page.evaluate(() => QPTDesign.ui.getDoc().pages.length), 1);
  const st = await page.evaluate(() => { const r = document.getElementById('dzStage').getBoundingClientRect(), s = QPTDesign.ui.state; return { w: r.width, h: r.height, z: s.zoom, px: s.panX, py: s.panY }; });
  assert.ok(1080 * st.z <= st.w && 1080 * st.z <= st.h, '整頁放得進舞台');
  assert.ok(Math.abs(st.px - (st.w - 1080 * st.z) / 2) < 2, '水平置中');
  // 畫布實際像素＝頁面 × dpr × zoom
  const cw = await page.evaluate(() => document.getElementById('dzCanvas').width);
  assert.ok(Math.abs(cw - Math.round(1080 * st.z)) <= 1, `畫布寬 ${cw}`);
  assert.deepEqual(await px(page, 540, 540), [255, 255, 255, 255]);
  assert.match(await page.locator('#dzZoomOut').textContent(), /%/);
  assert.deepEqual(errors, []);
});

test('改成 4:5 頁面變 1080×1350；復原回到 1:1', { skip }, async t => {
  const { page, errors } = await open(t);
  await page.selectOption('#dzSizePreset', '4:5');
  let p = await curPage(page);
  assert.equal(p.w, 1080); assert.equal(p.h, 1350);
  await page.click('#dzUndoBtn');
  p = await curPage(page);
  assert.equal(p.h, 1080);
  assert.deepEqual(errors, []);
});

test('自訂 5000 被拒並顯示繁中訊息', { skip }, async t => {
  const { page, errors } = await open(t);
  const before = await docJson(page);
  await page.selectOption('#dzSizePreset', 'custom');
  await page.fill('#dzPageW', '5000');
  await page.click('#dzPageApply');
  assert.match(await status(page), /4096/);
  assert.match(await status(page), /[一-鿿]/);
  assert.equal(await docJson(page), before, '文件不變');
  await page.fill('#dzPageW', '1200');
  await page.fill('#dzPageH', '800');
  await page.click('#dzPageApply');
  const p = await curPage(page);
  assert.deepEqual([p.w, p.h], [1200, 800]);
  assert.deepEqual(errors, []);
});

test('新增、複製、刪除頁面，第 21 頁被拒', { skip }, async t => {
  const { page, errors } = await open(t);
  const n = () => page.evaluate(() => QPTDesign.ui.getDoc().pages.length);
  await page.click('#dzPageAdd');
  assert.equal(await n(), 2);
  await flush(page);
  assert.equal(await page.locator('#dzPages .dz-thumb').count(), 2);
  const s = await S(page);
  assert.equal(s.pageId, (await page.evaluate(() => QPTDesign.ui.getDoc().pages[1].id)), '切到新的那頁');
  await add(page, 'shape:rect');
  await page.click('#dzPageDup');
  assert.equal(await n(), 3);
  const pages = await page.evaluate(() => QPTDesign.ui.getDoc().pages.map(p => p.objects.length));
  assert.deepEqual(pages, [0, 1, 1], '複製的頁面也有物件');
  await page.click('#dzPageDel');
  assert.equal(await n(), 2);
  for (let i = 0; i < 18; i++) await page.click('#dzPageAdd');
  assert.equal(await n(), 20);
  await page.click('#dzPageAdd');
  assert.equal(await n(), 20);
  assert.match(await status(page), /最多.*20/);
  // 點縮圖切頁
  await page.click('#dzPages .dz-thumb >> nth=0');
  assert.equal((await S(page)).pageId, await page.evaluate(() => QPTDesign.ui.getDoc().pages[0].id));
  assert.deepEqual(errors, []);
});

test('拖曳縮圖可以調整頁面順序', { skip }, async t => {
  const { page, errors } = await open(t);
  await page.click('#dzPageAdd');
  await page.click('#dzPageAdd');
  const ids0 = await page.evaluate(() => QPTDesign.ui.getDoc().pages.map(p => p.id));
  await page.dragAndDrop('#dzPages .dz-thumb >> nth=0', '#dzPages .dz-thumb >> nth=2');
  const ids1 = await page.evaluate(() => QPTDesign.ui.getDoc().pages.map(p => p.id));
  assert.notDeepEqual(ids1, ids0);
  assert.equal(ids1[2], ids0[0], '第一頁移到最後');
  assert.deepEqual(errors, []);
});

test('背景改成漸層後畫布像素改變', { skip }, async t => {
  const { page, errors } = await open(t);
  const a = await px(page, 540, 20), b = await px(page, 540, 1060);
  assert.deepEqual(a, b);
  await page.click('#dzBgType [data-bg="gradient"]');
  await flush(page);
  const p = await curPage(page);
  assert.equal(p.bg.type, 'gradient');
  const a2 = await px(page, 540, 20), b2 = await px(page, 540, 1060);
  assert.notDeepEqual(a2, b2, '上下顏色不同');
  // 改純色
  await page.click('#dzBgType [data-bg="solid"]');
  await page.locator('#dzBgColor').evaluate(el => { el.value = '#ff0000'; el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true })); });
  await flush(page);
  assert.deepEqual(await px(page, 540, 540), [255, 0, 0, 255]);
  assert.deepEqual(errors, []);
});

test('背景圖片：選圖後頁面背景是圖片', { skip }, async t => {
  const { page, errors } = await open(t);
  const file = await makeImage(page, 1080, 1080);
  await page.click('#dzBgType [data-bg="image"]');
  await page.setInputFiles('#dzBgFile', file);
  await page.waitForFunction(() => { const s = QPTDesign.ui.state; return s.doc.pages[0].bg.type === 'image'; });
  await page.waitForFunction(() => { const c = document.getElementById('dzCanvas'); const d = c.getContext('2d').getImageData(10, c.height / 2, 1, 1).data; return d[0] > 200 && d[2] < 60; });
  assert.deepEqual(errors, []);
});

test('Ctrl＋滾輪縮放改變 zoom；滾輪捲動改變 pan；符合視窗回到原本', { skip }, async t => {
  const { page, errors } = await open(t);
  const s0 = await S(page);
  const box = await page.locator('#dzStage').boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.keyboard.down('Control');
  await page.mouse.wheel(0, -300);
  await page.keyboard.up('Control');
  await flush(page);
  const s1 = await S(page);
  assert.ok(s1.zoom > s0.zoom, `放大 ${s0.zoom} → ${s1.zoom}`);
  assert.ok(s1.zoom <= 4);
  await page.mouse.wheel(0, 120);
  await flush(page);
  const s2 = await S(page);
  assert.ok(s2.panY < s1.panY, '往下捲');
  assert.equal(s2.zoom, s1.zoom);
  await page.click('#dzFitBtn');
  const s3 = await S(page);
  assert.ok(Math.abs(s3.zoom - s0.zoom) < 1e-6);
  assert.deepEqual(errors, []);
});

test('空白鍵＋拖曳平移', { skip }, async t => {
  const { page, errors } = await open(t);
  const s0 = await S(page);
  const box = await page.locator('#dzStage').boundingBox();
  await page.mouse.move(box.x + 30, box.y + 30);
  await page.keyboard.down(' ');
  await page.mouse.down();
  await page.mouse.move(box.x + 90, box.y + 70, { steps: 4 });
  await page.mouse.up();
  await page.keyboard.up(' ');
  const s1 = await S(page);
  assert.ok(Math.abs(s1.panX - s0.panX - 60) < 1 && Math.abs(s1.panY - s0.panY - 40) < 1, `平移 (${s1.panX - s0.panX}, ${s1.panY - s0.panY})`);
  assert.equal((await page.evaluate(() => QPTDesign.ui.getDoc().pages[0].objects.length)), 0);
  assert.deepEqual(errors, []);
});

test('頁面沒有 pageerror（切換各分頁）', { skip }, async t => {
  const { page, errors } = await open(t);
  for (const id of ['funcLayoutBtn', 'funcWatermarkBtn', 'funcCollageBtn', 'funcResizeBtn', 'funcEditBtn', 'funcDesignBtn']) await page.click('#' + id);
  await flush(page);
  assert.deepEqual(errors, []);
});


// =====================================================================================
// Task 7：物件、選取與變形、吸附、快捷鍵、屬性面板、文字編輯、字型選單
// =====================================================================================
test('加文字→雙擊編輯→輸入「測試」→點外面，物件 text 是「測試」，Ctrl+Z 一次回到「輸入文字」', { skip }, async t => {
  const { page, errors } = await open(t);
  const id = await add(page, 'text');
  let o = await obj(page, id);
  assert.equal(o.text, '輸入文字');
  assert.ok(Math.abs(o.x + o.w / 2 - 540) < 1 && Math.abs(o.y + o.h / 2 - 540) < 1, '新物件在頁面中央');
  const c = await center(page, id);
  await page.mouse.dblclick(c.x, c.y);
  await page.waitForSelector('.dz-text-edit');
  // 編輯中這個物件不畫在畫布上（由輸入框顯示）
  assert.deepEqual(await page.evaluate(() => document.activeElement.className), 'dz-text-edit');
  await page.keyboard.type('測試');
  const box = await page.locator('#dzStage').boundingBox();
  await page.mouse.click(box.x + 15, box.y + 15);
  await page.waitForSelector('.dz-text-edit', { state: 'detached' });
  o = await obj(page, id);
  assert.equal(o.text, '測試');
  await page.keyboard.press('Control+z');
  o = await obj(page, id);
  assert.equal(o.text, '輸入文字', '一次復原就回到原文');
  await page.keyboard.press('Control+z');
  assert.equal(await obj(page, id), null, '再復原一次物件消失');
  await page.keyboard.press('Control+Shift+z');
  assert.equal((await obj(page, id)).text, '輸入文字');
  assert.deepEqual(errors, []);
});

test('在 textarea 按 Backspace 不刪物件、在面板 input 按方向鍵不移動物件', { skip }, async t => {
  const { page, errors } = await open(t);
  const id = await add(page, 'text');
  const c = await center(page, id);
  await page.mouse.dblclick(c.x, c.y);
  await page.waitForSelector('.dz-text-edit');
  await page.keyboard.press('End');
  await page.keyboard.press('Backspace');
  await page.keyboard.press('Delete');
  await page.keyboard.press('Control+z');   // 在輸入框裡是輸入框自己的復原
  await page.keyboard.press('Escape');
  await page.waitForSelector('.dz-text-edit', { state: 'detached' });
  assert.ok(await obj(page, id), '物件還在');
  const o0 = await obj(page, id);
  await page.click('#dzF-x');
  for (const k of ['ArrowLeft', 'ArrowRight', 'ArrowDown', 'Delete', 'Backspace']) await page.keyboard.press(k);
  const o1 = await obj(page, id);
  assert.ok(o1, '物件沒有被刪');
  assert.equal(o1.y, o0.y, '方向鍵沒有移動物件');
  // 面板 textarea 也一樣
  await page.click('#dzTextContent');
  await page.keyboard.press('Backspace');
  assert.ok(await obj(page, id));
  assert.deepEqual(errors, []);
});

test('拖曳物件，靠近頁面中心時出現吸附線，放開後中心對齊 540', { skip }, async t => {
  const { page, errors } = await open(t);
  const id = await add(page, 'shape:rect');
  // 先拖到旁邊
  let c = await center(page, id);
  await drag(page, c, { x: c.x + 120, y: c.y + 90 });
  let o = await obj(page, id);
  assert.ok(Math.abs(o.x + o.w / 2 - 540) > 50, '先移開');
  // 再拖回靠近中心（差 3 頁面像素）
  c = await center(page, id);
  const z = (await S(page)).zoom;
  const target = await toScreen(page, 543, 537);
  let guides = 0;
  await drag(page, c, target, { hold: async () => { await flush(page); guides = await page.locator('.dz-guide').count(); } });
  assert.ok(guides >= 1, '拖曳中出現吸附線');
  assert.equal(await page.locator('.dz-guide').count(), 0, '放開後吸附線消失');
  o = await obj(page, id);
  assert.ok(Math.abs(o.x + o.w / 2 - 540) < 1e-6, `中心 x ${o.x + o.w / 2}（zoom ${z}）`);
  assert.ok(Math.abs(o.y + o.h / 2 - 540) < 1e-6, `中心 y ${o.y + o.h / 2}`);
  // 整段拖曳只記一筆：一次復原回到第一次拖曳後的位置
  await page.keyboard.press('Control+z');
  const o2 = await obj(page, id);
  assert.ok(Math.abs(o2.x + o2.w / 2 - 540) > 50);
  assert.deepEqual(errors, []);
});

test('拖 se 把手放大、Shift 拖旋轉把手得到 15 的倍數', { skip }, async t => {
  const { page, errors } = await open(t);
  const id = await add(page, 'shape:rect');
  const o0 = await obj(page, id);
  const se = await page.locator('.dz-handle[data-h="se"]').boundingBox();
  const from = { x: se.x + se.width / 2, y: se.y + se.height / 2 };
  await drag(page, from, { x: from.x + 50, y: from.y + 30 });
  const o1 = await obj(page, id);
  assert.ok(o1.w > o0.w + 20 && o1.h > o0.h + 10, `放大 ${o0.w}×${o0.h} → ${o1.w}×${o1.h}`);
  assert.ok(Math.abs(o1.w / o1.h - o0.w / o0.h) < 0.01, '角把手等比');
  assert.ok(Math.abs(o1.x - o0.x) < 1e-6 && Math.abs(o1.y - o0.y) < 1e-6, '左上角不動');
  // e 邊把手只改寬
  const e = await page.locator('.dz-handle[data-h="e"]').boundingBox();
  await drag(page, { x: e.x + e.width / 2, y: e.y + e.height / 2 }, { x: e.x + e.width / 2 + 40, y: e.y + e.height / 2 + 25 });
  const o2 = await obj(page, id);
  assert.ok(o2.w > o1.w && Math.abs(o2.h - o1.h) < 1e-6, '邊把手單向');
  // 旋轉
  const rot = await page.locator('.dz-rot').boundingBox();
  const c = await center(page, id);
  const rf = { x: rot.x + rot.width / 2, y: rot.y + rot.height / 2 };
  await drag(page, rf, { x: c.x + 200, y: c.y - 90 }, { shift: true });
  const o3 = await obj(page, id);
  assert.ok(o3.rot > 0, `有旋轉 ${o3.rot}`);
  assert.equal(o3.rot % 15, 0, `15 的倍數：${o3.rot}`);
  // 文字：角把手連字級一起等比
  const tid = await add(page, 'text');
  const t0 = await obj(page, tid);
  const tse = await page.locator('.dz-handle[data-h="se"]').boundingBox();
  await drag(page, { x: tse.x + tse.width / 2, y: tse.y + tse.height / 2 }, { x: tse.x + tse.width / 2 + 60, y: tse.y + tse.height / 2 + 10 });
  const t1 = await obj(page, tid);
  assert.ok(t1.size > t0.size, `字級變大 ${t0.size} → ${t1.size}`);
  assert.equal(await page.locator('.dz-handle[data-h="n"]').count(), 0, '文字沒有上下邊把手');
  // 馬賽克沒有旋轉把手
  await add(page, 'mosaic');
  assert.equal(await page.locator('.dz-rot').count(), 0);
  assert.deepEqual(errors, []);
});

test('拖曳中按 Esc 回到原位、復原堆疊沒有新增', { skip }, async t => {
  const { page, errors } = await open(t);
  const id = await add(page, 'shape:ellipse');
  const before = await docJson(page);
  const c = await center(page, id);
  await page.mouse.move(c.x, c.y);
  await page.mouse.down();
  await page.mouse.move(c.x + 150, c.y + 80, { steps: 6 });
  await flush(page);
  assert.notEqual(await docJson(page), before, '拖曳中有移動');
  await page.keyboard.press('Escape');
  await page.mouse.move(c.x + 200, c.y + 100, { steps: 3 });
  await page.mouse.up();
  assert.equal(await docJson(page), before, '回到原位');
  await page.keyboard.press('Control+z');
  assert.equal(await obj(page, id), null, '最後一筆復原仍是「新增物件」');
  assert.deepEqual(errors, []);
});

test('Shift 點選與框選多選、對齊左邊後 x 相同、等距分佈', { skip }, async t => {
  const { page, errors } = await open(t);
  const ids = [];
  for (let i = 0; i < 3; i++) ids.push(await add(page, 'shape:rect'));
  // 用面板把三個物件擺開
  const place = [[100, 80], [400, 420], [650, 760]];
  for (let i = 0; i < 3; i++) {
    await page.evaluate(id => QPTDesign.ui.select([id]), ids[i]);
    await page.fill('#dzF-x', String(place[i][0])); await page.locator('#dzF-x').press('Enter'); await page.locator('#dzF-x').blur();
    await page.fill('#dzF-y', String(place[i][1])); await page.locator('#dzF-y').blur();
    await page.fill('#dzF-w', '200'); await page.locator('#dzF-w').blur();
    await page.fill('#dzF-h', '100'); await page.locator('#dzF-h').blur();
  }
  assert.deepEqual((await obj(page, ids[2])).x, 650);
  // 點空白取消選取，再 Shift 點選兩個
  const blank = await toScreen(page, 1000, 30);
  await page.mouse.click(blank.x, blank.y);
  assert.deepEqual((await S(page)).sel, []);
  await page.mouse.click(...Object.values(await center(page, ids[0])));
  await page.keyboard.down('Shift');
  await page.mouse.click(...Object.values(await center(page, ids[1])));
  await page.keyboard.up('Shift');
  assert.deepEqual((await S(page)).sel.sort(), [ids[0], ids[1]].sort());
  // 框選三個
  await page.mouse.click(blank.x, blank.y);
  const a = await toScreen(page, 50, 40), b = await toScreen(page, 1000, 1000);
  await drag(page, a, b);
  assert.deepEqual((await S(page)).sel.sort(), ids.slice().sort());
  assert.equal(await page.locator('.dz-sel').count(), 3);
  await page.click('#dzPanel [data-align="left"]');
  const xs = await Promise.all(ids.map(async id => (await obj(page, id)).x));
  assert.deepEqual(xs, [100, 100, 100]);
  await page.click('#dzPanel [data-dist="v"]');
  const os_ = await Promise.all(ids.map(id => obj(page, id)));
  const gap1 = os_[1].y - (os_[0].y + os_[0].h), gap2 = os_[2].y - (os_[1].y + os_[1].h);
  assert.ok(Math.abs(gap1 - gap2) < 1e-6, `間距 ${gap1} / ${gap2}`);
  assert.deepEqual(errors, []);
});

test('Ctrl+C／V 貼上 id 不同、Ctrl+D 重複、Delete 刪除、] [ 調順序', { skip }, async t => {
  const { page, errors } = await open(t);
  const a = await add(page, 'shape:rect');
  const b = await add(page, 'sticker:smile');
  await page.evaluate(id => QPTDesign.ui.select([id]), a);
  await page.locator('#dzStage').hover();
  await page.keyboard.press('Control+c');
  await page.keyboard.press('Control+v');
  await page.waitForFunction(() => QPTDesign.ui.state.doc.pages[0].objects.length === 3);
  const objs = (await curPage(page)).objects;
  const pasted = objs[2];
  assert.notEqual(pasted.id, a);
  assert.equal(pasted.type, 'shape');
  assert.equal(pasted.x, (await obj(page, a)).x + 20);
  assert.deepEqual((await S(page)).sel, [pasted.id], '選取貼上的物件');
  await page.keyboard.press('Control+d');
  assert.equal((await curPage(page)).objects.length, 4);
  await page.keyboard.press('Delete');
  assert.equal((await curPage(page)).objects.length, 3);
  // 圖層：把 a 往上一層、再往下
  await page.evaluate(id => QPTDesign.ui.select([id]), a);
  await page.keyboard.press(']');
  assert.deepEqual((await curPage(page)).objects.map(o => o.id).slice(0, 2), [b, a]);
  await page.keyboard.press('[');
  assert.deepEqual((await curPage(page)).objects.map(o => o.id).slice(0, 2), [a, b]);
  // 方向鍵微調
  const x0 = (await obj(page, a)).x;
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('Shift+ArrowRight');
  assert.equal((await obj(page, a)).x, x0 + 11);
  assert.deepEqual(errors, []);
});

test('鎖定的物件拖不動、不能刪；隱藏的物件不畫出', { skip }, async t => {
  const { page, errors } = await open(t);
  const id = await add(page, 'shape:rect');
  await page.check('#dzF-locked');
  assert.equal((await obj(page, id)).locked, true);
  assert.ok(await page.locator('#dzF-x').isDisabled(), '鎖定後欄位停用');
  const o0 = await obj(page, id);
  const c = await center(page, id);
  await drag(page, c, { x: c.x + 100, y: c.y + 60 });
  const o1 = await obj(page, id);
  assert.equal(o1.x, o0.x); assert.equal(o1.y, o0.y);
  assert.match(await status(page), /鎖定/);
  assert.equal(await page.locator('.dz-handle').count(), 0, '鎖定的物件沒有把手');
  await page.keyboard.press('Delete');
  assert.ok(await obj(page, id), '鎖定的物件不能刪');
  await page.uncheck('#dzF-locked');
  assert.equal((await obj(page, id)).locked, false);
  // 隱藏
  const inside = await px(page, 540, 540);
  assert.notDeepEqual(inside, [255, 255, 255, 255], '形狀有畫出來');
  await page.check('#dzF-hidden');
  await flush(page);
  assert.deepEqual(await px(page, 540, 540), [255, 255, 255, 255], '隱藏後不畫');
  assert.deepEqual(errors, []);
});

test('上傳圖片後物件出現，圓角、抽色改變像素', { skip }, async t => {
  const { page, errors } = await open(t);
  const file = await makeImage(page, 400, 300);
  await page.setInputFiles('#dzImgFile', file);
  await page.waitForFunction(() => QPTDesign.ui.state.doc.pages[0].objects.some(o => o.type === 'image'));
  await flush(page);
  const o = (await curPage(page)).objects[0];
  assert.equal(o.type, 'image');
  assert.ok(Math.abs(Math.max(o.w, o.h) - 1080 * 0.6) < 1e-6, '長邊＝頁面短邊 60%');
  assert.ok(Math.abs(o.w / o.h - 4 / 3) < 1e-6, '依原圖比例');
  assert.deepEqual((await S(page)).sel, [o.id]);
  const left = await px(page, o.x + 30, o.y + o.h / 2);
  assert.ok(left[0] > 200 && left[2] < 60, '左半紅 ' + left);
  const corner = await px(page, o.x + 2, o.y + 2);
  await page.fill('#dzF-radius', '80');
  await page.locator('#dzF-radius').blur();
  await flush(page);
  assert.equal((await obj(page, o.id)).radius, 80);
  const corner2 = await px(page, o.x + 2, o.y + 2);
  assert.notDeepEqual(corner2, corner, '圓角把角落裁掉');
  assert.deepEqual(corner2, [255, 255, 255, 255]);
  await page.check('#dzF-gray');
  await flush(page);
  const g = await px(page, o.x + 30, o.y + o.h / 2);
  assert.ok(Math.abs(g[0] - g[1]) < 3 && Math.abs(g[1] - g[2]) < 3, '抽色後 r=g=b ' + g);
  // 復原兩次回到彩色、直角
  await page.keyboard.press('Control+z');
  await page.keyboard.press('Control+z');
  assert.equal((await obj(page, o.id)).radius, 0);
  assert.deepEqual(errors, []);
});

test('拉面板滑桿一次只記一筆復原', { skip }, async t => {
  const { page, errors } = await open(t);
  const id = await add(page, 'shape:rect');
  const sl = page.locator('#dzF-opacity');
  const b = await sl.boundingBox();
  await page.mouse.move(b.x + b.width - 2, b.y + b.height / 2);
  await page.mouse.down();
  for (let i = 1; i <= 6; i++) await page.mouse.move(b.x + b.width - 2 - i * 20, b.y + b.height / 2);
  await page.mouse.up();
  const op = (await obj(page, id)).opacity;
  assert.ok(op < 0.8, `透明度 ${op}`);
  await page.keyboard.press('Control+z');   // 焦點在滑桿上：交給滑桿自己，不復原文件
  await page.click('#dzUndoBtn');
  assert.equal((await obj(page, id)).opacity, 1, '一次復原就回到 100%');
  await page.click('#dzUndoBtn');
  assert.equal(await obj(page, id), null);
  assert.deepEqual(errors, []);
});

test('選思源宋體 → 字型選單顯示下載中或載入失敗', { skip }, async t => {
  const { page, errors } = await open(t);
  const id = await add(page, 'text');
  await page.selectOption('#dzFont', 'noto-serif-tc-700');
  assert.equal((await obj(page, id)).font, 'noto-serif-tc-700');
  await page.waitForFunction(() => /下載中|載入失敗/.test([...document.querySelectorAll('#dzFont option')].map(o => o.textContent).join()));
  const labels = await page.locator('#dzFont option').allTextContents();
  assert.ok(labels.some(l => /思源宋體.*(下載中|載入失敗)/.test(l)), labels.join('、'));
  // Google Fonts 的樣式表是選到才插入
  assert.equal(await page.locator('link[href*="fonts.googleapis.com"]').count(), 1);
  assert.deepEqual(errors, []);
});

test('貼圖與形狀：加入後畫布有畫出、換貼圖', { skip }, async t => {
  const { page, errors } = await open(t);
  await add(page, 'shape:ellipse');
  await flush(page);
  const p = await px(page, 540, 540);
  assert.ok(p[2] > 200 && p[0] < 100, '藍色橢圓 ' + p);
  const sid = await add(page, 'sticker:smile');
  await page.waitForFunction(() => document.querySelectorAll('#dzF-sticker button').length === 7);
  await page.click('#dzF-sticker [data-v="cry"]');
  assert.equal((await obj(page, sid)).sticker, 'cry');
  await add(page, 'shape:arrow');
  await add(page, 'shape:line');
  await add(page, 'mosaic');
  assert.equal((await curPage(page)).objects.length, 5);
  assert.deepEqual(errors, []);
});

// =====================================================================================
// Task 8：匯出、剪貼簿、專案檔、手機版面
// =====================================================================================
// 下載：按按鈕 → 取得下載檔的位元組與檔名
async function download(page, sel) {
  const [dl] = await Promise.all([page.waitForEvent('download'), page.click(sel)]);
  const file = await dl.path();
  return { name: dl.suggestedFilename(), bytes: fs.readFileSync(file), file };
}
// 開匯出彈窗、照 o 設定（fmt／range／pages／scale／dpi），回傳彈窗裡的按鈕 selector 給 download() 點
async function openExport(page, o = {}) {
  await page.click('#dzExportBtn');
  await page.waitForSelector('#dzExportDlg:not([hidden])');
  for (const [k, id] of [['fmt', 'dzExpFmt'], ['range', 'dzExpRange'], ['pages', null], ['pack', 'dzExpPack'], ['scale', 'dzExpScale'], ['dpi', 'dzExpDpi']]) {
    if (k === 'pages') { if (o.pages != null) await page.fill('#dzExpPages', o.pages); continue; }
    if (o[k] != null) await page.click(`#${id} button[data-v="${o[k]}"]`);
  }
  return '#dzExpGo';
}
// 在頁面裡把圖片檔解碼，回傳指定點的像素
const decodePx = (page, bytes, mime, pts) => page.evaluate(async ([b64, mime, pts]) => {
  const im = new Image(); im.src = `data:${mime};base64,${b64}`; await im.decode();
  const c = document.createElement('canvas'); c.width = im.naturalWidth; c.height = im.naturalHeight;
  const x = c.getContext('2d'); x.drawImage(im, 0, 0);
  return { w: c.width, h: c.height, px: pts.map(([px, py]) => Array.from(x.getImageData(px, py, 1, 1).data)) };
}, [bytes.toString('base64'), mime, pts]);
// 一頁有底色、形狀、文字、貼圖
async function sampleDoc(page) {
  await page.click('#dzBgType [data-bg="solid"]');
  await page.locator('#dzBgColor').evaluate(el => { el.value = '#ffeecc'; el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true })); });
  await page.evaluate(() => {
    const U = QPTDesign.ui, C = QPTDesign.core, H = U.state.history, pid = U.state.pageId;
    H.run('t', d => C.addObject(d, pid, { type: 'shape', kind: 'rect', x: 100, y: 100, w: 300, h: 300, fill: '#ff0000' }));
    H.run('t', d => C.addObject(d, pid, { type: 'shape', kind: 'ellipse', x: 600, y: 600, w: 300, h: 300, fill: '#0000ff' }));
    H.run('t', d => C.addObject(d, pid, { type: 'sticker', sticker: 'smile', x: 650, y: 100, w: 240, h: 240 }));
    H.run('t', d => C.addObject(d, pid, { type: 'text', text: '標題', x: 140, y: 700, w: 400, h: 100, color: '#008000' }));
    U.rerender();
  });
  await flush(page);
}
const PTS = [[250, 250], [750, 750], [50, 1030], [1030, 50], [540, 540]];

test('匯出 PNG：下載檔第 33 位元組起是 pHYs、像素和畫布一致', { skip }, async t => {
  const { page, errors } = await open(t);
  await sampleDoc(page);
  const { name, bytes } = await download(page, await openExport(page, { fmt: 'png' }));
  assert.match(name, /^design-\d{8}-\d{4}\.png$/);
  assert.equal(bytes.toString('latin1', 37, 41), 'pHYs');
  assert.equal(bytes.readUInt32BE(41), 11811);
  assert.equal(bytes[49], 1);
  const out = await decodePx(page, bytes, 'image/png', PTS);
  assert.deepEqual([out.w, out.h], [1080, 1080]);
  for (let i = 0; i < PTS.length; i++) {
    const pv = await px(page, ...PTS[i]);
    assert.ok(out.px[i].every((v, k) => Math.abs(v - pv[k]) <= 4), `點 ${PTS[i]}：匯出 ${out.px[i]}，畫布 ${pv}`);
  }
  assert.deepEqual(out.px[0].slice(0, 3), [255, 0, 0]);
  assert.match(await status(page), /已下載/);
  assert.deepEqual(errors, []);
});

test('匯出 JPG 的 JFIF 密度是 300', { skip }, async t => {
  const { page, errors } = await open(t);
  await sampleDoc(page);
  const { name, bytes } = await download(page, await openExport(page, { fmt: 'jpg' }));
  assert.match(name, /^design-\d{8}-\d{4}\.jpg$/);
  assert.equal(bytes[0], 0xFF); assert.equal(bytes[1], 0xD8);
  assert.equal(bytes.toString('latin1', 6, 10), 'JFIF');
  assert.equal(bytes[13], 1);
  assert.equal(bytes.readUInt16BE(14), 300);
  assert.equal(bytes.readUInt16BE(16), 300);
  const out = await decodePx(page, bytes, 'image/jpeg', [[250, 250]]);
  assert.ok(out.px[0][0] > 240 && out.px[0][1] < 20, '紅色 ' + out.px[0]);
  assert.deepEqual(errors, []);
});

test('匯出 ZIP：兩頁時中央目錄檔名是 page-01.png、page-02.png', { skip }, async t => {
  const { page, errors } = await open(t);
  await sampleDoc(page);
  await page.click('#dzPageAdd');
  // 匯出中按鈕停用、顯示「匯出中…」
  const [dl] = await Promise.all([
    page.waitForEvent('download'),
    (async () => {
      await page.click(await openExport(page, { fmt: 'png', range: 'all', pack: 'zip' }));
      const st = await page.evaluate(() => ({ dis: document.getElementById('dzExportBtn').disabled, msg: document.getElementById('dzStatus').textContent }));
      assert.ok(st.dis, '匯出中按鈕停用');
      assert.match(st.msg, /匯出中/);
    })(),
  ]);
  const bytes = fs.readFileSync(await dl.path());
  assert.match(dl.suggestedFilename(), /^design-\d{8}-\d{4}\.zip$/);
  const names = [];
  for (let i = 0; i + 46 < bytes.length; i++) {
    if (bytes.readUInt32LE(i) !== 0x02014b50) continue;
    const n = bytes.readUInt16LE(i + 28);
    names.push(bytes.toString('utf8', i + 46, i + 46 + n));
  }
  assert.deepEqual(names, ['page-01.png', 'page-02.png']);
  await page.waitForFunction(() => !document.getElementById('dzExportBtn').disabled);
  assert.deepEqual(errors, []);
});

test('專案檔匯出再匯入：serialize(doc) 相同（id 與資產內容都一樣）、畫布像素一致', { skip }, async t => {
  const { page, errors } = await open(t);
  await sampleDoc(page);
  const img = await makeImage(page, 400, 300);
  await page.setInputFiles('#dzImgFile', img);
  await page.waitForFunction(() => QPTDesign.ui.state.doc.pages[0].objects.some(o => o.type === 'image'));
  await page.click('#dzPageAdd');
  await add(page, 'text');
  await page.click('#dzPages .dz-thumb >> nth=0');
  await flush(page);
  const docA = await docJson(page);
  const pxA = [];
  for (const p of PTS) pxA.push(await px(page, ...p));
  const { name, file } = await download(page, '#dzSaveBtn');
  assert.match(name, /^design-\d{8}-\d{4}\.json$/);
  const proj = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(proj.app, 'QuickPatterntool-design');
  assert.equal(proj.version, 1);
  assert.match(proj.doc.assets.a1.data, /^data:image\/png;base64,/);
  const saved = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'qpt-dz-')), 'proj.json');
  fs.copyFileSync(file, saved);

  // 新的分頁（全新的文件）匯入
  const b = await open(t);
  await b.page.setInputFiles('#dzOpenFile', saved);
  await b.page.waitForFunction(() => QPTDesign.ui.state.doc.pages.length === 2);
  await b.page.waitForFunction(() => /已匯入/.test(document.getElementById('dzStatus').textContent));
  await b.page.waitForFunction(() => Object.keys(QPTDesign.ui.state.doc.assets).length === 1);
  await b.page.evaluate(() => new Promise(r => setTimeout(r, 300)));
  await flush(b.page);
  assert.equal(await docJson(b.page), docA);
  for (let i = 0; i < PTS.length; i++) {
    const pb = await px(b.page, ...PTS[i]);
    assert.ok(pb.every((v, k) => Math.abs(v - pxA[i][k]) <= 2), `點 ${PTS[i]}：${pxA[i]} vs ${pb}`);
  }
  // 圖片也畫出來了（不是佔位）
  const o = (await curPage(b.page)).objects.find(x => x.type === 'image');
  const ip = await px(b.page, o.x + 20, o.y + o.h / 2);
  assert.ok(ip[0] > 200 && ip[2] < 60, '圖片左半紅 ' + ip);
  assert.deepEqual(errors, []);
  assert.deepEqual(b.errors, []);
});

test('匯入壞檔顯示繁中錯誤、doc 不變', { skip }, async t => {
  const { page, errors } = await open(t);
  await add(page, 'shape:rect');
  const before = await docJson(page);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qpt-dz-'));
  const cases = [
    ['bad.json', 'not json {', /不是有效的設計專案檔/],
    ['other.json', JSON.stringify({ app: 'something-else', doc: {} }), /不是有效的設計專案檔/],
    ['newer.json', JSON.stringify({ app: 'QuickPatterntool-design', version: 2, doc: { version: 2, pages: [], assets: {} } }), /較新版本/],
    ['missing.json', JSON.stringify({ app: 'QuickPatterntool-design', version: 1, doc: { version: 1, assets: {}, pages: [{ id: 'p1', w: 1080, h: 1080, bg: { type: 'solid', color: '#fff' }, objects: [{ id: 'o1', type: 'image', asset: 'nope', x: 0, y: 0, w: 10, h: 10 }] }] } }), /[一-鿿]/],
  ];
  for (const [n, body, re] of cases) {
    const f = path.join(dir, n);
    fs.writeFileSync(f, body);
    await page.setInputFiles('#dzOpenFile', f);
    await page.waitForFunction(() => document.getElementById('dzStatus').classList.contains('err'));
    const msg = await status(page);
    assert.match(msg, re, `${n}：${msg}`);
    assert.equal(await docJson(page), before, `${n}：文件不變`);
    await page.evaluate(() => { const s = document.getElementById('dzStatus'); s.textContent = ''; s.classList.remove('err'); });
  }
  assert.deepEqual(errors, []);
});

test('匯入後 Ctrl+Z 回到匯入前', { skip }, async t => {
  const { page, errors } = await open(t);
  // 先做一份專案檔
  await add(page, 'shape:ellipse');
  await page.click('#dzPageAdd');
  const { file } = await download(page, '#dzSaveBtn');
  const saved = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'qpt-dz-')), 'p.json');
  fs.copyFileSync(file, saved);
  // 另一個分頁：有自己的內容，匯入（會先確認），再復原
  const b = await open(t);
  const img = await makeImage(b.page);
  await b.page.setInputFiles('#dzImgFile', img);
  await b.page.waitForFunction(() => QPTDesign.ui.state.doc.pages[0].objects.length === 1);
  const pagesBefore = await b.page.evaluate(() => JSON.stringify(QPTDesign.ui.getDoc().pages));
  const dialogs = [];
  b.page.on('dialog', d => dialogs.push(d.message()));
  await b.page.setInputFiles('#dzOpenFile', saved);
  await b.page.waitForFunction(() => QPTDesign.ui.state.doc.pages.length === 2);
  assert.ok(dialogs.some(m => /取代目前的設計/.test(m)), '有內容時先確認');
  // 匯入的資產 id 不會和現有的撞到（這份專案沒有圖片，現有的 a1 仍在）
  await b.page.locator('#dzStage').hover();
  await b.page.keyboard.press('Control+z');
  assert.equal(await b.page.evaluate(() => JSON.stringify(QPTDesign.ui.getDoc().pages)), pagesBefore);
  // 圖片仍畫得出來
  await flush(b.page);
  const o = (await curPage(b.page)).objects[0];
  const ip = await px(b.page, o.x + 20, o.y + o.h / 2);
  assert.ok(ip[0] > 200 && ip[2] < 60, '復原後圖片仍在 ' + ip);
  assert.deepEqual(errors, []);
  assert.deepEqual(b.errors, []);
});

test('匯入的資產 id 和現有的撞到時會改名，復原後舊圖不被換掉', { skip }, async t => {
  const { page, errors } = await open(t);
  const blue = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'qpt-dz-')), 'blue.png');
  const b64 = await page.evaluate(() => { const c = document.createElement('canvas'); c.width = 200; c.height = 200; const x = c.getContext('2d'); x.fillStyle = '#00c000'; x.fillRect(0, 0, 200, 200); return c.toDataURL('image/png').split(',')[1]; });
  fs.writeFileSync(blue, Buffer.from(b64, 'base64'));
  await page.setInputFiles('#dzImgFile', blue);
  await page.waitForFunction(() => QPTDesign.ui.state.doc.pages[0].objects.length === 1);
  const { file } = await download(page, '#dzSaveBtn');   // 這份的資產是 a1（綠）
  const saved = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'qpt-dz-')), 'g.json');
  fs.copyFileSync(file, saved);
  const b = await open(t);
  await b.page.setInputFiles('#dzImgFile', await makeImage(b.page));   // 這邊的 a1 是紅藍圖
  await b.page.waitForFunction(() => QPTDesign.ui.state.doc.pages[0].objects.length === 1);
  await b.page.setInputFiles('#dzOpenFile', saved);
  await b.page.waitForFunction(() => /已匯入/.test(document.getElementById('dzStatus').textContent));
  const d = JSON.parse(await docJson(b.page));
  assert.notEqual(d.pages[0].objects[0].asset, 'a1', '匯入的資產改名');
  await b.page.waitForFunction(() => { const s = QPTDesign.ui.state, p = s.doc.pages[0], o = p.objects[0]; const c = document.getElementById('dzCanvas'); const k = c.width / p.w;
    const v = c.getContext('2d').getImageData(Math.floor((o.x + o.w / 2) * k), Math.floor((o.y + o.h / 2) * k), 1, 1).data; return v[1] > 150 && v[0] < 60; });
  await b.page.click('#dzUndoBtn');
  await flush(b.page);
  const o = (await curPage(b.page)).objects[0];
  assert.equal(o.asset, 'a1');
  const ip = await px(b.page, o.x + 20, o.y + o.h / 2);
  assert.ok(ip[0] > 200 && ip[1] < 60, '復原後還是原本的紅藍圖 ' + ip);
  assert.deepEqual(errors, []);
  assert.deepEqual(b.errors, []);
});

test('複製：stub navigator.clipboard.write 後收到 image/png', { skip }, async t => {
  const init = () => {
    window.__clip = [];
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { write: async items => { for (const it of items) for (const ty of it.types) window.__clip.push([ty, (await it.getType(ty)).size]); } } });
  };
  const { page, errors } = await open(t, { init });
  await sampleDoc(page);
  await openExport(page);
  await page.click('#dzExpCopy');
  await page.waitForFunction(() => window.__clip.length > 0);
  const clip = await page.evaluate(() => window.__clip);
  assert.equal(clip[0][0], 'image/png');
  assert.ok(clip[0][1] > 1000);
  assert.match(await status(page), /已複製/);
  assert.deepEqual(errors, []);
});

test('390×844 視窗：畫布在面板之上、沒有水平捲軸', { skip }, async t => {
  const { page, errors } = await open(t, { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, hasTouch: true, isMobile: true });
  await add(page, 'text');
  const m = await page.evaluate(() => {
    const r = id => document.getElementById(id).getBoundingClientRect();
    const btns = [...document.querySelectorAll('.func-btn')].map(b => b.getBoundingClientRect());
    return { sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth,
      stage: r('dzStage'), panel: r('dzPanel'), tools: r('dzTools'),
      toolsScroll: getComputedStyle(document.getElementById('dzTools')).overflowX,
      rows: new Set(btns.map(b => Math.round(b.top))).size };
  });
  assert.equal(m.sw, m.cw, `scrollWidth ${m.sw} ≠ clientWidth ${m.cw}`);
  assert.equal(m.cw, 390);
  assert.ok(m.stage.bottom <= m.panel.top, '畫布在面板之上');
  assert.ok(m.stage.bottom <= m.tools.top, '工具列在畫布下方');
  assert.ok(m.tools.height < 120, '工具列是橫的一排');
  assert.equal(m.toolsScroll, 'auto');
  assert.ok(m.stage.width > 340, '畫布接近滿寬');
  assert.equal(m.rows, 1, '上排功能切換仍是一排');
  // 整頁放得進舞台
  const s = await S(page);
  assert.ok(1080 * s.zoom <= m.stage.width && 1080 * s.zoom <= m.stage.height);
  assert.deepEqual(errors, []);
});

test('手機：兩指張開放大畫布、單指拖曳物件', { skip }, async t => {
  const { ctx, page, errors } = await open(t, { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, hasTouch: true, isMobile: true });
  const id = await add(page, 'shape:rect');
  await page.evaluate(() => window.scrollTo(0, 0));   // 點工具列時頁面捲到下面了，捲回畫布
  const z0 = (await S(page)).zoom;
  const box = await page.locator('#dzStage').boundingBox();
  const cx = box.x + box.width / 2, cy = box.y + 40;
  const cdp = await ctx.newCDPSession(page);
  const touch = (type, pts) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: pts.map((q, i) => ({ x: q[0], y: q[1], id: i })) });
  await touch('touchStart', [[cx - 30, cy], [cx + 30, cy]]);
  for (let i = 1; i <= 6; i++) await touch('touchMove', [[cx - 30 - i * 10, cy], [cx + 30 + i * 10, cy]]);
  await touch('touchEnd', []);
  const z1 = (await S(page)).zoom;
  assert.ok(z1 > z0 * 1.3, `放大 ${z0} → ${z1}`);
  assert.equal(await obj(page, id).then(o => o.x), (1080 - 400) / 2, '兩指縮放不會動到物件');
  await page.click('#dzFitBtn');
  const c = await center(page, id);
  await touch('touchStart', [[c.x, c.y]]);
  for (let i = 1; i <= 5; i++) await touch('touchMove', [[c.x + i * 8, c.y]]);
  await touch('touchEnd', []);
  const o = await obj(page, id);
  assert.ok(o.x > (1080 - 400) / 2 + 20, `單指拖曳物件 x=${o.x}`);
  assert.deepEqual(errors, []);
});

// =====================================================================================
// 審查補強：貼上不外漏到圖片套版、輸入框內 Ctrl+Z、字型 ready 回 false
// =====================================================================================
test('設計分頁的輸入框內貼上含圖片的剪貼簿：不會流進看不見的「圖片套版」', { skip }, async t => {
  const { page, errors } = await open(t);
  await add(page, 'text');
  const fire = sel => page.evaluate(sel => {
    const el = document.querySelector(sel); el.focus();
    const dt = new DataTransfer();
    dt.items.add(new File([new Uint8Array([1, 2, 3, 4])], 'zzz-leak.png', { type: 'image/png' }));
    const ev = new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true });
    el.dispatchEvent(ev);
    return { prevented: ev.defaultPrevented };
  }, sel);
  const before = await docJson(page);
  // app.js 的 handleFile 一收到圖片就會 URL.createObjectURL：用次數當作「圖片套版有沒有收到圖」的訊號
  await page.evaluate(() => { window.__objUrls = 0; const oc = URL.createObjectURL; URL.createObjectURL = f => { window.__objUrls++; return oc.call(URL, f); }; });
  await fire('#dzF-x');                                  // 面板的數字輸入框
  await page.evaluate(() => new Promise(r => setTimeout(r, 400)));
  assert.equal(await page.evaluate(() => window.__objUrls), 0, '圖片套版沒有收到圖片');
  assert.equal(await docJson(page), before, '輸入框內貼圖不會新增設計物件');
  assert.equal((await page.evaluate(() => document.getElementById('dzF-x').tagName)), 'INPUT');
  assert.deepEqual(errors, []);
});

test('面板 input 與文字編輯 textarea 內按 Ctrl+Z：文件與復原堆疊都不變', { skip }, async t => {
  const { page, errors } = await open(t);
  const id = await add(page, 'text');
  const snap = () => page.evaluate(() => { const H = QPTDesign.ui.state.history; return { doc: QPTDesign.core.serialize(QPTDesign.ui.getDoc()), can: H.canUndo, label: H.undoLabel }; });
  const base = await snap();
  assert.equal(base.can, true);
  await page.click('#dzF-x');
  await page.keyboard.press('Control+z');
  assert.deepEqual(await snap(), base, '面板 input');
  const c = await center(page, id);
  await page.mouse.dblclick(c.x, c.y);
  await page.waitForSelector('.dz-text-edit');
  const inEdit = await snap();
  await page.keyboard.press('Control+z');
  assert.deepEqual(await snap(), inEdit, '文字編輯 textarea');
  assert.equal(inEdit.can, base.can);
  assert.equal(inEdit.label, base.label);
  assert.deepEqual(errors, []);
});

test('字型 ready 回 false：匯出 PNG 仍會完成並下載', { skip }, async t => {
  const { page, errors } = await open(t);
  await sampleDoc(page);
  await page.evaluate(() => { QPTDesign.fonts.ready = () => Promise.resolve(false); });
  const { name, bytes } = await download(page, await openExport(page, { fmt: 'png' }));
  assert.match(name, /^design-\d{8}-\d{4}\.png$/);
  assert.equal(bytes.toString('latin1', 37, 41), 'pHYs');
  assert.deepEqual(errors, []);
});

// ---- 匯出彈窗 -------------------------------------------------------------------------
test('匯出彈窗：2× 與 72 DPI 輸出 2160 px、pHYs 是 72 DPI；檔名可改', { skip }, async t => {
  const { page, errors } = await open(t);
  await sampleDoc(page);
  const go = await openExport(page, { fmt: 'png', scale: 2, dpi: 72 });
  assert.match(await page.textContent('#dzExpSize'), /2160 × 2160 px/);
  await page.fill('#dzExpName', 'weekend/cover');   // 無頭 Chromium 會把非英文的下載檔名改成 download，所以這裡用英文驗證「斜線會被拿掉」
  const { name, bytes } = await download(page, go);
  assert.equal(name, 'weekendcover.png');
  assert.equal(bytes.readUInt32BE(16), 2160);   // IHDR 寬
  assert.equal(bytes.toString('latin1', 37, 41), 'pHYs');
  assert.equal(bytes.readUInt32BE(41), Math.round(72 / 0.0254));
  assert.ok(await page.isHidden('#dzExportDlg'), '下載後關閉彈窗');
  assert.deepEqual(errors, []);
});

test('匯出彈窗：指定頁「2」只下載第 2 頁；「1,3」打包 ZIP；超出範圍顯示繁中錯誤並停用下載', { skip }, async t => {
  const { page, errors } = await open(t);
  await sampleDoc(page);
  await page.click('#dzPageAdd');
  await page.click('#dzPageAdd');
  let go = await openExport(page, { range: 'custom', pages: '2' });
  assert.match(await page.textContent('#dzExpSummary'), /第 2 頁/);
  let r = await download(page, go);
  assert.match(r.name, /\.png$/);
  go = await openExport(page, { range: 'custom', pages: '1,3', pack: 'zip' });
  assert.equal(await page.textContent('#dzExpGo'), '下載 ZIP');
  assert.ok(await page.isDisabled('#dzExpCopy'), '多頁不能複製');
  r = await download(page, go);
  assert.match(r.name, /\.zip$/);
  const text = r.bytes.toString('latin1');
  assert.ok(text.includes('page-01.png') && text.includes('page-03.png') && !text.includes('page-02.png'));
  await openExport(page, { range: 'custom', pages: '5' });
  assert.match(await page.textContent('#dzExpErr'), /1～3/);
  assert.ok(await page.isDisabled('#dzExpGo'));
  assert.deepEqual(errors, []);
});

test('匯出彈窗：3× 讓長邊超過 8192 時停用下載並說明', { skip }, async t => {
  const { page, errors } = await open(t);
  await page.click('#dzExportBtn');
  await page.click('#dzExpScale button[data-v="3"]');
  assert.equal(await page.textContent('#dzExpErr'), '');   // 1080×3 = 3240 沒超過
  await page.click('#dzExpClose');
  await page.evaluate(() => { const u = QPTDesign.ui, c = QPTDesign.core; u.state.history.run('改尺寸', d => c.setPageProps(d, u.state.pageId, { w: 4000, h: 1000 })); u.rerender(); });
  await page.click('#dzExportBtn');
  assert.match(await page.textContent('#dzExpErr'), /8192/);
  assert.ok(await page.isDisabled('#dzExpGo'));
  assert.deepEqual(errors, []);
});

test('匯出彈窗：Esc 關閉、開著時快捷鍵不作用、設定會記住', { skip }, async t => {
  const { page, errors } = await open(t);
  await sampleDoc(page);
  await page.evaluate(() => QPTDesign.ui.select([QPTDesign.ui.getDoc().pages[0].objects[0].id]));
  const count = () => page.evaluate(() => QPTDesign.ui.getDoc().pages[0].objects.length);
  const n = await count();
  await openExport(page, { fmt: 'jpg', scale: 2 });
  await page.keyboard.press('Delete');
  await page.keyboard.press('Control+z');
  assert.equal(await count(), n, '彈窗開著時 Delete／Ctrl+Z 不動文件');
  await page.keyboard.press('Escape');
  assert.ok(await page.isHidden('#dzExportDlg'));
  assert.equal(await page.evaluate(() => document.activeElement.id), 'dzExportBtn', '焦點回到匯出按鈕');
  await page.click('#dzExportBtn');
  assert.ok(await page.isVisible('#dzExpQualityRow'), 'JPG 才顯示品質');
  assert.equal(await page.getAttribute('#dzExpScale button[data-v="2"]', 'aria-pressed'), 'true');
  await page.click('#dzExpCancel');
  assert.ok(await page.isHidden('#dzExportDlg'));
  assert.deepEqual(errors, []);
});

test('匯出彈窗：多頁預設一張一張下載，檔名結尾是頁碼；只有多頁才顯示「多頁時」', { skip }, async t => {
  const { page, errors } = await open(t);
  await sampleDoc(page);
  await page.click('#dzExportBtn');
  assert.ok(await page.isHidden('#dzExpPackRow'), '目前頁只有一頁，不顯示多頁選項');
  await page.click('#dzExpClose');
  await page.click('#dzPageAdd');
  await page.click('#dzPageAdd');
  const go = await openExport(page, { range: 'custom', pages: '1, 3' });
  assert.ok(await page.isVisible('#dzExpPackRow'));
  assert.equal(await page.getAttribute('#dzExpPack button[data-v="each"]', 'aria-pressed'), 'true', '預設一張一張');
  assert.equal(await page.textContent('#dzExpGo'), '下載 2 張');
  await page.fill('#dzExpName', 'trip');
  const names = [];
  const got = new Promise(res => page.on('download', d => { names.push(d.suggestedFilename()); if (names.length === 2) res(); }));
  await page.click(go);
  await got;
  assert.deepEqual(names, ['trip_01.png', 'trip_03.png']);
  await page.waitForFunction(() => /已一張一張下載 2 頁/.test(document.getElementById('dzStatus').textContent));
  assert.deepEqual(errors, []);
});

// =====================================================================================
// 漸層填色、重新著色、弧形文字（規格 2026-10-30-design-paint-recolor-arc 第 4、5 節）
// =====================================================================================
// 改欄位的值並送出 input＋change（color、range、number 都適用）
const setInput = (page, sel, v) => page.locator(sel).evaluate((el, v) => {
  el.value = v;
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
}, String(v));
const near = (a, b, tol = 24) => a.slice(0, 3).every((v, k) => Math.abs(v - b[k]) <= tol);
const BLUE = [0x2f, 0x6f, 0xed];

test('顏料編輯器：形狀改放射與線性，像素跟著變；復原一次回到純色；拉角度只記一筆', { skip }, async t => {
  const { page, errors } = await open(t);
  const id = await add(page, 'shape:rect');
  const o = await obj(page, id);
  const cx = o.x + o.w / 2, cy = o.y + o.h / 2;
  const P = { c: [cx, cy], tl: [o.x + 4, o.y + 4], top: [cx, o.y + 6], bottom: [cx, o.y + o.h - 6], left: [o.x + 6, cy], right: [o.x + o.w - 6, cy] };
  const solidC = await px(page, ...P.c);
  assert.ok(near(solidC, BLUE), '預設藍色 ' + solidC);
  assert.ok(await page.isVisible('#dzF-fill-type'), '有純色／線性／放射切換');
  assert.equal(await page.getAttribute('#dzF-fill-type button[data-v="solid"]', 'aria-pressed'), 'true');

  // 放射：中心是原本的顏色、角落是終點色（預設白）
  await page.click('#dzF-fill-type [data-v="radial"]');
  await flush(page);
  assert.deepEqual((await obj(page, id)).fill, { type: 'radial', from: '#2f6fed', to: '#ffffff', cx: 0.5, cy: 0.5, r: 1 });
  assert.ok(near(await px(page, ...P.c), BLUE), '中心接近起點色');
  const corner = await px(page, ...P.tl);
  assert.ok(corner[0] > 200 && corner[1] > 200, '角落接近白 ' + corner);
  for (const s of ['#dzF-fill-from', '#dzF-fill-to', '#dzF-fill-cx', '#dzF-fill-cy', '#dzF-fill-r']) assert.ok(await page.isVisible(s), s);
  assert.equal(await page.isVisible('#dzF-fill-angle'), false, '放射沒有角度');
  await page.click('#dzUndoBtn');
  await flush(page);
  assert.equal((await obj(page, id)).fill, '#2f6fed', '復原一次回到純色');
  assert.deepEqual(await px(page, ...P.c), solidC);
  assert.ok(await page.isVisible('#dzF-fill'), '面板也回到純色');

  // 線性：預設 180°（上→下）
  await page.click('#dzF-fill-type [data-v="linear"]');
  await flush(page);
  assert.deepEqual((await obj(page, id)).fill, { type: 'linear', from: '#2f6fed', to: '#ffffff', angle: 180 });
  const top = await px(page, ...P.top), bottom = await px(page, ...P.bottom);
  assert.ok(near(top, BLUE, 30) && bottom[0] > 200, `上 ${top} 下 ${bottom}`);
  // 改終點色：整個 paint 物件一起寫回
  await setInput(page, '#dzF-fill-to', '#ff0000');
  assert.deepEqual((await obj(page, id)).fill, { type: 'linear', from: '#2f6fed', to: '#ff0000', angle: 180 });
  // 拉角度滑桿：一次拖動只記一筆
  const sl = page.locator('#dzF-fill-angle');
  const b = await sl.boundingBox();
  await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2);
  await page.mouse.down();
  for (let i = 1; i <= 5; i++) await page.mouse.move(b.x + b.width / 2 - i * 12, b.y + b.height / 2);
  await page.mouse.up();
  const ang = (await obj(page, id)).fill.angle;
  assert.ok(ang < 180, '角度 ' + ang);
  await setInput(page, '#dzF-fill-angle', 90);
  await flush(page);
  const L = await px(page, ...P.left), Rt = await px(page, ...P.right);
  assert.ok(near(L, BLUE, 30) && Rt[0] > 200 && Rt[2] < 80, `90° 左 ${L} 右 ${Rt}`);
  await page.click('#dzUndoBtn');
  assert.equal((await obj(page, id)).fill.angle, ang, '復原一次回到拖動後的角度');
  await page.click('#dzUndoBtn');
  assert.equal((await obj(page, id)).fill.angle, 180, '再一次回到拖動前（拖動只記一筆）');
  // 切回純色：用起點色
  await page.click('#dzF-fill-type [data-v="solid"]');
  assert.equal((await obj(page, id)).fill, '#2f6fed');
  assert.deepEqual(errors, []);
});

test('顏料編輯器：線與箭頭只有純色；漸層矩形改成線時填色變回純色', { skip }, async t => {
  const { page, errors } = await open(t);
  const id = await add(page, 'shape:rect');
  await page.click('#dzF-fill-type [data-v="radial"]');
  await page.selectOption('#dzF-kind', 'line');
  const o = await obj(page, id);
  assert.equal(o.kind, 'line');
  assert.equal(o.fill, '#2f6fed');
  assert.equal(await page.locator('#dzF-fill-type').count(), 0, '線沒有漸層切換');
  const aid = await add(page, 'shape:arrow');
  assert.ok(aid);
  assert.equal(await page.locator('#dzF-fill-type').count(), 0, '箭頭沒有漸層切換');
  assert.deepEqual(errors, []);
});

test('顏料編輯器：文字顏色可以改成線性漸層，描邊仍是純色', { skip }, async t => {
  const { page, errors } = await open(t);
  const id = await add(page, 'text');
  assert.ok(await page.isVisible('#dzF-color-type'));
  await page.click('#dzF-color-type [data-v="linear"]');
  let o = await obj(page, id);
  assert.deepEqual(o.color, { type: 'linear', from: '#111111', to: '#ffffff', angle: 180 });
  await setInput(page, '#dzF-color-to', '#ff0000');
  o = await obj(page, id);
  assert.equal(o.color.to, '#ff0000');
  assert.equal(typeof o.stroke.color, 'string');
  assert.equal(await page.locator('#dzF-strokeColor-type').count(), 0, '描邊沒有漸層');
  assert.deepEqual(errors, []);
});

test('背景：放射漸層，中心是起點色、角落是終點色', { skip }, async t => {
  const { page, errors } = await open(t);
  await page.click('#dzBgType [data-bg="solid"]');
  await setInput(page, '#dzBgColor', '#ff0000');
  await page.click('#dzBgType [data-bg="radial"]');
  await flush(page);
  const bg = (await curPage(page)).bg;
  assert.deepEqual(bg, { type: 'radial', from: '#ff0000', to: '#ffffff', cx: 0.5, cy: 0.5, r: 1 });
  const c = await px(page, 540, 540), k = await px(page, 4, 4);
  assert.ok(c[0] > 240 && c[1] < 30, '中心紅 ' + c);
  assert.ok(k[1] > 200, '角落接近白 ' + k);
  await setInput(page, '#dzBgR', 50);
  assert.equal((await curPage(page)).bg.r, 0.5);
  await setInput(page, '#dzBgCx', 0);
  assert.equal((await curPage(page)).bg.cx, 0);
  // 放射 → 線性 保留兩端顏色
  await page.click('#dzBgType [data-bg="gradient"]');
  assert.deepEqual((await curPage(page)).bg, { type: 'gradient', from: '#ff0000', to: '#ffffff', angle: 180 });
  await page.click('#dzBgType [data-bg="solid"]');
  assert.deepEqual((await curPage(page)).bg, { type: 'solid', color: '#ff0000' });
  assert.deepEqual(errors, []);
});

// 兩頁：第 1 頁底色 #ffeecc、紅色矩形、紅色橢圓、紅字、鎖定的紅色矩形；第 2 頁一個紅色矩形
async function redDoc(page) {
  await page.click('#dzBgType [data-bg="solid"]');
  await setInput(page, '#dzBgColor', '#ffeecc');
  await page.click('#dzPageAdd');
  await page.evaluate(() => {
    const U = QPTDesign.ui, C = QPTDesign.core, H = U.state.history, pid = U.state.pageId;
    H.run('t', d => C.addObject(d, pid, { type: 'shape', kind: 'rect', x: 100, y: 100, w: 300, h: 300, fill: '#ff0000' }));
  });
  await page.click('#dzPages .dz-thumb >> nth=0');
  await page.evaluate(() => {
    const U = QPTDesign.ui, C = QPTDesign.core, H = U.state.history, pid = U.state.pageId;
    H.run('t', d => C.addObject(d, pid, { type: 'shape', kind: 'rect', x: 100, y: 100, w: 300, h: 300, fill: '#ff0000' }));
    H.run('t', d => C.addObject(d, pid, { type: 'shape', kind: 'ellipse', x: 600, y: 600, w: 300, h: 300, fill: 'rgba(255,0,0,0.5)' }));
    H.run('t', d => C.addObject(d, pid, { type: 'text', text: '標題', x: 600, y: 100, w: 400, h: 100, color: '#ff0000' }));
    H.run('t', d => C.addObject(d, pid, { type: 'shape', kind: 'rect', x: 100, y: 700, w: 200, h: 200, fill: '#ff0000', locked: true }));
    U.select([]);
    U.rerender();
  });
  await flush(page);
}
const swatchCount = (page, c) => page.locator(`#dzRecolor [data-color="${c}"] .dz-swatch-n`).textContent();

test('配色：本頁換色一次換掉、鎖定的不改；Ctrl+Z 一次全部復原；全部頁也會換', { skip }, async t => {
  const { page, errors } = await open(t);
  await redDoc(page);
  assert.ok(await page.isVisible('#dzRecolor'), '沒選物件時有配色區');
  assert.equal(await page.getAttribute('#dzRecolorScope button[data-v="page"]', 'aria-pressed'), 'true', '預設本頁');
  assert.equal(await swatchCount(page, '#ff0000'), '4');
  const before = await docJson(page);
  const undoBefore = await page.evaluate(() => QPTDesign.ui.state.history.canUndo);

  await page.focus('#dzRecolor [data-color="#ff0000"] input');
  await setInput(page, '#dzRecolor [data-color="#ff0000"] input', '#00ff00');
  await flush(page);
  assert.match(await status(page), /已替換 3 處/);
  assert.match(await status(page), /1 處在鎖定物件裡沒改/);
  assert.deepEqual((await px(page, 250, 250)).slice(0, 3), [0, 255, 0]);
  const e = await px(page, 750, 750);
  assert.ok(e[1] > e[0] + 60, '半透明橢圓也變綠 ' + e);
  assert.deepEqual((await px(page, 200, 800)).slice(0, 3), [255, 0, 0], '鎖定的不改');
  const p1 = await curPage(page);
  assert.equal(p1.objects[1].fill, 'rgba(0,255,0,0.5)', '保留透明度');
  const d = await page.evaluate(() => QPTDesign.ui.getDoc().pages[1].objects[0].fill);
  assert.equal(d, '#ff0000', '本頁模式不改第 2 頁');
  // 色票重建
  assert.equal(await swatchCount(page, '#00ff00'), '3');
  assert.equal(await swatchCount(page, '#ff0000'), '1');

  // 一次 Ctrl+Z 全部復原
  await page.keyboard.press('Control+z');
  await flush(page);
  assert.equal(await docJson(page), before);
  assert.deepEqual((await px(page, 250, 250)).slice(0, 3), [255, 0, 0]);
  assert.equal(await swatchCount(page, '#ff0000'), '4', '復原後色票也更新');
  assert.ok(undoBefore);

  // 全部頁
  await page.click('#dzRecolorScope [data-v="all"]');
  assert.equal(await swatchCount(page, '#ff0000'), '5');
  await setInput(page, '#dzRecolor [data-color="#ff0000"] input', '#0000ff');
  assert.match(await status(page), /已替換 4 處/);
  assert.equal(await page.evaluate(() => QPTDesign.ui.getDoc().pages[1].objects[0].fill), '#0000ff');
  await page.click('#dzUndoBtn');
  assert.equal(await docJson(page), before, '一次復原兩頁都回來');
  assert.deepEqual(errors, []);
});

test('配色：超過 24 色只顯示 24 格並註明另有幾色', { skip }, async t => {
  const { page, errors } = await open(t);
  await page.evaluate(() => {
    const U = QPTDesign.ui, C = QPTDesign.core, H = U.state.history, pid = U.state.pageId;
    H.run('t', d => {
      for (let i = 0; i < 30; i++) {
        const r = C.addObject(d, pid, { type: 'shape', kind: 'rect', x: i * 30, y: 0, w: 20, h: 20, fill: '#' + (0x100000 + i * 4099).toString(16).slice(-6) });
        if (!r.ok) return r;
      }
      return { ok: true };
    });
    U.select([]);
    U.rerender();
  });
  await flush(page);
  // 30 個形狀色＋背景白＝31 色（粗細 0 的描邊看不見，不算）
  assert.equal(await page.locator('#dzRecolor .dz-swatch').count(), 24);
  assert.match(await page.textContent('#dzRecolorMore'), /另有 7 色/);
  assert.deepEqual(errors, []);
});

test('弧度：拉弧度後 h 改變、對齊停用；一次復原；數字欄位；匯出 PNG 和畫布一致', { skip }, async t => {
  const { page, errors } = await open(t);
  const id = await add(page, 'text');
  await page.evaluate(() => document.fonts.ready);
  const h0 = (await obj(page, id)).h;
  assert.equal(await page.textContent('#dzF-arcOut'), '不彎');
  assert.equal(await page.locator('#dzF-align button:disabled').count(), 0);

  // 拖滑桿：一筆
  const sl = page.locator('#dzF-arc');
  const b = await sl.boundingBox();
  await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2);
  await page.mouse.down();
  for (let i = 1; i <= 5; i++) await page.mouse.move(b.x + b.width / 2 + i * 8, b.y + b.height / 2);
  await page.mouse.up();
  const a1 = (await obj(page, id)).arc;
  assert.ok(a1 > 0, 'arc ' + a1);
  await page.click('#dzUndoBtn');
  assert.equal((await obj(page, id)).arc, 0, '拖動只記一筆');
  assert.equal((await obj(page, id)).h, h0);

  await setInput(page, '#dzF-arcNum', 120);
  await flush(page);
  const o = await obj(page, id);
  assert.equal(o.arc, 120);
  assert.notEqual(o.h, h0, 'h 改變');
  const want = await page.evaluate(id => { const f = QPTDesign.core.findObject(QPTDesign.ui.getDoc(), id); return QPTDesign.render.textHeight(f.obj, QPTDesign.fonts); }, id);
  assert.ok(Math.abs(o.h - want) < 0.5, `h ${o.h} ≈ textHeight ${want}`);
  assert.equal(await page.inputValue('#dzF-arc'), '120', '滑桿同步');
  assert.equal(await page.textContent('#dzF-arcOut'), '上拱');
  assert.equal(await page.locator('#dzF-align button:disabled').count(), 3, '對齊停用');
  assert.match(await page.textContent('#dzF-arcNote'), /弧形文字固定置中/);
  // 範圍限制
  await setInput(page, '#dzF-arcNum', 999);
  assert.equal((await obj(page, id)).arc, 360);
  await setInput(page, '#dzF-arcNum', -90);
  assert.equal((await obj(page, id)).arc, -90);
  assert.equal(await page.textContent('#dzF-arcOut'), '下彎');
  await setInput(page, '#dzF-arcNum', 120);
  // 改字級也用 textHeight 更新 h
  await setInput(page, '#dzF-size', 120);
  const o2 = await obj(page, id);
  const want2 = await page.evaluate(id => { const f = QPTDesign.core.findObject(QPTDesign.ui.getDoc(), id); return QPTDesign.render.textHeight(f.obj, QPTDesign.fonts); }, id);
  assert.ok(Math.abs(o2.h - want2) < 0.5 && o2.h > o.h, `改字級後 h ${o2.h}`);

  // 匯出 PNG 和畫布一致（把匯出圖縮到畫布大小，比較文字框範圍的平均差與「有字」像素數）
  await page.evaluate(() => QPTDesign.ui.select([]));
  await flush(page);
  const { bytes } = await download(page, await openExport(page, { fmt: 'png', range: 'cur', scale: 1 }));
  const cmp = await page.evaluate(async ([b64, box]) => {
    const im = new Image(); im.src = 'data:image/png;base64,' + b64; await im.decode();
    const cv = document.getElementById('dzCanvas'), k = cv.width / 1080;
    const c2 = document.createElement('canvas'); c2.width = cv.width; c2.height = cv.height;
    c2.getContext('2d').drawImage(im, 0, 0, c2.width, c2.height);
    const sx = Math.floor(box.x * k), sy = Math.floor(box.y * k), sw = Math.ceil(box.w * k), sh = Math.ceil(box.h * k);
    const a = cv.getContext('2d').getImageData(sx, sy, sw, sh).data, b = c2.getContext('2d').getImageData(sx, sy, sw, sh).data;
    let diff = 0, inkA = 0, inkB = 0;
    for (let i = 0; i < a.length; i += 4) {
      diff += Math.abs(a[i] - b[i]) + Math.abs(a[i + 1] - b[i + 1]) + Math.abs(a[i + 2] - b[i + 2]);
      if (a[i] < 128) inkA++;
      if (b[i] < 128) inkB++;
    }
    return { avg: diff / (a.length / 4) / 3, inkA, inkB };
  }, [bytes.toString('base64'), o2]);
  assert.ok(cmp.inkA > 50, '畫布有字 ' + cmp.inkA);
  assert.ok(Math.abs(cmp.inkA - cmp.inkB) / cmp.inkA < 0.15, `有字像素：畫布 ${cmp.inkA}、匯出 ${cmp.inkB}`);
  assert.ok(cmp.avg < 12, '平均差 ' + cmp.avg);
  assert.deepEqual(errors, []);
});

test('專案檔存了再開：漸層與弧度都保留', { skip }, async t => {
  const { page, errors } = await open(t);
  await page.click('#dzBgType [data-bg="radial"]');
  const sid = await add(page, 'shape:rect');
  await page.click('#dzF-fill-type [data-v="radial"]');
  await setInput(page, '#dzF-fill-r', 60);
  const tid = await add(page, 'text');
  await page.click('#dzF-color-type [data-v="linear"]');
  await setInput(page, '#dzF-arcNum', 120);
  const docA = await docJson(page);
  const { file } = await download(page, '#dzSaveBtn');
  const saved = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'qpt-dz-')), 'proj.json');
  fs.copyFileSync(file, saved);
  const b = await open(t);
  await b.page.setInputFiles('#dzOpenFile', saved);
  await b.page.waitForFunction(() => /已匯入/.test(document.getElementById('dzStatus').textContent));
  assert.equal(await docJson(b.page), docA);
  const s = await obj(b.page, sid), x = await obj(b.page, tid);
  assert.equal(s.fill.type, 'radial'); assert.equal(s.fill.r, 0.6);
  assert.equal(x.color.type, 'linear'); assert.equal(x.arc, 120);
  assert.equal((await curPage(b.page)).bg.type, 'radial');
  assert.deepEqual(errors, []);
  assert.deepEqual(b.errors, []);
});

test('390×844 手機：顏料編輯器與配色區不會撐出水平捲軸', { skip }, async t => {
  const { page, errors } = await open(t, { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, hasTouch: true, isMobile: true });
  await add(page, 'shape:rect');
  await page.click('#dzF-fill-type [data-v="radial"]');
  const m1 = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth, r: document.getElementById('dzF-fill-r').getBoundingClientRect().right }));
  assert.equal(m1.sw, m1.cw);
  assert.ok(m1.r <= m1.cw, '半徑滑桿在畫面內');
  await page.evaluate(() => QPTDesign.ui.select([]));
  await redDoc(page);
  const m2 = await page.evaluate(() => {
    const p = document.getElementById('dzPanel').getBoundingClientRect();
    const sw = [...document.querySelectorAll('#dzRecolor .dz-swatch')].map(e => e.getBoundingClientRect());
    return { sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth, inside: sw.every(r => r.left >= p.left && r.right <= p.right), n: sw.length, h: sw[0] && sw[0].height };
  });
  assert.equal(m2.sw, m2.cw);
  assert.ok(m2.n > 0 && m2.inside, '色票在面板內');
  assert.ok(m2.h >= 36, '色票夠大好點 ' + m2.h);
  assert.deepEqual(errors, []);
});

// ---- 滿版與全螢幕 ------------------------------------------------------------------------
test('滿版：設計分頁用滿視窗寬度、畫布撐到視窗底部；切到別的分頁就恢復', { skip }, async t => {
  const { page, errors } = await open(t, { viewport: { width: 1600, height: 1000 } });
  const m = await page.evaluate(() => {
    const a = document.getElementById('designApp').getBoundingClientRect();
    const s = document.getElementById('dzStage').getBoundingClientRect();
    const p = document.getElementById('dzPanel').getBoundingClientRect();
    return { full: document.documentElement.classList.contains('dz-full'), aw: a.width, sh: s.height, pBottom: p.bottom, docH: document.documentElement.scrollHeight, vh: innerHeight };
  });
  assert.ok(m.full);
  assert.ok(m.aw >= 1600 - 40, '寬度接近視窗寬 ' + m.aw);
  assert.ok(m.sh > 600, '畫布夠高 ' + m.sh);
  assert.ok(m.pBottom <= m.vh, '面板不超出視窗');
  assert.ok(m.docH <= m.vh + 2, '不需要整頁捲動 ' + m.docH);
  await page.click('#funcWatermarkBtn');
  assert.equal(await page.evaluate(() => document.documentElement.classList.contains('dz-full')), false);
  assert.deepEqual(errors, []);
});

test('全螢幕按鈕：呼叫 requestFullscreen；不支援時顯示繁中說明', { skip }, async t => {
  const { page, errors } = await open(t);
  await page.evaluate(() => { window.__fs = 0; document.documentElement.requestFullscreen = () => { window.__fs++; return Promise.resolve(); }; });
  await page.click('#dzFullBtn');
  assert.equal(await page.evaluate(() => window.__fs), 1);
  await page.evaluate(() => { document.documentElement.requestFullscreen = undefined; });
  await page.click('#dzFullBtn');
  assert.match(await page.textContent('#dzStatus'), /全螢幕/);
  assert.deepEqual(errors, []);
});

// =====================================================================================
// 圖層面板、群組、剪裁遮色片、混合模式、多邊形與星形（規格 2026-11-03-design-layers-group-clip-blend-shapes 第 6 節）
// =====================================================================================
// 用 core 直接加物件（不經過工具列），回傳 id 陣列
const addRaw = (page, list) => page.evaluate(list => {
  const U = QPTDesign.ui, C = QPTDesign.core, H = U.state.history, pid = U.state.pageId;
  const ids = list.map(o => H.run('t', d => C.addObject(d, pid, o)).id);
  U.rerender();
  return ids;
}, list);
const twoShapes = page => addRaw(page, [
  { type: 'shape', kind: 'rect', x: 100, y: 100, w: 200, h: 200, fill: '#ff0000' },
  { type: 'shape', kind: 'ellipse', x: 500, y: 500, w: 200, h: 200, fill: '#0000ff' },
]);
const groups = async page => (await curPage(page)).groups;
const selSorted = async page => (await S(page)).sel.slice().sort();
const inGroup = page => page.evaluate(() => QPTDesign.ui.state.inGroup || null);
const press = async (page, key) => { await page.locator('#dzStage').hover(); await page.keyboard.press(key); await flush(page); };
const WHITE = [255, 255, 255, 255];
const isWhite = p => p[0] > 245 && p[1] > 245 && p[2] > 245;
// 圖層面板的列（由上到下）：物件列回 id，群組標題回 'g:<gid>'
const layerRows = page => page.$$eval('#dzLayers .dz-layer', rs => rs.map(r => r.dataset.gid ? 'g:' + r.dataset.gid : r.dataset.id));
const rowBox = (page, sel) => page.locator(sel).boundingBox();
async function dragRow(page, fromSel, toSel, where = 'above') {
  const a = await rowBox(page, fromSel), b = await rowBox(page, toSel);
  const ty = where === 'above' ? b.y + 3 : b.y + b.height - 3;
  await page.mouse.move(a.x + a.width / 2, a.y + a.height / 2);
  await page.mouse.down();
  await page.mouse.move(a.x + a.width / 2, (a.y + ty) / 2, { steps: 4 });
  await page.mouse.move(b.x + b.width / 2, ty, { steps: 4 });
  await page.mouse.up();
  await flush(page);
}

test('多邊形與星形：工具列加入 400×400 置中、面板改邊數與內徑畫面跟著變；Ctrl+Z 還原', { skip }, async t => {
  const { page, errors } = await open(t);
  const pid = await add(page, 'shape:polygon');
  let o = await obj(page, pid);
  assert.deepEqual([o.kind, o.w, o.h, o.x, o.y, o.sides], ['polygon', 400, 400, 340, 340, 6]);
  assert.equal(await page.inputValue('#dzF-kind'), 'polygon');
  assert.equal(await page.locator('#dzF-kind option[value="star"]').count(), 1);
  assert.equal(await page.inputValue('#dzF-sides'), '6');
  assert.equal(await page.locator('#dzF-radius').count(), 0, '多邊形沒有圓角');
  assert.ok(!isWhite(await px(page, 540, 540)), '中心有顏色');
  assert.ok(isWhite(await px(page, 350, 540)), '六邊形左側凹進去的地方是背景');
  await setInput(page, '#dzF-sides', 4);
  await flush(page);
  assert.equal((await obj(page, pid)).sides, 4);
  assert.ok(!isWhite(await px(page, 350, 540)), '改成菱形後左頂點附近有顏色');
  await page.click('#dzUndoBtn');
  await flush(page);
  assert.equal((await obj(page, pid)).sides, 6);
  assert.ok(isWhite(await px(page, 350, 540)));
  await page.evaluate(id => QPTDesign.ui.select([id]), pid);
  await press(page, 'Delete');
  const sid = await add(page, 'shape:star');
  o = await obj(page, sid);
  assert.deepEqual([o.kind, o.w, o.h, o.points, o.inner], ['star', 400, 400, 5, 0.5]);
  assert.equal(await page.inputValue('#dzF-points'), '5');
  assert.equal(await page.inputValue('#dzF-inner'), '50');
  assert.ok(!isWhite(await px(page, 540, 540)), '星形中心有顏色');
  assert.ok(isWhite(await px(page, 628, 419)), '兩個尖角之間的凹處是背景');
  await setInput(page, '#dzF-inner', 95);
  await flush(page);
  assert.equal((await obj(page, sid)).inner, 0.95);
  assert.ok(!isWhite(await px(page, 628, 419)), '內徑變大後凹處被填滿');
  await setInput(page, '#dzF-points', 8);
  assert.equal((await obj(page, sid)).points, 8);
  await page.click('#dzUndoBtn');
  await page.click('#dzUndoBtn');
  o = await obj(page, sid);
  assert.deepEqual([o.points, o.inner], [5, 0.5]);
  // 種類下拉：矩形改成星形
  const rid = await add(page, 'shape:rect');
  await page.selectOption('#dzF-kind', 'star');
  o = await obj(page, rid);
  assert.deepEqual([o.kind, o.points, o.inner], ['star', 5, 0.5]);
  assert.deepEqual(errors, []);
});

test('群組：Ctrl+G 後點一個選到整組、拖曳一起移動；Ctrl+Shift+G 取消群組；每步 Ctrl+Z 還原', { skip }, async t => {
  const { page, errors } = await open(t);
  const [a, b] = await twoShapes(page);
  await page.evaluate(ids => QPTDesign.ui.select(ids), [a, b]);
  await press(page, 'Control+g');
  assert.equal((await obj(page, a)).groupId, 'g1');
  assert.equal((await obj(page, b)).groupId, 'g1');
  assert.deepEqual(await groups(page), { g1: { name: '群組 1', clip: false } });
  assert.equal(await page.inputValue('#dzGroupName'), '群組 1');
  assert.equal(await page.locator('#dzUngroupBtn').count(), 1);
  assert.equal(await page.locator('#dzReleaseBtn').count(), 0, '一般群組沒有釋放遮色片');
  const blank = await toScreen(page, 1000, 30);
  await page.mouse.click(blank.x, blank.y);
  assert.deepEqual((await S(page)).sel, []);
  await page.mouse.click(...Object.values(await center(page, a)));
  assert.deepEqual(await selSorted(page), [a, b].sort(), '點一個成員選到整組');
  const c = await center(page, a), z = (await S(page)).zoom;
  await drag(page, c, { x: c.x + 100 * z, y: c.y + 50 * z });
  const [a1, b1] = [await obj(page, a), await obj(page, b)];
  assert.ok(Math.abs(a1.x - 200) <= 2 && Math.abs(a1.y - 150) <= 2, `a 移到 ${a1.x},${a1.y}`);
  assert.ok(Math.abs((b1.x - 500) - (a1.x - 100)) < 1e-6 && Math.abs((b1.y - 500) - (a1.y - 100)) < 1e-6, '兩個一起移動');
  await press(page, 'Control+z');
  assert.equal((await obj(page, a)).x, 100);
  assert.equal((await obj(page, b)).x, 500);
  await page.evaluate(ids => QPTDesign.ui.select(ids), [a, b]);
  await press(page, 'Control+Shift+g');
  assert.equal((await obj(page, a)).groupId, undefined);
  assert.deepEqual(await groups(page), {});
  await press(page, 'Control+z');
  assert.equal((await obj(page, a)).groupId, 'g1');
  await press(page, 'Control+z');
  assert.deepEqual(await groups(page), {}, '再按一次回到群組前');
  // 面板的「群組」按鈕
  await page.evaluate(ids => QPTDesign.ui.select(ids), [a, b]);
  await page.click('#dzGroupBtn');
  assert.equal((await obj(page, b)).groupId, 'g1');
  await page.fill('#dzGroupName', '標誌');
  await page.locator('#dzGroupName').press('Enter');
  assert.equal((await groups(page)).g1.name, '標誌');
  await page.click('#dzUngroupBtn');
  assert.deepEqual(await groups(page), {});
  assert.deepEqual(errors, []);
});

test('整組變形：角把手等比縮放兩個都變大、旋轉把手一起轉（Shift 每 15°）；各一次 Ctrl+Z', { skip }, async t => {
  const { page, errors } = await open(t);
  const [a, b] = await twoShapes(page);
  await page.evaluate(ids => QPTDesign.ui.select(ids), [a, b]);
  await press(page, 'Control+g');
  assert.equal(await page.locator('.dz-group-box .dz-handle').count(), 4, '只有 4 個角把手');
  assert.equal(await page.locator('.dz-group-box .dz-rot').count(), 1);
  assert.equal(await page.locator('.dz-sel .dz-handle').count(), 0, '成員自己沒有把手');
  const se = await page.locator('.dz-group-box .dz-handle[data-gh="se"]').boundingBox();
  const to = await toScreen(page, 850, 850);
  await drag(page, { x: se.x + se.width / 2, y: se.y + se.height / 2 }, to);
  let [a1, b1] = [await obj(page, a), await obj(page, b)];
  assert.ok(a1.w > 230 && b1.w > 230, `兩個都放大 ${a1.w} ${b1.w}`);
  assert.ok(Math.abs(a1.w - b1.w) < 1e-6 && Math.abs(a1.w - a1.h) < 1e-6, '等比');
  assert.ok(Math.abs(a1.x - 100) < 1 && Math.abs(a1.y - 100) < 1, '對角（左上）不動');
  await press(page, 'Control+z');
  assert.equal((await obj(page, a)).w, 200);
  assert.equal((await obj(page, b)).w, 200);
  // 旋轉：拖到中心正右方，Shift → 90°
  const rot = await page.locator('.dz-group-box .dz-rot').boundingBox();
  const right = await toScreen(page, 950, 395);
  await drag(page, { x: rot.x + rot.width / 2, y: rot.y + rot.height / 2 }, right, { shift: true });
  [a1, b1] = [await obj(page, a), await obj(page, b)];
  assert.equal(a1.rot, 90); assert.equal(b1.rot, 90);
  assert.ok(Math.abs(a1.x + 100 - 600) < 1 && Math.abs(a1.y + 100 - 200) < 1, `a 的中心繞群組中心轉到 (600,200)：${a1.x + 100},${a1.y + 100}`);
  await press(page, 'Control+z');
  assert.equal((await obj(page, a)).rot, 0);
  assert.equal((await obj(page, a)).x, 100);
  // 沒有群組的多選也一樣有整組把手
  await press(page, 'Control+Shift+g');
  await page.evaluate(ids => QPTDesign.ui.select(ids), [a, b]);
  await flush(page);
  assert.equal(await page.locator('.dz-group-box .dz-handle').count(), 4);
  assert.deepEqual(errors, []);
});

test('雙擊進入群組內選取：只移動一個成員；Esc 離開；文字要再雙擊才編輯', { skip }, async t => {
  const { page, errors } = await open(t);
  const [a, b] = await twoShapes(page);
  const [tx] = await addRaw(page, [{ type: 'text', text: '群組字', x: 600, y: 150, w: 300, h: 100 }]);
  await page.evaluate(ids => QPTDesign.ui.select(ids), [a, b, tx]);
  await press(page, 'Control+g');
  const c = await center(page, a);
  await page.mouse.dblclick(c.x, c.y);
  await flush(page);
  assert.deepEqual((await S(page)).sel, [a], '只選到 a');
  assert.equal(await inGroup(page), 'g1');
  const z = (await S(page)).zoom;
  await drag(page, c, { x: c.x + 80 * z, y: c.y });
  assert.ok(Math.abs((await obj(page, a)).x - 180) <= 2, 'a 移動了');
  assert.equal((await obj(page, b)).x, 500, 'b 沒動');
  // 群組內選取時點另一個成員：只選它
  await page.mouse.click(...Object.values(await center(page, b)));
  assert.deepEqual((await S(page)).sel, [b]);
  await press(page, 'Escape');
  assert.equal(await inGroup(page), null);
  assert.deepEqual(await selSorted(page), [a, b, tx].sort(), 'Esc 回到整組');
  await press(page, 'Control+z');
  assert.equal((await obj(page, a)).x, 100);
  // 文字：第一次雙擊進入群組內選取，第二次才編輯
  const ct = await center(page, tx);
  await page.mouse.dblclick(ct.x, ct.y);
  await flush(page);
  assert.deepEqual((await S(page)).sel, [tx]);
  assert.equal(await page.locator('.dz-text-edit').count(), 0, '還沒進入文字編輯');
  await page.mouse.dblclick(ct.x, ct.y);
  await flush(page);
  assert.equal(await page.locator('.dz-text-edit').count(), 1, '再雙擊一次才編輯');
  await page.keyboard.press('Escape');
  // 點空白離開群組內選取
  const blank = await toScreen(page, 1000, 1000);
  await page.mouse.click(blank.x, blank.y);
  assert.equal(await inGroup(page), null);
  assert.deepEqual(errors, []);
});

test('剪裁遮色片：Ctrl+7 建立後框外被裁掉、外框不畫且選取時有虛線輪廓；Ctrl+Alt+7／按鈕釋放；Ctrl+Z 還原', { skip }, async t => {
  const { page, errors } = await open(t);
  const file = await makeImage(page, 400, 300);
  await page.setInputFiles('#dzImgFile', file);
  await page.waitForFunction(() => QPTDesign.ui.state.doc.pages[0].objects.some(o => o.type === 'image'));
  const img = (await curPage(page)).objects[0].id;
  const [el_] = await addRaw(page, [{ type: 'shape', kind: 'ellipse', x: 440, y: 440, w: 200, h: 200, fill: '#00c000' }]);
  await flush(page);
  const corner = [230, 310], inside = [500, 540];
  assert.ok((await px(page, ...corner))[0] > 200, '剪裁前角落是圖片的紅');
  assert.ok((await px(page, ...inside))[1] > 150, '剪裁前圓內是外框的綠');
  await page.evaluate(ids => QPTDesign.ui.select(ids), [img, el_]);
  await press(page, 'Control+7');
  assert.deepEqual(await groups(page), { g1: { name: '剪裁群組 1', clip: true } });
  assert.ok(isWhite(await px(page, ...corner)), '框外被裁掉');
  const p1 = await px(page, ...inside);
  assert.ok(p1[0] > 200 && p1[1] < 60, '圓內是圖片、外框的填色沒畫出 ' + p1);
  assert.equal(await page.locator('.dz-clip-outline').count(), 1, '外框的虛線輪廓');
  assert.equal(await page.locator('#dzReleaseBtn').count(), 1);
  await press(page, 'Control+Alt+7');
  assert.deepEqual(await groups(page), {});
  assert.ok((await px(page, ...inside))[1] > 150, '釋放後外框恢復可見');
  assert.equal(await page.locator('.dz-clip-outline').count(), 0);
  await press(page, 'Control+z');
  assert.equal((await groups(page)).g1.clip, true);
  assert.ok(isWhite(await px(page, ...corner)));
  await page.evaluate(ids => QPTDesign.ui.select(ids), [img, el_]);
  await page.click('#dzReleaseBtn');
  assert.deepEqual(await groups(page), {});
  assert.ok((await px(page, ...corner))[0] > 200);
  await press(page, 'Control+z');
  await press(page, 'Control+z');
  assert.deepEqual(await groups(page), {}, '回到建立前');
  // 按鈕建立；最上層不是形狀時顯示原因
  await page.evaluate(ids => QPTDesign.ui.select(ids), [img, el_]);
  await page.click('#dzClipBtn');
  assert.equal((await groups(page)).g1.clip, true);
  await press(page, 'Control+z');
  await page.evaluate(id => QPTDesign.ui.select([id]), el_);
  await press(page, '[');   // 把外框移到圖片下面
  await page.evaluate(ids => QPTDesign.ui.select(ids), [img, el_]);
  await page.click('#dzClipBtn');
  assert.match(await status(page), /最上層的形狀/);
  assert.deepEqual(await groups(page), {});
  assert.deepEqual(errors, []);
});

test('混合模式：選「色彩增值」後像素改變、馬賽克沒有這個欄位；Ctrl+Z 還原', { skip }, async t => {
  const { page, errors } = await open(t);
  const [, g] = await addRaw(page, [
    { type: 'shape', kind: 'rect', x: 100, y: 100, w: 400, h: 400, fill: '#ff0000' },
    { type: 'shape', kind: 'rect', x: 300, y: 300, w: 400, h: 400, fill: '#00ff00' },
  ]);
  await page.evaluate(id => QPTDesign.ui.select([id]), g);
  await flush(page);
  assert.deepEqual((await px(page, 400, 400)).slice(0, 3), [0, 255, 0]);
  const opts = await page.$$eval('#dzF-blend option', os => os.map(o => o.textContent));
  assert.deepEqual(opts, ['正常', '色彩增值', '濾色', '覆蓋', '變暗', '變亮', '加亮顏色', '加深顏色', '實光', '柔光', '差異化', '排除', '色相', '飽和度', '顏色', '明度']);
  await page.selectOption('#dzF-blend', { label: '色彩增值' });
  await flush(page);
  assert.equal((await obj(page, g)).blend, 'multiply');
  assert.deepEqual((await px(page, 400, 400)).slice(0, 3), [0, 0, 0], '紅疊綠變黑');
  assert.deepEqual((await px(page, 600, 600)).slice(0, 3), [0, 255, 0], '沒疊到的地方不變');
  await page.click('#dzUndoBtn');
  await flush(page);
  assert.deepEqual((await px(page, 400, 400)).slice(0, 3), [0, 255, 0]);
  // 混合模式在透明度下面
  const [op, bl] = await Promise.all(['#dzF-opacity', '#dzF-blend'].map(s => page.locator(s).boundingBox()));
  assert.ok(bl.y > op.y, '混合模式在透明度下面');
  await add(page, 'mosaic');
  assert.equal(await page.locator('#dzF-blend').count(), 0, '馬賽克沒有混合模式');
  assert.deepEqual(errors, []);
});

test('圖層面板：列的順序相反、點列選取、眼睛隱藏、鎖頭鎖定、雙擊改名、拖曳排序；每步 Ctrl+Z 還原', { skip }, async t => {
  const { page, errors } = await open(t);
  const [a, b, c] = await addRaw(page, [
    { type: 'shape', kind: 'rect', x: 100, y: 100, w: 200, h: 200, fill: '#ff0000' },
    { type: 'shape', kind: 'ellipse', x: 500, y: 500, w: 200, h: 200, fill: '#0000ff' },
    { type: 'text', text: '一二三四五六七八九十十一', x: 100, y: 800, w: 900, h: 100 },
  ]);
  assert.equal(await page.isVisible('#dzLayers'), false, '預設在屬性分頁');
  await page.click('#dzTabLayers');
  assert.equal(await page.getAttribute('#dzTabLayers', 'aria-selected'), 'true');
  assert.equal(await page.isVisible('#dzPanelBody'), false);
  assert.deepEqual(await layerRows(page), [c, b, a], '最上層排第一');
  const names = await page.$$eval('#dzLayers .dz-layer-name', ns => ns.map(n => n.textContent));
  assert.deepEqual(names, ['文字：一二三四五六七八九十', '橢圓', '矩形']);
  // 點列選取、畫布選取同步反白
  await page.click(`#dzLayers .dz-layer[data-id="${b}"] .dz-layer-name`);
  assert.deepEqual((await S(page)).sel, [b]);
  await flush(page);   // 反白在下一個畫格的重畫裡更新（drawLayers），先等一格再檢查
  assert.ok(await page.locator(`#dzLayers .dz-layer[data-id="${b}"]`).evaluate(e => e.classList.contains('sel')));
  await page.click(`#dzLayers .dz-layer[data-id="${a}"] .dz-layer-name`, { modifiers: ['Shift'] });
  assert.deepEqual(await selSorted(page), [a, b].sort(), 'Shift 加選');
  await page.evaluate(id => QPTDesign.ui.select([id]), c);
  await flush(page);
  assert.ok(await page.locator(`#dzLayers .dz-layer[data-id="${c}"]`).evaluate(e => e.classList.contains('sel')));
  assert.ok(!(await page.locator(`#dzLayers .dz-layer[data-id="${b}"]`).evaluate(e => e.classList.contains('sel'))));
  // 眼睛
  await page.click(`#dzLayers .dz-layer[data-id="${a}"] .dz-layer-eye`);
  assert.equal((await obj(page, a)).hidden, true);
  await flush(page);
  assert.ok(isWhite(await px(page, 200, 200)), '隱藏後不畫');
  await press(page, 'Control+z');
  assert.equal((await obj(page, a)).hidden, false);
  // 鎖頭：鎖定後拖不動
  await page.click(`#dzLayers .dz-layer[data-id="${b}"] .dz-layer-lock`);
  assert.equal((await obj(page, b)).locked, true);
  const cb = await center(page, b);
  await drag(page, cb, { x: cb.x + 80, y: cb.y + 40 });
  assert.equal((await obj(page, b)).x, 500, '鎖定的物件拖不動');
  await press(page, 'Control+z');
  assert.equal((await obj(page, b)).locked, false);
  // 雙擊改名：Enter 確認、Esc 取消
  await page.dblclick(`#dzLayers .dz-layer[data-id="${a}"] .dz-layer-name`);
  await page.fill('#dzLayers .dz-layer-rename', '背景方塊');
  await page.keyboard.press('Enter');
  assert.equal((await obj(page, a)).name, '背景方塊');
  assert.equal(await page.textContent(`#dzLayers .dz-layer[data-id="${a}"] .dz-layer-name`), '背景方塊');
  await page.dblclick(`#dzLayers .dz-layer[data-id="${a}"] .dz-layer-name`);
  await page.fill('#dzLayers .dz-layer-rename', '不要這個');
  await page.keyboard.press('Escape');
  assert.equal((await obj(page, a)).name, '背景方塊', 'Esc 取消');
  await press(page, 'Control+z');
  assert.ok(!(await obj(page, a)).name, '復原名稱');
  // 拖曳排序：把最下層的 a 拖到最上面
  await dragRow(page, `#dzLayers .dz-layer[data-id="${a}"]`, `#dzLayers .dz-layer[data-id="${c}"]`, 'above');
  assert.deepEqual((await curPage(page)).objects.map(o => o.id), [b, c, a]);
  assert.deepEqual(await layerRows(page), [a, c, b]);
  await press(page, 'Control+z');
  assert.deepEqual((await curPage(page)).objects.map(o => o.id), [a, b, c]);
  assert.deepEqual(errors, []);
});

test('圖層面板：群組標題可收合、眼睛鎖頭套用整組、成員只能在組內拖曳、標題拖曳整組', { skip }, async t => {
  const { page, errors } = await open(t);
  const [a, b, c] = await addRaw(page, [
    { type: 'shape', kind: 'rect', x: 100, y: 100, w: 200, h: 200, fill: '#ff0000' },
    { type: 'shape', kind: 'rect', x: 400, y: 100, w: 200, h: 200, fill: '#00ff00' },
    { type: 'shape', kind: 'ellipse', x: 700, y: 100, w: 200, h: 200, fill: '#0000ff' },
  ]);
  await page.evaluate(ids => QPTDesign.ui.select(ids), [b, c]);
  await press(page, 'Control+7');   // b 是圖、c 是外框
  await page.click('#dzTabLayers');
  assert.deepEqual(await layerRows(page), ['g:g1', c, b, a]);
  const head = '#dzLayers .dz-layer[data-gid="g1"]';
  assert.match(await page.textContent(head), /剪裁群組 1/);
  assert.match(await page.textContent(head), /剪裁/);
  assert.match(await page.textContent(`#dzLayers .dz-layer[data-id="${c}"]`), /外框/);
  assert.ok(await page.locator(`#dzLayers .dz-layer[data-id="${c}"]`).evaluate(e => e.classList.contains('is-member')));
  // 點標題選整組；點成員列＝群組內選取
  await page.click(`${head} .dz-layer-name`);
  assert.deepEqual(await selSorted(page), [b, c].sort());
  assert.ok(await page.locator(head).evaluate(e => e.classList.contains('sel')));
  await page.click(`#dzLayers .dz-layer[data-id="${b}"] .dz-layer-name`);
  assert.deepEqual((await S(page)).sel, [b]);
  assert.equal(await inGroup(page), 'g1');
  // 收合
  await page.click(`${head} .dz-layer-caret`);
  assert.deepEqual(await layerRows(page), ['g:g1', a]);
  await page.click(`${head} .dz-layer-caret`);
  assert.deepEqual(await layerRows(page), ['g:g1', c, b, a]);
  // 群組眼睛、鎖頭套用整組，一筆復原
  await page.click(`${head} .dz-layer-eye`);
  assert.equal((await obj(page, b)).hidden, true); assert.equal((await obj(page, c)).hidden, true);
  await press(page, 'Control+z');
  assert.equal((await obj(page, b)).hidden, false); assert.equal((await obj(page, c)).hidden, false);
  await page.click(`${head} .dz-layer-lock`);
  assert.equal((await obj(page, b)).locked, true); assert.equal((await obj(page, c)).locked, true);
  await press(page, 'Control+z');
  assert.equal((await obj(page, c)).locked, false);
  // 群組改名
  await page.dblclick(`${head} .dz-layer-name`);
  await page.fill('#dzLayers .dz-layer-rename', '照片框');
  await page.keyboard.press('Enter');
  assert.equal((await groups(page)).g1.name, '照片框');
  await press(page, 'Control+z');
  assert.equal((await groups(page)).g1.name, '剪裁群組 1');
  // 成員拖出群組：不動並顯示原因
  const before = (await curPage(page)).objects.map(o => o.id);
  await dragRow(page, `#dzLayers .dz-layer[data-id="${b}"]`, `#dzLayers .dz-layer[data-id="${a}"]`, 'below');
  assert.deepEqual((await curPage(page)).objects.map(o => o.id), before, '成員沒有離開群組');
  assert.match(await status(page), /群組/);
  assert.equal((await obj(page, b)).groupId, 'g1');
  // 一般群組裡的成員可以在組內換順序
  await page.evaluate(ids => QPTDesign.ui.select(ids), [b, c]);
  await press(page, 'Control+Alt+7');
  await page.evaluate(ids => QPTDesign.ui.select(ids), [b, c]);
  await press(page, 'Control+g');
  await dragRow(page, `#dzLayers .dz-layer[data-id="${b}"]`, `#dzLayers .dz-layer[data-id="${c}"]`, 'above');
  assert.deepEqual((await curPage(page)).objects.map(o => o.id), [a, c, b], '組內換順序');
  await press(page, 'Control+z');
  assert.deepEqual((await curPage(page)).objects.map(o => o.id), [a, b, c]);
  // 拖群組標題：整組移到最下面
  await dragRow(page, '#dzLayers .dz-layer[data-gid="g1"]', `#dzLayers .dz-layer[data-id="${a}"]`, 'below');
  assert.deepEqual((await curPage(page)).objects.map(o => o.id), [b, c, a], '整組移到 a 下面');
  await press(page, 'Control+z');
  assert.deepEqual((await curPage(page)).objects.map(o => o.id), [a, b, c]);
  // 記住分頁
  assert.equal(await page.evaluate(() => localStorage.getItem('qpt.design.panelTab')), 'layers');
  await page.reload();
  await page.click('#toolsClose').catch(() => {});
  await page.click('#funcDesignBtn');
  await page.waitForFunction(() => window.QPTDesign && QPTDesign.ui && QPTDesign.ui.state.zoom > 0);
  assert.equal(await page.isVisible('#dzLayers'), true, '重新載入後還在圖層分頁');
  assert.deepEqual(errors, []);
});

test('複製貼上整組：貼上的是新群組、選到整組', { skip }, async t => {
  const { page, errors } = await open(t);
  const [a, b] = await twoShapes(page);
  await page.evaluate(ids => QPTDesign.ui.select(ids), [a, b]);
  await press(page, 'Control+g');
  await press(page, 'Control+c');
  await press(page, 'Control+v');
  await page.waitForFunction(() => QPTDesign.ui.state.doc.pages[0].objects.length === 4);
  const objs = (await curPage(page)).objects;
  assert.deepEqual(objs.map(o => o.groupId), ['g1', 'g1', 'g2', 'g2']);
  assert.deepEqual(Object.keys(await groups(page)).sort(), ['g1', 'g2']);
  assert.deepEqual(await selSorted(page), [objs[2].id, objs[3].id].sort());
  // 群組內只複製一個：貼上的不帶群組
  await page.evaluate(id => QPTDesign.ui.select([id]), a);
  await press(page, 'Control+c');
  await press(page, 'Control+v');
  await page.waitForFunction(() => QPTDesign.ui.state.doc.pages[0].objects.length === 5);
  assert.equal((await curPage(page)).objects[4].groupId, undefined);
  assert.deepEqual(errors, []);
});

test('專案檔存了再開：群組、剪裁、混合模式、多邊形和星形都保留', { skip }, async t => {
  const { page, errors } = await open(t);
  const [p, s, r, e] = await addRaw(page, [
    { type: 'shape', kind: 'polygon', sides: 5, x: 100, y: 100, w: 300, h: 300 },
    { type: 'shape', kind: 'star', points: 7, inner: 0.3, x: 500, y: 100, w: 300, h: 300, blend: 'screen' },
    { type: 'shape', kind: 'rect', x: 100, y: 600, w: 300, h: 300, fill: '#ff0000' },
    { type: 'shape', kind: 'ellipse', x: 150, y: 650, w: 200, h: 200 },
  ]);
  await page.evaluate(ids => QPTDesign.ui.select(ids), [p, s]);
  await press(page, 'Control+g');
  await page.evaluate(ids => QPTDesign.ui.select(ids), [r, e]);
  await press(page, 'Control+7');
  const docA = await docJson(page);
  const { file } = await download(page, '#dzSaveBtn');
  const saved = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'qpt-dz-')), 'proj.json');
  fs.copyFileSync(file, saved);
  const b2 = await open(t);
  await b2.page.setInputFiles('#dzOpenFile', saved);
  await b2.page.waitForFunction(() => /已匯入/.test(document.getElementById('dzStatus').textContent));
  assert.equal(await docJson(b2.page), docA);
  const pg = await curPage(b2.page);
  assert.deepEqual(pg.groups, { g1: { name: '群組 1', clip: false }, g2: { name: '剪裁群組 2', clip: true } });
  assert.equal((await obj(b2.page, s)).blend, 'screen');
  assert.equal((await obj(b2.page, p)).sides, 5);
  assert.deepEqual(errors, []);
  assert.deepEqual(b2.errors, []);
});

test('390×844 手機：屬性｜圖層分頁可以切換、圖層列不撐出水平捲軸', { skip }, async t => {
  const { page, errors } = await open(t, { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, hasTouch: true, isMobile: true });
  const [a, b] = await twoShapes(page);
  await page.evaluate(ids => QPTDesign.ui.select(ids), [a, b]);
  await page.evaluate(() => document.getElementById('dzGroupBtn').click());
  await page.tap('#dzTabLayers');
  await flush(page);
  const m = await page.evaluate(() => {
    const p = document.getElementById('dzPanel').getBoundingClientRect();
    const rows = [...document.querySelectorAll('#dzLayers .dz-layer')].map(e => e.getBoundingClientRect());
    const eye = document.querySelector('#dzLayers .dz-layer-eye').getBoundingClientRect();
    return { sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth, n: rows.length,
      inside: rows.every(r => r.left >= p.left && r.right <= p.right + 0.5), eyeH: eye.height, eyeW: eye.width };
  });
  assert.equal(m.sw, m.cw);
  assert.equal(m.n, 3);
  assert.ok(m.inside, '列在面板內');
  assert.ok(m.eyeH >= 32 && m.eyeW >= 32, `眼睛按鈕夠大 ${m.eyeW}×${m.eyeH}`);
  await page.tap(`#dzLayers .dz-layer[data-id="${a}"] .dz-layer-name`);
  assert.deepEqual((await S(page)).sel, [a]);
  await page.tap('#dzTabProps');
  assert.equal(await page.isVisible('#dzPanelBody'), true);
  assert.deepEqual(errors, []);
});

// 網頁版「圖片套版」的貼圖與馬賽克（stickers.js 的批次模式：每一組各自一份）在真的 Chromium 裡的測試：載入 index.html（file://）。
// 需要 playwright：NODE_PATH=<有 playwright 的 node_modules> node --test test/stickersweb.e2e.js
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

const SLOT = '#batchFxSlot';
const BOXES = '#batchPreview .fx-item';

async function open(t, opts = {}) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, ...opts });
  t.after(() => ctx.close());
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
  await page.route('https://**', r => r.abort());
  await page.goto(PAGE);
  await page.click('#toolsClose').catch(() => {});
  return { ctx, page, errors };
}

// 一張底下 4 條直條的測試圖（直條邊緣用來判斷馬賽克有沒有糊掉）
async function makeBg(page) {
  const png = await page.evaluate(() => { const c = document.createElement('canvas'); c.width = 1200; c.height = 1200; const x = c.getContext('2d');
    x.fillStyle = '#2a6'; x.fillRect(0, 0, 1200, 1200); x.fillStyle = '#fff';
    for (let i = 0; i < 12; i++) x.fillRect(i * 100, 0, 50, 1200);
    return c.toDataURL('image/png').split(',')[1]; });
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'qpt-')), 'bg.png');
  fs.writeFileSync(file, Buffer.from(png, 'base64'));
  return file;
}
async function loadBg(page, file, title = '標題') {
  await page.setInputFiles('#layoutApp .batch-item-block input[type=file]', file);
  await page.fill('#layoutApp .batch-item-block textarea', title);
  await page.waitForFunction(() => { const c = document.getElementById('batchCanvas'); return c.getContext('2d').getImageData(540, 100, 1, 1).data[3] > 0; });
}
const canvasSig = page => page.evaluate(() => { const c = document.getElementById('batchCanvas'); const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data; let h = 0; for (let i = 0; i < d.length; i += 997) h = (h * 31 + d[i]) | 0; return h; });
const rect = (page, sel) => page.locator(sel).first().boundingBox();

test('網頁版預覽下方有「貼圖與馬賽克」一排（馬賽克、抽色＋7 張貼圖）；還沒有背景時停用，載入背景後可以按', { skip }, async t => {
  const { page, errors } = await open(t);
  assert.equal(await page.locator(`${SLOT} .fx-tile`).count(), 9);
  assert.equal(await page.locator(`${SLOT} .fx-sticker-tile img`).count(), 7);
  assert.equal(await page.locator(`${SLOT} .fx-tile:disabled`).count(), 9, '沒有背景時全部停用');
  await loadBg(page, await makeBg(page));
  assert.equal(await page.locator(`${SLOT} .fx-tile:disabled`).count(), 0);
  // 位置：在預覽畫布下方
  const [c, bar] = await Promise.all([rect(page, '#batchCanvas'), rect(page, SLOT)]);
  assert.ok(bar.y >= c.y + c.height - 1, '貼圖列在畫布下面');
  assert.deepEqual(errors, []);
});

test('貼圖：點一下加到預覽、拖曳移動、滾輪縮放、× 與 Delete 刪除；畫面（畫布）跟著變', { skip }, async t => {
  const { page, errors } = await open(t);
  await loadBg(page, await makeBg(page));
  const s0 = await canvasSig(page);
  await page.click(`${SLOT} .fx-sticker-tile >> nth=1`);
  await page.waitForSelector(BOXES);
  const s1 = await canvasSig(page);
  assert.notEqual(s1, s0, '畫布上畫出了貼圖');
  assert.match(await page.locator(`${SLOT} .fx-count`).textContent(), /已加 1 個/);
  // 拖曳
  let b = await rect(page, BOXES);
  await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2);
  await page.mouse.down(); await page.mouse.move(b.x + b.width / 2 + 60, b.y + b.height / 2 + 40, { steps: 5 }); await page.mouse.up();
  let b2 = await rect(page, BOXES);
  assert.ok(Math.abs(b2.x - b.x - 60) < 3 && Math.abs(b2.y - b.y - 40) < 3, `拖曳位移 (${b2.x - b.x}, ${b2.y - b.y})`);
  assert.notEqual(await canvasSig(page), s1);
  // 滾輪縮放（在貼圖上）：放大
  await page.mouse.move(b2.x + b2.width / 2, b2.y + b2.height / 2);
  await page.mouse.wheel(0, -300);
  const b3 = await rect(page, BOXES);
  assert.ok(b3.width > b2.width * 1.2, `放大 ${b2.width} → ${b3.width}`);
  assert.ok(Math.abs(b3.width / b3.height - b2.width / b2.height) < 0.02, '等比');
  // × 刪除
  await page.click(`${BOXES} .fx-del`);
  assert.equal(await page.locator(BOXES).count(), 0);
  assert.equal(await canvasSig(page), s0, '刪掉後畫布回到沒有貼圖');
  // Delete 鍵刪除
  await page.click(`${SLOT} .fx-sticker-tile >> nth=0`);
  await page.waitForSelector(BOXES);
  await page.keyboard.press('Delete');
  assert.equal(await page.locator(BOXES).count(), 0);
  assert.deepEqual(errors, []);
});

test('馬賽克：方塊像素，只糊框裡的照片', { skip }, async t => {
  const { page, errors } = await open(t);
  await loadBg(page, await makeBg(page), '');
  const edges = () => page.evaluate(() => { const c = document.getElementById('batchCanvas'); const d = c.getContext('2d').getImageData(0, 540, c.width, 1).data;
    let n = 0; for (let i = 4; i < d.length; i += 4) if (Math.abs(d[i] - d[i - 4]) > 90) n++; return n; });
  const before = await edges();
  assert.ok(before > 8, `原圖有直條（${before}）`);
  await page.click(`${SLOT} .fx-mosaic-tile`);
  await page.waitForSelector(BOXES);
  assert.ok(await edges() < before, '框住的那一段直條被糊掉了');
  // 畫面上的方框在畫布範圍內
  const [c, b] = await Promise.all([rect(page, '#batchCanvas'), rect(page, BOXES)]);
  assert.ok(b.x >= c.x && b.y >= c.y && b.x + b.width <= c.x + c.width + 1 && b.y + b.height <= c.y + c.height + 1);
  assert.deepEqual(errors, []);
});

test('每一組各自一份：換到別組看不到上一組的貼圖，換回來還在', { skip }, async t => {
  const { page, errors } = await open(t);
  const bg = await makeBg(page);
  await loadBg(page, bg, '第一組');
  await page.click(`${SLOT} .fx-sticker-tile >> nth=2`);
  await page.waitForSelector(BOXES);
  const withSticker = await canvasSig(page);
  await page.click('#addBatchItemBtn');
  assert.equal(await page.locator(BOXES).count(), 0, '新的一組沒有貼圖');
  assert.equal(await page.locator(`${SLOT} .fx-tile:disabled`).count(), 9, '新的一組還沒有背景，貼圖列停用');
  await page.setInputFiles('#layoutApp .batch-item-block input[type=file]', bg);
  await page.fill('#layoutApp .batch-item-block textarea', '第二組');
  await page.waitForTimeout(500);
  assert.equal(await page.locator(BOXES).count(), 0);
  assert.equal(await page.locator(`${SLOT} .fx-count`).textContent(), '');
  await page.click('#batchThumbs > *:nth-child(1)').catch(async () => { await page.locator('.batch-item-row').first().click(); });
  await page.waitForSelector(BOXES);
  assert.equal(await page.locator(BOXES).count(), 1, '換回第一組，貼圖還在');
  assert.equal(await canvasSig(page), withSticker);
  assert.deepEqual(errors, []);
});

test('按「完成」存下來的圖包含貼圖與馬賽克；完成後再改貼圖，這一組變回未完成', { skip }, async t => {
  const { page, errors } = await open(t);
  await loadBg(page, await makeBg(page), '有貼圖的標題');
  await page.click(`${SLOT} .fx-sticker-tile >> nth=3`);
  await page.click(`${SLOT} .fx-mosaic-tile`);
  await page.waitForSelector(BOXES);
  const live = await page.evaluate(() => document.getElementById('batchCanvas').toDataURL('image/png'));
  await page.click('#layoutApp .batch-item-block button:text-is("完成")');
  await page.waitForFunction(() => batchItems[0] && batchItems[0].done && batchItems[0].resultDataUrl);
  const saved = await page.evaluate(async () => {
    const img = new Image(); img.src = batchItems[0].resultDataUrl; await img.decode();
    const c = document.createElement('canvas'); c.width = c.height = 1080; c.getContext('2d').drawImage(img, 0, 0, 1080, 1080);
    return c.toDataURL('image/png');
  });
  // 存下來的圖和預覽畫的一樣（都含貼圖與馬賽克）
  const same = await page.evaluate(async ([a, b]) => {
    const load = u => new Promise(r => { const i = new Image(); i.onload = () => r(i); i.src = u; });
    const [ia, ib] = await Promise.all([load(a), load(b)]);
    const draw = i => { const c = document.createElement('canvas'); c.width = c.height = 270; const x = c.getContext('2d'); x.drawImage(i, 0, 0, 270, 270); return x.getImageData(0, 0, 270, 270).data; };
    const da = draw(ia), db = draw(ib); let diff = 0; for (let i = 0; i < da.length; i += 4) diff += Math.abs(da[i] - db[i]);
    return diff / (da.length / 4);
  }, [live, saved]);
  assert.ok(same < 6, `完成後存的圖與預覽一致（平均差 ${same}）`);
  // 完成後（會收合）再點縮圖打開，改貼圖 → 變回未完成
  await page.click('#batchThumbs > *:nth-child(1)');
  await page.waitForSelector(BOXES);
  assert.equal(await page.evaluate(() => batchItems[0].done), true);
  await page.locator(BOXES).last().click({ position: { x: 20, y: 20 } });   // 最上面那個（馬賽克）
  await page.keyboard.press('Delete');
  assert.equal(await page.evaluate(() => batchItems[0].done), false, '改了貼圖，要重新按完成');
  assert.deepEqual(errors, []);
});

// 取畫布上某個區塊的「最大飽和度」（max-min），用來判斷是不是單色
const satIn = (page, x, y, w, h) => page.evaluate(([x, y, w, h]) => { const c = document.getElementById('batchCanvas'); const d = c.getContext('2d').getImageData(x, y, w, h).data;
  let m = 0; for (let i = 0; i < d.length; i += 4) m = Math.max(m, Math.max(d[i], d[i + 1], d[i + 2]) - Math.min(d[i], d[i + 1], d[i + 2])); return m; }, [x, y, w, h]);

test('抽色：照片抽色成單色，再按一次還原；每一組各自一份；完成後存下來的圖也是抽色；邊框仍是彩色', { skip }, async t => {
  const { page, errors } = await open(t);
  const bg = await makeBg(page);
  await loadBg(page, bg, '抽色測試');   // 要有標題才能按「完成」
  const gray = `${SLOT} .fx-gray-tile`;
  const colored = await canvasSig(page);
  assert.ok(await satIn(page, 300, 300, 400, 200) > 60, '原圖是綠色的');
  assert.equal(await page.getAttribute(gray, 'aria-pressed'), 'false');
  await page.click(gray);
  assert.equal(await page.getAttribute(gray, 'aria-pressed'), 'true');
  assert.ok(await page.locator(gray).evaluate(el => el.classList.contains('on')));
  assert.ok(await satIn(page, 300, 300, 400, 200) <= 2, '照片變成單色');
  assert.ok(await satIn(page, 0, 0, 1080, 1080) > 40, '角落的邊框不受影響，仍是彩色');
  assert.match(await page.locator(`${SLOT} .fx-count`).textContent(), /抽色/);
  assert.equal(await page.locator(BOXES).count(), 0, '抽色不是方框，不占貼圖數量');
  // 抽色時還能照常加貼圖
  await page.click(`${SLOT} .fx-sticker-tile >> nth=0`);
  await page.waitForSelector(BOXES);
  assert.ok(await satIn(page, 20, 400, 150, 200) <= 2, '加了貼圖後照片仍是抽色（貼圖本身是彩色，取樣避開貼圖）');
  await page.keyboard.press('Delete');
  // 第二組不受影響
  await page.click('#addBatchItemBtn');
  assert.equal(await page.getAttribute(gray, 'aria-pressed'), 'false', '新的一組沒開抽色');
  await page.setInputFiles('#layoutApp .batch-item-block input[type=file]', bg);
  await page.fill('#layoutApp .batch-item-block textarea', '');
  await page.waitForTimeout(500);
  assert.ok(await satIn(page, 300, 300, 400, 200) > 60, '第二組仍是彩色');
  await page.click('#batchThumbs > *:nth-child(1)');
  await page.waitForFunction(() => document.querySelector('#batchFxSlot .fx-gray-tile').getAttribute('aria-pressed') === 'true');
  assert.ok(await satIn(page, 300, 300, 400, 200) <= 2, '換回第一組仍是抽色');
  // 完成後存下來的圖
  await page.click('#layoutApp .batch-item-block button:text-is("完成")');
  await page.waitForFunction(() => batchItems[0] && batchItems[0].done && batchItems[0].resultDataUrl);
  const savedSat = await page.evaluate(async () => {
    const img = new Image(); img.src = batchItems[0].resultDataUrl; await img.decode();
    const c = document.createElement('canvas'); c.width = c.height = 1080; const x = c.getContext('2d'); x.drawImage(img, 0, 0, 1080, 1080);
    const d = x.getImageData(300, 300, 400, 200).data; let m = 0;
    for (let i = 0; i < d.length; i += 4) m = Math.max(m, Math.max(d[i], d[i + 1], d[i + 2]) - Math.min(d[i], d[i + 1], d[i + 2])); return m; });
  assert.ok(savedSat <= 2, `完成後存的圖是抽色（${savedSat}）`);
  // 完成後再關掉抽色 → 變回未完成，畫面還原
  await page.click('#batchThumbs > *:nth-child(1)');
  await page.waitForFunction(() => document.querySelector('#batchFxSlot .fx-gray-tile:not(:disabled)'));
  await page.click(gray);
  assert.equal(await page.evaluate(() => batchItems[0].done), false, '改了抽色，要重新按完成');
  assert.equal(await canvasSig(page), colored, '關掉抽色後回到原本的彩色畫面');
  assert.deepEqual(errors, []);
});

test('抽色：還沒有背景時按不了', { skip }, async t => {
  const { page, errors } = await open(t);
  assert.equal(await page.locator(`${SLOT} .fx-gray-tile`).isDisabled(), true);
  assert.deepEqual(errors, []);
});

test('觸控：兩指在貼圖上張開會放大、單指拖曳會移動', { skip }, async t => {
  const { ctx, page, errors } = await open(t, { hasTouch: true });
  await loadBg(page, await makeBg(page));
  await page.click(`${SLOT} .fx-sticker-tile >> nth=1`);
  await page.waitForSelector(BOXES);
  const b = await rect(page, BOXES);
  const cx = b.x + b.width / 2, cy = b.y + b.height / 2;
  const cdp = await ctx.newCDPSession(page);
  const touch = (type, pts) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: pts.map((q, i) => ({ x: q[0], y: q[1], id: i })) });
  await touch('touchStart', [[cx - 20, cy], [cx + 20, cy]]);
  for (let i = 1; i <= 8; i++) await touch('touchMove', [[cx - 20 - i * 6, cy], [cx + 20 + i * 6, cy]]);
  await touch('touchEnd', []);
  const b2 = await rect(page, BOXES);
  assert.ok(b2.width > b.width * 1.5, `雙指放大 ${b.width} → ${b2.width}`);
  const cx2 = b2.x + b2.width / 2, cy2 = b2.y + b2.height / 2;
  await touch('touchStart', [[cx2, cy2]]);
  for (let i = 1; i <= 6; i++) await touch('touchMove', [[cx2 + i * 8, cy2]]);
  await touch('touchEnd', []);
  const b3 = await rect(page, BOXES);
  assert.ok(b3.x > b2.x + 30, `單指拖曳 ${b2.x} → ${b3.x}`);
  assert.deepEqual(errors, []);
});

test('側邊欄（sidepanel.html）不受影響：沒有網頁版的貼圖列容器', () => {
  assert.ok(!/batchFxSlot/.test(fs.readFileSync(path.join(__dirname, '..', 'sidepanel.html'), 'utf8')));
  assert.ok(/batchFxSlot/.test(fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8')));
});

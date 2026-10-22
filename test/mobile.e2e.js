// 網頁版手機版面（390px 寬、觸控）在真的 Chromium 裡的測試：載入 index.html（file://），
// 驗證：每個分頁都不橫向捲動、單欄、圖片套版的預覽在最上面、沒有滑鼠的裝置顯示觸控說明、預覽可以雙指縮放與單指拖曳。
// 需要 playwright：NODE_PATH=<有 playwright 的 node_modules> node --test test/mobile.e2e.js
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

let chromium = null;
try { ({ chromium } = require('playwright')); } catch (e) { /* 沒裝 playwright：整檔略過 */ }
const skip = chromium ? false : '找不到 playwright（設 NODE_PATH 指到有 playwright 的 node_modules）';

const PAGE = 'file://' + path.join(__dirname, '..', 'index.html');
const TABS = ['funcLayoutBtn', 'funcWatermarkBtn', 'funcCollageBtn', 'funcResizeBtn', 'funcEditBtn'];

let browser;
test.before(async () => { if (chromium) browser = await chromium.launch(); });
test.after(async () => { if (browser) await browser.close(); });

async function open(t, opts = {}) {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, hasTouch: true, isMobile: true, ...opts });
  t.after(() => ctx.close());
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.route('https://**', r => r.abort());
  await page.goto(PAGE);
  await page.click('#toolsClose').catch(() => {});   // 載入時「其他工具」會自己打開
  return { ctx, page, errors };
}

test('手機寬度：每個功能分頁都不會橫向捲動（頁面寬度 = 螢幕寬度）', { skip }, async t => {
  const { page, errors } = await open(t);
  for (const id of TABS) {
    await page.click('#' + id);
    const w = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth }));
    assert.equal(w.sw, w.cw, `${id}：scrollWidth ${w.sw} ≠ clientWidth ${w.cw}`);
    assert.equal(w.cw, 390, `${id}：版面寬度被撐開成 ${w.cw}`);
  }
  assert.deepEqual(errors, []);
});

test('手機寬度：版面收成單欄，圖片套版的預覽在欄位上方；上排功能切換單排、字不換行', { skip }, async t => {
  const { page } = await open(t);
  const m = await page.evaluate(() => {
    const card = document.querySelector('#layoutApp > .card').getBoundingClientRect();
    const prev = document.querySelector('#layoutApp > .preview-col').getBoundingClientRect();
    const btns = [...document.querySelectorAll('.func-btn')].map(b => b.getBoundingClientRect());
    return { cols: getComputedStyle(document.getElementById('layoutApp')).gridTemplateColumns.split(' ').length,
      prevBottom: prev.bottom, cardTop: card.top, cardW: card.width, prevW: prev.width,
      sameRow: new Set(btns.map(b => Math.round(b.top))).size, h: btns.map(b => Math.round(b.height)) };
  });
  assert.equal(m.cols, 1);
  assert.ok(m.prevBottom <= m.cardTop + 1, '預覽在欄位上方');
  assert.ok(m.cardW > 300 && m.prevW > 300, '兩塊都接近滿寬');
  assert.equal(m.sameRow, 1, '五個功能按鈕在同一排');
  assert.ok(Math.max(...m.h) < 50, '按鈕高度正常（字沒有直排換行）');
});

test('手機寬度：輸入框字級至少 16px（iOS 不會因為點進去而放大頁面）', { skip }, async t => {
  const { page } = await open(t);
  for (const id of ['funcLayoutBtn', 'funcWatermarkBtn', 'funcResizeBtn']) {
    await page.click('#' + id);
    const small = await page.evaluate(() => [...document.querySelectorAll('input, textarea, select')]
      .filter(e => e.offsetParent && !/^(range|checkbox|radio|color|file|hidden)$/.test(e.type) && !e.classList.contains('title-overlay'))
      .map(e => ({ id: e.id || e.className, fs: parseFloat(getComputedStyle(e).fontSize) })).filter(x => x.fs < 16));
    assert.deepEqual(small, [], `${id}：有字級小於 16px 的輸入框`);
  }
});

test('沒有滑鼠的裝置：提示不寫 Ctrl+V／滾輪，改成雙指縮放；桌面版維持原本的說明', { skip }, async t => {
  const { page } = await open(t);
  const hint = await page.locator('#batchPreview .preview-hint').innerText();
  assert.match(hint, /雙指縮放/);
  assert.ok(!/Ctrl\+V|滾輪/.test(hint), hint);
  const desk = await browser.newContext({ viewport: { width: 1280, height: 860 } });
  t.after(() => desk.close());
  const dp = await desk.newPage();
  await dp.route('https://**', r => r.abort());
  await dp.goto(PAGE);
  const dh = await dp.locator('#batchPreview .preview-hint').innerText().catch(async () => (await dp.locator('#batchPreview .preview-hint').textContent()));
  assert.match(dh, /Ctrl\+V/);
  assert.match(dh, /滾輪縮放/);
});

test('預覽上雙指張開會放大、單指拖曳會平移（觸控）', { skip }, async t => {
  const { ctx, page, errors } = await open(t);
  const png = await page.evaluate(() => { const c = document.createElement('canvas'); c.width = 1600; c.height = 1200; const x = c.getContext('2d');
    const g = x.createLinearGradient(0, 0, 1600, 1200); g.addColorStop(0, '#f6a'); g.addColorStop(1, '#4af'); x.fillStyle = g; x.fillRect(0, 0, 1600, 1200);
    x.fillStyle = '#fff'; for (let i = 0; i < 8; i++) x.fillRect(100 + i * 180, 300, 80, 600);
    return c.toDataURL('image/png').split(',')[1]; });
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'qpt-')), 'bg.png');
  fs.writeFileSync(file, Buffer.from(png, 'base64'));
  await page.setInputFiles('#layoutApp .batch-item-block input[type=file]', file);
  await page.waitForFunction(() => { const c = document.getElementById('batchCanvas'); return c.offsetParent && c.getContext('2d').getImageData(540, 300, 1, 1).data[3] > 0; });
  const sel = '#batchCanvas';
  await page.locator(sel).scrollIntoViewIfNeeded();
  const box = await page.locator(sel).boundingBox();
  const cx = box.x + box.width / 2, cy = box.y + box.height / 2;
  const cdp = await ctx.newCDPSession(page);
  const touch = (type, pts) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: pts.map((q, i) => ({ x: q[0], y: q[1], id: i })) });
  const zoom = () => page.evaluate(() => { const c = document.getElementById('batchCanvas'); const x = c.getContext('2d'); const d = x.getImageData(0, 400, c.width, 1).data;
    let edges = 0; for (let i = 4; i < d.length; i += 4) if (Math.abs(d[i] - d[i - 4]) > 90) edges++; return edges; });
  const sig = () => page.evaluate(() => { const c = document.getElementById('batchCanvas'); const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data; let h = 0; for (let i = 0; i < d.length; i += 1009) h = (h * 31 + d[i]) | 0; return h; });
  const edges0 = await zoom();
  await touch('touchStart', [[cx - 30, cy], [cx + 30, cy]]);
  for (let i = 1; i <= 8; i++) await touch('touchMove', [[cx - 30 - i * 12, cy], [cx + 30 + i * 12, cy]]);
  await touch('touchEnd', []);
  const edges1 = await zoom();
  assert.ok(edges1 < edges0, `放大後同一條橫線上的直條邊緣變少（${edges0} → ${edges1}）`);
  const s1 = await sig();
  await touch('touchStart', [[cx, cy]]);
  for (let i = 1; i <= 6; i++) await touch('touchMove', [[cx - i * 10, cy]]);
  await touch('touchEnd', []);
  assert.notEqual(await sig(), s1, '單指拖曳後畫面有移動');
  // 雙指縮小回到原尺寸（最小是 1 倍，不會比原圖更小）
  await touch('touchStart', [[cx - 150, cy], [cx + 150, cy]]);
  for (let i = 1; i <= 10; i++) await touch('touchMove', [[cx - 150 + i * 14, cy], [cx + 150 - i * 14, cy]]);
  await touch('touchEnd', []);
  const edges2 = await zoom();
  assert.ok(edges2 > edges1, `雙指縮小後邊緣變多（${edges1} → ${edges2}），而且不會比 1 倍更小（${edges2} ≤ ${edges0 + 2}）`);
  assert.ok(edges2 <= edges0 + 2);
  assert.deepEqual(errors, []);
});

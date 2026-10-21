// 側邊欄在真的 Chromium 裡的流程測試：載入 sidepanel.html，用假的 chrome.* 和假的文章／圖片，
// 驗證「熱門新聞庫送來的暫存 → 自動快速產圖」。真的擴充功能環境（sidePanel.open 是否被允許等）仍需 Chrome 實機。
// 需要 playwright：NODE_PATH=<有 playwright 的 node_modules> node --test test/sidepanel.e2e.js
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const zlib = require('node:zlib');

let chromium = null;
try { ({ chromium } = require('playwright')); } catch (e) { /* 沒裝 playwright：整檔略過 */ }
const skip = chromium ? false : '找不到 playwright（設 NODE_PATH 指到有 playwright 的 node_modules）';

const PAGE = 'file://' + path.join(__dirname, '..', 'sidepanel.html');
const ARTICLE_A = 'https://news.tvbs.com.tw/local/1111111';
const ARTICLE_B = 'https://news.tvbs.com.tw/local/2222222';

function png(w, h) {   // 純色 PNG
  const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  const crc = buf => { let c = 0xffffffff; for (const b of buf) c = crcTable[(c ^ b) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const c = Buffer.alloc(4); c.writeUInt32BE(crc(td));
    return Buffer.concat([len, td, c]);
  };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  const row = Buffer.concat([Buffer.from([0]), Buffer.alloc(w * 3, 0x80)]);
  const raw = Buffer.concat(Array.from({ length: h }, () => row));
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
const article = (title, caption, tag) => `<html><head><meta property="og:title" content="${title}"><meta property="og:image" content="https://img.tvbs.com.tw/a.png"></head>
<body><article><h1>${title}</h1><img src="https://img.tvbs.com.tw/a.png"><figcaption>${caption}</figcaption><a href="/tag/${tag}">#${tag}</a></article></body></html>`;

let browser;
test.before(async () => { if (chromium) browser = await chromium.launch(); });
test.after(async () => { if (browser) await browser.close(); });

async function open(t, { badge = '' } = {}) {
  const ctx = await browser.newContext({ viewport: { width: 420, height: 900 } });
  t.after(() => ctx.close());
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  const downloads = [];
  page.on('download', d => downloads.push(d.suggestedFilename()));
  await page.route('https://api.github.com/**', r => r.abort());
  await page.route('https://raw.githubusercontent.com/**', r => r.abort());
  await page.route(ARTICLE_A, r => r.fulfill({ contentType: 'text/html; charset=utf-8', body: article('文章A原標題', '（圖／A攝影）', 'A標籤') }));
  await page.route(ARTICLE_B, r => r.abort());   // B 文章抓不到
  await page.route('https://img.tvbs.com.tw/**', r => r.fulfill({ contentType: 'image/png', body: png(1200, 900) }));
  await page.addInitScript(initial => {
    const store = { session: {}, local: {} };
    const listeners = [];
    const action = { badge: initial };
    window.__store = store;
    window.__action = action;
    window.chrome = {
      runtime: { id: 'me', getManifest: () => ({ name: '圖片套版產生器', version: '4.50' }), getURL: p => p, reload() {} },
      tabs: { create() {} },
      action: { getBadgeText: async () => action.badge, setBadgeText: async o => { action.badge = o.text; }, setBadgeBackgroundColor: async () => {} },
      storage: {
        local: { get: async () => ({}), set: async () => {} },
        session: {
          get: async k => ({ [k]: store.session[k] }),
          remove: async k => { delete store.session[k]; },
          set: async o => {
            const changes = {};
            for (const k of Object.keys(o)) { changes[k] = { newValue: o[k] }; store.session[k] = o[k]; }
            listeners.forEach(fn => fn(changes, 'session'));
          },
        },
        onChanged: { addListener: fn => listeners.push(fn) },
      },
    };
  }, badge);
  await page.goto(PAGE);
  return { page, errors, downloads };
}
const send = (page, pending) => page.evaluate(p => chrome.storage.session.set({ pending: p }), pending);
const status = page => page.locator('#qfStatus').textContent();
const waitStatus = (page, re) => page.waitForFunction(r => new RegExp(r).test(document.getElementById('qfStatus').textContent), re.source, { timeout: 15000 });

test('收到暫存：網址帶入、圖上標題照改標的分行、複製框是單行標題、停在「直接下載」、沒有自動下載', { skip }, async t => {
  const { page, errors, downloads } = await open(t);
  await send(page, { url: ARTICLE_A, title: '定期保養的 5 個重點\n第 3 項最多人漏掉', at: Date.now() });
  await waitStatus(page, /完成/);
  assert.equal(await page.inputValue('#qfUrl'), ARTICLE_A);
  assert.equal(await page.inputValue('#title'), '定期保養的 5 個重點\n第 3 項最多人漏掉');
  const copy = (await page.inputValue('#qfCopyText')).split('\n');
  assert.equal(copy[0], '【定期保養的 5 個重點 第 3 項最多人漏掉】');
  assert.match(copy[1], /A攝影/);
  assert.equal((await page.locator('#qfBtn').textContent()).trim(), '直接下載');
  assert.equal(await page.evaluate(() => 'pending' in window.__store.session), false);
  assert.deepEqual(downloads, []);
  assert.deepEqual(errors, []);
});

test('暫存超過 2 分鐘 → 丟棄，不產圖', { skip }, async t => {
  const { page } = await open(t);
  await send(page, { url: ARTICLE_A, title: '舊的', at: Date.now() - 120000 });
  await page.waitForFunction(() => !('pending' in window.__store.session));
  assert.equal(await page.inputValue('#qfUrl'), '');
  assert.equal(await status(page), '');
});

test('圖示：只清自己留的藍色「1」，不動更新提示的「新」', { skip }, async t => {
  for (const [badge, expected] of [['1', ''], ['新', '新']]) {
    const { page } = await open(t, { badge });
    await send(page, { url: ARTICLE_A, title: '標題', at: Date.now() });
    await waitStatus(page, /完成/);
    assert.equal(await page.evaluate(() => window.__action.badge), expected, badge);
  }
});

test('改標送來但文章抓失敗：複製框不會混著上一篇的圖說和 hashtag', { skip }, async t => {
  const { page } = await open(t);
  await page.fill('#qfUrl', ARTICLE_A);
  await page.click('#qfBtn');
  await waitStatus(page, /完成/);
  assert.match(await page.inputValue('#qfCopyText'), /A攝影/);
  await send(page, { url: ARTICLE_B, title: 'B的改標', at: Date.now() });
  await waitStatus(page, /連線失敗|讀取/);
  assert.equal(await page.inputValue('#title'), 'B的改標');
  assert.equal(await page.inputValue('#qfCopyText'), '【B的改標】');
});

// ---- 「圖片背景／純色背景」開關在「快速產圖」標題列右邊；提示氣泡在按鈕下方 ---------------------------
const box = (page, sel) => page.locator(sel).boundingBox();
const overlap = (a, b) => a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;

test('開關固定在「快速產圖」標題列右邊（和標題同一列、靠右），編輯卡片裡不再有一份', { skip }, async t => {
  const { page, errors } = await open(t);
  assert.equal(await page.locator('#quickFill .sp-card-head .bg-toggle').count(), 1);
  assert.equal(await page.locator('#singleBgPicker .bg-toggle').count(), 0);
  const h2 = await box(page, '#quickFill h2'), tg = await box(page, '#quickFill .bg-toggle'), card = await box(page, '#quickFill');
  assert.ok(Math.abs((tg.y + tg.height / 2) - (h2.y + h2.height / 2)) < 6, '和標題在同一列');
  assert.ok(tg.x > h2.x + h2.width, '在標題右邊');
  assert.ok(card.x + card.width - (tg.x + tg.width) < 24, '靠右');
  assert.ok(tg.width < 175 && tg.height < 36, `縮小版：${tg.width}×${tg.height}`);
  assert.deepEqual(errors, []);
});

test('開關照常運作：切到純色背景 → 出現色票；選色、全部清除後回到圖片背景', { skip }, async t => {
  const { page } = await open(t);
  const btn = name => page.locator('#qfBgSlot .bg-toggle button', { hasText: name });
  assert.match(await btn('圖片背景').getAttribute('class'), /active/);
  await btn('純色背景').click();
  assert.match(await btn('純色背景').getAttribute('class'), /active/);
  await page.waitForSelector('#qfColorStrip .color-swatches', { state: 'visible' });
  await page.locator('#qfColorStrip .color-swatch').first().click();
  await page.click('#resetBtn');
  await page.click('#confirmOkBtn');   // 「全部清除」要先確認
  await page.waitForFunction(() => document.querySelector('#qfBgSlot .bg-toggle button.active').textContent === '圖片背景');
  assert.equal(await page.locator('#qfColorStrip').isVisible(), false);
});

test('編輯卡片的「背景」：只剩圖片縮圖，沒載入圖片時整塊隱藏（純色背景時也不顯示）', { skip }, async t => {
  const { page } = await open(t);
  const field = page.locator('#singleFields .field:has(#singleBgPicker)');
  assert.equal(await field.isVisible(), false);
  await page.locator('#qfBgSlot .bg-toggle button', { hasText: '純色背景' }).click();
  await page.waitForSelector('#qfColorStrip', { state: 'visible' });
  assert.equal(await field.isVisible(), false);
  await page.setInputFiles('#singleBgPicker input[type=file]', { name: 'bg.png', mimeType: 'image/png', buffer: png(40, 40) });
  await field.waitFor({ state: 'visible' });
  assert.equal(await page.locator('#singleBgPicker .batch-item-thumb').isVisible(), true);
  assert.equal(await page.locator('#qfColorStrip').isVisible(), false);   // 放了圖片就回到圖片背景，色票收起來
  await page.click('#resetBtn');
  await page.click('#confirmOkBtn');
  await page.waitForFunction(() => document.querySelector('#singleFields .field:has(#singleBgPicker)').hidden);
});

test('按「純色背景」隨機挑一個現有色票來用；已在純色背景時再按不會重抽', { skip }, async t => {
  const { page } = await open(t);
  const btn = page.locator('#qfBgSlot .bg-toggle button', { hasText: '純色背景' });
  const selected = () => page.evaluate(() => { const s = document.querySelector('#qfColorStrip .color-swatch.selected'); return s && s.title; });
  const seen = new Set();
  for (let i = 0; i < 12; i++) {
    await btn.click();
    await page.waitForSelector('#qfColorStrip .color-swatch.selected');
    const c = await selected();
    assert.match(c, /^#[0-9a-f]{6}$/i);
    assert.ok(await page.locator(`#qfColorStrip .color-swatch[title="${c}"]`).count() === 1, '挑到的是現有色票');
    assert.equal(await selected(), c);
    await btn.click();                       // 已在純色背景：不重抽
    assert.equal(await selected(), c);
    seen.add(c);
    await page.locator('#qfBgSlot .bg-toggle button', { hasText: '圖片背景' }).click();
    await page.waitForFunction(() => document.getElementById('qfColorStrip').hidden);
  }
  assert.ok(seen.size > 1, `12 次只抽到 ${seen.size} 種顏色，看起來不是隨機`);
});

test('色票在「快速產圖」下方彈出一排、可左右滑動；全部色票都在裡面，氣泡不蓋到色票', { skip }, async t => {
  const { page, errors } = await open(t);
  await page.locator('#qfBgSlot .bg-toggle button', { hasText: '純色背景' }).click();
  await page.waitForSelector('#qfColorStrip', { state: 'visible' });
  const strip = '#qfColorStrip .color-swatches';
  const card = await box(page, '#quickFill'), row = await box(page, '#quickFill .qf-row'), st = await box(page, '#qfColorStrip');
  assert.ok(st.y >= row.y + row.height, '在輸入列下方');
  assert.ok(st.y + st.height <= card.y + card.height + 1, '在快速產圖卡片裡');
  const tip = await box(page, '#qfTip');
  assert.ok(!overlap(tip, await box(page, strip)), '提示氣泡不蓋到色票');
  const m = await page.evaluate(sel => { const e = document.querySelector(sel); return { n: e.children.length, sw: e.scrollWidth, cw: e.clientWidth, oy: getComputedStyle(e).overflowX, wrap: getComputedStyle(e).flexWrap }; }, strip);
  assert.equal(m.n, 19);
  assert.equal(m.wrap, 'nowrap');
  assert.equal(m.oy, 'auto');
  assert.ok(m.sw > m.cw, '放不下，要能左右滑');
  // 滑動：滾輪、捲到最左／最右都能點到對應的色票
  await page.waitForTimeout(500);
  await page.locator(strip).hover();
  await page.mouse.wheel(0, -2000);
  await page.waitForFunction(s => document.querySelector(s).scrollLeft === 0, strip);
  await page.mouse.wheel(0, 2000);
  await page.waitForFunction(s => { const e = document.querySelector(s); return e.scrollLeft >= e.scrollWidth - e.clientWidth - 1; }, strip);
  const last = page.locator('#qfColorStrip .color-swatch').last();
  await last.click();
  assert.match(await last.getAttribute('class'), /selected/);
  assert.deepEqual(errors, []);
});

test('提示氣泡在按鈕下方：「貼上連結按Enter可以產圖」不蓋到開關；貼上網址後消失', { skip }, async t => {
  const { page } = await open(t);
  const tip = await box(page, '#qfTip'), btn = await box(page, '#qfBtn'), tg = await box(page, '#quickFill .bg-toggle'), card = await box(page, '#quickFill');
  assert.ok(tip.y >= btn.y + btn.height, '氣泡在按鈕下方');
  assert.ok(!overlap(tip, tg), '不蓋到開關');
  assert.ok(tip.y + tip.height <= card.y + card.height, '氣泡沒有超出卡片');
  assert.ok(tip.x + tip.width <= card.x + card.width + 1 && tip.x >= card.x, '氣泡沒有超出卡片左右');
  await page.fill('#qfUrl', 'https://news.tvbs.com.tw/local/9');
  assert.equal(await page.locator('#qfTip').isHidden(), true);
});

test('產圖完成後「確認直接下載？」也在按鈕下方，不蓋到開關', { skip }, async t => {
  const { page, errors } = await open(t);
  await page.fill('#qfUrl', ARTICLE_A);
  await page.press('#qfUrl', 'Enter');
  await waitStatus(page, /完成/);
  await page.waitForSelector('#qfConfirmTip', { state: 'visible' });
  await page.waitForTimeout(300);   // 等氣泡的彈出動畫
  const tip = await box(page, '#qfConfirmTip'), btn = await box(page, '#qfBtn'), tg = await box(page, '#quickFill .bg-toggle'), card = await box(page, '#quickFill');
  assert.ok(tip.y >= btn.y + btn.height, '氣泡在按鈕下方');
  assert.ok(!overlap(tip, tg), '不蓋到開關');
  assert.ok(tip.y + tip.height <= card.y + card.height, '氣泡沒有超出卡片');
  assert.deepEqual(errors, []);
});

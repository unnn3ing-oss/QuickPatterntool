// 網頁版左邊編輯區「快速產圖」輸入框的流程測試（測試環境見 test/web-harness.js）。
// 文章與圖片用 Playwright 攔截（回傳假的 TVBS 文章與 PNG），由「真的」背景程式（poster.js）代抓、網頁這邊用「真的」quickfill.js 解析，
// 所以抓取的限制、斷行規則、挑圖都是真的程式在跑。真的擴充功能環境仍需 Chrome 實機。
// 需要 playwright：NODE_PATH=<有 playwright 的 node_modules> node --test test/qfweb.e2e.js
const test = require('node:test');
const assert = require('node:assert/strict');
const zlib = require('node:zlib');
const { openWeb } = require('./web-harness');

let chromium = null;
try { ({ chromium } = require('playwright')); } catch (e) { /* 沒裝 playwright：整檔略過 */ }
const skip = chromium ? false : '找不到 playwright（設 NODE_PATH 指到有 playwright 的 node_modules）';

const ART_URL = 'https://news.tvbs.com.tw/local/1111111';
const TITLE = '少年霸凌案狂燒！中壢武和宮主道歉喊冤：我兒子沒打人';
const CORS = { 'access-control-allow-origin': '*' };

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
const article = ({ images = ['https://img.tvbs.com.tw/good.png'], og } = {}) => `<html><head><meta property="og:title" content="${TITLE}">
${og ? `<meta property="og:image" content="${og}">` : ''}</head><body><article><h1>${TITLE}</h1>
${images.map(u => `<img src="${u}">`).join('')}<figcaption>（圖／TVBS）</figcaption>
<a href="/tag/霸凌">#霸凌</a><a href="/tag/宮廟">#宮廟</a><a href="/tag/張善政">#張善政</a></article></body></html>`;

let browser;
test.before(async () => { if (chromium) browser = await chromium.launch(); });
test.after(async () => { if (browser) await browser.close(); });

// imgs：{ 檔名: { status, w, h, type } }；回傳記錄所有請求的 log
async function open(t, { html, imgs = { 'good.png': { w: 1200, h: 900 } }, withExtension = true } = {}) {
  const log = { article: [], image: [], other: [] };
  const routes = async page => {
    await page.route('https://news.tvbs.com.tw/**', r => { log.article.push(r.request().url()); return r.fulfill({ contentType: 'text/html; charset=utf-8', headers: CORS, body: html || article() }); });
    await page.route('https://img.tvbs.com.tw/**', r => {
      const name = new URL(r.request().url()).pathname.slice(1);
      log.image.push(name);
      const spec = imgs[name];
      if (!spec) return r.fulfill({ status: 404, headers: CORS, body: 'nope' });
      if (spec.type) return r.fulfill({ contentType: spec.type, headers: CORS, body: '<html>not an image</html>' });
      return r.fulfill({ contentType: 'image/png', headers: CORS, body: png(spec.w, spec.h) });
    });
    page_other(page, log);
  };
  const r = await openWeb(browser, t, { withExtension, routes });
  await r.page.waitForSelector('.qfw-input');
  return Object.assign(r, { log });
}
function page_other(page, log) { page.on('request', req => { const u = new URL(req.url()); if (!/^(unnn3ing-oss\.github\.io|news\.tvbs\.com\.tw|img\.tvbs\.com\.tw)$/.test(u.hostname)) log.other.push(req.url()); }); }
const status = page => page.locator('.qfw-status').textContent();
const waitDone = (page, re = /完成/) => page.waitForFunction(r => new RegExp(r).test((document.querySelector('.qfw-status') || {}).textContent || ''), re.source, { timeout: 20000 });
const run = async (page, url = ART_URL) => { await page.fill('.qfw-input', url); await page.press('.qfw-input', 'Enter'); };

test('輸入框在「下載／完成」那一列和「新聞／娛樂」之間，很小（一行高）', { skip }, async t => {
  const { page, errors } = await open(t);
  const kids = await page.evaluate(() => [...document.querySelector('.batch-item-block').children].map(c => c.className.split(' ')[0]));
  assert.deepEqual(kids.slice(0, 3), ['batch-item-head', 'qfw-row', 'bg-toggle']);
  const box = await page.locator('.qfw-input').boundingBox();
  assert.ok(box.height <= 36, `輸入框高度 ${box.height}`);
  assert.match(await page.locator('.qfw-input').getAttribute('placeholder'), /Enter/);
  assert.deepEqual(errors, []);
});

test('貼上網址按 Enter：標題依規則斷行帶進卡片、首圖放進背景、完成訊息；只抓文章 1 次、圖片 1 張', { skip }, async t => {
  const { page, log, errors } = await open(t);
  await run(page);
  await waitDone(page, /完成：標題、圖片都帶入了/);
  const lines = await page.locator('.batch-item-block textarea').inputValue();
  assert.equal(lines, await page.evaluate(t0 => QuickFill.breakTitle(t0).join('\n'), TITLE));
  assert.ok(lines.split('\n').length >= 2);
  assert.equal(await page.evaluate(() => batchItems[0].bg.type), 'image');
  assert.equal(await page.evaluate(() => batchItems[0].bg.image.naturalWidth), 1200);
  assert.equal(await page.evaluate(() => batchItems[0].title), lines);   // 卡片自己的資料也跟著更新（不只是框裡的字）
  assert.match(await page.locator('.batch-item-block .hint').first().textContent().catch(() => ''), /./);
  assert.equal(log.article.length, 1);
  assert.deepEqual(log.image, ['good.png']);
  assert.deepEqual(log.other, []);
  assert.deepEqual(errors, []);
});

test('只有按 Enter 才送出（打字、貼上都不會）；沒填網址按 Enter 會提醒', { skip }, async t => {
  const { page, log } = await open(t);
  await page.fill('.qfw-input', ART_URL);
  await new Promise(r => setTimeout(r, 500));
  assert.equal(log.article.length, 0);
  assert.equal(await page.locator('.qfw-status').isHidden(), true);
  await page.fill('.qfw-input', '');
  await page.press('.qfw-input', 'Enter');
  assert.match(await status(page), /請先貼上文章網址/);
  assert.equal(log.article.length, 0);
});

test('不是 TVBS 的網址：外掛拒絕，顯示說明，完全沒有對外發出請求', { skip }, async t => {
  const { page, log } = await open(t);
  await run(page, 'https://example.com/a');
  await waitDone(page, /只能抓 TVBS/);
  assert.deepEqual(log.article, []);
  assert.deepEqual(log.other, []);
  assert.equal(await page.locator('.batch-item-block textarea').inputValue(), '');
});

test('沒有安裝外掛：顯示「沒有收到外掛的回應…」，不壞掉', { skip }, async t => {
  const { page, errors } = await open(t, { withExtension: false });
  await page.evaluate(() => { const orig = QptWebBridge.call; QptWebBridge.call = (op, p) => orig(op, p, 500); });   // 測試加速：不要等 30 秒
  await run(page);
  await waitDone(page, /沒有收到外掛的回應/);
  assert.deepEqual(errors, []);
});

test('第一張圖抓不到／太小時自動換下一張，直到找到可用的（顯示進度）', { skip }, async t => {
  const html = article({ og: 'https://img.tvbs.com.tw/bad.png', images: ['https://img.tvbs.com.tw/small.png', 'https://img.tvbs.com.tw/text.png', 'https://img.tvbs.com.tw/good.png'] });
  const { page, log } = await open(t, { html, imgs: { 'small.png': { w: 100, h: 80 }, 'text.png': { type: 'text/html' }, 'good.png': { w: 1200, h: 900 } } });
  await run(page);
  await waitDone(page, /完成/);
  assert.deepEqual(log.image, ['bad.png', 'small.png', 'text.png', 'good.png']);
  assert.equal(await page.evaluate(() => batchItems[0].bg.image.naturalWidth), 1200);
  assert.match(await status(page), /完成：標題、圖片都帶入了/);
});

test('圖片都抓不到：標題照樣帶入，提醒手動放圖', { skip }, async t => {
  const { page } = await open(t, { html: article({ images: ['https://img.tvbs.com.tw/x.png'] }), imgs: {} });
  await run(page);
  await waitDone(page, /完成，但/);
  assert.match(await status(page), /圖片都抓不到，請手動放圖/);
  assert.notEqual(await page.locator('.batch-item-block textarea').inputValue(), '');
  assert.equal(await page.evaluate(() => batchItems[0].bg.image), null);
});

test('卡片收合再展開：輸入框內容與完成訊息還在（卡片會整個重建，不能掉）', { skip }, async t => {
  const { page } = await open(t);
  await run(page);
  await waitDone(page);
  await page.locator('.batch-item-head .label').click();   // 點卡片標題列＝收合
  await page.waitForSelector('.batch-item-row');
  await page.locator('.batch-item-row').click();             // 再展開
  await page.waitForSelector('.qfw-input');
  assert.equal(await page.inputValue('.qfw-input'), ART_URL);
  assert.match(await status(page), /完成/);
  // 位置仍然正確
  const kids = await page.evaluate(() => [...document.querySelector('.batch-item-block').children].map(c => c.className.split(' ')[0]));
  assert.deepEqual(kids.slice(0, 3), ['batch-item-head', 'qfw-row', 'bg-toggle']);
});

test('「全部清除」：跑到一半的作廢（之後不會有東西冒出來）；新增的卡片輸入框是空的、沒有舊訊息', { skip }, async t => {
  const { page, errors } = await open(t);
  await run(page);
  await page.click('#batchResetBtn');   // 文章還在抓的時候就清除
  await page.click('#confirmOkBtn');
  await page.waitForFunction(() => batchItems.length === 0);
  await new Promise(r => setTimeout(r, 1500));   // 等原本那次抓取跑完
  assert.equal(await page.evaluate(() => batchItems.length), 0, '作廢的結果不能把卡片救回來');
  await page.click('#addBatchItemBtn');
  await page.waitForSelector('.qfw-input');
  assert.equal(await page.inputValue('.qfw-input'), '');
  assert.equal(await page.locator('.qfw-status').isHidden(), true);
  assert.equal(await page.locator('.batch-item-block textarea').inputValue(), '');
  assert.deepEqual(errors, []);
});

test('快速產圖後完成圖片 → 排程抽屜「帶入目前圖文」連文章網址與圖文格式（【標題】／圖說／hashtag）一起帶入', { skip }, async t => {
  const { page } = await open(t);
  await run(page);
  await waitDone(page);
  await page.getByRole('button', { name: '完成', exact: true }).click();
  await page.waitForFunction(() => batchItems[0].done && batchItems[0].resultDataUrl, null, { timeout: 20000 });
  await page.click('#schedTab');
  await page.waitForSelector('#schFillBtn', { state: 'visible' });
  await page.click('#schFillBtn');
  await page.waitForFunction(() => document.getElementById('schText').value !== '');
  assert.equal(await page.inputValue('#schText'), `【${TITLE}】\n（圖／TVBS）\n#霸凌 #宮廟 #張善政`);
  assert.equal(await page.inputValue('#schArticle'), ART_URL);
  assert.equal(await page.locator('.sch-thumb').count(), 1);
  // 選粉專之後，留言預覽帶好追蹤碼（有附圖 → pic）
  await page.selectOption('#schPreset', { label: '新聞粉' });
  assert.match(await page.locator('#schCommentPreview').textContent(), /https:\/\/news\.tvbs\.com\.tw\/local\/1111111\?&utm_source=facebook&utm_medium=fbarticlepic$/);
});

test('標題在快速產圖後又改過：帶入排程時第一行【標題】用新的，圖說與 hashtag 不變', { skip }, async t => {
  const { page } = await open(t);
  await run(page);
  await waitDone(page);
  await page.fill('.batch-item-block textarea', '我自己改的標題');
  await page.getByRole('button', { name: '完成', exact: true }).click();
  await page.waitForFunction(() => batchItems[0].done && batchItems[0].resultDataUrl, null, { timeout: 20000 });
  await page.click('#schedTab');
  await page.waitForSelector('#schFillBtn', { state: 'visible' });
  await page.click('#schFillBtn');
  await page.waitForFunction(() => document.getElementById('schText').value !== '');
  assert.equal(await page.inputValue('#schText'), '【我自己改的標題】\n（圖／TVBS）\n#霸凌 #宮廟 #張善政');
});

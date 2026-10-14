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

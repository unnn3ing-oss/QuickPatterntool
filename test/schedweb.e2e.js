// 網頁版右側「排程」抽屜在真的 Chromium 裡的流程測試。
// 網頁版從假的網址 https://unnn3ing-oss.github.io/QuickPatterntool/ 載入（內容取自本機檔案），
// 並在頁面裡放「真的」scheduler.js、schedbridge.js（內容腳本）、poster.js（背景），接上假的 chrome.*（記憶體 storage／鬧鐘／分頁），
// 所以「網頁 → postMessage → 橋接 → 背景 → 儲存 → 通知網頁重新整理」整條路都是真的程式在跑。
// 真的擴充功能環境（content script 注入、跨環境訊息）仍需 Chrome 實機。
// 需要 playwright：NODE_PATH=<有 playwright 的 node_modules> node --test test/schedweb.e2e.js
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

let chromium = null;
try { ({ chromium } = require('playwright')); } catch (e) { /* 沒裝 playwright：整檔略過 */ }
const skip = chromium ? false : '找不到 playwright（設 NODE_PATH 指到有 playwright 的 node_modules）';

const ROOT = path.join(__dirname, '..');
const BASE = 'https://unnn3ing-oss.github.io/QuickPatterntool/';
const FB = 'https://www.facebook.com/tvbsfb/';
const TEA = 'https://www.facebook.com/tvbsteatimenews';
const ART = 'https://news.tvbs.com.tw/politics/4039103';
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.ttf': 'font/ttf', '.woff2': 'font/woff2' };
const src = f => fs.readFileSync(path.join(ROOT, f), 'utf8');

let browser;
test.before(async () => { if (chromium) browser = await chromium.launch(); });
test.after(async () => { if (browser) await browser.close(); });

// 假的 chrome.* ＋ 真的 scheduler／schedbridge／poster。withExtension:false 時什麼都不放（沒裝外掛的網頁版）。
const EXTENSION = () => `
(() => {
  const data = { fbQueue: window.__initialQueue || [] };
  const listeners = { storage: [], message: [] };
  window.__tabs = { created: [], sent: [], removed: [] };
  const clone = v => JSON.parse(JSON.stringify(v));
  window.chrome = {
    runtime: {
      id: 'me', getManifest: () => ({ version: '9.99' }),
      onMessage: { addListener: f => listeners.message.push(f) }, onInstalled: { addListener() {} }, onStartup: { addListener() {} },
      sendMessage: msg => new Promise(res => {
        let async = false;
        for (const f of listeners.message) { if (f(msg, { id: 'me', tab: { id: 5 }, url: location.href }, v => res(v)) === true) async = true; }
        if (!async) res(undefined);
      })
    },
    storage: {
      local: {
        get: async k => (k in data ? { [k]: clone(data[k]) } : {}),
        set: async o => {
          const changes = {};
          for (const k of Object.keys(o)) { changes[k] = { newValue: clone(o[k]) }; data[k] = clone(o[k]); }
          listeners.storage.forEach(f => f(changes, 'local'));
        }
      },
      onChanged: { addListener: f => listeners.storage.push(f) }
    },
    alarms: { create: async () => {}, getAll: async () => [], clear: async () => true, onAlarm: { addListener() {} } },
    tabs: {
      query: async () => [{ id: 7 }], create: async o => { window.__tabs.created.push(o); return { id: 100 + window.__tabs.created.length }; },
      sendMessage: async (id, m) => { window.__tabs.sent.push(m); return { started: true }; },
      remove: async id => { window.__tabs.removed.push(id); }, update: async () => {}, onRemoved: { addListener() {} }
    },
    notifications: { create: async () => {} }
  };
  window.__data = data;
})();
${src('scheduler.js')}
${src('schedbridge.js')}
${src('poster.js')}
`;

async function open(t, { queue = [], withExtension = true } = {}) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  t.after(() => ctx.close());
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.route('**/*', route => {
    const url = new URL(route.request().url());
    if (url.origin !== 'https://unnn3ing-oss.github.io' || !url.pathname.startsWith('/QuickPatterntool/')) return route.abort();
    const rel = decodeURIComponent(url.pathname.slice('/QuickPatterntool/'.length)) || 'index.html';
    const file = path.join(ROOT, rel);
    if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) return route.fulfill({ status: 404, body: '' });
    return route.fulfill({ contentType: TYPES[path.extname(file)] || 'application/octet-stream', body: fs.readFileSync(file) });
  });
  if (withExtension) {
    await page.addInitScript(q => { window.__initialQueue = q; }, queue);
    await page.addInitScript(EXTENSION());
  }
  await page.goto(BASE);
  return { page, errors };
}
const store = page => page.evaluate(() => window.__data.fbQueue);
const future = (min = 60) => { const d = new Date(Date.now() + min * 60000); d.setSeconds(0, 0); return new Date(d - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16); };
const item = over => Object.assign({ id: 'x1', text: '既有的貼文', images: [], pageUrl: FB, note: '', articleUrl: '', at: Date.now() + 3600000, status: 'pending', createdAt: Date.now() }, over);
const openDrawer = async page => { await page.click('#schedTab'); await page.waitForSelector('#schPage', { state: 'visible' }); };

test('抽屜預設收在右邊緣只露出「排程」頁籤；點頁籤彈出、再點收起；Esc 也能關；頁面沒有錯誤', { skip }, async t => {
  const { page, errors } = await open(t);
  assert.equal(await page.locator('#schedDrawer.open').count(), 0);
  assert.equal(await page.locator('#schedDrawerPanel').isVisible(), false);   // 收起時裡面的東西不能被 Tab 到
  const box = await page.locator('#schedTab').boundingBox();
  assert.ok(box.x > 1280 - 60 && box.x + box.width <= 1280 + 1, '頁籤要在右緣、完整看得到：' + JSON.stringify(box));
  assert.equal(await page.locator('#schedTab').getAttribute('aria-expanded'), 'false');
  await page.click('#schedTab');
  await page.waitForSelector('#schPage', { state: 'visible' });
  assert.equal(await page.locator('#schedTab').getAttribute('aria-expanded'), 'true');
  await page.waitForFunction(() => document.getElementById('schedDrawerPanel').getBoundingClientRect().x < 845);   // 等彈出動畫跑完（寬度 440）
  const panel = await page.locator('#schedDrawerPanel').boundingBox();
  assert.ok(panel.x + panel.width <= 1281 && panel.x >= 1280 - 460, '抽屜寬度約 440：' + JSON.stringify(panel));
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => !document.querySelector('#schedDrawer.open'));
  await page.click('#schedTab');
  await page.waitForSelector('#schedDrawer.open');
  await page.click('.sched-close');
  await page.waitForFunction(() => !document.querySelector('#schedDrawer.open'));
  assert.deepEqual(errors, []);
});

test('沒有安裝外掛：抽屜顯示說明與「重新偵測」，不壞掉；裝好之後重新偵測就能用', { skip }, async t => {
  const { page, errors } = await open(t, { withExtension: false });
  await page.click('#schedTab');
  await page.waitForSelector('.sched-ext-note', { state: 'visible', timeout: 8000 });
  assert.match(await page.locator('.sched-ext-note').textContent(), /安裝「圖片套版產生器」Chrome 外掛/);
  assert.equal(await page.locator('#schPage').count(), 0);
  // 之後「裝好了」：補上外掛，按重新偵測
  await page.evaluate(code => { (0, eval)(code); }, EXTENSION());
  await page.click('.sched-retry');
  await page.waitForSelector('#schPage', { state: 'visible', timeout: 8000 });
  assert.deepEqual(errors, []);
});

test('在網頁版新增排程：下拉選粉專、小編文、文章網址 → 存進外掛、清單出現、頁籤顯示等待中數量', { skip }, async t => {
  const { page } = await open(t);
  await openDrawer(page);
  await page.selectOption('#schPreset', { label: '娛樂粉' });
  await page.fill('#schText', '網頁版新增的貼文');
  await page.fill('#schNote', '你也這樣覺得嗎？👀');
  await page.fill('#schArticle', ART);
  assert.match(await page.locator('#schCommentPreview').textContent(), /utm_medium=tvbsteatimenewscomments$/);
  await page.fill('#schAt', future(60));
  await page.click('#schAddBtn');
  await page.waitForFunction(() => window.__data.fbQueue.length === 1);
  const [q] = await store(page);
  assert.deepEqual({ text: q.text, note: q.note, articleUrl: q.articleUrl, pageUrl: q.pageUrl, status: q.status }, { text: '網頁版新增的貼文', note: '你也這樣覺得嗎？👀', articleUrl: ART, pageUrl: TEA, status: 'pending' });
  await page.waitForSelector('.sch-item');
  assert.match(await page.locator('.sch-item .sch-text').textContent(), /網頁版新增的貼文/);
  await page.waitForFunction(() => !document.querySelector('.sched-tab-badge').hidden);
  assert.equal(await page.locator('.sched-tab-badge').textContent(), '1');
  assert.equal(await page.evaluate(() => localStorage.getItem('qpt-sched-page')), TEA);   // 網頁版用 localStorage 記住粉專
});

test('網頁版新增時外掛會再驗證一次：不合格的資料被擋下並顯示原因（不是靜靜失敗）', { skip }, async t => {
  const { page } = await open(t);
  await openDrawer(page);
  await page.fill('#schPage', 'https://evil.example/x');
  await page.fill('#schText', 'x');
  await page.fill('#schAt', future());
  await page.click('#schAddBtn');
  assert.match(await page.locator('#schStatus').textContent(), /粉專網址/);
  assert.equal((await store(page)).length, 0);
});

test('編輯：從網頁版把等待中的排程（含圖片）帶回表單、修改、更新；外掛端有變動時清單自動重整', { skip }, async t => {
  const at = Date.now() + 7200000;
  const { page } = await open(t, { queue: [item({ id: 'e1', text: '原本的貼文', note: '原本小編文', articleUrl: ART, pageUrl: TEA, at, images: [{ name: 'a.png', dataUrl: PNG }] })] });
  await openDrawer(page);
  await page.waitForSelector('.sch-item');
  assert.match(await page.locator('.sch-text').textContent(), /🖼 1/);
  await page.getByRole('button', { name: '編輯' }).click();
  await page.waitForFunction(() => document.getElementById('schAddBtn').textContent === '更新排程');
  assert.equal(await page.inputValue('#schText'), '原本的貼文');
  assert.equal(await page.inputValue('#schNote'), '原本小編文');
  assert.equal(await page.inputValue('#schArticle'), ART);
  assert.equal(await page.locator('#schPreset option:checked').textContent(), '娛樂粉');
  assert.equal(await page.locator('.sch-thumb').count(), 1, '圖片要能從外掛取回來');
  await page.fill('#schText', '網頁版改過的貼文');
  await page.fill('#schAt', future(240));
  await page.click('#schAddBtn');
  await page.waitForFunction(() => window.__data.fbQueue[0].text === '網頁版改過的貼文');
  assert.equal((await store(page))[0].id, 'e1');
  // 外掛那邊（背景／側邊欄）改了排程 → 抽屜自動更新，不用重新整理
  await page.evaluate(() => { const q = window.__data.fbQueue.slice(); q[0] = Object.assign({}, q[0], { status: 'running', step: 'images', startedAt: Date.now() }); return chrome.storage.local.set({ fbQueue: q }); });
  await page.waitForFunction(() => /執行中/.test(document.querySelector('.sch-chip').textContent));
  assert.match(await page.locator('.sch-detail').textContent(), /上傳圖片/);
});

test('試跑／立即發佈：請外掛執行（開粉專分頁、把內容與留言交給內容腳本）；立即發佈要先確認', { skip }, async t => {
  const { page } = await open(t, { queue: [item({ id: 's1', text: '要發的貼文', note: '小編', articleUrl: ART, pageUrl: TEA })] });
  await openDrawer(page);
  await page.waitForSelector('.sch-item');
  await page.getByRole('button', { name: '試跑' }).click();
  await page.waitForFunction(() => window.__tabs.sent.length === 1);
  const sent = await page.evaluate(() => ({ created: window.__tabs.created, job: window.__tabs.sent[0].job }));
  assert.deepEqual(sent.created, [{ url: TEA, active: true }]);
  assert.deepEqual({ id: sent.job.id, mode: sent.job.mode, dryRun: sent.job.dryRun, comment: sent.job.comment },
    { id: 's1', mode: 'post', dryRun: true, comment: `小編\n${ART}?&utm_source=facebook&utm_medium=tvbsteatimenewscomments` });
  await page.evaluate(() => { const q = window.__data.fbQueue.slice(); q[0] = Object.assign({}, q[0], { status: 'pending', startedAt: undefined }); return chrome.storage.local.set({ fbQueue: q }); });
  await page.getByRole('button', { name: '立即發佈' }).click();
  assert.equal(await page.locator('#confirmOverlay.open').count(), 1);
  assert.equal(await page.evaluate(() => window.__tabs.sent.length), 1, '確認前不能發');
  assert.equal(await page.locator('#confirmOkBtn').isVisible(), true, '確認視窗要蓋在抽屜上面');
  await page.click('#confirmCancelBtn');
  assert.equal(await page.evaluate(() => window.__tabs.sent.length), 1);
});

test('已發佈的貼文：網頁版也能「試跑留言」「補留言」（mode:comment）', { skip }, async t => {
  const now = Date.now();
  const { page } = await open(t, { queue: [item({ id: 'd1', text: '發好的', status: 'done', finishedAt: now - 5000, at: now - 900000, note: '小編', articleUrl: ART, pageUrl: FB, commentState: 'failed', commentError: '找不到送出按鈕' })] });
  await openDrawer(page);
  await page.waitForSelector('.sch-item');
  assert.match(await page.locator('.sch-detail.err').textContent(), /留言失敗：找不到送出按鈕/);
  await page.getByRole('button', { name: '補留言' }).click();
  await page.click('#confirmOkBtn');
  await page.waitForFunction(() => window.__tabs.sent.length === 1);
  const job = await page.evaluate(() => window.__tabs.sent[0].job);
  assert.deepEqual({ mode: job.mode, images: job.images, dryRun: job.dryRun, comment: job.comment },
    { mode: 'comment', images: [], dryRun: false, comment: `小編\n${ART}?&utm_source=facebook&utm_medium=fbarticlecomments` });
});

test('帶入目前圖文：取目前展開（或最後完成）的套版圖，標題放進【】', { skip }, async t => {
  const { page } = await open(t);
  await openDrawer(page);
  await page.click('#schFillBtn');
  assert.match(await page.locator('#schStatus').textContent(), /沒有可以帶入的內容/);
  await page.evaluate(png => {
    batchItems.push({ id: 't1', title: '第一則\n第二行', done: true, resultDataUrl: png });
    batchItems.push({ id: 't2', title: '最後完成的', done: true, resultDataUrl: png });
  }, PNG);
  await page.click('#schFillBtn');
  await page.waitForFunction(() => document.querySelectorAll('.sch-thumb').length === 1);
  assert.equal(await page.inputValue('#schText'), '【最後完成的】');
  await page.evaluate(() => { expandedBatchItemId = 't1'; });
  await page.click('#schFillBtn');
  await page.waitForFunction(() => document.getElementById('schText').value === '【第一則 第二行】');
});

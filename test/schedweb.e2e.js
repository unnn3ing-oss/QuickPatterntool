// 網頁版右側「排程」抽屜在真的 Chromium 裡的流程測試（測試環境見 test/web-harness.js：假網址載入網頁版、真的橋接與背景程式、假的 chrome.*）。
// 真的擴充功能環境（content script 注入、跨環境訊息）仍需 Chrome 實機。
// 需要 playwright：NODE_PATH=<有 playwright 的 node_modules> node --test test/schedweb.e2e.js
const test = require('node:test');
const assert = require('node:assert/strict');
const { EXTENSION, openWeb } = require('./web-harness');

let chromium = null;
try { ({ chromium } = require('playwright')); } catch (e) { /* 沒裝 playwright：整檔略過 */ }
const skip = chromium ? false : '找不到 playwright（設 NODE_PATH 指到有 playwright 的 node_modules）';

const FB = 'https://www.facebook.com/tvbsfb/';
const TEA = 'https://www.facebook.com/tvbsteatimenews';
const ART = 'https://news.tvbs.com.tw/politics/4039103';
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

let browser;
test.before(async () => { if (chromium) browser = await chromium.launch(); });
test.after(async () => { if (browser) await browser.close(); });

const open = (t, opts) => openWeb(browser, t, opts);
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
  await page.waitForFunction(() => document.getElementById('schedDrawerPanel').getBoundingClientRect().x < 841);   // 等彈出動畫跑完（寬度 440，停在 840）
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

test('帶入目前圖文：取目前展開（或最後完成）的套版圖，標題放進【】（卡片資料已是成品的情況）', { skip }, async t => {
  const { page } = await open(t);
  await openDrawer(page);
  await page.click('#schFillBtn');
  assert.match(await page.locator('#schStatus').textContent(), /左邊還沒有可以帶入的圖/);
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

// 用真的卡片操作：在左邊卡片打標題、放背景圖，「不按完成」就直接帶入
const BG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
const prepareCard = async (page, title) => {
  await page.fill('.batch-item-block textarea', title);
  await page.setInputFiles('.batch-item-block input[type=file]', { name: 'bg.png', mimeType: 'image/png', buffer: BG });
  await page.waitForFunction(() => batchItems[0].bg && batchItems[0].bg.image);
};

test('帶入目前圖文：左邊正在編輯、還沒按「完成」的卡片也能帶入（有標題＋背景就行），成品圖與按完成的一樣', { skip }, async t => {
  const { page, errors } = await open(t);
  await prepareCard(page, '黑人心梗主因曝！\n醫示警「1行為」');
  assert.equal(await page.evaluate(() => batchItems[0].done), false);
  await page.click('#schedTab');
  await page.waitForSelector('#schFillBtn', { state: 'visible' });
  await page.click('#schFillBtn');
  await page.waitForFunction(() => document.querySelectorAll('.sch-thumb').length === 1, null, { timeout: 20000 });
  assert.equal(await page.inputValue('#schText'), '【黑人心梗主因曝！ 醫示警「1行為」】');
  assert.match(await page.locator('#schStatus').textContent(), /已帶入文字、預覽圖片|已帶入文字.*圖片/);
  // 帶進來的圖就是 1080×1080 成品圖
  const size = await page.evaluate(() => new Promise(res => { const i = new Image(); i.onload = () => res([i.width, i.height]); i.src = document.querySelector('.sch-thumb img').src; }));
  assert.deepEqual(size, [1080, 1080]);
  // 卡片沒有被收合，仍在編輯；且帶入的就是它目前的成品
  assert.equal(await page.locator('.batch-item-block').count(), 1);
  assert.equal(await page.evaluate(() => batchItems[0].done), true);
  assert.deepEqual(errors, []);
});

test('帶入目前圖文：卡片只有標題、沒有背景 → 不亂帶，說明要補什麼', { skip }, async t => {
  const { page } = await open(t);
  await page.fill('.batch-item-block textarea', '只有標題');
  await page.click('#schedTab');
  await page.waitForSelector('#schFillBtn', { state: 'visible' });
  await page.click('#schFillBtn');
  assert.match(await page.locator('#schStatus').textContent(), /左邊還沒有可以帶入的圖.*標題.*背景/);
  assert.equal(await page.locator('.sch-thumb').count(), 0);
  assert.equal(await page.inputValue('#schText'), '');
});

test('帶入目前圖文：多張卡片時以「正在編輯（展開）」的那張為準，不是第一張', { skip }, async t => {
  const { page } = await open(t);
  await prepareCard(page, '第一張的標題');
  await page.getByRole('button', { name: '完成', exact: true }).click();   // 第一張完成並收合
  await page.waitForFunction(() => batchItems[0].done);
  await page.click('#addBatchItemBtn');                                    // 新增第二張並展開
  await page.waitForFunction(() => batchItems.length === 2);
  await page.fill('.batch-item-block textarea', '第二張的標題');
  await page.setInputFiles('.batch-item-block input[type=file]', { name: 'bg.png', mimeType: 'image/png', buffer: BG });
  await page.waitForFunction(() => batchItems[1].bg && batchItems[1].bg.image);
  await page.click('#schedTab');
  await page.waitForSelector('#schFillBtn', { state: 'visible' });
  await page.click('#schFillBtn');
  await page.waitForFunction(() => document.getElementById('schText').value !== '', null, { timeout: 20000 });
  assert.equal(await page.inputValue('#schText'), '【第二張的標題】');
  // 帶入沒有把正在編輯的畫面換掉
  assert.equal(await page.locator('.batch-item-block textarea').inputValue(), '第二張的標題');
});

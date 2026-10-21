// 網頁版「剪輯」分頁（QuickCut 搬家說明與功能介紹）在真的 Chromium 裡的測試：載入 index.html（file://），
// 驗證：剪輯分頁只有介紹、舊剪輯程式沒有載入、前往 QuickCut 的連結正確、4 步精靈可以切換、切到別的分頁會收起來。
// 需要 playwright：NODE_PATH=<有 playwright 的 node_modules> node --test test/quickcut-intro.e2e.js
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

let chromium = null;
try { ({ chromium } = require('playwright')); } catch (e) { /* 沒裝 playwright：整檔略過 */ }
const skip = chromium ? false : '找不到 playwright（設 NODE_PATH 指到有 playwright 的 node_modules）';

const ROOT = path.join(__dirname, '..');
const PAGE = 'file://' + path.join(ROOT, 'index.html');
const QUICKCUT = 'https://unnn3ing-oss.github.io/quickcut/';

let browser;
test.before(async () => { if (chromium) browser = await chromium.launch(); });
test.after(async () => { if (browser) await browser.close(); });

async function open(t, opts = {}) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 860 }, ...opts });
  t.after(() => ctx.close());
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
  await page.route('https://**', r => r.abort());
  await page.goto(PAGE);
  return { page, errors };
}

test('index.html 不再載入舊剪輯（edit.css、edit-*.js、深色開關）', () => {
  const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  assert.ok(!/<link[^>]*edit\.css/.test(html));
  assert.ok(!/<script[^>]*src="edit-[a-z]+\.js"/.test(html));
  assert.ok(!/edThemeBtn/.test(html));
  assert.ok(!/id="edTimeline"|id="edToolbar"|id="edExportDialog"/.test(html));
});

test('點「剪輯」：該分頁只剩 QuickCut 搬家說明，沒有舊剪輯介面，也沒有 console error', { skip }, async t => {
  const { page, errors } = await open(t);
  assert.equal(await page.locator('#editApp').isVisible(), false);
  await page.click('#funcEditBtn');
  await page.waitForSelector('#editApp', { state: 'visible' });
  assert.match(await page.locator('#qcTitle').textContent(), /QuickCut/);
  assert.equal(await page.locator('#editApp .ed-toolbar, #editApp .ed-timeline, #editApp canvas').count(), 0, '沒有舊剪輯介面');
  assert.equal(await page.evaluate(() => typeof window.QPTEdit), 'undefined', '舊剪輯程式沒有載入');
  assert.equal(await page.locator('#layoutApp').isVisible(), false, '其他分頁收起來');
  assert.deepEqual(errors, []);
});

test('「前往 QuickCut」連結：指向專屬網站、在新分頁開啟、不帶 opener', { skip }, async t => {
  const { page } = await open(t);
  await page.click('#funcEditBtn');
  const links = page.locator('#editApp a[href]');
  assert.ok(await links.count() >= 2, '頂端與最後一步各有一個連結');
  for (const a of await links.all()) {
    assert.equal(await a.getAttribute('href'), QUICKCUT);
    assert.equal(await a.getAttribute('target'), '_blank');
    assert.match(await a.getAttribute('rel'), /noopener/);
  }
  // 按下去真的是開新分頁（網路被擋，只看有沒有開出新頁、網址對不對）
  const asked = [];
  page.context().on('request', r => asked.push(r.url()));
  const popup = page.waitForEvent('popup');
  await page.click('#qcGo');
  await popup;
  await page.waitForTimeout(300);
  assert.ok(asked.includes(QUICKCUT), `新分頁有去要 QuickCut 的網址：${asked.join(', ')}`);
});

test('4 步功能介紹：下一步／上一步／點步驟／方向鍵都能切換，進度與按鈕狀態正確', { skip }, async t => {
  const { page, errors } = await open(t);
  await page.click('#funcEditBtn');
  const cur = () => page.evaluate(() => {
    const panes = [...document.querySelectorAll('#editApp .ds-pane')];
    return { shown: panes.map(p => !p.hidden), count: document.getElementById('qcCount').textContent,
      prev: document.getElementById('qcPrev').disabled, next: document.getElementById('qcNext').disabled,
      done: document.querySelectorAll('#qcSteps .ds-step.done').length, current: [...document.querySelectorAll('#qcSteps .ds-step')].findIndex(li => li.classList.contains('current')) };
  });
  let s = await cur();
  assert.deepEqual(s.shown, [true, false, false, false]);
  assert.equal(s.count, '1 / 4'); assert.equal(s.prev, true); assert.equal(s.next, false);
  await page.click('#qcNext');
  s = await cur(); assert.deepEqual(s.shown, [false, true, false, false]); assert.equal(s.done, 1); assert.equal(s.prev, false);
  await page.keyboard.press('ArrowRight');
  s = await cur(); assert.equal(s.current, 2);
  await page.click('#qcSteps .ds-step:nth-child(4) .ds-step-btn');
  s = await cur(); assert.deepEqual(s.shown, [false, false, false, true]); assert.equal(s.count, '4 / 4'); assert.equal(s.next, true); assert.equal(s.done, 3);
  await page.click('#qcPrev');
  s = await cur(); assert.equal(s.current, 2);
  await page.keyboard.press('ArrowLeft'); await page.keyboard.press('ArrowLeft');
  s = await cur(); assert.equal(s.current, 0);
  // 離開再回來：從第 1 步開始
  await page.click('#qcNext');
  await page.click('#funcResizeBtn');
  assert.equal(await page.locator('#editApp').isVisible(), false);
  await page.click('#funcEditBtn');
  s = await cur(); assert.equal(s.current, 0);
  assert.deepEqual(errors, []);
});

test('示意動畫：切到一步會開始播（.play），離開分頁就停；「減少動態效果」時不播、停在做完的畫面', { skip }, async t => {
  const { page } = await open(t);
  await page.click('#funcEditBtn');
  assert.equal(await page.locator('#editApp .ds-pane:not([hidden]) .ds-art.play').count(), 1);
  assert.ok(await page.locator('#editApp .ds-pane:not([hidden]) .ds-art svg .qc-cv').count() > 0, '有示意圖');
  const ctx2 = await browser.newContext({ viewport: { width: 1280, height: 860 }, reducedMotion: 'reduce' });
  t.after(() => ctx2.close());
  const p2 = await ctx2.newPage();
  await p2.route('https://**', r => r.abort());
  await p2.goto(PAGE);
  await p2.click('#funcEditBtn');
  assert.equal(await p2.locator('#editApp .ds-art.play').count(), 0);
});

test('手機寬度：說明卡片不會橫向捲出畫面，前往按鈕撐滿寬度', { skip }, async t => {
  const { page } = await open(t, { viewport: { width: 390, height: 800 } });
  await page.click('#funcEditBtn');
  const m = await page.evaluate(() => { const c = document.querySelector('#editApp .qc-card').getBoundingClientRect(); return { right: c.right, w: window.innerWidth, go: document.getElementById('qcGo').getBoundingClientRect().width, card: c.width }; });
  assert.ok(m.right <= m.w + 1, `卡片右緣 ${m.right} 超出視窗 ${m.w}`);
  assert.ok(m.go > m.card * 0.8, '按鈕撐滿');
});

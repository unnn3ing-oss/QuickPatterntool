// 網頁版「剪輯」分頁（QuickCut 搬家說明與功能介紹）在真的 Chromium 裡的測試：載入 index.html（file://），
// 驗證：剪輯分頁只有介紹、舊剪輯程式沒有載入、右下角的前往 QuickCut 連結正確、功能輪播會自動換則／可暫停／可手動切換、切到別的分頁會收起來。
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

test('右下角「前往 QuickCut」：整頁唯一的連結，指向專屬網站、在新分頁開啟、不帶 opener、位在輪播的右下角', { skip }, async t => {
  const { page } = await open(t);
  await page.click('#funcEditBtn');
  const links = page.locator('#editApp a[href]');
  assert.equal(await links.count(), 1, '只有右下角這一個連結');
  const a = links.first();
  assert.equal(await a.getAttribute('id'), 'qcGo');
  assert.equal(await a.getAttribute('href'), QUICKCUT);
  assert.equal(await a.getAttribute('target'), '_blank');
  assert.match(await a.getAttribute('rel'), /noopener/);
  const pos = await page.evaluate(() => {
    const go = document.getElementById('qcGo').getBoundingClientRect(), card = document.querySelector('#editApp .qc-card').getBoundingClientRect();
    const dots = document.getElementById('qcDots').getBoundingClientRect();
    return { goRight: card.right - go.right, goBottom: card.bottom - go.bottom, goLeft: go.left, dotsRight: dots.right, cardMid: card.left + card.width / 2 };
  });
  assert.ok(pos.goRight < 60 && pos.goBottom < 60, `連結貼近卡片右下角（右 ${pos.goRight}、下 ${pos.goBottom}）`);
  assert.ok(pos.goLeft > pos.cardMid, '連結在右半邊');
  // 按下去真的是開新分頁（網路被擋，只看有沒有開出新頁、網址對不對）
  const asked = [];
  page.context().on('request', r => asked.push(r.url()));
  const popup = page.waitForEvent('popup');
  await page.click('#qcGo');
  await popup;
  await page.waitForTimeout(300);
  assert.ok(asked.includes(QUICKCUT), `新分頁有去要 QuickCut 的網址：${asked.join(', ')}`);
});

// 把每一則的輪播時間縮短，測試才不用等 7 秒
const FAST = `document.querySelectorAll('#editApp .ds-pane').forEach(p => p.dataset.cycle = '500')`;
const state = page => page.evaluate(() => {
  const panes = [...document.querySelectorAll('#editApp .ds-pane')];
  return { shown: panes.findIndex(p => !p.hidden), visible: panes.filter(p => !p.hidden).length,
    count: document.getElementById('qcCount').textContent,
    current: [...document.querySelectorAll('#qcDots .qc-dot')].findIndex(d => d.classList.contains('current')),
    pause: document.getElementById('qcPause').getAttribute('aria-pressed'), pauseText: document.getElementById('qcPause').textContent };
});

test('自動輪播：每則播完自動換下一則、第 4 則後回到第 1 則循環；圓點與計數同步', { skip }, async t => {
  const { page, errors } = await open(t);
  await page.evaluate(FAST);
  await page.click('#funcEditBtn');
  let s = await state(page);
  assert.equal(s.shown, 0); assert.equal(s.count, '1 / 4'); assert.equal(s.visible, 1);
  const seen = new Set();
  const t0 = Date.now();
  while (Date.now() - t0 < 4500 && seen.size < 4) { seen.add((await state(page)).shown); await page.waitForTimeout(80); }
  assert.deepEqual([...seen].sort(), [0, 1, 2, 3], '4 則都輪到過');
  // 繼續等，會繞回第 1 則（循環）
  let wrapped = false;
  const t1 = Date.now();
  let last = (await state(page)).shown;
  while (Date.now() - t1 < 4000 && !wrapped) { const n = (await state(page)).shown; if (last === 3 && n === 0) wrapped = true; last = n; await page.waitForTimeout(60); }
  assert.ok(wrapped, '第 4 則後回到第 1 則');
  s = await state(page);
  assert.equal(s.current, s.shown); assert.equal(s.count, `${s.shown + 1} / 4`); assert.equal(s.visible, 1);
  assert.deepEqual(errors, []);
});

test('暫停輪播：按下後停在原則、文字變「繼續輪播」；再按一次繼續自動換', { skip }, async t => {
  const { page } = await open(t);
  await page.evaluate(FAST);
  await page.click('#funcEditBtn');
  await page.click('#qcPause');
  await page.mouse.move(0, 0);
  let s = await state(page);
  assert.equal(s.pause, 'true'); assert.equal(s.pauseText, '繼續輪播');
  const at = s.shown;
  await page.waitForTimeout(1400);
  assert.equal((await state(page)).shown, at, '暫停期間不換則');
  await page.click('#qcPause');
  await page.mouse.move(0, 0);
  s = await state(page);
  assert.equal(s.pause, 'false'); assert.equal(s.pauseText, '暫停輪播');
  await page.waitForFunction(a => [...document.querySelectorAll('#editApp .ds-pane')].findIndex(p => !p.hidden) !== a, at, { timeout: 3000 });
});

test('滑鼠停在輪播上就不自動換，移開後繼續', { skip }, async t => {
  const { page } = await open(t);
  await page.evaluate(FAST);
  await page.click('#funcEditBtn');
  await page.hover('#editApp .qc-main');
  const at = (await state(page)).shown;
  await page.waitForTimeout(1400);
  assert.equal((await state(page)).shown, at, '滑鼠停著不換');
  await page.mouse.move(0, 0);
  await page.waitForFunction(a => [...document.querySelectorAll('#editApp .ds-pane')].findIndex(p => !p.hidden) !== a, at, { timeout: 3000 });
});

test('手動切換：下一則／上一則／點圓點／方向鍵（會循環），換過去後從那一則重新計時', { skip }, async t => {
  const { page, errors } = await open(t);
  await page.click('#funcEditBtn');
  await page.hover('#editApp .qc-main');   // 手動測試時先不要被自動換則干擾
  let s = await state(page);
  assert.equal(s.shown, 0);
  await page.click('#qcNext'); assert.equal((await state(page)).shown, 1);
  await page.keyboard.press('ArrowRight'); assert.equal((await state(page)).shown, 2);
  await page.click('#qcDots .qc-dot:nth-child(4)');
  s = await state(page); assert.equal(s.shown, 3); assert.equal(s.count, '4 / 4'); assert.equal(s.current, 3);
  await page.click('#qcNext'); assert.equal((await state(page)).shown, 0, '第 4 則按下一則回第 1 則');
  await page.click('#qcPrev'); assert.equal((await state(page)).shown, 3, '第 1 則按上一則到第 4 則');
  await page.keyboard.press('ArrowLeft'); assert.equal((await state(page)).shown, 2);
  assert.equal((await state(page)).visible, 1);
  // 離開再回來：從第 1 則開始
  await page.click('#funcResizeBtn');
  assert.equal(await page.locator('#editApp').isVisible(), false);
  await page.click('#funcEditBtn');
  assert.equal((await state(page)).shown, 0);
  assert.deepEqual(errors, []);
});

test('離開剪輯分頁就停止輪播（不在背景偷換則）', { skip }, async t => {
  const { page } = await open(t);
  await page.evaluate(FAST);
  await page.click('#funcEditBtn');
  await page.click('#funcResizeBtn');
  const at = (await state(page)).shown;
  await page.waitForTimeout(1300);
  assert.equal((await state(page)).shown, at);
  assert.equal(await page.locator('#editApp.playing').count(), 0);
});

test('示意動畫：目前這則有 .play，換則後只剩新那則；「減少動態效果」時不自動換也不播、停在做完的畫面', { skip }, async t => {
  const { page } = await open(t);
  await page.click('#funcEditBtn');
  await page.hover('#editApp .qc-main');
  assert.equal(await page.locator('#editApp .ds-art.play').count(), 1);
  assert.ok(await page.locator('#editApp .ds-pane:not([hidden]) .ds-art svg .qc-cv').count() > 0, '有示意圖');
  await page.click('#qcNext');
  assert.equal(await page.locator('#editApp .ds-pane:not([hidden]) .ds-art.play').count(), 1);
  assert.equal(await page.locator('#editApp .ds-art.play').count(), 1);
  const ctx2 = await browser.newContext({ viewport: { width: 1280, height: 860 }, reducedMotion: 'reduce' });
  t.after(() => ctx2.close());
  const p2 = await ctx2.newPage();
  await p2.route('https://**', r => r.abort());
  await p2.goto(PAGE);
  await p2.evaluate(FAST);
  await p2.click('#funcEditBtn');
  assert.equal(await p2.locator('#editApp .ds-art.play').count(), 0);
  await p2.waitForTimeout(1300);
  assert.equal((await state(p2)).shown, 0, '減少動態效果：不自動換則');
  await p2.click('#qcNext');
  assert.equal((await state(p2)).shown, 1, '但仍可手動換');
});

test('手機寬度：卡片不會橫向捲出畫面，前往按鈕撐滿寬度', { skip }, async t => {
  const { page } = await open(t, { viewport: { width: 390, height: 800 } });
  await page.click('#funcEditBtn');
  const m = await page.evaluate(() => { const c = document.querySelector('#editApp .qc-card').getBoundingClientRect(); return { right: c.right, w: window.innerWidth, go: document.getElementById('qcGo').getBoundingClientRect().width, card: c.width }; });
  assert.ok(m.right <= m.w + 1, `卡片右緣 ${m.right} 超出視窗 ${m.w}`);
  assert.ok(m.go > m.card * 0.8, '按鈕撐滿');
});

// 側邊欄「FB 粉專排程」在真的 Chromium 裡的流程測試：用假的 chrome（記憶體 storage），驗證建立、顯示、刪除、試跑／立即發佈送出的訊息。
// 到點自動發佈由背景（poster.js，見 test/poster.test.js）負責；真的擴充功能環境仍需 Chrome 實機。
// 需要 playwright：NODE_PATH=<有 playwright 的 node_modules> node --test test/schedpanel.e2e.js
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

let chromium = null;
try { ({ chromium } = require('playwright')); } catch (e) { /* 沒裝 playwright：整檔略過 */ }
const skip = chromium ? false : '找不到 playwright（設 NODE_PATH 指到有 playwright 的 node_modules）';

const PAGE = 'file://' + path.join(__dirname, '..', 'sidepanel.html');
const FB = 'https://www.facebook.com/tvbsnews';
const PNG_BYTES = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');

let browser;
test.before(async () => { if (chromium) browser = await chromium.launch(); });
test.after(async () => { if (browser) await browser.close(); });

async function open(t, { queue = [] } = {}) {
  const ctx = await browser.newContext({ viewport: { width: 420, height: 1100 } });
  t.after(() => ctx.close());
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.route('https://api.github.com/**', r => r.abort());
  await page.route('https://raw.githubusercontent.com/**', r => r.abort());
  await page.addInitScript(initial => {
    const data = { fbQueue: initial };
    const listeners = [];
    window.__data = data;
    window.__sent = [];
    window.chrome = {
      runtime: {
        id: 'me', getManifest: () => ({ name: '圖片套版產生器', version: '5.00' }), getURL: p => p, reload() {},
        sendMessage: async m => { window.__sent.push(m); return { ok: true }; }
      },
      tabs: { create() {} },
      action: { getBadgeText: async () => '', setBadgeText: async () => {}, setBadgeBackgroundColor: async () => {} },
      storage: {
        local: {
          get: async k => (k in data ? { [k]: JSON.parse(JSON.stringify(data[k])) } : {}),
          set: async o => {
            const changes = {};
            for (const k of Object.keys(o)) { changes[k] = { newValue: o[k] }; data[k] = JSON.parse(JSON.stringify(o[k])); }
            listeners.forEach(fn => fn(changes, 'local'));
          }
        },
        session: { get: async () => ({}), remove: async () => {}, set: async () => {} },
        onChanged: { addListener: fn => listeners.push(fn) }
      }
    };
  }, queue);
  await page.goto(PAGE);
  return { page, errors };
}
const queued = page => page.evaluate(() => window.__data.fbQueue);
const future = (min = 30) => { const d = new Date(Date.now() + min * 60000); d.setSeconds(0, 0); return new Date(d - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16); };
const item = over => Object.assign({ id: 'x1', text: '既有的貼文', images: [], pageUrl: FB, at: Date.now() + 3600000, status: 'pending', createdAt: Date.now() }, over);

test('預設時間是未來的整點／半點；加入排程：存入佇列、清空表單、記住粉專網址', { skip }, async t => {
  const { page, errors } = await open(t);
  const def = new Date(await page.inputValue('#schAt')).getTime();
  assert.ok(def > Date.now() + 9 * 60000 && new Date(def).getMinutes() % 30 === 0);
  await page.fill('#schPage', 'facebook.com/tvbsnews');
  await page.click('#schAddBtn');
  assert.match(await page.locator('#schStatus').textContent(), /粉專網址/);   // 網址格式錯的提示
  await page.fill('#schPage', FB);
  await page.click('#schAddBtn');
  assert.match(await page.locator('#schStatus').textContent(), /文字和圖片至少要有一樣/);
  await page.fill('#schText', '第一行\n第二行');
  await page.fill('#schAt', future(45));
  await page.click('#schAddBtn');
  await page.waitForFunction(() => window.__data.fbQueue.length === 1);
  const q = await queued(page);
  assert.equal(q.length, 1);
  assert.equal(q[0].text, '第一行\n第二行');
  assert.equal(q[0].status, 'pending');
  assert.equal(q[0].pageUrl, FB);
  assert.equal(await page.inputValue('#schText'), '');
  assert.equal(await page.evaluate(() => window.__data.fbPageUrl), FB);
  assert.equal(await page.locator('.sch-item').count(), 1);
  assert.match(await page.locator('.sch-chip').textContent(), /等待中/);
  assert.deepEqual(errors, []);
});

test('時間不能是過去或不到一分鐘後', { skip }, async t => {
  const { page } = await open(t);
  await page.fill('#schPage', FB);
  await page.fill('#schText', 'x');
  await page.fill('#schAt', future(-30));
  await page.click('#schAddBtn');
  assert.match(await page.locator('#schStatus').textContent(), /一分鐘以後/);
  assert.equal((await queued(page)).length, 0);
});

test('加入圖片：縮圖可移除；圖片隨排程存入；不支援的格式會提示', { skip }, async t => {
  const { page } = await open(t);
  await page.setInputFiles('#schFile', [
    { name: 'a.png', mimeType: 'image/png', buffer: PNG_BYTES },
    { name: 'b.png', mimeType: 'image/png', buffer: PNG_BYTES },
    { name: 'c.txt', mimeType: 'text/plain', buffer: Buffer.from('hi') }
  ]);
  await page.waitForFunction(() => document.querySelectorAll('.sch-thumb').length === 2);
  assert.match(await page.locator('#schStatus').textContent(), /只支援/);
  await page.locator('.sch-thumb-x').first().click();
  assert.equal(await page.locator('.sch-thumb').count(), 1);
  await page.fill('#schPage', FB);
  await page.fill('#schAt', future());
  await page.click('#schAddBtn');
  await page.waitForFunction(() => window.__data.fbQueue.length === 1);
  const q = await queued(page);
  assert.equal(q[0].images.length, 1);
  assert.match(q[0].images[0].dataUrl, /^data:image\/png;base64,/);
  assert.equal(q[0].images[0].name, 'b.png');
  assert.equal(await page.locator('.sch-thumb').count(), 0);
});

test('帶入目前圖文：複製框的文字進來；沒有預覽圖時只帶文字並說明', { skip }, async t => {
  const { page } = await open(t);
  await page.fill('#qfCopyText', '【標題】\n（圖／A攝影）\n#標籤');
  await page.click('#schFillBtn');
  assert.equal(await page.inputValue('#schText'), '【標題】\n（圖／A攝影）\n#標籤');
  assert.equal(await page.locator('.sch-thumb').count(), 0);
  assert.match(await page.locator('#schStatus').textContent(), /沒有圖片/);
});

test('帶入目前圖文：預覽有圖時，成品圖（1080×1080 PNG）一起帶入並隨排程存入', { skip }, async t => {
  const { page } = await open(t);
  await page.setInputFiles('#singleBgPicker input[type=file]', { name: 'bg.png', mimeType: 'image/png', buffer: PNG_BYTES });
  await page.evaluate(() => { const el = document.getElementById('title'); el.value = '標題'; el.dispatchEvent(new Event('input', { bubbles: true })); });
  await page.waitForFunction(() => !document.getElementById('downloadBtn').disabled);
  await page.fill('#qfCopyText', '【標題】');
  await page.click('#schFillBtn');
  await page.waitForFunction(() => document.querySelectorAll('.sch-thumb').length === 1);
  await page.fill('#schPage', FB);
  await page.fill('#schAt', future());
  await page.click('#schAddBtn');
  await page.waitForFunction(() => window.__data.fbQueue.length === 1);
  const [im] = (await queued(page))[0].images;
  assert.match(im.dataUrl, /^data:image\/png;base64,/);
  const size = await page.evaluate(src => new Promise(res => { const i = new Image(); i.onload = () => res([i.width, i.height]); i.src = src; }), im.dataUrl);
  assert.deepEqual(size, [1080, 1080]);
});

test('清單：依時間排序；各狀態顯示原因；刪除；試跑直接送、立即發佈要先確認', { skip }, async t => {
  const now = Date.now();
  const { page } = await open(t, { queue: [
    item({ id: 'late', text: '晚的', at: now + 7200000 }),
    item({ id: 'soon', text: '早的', at: now + 3600000, images: [{ name: 'a', dataUrl: 'data:image/png;base64,AA' }] }),
    item({ id: 'bad', text: '失敗的', status: 'failed', error: '文字沒有輸入成功', step: 'text', at: now - 100000 }),
    item({ id: 'gone', text: '錯過的', status: 'missed', error: '排定…沒有補發', at: now - 3600000 }),
    item({ id: 'ok', text: '發好的', status: 'done', finishedAt: now - 1000, at: now - 200000 }),
    item({ id: 'run', text: '跑中', status: 'running', step: 'images', at: now - 50000 })
  ] });
  const texts = await page.locator('.sch-text').allTextContents();
  assert.deepEqual(texts.map(s => s.replace(/　.*/, '')), ['錯過的', '發好的', '失敗的', '跑中', '早的', '晚的']);
  assert.match(await page.locator('.sch-failed .sch-detail').textContent(), /文字沒有輸入成功/);
  assert.match(await page.locator('.sch-running .sch-detail').textContent(), /上傳圖片/);
  assert.deepEqual(await page.locator('.sch-running button').allTextContents(), ['中止']);   // 執行中只能中止，不能編輯、刪除、重複執行
  assert.match(await page.locator('.sch-running .sch-detail').textContent(), /已 \d+ 秒；卡住的話可以按「中止」/);
  assert.equal(await page.locator('.sch-done button').count(), 1);             // 已發佈只能刪除
  assert.match(await page.locator('.sch-pending .sch-text').first().textContent(), /🖼 1/);

  const soon = page.locator('.sch-item', { hasText: '早的' });
  await soon.getByRole('button', { name: '試跑' }).click();
  await page.waitForFunction(() => window.__sent.length === 1);
  assert.deepEqual(await page.evaluate(() => window.__sent[0]), { type: 'poster:start', id: 'soon', dryRun: true, mode: 'post' });

  await soon.getByRole('button', { name: '立即發佈' }).click();
  assert.equal(await page.locator('#confirmOverlay.open').count(), 1);
  assert.equal(await page.evaluate(() => window.__sent.length), 1);            // 還沒確認就沒送
  await page.click('#confirmCancelBtn');
  assert.equal(await page.evaluate(() => window.__sent.length), 1);
  await soon.getByRole('button', { name: '立即發佈' }).click();
  await page.click('#confirmOkBtn');
  await page.waitForFunction(() => window.__sent.length === 2);
  assert.deepEqual(await page.evaluate(() => window.__sent[1]), { type: 'poster:start', id: 'soon', dryRun: false, mode: 'post' });

  await soon.getByRole('button', { name: '刪除' }).click();
  await page.waitForFunction(() => window.__data.fbQueue.length === 5);
  assert.ok(!(await queued(page)).some(i => i.id === 'soon'));
});

test('「失敗：可能已經發出」重新發佈前，確認視窗會先警告可能重複發文', { skip }, async t => {
  const { page } = await open(t, { queue: [item({ id: 'u', status: 'failed', step: 'publishing', error: '已按下發佈但沒收到結果，貼文可能已經發出', at: Date.now() - 1000 })] });
  await page.getByRole('button', { name: '重新發佈' }).click();
  assert.match(await page.locator('#confirmMessage').textContent(), /可能已經發出去了/);
});

// ---- 粉專下拉選單、小編文、留言預覽、編輯 ---------------------------------------
const NEWS = 'https://www.facebook.com/tvbsfb/', TEA = 'https://www.facebook.com/tvbsteatimenews', ROOM = 'https://www.facebook.com/2100room';
const ART = 'https://news.tvbs.com.tw/politics/4039103';
const preview = page => page.locator('#schCommentPreview');

test('粉專下拉選單：自訂／新聞粉／娛樂粉／少康粉；選了會填入網址；網址欄仍可自己輸入，選單跟著對應', { skip }, async t => {
  const { page } = await open(t);
  assert.deepEqual(await page.locator('#schPreset option').allTextContents(), ['自訂', '新聞粉', '娛樂粉', '少康粉']);
  // 下拉選單在網址輸入框的左邊
  assert.ok(await page.evaluate(() => document.getElementById('schPreset').compareDocumentPosition(document.getElementById('schPage')) & Node.DOCUMENT_POSITION_FOLLOWING));
  for (const [label, url] of [['新聞粉', NEWS], ['娛樂粉', TEA], ['少康粉', ROOM]]) {
    await page.selectOption('#schPreset', { label });
    assert.equal(await page.inputValue('#schPage'), url, label);
  }
  await page.fill('#schPage', 'https://www.facebook.com/someoneelse');
  assert.equal(await page.inputValue('#schPreset'), '');
  await page.fill('#schPage', 'https://facebook.com/tvbsfb');
  await page.locator('#schPage').blur();   // 輸入完離開輸入框才會記住
  assert.equal(await page.locator('#schPreset option:checked').textContent(), '新聞粉');
  assert.equal(await page.evaluate(() => window.__data.fbPageUrl), 'https://www.facebook.com/tvbsfb');   // 記住最後用的粉專
});

test('小編文欄位在「發佈時間」上面；留言預覽依粉專與有沒有圖片帶不同追蹤碼', { skip }, async t => {
  const { page } = await open(t);
  assert.ok(await page.evaluate(() => document.getElementById('schNote').compareDocumentPosition(document.getElementById('schAt')) & Node.DOCUMENT_POSITION_FOLLOWING));
  assert.equal(await preview(page).isHidden(), true);
  await page.fill('#schNote', '你也這樣覺得嗎？👀');
  await page.fill('#schArticle', ART);
  const want = { 新聞粉: ['fbarticlecomments', 'fbarticlepic'], 娛樂粉: ['tvbsteatimenewscomments', 'tvbsteatimenewspic'], 少康粉: ['2100roomcomments', '2100roompic'] };
  for (const [label, [textMedium, picMedium]] of Object.entries(want)) {
    await page.selectOption('#schPreset', { label });
    assert.equal(await preview(page).textContent(), `發佈後會自動留言：\n你也這樣覺得嗎？👀\n${ART}?&utm_source=facebook&utm_medium=${textMedium}`, label);
    await page.setInputFiles('#schFile', { name: 'a.png', mimeType: 'image/png', buffer: PNG_BYTES });
    await page.waitForFunction(() => document.querySelectorAll('.sch-thumb').length === 1);
    assert.match(await preview(page).textContent(), new RegExp(`utm_medium=${picMedium}$`), label + ' 有圖');
    await page.locator('.sch-thumb-x').click();
    assert.match(await preview(page).textContent(), new RegExp(`utm_medium=${textMedium}$`), label + ' 移除圖片後');
  }
  await page.fill('#schPage', 'https://www.facebook.com/someoneelse');
  assert.equal(await preview(page).textContent(), `發佈後會自動留言：\n你也這樣覺得嗎？👀\n${ART}`);   // 自訂粉專不加追蹤碼
  await page.fill('#schArticle', 'abc');
  assert.match(await preview(page).textContent(), /文章網址要是 http\(s\) 網址/);
  await page.fill('#schArticle', '');
  await page.fill('#schNote', '');
  assert.equal(await preview(page).isHidden(), true);
});

test('加入排程：小編文與文章網址一起存；文章網址格式不對會擋下', { skip }, async t => {
  const { page } = await open(t);
  await page.selectOption('#schPreset', { label: '娛樂粉' });
  await page.fill('#schText', '貼文');
  await page.fill('#schNote', '小編說');
  await page.fill('#schArticle', 'abc');
  await page.fill('#schAt', future(45));
  await page.click('#schAddBtn');
  assert.match(await page.locator('#schStatus').textContent(), /文章網址要是 http\(s\) 網址/);
  assert.equal((await queued(page)).length, 0);
  await page.fill('#schArticle', ART);
  await page.click('#schAddBtn');
  await page.waitForFunction(() => window.__data.fbQueue.length === 1);
  const [q] = await queued(page);
  assert.deepEqual({ note: q.note, articleUrl: q.articleUrl, pageUrl: q.pageUrl }, { note: '小編說', articleUrl: ART, pageUrl: TEA });
  assert.equal(await page.inputValue('#schNote'), '');
  assert.equal(await page.inputValue('#schArticle'), '');
  assert.match(await page.locator('.sch-note').textContent(), /小編說/);
});

test('帶入目前圖文：快速產圖欄的文章網址也一起帶入（不是網址就不帶）', { skip }, async t => {
  const { page } = await open(t);
  await page.fill('#qfCopyText', '【標題】');
  await page.fill('#qfUrl', ART);
  await page.click('#schFillBtn');
  await page.waitForFunction(() => document.getElementById('schArticle').value !== '');
  assert.equal(await page.inputValue('#schArticle'), ART);
  assert.match(await page.locator('#schStatus').textContent(), /文章網址/);
  await page.fill('#schArticle', '');
  await page.fill('#qfUrl', '不是網址');
  await page.click('#schFillBtn');
  await page.waitForFunction(() => /已帶入/.test(document.getElementById('schStatus').textContent));
  assert.equal(await page.inputValue('#schArticle'), '');
});

test('編輯：等待中的排程帶回表單（含圖片）、改完按「更新排程」→ 同一筆更新、仍是等待中；可取消', { skip }, async t => {
  const at = Date.now() + 7200000;
  const { page } = await open(t, { queue: [item({ id: 'e1', text: '原本的貼文', note: '原本小編文', articleUrl: ART, pageUrl: TEA, at, images: [{ name: 'a.png', dataUrl: 'data:image/png;base64,' + PNG_BYTES.toString('base64') }] })] });
  await page.getByRole('button', { name: '編輯' }).click();
  await page.waitForFunction(() => document.getElementById('schAddBtn').textContent === '更新排程');
  assert.equal(await page.inputValue('#schText'), '原本的貼文');
  assert.equal(await page.inputValue('#schNote'), '原本小編文');
  assert.equal(await page.inputValue('#schArticle'), ART);
  assert.equal(await page.inputValue('#schPage'), TEA);
  assert.equal(await page.locator('#schPreset option:checked').textContent(), '娛樂粉');
  assert.equal(await page.locator('.sch-thumb').count(), 1);
  assert.equal(await page.locator('#schEditBar').isVisible(), true);
  assert.equal(new Date(await page.inputValue('#schAt')).getTime(), new Date(at).setSeconds(0, 0));   // 時間還沒過：沿用原本的
  await page.fill('#schText', '改過的貼文');
  await page.fill('#schAt', future(180));
  await page.click('#schAddBtn');
  await page.waitForFunction(() => window.__data.fbQueue[0].text === '改過的貼文');
  const q = await queued(page);
  assert.equal(q.length, 1);
  assert.deepEqual({ id: q[0].id, status: q[0].status, note: q[0].note, images: q[0].images.length }, { id: 'e1', status: 'pending', note: '原本小編文', images: 1 });
  assert.equal(await page.locator('#schAddBtn').textContent(), '加入排程');
  assert.equal(await page.locator('#schEditBar').isHidden(), true);
  assert.equal(await page.inputValue('#schText'), '');

  await page.getByRole('button', { name: '編輯' }).click();
  await page.waitForFunction(() => document.getElementById('schAddBtn').textContent === '更新排程');
  await page.click('#schCancelEdit');
  assert.equal(await page.locator('#schAddBtn').textContent(), '加入排程');
  assert.equal(await page.inputValue('#schText'), '');
  assert.equal((await queued(page)).length, 1);
});

test('編輯：失敗／錯過的可以編輯，時間已過會提示重新選，改完回到「等待中」；執行中、已發佈的不能編輯', { skip }, async t => {
  const now = Date.now();
  const { page } = await open(t, { queue: [
    item({ id: 'f', text: '失敗的', status: 'failed', error: 'x', at: now - 600000 }),
    item({ id: 'm', text: '錯過的', status: 'missed', error: 'y', at: now - 7200000 }),
    item({ id: 'r', text: '跑中', status: 'running', step: 'text', at: now - 1000 }),
    item({ id: 'd', text: '發好的', status: 'done', finishedAt: now - 1000, at: now - 900000 })
  ] });
  assert.equal(await page.getByRole('button', { name: '編輯' }).count(), 2);
  await page.locator('.sch-item', { hasText: '失敗的' }).getByRole('button', { name: '編輯' }).click();
  await page.waitForFunction(() => document.getElementById('schAddBtn').textContent === '更新排程');
  assert.match(await page.locator('#schEditLabel').textContent(), /時間已過，請重新選時間/);
  assert.ok(new Date(await page.inputValue('#schAt')).getTime() > now + 9 * 60000);   // 預設改成未來的時間
  await page.click('#schAddBtn');
  await page.waitForFunction(() => window.__data.fbQueue.find(i => i.id === 'f').status === 'pending');
  const f = (await queued(page)).find(i => i.id === 'f');
  assert.equal(f.error, undefined);
  assert.ok(f.at > now);
});

test('已發佈的貼文：顯示留言狀態；有留言內容才有「試跑留言」「補留言」，會用 mode:comment 請外掛做', { skip }, async t => {
  const now = Date.now();
  const base = { status: 'done', finishedAt: now - 1000, at: now - 900000 };
  const { page } = await open(t, { queue: [
    item(Object.assign({ id: 'c1', text: '留言失敗的' }, base, { note: '小編', commentState: 'failed', commentError: '找不到送出按鈕' })),
    item(Object.assign({ id: 'c2', text: '留言成功的', at: now - 800000 }, base, { articleUrl: ART, commentState: 'done' })),
    item(Object.assign({ id: 'c3', text: '沒有留言內容的', at: now - 700000 }, base))
  ] });
  const failed = page.locator('.sch-item', { hasText: '留言失敗的' });
  assert.match(await failed.locator('.sch-detail.err').textContent(), /留言失敗：找不到送出按鈕/);
  assert.match(await page.locator('.sch-item', { hasText: '留言成功的' }).textContent(), /留言：已完成/);
  assert.equal(await page.locator('.sch-item', { hasText: '沒有留言內容的' }).getByRole('button', { name: /留言/ }).count(), 0);
  assert.equal(await failed.getByRole('button', { name: '編輯' }).count(), 0);

  await failed.getByRole('button', { name: '試跑留言' }).click();
  await page.waitForFunction(() => window.__sent.length === 1);
  assert.deepEqual(await page.evaluate(() => window.__sent[0]), { type: 'poster:start', id: 'c1', dryRun: true, mode: 'comment' });
  await failed.getByRole('button', { name: '補留言' }).click();
  assert.equal(await page.locator('#confirmOverlay.open').count(), 1);
  await page.click('#confirmOkBtn');
  await page.waitForFunction(() => window.__sent.length === 2);
  assert.deepEqual(await page.evaluate(() => window.__sent[1]), { type: 'poster:start', id: 'c1', dryRun: false, mode: 'comment' });
  // 已經留言成功的：按鈕改叫「再留言」，並警告會重複
  await page.locator('.sch-item', { hasText: '留言成功的' }).getByRole('button', { name: '再留言' }).click();
  assert.match(await page.locator('#confirmMessage').textContent(), /重複的留言/);
});

test('執行中的排程可以「中止」：先確認（已按下發佈／留言階段的提醒不同），確認後請外掛中止', { skip }, async t => {
  const now = Date.now();
  const { page } = await open(t, { queue: [item({ id: 'r1', text: '跑中的', status: 'running', step: 'publishing', startedAt: now - 90000, at: now - 100000 })] });
  assert.match(await page.locator('.sch-running .sch-detail').textContent(), /已 1 分 \d+ 秒/);
  await page.getByRole('button', { name: '中止' }).click();
  assert.equal(await page.locator('#confirmOverlay.open').count(), 1);
  assert.match(await page.locator('#confirmMessage').textContent(), /已經按下發佈.*先到粉專確認/);
  assert.equal(await page.evaluate(() => window.__sent.length), 0, '確認前不能中止');
  await page.click('#confirmCancelBtn');
  assert.equal(await page.evaluate(() => window.__sent.length), 0);
  await page.getByRole('button', { name: '中止' }).click();
  await page.click('#confirmOkBtn');
  await page.waitForFunction(() => window.__sent.length === 1);
  assert.deepEqual(await page.evaluate(() => window.__sent[0]), { type: 'poster:cancel', id: 'r1' });
});

test('中止的提醒依階段不同：留言階段說「貼文已經發佈，只會中止留言」，其他階段說「貼文不會發佈」', { skip }, async t => {
  const now = Date.now();
  for (const [step, re] of [['commenting', /貼文已經發佈，只會中止留言/], ['text', /貼文不會發佈/]]) {
    const { page } = await open(t, { queue: [item({ id: 'r2', status: 'running', step, startedAt: now - 5000, at: now - 9000 })] });
    await page.getByRole('button', { name: '中止' }).click();
    assert.match(await page.locator('#confirmMessage').textContent(), re, step);
  }
});

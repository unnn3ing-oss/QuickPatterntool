// Facebook 內容腳本（fbpost.js）在真的 Chromium 裡的流程測試。
// 這裡用「模擬的 Facebook 發文框」測流程邏輯：點發文框 → 輸入文字 → 上傳圖片 → （下一步）→ 發佈 → 視窗關閉，
// 以及各種失敗情況會不會誠實回報。真正的 Facebook 介面（元素、文字、改版）沒辦法在沙盒測，必須用側邊欄的「試跑」實機驗證。
// 需要 playwright：NODE_PATH=<有 playwright 的 node_modules> node --test test/fbpost.e2e.js
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

let chromium = null;
try { ({ chromium } = require('playwright')); } catch (e) { /* 沒裝 playwright：整檔略過 */ }
const skip = chromium ? false : '找不到 playwright（設 NODE_PATH 指到有 playwright 的 node_modules）';

const SCRIPT = fs.readFileSync(path.join(__dirname, '..', 'fbpost.js'), 'utf8');
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const URL_PAGE = 'https://www.facebook.com/tvbsnews';

// opts：lang 'zh'|'en'｜flow 'direct'|'next'（按鈕叫「下一步」）|'continue'（叫「繼續」，真實 Facebook 的樣子）｜close 'ok'|'never'
//       click 'normal'|'strict'（按鈕只認「有座標且按下」的真人式點擊）|'keyOnly'（只認鍵盤 Enter）|'dead'（點了沒反應）
//       multiple 是否 multiple｜noTrigger 頁面沒有發文框｜editor 'normal'|'enterOnly'（只認 Enter 鍵換行）|'noBreak'（完全不能換行）|'stubborn'（不能換行、清空會被還原）|'dup'（第一次輸入後內容莫名重複一份）
function mock(opts = {}) {
  const L = opts.lang === 'en'
    ? { trigger: "What's on your mind?", photo: 'Photo/video', post: 'Post', next: 'Next', title: 'Create post' }
    : { trigger: '在想些什麼？', photo: '相片/影片', post: '發佈', next: '下一步', title: '建立貼文' };
  return `<!doctype html><meta charset="utf-8"><title>mock fb</title>
<style>[role=dialog]{border:1px solid #888;padding:12px;margin:12px;width:420px} [contenteditable]{min-height:60px;border:1px solid #ccc}
img.thumb{width:100px;height:100px;display:inline-block} [aria-disabled=true]{opacity:.4} div[role=button]{display:inline-block;margin:4px;padding:4px;border:1px solid #aaa}</style>
<div role="navigation"><div role="button" aria-label="建立" id="nav">＋</div></div>
${opts.noTrigger ? '<p>這不是粉專頁面</p>' : `<div id="feed"><div role="button" id="trigger"><span>${L.trigger}</span></div></div>`}
<script>
window.__posted = null; window.__events = [];
document.getElementById('nav').addEventListener('click', () => window.__events.push('nav-click'));
const opts = ${JSON.stringify(opts)}, L = ${JSON.stringify(L)};
const NEXT = opts.flow === 'continue' ? '繼續' : L.next;
const btn = (label, extra='') => '<div role="button" aria-label="'+label+'" '+extra+'>'+label+'</div>';
function openDialog() {
  setTimeout(() => {
    const d = document.createElement('div'); d.setAttribute('role','dialog'); d.id = 'dlg';
    d.innerHTML = '<h2>'+L.title+'</h2><div contenteditable="true" role="textbox" id="box"></div>'
      + btn(L.photo) + '<div id="media"></div>' + btn(opts.flow === 'next' || opts.flow === 'continue' ? NEXT : L.post, 'id="go" aria-disabled="true"');
    document.body.append(d);
    const box = d.querySelector('#box'), go = d.querySelector('#go');
    box.style.whiteSpace = 'pre-wrap';
    // 模擬「編輯器不接受瀏覽器的換行指令」：任何新增的段落／換行元素或換行字元都被拿掉（除非是自己的 Enter 處理加的）
    const allowed = new WeakSet();
    if (opts.editor === 'enterOnly' || opts.editor === 'noBreak' || opts.editor === 'stubborn') {
      new MutationObserver(muts => {
        for (const m of muts) for (const n of m.addedNodes) {
          if (allowed.has(n)) continue;
          if (n.nodeType === 1 && /^(DIV|P|BR)$/.test(n.nodeName)) n.replaceWith(...n.childNodes);
          else if (n.nodeType === 3 && n.data.includes('\\n')) n.data = n.data.replace(/\\n/g, '');
        }
      }).observe(box, { childList: true, subtree: true });
    }
    if (opts.editor === 'enterOnly') {
      box.addEventListener('keydown', e => {
        if (e.key !== 'Enter') return;
        e.preventDefault();
        // 像 Lexical：Enter 在最後新增一個段落，游標放進去
        const sel = getSelection(), line = document.createElement('div'), br = document.createElement('br');
        line.append(br); allowed.add(line); allowed.add(br); box.append(line);
        const r = document.createRange(); r.setStart(line, 0); r.collapse(true); sel.removeAllRanges(); sel.addRange(r);
        box.dispatchEvent(new Event('input', { bubbles: true }));
      });
    }
    let last = '', dupTimer = null, dupDone = false;
    box.addEventListener('input', () => {
      if (box.textContent.trim()) last = box.innerHTML;
      if (opts.editor === 'dup' && !dupDone) { clearTimeout(dupTimer); dupTimer = setTimeout(() => { dupDone = true; box.innerHTML += box.innerHTML; }, 20); }
    });
    if (opts.editor === 'stubborn') new MutationObserver(() => { if (!box.textContent.trim() && last) box.innerHTML = last; }).observe(box, { childList: true, subtree: true });
    box.addEventListener('input', sync);
    function sync(){ go.setAttribute('aria-disabled', (box.innerText.trim() || d.querySelector('img.thumb')) ? 'false' : 'true'); }
    d.querySelector('[aria-label="'+L.photo+'"]').addEventListener('click', () => {
      if (d.querySelector('input[type=file]')) return;
      const inp = document.createElement('input'); inp.type = 'file'; inp.accept = 'image/*,video/*'; if (opts.multiple !== false) inp.multiple = true;
      d.append(inp);
      inp.addEventListener('change', () => {
        const files = [...inp.files]; window.__events.push('files:' + files.map(f => f.name + ':' + f.type).join(','));
        const bar = document.createElement('div'); bar.setAttribute('role','progressbar'); bar.textContent = '上傳中'; d.append(bar);
        setTimeout(() => { files.forEach(() => { const im = document.createElement('img'); im.className='thumb'; im.src='${PNG}'; d.querySelector('#media').append(im); }); bar.remove(); sync(); }, 400);
      });
    });
    function activate() {
      if (go.getAttribute('aria-disabled') === 'true') return;
      if ((opts.flow === 'next' || opts.flow === 'continue') && go.getAttribute('aria-label') === NEXT) {
        d.querySelector('#box').remove(); go.setAttribute('aria-label', L.post); go.textContent = L.post; return;
      }
      window.__events.push('publish');
      if (opts.close === 'never') return;
      setTimeout(() => {
        const box = d.querySelector('#box');
        window.__posted = { text: box ? box.innerText : '(第二畫面)', images: d.querySelectorAll('img.thumb').length };
        d.remove();
      }, 500);
    }
    let armed = false;
    if (opts.click === 'strict') {
      go.addEventListener('mousedown', e => { const r = go.getBoundingClientRect(); armed = e.buttons === 1 && e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom; });
      go.addEventListener('click', () => { if (armed) { armed = false; activate(); } });
    } else if (opts.click === 'keyOnly') {
      go.addEventListener('keydown', e => { if (e.key === 'Enter') activate(); });
    } else if (opts.click !== 'dead') {
      go.addEventListener('click', activate);
    }
  }, 250);
}
const trg = document.getElementById('trigger'); if (trg) trg.addEventListener('click', openDialog);
</script>`;
}

let browser;
test.before(async () => { if (chromium) browser = await chromium.launch(); });
test.after(async () => { if (browser) await browser.close(); });

async function open(t, opts) {
  const ctx = await browser.newContext({ viewport: { width: 900, height: 700 } });
  t.after(() => ctx.close());
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.route(URL_PAGE, r => r.fulfill({ contentType: 'text/html; charset=utf-8', body: mock(opts) }));
  await page.goto(URL_PAGE);
  // 假的 chrome：記下回報給背景的訊息，並把內容腳本註冊的處理函式留下來
  await page.evaluate(() => {
    window.__sent = [];
    window.chrome = { runtime: { id: 'me', sendMessage: m => { window.__sent.push(m); return Promise.resolve(); }, onMessage: { addListener: f => { window.__listener = f; } } } };
  });
  await page.addScriptTag({ content: SCRIPT });
  await page.evaluate(() => Object.assign(QptFbPost.T, { trigger: 800, text: 400, settle: 60, upload: 3000, enabled: 1500, closed: 1500, pressWait: 1200, hop: 100, poll: 50 }));
  // 沒有回應（忽略訊息）時回傳 undefined
  const send = (job, sender = { id: 'me' }) => page.evaluate(([j, s]) => new Promise(res => {
    window.__listener({ type: 'fbpost:run', job: j }, s, res);
    setTimeout(() => res(undefined), 300);
  }), [job, sender]);
  const result = async () => {
    await page.waitForFunction(() => window.__sent.some(m => m.type === 'fbpost:result'), null, { timeout: 15000 });
    return page.evaluate(() => ({ result: window.__sent.find(m => m.type === 'fbpost:result'), steps: window.__sent.filter(m => m.type === 'fbpost:progress').map(m => m.step) }));
  };
  return { page, errors, send, result };
}
const job = (over = {}) => Object.assign({ id: 'j1', text: '第一行\n第二行 #標籤', images: [{ name: 'a.png', dataUrl: PNG }, { name: '圖 2.jpg', dataUrl: PNG.replace('image/png', 'image/jpeg') }], dryRun: false }, over);

test('正常發佈：多行文字、2 張圖 → 貼文內容正確、依序回報各步驟、最後回報成功', { skip }, async t => {
  const { page, errors, send, result } = await open(t, {});
  assert.deepEqual(await send(job()), { started: true });
  const { result: r, steps } = await result();
  assert.equal(r.ok, true, r.error);
  assert.deepEqual(steps, ['open', 'text', 'images', 'ready', 'publishing']);
  const posted = await page.evaluate(() => window.__posted);
  assert.equal(posted.text.replace(/\n+/g, '\n').trim(), '第一行\n第二行 #標籤');
  assert.equal(posted.images, 2);
  const files = await page.evaluate(() => window.__events.find(e => e.startsWith('files:')));
  assert.equal(files, 'files:a.png:image/png,圖_2.jpg:image/jpeg');   // 檔名的空白換成底線、副檔名依格式
  assert.deepEqual(errors, []);
});

test('試跑：內容填好就停，不按發佈、視窗留著', { skip }, async t => {
  const { page, send, result } = await open(t, {});
  await send(job({ dryRun: true }));
  const { result: r, steps } = await result();
  assert.equal(r.ok, true);
  assert.equal(r.step, 'ready');
  assert.ok(!steps.includes('publishing'));
  assert.equal(await page.evaluate(() => window.__posted), null);
  assert.ok(!(await page.evaluate(() => window.__events)).includes('publish'));
  assert.equal(await page.locator('[role=dialog]').count(), 1);
  assert.match(await page.locator('#box').innerText(), /第一行/);
});

test('有「下一步」的流程（第二個畫面才有發佈）也能發出', { skip }, async t => {
  const { page, send, result } = await open(t, { flow: 'next' });
  await send(job({ images: [] }));
  const { result: r } = await result();
  assert.equal(r.ok, true, r.error);
  assert.equal((await page.evaluate(() => window.__posted)).text, '(第二畫面)');
});

test('英文介面也認得', { skip }, async t => {
  const { page, send, result } = await open(t, { lang: 'en' });
  await send(job());
  const { result: r } = await result();
  assert.equal(r.ok, true, r.error);
  assert.equal((await page.evaluate(() => window.__posted)).images, 2);
});

test('只有文字／只有圖片都可以', { skip }, async t => {
  for (const over of [{ images: [] }, { text: '' }]) {
    const { page, send, result } = await open(t, {});
    await send(job(over));
    const { result: r } = await result();
    assert.equal(r.ok, true, JSON.stringify(over) + r.error);
    const posted = await page.evaluate(() => window.__posted);
    assert.equal(posted.images, over.images ? 0 : 2);
    if (over.text === '') assert.equal(posted.text.trim(), '');
  }
});

test('上傳欄位不支援多選：圖片一張一張傳', { skip }, async t => {
  const { page, send, result } = await open(t, { multiple: false });
  await send(job());
  const { result: r } = await result();
  assert.equal(r.ok, true, r.error);
  assert.equal((await page.evaluate(() => window.__posted)).images, 2);
  assert.equal((await page.evaluate(() => window.__events.filter(e => e.startsWith('files:')))).length, 2);
});

test('找不到發文框（沒登入／不是粉專頁面）→ 回報失敗與原因，不亂點「建立」', { skip }, async t => {
  const { send, result, page } = await open(t, { noTrigger: true });
  await send(job());
  const { result: r } = await result();
  assert.equal(r.ok, false);
  assert.equal(r.step, 'open');
  assert.match(r.error, /找不到發文框/);
  assert.equal(await page.locator('[role=dialog]').count(), 0);
});

test('按了發佈但視窗沒關 → 失敗，且訊息提醒「可能沒有發出，請到粉專確認」', { skip }, async t => {
  const { send, result } = await open(t, { close: 'never' });
  await send(job());
  const { result: r } = await result();
  assert.equal(r.ok, false);
  assert.equal(r.step, 'publishing');
  assert.match(r.error, /沒有關閉/);
});

test('同一個工作重送不會重複發；別的工作在忙時回 busy；格式不對的拒絕；別的擴充功能的訊息忽略', { skip }, async t => {
  const { page, send, result } = await open(t, {});
  assert.deepEqual(await send(job()), { started: true });
  assert.deepEqual(await send(job()), { started: true });
  assert.deepEqual(await send(job({ id: 'other' })), { busy: true });
  await result();
  assert.equal((await page.evaluate(() => window.__events.filter(e => e === 'publish'))).length, 1);

  const b = await open(t, {});
  assert.deepEqual(await b.send({ id: 'x', text: 1, images: [], dryRun: false }), { started: false });
  assert.deepEqual(await b.send(job({ images: [{ name: 'x', dataUrl: 'https://evil/a.png' }] })), { started: false });
  assert.equal(await b.send(job(), { id: 'other-extension' }), undefined);
});

test('不會誤點導覽列的「建立」按鈕：只認發文框的文字（在想些什麼／建立貼文）', { skip }, async t => {
  const { page, send, result } = await open(t, {});
  await send(job({ dryRun: true }));
  await result();
  assert.ok(!(await page.evaluate(() => window.__events)).includes('nav-click'));
  assert.equal(await page.locator('[role=dialog]').count(), 1);
});

test('真實 Facebook 的第一個按鈕叫「繼續」（不是「下一步」）：要按「繼續」再按「發佈」', { skip }, async t => {
  const { page, send, result } = await open(t, { flow: 'continue' });
  await send(job());
  const { result: r } = await result();
  assert.equal(r.ok, true, r.error);
  assert.equal((await page.evaluate(() => window.__posted)).text, '(第二畫面)');
});

test('換行：編輯器只認 Enter 鍵時，改用 Enter 事件，三行不會被擠成一行', { skip }, async t => {
  const { page, send, result } = await open(t, { editor: 'enterOnly', flow: 'direct' });
  await send(job({ text: '【標題】\n（圖／TVBS）\n#霸凌 #宮廟', images: [], dryRun: true }));
  const { result: r } = await result();
  assert.equal(r.ok, true, r.error);
  const lines = (await page.locator('#box').innerText()).split('\n').map(l => l.trim()).filter(Boolean);
  assert.deepEqual(lines, ['【標題】', '（圖／TVBS）', '#霸凌 #宮廟']);
});

test('換行：每一種方式都不行時，停下來報錯，不發出擠成一行的貼文', { skip }, async t => {
  const { page, send, result } = await open(t, { editor: 'noBreak' });
  await send(job({ text: '【標題】\n（圖／TVBS）', images: [] }));
  const { result: r } = await result();
  assert.equal(r.ok, false);
  assert.match(r.error, /換行沒有成功/);
  assert.equal(await page.evaluate(() => window.__posted), null);
  assert.ok(!(await page.evaluate(() => window.__events)).includes('publish'));
});

test('單行文字不受換行檢查影響', { skip }, async t => {
  const { page, send, result } = await open(t, { editor: 'noBreak' });
  await send(job({ text: '只有一行 #標籤', images: [] }));
  const { result: r } = await result();
  assert.equal(r.ok, true, r.error);
  assert.equal((await page.evaluate(() => window.__posted)).text.trim(), '只有一行 #標籤');
});

test('「繼續」只認真人式點擊（要有座標、按下去）：第一種方式就成功，只發一次', { skip }, async t => {
  const { page, send, result } = await open(t, { flow: 'continue', click: 'strict' });
  await send(job());
  const { result: r } = await result();
  assert.equal(r.ok, true, r.error);
  assert.equal((await page.evaluate(() => window.__events.filter(e => e === 'publish'))).length, 1);
});

test('按鈕只認鍵盤 Enter：前面的點擊方式沒反應就換成鍵盤，仍然成功、只發一次', { skip }, async t => {
  const { page, send, result } = await open(t, { flow: 'continue', click: 'keyOnly' });
  await send(job());
  const { result: r } = await result();
  assert.equal(r.ok, true, r.error);
  assert.equal((await page.evaluate(() => window.__events.filter(e => e === 'publish'))).length, 1);
});

test('「繼續」怎麼點都沒反應：報錯、列出視窗裡的按鈕，不發佈', { skip }, async t => {
  const { page, send, result } = await open(t, { flow: 'continue', click: 'dead' });
  await send(job());
  const { result: r } = await result();
  assert.equal(r.ok, false);
  assert.match(r.error, /按「繼續」沒有反應（試過 4 種點擊方式）/);
  assert.match(r.error, /視窗裡的按鈕：.*繼續/);
  assert.ok(!(await page.evaluate(() => window.__events)).includes('publish'));
});

test('「發佈」只點一次：點了沒關視窗也不會再點第二次（避免重複發文）；點不動時報錯並提醒到粉專確認', { skip }, async t => {
  for (const click of ['normal', 'dead']) {
    const { page, send, result } = await open(t, { flow: 'direct', close: 'never', click });
    await send(job({ images: [] }));
    const { result: r } = await result();
    assert.equal(r.ok, false, click);
    assert.equal(r.step, 'publishing');
    assert.match(r.error, /沒有關閉.*請到粉專確認/);
    assert.equal((await page.evaluate(() => window.__events.filter(e => e === 'publish'))).length, click === 'normal' ? 1 : 0, click);
  }
});

test('發佈沿用前面步驟證明有效的點擊方式（鍵盤 Enter 的按鈕，發佈也用 Enter 一次發出）', { skip }, async t => {
  const { page, send, result } = await open(t, { flow: 'continue', click: 'keyOnly' });
  await send(job({ images: [] }));
  const { result: r } = await result();
  assert.equal(r.ok, true, r.error);
  assert.equal((await page.evaluate(() => window.__events.filter(e => e === 'publish'))).length, 1);
});

test('內容莫名重複一份：會被抓到、清空後重新輸入，最後只有一份', { skip }, async t => {
  const { page, send, result } = await open(t, { editor: 'dup' });
  await send(job({ text: '【標題】\n（圖／TVBS）\n#霸凌 #宮廟', images: [], dryRun: true }));
  const { result: r } = await result();
  assert.equal(r.ok, true, r.error);
  const lines = (await page.locator('#box').innerText()).split('\n').map(l => l.trim()).filter(Boolean);
  assert.deepEqual(lines, ['【標題】', '（圖／TVBS）', '#霸凌 #宮廟']);
});

test('文字框清不乾淨：停止輸入並報錯，內容絕不會疊成好幾份', { skip }, async t => {
  const { page, send, result } = await open(t, { editor: 'stubborn' });
  const text = '【標題】\n（圖／TVBS）\n#霸凌 #宮廟';
  await send(job({ text, images: [] }));
  const { result: r } = await result();
  assert.equal(r.ok, false);
  assert.match(r.error, /清不乾淨/);
  const got = (await page.locator('#box').innerText()).replace(/\s+/g, '');
  assert.ok(got.length <= text.replace(/\s+/g, '').length, '文字框內容超過一份：' + got);
  assert.ok(!(await page.evaluate(() => window.__events)).includes('publish'));
});

test('文字框原本就有內容（例如 Facebook 自動帶出的草稿）：先清掉再輸入，不接在後面', { skip }, async t => {
  const { page, send, result } = await open(t, {});
  await page.locator('#trigger').click();
  await page.waitForSelector('#box');
  await page.evaluate(() => { document.getElementById('box').innerText = '上次沒發完的草稿'; });
  await send(job({ images: [], dryRun: true }));
  const { result: r } = await result();
  assert.equal(r.ok, true, r.error);
  assert.ok(!(await page.locator('#box').innerText()).includes('草稿'));
});

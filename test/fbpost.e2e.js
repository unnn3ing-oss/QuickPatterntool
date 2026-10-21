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
//       multiple 是否 multiple｜noTrigger 頁面沒有發文框｜editor 'normal'|'enterOnly'（只認 Enter 鍵換行）|'noBreak'（完全不能換行）|'stubborn'（不能換行、清空會被還原）|'dup'（第一次輸入後內容莫名重複一份）|'dupLate'（輸入驗證通過之後才重複一份）
//       feed 'article'（預設，貼文是 role=article）|'plain'（動態牆完全沒有 role=article）|'wrapper'（整串動態被包在同一個 role=article 裡）｜pinned 動態牆最上面有一則置頂的舊貼文（新貼文出現在它下面）｜lazy 舊貼文在很下面、要捲動才會載入｜noTime 新貼文沒有「剛剛」時間標記
//       comment 'normal'（留言框按 Enter 送出）|'sendBtn'（Enter 沒用，要按送出鈕）|'noSubmit'（怎麼都送不出）｜noArticle 發佈後動態牆沒有出現新貼文｜stale 發佈後新貼文不會即時出現在目前頁面，要重新整理才看得到（真實 Facebook 的樣子）｜oldText 動態牆本來就有一則同文字的舊貼文
function mock(opts = {}) {
  const L = opts.lang === 'en'
    ? { trigger: "What's on your mind?", photo: 'Photo/video', post: 'Post', next: 'Next', title: 'Create post' }
    : { trigger: '在想些什麼？', photo: '相片/影片', post: '發佈', next: '下一步', title: '建立貼文' };
  return `<!doctype html><meta charset="utf-8"><title>mock fb</title>
<style>[role=dialog]{border:1px solid #888;padding:12px;margin:12px;width:420px} [contenteditable]{min-height:60px;border:1px solid #ccc}
img.thumb{width:100px;height:100px;display:inline-block} [aria-disabled=true]{opacity:.4} div[role=button]{display:inline-block;margin:4px;padding:4px;border:1px solid #aaa}</style>
<div role="navigation"><div role="button" aria-label="建立" id="nav">＋</div></div>
${opts.noTrigger ? '<p>這不是粉專頁面</p>' : `<div id="feed"><div role="button" id="trigger"><span>${L.trigger}</span></div></div>`}
<div id="posts"></div>
<script>
window.__posted = null; window.__events = []; window.__comments = [];
document.getElementById('nav').addEventListener('click', () => window.__events.push('nav-click'));
const opts = ${JSON.stringify(opts)}, L = ${JSON.stringify(L)};
const NEXT = opts.flow === 'continue' ? '繼續' : L.next;
const btn = (label, extra='') => '<div role="button" aria-label="'+label+'" '+extra+'>'+label+'</div>';
function makeArticle(text, imgs, fresh) {
  const a = document.createElement('div'); a.className = 'post';
  if (opts.feed !== 'plain') a.setAttribute('role', 'article');
  const when = fresh ? (opts.noTime ? '' : '剛剛') : '3 天';
  a.innerHTML = '<div>粉專名稱 · ' + when + '</div><div class="body"></div><div class="actions">' + btn('讚') + btn('留言') + btn('分享') + '</div><div class="cbox"></div>';
  a.querySelector('.body').textContent = text;
  for (let i = 0; i < imgs; i++) { const im = document.createElement('img'); im.className = 'thumb'; im.src = '${PNG}'; a.querySelector('.body').append(im); }
  a.querySelector('[aria-label="留言"]').addEventListener('click', () => openComment(a));
  return a;
}
function openComment(a) {
  const holder = a.querySelector('.cbox');
  if (holder.querySelector('[role=textbox]')) return;
  holder.innerHTML = '<div contenteditable="true" role="textbox" aria-label="留言為 粉專" class="cinput"></div>' + (opts.comment === 'sendBtn' ? '<div role="button" aria-label="留言" class="send">➤</div>' : '');
  const cb = holder.querySelector('.cinput'); cb.style.whiteSpace = 'pre-wrap';
  function submit() {
    const text = cb.innerText.trim(); if (!text) return;
    window.__comments.push(text);
    const c = document.createElement('div'); c.className = 'cmt'; if (opts.feed !== 'plain') { c.setAttribute('role', 'article'); c.setAttribute('aria-label', '留言由 小編'); } c.textContent = text; a.append(c);
    cb.innerHTML = '';
  }
  cb.addEventListener('keydown', e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); window.__events.push('comment-enter'); if (!opts.comment || opts.comment === 'normal') submit(); } });
  const send = holder.querySelector('.send'); if (send) send.addEventListener('click', submit);
}
const posts = document.getElementById('posts');
if (opts.feed === 'wrapper') { const w = document.createElement('div'); w.setAttribute('role', 'article'); posts.replaceWith(w); w.append(posts); }
if (opts.pinned) { const pin = makeArticle('置頂的公告貼文', 0, false); posts.parentElement.insertBefore(pin, posts); }
function fill(n, start) { for (let i = 0; i < n; i++) { const p = makeArticle('更早的第 ' + (start + i) + ' 則貼文內容', 0, false); p.style.height = '260px'; posts.append(p); } }
if (opts.lazy) {
  // 動態牆往下捲才載入更多：舊貼文（oldText）在第 21 則
  let loaded = 0; const BATCH = 7;
  const more = () => { const start = loaded; fill(BATCH, start); loaded += BATCH; if (opts.oldText && start <= 20 && 20 < loaded) { const old = makeArticle(opts.oldText, 0, false); old.style.height = '260px'; posts.children[20 - start + posts.children.length - BATCH].replaceWith(old); } };
  more();
  window.addEventListener('scroll', () => { if (window.scrollY + window.innerHeight > document.body.scrollHeight - 600 && loaded < 42) more(); });
} else {
  if (opts.oldText) posts.append(makeArticle(opts.oldText, 0, false));
  posts.append(makeArticle('更早的一則貼文', 0, false));
}
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
      if (opts.editor === 'dupLate' && !dupDone) { dupDone = true; setTimeout(() => { box.innerHTML += box.innerHTML; }, 250); }
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
        d.dataset.text = d.querySelector('#box').innerText; d.dataset.imgs = d.querySelectorAll('img.thumb').length;
        d.querySelector('#box').remove(); go.setAttribute('aria-label', L.post); go.textContent = L.post; return;
      }
      window.__events.push('publish');
      if (opts.close === 'never') return;
      setTimeout(() => {
        const box = d.querySelector('#box');
        window.__posted = { text: box ? box.innerText : '(第二畫面)', images: d.querySelectorAll('img.thumb').length };
        const articleText = d.dataset.text !== undefined ? d.dataset.text : (box ? box.innerText : '');
        const articleImgs = d.dataset.imgs !== undefined ? +d.dataset.imgs : d.querySelectorAll('img.thumb').length;
        d.remove();
        if (opts.stale) sessionStorage.setItem('__server', JSON.stringify({ text: articleText.trim(), imgs: articleImgs }));   // 只存在「伺服器」，重新整理才看得到
        else if (!opts.noArticle) setTimeout(() => document.getElementById('posts').prepend(makeArticle(articleText.trim(), articleImgs, true)), 300);
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
const srv = sessionStorage.getItem('__server');
if (srv) { const s = JSON.parse(srv); posts.prepend(makeArticle(s.text, s.imgs, true)); }
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
  // 假的 chrome：記下回報給背景的訊息，並把內容腳本註冊的處理函式留下來（頁面重新整理後要重新注入，和真的內容腳本一樣）
  const attach = async () => {
    await page.evaluate(() => {
      window.__sent = [];
      window.chrome = { runtime: { id: 'me', sendMessage: m => { window.__sent.push(m); return Promise.resolve(); }, onMessage: { addListener: f => { window.__listener = f; } } } };
    });
    await page.addScriptTag({ content: SCRIPT });
    await page.evaluate(() => Object.assign(QptFbPost.T, { trigger: 800, text: 400, settle: 60, upload: 3000, enabled: 1500, closed: 1500, pressWait: 1200, hop: 100, article: 2500, articleOld: 6000, scrollAfter: 400, scrollWait: 120, commentSent: 700, heartbeat: 150, deadline: 600000, poll: 50, afterPublish: 100 }));
  };
  await page.goto(URL_PAGE);
  await attach();
  const reload = async () => { await page.reload(); await attach(); };
  // 沒有回應（忽略訊息）時回傳 undefined
  const send = (job, sender = { id: 'me' }) => page.evaluate(([j, s]) => new Promise(res => {
    window.__listener({ type: 'fbpost:run', job: j }, s, res);
    setTimeout(() => res(undefined), 300);
  }), [job, sender]);
  const result = async () => {
    await page.waitForFunction(() => window.__sent.some(m => m.type === 'fbpost:result'), null, { timeout: 15000 });
    return page.evaluate(() => ({ result: window.__sent.find(m => m.type === 'fbpost:result'), steps: window.__sent.filter(m => m.type === 'fbpost:progress').map(m => m.step).filter((x, i, a) => i === 0 || x !== a[i - 1]) }));   // 心跳會重複回報同一步，合併連續的
  };
  return { page, errors, send, result, reload };
}
const job = (over = {}) => Object.assign({ id: 'j1', comment: '', text: '第一行\n第二行 #標籤', images: [{ name: 'a.png', dataUrl: PNG }, { name: '圖 2.jpg', dataUrl: PNG.replace('image/png', 'image/jpeg') }], dryRun: false }, over);

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

// ---- 發佈後自動留言 ------------------------------------------------------
const COMMENT = '你也這樣覺得嗎？👀\nhttps://news.tvbs.com.tw/politics/4039103?&utm_source=facebook&utm_medium=tvbsteatimenewscomments';
const comments = page => page.evaluate(() => window.__comments);
const publishes = page => page.evaluate(() => window.__events.filter(e => e === 'publish').length);

test('發佈後在剛發的貼文留言：內容與換行完全一致、只留一次、貼文不受影響', { skip }, async t => {
  const { page, send, result } = await open(t, {});
  await send(job({ comment: COMMENT }));
  const { result: r, steps } = await result();
  assert.equal(r.ok, true, r.error);
  assert.equal(r.commentState, 'done');
  assert.deepEqual(steps.slice(-3), ['publishing', 'finding', 'commenting']);
  assert.deepEqual(await comments(page), [COMMENT]);
  assert.equal(await publishes(page), 1);
  assert.equal(await page.evaluate(() => window.__events.filter(e => e === 'comment-enter').length), 1);
  // 留言在「新貼文」（最上面那則）底下
  assert.equal(await page.locator('#posts > [role=article]').first().locator('[role=article]').count(), 1);
});

test('留言框按 Enter 沒反應時，改按「送出」鈕一次（動作列那顆「留言」不能當成送出鈕）', { skip }, async t => {
  const { page, send, result } = await open(t, { comment: 'sendBtn' });
  await send(job({ comment: COMMENT }));
  const { result: r } = await result();
  assert.equal(r.ok, true, r.error);
  assert.equal(r.commentState, 'done');
  assert.deepEqual(await comments(page), [COMMENT]);
});

test('留言怎麼都送不出：貼文仍算發佈成功，留言標成失敗並說明，沒有留言被送出', { skip }, async t => {
  const { page, send, result } = await open(t, { comment: 'noSubmit' });
  await send(job({ comment: COMMENT }));
  const { result: r } = await result();
  assert.equal(r.ok, true, '貼文已經發佈，不能因為留言失敗就整筆算失敗');
  assert.equal(r.commentState, 'failed');
  assert.match(r.commentError, /找不到送出按鈕/);
  assert.deepEqual(await comments(page), []);
  assert.equal(await publishes(page), 1);
});

test('發佈後動態牆一直沒出現新貼文：不亂留言到別的貼文，留言標成失敗', { skip }, async t => {
  const { page, send, result } = await open(t, { noArticle: true });
  await send(job({ comment: COMMENT }));
  const { result: r } = await result();
  assert.equal(r.ok, true);
  assert.equal(r.commentState, 'failed');
  assert.match(r.commentError, /找不到剛發佈的貼文/);
  assert.deepEqual(await comments(page), []);
});

test('動態牆本來就有「同文字」的舊貼文：留言留在新貼文，不是舊的', { skip }, async t => {
  const text = '第一行\n第二行 #標籤';
  const { page, send, result } = await open(t, { oldText: '第一行 第二行 #標籤' });
  await send(job({ comment: COMMENT, text, images: [] }));
  const { result: r } = await result();
  assert.equal(r.ok, true, r.error);
  assert.equal(r.commentState, 'done', r.commentError);
  assert.equal(await page.locator('#posts > [role=article]').count(), 3);
  assert.equal(await page.locator('#posts > [role=article]').nth(0).locator('[role=article]').count(), 1);
  assert.equal(await page.locator('#posts > [role=article]').nth(1).locator('[role=article]').count(), 0);
});

test('只有圖片的貼文也能找到並留言', { skip }, async t => {
  const { page, send, result } = await open(t, {});
  await send(job({ text: '', comment: COMMENT }));
  const { result: r } = await result();
  assert.equal(r.ok, true, r.error);
  assert.equal(r.commentState, 'done', r.commentError);
  assert.deepEqual(await comments(page), [COMMENT]);
});

test('試跑：不發佈、也不留言', { skip }, async t => {
  const { page, send, result } = await open(t, {});
  await send(job({ comment: COMMENT, dryRun: true }));
  const { result: r, steps } = await result();
  assert.equal(r.ok, true);
  assert.equal(r.commentState, 'none');
  assert.ok(!steps.includes('commenting'));
  assert.deepEqual(await comments(page), []);
  assert.equal(await publishes(page), 0);
});

test('沒有小編文與網址（comment 是空的）：發佈完就結束，不留言', { skip }, async t => {
  const { page, send, result } = await open(t, {});
  await send(job({ comment: '' }));
  const { result: r, steps } = await result();
  assert.equal(r.ok, true, r.error);
  assert.equal(r.commentState, 'none');
  assert.ok(!steps.includes('finding'));
  assert.deepEqual(await comments(page), []);
});

test('補留言（mode:comment）：貼文已發佈，只做留言，不開發文框、不發佈', { skip }, async t => {
  const text = '第一行 第二行 #標籤';
  const { page, send, result } = await open(t, { oldText: text });
  await send({ id: 'c1', mode: 'comment', text, images: [], comment: COMMENT, dryRun: false });
  const { result: r, steps } = await result();
  assert.equal(r.ok, true, r.error);
  assert.equal(r.commentState, 'done');
  assert.deepEqual(steps, ['finding', 'commenting']);
  assert.deepEqual(await comments(page), [COMMENT]);
  assert.equal(await publishes(page), 0);
  assert.equal(await page.locator('[role=dialog]').count(), 0);
});

test('試跑留言（mode:comment＋dryRun）：留言打好了但沒有送出', { skip }, async t => {
  const text = '第一行 第二行 #標籤';
  const { page, send, result } = await open(t, { oldText: text });
  await send({ id: 'c2', mode: 'comment', text, images: [], comment: COMMENT, dryRun: true });
  const { result: r } = await result();
  assert.equal(r.ok, true, r.error);
  assert.equal(r.commentState, 'dry-ok');
  assert.deepEqual(await comments(page), []);
  assert.equal((await page.locator('.cinput').innerText()).split('\n').map(l => l.trim()).filter(Boolean).length, 2);
});

test('補留言：貼文下已經有同樣的留言就不重複留', { skip }, async t => {
  const text = '第一行 第二行 #標籤';
  const { page, send, result } = await open(t, { oldText: text });
  await send({ id: 'c3', mode: 'comment', text, images: [], comment: COMMENT, dryRun: false });
  await result();
  const again = await page.evaluate(async ([t0, c]) => {
    const out = await QptFbPost.run({ id: 'c4', mode: 'comment', text: t0, images: [], comment: c, dryRun: false }, () => {});
    return out;
  }, [text, COMMENT]);
  assert.equal(again.commentState, 'done');
  assert.match(again.commentNote, /沒有重複留言/);
  assert.deepEqual(await comments(page), [COMMENT]);
});

test('補留言但沒有留言內容：直接報錯', { skip }, async t => {
  const { send, result } = await open(t, { oldText: '第一行 第二行 #標籤' });
  await send({ id: 'c5', mode: 'comment', text: '第一行 第二行 #標籤', images: [], comment: '', dryRun: false });
  const { result: r } = await result();
  assert.equal(r.ok, false);
  assert.match(r.error, /沒有要留言的內容/);
});

test('補留言找不到貼文：報錯，不留言到別則貼文', { skip }, async t => {
  const { page, send, result } = await open(t, {});
  await send({ id: 'c6', mode: 'comment', text: '一則根本不存在的貼文內容', images: [], comment: COMMENT, dryRun: false });
  const { result: r } = await result();
  assert.equal(r.ok, false);
  assert.match(r.error, /找不到這則貼文/);
  assert.match(r.error, /頁面上：role=article \d+ 個.*「留言」鈕 \d+ 個.*含貼文開頭文字的位置 0 處/);   // 找不到時要把頁面實際長相回報出來
  assert.deepEqual(await comments(page), []);
});

test('發佈前守門：驗證通過後內容才莫名重複 → 發佈前抓到、清掉重打，貼文只有一份', { skip }, async t => {
  const { page, send, result } = await open(t, { editor: 'dupLate' });
  await send(job({ text: '【標題】\n（圖／TVBS）\n#霸凌 #宮廟' }));
  const { result: r } = await result();
  assert.equal(r.ok, true, r.error);
  const posted = await page.evaluate(() => window.__posted);
  assert.equal(posted.text.replace(/\s+/g, ''), '【標題】（圖／TVBS）#霸凌#宮廟');
  assert.equal(await publishes(page), 1);
});

// ---- 找「剛發的貼文」：Facebook 結構不同時也要找得到，找不到要說清楚 ----------------------
test('動態牆完全沒有 role=article（貼文是一般的 div）：照樣找得到剛發的貼文並留言', { skip }, async t => {
  const { page, send, result } = await open(t, { feed: 'plain' });
  assert.equal(await page.locator('[role=article]').count(), 0);
  await send(job({ comment: COMMENT }));
  const { result: r } = await result();
  assert.equal(r.ok, true, r.error);
  assert.equal(r.commentState, 'done', r.commentError);
  assert.deepEqual(await comments(page), [COMMENT]);
  assert.equal(await page.locator('#posts > .post').first().locator('.cmt').count(), 1);
  assert.equal(await page.locator('#posts > .post').nth(1).locator('.cmt').count(), 0);
});

test('整串動態被包在同一個 role=article 裡、最上面還有置頂的舊貼文、又有同文字的舊貼文：留言只留在新貼文', { skip }, async t => {
  const { page, send, result } = await open(t, { feed: 'wrapper', pinned: true, oldText: '第一行 第二行 #標籤' });
  await send(job({ comment: COMMENT, images: [] }));
  const { result: r } = await result();
  assert.equal(r.ok, true, r.error);
  assert.equal(r.commentState, 'done', r.commentError);
  assert.deepEqual(await comments(page), [COMMENT]);
  assert.equal(await page.locator('#posts > .post').count(), 3);
  assert.equal(await page.locator('#posts > .post').nth(0).locator('.cmt').count(), 1);
  assert.equal(await page.locator('#posts > .post').nth(1).locator('.cmt').count(), 0);
  assert.equal(await page.locator('#posts > .post').nth(2).locator('.cmt').count(), 0);
  assert.equal(await page.locator('.post', { hasText: '置頂的公告貼文' }).locator('.cmt').count(), 0, '不能留到置頂的貼文上');
});

test('補留言：舊貼文在很下面（動態牆要往下捲才會載入）→ 自動往下捲找到它再留言', { skip }, async t => {
  const text = '很久以前發的那一則貼文內容';
  const { page, send, result } = await open(t, { lazy: true, oldText: text });
  assert.equal(await page.locator('.post', { hasText: text }).count(), 0, '一開始不在畫面上');
  await send({ id: 'c9', mode: 'comment', text, images: [], comment: COMMENT, dryRun: false });
  const { result: r } = await result();
  assert.equal(r.ok, true, r.error);
  assert.equal(r.commentState, 'done');
  assert.deepEqual(await comments(page), [COMMENT]);
  assert.equal(await page.locator('.post', { hasText: text }).locator('.cmt').count(), 1);
});

test('找不到貼文時，錯誤訊息會附上頁面實際的結構（role=article 數、留言鈕數、最上面的貼文），方便對照真實畫面', { skip }, async t => {
  const { send, result } = await open(t, { noArticle: true });
  await send(job({ comment: COMMENT }));
  const { result: r } = await result();
  assert.equal(r.commentState, 'failed');
  assert.match(r.commentError, /找不到剛發佈的貼文/);
  assert.match(r.commentError, /role=article 1 個（最上層 1 個）、「留言」鈕 1 個、含貼文開頭文字的位置 0 處；最上面的貼文：「粉專名稱 · 3 天更早的一則貼文/);
});

test('只有圖片的新貼文沒有「剛剛」時間標記：不猜，留言標成失敗（寧可不留言，也不留到別則貼文）', { skip }, async t => {
  const { page, send, result } = await open(t, { noTime: true });
  await send(job({ text: '', comment: COMMENT }));
  const { result: r } = await result();
  assert.equal(r.ok, true);
  assert.equal(r.commentState, 'failed');
  assert.deepEqual(await comments(page), []);
});

test('補留言但貼文只有圖片：沒有文字可以找到它，直接說明並請手動留言', { skip }, async t => {
  const { send, result } = await open(t, {});
  await send({ id: 'c10', mode: 'comment', text: '', images: [], comment: COMMENT, dryRun: false });
  const { result: r } = await result();
  assert.equal(r.ok, false);
  assert.match(r.error, /只有圖片.*請手動留言/);
});

// ---- 不能卡住：心跳、期限、中止 ------------------------------------------------------
test('執行中會持續送「心跳」（同一步重複回報），背景靠它知道分頁的腳本還活著', { skip }, async t => {
  const { page, send, result } = await open(t, { close: 'never' });
  await send(job({ images: [] }));
  await result();
  const beats = await page.evaluate(() => window.__sent.filter(m => m.type === 'fbpost:progress' && m.step === 'publishing').length);
  assert.ok(beats >= 4, `心跳只有 ${beats} 次`);
});

test('整次執行有最後期限：到了就中止並回報；中止後原本的流程不會在背景繼續動作', { skip }, async t => {
  const { page, send, result } = await open(t, { close: 'never' });
  await page.evaluate(() => Object.assign(QptFbPost.T, { deadline: 900, closed: 8000 }));
  await send(job({ images: [], comment: COMMENT }));
  const { result: r } = await result();
  assert.equal(r.ok, false);
  assert.match(r.error, /超過.*分鐘還沒完成，已中止/);
  const before = await page.evaluate(() => window.__sent.length);
  await new Promise(res => setTimeout(res, 1500));
  assert.equal(await page.evaluate(() => window.__sent.filter(m => m.type === 'fbpost:result').length), 1, '只回報一次結果');
  assert.equal(await page.evaluate(() => window.__sent.length), before, '回報結果之後不能再有任何訊息（心跳停了、流程也沒有繼續動作）');
  assert.equal(await publishes(page), 1);
  assert.deepEqual(await comments(page), []);
});

test('收到「中止」：腳本立刻停手並回報失敗', { skip }, async t => {
  const { page, send, result } = await open(t, { close: 'never' });
  await page.evaluate(() => { QptFbPost.T.closed = 8000; });
  await send(job({ images: [] }));
  await page.waitForFunction(() => window.__sent.some(m => m.type === 'fbpost:progress' && m.step === 'publishing'));
  await page.evaluate(() => window.__listener({ type: 'fbpost:cancel', id: 'j1' }, { id: 'me' }, () => {}));
  const { result: r } = await result();
  assert.equal(r.ok, false);
  assert.match(r.error, /已中止|沒有關閉/);
  assert.equal(await publishes(page), 1, '中止不會再多按一次發佈');
});

// ---- 發佈後新貼文不會即時出現在目前頁面：要重新整理才找得到 ------------------------------------
const waitReloadAsk = page => page.waitForFunction(() => window.__sent.some(m => m.type === 'fbpost:reload'), null, { timeout: 15000 });

test('【重現實機問題】新貼文不會即時出現在目前頁面：沒重新整理就找不到貼文，留言標成失敗、不亂留言', { skip }, async t => {
  const { page, send, result } = await open(t, { stale: true });
  await send(job({ comment: COMMENT }));   // 沒有 reload 旗標＝舊行為
  const { result: r } = await result();
  assert.equal(r.ok, true, r.error);
  assert.equal(r.commentState, 'failed');
  assert.match(r.commentError, /找不到剛發佈的貼文/);
  assert.deepEqual(await comments(page), []);
});

test('發佈後請背景重新整理（回報 reload、不回報結果）→ 重新整理後交付「只留言」的工作 → 留言到新貼文', { skip }, async t => {
  const { page, send, result, reload } = await open(t, { stale: true });
  await send(job({ comment: COMMENT, reload: true }));
  await waitReloadAsk(page);
  const first = await page.evaluate(() => ({ results: window.__sent.filter(m => m.type === 'fbpost:result').length, steps: window.__sent.filter(m => m.type === 'fbpost:progress').map(m => m.step).filter((x, i, a) => i === 0 || x !== a[i - 1]) }));
  assert.equal(first.results, 0, '發佈階段不能先回報結果，否則背景會把它當成完成並關掉分頁');
  assert.deepEqual(first.steps, ['open', 'text', 'images', 'ready', 'publishing', 'reloading']);
  assert.equal(await publishes(page), 1);
  await reload();   // 背景把分頁重新整理，內容腳本重新注入
  assert.match(await page.locator('#posts > [role=article]').first().innerText(), /第一行/, '重新整理後新貼文出現在最上面');
  assert.deepEqual(await send({ id: 'j1', mode: 'comment', fresh: true, text: job().text, images: [], comment: COMMENT, dryRun: false }), { started: true });
  const { result: r, steps } = await result();
  assert.equal(r.ok, true, r.error);
  assert.equal(r.commentState, 'done');
  assert.deepEqual(steps, ['finding', 'commenting']);
  assert.deepEqual(await comments(page), [COMMENT]);
  assert.equal(await page.locator('#posts > [role=article]').first().locator('[role=article]').count(), 1);
});

test('重新整理後只有圖片的貼文：認最上面帶「剛剛」標記的新貼文再留言', { skip }, async t => {
  const { page, send, result, reload } = await open(t, { stale: true });
  await send(job({ text: '', comment: COMMENT, reload: true }));
  await waitReloadAsk(page);
  await reload();
  await send({ id: 'j1', mode: 'comment', fresh: true, text: '', images: [], comment: COMMENT, dryRun: false });
  const { result: r } = await result();
  assert.equal(r.ok, true, r.error);
  assert.equal(r.commentState, 'done', r.commentError);
  assert.deepEqual(await comments(page), [COMMENT]);
});

test('補留言（非 fresh）遇到只有圖片的舊貼文，仍然直接說明、不猜', { skip }, async t => {
  const { send, result } = await open(t, {});
  await send({ id: 'c1', mode: 'comment', text: '', images: [], comment: COMMENT, dryRun: false });
  const { result: r } = await result();
  assert.equal(r.ok, false);
  assert.match(r.error, /只有圖片/);
});

test('沒有留言內容或試跑時，發佈完不會要求重新整理', { skip }, async t => {
  const a = await open(t, {});
  await a.send(job({ comment: '', reload: true }));
  const { result: r1 } = await a.result();
  assert.equal(r1.ok, true, r1.error);
  assert.equal(await a.page.evaluate(() => window.__sent.some(m => m.type === 'fbpost:reload')), false);
  const b = await open(t, {});
  await b.send(job({ comment: COMMENT, reload: true, dryRun: true }));
  const { result: r2 } = await b.result();
  assert.equal(r2.ok, true, r2.error);
  assert.equal(await b.page.evaluate(() => window.__sent.some(m => m.type === 'fbpost:reload')), false);
});

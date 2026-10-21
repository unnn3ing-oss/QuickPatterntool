// Facebook 粉專發文的內容腳本：只注入 https://www.facebook.com/*。
// 背景（poster.js）到點開好粉專分頁後，傳 fbpost:run 進來；這裡照人的操作順序做：
//   點「建立貼文」→ 在編輯視窗輸入文字 → 上傳圖片 → （下一步）→ 按「發佈」→ 等視窗關閉，
// 每一步回報 fbpost:progress，最後回報 fbpost:result。dryRun（試跑）做到「內容填好」就停，不按發佈。
//
// Facebook 的 class 名稱是混淆過、天天在變的，所以這裡完全不用 class，只靠
// 「角色（role）＋看得到的字／aria-label」找元素，並且每一步都驗證結果（文字有進去、圖片縮圖有出現、視窗有關閉），
// 驗證不過就報錯，不會假裝成功。介面文字同時支援繁體中文與英文。
// 純函式與流程都掛在 QptFbPost 上，方便在模擬頁面（test/fbpost.e2e.js）測試。
(function (root) {
  const LABELS = {
    trigger: [/在想些什麼/, /建立貼文/, /What'?s on your mind/i, /Create (a )?post/i, /Write something/i],
    photo: [/^相片\/影片$/, /^相片$/, /^照片\/影片$/, /^照片$/, /^Photo\/video$/i, /^Photo$/i],
    publish: [/^發佈$/, /^發布$/, /^Post$/i, /^Publish$/i],
    next: [/^下一步$/, /^Next$/i]
  };
  const TEXTBOX = '[contenteditable="true"][role="textbox"]';
  const MAX_LABEL = 60;
  // 各步驟等待上限（毫秒）；測試時會調小
  const T = { trigger: 30000, dialog: 20000, input: 15000, text: 1500, upload: 120000, enabled: 30000, closed: 120000, poll: 250 };

  const sleep = ms => new Promise(r => setTimeout(r, ms));
  async function waitFor(fn, timeout) {
    const end = Date.now() + timeout;
    for (;;) {
      let v = null;
      try { v = fn(); } catch (e) { /* 頁面重畫中，下一輪再試 */ }
      if (v) return v;
      if (Date.now() >= end) return null;
      await sleep(T.poll);
    }
  }
  const fail = msg => { throw new Error(msg); };

  const isVisible = el => !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length);
  const labelOf = el => (el.getAttribute('aria-label') || el.textContent || '').replace(/\s+/g, ' ').trim();
  const matches = (label, patterns) => patterns.some(re => re.test(label));
  const isEnabled = el => !el.disabled && el.getAttribute('aria-disabled') !== 'true';

  // 在 scope 裡找「看得到、字或 aria-label 符合」的按鈕
  function findButton(scope, patterns, { enabled = false, outsideDialog = false } = {}) {
    for (const el of scope.querySelectorAll('[role="button"], button, [aria-label]')) {
      if (!isVisible(el)) continue;
      if (outsideDialog && el.closest('[role="dialog"]')) continue;
      const label = labelOf(el);
      if (!label || label.length > MAX_LABEL || !matches(label, patterns)) continue;
      if (enabled && !isEnabled(el)) continue;
      return el;
    }
    return null;
  }

  // 發文的編輯視窗：有輸入框的 dialog。strict:false 時只要有「發佈／下一步」也算（按「下一步」後輸入框可能不在了）
  function findDialog(strict = true) {
    for (const d of document.querySelectorAll('[role="dialog"]')) {
      if (!isVisible(d)) continue;
      if (d.querySelector(TEXTBOX)) return d;
      if (!strict && (findButton(d, LABELS.publish) || findButton(d, LABELS.next))) return d;
    }
    return null;
  }
  const findLooseDialog = () => findDialog(false);
  const findTrigger = () => findButton(document, LABELS.trigger, { outsideDialog: true });

  // 點擊：依序送出完整的滑鼠事件，React 才認得
  function press(el) {
    el.scrollIntoView({ block: 'center' });
    for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']) {
      const Ev = type.startsWith('pointer') && typeof PointerEvent === 'function' ? PointerEvent : MouseEvent;
      el.dispatchEvent(new Ev(type, { bubbles: true, cancelable: true, view: window }));
    }
  }

  // ---- 文字 ------------------------------------------------------------
  const squash = s => s.replace(/\s+/g, '');
  const boxText = box => squash(box ? (box.innerText || box.textContent || '') : '');
  const textBox = () => { const d = findDialog(); return d ? d.querySelector(TEXTBOX) : null; };

  // 用瀏覽器的編輯指令輸入，Facebook 的編輯器（Lexical）才會收到真正的輸入事件
  function typeWithExec(box, text) {
    box.focus();
    const lines = text.replace(/\r\n?/g, '\n').split('\n');
    lines.forEach((line, i) => {
      if (i > 0) document.execCommand('insertParagraph');
      if (line) document.execCommand('insertText', false, line);
    });
  }
  // 備用：模擬貼上
  function typeWithPaste(box, text) {
    box.focus();
    document.execCommand('selectAll');
    document.execCommand('delete');
    const dt = new DataTransfer();
    dt.setData('text/plain', text);
    box.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
  }
  async function setText(text) {
    const head = squash(text).slice(0, 40);
    const has = () => boxText(textBox()).includes(head);
    for (const type of [typeWithExec, typeWithPaste]) {
      const box = textBox();
      if (!box) fail('找不到文字輸入框');
      type(box, text);
      if (await waitFor(has, T.text)) return;
    }
    fail('文字沒有輸入成功（Facebook 編輯器沒有接受輸入）');
  }

  // ---- 圖片 ------------------------------------------------------------
  function dataUrlToFile(dataUrl, name) {
    const comma = dataUrl.indexOf(',');
    const mime = (dataUrl.slice(5, comma).match(/^[^;]+/) || ['image/png'])[0];
    const bin = atob(dataUrl.slice(comma + 1));
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    const ext = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif' }[mime] || 'png';
    const base = String(name || 'image').replace(/\.[a-z0-9]+$/i, '').replace(/[^\w一-鿿-]+/g, '_').slice(0, 60) || 'image';
    return new File([bytes], `${base}.${ext}`, { type: mime });
  }
  function findFileInput() {
    const d = findLooseDialog();
    const all = [...(d ? d.querySelectorAll('input[type="file"]') : []), ...document.querySelectorAll('input[type="file"]')];
    return all.find(i => /image/i.test(i.accept || '')) || null;
  }
  // 視窗裡「夠大的圖片／影片」數量：上傳完成後縮圖會出現（頭像等小圖不算）
  function countMedia(d) {
    if (!d) return 0;
    return [...d.querySelectorAll('img, video')].filter(el => isVisible(el) && el.getBoundingClientRect().width >= 80).length;
  }
  const uploading = d => !!d && [...d.querySelectorAll('[role="progressbar"]')].some(isVisible);

  async function attachImages(images) {
    let remaining = images.slice();
    while (remaining.length) {
      const base = countMedia(findLooseDialog());
      let input = findFileInput();
      if (!input) {
        const d = findLooseDialog();
        const btn = d && findButton(d, LABELS.photo);
        if (!btn) fail('找不到「相片／影片」按鈕');
        press(btn);
        input = await waitFor(findFileInput, T.input);
        if (!input) fail('找不到上傳圖片的欄位');
      }
      const batch = input.multiple ? remaining.splice(0) : remaining.splice(0, 1);
      const dt = new DataTransfer();
      batch.forEach((im, i) => dt.items.add(dataUrlToFile(im.dataUrl, im.name || `image-${i + 1}`)));
      input.files = dt.files;
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
      // 縮圖出現（Facebook 超過幾張會折疊成「+N」，所以最多只要求 3 張）且沒有上傳進度條
      const expected = Math.min(batch.length, 3);
      const done = await waitFor(() => { const d = findLooseDialog(); return d && countMedia(d) >= base + expected && !uploading(d); }, T.upload);
      if (!done) fail('圖片上傳逾時或沒有出現縮圖');
    }
  }

  // ---- 發佈 ------------------------------------------------------------
  async function publish(onPublishing) {
    let pressed = false;
    for (let hop = 0; hop < 4 && !pressed; hop++) {
      const btn = await waitFor(() => {
        const d = findLooseDialog();
        return d && (findButton(d, LABELS.publish, { enabled: true }) || findButton(d, LABELS.next, { enabled: true }));
      }, T.enabled);
      if (!btn) fail('找不到可以按的「發佈」按鈕（內容可能不符規定，或圖片還在處理）');
      if (matches(labelOf(btn), LABELS.publish)) { onPublishing(); press(btn); pressed = true; }
      else { press(btn); await sleep(1200); }   // 「下一步」：進入第二個畫面
    }
    if (!pressed) fail('按了「下一步」之後仍然沒有出現「發佈」按鈕');
    // 發佈成功＝編輯視窗關掉。多等一下確認不是短暫消失
    const closed = await waitFor(() => !findLooseDialog(), T.closed);
    if (closed) await sleep(Math.min(1500, T.closed));
    if (!closed || findLooseDialog()) fail('按下發佈後編輯視窗沒有關閉，貼文可能沒有發出，請到粉專確認');
  }

  // ---- 主流程 ----------------------------------------------------------
  // report(type, payload)：回報給背景。回傳最後一個步驟；失敗時丟出帶 step 的 Error。
  async function run(job, report) {
    let step = 'open';
    const go = s => { step = s; report('progress', { step: s }); };
    try {
      go('open');
      if (!findDialog()) {
        const trigger = await waitFor(findTrigger, T.trigger);
        if (!trigger) fail('找不到發文框（請確認已登入，並已在 Facebook 切換成粉專身分）');
        press(trigger);
        if (!await waitFor(findDialog, T.dialog)) fail('點了發文框，但沒有跳出編輯視窗');
      }
      go('text');
      if (job.text.trim()) await setText(job.text);
      if (job.images.length) { go('images'); await attachImages(job.images); }
      go('ready');
      if (!job.dryRun) await publish(() => go('publishing'));
      return step;
    } catch (e) {
      e.step = step;
      throw e;
    }
  }

  function validJob(j) {
    return !!j && typeof j.id === 'string' && typeof j.text === 'string' && Array.isArray(j.images) && typeof j.dryRun === 'boolean'
      && j.images.every(im => im && typeof im.dataUrl === 'string' && /^data:image\//.test(im.dataUrl));
  }

  // ---- 接線（只在擴充功能有效的頁面註冊）------------------------------------
  let current = null;   // 正在跑或剛跑完的工作 id：背景重送同一個工作時不會重複執行
  function listen() {
    chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
      if (!msg || msg.type !== 'fbpost:run' || sender.id !== chrome.runtime.id) return;
      const job = msg.job;
      if (!validJob(job)) { sendResponse({ started: false }); return; }
      if (current) { sendResponse(current === job.id ? { started: true } : { busy: true }); return; }
      current = job.id;
      sendResponse({ started: true });
      const report = (type, payload) => {
        try { Promise.resolve(chrome.runtime.sendMessage(Object.assign({ type: 'fbpost:' + type, id: job.id }, payload))).catch(() => {}); }
        catch (e) { /* 擴充功能重新載入了：背景的卡住監看會收尾 */ }
      };
      run(job, report).then(
        step => report('result', { ok: true, step }),
        e => report('result', { ok: false, step: e.step, error: e.message || String(e) })
      );
    });
  }
  if (typeof document !== 'undefined' && typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.id && chrome.runtime.onMessage) listen();

  root.QptFbPost = { run, T, LABELS, findDialog, findTrigger, dataUrlToFile, validJob };
  if (typeof module !== 'undefined' && module.exports) module.exports = root.QptFbPost;
})(typeof self !== 'undefined' ? self : this);

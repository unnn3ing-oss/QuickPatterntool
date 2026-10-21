// Facebook 粉專發文的內容腳本：只注入 https://www.facebook.com/*。
// 背景（poster.js）到點開好粉專分頁後，傳 fbpost:run 進來；這裡照人的操作順序做：
//   點「建立貼文」→ 在編輯視窗輸入文字 → 上傳圖片 → （下一步）→ 按「發佈」→ 等視窗關閉 → 找到剛發的貼文留言，
// 每一步回報 fbpost:progress，最後回報 fbpost:result。dryRun（試跑）做到「內容填好」就停，不按發佈、不留言。
// mode:'comment' 只做最後的留言（貼文已經發佈，補留言用）。
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
    next: [/^下一步$/, /^繼續$/, /^Next$/i, /^Continue$/i],
    commentBtn: [/^留言$/, /^發表留言$/, /^Comment$/i, /^Leave a comment$/i],
    send: [/^留言$/, /^發佈留言$/, /^發表$/, /^送出$/, /^Comment$/i, /^Post comment$/i, /^Send$/i]
  };
  const TEXTBOX = '[contenteditable="true"][role="textbox"]';
  const MAX_LABEL = 60;
  // 各步驟等待上限（毫秒）；測試時會調小
  const T = { trigger: 30000, text: 1500, settle: 250, upload: 120000, enabled: 30000, closed: 120000, pressWait: 5000, hop: 1200, article: 30000, commentSent: 6000, poll: 250 };

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

  // ---- 點擊 ------------------------------------------------------------
  // Facebook 的按鈕常檢查滑鼠座標與按鍵狀態，所以第一種做法送出「像真人」的完整事件（有座標、按下時 buttons=1）；
  // 不行再換 el.click()、鍵盤 Enter、鍵盤空白鍵。每種做完都要檢查畫面真的有變化（見 pressUntil），沒反應才換下一種。
  function pressMouse(el) {
    el.scrollIntoView({ block: 'center' });
    const r = el.getBoundingClientRect();
    const x = Math.round(r.left + r.width / 2), y = Math.round(r.top + r.height / 2);
    const init = (buttons, extra) => Object.assign({
      bubbles: true, cancelable: true, composed: true, view: window, clientX: x, clientY: y, screenX: x, screenY: y,
      button: 0, buttons, pointerId: 1, pointerType: 'mouse', isPrimary: true
    }, extra);
    const Pointer = typeof PointerEvent === 'function' ? PointerEvent : MouseEvent;
    [['pointerover', Pointer, 0], ['mouseover', MouseEvent, 0], ['pointermove', Pointer, 0], ['mousemove', MouseEvent, 0],
      ['pointerdown', Pointer, 1], ['mousedown', MouseEvent, 1], ['pointerup', Pointer, 0], ['mouseup', MouseEvent, 0],
      ['click', MouseEvent, 0, { detail: 1 }]
    ].forEach(([type, Ev, buttons, extra]) => el.dispatchEvent(new Ev(type, init(buttons, extra))));
  }
  function pressKey(el, key) {
    if (el.focus) el.focus();
    const code = key === ' ' ? 'Space' : 'Enter', kc = key === ' ' ? 32 : 13;
    for (const type of ['keydown', 'keypress', 'keyup']) {
      el.dispatchEvent(new KeyboardEvent(type, { key, code, keyCode: kc, which: kc, bubbles: true, cancelable: true }));
    }
  }
  const METHODS = [pressMouse, el => el.click(), el => pressKey(el, 'Enter'), el => pressKey(el, ' ')];
  // 依序用各種方式點 el，每種之後等 effect() 成立；成立就停（不會重複點），並記住這種方式。全部沒反應回 false。
  // 只能用在「重複點也沒副作用」的按鈕（開發文框、相片／影片、繼續）。
  let preferred = 0;
  async function pressUntil(el, effect, ms) {
    const order = METHODS.map((m, i) => i).sort((a, b) => (a === preferred ? -1 : b === preferred ? 1 : a - b));
    for (const i of order) {
      if (!el.isConnected) return !!effect();
      METHODS[i](el);
      if (await waitFor(effect, ms)) { preferred = i; return true; }
    }
    return false;
  }
  // 「發佈」只點一次：就算第一次已經發出、畫面卻沒變，也絕不再點，否則會重複發文。
  // 用前面步驟證明有效的點擊方式；有沒有成功由「視窗是否關閉」判斷。
  function pressOnce(el) { METHODS[preferred](el); }
  // 失敗時附上畫面上有哪些按鈕，方便判斷是改版還是別的原因
  function visibleButtons(scope) {
    const seen = [];
    for (const el of (scope || document).querySelectorAll('[role="button"], button')) {
      const l = isVisible(el) ? labelOf(el) : '';
      if (l && l.length <= 24 && !seen.includes(l)) seen.push(l);
    }
    return seen.slice(0, 14).join('、');
  }
  const shown = () => { const d = findLooseDialog(); return d ? `（視窗裡的按鈕：${visibleButtons(d) || '無'}）` : '（找不到發文視窗）'; };

  // ---- 文字 ------------------------------------------------------------
  const squash = s => s.replace(/\s+/g, '');
  const boxText = box => squash(box ? (box.innerText || box.textContent || '') : '');
  const textBox = () => { const d = findDialog(); return d ? d.querySelector(TEXTBOX) : null; };
  const occurrences = (hay, needle) => (needle ? hay.split(needle).length - 1 : 0);

  // 換行的幾種做法，依序嘗試：Facebook 的編輯器（Lexical）有時不接受某一種，所以每種都要驗證換行真的出現。
  const BREAKS = [
    () => document.execCommand('insertParagraph'),
    () => document.execCommand('insertLineBreak'),
    box => box.dispatchEvent(new InputEvent('beforeinput', { inputType: 'insertParagraph', bubbles: true, cancelable: true })),
    box => ['keydown', 'keypress', 'keyup'].forEach(type =>
      box.dispatchEvent(new KeyboardEvent(type, { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true })))
  ];
  // 留言框裡單按 Enter 會「送出留言」，所以換行只能用 Shift+Enter 或編輯指令，絕不能送出單純的 Enter
  const COMMENT_BREAKS = [
    () => document.execCommand('insertLineBreak'),
    box => box.dispatchEvent(new InputEvent('beforeinput', { inputType: 'insertLineBreak', bubbles: true, cancelable: true })),
    box => ['keydown', 'keypress', 'keyup'].forEach(type =>
      box.dispatchEvent(new KeyboardEvent(type, { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, shiftKey: true, bubbles: true, cancelable: true }))),
    () => document.execCommand('insertParagraph')
  ];
  const normLines = s => s.replace(/\r\n?/g, '\n').split('\n').map(l => l.trim()).filter(Boolean);
  // 清空文字框：幾種方式輪流試，每種之後確認真的空了。清不乾淨就回 false（呼叫端必須停下來，不能在舊內容上疊加）
  const CLEARS = [
    b => { b.focus(); document.execCommand('selectAll'); document.execCommand('delete'); },
    b => { b.focus(); getSelection().selectAllChildren(b); document.execCommand('delete'); },
    b => {
      b.focus(); document.execCommand('selectAll');
      ['keydown', 'keyup'].forEach(type => b.dispatchEvent(new KeyboardEvent(type, { key: 'Backspace', code: 'Backspace', keyCode: 8, which: 8, bubbles: true, cancelable: true })));
    }
  ];
  async function emptyBox(getBox) {
    for (const clear of CLEARS) {
      const box = getBox();
      if (!box) return false;
      if (boxText(box) === '') return true;
      clear(box);
      await sleep(T.settle);
      if (boxText(getBox()) === '') return true;
    }
    return boxText(getBox()) === '';
  }
  // 用瀏覽器的編輯指令輸入，Facebook 的編輯器才會收到真正的輸入事件
  function typeWithExec(box, text, brk) {
    box.focus();
    text.replace(/\r\n?/g, '\n').split('\n').forEach((line, i) => {
      if (i > 0) brk(box);
      if (line) document.execCommand('insertText', false, line);
    });
  }
  // 備用：模擬貼上
  function typeWithPaste(box, text) {
    box.focus();
    const dt = new DataTransfer();
    dt.setData('text/plain', text);
    box.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
  }
  // 判斷文字框內容對不對：頭尾都在、「只出現一份」、長度和預期相近、有內容的行數相同（沒被擠成一行）
  function inspectBox(box, text) {
    const wantSq = squash(text);
    const head = wantSq.slice(0, 40), tail = wantSq.slice(-20);
    const tolerance = Math.max(4, Math.round(wantSq.length * 0.05));
    if (!box) return { ok: false, why: '找不到文字框' };
    const got = boxText(box);
    const lines = normLines(box.innerText || box.textContent || '').length;
    const wantLines = normLines(text).length;
    // 開頭出現的次數要和原文一樣（原文本身重複的字句不算）；多出來就是內容重複了
    const copies = occurrences(got, head), wantCopies = occurrences(wantSq, head);
    const ok = got.includes(head) && got.includes(tail) && copies === wantCopies && Math.abs(got.length - wantSq.length) <= tolerance && lines === wantLines;
    return { ok, copies, why: `文字框內容長度 ${got.length}（預期 ${wantSq.length}）、行數 ${lines}（預期 ${wantLines}）、開頭出現 ${copies} 次（預期 ${wantCopies}）` };
  }
  // 把 text 輸入文字框（getBox 每次重新取，因為編輯器會重畫）。每次輸入前文字框都必須是空的：清不掉就停止，
  // 絕不在舊內容上疊加（否則內容會重複好幾份）。換行用 breaks 裡的方式依序試，每種都驗證。
  async function typeInto({ getBox, text, breaks, what }) {
    const multi = normLines(text).length > 1;
    const attempts = multi ? breaks.map(brk => box => typeWithExec(box, text, brk)) : [box => typeWithExec(box, text, breaks[0])];
    attempts.push(box => typeWithPaste(box, text));
    let why = '';
    for (const type of attempts) {
      if (!await emptyBox(getBox)) fail(`${what}清不乾淨，為了避免內容重複已停止輸入。` + (why ? '（' + why + '）' : ''));
      const box = getBox();
      if (!box) fail(`找不到${what}`);
      type(box);
      await sleep(T.settle);   // 編輯器常在下一個瞬間才整理畫面（可能吃掉換行），等它穩定再驗證
      if (await waitFor(() => { const c = inspectBox(getBox(), text); why = c.why; return c.ok; }, T.text)) return;
    }
    fail((multi ? `${what}有輸入但換行沒有成功（Facebook 編輯器不接受換行），已停止以免送出擠成一行的內容` : `${what}沒有輸入成功（Facebook 編輯器沒有接受輸入）`) + `（${why}）`);
  }
  const setText = text => typeInto({ getBox: textBox, text, breaks: BREAKS, what: '文字輸入框' });
  // 發佈前的最後一道守門：貼文內容必須「剛好一份」。發現重複就清掉重打一次，還是不對就停止，絕不發出重複的內容。
  async function ensureSingleCopy(text) {
    if (!text.trim()) return;
    if (inspectBox(textBox(), text).ok) return;
    await setText(text);
    const c = inspectBox(textBox(), text);
    if (!c.ok) fail(`發佈前檢查發現貼文內容不是剛好一份，已停止，沒有發佈。（${c.why}）`);
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
        if (!await pressUntil(btn, findFileInput, T.pressWait)) fail('點了「相片／影片」，但沒有出現上傳圖片的欄位' + shown());
        input = findFileInput();
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
  async function publish(onNext, onPublishing) {
    // 按下「繼續」之後的反應：按鈕消失或出現「發佈」
    const nextEffect = () => { const d = findLooseDialog(); return !d || !findButton(d, LABELS.next, { enabled: true }) || !!findButton(d, LABELS.publish, { enabled: true }); };
    let pressed = false;
    for (let hop = 0; hop < 4 && !pressed; hop++) {
      const btn = await waitFor(() => {
        const d = findLooseDialog();
        return d && (findButton(d, LABELS.publish, { enabled: true }) || findButton(d, LABELS.next, { enabled: true }));
      }, T.enabled);
      if (!btn) fail('找不到可以按的「發佈」按鈕（內容可能不符規定，或圖片還在處理）' + shown());
      if (matches(labelOf(btn), LABELS.publish)) {
        onPublishing();
        pressOnce(btn);
        pressed = true;
      } else {
        onNext();
        const name = labelOf(btn);
        if (!await pressUntil(btn, nextEffect, T.pressWait)) fail(`按「${name}」沒有反應（試過 ${METHODS.length} 種點擊方式）` + shown());
        await sleep(T.hop);   // 等第二個畫面出現
      }
    }
    if (!pressed) fail('按了「繼續」之後仍然沒有出現「發佈」按鈕' + shown());
    // 發佈成功＝編輯視窗關掉。多等一下確認不是短暫消失
    const closed = await waitFor(() => !findLooseDialog(), T.closed);
    if (closed) await sleep(Math.min(1500, T.closed));
    if (!closed || findLooseDialog()) fail('按下發佈後編輯視窗沒有關閉，貼文可能沒有發出，請到粉專確認');
  }

  // ---- 留言 ------------------------------------------------------------
  // 動態牆最上層的貼文（留言本身也是 role=article，但它們在貼文裡面，要排除）
  const topArticles = () => [...document.querySelectorAll('[role="article"]')].filter(a => isVisible(a) && !(a.parentElement && a.parentElement.closest('[role="article"]')));
  const articleSig = a => squash(a.textContent || '').slice(0, 160);
  const countSigs = list => list.reduce((m, a) => { const k = articleSig(a); m[k] = (m[k] || 0) + 1; return m; }, {});
  // 找「剛發的那則」：有文字就只看包含文字開頭的貼文；而且要是「發佈前沒有的」——同樣特徵的貼文數量比發佈前多，
  // 最上面那一則就是新的（動態牆本來就有同文字的舊貼文也不會誤認）。找不到就回 null，寧可不留言也不留到別則貼文上。
  function findPostArticle(text, before) {
    const head = squash(text || '').slice(0, 24);
    const list = topArticles();
    const now = countSigs(list);
    return list.find(a => (!head || squash(a.textContent || '').includes(head)) && now[articleSig(a)] > (before[articleSig(a)] || 0)) || null;
  }
  const commentBox = a => { const b = a && a.querySelector(TEXTBOX); return b && isVisible(b) ? b : null; };
  // 送出鈕：在留言框「後面」的按鈕（貼文動作列也有一顆「留言」，它在留言框前面，不能當成送出鈕）
  function findSendButton(article, box) {
    for (const el of article.querySelectorAll('[role="button"], button, [aria-label]')) {
      if (!isVisible(el) || !isEnabled(el) || el.contains(box) || !(box.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING)) continue;
      const label = labelOf(el);
      if (label && label.length <= MAX_LABEL && matches(label, LABELS.send)) return el;
    }
    return null;
  }
  const commentExists = (a, tail) => !!a && [...a.querySelectorAll('[role="article"]')].some(c => squash(c.textContent || '').includes(tail));
  const shownArticle = a => (a ? `（貼文裡的按鈕：${visibleButtons(a) || '無'}）` : '（找不到貼文）');

  // 「送出」鈕：和動作列的「留言」同名，所以只認「在留言框後面」的那顆
  function findSendButton(a, box) {
    if (!box) return null;
    for (const el of a.querySelectorAll('[role="button"], button, [aria-label]')) {
      if (!isVisible(el) || !isEnabled(el) || !(box.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING)) continue;
      const label = labelOf(el);
      if (label && label.length <= MAX_LABEL && matches(label, LABELS.send)) return el;
    }
    return null;
  }

  // 送出留言。只送一次：先按 Enter；按完沒反應才改按「送出」鈕一次，之後不再試（再試可能重複留言）。
  // 成功的判準：留言出現在貼文下，或留言框被清空。
  async function submitComment(getArticle, getBox, text) {
    const tail = squash(text).slice(-30);
    const sent = () => { const a = getArticle(), b = getBox(); return commentExists(a, tail) || !!(a && (!b || boxText(b) === '')); };
    const box = getBox();
    if (!box) fail('留言框不見了');
    pressKey(box, 'Enter');
    if (await waitFor(sent, T.commentSent)) return;
    const a = getArticle();
    const btn = a && findSendButton(a, getBox());
    if (!btn) fail('留言按 Enter 沒有送出，也找不到送出按鈕，請手動留言' + shownArticle(a));
    if (sent()) return;
    pressOnce(btn);
    if (!await waitFor(sent, T.commentSent)) fail('留言按了送出但沒有出現在貼文下，請到貼文確認是否已留言（未確認前請勿重複留言）');
  }

  async function postComment(job, before, go, submit) {
    const text = job.comment.trim();
    go('finding');
    const getArticle = () => findPostArticle(job.text, before);
    const article = await waitFor(getArticle, T.article);
    if (!article) fail('找不到剛發佈的貼文，沒辦法留言' + (topArticles().length ? '' : '（畫面上沒有任何貼文）'));
    if (commentExists(article, squash(text).slice(-30))) return 'exists';   // 已經留過了，不重複留
    go('commenting');
    const getBox = () => commentBox(getArticle());
    if (!getBox()) {
      const btn = findButton(article, LABELS.commentBtn);
      if (!btn) fail('找不到貼文的「留言」按鈕或留言輸入框' + shownArticle(article));
      if (!await pressUntil(btn, getBox, T.pressWait)) fail('點了「留言」，但沒有出現留言輸入框' + shownArticle(getArticle()));
    }
    await typeInto({ getBox, text, breaks: COMMENT_BREAKS, what: '留言輸入框' });
    if (!submit) return 'typed';
    await submitComment(getArticle, getBox, text);
    return 'sent';
  }

  // ---- 主流程 ----------------------------------------------------------
  // report(type, payload)：回報給背景。回傳 { step, commentState, commentError }；失敗時丟出帶 step 的 Error。
  // commentState：none 沒有要留言｜done 留言完成｜failed 貼文已發佈但留言失敗｜dry-ok 試跑留言（已輸入、沒送出）
  async function run(job, report) {
    const mode = job.mode === 'comment' ? 'comment' : 'post';
    const comment = (job.comment || '').trim();
    let step = mode === 'comment' ? 'finding' : 'open';
    const go = s => { step = s; report('progress', { step: s }); };
    const out = { commentState: 'none' };
    try {
      let before = {};
      if (mode === 'post') {
        go('open');
        if (!findDialog()) {
          const trigger = await waitFor(findTrigger, T.trigger);
          if (!trigger) fail('找不到發文框（請確認已登入，並已在 Facebook 切換成粉專身分）');
          if (!await pressUntil(trigger, findDialog, T.pressWait)) fail('點了發文框，但沒有跳出編輯視窗');
        }
        go('text');
        if (job.text.trim()) await setText(job.text);
        if (job.images.length) { go('images'); await attachImages(job.images); }
        go('ready');
        await ensureSingleCopy(job.text);
        if (job.dryRun) { out.step = step; return out; }
        before = countSigs(topArticles());
        await publish(() => go('next'), () => go('publishing'));
      }
      if (comment) {
        try {
          const r = await postComment(job, before, go, !job.dryRun);
          out.commentState = job.dryRun ? 'dry-ok' : 'done';
          if (r === 'exists') out.commentNote = '貼文下已經有這則留言，沒有重複留言';
        } catch (e) {
          if (mode === 'comment') throw e;   // 補留言本身就是這次的工作：失敗就是失敗
          out.commentState = 'failed';       // 貼文已經發佈了：留言失敗不能把整筆標成失敗
          out.commentError = e.message || String(e);
        }
      } else if (mode === 'comment') {
        fail('這筆沒有要留言的內容（小編文和文章網址都是空的）');
      }
      out.step = step;
      return out;
    } catch (e) {
      e.step = step;
      throw e;
    }
  }

  function validJob(j) {
    return !!j && typeof j.id === 'string' && typeof j.text === 'string' && Array.isArray(j.images) && typeof j.dryRun === 'boolean'
      && (j.comment === undefined || (typeof j.comment === 'string' && j.comment.length <= 5000))
      && (j.mode === undefined || j.mode === 'post' || j.mode === 'comment')
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
        out => report('result', Object.assign({ ok: true }, out)),
        e => report('result', { ok: false, step: e.step, error: e.message || String(e) })
      );
    });
  }
  if (typeof document !== 'undefined' && typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.id && chrome.runtime.onMessage) listen();

  root.QptFbPost = { run, T, LABELS, METHODS, findDialog, findTrigger, dataUrlToFile, validJob, inspectBox };
  if (typeof module !== 'undefined' && module.exports) module.exports = root.QptFbPost;
})(typeof self !== 'undefined' ? self : this);

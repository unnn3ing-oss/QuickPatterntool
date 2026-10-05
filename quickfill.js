// 側邊欄「快速產圖」：貼文章網址 → 抓標題／首圖／圖說／hashtag，
// 標題與圖帶進套版，同時組好「複製圖文格式」的文字。
//
// 需要在 app.js 之後載入（會呼叫它的 singleBgPicker 並透過 DOM 填標題）。
(function (root) {
  // ---- 標題換行 ----------------------------------------------------------------
  // 強斷點：每個空格（半形／全形）換一行（空格本身丟掉）；「！」「？」之後也換行（標點留在上一行），
  //        連續的標點和緊接著的右引號／右括號留在同一行。標題裡有幾個強斷點就一定會分成幾段。
  // 弱斷點：全形「：」。標題通常 2～3 段，所以：
  //   1) 強斷點切出來不到 3 段時，用「：」補斷，補到 3 段為止；
  //   2) 已經有 3 段以上時，「：」不拆（例：「蔡英文現身！12萬洋流挺沈伯洋　賴清德：對手認知作戰已開始」維持 3 段）；
  //   3) 但如果某一行字數太多（放不下一行、會被縮小字級），才在那行的「：」多拆一段，變 4 段。
  // 一行放得下多少：畫布標題區寬 960px ÷ 字級 67px ≈ 14.3 個全形字，所以超過 14 個全形字算太長。
  // 只認全形「：」，半形「:」常出現在時間（12:30）或網址裡，不拆。
  const STRONG_BREAK = /[！？!?]/;
  const CLOSERS = /[」』）)”’》】〕]/;
  const TARGET_LINES = 3;
  const LINE_CAPACITY = 14;   // 一行放得下的全形字數

  // 估算一行的寬度（以全形字為 1）：全形 1、英數約 0.55、其他半形符號約 0.35
  function lineWidth(text) {
    let w = 0;
    for (const ch of text) {
      if (ch.charCodeAt(0) > 0x7f) w += 1;
      else w += /[A-Za-z0-9]/.test(ch) ? 0.55 : 0.35;
    }
    return w;
  }

  function splitStrong(s) {
    const lines = [];
    let cur = '';
    const push = () => { if (cur.trim()) lines.push(cur.trim()); cur = ''; };
    for (let i = 0; i < s.length; i++) {
      const ch = s[i];
      if (/[\s　]/.test(ch)) { push(); continue; }
      cur += ch;
      if (STRONG_BREAK.test(ch)) {
        while (i + 1 < s.length && (STRONG_BREAK.test(s[i + 1]) || CLOSERS.test(s[i + 1]))) cur += s[++i];
        push();
      }
    }
    push();
    return lines;
  }

  // 在一行裡找「：」的斷點（冒號後面還有字才算；緊接著的標點、右引號留在冒號那一行）
  function colonCuts(line) {
    const cuts = [];
    for (let i = 0; i < line.length; i++) {
      if (line[i] !== '：') continue;
      let j = i;
      while (j + 1 < line.length && (line[j + 1] === '：' || STRONG_BREAK.test(line[j + 1]) || CLOSERS.test(line[j + 1]))) j++;
      if (j + 1 < line.length) cuts.push(j + 1);
      i = j;
    }
    return cuts;
  }

  // 太長的一行：在「：」拆成兩半（選讓較長那半最短的斷點），拆完還太長就再拆
  function splitIfTooLong(line) {
    if (lineWidth(line) <= LINE_CAPACITY) return [line];
    const cuts = colonCuts(line);
    if (!cuts.length) return [line];
    const cut = cuts.reduce((best, c) =>
      Math.max(lineWidth(line.slice(0, c)), lineWidth(line.slice(c))) < Math.max(lineWidth(line.slice(0, best)), lineWidth(line.slice(best))) ? c : best, cuts[0]);
    return [...splitIfTooLong(line.slice(0, cut)), ...splitIfTooLong(line.slice(cut))];
  }

  function breakTitle(title) {
    const s = String(title).replace(/\s*\n\s*/g, ' ').trim();
    let lines = splitStrong(s);

    // 1) 不到 3 段：用「：」補斷到 3 段
    let budget = TARGET_LINES - lines.length;
    if (budget > 0) {
      const topped = [];
      for (const line of lines) {
        let from = 0;
        for (const cut of colonCuts(line)) {
          if (budget <= 0) break;
          topped.push(line.slice(from, cut));
          from = cut;
          budget--;
        }
        topped.push(line.slice(from));
      }
      lines = topped;
    }

    // 2) 還有放不下一行的長句：才在「：」多拆一段（可能因此變成 4 段）
    return lines.flatMap(splitIfTooLong);
  }

  // ---- 圖說（攝影／來源）-------------------------------------------------------
  // 直接抓括號「（…）」「(…)」裡的文字，例如：
  //   （圖／王小明攝）、（示意圖／Shutterstock達志影像）、（組圖／沈伯洋辦公室提供、柯文哲臉書）
  // 不再限定開頭一定要是「圖」「示意圖」…。不過括號在內文裡也很常見（「（記者王小明／台北報導）」），
  // 所以依文字出現的位置分三級，位置越不可靠，認定越嚴格：
  //   any    ：圖片自己的 figcaption，括號裡任何文字都算（有「／」的優先）
  //   slash  ：圖片旁邊的文字、alt／title，要「短標籤／內容」的形式
  //   strict ：整頁文字裡找，標籤還必須以「圖、照、片、畫面、影像、翻攝」等結尾
  const SLASH_INNER = /^[^／/]{1,12}[／/]\s*\S/;
  const STRICT_INNER = /^[^（）()／/\s]{0,10}(?:圖|照|片|畫面|影像|翻攝|攝影)\s*[／/]\s*\S/;
  const MAX_CAPTION = 90;

  function normalizeCaption(s) {
    return s.replace(/\(/g, '（').replace(/\)/g, '）').replace(/\//, '／').replace(/\s+/g, ' ').trim();
  }

  // 找出最外層的括號群組（支援括號裡再有括號，半形全形混用）
  function parenGroups(text) {
    const out = [];
    let depth = 0, start = -1;
    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      if (ch === '（' || ch === '(') { if (depth === 0) start = i; depth++; }
      else if ((ch === '）' || ch === ')') && depth > 0) {
        depth--;
        if (depth === 0) out.push(text.slice(start, i + 1));
      }
    }
    return out;
  }

  function pickCaption(text, mode = 'slash') {
    if (!text) return '';
    const groups = parenGroups(text).filter(g => {
      const inner = g.slice(1, -1).trim();
      return inner && inner.length <= MAX_CAPTION;
    });
    const innerOf = g => g.slice(1, -1).trim();
    if (mode === 'any') {
      const hit = groups.find(g => SLASH_INNER.test(innerOf(g))) || groups[0];
      if (hit) return normalizeCaption(hit);
    } else if (mode === 'slash') {
      const hit = groups.find(g => SLASH_INNER.test(innerOf(g)));
      if (hit) return normalizeCaption(hit);
    } else {
      const hit = groups.find(g => STRICT_INNER.test(innerOf(g)));
      if (hit) return normalizeCaption(hit);
    }
    // 沒有括號、整段就是「圖／來源」的寫法時，自己補上括號
    const plain = text.trim();
    if (mode !== 'strict' && plain.length <= MAX_CAPTION && STRICT_INNER.test(plain) && !/[（）()]/.test(plain)) {
      return `（${normalizeCaption(plain)}）`;
    }
    return '';
  }

  // ---- 網頁解析 ----------------------------------------------------------------
  function meta(doc, ...keys) {
    for (const key of keys) {
      for (const el of doc.querySelectorAll('meta')) {
        const k = (el.getAttribute('property') || el.getAttribute('name') || '').toLowerCase();
        const v = (el.getAttribute('content') || '').trim();
        if (k === key && v) return v;
      }
    }
    return '';
  }
  function metaAll(doc, key) {
    return [...doc.querySelectorAll('meta')]
      .filter(el => (el.getAttribute('property') || el.getAttribute('name') || '').toLowerCase() === key)
      .map(el => (el.getAttribute('content') || '').trim())
      .filter(Boolean);
  }

  // 去掉標題尾巴的站名，例如「…｜TVBS新聞網」
  function cleanTitle(t) {
    return t.replace(/\s+/g, ' ').replace(/\s*[|｜│\-–—]\s*(?:TVBS|.{0,12}新聞網|.{0,12}娛樂).*$/i, '').trim();
  }

  function resolveUrl(u, base) {
    if (!u) return '';   // new URL('', base) 會回傳 base 本身
    try { return new URL(u, base).href; } catch (e) { return ''; }
  }
  function sameImage(a, b) {
    const strip = u => u.split(/[?#]/)[0];
    return strip(a) === strip(b);
  }
  const JUNK_IMG = /(^|[\/_.-])(logo|icon|avatar|sprite|pixel|blank|placeholder|spacer)([\/_.-]|$)/i;
  function imgSrc(img, base) {
    for (const attr of ['data-src', 'data-original', 'data-lazy-src', 'data-lazy', 'src']) {
      const v = (img.getAttribute(attr) || '').trim();
      if (v && !v.startsWith('data:')) return resolveUrl(v, base);
    }
    const srcset = (img.getAttribute('data-srcset') || img.getAttribute('srcset') || '').trim();
    if (srcset) {
      const last = srcset.split(',').pop().trim().split(/\s+/)[0];   // 通常最後一個最大張
      if (last) return resolveUrl(last, base);
    }
    return '';
  }

  // 在圖片附近找圖說：figure/figcaption → 後面幾層的相鄰文字 → alt/title
  function captionForImg(img) {
    const fig = img.closest('figure');
    if (fig) {
      const c = pickCaption((fig.querySelector('figcaption') || {}).textContent || '', 'any');
      if (c) return c;
    }
    let node = img;
    for (let depth = 0; depth < 4 && node; depth++, node = node.parentElement) {
      for (let sib = node.nextElementSibling, n = 0; sib && n < 2; sib = sib.nextElementSibling, n++) {
        if (sib.tagName === 'IMG' || sib.querySelector('img')) break;   // 那是下一張圖，圖說不屬於這張
        const text = (sib.textContent || '').trim();
        if (text.length <= 200) {
          const c = pickCaption(text, 'slash');
          if (c) return c;
        }
      }
    }
    return pickCaption(img.getAttribute('alt') || '', 'slash') || pickCaption(img.getAttribute('title') || '', 'slash');
  }

  function collectHashtags(doc) {
    const out = [];
    const add = raw => {
      const t = String(raw).replace(/^[#＃\s]+/, '').replace(/\s+/g, '').trim();
      if (t && t.length <= 30 && !out.includes(t)) out.push(t);
    };
    const scope = doc.querySelector('article') || doc.querySelector('main') || doc.body;
    // 1) 頁面上以「#」顯示的標籤連結
    scope.querySelectorAll('a').forEach(a => { if (/^[#＃]\S/.test((a.textContent || '').trim())) add(a.textContent); });
    // 2) 標籤區塊（class 含 tag／keyword／hashtag）裡的連結
    if (!out.length) {
      doc.querySelectorAll('[class*="hashtag" i] a, [class*="tags" i] a, [class*="tag-" i] a, [class*="tag_" i] a, [class*="keyword" i] a')
        .forEach(a => add(a.textContent));
    }
    // 3) 網址長得像標籤頁的連結（文章區內）
    if (!out.length) {
      scope.querySelectorAll('a[href*="/tag/"], a[href*="/tags/"], a[href*="/keyword/"]').forEach(a => add(a.textContent));
    }
    // 4) meta 標籤
    if (!out.length) metaAll(doc, 'article:tag').forEach(add);
    if (!out.length) {
      const kw = meta(doc, 'news_keywords', 'keywords');
      kw.split(/[,，、]/).forEach(add);
    }
    // 5) JSON-LD 的 keywords
    if (!out.length) {
      doc.querySelectorAll('script[type="application/ld+json"]').forEach(s => {
        try {
          const walk = v => {
            if (Array.isArray(v)) v.forEach(walk);
            else if (v && typeof v === 'object') {
              if (v.keywords) (Array.isArray(v.keywords) ? v.keywords : String(v.keywords).split(/[,，、]/)).forEach(add);
              Object.values(v).forEach(walk);
            }
          };
          walk(JSON.parse(s.textContent));
        } catch (e) { /* 不是合法 JSON 就略過 */ }
      });
    }
    return out;
  }

  // 回傳 { title, tags, images: [{url, caption}], fallbackCaption }
  function parseArticle(html, baseUrl) {
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const rawTitle = meta(doc, 'og:title', 'twitter:title')
      || ((doc.querySelector('h1') || {}).textContent || '').trim()
      || ((doc.querySelector('title') || {}).textContent || '').trim();
    const title = cleanTitle(rawTitle);

    // 內文圖片（依出現順序）；文章區優先，再補頁面其他圖片
    const scope = doc.querySelector('article') || doc.querySelector('main') || doc.body;
    const imgs = [...scope.querySelectorAll('img'), ...[...doc.querySelectorAll('img')].filter(i => !scope.contains(i))];
    const bodyImages = [];
    for (const img of imgs) {
      const url = imgSrc(img, baseUrl);
      if (!url || /\.(svg|gif)(\?|#|$)/i.test(url) || JUNK_IMG.test(url)) continue;
      if (bodyImages.some(b => sameImage(b.url, url))) continue;
      bodyImages.push({ url, caption: captionForImg(img) });
    }

    const images = [];
    const ogUrl = resolveUrl(meta(doc, 'og:image:secure_url', 'og:image', 'twitter:image', 'twitter:image:src'), baseUrl);
    const firstBodyCaption = (bodyImages.find(b => b.caption) || {}).caption || '';
    if (ogUrl) {
      const same = bodyImages.find(b => sameImage(b.url, ogUrl));
      images.push({ url: ogUrl, caption: (same && same.caption) || '' });
    }
    bodyImages.forEach(b => { if (!images.some(i => sameImage(i.url, b.url))) images.push(b); });

    const fallbackCaption = firstBodyCaption || pickCaption(scope.textContent || '', 'strict');
    return { title, tags: collectHashtags(doc), images, fallbackCaption };
  }

  // ---- 複製用的圖文格式 --------------------------------------------------------
  //   【標題】
  //   （圖／OOO 攝）
  //   #標籤 #標籤 #標籤
  function formatCopy({ title, caption, tags }) {
    const lines = [];
    if (title) lines.push(`【${title}】`);
    if (caption) lines.push(caption);
    const tagLine = (tags || []).slice(0, 3).map(t => `#${t}`).join(' ');
    if (tagLine) lines.push(tagLine);
    return lines.join('\n');
  }

  root.QuickFill = { breakTitle, parseArticle, formatCopy, pickCaption };

  // ---- 側邊欄互動 --------------------------------------------------------------
  const urlInput = document.getElementById('qfUrl');
  if (!urlInput) return;
  const runBtn = document.getElementById('qfBtn');
  const statusEl = document.getElementById('qfStatus');
  const copyText = document.getElementById('qfCopyText');
  const copyBtn = document.getElementById('qfCopyBtn');
  const titleEl = document.getElementById('title');
  const downloadBtn = document.getElementById('downloadBtn');
  const tipEl = document.getElementById('qfTip');
  const askTipEl = document.getElementById('qfAskTip');
  const askBox = document.getElementById('qfAsk');
  const askDownloadBtn = document.getElementById('qfAskDownload');
  const askEditBtn = document.getElementById('qfAskEdit');
  const MIN_W = 300, MIN_H = 200;   // 太小的圖（圖示、追蹤像素）不當背景
  let runId = 0;
  let lastRunUrl = '';   // 最近一次快速產圖用的網址；詢問中在網址欄再按 Enter（網址沒變）就當作「直接下載」

  // 功能提示：每次載入（重新載入）插件都會重新出現。
  //   「貼上連結按Enter可以產圖」：載入時顯示，使用者開始輸入、按下快速產圖、或點一下提示就收起來。
  //   「再按一次Enter即下載」：這次載入的第一張圖才顯示，同一次使用中的第二張起不再跳；重新載入後又從頭計算。
  const hideTip = () => { if (tipEl) tipEl.hidden = true; };
  let askTipShown = false;

  function setStatus(msg, kind) {
    statusEl.textContent = msg;
    statusEl.className = 'qf-status' + (kind ? ` ${kind}` : '');
  }

  function normalizeUrl(raw) {
    let s = raw.trim();
    if (!s) return '';
    if (!/^https?:\/\//i.test(s)) s = 'https://' + s;
    try { return new URL(s).href; } catch (e) { return ''; }
  }

  // 依序嘗試，抓不到或太小就換下一張
  async function loadFirstUsableImage(cands, onTry) {
    for (let i = 0; i < cands.length; i++) {
      onTry(i, cands.length);
      try {
        const res = await fetch(cands[i].url, { credentials: 'omit' });
        if (!res.ok) continue;
        const blob = await res.blob();
        const bmp = await createImageBitmap(blob);
        const ok = bmp.width >= MIN_W && bmp.height >= MIN_H;
        bmp.close();
        if (ok) return { cand: cands[i], blob };
      } catch (e) { /* 這張不行，試下一張 */ }
    }
    return null;
  }

  // 等「這次」抓到的圖真的換進預覽（不然「直接下載」會下到上一張圖）；逾時回傳 false
  async function waitForNewImage(previousImage) {
    for (let i = 0; i < 60; i++) {
      if (singleBg.image && singleBg.image !== previousImage && !downloadBtn.disabled) return true;
      await new Promise(r => setTimeout(r, 75));
    }
    return false;
  }

  // 完成後詢問：直接下載／還要修改。嵌在卡片裡（不用跳窗），預覽完整露出來讓使用者先看
  const hideAsk = () => { askBox.hidden = true; };
  function showAsk() {
    askBox.hidden = false;
    askTipEl.hidden = askTipShown;   // 這次載入的第一張圖才顯示提示
    askTipShown = true;
    askDownloadBtn.focus({ preventScroll: true });
  }

  async function run() {
    const url = normalizeUrl(urlInput.value);
    if (!url) { setStatus('請先貼上文章網址', 'err'); return; }
    const mine = ++runId;
    lastRunUrl = url;
    runBtn.disabled = true;
    hideTip();
    hideAsk();
    setStatus('讀取文章中…');
    try {
      let res;
      try { res = await fetch(url, { credentials: 'omit' }); }
      catch (e) { throw new Error('連線失敗，請確認網址和網路'); }
      if (!res.ok) throw new Error(`文章讀取失敗（HTTP ${res.status}）`);
      const article = parseArticle(await res.text(), res.url || url);
      if (mine !== runId) return;
      if (!article.title) throw new Error('這個網頁抓不到標題');

      titleEl.value = breakTitle(article.title).join('\n');
      titleEl.dispatchEvent(new Event('input'));

      const notes = [];
      const previousImage = singleBg.image;
      let caption = article.fallbackCaption;
      const got = await loadFirstUsableImage(article.images, (i, n) => setStatus(`標題已帶入，抓取圖片 ${i + 1}/${n}…`));
      if (mine !== runId) return;
      if (got) {
        const type = got.blob.type && got.blob.type.startsWith('image/') ? got.blob.type : 'image/jpeg';
        const ext = type.split('/')[1].replace('jpeg', 'jpg').replace(/\+.*$/, '');
        singleBgPicker.handleFile(new File([got.blob], `article-image.${ext}`, { type }));
        caption = got.cand.caption || article.fallbackCaption;
      } else {
        notes.push(article.images.length ? '圖片都抓不到，請手動放圖' : '網頁裡沒找到圖片，請手動放圖');
      }
      if (!caption) notes.push('沒抓到圖說');
      if (!article.tags.length) notes.push('沒抓到 hashtag');

      copyText.value = formatCopy({ title: article.title, caption, tags: article.tags });
      copyBtn.disabled = !copyText.value;

      // 有圖就問使用者要直接下載還是還要修改；沒抓到圖就沒有東西可下載，不用問
      const ready = got ? await waitForNewImage(previousImage) : false;
      if (mine !== runId) return;
      if (got && !ready) notes.push('圖片沒能載入預覽');
      if (ready) showAsk();
      setStatus(notes.length ? `完成，但${notes.join('、')}` : '完成：標題、圖片、圖說、hashtag 都帶入了', notes.length ? 'warn' : 'ok');
    } catch (err) {
      if (mine === runId) setStatus(err.message || String(err), 'err');
    } finally {
      if (mine === runId) runBtn.disabled = false;
    }
  }

  async function copyToClipboard(text) {
    try { await navigator.clipboard.writeText(text); return true; }
    catch (e) {
      copyText.select();
      try { return document.execCommand('copy'); } catch (e2) { return false; }
    }
  }

  function confirmDownload() {
    hideAsk();
    if (downloadBtn.disabled) { setStatus('現在還不能下載，請先補上標題和背景', 'warn'); return; }
    downloadBtn.click();
    setStatus('已下載圖片', 'ok');
  }
  askDownloadBtn.addEventListener('click', confirmDownload);
  askEditBtn.addEventListener('click', () => {
    hideAsk();
    setStatus('好，修改完成後按「下載圖片」就能下載', 'ok');
  });
  // 使用者自己按了「下載圖片」，就不用再問了
  downloadBtn.addEventListener('click', hideAsk);

  runBtn.addEventListener('click', run);
  // Enter：沒有詢問時＝快速產圖；詢問還開著、網址沒改過時＝「再按一次 Enter 即下載」；網址改了就是重新產圖
  urlInput.addEventListener('keydown', e => {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    if (!askBox.hidden && normalizeUrl(urlInput.value) === lastRunUrl) confirmDownload(); else run();
  });
  // 詢問開著、焦點不在任何輸入元件上（例如點過畫面空白處）時，Enter 一樣是下載
  document.addEventListener('keydown', e => {
    if (e.key === 'Enter' && !askBox.hidden && document.activeElement === document.body) { e.preventDefault(); confirmDownload(); }
  });
  urlInput.addEventListener('input', hideTip);
  if (tipEl) tipEl.addEventListener('click', hideTip);
  copyText.addEventListener('input', () => { copyBtn.disabled = !copyText.value.trim(); });
  copyBtn.addEventListener('click', async () => {
    const ok = await copyToClipboard(copyText.value);
    const label = copyBtn.textContent;
    copyBtn.textContent = ok ? '已複製 ✓' : '複製失敗，請手動選取';
    setTimeout(() => { copyBtn.textContent = label; }, 1600);
  });
  // 套版區按「全部清除」確認後，快速產圖欄位一併清空
  document.addEventListener('qpt:reset', () => {
    runId++;
    hideAsk();
    urlInput.value = '';
    copyText.value = '';
    copyBtn.disabled = true;
    runBtn.disabled = false;
    setStatus('');
  });
})(window);

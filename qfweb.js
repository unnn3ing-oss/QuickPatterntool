// 網頁版專用：左邊編輯區每張圖片卡片的「快速產圖」。
// 位置：卡片上方「下載／完成」那一列和「新聞／娛樂」切換之間，一個小輸入框；貼上文章網址、按 Enter 就送出，
// 標題（依規則斷行）與首圖會帶進這張卡片，跟外掛側邊欄的快速產圖一樣。
// 網頁自己抓別家網站會被瀏覽器的跨網域限制擋住，所以文章與圖片要請人代抓，有兩條路（兩條都只限 https 的 tvbs.com.tw）：
//   1. 外掛（電腦版 Chrome）：透過 schedbridge.js 的橋接請外掛下載，見 schedweb.js 的 QptWebBridge
//   2. 文章代理（Cloudflare Worker，手機沒有外掛時就靠它）：原始碼在 examples/article-proxy/，網址見下面的 PROXY
// 偵測到外掛就用外掛（行為和以前完全一樣），沒有外掛才走代理。解析標題、斷行、挑圖、圖說、hashtag 用的是和側邊欄同一份 quickfill.js。
// 需要在 app.js、quickfill.js、schedweb.js 之後載入。
(function () {
  const QF = window.QuickFill;
  const WB = window.QptWebBridge;
  const list = document.getElementById('batchItemsList');
  if (!QF || !WB || !list) return;

  // 文章代理的網址（Worker 名稱必須是 qpt-article-proxy）；index.html 的 CSP connect-src 也只放行這一個
  const PROXY = 'https://qpt-article-proxy.19jpz-3.workers.dev';
  const PING_MS = 1200;
  const NOT_TVBS = '網頁版快速產圖只能抓 TVBS 的文章網址（https://….tvbs.com.tw/…）';
  const NO_ROUTE = '連不上文章代理，也沒有偵測到外掛：請確認網路後再試；電腦版也可以安裝並更新外掛，重新整理本頁';

  // 每張卡片各自記住輸入框內容與狀態：卡片展開／收合時會整個重建，不能因此掉了正在跑的進度或剛貼的網址
  const states = new Map();   // itemId → { value, runId, status:{ text, kind } }
  const stateOf = id => { if (!states.has(id)) states.set(id, { value: '', runId: 0, status: { text: '', kind: '' } }); return states.get(id); };
  // 卡片的 id 是數字，從 data-item-id 讀回來是字串，所以用字串比對
  const findItem = id => (typeof batchItems !== 'undefined' ? batchItems : []).find(i => String(i.id) === String(id)) || null;
  const findBlock = id => list.querySelector(`.batch-item-block[data-item-id="${CSS.escape(id)}"]`);

  function showStatus(id) {
    const block = findBlock(id);
    const el = block && block.querySelector('.qfw-status');
    if (!el) return;
    const { text, kind } = stateOf(id).status;
    el.textContent = text;
    el.className = 'qfw-status' + (kind ? ' ' + kind : '');
    el.hidden = !text;
  }
  function setStatus(id, text, kind) {
    stateOf(id).status = { text: text || '', kind: kind || '' };
    showStatus(id);
  }

  // 標題帶進卡片：優先寫進卡片的標題框並觸發 input（這樣卡片自己會更新狀態、預覽與縮圖）；卡片目前是收合的就直接改資料再重畫
  function applyTitle(id, text) {
    const ta = findBlock(id) && findBlock(id).querySelector('textarea');
    if (ta) { ta.value = text; ta.dispatchEvent(new Event('input', { bubbles: true })); return; }
    const item = findItem(id);
    if (!item) return;
    item.title = text;
    item.done = false;
    if (typeof renderBatchItemsList === 'function') renderBatchItemsList();
    if (typeof renderBatchThumbs === 'function') renderBatchThumbs();
  }

  // 不能用 fetch(dataUrl)：網頁的內容安全政策（CSP）connect-src 不含 data:，會被擋
  function dataUrlToBlob(dataUrl) {
    const comma = dataUrl.indexOf(',');
    const mime = (dataUrl.slice(5, comma).match(/^[^;]+/) || ['application/octet-stream'])[0];
    const bin = atob(dataUrl.slice(comma + 1));
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new Blob([bytes], { type: mime });
  }

  // 網址有「entertainment」就把這張卡片切成娛樂（粉框）；只往娛樂切。卡片是展開的就按它的切換鈕（會自己更新預覽），收合的就直接改資料再重畫
  function applyFrameByUrl(id, ...urls) {
    if (!urls.some(QF.isEntertainmentUrl)) return;
    const btn = findBlock(id) && findBlock(id).querySelector('button[data-frame="entertainment"]');
    if (btn) { if (!btn.classList.contains('active')) btn.click(); return; }
    const item = findItem(id);
    if (!item || item.frame === 'entertainment') return;
    item.frame = 'entertainment';
    item.done = false;
    if (typeof renderBatchItemsList === 'function') renderBatchItemsList();
    if (typeof renderBatchThumbs === 'function') renderBatchThumbs();
  }

  const isTvbs = u => { try { const x = new URL(u); const h = x.hostname.toLowerCase(); return x.protocol === 'https:' && !x.username && !x.password && (h === 'tvbs.com.tw' || h.endsWith('.tvbs.com.tw')); } catch (e) { return false; } };

  // ---- 文章代理：任何「連不上」（斷網、沒部署、被擋）都標成 unreachable，由呼叫端決定怎麼說 ----------
  async function proxyGet(path, params, timeoutMs, read) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);   // 計時涵蓋讀取內容的時間，不只是連線
    try {
      const res = await fetch(`${PROXY}${path}?${new URLSearchParams(params)}`, { credentials: 'omit', signal: ctrl.signal });
      return { res, body: await read(res) };
    } catch (e) {
      throw Object.assign(new Error(e && e.name === 'AbortError' ? '文章代理逾時' : NO_ROUTE), { unreachable: true });
    } finally { clearTimeout(timer); }
  }
  const proxyErr = body => (body && typeof body.error === 'string' && body.error) || '文章代理回應不正確';

  // 外掛有沒有在？（有就用外掛，行為跟以前一樣；手機沒有外掛，等 PING_MS 就改走代理）
  const hasExtension = async () => (await WB.call('ping', {}, PING_MS)).ok;

  // 取得文章 → { html, url, via:'ext'|'proxy' }
  async function getArticle(url) {
    if (await hasExtension()) {
      const art = await WB.call('fetchArticle', { url }, 30000);
      if (!art.ok) throw new Error(WB.friendly(art.error));
      return { html: art.data.html, url: art.data.url, via: 'ext' };
    }
    const { res, body } = await proxyGet('/article', { url }, 25000, r => r.json());
    if (!res.ok || !body || !body.ok || typeof body.html !== 'string') throw new Error(proxyErr(body));
    if (!isTvbs(body.url)) throw new Error('文章被轉址到 TVBS 以外的網站，已停止');
    return { html: body.html, url: body.url, via: 'proxy' };
  }

  // 取得一張圖 → Blob；這張不能用就回 null（換下一張）；連不上代理丟 unreachable
  async function getImage(imgUrl, articleUrl, via) {
    if (via === 'ext') {
      const r = await WB.call('fetchImage', { url: imgUrl, articleUrl }, 40000);
      if (!r.ok) { if (r.error === 'no_extension') throw new Error(WB.friendly(r.error)); return null; }
      return dataUrlToBlob(r.data.dataUrl);
    }
    if (!isTvbs(imgUrl)) return null;   // 代理只抓 TVBS 網域的圖，其他網域的圖直接換下一張
    const { res, body } = await proxyGet('/image', { url: imgUrl, article: articleUrl }, 30000, r => (r.ok ? r.blob() : null));
    return res.ok && body && /^image\//.test(body.type) ? body : null;
  }

  async function run(id) {
    const st = stateOf(id);
    if (!findItem(id)) return;
    const url = QF.normalizeUrl(st.value);
    if (!url) { setStatus(id, '請先貼上文章網址', 'err'); return; }
    if (!isTvbs(url)) { setStatus(id, NOT_TVBS, 'err'); return; }
    const mine = ++st.runId;
    applyFrameByUrl(id, url);
    const stale = () => mine !== st.runId || !findItem(id);
    const L = QF.LIMITS;
    setStatus(id, '讀取文章中…');
    try {
      const art = await getArticle(url);
      if (stale()) return;
      applyFrameByUrl(id, art.url);   // 轉址之後才出現 entertainment 的情況
      const article = QF.parseArticle(art.html, art.url);
      if (!article.title) throw new Error('這個網頁抓不到標題');
      const applied = QF.breakTitle(article.title).join('\n');
      applyTitle(id, applied);

      // 圖片：依序試（最多 MAX_IMAGE_TRIES 張），抓不到、太小、太大就換下一張
      const cands = article.images.filter(c => QF.isAllowedImageUrl(c.url, art.url)).slice(0, L.MAX_IMAGE_TRIES);
      let got = null;
      let lost = false;
      for (let i = 0; i < cands.length && !got && !lost; i++) {
        setStatus(id, `標題已帶入，抓取圖片 ${i + 1}/${cands.length}…`);
        try {
          const blob = await getImage(cands[i].url, art.url, art.via);
          if (stale()) return;
          if (!blob) continue;
          const bmp = await createImageBitmap(blob);
          const ok = bmp.width >= L.MIN_W && bmp.height >= L.MIN_H && bmp.width * bmp.height <= L.MAX_PIXELS;
          bmp.close();
          if (ok) got = { cand: cands[i], blob };
        } catch (e) {
          if (stale()) return;
          if (e && e.unreachable) lost = true;             // 代理中途連不上：不用再一張張試
          else if (art.via === 'ext' && /外掛/.test(e && e.message)) throw e;   // 外掛不見了：照舊直接報錯
          /* 其他：這張不行，試下一張 */
        }
      }
      if (stale()) return;
      const notes = [];
      let caption = article.fallbackCaption;
      if (got) {
        const type = got.blob.type && got.blob.type.startsWith('image/') ? got.blob.type : 'image/jpeg';
        const ext = type.split('/')[1].replace('jpeg', 'jpg').replace(/\+.*$/, '');
        const item = findItem(id);
        if (item && typeof item.handleFile === 'function') item.handleFile(new File([got.blob], `article-image.${ext}`, { type }));
        else notes.push('圖片沒能放進卡片，請手動放圖');
        caption = got.cand.caption || article.fallbackCaption;
      } else {
        notes.push(lost ? '中途連不上文章代理，圖片沒抓到，請手動放圖' : article.images.length ? '圖片都抓不到，請手動放圖' : '網頁裡沒找到圖片，請手動放圖');
      }
      if (!caption) notes.push('沒抓到圖說');
      if (!QF.pickTags(article.tags).length) notes.push('沒抓到 2～3 字的 hashtag');
      // 留給「排程」抽屜的「帶入目前圖文」：複製用的圖文格式與文章網址
      const item = findItem(id);
      if (item) item.qfMeta = { articleUrl: art.url, appliedTitle: applied, copyText: QF.formatCopy({ title: article.title, caption, tags: article.tags }) };
      setStatus(id, notes.length ? `完成，但${notes.join('、')}` : '完成：標題、圖片都帶入了', notes.length ? 'warn' : 'ok');
    } catch (err) {
      if (!stale()) setStatus(id, err.message || String(err), 'err');
    }
  }

  // ---- 把輸入框放進每張展開的卡片（下載／完成 與 新聞／娛樂 之間）-------------------------
  function buildRow(id) {
    const st = stateOf(id);
    const row = document.createElement('div');
    row.className = 'qfw-row';
    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'qfw-input';
    input.placeholder = '快速產圖：貼上文章網址，按 Enter';
    input.setAttribute('aria-label', '快速產圖：文章網址');
    input.autocomplete = 'off';
    input.spellcheck = false;
    input.inputMode = 'url';
    input.value = st.value;
    input.addEventListener('input', () => { st.value = input.value; });
    input.addEventListener('keydown', e => {
      if (e.key !== 'Enter' || e.isComposing) return;
      e.preventDefault();
      e.stopPropagation();
      run(id);
    });
    const status = document.createElement('div');
    status.className = 'qfw-status';
    status.setAttribute('role', 'status');
    status.hidden = true;
    row.append(input, status);
    return row;
  }
  function decorate() {
    for (const id of [...states.keys()]) if (!findItem(id)) states.delete(id);   // 卡片被刪除或「全部清除」了：它的輸入框內容與進度一起丟掉（跑到一半的也已作廢，見 run 的 stale）
    for (const block of list.querySelectorAll('.batch-item-block')) {
      if (block.querySelector(':scope > .qfw-row')) continue;
      const head = block.querySelector(':scope > .batch-item-head');
      if (!head || !block.dataset.itemId) continue;
      head.after(buildRow(block.dataset.itemId));
      showStatus(block.dataset.itemId);
    }
  }
  new MutationObserver(decorate).observe(list, { childList: true });
  decorate();
})();

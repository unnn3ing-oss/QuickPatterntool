// Facebook 粉專排程發文：佇列的資料格式、驗證、判斷「該不該現在發」，以及存取佇列。
// 這個檔案同時被三個地方載入：
//   1. 側邊欄（新增、刪除、顯示排程）
//   2. background.js（importScripts，到點執行）
//   3. Node 單元測試（純函式不碰 chrome.*）
// 佇列存在 chrome.storage.local 的 fbQueue；每一筆：
//   { id, text, images:[{name,dataUrl}], pageUrl, note(小編文), articleUrl(文章網址), at(排定時間 ms), status, createdAt,
//     startedAt, finishedAt, tabId, prevTabId, prevStatus, dryRun, mode, step, error, commentState, commentError }
// status：pending 等待中｜running 執行中｜done 已發佈｜failed 失敗｜missed 錯過（開機時已超過寬限時間）
// 發佈後會在貼文下自動留言「小編文＋換行＋文章網址（帶追蹤碼）」（commentOf），結果記在 commentState：done｜failed｜none（沒有要留言）
// mode：執行中才有。post＝發貼文（之後留言）｜comment＝只補留言（貼文已發佈）
(function (root) {
  const KEY = 'fbQueue';
  const PAGE_KEY = 'fbPageUrl';
  const GRACE_MS = 10 * 60 * 1000;        // 錯過排定時間 10 分鐘內還會補發；超過就標成「錯過」，不補發過時的貼文
  const RUN_TIMEOUT_MS = 6 * 60 * 1000;   // 一次執行（發文＋留言）最多 6 分鐘，超過視為卡住
  const MAX_IMAGES = 10;
  const MAX_TEXT = 10000;
  const MAX_ITEMS = 50;
  const MAX_NOTE = 500;
  const MAX_URL = 2000;
  const MAX_IMAGE_CHARS = 40 * 1024 * 1024;   // 所有圖片 data URL 加起來的上限（網頁版透過訊息傳給外掛，單則訊息不能超過 64MB）
  const STEP_LABELS = {
    start: '開啟粉專', open: '開啟發文框', text: '輸入文字', images: '上傳圖片',
    ready: '內容已填好', next: '按「繼續」', publishing: '按下發佈', reloading: '重新整理頁面', finding: '找剛發佈的貼文', commenting: '留言',
    commented: '留言完成', 'dry-ok': '試跑完成'
  };

  // 只接受 facebook.com 的 https 網址，而且要是粉專頁面（不能是首頁）。
  // → { ok:true, url } 或 { ok:false, error }
  function normalizePageUrl(raw) {
    if (typeof raw !== 'string' || !raw.trim() || raw.length > 500) return { ok: false, error: '請填粉專網址' };
    let u;
    try { u = new URL(raw.trim()); } catch (e) { return { ok: false, error: '粉專網址格式不對' }; }
    const host = u.hostname.toLowerCase();
    if (u.protocol !== 'https:' || u.username || u.password) return { ok: false, error: '粉專網址必須是 https://www.facebook.com/…' };
    if (host !== 'www.facebook.com' && host !== 'facebook.com') return { ok: false, error: '粉專網址必須是 facebook.com' };
    if (u.pathname.replace(/\/+$/, '') === '' ) return { ok: false, error: '請填粉專頁面的網址，不是 Facebook 首頁' };
    u.hostname = 'www.facebook.com';
    return { ok: true, url: u.href };
  }

  // ---- 粉專預設與追蹤碼 -----------------------------------------------------
  // 留言裡的文章網址要帶追蹤碼：貼文有附圖用 pic、只有文字用 comments。自訂粉專（不在清單內）不加追蹤碼。
  const PAGES = [
    { id: 'news', name: '新聞粉', url: 'https://www.facebook.com/tvbsfb/', pic: 'fbarticlepic', text: 'fbarticlecomments' },
    { id: 'tea', name: '娛樂粉', url: 'https://www.facebook.com/tvbsteatimenews', pic: 'tvbsteatimenewspic', text: 'tvbsteatimenewscomments' },
    { id: 'room', name: '少康粉', url: 'https://www.facebook.com/2100room', pic: '2100roompic', text: '2100roomcomments' }
  ];
  const pagePath = url => {
    try { return new URL(url).pathname.replace(/\/+$/, '').toLowerCase(); } catch (e) { return null; }
  };
  function pageOf(url) {
    const p = pagePath(url);
    return p ? PAGES.find(pg => pagePath(pg.url) === p) || null : null;
  }
  // 文章網址 + 追蹤碼。格式固定為 …?&utm_source=facebook&utm_medium=XXX；網址本來就有別的參數時接在後面，並先拿掉舊的 utm_source／utm_medium。
  // → 字串；網址不是 http(s) 回 null
  function withUtm(articleUrl, medium) {
    let u;
    try { u = new URL(String(articleUrl).trim()); } catch (e) { return null; }
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
    u.searchParams.delete('utm_source');
    u.searchParams.delete('utm_medium');
    const rest = u.searchParams.toString();
    const hash = u.hash;
    u.search = '';
    u.hash = '';
    return `${u.href}${rest ? '?' + rest + '&' : '?&'}utm_source=facebook&utm_medium=${medium}${hash}`;
  }
  // 要留的內容：小編文、換行、文章網址（帶追蹤碼）。兩樣都沒有 → 空字串（不留言）。
  function commentOf(item) {
    const note = String(item.note || '').trim();
    const url = String(item.articleUrl || '').trim();
    let link = '';
    if (url) {
      const pg = pageOf(item.pageUrl);
      const hasImages = Array.isArray(item.images) && item.images.length > 0;
      link = (pg ? withUtm(url, hasImages ? pg.pic : pg.text) : null) || url;
    }
    return [note, link].filter(Boolean).join('\n');
  }
  const canEdit = item => !!item && (item.status === 'pending' || item.status === 'failed' || item.status === 'missed');

  // 一筆排程能不能執行（新增時、到點執行前各驗一次）。→ { ok:true } 或 { ok:false, error }
  function validateItem(item) {
    if (!item || typeof item !== 'object') return { ok: false, error: '排程資料不正確' };
    if (typeof item.id !== 'string' || !item.id) return { ok: false, error: '排程資料不正確' };
    if (typeof item.text !== 'string' || item.text.length > MAX_TEXT) return { ok: false, error: `文字不能超過 ${MAX_TEXT} 字` };
    const images = item.images;
    if (!Array.isArray(images) || images.length > MAX_IMAGES) return { ok: false, error: `圖片最多 ${MAX_IMAGES} 張` };
    for (const im of images) {
      if (!im || typeof im.dataUrl !== 'string' || !/^data:image\/(png|jpe?g|webp|gif);base64,/.test(im.dataUrl)) {
        return { ok: false, error: '圖片格式只支援 PNG、JPG、WebP、GIF' };
      }
    }
    if (images.reduce((n, im) => n + im.dataUrl.length, 0) > MAX_IMAGE_CHARS) return { ok: false, error: '圖片加起來太大了，請減少張數或縮小圖片' };
    if (!item.text.trim() && !images.length) return { ok: false, error: '文字和圖片至少要有一樣' };
    if (item.note != null && (typeof item.note !== 'string' || item.note.length > MAX_NOTE)) return { ok: false, error: `小編文不能超過 ${MAX_NOTE} 字` };
    if (item.articleUrl != null && item.articleUrl !== '') {
      if (typeof item.articleUrl !== 'string' || item.articleUrl.length > MAX_URL || !withUtm(item.articleUrl, 'x')) return { ok: false, error: '文章網址要是 http(s) 網址' };
    }
    if (typeof item.at !== 'number' || !isFinite(item.at)) return { ok: false, error: '請選擇發佈時間' };
    const p = normalizePageUrl(item.pageUrl);
    if (!p.ok) return p;
    return { ok: true };
  }

  // 這筆現在該怎麼處理。
  //   pending：wait（還沒到）｜fire（到了，在寬限內）｜missed（超過寬限）
  //   running：busy（執行中）｜stale（卡住太久）
  //   其他狀態：idle
  function classify(item, now) {
    if (item.status === 'pending') {
      if (now < item.at) return 'wait';
      return now - item.at <= GRACE_MS ? 'fire' : 'missed';
    }
    if (item.status === 'running') {
      return now - (item.startedAt || 0) > RUN_TIMEOUT_MS ? 'stale' : 'busy';
    }
    return 'idle';
  }

  // 卡住時的錯誤說明。已經按下發佈卻沒收到結果時，不能說「失敗」：貼文有可能已經發出去了。
  function stuckMessage(step) {
    if (step === 'reloading' || step === 'finding' || step === 'commenting') return '貼文已經發佈，但留言沒有完成，請手動留言（或按「補留言」）';
    if (step === 'publishing') return '已按下發佈但沒收到結果，貼文可能已經發出，請先到粉專確認，再決定要不要重發';
    return `卡在「${STEP_LABELS[step] || '開始'}」這一步，沒有發佈`;
  }

  // 把表單內容組成一筆排程（新增與編輯共用，也是網頁版傳來的資料的驗證）。
  // input：{ pageUrl, text, images, note, articleUrl, at } → { ok:true, item } 或 { ok:false, error }
  function buildItem(input, opts) {
    const { now = Date.now(), id, createdAt } = opts || {};
    const i = input || {};
    const page = normalizePageUrl(i.pageUrl);
    if (!page.ok) return page;
    const item = {
      id: id || newId(),
      text: typeof i.text === 'string' ? i.text.trim() : i.text,
      images: Array.isArray(i.images) ? i.images.map(im => ({ name: im && String(im.name || 'image').slice(0, 120), dataUrl: im && im.dataUrl })) : i.images,
      pageUrl: page.url,
      note: typeof i.note === 'string' ? i.note.trim() : '',
      articleUrl: typeof i.articleUrl === 'string' ? i.articleUrl.trim() : '',
      at: i.at,
      status: 'pending',
      createdAt: createdAt || now
    };
    const v = validateItem(item);
    if (!v.ok) return v;
    if (item.at < now + 60000) return { ok: false, error: '發佈時間要在一分鐘以後' };
    return { ok: true, item };
  }
  async function addItem(input) {
    const b = buildItem(input);
    if (!b.ok) return b;
    try { await add(b.item); } catch (e) { return { ok: false, error: e.message || '加入失敗（儲存空間不足？）' }; }
    return b;
  }
  // 編輯：只有等待中／失敗／錯過的可以改；改完回到「等待中」（重新排程）
  async function edit(id, input) {
    let result = { ok: false, error: '找不到這筆排程' };
    await mutate(list => {
      const cur = list.find(i => i.id === id);
      if (!cur) return null;
      if (!canEdit(cur)) { result = { ok: false, error: '這筆正在執行或已經發佈，不能編輯' }; return null; }
      const b = buildItem(input, { id, createdAt: cur.createdAt });
      result = b;
      return b.ok ? list.map(i => (i.id === id ? b.item : i)) : null;
    });
    return result;
  }
  // 給網頁版的清單：圖片只留名稱（data URL 很大，要編輯時再單筆取）
  const summarize = item => Object.assign({}, item, { images: (item.images || []).map(im => ({ name: im.name })) });

  function newId() { return 'p' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7); }

  // ---- 佇列存取（需要 chrome.storage.local）--------------------------------
  // 同一個環境內的寫入排隊，避免兩次「讀→改→寫」互相蓋掉；跨環境（側邊欄與背景）的衝突機率低，
  // 且每次都用最新讀到的清單改，只動指定的那一筆。
  let chain = Promise.resolve();
  function mutate(fn) {
    const run = chain.then(async () => {
      const got = await root.chrome.storage.local.get(KEY);
      const next = fn(Array.isArray(got[KEY]) ? got[KEY].slice() : []);
      if (next) await root.chrome.storage.local.set({ [KEY]: next });
      return next;
    });
    chain = run.catch(() => {});
    return run;
  }
  async function list() {
    const got = await root.chrome.storage.local.get(KEY);
    return Array.isArray(got[KEY]) ? got[KEY] : [];
  }
  const update = (id, patch) => mutate(l => (l.some(i => i.id === id) ? l.map(i => (i.id === id ? Object.assign({}, i, patch) : i)) : null));
  const remove = id => mutate(l => l.filter(i => i.id !== id));
  const add = item => mutate(l => {
    if (l.length >= MAX_ITEMS) throw new Error(`排程最多 ${MAX_ITEMS} 筆，請先刪除不需要的`);
    return l.concat(item);
  });

  root.QptSched = {
    KEY, PAGE_KEY, GRACE_MS, RUN_TIMEOUT_MS, MAX_IMAGES, MAX_TEXT, MAX_ITEMS, STEP_LABELS,
    MAX_NOTE, MAX_URL, MAX_IMAGE_CHARS, PAGES,
    normalizePageUrl, pageOf, withUtm, commentOf, canEdit, validateItem, buildItem, summarize, classify, stuckMessage, newId,
    list, update, remove, add, addItem, edit, mutate
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = root.QptSched;
})(typeof self !== 'undefined' ? self : this);

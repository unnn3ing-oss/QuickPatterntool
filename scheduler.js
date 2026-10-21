// Facebook 粉專排程發文：佇列的資料格式、驗證、判斷「該不該現在發」，以及存取佇列。
// 這個檔案同時被三個地方載入：
//   1. 側邊欄（新增、刪除、顯示排程）
//   2. background.js（importScripts，到點執行）
//   3. Node 單元測試（純函式不碰 chrome.*）
// 佇列存在 chrome.storage.local 的 fbQueue；每一筆：
//   { id, text, images:[{name,dataUrl}], pageUrl, at(排定時間 ms), status, createdAt,
//     startedAt, finishedAt, tabId, prevTabId, prevStatus, dryRun, step, error }
// status：pending 等待中｜running 執行中｜done 已發佈｜failed 失敗｜missed 錯過（開機時已超過寬限時間）
(function (root) {
  const KEY = 'fbQueue';
  const PAGE_KEY = 'fbPageUrl';
  const GRACE_MS = 10 * 60 * 1000;        // 錯過排定時間 10 分鐘內還會補發；超過就標成「錯過」，不補發過時的貼文
  const RUN_TIMEOUT_MS = 4 * 60 * 1000;   // 一次執行最多 4 分鐘，超過視為卡住
  const MAX_IMAGES = 10;
  const MAX_TEXT = 10000;
  const MAX_ITEMS = 50;
  const STEP_LABELS = {
    start: '開啟粉專', open: '開啟發文框', text: '輸入文字', images: '上傳圖片',
    ready: '內容已填好', publishing: '按下發佈', 'dry-ok': '試跑完成'
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
    if (!item.text.trim() && !images.length) return { ok: false, error: '文字和圖片至少要有一樣' };
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
    if (step === 'publishing') return '已按下發佈但沒收到結果，貼文可能已經發出，請先到粉專確認，再決定要不要重發';
    return `卡在「${STEP_LABELS[step] || '開始'}」這一步，沒有發佈`;
  }

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
    normalizePageUrl, validateItem, classify, stuckMessage, newId, list, update, remove, add, mutate
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = root.QptSched;
})(typeof self !== 'undefined' ? self : this);

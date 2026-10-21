// 網頁版（GitHub Pages 上的 QuickPatterntool）和外掛之間的排程橋接：網頁版的「排程」抽屜靠它讀寫外掛裡的排程清單。
// 這個檔案同時被兩個地方載入：
//   1. 內容腳本（只注入網頁版頁面）：接頁面的 postMessage → 轉給 background（sched:api）→ 把結果回給頁面；
//      排程清單有變動時通知頁面重新讀取
//   2. background.js（importScripts）：用 senderAllowed／OPS 驗證 sched:api 的來源
// 驗證都是純函式，方便在 Node 單元測試。網頁傳來的內容一律不可信，background 會再驗證一次（見 poster.js 的 webApi）。
(function (root) {
  const PAGE_ORIGIN = 'https://unnn3ing-oss.github.io';
  const PAGE_PATH_PREFIX = '/QuickPatterntool/';
  const OPS = ['ping', 'list', 'get', 'add', 'edit', 'remove', 'start'];

  // → { ok:true, nonce, op, payload } 或 { ok:false }
  function validateRequest(d) {
    if (!d || typeof d !== 'object' || Array.isArray(d)) return { ok: false };
    if (d.source !== 'qpt-web' || d.type !== 'sched' || d.v !== 1) return { ok: false };
    if (typeof d.nonce !== 'string' || !d.nonce || d.nonce.length > 64) return { ok: false };
    if (typeof d.op !== 'string' || !OPS.includes(d.op)) return { ok: false };
    if (d.payload !== undefined && (d.payload === null || typeof d.payload !== 'object' || Array.isArray(d.payload))) return { ok: false };
    return { ok: true, nonce: d.nonce, op: d.op, payload: d.payload || {} };
  }

  // 只信任自己的擴充功能、來自網頁版頁面的訊息。
  function senderAllowed(sender, selfId) {
    if (!sender || !selfId || sender.id !== selfId || !sender.tab || typeof sender.url !== 'string') return false;
    let u;
    try { u = new URL(sender.url); } catch (e) { return false; }
    return u.origin === PAGE_ORIGIN && u.pathname.startsWith(PAGE_PATH_PREFIX);
  }

  // ---- 內容腳本接線（只在網頁版頁面、且擴充功能有效時註冊）-----------------------
  const post = m => window.postMessage(Object.assign({ source: 'quickpattern' }, m), location.origin);

  if (typeof document !== 'undefined' && typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.id
    && typeof location !== 'undefined' && location.origin === PAGE_ORIGIN && location.pathname.startsWith(PAGE_PATH_PREFIX)) {
    window.addEventListener('message', event => {
      if (event.source !== window || event.origin !== location.origin) return;
      const v = validateRequest(event.data);
      if (!v.ok) return;
      let p;
      try { p = chrome.runtime.sendMessage({ type: 'sched:api', op: v.op, payload: v.payload }); }
      catch (e) { post({ type: 'sched-result', nonce: v.nonce, ok: false, error: 'extension_unavailable' }); return; }
      Promise.resolve(p).then(
        r => post(Object.assign({ type: 'sched-result', nonce: v.nonce }, r && typeof r === 'object' ? { ok: !!r.ok, data: r.data, error: r.error } : { ok: false, error: 'no_response' })),
        () => post({ type: 'sched-result', nonce: v.nonce, ok: false, error: 'extension_unavailable' })
      );
    });
    // 排程清單有變動（側邊欄新增、背景更新狀態…）→ 通知頁面重新讀取
    try {
      chrome.storage.onChanged.addListener((changes, area) => { if (area === 'local' && changes.fbQueue) post({ type: 'sched-changed' }); });
    } catch (e) { /* 沒有 storage 權限：頁面仍可手動重新整理 */ }
    post({ type: 'sched-ready' });
  }

  root.QptSchedBridge = { validateRequest, senderAllowed, OPS, PAGE_ORIGIN, PAGE_PATH_PREFIX };
  if (typeof module !== 'undefined' && module.exports) module.exports = root.QptSchedBridge;
})(typeof self !== 'undefined' ? self : this);

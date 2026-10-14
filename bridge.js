// 從「熱門新聞庫」把新聞網址與改標送進側邊欄快速產圖的橋接。
// 這個檔案同時被三個地方載入：
//   1. 內容腳本（只注入熱門新聞庫頁面）：接頁面的 postMessage → 轉給 background
//   2. background.js（importScripts）：驗證 sender 與內容、暫存、開側邊欄
//   3. 側邊欄：判斷暫存有沒有過期
// 驗證都是純函式，方便在 Node 單元測試。
(function (root) {
  const PENDING_TTL_MS = 120000;
  const PAGE_ORIGIN = 'https://unnn3ing-oss.github.io';
  const PAGE_PATH_PREFIX = '/hottopic/';
  const MAX_URL = 2000;
  const MAX_TITLE = 200;

  // → { ok:true, url, title|null } 或 { ok:false, error }
  function validateSend(msg) {
    if (!msg || typeof msg !== 'object' || Array.isArray(msg)) return { ok: false, error: 'bad_message' };
    const raw = msg.url;
    if (typeof raw !== 'string' || !raw || raw.length > MAX_URL) return { ok: false, error: 'bad_url' };
    let u;
    try { u = new URL(raw); } catch (e) { return { ok: false, error: 'bad_url' }; }
    const host = u.hostname.toLowerCase();
    if (u.protocol !== 'https:' || u.username || u.password) return { ok: false, error: 'bad_url' };
    if (host !== 'tvbs.com.tw' && !host.endsWith('.tvbs.com.tw')) return { ok: false, error: 'bad_url' };

    let title = null;
    if (msg.title !== undefined && msg.title !== null) {
      if (typeof msg.title !== 'string' || msg.title.length > MAX_TITLE) return { ok: false, error: 'bad_title' };
      title = msg.title.replace(/[\r\n]+/g, ' ').replace(/[\u0000-\u001f\u007f]/g, '');   // 改標用換行分行，換成空格（breakTitle 把空格當斷點），不能直接刪掉
      if (!title.trim()) return { ok: false, error: 'bad_title' };
    }
    return { ok: true, url: u.href, title };
  }

  // 只信任自己的擴充功能、來自熱門新聞庫頁面的訊息。
  function senderAllowed(sender, selfId) {
    if (!sender || !selfId || sender.id !== selfId || typeof sender.url !== 'string') return false;
    let u;
    try { u = new URL(sender.url); } catch (e) { return false; }
    return u.origin === PAGE_ORIGIN && u.pathname.startsWith(PAGE_PATH_PREFIX);
  }

  function isFresh(pending, now) {
    return !!pending && typeof pending.at === 'number' && now - pending.at < PENDING_TTL_MS;
  }

  // ---- 內容腳本接線（只在熱門新聞庫頁面、且擴充功能有效時註冊）-----------------
  function ack(nonce, ok, opened, error) {
    const m = { source: 'quickpattern', type: 'ack', nonce, ok, opened };
    if (error) m.error = error;
    window.postMessage(m, location.origin);
  }

  if (typeof document !== 'undefined' && typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.id) {
    window.addEventListener('message', event => {
      const d = event.data;
      if (event.source !== window || event.origin !== location.origin) return;
      if (!d || d.source !== 'hottopic' || d.type !== 'send-to-quickpattern' || d.v !== 1) return;
      if (typeof d.nonce !== 'string' || d.nonce.length > 64) return;
      const v = validateSend(d);
      if (!v.ok) { ack(d.nonce, false, false, v.error); return; }
      let p;
      try { p = chrome.runtime.sendMessage({ type: 'hottopic:send', url: v.url, title: v.title }); }
      catch (e) { ack(d.nonce, false, false, 'extension_unavailable'); return; }
      Promise.resolve(p).then(
        r => ack(d.nonce, !!(r && r.ok), !!(r && r.opened), r && r.error),
        () => ack(d.nonce, false, false, 'extension_unavailable')
      );
    });
  }

  root.QptBridge = { validateSend, senderAllowed, isFresh, PENDING_TTL_MS, PAGE_ORIGIN, PAGE_PATH_PREFIX };
  if (typeof module !== 'undefined' && module.exports) module.exports = root.QptBridge;
})(typeof self !== 'undefined' ? self : this);

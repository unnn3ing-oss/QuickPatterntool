// 點工具列圖示就打開側邊欄；另外定時問 GitHub 有沒有新版，有的話在圖示上顯示「新」。
// 真正的更新要在側邊欄按「更新」才會執行（見 updater.js）。
importScripts('updater.js', 'bridge.js');

const CHECK_EVERY_MINUTES = 60;   // 每小時檢查一次

// Chrome 會記住已建立的鬧鐘，所以光在安裝時建立不夠：
// 每次背景腳本啟動都確認一次，已存在但間隔不對（例如舊版的 6 小時）就改成現在的設定。
function ensureCheckAlarm() {
  chrome.alarms.get('check-update', alarm => {
    if (!alarm || alarm.periodInMinutes !== CHECK_EVERY_MINUTES) {
      chrome.alarms.create('check-update', { delayInMinutes: 1, periodInMinutes: CHECK_EVERY_MINUTES });
    }
  });
}
ensureCheckAlarm();

chrome.runtime.onInstalled.addListener(() => {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
  ensureCheckAlarm();
});
chrome.runtime.onStartup.addListener(() => {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
  ensureCheckAlarm();
});

chrome.alarms.onAlarm.addListener(async alarm => {
  if (alarm.name !== 'check-update') return;
  try {
    const info = await Updater.checkLatest();
    await chrome.action.setBadgeText({ text: info.hasUpdate ? '新' : '' });
    if (info.hasUpdate) await chrome.action.setBadgeBackgroundColor({ color: '#d92d20' });
  } catch (e) { /* offline or rate-limited: try again at the next alarm */ }
});

// 熱門新聞庫卡片的「送到套版」：bridge.js（內容腳本）驗證後轉進來。
// 暫存請求 → 嘗試打開側邊欄；Chrome 不允許（需要使用者操作）就在圖示顯示藍色「1」，
// 使用者點圖示打開側邊欄後，側邊欄會自己讀暫存並產圖（見 sidepanel.js）。
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || msg.type !== 'hottopic:send') return;
  (async () => {
    if (!QptBridge.senderAllowed(sender, chrome.runtime.id)) {
      return { ok: false, opened: false, error: 'sender_not_allowed' };
    }
    const v = QptBridge.validateSend(msg);
    if (!v.ok) return { ok: false, opened: false, error: v.error };
    // sidePanel.open 要在「使用者操作」仍有效時呼叫：驗證完立刻、同步送出，不能先 await 別的。
    // 暫存和開側邊欄並行；側邊欄啟動時讀一次、之後靠 storage.onChanged，晚一點寫入也會被讀到。
    let opening;
    try { opening = Promise.resolve(chrome.sidePanel.open({ windowId: sender.tab.windowId })); }
    catch (e) { opening = Promise.reject(e); }
    opening.catch(() => {});   // 失敗在下面處理，避免 unhandled rejection
    await chrome.storage.session.set({ pending: { url: v.url, title: v.title, at: Date.now() } });
    let opened = false;
    try { await opening; opened = true; } catch (e) { opened = false; }
    if (!opened) {
      await chrome.action.setBadgeText({ text: '1' });
      await chrome.action.setBadgeBackgroundColor({ color: '#1a73e8' });
    }
    return { ok: true, opened };
  })().then(sendResponse, () => sendResponse({ ok: false, opened: false, error: 'internal_error' }));
  return true;   // 非同步回覆
});

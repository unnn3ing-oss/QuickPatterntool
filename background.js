// 點工具列圖示就打開側邊欄；另外定時問 GitHub 有沒有新版，有的話在圖示上顯示「新」。
// 真正的更新要在側邊欄按「更新」才會執行（見 updater.js）。
importScripts('updater.js');

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

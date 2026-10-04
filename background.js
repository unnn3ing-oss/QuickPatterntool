// 點工具列圖示就打開側邊欄；另外定時問 GitHub 有沒有新版，有的話在圖示上顯示「新」。
// 真正的更新要在側邊欄按「更新」才會執行（見 updater.js）。
importScripts('updater.js');

chrome.runtime.onInstalled.addListener(() => {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
  chrome.alarms.create('check-update', { delayInMinutes: 1, periodInMinutes: 360 });
});
chrome.runtime.onStartup.addListener(() => {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
});

chrome.alarms.onAlarm.addListener(async alarm => {
  if (alarm.name !== 'check-update') return;
  try {
    const info = await Updater.checkLatest();
    await chrome.action.setBadgeText({ text: info.hasUpdate ? '新' : '' });
    if (info.hasUpdate) await chrome.action.setBadgeBackgroundColor({ color: '#d92d20' });
  } catch (e) { /* offline or rate-limited: try again at the next alarm */ }
});

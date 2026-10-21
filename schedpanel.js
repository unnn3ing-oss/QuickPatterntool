// 側邊欄的「FB 粉專排程」：介面由 schedui.js 產生（和網頁版的排程抽屜共用），這裡只負責接資料：
// 排程清單直接讀寫外掛的 chrome.storage.local（格式與驗證見 scheduler.js），發佈／留言要背景（poster.js）執行，所以用訊息請它開始。
(function () {
  const S = QptSched;
  const $ = id => document.getElementById(id);

  const api = {
    list: () => S.list(),
    get: async id => (await S.list()).find(i => i.id === id) || null,
    add: input => S.addItem(input),
    edit: (id, input) => S.edit(id, input),
    remove: id => S.remove(id),
    start: (id, o) => chrome.runtime.sendMessage({ type: 'poster:start', id, dryRun: !!(o && o.dryRun), mode: o && o.mode === 'comment' ? 'comment' : 'post' }),
    cancel: id => chrome.runtime.sendMessage({ type: 'poster:cancel', id }),
    loadPrefs: async () => { const got = await chrome.storage.local.get(S.PAGE_KEY); return { pageUrl: got[S.PAGE_KEY] }; },
    savePrefs: p => chrome.storage.local.set({ [S.PAGE_KEY]: p.pageUrl }),
    loadSettings: () => S.getSettings(),
    saveSettings: async s => { await S.setSettings({ background: !!s.background }); return { ok: true }; },
    onChange: cb => chrome.storage.onChanged.addListener((changes, area) => { if (area === 'local' && changes[S.KEY]) cb(); })
  };

  // 「帶入目前圖文」：複製框的文字、快速產圖的文章網址、目前預覽的成品圖（1080×1080 PNG，要先有標題與背景）
  async function compose() {
    const out = { text: $('qfCopyText').value.trim(), image: null, articleUrl: '' };
    const url = $('qfUrl').value.trim();
    if (url && S.withUtm(url, 'x')) out.articleUrl = url;
    if (!$('downloadBtn').disabled) {
      await whzFontReady;
      render();
      const blob = await new Promise(res => canvas.toBlob(res, 'image/png'));
      if (blob) {
        out.image = await new Promise((resolve, reject) => {
          const r = new FileReader();
          r.onload = () => resolve(r.result);
          r.onerror = () => reject(new Error('讀取圖片失敗'));
          r.readAsDataURL(blob);
        });
      }
    }
    return out;
  }

  QptSchedUI.mount($('schedCard'), { api, compose, confirm: askConfirm });
})();

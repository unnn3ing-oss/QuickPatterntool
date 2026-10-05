// 側邊欄的「版本更新」區塊（邏輯在 updater.js）。
(function () {
  const statusEl = document.getElementById('upStatus');
  const hintEl = document.getElementById('upHint');
  const checkBtn = document.getElementById('upCheckBtn');
  const applyBtn = document.getElementById('upApplyBtn');
  const filesBox = document.getElementById('upFiles');
  const filesSummary = document.getElementById('upFilesSummary');
  const fileList = document.getElementById('upFileList');
  let latest = null;

  function show(msg, hasUpdate) {
    statusEl.textContent = msg;
    statusEl.classList.toggle('has-update', !!hasUpdate);
  }
  // 版本號顯示：已是最新「 v1.24」；有新版「 v1.25（目前 v1.23，3 個檔案不同）」
  const ver = v => (v ? `v${v}` : '');
  function updateHeadline(info) {
    const n = `${info.changed.length} 個檔案不同`;
    if (!info.version) return `有新版本（${n}）`;
    if (info.version === info.localVersion) return `有新版本（版本號仍是 ${ver(info.version)}，${n}）`;
    return `有新版本 ${ver(info.version)}（目前 ${ver(info.localVersion)}，${n}）`;
  }
  const fmtDate = iso => new Date(iso).toLocaleString('zh-TW', { hour12: false });

  // 還沒選過資料夾時，先在按鈕旁邊寫明資料夾在哪（系統的選資料夾視窗會蓋住畫面，所以要事先講）
  async function refreshFolderHint() {
    hintEl.textContent = '';
    if (await Updater.hasSavedFolder()) { applyBtn.textContent = '更新到最新版'; return; }
    applyBtn.textContent = '選擇資料夾並更新';
    hintEl.append(
      '第一次更新要先選擇這個擴充功能所在的資料夾（只需選這一次）。',
      document.createElement('br'),
      '資料夾位置：開啟下面的「詳細資料」頁，找到「來源」那一行的路徑。',
      document.createElement('br'));
    const link = document.createElement('button');
    link.type = 'button';
    link.className = 'up-link';
    link.id = 'upOpenExt';
    link.textContent = '開啟擴充功能詳細資料頁';
    link.addEventListener('click', () => chrome.tabs.create({ url: `chrome://extensions/?id=${chrome.runtime.id}` }));
    hintEl.append(link);
  }

  // 列出這次要更新的檔案（新增／修改），讓使用者更新前看得到會動到什麼
  function showFiles(changed) {
    fileList.textContent = '';
    for (const f of changed) {
      const li = document.createElement('li');
      li.textContent = f.path;
      const tag = document.createElement('span');
      tag.className = 'up-tag';
      tag.textContent = f.status === 'new' ? '新增' : '修改';
      li.append(tag);
      fileList.append(li);
    }
    filesSummary.textContent = `要更新的檔案（${changed.length}）`;
    filesBox.hidden = !changed.length;
    filesBox.open = false;
  }

  async function check() {
    checkBtn.disabled = true;
    show('檢查中…');
    hintEl.textContent = '';
    filesBox.hidden = true;
    try {
      latest = await Updater.checkLatest();
      if (latest.hasUpdate) {
        show(`${updateHeadline(latest)}：${latest.message}｜${fmtDate(latest.date)}`, true);
        applyBtn.hidden = false;
        showFiles(latest.changed);
        await refreshFolderHint();
        chrome.action.setBadgeText({ text: '新' }).catch(() => {});
        chrome.action.setBadgeBackgroundColor({ color: '#d92d20' }).catch(() => {});
      } else {
        show(`已是最新版本${latest.version ? ' ' + ver(latest.version) : ''}（${fmtDate(latest.date)}）`);
        applyBtn.hidden = true;
        chrome.action.setBadgeText({ text: '' }).catch(() => {});
      }
    } catch (err) {
      show(err.message || String(err));
      applyBtn.hidden = true;
    } finally {
      checkBtn.disabled = false;
    }
  }

  async function apply() {
    if (!latest || !latest.hasUpdate) return;
    applyBtn.disabled = checkBtn.disabled = true;
    try {
      let dir = await Updater.getFolder();
      if (!dir) dir = await Updater.pickFolder();
      await Updater.apply(dir, latest, msg => show(msg), risks => askConfirm({
        title: '這次更新會增加權限',
        message: `新版的 manifest.json 有以下變動：\n・${risks.join('\n・')}\n\n只有信任這份更新時才要繼續。`,
        okText: '仍要更新'
      }));
      show('更新完成，重新載入擴充功能…');
      setTimeout(() => chrome.runtime.reload(), 400);
    } catch (err) {
      if (err && err.name === 'AbortError') show('已取消，沒有更新任何檔案');
      else show(`更新失敗：${err.message || err}`);
      applyBtn.disabled = checkBtn.disabled = false;
    }
  }

  checkBtn.addEventListener('click', check);
  applyBtn.addEventListener('click', apply);
  check();
})();

// 「複製圖片」：把目前預覽的成品（1080×1080 PNG）放進剪貼簿，可以直接貼到其他地方。
(function () {
  const btn = document.getElementById('copyImageBtn');
  const download = document.getElementById('downloadBtn');
  const sync = () => { btn.disabled = download.disabled; };
  new MutationObserver(sync).observe(download, { attributes: true, attributeFilter: ['disabled'] });
  sync();

  btn.addEventListener('click', async () => {
    const label = '複製圖片';
    const flash = text => { btn.textContent = text; setTimeout(() => { btn.textContent = label; }, 1600); };
    try {
      await whzFontReady;
      render();
      const blob = await new Promise((resolve, reject) =>
        canvas.toBlob(b => (b ? resolve(b) : reject(new Error('產生圖片失敗'))), 'image/png'));
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
      flash('已複製 ✓');
    } catch (err) {
      flash('複製失敗');
    }
  });
})();

// 側邊欄的「FB 粉專排程」：填好內容、選時間、加入排程；下方列出所有排程，可試跑、立即發佈、刪除。
// 資料格式與驗證見 scheduler.js；到點自動發佈的是背景的 poster.js，這裡只負責建立與顯示。
(function () {
  const S = QptSched;
  const $ = id => document.getElementById(id);
  const el = {
    page: $('schPage'), text: $('schText'), thumbs: $('schThumbs'), file: $('schFile'), addImg: $('schAddImg'),
    fill: $('schFillBtn'), at: $('schAt'), add: $('schAddBtn'), status: $('schStatus'), list: $('schList')
  };
  const MAX_IMAGE_BYTES = 15 * 1024 * 1024;
  let images = [];   // 這張表單目前選的圖片 [{name, dataUrl}]

  function say(msg, kind) {
    el.status.textContent = msg || '';
    el.status.className = 'qf-status' + (kind ? ' ' + kind : '');
  }
  const fmt = t => new Date(t).toLocaleString('zh-TW', { hour12: false, month: 'numeric', day: 'numeric', weekday: 'short', hour: '2-digit', minute: '2-digit' });
  function toLocalInput(ms) {
    const d = new Date(ms - new Date(ms).getTimezoneOffset() * 60000);
    return d.toISOString().slice(0, 16);
  }
  // 預設時間：至少 10 分鐘後的下一個整點或半點
  function defaultTime() {
    const t = new Date(Date.now() + 10 * 60000);
    t.setSeconds(0, 0);
    t.setMinutes(t.getMinutes() <= 30 ? 30 : 60);
    return t.getTime();
  }

  const readFile = file => new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.onerror = () => reject(new Error('讀取圖片失敗'));
    r.readAsDataURL(file);
  });

  // ---- 圖片縮圖 -----------------------------------------------------------
  function renderThumbs() {
    el.thumbs.textContent = '';
    images.forEach((im, i) => {
      const box = document.createElement('div');
      box.className = 'sch-thumb';
      const img = document.createElement('img');
      img.src = im.dataUrl;
      img.alt = im.name;
      const x = document.createElement('button');
      x.type = 'button';
      x.className = 'sch-thumb-x';
      x.textContent = '✕';
      x.title = '移除這張圖片';
      x.setAttribute('aria-label', `移除第 ${i + 1} 張圖片`);
      x.addEventListener('click', () => { images.splice(i, 1); renderThumbs(); });
      box.append(img, x);
      el.thumbs.append(box);
    });
    el.thumbs.hidden = !images.length;
    el.addImg.textContent = images.length ? `加入圖片（${images.length}/${S.MAX_IMAGES}）` : '加入圖片';
  }

  async function addFiles(files) {
    for (const f of files) {
      if (images.length >= S.MAX_IMAGES) { say(`圖片最多 ${S.MAX_IMAGES} 張`, 'warn'); break; }
      if (!/^image\/(png|jpe?g|webp|gif)$/.test(f.type)) { say(`${f.name}：只支援 PNG、JPG、WebP、GIF`, 'warn'); continue; }
      if (f.size > MAX_IMAGE_BYTES) { say(`${f.name} 超過 15MB`, 'warn'); continue; }
      images.push({ name: f.name, dataUrl: await readFile(f) });
    }
    renderThumbs();
  }

  // 「帶入目前圖文」：複製框的文字 + 目前預覽的成品圖
  async function fillFromPreview() {
    const text = $('qfCopyText').value.trim();
    let usedImage = false;
    if (!$('downloadBtn').disabled) {
      await whzFontReady;
      render();
      const blob = await new Promise(res => canvas.toBlob(res, 'image/png'));
      if (blob) {
        images = [{ name: 'preview.png', dataUrl: await readFile(blob) }];
        usedImage = true;
      }
    }
    if (text) el.text.value = text;
    renderThumbs();
    if (!text && !usedImage) say('目前沒有可以帶入的內容：先快速產圖，或在「複製圖文格式」輸入文字', 'warn');
    else say(`已帶入${text ? '文字' : ''}${text && usedImage ? '和' : ''}${usedImage ? '預覽圖片' : ''}${usedImage ? '' : '（目前預覽沒有圖片，所以沒帶圖）'}`, usedImage ? 'ok' : 'warn');
  }

  // ---- 加入排程 -----------------------------------------------------------
  async function addToQueue() {
    const page = S.normalizePageUrl(el.page.value);
    if (!page.ok) { say(page.error, 'err'); el.page.focus(); return; }
    const at = el.at.value ? new Date(el.at.value).getTime() : NaN;
    if (!isFinite(at)) { say('請選擇發佈時間', 'err'); el.at.focus(); return; }
    if (at < Date.now() + 60000) { say('發佈時間要在一分鐘以後', 'err'); el.at.focus(); return; }
    const item = { id: S.newId(), text: el.text.value.trim(), images: images.slice(), pageUrl: page.url, at, status: 'pending', createdAt: Date.now() };
    const v = S.validateItem(item);
    if (!v.ok) { say(v.error, 'err'); return; }
    try { await S.add(item); }
    catch (e) { say(e.message || '加入失敗（儲存空間不足？）', 'err'); return; }
    chrome.storage.local.set({ [S.PAGE_KEY]: page.url }).catch(() => {});
    el.text.value = '';
    images = [];
    renderThumbs();
    el.at.value = toLocalInput(defaultTime());
    say(`已排入 ${fmt(at)}。到時間瀏覽器要開著，會自動開新分頁發佈`, 'ok');
  }

  // ---- 排程清單 -----------------------------------------------------------
  const STATUS = { pending: '等待中', running: '執行中', done: '已發佈', failed: '失敗', missed: '錯過' };

  function detailOf(item) {
    if (item.status === 'running') return `${item.dryRun ? '試跑' : '發佈'}中：${S.STEP_LABELS[item.step] || '開始'}…`;
    if (item.error) return item.error;
    if (item.step === 'dry-ok') return '試跑完成：內容有填好，沒有發佈';
    if (item.status === 'done') return `已在 ${fmt(item.finishedAt)} 發佈`;
    return '';
  }

  async function startNow(item, dryRun) {
    if (!dryRun) {
      const uncertain = item.status === 'failed' && item.step === 'publishing';
      const ok = await askConfirm({
        title: item.status === 'pending' ? '現在就發佈到粉專？' : '重新發佈到粉專？',
        message: (uncertain ? '上一次已經按下發佈但沒收到結果，貼文可能已經發出去了，請先到粉專確認，免得重複發文。\n\n' : '')
          + '會立刻開啟 Facebook 並發佈這則貼文，發出後無法由外掛收回。',
        okText: '發佈'
      });
      if (!ok) return;
    }
    say(dryRun ? '試跑中：會開啟 Facebook 填好內容，但不會發佈' : '開始發佈…');
    let r;
    try { r = await chrome.runtime.sendMessage({ type: 'poster:start', id: item.id, dryRun }); }
    catch (e) { r = { ok: false, error: '無法連到背景程式，請重新載入外掛' }; }
    if (r && r.ok) say('');
    else say((r && r.error) || '無法開始', 'err');
  }

  function renderList(items) {
    el.list.textContent = '';
    const sorted = items.slice().sort((a, b) => a.at - b.at);
    el.list.hidden = !sorted.length;
    for (const item of sorted) {
      const li = document.createElement('div');
      li.className = 'sch-item sch-' + item.status;

      const head = document.createElement('div');
      head.className = 'sch-item-head';
      const time = document.createElement('span');
      time.className = 'sch-time';
      time.textContent = fmt(item.at);
      const chip = document.createElement('span');
      chip.className = 'sch-chip';
      chip.textContent = STATUS[item.status] || item.status;
      head.append(time, chip);

      const body = document.createElement('div');
      body.className = 'sch-text';
      const first = (item.text || '').split('\n').find(l => l.trim()) || '（只有圖片）';
      body.textContent = first.length > 60 ? first.slice(0, 60) + '…' : first;
      if (item.images.length) body.textContent += `　🖼 ${item.images.length}`;

      li.append(head, body);
      const detail = detailOf(item);
      if (detail) {
        const d = document.createElement('div');
        d.className = 'sch-detail' + (item.status === 'failed' || item.status === 'missed' ? ' err' : '');
        d.textContent = detail;
        li.append(d);
      }

      const actions = document.createElement('div');
      actions.className = 'sch-actions';
      const btn = (text, fn, cls) => {
        const b = document.createElement('button');
        b.type = 'button';
        b.textContent = text;
        if (cls) b.className = cls;
        b.addEventListener('click', fn);
        actions.append(b);
        return b;
      };
      if (item.status !== 'running' && item.status !== 'done') {
        btn('試跑', () => startNow(item, true)).title = '開啟 Facebook 並填好內容，但不按發佈';
        btn(item.status === 'pending' ? '立即發佈' : '重新發佈', () => startNow(item, false));
      }
      if (item.status !== 'running') btn('刪除', async () => { await S.remove(item.id); });
      li.append(actions);
      el.list.append(li);
    }
  }

  async function refresh() {
    try { renderList(await S.list()); } catch (e) { /* 儲存空間讀不到：維持原樣 */ }
  }

  // ---- 啟動 ---------------------------------------------------------------
  el.fill.addEventListener('click', () => fillFromPreview().catch(() => say('帶入失敗', 'err')));
  el.addImg.addEventListener('click', () => el.file.click());
  el.file.addEventListener('change', async () => { await addFiles([...el.file.files]); el.file.value = ''; });
  el.add.addEventListener('click', addToQueue);
  el.page.addEventListener('change', () => {
    const p = S.normalizePageUrl(el.page.value);
    if (p.ok) chrome.storage.local.set({ [S.PAGE_KEY]: p.url }).catch(() => {});
  });
  chrome.storage.onChanged.addListener((changes, area) => { if (area === 'local' && changes[S.KEY]) refresh(); });

  el.at.value = toLocalInput(defaultTime());
  renderThumbs();
  chrome.storage.local.get(S.PAGE_KEY).then(got => { if (got[S.PAGE_KEY] && !el.page.value) el.page.value = got[S.PAGE_KEY]; }).catch(() => {});
  refresh();
})();

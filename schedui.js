// FB 粉專排程的介面（側邊欄與網頁版的「排程」抽屜共用）：填好內容、選時間、加入排程；下方列出所有排程，可編輯、試跑、立即發佈、刪除，
// 已發佈的可以試跑留言／補留言。資料怎麼存取由呼叫端用 api 提供（側邊欄直接讀寫外掛的 storage，網頁版透過 schedbridge.js 轉給外掛），
// 所以這個檔案完全不碰 chrome.*。需要先載入 scheduler.js（驗證、追蹤碼、留言組合）。
//
// QptSchedUI.mount(container, { api, compose, confirm }) → { refresh }
//   api：{ list():Promise<item[]>, get(id):Promise<item|null>, add(input):Promise<{ok,error}>, edit(id,input):Promise<{ok,error}>,
//          remove(id), start(id,{dryRun,mode}):Promise<{ok,error}>, loadPrefs():Promise<{pageUrl}>, savePrefs({pageUrl}), onChange(cb) }
//   compose（選用）：async () => ({ text, image(dataURL|null), articleUrl })，「帶入目前圖文」用
//   confirm（選用）：async ({ title, message, okText }) => boolean
(function (root) {
  const S = root.QptSched;
  const STATUS = { pending: '等待中', running: '執行中', done: '已發佈', failed: '失敗', missed: '錯過' };
  const MAX_IMAGE_BYTES = 15 * 1024 * 1024;

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

  // 小工具：h('div', { class:'x', text:'…', onclick }, child, …)
  function h(tag, props, ...kids) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(props || {})) {
      if (v == null || v === false) continue;
      if (k === 'text') el.textContent = v;
      else if (k === 'class') el.className = v;
      else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
      else if (v === true) el.setAttribute(k, '');
      else el.setAttribute(k, v);
    }
    for (const kid of kids) if (kid) el.append(kid);
    return el;
  }

  function mount(container, opts) {
    const { api, compose } = opts;
    const confirm = opts.confirm || (async ({ message }) => window.confirm(message));
    let images = [];    // 表單目前選的圖片 [{name, dataUrl}]
    let editId = null;  // 編輯中的排程 id（null＝新增）

    container.textContent = '';
    container.classList.add('sch-root');

    // ---- 版面 ---------------------------------------------------------------
    const el = {};
    el.fill = compose ? h('button', { type: 'button', class: 'success', id: 'schFillBtn', title: '帶入目前的文字、文章網址和預覽圖片', text: '帶入目前圖文' }) : null;
    container.append(h('div', { class: 'sp-card-head sch-head' }, h('h2', { text: 'FB 粉專排程' }), el.fill));

    el.editBar = h('div', { class: 'sch-editbar', id: 'schEditBar', hidden: true });
    el.editLabel = h('span', { id: 'schEditLabel' });
    el.cancelEdit = h('button', { type: 'button', id: 'schCancelEdit', text: '取消編輯' });
    el.editBar.append(el.editLabel, el.cancelEdit);
    container.append(el.editBar);

    el.preset = h('select', { id: 'schPreset', class: 'sch-input sch-select', 'aria-label': '選擇粉專' },
      h('option', { value: '', text: '自訂' }), ...S.PAGES.map(p => h('option', { value: p.id, text: p.name })));
    el.page = h('input', { type: 'url', id: 'schPage', class: 'sch-input', placeholder: 'https://www.facebook.com/你的粉專', autocomplete: 'off', spellcheck: 'false' });
    container.append(h('div', { class: 'sch-field' }, h('label', { for: 'schPage', text: '粉專' }), h('div', { class: 'sch-row' }, el.preset, el.page)));

    el.text = h('textarea', { id: 'schText', rows: '4', placeholder: '貼文內容（可以空白，但文字和圖片至少要有一樣）', spellcheck: 'false' });
    container.append(el.text);
    el.thumbs = h('div', { class: 'sch-thumbs', id: 'schThumbs', hidden: true });
    el.addImg = h('button', { type: 'button', id: 'schAddImg', text: '加入圖片' });
    el.file = h('input', { type: 'file', id: 'schFile', accept: 'image/png,image/jpeg,image/webp,image/gif', multiple: true, hidden: true });
    container.append(el.thumbs, h('div', { class: 'sch-row' }, el.addImg, el.file));

    el.article = h('input', { type: 'url', id: 'schArticle', class: 'sch-input', placeholder: 'https://news.tvbs.com.tw/…', autocomplete: 'off', spellcheck: 'false' });
    container.append(h('div', { class: 'sch-field' }, h('label', { for: 'schArticle', text: '文章網址（留言用，會自動加追蹤碼）' }), el.article));
    el.note = h('input', { type: 'text', id: 'schNote', class: 'sch-input', placeholder: '留言的第一行，例如：你也這樣覺得嗎？👀', maxlength: String(S.MAX_NOTE), autocomplete: 'off' });
    container.append(h('div', { class: 'sch-field' }, h('label', { for: 'schNote', text: '小編文' }), el.note));
    el.preview = h('div', { class: 'sch-preview', id: 'schCommentPreview', hidden: true });
    container.append(el.preview);

    el.at = h('input', { type: 'datetime-local', id: 'schAt', class: 'sch-input' });
    el.add = h('button', { type: 'button', class: 'primary', id: 'schAddBtn', text: '加入排程' });
    container.append(h('div', { class: 'sch-field' }, h('label', { for: 'schAt', text: '發佈時間' }), h('div', { class: 'sch-row' }, el.at, el.add)));

    el.status = h('div', { class: 'qf-status', id: 'schStatus', role: 'status' });
    el.list = h('div', { class: 'sch-list', id: 'schList', hidden: true });
    container.append(el.status, el.list, h('div', { class: 'hint', text: '到時間瀏覽器要開著、電腦不能休眠；外掛會自動開新分頁發佈並在貼文下留言，發完關閉。請先在 Facebook 切換成粉專身分。第一次建議先按「試跑」確認內容有正確填好。' }));

    function say(msg, kind) {
      el.status.textContent = msg || '';
      el.status.className = 'qf-status' + (kind ? ' ' + kind : '');
    }

    // ---- 粉專下拉選單 ↔ 網址 ----------------------------------------------------
    function syncPresetFromUrl() {
      const pg = S.pageOf(el.page.value);
      el.preset.value = pg ? pg.id : '';
    }
    function savePage() {
      const p = S.normalizePageUrl(el.page.value);
      if (p.ok && api.savePrefs) Promise.resolve(api.savePrefs({ pageUrl: p.url })).catch(() => {});
    }
    el.preset.addEventListener('change', () => {
      const pg = S.PAGES.find(p => p.id === el.preset.value);
      if (pg) { el.page.value = pg.url; savePage(); }
      else el.page.focus();
      renderPreview();
    });
    el.page.addEventListener('input', () => { syncPresetFromUrl(); renderPreview(); });
    el.page.addEventListener('change', savePage);

    // ---- 留言預覽：小編文＋換行＋文章網址（照粉專與有無圖片帶追蹤碼）---------------------
    function currentComment() {
      const p = S.normalizePageUrl(el.page.value);
      return S.commentOf({ note: el.note.value, articleUrl: el.article.value, pageUrl: p.ok ? p.url : el.page.value, images });
    }
    function renderPreview() {
      const url = el.article.value.trim();
      el.preview.className = 'sch-preview';
      if (url && !S.withUtm(url, 'x')) {
        el.preview.hidden = false;
        el.preview.classList.add('warn');
        el.preview.textContent = '文章網址要是 http(s) 網址';
        return;
      }
      const c = currentComment();
      el.preview.hidden = !c;
      el.preview.textContent = c ? '發佈後會自動留言：\n' + c : '';
    }
    for (const input of [el.article, el.note]) input.addEventListener('input', renderPreview);

    // ---- 圖片縮圖 -------------------------------------------------------------
    function renderThumbs() {
      el.thumbs.textContent = '';
      images.forEach((im, i) => {
        const x = h('button', { type: 'button', class: 'sch-thumb-x', text: '✕', title: '移除這張圖片', 'aria-label': `移除第 ${i + 1} 張圖片` });
        x.addEventListener('click', () => { images.splice(i, 1); renderThumbs(); renderPreview(); });
        el.thumbs.append(h('div', { class: 'sch-thumb' }, h('img', { src: im.dataUrl, alt: im.name }), x));
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
      renderPreview();
    }
    el.addImg.addEventListener('click', () => el.file.click());
    el.file.addEventListener('change', async () => { await addFiles([...el.file.files]); el.file.value = ''; });

    // 「帶入目前圖文」
    async function fillFromCompose() {
      const c = (await compose()) || {};
      const text = (c.text || '').trim();
      if (c.image) images = [{ name: 'preview.png', dataUrl: c.image }];
      if (text) el.text.value = text;
      if (c.articleUrl) el.article.value = c.articleUrl;
      renderThumbs();
      renderPreview();
      const got = [text && '文字', c.articleUrl && '文章網址', c.image && '預覽圖片'].filter(Boolean);
      if (!got.length) say('目前沒有可以帶入的內容：請先完成一張套版圖（側邊欄是快速產圖），或自己輸入文字、加入圖片', 'warn');
      else say(`已帶入${got.join('、')}${c.image ? '' : '（目前預覽沒有圖片，所以沒帶圖）'}`, c.image ? 'ok' : 'warn');
    }
    if (el.fill) el.fill.addEventListener('click', () => fillFromCompose().catch(() => say('帶入失敗', 'err')));

    // ---- 新增／編輯 ------------------------------------------------------------
    function resetForm() {
      editId = null;
      el.text.value = '';
      el.article.value = '';
      el.note.value = '';
      images = [];
      el.at.value = toLocalInput(defaultTime());
      el.add.textContent = '加入排程';
      el.editBar.hidden = true;
      renderThumbs();
      renderPreview();
    }
    function readForm() {
      const p = S.normalizePageUrl(el.page.value);
      if (!p.ok) { say(p.error, 'err'); el.page.focus(); return null; }
      const at = el.at.value ? new Date(el.at.value).getTime() : NaN;
      if (!isFinite(at)) { say('請選擇發佈時間', 'err'); el.at.focus(); return null; }
      return { pageUrl: p.url, text: el.text.value.trim(), images: images.slice(), note: el.note.value.trim(), articleUrl: el.article.value.trim(), at };
    }
    async function submit() {
      const input = readForm();
      if (!input) return;
      // 先在這裡驗證一次，給最直接的提示（外掛那邊還會再驗證）
      const b = S.buildItem(input);
      if (!b.ok) { say(b.error, 'err'); return; }
      el.add.disabled = true;
      let r;
      try { r = editId ? await api.edit(editId, input) : await api.add(input); }
      catch (e) { r = { ok: false, error: e && e.message ? e.message : '無法連到外掛' }; }
      el.add.disabled = false;
      if (!r || !r.ok) { say((r && r.error) || '加入失敗', 'err'); return; }
      const wasEdit = !!editId;
      if (api.savePrefs) Promise.resolve(api.savePrefs({ pageUrl: input.pageUrl })).catch(() => {});
      resetForm();
      say(`${wasEdit ? '已更新' : '已排入'} ${fmt(input.at)}。到時間瀏覽器要開著，會自動開新分頁發佈`, 'ok');
      refresh();
    }
    el.add.addEventListener('click', submit);
    el.cancelEdit.addEventListener('click', () => { resetForm(); say(''); });

    async function startEdit(item) {
      const full = await api.get(item.id);
      if (!full) { say('找不到這筆排程', 'err'); return; }
      editId = full.id;
      el.page.value = full.pageUrl;
      syncPresetFromUrl();
      el.text.value = full.text || '';
      el.note.value = full.note || '';
      el.article.value = full.articleUrl || '';
      images = (full.images || []).map(im => ({ name: im.name, dataUrl: im.dataUrl }));
      el.at.value = toLocalInput(full.at > Date.now() + 120000 ? full.at : defaultTime());
      el.add.textContent = '更新排程';
      el.editLabel.textContent = full.at > Date.now() ? `編輯中：${fmt(full.at)} 的排程` : `編輯中：${fmt(full.at)} 的排程（時間已過，請重新選時間）`;
      el.editBar.hidden = false;
      renderThumbs();
      renderPreview();
      say('');
      container.scrollIntoView({ block: 'start', behavior: 'smooth' });
    }

    // ---- 排程清單 -------------------------------------------------------------
    function detailsOf(item) {
      const out = [];
      if (item.status === 'running') {
        const what = item.mode === 'comment' ? (item.dryRun ? '試跑留言' : '補留言') : (item.dryRun ? '試跑' : '發佈');
        out.push({ text: `${what}中：${S.STEP_LABELS[item.step] || '開始'}…` });
        return out;
      }
      if (item.status === 'done') {
        out.push({ text: `已在 ${fmt(item.finishedAt || item.at)} 發佈` });
        if (item.commentState === 'done') out.push({ text: '留言：已完成' });
        else if (item.commentState === 'failed') out.push({ text: `留言失敗：${item.commentError || '原因不明'}`, err: true });
        if (item.step === 'dry-ok') out.push({ text: '試跑留言完成：留言有打好，沒有送出' });
        return out;
      }
      if (item.error) out.push({ text: item.error, err: item.status === 'failed' || item.status === 'missed' });
      else if (item.step === 'dry-ok') out.push({ text: '試跑完成：內容有填好，沒有發佈' });
      return out;
    }

    async function run(item, { dryRun, mode }) {
      if (!dryRun) {
        const isComment = mode === 'comment';
        const uncertain = !isComment && item.status === 'failed' && item.step === 'publishing';
        const ok = await confirm(isComment
          ? { title: item.commentState === 'done' ? '再留言一次？' : '補留言？', message: '會開啟 Facebook，在這則貼文下留言，留言送出後無法由外掛收回。' + (item.commentState === 'done' ? '\n\n這則貼文已經留過言了，再留一次會有重複的留言。' : ''), okText: '留言' }
          : {
            title: item.status === 'pending' ? '現在就發佈到粉專？' : '重新發佈到粉專？',
            message: (uncertain ? '上一次已經按下發佈但沒收到結果，貼文可能已經發出去了，請先到粉專確認，免得重複發文。\n\n' : '') + '會立刻開啟 Facebook 並發佈這則貼文，發出後無法由外掛收回。',
            okText: '發佈'
          });
        if (!ok) return;
      }
      say(dryRun ? (mode === 'comment' ? '試跑留言中：會把留言打好，但不會送出' : '試跑中：會開啟 Facebook 填好內容，但不會發佈') : (mode === 'comment' ? '開始留言…' : '開始發佈…'));
      let r;
      try { r = await api.start(item.id, { dryRun, mode }); }
      catch (e) { r = { ok: false, error: '無法連到外掛，請確認外掛已安裝並已更新到最新版' }; }
      if (r && r.ok) say('');
      else say((r && r.error) || '無法開始', 'err');
    }

    function renderList(items) {
      el.list.textContent = '';
      const sorted = items.slice().sort((a, b) => a.at - b.at);
      el.list.hidden = !sorted.length;
      for (const item of sorted) {
        const li = h('div', { class: 'sch-item sch-' + item.status + (item.id === editId ? ' sch-editing' : '') });
        li.append(h('div', { class: 'sch-item-head' }, h('span', { class: 'sch-time', text: fmt(item.at) }), h('span', { class: 'sch-chip', text: STATUS[item.status] || item.status })));
        const first = (item.text || '').split('\n').find(l => l.trim()) || '（只有圖片）';
        let body = first.length > 60 ? first.slice(0, 60) + '…' : first;
        if (item.images.length) body += `　🖼 ${item.images.length}`;
        li.append(h('div', { class: 'sch-text', text: body }));
        if (item.note) li.append(h('div', { class: 'sch-note', text: '💬 ' + (item.note.length > 40 ? item.note.slice(0, 40) + '…' : item.note) }));
        for (const d of detailsOf(item)) li.append(h('div', { class: 'sch-detail' + (d.err ? ' err' : ''), text: d.text }));

        const actions = h('div', { class: 'sch-actions' });
        const btn = (text, fn, title) => actions.append(h('button', { type: 'button', text, title, onclick: fn }));
        if (S.canEdit(item)) btn('編輯', () => startEdit(item).catch(() => say('讀取排程失敗', 'err')));
        if (item.status !== 'running' && item.status !== 'done') {
          btn('試跑', () => run(item, { dryRun: true, mode: 'post' }), '開啟 Facebook 並填好內容，但不按發佈');
          btn(item.status === 'pending' ? '立即發佈' : '重新發佈', () => run(item, { dryRun: false, mode: 'post' }));
        }
        if (item.status === 'done' && S.commentOf(item)) {
          btn('試跑留言', () => run(item, { dryRun: true, mode: 'comment' }), '在貼文下把留言打好，但不送出');
          btn(item.commentState === 'done' ? '再留言' : '補留言', () => run(item, { dryRun: false, mode: 'comment' }));
        }
        if (item.status !== 'running') btn('刪除', async () => { if (editId === item.id) resetForm(); await api.remove(item.id); refresh(); });
        li.append(actions);
        el.list.append(li);
      }
    }

    async function refresh() {
      try { renderList(await api.list()); } catch (e) { /* 讀不到（外掛沒回應）：維持原樣 */ }
    }

    // ---- 啟動 -----------------------------------------------------------------
    if (api.onChange) api.onChange(refresh);
    el.at.value = toLocalInput(defaultTime());
    renderThumbs();
    renderPreview();
    Promise.resolve(api.loadPrefs ? api.loadPrefs() : null).then(p => {
      if (p && p.pageUrl && !el.page.value) { el.page.value = p.pageUrl; syncPresetFromUrl(); renderPreview(); }
    }).catch(() => {});
    refresh();
    return { refresh };
  }

  root.QptSchedUI = { mount };
  if (typeof module !== 'undefined' && module.exports) module.exports = root.QptSchedUI;
})(typeof self !== 'undefined' ? self : this);

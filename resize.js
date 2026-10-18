// =====================================================================================
// 改尺寸（網頁版專用，獨立的檔案：外掛不需要，updater.js／deploy.js 的 SKIP 會略過它）
//
// 一次放一張或多張照片，輸入想要的寬、高，全部轉成這個尺寸。
//   裁切填滿：寬、高都要填；照片縮放到剛好蓋滿，多出來的裁掉。在預覽上拖曳可調整保留哪一塊（每張各自記住）。
//   等比縮放：寬、高只填一個，另一邊依原圖比例自動算；兩個都填時縮到剛好放進這個範圍，不裁切。
// 預覽用縮小的圖畫，下載時從原圖重畫一次；裁切位置用「0～1 的比例」記錄，所以兩邊的結果一致。
// 縮小幅度大時分段縮（每次最多縮一半），比一次縮到位清楚。
//
// 需要在 app.js、watermark.js 之後載入（會用到 askConfirm、isImageFile）。上排的功能切換在 watermark.js：
// 切到「尺寸」時它會送出 'qpt:func' 事件，這裡收到後重畫。
// =====================================================================================
(function () {
  const $ = id => document.getElementById(id);
  const app = $('resizeApp');
  const canvas = $('rsCanvas');
  if (!app || !canvas) return;

  const MAX_SIDE = 10000;                 // 寬、高的上限
  const MAX_PIXELS = 100e6;               // 輸出畫素上限（再大瀏覽器的畫布會失敗）
  const MAX_PHOTOS = 50;
  const PREVIEW_MAX = 1080;               // 預覽畫布的長邊
  const PREVIEW_SRC = 2000;               // 預覽用的縮小原圖長邊（拖曳時不用每次處理大圖）
  const THUMB = 208;
  const DL_GAP_MIN = 500, DL_GAP_MAX = 1000;

  const st = { photos: [], cur: 0, nextId: 1, mode: 'cover', fmt: 'auto', w: 1080, h: 1080 };
  const photo = () => st.photos[st.cur] || null;
  const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

  const inW = $('rsW'), inH = $('rsH');
  const statusEl = $('rsStatus');
  const emptyEl = $('rsEmpty');
  const downloadBtn = $('rsDownloadBtn'), downloadAllBtn = $('rsDownloadAllBtn');
  const shelf = $('rsShelf'), thumbsEl = $('rsThumbs');
  const hintEl = $('rsHint'), sizeHint = $('rsSizeHint'), modeHint = $('rsModeHint'), previewHint = $('rsPreviewHint');
  const g = canvas.getContext('2d');
  let busy = false, raf = 0;
  const active = () => !app.hidden;

  // ---- 算輸出尺寸與裁切範圍 ---------------------------------------------------------
  // 回傳 { tw, th, sx, sy, sw, sh }（sx…是原圖上要取的範圍）或 { error }
  function plan(p) {
    const iw = p.img.naturalWidth, ih = p.img.naturalHeight;
    const W = st.w, H = st.h;
    let tw, th;
    if (st.mode === 'cover') {
      if (!W || !H) return { error: '「裁切填滿」需要同時填寬和高' };
      tw = W; th = H;
      const k = Math.max(tw / iw, th / ih);
      const sw = tw / k, sh = th / k;
      return { tw, th, sx: (iw - sw) * p.fx, sy: (ih - sh) * p.fy, sw, sh, ox: iw * k - tw, oy: ih * k - th };
    }
    if (!W && !H) return { error: '請填寬或高（至少一個）' };
    const k = W && H ? Math.min(W / iw, H / ih) : W ? W / iw : H / ih;
    tw = Math.max(1, Math.round(iw * k)); th = Math.max(1, Math.round(ih * k));
    if (W && !H) tw = W; else if (H && !W) th = H;
    return { tw, th, sx: 0, sy: 0, sw: iw, sh: ih, ox: 0, oy: 0 };
  }
  const tooBig = pl => pl.tw * pl.th > MAX_PIXELS;

  // 把來源的一塊範圍畫到目標；縮小很多時每次最多縮一半
  function drawScaled(ctx, src, sx, sy, sw, sh, dx, dy, dw, dh) {
    let cur = src, cx = sx, cy = sy, cw = sw, ch = sh;
    for (;;) {
      const nw = cw / 2 >= dw ? Math.max(dw, Math.round(cw / 2)) : 0;
      const nh = ch / 2 >= dh ? Math.max(dh, Math.round(ch / 2)) : 0;
      if (!nw && !nh) break;
      const tmp = document.createElement('canvas');
      tmp.width = nw || Math.max(1, Math.round(cw)); tmp.height = nh || Math.max(1, Math.round(ch));
      const tg = tmp.getContext('2d');
      tg.imageSmoothingQuality = 'high';
      tg.drawImage(cur, cx, cy, cw, ch, 0, 0, tmp.width, tmp.height);
      cur = tmp; cx = 0; cy = 0; cw = tmp.width; ch = tmp.height;
    }
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(cur, cx, cy, cw, ch, dx, dy, dw, dh);
  }

  // ---- 預覽 ----------------------------------------------------------------------
  function schedule() { if (!raf) raf = requestAnimationFrame(() => { raf = 0; render(); }); }

  function render() {
    const p = photo();
    const n = st.photos.length;
    emptyEl.hidden = n > 0;
    canvas.hidden = !n;
    updateModeHint();
    drawThumbs();
    downloadBtn.disabled = true;
    downloadAllBtn.hidden = n < 2;
    downloadAllBtn.disabled = true;
    if (!p) { statusEl.textContent = '請先上傳照片'; sizeHint.textContent = ''; previewHint.textContent = ''; return; }
    const pl = plan(p);
    if (pl.error || tooBig(pl)) {
      canvas.hidden = true; emptyEl.hidden = false;
      emptyEl.textContent = pl.error || `輸出 ${pl.tw}×${pl.th} 超過 1 億畫素，請縮小一點`;
      statusEl.textContent = pl.error || '尺寸太大';
      sizeHint.textContent = '';
      previewHint.textContent = '';
      return;
    }
    const ps = Math.min(1, PREVIEW_MAX / Math.max(pl.tw, pl.th));
    const cw = Math.max(1, Math.round(pl.tw * ps)), ch = Math.max(1, Math.round(pl.th * ps));
    if (canvas.width !== cw || canvas.height !== ch) { canvas.width = cw; canvas.height = ch; }
    g.fillStyle = '#ffffff'; g.fillRect(0, 0, cw, ch);
    const f = p.prev.width / p.img.naturalWidth;            // 縮小預覽圖相對於原圖的比例
    drawScaled(g, p.prev, pl.sx * f, pl.sy * f, pl.sw * f, pl.sh * f, 0, 0, cw, ch);
    const movable = st.mode === 'cover' && (pl.ox > 0.5 || pl.oy > 0.5);
    canvas.classList.toggle('can-drag', movable);
    const iw = p.img.naturalWidth, ih = p.img.naturalHeight;
    statusEl.textContent = `輸出 ${pl.tw}×${pl.th}（原圖 ${iw}×${ih}）`;
    sizeHint.textContent = pl.tw > iw || pl.th > ih ? '比原圖大，放大後會偏模糊' : '';
    previewHint.textContent = movable ? '在預覽上拖曳可以調整保留的範圍；每張照片各自記住。' : '';
    emptyEl.textContent = '上傳或貼上照片，輸入寬高就會顯示轉換後的樣子';
    downloadBtn.disabled = busy;
    downloadAllBtn.disabled = busy || !st.photos.every(q => { const x = plan(q); return !x.error && !tooBig(x); });
  }

  function updateModeHint() {
    modeHint.textContent = st.mode === 'cover'
      ? '照片縮放到剛好蓋滿，多出來的部分裁掉。寬、高都要填。'
      : '寬、高填一個，另一邊自動依原圖比例算；兩個都填就縮到剛好放進這個範圍，不裁切。';
  }

  // ---- 展示窗（沿用浮水印的縮圖樣式）------------------------------------------------
  function paintThumb(c, p) {
    const t = c.getContext('2d');
    t.fillStyle = '#e8eef7'; t.fillRect(0, 0, THUMB, THUMB);
    const pl = plan(p);
    if (pl.error || tooBig(pl)) {
      const k = Math.min(THUMB / p.small.width, THUMB / p.small.height);
      const w = Math.round(p.small.width * k), h = Math.round(p.small.height * k);
      t.drawImage(p.small, (THUMB - w) / 2, (THUMB - h) / 2, w, h);
      return;
    }
    const k = Math.min(THUMB / pl.tw, THUMB / pl.th);
    const w = Math.max(1, Math.round(pl.tw * k)), h = Math.max(1, Math.round(pl.th * k));
    const f = p.small.width / p.img.naturalWidth;
    t.imageSmoothingQuality = 'high';
    t.drawImage(p.small, pl.sx * f, pl.sy * f, pl.sw * f, pl.sh * f, Math.round((THUMB - w) / 2), Math.round((THUMB - h) / 2), w, h);
  }

  let thumbKey = '', lastCentered = '';
  function drawThumbs() {
    shelf.hidden = st.photos.length < 2;
    const key = st.photos.map(p => p.id).join(',');
    if (key !== thumbKey) {
      thumbKey = key;
      thumbsEl.textContent = '';
      st.photos.forEach((p, i) => {
        const wrap = document.createElement('div');
        wrap.className = 'wm-thumb';
        wrap.title = `#${i + 1} ${p.name}`;
        const c = document.createElement('canvas');
        c.width = c.height = THUMB;
        const badge = document.createElement('span');
        badge.className = 'wm-thumb-no';
        badge.textContent = String(i + 1);
        const rm = document.createElement('button');
        rm.type = 'button';
        rm.className = 'remove-btn wm-thumb-rm';
        rm.title = '移除這張'; rm.setAttribute('aria-label', `移除第 ${i + 1} 張`);
        rm.innerHTML = '<svg viewBox="0 0 12 12" aria-hidden="true"><path d="M3 3l6 6M9 3l-6 6"/></svg>';
        rm.addEventListener('click', e => { e.stopPropagation(); removePhoto(p.id); });
        wrap.addEventListener('click', () => { st.cur = st.photos.findIndex(x => x.id === p.id); updateHint(); schedule(); });
        wrap.append(c, badge, rm);
        thumbsEl.append(wrap);
      });
      updateShelfNav();
    }
    st.photos.forEach((p, i) => {
      const wrap = thumbsEl.children[i];
      if (!wrap) return;
      wrap.classList.toggle('active-thumb', i === st.cur);
      paintThumb(wrap.firstChild, p);
    });
    const act = thumbsEl.children[st.cur];
    if (act && lastCentered !== `${thumbKey}|${st.cur}`) {
      lastCentered = `${thumbKey}|${st.cur}`;
      thumbsEl.scrollTo({ left: act.offsetLeft - (thumbsEl.clientWidth - act.offsetWidth) / 2 });
    }
  }
  function updateShelfNav() {
    const max = thumbsEl.scrollWidth - thumbsEl.clientWidth;
    $('rsShelfPrev').disabled = thumbsEl.scrollLeft <= 1;
    $('rsShelfNext').disabled = thumbsEl.scrollLeft >= max - 1;
  }
  $('rsShelfPrev').addEventListener('click', () => thumbsEl.scrollBy({ left: -thumbsEl.clientWidth * 0.8 }));
  $('rsShelfNext').addEventListener('click', () => thumbsEl.scrollBy({ left: thumbsEl.clientWidth * 0.8 }));
  thumbsEl.addEventListener('scroll', updateShelfNav, { passive: true });
  thumbsEl.addEventListener('wheel', e => {
    if (Math.abs(e.deltaX) > Math.abs(e.deltaY) || thumbsEl.scrollWidth <= thumbsEl.clientWidth) return;
    e.preventDefault();
    thumbsEl.scrollBy({ left: e.deltaY, behavior: 'auto' });
  }, { passive: false });
  new ResizeObserver(updateShelfNav).observe(thumbsEl);

  function removePhoto(id) {
    const i = st.photos.findIndex(p => p.id === id);
    if (i < 0) return;
    const [p] = st.photos.splice(i, 1);
    URL.revokeObjectURL(p.url);
    if (st.cur > i || st.cur >= st.photos.length) st.cur = Math.max(0, st.cur - 1);
    updateHint();
    schedule();
  }

  // ---- 載入照片 -------------------------------------------------------------------
  function loadImage(file) {
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(file);
      const im = new Image();
      im.onload = () => resolve({ im, url });
      im.onerror = () => { URL.revokeObjectURL(url); reject(new Error('decode')); };
      im.src = url;
    });
  }
  const isImage = f => (typeof isImageFile === 'function' ? isImageFile(f) : !!f && /^image\//.test(f.type));
  function shrink(im, maxSide) {
    const k = Math.min(1, maxSide / Math.max(im.naturalWidth, im.naturalHeight));
    const c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(im.naturalWidth * k)); c.height = Math.max(1, Math.round(im.naturalHeight * k));
    drawScaled(c.getContext('2d'), im, 0, 0, im.naturalWidth, im.naturalHeight, 0, 0, c.width, c.height);
    return c;
  }

  function updateHint(extra) {
    const n = st.photos.length, p = photo();
    const base = !n ? '輸入想要的寬高，所有照片一起轉換'
      : n === 1 ? `已載入：${p.name}（${p.img.naturalWidth}×${p.img.naturalHeight}）`
      : `已載入 ${n} 張；目前第 ${st.cur + 1} 張：${p.name}（${p.img.naturalWidth}×${p.img.naturalHeight}）`;
    hintEl.textContent = extra ? `${base}。${extra}` : base;
  }

  async function addPhotos(fileList) {
    const files = [...(fileList || [])];
    if (!files.length) return;
    const images = files.filter(isImage);
    const notes = [];
    if (images.length < files.length) notes.push(`略過 ${files.length - images.length} 個不是圖片的檔案`);
    const room = MAX_PHOTOS - st.photos.length;
    if (images.length > room) notes.push(`一次最多 ${MAX_PHOTOS} 張，多出的 ${images.length - room} 張沒有加入`);
    const wasEmpty = st.photos.length === 0;
    let failed = 0;
    for (const file of images.slice(0, Math.max(0, room))) {
      try {
        const { im, url } = await loadImage(file);
        st.photos.push({ id: st.nextId++, name: file.name, mime: file.type, img: im, url, fx: 0.5, fy: 0.5, prev: shrink(im, PREVIEW_SRC), small: shrink(im, THUMB * 2) });
      } catch (e) { failed++; }
    }
    if (failed) notes.push(`${failed} 張無法開啟（可能是不支援的格式，例如 HEIC，請改用 JPG／PNG）`);
    if (wasEmpty) st.cur = 0;
    updateHint(notes.join('；'));
    schedule();
  }

  const zone = $('rsDrop'), input = $('rsInput');
  zone.addEventListener('click', () => input.click());
  zone.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); input.click(); } });
  input.addEventListener('click', e => e.stopPropagation());
  input.addEventListener('change', () => { addPhotos(input.files); input.value = ''; });
  zone.addEventListener('dragover', e => { e.preventDefault(); zone.classList.add('drag'); });
  zone.addEventListener('dragleave', () => zone.classList.remove('drag'));
  zone.addEventListener('drop', e => { e.preventDefault(); e.stopPropagation(); zone.classList.remove('drag'); addPhotos(e.dataTransfer.files); });

  const stage = $('rsStage');
  stage.addEventListener('dragover', e => { e.preventDefault(); stage.classList.add('drag'); });
  stage.addEventListener('dragleave', () => stage.classList.remove('drag'));
  stage.addEventListener('drop', e => { e.preventDefault(); stage.classList.remove('drag'); addPhotos(e.dataTransfer.files); });

  // Ctrl+V：這個功能開著時一律由這裡處理（捕捉階段攔下，免得 app.js 把圖貼進看不見的「圖片套版」）
  document.addEventListener('paste', e => {
    if (!active()) return;
    const files = e.clipboardData ? [...e.clipboardData.items].filter(i => i.kind === 'file' && /^image\//.test(i.type)).map(i => i.getAsFile()) : [];
    e.stopImmediatePropagation();
    if (!files.length) return;
    e.preventDefault();
    addPhotos(files);
  }, true);

  // ---- 設定：方式、寬高、格式 --------------------------------------------------------
  const modeToggle = $('rsMode');
  modeToggle.querySelectorAll('button').forEach(btn => btn.addEventListener('click', () => {
    st.mode = btn.dataset.mode;
    modeToggle.querySelectorAll('button').forEach(b => b.classList.toggle('active', b === btn));
    schedule();
  }));
  const fmtToggle = $('rsFormat');
  fmtToggle.querySelectorAll('button').forEach(btn => btn.addEventListener('click', () => {
    st.fmt = btn.dataset.fmt;
    fmtToggle.querySelectorAll('button').forEach(b => b.classList.toggle('active', b === btn));
  }));

  // 輸入框：空白＝沒填（0）；不是 1～10000 的整數就視為沒填，離開輸入框時再把數字修正回範圍內
  const parseSide = el => { const v = Math.floor(Number(el.value)); return el.value.trim() !== '' && v >= 1 ? Math.min(v, MAX_SIDE) : 0; };
  function readSize() { st.w = parseSide(inW); st.h = parseSide(inH); schedule(); }
  inW.addEventListener('input', readSize);
  inH.addEventListener('input', readSize);
  for (const el of [inW, inH]) {
    el.addEventListener('change', () => { const v = parseSide(el); el.value = v ? String(v) : ''; readSize(); });
    el.addEventListener('keydown', e => { if (e.key === 'Enter') el.blur(); });
  }
  $('rsSwapBtn').addEventListener('click', () => {
    [inW.value, inH.value] = [inH.value, inW.value];
    readSize();
  });
  inW.value = st.w; inH.value = st.h;

  // ---- 預覽上拖曳調整裁切位置 ---------------------------------------------------------
  let drag = null;
  canvas.addEventListener('pointerdown', e => {
    const p = photo();
    if (!p || st.mode !== 'cover' || e.button > 0) return;
    const pl = plan(p);
    if (pl.error || (pl.ox <= 0.5 && pl.oy <= 0.5)) return;
    drag = { id: e.pointerId, x: e.clientX, y: e.clientY, fx: p.fx, fy: p.fy, pl, p };
    canvas.setPointerCapture(e.pointerId);
    canvas.classList.add('dragging');
  });
  canvas.addEventListener('pointermove', e => {
    if (!drag || e.pointerId !== drag.id) return;
    const r = canvas.getBoundingClientRect();
    const toOut = drag.pl.tw / r.width;                // 螢幕像素 → 輸出像素
    const { ox, oy } = drag.pl;
    // 往右拖＝照片往右移＝露出更左邊的部分
    if (ox > 0.5) drag.p.fx = clamp(drag.fx - (e.clientX - drag.x) * toOut / ox, 0, 1);
    if (oy > 0.5) drag.p.fy = clamp(drag.fy - (e.clientY - drag.y) * toOut / oy, 0, 1);
    schedule();
  });
  const endDrag = e => {
    if (!drag || (e && e.pointerId !== drag.id)) return;
    drag = null;
    canvas.classList.remove('dragging');
  };
  canvas.addEventListener('pointerup', endDrag);
  canvas.addEventListener('pointercancel', endDrag);

  // ---- 輸出 ------------------------------------------------------------------------
  const safeBase = name => (name.replace(/\.[^.]+$/, '').replace(/[\\/:*?"<>|]/g, '').trim().slice(0, 60)) || '照片';
  const extFor = p => (st.fmt === 'png' ? 'png' : st.fmt === 'jpeg' ? 'jpg' : (p.mime === 'image/jpeg' ? 'jpg' : 'png'));

  async function exportPhoto(p) {
    const pl = plan(p);
    if (pl.error) throw new Error(pl.error);
    if (tooBig(pl)) throw new Error(`${p.name} 的輸出 ${pl.tw}×${pl.th} 超過 1 億畫素`);
    const ext = extFor(p);
    const c = document.createElement('canvas');
    c.width = pl.tw; c.height = pl.th;
    const ctx = c.getContext('2d');
    if (ext === 'jpg') { ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, pl.tw, pl.th); }   // JPG 沒有透明，墊白底
    drawScaled(ctx, p.img, pl.sx, pl.sy, pl.sw, pl.sh, 0, 0, pl.tw, pl.th);
    const blob = await new Promise((res, rej) => c.toBlob(b => (b ? res(b) : rej(new Error('產生圖片失敗'))), ext === 'png' ? 'image/png' : 'image/jpeg', 0.95));
    return { blob, ext, pl, filename: `${safeBase(p.name)}_${pl.tw}x${pl.th}.${ext}` };
  }
  function saveBlob(blob, filename) {
    const a = document.createElement('a');
    a.download = filename;
    a.href = URL.createObjectURL(blob);
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 10000);
  }
  async function run(fn) {
    if (busy) return;
    busy = true; render();
    try { await fn(); } catch (err) { statusEl.textContent = `下載失敗：${err.message || err}`; }
    finally { busy = false; const keep = statusEl.textContent; render(); statusEl.textContent = keep; }
  }

  downloadBtn.addEventListener('click', () => run(async () => {
    const { blob, filename } = await exportPhoto(photo());
    saveBlob(blob, filename);
    statusEl.textContent = `已下載：${filename}`;
  }));
  const pad2 = n => String(n).padStart(2, '0');
  const stampNow = () => { const d = new Date(); return `${pad2(d.getFullYear() % 100)}${pad2(d.getMonth() + 1)}${pad2(d.getDate())}${pad2(d.getHours())}${pad2(d.getMinutes())}`; };
  downloadAllBtn.addEventListener('click', () => run(async () => {
    const list = [...st.photos];
    const stamp = stampNow();
    for (let i = 0; i < list.length; i++) {
      statusEl.textContent = `產生中 ${i + 1}／${list.length}：${list[i].name}`;
      const { blob, ext } = await exportPhoto(list[i]);
      saveBlob(blob, `${stamp}_${i + 1}.${ext}`);
      if (i < list.length - 1) await new Promise(r => setTimeout(r, DL_GAP_MIN + Math.random() * (DL_GAP_MAX - DL_GAP_MIN)));
    }
    statusEl.textContent = `已下載 ${list.length} 張（${stamp}_1 ～ ${stamp}_${list.length}）`;
  }));

  $('rsResetBtn').addEventListener('click', async () => {
    if (!(await askConfirm())) return;
    for (const p of st.photos) URL.revokeObjectURL(p.url);
    Object.assign(st, { photos: [], cur: 0, mode: 'cover', fmt: 'auto', w: 1080, h: 1080 });
    inW.value = st.w; inH.value = st.h;
    modeToggle.querySelectorAll('button').forEach(b => b.classList.toggle('active', b.dataset.mode === 'cover'));
    fmtToggle.querySelectorAll('button').forEach(b => b.classList.toggle('active', b.dataset.fmt === 'auto'));
    updateHint();
    schedule();
  });

  document.addEventListener('qpt:func', e => { if (e.detail === 'resize') schedule(); });

  // 測試與除錯用
  window.Resize = { state: st, plan };
  updateHint();
  schedule();
})();

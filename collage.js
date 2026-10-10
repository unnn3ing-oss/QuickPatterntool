// =====================================================================================
// 拼圖（網頁版專用，獨立的檔案：外掛不需要，updater.js／deploy.js 的 SKIP 會略過它）
//
// 一張 1080 寬的畫布，把多張照片無縫拼在一起。
//   等分：直向、橫向各切 1～4 份（切線的位置用整數像素，相鄰的格子共用同一條邊，不會有縫），可在預覽上拖曳分隔線調比例。
//   自由框：自己拉矩形框（最多 12 個）、移動、拉邊角、貼齊、調上下層、刪除，畫布高度可調（做直式長圖）。
// 每個框一張照片：蓋滿框（cover），可拖曳位置、滾輪／滑桿縮放。輸出 1080 寬、300 DPI 的 JPG（檔名 yyyymmdd拼圖），
// 也可以複製成圖片貼到別的地方。編輯用的虛線、控制點、選取框只畫在預覽上，不會輸出。
//
// 需要在 app.js 之後載入（會用到它的 isImageFile、askConfirm）。上排的功能切換在 watermark.js：
// 切到拼圖時它會送出 'qpt:func' 事件，這裡收到後重畫。
// =====================================================================================
(function () {
  const $ = id => document.getElementById(id);
  const app = $('collageApp');
  const canvas = $('cgCanvas');
  if (!app || !canvas) return;
  const g = canvas.getContext('2d');

  const S = 1080;                                   // 畫布寬度（也是等分版面的高度）
  const MIN = 60;                                   // 格子／框最小的邊長
  const H_MIN = 300, H_MAX = 5000;                  // 自由框的畫布高度範圍
  const NEW_H = 300;                                // 新增框的預設高度
  const MAX_FRAMES = 12;
  const SNAP = 14, DIV_HIT = 12, HANDLE = 22;       // 貼齊距離、分隔線的抓取範圍、控制點大小（都是畫布上的像素）
  const SCALE_MAX = 5;
  const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
  const evenCuts = n => Array.from({ length: n + 1 }, (_, k) => Math.round(S * k / n));

  // ---- 狀態 ---------------------------------------------------------------------
  const cg = { layout: 'grid', cols: 2, rows: 1, xs: evenCuts(2), ys: evenCuts(1), rects: [], editFrames: true, h: S };
  let cards = [];                                   // 每個框的照片：{ img, name, url, scale, fx, fy }（fx／fy：照片在多出來的範圍裡的位置 0～1）
  let active = 0;
  let drag = null;
  const freshCard = () => ({ img: null, name: '', url: null, scale: 1, fx: 0.5, fy: 0.5 });
  const boardH = () => (cg.layout === 'free' ? cg.h : S);
  const count = () => (cg.layout === 'free' ? cg.rects.length : cg.cols * cg.rows);
  const gridRect = i => { const c = i % cg.cols, r = Math.floor(i / cg.cols); return { x: cg.xs[c], y: cg.ys[r], w: cg.xs[c + 1] - cg.xs[c], h: cg.ys[r + 1] - cg.ys[r] }; };
  const rectOf = i => (cg.layout === 'free' ? cg.rects[i] : gridRect(i));
  const contentBottom = () => cg.rects.reduce((m, r) => Math.max(m, r.y + r.h), 0);
  function ensureCards() { while (cards.length < count()) cards.push(freshCard()); }
  ensureCards();

  const statusEl = $('cgStatus');
  const say = msg => { statusEl.textContent = msg || ''; };

  // ---- 繪製 ---------------------------------------------------------------------
  // 照片蓋滿框：scale 1 ＝剛好蓋滿，放大後多出來的部分用 fx／fy 決定露出哪一塊
  function place(r, c) {
    const iw = c.img.naturalWidth, ih = c.img.naturalHeight;
    const k = Math.max(r.w / iw, r.h / ih) * c.scale;
    const dw = iw * k, dh = ih * k;
    return { dx: r.x - (dw - r.w) * c.fx, dy: r.y - (dh - r.h) * c.fy, dw, dh, ox: dw - r.w, oy: dh - r.h };
  }
  function drawBoard(ctx, exporting) {
    const H = boardH();
    ctx.save();
    ctx.imageSmoothingQuality = 'high';
    ctx.fillStyle = exporting ? '#ffffff' : (cg.layout === 'free' ? '#e9ecf3' : '#c8cbd4');
    ctx.fillRect(0, 0, S, H);
    for (let i = 0; i < count(); i++) {
      const r = rectOf(i), c = cards[i];
      ctx.save();
      ctx.beginPath(); ctx.rect(r.x, r.y, r.w, r.h); ctx.clip();
      if (c.img) {
        const p = place(r, c);
        ctx.drawImage(c.img, p.dx, p.dy, p.dw, p.dh);
      } else if (!exporting) {
        ctx.fillStyle = '#c8cbd4'; ctx.fillRect(r.x, r.y, r.w, r.h);
        ctx.fillStyle = '#8a8f9c'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        ctx.font = `${Math.round(clamp(Math.min(r.w, r.h) / 11, 18, 34))}px sans-serif`;
        ctx.fillText('點擊或拖曳上傳圖片', r.x + r.w / 2, r.y + r.h / 2);
      }
      ctx.restore();
    }
    ctx.restore();
  }
  function handlesOf(r) {
    const cx = r.x + r.w / 2, cy = r.y + r.h / 2, x1 = r.x + r.w, y1 = r.y + r.h;
    return [
      { k: 'nw', x: r.x, y: r.y }, { k: 'n', x: cx, y: r.y }, { k: 'ne', x: x1, y: r.y },
      { k: 'e', x: x1, y: cy }, { k: 'se', x: x1, y: y1 }, { k: 's', x: cx, y: y1 },
      { k: 'sw', x: r.x, y: y1 }, { k: 'w', x: r.x, y: cy },
    ];
  }
  function drawGuides() {                             // 只畫在預覽上
    g.save();
    g.lineWidth = 2; g.setLineDash([10, 8]);
    if (cg.layout === 'grid') {
      g.strokeStyle = 'rgba(255,255,255,0.9)'; g.shadowColor = 'rgba(0,0,0,0.6)'; g.shadowBlur = 3;
      g.beginPath();
      for (let c = 1; c < cg.cols; c++) { g.moveTo(cg.xs[c], 0); g.lineTo(cg.xs[c], S); }
      for (let r = 1; r < cg.rows; r++) { g.moveTo(0, cg.ys[r]); g.lineTo(S, cg.ys[r]); }
      g.stroke();
    } else if (cg.editFrames) {
      g.strokeStyle = 'rgba(0,74,173,0.55)';
      cg.rects.forEach(r => g.strokeRect(r.x + 1, r.y + 1, r.w - 2, r.h - 2));
      if (drag && drag.type === 'draw' && drag.rect) {
        g.strokeStyle = 'rgba(0,74,173,0.95)'; g.fillStyle = 'rgba(0,74,173,0.12)';
        g.fillRect(drag.rect.x, drag.rect.y, drag.rect.w, drag.rect.h); g.strokeRect(drag.rect.x, drag.rect.y, drag.rect.w, drag.rect.h);
      }
      g.setLineDash([]);
      const a = cg.rects[active];
      if (a) for (const h of handlesOf(a)) {
        g.fillStyle = '#ffffff'; g.strokeStyle = 'rgba(0,74,173,0.95)';
        g.fillRect(h.x - HANDLE / 2, h.y - HANDLE / 2, HANDLE, HANDLE); g.strokeRect(h.x - HANDLE / 2, h.y - HANDLE / 2, HANDLE, HANDLE);
      }
    }
    g.restore();
    const a = count() > 0 ? rectOf(active) : null;      // 目前選取的格子：藍色框住（畫在裡面，不會被邊緣切掉）
    if (a) { g.save(); g.setLineDash([]); g.strokeStyle = 'rgba(0,74,173,0.9)'; g.lineWidth = 6; g.strokeRect(a.x + 3, a.y + 3, a.w - 6, a.h - 6); g.restore(); }
  }
  let raf = 0;
  function schedule() { if (!raf) raf = requestAnimationFrame(() => { raf = 0; render(); }); }
  function render() {
    const H = boardH();
    if (canvas.height !== H) canvas.height = H;
    canvas.style.aspectRatio = `${S} / ${H}`;
    g.clearRect(0, 0, S, H);
    drawBoard(g, false);
    drawGuides();
    syncUI();
  }

  // ---- 控制項同步 ---------------------------------------------------------------
  const $layout = $('cgLayout'), $cols = $('cgCols'), $rows = $('cgRows'), $edit = $('cgEdit');
  for (const seg of [$cols, $rows]) for (let n = 1; n <= 4; n++) { const b = document.createElement('button'); b.type = 'button'; b.dataset.n = n; b.textContent = n === 1 ? '不切' : String(n); seg.appendChild(b); }
  const $scale = $('cgScale'), $scaleOut = $('cgScaleOut'), $selOut = $('cgSelOut'), $selHint = $('cgSelHint');
  const $height = $('cgHeight');
  function syncUI() {
    $layout.querySelectorAll('button').forEach(b => b.classList.toggle('active', b.dataset.layout === cg.layout));
    $('cgGridCtrl').hidden = cg.layout !== 'grid';
    $('cgFreeCtrl').hidden = cg.layout !== 'free';
    $cols.querySelectorAll('button').forEach(b => b.classList.toggle('active', Number(b.dataset.n) === cg.cols));
    $rows.querySelectorAll('button').forEach(b => b.classList.toggle('active', Number(b.dataset.n) === cg.rows));
    $edit.querySelectorAll('button').forEach(b => b.classList.toggle('active', (b.dataset.edit === 'frame') === cg.editFrames));
    if (document.activeElement !== $height) $height.value = cg.h;
    const n = count(), c = cards[active];
    const has = n > 0 && c && c.img;
    $selOut.textContent = n ? `第 ${active + 1} 格／共 ${n} 格` : '';
    $selHint.textContent = !n ? '還沒有框，在預覽上拉出一個' : has ? `${c.name || '照片'}（${c.img.naturalWidth}×${c.img.naturalHeight}）` : '這一格還沒有照片：點「選擇照片」、貼上，或把照片拖到這一格';
    $scale.disabled = !has; $scale.value = has ? Math.round(c.scale * 100) : 100;
    $scaleOut.textContent = has ? `${Math.round(c.scale * 100)}%` : '';
    $('cgResetPosBtn').disabled = !has; $('cgRemoveImgBtn').disabled = !has; $('cgPickBtn').disabled = !n;
    const any = cards.slice(0, n).some(x => x.img);
    $('cgDownloadBtn').disabled = busy || !any; $('cgCopyBtn').disabled = busy || !any;
    $('cgFitImgBtn').disabled = !has;
    $('cgDeleteBtn').disabled = n <= 1;
    $('cgAddBtn').disabled = cg.rects.length >= MAX_FRAMES;
    $('cgHint').textContent = `輸出 ${S}×${boardH()}、300 DPI 的 JPG`;
  }

  // ---- 載入照片 -----------------------------------------------------------------
  const isImage = f => (typeof isImageFile === 'function' ? isImageFile(f) : !!f && /^image\//.test(f.type));
  function loadImage(file) {
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(file), im = new Image();
      im.onload = () => resolve({ im, url });
      im.onerror = () => { URL.revokeObjectURL(url); reject(new Error('decode')); };
      im.src = url;
    });
  }
  function setCard(i, im, url, name) {
    const c = cards[i];
    if (c.url) URL.revokeObjectURL(c.url);
    Object.assign(c, { img: im, url, name, scale: 1, fx: 0.5, fy: 0.5 });
  }
  // 放照片：從 start 格開始，依序放進「空的格子」；start 那格如果指定要換（replaceStart），就直接換掉
  async function addFiles(fileList, start = active, replaceStart = false) {
    const files = [...(fileList || [])];
    if (!files.length) return;
    const images = files.filter(isImage), notes = [];
    if (images.length < files.length) notes.push(`略過 ${files.length - images.length} 個不是圖片的檔案`);
    const n = count();
    if (!n) { say('還沒有框，先在預覽上拉出一個框'); return; }
    const slots = [];
    if (replaceStart || !cards[start].img) slots.push(start);
    for (let i = 0; i < n && slots.length < images.length; i++) if (!cards[i].img && !slots.includes(i)) slots.push(i);
    if (images.length > slots.length) notes.push(`格子不夠，${images.length - slots.length} 張沒有放進去（可以增加格子，或換成別的版面）`);
    let failed = 0, placed = 0;
    for (let k = 0; k < slots.length && k < images.length; k++) {
      try { const { im, url } = await loadImage(images[k]); setCard(slots[k], im, url, images[k].name); placed++; }
      catch (e) { failed++; }
    }
    if (failed) notes.push(`${failed} 張無法開啟（可能是不支援的格式，例如 HEIC，請改用 JPG／PNG）`);
    if (slots.length) active = slots[0];
    say(placed ? `已放入 ${placed} 張照片${notes.length ? '；' + notes.join('；') : ''}` : notes.join('；'));
    schedule();
  }

  const drop = $('cgDrop'), input = $('cgInput'), cellInput = $('cgCellInput');
  drop.addEventListener('click', () => input.click());
  drop.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); input.click(); } });
  input.addEventListener('click', e => e.stopPropagation());
  input.addEventListener('change', () => { addFiles(input.files); input.value = ''; });
  drop.addEventListener('dragover', e => { e.preventDefault(); drop.classList.add('drag'); });
  drop.addEventListener('dragleave', () => drop.classList.remove('drag'));
  drop.addEventListener('drop', e => { e.preventDefault(); e.stopPropagation(); drop.classList.remove('drag'); addFiles(e.dataTransfer.files); });
  $('cgPickBtn').addEventListener('click', () => cellInput.click());
  cellInput.addEventListener('change', () => { addFiles(cellInput.files, active, true); cellInput.value = ''; });

  // ---- 座標、命中判斷 -------------------------------------------------------------
  function posOf(e) {
    const r = canvas.getBoundingClientRect();
    return { x: (e.clientX - r.left) * canvas.width / r.width, y: (e.clientY - r.top) * canvas.height / r.height };
  }
  function cellAt(p) {                                // 最上面的那一格（自由框後面的蓋在前面）
    for (let i = count() - 1; i >= 0; i--) { const r = rectOf(i); if (p.x >= r.x && p.x <= r.x + r.w && p.y >= r.y && p.y <= r.y + r.h) return i; }
    return -1;
  }
  function dividerAt(p) {
    if (cg.layout !== 'grid') return null;
    for (let c = 1; c < cg.cols; c++) if (Math.abs(p.x - cg.xs[c]) <= DIV_HIT) return { axis: 'x', idx: c };
    for (let r = 1; r < cg.rows; r++) if (Math.abs(p.y - cg.ys[r]) <= DIV_HIT) return { axis: 'y', idx: r };
    return null;
  }
  function handleAt(r, p) {
    if (!r) return null;
    const slop = 2;                                   // 控制點跨在框的邊上，只有裡面那半（多 2px）抓得到，這樣貼著這個框邊拉新框時是拉新框、不是改這個框
    if (p.x < r.x - slop || p.x > r.x + r.w + slop || p.y < r.y - slop || p.y > r.y + r.h + slop) return null;
    const h = handlesOf(r).find(h => Math.abs(p.x - h.x) <= HANDLE * 0.75 && Math.abs(p.y - h.y) <= HANDLE * 0.75);
    return h ? h.k : null;
  }
  // 磁吸：把給定的邊（同一軸上的數值）貼到畫布邊緣或別的框的邊，回傳要位移多少
  function snapShift(edges, axis, skip) {
    const targets = [0, axis === 'x' ? S : boardH()];
    cg.rects.forEach((r, i) => { if (i !== skip) targets.push(...(axis === 'x' ? [r.x, r.x + r.w] : [r.y, r.y + r.h])); });
    let best = null;
    for (const e of edges) for (const t of targets) { const d = t - e; if (Math.abs(d) <= SNAP && (best === null || Math.abs(d) < Math.abs(best))) best = d; }
    return best || 0;
  }
  const snapV = (v, axis, skip) => v + snapShift([v], axis, skip);

  // ---- 滑鼠／觸控 -----------------------------------------------------------------
  const CURSOR = { n: 'ns-resize', s: 'ns-resize', e: 'ew-resize', w: 'ew-resize', nw: 'nwse-resize', se: 'nwse-resize', ne: 'nesw-resize', sw: 'nesw-resize' };
  function hoverCursor(p) {
    const d = dividerAt(p);
    if (d) return d.axis === 'x' ? 'col-resize' : 'row-resize';
    if (cg.layout === 'free' && cg.editFrames) {
      const h = handleAt(cg.rects[active], p);
      if (h) return CURSOR[h];
      return cellAt(p) >= 0 ? 'move' : 'crosshair';
    }
    const i = cellAt(p);
    return i >= 0 && cards[i].img ? 'grab' : 'default';
  }
  canvas.addEventListener('pointerdown', e => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    const p = posOf(e);
    canvas.setPointerCapture(e.pointerId);
    const div = dividerAt(p);
    if (div) { e.preventDefault(); drag = { id: e.pointerId, type: 'divider', ...div }; return; }
    if (cg.layout === 'free' && cg.editFrames) {
      e.preventDefault();
      const handle = handleAt(cg.rects[active], p);
      if (handle) { drag = { id: e.pointerId, type: 'resize', idx: active, handle, start: { ...cg.rects[active] }, px: p.x, py: p.y }; return; }
      const hit = cellAt(p);
      if (hit >= 0) { active = hit; drag = { id: e.pointerId, type: 'move', idx: hit, start: { ...cg.rects[hit] }, px: p.x, py: p.y }; schedule(); return; }
      if (cg.rects.length >= MAX_FRAMES) { say(`最多 ${MAX_FRAMES} 個框`); return; }
      drag = { id: e.pointerId, type: 'draw', x0: snapV(p.x, 'x', -1), y0: snapV(p.y, 'y', -1), rect: null };
      return;
    }
    const hit = cellAt(p);
    if (hit < 0) return;
    e.preventDefault();
    active = hit; schedule();
    const c = cards[hit];
    if (c.img) drag = { id: e.pointerId, type: 'pan', idx: hit, px: p.x, py: p.y, fx: c.fx, fy: c.fy, moved: false };
  });
  canvas.addEventListener('pointermove', e => {
    const p = posOf(e);
    if (!drag || e.pointerId !== drag.id) { canvas.style.cursor = hoverCursor(p); return; }
    e.preventDefault();
    const d = drag, H = boardH(), M = MIN;
    if (d.type === 'divider') {
      const arr = d.axis === 'x' ? cg.xs : cg.ys;
      arr[d.idx] = clamp(Math.round(d.axis === 'x' ? p.x : p.y), arr[d.idx - 1] + M, arr[d.idx + 1] - M);
    } else if (d.type === 'move') {
      const r = { ...d.start };
      r.x = clamp(Math.round(d.start.x + p.x - d.px), 0, S - r.w);
      r.y = clamp(Math.round(d.start.y + p.y - d.py), 0, H - r.h);
      r.x = clamp(r.x + snapShift([r.x, r.x + r.w], 'x', d.idx), 0, S - r.w);
      r.y = clamp(r.y + snapShift([r.y, r.y + r.h], 'y', d.idx), 0, H - r.h);
      cg.rects[d.idx] = r;
    } else if (d.type === 'resize') {
      const s = d.start;
      let x0 = s.x, y0 = s.y, x1 = s.x + s.w, y1 = s.y + s.h;
      const dx = p.x - d.px, dy = p.y - d.py;
      if (d.handle.includes('w')) x0 = clamp(Math.round(snapV(s.x + dx, 'x', d.idx)), 0, x1 - M);
      if (d.handle.includes('e')) x1 = clamp(Math.round(snapV(s.x + s.w + dx, 'x', d.idx)), x0 + M, S);
      if (d.handle.includes('n')) y0 = clamp(Math.round(snapV(s.y + dy, 'y', d.idx)), 0, y1 - M);
      if (d.handle.includes('s')) y1 = clamp(Math.round(snapV(s.y + s.h + dy, 'y', d.idx)), y0 + M, H);
      cg.rects[d.idx] = { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
    } else if (d.type === 'draw') {
      const px = Math.round(clamp(snapV(p.x, 'x', -1), 0, S)), py = Math.round(clamp(snapV(p.y, 'y', -1), 0, H));
      const x0 = Math.round(clamp(d.x0, 0, S)), y0 = Math.round(clamp(d.y0, 0, H));
      d.rect = { x: Math.min(x0, px), y: Math.min(y0, py), w: Math.abs(px - x0), h: Math.abs(py - y0) };
    } else if (d.type === 'pan') {
      const c = cards[d.idx], pl = place(rectOf(d.idx), c);
      if (Math.abs(p.x - d.px) + Math.abs(p.y - d.py) > 3) { d.moved = true; canvas.style.cursor = 'grabbing'; }
      if (pl.ox > 0) c.fx = clamp(d.fx - (p.x - d.px) / pl.ox, 0, 1);
      if (pl.oy > 0) c.fy = clamp(d.fy - (p.y - d.py) / pl.oy, 0, 1);
    }
    schedule();
  });
  const endDrag = e => {
    const d = drag;
    if (!d || e.pointerId !== d.id) return;
    drag = null;
    if (d.type === 'draw' && d.rect && d.rect.w >= MIN && d.rect.h >= MIN) {
      cg.rects.push(d.rect); ensureCards(); cards[cg.rects.length - 1] = freshCard(); active = cg.rects.length - 1;
    }
    canvas.style.cursor = hoverCursor(posOf(e));
    schedule();
  };
  canvas.addEventListener('pointerup', endDrag);
  canvas.addEventListener('pointercancel', endDrag);
  // 滾輪：停在有照片的格子上時放大縮小（不會捲動頁面）
  canvas.addEventListener('wheel', e => {
    const i = cellAt(posOf(e));
    if (i < 0 || !cards[i].img) return;
    e.preventDefault();
    active = i;
    const c = cards[i];
    c.scale = clamp(c.scale * Math.exp(-e.deltaY * 0.0015), 1, SCALE_MAX);
    schedule();
  }, { passive: false });
  // 雙擊：換這一格的照片
  canvas.addEventListener('dblclick', e => {
    const i = cellAt(posOf(e));
    if (i < 0) return;
    active = i; schedule(); cellInput.click();
  });
  // 把照片拖到某一格上：放進那一格（一張時換掉那格的照片；多張時從那一格開始依序放進空格）
  const stage = $('cgStage');
  stage.addEventListener('dragover', e => { e.preventDefault(); stage.classList.add('drag'); });
  stage.addEventListener('dragleave', () => stage.classList.remove('drag'));
  stage.addEventListener('drop', e => {
    e.preventDefault(); e.stopPropagation(); stage.classList.remove('drag');
    const files = [...e.dataTransfer.files];
    const i = e.target === canvas ? cellAt(posOf(e)) : -1;
    if (i >= 0) { active = i; addFiles(files, i, files.length === 1); } else addFiles(files);
  });

  // Ctrl+V 貼上：拼圖開著時由這裡處理（在捕捉階段攔下，免得 app.js 把圖貼到看不見的「圖片套版」裡）。貼到目前選取的格子
  document.addEventListener('paste', e => {
    if (app.hidden) return;
    const files = e.clipboardData ? [...e.clipboardData.items].filter(i => i.kind === 'file' && /^image\//.test(i.type)).map(i => i.getAsFile()) : [];
    e.stopImmediatePropagation();
    if (!files.length) return;
    e.preventDefault();
    addFiles(files, active, files.length === 1);
  }, true);

  // ---- 版面操作 -------------------------------------------------------------------
  function relayout(nextActive) {
    ensureCards();
    active = clamp(nextActive, 0, Math.max(0, count() - 1));
    schedule();
  }
  $layout.querySelectorAll('button').forEach(btn => btn.addEventListener('click', () => {
    const target = btn.dataset.layout;
    if (target === cg.layout) return;
    if (target === 'free') {                          // 從目前的等分切法開始，只要微調
      const n = cg.cols * cg.rows;
      cg.rects = Array.from({ length: n }, (_, i) => gridRect(i));
      cards.length = Math.max(cards.length, n);
      cg.editFrames = true;
      cg.h = Math.max(cg.h, contentBottom(), H_MIN);
    }
    cg.layout = target;
    relayout(active);
  }));
  function setGrid(cols, rows) { cg.cols = cols; cg.rows = rows; cg.xs = evenCuts(cols); cg.ys = evenCuts(rows); relayout(active); }
  $cols.addEventListener('click', e => { const n = Number(e.target.dataset.n); if (n) setGrid(n, cg.rows); });
  $rows.addEventListener('click', e => { const n = Number(e.target.dataset.n); if (n) setGrid(cg.cols, n); });
  $('cgEvenBtn').addEventListener('click', () => setGrid(cg.cols, cg.rows));
  $edit.querySelectorAll('button').forEach(btn => btn.addEventListener('click', () => { cg.editFrames = btn.dataset.edit === 'frame'; schedule(); }));

  $height.addEventListener('change', () => {
    const floor = Math.max(H_MIN, contentBottom());
    const v = Math.round(Number($height.value)) || cg.h;
    if (v < floor) say(`畫布高度不能小於框的最低邊 ${floor}px，可先把框往上移或縮小`);
    cg.h = clamp(v, floor, H_MAX);
    schedule();
  });
  $('cgFitHeightBtn').addEventListener('click', () => { cg.h = clamp(contentBottom(), H_MIN, H_MAX); schedule(); });
  $('cgAddBtn').addEventListener('click', () => {
    if (cg.layout !== 'free') return;
    if (cg.rects.length >= MAX_FRAMES) { say(`最多 ${MAX_FRAMES} 個框`); return; }
    const y = contentBottom();
    if (y + MIN > H_MAX) { say(`畫布高度已達上限 ${H_MAX}px`); return; }
    const h = Math.min(NEW_H, H_MAX - y);
    cg.rects.push({ x: 0, y, w: S, h });
    ensureCards(); cards[cg.rects.length - 1] = freshCard();
    cg.h = Math.max(cg.h, y + h);
    relayout(cg.rects.length - 1);
  });
  // 框的高度改成照片的比例（寬度不變，所以不裁切），下面的框跟著位移，疊起來仍然貼齊
  $('cgFitImgBtn').addEventListener('click', () => {
    const r = cg.rects[active], c = cards[active];
    if (cg.layout !== 'free' || !r) return;
    if (!c || !c.img) { say('這個框還沒有圖片，先貼上或選擇圖片再貼合'); return; }
    const oldBottom = r.y + r.h;
    const newH = clamp(Math.round(r.w * c.img.naturalHeight / c.img.naturalWidth), MIN, H_MAX - r.y);
    const delta = newH - r.h;
    cg.rects.forEach((o, k) => { if (k !== active && o.y >= oldBottom - 1) o.y = clamp(o.y + delta, 0, H_MAX - o.h); });
    r.h = newH;
    c.scale = 1; c.fx = 0.5; c.fy = 0.5;
    cg.h = clamp(Math.max(cg.h, contentBottom()), H_MIN, H_MAX);
    schedule();
  });
  // 和上／下一個框對調上下位置（依位置排序），兩個框合起來佔的範圍不變，所以貼齊的疊法仍然貼齊
  function swapVertical(dir) {
    if (cg.layout !== 'free' || !cg.rects[active]) return;
    const order = cg.rects.map((_, k) => k).sort((a, b) => cg.rects[a].y - cg.rects[b].y || cg.rects[a].x - cg.rects[b].x);
    const pos = order.indexOf(active), nb = order[pos + dir];
    if (nb === undefined) { say(dir < 0 ? '已經在最上面' : '已經在最下面'); return; }
    const upper = cg.rects[dir < 0 ? nb : active], lower = cg.rects[dir < 0 ? active : nb];
    const top = upper.y, bottom = lower.y + lower.h;
    lower.y = top; upper.y = bottom - upper.h;
    schedule();
  }
  $('cgUpBtn').addEventListener('click', () => swapVertical(-1));
  $('cgDownBtn').addEventListener('click', () => swapVertical(1));
  function moveFrame(from, to) {
    const [r] = cg.rects.splice(from, 1), [c] = cards.splice(from, 1);
    cg.rects.splice(to, 0, r); cards.splice(to, 0, c);
    relayout(to);
  }
  $('cgFrontBtn').addEventListener('click', () => { if (cg.layout === 'free' && active < count()) moveFrame(active, count() - 1); });
  $('cgBackBtn').addEventListener('click', () => { if (cg.layout === 'free' && active < count()) moveFrame(active, 0); });
  function deleteFrame() {
    if (cg.layout !== 'free' || active < 0 || active >= count()) return;
    if (count() <= 1) { say('至少要保留一個框'); return; }
    cg.rects.splice(active, 1);
    const [c] = cards.splice(active, 1);
    if (c && c.url) URL.revokeObjectURL(c.url);
    relayout(active - 1);
  }
  $('cgDeleteBtn').addEventListener('click', deleteFrame);
  document.addEventListener('keydown', e => {
    if (app.hidden || (e.key !== 'Delete' && e.key !== 'Backspace')) return;
    const tag = document.activeElement && document.activeElement.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA') return;
    if (cg.layout === 'free' && cg.editFrames) { e.preventDefault(); deleteFrame(); }
  });

  // 選取格子的照片：縮放、重設、移除
  $scale.addEventListener('input', () => { const c = cards[active]; if (c && c.img) { c.scale = clamp(Number($scale.value) / 100, 1, SCALE_MAX); schedule(); } });
  $('cgResetPosBtn').addEventListener('click', () => { const c = cards[active]; if (c) { c.scale = 1; c.fx = 0.5; c.fy = 0.5; schedule(); } });
  $('cgRemoveImgBtn').addEventListener('click', () => {
    const c = cards[active];
    if (!c) return;
    if (c.url) URL.revokeObjectURL(c.url);
    cards[active] = freshCard();
    schedule();
  });

  // ---- 輸出 -----------------------------------------------------------------------
  let busy = false;
  function offscreen() {
    const c = document.createElement('canvas');
    c.width = S; c.height = boardH();
    drawBoard(c.getContext('2d'), true);
    return c;
  }
  // 把 JPG 檔頭（JFIF）的解析度欄位改成 300 DPI；找不到 JFIF 標頭就原樣回傳
  async function withDpi(blob, dpi) {
    const b = new Uint8Array(await blob.arrayBuffer());
    const ok = b[0] === 0xFF && b[1] === 0xD8 && b[2] === 0xFF && b[3] === 0xE0 && b[6] === 0x4A && b[7] === 0x46 && b[8] === 0x49 && b[9] === 0x46 && b[10] === 0;
    if (!ok) return blob;
    b[13] = 1; b[14] = dpi >> 8; b[15] = dpi & 255; b[16] = dpi >> 8; b[17] = dpi & 255;
    return new Blob([b], { type: 'image/jpeg' });
  }
  const pad2 = n => String(n).padStart(2, '0');
  const stampDay = () => { const d = new Date(); return `${d.getFullYear()}${pad2(d.getMonth() + 1)}${pad2(d.getDate())}`; };
  async function guarded(fn) {
    if (busy) return;
    busy = true; syncUI();
    try { await fn(); } catch (err) { say(`失敗：${err.message || err}`); }
    finally { busy = false; syncUI(); }
  }
  $('cgDownloadBtn').addEventListener('click', () => guarded(async () => {
    const c = offscreen();
    const raw = await new Promise((res, rej) => c.toBlob(b => (b ? res(b) : rej(new Error('產生圖片失敗'))), 'image/jpeg', 0.95));
    const blob = await withDpi(raw, 300);
    const a = document.createElement('a');
    a.download = `${stampDay()}拼圖.jpg`;
    a.href = URL.createObjectURL(blob);
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 10000);
    say(`已下載：${a.download}（${S}×${c.height}）`);
  }));
  $('cgCopyBtn').addEventListener('click', () => guarded(async () => {
    const c = offscreen();
    const blob = await new Promise((res, rej) => c.toBlob(b => (b ? res(b) : rej(new Error('產生圖片失敗'))), 'image/png'));
    try { await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]); say('已複製拼圖，可以直接貼到別的地方'); }
    catch (e) { say('複製失敗：瀏覽器不允許寫入剪貼簿，請改用「下載圖片」'); }
  }));

  $('cgResetBtn').addEventListener('click', async () => {
    if (!(await askConfirm())) return;
    for (const c of cards) if (c.url) URL.revokeObjectURL(c.url);
    Object.assign(cg, { layout: 'grid', cols: 2, rows: 1, xs: evenCuts(2), ys: evenCuts(1), rects: [], editFrames: true, h: S });
    cards = []; ensureCards(); active = 0; drag = null;
    say('');
    schedule();
  });

  // 從別的功能切過來（畫布剛從隱藏變成顯示）時重畫
  document.addEventListener('qpt:func', e => { if (e.detail === 'collage') schedule(); });

  // 測試與除錯用
  window.Collage = { state: cg, cards: () => cards, active: () => active, rectOf, count, place, render, offscreen };
  schedule();
})();


// 貼圖與馬賽克（需在 app.js 之後載入）。兩個地方用：
//   - 側邊欄「快速產圖」：單張的預覽畫布，按鈕在標題列、一排貼圖在下方彈出；
//   - 網頁版「圖片套版」：批次模式，**每一組各自有一份**貼圖／馬賽克（預覽的是哪一組就編輯哪一組），一排貼圖固定在預覽畫布下方。
//
// 做法：貼圖／馬賽克的資料存在這裡（位置與大小用 1080×1080 畫布座標），畫的時候由 app.js 透過 fx 物件叫回來：
//   - 馬賽克在「背景畫完、邊框與標題還沒畫」的時候畫，所以只糊照片，不糊標題字；
//   - 貼圖在最後畫，蓋在標題與邊框上面。
// 因為是畫進同一張畫布，下載、複製圖片、直接下載、排程帶入、批次「完成」存下來的圖都會自動包含它們。
// 預覽上用來拖曳的方框是蓋在畫布上的 DOM 元素，不會被輸出。
// 操作：拖曳移動；滑鼠在方框上滾輪縮放（其他地方的滾輪仍是縮放背景照片），觸控用兩指在方框上縮放。
(function () {
  if (typeof SIZE === 'undefined') return;
  const sideBtn = document.getElementById('qfFxBtn');          // 側邊欄才有
  const sideStrip = document.getElementById('qfFxStrip');
  const batchSlot = document.getElementById('batchFxSlot');    // 網頁版才有
  const useSingle = !!(sideBtn && sideStrip && typeof singleFx !== 'undefined' && typeof canvas !== 'undefined');
  const useBatch = !!(batchSlot && typeof batchFx !== 'undefined' && typeof batchCanvas !== 'undefined');
  if (!useSingle && !useBatch) return;

  const STICKERS = [
    { id: 'smile', name: '笑臉' }, { id: 'shock', name: '驚嚇' }, { id: 'cry', name: '大哭' }, { id: 'angry', name: '生氣' },
    { id: 'kiss', name: '親親' }, { id: 'laugh', name: '笑哭' }, { id: 'meh', name: '無言' }
  ];
  const images = {};
  const editors = [];
  STICKERS.forEach(s => {
    const img = new Image();
    img.onload = () => { editors.forEach(ed => ed.redraw()); };   // 圖載好了，重畫一次（畫面上已經有貼圖卻還沒載好時才會用到；不算「改了內容」）
    img.src = `stickers/${s.id}.png`;
    images[s.id] = img;
  });

  const STICKER_W = 300;            // 新貼上的貼圖寬度（畫布座標）
  const MOSAIC_W = 320, MOSAIC_H = 240;
  const MIN_SIZE = 40, MAX_SIZE = SIZE * 1.4;
  const MAX_ITEMS = 30;
  const BLOCK_DIV = 5;              // 馬賽克的方塊大小 = 短邊 / 5：整個框只剩約 5 格，糊得夠重、認不出來
  const BLOCK_MIN = 14;
  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
  let nextId = 1;

  // ---- 畫進畫布 ----
  function pixelate(c, m) {
    const x0 = Math.max(0, Math.floor(m.x)), y0 = Math.max(0, Math.floor(m.y));
    const x1 = Math.min(SIZE, Math.ceil(m.x + m.w)), y1 = Math.min(SIZE, Math.ceil(m.y + m.h));
    const w = x1 - x0, h = y1 - y0;
    if (w < 1 || h < 1) return;
    const b = Math.max(BLOCK_MIN, Math.round(Math.min(m.w, m.h) / BLOCK_DIV));
    let data;
    try { data = c.getImageData(x0, y0, w, h).data; } catch (e) { c.save(); c.fillStyle = '#808080'; c.fillRect(x0, y0, w, h); c.restore(); return; }   // 畫布被污染（讀不到像素）就用灰色蓋住，至少不會露出原圖
    c.save();
    for (let by = 0; by < h; by += b) {
      for (let bx = 0; bx < w; bx += b) {
        const bw = Math.min(b, w - bx), bh = Math.min(b, h - by);
        let r = 0, g = 0, bl = 0;
        for (let yy = by; yy < by + bh; yy++) {
          let i = (yy * w + bx) * 4;
          for (let xx = 0; xx < bw; xx++, i += 4) { r += data[i]; g += data[i + 1]; bl += data[i + 2]; }
        }
        const n = bw * bh;
        c.fillStyle = `rgb(${Math.round(r / n)},${Math.round(g / n)},${Math.round(bl / n)})`;
        c.fillRect(x0 + bx, y0 + by, bw, bh);
      }
    }
    c.restore();
  }

  // 給 app.js 的 renderComposite 用：畫某一份清單裡的馬賽克（背景之後、標題之前）與貼圖（最後）
  function drawFx(list) {
    return {
      mosaic(c) { list.forEach(it => { if (it.kind === 'mosaic') pixelate(c, it); }); },
      stickers(c) {
        list.forEach(it => {
          const img = images[it.key];
          if (it.kind === 'sticker' && img && img.complete && img.naturalWidth) c.drawImage(img, it.x, it.y, it.w, it.h);
        });
      }
    };
  }

  // 縮放：以方框中心為準，兩邊都要在 MIN_SIZE～MAX_SIZE 內。貼圖等比；馬賽克也等比，按住 Shift 只調寬、按住 Alt 只調高。
  function scaleItem(it, f, only) {
    const cx = it.x + it.w / 2, cy = it.y + it.h / 2;
    let w = it.w, h = it.h;
    if (it.kind === 'mosaic' && only === 'w') w = clamp(w * f, MIN_SIZE, MAX_SIZE);
    else if (it.kind === 'mosaic' && only === 'h') h = clamp(h * f, MIN_SIZE, MAX_SIZE);
    else {
      const s = clamp(it.w * f, MIN_SIZE, MAX_SIZE) / it.w;
      const s2 = clamp(it.h * f, MIN_SIZE, MAX_SIZE) / it.h;
      const sc = f > 1 ? Math.min(s, s2) : Math.max(s, s2);
      w = it.w * sc; h = it.h * sc;
    }
    it.w = w; it.h = h; it.x = cx - w / 2; it.y = cy - h / 2;
  }

  // ---- 預覽上的操作方框（DOM，不會輸出）：一個畫布一個 editor ----
  // host: { canvas, items() -> 目前要編輯的清單（陣列，原地修改）或 null（沒有目標）, ready() -> 目前能不能放（有背景）, changed() -> 使用者改了內容（要重畫，批次還要讓那一組變回未完成）, redraw() -> 只重畫, onLayout?(n) }
  function createEditor(host) {
    const canvasEl = host.canvas;
    const wrap = canvasEl.closest('.canvas-wrap');
    const layer = document.createElement('div');
    layer.className = 'fx-layer';
    wrap.appendChild(layer);
    let selectedId = null;
    let shown = null;   // layer 裡目前畫的是哪一份清單

    const el = id => layer.querySelector(`[data-id="${id}"]`);

    // 預覽的對象換了（例如批次換到另一組）就把方框整個重建；沒換就只更新位置
    function sync(force) {
      const list = host.items();
      if (force || list !== shown) {
        shown = list;
        selectedId = null;
        layer.textContent = '';
        (list || []).forEach(it => layer.appendChild(buildEl(it)));
      }
      layout();
    }

    function layout() {
      const list = shown || [];
      const k = canvasEl.clientWidth / SIZE;
      layer.hidden = !host.ready() || !list.length;
      if (k) {
        layer.style.left = `${canvasEl.offsetLeft}px`;
        layer.style.top = `${canvasEl.offsetTop}px`;
        layer.style.width = `${canvasEl.clientWidth}px`;
        layer.style.height = `${canvasEl.clientHeight}px`;
        list.forEach(it => {
          const box = el(it.id);
          if (!box) return;
          box.style.left = `${it.x * k}px`;
          box.style.top = `${it.y * k}px`;
          box.style.width = `${it.w * k}px`;
          box.style.height = `${it.h * k}px`;
          box.classList.toggle('selected', it.id === selectedId);
        });
      }
      if (host.onLayout) host.onLayout(list.length);
    }

    const select = id => { selectedId = id; layout(); };
    function removeItem(id) {
      const list = shown || [];
      const i = list.findIndex(it => it.id === id);
      if (i >= 0) list.splice(i, 1);
      const box = el(id);
      if (box) box.remove();
      if (selectedId === id) selectedId = null;
      host.changed();
    }

    function buildEl(it) {
      const box = document.createElement('div');
      box.className = `fx-item fx-${it.kind}`;
      box.dataset.id = it.id;
      box.title = it.kind === 'mosaic' ? '馬賽克：拖曳移動、滾輪縮放（Shift＝只調寬、Alt＝只調高），觸控用兩指縮放' : '拖曳移動、滾輪縮放，觸控用兩指縮放';
      const del = document.createElement('button');
      del.type = 'button';
      del.className = 'fx-del';
      del.textContent = '×';
      del.title = '刪除（Delete）';
      del.addEventListener('pointerdown', e => e.stopPropagation());
      del.addEventListener('click', e => { e.stopPropagation(); removeItem(it.id); });
      box.appendChild(del);

      const ptrs = new Map();   // pointerId -> { x, y }
      let drag = null, pin = null;
      const startDrag = (id, x, y) => { drag = { id, sx: x, sy: y, x: it.x, y: it.y }; };
      box.addEventListener('pointerdown', e => {
        if (e.button !== 0) return;
        e.preventDefault();
        select(it.id);
        // 點到的方框移到最上層（畫的順序也跟著變）
        const list = shown || [];
        const i = list.indexOf(it);
        if (i >= 0 && i !== list.length - 1) { list.splice(i, 1); list.push(it); layer.appendChild(box); }
        ptrs.set(e.pointerId, { x: e.clientX, y: e.clientY });
        box.setPointerCapture(e.pointerId);
        if (ptrs.size === 2) {   // 第二根手指放上來：改成雙指縮放
          drag = null;
          const [a, b] = [...ptrs.values()];
          pin = { d0: Math.max(Math.hypot(a.x - b.x, a.y - b.y), 1), w: it.w, h: it.h, cx: it.x + it.w / 2, cy: it.y + it.h / 2 };
        } else if (ptrs.size === 1) startDrag(e.pointerId, e.clientX, e.clientY);
        host.changed();
      });
      box.addEventListener('pointermove', e => {
        if (ptrs.has(e.pointerId)) ptrs.set(e.pointerId, { x: e.clientX, y: e.clientY });
        if (pin && ptrs.size === 2) {
          const [a, b] = [...ptrs.values()];
          const f = Math.hypot(a.x - b.x, a.y - b.y) / pin.d0;
          it.w = pin.w; it.h = pin.h; it.x = pin.cx - pin.w / 2; it.y = pin.cy - pin.h / 2;   // 從開始縮放時的大小算起，免得一點一點累積誤差
          scaleItem(it, f);
          host.changed();
          return;
        }
        if (!drag || e.pointerId !== drag.id) return;
        const k = SIZE / canvasEl.clientWidth;
        // 中心點不能離開畫布，免得把東西拖丟了
        it.x = clamp(drag.x + (e.clientX - drag.sx) * k, -it.w / 2, SIZE - it.w / 2);
        it.y = clamp(drag.y + (e.clientY - drag.sy) * k, -it.h / 2, SIZE - it.h / 2);
        host.changed();
      });
      const end = e => {
        ptrs.delete(e.pointerId);
        if (pin && ptrs.size < 2) {
          pin = null;
          const rest = [...ptrs.entries()][0];   // 剩下的那根手指接著拖曳（從它現在的位置算起，不會跳）
          if (rest) startDrag(rest[0], rest[1].x, rest[1].y); else drag = null;
        } else if (drag && e.pointerId === drag.id) drag = null;
      };
      box.addEventListener('pointerup', end);
      box.addEventListener('pointercancel', end);

      // 滾輪縮放
      box.addEventListener('wheel', e => {
        e.preventDefault();
        e.stopPropagation();
        const d = Math.abs(e.deltaY) >= Math.abs(e.deltaX) ? e.deltaY : e.deltaX;   // 按著 Shift 時有些系統會把滾動換成橫向
        scaleItem(it, Math.exp(-d * 0.0015), e.shiftKey && !e.altKey ? 'w' : e.altKey && !e.shiftKey ? 'h' : null);
        select(it.id);
        host.changed();
      }, { passive: false });
      return box;
    }

    function add(kind, key) {
      const list = host.items();
      if (!list || !host.ready() || list.length >= MAX_ITEMS) return;
      sync();
      const n = list.length % 6;
      let w, h;
      if (kind === 'sticker') {
        const img = images[key];
        w = STICKER_W;
        h = img && img.naturalWidth ? w * img.naturalHeight / img.naturalWidth : w;
      } else { w = MOSAIC_W; h = MOSAIC_H; }
      const it = { id: nextId++, kind, key: key || null, w, h, x: (SIZE - w) / 2 + (n - 2.5) * 36, y: (SIZE - h) / 2 + (n - 2.5) * 36 };
      list.push(it);
      layer.appendChild(buildEl(it));
      selectedId = it.id;
      host.changed();
    }

    // 點到畫布（沒點到方框）就取消選取；Delete 刪掉選取的
    canvasEl.addEventListener('pointerdown', () => { if (selectedId !== null) select(null); });
    document.addEventListener('keydown', e => {
      if (selectedId === null || (e.key !== 'Delete' && e.key !== 'Backspace')) return;
      const t = e.target;
      if (t && (/^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName) || t.isContentEditable)) return;
      e.preventDefault();
      removeItem(selectedId);
    });
    new ResizeObserver(layout).observe(canvasEl);

    const ed = { sync, layout, add, redraw: host.redraw, count: () => (shown ? shown.length : 0) };
    editors.push(ed);
    return ed;
  }

  // 一排「馬賽克＋7 張貼圖」的按鈕；dis() 回傳現在要不要停用（網頁版還沒有背景時）
  function buildRow(editor) {
    const row = document.createElement('div');
    row.className = 'fx-row';
    const tiles = [];
    const tile = (cls, title) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = `fx-tile ${cls}`;
      b.title = title;
      b.setAttribute('aria-label', title);
      row.appendChild(b);
      tiles.push(b);
      return b;
    };
    const mosaicTile = tile('fx-mosaic-tile', '馬賽克：加一個方塊馬賽克到預覽');
    mosaicTile.innerHTML = '<span class="fx-mini"></span><span>馬賽克</span>';
    mosaicTile.addEventListener('click', () => editor.add('mosaic'));
    const sep = document.createElement('span');
    sep.className = 'fx-sep';
    row.appendChild(sep);
    STICKERS.forEach(s => {
      const b = tile('fx-sticker-tile', `貼圖：${s.name}`);
      const img = document.createElement('img');
      img.src = `stickers/${s.id}.png`;
      img.alt = s.name;
      img.draggable = false;
      b.appendChild(img);
      b.addEventListener('click', () => editor.add('sticker', s.id));
    });
    row.addEventListener('wheel', e => {   // 滑鼠滾輪上下 → 左右捲
      if (row.scrollWidth <= row.clientWidth) return;
      row.scrollLeft += Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
      e.preventDefault();
    }, { passive: false });
    return { row, tiles };
  }
  const touchOnly = typeof matchMedia === 'function' && matchMedia('(hover: none)').matches;
  const hintText = touchOnly ? '點一下加到預覽；在預覽上拖曳移動、兩指縮放；按 × 刪除' : '點一下加到預覽；在預覽上拖曳移動、滾輪縮放；按 × 或 Delete 刪除';

  // ---- 側邊欄：單張預覽 ----
  if (useSingle) {
    const items = [];
    const single = createEditor({
      canvas,
      items: () => items,
      ready: () => typeof hasBackground === 'function' && hasBackground(singleBg),
      changed: () => render(),
      redraw: () => render(),
      onLayout: n => {
        sideBtn.classList.toggle('has-items', n > 0);
        sideBtn.textContent = n ? `貼圖 ${n}` : '貼圖';
      }
    });
    singleFx = { ...drawFx(items), onRender: () => single.sync() };
    single.sync();
    document.addEventListener('qpt:reset', () => {   // 「全部清除」
      items.length = 0;
      single.sync(true);
      render();
    });
    const { row } = buildRow(single);
    const hint = document.createElement('div');
    hint.className = 'fx-hint';
    hint.textContent = hintText;
    sideStrip.appendChild(row);
    sideStrip.appendChild(hint);
    sideBtn.addEventListener('click', () => {
      sideStrip.hidden = !sideStrip.hidden;
      sideBtn.setAttribute('aria-expanded', String(!sideStrip.hidden));
      sideBtn.classList.toggle('open', !sideStrip.hidden);
    });
  }

  // ---- 網頁版：批次預覽（每一組各自一份）----
  if (useBatch) {
    const store = new WeakMap();   // 批次項目 -> 它的貼圖／馬賽克清單（項目被移除就跟著被回收）
    const listOf = item => { let l = store.get(item); if (!l) store.set(item, l = []); return l; };
    const current = () => batchItems.find(it => it.id === expandedBatchItemId) || null;
    let count;
    let tiles = [];
    const setDisabled = () => {
      const off = !(current() && hasBackground(current().bg));
      tiles.forEach(b => { b.disabled = off; });
      batchSlot.classList.toggle('off', off);
    };
    const batch = createEditor({
      canvas: batchCanvas,
      items: () => { const it = current(); return it ? listOf(it) : null; },
      ready: () => { const it = current(); return !!it && hasBackground(it.bg); },
      changed: () => {
        const it = current();
        if (!it) return;
        if (it.invalidateDone) it.invalidateDone();   // 改了貼圖，這一組要重新按「完成」
        previewBatchItem(it);
      },
      redraw: () => { const it = current(); if (it && !it.done && listOf(it).length) previewBatchItem(it); },
      onLayout: n => { if (count) count.textContent = n ? `這一組已加 ${n} 個` : ''; setDisabled(); }
    });
    batchFx = { forItem: item => drawFx(listOf(item)), onView: () => batch.sync() };

    const head = document.createElement('div');
    head.className = 'fx-bar-head';
    const title = document.createElement('strong');
    title.textContent = '貼圖與馬賽克';
    count = document.createElement('span');
    count.className = 'fx-count';
    head.appendChild(title);
    head.appendChild(count);
    const built = buildRow(batch);
    tiles = built.tiles;
    const hint = document.createElement('div');
    hint.className = 'fx-hint';
    hint.textContent = hintText;
    batchSlot.appendChild(head);
    batchSlot.appendChild(built.row);
    batchSlot.appendChild(hint);
    batch.sync();
  }
})();

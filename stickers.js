// 側邊欄「快速產圖」的貼圖與馬賽克（只用在單張的預覽畫布，需在 app.js 之後載入）。
//
// 做法：貼圖／馬賽克的資料存在這裡（位置與大小用 1080×1080 畫布座標），畫的時候由 app.js 的 render() 透過 singleFx 叫回來：
//   - 馬賽克在「背景畫完、邊框與標題還沒畫」的時候畫，所以只糊照片，不糊標題字；
//   - 貼圖在最後畫，蓋在標題與邊框上面。
// 因為是畫進同一張畫布，下載、複製圖片、直接下載、排程帶入的都會自動包含它們。
// 預覽上用來拖曳的方框是蓋在畫布上的 DOM 元素，不會被輸出。
// 操作只有「移動」和「滾輪縮放」：滑鼠在方框上滾輪就是縮放它，其他地方的滾輪仍是縮放背景照片。
(function () {
  if (typeof singleFx === 'undefined' || typeof canvas === 'undefined' || typeof SIZE === 'undefined') return;

  const STICKERS = [
    { id: 'smile', name: '笑臉' }, { id: 'shock', name: '驚嚇' }, { id: 'cry', name: '大哭' }, { id: 'angry', name: '生氣' },
    { id: 'kiss', name: '親親' }, { id: 'laugh', name: '笑哭' }, { id: 'meh', name: '無言' }
  ];
  const images = {};
  STICKERS.forEach(s => {
    const img = new Image();
    img.onload = () => { render(); };
    img.src = `stickers/${s.id}.png`;
    images[s.id] = img;
  });

  const STICKER_W = 300;            // 新貼上的貼圖寬度（畫布座標）
  const MOSAIC_W = 320, MOSAIC_H = 240;
  const MIN_SIZE = 40, MAX_SIZE = SIZE * 1.4;
  const MAX_ITEMS = 30;
  const BLOCK_DIV = 5;              // 馬賽克的方塊大小 = 短邊 / 5：整個框只剩約 5 格，糊得夠重、認不出來
  const BLOCK_MIN = 14;

  let items = [];                   // { id, kind: 'sticker'|'mosaic', key, x, y, w, h }（x、y 是左上角）
  let selectedId = null;
  let nextId = 1;
  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
  const find = id => items.find(it => it.id === id);

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

  singleFx = {
    mosaic(c) { items.forEach(it => { if (it.kind === 'mosaic') pixelate(c, it); }); },
    stickers(c) {
      items.forEach(it => {
        const img = images[it.key];
        if (it.kind === 'sticker' && img && img.complete && img.naturalWidth) c.drawImage(img, it.x, it.y, it.w, it.h);
      });
    },
    onRender() { layout(); }
  };

  // ---- 預覽上的操作方框（DOM，不會輸出）----
  const wrap = canvas.closest('.canvas-wrap');
  const layer = document.createElement('div');
  layer.className = 'fx-layer';
  wrap.appendChild(layer);

  function layout() {
    const ready = typeof hasBackground === 'function' && hasBackground(singleBg);
    layer.hidden = !ready || !items.length;
    const k = canvas.clientWidth / SIZE;
    if (!k) return;
    layer.style.left = `${canvas.offsetLeft}px`;
    layer.style.top = `${canvas.offsetTop}px`;
    layer.style.width = `${canvas.clientWidth}px`;
    layer.style.height = `${canvas.clientHeight}px`;
    items.forEach(it => {
      const el = layer.querySelector(`[data-id="${it.id}"]`);
      if (!el) return;
      el.style.left = `${it.x * k}px`;
      el.style.top = `${it.y * k}px`;
      el.style.width = `${it.w * k}px`;
      el.style.height = `${it.h * k}px`;
      el.classList.toggle('selected', it.id === selectedId);
    });
    updateStrip();
  }

  function select(id) {
    selectedId = id;
    layout();
  }

  function removeItem(id) {
    items = items.filter(it => it.id !== id);
    const el = layer.querySelector(`[data-id="${id}"]`);
    if (el) el.remove();
    if (selectedId === id) selectedId = null;
    render();
  }

  function buildEl(it) {
    const el = document.createElement('div');
    el.className = `fx-item fx-${it.kind}`;
    el.dataset.id = it.id;
    el.title = it.kind === 'mosaic' ? '馬賽克：拖曳移動、滾輪縮放（Shift＝只調寬、Alt＝只調高）' : '拖曳移動、滾輪縮放';
    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'fx-del';
    del.textContent = '×';
    del.title = '刪除（Delete）';
    del.addEventListener('pointerdown', e => e.stopPropagation());
    del.addEventListener('click', e => { e.stopPropagation(); removeItem(it.id); });
    el.appendChild(del);

    let drag = null;
    el.addEventListener('pointerdown', e => {
      if (e.button !== 0) return;
      e.preventDefault();
      select(it.id);
      // 點到的方框移到最上層（畫的順序也跟著變）
      items = items.filter(x => x !== it).concat(it);
      layer.appendChild(el);
      drag = { id: e.pointerId, sx: e.clientX, sy: e.clientY, x: it.x, y: it.y };
      el.setPointerCapture(e.pointerId);
      render();
    });
    el.addEventListener('pointermove', e => {
      if (!drag || e.pointerId !== drag.id) return;
      const k = SIZE / canvas.clientWidth;
      // 中心點不能離開畫布，免得把東西拖丟了
      it.x = clamp(drag.x + (e.clientX - drag.sx) * k, -it.w / 2, SIZE - it.w / 2);
      it.y = clamp(drag.y + (e.clientY - drag.sy) * k, -it.h / 2, SIZE - it.h / 2);
      render();
    });
    const end = e => { if (drag && e.pointerId === drag.id) drag = null; };
    el.addEventListener('pointerup', end);
    el.addEventListener('pointercancel', end);

    // 滾輪縮放：以方框中心為準。貼圖等比；馬賽克也等比，按住 Shift 只調寬、按住 Alt 只調高。
    el.addEventListener('wheel', e => {
      e.preventDefault();
      e.stopPropagation();
      const d = Math.abs(e.deltaY) >= Math.abs(e.deltaX) ? e.deltaY : e.deltaX;   // 按著 Shift 時有些系統會把滾動換成橫向
      const f = Math.exp(-d * 0.0015);
      const cx = it.x + it.w / 2, cy = it.y + it.h / 2;
      let w = it.w, h = it.h;
      if (it.kind === 'mosaic' && e.shiftKey && !e.altKey) w = clamp(w * f, MIN_SIZE, MAX_SIZE);
      else if (it.kind === 'mosaic' && e.altKey && !e.shiftKey) h = clamp(h * f, MIN_SIZE, MAX_SIZE);
      else {
        const s = clamp(it.w * f, MIN_SIZE, MAX_SIZE) / it.w;
        const s2 = clamp(it.h * f, MIN_SIZE, MAX_SIZE) / it.h;
        const sc = f > 1 ? Math.min(s, s2) : Math.max(s, s2);   // 兩邊都要在範圍內
        w = it.w * sc; h = it.h * sc;
      }
      it.w = w; it.h = h; it.x = cx - w / 2; it.y = cy - h / 2;
      select(it.id);
      render();
    }, { passive: false });
    return el;
  }

  function add(kind, key) {
    if (items.length >= MAX_ITEMS) return;
    const n = items.length % 6;
    let w, h;
    if (kind === 'sticker') {
      const img = images[key];
      w = STICKER_W;
      h = img && img.naturalWidth ? w * img.naturalHeight / img.naturalWidth : w;
    } else { w = MOSAIC_W; h = MOSAIC_H; }
    const it = { id: nextId++, kind, key: key || null, w, h, x: (SIZE - w) / 2 + (n - 2.5) * 36, y: (SIZE - h) / 2 + (n - 2.5) * 36 };
    items.push(it);
    layer.appendChild(buildEl(it));
    selectedId = it.id;
    render();
  }

  // 點到畫布（沒點到方框）就取消選取；Delete 刪掉選取的
  canvas.addEventListener('pointerdown', () => { if (selectedId !== null) select(null); });
  document.addEventListener('keydown', e => {
    if (selectedId === null || (e.key !== 'Delete' && e.key !== 'Backspace')) return;
    const t = e.target;
    if (t && (/^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName) || t.isContentEditable)) return;
    e.preventDefault();
    removeItem(selectedId);
  });
  document.addEventListener('qpt:reset', () => {   // 「全部清除」
    items = [];
    selectedId = null;
    layer.textContent = '';
    render();
  });
  new ResizeObserver(layout).observe(canvas);

  // ---- 「貼圖」按鈕與在「快速產圖」下方彈出的那一排 ----
  const btn = document.getElementById('qfFxBtn');
  const strip = document.getElementById('qfFxStrip');
  if (!btn || !strip) return;
  const row = document.createElement('div');
  row.className = 'fx-row';
  const tile = (cls, title) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = `fx-tile ${cls}`;
    b.title = title;
    b.setAttribute('aria-label', title);
    row.appendChild(b);
    return b;
  };
  const mosaicTile = tile('fx-mosaic-tile', '馬賽克：加一個方塊馬賽克到預覽');
  mosaicTile.innerHTML = '<span class="fx-mini"></span><span>馬賽克</span>';
  mosaicTile.addEventListener('click', () => add('mosaic'));
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
    b.addEventListener('click', () => add('sticker', s.id));
  });
  row.addEventListener('wheel', e => {   // 滑鼠滾輪上下 → 左右捲
    if (row.scrollWidth <= row.clientWidth) return;
    row.scrollLeft += Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
    e.preventDefault();
  }, { passive: false });
  const hint = document.createElement('div');
  hint.className = 'fx-hint';
  hint.textContent = '點一下加到預覽；在預覽上拖曳移動、滾輪縮放；按 × 或 Delete 刪除';
  strip.appendChild(row);
  strip.appendChild(hint);

  function updateStrip() {
    btn.classList.toggle('has-items', items.length > 0);
    btn.textContent = items.length ? `貼圖 ${items.length}` : '貼圖';
  }
  btn.addEventListener('click', () => {
    strip.hidden = !strip.hidden;
    btn.setAttribute('aria-expanded', String(!strip.hidden));
    btn.classList.toggle('open', !strip.hidden);
  });
})();

// =====================================================================================
// 設計：介面（網頁版專用，外掛不需要；updater.js／deploy.js 的 SKIP 會略過 design-*）
//
// 「設計」分頁的工具列、畫布舞台（縮放／平移）、選取框與把手、屬性面板、頁面列、快捷鍵、觸控、匯出彈窗與專案檔。
// 只用 QPTDesign.core／fonts／render／export（一律在用到時才讀），不引用 app.js、stickers.js、watermark.js、deploy.js、edit-*.js。
// 跟主工具唯一的接縫：watermark.js 切分頁時送出的 qpt:func 事件（detail==='design' 時顯示）。
//
// 原則：
// - 文件只在這裡透過 core 的操作與 history 修改；core 成功後會換掉頁面／物件，所以一律用 id 重查，不長期握著物件參考。
// - 拖曳（移動、縮放、旋轉）與拉滑桿：history.begin → 每次移動先 rewind 再套用「從起點的總位移」→ end，整段只記一筆復原；Esc 取消。
// - 選取框、把手、吸附線、框選、文字輸入框都是蓋在畫布上的 DOM，不會輸出。
// - 重畫一律經過 scheduleRender（requestAnimationFrame 合併），字型分片、影像解碼完成都只排一次重畫。
// - 給 e2e 檢查用：QPTDesign.ui = { state, getDoc(), select(ids), rerender() }。
// =====================================================================================
(function () {
  'use strict';
  const Q = window.QPTDesign = window.QPTDesign || {};
  const app = document.getElementById('designApp');
  if (!app) return;

  const core = () => Q.core;
  const fonts = () => Q.fonts;
  const R = () => Q.render;
  const X = () => Q['export'];

  // ---- 常數 --------------------------------------------------------------------------
  const ZOOM_MIN = 0.1, ZOOM_MAX = 4;
  const CANVAS_MAX = 4096;               // 預覽畫布實際像素的上限
  const THUMB = 96;                      // 頁面縮圖長邊（CSS 像素）
  const MOVE_SLOP = 3;                   // 拖超過這麼多螢幕像素才算移動（避免點一下就記一筆）
  const IMAGE_SHARE = 0.6;               // 新圖片的長邊＝頁面短邊 × 0.6
  const STICKER_NAMES = { angry: '生氣', cry: '哭', kiss: '親親', laugh: '大笑', meh: '無言', shock: '驚訝', smile: '微笑' };
  const SIZE_NAMES = { '1:1': '1:1 方形', '4:5': '4:5 直式貼文', '9:16': '9:16 限動', '16:9': '16:9 橫式' };
  const SHAPES = [['rect', '矩形'], ['ellipse', '橢圓'], ['line', '線'], ['arrow', '箭頭']];
  const TEXT_LAYOUT_KEYS = ['text', 'font', 'size', 'w', 'lineHeight', 'letterSpacing', 'arc'];
  const RECOLOR_MAX = 24;                // 配色區最多列幾色

  // ---- 小工具 ------------------------------------------------------------------------
  const $ = id => document.getElementById(id);
  const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
  const r1 = v => Math.round(v * 10) / 10;
  const copy = v => JSON.parse(JSON.stringify(v));
  function el(tag, attrs, ...kids) {
    const e = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v == null || v === false) continue;
      if (k === 'class') e.className = v;
      else if (k === 'text') e.textContent = v;
      else if (k === 'style') e.style.cssText = v;
      else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
      else e.setAttribute(k, v === true ? '' : v);
    }
    for (const k of kids.flat()) if (k != null) e.append(k);
    return e;
  }
  // 焦點在輸入欄位（勾選框除外）時，快捷鍵一律交給欄位自己
  const typing = () => {
    const a = document.activeElement;
    if (!a) return false;
    if (a.tagName === 'INPUT') return a.type !== 'checkbox' && a.type !== 'radio';
    return a.tagName === 'TEXTAREA' || a.tagName === 'SELECT' || a.isContentEditable;
  };
  // 顏色欄位只吃 #rrggbb：把 #rgb、rgb()／rgba() 轉過去
  function toHex(c) {
    if (typeof c !== 'string') return '#000000';
    let m = /^#([0-9a-f]{6})$/i.exec(c);
    if (m) return '#' + m[1].toLowerCase();
    m = /^#([0-9a-f])([0-9a-f])([0-9a-f])$/i.exec(c);
    if (m) return ('#' + m[1] + m[1] + m[2] + m[2] + m[3] + m[3]).toLowerCase();
    m = /^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/i.exec(c);
    if (m) return '#' + [m[1], m[2], m[3]].map(v => clamp(+v, 0, 255).toString(16).padStart(2, '0')).join('');
    return '#000000';
  }
  const alphaOf = c => { const m = /^rgba\([^)]*,\s*([\d.]+)\s*\)$/i.exec(c || ''); return m ? +m[1] : 1; };
  function hexToRgba(hex, a) {
    const n = parseInt(hex.slice(1), 16);
    return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
  }
  function stamp() {
    const d = new Date(), p = n => String(n).padStart(2, '0');
    return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
  }
  function download(blob, name) {
    const url = URL.createObjectURL(blob);
    const a = el('a', { href: url, download: name, style: 'display:none' });
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 30000);
  }

  // =====================================================================================
  // 狀態
  // =====================================================================================
  const state = { doc: null, pageId: null, selection: [], zoom: 1, panX: 0, panY: 0, history: null };
  const assets = { blobs: {}, urls: {}, imgs: {}, wait: {} };   // 資產 id → Blob／Object URL／解碼好的影像／解碼中的 Promise
  const stickerImgs = {}, stickerWait = {};
  let H = null;                 // history
  let drag = null;              // 目前的拖曳：move／resize／rotate／marquee／pan／pinch
  let fieldPending = false;     // 面板欄位正在 begin…end 之間
  let editing = null;           // 文字編輯中：{ id, el }
  let clip = null, pasteN = 0;  // 內部剪貼簿（Ctrl+C 的物件）
  let autoFit = true;           // 使用者還沒自己縮放：視窗大小改變時重新符合視窗
  let shown = false;
  let spaceDown = false, overStage = false;
  let bgMode = null;            // 面板的背景分頁（還沒選圖時也能切到「圖片」）
  let exporting = false;
  const pointers = new Map();

  const doc = () => state.doc;
  const page = () => {
    const d = state.doc;
    return d.pages.find(p => p.id === state.pageId) || d.pages[0];
  };
  const pageIndex = () => state.doc.pages.indexOf(page());
  const objOf = id => page().objects.find(o => o.id === id) || null;
  const selObjs = () => state.selection.map(objOf).filter(Boolean);

  function initDoc() {
    state.doc = core().createDoc();
    state.pageId = state.doc.pages[0].id;
    H = state.history = core().createHistory(() => state.doc, () => onDocRestored(), { limit: 100 });
  }

  // 復原／重做／rewind／cancel 之後：頁面或物件可能不見了，修正目前頁與選取
  function onDocRestored() {
    pruneState();
    scheduleRender();
  }
  function pruneState() {
    const d = state.doc;
    if (!d.pages.some(p => p.id === state.pageId)) state.pageId = d.pages[0].id;
    const ids = new Set(page().objects.map(o => o.id));
    state.selection = state.selection.filter(id => ids.has(id));
    if (editing && !ids.has(editing.id)) cancelTextEdit();
  }

  // ---- 狀態列訊息 ----------------------------------------------------------------------
  let sayTimer = 0;
  function say(msg, kind) {
    const s = $('dzStatus');
    if (!s) return;
    s.textContent = msg || '';
    s.classList.toggle('err', kind === 'err');
    clearTimeout(sayTimer);
    if (msg && kind !== 'stay') sayTimer = setTimeout(() => { s.textContent = ''; }, 6000);
  }
  const lockedMsg = r => (r && r.reason === '物件已鎖定' ? '物件已鎖定，先在右側解除鎖定才能修改' : r && r.reason);

  // 一次編輯（記一筆復原）：fn(doc) 回 core 的結果；失敗時文件不變並顯示原因
  function act(label, fn) {
    endField();
    if (editing) commitTextEdit();
    if (H.busy) return { ok: false, reason: '請先完成目前的拖曳' };
    let r;
    try { r = H.run(label, fn); } catch (e) { r = { ok: false, reason: '操作失敗：' + (e && e.message || e) }; }
    if (r && r.ok === false) say(lockedMsg(r), 'err');
    pruneState();
    refresh();
    return r || { ok: true };
  }
  function endField() {
    if (!fieldPending) return;
    fieldPending = false;
    H.end();
    refresh();
  }

  // 文字物件改了排版相關欄位時，順便用 render.textHeight 更新 h
  function withTextH(o, patch) {
    if (o.type !== 'text' || !TEXT_LAYOUT_KEYS.some(k => k in patch)) return patch;
    const merged = Object.assign({}, o, patch);
    return Object.assign({}, patch, { h: Math.max(1, R().textHeight(merged, fonts())) });
  }
  // 對目前選取的物件套用 patch（可以是函式 o → patch）
  function patchSel(mk, ids) {
    const objs = (ids || state.selection).map(objOf).filter(Boolean);
    if (!objs.length) return { ok: false, reason: '沒有選取物件' };
    return core().updateObjects(state.doc, page().id, objs.map(o => Object.assign({ id: o.id }, withTextH(o, typeof mk === 'function' ? mk(o) : mk))));
  }

  // =====================================================================================
  // 版面骨架
  // =====================================================================================
  const ICONS = {
    text: '<path d="M4 5h16M12 5v14M9 19h6"/>',
    download: '<path d="M12 4v11M7 10l5 5 5-5M5 20h14"/>',
    image: '<rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="9" cy="10" r="2"/><path d="M21 17l-5-5-8 8"/>',
    rect: '<rect x="4" y="6" width="16" height="12" rx="1"/>',
    ellipse: '<ellipse cx="12" cy="12" rx="8" ry="6"/>',
    line: '<path d="M4 18L20 6"/>',
    arrow: '<path d="M4 18L19 7M12 6h7v7"/>',
    mosaic: '<path d="M4 4h5v5H4zM15 4h5v5h-5zM9.5 9.5h5v5h-5zM4 15h5v5H4zM15 15h5v5h-5z"/>',
  };
  const icon = name => `<svg viewBox="0 0 24 24" aria-hidden="true">${ICONS[name]}</svg>`;

  // 匯出彈窗的切換列（純字串，選項都是固定文字）
  function expToggle(id, label, options) {
    return `<div class="dz-row"><span class="dz-lbl">${label}</span><div class="dz-ctl"><div class="bg-toggle dz-toggle" id="${id}" role="group" aria-label="${label}">` +
      options.map(([v, n]) => `<button type="button" data-v="${v}">${n}</button>`).join('') + '</div></div></div>';
  }
  function build() {
    app.innerHTML = `
      <div class="dz-tools" id="dzTools" role="toolbar" aria-label="加入物件">
        <button type="button" class="dz-tool" data-add="text" title="加入文字">${icon('text')}<span>文字</span></button>
        <button type="button" class="dz-tool" data-add="image" title="加入圖片（也可以把圖片拖進畫布或貼上）">${icon('image')}<span>圖片</span></button>
        <span class="dz-tool-label">形狀</span>
        ${SHAPES.map(([k, n]) => `<button type="button" class="dz-tool" data-add="shape:${k}" title="加入${n}">${icon(k)}<span>${n}</span></button>`).join('')}
        <span class="dz-tool-label">貼圖</span>
        ${core().STICKERS.map(s => `<button type="button" class="dz-tool dz-sticker" data-add="sticker:${s}" title="加入貼圖：${STICKER_NAMES[s] || s}"><img src="stickers/${s}.png" alt="${STICKER_NAMES[s] || s}" draggable="false"></button>`).join('')}
        <span class="dz-tool-label">遮蓋</span>
        <button type="button" class="dz-tool" data-add="mosaic" title="加入馬賽克（打格子它底下的所有圖層）">${icon('mosaic')}<span>馬賽克</span></button>
        <input type="file" id="dzImgFile" accept="image/*" multiple hidden>
      </div>
      <div class="dz-main">
        <div class="dz-viewbar">
          <div class="dz-group">
            <button type="button" id="dzUndoBtn" title="復原（Ctrl＋Z）">↶ 復原</button>
            <button type="button" id="dzRedoBtn" title="重做（Ctrl＋Shift＋Z）">↷ 重做</button>
          </div>
          <div class="dz-group">
            <button type="button" id="dzZoomMinus" class="dz-sq" title="縮小" aria-label="縮小">−</button>
            <output id="dzZoomOut" aria-live="off">100%</output>
            <button type="button" id="dzZoomPlus" class="dz-sq" title="放大" aria-label="放大">＋</button>
            <button type="button" id="dzFitBtn" title="整頁放進視窗">符合視窗</button>
          </div>
          <div class="dz-viewbar-end">
            <div class="dz-group">
              <button type="button" id="dzOpenBtn" title="開啟之前存的 .json 專案檔">開啟專案</button>
              <button type="button" id="dzSaveBtn" title="存成 .json，之後可以再開啟繼續編輯">存專案</button>
              <input type="file" id="dzOpenFile" accept=".json,application/json" hidden>
            </div>
            <button type="button" class="primary dz-export-btn" id="dzExportBtn" aria-haspopup="dialog" title="設定格式、範圍、尺寸後下載或複製">${icon('download')}<span>匯出</span></button>
          </div>
        </div>
        <div class="dz-stage" id="dzStage" tabindex="-1" aria-label="設計畫布">
          <canvas id="dzCanvas" width="1" height="1"></canvas>
          <div class="dz-overlay" id="dzOverlay"></div>
        </div>
        <div class="dz-pagebar">
          <div class="dz-pages" id="dzPages" aria-label="頁面（可拖曳排序）"></div>
          <div class="dz-page-btns">
            <button type="button" id="dzPageAdd">＋ 新增頁面</button>
            <button type="button" id="dzPageDup">複製頁面</button>
            <button type="button" id="dzPageDel">刪除頁面</button>
          </div>
        </div>
        <div class="dz-status" id="dzStatus" role="status" aria-live="polite"></div>
        <div class="dz-hint"><span class="dz-desk">雙擊文字可以直接編輯；Ctrl＋滾輪縮放、按住空白鍵拖曳平移；Delete 刪除、Ctrl＋Z 復原、Ctrl＋C／V／D 複製貼上與重複、方向鍵微調（Shift 一次 10px）、] [ 調圖層。</span><span class="dz-touch">雙指縮放畫布、在空白處拖曳平移；文字內容在下方面板修改。</span></div>
      </div>
      <aside class="dz-panel" id="dzPanel" aria-label="屬性">
        <div id="dzPanelBody"></div>
      </aside>
      <div class="dz-modal" id="dzExportDlg" hidden>
        <div class="dz-modal-card" role="dialog" aria-modal="true" aria-labelledby="dzExpTitle">
          <div class="dz-modal-head">
            <h2 id="dzExpTitle">匯出</h2>
            <button type="button" class="dz-modal-x" id="dzExpClose" aria-label="關閉">×</button>
          </div>
          <div class="dz-modal-body">
            ${expToggle('dzExpFmt', '格式', [['png', 'PNG'], ['jpg', 'JPG']])}
            <p class="dz-note" id="dzExpFmtNote"></p>
            <div class="dz-row" id="dzExpQualityRow"><span class="dz-lbl">JPG 品質</span><div class="dz-ctl"><input type="range" id="dzExpQuality" min="60" max="100" step="1"><output class="dz-out" id="dzExpQualityOut"></output></div></div>
            ${expToggle('dzExpRange', '範圍', [['cur', '目前頁'], ['all', '全部頁'], ['custom', '指定頁']])}
            <div class="dz-row" id="dzExpPagesRow"><span class="dz-lbl">頁碼</span><div class="dz-ctl"><input type="text" id="dzExpPages" placeholder="例：1-3, 5" inputmode="numeric" autocomplete="off"></div></div>
            <div class="dz-row" id="dzExpPackRow"><span class="dz-lbl">多頁時</span><div class="dz-ctl"><div class="bg-toggle dz-toggle" id="dzExpPack" role="group" aria-label="多頁時"><button type="button" data-v="each">一張一張下載</button><button type="button" data-v="zip">打包 ZIP</button></div></div></div>
            <p class="dz-note" id="dzExpPackNote"></p>
            ${expToggle('dzExpScale', '尺寸', [['0.5', '0.5×'], ['1', '1×'], ['2', '2×'], ['3', '3×']])}
            <p class="dz-note" id="dzExpSize"></p>
            ${expToggle('dzExpDpi', '解析度', [['72', '72'], ['150', '150'], ['300', '300 DPI']])}
            <p class="dz-note">DPI 只寫進檔案的解析度標記（影響印刷時的實際尺寸），不會改變像素。</p>
            <div class="dz-row"><span class="dz-lbl">檔名</span><div class="dz-ctl"><input type="text" id="dzExpName" autocomplete="off" spellcheck="false"><span class="dz-unit" id="dzExpExt"></span></div></div>
            <p class="dz-exp-summary" id="dzExpSummary"></p>
            <p class="dz-note err" id="dzExpErr" role="alert"></p>
          </div>
          <div class="dz-modal-foot">
            <button type="button" id="dzExpCancel">取消</button>
            <button type="button" id="dzExpCopy" title="把這一頁（PNG）複製到剪貼簿，可以直接貼到聊天或社群後台">複製圖片</button>
            <button type="button" class="primary" id="dzExpGo">下載</button>
          </div>
        </div>
      </div>`;
  }

  // =====================================================================================
  // 檢視：縮放、平移、符合視窗
  // =====================================================================================
  const stageEl = () => $('dzStage');
  function stageSize() { const s = stageEl(); return { w: s.clientWidth, h: s.clientHeight }; }
  function fitZoom() {
    const { w, h } = stageSize(), p = page(), pad = w < 500 ? 16 : 32;
    return Math.max(0.01, Math.min((w - pad * 2) / p.w, (h - pad * 2) / p.h));
  }
  function fitView() {
    const { w, h } = stageSize();
    if (!w || !h) return false;
    const p = page();
    state.zoom = Math.min(ZOOM_MAX, fitZoom());
    state.panX = (w - p.w * state.zoom) / 2;
    state.panY = (h - p.h * state.zoom) / 2;
    autoFit = true;
    scheduleRender();
    return true;
  }
  // 以舞台上的 (sx, sy) 為中心縮放
  function zoomAt(z, sx, sy) {
    const lo = Math.min(ZOOM_MIN, fitZoom());
    z = clamp(z, lo, ZOOM_MAX);
    const px = (sx - state.panX) / state.zoom, py = (sy - state.panY) / state.zoom;
    state.zoom = z;
    state.panX = sx - px * z;
    state.panY = sy - py * z;
    autoFit = false;
    scheduleRender();
  }
  function zoomCenter(f) { const { w, h } = stageSize(); zoomAt(state.zoom * f, w / 2, h / 2); }
  // 螢幕座標 → 頁面座標
  function toPage(cx, cy) {
    const r = stageEl().getBoundingClientRect();
    return { x: (cx - r.left - state.panX) / state.zoom, y: (cy - r.top - state.panY) / state.zoom };
  }
  function toStage(cx, cy) { const r = stageEl().getBoundingClientRect(); return { x: cx - r.left, y: cy - r.top }; }

  // =====================================================================================
  // 重畫（requestAnimationFrame 合併）
  // =====================================================================================
  let rafId = 0;
  function scheduleRender() {
    if (rafId) return;
    rafId = requestAnimationFrame(() => { rafId = 0; drawAll(); });
  }
  function drawAll() {
    if (!state.doc) return;
    drawStage();
    drawOverlay();
    positionTextEdit();
    drawThumbs();
    syncChrome();
    syncPanel();
  }
  function renderOpts(scale, skip) {
    return { scale, images: assets.imgs, stickers: stickerImgs, fonts: fonts(), skipIds: skip || null };
  }
  function drawStage() {
    if (app.hidden) return;
    const p = page(), c = $('dzCanvas');
    const dpr = window.devicePixelRatio || 1;
    const k = Math.min(state.zoom * dpr, CANVAS_MAX / p.w, CANVAS_MAX / p.h);
    const cw = Math.max(1, Math.round(p.w * k)), ch = Math.max(1, Math.round(p.h * k));
    if (c.width !== cw) c.width = cw;
    if (c.height !== ch) c.height = ch;
    c.style.width = p.w * state.zoom + 'px';
    c.style.height = p.h * state.zoom + 'px';
    c.style.transform = `translate(${state.panX}px, ${state.panY}px)`;
    const ctx = c.getContext('2d');
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, cw, ch);
    const res = R().render(ctx, p, renderOpts(cw / p.w, editing ? new Set([editing.id]) : null));
    if (res && res.pending) for (const id of usedAssets(p)) loadAsset(id);
  }

  // ---- 選取框、把手、吸附線、框選（DOM，不輸出）----------------------------------------
  const HANDLE_POS = { nw: [0, 0], n: [50, 0], ne: [100, 0], e: [100, 50], se: [100, 100], s: [50, 100], sw: [0, 100], w: [0, 50] };
  const CURSORS = ['ns-resize', 'nesw-resize', 'ew-resize', 'nwse-resize'];
  const HANDLE_ANGLE = { n: 0, ne: 45, e: 90, se: 135, s: 180, sw: 225, w: 270, nw: 315 };
  function frameFor(o, cls) {
    const z = state.zoom;
    const f = el('div', { class: cls });
    f.style.left = state.panX + (o.x + o.w / 2) * z - (o.w * z) / 2 + 'px';
    f.style.top = state.panY + (o.y + o.h / 2) * z - (o.h * z) / 2 + 'px';
    f.style.width = o.w * z + 'px';
    f.style.height = o.h * z + 'px';
    if (o.rot) f.style.transform = `rotate(${o.rot}deg)`;
    return f;
  }
  function drawOverlay() {
    const ov = $('dzOverlay');
    ov.textContent = '';
    if (app.hidden) return;
    const objs = selObjs();
    for (const o of objs) {
      const f = frameFor(o, 'dz-sel' + (o.locked ? ' locked' : '') + (o.hidden ? ' is-hidden' : ''));
      if (o.locked) f.append(el('span', { class: 'dz-lock', text: '🔒' }));
      if (objs.length === 1 && !o.locked && !editing && !(drag && drag.type === 'move')) {
        const hs = o.type === 'text' ? ['nw', 'ne', 'se', 'sw', 'e', 'w'] : Object.keys(HANDLE_POS);
        for (const hd of hs) {
          const [l, t] = HANDLE_POS[hd];
          const ang = (HANDLE_ANGLE[hd] + (o.rot || 0) + 360) % 180;
          f.append(el('div', { class: 'dz-handle', 'data-h': hd, style: `left:${l}%;top:${t}%;cursor:${CURSORS[Math.round(ang / 45) % 4]}` }));
        }
        if (o.type !== 'mosaic') f.append(el('div', { class: 'dz-rot', title: '旋轉（Shift 每 15°）' }));
      }
      ov.append(f);
    }
    if (objs.length > 1) {
      const b = unionBounds(objs);
      ov.append(frameFor(Object.assign({ rot: 0 }, b), 'dz-group-box'));
    }
    if (drag && drag.lines) {
      for (const ln of drag.lines) {
        const g = el('div', { class: 'dz-guide', 'data-axis': ln.axis });
        if (ln.axis === 'x') g.style.left = state.panX + ln.pos * state.zoom + 'px';
        else g.style.top = state.panY + ln.pos * state.zoom + 'px';
        ov.append(g);
      }
    }
    if (drag && drag.type === 'marquee' && drag.rect) {
      const m = drag.rect;
      ov.append(el('div', { class: 'dz-marquee', style: `left:${state.panX + m.x * state.zoom}px;top:${state.panY + m.y * state.zoom}px;width:${m.w * state.zoom}px;height:${m.h * state.zoom}px` }));
    }
  }
  function unionBounds(objs) {
    const bs = objs.map(o => core().bounds(o));
    const x = Math.min(...bs.map(b => b.x)), y = Math.min(...bs.map(b => b.y));
    return { x, y, w: Math.max(...bs.map(b => b.x + b.w)) - x, h: Math.max(...bs.map(b => b.y + b.h)) - y };
  }

  // ---- 頁面縮圖 ---------------------------------------------------------------------------
  const thumbSig = {};
  let thumbOrder = '';
  function drawThumbs() {
    const box = $('dzPages'), d = state.doc;
    const order = d.pages.map(p => p.id).join(',');
    if (order !== thumbOrder) {
      thumbOrder = order;
      box.textContent = '';
      d.pages.forEach((p, i) => {
        const b = el('button', { type: 'button', class: 'dz-thumb', draggable: 'true', 'data-page': p.id, title: `第 ${i + 1} 頁（拖曳可以調整順序）` },
          el('canvas', { width: 1, height: 1 }), el('span', { text: String(i + 1) }));
        box.append(b);
        delete thumbSig[p.id];
      });
    }
    const extra = '|' + Object.keys(assets.imgs).length + '|' + Object.keys(stickerImgs).length + '|' + (fonts() ? fonts().gen() : 0);
    for (const b of box.querySelectorAll('.dz-thumb')) {
      const p = d.pages.find(q => q.id === b.dataset.page);
      if (!p) continue;
      b.classList.toggle('active', p.id === page().id);
      const sig = JSON.stringify(p) + extra;
      if (thumbSig[p.id] === sig) continue;
      thumbSig[p.id] = sig;
      const c = b.querySelector('canvas');
      const dpr = window.devicePixelRatio || 1, k = THUMB / Math.max(p.w, p.h);
      c.width = Math.max(1, Math.round(p.w * k * dpr)); c.height = Math.max(1, Math.round(p.h * k * dpr));
      c.style.width = Math.round(p.w * k) + 'px'; c.style.height = Math.round(p.h * k) + 'px';
      const ctx = c.getContext('2d');
      ctx.clearRect(0, 0, c.width, c.height);
      R().render(ctx, p, renderOpts(c.width / p.w));
    }
  }

  function syncChrome() {
    $('dzZoomOut').textContent = Math.round(state.zoom * 100) + '%';
    $('dzUndoBtn').disabled = !H.canUndo || H.busy;
    $('dzRedoBtn').disabled = !H.canRedo || H.busy;
    $('dzPageDel').disabled = state.doc.pages.length <= 1;
    $('dzPageAdd').disabled = $('dzPageDup').disabled = false;
    for (const id of ['dzExportBtn', 'dzSaveBtn', 'dzOpenBtn']) $(id).disabled = exporting;
  }

  // =====================================================================================
  // 影像（資產與貼圖）
  // =====================================================================================
  function usedAssets(p) {
    const ids = new Set();
    for (const pg of p ? [p] : state.doc.pages) {
      if (pg.bg && pg.bg.type === 'image') ids.add(pg.bg.asset);
      for (const o of pg.objects) if (o.type === 'image') ids.add(o.asset);
    }
    return [...ids];
  }
  function loadAsset(id) {
    if (assets.wait[id]) return assets.wait[id];
    const url = assets.urls[id];
    if (!url) return Promise.resolve(false);
    const im = new Image();
    assets.wait[id] = new Promise(res => {
      im.onload = () => { assets.imgs[id] = im; scheduleRender(); res(true); };
      im.onerror = () => res(false);
    });
    im.src = url;
    return assets.wait[id];
  }
  function loadStickers() {
    for (const s of core().STICKERS) {
      if (stickerWait[s]) continue;
      const im = new Image();
      stickerWait[s] = new Promise(res => {
        im.onload = () => { stickerImgs[s] = im; scheduleRender(); res(true); };
        im.onerror = () => res(false);
      });
      im.src = `stickers/${s}.png`;
    }
  }
  // 匯出前等文件用到的影像都解碼好
  function loadImages(d) {
    const jobs = [];
    for (const pg of d.pages) {
      if (pg.bg && pg.bg.type === 'image') jobs.push(loadAsset(pg.bg.asset));
      for (const o of pg.objects) {
        if (o.type === 'image') jobs.push(loadAsset(o.asset));
        if (o.type === 'sticker') { loadStickers(); jobs.push(stickerWait[o.sticker] || Promise.resolve(false)); }
      }
    }
    return Promise.all(jobs);
  }
  const exportEnv = () => ({ fonts: fonts(), images: assets.imgs, stickers: stickerImgs, loadImages });

  // 讀圖片檔 → 新資產（Object URL，不轉 base64）
  function decodeFile(file) {
    return new Promise((res, rej) => {
      const url = URL.createObjectURL(file);
      const im = new Image();
      im.onload = () => res({ url, im, w: im.naturalWidth, h: im.naturalHeight });
      im.onerror = () => { URL.revokeObjectURL(url); rej(new Error('讀不到這張圖片')); };
      im.src = url;
    });
  }
  function registerAsset(id, blob, url, im) {
    assets.blobs[id] = blob; assets.urls[id] = url;
    if (im) { assets.imgs[id] = im; assets.wait[id] = Promise.resolve(true); }
  }
  async function addImageFile(file, { asBg = false } = {}) {
    if (!file || !/^image\//.test(file.type || '')) { say('請選擇圖片檔', 'err'); return null; }
    let dec;
    try { dec = await decodeFile(file); } catch (e) { say(e.message, 'err'); return null; }
    let assetId = null;
    const pid = page().id;
    const r = act(asBg ? '背景圖片' : '加入圖片', d => {
      const a = core().addAsset(d, { name: file.name || '', w: dec.w, h: dec.h, mime: file.type || '' });
      if (!a.ok) return a;
      assetId = a.id;
      if (asBg) return core().setPageProps(d, pid, { bg: { type: 'image', asset: a.id, fit: 'cover', view: { ox: 0.5, oy: 0.5, scale: 1 } } });
      const p = d.pages.find(q => q.id === pid);
      const k = (Math.min(p.w, p.h) * IMAGE_SHARE) / Math.max(dec.w, dec.h);
      return core().addObject(d, pid, { type: 'image', asset: a.id, w: Math.max(1, dec.w * k), h: Math.max(1, dec.h * k) });
    });
    if (!r.ok || !assetId) { URL.revokeObjectURL(dec.url); return null; }
    registerAsset(assetId, file, dec.url, dec.im);
    if (asBg) bgMode = null;
    else select([r.id]);
    refresh();
    return r;
  }

  // =====================================================================================
  // 新增物件
  // =====================================================================================
  function addObject(kind) {
    endField();
    if (kind === 'image') { $('dzImgFile').click(); return; }
    const [type, sub] = kind.split(':');
    const C = core();
    let partial = { type };
    if (type === 'text') {
      partial = C.defaults('text');
      partial.w = Math.min(partial.w, Math.round(page().w * 0.85));   // 窄頁面時不要超出
      partial.h = Math.max(1, R().textHeight(partial, fonts()));
      fonts().load(partial.font);
    } else if (type === 'shape') {
      partial = { type, kind: sub };
      if (sub === 'line' || sub === 'arrow') Object.assign(partial, { w: 400, h: 40, stroke: { w: 8, color: '#111111' } });
      if (sub === 'ellipse') Object.assign(partial, { w: 320, h: 320 });
    } else if (type === 'sticker') {
      partial = { type, sticker: sub };
      loadStickers();
    } else if (type === 'mosaic') partial = { type };
    const r = act('新增物件', d => core().addObject(d, page().id, partial));
    if (r.ok) select([r.id]);
    return r;
  }

  // =====================================================================================
  // 選取
  // =====================================================================================
  function select(ids) {
    const have = new Set(page().objects.map(o => o.id));
    state.selection = [...new Set((ids || []).filter(id => have.has(id)))];
    refresh();
  }
  function refresh() { refreshPanel(); scheduleRender(); }

  // =====================================================================================
  // 指標（滑鼠、觸控、筆）
  // =====================================================================================
  function onPointerDown(e) {
    const stage = stageEl();
    if (editing && e.target === editing.el) return;
    if (e.pointerType === 'mouse' && e.button !== 0 && e.button !== 1) return;
    if (editing) commitTextEdit();
    endField();
    if (document.activeElement && document.activeElement !== document.body && !stage.contains(document.activeElement)) document.activeElement.blur();
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    e.preventDefault();

    // 兩指：縮放＋平移（取消一指的拖曳）
    if (pointers.size === 2) {
      if (drag && H.busy) H.cancel();
      const [a, b] = [...pointers.values()];
      const mid = toStage((a.x + b.x) / 2, (a.y + b.y) / 2);
      drag = { type: 'pinch', d0: Math.hypot(a.x - b.x, a.y - b.y) || 1, z0: state.zoom,
        px: (mid.x - state.panX) / state.zoom, py: (mid.y - state.panY) / state.zoom };
      scheduleRender();
      return;
    }
    if (pointers.size > 2) return;

    const pt = toPage(e.clientX, e.clientY);
    const handleEl = e.target.closest && e.target.closest('.dz-handle');
    const rotEl = e.target.closest && e.target.closest('.dz-rot');
    if (spaceDown || e.button === 1) { startPan(e); return; }

    if (handleEl || rotEl) {
      const o = selObjs()[0];
      if (!o) return;
      H.begin(rotEl ? '旋轉' : '縮放');
      drag = { type: rotEl ? 'rotate' : 'resize', id: o.id, handle: handleEl && handleEl.dataset.h, orig: copy(o), start: pt, sx: e.clientX, sy: e.clientY };
      scheduleRender();
      return;
    }

    const hit = core().hitTest(page(), pt.x, pt.y);
    if (hit) {
      if (e.shiftKey) {
        if (state.selection.includes(hit)) { select(state.selection.filter(id => id !== hit)); return; }
        select(state.selection.concat(hit));
      } else if (!state.selection.includes(hit)) select([hit]);
      const objs = selObjs();
      const orig = {};
      for (const o of objs) orig[o.id] = { x: o.x, y: o.y };
      H.begin('移動');
      drag = { type: 'move', ids: objs.map(o => o.id), orig, start: pt, sx: e.clientX, sy: e.clientY, moved: false,
        box: unionBounds(objs), cands: core().snapCandidates(page(), objs.map(o => o.id)), lines: null };
      return;
    }
    // 空白處：觸控是平移，滑鼠是框選
    if (e.pointerType === 'touch') { if (!e.shiftKey) select([]); startPan(e); return; }
    if (!e.shiftKey) select([]);
    drag = { type: 'marquee', start: pt, add: e.shiftKey ? state.selection.slice() : [], rect: null };
  }
  function startPan(e) {
    drag = { type: 'pan', sx: e.clientX, sy: e.clientY, px: state.panX, py: state.panY };
    stageEl().classList.add('dz-grabbing');
  }

  function onPointerMove(e) {
    if (pointers.has(e.pointerId)) pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (!drag) return;
    const C = core();
    if (drag.type === 'pinch') {
      if (pointers.size < 2) return;
      const [a, b] = [...pointers.values()];
      const d = Math.hypot(a.x - b.x, a.y - b.y) || 1;
      const mid = toStage((a.x + b.x) / 2, (a.y + b.y) / 2);
      state.zoom = clamp(drag.z0 * d / drag.d0, Math.min(ZOOM_MIN, fitZoom()), ZOOM_MAX);
      state.panX = mid.x - drag.px * state.zoom;
      state.panY = mid.y - drag.py * state.zoom;
      autoFit = false;
      scheduleRender();
      return;
    }
    if (drag.type === 'pan') {
      state.panX = drag.px + e.clientX - drag.sx;
      state.panY = drag.py + e.clientY - drag.sy;
      autoFit = false;
      scheduleRender();
      return;
    }
    const pt = toPage(e.clientX, e.clientY);
    if (drag.type === 'marquee') {
      const x = Math.min(pt.x, drag.start.x), y = Math.min(pt.y, drag.start.y);
      drag.rect = { x, y, w: Math.abs(pt.x - drag.start.x), h: Math.abs(pt.y - drag.start.y) };
      scheduleRender();
      return;
    }
    let dx = pt.x - drag.start.x, dy = pt.y - drag.start.y;
    if (drag.type === 'move') {
      if (!drag.moved && Math.hypot(e.clientX - drag.sx, e.clientY - drag.sy) < MOVE_SLOP) return;
      drag.moved = true;
      H.rewind();
      drag.lines = null;
      if (!e.altKey) {
        const b = drag.box;
        const s = C.snapBox({ x: b.x + dx, y: b.y + dy, w: b.w, h: b.h }, drag.cands, { zoom: state.zoom });
        dx += s.dx; dy += s.dy;
        drag.lines = s.lines.length ? s.lines : null;
      }
      const r = C.updateObjects(state.doc, page().id, drag.ids.map(id => ({ id, x: drag.orig[id].x + dx, y: drag.orig[id].y + dy })));
      if (!r.ok) { H.cancel(); drag = null; say(lockedMsg(r), 'err'); refresh(); return; }
      scheduleRender();
      return;
    }
    if (drag.type === 'resize') {
      const o = drag.orig, hd = drag.handle, corner = hd.length === 2;
      const keep = corner && !(e.shiftKey && o.type !== 'text');   // 角把手等比；非文字按 Shift 可以自由縮放
      const nr = C.resizeRect(o, hd, dx, dy, { keepRatio: keep, minSize: 8 });
      let patch = { x: nr.x, y: nr.y, w: nr.w, h: nr.h };
      if (o.type === 'text') {
        if (corner) patch.size = Math.max(1, r1(o.size * nr.w / o.w));
        else patch.h = Math.max(1, R().textHeight(Object.assign({}, o, { w: nr.w }), fonts()));
      }
      H.rewind();
      const r = C.updateObjects(state.doc, page().id, [Object.assign({ id: o.id }, patch)]);
      if (!r.ok) { H.cancel(); drag = null; say(lockedMsg(r), 'err'); refresh(); return; }
      scheduleRender();
      return;
    }
    if (drag.type === 'rotate') {
      const a = C.rotateAngle(drag.orig, pt.x, pt.y, { step: e.shiftKey ? 15 : 0 });
      H.rewind();
      const r = C.updateObjects(state.doc, page().id, [{ id: drag.orig.id, rot: Math.round(a * 10) / 10 }]);
      if (!r.ok) { H.cancel(); drag = null; say(lockedMsg(r), 'err'); refresh(); return; }
      scheduleRender();
    }
  }

  function onPointerUp(e) {
    pointers.delete(e.pointerId);
    if (!drag) return;
    const d = drag;
    if (d.type === 'pinch') { if (pointers.size === 0) drag = null; return; }
    drag = null;
    stageEl().classList.remove('dz-grabbing');
    if (d.type === 'marquee') {
      if (d.rect && (d.rect.w > 1 || d.rect.h > 1)) select(d.add.concat(core().inRect(page(), d.rect)));
      scheduleRender();
      return;
    }
    if (d.type === 'move' || d.type === 'resize' || d.type === 'rotate') {
      if (H.busy) H.end();
      refresh();
    }
    scheduleRender();
  }
  // 拖曳中按 Esc：回到拖曳前，不記復原
  function cancelDrag() {
    if (!drag) return false;
    if ((drag.type === 'move' || drag.type === 'resize' || drag.type === 'rotate') && H.busy) H.cancel();
    drag = null;
    stageEl().classList.remove('dz-grabbing');
    refresh();
    return true;
  }

  function onWheel(e) {
    e.preventDefault();
    const s = toStage(e.clientX, e.clientY);
    if (e.ctrlKey || e.metaKey) { zoomAt(state.zoom * Math.exp(-e.deltaY * 0.0015), s.x, s.y); return; }
    const k = e.deltaMode === 1 ? 16 : 1;
    if (e.shiftKey && !e.deltaX) state.panX -= e.deltaY * k;
    else { state.panX -= e.deltaX * k; state.panY -= e.deltaY * k; }
    autoFit = false;
    scheduleRender();
  }

  // =====================================================================================
  // 文字編輯（蓋在畫布上的 textarea，不輸出）
  // =====================================================================================
  function startTextEdit(id) {
    const o = objOf(id);
    if (!o || o.type !== 'text') return;
    if (o.locked) { say('物件已鎖定，先在右側解除鎖定才能編輯', 'err'); return; }
    endField();
    state.selection = [id];
    const ta = el('textarea', { class: 'dz-text-edit', spellcheck: 'false', 'aria-label': '編輯文字' });
    ta.value = o.text;
    stageEl().append(ta);
    editing = { id, el: ta };
    ta.addEventListener('input', () => { const cur = objOf(id); if (cur) fonts().ensureText(cur.font, ta.value); positionTextEdit(); });
    ta.addEventListener('keydown', e => {
      // Esc：結束編輯但保留選取（不要再傳到 document，否則會被當成「取消選取」）
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); commitTextEdit(); stageEl().focus({ preventScroll: true }); }
    });
    ta.addEventListener('blur', () => commitTextEdit());
    positionTextEdit();
    ta.focus({ preventScroll: true });
    ta.select();
    refresh();
  }
  function positionTextEdit() {
    if (!editing) return;
    const o = objOf(editing.id), ta = editing.el;
    if (!o) return;
    const z = state.zoom;
    ta.style.left = state.panX + o.x * z + 'px';
    ta.style.top = state.panY + o.y * z + 'px';
    ta.style.width = o.w * z + 'px';
    ta.style.font = fonts().fontCss(o.font, o.size * z);
    ta.style.lineHeight = o.size * o.lineHeight * z + 'px';
    ta.style.letterSpacing = (o.letterSpacing || 0) * z + 'px';
    ta.style.textAlign = o.align;
    ta.style.color = typeof o.color === 'string' ? o.color : o.color.from;   // 漸層字在編輯框裡先用起點色
    ta.style.transformOrigin = `${(o.w * z) / 2}px ${(o.h * z) / 2}px`;
    ta.style.transform = o.rot ? `rotate(${o.rot}deg)` : '';
    ta.style.height = '0px';
    ta.style.height = Math.max(ta.scrollHeight, o.size * o.lineHeight * z) + 'px';
  }
  function commitTextEdit() {
    if (!editing) return;
    const { id, el: ta } = editing;
    editing = null;
    const text = ta.value;
    ta.remove();
    const o = objOf(id);
    if (o && o.text !== text) {
      const r = act('編輯文字', d => core().updateObjects(d, page().id, [Object.assign({ id }, withTextH(o, { text }))]));
      if (r.ok) fonts().ensureText(o.font, text);
    } else refresh();
  }
  function cancelTextEdit() {
    if (!editing) return;
    const ta = editing.el;
    editing = null;
    ta.remove();
  }

  // =====================================================================================
  // 快捷鍵與剪貼簿
  // =====================================================================================
  function onKeyDown(e) {
    if (app.hidden) return;
    if (e.key === 'Escape' && drag) { e.preventDefault(); cancelDrag(); return; }
    if (typing()) return;
    if (document.querySelector('.modal-overlay.open, #confirmOverlay.open') || !$('dzExportDlg').hidden) return;
    const mod = e.ctrlKey || e.metaKey, k = (e.key || '').toLowerCase();
    if (e.key === ' ' && overStage) { e.preventDefault(); if (!spaceDown) { spaceDown = true; stageEl().classList.add('dz-panning'); } return; }
    if (drag) return;
    if (mod && k === 'z') { e.preventDefault(); e.shiftKey ? redo() : undo(); return; }
    if (mod && k === 'y') { e.preventDefault(); redo(); return; }
    if (mod && k === 'c') { if (state.selection.length) copySel(); return; }
    if (mod && k === 'x') { if (state.selection.length) { copySel(); delSel(); e.preventDefault(); } return; }
    if (mod && k === 'v') { schedulePaste(); return; }
    if (mod && k === 'd') { e.preventDefault(); dupSel(); return; }
    if (mod && k === 'a') { e.preventDefault(); select(page().objects.filter(o => !o.hidden).map(o => o.id)); return; }
    if (mod || e.altKey) return;
    if (e.key === 'Delete' || e.key === 'Backspace') { if (state.selection.length) { e.preventDefault(); delSel(); } return; }
    const arrows = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
    if (arrows[e.key]) {
      if (!state.selection.length) return;
      e.preventDefault();
      const n = e.shiftKey ? 10 : 1, [ax, ay] = arrows[e.key];
      act('微調位置', d => patchSel(o => ({ x: o.x + ax * n, y: o.y + ay * n })));
      return;
    }
    if (e.key === ']' || e.key === '}') { if (state.selection.length) act('圖層順序', d => core().reorder(d, page().id, state.selection, e.shiftKey ? 'top' : 'up')); return; }
    if (e.key === '[' || e.key === '{') { if (state.selection.length) act('圖層順序', d => core().reorder(d, page().id, state.selection, e.shiftKey ? 'bottom' : 'down')); return; }
    if (e.key === 'Escape') { if (state.selection.length) select([]); return; }
    if (e.key === 'Enter' && state.selection.length === 1) { const o = selObjs()[0]; if (o.type === 'text') { e.preventDefault(); startTextEdit(o.id); } }
  }
  function onKeyUp(e) {
    if (e.key === ' ' && spaceDown) { spaceDown = false; stageEl().classList.remove('dz-panning'); }
  }
  function undo() { endField(); if (editing) commitTextEdit(); if (H.undo()) { pruneState(); refresh(); } }
  function redo() { endField(); if (editing) commitTextEdit(); if (H.redo()) { pruneState(); refresh(); } }
  function copySel() {
    const objs = page().objects.filter(o => state.selection.includes(o.id));   // 依圖層順序
    clip = copy(objs);
    pasteN = 0;
    say(`已複製 ${objs.length} 個物件`);
  }
  let pasteTimer = 0;
  // Ctrl+V：系統剪貼簿裡有圖片時由 paste 事件加入圖片；沒有的話（或瀏覽器沒送 paste 事件）就貼上內部複製的物件
  function schedulePaste() {
    clearTimeout(pasteTimer);
    pasteTimer = setTimeout(() => { pasteTimer = 0; pasteClip(); }, 60);
  }
  function pasteClip() {
    if (!clip || !clip.length) return;
    pasteN++;
    const r = act('貼上', d => core().pasteObjects(d, page().id, clip, { dx: 20 * pasteN, dy: 20 * pasteN }));
    if (r.ok) select(r.ids);
  }
  function dupSel() {
    if (!state.selection.length) return;
    const r = act('重複', d => core().duplicateObjects(d, page().id, state.selection));
    if (r.ok) select(r.ids);
  }
  function delSel() {
    const r = act('刪除', d => core().removeObjects(d, page().id, state.selection));
    if (r.ok) select([]);
  }
  function onPaste(e) {
    if (app.hidden) return;
    const items = e.clipboardData ? [...e.clipboardData.items] : [];
    const files = items.filter(i => i.kind === 'file' && /^image\//.test(i.type)).map(i => i.getAsFile()).filter(Boolean);
    if (!files.length) return;   // 沒有圖片：輸入框貼純文字照常
    e.stopImmediatePropagation();   // 不讓 app.js 把圖貼到看不見的「圖片套版」（輸入框內也一樣）
    if (typing()) return;           // 在輸入框內不加圖到設計，只擋掉 app.js
    e.preventDefault();
    clearTimeout(pasteTimer); pasteTimer = 0;
    (async () => { for (const f of files) await addImageFile(f); })();
  }
  function onCopy(e) {
    if (app.hidden || typing() || !state.selection.length) return;
    // 蓋掉系統剪貼簿裡舊的圖片，之後 Ctrl+V 才會貼上這次複製的物件
    const texts = selObjs().filter(o => o.type === 'text').map(o => o.text);
    if (e.clipboardData) { e.clipboardData.setData('text/plain', texts.join('\n') || '設計物件'); e.preventDefault(); }
  }

  // =====================================================================================
  // 頁面列
  // =====================================================================================
  function goPage(id) {
    if (editing) commitTextEdit();
    endField();
    if (id === state.pageId) return;
    const prev = page();
    state.pageId = id;
    state.selection = [];
    bgMode = null;
    const p = page();
    if (autoFit || prev.w !== p.w || prev.h !== p.h) fitView();
    refresh();
  }
  function addPage() {
    const r = act('新增頁面', d => core().addPage(d, { index: pageIndex() + 1 }));
    if (r.ok) goPage(r.id);
  }
  function dupPage() {
    const r = act('複製頁面', d => core().duplicatePage(d, page().id));
    if (r.ok) goPage(r.id);
  }
  function delPage() {
    const i = pageIndex(), id = page().id;
    const r = act('刪除頁面', d => core().removePage(d, id));
    if (r.ok) { state.pageId = state.doc.pages[Math.min(i, state.doc.pages.length - 1)].id; state.selection = []; fitView(); refresh(); }
  }
  let dragPageId = null;
  function wirePages() {
    const box = $('dzPages');
    box.addEventListener('click', e => { const b = e.target.closest('.dz-thumb'); if (b) goPage(b.dataset.page); });
    box.addEventListener('dragstart', e => {
      const b = e.target.closest('.dz-thumb');
      if (!b) return;
      dragPageId = b.dataset.page;
      e.dataTransfer.effectAllowed = 'move';
      try { e.dataTransfer.setData('text/plain', 'qpt-page:' + dragPageId); } catch (err) { /* 有些瀏覽器不給設 */ }
    });
    box.addEventListener('dragover', e => { if (dragPageId) { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; } });
    box.addEventListener('drop', e => {
      if (!dragPageId) return;
      e.preventDefault();
      const b = e.target.closest('.dz-thumb');
      const id = dragPageId;
      dragPageId = null;
      if (!b || b.dataset.page === id) return;
      const to = state.doc.pages.findIndex(p => p.id === b.dataset.page);
      act('調整頁面順序', d => core().movePage(d, id, to));
    });
    box.addEventListener('dragend', () => { dragPageId = null; });
  }

  // =====================================================================================
  // 屬性面板
  // =====================================================================================
  let panelSig = '';
  let bound = [];   // { el, get, kind, out? }：重畫時把值同步回欄位（使用者正在操作的那一格除外）
  function selSig() {
    const objs = selObjs(), p = page();
    return [p.id, state.selection.join(','), objs.map(o => `${o.type}:${o.kind || ''}:${o.locked}:${paintKind(o.type === 'text' ? o.color : o.fill)}`).join(','),
      p.bg.type, bgMode || '', editing ? 'e' : ''].join('|');
  }
  function refreshPanel() {
    if (!state.doc) return;
    const sig = selSig();
    if (sig !== panelSig) { panelSig = sig; buildPanel(); }
    syncPanel();
  }
  function syncPanel() {
    for (const b of bound) {
      let v;
      try { v = b.get(); } catch (e) { continue; }
      if (v === undefined) continue;
      if (b.kind === 'fn') { b.sync(v); continue; }
      if (b.el === document.activeElement && b.kind !== 'check') {   // 使用者正在操作的欄位不改值，只更新旁邊的數字
        if (b.out) b.out.textContent = b.fmt ? b.fmt(v) : String(r1(v));
        continue;
      }
      if (b.kind === 'check') b.el.checked = !!v;
      else if (b.kind === 'toggle') {
        for (const x of b.el.querySelectorAll('button')) { const on = x.dataset.v === String(v); x.classList.toggle('active', on); x.setAttribute('aria-pressed', String(on)); }
      }
      else if (b.kind === 'color') b.el.value = toHex(v);
      else if (b.kind === 'num' || b.kind === 'range') {
        const s = String(r1(v));
        if (b.el.value !== s) b.el.value = s;
        if (b.out) b.out.textContent = b.fmt ? b.fmt(v) : s;
      } else if (b.el.value !== String(v)) b.el.value = v;
    }
    updateFontUi();
  }

  // ---- 欄位工廠 ----
  // live：拉動中一直預覽（begin → 每次 input 都 rewind 再套用 → change 時 end，整段一筆）
  function liveBind(input, label, apply) {
    input.addEventListener('input', () => {
      const v = readVal(input);
      if (v === null) return;
      if (editing) commitTextEdit();
      if (!fieldPending) {
        if (H.busy) return;
        H.begin(label);
        fieldPending = true;
      }
      H.rewind();
      const r = apply(v);
      if (r && r.ok === false) say(lockedMsg(r), 'err');
      scheduleRender();
    });
    input.addEventListener('change', () => endField());
  }
  function readVal(input) {
    if (input.type === 'number' || input.type === 'range') {
      if (input.value === '') return null;
      const n = Number(input.value);
      return isFinite(n) ? n : null;
    }
    return input.value;
  }
  function row(label, ...controls) {
    return el('div', { class: 'dz-row' }, el('span', { class: 'dz-lbl', text: label }), el('div', { class: 'dz-ctl' }, ...controls));
  }
  // 數字欄位：get() 讀值、apply(v) 套用（在 live 交易裡）
  function numField(id, label, get, apply, { min, max, step = 1, unit = '' } = {}) {
    const input = el('input', { type: 'number', id, min, max, step, inputmode: 'decimal' });
    liveBind(input, label, v => apply(min != null || max != null ? clamp(v, min != null ? min : -Infinity, max != null ? max : Infinity) : v));
    bound.push({ el: input, get, kind: 'num' });
    return row(label, input, unit ? el('span', { class: 'dz-unit', text: unit }) : null);
  }
  function rangeField(id, label, get, apply, { min, max, step = 1, fmt } = {}) {
    const input = el('input', { type: 'range', id, min, max, step });
    const out = el('output', { class: 'dz-out' });
    liveBind(input, label, apply);
    bound.push({ el: input, get, kind: 'range', out, fmt });
    return row(label, input, out);
  }
  function colorField(id, label, get, apply) {
    const input = el('input', { type: 'color', id });
    liveBind(input, label, apply);
    bound.push({ el: input, get, kind: 'color' });
    return row(label, input);
  }
  function checkField(id, label, get, apply, attrs) {
    const input = el('input', Object.assign({ type: 'checkbox', id }, attrs || {}));
    input.addEventListener('change', () => act(label, () => apply(input.checked)));
    bound.push({ el: input, get, kind: 'check' });
    return el('label', Object.assign({ class: 'dz-check', for: id }, attrs || {}), input, el('span', { text: label }));
  }
  function selectField(id, label, options, get, apply) {
    const s = el('select', { id }, options.map(([v, n]) => el('option', { value: v, text: n })));
    s.addEventListener('change', () => act(label, () => apply(s.value)));
    bound.push({ el: s, get, kind: 'select' });
    return row(label, s);
  }
  function toggleField(id, label, options, get, apply) {
    const box = el('div', { class: 'bg-toggle dz-toggle', id, role: 'group', 'aria-label': label },
      options.map(([v, n]) => el('button', { type: 'button', 'data-v': v, text: n })));
    box.addEventListener('click', e => { const b = e.target.closest('button'); if (b) act(label, () => apply(b.dataset.v)); });
    bound.push({ el: box, get, kind: 'toggle' });
    return row(label, box);
  }
  const sec = (title, ...kids) => el('section', { class: 'dz-sec' }, title ? el('h3', { text: title }) : null, ...kids);
  const btn = (text, onclick, attrs) => el('button', Object.assign({ type: 'button', onclick }, attrs || {}), text);

  // 讀目前物件的欄位（用 id 重查）
  const cur = id => objOf(id) || {};
  const pageBg = () => page().bg;

  // ---- 顏料（純色／線性／放射）----
  // 物件的 paint：純色字串、{ type:'linear', from, to, angle }、{ type:'radial', from, to, cx, cy, r }。
  // 背景的寫法不同（{ type:'solid', color }、線性叫 'gradient'），所以編輯器內部一律轉成 { kind, color | from, to, angle | cx, cy, r } 處理。
  function paintKind(p) {
    if (p == null) return '';
    if (typeof p === 'string') return 'solid';
    return p.type === 'radial' ? 'radial' : p.type === 'solid' ? 'solid' : 'linear';
  }
  const numOr = (v, d) => (typeof v === 'number' && isFinite(v) ? v : d);
  function paintDecode(p, bg) {
    if (bg) {
      if (!p || p.type === 'image') return null;
      if (p.type === 'solid') return { kind: 'solid', color: p.color };
    } else if (typeof p === 'string') return { kind: 'solid', color: p };
    if (p && p.type === 'radial') return { kind: 'radial', from: p.from, to: p.to, cx: numOr(p.cx, 0.5), cy: numOr(p.cy, 0.5), r: numOr(p.r, 1) };
    if (p && (p.type === 'linear' || p.type === 'gradient')) return { kind: 'linear', from: p.from, to: p.to, angle: numOr(p.angle, 180) };
    return { kind: 'solid', color: '#000000' };
  }
  // 寫回時補滿所有欄位（放射的 cx、cy、r 不留空）
  function paintEncode(q, bg) {
    if (q.kind === 'solid') return bg ? { type: 'solid', color: q.color } : q.color;
    if (q.kind === 'linear') return { type: bg ? 'gradient' : 'linear', from: q.from, to: q.to, angle: q.angle };
    return { type: 'radial', from: q.from, to: q.to, cx: q.cx, cy: q.cy, r: q.r };
  }
  // 換類型：純色→漸層時起點沿用原色、終點白（原色本來就是白就改用主色藍，不然看不出變化）；
  // 漸層之間互換保留兩端顏色；漸層→純色用起點色
  function paintConvert(q, kind) {
    if (q.kind === kind) return q;
    if (kind === 'solid') return { kind, color: q.kind === 'solid' ? q.color : q.from };
    const from = q.kind === 'solid' ? q.color : q.from;
    const to = q.kind === 'solid' ? (core().colorKey(from) === '#ffffff' ? '#2f6fed' : '#ffffff') : q.to;
    return kind === 'linear' ? { kind, from, to, angle: 180 } : { kind, from, to, cx: 0.5, cy: 0.5, r: 1 };
  }
  // 物件用的欄位 id：dzF-fill（純色）、dzF-fill-type、dzF-fill-from／-to／-angle／-cx／-cy／-r
  const paintIds = p => ({ type: p + '-type', color: p, from: p + '-from', to: p + '-to', angle: p + '-angle', cx: p + '-cx', cy: p + '-cy', r: p + '-r' });
  // 顏料編輯器（形狀填色、文字顏色、背景共用）：回傳一串面板列。
  // get() 讀原始 paint、set(raw) 在交易裡寫回（回 core 的結果）；改漸層的單一欄位時一律寫回完整的 paint 物件。
  // 有 ids.type 才畫「純色／線性／放射」切換（背景的切換和「圖片」放在一起，由背景面板自己畫）。
  function paintEditor(ids, label, get, set, { bg = false, solidLabel = '選色' } = {}) {
    const q = () => paintDecode(get(), bg);
    const put = patch => set(paintEncode(Object.assign({}, q(), patch), bg));
    // 類型對不上（例如剛復原、面板還沒重建）時回 undefined，syncPanel 就不動那一格
    const g = (kind, f) => () => { const x = q(); return x && x.kind === kind ? f(x) : undefined; };
    const pct = v => Math.round(v) + '%';
    const now = q(), kids = [];
    if (!now) return kids;
    if (ids.type) {
      kids.push(toggleField(ids.type, label, [['solid', '純色'], ['linear', '線性'], ['radial', '放射']],
        () => { const x = q(); return x ? x.kind : undefined; }, v => set(paintEncode(paintConvert(q(), v), bg))));
    }
    if (now.kind === 'solid') {
      kids.push(colorField(ids.color, ids.type ? solidLabel : label, g('solid', x => x.color), v => put({ color: v })));
    } else if (now.kind === 'linear') {
      kids.push(colorField(ids.from, '起點色', g('linear', x => x.from), v => put({ from: v })));
      kids.push(colorField(ids.to, '終點色', g('linear', x => x.to), v => put({ to: v })));
      kids.push(rangeField(ids.angle, '角度', g('linear', x => x.angle), v => put({ angle: v }), { min: 0, max: 360, step: 1, fmt: v => Math.round(v) + '°' }));
    } else {
      kids.push(colorField(ids.from, '中心色', g('radial', x => x.from), v => put({ from: v })));
      kids.push(colorField(ids.to, '外圍色', g('radial', x => x.to), v => put({ to: v })));
      kids.push(rangeField(ids.cx, '中心 X', g('radial', x => x.cx * 100), v => put({ cx: v / 100 }), { min: 0, max: 100, step: 1, fmt: pct }));
      kids.push(rangeField(ids.cy, '中心 Y', g('radial', x => x.cy * 100), v => put({ cy: v / 100 }), { min: 0, max: 100, step: 1, fmt: pct }));
      kids.push(rangeField(ids.r, '半徑', g('radial', x => x.r * 100), v => put({ r: v / 100 }), { min: 5, max: 200, step: 1, fmt: pct }));
    }
    return kids;
  }

  // ---- 配色（重新著色）：沒選物件時列出本頁／全部頁用到的顏色，點色票換色 ----
  let recolorScope = 'page';
  function recolorSec() {
    const C = core();
    const opts = () => (recolorScope === 'page' ? { pageId: page().id } : {});
    const scope = el('div', { class: 'bg-toggle dz-toggle', id: 'dzRecolorScope', role: 'group', 'aria-label': '配色範圍' },
      [['page', '本頁'], ['all', '全部頁']].map(([v, n]) => el('button', { type: 'button', 'data-v': v, text: n })));
    scope.addEventListener('click', e => {
      const b = e.target.closest('button');
      if (!b || b.dataset.v === recolorScope) return;
      recolorScope = b.dataset.v;
      syncPanel();
    });
    bound.push({ el: scope, get: () => recolorScope, kind: 'toggle' });
    const grid = el('div', { class: 'dz-swatches', id: 'dzRecolorGrid' });
    const more = el('p', { class: 'dz-note', id: 'dzRecolorMore' });
    const apply = (from, value) => {
      const to = C.colorKey(value);
      if (!to || to === from) return;
      const r = act('換色', d => C.recolor(d, { [from]: to }, opts()));
      if (!r.ok) return;
      const lockNote = r.skippedLocked ? `${r.skippedLocked} 處在鎖定物件裡沒改` : '';
      if (!r.changed) say('沒有可替換的顏色' + (lockNote ? `（${lockNote}）` : ''), lockNote ? 'err' : null);
      else say(`已替換 ${r.changed} 處` + (lockNote ? `；${lockNote}` : ''));
    };
    // 顏色或次數變了才重建色票（每次重畫都會檢查，所以復原、別處的修改也會反映）
    let sig = null;
    const rebuild = () => {
      const list = C.docColors(state.doc, opts());
      const s = recolorScope + '|' + list.map(c => c.color + ':' + c.count).join(',');
      if (s === sig) return;
      sig = s;
      grid.textContent = '';
      for (const { color, count } of list.slice(0, RECOLOR_MAX)) {
        const input = el('input', { type: 'color', value: color, 'aria-label': `${color}，用了 ${count} 處，點一下換色` });
        // 選好才套用（change）：拖色盤時不連續換色，整次只記一筆復原
        input.addEventListener('change', () => apply(color, input.value));
        grid.append(el('label', { class: 'dz-swatch', 'data-color': color, title: `${color}（${count} 處）` },
          input, el('span', { class: 'dz-swatch-n', 'aria-hidden': 'true', text: String(count) })));
      }
      more.textContent = list.length > RECOLOR_MAX ? `另有 ${list.length - RECOLOR_MAX} 色（只列出用得最多的 ${RECOLOR_MAX} 色）` : '';
    };
    bound.push({ kind: 'fn', get: () => true, sync: rebuild });
    const s = sec('配色', row('範圍', scope), grid, more,
      el('p', { class: 'dz-note', text: '點色票選新顏色，畫面上所有這個顏色（含漸層兩端、描邊、陰影）都會換掉；鎖定的物件不改。' }));
    s.id = 'dzRecolor';
    return s;
  }

  function buildPanel() {
    const body = $('dzPanelBody');
    bound = [];
    body.textContent = '';
    const objs = selObjs();
    if (!objs.length) body.append(...pagePanel());
    else if (objs.length === 1) body.append(...objPanel(objs[0]));
    else body.append(...multiPanel(objs));
  }

  // ---- 頁面設定 ----
  function pagePanel() {
    const p = page(), C = core();
    const presetOf = () => { const q = page(); const k = Object.keys(C.SIZES).find(k => C.SIZES[k][0] === q.w && C.SIZES[k][1] === q.h); return k || 'custom'; };
    const preset = el('select', { id: 'dzSizePreset' },
      Object.keys(C.SIZES).map(k => el('option', { value: k, text: `${SIZE_NAMES[k] || k}（${C.SIZES[k][0]}×${C.SIZES[k][1]}）` })),
      el('option', { value: 'custom', text: '自訂尺寸' }));
    const wIn = el('input', { type: 'number', id: 'dzPageW', min: C.SIDE_MIN, max: C.SIDE_MAX, step: 1, value: p.w, inputmode: 'numeric' });
    const hIn = el('input', { type: 'number', id: 'dzPageH', min: C.SIDE_MIN, max: C.SIDE_MAX, step: 1, value: p.h, inputmode: 'numeric' });
    const setSize = (w, h) => {
      const r = act('頁面尺寸', d => C.setPageProps(d, page().id, { w, h }));
      if (r.ok) { fitView(); say(`頁面尺寸改成 ${w}×${h}`); }
      else { wIn.value = page().w; hIn.value = page().h; preset.value = presetOf(); }
    };
    preset.addEventListener('change', () => {
      if (preset.value === 'custom') { wIn.focus(); return; }
      const [w, h] = C.SIZES[preset.value];
      setSize(w, h);
    });
    const apply = btn('套用', () => {
      const w = Number(wIn.value), h = Number(hIn.value);
      if (!Number.isInteger(w) || !Number.isInteger(h) || w < C.SIDE_MIN || h < C.SIDE_MIN || w > C.SIDE_MAX || h > C.SIDE_MAX) {
        say(`頁面尺寸必須是 ${C.SIDE_MIN}～${C.SIDE_MAX} 的整數`, 'err');
        return;
      }
      setSize(w, h);
    }, { id: 'dzPageApply' });
    for (const inp of [wIn, hIn]) inp.addEventListener('keydown', e => { if (e.key === 'Enter') apply.click(); });
    bound.push({ el: preset, get: presetOf, kind: 'select' });
    bound.push({ el: wIn, get: () => page().w, kind: 'num' }, { el: hIn, get: () => page().h, kind: 'num' });

    // 背景
    const bg = p.bg, mode = bgMode || bg.type;
    const bgType = el('div', { class: 'bg-toggle dz-toggle', id: 'dzBgType', role: 'group', 'aria-label': '背景類型' },
      [['solid', '純色'], ['gradient', '線性'], ['radial', '放射'], ['image', '圖片']].map(([v, n]) =>
        el('button', { type: 'button', 'data-bg': v, class: v === mode ? 'active' : null, 'aria-pressed': String(v === mode), title: v === 'gradient' ? '線性漸層' : v === 'radial' ? '放射漸層' : null, text: n })));
    bgType.addEventListener('click', e => {
      const b = e.target.closest('button');
      if (!b) return;
      const t = b.dataset.bg, now = page().bg;
      if (t === now.type) { bgMode = null; refresh(); return; }
      if (t === 'image') { bgMode = 'image'; refresh(); return; }
      bgMode = null;
      const q = paintDecode(now, true) || { kind: 'solid', color: '#ffffff' };
      const nb = paintEncode(paintConvert(q, t === 'gradient' ? 'linear' : t), true);
      act('背景', d => C.setPageProps(d, page().id, { bg: nb }));
    });
    const setBg = patch => C.setPageProps(state.doc, page().id, { bg: Object.assign({}, page().bg, patch) });
    const bgKids = [];
    if (mode === 'solid' || mode === 'gradient' || mode === 'radial') {
      bgKids.push(...paintEditor({ color: 'dzBgColor', from: 'dzBgFrom', to: 'dzBgTo', angle: 'dzBgAngle', cx: 'dzBgCx', cy: 'dzBgCy', r: 'dzBgR' },
        '顏色', pageBg, raw => C.setPageProps(state.doc, page().id, { bg: raw }), { bg: true }));
    } else {
      const file = el('input', { type: 'file', id: 'dzBgFile', accept: 'image/*', hidden: true });
      file.addEventListener('change', () => { const f = file.files[0]; file.value = ''; if (f) addImageFile(f, { asBg: true }); });
      bgKids.push(el('div', { class: 'dz-btns' }, btn(bg.type === 'image' ? '換一張背景圖' : '選擇背景圖片', () => file.click(), { id: 'dzBgPick' }), file));
      if (bg.type === 'image') {
        bgKids.push(toggleField('dzBgFit', '填滿方式', [['cover', '蓋滿'], ['contain', '完整顯示']], () => pageBg().fit, v => C.setPageProps(state.doc, page().id, { bg: Object.assign({}, page().bg, { fit: v }) })));
        const setView = patch => setBg({ view: Object.assign({}, page().bg.view, patch) });
        bgKids.push(rangeField('dzBgScale', '縮放', () => pageBg().view.scale * 100, v => setView({ scale: v / 100 }), { min: 100, max: 400, step: 1, fmt: v => Math.round(v) + '%' }));
        bgKids.push(rangeField('dzBgOx', '水平位置', () => pageBg().view.ox * 100, v => setView({ ox: v / 100 }), { min: 0, max: 100, step: 1, fmt: v => Math.round(v) + '%' }));
        bgKids.push(rangeField('dzBgOy', '垂直位置', () => pageBg().view.oy * 100, v => setView({ oy: v / 100 }), { min: 0, max: 100, step: 1, fmt: v => Math.round(v) + '%' }));
      } else bgKids.push(el('p', { class: 'dz-note', text: '選好圖片後才會換成圖片背景。' }));
    }
    return [
      sec(`頁面（第 ${pageIndex() + 1} 頁／共 ${state.doc.pages.length} 頁）`,
        row('尺寸', preset),
        row('寬×高', wIn, el('span', { class: 'dz-unit', text: '×' }), hIn, apply),
        el('p', { class: 'dz-note', text: `自訂尺寸 ${C.SIDE_MIN}～${C.SIDE_MAX} px。` })),
      sec('背景', row('類型', bgType), ...bgKids),
      recolorSec(),
      sec(null, el('p', { class: 'dz-note', text: '從左邊加入文字、圖片、形狀、貼圖或馬賽克；點一下物件就能在這裡調整。' })),
    ];
  }

  // ---- 弧形文字：滑桿＋數字欄位（−360～360）；arc ≠ 0 時對齊停用（弧形固定置中）----
  // 改 arc 會經過 patchSel → withTextH，用 render.textHeight 更新 h
  function arcRows(id, up, alignRow) {
    const apply = v => up({ arc: clamp(Math.round(v), -360, 360) });
    const rng = el('input', { type: 'range', id: 'dzF-arc', min: -360, max: 360, step: 1, 'aria-label': '弧度' });
    const num = el('input', { type: 'number', id: 'dzF-arcNum', class: 'dz-arc-num', min: -360, max: 360, step: 1, inputmode: 'numeric', 'aria-label': '弧度（度）' });
    const out = el('output', { class: 'dz-out', id: 'dzF-arcOut', for: 'dzF-arc' });
    const note = el('p', { class: 'dz-note', id: 'dzF-arcNote' });
    liveBind(rng, '弧度', apply);
    liveBind(num, '弧度', apply);
    const arcOf = () => cur(id).arc || 0;
    bound.push({ el: rng, get: arcOf, kind: 'range' }, { el: num, get: arcOf, kind: 'num' });
    bound.push({ kind: 'fn', get: arcOf, sync: a => {
      out.textContent = a === 0 ? '不彎' : a > 0 ? '上拱' : '下彎';
      note.textContent = a === 0 ? '0＝不彎；往右拉字往上拱、往左拉往下彎。' : '弧形文字固定置中（對齊不作用），排成一行、不換行。';
      const locked = !!cur(id).locked;
      for (const b of alignRow.querySelectorAll('button')) { b.disabled = locked || a !== 0; b.title = a !== 0 ? '弧形文字固定置中' : ''; }
    } });
    return [row('弧度', rng, num, out), note];
  }

  // ---- 單一物件 ----
  function objPanel(o) {
    const C = core(), id = o.id;
    const up = mk => patchSel(mk, [id]);
    const kids = [];
    const TITLES = { text: '文字', image: '圖片', shape: '形狀', sticker: '貼圖', mosaic: '馬賽克' };
    if (o.locked) kids.push(el('p', { class: 'dz-locked-note', text: '🔒 這個物件已鎖定：不能移動、縮放或修改，先取消下面的「鎖定」。' }));

    // 類型專屬
    if (o.type === 'text') {
      const ta = el('textarea', { id: 'dzTextContent', rows: 3, 'aria-label': '文字內容' });
      liveBind(ta, '編輯文字', v => { fonts().ensureText(cur(id).font, v); return up({ text: v }); });
      bound.push({ el: ta, get: () => cur(id).text, kind: 'text' });
      const fontSel = el('select', { id: 'dzFont' }, fonts().list().map(f => el('option', { value: f.id, text: fontLabel(f) })));
      fontSel.addEventListener('change', () => {
        const fid = fontSel.value;
        fonts().load(fid);
        fonts().ensureText(fid, cur(id).text);
        act('字型', () => up({ font: fid }));
      });
      bound.push({ el: fontSel, get: () => cur(id).font, kind: 'select' });
      const alignRow = toggleField('dzF-align', '對齊', [['left', '靠左'], ['center', '置中'], ['right', '靠右']], () => cur(id).align, v => up({ align: v }));
      kids.push(sec('文字',
        row('內容', ta),
        row('字型', fontSel),
        el('p', { class: 'dz-note dz-font-state', id: 'dzFontState' }),
        numField('dzF-size', '字級', () => cur(id).size, v => up({ size: v }), { min: 4, max: 1000, step: 1, unit: 'px' }),
        paintEditor(paintIds('dzF-color'), '顏色', () => cur(id).color, v => up({ color: v })),
        alignRow,
        rangeField('dzF-lineHeight', '行高', () => cur(id).lineHeight, v => up({ lineHeight: v }), { min: 0.8, max: 3, step: 0.05, fmt: v => (Math.round(v * 100) / 100).toFixed(2) }),
        rangeField('dzF-letterSpacing', '字距', () => cur(id).letterSpacing, v => up({ letterSpacing: v }), { min: -20, max: 100, step: 1 }),
        ...arcRows(id, up, alignRow)));
      kids.push(sec('描邊與陰影',
        numField('dzF-strokeW', '描邊粗細', () => cur(id).stroke.w, v => up({ stroke: { w: v } }), { min: 0, max: 60, step: 1, unit: 'px' }),
        colorField('dzF-strokeColor', '描邊顏色', () => cur(id).stroke.color, v => up({ stroke: { color: v } })),
        numField('dzF-shadowBlur', '陰影模糊', () => cur(id).shadow.blur, v => up({ shadow: { blur: v } }), { min: 0, max: 100, step: 1, unit: 'px' }),
        numField('dzF-shadowX', '陰影 X', () => cur(id).shadow.x, v => up({ shadow: { x: v } }), { min: -200, max: 200, step: 1, unit: 'px' }),
        numField('dzF-shadowY', '陰影 Y', () => cur(id).shadow.y, v => up({ shadow: { y: v } }), { min: -200, max: 200, step: 1, unit: 'px' }),
        colorField('dzF-shadowColor', '陰影顏色', () => cur(id).shadow.color, v => up({ shadow: { color: hexToRgba(v, alphaOf(cur(id).shadow.color)) } }))));
    } else if (o.type === 'image') {
      const setView = patch => up({ view: Object.assign({}, cur(id).view, patch) });
      kids.push(sec('圖片',
        toggleField('dzF-fit', '填滿方式', [['cover', '蓋滿'], ['contain', '完整顯示']], () => cur(id).fit, v => up({ fit: v })),
        rangeField('dzF-scale', '裁切縮放', () => cur(id).view.scale * 100, v => setView({ scale: v / 100 }), { min: 100, max: 400, step: 1, fmt: v => Math.round(v) + '%' }),
        rangeField('dzF-ox', '水平位置', () => cur(id).view.ox * 100, v => setView({ ox: v / 100 }), { min: 0, max: 100, step: 1, fmt: v => Math.round(v) + '%' }),
        rangeField('dzF-oy', '垂直位置', () => cur(id).view.oy * 100, v => setView({ oy: v / 100 }), { min: 0, max: 100, step: 1, fmt: v => Math.round(v) + '%' }),
        numField('dzF-radius', '圓角', () => cur(id).radius, v => up({ radius: v }), { min: 0, max: 2000, step: 1, unit: 'px' }),
        checkField('dzF-gray', '抽色（黑白）', () => cur(id).gray, v => up({ gray: v }))));
    } else if (o.type === 'shape') {
      const line = o.kind === 'line' || o.kind === 'arrow';
      kids.push(sec('形狀',
        // 線與箭頭的填色只能是純色：從漸層的矩形／橢圓改過去時，填色改用起點色
        selectField('dzF-kind', '種類', SHAPES, () => cur(id).kind, v => up(x => (v === 'line' || v === 'arrow') && typeof x.fill !== 'string' ? { kind: v, fill: x.fill.from } : { kind: v })),
        line ? null : paintEditor(paintIds('dzF-fill'), '填色', () => cur(id).fill, v => up({ fill: v })),
        numField('dzF-strokeW', line ? '線條粗細' : '描邊粗細', () => cur(id).stroke.w, v => up({ stroke: { w: v } }), { min: 0, max: 200, step: 1, unit: 'px' }),
        colorField('dzF-strokeColor', line ? '線條顏色' : '描邊顏色', () => cur(id).stroke.color, v => up({ stroke: { color: v } })),
        o.kind === 'rect' ? numField('dzF-radius', '圓角', () => cur(id).radius, v => up({ radius: v }), { min: 0, max: 2000, step: 1, unit: 'px' }) : null));
    } else if (o.type === 'sticker') {
      const grid = el('div', { class: 'dz-sticker-pick', id: 'dzF-sticker', role: 'group', 'aria-label': '換貼圖' },
        C.STICKERS.map(s => el('button', { type: 'button', 'data-v': s, title: STICKER_NAMES[s] || s }, el('img', { src: `stickers/${s}.png`, alt: STICKER_NAMES[s] || s, draggable: 'false' }))));
      grid.addEventListener('click', e => { const b = e.target.closest('button'); if (b) act('換貼圖', () => up({ sticker: b.dataset.v })); });
      bound.push({ el: grid, get: () => cur(id).sticker, kind: 'toggle' });
      kids.push(sec('貼圖', grid));
    } else if (o.type === 'mosaic') {
      kids.push(sec('馬賽克', el('p', { class: 'dz-note', text: '馬賽克會把它底下所有圖層打成格子（格子大小依短邊自動決定），不能旋轉。' })));
    }

    // 位置與大小
    kids.push(sec(`位置與大小（${TITLES[o.type]}）`,
      el('div', { class: 'dz-grid2' },
        numField('dzF-x', 'X', () => cur(id).x, v => up({ x: v }), { step: 1 }),
        numField('dzF-y', 'Y', () => cur(id).y, v => up({ y: v }), { step: 1 }),
        numField('dzF-w', '寬', () => cur(id).w, v => up({ w: v }), { min: 1, step: 1 }),
        o.type === 'text' ? numField('dzF-h', '高', () => cur(id).h, () => ({ ok: true }), { step: 1 }) : numField('dzF-h', '高', () => cur(id).h, v => up({ h: v }), { min: 1, step: 1 }),
        o.type === 'mosaic' ? null : numField('dzF-rot', '旋轉', () => cur(id).rot, v => up({ rot: ((v % 360) + 360) % 360 }), { min: -360, max: 360, step: 1, unit: '°' })),
      rangeField('dzF-opacity', '透明度', () => cur(id).opacity * 100, v => up({ opacity: v / 100 }), { min: 0, max: 100, step: 1, fmt: v => Math.round(v) + '%' })));
    kids.push(arrangeSec([id]));
    const nodes = kids.filter(Boolean);
    if (o.type === 'text') { const h = nodes.flatMap(n => [...n.querySelectorAll('#dzF-h')]); for (const x of h) { x.disabled = true; x.title = '文字的高度由內容決定'; } }
    if (o.locked) for (const n of nodes) for (const x of n.querySelectorAll('input, select, textarea, button')) if (!x.closest('[data-lockfree]')) x.disabled = true;
    return nodes;
  }

  // ---- 排列（對齊、圖層、鎖定、隱藏、複製、刪除）----
  function arrangeSec(ids) {
    const C = core(), multi = ids.length > 1;
    const alignBtns = el('div', { class: 'dz-icon-row', role: 'group', 'aria-label': multi ? '對齊選取範圍' : '對齊頁面' },
      [['left', '靠左'], ['hcenter', '水平置中'], ['right', '靠右'], ['top', '靠上'], ['vcenter', '垂直置中'], ['bottom', '靠下']]
        .map(([m, n]) => btn(n, () => act('對齊', d => C.align(d, page().id, state.selection, m)), { 'data-align': m })));
    const kids = [el('h4', { text: multi ? '對齊（以選取範圍為準）' : '對齊頁面' }), alignBtns];
    if (multi) {
      kids.push(el('h4', { text: '等距分佈（3 個以上）' }), el('div', { class: 'dz-icon-row' },
        btn('水平等距', () => act('等距分佈', d => C.distribute(d, page().id, state.selection, 'h')), { 'data-dist': 'h' }),
        btn('垂直等距', () => act('等距分佈', d => C.distribute(d, page().id, state.selection, 'v')), { 'data-dist': 'v' })));
    }
    kids.push(el('h4', { text: '圖層' }), el('div', { class: 'dz-icon-row' },
      btn('移到最上', () => act('圖層順序', d => C.reorder(d, page().id, state.selection, 'top')), { 'data-order': 'top' }),
      btn('上移一層', () => act('圖層順序', d => C.reorder(d, page().id, state.selection, 'up')), { 'data-order': 'up' }),
      btn('下移一層', () => act('圖層順序', d => C.reorder(d, page().id, state.selection, 'down')), { 'data-order': 'down' }),
      btn('移到最下', () => act('圖層順序', d => C.reorder(d, page().id, state.selection, 'bottom')), { 'data-order': 'bottom' })));
    const allOf = k => () => { const objs = selObjs(); return objs.length > 0 && objs.every(o => o[k]); };
    kids.push(el('div', { class: 'dz-checks' },
      checkField('dzF-locked', '鎖定', allOf('locked'), v => patchSel({ locked: v }), { 'data-lockfree': '' }),
      checkField('dzF-hidden', '隱藏', allOf('hidden'), v => patchSel({ hidden: v }), { 'data-lockfree': '' })));
    kids.push(el('div', { class: 'dz-btns' },
      btn('重複', dupSel, { id: 'dzDupBtn' }),
      btn('刪除', delSel, { id: 'dzDelBtn', class: 'dz-danger' })));
    return sec(multi ? null : '排列', ...kids);
  }

  // ---- 多選 ----
  function multiPanel(objs) {
    const node = arrangeSec(objs.map(o => o.id));
    const s = sec(`已選取 ${objs.length} 個物件`, el('p', { class: 'dz-note', text: 'Shift＋點選可以加選或取消；在空白處拖曳可以框選。' }));
    if (objs.some(o => o.locked)) s.append(el('p', { class: 'dz-locked-note', text: '🔒 選取範圍裡有鎖定的物件，無法一起移動、對齊或刪除。' }));
    s.append(rangeField('dzF-opacity', '透明度', () => selObjs()[0].opacity * 100, v => patchSel({ opacity: v / 100 }), { min: 0, max: 100, step: 1, fmt: v => Math.round(v) + '%' }));
    return [s, node];
  }

  // ---- 字型選單的狀態 ----
  function fontLabel(f) {
    const st = f.state || fonts().state(f.id);
    return f.name + (st === 'loading' ? '（下載中…）' : st === 'failed' ? '（載入失敗）' : '');
  }
  function updateFontUi() {
    const sel = $('dzFont');
    if (!sel) return;
    const list = fonts().list();
    for (const opt of sel.options) { const f = list.find(x => x.id === opt.value); if (f) { const t = fontLabel(f); if (opt.textContent !== t) opt.textContent = t; } }
    const note = $('dzFontState');
    if (note) {
      const st = fonts().state(sel.value);
      const t = st === 'loading' ? '字型下載中…（先用備用字型顯示，下載好會自動更新）' : st === 'failed' ? '字型載入失敗，暫時用備用字型；匯出也會用備用字型。' : '';
      if (note.textContent !== t) note.textContent = t;
      note.classList.toggle('err', st === 'failed');
    }
  }

  // =====================================================================================
  // 匯出、剪貼簿、專案檔
  // =====================================================================================
  // spec = { kind:'download'|'copy', fmt, pages:[0 起算], scale, quality(0～1), dpi, name, pack:'each'|'zip' }（由匯出彈窗組出來）
  async function runExport(spec) {
    if (exporting) return;
    endField();
    if (editing) commitTextEdit();
    exporting = true;
    syncChrome();
    say('匯出中…', 'stay');
    try {
      // 匯出期間使用者仍可能在編輯；先深拷貝一份，避免 core 的 replaceInPlace 在同一物件上換掉 pages
      const d = core().deserialize(core().serialize(state.doc)), env = exportEnv();
      const opts = { scale: spec.scale, quality: spec.quality, dpi: spec.dpi };
      const pages = spec.pages, fmt = spec.fmt, FMT = fmt.toUpperCase();
      const px = i => `${Math.round(d.pages[i].w * spec.scale)}×${Math.round(d.pages[i].h * spec.scale)}`;
      if (spec.kind === 'copy') {
        const r = await X().copyPage(d, pages[0], env, opts);
        say(r.ok ? `已複製第 ${pages[0] + 1} 頁（${px(pages[0])}），可以直接貼上` : r.reason, r.ok ? null : 'err');
      } else if (pages.length === 1) {
        const blob = await X().exportPage(d, pages[0], fmt, env, opts);
        download(blob, `${spec.name}.${fmt}`);
        say(`已下載第 ${pages[0] + 1} 頁（${FMT}，${px(pages[0])}，${spec.dpi} DPI）`);
      } else if (spec.pack === 'each') {
        // 一張一張下載：字型只等第一張，之後每張不再等；每張之間隔一下，瀏覽器才不會漏掉
        for (let k = 0; k < pages.length; k++) {
          say(`下載中 ${k + 1}／${pages.length}…`, 'stay');
          const blob = await X().exportPage(d, pages[k], fmt, env, Object.assign({ skipFontWait: k > 0 }, opts));
          download(blob, `${spec.name}_${String(pages[k] + 1).padStart(2, '0')}.${fmt}`);
          if (k < pages.length - 1) await new Promise(r => setTimeout(r, EACH_GAP_MS));
        }
        say(`已一張一張下載 ${pages.length} 頁（${FMT}，${spec.dpi} DPI）`);
      } else {
        const blob = await X().exportZip(d, fmt, env, Object.assign({ pages }, opts));
        download(blob, `${spec.name}.zip`);
        say(`已下載 ${pages.length} 頁（ZIP，每頁 ${FMT}，${spec.dpi} DPI）`);
      }
    } catch (e) {
      const m = (e && e.message) || String(e);
      say('匯出失敗：' + m + (/太大/.test(m) ? '' : '（圖片可能來自不同來源，請改用上傳的圖片）'), 'err');
    } finally {
      exporting = false;
      syncChrome();
    }
  }

  // ---- 匯出彈窗 -----------------------------------------------------------------------
  // 設定一改就記在這台瀏覽器（格式、品質、範圍、頁碼、倍率、DPI）；檔名每次開啟都重給一個時間戳
  const EXP_KEY = 'qpt.design.export';
  const EXP_DEFAULT = { fmt: 'png', quality: 95, range: 'cur', pages: '', scale: 1, dpi: 300, pack: 'each' };
  const EACH_GAP_MS = 600;   // 一張一張下載時每張間隔：連續觸發太快，瀏覽器可能只收到最後幾張
  let exp = null, expReturnFocus = null;
  function loadExp() {
    let v = {};
    try { v = JSON.parse(localStorage.getItem(EXP_KEY) || '{}') || {}; } catch (e) { /* 私密視窗等讀不到就用預設 */ }
    const o = Object.assign({}, EXP_DEFAULT, v);
    if (!['png', 'jpg'].includes(o.fmt)) o.fmt = 'png';
    if (!['cur', 'all', 'custom'].includes(o.range)) o.range = 'cur';
    if (!['each', 'zip'].includes(o.pack)) o.pack = 'each';
    if (![0.5, 1, 2, 3].includes(+o.scale)) o.scale = 1;
    if (![72, 150, 300].includes(+o.dpi)) o.dpi = 300;
    o.scale = +o.scale; o.dpi = +o.dpi;
    o.quality = clamp(Math.round(+o.quality) || 95, 60, 100);
    return o;
  }
  function saveExp() {
    const { fmt, quality, range, pages, scale, dpi, pack } = exp;
    try { localStorage.setItem(EXP_KEY, JSON.stringify({ fmt, quality, range, pages, scale, dpi, pack })); } catch (e) { /* 存不了不影響匯出 */ }
  }
  const expOpen = () => !$('dzExportDlg').hidden;
  function expPages() {
    const n = state.doc.pages.length;
    if (exp.range === 'cur') return { ok: true, pages: [pageIndex()] };
    if (exp.range === 'all') return { ok: true, pages: state.doc.pages.map((_, i) => i) };
    return X().parsePages(exp.pages, n);
  }
  const expName = () => (exp.name || '').replace(/[\\/:*?"<>|\u0000-\u001f]/g, '').trim().replace(/\.(png|jpe?g|zip)$/i, '') || `design-${stamp()}`;
  function syncExportDlg() {
    for (const [id, v] of [['dzExpFmt', exp.fmt], ['dzExpRange', exp.range], ['dzExpScale', exp.scale], ['dzExpDpi', exp.dpi], ['dzExpPack', exp.pack]]) {
      for (const b of $(id).querySelectorAll('button')) { const on = b.dataset.v === String(v); b.classList.toggle('active', on); b.setAttribute('aria-pressed', String(on)); }
    }
    $('dzExpFmtNote').textContent = exp.fmt === 'png' ? 'PNG：畫質無損、保留透明背景。' : 'JPG：檔案比較小，透明的地方會墊白色。';
    $('dzExpQualityRow').hidden = exp.fmt !== 'jpg';
    $('dzExpQuality').value = exp.quality;
    $('dzExpQualityOut').textContent = exp.quality + '%';
    $('dzExpPagesRow').hidden = exp.range !== 'custom';
    const r = expPages();
    let err = r.ok ? '' : r.reason, sizeText = '';
    if (r.ok) {
      const ps = r.pages.map(i => state.doc.pages[i]);
      const dims = ps.map(p => [Math.round(p.w * exp.scale), Math.round(p.h * exp.scale)]);
      const same = dims.every(d => d[0] === dims[0][0] && d[1] === dims[0][1]);
      sizeText = same ? `輸出 ${dims[0][0]} × ${dims[0][1]} px` : `依各頁尺寸 × ${exp.scale}（例：第 ${r.pages[0] + 1} 頁 ${dims[0][0]} × ${dims[0][1]} px）`;
      const big = dims.find(d => Math.max(d[0], d[1]) > X().MAX_OUTPUT_SIDE);
      if (big) err = `${big[0]} × ${big[1]} px 太大了，長邊不能超過 ${X().MAX_OUTPUT_SIDE}px，請改用較小的尺寸倍率`;
    }
    $('dzExpSize').textContent = sizeText;
    const many = r.ok && r.pages.length > 1, each = many && exp.pack === 'each', FMT = exp.fmt.toUpperCase();
    $('dzExpPackRow').hidden = !many;
    $('dzExpPackNote').textContent = each ? '每頁各存成一個檔案，檔名結尾是頁碼（例：_01）。第一次可能會跳出「允許下載多個檔案」，請按允許。' : '';
    $('dzExpExt').textContent = !many ? '.' + exp.fmt : each ? `_01.${exp.fmt}…` : '.zip';
    $('dzExpSummary').textContent = !r.ok ? '' : each
      ? `將一張一張下載 ${r.pages.length} 頁（每頁一個 ${FMT} 檔）`
      : many ? `將下載 ${r.pages.length} 頁，打包成一個 ZIP（每頁一張 ${FMT}）`
      : `將下載第 ${r.pages[0] + 1} 頁（${FMT}）`;
    $('dzExpErr').textContent = err;
    $('dzExpGo').disabled = !!err || exporting;
    $('dzExpGo').textContent = each ? `下載 ${r.pages.length} 張` : many ? '下載 ZIP' : '下載';
    // 剪貼簿只能放一張 PNG：範圍只有一頁時才能複製
    $('dzExpCopy').disabled = !!err || many || exporting;
  }
  function openExportDlg() {
    if (exporting || expOpen()) return;
    endField();
    if (editing) commitTextEdit();
    exp = loadExp();
    exp.name = `design-${stamp()}`;
    $('dzExpPages').value = exp.pages;
    $('dzExpName').value = exp.name;
    expReturnFocus = document.activeElement;
    $('dzExportDlg').hidden = false;
    syncExportDlg();
    $('dzExpGo').focus();
  }
  function closeExportDlg() {
    if (!expOpen()) return;
    $('dzExportDlg').hidden = true;
    const f = expReturnFocus && document.contains(expReturnFocus) ? expReturnFocus : $('dzExportBtn');
    if (f && f.focus) f.focus();
  }
  function submitExport(kind) {
    syncExportDlg();
    if (kind === 'copy' ? $('dzExpCopy').disabled : $('dzExpGo').disabled) return;
    const r = expPages();
    const spec = { kind, fmt: kind === 'copy' ? 'png' : exp.fmt, pages: r.pages, scale: exp.scale, quality: exp.quality / 100, dpi: exp.dpi, name: expName(), pack: exp.pack };
    saveExp();
    closeExportDlg();
    runExport(spec);
  }
  function wireExportDlg() {
    const dlg = $('dzExportDlg');
    const onToggle = (id, key, num) => $(id).addEventListener('click', e => {
      const b = e.target.closest('button');
      if (!b) return;
      exp[key] = num ? Number(b.dataset.v) : b.dataset.v;
      saveExp();
      syncExportDlg();
      if (key === 'range' && exp.range === 'custom') $('dzExpPages').focus();
    });
    onToggle('dzExpFmt', 'fmt');
    onToggle('dzExpRange', 'range');
    onToggle('dzExpScale', 'scale', true);
    onToggle('dzExpDpi', 'dpi', true);
    onToggle('dzExpPack', 'pack');
    $('dzExpQuality').addEventListener('input', e => { exp.quality = Number(e.target.value); saveExp(); syncExportDlg(); });
    $('dzExpPages').addEventListener('input', e => { exp.pages = e.target.value; saveExp(); syncExportDlg(); });
    $('dzExpName').addEventListener('input', e => { exp.name = e.target.value; });
    $('dzExpGo').addEventListener('click', () => submitExport('download'));
    $('dzExpCopy').addEventListener('click', () => submitExport('copy'));
    $('dzExpCancel').addEventListener('click', closeExportDlg);
    $('dzExpClose').addEventListener('click', closeExportDlg);
    dlg.addEventListener('mousedown', e => { if (e.target === dlg) closeExportDlg(); });   // 點背景關閉
    dlg.addEventListener('keydown', e => {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeExportDlg(); return; }
      if (e.key === 'Enter' && e.target.tagName === 'INPUT' && e.target.type === 'text') { e.preventDefault(); submitExport('download'); return; }
      if (e.key === 'Tab') {   // 焦點留在彈窗裡
        const f = [...dlg.querySelectorAll('button, input')].filter(x => !x.disabled && x.offsetParent !== null);
        if (!f.length) return;
        const first = f[0], last = f[f.length - 1];
        if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
        else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
      }
    });
  }
  async function saveProject() {
    if (exporting) return;
    endField();
    if (editing) commitTextEdit();
    exporting = true;
    syncChrome();
    say('存檔中…', 'stay');
    try {
      const snap = core().deserialize(core().serialize(state.doc));   // 深拷貝，編輯不影響存檔中的文件
      const json = await X().serializeProject(snap, assets.blobs);
      download(new Blob([json], { type: 'application/json' }), `design-${stamp()}.json`);
      say('已存成專案檔（.json），之後可以用「開啟專案檔」繼續編輯');
    } catch (e) {
      if (window.console) console.error('[design] 存專案檔失敗', e);
      say('存檔失敗：無法處理其中的圖片，請換掉有問題的圖片後再試一次', 'err');
    } finally {
      exporting = false;
      syncChrome();
    }
  }
  // 匯入的資產 id 如果和目前的撞到，就改成新的 id（避免復原到匯入前時，舊物件拿到新的圖片）
  function remapAssets(nd) {
    const taken = new Set(Object.keys(state.doc.assets).concat(Object.keys(assets.blobs)));
    const map = {};
    let n = 0;
    for (const id of Object.keys(nd.assets)) {
      if (!taken.has(id)) { taken.add(id); continue; }
      let nid;
      do { nid = 'a' + (++n); } while (taken.has(nid) || Object.prototype.hasOwnProperty.call(nd.assets, nid));
      taken.add(nid);
      map[id] = nid;
    }
    if (!Object.keys(map).length) return map;
    const assetsOut = {};
    for (const [id, a] of Object.entries(nd.assets)) assetsOut[map[id] || id] = a;
    nd.assets = assetsOut;
    for (const p of nd.pages) {
      if (p.bg && p.bg.type === 'image' && map[p.bg.asset]) p.bg.asset = map[p.bg.asset];
      for (const o of p.objects) if (o.type === 'image' && map[o.asset]) o.asset = map[o.asset];
    }
    return map;
  }
  async function openProject(file) {
    if (!file) return;
    endField();
    if (editing) commitTextEdit();
    say('讀取專案檔中…', 'stay');
    const r = await X().parseProject(file, { migrate: core().migrate });
    if (!r.ok) { say(r.reason, 'err'); return; }
    const hasContent = state.doc.pages.some(p => p.objects.length);
    if (hasContent && !window.confirm('匯入會取代目前的設計（可以復原），要繼續嗎？')) { say(''); return; }
    const nd = r.doc;
    const map = remapAssets(nd);
    // 目前的資產也留著（資產只增不減），之後新增的資產 id 才不會和復原回來的舊物件撞到
    for (const [id, a] of Object.entries(state.doc.assets)) if (!(id in nd.assets)) nd.assets[id] = a;
    const why = core().validate(nd);
    if (why) { say(why, 'err'); return; }
    const res = act('匯入專案', d => {
      for (const k of Object.keys(d)) delete d[k];
      Object.assign(d, copy(nd));
      return { ok: true };
    });
    if (!res.ok) return;
    for (const [oldId, blob] of Object.entries(r.blobs)) {
      const id = map[oldId] || oldId;
      const prev = assets.urls[id];
      if (prev) URL.revokeObjectURL(prev);
      delete assets.imgs[id]; delete assets.wait[id];
      registerAsset(id, blob, URL.createObjectURL(blob), null);
      loadAsset(id);
    }
    state.pageId = state.doc.pages[0].id;
    state.selection = [];
    bgMode = null;
    fonts().ready(state.doc);   // 不等：用到的字型才開始下載，載好會自動重畫
    fitView();
    refresh();
    say(`已匯入專案（${state.doc.pages.length} 頁）；按復原可以回到匯入前`);
  }

  // =====================================================================================
  // 接線
  // =====================================================================================
  function wire() {
    const stage = stageEl();
    $('dzTools').addEventListener('click', e => {
      const b = e.target.closest('[data-add]');
      if (!b) return;
      addObject(b.dataset.add);
    });
    $('dzImgFile').addEventListener('change', async e => {
      const files = [...e.target.files];
      e.target.value = '';
      for (const f of files) await addImageFile(f);
    });
    $('dzUndoBtn').addEventListener('click', undo);
    $('dzRedoBtn').addEventListener('click', redo);
    $('dzZoomMinus').addEventListener('click', () => zoomCenter(1 / 1.25));
    $('dzZoomPlus').addEventListener('click', () => zoomCenter(1.25));
    $('dzFitBtn').addEventListener('click', () => fitView());
    $('dzPageAdd').addEventListener('click', addPage);
    $('dzPageDup').addEventListener('click', dupPage);
    $('dzPageDel').addEventListener('click', delPage);
    $('dzExportBtn').addEventListener('click', openExportDlg);
    wireExportDlg();
    $('dzSaveBtn').addEventListener('click', saveProject);
    $('dzOpenBtn').addEventListener('click', () => $('dzOpenFile').click());
    $('dzOpenFile').addEventListener('change', e => { const f = e.target.files[0]; e.target.value = ''; openProject(f); });
    wirePages();

    stage.addEventListener('pointerdown', onPointerDown);
    window.addEventListener('pointermove', onPointerMove);
    window.addEventListener('pointerup', onPointerUp);
    window.addEventListener('pointercancel', onPointerUp);
    stage.addEventListener('pointerenter', () => { overStage = true; });
    stage.addEventListener('pointerleave', () => { overStage = false; });
    stage.addEventListener('wheel', onWheel, { passive: false });
    stage.addEventListener('dblclick', e => {
      if (editing) return;
      const pt = toPage(e.clientX, e.clientY);
      const id = core().hitTest(page(), pt.x, pt.y);
      const o = id && objOf(id);
      if (o && o.type === 'text') startTextEdit(id);
    });
    stage.addEventListener('contextmenu', e => { if (drag) e.preventDefault(); });
    // 把圖片拖進畫布
    stage.addEventListener('dragover', e => { if (e.dataTransfer && [...e.dataTransfer.types].includes('Files')) { e.preventDefault(); stage.classList.add('drag'); } });
    stage.addEventListener('dragleave', () => stage.classList.remove('drag'));
    stage.addEventListener('drop', async e => {
      stage.classList.remove('drag');
      const files = e.dataTransfer ? [...e.dataTransfer.files].filter(f => /^image\//.test(f.type)) : [];
      if (!files.length) return;
      e.preventDefault();
      for (const f of files) await addImageFile(f);
    });
    document.addEventListener('keydown', onKeyDown);
    document.addEventListener('keyup', onKeyUp);
    window.addEventListener('blur', () => { spaceDown = false; stage.classList.remove('dz-panning'); });
    window.addEventListener('paste', onPaste, true);    // 捕捉階段：比 app.js 的 paste 先處理
    document.addEventListener('copy', onCopy);
    document.addEventListener('qpt:func', e => {
      if (e.detail !== 'design') { if (editing) commitTextEdit(); endField(); cancelDrag(); return; }
      onShow();
    });
    if (typeof ResizeObserver === 'function') new ResizeObserver(() => { if (!app.hidden) { if (autoFit) fitView(); else scheduleRender(); } }).observe(stage);
    else window.addEventListener('resize', () => { if (!app.hidden && autoFit) fitView(); });
    fonts().onFontLoad(() => scheduleRender());
  }

  function onShow() {
    loadStickers();
    if (!shown) { shown = fitView(); }
    refresh();
  }

  // ---- 啟動 ----
  initDoc();
  build();
  wire();
  refresh();
  fonts().load('WHZ-Heavy');
  if (!app.hidden) onShow();

  Q.ui = {
    state,
    getDoc: () => state.doc,
    select,
    rerender: scheduleRender,
  };
})();

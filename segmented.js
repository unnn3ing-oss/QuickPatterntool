// 切換開關的滑動動畫與「滑動切換」手勢。網頁版與 Chrome 側邊欄共用（樣式在 segmented.css）。
//
// 對象：.func-switch（圖片套版／浮水印）、.mode-switch（單張／批次）、.bg-toggle（新聞／娛樂、圖片背景／純色背景…）。
// 這些開關原本都是「按鈕上掛 .active」，各自的程式不用改：這裡只負責
//   1. 放一個白色圓塊在目前選到的按鈕底下，.active 換人時讓圓塊滑過去；
//   2. 可以拖著（或手指滑過）開關來切換，放開時停在最近的一格；
//   3. 左右方向鍵切換。
//
// 效能：
//   - 動畫只動 transform（GPU 合成），不逐格量測、不逐格改版面；
//   - 量測與寫入分開、集中在 requestAnimationFrame 一次做完（先讀完所有開關的位置再寫），不會互相逼出重排；
//   - 拖曳時用 rAF 合併 pointermove，每一格畫面最多寫一次；
//   - 一個開關只有一個 MutationObserver（只看它的按鈕的 class）和共用的一個 ResizeObserver；
//   - 開關被移除（批次的區塊重建）時會解除觀察，不會越積越多。
(function () {
  'use strict';
  const SEL = '.func-switch, .mode-switch, .bg-toggle';
  const states = new WeakMap();                       // 開關 → { thumb, placed, drag, ... }
  const reduceMotion = window.matchMedia ? matchMedia('(prefers-reduced-motion: reduce)') : { matches: false };

  const segs = c => Array.from(c.children).filter(e => e.tagName === 'BUTTON');
  const activeOf = c => segs(c).find(b => b.classList.contains('active'));

  // ---- 量測（只讀）／套用（只寫）----------------------------------------------------
  function measure(c) {
    const a = activeOf(c);
    if (!a || !c.offsetWidth) return null;            // 沒有選到的、或開關現在看不到（display:none）
    return { x: a.offsetLeft, y: a.offsetTop, w: a.offsetWidth, h: a.offsetHeight };
  }

  function apply(c, m, animate) {
    const st = states.get(c);
    if (!st) return;
    const thumb = st.thumb;
    if (!m) { c.classList.remove('seg-ready'); st.placed = false; return; }      // 看不到：退回原本的樣式，等看得到再放
    const willAnimate = animate && st.placed && !reduceMotion.matches && !st.drag;
    if (!willAnimate) thumb.classList.add('seg-notrans');                         // 第一次放、改尺寸、減少動態：直接到位不要滑
    thumb.style.width = m.w + 'px';
    thumb.style.height = m.h + 'px';
    thumb.style.transform = `translate3d(${m.x}px, ${m.y}px, 0)`;
    st.x = m.x; st.w = m.w;
    if (!st.placed) { c.classList.add('seg-ready'); st.placed = true; }
    if (willAnimate) {
      thumb.classList.add('is-moving');                                           // will-change 只在移動時掛
      clearTimeout(st.timer);
      st.timer = setTimeout(() => thumb.classList.remove('is-moving'), 460);
    } else {
      requestAnimationFrame(() => thumb.classList.remove('seg-notrans'));
    }
  }

  // ---- 排程：同一個 frame 內先讀後寫 -------------------------------------------------
  const dirty = new Map();                            // 開關 → 這次要不要動畫
  let raf = 0;
  function schedule(c, animate) {
    dirty.set(c, (dirty.get(c) || false) || animate);
    if (!raf) raf = requestAnimationFrame(flush);
  }
  function flush() {
    raf = 0;
    const jobs = Array.from(dirty, ([c, anim]) => ({ c, anim, m: measure(c) }));   // 讀
    dirty.clear();
    for (const j of jobs) apply(j.c, j.m, j.anim);                                  // 寫
  }

  // 大小變了（視窗縮放、字級變了、從隱藏變成顯示）→ 直接重放位置，不做動畫。
  // 在 ResizeObserver 裡當場處理，這樣從隱藏變成顯示的那一幀就已經放好，不會閃。
  const ro = typeof ResizeObserver === 'function' ? new ResizeObserver(entries => {
    const jobs = entries.map(en => ({ c: en.target, m: measure(en.target) }));
    for (const j of jobs) apply(j.c, j.m, false);
  }) : null;

  // ---- 拖曳／滑動 ------------------------------------------------------------------
  function bindDrag(c, st) {
    let pending = 0;
    const writeDrag = () => {
      pending = 0;
      if (st.drag && st.drag.active) st.thumb.style.transform = `translate3d(${st.drag.tx}px, ${st.thumb._y || 0}px, 0)`;
    };
    c.addEventListener('pointerdown', e => {
      if (e.pointerType === 'mouse' && e.button !== 0) return;
      const m = measure(c);
      if (!m) return;
      const bs = segs(c);
      st.thumb._y = m.y;
      st.drag = {
        id: e.pointerId, x0: e.clientX, tx0: m.x, tx: m.x, active: false,
        lo: Math.min(...bs.map(b => b.offsetLeft)), hi: Math.max(...bs.map(b => b.offsetLeft + b.offsetWidth)) - m.w,
        centers: bs.map(b => b.offsetLeft + b.offsetWidth / 2), bs,
      };
    });
    c.addEventListener('pointermove', e => {
      const d = st.drag;
      if (!d || e.pointerId !== d.id) return;
      const dx = e.clientX - d.x0;
      if (!d.active) {
        if (Math.abs(dx) < 6) return;                   // 小於 6px 算點擊，不是滑動
        d.active = true;
        try { c.setPointerCapture(d.id); } catch (err) { /* 這個指標不能被捕捉就算了 */ }
        c.classList.add('seg-dragging');
        st.thumb.classList.add('is-moving');
        clearTimeout(st.timer);
      }
      d.tx = Math.min(d.hi, Math.max(d.lo, d.tx0 + dx));
      if (!pending) pending = requestAnimationFrame(writeDrag);
    });
    const end = e => {
      const d = st.drag;
      if (!d || e.pointerId !== d.id) return;
      st.drag = null;
      if (pending) { cancelAnimationFrame(pending); pending = 0; }
      if (!d.active) return;                             // 單純點擊：交給瀏覽器原本的 click
      c.classList.remove('seg-dragging');
      if (c.hasPointerCapture && c.hasPointerCapture(d.id)) c.releasePointerCapture(d.id);
      if (e.type !== 'pointercancel') {
        const center = d.tx + (st.w || 0) / 2;
        let best = 0, bd = Infinity;
        d.centers.forEach((cx, i) => { const dist = Math.abs(cx - center); if (dist < bd) { bd = dist; best = i; } });
        const target = d.bs[best];
        if (target && !target.classList.contains('active')) target.click();   // 交給原本的點擊處理（它會換 .active）
      }
      st.suppressUntil = performance.now() + 60;         // 放開後瀏覽器可能補一個 click，擋掉，免得重複切換（要放在上面自己的 click 之後）
      schedule(c, true);                                  // 不管有沒有換，都讓圓塊滑到「實際選到的」那一格
    };
    c.addEventListener('pointerup', end);
    c.addEventListener('pointercancel', end);
    c.addEventListener('click', e => {
      if (st.suppressUntil && performance.now() < st.suppressUntil) { e.stopPropagation(); e.preventDefault(); st.suppressUntil = 0; }
    }, true);
  }

  // ---- 鍵盤：左右方向鍵 --------------------------------------------------------------
  function bindKeys(c) {
    c.addEventListener('keydown', e => {
      if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
      const bs = segs(c), i = bs.indexOf(e.target);
      if (i < 0) return;
      const n = e.key === 'ArrowRight' ? i + 1 : i - 1;
      if (n < 0 || n >= bs.length) return;
      e.preventDefault();
      bs[n].click();
      bs[n].focus();
    });
  }

  // ---- 掛上去／拿掉 -----------------------------------------------------------------
  function enhance(c) {
    if (states.has(c)) return;
    const thumb = document.createElement('span');
    thumb.className = 'seg-thumb';
    thumb.setAttribute('aria-hidden', 'true');
    c.insertBefore(thumb, c.firstChild);
    const st = { thumb, placed: false, drag: null, timer: 0, x: 0, w: 0, suppressUntil: 0, mo: null };
    states.set(c, st);
    // 只看這個開關「按鈕」的 class 變化（不看圓塊自己，免得自己改 class 又觸發自己）
    st.mo = new MutationObserver(() => schedule(c, true));
    segs(c).forEach(b => st.mo.observe(b, { attributes: true, attributeFilter: ['class'] }));
    bindDrag(c, st);
    bindKeys(c);
    if (ro) ro.observe(c);
    schedule(c, false);
  }
  function release(c) {
    const st = states.get(c);
    if (!st) return;
    st.mo.disconnect();
    if (ro) ro.unobserve(c);
    clearTimeout(st.timer);
    states.delete(c);
    dirty.delete(c);
  }
  const each = (node, fn) => {
    if (node.nodeType !== 1) return;
    if (node.matches(SEL)) fn(node);
    if (node.firstElementChild) node.querySelectorAll(SEL).forEach(fn);
  };

  document.querySelectorAll(SEL).forEach(enhance);
  // 之後動態產生的開關（批次模式每一組的「圖片背景／純色背景」「新聞／娛樂」）也要處理
  new MutationObserver(records => {
    for (const r of records) {
      r.addedNodes.forEach(n => each(n, enhance));
      r.removedNodes.forEach(n => each(n, c => { if (!c.isConnected) release(c); }));
    }
  }).observe(document.documentElement, { childList: true, subtree: true });

  window.Segmented = { enhance, SEL };               // 測試與除錯用
})();

// =====================================================================================
// 設計：渲染（網頁版專用，外掛不需要；updater.js／deploy.js 的 SKIP 會略過 design-*）
//
// render(ctx, page, opts)：把一頁畫到 Canvas，預覽與匯出共用同一個函式（所見即所得）。
// 不碰 DOM（離屏畫布只在需要時才建立）；選取框、把手、吸附線等 DOM 疊層不會輸出。
// 瀏覽器掛在 QPTDesign.render，node 用 module.exports（test/design-render.test.js）。
// =====================================================================================
(function (root) {
  'use strict';

  const MOSAIC_MIN = 14, MOSAIC_DIV = 5, GRAY = '#808080';

  const num = (v, d) => (typeof v === 'number' && isFinite(v) ? v : d);
  const imgSize = im => ({
    w: im.naturalWidth || im.videoWidth || im.width || 0,
    h: im.naturalHeight || im.videoHeight || im.height || 0,
  });
  function makeCanvas(opts, w, h) {
    const c = opts && opts.createCanvas ? opts.createCanvas(w, h)
      : root.document.createElement('canvas');
    c.width = Math.max(1, Math.ceil(w)); c.height = Math.max(1, Math.ceil(h));
    return c;
  }

  // ---- 文字排版 -----------------------------------------------------------------
  const layoutCache = new Map();
  function fontStr(fonts, obj) {
    const size = num(obj.size, 80);
    return fonts && fonts.fontCss ? fonts.fontCss(obj.font, size) : `${size}px sans-serif`;
  }
  // 逐字量測（全形英數混排都適用）；累計超過 obj.w 就換行，'\n' 強制換行。
  function layoutText(ctx, obj, fonts) {
    const size = num(obj.size, 80), ls = num(obj.letterSpacing, 0), lh = num(obj.lineHeight, 1.25);
    const gen = fonts && fonts.gen ? fonts.gen() : 0;
    const text = String(obj.text == null ? '' : obj.text);
    const key = [text, obj.font, size, obj.w, ls, lh, gen].join('|');
    const hit = layoutCache.get(key);
    if (hit) return hit;
    ctx.font = fontStr(fonts, obj);
    const lines = [];
    for (const para of text.split('\n')) {
      let cur = '', acc = 0;
      for (const ch of para) {
        const cw = ctx.measureText(ch).width + ls;
        if (cur && acc + cw > obj.w) { lines.push(cur); cur = ''; acc = 0; }
        cur += ch; acc += cw;
      }
      lines.push(cur);
    }
    const lineH = size * lh;
    const out = { lines, lineH, height: lines.length * lineH };
    if (layoutCache.size > 500) layoutCache.clear();
    layoutCache.set(key, out);
    return out;
  }
  let measureCtx = null;
  // UI 用來更新文字物件的 h。沒有 DOM 時（node）用字寬＝字級的粗估。
  function textHeight(obj, fonts, ctx) {
    if (!ctx) {
      if (!measureCtx && root.document) measureCtx = root.document.createElement('canvas').getContext('2d');
      ctx = measureCtx;
    }
    if (!ctx) ctx = { font: '', measureText: () => ({ width: num(obj.size, 80) }) };
    return layoutText(ctx, obj, fonts).height;
  }

  // ---- 幾何小工具 -----------------------------------------------------------------
  // 影像擺放（image 物件與圖片背景共用，和 resize.js 的 fx/fy 同一種記法）
  function place(iw, ih, w, h, fit, view) {
    const sc = view && view.scale != null ? view.scale : 1;
    const ox = view && view.ox != null ? view.ox : 0.5, oy = view && view.oy != null ? view.oy : 0.5;
    const k = (fit === 'contain' ? Math.min(w / iw, h / ih) : Math.max(w / iw, h / ih)) * sc;
    const dw = iw * k, dh = ih * k;
    return { dx: (w - dw) * ox, dy: (h - dh) * oy, dw, dh };
  }
  function roundRectPath(c, x, y, w, h, r) {
    r = Math.max(0, Math.min(num(r, 0), w / 2, h / 2));
    c.beginPath();
    if (!r) { c.rect(x, y, w, h); return; }
    c.moveTo(x + r, y);
    c.arcTo(x + w, y, x + w, y + h, r);
    c.arcTo(x + w, y + h, x, y + h, r);
    c.arcTo(x, y + h, x, y, r);
    c.arcTo(x, y, x + w, y, r);
    c.closePath();
  }
  function placeholder(c, w, h) {
    c.save();
    c.fillStyle = '#d9d9d9'; c.fillRect(0, 0, w, h);
    c.beginPath(); c.rect(0, 0, w, h); c.clip();
    c.strokeStyle = '#a8a8a8'; c.lineWidth = 2;
    c.beginPath();
    for (let i = -h; i < w; i += 16) { c.moveTo(i, h); c.lineTo(i + h, 0); }
    c.stroke();
    c.restore();
  }

  // ---- 背景 -----------------------------------------------------------------------
  function drawBg(ctx, page, opts) {
    const bg = page.bg || { type: 'solid', color: '#ffffff' };
    const W = page.w, H = page.h;
    if (bg.type === 'gradient') {
      // CSS 角度：0°＝由下往上、90°＝由左往右；漸層線長＝|w·sinθ|+|h·cosθ|
      const t = num(bg.angle, 180) * Math.PI / 180;
      const sx = Math.sin(t), cy = -Math.cos(t);
      const L = Math.abs(W * Math.sin(t)) + Math.abs(H * Math.cos(t));
      const cx = W / 2, cyy = H / 2;
      const g = ctx.createLinearGradient(cx - sx * L / 2, cyy - cy * L / 2, cx + sx * L / 2, cyy + cy * L / 2);
      g.addColorStop(0, bg.from || '#ffffff'); g.addColorStop(1, bg.to || '#000000');
      ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
      return false;
    }
    if (bg.type === 'image') {
      ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, W, H);
      const im = opts.images && opts.images[bg.asset];
      const s = im && imgSize(im);
      if (!s || !s.w) { placeholder(ctx, W, H); return true; }
      ctx.save();
      ctx.beginPath(); ctx.rect(0, 0, W, H); ctx.clip();
      ctx.imageSmoothingQuality = 'high';
      const p = place(s.w, s.h, W, H, bg.fit, bg.view);
      ctx.drawImage(im, p.dx, p.dy, p.dw, p.dh);
      ctx.restore();
      return false;
    }
    ctx.fillStyle = bg.color || '#ffffff'; ctx.fillRect(0, 0, W, H);
    return false;
  }

  // ---- 物件 -----------------------------------------------------------------------
  function drawImageObj(ctx, o, opts, scale) {
    const im = opts.images && opts.images[o.asset];
    const s = im && imgSize(im);
    if (!s || !s.w) { placeholder(ctx, o.w, o.h); return true; }
    const pw = Math.max(1, Math.ceil(o.w * scale)), ph = Math.max(1, Math.ceil(o.h * scale));
    const a = makeCanvas(opts, pw, ph), ac = a.getContext('2d');
    ac.scale(pw / o.w, ph / o.h);
    // 圓角裁切 → 擺放影像
    ac.save();
    roundRectPath(ac, 0, 0, o.w, o.h, o.radius);
    ac.clip();
    ac.imageSmoothingQuality = 'high';
    const p = place(s.w, s.h, o.w, o.h, o.fit, o.view);
    ac.drawImage(im, p.dx, p.dy, p.dw, p.dh);
    ac.restore();
    let out = a;
    if (o.gray) {
      // 抽色：只作用在這張圖自己的離屏畫布；用 destination-in 把透明處（圓角、留白）還原，不會被染黑
      const b = makeCanvas(opts, pw, ph), bc = b.getContext('2d');
      bc.drawImage(a, 0, 0);
      bc.globalCompositeOperation = 'saturation';
      bc.fillStyle = '#000'; bc.fillRect(0, 0, pw, ph);
      bc.globalCompositeOperation = 'destination-in';
      bc.drawImage(a, 0, 0);
      out = b;
    }
    ctx.drawImage(out, 0, 0, o.w, o.h);
    return false;
  }

  function drawText(ctx, o, opts, scale) {
    const fonts = opts.fonts;
    const lay = layoutText(ctx, o, fonts);
    const ls = num(o.letterSpacing, 0);
    const st = o.stroke && o.stroke.w > 0 ? o.stroke : null;
    const sh = o.shadow && (o.shadow.blur > 0 || o.shadow.x || o.shadow.y) ? o.shadow : null;
    ctx.font = fontStr(fonts, o);
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'left';
    ctx.lineJoin = 'round';
    const align = o.align === 'left' || o.align === 'right' ? o.align : 'center';

    const pass = (stroke) => {
      lay.lines.forEach((line, i) => {
        const y = i * lay.lineH + lay.lineH / 2;
        if (!ls) {
          const x = align === 'left' ? 0 : align === 'right' ? o.w : o.w / 2;
          ctx.textAlign = align;
          if (stroke) ctx.strokeText(line, x, y); else ctx.fillText(line, x, y);
          return;
        }
        // 字距：逐字 fillText，對齊以行寬（不含最後一個字距）為準
        ctx.textAlign = 'left';
        const chars = [...line];
        const ws = chars.map(ch => ctx.measureText(ch).width);
        const lw = ws.reduce((a, b) => a + b, 0) + ls * Math.max(0, chars.length - 1);
        let x = align === 'left' ? 0 : align === 'right' ? o.w - lw : (o.w - lw) / 2;
        chars.forEach((ch, k) => {
          if (stroke) ctx.strokeText(ch, x, y); else ctx.fillText(ch, x, y);
          x += ws[k] + ls;
        });
      });
    };
    const setShadow = on => {
      ctx.shadowColor = on ? sh.color || 'rgba(0,0,0,0.5)' : 'rgba(0,0,0,0)';
      // 陰影的位移與模糊不受 transform 影響，要自己乘上 scale
      ctx.shadowOffsetX = on ? num(sh.x, 0) * scale : 0;
      ctx.shadowOffsetY = on ? num(sh.y, 0) * scale : 0;
      ctx.shadowBlur = on ? num(sh.blur, 0) * scale : 0;
    };
    if (st) {
      ctx.lineWidth = st.w * 2; ctx.strokeStyle = st.color || '#000000';
      setShadow(!!sh);                      // 陰影只加在第一次繪製
      pass(true);
      setShadow(false);
    } else setShadow(!!sh);
    ctx.fillStyle = o.color || '#111111';
    pass(false);
    setShadow(false);
  }

  function drawShape(ctx, o) {
    const w = o.w, h = o.h, sw = o.stroke && o.stroke.w > 0 ? o.stroke.w : 0;
    const hasFill = o.fill && o.fill !== 'none' && o.fill !== 'transparent';
    if (o.kind === 'line' || o.kind === 'arrow') {
      const lw = sw || 2, color = sw ? (o.stroke.color || '#000000') : (o.fill || '#000000');
      ctx.strokeStyle = color; ctx.fillStyle = color; ctx.lineWidth = lw; ctx.lineCap = 'butt';
      const my = h / 2;
      if (o.kind === 'arrow') {
        const hl = Math.min(w, Math.max(16, lw * 4));
        ctx.beginPath(); ctx.moveTo(0, my); ctx.lineTo(Math.max(0, w - hl + 1), my); ctx.stroke();
        ctx.beginPath(); ctx.moveTo(w, my); ctx.lineTo(w - hl, my - hl / 2); ctx.lineTo(w - hl, my + hl / 2); ctx.closePath(); ctx.fill();
      } else { ctx.beginPath(); ctx.moveTo(0, my); ctx.lineTo(w, my); ctx.stroke(); }
      return;
    }
    if (o.kind === 'ellipse') { ctx.beginPath(); ctx.ellipse(w / 2, h / 2, w / 2, h / 2, 0, 0, Math.PI * 2); }
    else roundRectPath(ctx, 0, 0, w, h, o.radius);
    if (hasFill) { ctx.fillStyle = o.fill; ctx.fill(); }
    if (sw) { ctx.lineWidth = sw; ctx.strokeStyle = o.stroke.color || '#000000'; ctx.lineJoin = 'round'; ctx.stroke(); }
  }

  function drawSticker(ctx, o, opts) {
    const im = opts.stickers && opts.stickers[o.sticker];
    const s = im && imgSize(im);
    if (!s || !s.w) { placeholder(ctx, o.w, o.h); return true; }
    const k = Math.min(o.w / s.w, o.h / s.h);
    const dw = s.w * k, dh = s.h * k;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(im, (o.w - dw) / 2, (o.h - dh) / 2, dw, dh);
    return false;
  }

  // 馬賽克：在畫布像素座標上做（頁面座標 × scale），讀取目前已畫好的像素，每格取真實平均色
  function drawMosaic(ctx, o, page, scale) {
    const CW = Math.ceil(page.w * scale), CH = Math.ceil(page.h * scale);
    const x0 = Math.max(0, Math.floor(o.x * scale)), y0 = Math.max(0, Math.floor(o.y * scale));
    const x1 = Math.min(CW, Math.ceil((o.x + o.w) * scale)), y1 = Math.min(CH, Math.ceil((o.y + o.h) * scale));
    const w = x1 - x0, h = y1 - y0;
    if (w < 1 || h < 1) return;
    const b = Math.max(1, Math.round(Math.max(MOSAIC_MIN, Math.round(Math.min(o.w, o.h) / MOSAIC_DIV)) * scale));
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha = o.opacity == null ? 1 : o.opacity;
    let data;
    try { data = ctx.getImageData(x0, y0, w, h).data; }
    catch (e) { ctx.fillStyle = GRAY; ctx.fillRect(x0, y0, w, h); ctx.restore(); return; }   // 畫布被污染讀不到像素：用灰色蓋住
    for (let by = 0; by < h; by += b) {
      for (let bx = 0; bx < w; bx += b) {
        const bw = Math.min(b, w - bx), bh = Math.min(b, h - by);
        let r = 0, g = 0, bl = 0;
        for (let yy = by; yy < by + bh; yy++) {
          let i = (yy * w + bx) * 4;
          for (let xx = 0; xx < bw; xx++, i += 4) { r += data[i]; g += data[i + 1]; bl += data[i + 2]; }
        }
        const n = bw * bh;
        ctx.fillStyle = `rgb(${Math.round(r / n)},${Math.round(g / n)},${Math.round(bl / n)})`;
        ctx.fillRect(x0 + bx, y0 + by, bw, bh);
      }
    }
    ctx.restore();
  }

  // opts = { scale=1, images, stickers, fonts, skipIds:Set, createCanvas? }
  function render(ctx, page, opts) {
    opts = opts || {};
    const scale = opts.scale || 1;
    let pending = false;
    ctx.save();
    ctx.setTransform(scale, 0, 0, scale, 0, 0);
    if (drawBg(ctx, page, opts)) pending = true;
    for (const o of page.objects || []) {
      if (!o || o.hidden || (opts.skipIds && opts.skipIds.has(o.id))) continue;
      if (o.type === 'mosaic') { drawMosaic(ctx, o, page, scale); continue; }
      ctx.save();
      ctx.globalAlpha = o.opacity == null ? 1 : o.opacity;
      ctx.translate(o.x + o.w / 2, o.y + o.h / 2);
      if (o.rot) ctx.rotate(o.rot * Math.PI / 180);
      ctx.translate(-o.w / 2, -o.h / 2);
      if (o.type === 'image') { if (drawImageObj(ctx, o, opts, scale)) pending = true; }
      else if (o.type === 'text') drawText(ctx, o, opts, scale);
      else if (o.type === 'shape') drawShape(ctx, o);
      else if (o.type === 'sticker') { if (drawSticker(ctx, o, opts)) pending = true; }
      ctx.restore();
    }
    ctx.restore();
    return { pending };
  }

  const api = { render, layoutText, textHeight, place };
  const Q = root.QPTDesign = root.QPTDesign || {};
  Q.render = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);

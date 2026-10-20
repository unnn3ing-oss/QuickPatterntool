// =====================================================================================
// 剪輯：畫面變形、轉場、字幕（網頁版專用，外掛不需要，updater.js／deploy.js 的 SKIP 會略過它）
//
// 匯出 QPTEdit.fx（純數學部分也 module.exports，node 可測）：
//   fitRect／clipMatrix／cropRect／getParam      畫面數學（座標單位：輸出像素、原點在畫面中心、Y 向下、旋轉順時針為正）
//   drawClipVisual／drawSolid／drawTitle         把片段畫到 ctx（preview 與 export 共用，ctx 的基底矩陣用「相乘」，不重設）
//   TRANSITIONS                                  轉場：draw(ctx, drawA, drawB, t, opts, outW, outH)
//   TITLE_PRESETS／makeTitle／wrapText           字幕
//   inspector.sections                           檢查器（變形／裁切／字幕／轉場）
//   ready()                                      等字型載入（Canvas 不會等 @font-face，匯出前請先 await）
// 這支檔案不讀其他 QPTEdit 模組，載入時也不碰 DOM；檢查器樣式在第一次 render 或呼叫 ensureStyle() 時插入。
// =====================================================================================
(function (root) {
  const Q = root.QPTEdit = root.QPTEdit || {};

  const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
  const num = (v, d) => (typeof v === 'number' && isFinite(v)) ? v : d;
  const deepClone = o => JSON.parse(JSON.stringify(o));

  // ---------------------------------------------------------------------------------
  // 預設值
  // ---------------------------------------------------------------------------------
  const DEFAULT_TRANSFORM = { zoomX: 1, zoomY: 1, zoomLinked: true, posX: 0, posY: 0, rotation: 0, anchorX: 0, anchorY: 0, opacity: 1, flipH: false, flipV: false };
  const DEFAULT_CROP = { left: 0, right: 0, top: 0, bottom: 0, softness: 0 };
  const DEFAULT_VIDEO = { transform: DEFAULT_TRANSFORM, crop: DEFAULT_CROP, fit: 'fit', composite: 'normal' };
  const defaultTransform = () => ({ ...DEFAULT_TRANSFORM });
  const defaultCrop = () => ({ ...DEFAULT_CROP });
  const defaultVideo = () => deepClone(DEFAULT_VIDEO);

  // ---------------------------------------------------------------------------------
  // 畫面數學
  // ---------------------------------------------------------------------------------

  // 基準縮放：fit＝完整放進輸出（黑邊）、fill＝蓋滿（裁掉多的）、stretch＝各軸拉到剛好
  // 回傳 { sx, sy, w, h }：sx／sy 是來源像素 → 輸出像素的倍率，w／h 是縮放後的大小
  function fitRect(srcW, srcH, outW, outH, fit) {
    srcW = Math.max(1, srcW); srcH = Math.max(1, srcH);
    let sx, sy;
    if (fit === 'stretch') { sx = outW / srcW; sy = outH / srcH; }
    else if (fit === 'fill') { sx = sy = Math.max(outW / srcW, outH / srcH); }
    else { sx = sy = Math.min(outW / srcW, outH / srcH); }
    return { sx, sy, w: srcW * sx, h: srcH * sy };
  }

  // 讀參數：path 例如 'video.transform.zoomX'。clip.keyframes[path] 有資料就內插，否則讀靜態值。
  // 第一階段內插：linear（數字）／hold（也套用在非數字，例如翻轉）；'bezier' 先當 linear（第二階段再做）。
  function getStatic(clip, path) {
    let o = clip;
    for (const k of path.split('.')) {
      if (o == null) return undefined;
      o = o[k];
    }
    return o;
  }
  function defaultFor(path) {
    const m = /^video\.transform\.(\w+)$/.exec(path);
    if (m) return DEFAULT_TRANSFORM[m[1]];
    const c = /^video\.crop\.(\w+)$/.exec(path);
    if (c) return DEFAULT_CROP[c[1]];
    if (path === 'video.fit') return 'fit';
    return undefined;
  }
  function getParam(clip, path, fInClip) {
    const kfs = clip && clip.keyframes && clip.keyframes[path];
    if (Array.isArray(kfs) && kfs.length) {
      const a = kfs.slice().sort((p, q) => p.f - q.f);
      const f = fInClip || 0;
      if (f <= a[0].f) return a[0].v;
      const last = a[a.length - 1];
      if (f >= last.f) return last.v;
      for (let i = 0; i < a.length - 1; i++) {
        const k0 = a[i], k1 = a[i + 1];
        if (f >= k0.f && f < k1.f) {
          if (k0.interp === 'hold' || typeof k0.v !== 'number' || typeof k1.v !== 'number') return k0.v;
          const u = (f - k0.f) / (k1.f - k0.f);
          return k0.v + (k1.v - k0.v) * u;
        }
      }
      return last.v;
    }
    const v = clip ? getStatic(clip, path) : undefined;
    return v === undefined ? defaultFor(path) : v;
  }

  // 來源像素 → 輸出像素的仿射矩陣 [a,b,c,d,e,f]（canvas 的 transform 參數順序）
  // 順序：fit（基準縮放，來源中心對齊畫面中心）→ 以錨點為軸心：翻轉 → 縮放 → 旋轉 → 位置位移。
  //   錨點 anchorX/Y：縮放／旋轉的軸心，單位是縮放前（fit 後）的輸出像素、相對影像中心；
  //   縮放、旋轉皆為 0/1 時改錨點不會讓影像移動。
  //   zoomLinked 為真時 Y 軸用 zoomX。旋轉單位度、順時針為正。posX/posY 是輸出像素、畫面中心為原點、Y 向下。
  function clipMatrix(clip, srcW, srcH, outW, outH, fInClip) {
    const g = n => getParam(clip, 'video.transform.' + n, fInClip);
    const fit = fitRect(srcW, srcH, outW, outH, getParam(clip, 'video.fit', fInClip));
    const zx = num(g('zoomX'), 1);
    const linked = g('zoomLinked') !== false;
    const zy = linked ? zx : num(g('zoomY'), 1);
    const fh = g('flipH') ? -1 : 1, fv = g('flipV') ? -1 : 1;
    const ax = num(g('anchorX'), 0), ay = num(g('anchorY'), 0);
    const px = num(g('posX'), 0), py = num(g('posY'), 0);
    const rad = num(g('rotation'), 0) * Math.PI / 180;
    const cos = Math.cos(rad), sin = Math.sin(rad);
    // L = R · S · F
    const l00 = cos * zx * fh, l01 = -sin * zy * fv;
    const l10 = sin * zx * fh, l11 = cos * zy * fv;
    // A = L · Fit
    const a00 = l00 * fit.sx, a01 = l01 * fit.sy;
    const a10 = l10 * fit.sx, a11 = l11 * fit.sy;
    // 平移：L · (−Fit · c_src − anchor) + anchor + c_out + pos
    const tx0 = -fit.sx * srcW / 2 - ax, ty0 = -fit.sy * srcH / 2 - ay;
    const e = l00 * tx0 + l01 * ty0 + ax + outW / 2 + px;
    const f = l10 * tx0 + l11 * ty0 + ay + outH / 2 + py;
    return [a00, a10, a01, a11, e, f];
  }
  function applyMatrix(m, x, y) { return [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]]; }

  // 來源裁切矩形（來源像素）。上下左右是 0~1 的比例；至少留 1 像素，左右（上下）加起來不會吃光
  function cropRect(clip, srcW, srcH, fInClip) {
    const g = n => clamp(num(getParam(clip, 'video.crop.' + n, fInClip), 0), 0, 1);
    let l = g('left'), r = g('right'), t = g('top'), b = g('bottom');
    const lim = (a, c, size) => {
      const maxSum = Math.max(0, 1 - 1 / Math.max(1, size));
      if (a + c > maxSum) { const k = maxSum / (a + c); a *= k; c *= k; }
      return [a, c];
    };
    [l, r] = lim(l, r, srcW);
    [t, b] = lim(t, b, srcH);
    return { sx: l * srcW, sy: t * srcH, sw: (1 - l - r) * srcW, sh: (1 - t - b) * srcH };
  }

  // ---------------------------------------------------------------------------------
  // 離屏畫布（共享，不要每格新建）
  // ---------------------------------------------------------------------------------
  let canvasFactory = (w, h) => {
    if (typeof root.OffscreenCanvas !== 'undefined') return new root.OffscreenCanvas(w, h);
    const c = root.document.createElement('canvas'); c.width = w; c.height = h; return c;
  };
  const pool = {};
  function scratch(key, w, h) {
    w = Math.max(1, Math.round(w)); h = Math.max(1, Math.round(h));
    let s = pool[key];
    if (!s || s.canvas.width !== w || s.canvas.height !== h) {
      const canvas = canvasFactory(w, h);
      s = pool[key] = { canvas, ctx: canvas.getContext('2d') };
    }
    const c = s.ctx;
    c.setTransform(1, 0, 0, 1, 0, 0);
    c.globalAlpha = 1; c.globalCompositeOperation = 'source-over'; c.filter = 'none';
    c.clearRect(0, 0, w, h);
    return s;
  }

  // ---------------------------------------------------------------------------------
  // 畫影像／色塊
  // ---------------------------------------------------------------------------------
  // paint(ctx, rect)：在「來源座標」畫出裁切後的內容
  function drawBox(ctx, clip, srcW, srcH, outW, outH, f, paint) {
    const op = clamp(num(getParam(clip, 'video.transform.opacity', f), 1), 0, 1);
    if (op <= 0) return;
    const m = clipMatrix(clip, srcW, srcH, outW, outH, f);
    const r = cropRect(clip, srcW, srcH, f);
    const soft = clamp(num(getParam(clip, 'video.crop.softness', f), 0), 0, 1);
    const cr = n => num(getParam(clip, 'video.crop.' + n, f), 0) > 0.0001;
    const fe = soft * Math.min(r.sw, r.sh) / 2;
    ctx.save();
    ctx.globalAlpha *= op;
    if (!(fe > 0) || !(cr('left') || cr('right') || cr('top') || cr('bottom'))) {
      ctx.imageSmoothingQuality = 'high';
      ctx.transform(m[0], m[1], m[2], m[3], m[4], m[5]);
      paint(ctx, r);
    } else {
      // 柔邊：先畫到離屏，在來源座標下用漸層遮罩把「有裁切的那幾邊」羽化，再貼回去
      const s = scratch('soft', outW, outH), c = s.ctx;
      c.imageSmoothingQuality = 'high';
      c.setTransform(m[0], m[1], m[2], m[3], m[4], m[5]);
      paint(c, r);
      c.globalCompositeOperation = 'destination-in';
      const edge = (on, x0, y0, x1, y1) => {
        if (!on) return;
        const gr = c.createLinearGradient(x0, y0, x1, y1);
        gr.addColorStop(0, 'rgba(0,0,0,0)'); gr.addColorStop(1, 'rgba(0,0,0,1)');
        c.fillStyle = gr; c.fillRect(r.sx, r.sy, r.sw, r.sh);
      };
      edge(cr('left'), r.sx, 0, r.sx + fe, 0);
      edge(cr('right'), r.sx + r.sw, 0, r.sx + r.sw - fe, 0);
      edge(cr('top'), 0, r.sy, 0, r.sy + fe);
      edge(cr('bottom'), 0, r.sy + r.sh, 0, r.sy + r.sh - fe);
      c.setTransform(1, 0, 0, 1, 0, 0);
      c.globalCompositeOperation = 'source-over';
      ctx.drawImage(s.canvas, 0, 0);
    }
    ctx.restore();
  }

  function drawClipVisual(ctx, clip, source, srcW, srcH, outW, outH, fInClip) {
    if (!source || !(srcW > 0) || !(srcH > 0)) return;
    drawBox(ctx, clip, srcW, srcH, outW, outH, fInClip || 0, (c, r) => {
      c.drawImage(source, r.sx, r.sy, r.sw, r.sh, r.sx, r.sy, r.sw, r.sh);
    });
  }

  // 色塊：當成一張和輸出同大的純色影像，所以縮放／位置／旋轉／裁切／不透明度都照樣可用
  function drawSolid(ctx, clip, outW, outH, fInClip) {
    const color = clip.solidColor || '#000000';
    drawBox(ctx, clip, outW, outH, outW, outH, fInClip || 0, (c, r) => {
      c.fillStyle = color; c.fillRect(r.sx, r.sy, r.sw, r.sh);
    });
  }

  // ---------------------------------------------------------------------------------
  // 字型
  // ---------------------------------------------------------------------------------
  let fontPromise = null, fontLoaded = false;
  function ready() {
    if (fontPromise) return fontPromise;
    const d = root.document;
    if (!d || !d.fonts || !d.fonts.load) { fontLoaded = true; return (fontPromise = Promise.resolve(true)); }
    fontPromise = d.fonts.load('80px "WHZ-Heavy"', '字幕測試ABC123').then(() => { fontLoaded = true; return true; }, () => { fontLoaded = true; return false; });
    return fontPromise;
  }
  const FONT_FALLBACK = '"PingFang TC", "Microsoft JhengHei", "Noto Sans TC", sans-serif';
  function fontString(t, px) {
    const f = t.font || 'WHZ-Heavy';
    if (f === 'WHZ-Heavy') return `${px}px "WHZ-Heavy", ${FONT_FALLBACK}`;
    if (f === 'system' || f === 'sans') return `bold ${px}px system-ui, -apple-system, "Segoe UI", ${FONT_FALLBACK}`;
    return `${px}px "${f}", ${FONT_FALLBACK}`;
  }

  // ---------------------------------------------------------------------------------
  // 文字換行（中文依寬度、行首不放標點、行尾不放開括號；英數單字不拆，太長才硬拆）
  // ---------------------------------------------------------------------------------
  const NO_START = new Set(Array.from('，。、．；：？！）」』】》〉］｝”’…‥—～ー々,.;:?!)]}%‰°'));
  const NO_END = new Set(Array.from('（「『【《〈［｛“‘([{'));
  const WORD_RE = /[A-Za-z0-9À-ɏ]+(?:['’.\-:\/][A-Za-z0-9À-ɏ]+)*/y;

  function tokenize(par) {
    const out = [];
    const chars = Array.from(par);
    let i = 0;
    while (i < chars.length) {
      const ch = chars[i];
      if (/[A-Za-z0-9À-ɏ]/.test(ch)) {
        const rest = chars.slice(i).join('');
        WORD_RE.lastIndex = 0;
        const m = WORD_RE.exec(rest);
        const w = m ? m[0] : ch;
        out.push({ s: w, sp: false });
        i += Array.from(w).length;
      } else if (ch === ' ' || ch === '\t' || ch === '　') {
        out.push({ s: ch === '\t' ? ' ' : ch, sp: true }); i++;
      } else { out.push({ s: ch, sp: false }); i++; }
    }
    return out;
  }

  // measure(str) → 寬度；回傳行陣列。maxW 小於一個字時每行至少放一個字。
  function wrapText(measure, text, maxW) {
    const lines = [];
    const pars = String(text == null ? '' : text).replace(/\r\n?/g, '\n').split('\n');
    const str = a => a.map(t => t.s).join('');
    const trimEnd = a => { while (a.length && a[a.length - 1].sp) a.pop(); return a; };
    for (const par of pars) {
      const q = tokenize(par);
      let cur = [];
      let guard = 0;
      for (let qi = 0; qi < q.length && guard++ < 100000; qi++) {
        const tok = q[qi];
        if (tok.sp && cur.length === 0) continue;
        const cand = str(cur) + tok.s;
        if (cur.length === 0) {
          // 單字比一整行還寬：硬拆成字元
          const cs = Array.from(tok.s);
          if (!tok.sp && cs.length > 1 && measure(tok.s) > maxW) {
            q.splice(qi, 1, ...cs.map(c => ({ s: c, sp: false }))); qi--; continue;
          }
          cur.push(tok); continue;
        }
        if (measure(cand.replace(/\s+$/, '')) <= maxW) { cur.push(tok); continue; }
        if (tok.sp) { lines.push(str(trimEnd(cur))); cur = []; continue; }
        // 需要在 tok 前換行：先處理禁則，把前面的字一起帶到下一行
        const carry = [];
        let first = tok;
        while (NO_START.has(first.s) && cur.length > 1) { carry.unshift(cur.pop()); first = carry[0]; }
        while (cur.length > 1 && (NO_END.has(cur[cur.length - 1].s) || cur[cur.length - 1].sp)) {
          const last = cur.pop();
          if (!last.sp) carry.unshift(last);
        }
        lines.push(str(trimEnd(cur)));
        cur = carry;
        while (cur.length && cur[0].sp) cur.shift();
        qi--; continue;           // 帶下來的字連同 tok 重新檢查（cur 只會越來越短，一定會結束）
      }
      lines.push(str(trimEnd(cur)));
    }
    return lines;
  }

  const layoutCache = new Map();
  function layoutTitle(ctx, t, font, maxW) {
    const key = font + '|' + Math.round(maxW) + '|' + fontLoaded + '|' + t.text;
    let v = layoutCache.get(key);
    if (v) return v;
    ctx.font = font;
    const measure = s => ctx.measureText(s).width;
    const lines = wrapText(measure, t.text, maxW);
    const widths = lines.map(measure);
    v = { lines, widths, w: Math.max(0, ...widths) };
    if (layoutCache.size > 60) layoutCache.delete(layoutCache.keys().next().value);
    layoutCache.set(key, v);
    return v;
  }

  // ---------------------------------------------------------------------------------
  // 顏色小工具（檢查器的色彩＋透明度欄位用）
  // ---------------------------------------------------------------------------------
  function parseColor(s) {
    s = String(s == null ? '' : s).trim();
    let m = /^#([0-9a-f]{3})$/i.exec(s);
    if (m) { const h = m[1]; return { hex: '#' + h[0] + h[0] + h[1] + h[1] + h[2] + h[2], a: 1 }; }
    m = /^#([0-9a-f]{6})([0-9a-f]{2})?$/i.exec(s);
    if (m) return { hex: '#' + m[1].toLowerCase(), a: m[2] ? Math.round(parseInt(m[2], 16) / 255 * 1000) / 1000 : 1 };
    m = /^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*(?:,\s*([\d.]+)\s*)?\)$/i.exec(s);
    if (m) {
      const h = n => clamp(Math.round(+n), 0, 255).toString(16).padStart(2, '0');
      return { hex: '#' + h(m[1]) + h(m[2]) + h(m[3]), a: m[4] == null ? 1 : clamp(+m[4], 0, 1) };
    }
    return { hex: '#000000', a: s === 'transparent' ? 0 : 1 };
  }
  function formatColor(hex, a) {
    if (a >= 1) return hex;
    const n = parseInt(hex.slice(1), 16);
    return `rgba(${n >> 16 & 255},${n >> 8 & 255},${n & 255},${Math.round(clamp(a, 0, 1) * 1000) / 1000})`;
  }

  // ---------------------------------------------------------------------------------
  // 字幕
  // ---------------------------------------------------------------------------------
  const BASE_TITLE = {
    text: '輸入字幕', preset: 'static', font: 'WHZ-Heavy', size: 80, color: '#ffffff', align: 'center',
    stroke: { color: '#000000', width: 0 }, shadow: { color: 'rgba(0,0,0,.6)', blur: 8, x: 0, y: 4 },
    bg: { color: 'rgba(0,0,0,0)', padding: 24, radius: 8 }, lineHeight: 1.25, x: 0.5, y: 0.5,
  };
  // defaults：切換樣式時套用 align／x／y／bg（size 只用在新增字幕）
  const TITLE_PRESETS = {
    static: { name: '靜態字幕', defaults: { size: 80, align: 'center', x: 0.5, y: 0.5, bg: { color: 'rgba(0,0,0,0)', padding: 24, radius: 8 } } },
    lowerThird: { name: '下三分之一條', defaults: { size: 56, align: 'left', x: 0.06, y: 0.85, bg: { color: 'rgba(0,0,0,0.65)', padding: 22, radius: 0 } } },
    scroll: { name: '由下往上捲動', defaults: { size: 56, align: 'center', x: 0.5, y: 0.5, bg: { color: 'rgba(0,0,0,0)', padding: 24, radius: 8 } } },
    crawl: { name: '橫向跑馬燈', defaults: { size: 56, align: 'left', x: 0.5, y: 0.9, bg: { color: 'rgba(0,0,0,0.55)', padding: 14, radius: 0 } } },
    typewriter: { name: '打字機（逐字）', defaults: { size: 80, align: 'center', x: 0.5, y: 0.5, bg: { color: 'rgba(0,0,0,0)', padding: 24, radius: 8 } } },
    fadeUp: { name: '淡入上移', defaults: { size: 80, align: 'center', x: 0.5, y: 0.5, bg: { color: 'rgba(0,0,0,0)', padding: 24, radius: 8 } } },
  };
  function makeTitle(preset, text) {
    const t = deepClone(BASE_TITLE);
    const p = TITLE_PRESETS[preset] || TITLE_PRESETS.static;
    t.preset = TITLE_PRESETS[preset] ? preset : 'static';
    Object.assign(t, deepClone(p.defaults));
    if (text != null) t.text = text;
    return t;
  }

  const easeOutCubic = u => 1 - Math.pow(1 - clamp(u, 0, 1), 3);

  function roundRectPath(c, x, y, w, h, r) {
    r = Math.max(0, Math.min(r, w / 2, h / 2));
    c.beginPath();
    if (c.roundRect) { c.roundRect(x, y, w, h, r); return; }
    c.moveTo(x + r, y); c.arcTo(x + w, y, x + w, y + h, r); c.arcTo(x + w, y + h, x, y + h, r);
    c.arcTo(x, y + h, x, y, r); c.arcTo(x, y, x + w, y, r); c.closePath();
  }

  // 畫一塊文字。box：{ left, top, w（區塊寬）}；reveal：只畫前 N 個字（打字機），null＝全部
  function paintBlock(ctx, t, L, k, lh, box, reveal, drawBg) {
    const align = t.align === 'left' || t.align === 'right' ? t.align : 'center';
    const bgOk = drawBg && t.bg && t.bg.color;
    if (bgOk) {
      const pad = num(t.bg.padding, 0) * k;
      ctx.fillStyle = t.bg.color;
      roundRectPath(ctx, box.left - pad, box.top - pad, box.w + pad * 2, lh * L.lines.length + pad * 2, num(t.bg.radius, 0) * k);
      ctx.fill();
    }
    ctx.textBaseline = 'middle'; ctx.textAlign = align; ctx.lineJoin = 'round';
    const sw = num(t.stroke && t.stroke.width, 0) * k;
    const sh = t.shadow && (num(t.shadow.blur, 0) > 0 || num(t.shadow.x, 0) || num(t.shadow.y, 0));
    const setShadow = on => {
      if (on && sh) {
        ctx.shadowColor = t.shadow.color; ctx.shadowBlur = num(t.shadow.blur, 0) * k;
        ctx.shadowOffsetX = num(t.shadow.x, 0) * k; ctx.shadowOffsetY = num(t.shadow.y, 0) * k;
      } else { ctx.shadowColor = 'rgba(0,0,0,0)'; ctx.shadowBlur = 0; ctx.shadowOffsetX = 0; ctx.shadowOffsetY = 0; }
    };
    let left = reveal == null ? Infinity : reveal;
    L.lines.forEach((line, i) => {
      let s = line;
      if (reveal != null) {
        const cs = Array.from(line);
        s = cs.slice(0, Math.max(0, left)).join('');
        left -= cs.length;
      }
      if (!s) return;
      const y = box.top + (i + 0.5) * lh;
      const x = align === 'left' ? box.left : align === 'right' ? box.left + box.w : box.left + box.w / 2;
      if (sw > 0) {
        ctx.lineWidth = sw * 2; ctx.strokeStyle = t.stroke.color;
        setShadow(true); ctx.strokeText(s, x, y);
        setShadow(false); ctx.fillStyle = t.color; ctx.fillText(s, x, y);
      } else {
        setShadow(true); ctx.fillStyle = t.color; ctx.fillText(s, x, y);
      }
    });
    setShadow(false);
  }

  const TITLE_DRAW = {
    static(ctx, t, o) {
      const L = layoutTitle(ctx, t, o.font, o.outW * 0.9 - 2 * num(t.bg && t.bg.padding, 0) * o.k);
      const bh = L.lines.length * o.lh;
      paintBlock(ctx, t, L, o.k, o.lh, { left: t.x * o.outW - L.w / 2, top: t.y * o.outH - bh / 2, w: L.w }, null, true);
    },
    fadeUp(ctx, t, o) {
      const L = layoutTitle(ctx, t, o.font, o.outW * 0.9 - 2 * num(t.bg && t.bg.padding, 0) * o.k);
      const inF = Math.max(1, Math.min(Math.round(0.5 * o.fps), Math.floor(o.dur / 3)));
      const outF = Math.max(1, Math.min(Math.round(0.3 * o.fps), Math.floor(o.dur / 3)));
      let a = clamp(o.f / inF, 0, 1);
      const rise = (1 - easeOutCubic(a)) * 40 * o.k;
      if (o.f > o.dur - outF) a = Math.min(a, clamp((o.dur - o.f) / outF, 0, 1));
      const bh = L.lines.length * o.lh;
      ctx.globalAlpha *= a;
      paintBlock(ctx, t, L, o.k, o.lh, { left: t.x * o.outW - L.w / 2, top: t.y * o.outH - bh / 2 + rise, w: L.w }, null, true);
    },
    typewriter(ctx, t, o) {
      const L = layoutTitle(ctx, t, o.font, o.outW * 0.9 - 2 * num(t.bg && t.bg.padding, 0) * o.k);
      const total = L.lines.reduce((n, s) => n + Array.from(s).length, 0);
      const frames = Math.max(1, Math.min(Math.round(o.dur * 0.7), Math.ceil(total * o.fps / 10)));   // 每秒約 10 字，最多用掉 70% 長度
      const n = Math.floor(total * clamp(o.f / frames, 0, 1));
      const bh = L.lines.length * o.lh;
      paintBlock(ctx, t, L, o.k, o.lh, { left: t.x * o.outW - L.w / 2, top: t.y * o.outH - bh / 2, w: L.w }, n, true);
    },
    lowerThird(ctx, t, o) {
      const pad = num(t.bg && t.bg.padding, 0) * o.k;
      const left = t.x * o.outW;
      const L = layoutTitle(ctx, t, o.font, Math.max(40, o.outW - left - o.outW * 0.06 - pad));
      const bh = L.lines.length * o.lh;
      const top = t.y * o.outH - bh / 2;
      const inF = Math.max(1, Math.min(Math.round(0.4 * o.fps), Math.floor(o.dur / 3)));
      const outF = Math.max(1, Math.min(Math.round(0.3 * o.fps), Math.floor(o.dur / 3)));
      const p = Math.min(easeOutCubic(o.f / inF), o.f > o.dur - outF ? clamp((o.dur - o.f) / outF, 0, 1) : 1);
      ctx.translate(-(1 - p) * o.outW * 0.5, 0);
      ctx.globalAlpha *= p;
      const hasBar = t.bg && t.bg.color && parseColor(t.bg.color).a > 0;
      if (hasBar) {
        ctx.fillStyle = t.bg.color;
        ctx.fillRect(0, top - pad, o.outW, bh + pad * 2);
        ctx.fillStyle = '#ffd23f';
        ctx.fillRect(0, top - pad, 8 * o.k, bh + pad * 2);
      }
      paintBlock(ctx, { ...t, align: 'left' }, L, o.k, o.lh, { left, top, w: L.w }, null, false);
    },
    scroll(ctx, t, o) {
      const pad = num(t.bg && t.bg.padding, 0) * o.k;
      const L = layoutTitle(ctx, t, o.font, o.outW * 0.8 - 2 * pad);
      const bh = L.lines.length * o.lh;
      const p = clamp(o.f / Math.max(1, o.dur), 0, 1);
      const top = o.outH + pad - p * (o.outH + bh + pad * 2);
      paintBlock(ctx, t, L, o.k, o.lh, { left: t.x * o.outW - L.w / 2, top, w: L.w }, null, true);
    },
    crawl(ctx, t, o) {
      const one = { ...t, text: String(t.text == null ? '' : t.text).replace(/\s*\n\s*/g, '　') };
      ctx.font = o.font;
      const w = ctx.measureText(one.text).width;
      const pad = num(t.bg && t.bg.padding, 0) * o.k;
      const p = clamp(o.f / Math.max(1, o.dur), 0, 1);
      const left = o.outW - p * (o.outW + w);
      const top = t.y * o.outH - o.lh / 2;
      if (t.bg && t.bg.color) { ctx.fillStyle = t.bg.color; ctx.fillRect(0, top - pad, o.outW, o.lh + pad * 2); }
      paintBlock(ctx, { ...one, align: 'left' }, { lines: [one.text], widths: [w], w }, o.k, o.lh, { left, top, w }, null, false);
    },
  };

  // 字級 size 是「短邊 1080 時的像素」，輸出尺寸不同時等比放大縮小，看起來一致
  function drawTitle(ctx, clip, outW, outH, fInClip, fps) {
    const t = clip && clip.title;
    if (!t) return;
    const f = fInClip || 0;
    const op = clamp(num(getParam(clip, 'video.transform.opacity', f), 1), 0, 1);
    if (op <= 0) return;
    if (!fontLoaded) ready();
    const k = Math.min(outW, outH) / 1080;
    const px = Math.max(1, num(t.size, 80) * k);
    const o = {
      f, fps: fps || 30, dur: Math.max(1, clip.duration || 1), k, outW, outH, lh: px * num(t.lineHeight, 1.25),
      font: fontString(t, px),
    };
    ctx.save();
    const m = clipMatrix(clip, outW, outH, outW, outH, f);
    ctx.transform(m[0], m[1], m[2], m[3], m[4], m[5]);
    ctx.globalAlpha *= op;
    ctx.font = o.font;
    (TITLE_DRAW[t.preset] || TITLE_DRAW.static)(ctx, { ...BASE_TITLE, ...t }, o);
    ctx.restore();
  }

  // ---------------------------------------------------------------------------------
  // 轉場
  //   draw(ctx, drawA, drawB, t, opts, outW, outH)
  //   drawA／drawB：(ctx) => void。t<=0 只畫 A、t>=1 只畫 B（一定與 A／B 逐像素相同）。
  //   opts：Transition 物件（type/color/direction/ease）。單邊轉場（另一邊是背景）：
  //     opts.single===true 或 opts.rightClipId===null → 沒有 B（尾端淡出）；opts.single==='in' 或 opts.leftClipId===null → 沒有 A（開頭淡入）。
  //     沒有的那一邊由呼叫端畫成空白（透明，露出下層軌道或背景色），所以交叉疊化＝淡入／淡出到背景、
  //     擦拭／推擠／滑入／縮放／模糊＝和背景做同樣的效果；浸入顏色／淡出到黑是「從顏色淡入」／「淡出到顏色」。
  //   direction＝運動方向：'left' 表示畫面往左動（B 從右邊進來）。
  //   用到離屏畫布的轉場（疊化／推擠／滑入／縮放／模糊）假設 drawA／drawB 可以畫到任何同大的 ctx。
  // ---------------------------------------------------------------------------------
  function ease(t, kind) {
    t = clamp(t, 0, 1);
    if (kind === 'easeInOut') return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
    return t;
  }
  const isSingleIn = o => !!o && (o.single === 'in' || (o.leftClipId === null && !!o.rightClipId));
  const isSingle = o => !!o && (o.single === true || o.rightClipId === null || isSingleIn(o));
  const DIRS = { left: [-1, 0], right: [1, 0], up: [0, -1], down: [0, 1] };
  const dirOf = o => DIRS[o && o.direction] || DIRS.left;

  // 把一個 drawX 畫到離屏，回傳 canvas
  function layer(key, draw, outW, outH) {
    const s = scratch(key, outW, outH);
    draw(s.ctx);
    return s.canvas;
  }
  // 兩層加權合成（A 用 1-u、B 用 u；用 lighter 才能讓半透明區域也正確）後貼回 ctx
  function blend(ctx, cA, cB, u, outW, outH, xfA, xfB) {
    const s = scratch('tC', outW, outH), c = s.ctx;
    const put = (cv, a, xf, filter) => {
      if (a <= 0) return;
      c.save(); c.globalAlpha = a; if (filter) c.filter = filter; if (xf) xf(c); c.drawImage(cv, 0, 0); c.restore();
    };
    put(cA, 1 - u, xfA && xfA.fn, xfA && xfA.filter);
    c.globalCompositeOperation = 'lighter';
    put(cB, u, xfB && xfB.fn, xfB && xfB.filter);
    c.globalCompositeOperation = 'source-over';
    ctx.drawImage(s.canvas, 0, 0);
  }
  const scaleAbout = (outW, outH, sc) => c => { c.translate(outW / 2, outH / 2); c.scale(sc, sc); c.translate(-outW / 2, -outH / 2); };

  function dipDraw(ctx, drawA, drawB, t, opts, outW, outH, color) {
    if (isSingleIn(opts)) {          // 開頭淡入：從顏色淡入 B
      drawB(ctx);
      ctx.save(); ctx.globalAlpha = 1 - t; ctx.fillStyle = color; ctx.fillRect(0, 0, outW, outH); ctx.restore();
      return;
    }
    const single = isSingle(opts);
    if (single) {
      drawA(ctx);
      ctx.save(); ctx.globalAlpha = t; ctx.fillStyle = color; ctx.fillRect(0, 0, outW, outH); ctx.restore();
      return;
    }
    if (t < 0.5) { drawA(ctx); t = t * 2; } else { drawB(ctx); t = (1 - t) * 2; }
    ctx.save(); ctx.globalAlpha = clamp(t, 0, 1); ctx.fillStyle = color; ctx.fillRect(0, 0, outW, outH); ctx.restore();
  }

  function defineTransition(name, fn) {
    return {
      name,
      draw(ctx, drawA, drawB, t, opts, outW, outH) {
        if (!(t > 0)) { drawA(ctx); return; }
        if (!(t < 1)) { drawB(ctx); return; }
        fn(ctx, drawA, drawB, ease(t, opts && opts.ease), opts || {}, outW, outH);
      },
    };
  }

  const TRANSITIONS = {
    crossDissolve: defineTransition('交叉疊化', (ctx, dA, dB, u, o, W, H) => {
      blend(ctx, layer('tA', dA, W, H), layer('tB', dB, W, H), u, W, H);
    }),
    dipToColor: defineTransition('浸入顏色', (ctx, dA, dB, u, o, W, H) => {
      dipDraw(ctx, dA, dB, u, o, W, H, o.color || '#000000');
    }),
    fadeToBlack: defineTransition('淡出到黑', (ctx, dA, dB, u, o, W, H) => {
      dipDraw(ctx, dA, dB, u, o, W, H, '#000000');
    }),
    wipe: defineTransition('擦拭', (ctx, dA, dB, u, o, W, H) => {
      const [dx, dy] = dirOf(o);
      // 邊界沿運動方向前進：B 佔據「邊界之後」的區域（'left' 時 B 從右邊露出）
      let a, b;   // 兩個 rect [x,y,w,h]
      if (dx) {
        const edge = dx < 0 ? W * (1 - u) : W * u;
        a = dx < 0 ? [0, 0, edge, H] : [edge, 0, W - edge, H];
        b = dx < 0 ? [edge, 0, W - edge, H] : [0, 0, edge, H];
      } else {
        const edge = dy < 0 ? H * (1 - u) : H * u;
        a = dy < 0 ? [0, 0, W, edge] : [0, edge, W, H - edge];
        b = dy < 0 ? [0, edge, W, H - edge] : [0, 0, W, edge];
      }
      const clipped = (draw, r) => { ctx.save(); ctx.beginPath(); ctx.rect(r[0], r[1], r[2], r[3]); ctx.clip(); draw(ctx); ctx.restore(); };
      clipped(dA, a); clipped(dB, b);
    }),
    push: defineTransition('推擠', (ctx, dA, dB, u, o, W, H) => {
      const [dx, dy] = dirOf(o);
      const cA = layer('tA', dA, W, H), cB = layer('tB', dB, W, H);
      ctx.drawImage(cA, dx * W * u, dy * H * u);
      ctx.drawImage(cB, dx * W * (u - 1), dy * H * (u - 1));
    }),
    slide: defineTransition('滑入', (ctx, dA, dB, u, o, W, H) => {
      const [dx, dy] = dirOf(o);
      dA(ctx);
      ctx.drawImage(layer('tB', dB, W, H), -dx * W * (1 - u), -dy * H * (1 - u));
    }),
    zoom: defineTransition('縮放', (ctx, dA, dB, u, o, W, H) => {
      blend(ctx, layer('tA', dA, W, H), layer('tB', dB, W, H), u, W, H,
        { fn: scaleAbout(W, H, 1 + 0.6 * u) }, { fn: scaleAbout(W, H, 0.7 + 0.3 * u) });
    }),
    blur: defineTransition('模糊', (ctx, dA, dB, u, o, W, H) => {
      const px = Math.sin(Math.PI * u) * 28 * Math.min(W, H) / 1080;
      const filter = px > 0.2 ? `blur(${px.toFixed(2)}px)` : null;
      blend(ctx, layer('tA', dA, W, H), layer('tB', dB, W, H), u, W, H, { filter }, { filter });
    }),
  };
  // ---------------------------------------------------------------------------------
  // 檢查器
  //   sections：[{ id, title, appliesTo(subject), render(el, subject, commit) }]
  //   subject：clip 區段（transform／crop／title）收到片段；transition 區段收到 Transition 物件。
  //   commit(patch, { live })：clip 區段的 patch 是 setClipProps 的巢狀補丁（例如 { video: { transform: { zoomX: 1.2 } } }），
  //     transition 區段的 patch 是 Transition 的欄位補丁（例如 { duration: 20 }）。
  //   live:true＝拖曳／輸入中（不進復原），放開／確定時再送一次 live:false。
  //   同一個 el、同一個 subject.id 再次 render 只會更新欄位值（不重建 DOM），所以外部在 live 提交後重畫也不會打斷拖曳或輸入。
  // ---------------------------------------------------------------------------------
  const isTransition = s => !!s && s.leftClipId !== undefined;
  const FIT_OPTIONS = [['fit', '符合（完整顯示）'], ['fill', '填滿（裁掉多的）'], ['stretch', '拉伸（變形）']];
  const DIR_OPTIONS = [['left', '向左'], ['right', '向右'], ['up', '向上'], ['down', '向下']];
  const ALIGN_OPTIONS = [['left', '靠左'], ['center', '置中'], ['right', '靠右']];

  function ensureStyle() {
    const d = root.document;
    if (!d || d.getElementById('ed-fx-style')) return;
    const st = d.createElement('style');
    st.id = 'ed-fx-style';
    st.textContent = `
.ed-fx{display:flex;flex-direction:column;gap:6px;font-size:12px;color:var(--ed-text,var(--text,inherit))}
.ed-fx,.ed-fx *{box-sizing:border-box}
.ed-fx[hidden],.ed-fx [hidden]{display:none!important}
.ed-fx-row{display:grid;grid-template-columns:78px minmax(0,1fr);align-items:center;gap:8px;min-height:26px}
.ed-fx-lab{margin:0;font-size:12px;font-weight:600;color:var(--ed-muted,var(--muted,#6b7890));white-space:nowrap;overflow:hidden;text-overflow:ellipsis;user-select:none;-webkit-user-select:none}
.ed-fx-lab.ed-fx-drag{cursor:ew-resize;touch-action:none}
.ed-fx-lab.ed-fx-drag:hover{color:var(--ed-accent,var(--accent,#004aad))}
.ed-fx-ctl{display:flex;align-items:center;gap:6px;min-width:0}
.ed-fx-ctl>*{min-width:0}
.ed-fx input[type=number],.ed-fx select,.ed-fx textarea,.ed-fx input[type=text]{font:inherit;font-size:12px;color:var(--ed-text,var(--text,inherit));background:var(--ed-field,var(--field-bg,#fff));border:1px solid var(--ed-border,var(--border,rgba(0,74,173,.2)));border-radius:6px;padding:4px 6px;width:100%}
.ed-fx input[type=number]{text-align:right;-moz-appearance:textfield}
.ed-fx input[type=number]::-webkit-outer-spin-button,.ed-fx input[type=number]::-webkit-inner-spin-button{-webkit-appearance:none;margin:0}
.ed-fx textarea{min-height:64px;resize:vertical;line-height:1.4}
.ed-fx input[type=color]{width:34px;height:24px;padding:0;border:1px solid var(--ed-border,var(--border,rgba(0,74,173,.2)));border-radius:6px;background:none;flex:none}
.ed-fx-unit{flex:none;color:var(--ed-muted,var(--muted,#6b7890));font-size:11px;min-width:12px}
.ed-fx-alpha{width:64px!important;flex:none}
.ed-fx-chk{display:flex;align-items:center;gap:6px;margin:0;font-size:12px;font-weight:500;cursor:pointer}
.ed-fx-chk input{margin:0}
.ed-fx-head{margin:6px 0 0;padding-top:6px;border-top:1px solid var(--ed-border,var(--border,rgba(0,74,173,.12)));font-size:11px;font-weight:700;color:var(--ed-muted,var(--muted,#6b7890))}
.ed-fx-btn{font:inherit;font-size:12px;padding:4px 10px;border-radius:6px;border:1px solid var(--ed-border,var(--border,rgba(0,74,173,.2)));background:var(--ed-field,var(--field-bg,#fff));color:var(--ed-text,var(--text,inherit));cursor:pointer}
.ed-fx-btn:hover{border-color:var(--ed-accent,var(--accent,#004aad));color:var(--ed-accent,var(--accent,#004aad))}
.ed-fx-hint{font-size:11px;color:var(--ed-muted,var(--muted,#6b7890));line-height:1.4}
`;
    d.head.appendChild(st);
  }

  const fmtNum = (v, dec) => String(+Number(v).toFixed(dec));
  const el = (tag, cls, text) => {
    const e = root.document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  };

  // 每個欄位：{ el, refresh() }；st 是這個區段的共用狀態 { subject, commit }
  function makeRow(st, def) {
    const row = el('div', 'ed-fx-row');
    const ctl = el('div', 'ed-fx-ctl');
    const emit = (patch, live) => st.commit && st.commit(patch, { live: !!live });
    const get = () => def.get(st.subject);
    let refresh = () => {};
    const lab = txt => { const l = el('span', 'ed-fx-lab', txt); l.title = txt; return l; };

    if (def.type === 'head') {
      row.className = 'ed-fx-head'; row.textContent = def.label;
    } else if (def.type === 'btn') {
      row.style.gridTemplateColumns = '1fr';
      const b = el('button', 'ed-fx-btn', def.label);
      b.type = 'button';
      b.addEventListener('click', () => emit(def.patch(st.subject), false));
      row.append(b);
    } else if (def.type === 'hint') {
      row.style.gridTemplateColumns = '1fr';
      row.className = 'ed-fx-hint'; row.textContent = def.label;
    } else if (def.type === 'num') {
      const scale = def.scale || 1, dec = def.dec == null ? 2 : def.dec;
      const l = lab(def.label); l.classList.add('ed-fx-drag');
      const inp = el('input'); inp.type = 'number'; inp.step = def.inputStep || fmtNum(Math.pow(10, -dec), dec);
      const unit = el('span', 'ed-fx-unit', def.unit || '');
      ctl.append(inp, unit);
      const lo = def.min == null ? -Infinity : def.min, hi = def.max == null ? Infinity : def.max;
      const q = v => { const p = Math.pow(10, dec) * scale; return Math.round(clamp(v, lo, hi) * p) / p; };   // 夾範圍並對齊顯示精度
      const cur = () => num(get(), def.def == null ? 0 : def.def);
      refresh = () => { if (root.document.activeElement !== inp) inp.value = fmtNum(cur() * scale, dec); };
      inp.addEventListener('change', () => {
        const v = parseFloat(inp.value);
        if (!isFinite(v)) { inp.value = fmtNum(cur() * scale, dec); return; }
        const nv = q(v / scale);
        inp.value = fmtNum(nv * scale, dec);
        emit(def.patch(nv, st.subject), false);
      });
      // 在標籤上左右拖曳（Shift 加速 ×10、Alt 微調 ×0.1），雙擊標籤重設。用 window 監聽，外部中途重畫也不會中斷。
      const dpp = def.dpp || (Number.isFinite(hi - lo) ? (hi - lo) / 400 : Math.pow(10, -dec));
      l.addEventListener('pointerdown', e => {
        if (e.button !== 0) return;
        e.preventDefault();
        const x0 = e.clientX, v0 = cur();
        let moved = false, last = v0;
        const move = ev => {
          const dx = ev.clientX - x0;
          if (!moved && Math.abs(dx) < 2) return;
          moved = true;
          const mult = ev.shiftKey ? 10 : ev.altKey ? 0.1 : 1;
          last = q(v0 + dx * dpp * mult);
          inp.value = fmtNum(last * scale, dec);
          emit(def.patch(last, st.subject), true);
        };
        const up = () => {
          root.removeEventListener('pointermove', move); root.removeEventListener('pointerup', up); root.removeEventListener('pointercancel', up);
          root.document.body.style.cursor = '';
          if (moved) emit(def.patch(last, st.subject), false);
        };
        root.document.body.style.cursor = 'ew-resize';
        root.addEventListener('pointermove', move); root.addEventListener('pointerup', up); root.addEventListener('pointercancel', up);
      });
      l.addEventListener('dblclick', () => {
        if (def.def == null) return;
        inp.value = fmtNum(def.def * scale, dec);
        emit(def.patch(def.def, st.subject), false);
      });
      row.append(l, ctl);
    } else if (def.type === 'select') {
      const s = el('select');
      const opts = def.options;
      opts.forEach(([v, t]) => { const o = el('option', null, t); o.value = v; s.append(o); });
      ctl.append(s);
      refresh = () => { s.value = String(get()); };
      s.addEventListener('change', () => emit(def.patch(s.value, st.subject), false));
      row.append(lab(def.label), ctl);
    } else if (def.type === 'check') {
      row.style.gridTemplateColumns = '1fr';
      const l = el('label', 'ed-fx-chk');
      const c = el('input'); c.type = 'checkbox';
      l.append(c, root.document.createTextNode(def.label));
      refresh = () => { c.checked = !!get(); };
      c.addEventListener('change', () => emit(def.patch(c.checked, st.subject), false));
      row.append(l);
    } else if (def.type === 'color') {
      const c = el('input'); c.type = 'color';
      ctl.append(c);
      let a = null;
      if (def.alpha) {
        a = el('input', 'ed-fx-alpha'); a.type = 'number'; a.min = 0; a.max = 100; a.step = 5; a.title = '透明度（%）';
        ctl.append(a, el('span', 'ed-fx-unit', '%'));
      }
      refresh = () => {
        const p = parseColor(get());
        c.value = p.hex;
        if (a && root.document.activeElement !== a) a.value = fmtNum(p.a * 100, 0);
      };
      const build = () => formatColor(c.value, a ? clamp((parseFloat(a.value) || 0) / 100, 0, 1) : 1);
      c.addEventListener('input', () => emit(def.patch(build(), st.subject), true));
      c.addEventListener('change', () => emit(def.patch(build(), st.subject), false));
      if (a) a.addEventListener('change', () => emit(def.patch(build(), st.subject), false));
      row.append(lab(def.label), ctl);
    } else if (def.type === 'text') {
      row.style.gridTemplateColumns = '1fr';
      const wrap = el('div');
      const t = el('textarea'); t.rows = 3; t.placeholder = def.placeholder || '';
      wrap.append(lab(def.label), t);
      refresh = () => { if (root.document.activeElement !== t) t.value = String(get() == null ? '' : get()); };
      t.addEventListener('input', () => emit(def.patch(t.value, st.subject), true));
      t.addEventListener('change', () => emit(def.patch(t.value, st.subject), false));
      row.append(wrap);
    }
    return {
      el: row,
      refresh() {
        if (def.show) row.hidden = !def.show(st.subject);
        refresh();
      },
    };
  }

  function buildSection(host, key, subject, commit, defs) {
    let st = host.__edFx;
    if (st && st.key === key) {                     // 同一個對象：只更新值
      st.subject = subject; st.commit = commit;
      st.rows.forEach(r => r.refresh());
      return;
    }
    ensureStyle();
    host.textContent = '';
    host.classList.add('ed-fx');
    st = host.__edFx = { key, subject, commit, rows: [] };
    for (const d of defs) {
      const r = makeRow(st, d);
      host.append(r.el);
      st.rows.push(r);
    }
    st.rows.forEach(r => r.refresh());
  }

  const tf = (c, k) => { const v = getParam(c, 'video.transform.' + k, 0); return v === undefined ? DEFAULT_TRANSFORM[k] : v; };
  const tfPatch = o => ({ video: { transform: o } });
  const cp = (c, k) => { const v = getParam(c, 'video.crop.' + k, 0); return v === undefined ? 0 : v; };
  const cropPatch = o => ({ video: { crop: o } });
  const tt = (c, k) => (c.title && c.title[k] != null) ? c.title[k] : BASE_TITLE[k];
  const ttSub = (c, o, k) => (c.title && c.title[o] && c.title[o][k] != null) ? c.title[o][k] : BASE_TITLE[o][k];

  const SECTIONS = [
    {
      id: 'transform', title: '變形',
      appliesTo: c => !!c && !isTransition(c) && !!c.video,
      render(host, clip, commit) {
        const linked = c => c.video && c.video.transform ? c.video.transform.zoomLinked !== false : true;
        buildSection(host, 'transform:' + clip.id, clip, commit, [
          { type: 'num', label: '縮放 X', get: c => tf(c, 'zoomX'), def: 1, min: 0.01, max: 20, dpp: 0.005, dec: 3,
            patch: (v, c) => tfPatch(linked(c) ? { zoomX: v, zoomY: v } : { zoomX: v }) },
          { type: 'num', label: '縮放 Y', get: c => linked(c) ? tf(c, 'zoomX') : tf(c, 'zoomY'), def: 1, min: 0.01, max: 20, dpp: 0.005, dec: 3,
            patch: (v, c) => tfPatch(linked(c) ? { zoomX: v, zoomY: v } : { zoomY: v }) },
          { type: 'check', label: '連結縮放 X／Y', get: linked,
            patch: (v, c) => tfPatch(v ? { zoomLinked: true, zoomY: tf(c, 'zoomX') } : { zoomLinked: false }) },
          { type: 'num', label: '位置 X', get: c => tf(c, 'posX'), def: 0, min: -20000, max: 20000, dpp: 1, dec: 1, unit: 'px', patch: v => tfPatch({ posX: v }) },
          { type: 'num', label: '位置 Y', get: c => tf(c, 'posY'), def: 0, min: -20000, max: 20000, dpp: 1, dec: 1, unit: 'px', patch: v => tfPatch({ posY: v }) },
          { type: 'num', label: '旋轉', get: c => tf(c, 'rotation'), def: 0, min: -3600, max: 3600, dpp: 0.5, dec: 1, unit: '°', patch: v => tfPatch({ rotation: v }) },
          { type: 'num', label: '錨點 X', get: c => tf(c, 'anchorX'), def: 0, min: -20000, max: 20000, dpp: 1, dec: 1, unit: 'px', patch: v => tfPatch({ anchorX: v }) },
          { type: 'num', label: '錨點 Y', get: c => tf(c, 'anchorY'), def: 0, min: -20000, max: 20000, dpp: 1, dec: 1, unit: 'px', patch: v => tfPatch({ anchorY: v }) },
          { type: 'num', label: '不透明度', get: c => tf(c, 'opacity'), def: 1, min: 0, max: 1, scale: 100, dpp: 0.004, dec: 0, unit: '%', patch: v => tfPatch({ opacity: v }) },
          { type: 'check', label: '水平翻轉', get: c => !!tf(c, 'flipH'), patch: v => tfPatch({ flipH: v }) },
          { type: 'check', label: '垂直翻轉', get: c => !!tf(c, 'flipV'), patch: v => tfPatch({ flipV: v }) },
          { type: 'select', label: '畫面符合', options: FIT_OPTIONS, get: c => (c.video && c.video.fit) || 'fit', patch: v => ({ video: { fit: v } }) },
          { type: 'btn', label: '重設變形', patch: () => ({ video: { transform: defaultTransform(), fit: 'fit' } }) },
          { type: 'hint', label: '提示：在左側標籤上左右拖曳可調整數值（Shift 加速、Alt 微調），雙擊標籤重設。' },
        ]);
      },
    },
    {
      id: 'crop', title: '裁切',
      appliesTo: c => !!c && !isTransition(c) && !!c.video,
      render(host, clip, commit) {
        const side = (label, k) => ({ type: 'num', label, get: c => cp(c, k), def: 0, min: 0, max: 0.95, scale: 100, dpp: 0.002, dec: 1, unit: '%', patch: v => cropPatch({ [k]: v }) });
        buildSection(host, 'crop:' + clip.id, clip, commit, [
          side('左', 'left'), side('右', 'right'), side('上', 'top'), side('下', 'bottom'),
          { type: 'num', label: '柔邊', get: c => cp(c, 'softness'), def: 0, min: 0, max: 1, scale: 100, dpp: 0.004, dec: 0, unit: '%', patch: v => cropPatch({ softness: v }) },
          { type: 'btn', label: '重設裁切', patch: () => cropPatch(defaultCrop()) },
        ]);
      },
    },
    {
      id: 'title', title: '字幕',
      appliesTo: c => !!c && !isTransition(c) && c.type === 'title' && !!c.title,
      render(host, clip, commit) {
        const T = o => ({ title: o });
        const isPreset = (...a) => c => a.includes(tt(c, 'preset'));
        buildSection(host, 'title:' + clip.id, clip, commit, [
          { type: 'text', label: '文字', placeholder: '輸入字幕內容（可換行）', get: c => tt(c, 'text'), patch: v => T({ text: v }) },
          { type: 'select', label: '樣式', options: Object.keys(TITLE_PRESETS).map(k => [k, TITLE_PRESETS[k].name]), get: c => tt(c, 'preset'),
            patch: v => { const d = deepClone(TITLE_PRESETS[v].defaults); delete d.size; return T({ preset: v, ...d }); } },
          { type: 'select', label: '字型', options: [['WHZ-Heavy', '粗體（預設）'], ['system', '系統黑體']], get: c => tt(c, 'font'), patch: v => T({ font: v }) },
          { type: 'num', label: '字級', get: c => tt(c, 'size'), def: 80, min: 8, max: 600, dpp: 0.5, dec: 0, unit: 'px', patch: v => T({ size: v }) },
          { type: 'color', label: '文字顏色', get: c => tt(c, 'color'), patch: v => T({ color: v }) },
          { type: 'select', label: '對齊', options: ALIGN_OPTIONS, get: c => tt(c, 'align'), show: c => tt(c, 'preset') !== 'lowerThird' && tt(c, 'preset') !== 'crawl', patch: v => T({ align: v }) },
          { type: 'num', label: '行距', get: c => tt(c, 'lineHeight'), def: 1.25, min: 0.8, max: 3, dpp: 0.01, dec: 2, show: isPreset('static', 'lowerThird', 'scroll', 'typewriter', 'fadeUp'), patch: v => T({ lineHeight: v }) },
          { type: 'num', label: '水平位置', get: c => tt(c, 'x'), def: 0.5, min: -0.5, max: 1.5, scale: 100, dpp: 0.002, dec: 1, unit: '%', show: c => tt(c, 'preset') !== 'crawl', patch: v => T({ x: v }) },
          { type: 'num', label: '垂直位置', get: c => tt(c, 'y'), def: 0.5, min: -0.5, max: 1.5, scale: 100, dpp: 0.002, dec: 1, unit: '%', show: c => tt(c, 'preset') !== 'scroll', patch: v => T({ y: v }) },
          { type: 'head', label: '描邊' },
          { type: 'color', label: '描邊顏色', get: c => ttSub(c, 'stroke', 'color'), patch: v => T({ stroke: { color: v } }) },
          { type: 'num', label: '描邊粗細', get: c => ttSub(c, 'stroke', 'width'), def: 0, min: 0, max: 60, dpp: 0.1, dec: 1, unit: 'px', patch: v => T({ stroke: { width: v } }) },
          { type: 'head', label: '陰影' },
          { type: 'color', label: '陰影顏色', alpha: true, get: c => ttSub(c, 'shadow', 'color'), patch: v => T({ shadow: { color: v } }) },
          { type: 'num', label: '模糊', get: c => ttSub(c, 'shadow', 'blur'), def: 8, min: 0, max: 100, dpp: 0.2, dec: 0, unit: 'px', patch: v => T({ shadow: { blur: v } }) },
          { type: 'num', label: '位移 X', get: c => ttSub(c, 'shadow', 'x'), def: 0, min: -100, max: 100, dpp: 0.2, dec: 0, unit: 'px', patch: v => T({ shadow: { x: v } }) },
          { type: 'num', label: '位移 Y', get: c => ttSub(c, 'shadow', 'y'), def: 4, min: -100, max: 100, dpp: 0.2, dec: 0, unit: 'px', patch: v => T({ shadow: { y: v } }) },
          { type: 'head', label: '背景' },
          { type: 'color', label: '背景顏色', alpha: true, get: c => ttSub(c, 'bg', 'color'), patch: v => T({ bg: { color: v } }) },
          { type: 'num', label: '內距', get: c => ttSub(c, 'bg', 'padding'), def: 24, min: 0, max: 300, dpp: 0.3, dec: 0, unit: 'px', patch: v => T({ bg: { padding: v } }) },
          { type: 'num', label: '圓角', get: c => ttSub(c, 'bg', 'radius'), def: 8, min: 0, max: 200, dpp: 0.3, dec: 0, unit: 'px',
            show: c => tt(c, 'preset') !== 'lowerThird' && tt(c, 'preset') !== 'crawl', patch: v => T({ bg: { radius: v } }) },
        ]);
      },
    },
    {
      id: 'transition', title: '轉場',
      appliesTo: s => isTransition(s),
      render(host, tr, commit) {
        buildSection(host, 'transition:' + tr.id, tr, commit, [
          { type: 'select', label: '類型', options: Object.keys(TRANSITIONS).map(k => [k, TRANSITIONS[k].name]), get: s => s.type, patch: v => ({ type: v }) },
          { type: 'num', label: '長度', get: s => s.duration, def: 15, min: 1, max: 600, dpp: 0.25, dec: 0, unit: '格', patch: v => ({ duration: Math.round(v) }) },
          { type: 'select', label: '對齊', options: [['center', '置中於剪接點'], ['start', '從剪接點開始'], ['end', '在剪接點結束']], get: s => s.align || 'center', show: s => !!(s.leftClipId && s.rightClipId), patch: v => ({ align: v }) },
          { type: 'color', label: '顏色', get: s => s.color || '#000000', show: s => s.type === 'dipToColor', patch: v => ({ color: v }) },
          { type: 'select', label: '方向', options: DIR_OPTIONS, get: s => s.direction || 'left', show: s => ['wipe', 'push', 'slide'].includes(s.type), patch: v => ({ direction: v }) },
          { type: 'select', label: '緩動', options: [['linear', '線性'], ['easeInOut', '緩入緩出']], get: s => s.ease || 'linear', patch: v => ({ ease: v }) },
        ]);
      },
    },
  ];

  const api = {
    DEFAULT_TRANSFORM, DEFAULT_CROP, defaultTransform, defaultCrop, defaultVideo,
    fitRect, clipMatrix, applyMatrix, cropRect, getParam,
    drawClipVisual, drawSolid, drawTitle,
    TRANSITIONS, ease, TITLE_PRESETS, makeTitle, wrapText, parseColor, formatColor,
    ready, get fontLoaded() { return fontLoaded; },
    inspector: { sections: SECTIONS },
    ensureStyle,                 // 插入檢查器樣式（.ed-fx-*）；UI 自己的區段也用這套外觀，啟動時先呼叫一次
    _setCanvasFactory(fn) { canvasFactory = fn; Object.keys(pool).forEach(k => delete pool[k]); },
  };
  Q.fx = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);

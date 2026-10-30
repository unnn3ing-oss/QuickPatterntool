// =====================================================================================
// 設計：字型註冊表與載入器（網頁版專用，外掛不需要；updater.js／deploy.js 的 SKIP 會略過 design-*）
//
// 瀏覽器掛在 QPTDesign.fonts，node 用 module.exports（test/design-fonts.test.js）。
// 原則：沒用到的字型完全不發請求。google 來源用 unicode-range 分片，所以文字出現新字時要補載對應分片。
// 載入失敗不拋錯：狀態設為 failed、resolve false，畫面維持備用字型，不阻擋編輯與匯出。
// 與 edit-fx.js 的載入器同一種模式，但依接縫原則自備一份，不引用它。
// =====================================================================================
(function (root) {
  'use strict';

  const SANS_FALLBACK = '"PingFang TC", "Microsoft JhengHei", "Noto Sans TC", sans-serif';
  const SERIF_FALLBACK = '"Noto Serif TC", "Songti TC", "PMingLiU", "MingLiU", serif';
  const GOOGLE_CSS = 'https://fonts.googleapis.com/css2?family=Noto+Serif+TC:wght@400;700&display=swap';
  const DEFAULT_ID = 'WHZ-Heavy';
  const SAMPLE = '字體測試ABC123';

  // 順序即選單順序
  const FONTS = [
    { id: 'WHZ-Heavy', name: '粗體（預設）', family: 'WHZ-Heavy', weight: 400, source: 'preload', fallback: SANS_FALLBACK },
    { id: 'noto-serif-tc-400', name: '思源宋體', family: 'Noto Serif TC', weight: 400, source: 'google', fallback: SERIF_FALLBACK },
    { id: 'noto-serif-tc-700', name: '思源宋體 粗', family: 'Noto Serif TC', weight: 700, source: 'google', fallback: SERIF_FALLBACK },
    { id: 'cactus', name: '仙人掌明體', family: 'Cactus Classical Serif', weight: 400, source: 'file', url: 'fonts/cactus-classical-serif.woff2', fallback: SERIF_FALLBACK },
    { id: 'system', name: '系統黑體', family: null, weight: 400, source: 'system', fallback: SANS_FALLBACK },
  ];
  const BY_ID = {};
  for (const f of FONTS) BY_ID[f.id] = f;

  function createFonts(env) {
    env = env || {};
    const doc = env.document;
    const FontFaceCtor = env.FontFace;
    const setT = env.setTimeout || (typeof setTimeout !== 'undefined' ? setTimeout : null);
    const clearT = env.clearTimeout || (typeof clearTimeout !== 'undefined' ? clearTimeout : () => {});

    const states = {};              // id → 'loading'|'loaded'|'failed'（沒有 = idle）
    const baseLoads = {};           // id → Promise<boolean>（字型本身的載入，只做一次）
    const requested = {};           // id → Set<字元>（google 字型已要求過的字）
    const listeners = new Set();
    let gen = 0;
    let linkAdded = false;

    const get = id => BY_ID[id] || BY_ID[DEFAULT_ID];
    function notify(id, what) {
      for (const cb of [...listeners]) { try { cb(id, what); } catch (e) { /* 通知失敗不影響其他人 */ } }
    }
    function setState(id, st) { states[id] = st; notify(id, st); }
    function bump() { gen++; }

    function state(id) {
      const f = BY_ID[id];
      if (!f) return states[DEFAULT_ID] || 'idle';
      if (f.source === 'system') return 'loaded';
      return states[id] || 'idle';
    }
    function list() { return FONTS.map(f => ({ id: f.id, name: f.name, state: state(f.id) })); }

    function fontCss(id, size) {
      const f = get(id);
      const fam = f.family ? `"${f.family}", ` : '';
      return `${f.weight} ${size}px ${fam}${f.fallback}`;
    }

    const hasFonts = () => !!(doc && doc.fonts && typeof doc.fonts.load === 'function');
    // 插入 Google Fonts 樣式表（只插一次），回傳「樣式表載好」的 Promise。
    // 要等樣式表載好才能 document.fonts.load：否則 @font-face 還沒註冊，load 會立刻回空陣列，被誤當成「已載入」；
    // 樣式表載入失敗（離線、被擋）時 reject，字型狀態就會變成 failed。沒有 load 事件可等的環境（node 測試的 stub）直接視為載好。
    let linkReady = null;
    function ensureLink() {
      if (linkReady) return linkReady;
      if (linkAdded || !doc || !doc.createElement || !doc.head) return (linkReady = Promise.resolve());
      linkAdded = true;
      const link = doc.createElement('link');
      link.rel = 'stylesheet';
      link.href = GOOGLE_CSS;
      if (typeof link.addEventListener === 'function') {
        linkReady = new Promise((res, rej) => {
          link.addEventListener('load', () => res(), { once: true });
          link.addEventListener('error', () => rej(new Error('Google Fonts 樣式表載入失敗')), { once: true });
        });
        linkReady.catch(() => {});
      } else linkReady = Promise.resolve();
      doc.head.appendChild(link);
      return linkReady;
    }
    const spec = f => `${f.weight} 80px "${f.family}"`;

    // 一次 document.fonts.load；成功 → gen+1 並通知 loaded，失敗 → failed
    function runLoad(id, promiseFn) {
      let p;
      try { p = Promise.resolve(promiseFn()); } catch (e) { p = Promise.reject(e); }
      return p.then(() => { bump(); setState(id, 'loaded'); return true; },
        () => { bump(); setState(id, 'failed'); return false; });
    }

    function load(id) {
      const f = get(id);
      id = f.id;
      if (f.source === 'system') return Promise.resolve(true);
      if (baseLoads[id]) return baseLoads[id];
      let p;
      if (f.source === 'preload') {
        if (!hasFonts()) p = Promise.resolve(true);
        else { setState(id, 'loading'); p = runLoad(id, () => doc.fonts.load(`80px "${f.family}"`)); }
      } else if (f.source === 'google') {
        if (!hasFonts()) p = Promise.resolve(false);
        else {
          setState(id, 'loading');
          const linkP = ensureLink();
          const set = requested[id] || (requested[id] = new Set());
          for (const ch of SAMPLE) set.add(ch);
          p = runLoad(id, () => linkP.then(() => doc.fonts.load(spec(f), SAMPLE)));
        }
      } else if (f.source === 'file') {
        if (!doc || !doc.fonts || typeof FontFaceCtor !== 'function') {
          p = Promise.resolve(false); bump(); setState(id, 'failed');
        } else {
          setState(id, 'loading');
          p = runLoad(id, () => {
            const face = new FontFaceCtor(f.family, `url("${f.url}") format("woff2")`, { display: 'swap' });
            return Promise.resolve(face.load()).then(loaded => { doc.fonts.add(loaded || face); });
          });
        }
      } else p = Promise.resolve(true);
      baseLoads[id] = p;
      return p;
    }

    // 只對這個字型還沒要求過的新字元發請求（google 分片）；沒有新字元就不發請求
    function ensureText(id, text) {
      const f = get(id);
      id = f.id;
      if (f.source !== 'google') return load(id);
      const set = requested[id] || (requested[id] = new Set());
      const fresh = [];
      for (const ch of String(text || '')) {
        if (/\s/.test(ch) || set.has(ch)) continue;
        set.add(ch); fresh.push(ch);
      }
      if (!fresh.length) return states[id] === 'failed' ? Promise.resolve(false) : (baseLoads[id] || Promise.resolve(true));
      if (!hasFonts()) return Promise.resolve(false);
      const linkP = ensureLink();
      if (!states[id]) setState(id, 'loading');
      return runLoad(id, () => linkP.then(() => doc.fonts.load(spec(f), fresh.join(''))));
    }

    // 匯出前呼叫：等文件用到的所有字型（與其文字分片）載好；最多等 timeout，超時回 false（用備用字型繼續）
    function ready(docu, opts) {
      const timeout = opts && opts.timeout != null ? opts.timeout : 10000;
      const texts = {};
      for (const pg of (docu && docu.pages) || []) {
        for (const o of (pg && pg.objects) || []) {
          if (!o || o.type !== 'text') continue;
          const id = get(o.font).id;
          texts[id] = (texts[id] || '') + (o.text || '');
        }
      }
      const jobs = Object.keys(texts).map(id =>
        load(id).then(ok => (get(id).source === 'google' ? ensureText(id, texts[id]).then(ok2 => ok && ok2) : ok)));
      const all = Promise.all(jobs).then(r => r.every(Boolean));
      if (!setT) return all;
      let timer;
      const timeoutP = new Promise(res => { timer = setT(() => res(false), timeout); });
      return Promise.race([all, timeoutP]).then(v => { clearT(timer); return v; });
    }

    function onFontLoad(cb) { listeners.add(cb); return () => listeners.delete(cb); }

    return { list, fontCss, state, load, ensureText, ready, onFontLoad, gen: () => gen };
  }

  const api = { createFonts, FONTS, GOOGLE_CSS };
  const Q = root.QPTDesign = root.QPTDesign || {};
  if (root.document) Q.fonts = createFonts(root);
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);

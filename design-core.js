// =====================================================================================
// 平面設計：文件模型與編輯核心（網頁版專用，外掛不需要，updater.js／deploy.js 的 SKIP 會略過 design-*.js）
//
// 純邏輯、不碰 DOM：瀏覽器掛在 QPTDesign.core，node 用 module.exports（test/design-core.test.js）。
// 不引用 edit-core.js 等主工具的程式（接縫原則），需要的工具在這裡自備一份。
//
// 座標一律是「頁面像素」；x、y、w、h 是物件「未旋轉」時的左上角與尺寸，rot 是繞中心順時針的度數。
// 所有編輯操作都「就地修改」doc，回傳 { ok: true, ... } 或 { ok: false, reason: '繁中原因' }。
// 做法是「先在副本上算、檢查不變式、通過才整份換進去」，所以失敗時 doc 一定完全沒變；
// 注意：成功後 doc.pages 等子物件會換成新的物件，UI 不要長期握著舊的頁面／物件參考，要用 id 重新查。
//
// 鎖定（locked）的物件只能改 locked、hidden；其他修改、刪除、調圖層順序、對齊都會被擋下。
// 貼圖物件的貼圖名稱放在 sticker 欄位（id 欄位是物件自己的 id，兩者不能共用）。
// 幾何函式（corners／bounds／hitTest／resizeRect／snapBox…）都是純函式，不改文件。
// =====================================================================================
(function (root) {
  const Q = root.QPTDesign = root.QPTDesign || {};

  // ---- 常數 --------------------------------------------------------------------------
  const SIZES = { '1:1': [1080, 1080], '4:5': [1080, 1350], '9:16': [1080, 1920], '16:9': [1920, 1080] };
  const SIDE_MIN = 64, SIDE_MAX = 4096;
  const MAX_PAGES = 20, MAX_OBJECTS = 200;
  const DOC_VERSION = 1;
  const STICKERS = ['angry', 'cry', 'kiss', 'laugh', 'meh', 'shock', 'smile'];
  const SNAP_PX = 6;                       // 吸附門檻（螢幕像素）
  const TYPES = ['text', 'image', 'shape', 'sticker', 'mosaic'];
  const SHAPE_KINDS = ['rect', 'ellipse', 'line', 'arrow'];
  const ALIGNS = ['left', 'center', 'right'];
  const FITS = ['cover', 'contain'];
  const MERGE_KEYS = ['stroke', 'shadow', 'view'];   // patch 時做淺合併的欄位
  const LOCK_FREE = ['locked', 'hidden'];             // 鎖定時仍可改的欄位
  const HANDLES = { nw: [-1, -1], n: [0, -1], ne: [1, -1], e: [1, 0], se: [1, 1], s: [0, 1], sw: [-1, 1], w: [-1, 0] };

  const isObj = v => v !== null && typeof v === 'object' && !Array.isArray(v);
  const copy = v => (typeof structuredClone === 'function' ? structuredClone(v) : JSON.parse(JSON.stringify(v)));
  const fin = v => typeof v === 'number' && isFinite(v);
  const str = v => typeof v === 'string' && v.length > 0;
  const fail = reason => ({ ok: false, reason });
  const RAD = Math.PI / 180;

  class EditError extends Error {}
  const bail = reason => { throw new EditError(reason); };

  // ---- 預設值 ------------------------------------------------------------------------
  const common = () => ({ rot: 0, opacity: 1, locked: false, hidden: false });
  const DEFAULTS = {
    text: () => ({ text: '輸入文字', font: 'WHZ-Heavy', size: 80, color: '#111111', align: 'center', lineHeight: 1.25, letterSpacing: 0, arc: 0,
      stroke: { w: 0, color: '#000000' }, shadow: { x: 0, y: 0, blur: 0, color: 'rgba(0,0,0,0.5)' }, w: 800, h: 100 }),
    image: () => ({ fit: 'cover', view: { ox: 0.5, oy: 0.5, scale: 1 }, radius: 0, gray: false }),
    shape: () => ({ kind: 'rect', fill: '#2f6fed', stroke: { w: 0, color: '#000000' }, radius: 0, w: 400, h: 300 }),
    sticker: () => ({ sticker: 'smile', w: 240, h: 240 }),
    mosaic: () => ({ w: 300, h: 200 }),
  };
  // 該類型的完整預設欄位（含 type，不含 id、x、y）；不認得的類型回 null
  function defaults(type) {
    const mk = DEFAULTS[type];
    return mk ? Object.assign({ type }, mk(), common()) : null;
  }
  const solidBg = () => ({ type: 'solid', color: '#ffffff' });

  // ---- 序列化 ------------------------------------------------------------------------
  const serialize = doc => JSON.stringify(doc);
  const deserialize = s => (typeof s === 'string' ? JSON.parse(s) : copy(s));

  // ---- id ----------------------------------------------------------------------------
  // 依序給 id：取現有同前綴 id 的最大號碼 +1（所以會跳過已存在的，刪掉的號碼也不會馬上被重用）
  function nextId(prefix, ids) {
    let n = 0;
    const re = new RegExp('^' + prefix + '(\\d+)$');
    for (const id of ids) { const m = re.exec(id); if (m) n = Math.max(n, Number(m[1])); }
    return prefix + (n + 1);
  }
  const allObjects = doc => doc.pages.reduce((a, p) => a.concat(p.objects), []);
  const objIds = doc => allObjects(doc).map(o => o.id);

  function createDoc({ w = 1080, h = 1080 } = {}) {
    return { version: DOC_VERSION, pages: [{ id: 'p1', w, h, bg: solidBg(), objects: [] }], assets: {} };
  }

  // =====================================================================================
  // 不變式
  // =====================================================================================
  const sideOk = v => Number.isInteger(v) && v >= SIDE_MIN && v <= SIDE_MAX;
  function viewProblem(v) {
    if (!isObj(v) || !fin(v.ox) || !fin(v.oy) || !fin(v.scale)) return '圖片的裁切位置設定不正確';
    if (v.ox < 0 || v.ox > 1 || v.oy < 0 || v.oy > 1) return '圖片的裁切位置必須在 0～1 之間';
    if (v.scale <= 0) return '圖片的縮放必須大於 0';
    return null;
  }
  const strokeOk = s => isObj(s) && fin(s.w) && s.w >= 0 && str(s.color);
  // 顏料（paint）：純色字串，或線性／放射漸層物件。放射的 cx、cy（0～1）、r（0.05～2）可省略（渲染時用預設值）
  const inRange = (v, lo, hi) => v === undefined || (fin(v) && v >= lo && v <= hi);
  function paintOk(p) {
    if (typeof p === 'string') return str(p);
    if (!isObj(p) || !str(p.from) || !str(p.to)) return false;
    if (p.type === 'linear') return fin(p.angle);
    if (p.type === 'radial') return inRange(p.cx, 0, 1) && inRange(p.cy, 0, 1) && inRange(p.r, 0.05, 2);
    return false;
  }
  function bgProblem(bg, assets) {
    if (!isObj(bg)) return '頁面背景設定不正確';
    if (bg.type === 'solid') return str(bg.color) ? null : '背景顏色不正確';
    if (bg.type === 'gradient') return str(bg.from) && str(bg.to) && fin(bg.angle) ? null : '漸層背景設定不正確';
    if (bg.type === 'radial') return paintOk(bg) ? null : '放射漸層背景設定不正確';
    if (bg.type === 'image') {
      if (!str(bg.asset) || !Object.prototype.hasOwnProperty.call(assets, bg.asset)) return '找不到背景圖片的資產';
      if (!FITS.includes(bg.fit)) return '背景圖片的填滿方式不正確';
      return viewProblem(bg.view);
    }
    return '不支援的背景類型';
  }
  function objProblem(o, assets) {
    if (!isObj(o)) return '物件資料不正確';
    if (!str(o.id)) return '物件缺少 id';
    if (!TYPES.includes(o.type)) return `不支援的物件類型：${o.type}`;
    if (!fin(o.x) || !fin(o.y)) return '物件位置不正確';
    if (!fin(o.w) || !fin(o.h) || o.w <= 0 || o.h <= 0) return '物件寬高必須大於 0';
    if (!fin(o.rot)) return '旋轉角度不正確';
    if (!fin(o.opacity) || o.opacity < 0 || o.opacity > 1) return '透明度必須在 0～1 之間';
    if (typeof o.locked !== 'boolean' || typeof o.hidden !== 'boolean') return '鎖定／隱藏設定不正確';
    switch (o.type) {
      case 'text':
        if (typeof o.text !== 'string') return '文字內容不正確';
        if (!str(o.font)) return '字型不正確';
        if (!fin(o.size) || o.size <= 0) return '字級必須大於 0';
        if (!paintOk(o.color)) return '文字顏色不正確';
        if (o.arc !== undefined && !(fin(o.arc) && o.arc >= -360 && o.arc <= 360)) return '弧形文字的彎曲角度必須在 −360～360 之間';
        if (!ALIGNS.includes(o.align)) return '文字對齊方式不正確';
        if (!fin(o.lineHeight) || o.lineHeight <= 0) return '行高必須大於 0';
        if (!fin(o.letterSpacing)) return '字距不正確';
        if (!strokeOk(o.stroke)) return '文字描邊設定不正確';
        if (!isObj(o.shadow) || !fin(o.shadow.x) || !fin(o.shadow.y) || !fin(o.shadow.blur) || o.shadow.blur < 0 || !str(o.shadow.color)) return '文字陰影設定不正確';
        return null;
      case 'image':
        if (!str(o.asset) || !Object.prototype.hasOwnProperty.call(assets, o.asset)) return '找不到圖片資產';
        if (!FITS.includes(o.fit)) return '圖片填滿方式不正確';
        if (!fin(o.radius) || o.radius < 0) return '圓角不能小於 0';
        if (typeof o.gray !== 'boolean') return '抽色設定不正確';
        return viewProblem(o.view);
      case 'shape':
        if (!SHAPE_KINDS.includes(o.kind)) return `不支援的形狀：${o.kind}`;
        if (!paintOk(o.fill)) return '形狀填色不正確';
        if ((o.kind === 'line' || o.kind === 'arrow') && typeof o.fill !== 'string') return '線條與箭頭的填色必須是純色';
        if (!strokeOk(o.stroke)) return '形狀描邊設定不正確';
        if (!fin(o.radius) || o.radius < 0) return '圓角不能小於 0';
        return null;
      case 'sticker':
        return STICKERS.includes(o.sticker) ? null : `沒有這個貼圖：${o.sticker}`;
      case 'mosaic':
        return o.rot === 0 ? null : '馬賽克不能旋轉';
    }
    return null;
  }
  // 規格第 7 節的不變式；沒問題回 null，有問題回第一個繁中原因
  function validate(doc) {
    if (!isObj(doc)) return '不是有效的設計文件';
    if (doc.version !== DOC_VERSION) return '文件版本不正確';
    if (!isObj(doc.assets)) return '資產清單不正確';
    for (const [id, a] of Object.entries(doc.assets)) {
      if (!isObj(a) || !fin(a.w) || !fin(a.h) || a.w <= 0 || a.h <= 0) return `資產 ${id} 的尺寸不正確`;
      if (a.name != null && typeof a.name !== 'string') return `資產 ${id} 的名稱不正確`;
      if (a.mime != null && typeof a.mime !== 'string') return `資產 ${id} 的格式不正確`;
    }
    if (!Array.isArray(doc.pages)) return '頁面清單不正確';
    if (doc.pages.length < 1) return '至少要保留一頁';
    if (doc.pages.length > MAX_PAGES) return `最多只能有 ${MAX_PAGES} 頁`;
    const pageIds = new Set(), ids = new Set();
    for (const p of doc.pages) {
      if (!isObj(p) || !str(p.id)) return '頁面缺少 id';
      if (pageIds.has(p.id)) return `頁面 id 重複：${p.id}`;
      pageIds.add(p.id);
      if (!sideOk(p.w) || !sideOk(p.h)) return `頁面尺寸必須是 ${SIDE_MIN}～${SIDE_MAX} 的整數`;
      const bp = bgProblem(p.bg, doc.assets);
      if (bp) return bp;
      if (!Array.isArray(p.objects)) return '物件清單不正確';
      if (p.objects.length > MAX_OBJECTS) return `每頁最多 ${MAX_OBJECTS} 個物件`;
      for (const o of p.objects) {
        const op = objProblem(o, doc.assets);
        if (op) return op;
        if (ids.has(o.id)) return `物件 id 重複：${o.id}`;
        ids.add(o.id);
      }
    }
    return null;
  }

  // =====================================================================================
  // 全有或全無的交易
  // =====================================================================================
  function replaceInPlace(target, src) {
    for (const k of Object.keys(target)) if (!(k in src)) delete target[k];
    Object.assign(target, src);
  }
  // 在副本上執行 fn(draft)，檢查不變式，通過才換回 doc
  function tx(doc, fn) {
    if (!isObj(doc) || !Array.isArray(doc.pages)) return fail('不是有效的設計文件');
    const d = copy(doc);
    let res;
    try { res = fn(d) || {}; } catch (e) { if (e instanceof EditError) return fail(e.message); throw e; }
    if (res.ok === false) return res;
    const why = validate(d);
    if (why) return fail(why);
    replaceInPlace(doc, d);
    return Object.assign({}, res, { ok: true });
  }
  const needPage = (d, pageId) => d.pages.find(p => p.id === pageId) || bail('找不到頁面');
  const pageIndex = (d, pageId) => {
    const i = d.pages.findIndex(p => p.id === pageId);
    return i >= 0 ? i : bail('找不到頁面');
  };
  function needObjs(page, ids) {
    const list = Array.isArray(ids) ? ids : ids == null ? [] : [ids];
    if (!list.length) bail('沒有選取物件');
    return list.map(id => page.objects.find(o => o.id === id) || bail('找不到物件（可能已經被刪除）'));
  }
  function needUnlocked(objs) { for (const o of objs) if (o.locked) bail('物件已鎖定'); }

  // 把部分欄位補成完整物件（不含 id）；stroke／shadow／view 做淺合併
  function fill(partial) {
    if (!isObj(partial)) bail('物件資料不正確');
    const base = defaults(partial.type) || bail(`不支援的物件類型：${partial.type}`);
    const o = Object.assign(base, copy(partial));
    for (const k of MERGE_KEYS) if (k in base && isObj(partial[k])) o[k] = Object.assign({}, defaults(partial.type)[k], partial[k]);
    return o;
  }

  // =====================================================================================
  // 頁面
  // =====================================================================================
  function addPage(doc, { w, h, index, bg } = {}) {
    return tx(doc, d => {
      const ref = d.pages[d.pages.length - 1];
      const i = index == null ? d.pages.length : index;
      if (!Number.isInteger(i) || i < 0 || i > d.pages.length) bail('頁面位置不正確');
      const id = nextId('p', d.pages.map(p => p.id));
      d.pages.splice(i, 0, { id, w: w == null ? (ref ? ref.w : 1080) : w, h: h == null ? (ref ? ref.h : 1080) : h, bg: bg ? copy(bg) : solidBg(), objects: [] });
      return { id };
    });
  }
  function duplicatePage(doc, pageId) {
    return tx(doc, d => {
      const i = pageIndex(d, pageId);
      const src = d.pages[i];
      const id = nextId('p', d.pages.map(p => p.id));
      const used = objIds(d);
      const objects = src.objects.map(o => {
        const nid = nextId('o', used);
        used.push(nid);
        return Object.assign(copy(o), { id: nid });
      });
      d.pages.splice(i + 1, 0, Object.assign(copy(src), { id, objects }));
      return { id };
    });
  }
  function removePage(doc, pageId) {
    return tx(doc, d => {
      const i = pageIndex(d, pageId);
      if (d.pages.length <= 1) bail('至少要保留一頁');
      d.pages.splice(i, 1);
    });
  }
  function movePage(doc, pageId, toIndex) {
    return tx(doc, d => {
      const i = pageIndex(d, pageId);
      if (!fin(toIndex)) bail('頁面位置不正確');
      const to = Math.min(d.pages.length - 1, Math.max(0, Math.round(toIndex)));
      const [p] = d.pages.splice(i, 1);
      d.pages.splice(to, 0, p);
    });
  }
  function setPageProps(doc, pageId, props = {}) {
    return tx(doc, d => {
      const p = needPage(d, pageId);
      if (props.w !== undefined) p.w = props.w;
      if (props.h !== undefined) p.h = props.h;
      if (props.bg !== undefined) p.bg = copy(props.bg);
    });
  }

  // =====================================================================================
  // 資產
  // =====================================================================================
  function addAsset(doc, { name, w, h, mime } = {}) {
    return tx(doc, d => {
      const id = nextId('a', Object.keys(d.assets || {}));
      d.assets[id] = { name: name == null ? '' : name, w, h, mime: mime == null ? '' : mime };
      return { id };
    });
  }
  // 刪掉沒被引用的資產，回傳被刪的 id（只在存檔時呼叫；平常資產只增不減，復原才找得回來）
  function pruneAssets(doc) {
    const used = new Set();
    for (const p of doc.pages) {
      if (p.bg && p.bg.type === 'image') used.add(p.bg.asset);
      for (const o of p.objects) if (o.type === 'image') used.add(o.asset);
    }
    const removed = Object.keys(doc.assets).filter(id => !used.has(id));
    for (const id of removed) delete doc.assets[id];
    return removed;
  }

  // =====================================================================================
  // 物件
  // =====================================================================================
  function addObject(doc, pageId, partial) {
    return tx(doc, d => {
      const p = needPage(d, pageId);
      const o = fill(partial);
      o.id = nextId('o', objIds(d));
      // 沒給位置時放在頁面中央
      if (o.x === undefined) o.x = fin(o.w) ? (p.w - o.w) / 2 : 0;
      if (o.y === undefined) o.y = fin(o.h) ? (p.h - o.h) / 2 : 0;
      p.objects.push(o);
      return { id: o.id };
    });
  }
  function updateObjects(doc, pageId, patches) {
    return tx(doc, d => {
      const p = needPage(d, pageId);
      const list = Array.isArray(patches) ? patches : [patches];
      if (!list.length) bail('沒有選取物件');
      for (const patch of list) {
        if (!isObj(patch)) bail('修改內容不正確');
        const [o] = needObjs(p, [patch.id]);
        for (const [k, v] of Object.entries(patch)) {
          if (k === 'id' || v === undefined) continue;
          if (k === 'type' && v !== o.type) bail('不能變更物件類型');
          const nv = MERGE_KEYS.includes(k) && isObj(v) && isObj(o[k]) ? Object.assign({}, o[k], v) : copy(v);
          if (o.locked && !LOCK_FREE.includes(k) && JSON.stringify(nv) !== JSON.stringify(o[k])) bail('物件已鎖定');
          o[k] = nv;
        }
      }
    });
  }
  function removeObjects(doc, pageId, ids) {
    return tx(doc, d => {
      const p = needPage(d, pageId);
      const objs = needObjs(p, ids);
      needUnlocked(objs);
      const del = new Set(objs.map(o => o.id));
      p.objects = p.objects.filter(o => !del.has(o.id));
    });
  }
  // 把物件以新 id、位移後放到頁面最上層（依原本的圖層順序）；回傳的 ids 對應傳入的順序
  function placeCopies(d, p, srcs, dx, dy) {
    if (!fin(dx) || !fin(dy)) bail('位移量不正確');
    const used = objIds(d);
    return srcs.map(src => {
      const o = fill(src);
      o.id = nextId('o', used);
      used.push(o.id);
      o.x = (fin(o.x) ? o.x : 0) + dx;
      o.y = (fin(o.y) ? o.y : 0) + dy;
      return o;
    });
  }
  function duplicateObjects(doc, pageId, ids, { dx = 20, dy = 20 } = {}) {
    return tx(doc, d => {
      const p = needPage(d, pageId);
      const objs = needObjs(p, ids);
      const layered = objs.slice().sort((a, b) => p.objects.indexOf(a) - p.objects.indexOf(b));
      const copies = placeCopies(d, p, layered, dx, dy);
      p.objects.push(...copies);
      return { ids: objs.map(o => copies[layered.indexOf(o)].id) };
    });
  }
  function pasteObjects(doc, pageId, objs, { dx = 20, dy = 20 } = {}) {
    return tx(doc, d => {
      const p = needPage(d, pageId);
      const list = Array.isArray(objs) ? objs : [];
      if (!list.length) bail('剪貼簿沒有物件');
      const copies = placeCopies(d, p, list, dx, dy);
      p.objects.push(...copies);
      return { ids: copies.map(o => o.id) };
    });
  }
  function reorder(doc, pageId, ids, dir) {
    return tx(doc, d => {
      const p = needPage(d, pageId);
      const objs = needObjs(p, ids);
      needUnlocked(objs);
      const sel = new Set(objs.map(o => o.id));
      const a = p.objects.slice();
      if (dir === 'top' || dir === 'bottom') {
        const picked = a.filter(o => sel.has(o.id)), rest = a.filter(o => !sel.has(o.id));
        p.objects = dir === 'top' ? rest.concat(picked) : picked.concat(rest);
      } else if (dir === 'up') {
        for (let i = a.length - 2; i >= 0; i--) {
          if (sel.has(a[i].id) && !sel.has(a[i + 1].id)) [a[i], a[i + 1]] = [a[i + 1], a[i]];
        }
        p.objects = a;
      } else if (dir === 'down') {
        for (let i = 1; i < a.length; i++) {
          if (sel.has(a[i].id) && !sel.has(a[i - 1].id)) [a[i], a[i - 1]] = [a[i - 1], a[i]];
        }
        p.objects = a;
      } else bail('圖層順序方向不正確');
    });
  }
  function findObject(doc, id) {
    for (const page of doc.pages) {
      const index = page.objects.findIndex(o => o.id === id);
      if (index >= 0) return { page, obj: page.objects[index], index };
    }
    return null;
  }

  // =====================================================================================
  // 讀檔遷移
  // =====================================================================================
  // 補齊缺的欄位再跑 validate；不改到傳進來的 raw。讀到比自己新的版本一律拒絕。
  // 不認得的額外欄位（例如專案檔資產的 data）原樣保留，交給呼叫端處理。
  function migrate(raw) {
    if (!isObj(raw)) return fail('不是有效的設計專案檔');
    const ver = raw.version == null ? 1 : raw.version;
    if (!fin(ver) || ver < 1) return fail('不是有效的設計專案檔（版本不正確）');
    if (ver > DOC_VERSION) return fail('這個檔案是用較新版本的設計工具建立的，請先更新後再開啟');
    if (!Array.isArray(raw.pages)) return fail('不是有效的設計專案檔（缺少頁面）');
    let d;
    try {
      d = copy(raw);
      d.version = DOC_VERSION;
      if (d.assets == null) d.assets = {};
      if (!isObj(d.assets)) bail('資產清單不正確');
      const pageIds = [], used = [];
      for (const p of d.pages) for (const o of (isObj(p) && Array.isArray(p.objects) ? p.objects : [])) if (isObj(o) && str(o.id)) used.push(o.id);
      d.pages = d.pages.map(p => {
        if (!isObj(p)) bail('頁面資料不正確');
        if (!str(p.id) || pageIds.includes(p.id)) p.id = nextId('p', pageIds.concat(d.pages.map(q => (isObj(q) ? q.id : ''))));
        pageIds.push(p.id);
        if (p.bg == null) p.bg = solidBg();
        if (p.objects == null) p.objects = [];
        if (!Array.isArray(p.objects)) bail('物件清單不正確');
        p.objects = p.objects.map(o => {
          if (!isObj(o)) bail('物件資料不正確');
          const r = Object.assign({}, o);
          // 舊寫法：貼圖名稱寫在 id，搬到 sticker 欄位，再給物件新 id
          if (r.type === 'sticker' && r.sticker === undefined && STICKERS.includes(r.id)) { r.sticker = r.id; delete r.id; }
          const f = fill(r);
          if (!str(f.id)) { f.id = nextId('o', used); used.push(f.id); }
          return f;
        });
        return p;
      });
    } catch (e) {
      if (e instanceof EditError) return fail(e.message);
      throw e;
    }
    const why = validate(d);
    return why ? fail(why) : { ok: true, doc: d };
  }

  // =====================================================================================
  // 幾何（純函式）
  // =====================================================================================
  const rotOf = o => (fin(o.rot) ? o.rot : 0);
  const center = o => ({ x: o.x + o.w / 2, y: o.y + o.h / 2 });
  // 把物件座標（相對中心）轉成頁面座標
  function rotVec(dx, dy, deg) {
    const c = Math.cos(deg * RAD), s = Math.sin(deg * RAD);
    return { x: dx * c - dy * s, y: dx * s + dy * c };
  }
  // 四個角：左上、右上、右下、左下（以中心旋轉 rot 度）
  function corners(o) {
    const c = center(o), hw = o.w / 2, hh = o.h / 2, r = rotOf(o);
    return [[-hw, -hh], [hw, -hh], [hw, hh], [-hw, hh]].map(([dx, dy]) => {
      const v = rotVec(dx, dy, r);
      return { x: c.x + v.x, y: c.y + v.y };
    });
  }
  // 旋轉後的外接矩形
  function bounds(o) {
    if (!rotOf(o)) return { x: o.x, y: o.y, w: o.w, h: o.h };
    const cs = corners(o);
    const xs = cs.map(p => p.x), ys = cs.map(p => p.y);
    const x = Math.min(...xs), y = Math.min(...ys);
    return { x, y, w: Math.max(...xs) - x, h: Math.max(...ys) - y };
  }
  // 頁面上的點 → 物件未旋轉的座標系（原點是物件左上角）
  function toLocal(o, px, py) {
    const c = center(o);
    const v = rotVec(px - c.x, py - c.y, -rotOf(o));
    return { x: v.x + o.w / 2, y: v.y + o.h / 2 };
  }
  // 從最上層往下找第一個點得到的物件；略過隱藏的，鎖定的仍可點到
  function hitTest(page, px, py) {
    for (let i = page.objects.length - 1; i >= 0; i--) {
      const o = page.objects[i];
      if (o.hidden) continue;
      const l = toLocal(o, px, py);
      if (l.x >= 0 && l.x <= o.w && l.y >= 0 && l.y <= o.h) return o.id;
    }
    return null;
  }
  // 框選：bounds 完全落在框內、而且沒隱藏的物件（依圖層順序）
  function inRect(page, r) {
    const x2 = r.x + r.w, y2 = r.y + r.h, E = 1e-9;
    return page.objects.filter(o => {
      if (o.hidden) return false;
      const b = bounds(o);
      return b.x >= r.x - E && b.y >= r.y - E && b.x + b.w <= x2 + E && b.y + b.h <= y2 + E;
    }).map(o => o.id);
  }
  // 拖縮放把手：dx／dy 是頁面座標的總位移，回傳新的 {x,y,w,h}（rot 不變）。對邊或對角在頁面上的位置不動。
  function resizeRect(o, handle, dx, dy, { keepRatio = false, minSize = 8 } = {}) {
    const hd = HANDLES[handle];
    if (!hd) return { x: o.x, y: o.y, w: o.w, h: o.h };
    const [hx, hy] = hd, r = rotOf(o);
    const l = rotVec(dx || 0, dy || 0, -r);          // 位移轉進物件座標系
    let w = o.w, h = o.h;
    if (keepRatio) {
      let s;
      if (hx && hy) s = 1 + (hx * l.x * o.w + hy * l.y * o.h) / (o.w * o.w + o.h * o.h);   // 投影到對角線
      else if (hx) s = (o.w + hx * l.x) / o.w;
      else s = (o.h + hy * l.y) / o.h;
      s = Math.max(s, minSize / o.w, minSize / o.h);
      w = o.w * s; h = o.h * s;
    } else {
      if (hx) w = Math.max(minSize, o.w + hx * l.x);
      if (hy) h = Math.max(minSize, o.h + hy * l.y);
    }
    // 固定點：舊的對邊／對角（邊把手時是對邊中點）
    const c = center(o);
    const a0 = rotVec(-hx * o.w / 2, -hy * o.h / 2, r);
    const P = { x: c.x + a0.x, y: c.y + a0.y };
    const a1 = rotVec(-hx * w / 2, -hy * h / 2, r);
    const nc = { x: P.x - a1.x, y: P.y - a1.y };
    return { x: nc.x - w / 2, y: nc.y - h / 2, w, h };
  }
  // 從中心指向 (px,py) 的角度：0° 在正上方、順時針為正，正規化到 0～360；step 時取最近的倍數
  function rotateAngle(o, px, py, { step = 0 } = {}) {
    const c = center(o);
    let a = Math.atan2(px - c.x, -(py - c.y)) / RAD;
    if (step > 0) a = Math.round(a / step) * step;
    a = ((a % 360) + 360) % 360;
    if (Math.abs(a - 360) < 1e-9) a = 0;
    return a === 0 ? 0 : a;     // 不要 -0
  }
  // 吸附候選線：頁面的邊與中心，加上其他沒隱藏的物件 bounds 的邊與中心
  function snapCandidates(page, excludeIds) {
    const ex = new Set(excludeIds || []);
    const xs = new Set([0, page.w / 2, page.w]), ys = new Set([0, page.h / 2, page.h]);
    for (const o of page.objects) {
      if (o.hidden || ex.has(o.id)) continue;
      const b = bounds(o);
      xs.add(b.x); xs.add(b.x + b.w / 2); xs.add(b.x + b.w);
      ys.add(b.y); ys.add(b.y + b.h / 2); ys.add(b.y + b.h);
    }
    return { xs: [...xs], ys: [...ys] };
  }
  // 門檻以螢幕像素計：頁面門檻＝threshold／zoom（zoom＝每個頁面像素在螢幕上的像素數）
  function snapBox(box, cands, { threshold = SNAP_PX, zoom = 1 } = {}) {
    const t = threshold / (zoom > 0 ? zoom : 1);
    const lines = [];
    const axis = (name, edges, list) => {
      let best = null;
      for (const e of edges) for (const c of list) {
        const d = c - e;
        if (Math.abs(d) <= t && (best === null || Math.abs(d) < Math.abs(best))) best = d;
      }
      if (best === null) return 0;
      const seen = new Set();
      for (const e of edges) for (const c of list) {
        if (Math.abs(c - (e + best)) < 1e-6 && !seen.has(c)) { seen.add(c); lines.push({ axis: name, pos: c }); }
      }
      return best;
    };
    const dx = axis('x', [box.x, box.x + box.w / 2, box.x + box.w], (cands && cands.xs) || []);
    const dy = axis('y', [box.y, box.y + box.h / 2, box.y + box.h], (cands && cands.ys) || []);
    return { dx: dx || 0, dy: dy || 0, lines };
  }
  // 多個 bounds 的聯集
  function unionBounds(objs) {
    const bs = objs.map(bounds);
    const x = Math.min(...bs.map(b => b.x)), y = Math.min(...bs.map(b => b.y));
    return { x, y, w: Math.max(...bs.map(b => b.x + b.w)) - x, h: Math.max(...bs.map(b => b.y + b.h)) - y };
  }
  // 對齊：只選一個時對齊頁面，多個時對齊整個選取範圍的 bounds
  function align(doc, pageId, ids, mode) {
    return tx(doc, d => {
      const p = needPage(d, pageId);
      const objs = needObjs(p, ids);
      needUnlocked(objs);
      const ref = objs.length === 1 ? { x: 0, y: 0, w: p.w, h: p.h } : unionBounds(objs);
      for (const o of objs) {
        const b = bounds(o);
        switch (mode) {
          case 'left': o.x += ref.x - b.x; break;
          case 'hcenter': o.x += (ref.x + ref.w / 2) - (b.x + b.w / 2); break;
          case 'right': o.x += (ref.x + ref.w) - (b.x + b.w); break;
          case 'top': o.y += ref.y - b.y; break;
          case 'vcenter': o.y += (ref.y + ref.h / 2) - (b.y + b.h / 2); break;
          case 'bottom': o.y += (ref.y + ref.h) - (b.y + b.h); break;
          default: bail('對齊方式不正確');
        }
      }
    });
  }
  // 等距分佈：依 bounds 排序，頭尾不動，讓中間的間距相等
  function distribute(doc, pageId, ids, dir) {
    return tx(doc, d => {
      if (dir !== 'h' && dir !== 'v') bail('分佈方向不正確');
      const p = needPage(d, pageId);
      const objs = needObjs(p, ids);
      if (objs.length < 3) bail('至少 3 個物件才能等距分佈');
      needUnlocked(objs);
      const [pos, len, key] = dir === 'h' ? ['x', 'w', 'x'] : ['y', 'h', 'y'];
      const items = objs.map(o => ({ o, b: bounds(o) })).sort((a, b) => a.b[pos] - b.b[pos]);
      const start = items[0].b[pos];
      const last = items[items.length - 1].b;
      const total = items.reduce((s, it) => s + it.b[len], 0);
      const gap = (last[pos] + last[len] - start - total) / (items.length - 1);
      let cur = start;
      items.forEach((it, i) => {
        if (i > 0 && i < items.length - 1) it.o[key] += cur - it.b[pos];
        cur += it.b[len] + gap;
      });
    });
  }

  // =====================================================================================
  // 顏色：colorKey／docColors／recolor
  // =====================================================================================
  const hex2 = n => (n < 16 ? '0' : '') + n.toString(16);
  // 解析顏色字串 → { r, g, b, a }；看不懂回 null。支援 #rgb／#rgba／#rrggbb／#rrggbbaa／rgb()／rgba()
  function parseColor(c) {
    if (typeof c !== 'string') return null;
    const t = c.trim().toLowerCase();
    let m = /^#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/.exec(t);
    if (m) {
      let h = m[1];
      if (h.length <= 4) h = h.replace(/./g, ch => ch + ch);
      return { r: parseInt(h.slice(0, 2), 16), g: parseInt(h.slice(2, 4), 16), b: parseInt(h.slice(4, 6), 16), a: h.length === 8 ? parseInt(h.slice(6, 8), 16) / 255 : 1 };
    }
    m = /^rgba?\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})\s*(?:,\s*(\d*\.?\d+)\s*)?\)$/.exec(t);
    if (m) {
      const r = +m[1], g = +m[2], b = +m[3], a = m[4] === undefined ? 1 : +m[4];
      if (r > 255 || g > 255 || b > 255 || !(a >= 0 && a <= 1)) return null;
      return { r, g, b, a };
    }
    return null;
  }
  // 顏色 → '#rrggbb'（小寫、忽略透明度）；看不懂回 null
  function colorKey(c) {
    const p = parseColor(c);
    return p ? '#' + hex2(p.r) + hex2(p.g) + hex2(p.b) : null;
  }
  // 列出一頁所有「顏色欄位」：{ get(), set(v), locked }，背景的 locked 一律是 false
  function colorSlots(page) {
    const out = [];
    const slot = (holder, key, locked) => out.push({ get: () => holder[key], set: v => { holder[key] = v; }, locked });
    const paint = (holder, key, locked) => {
      const v = holder[key];
      if (isObj(v)) { slot(v, 'from', locked); slot(v, 'to', locked); } else slot(holder, key, locked);
    };
    const bg = page.bg;
    if (isObj(bg)) {
      if (bg.type === 'solid') slot(bg, 'color', false);
      else if (bg.type === 'gradient' || bg.type === 'radial') { slot(bg, 'from', false); slot(bg, 'to', false); }
    }
    for (const o of page.objects) {
      // 看不見的顏色不列、也不換：描邊粗細 0、沒有位移也沒有模糊的陰影（預設值就是這樣，不然配色區會一直多一格黑）
      const strokeOn = o => isObj(o.stroke) && o.stroke.w > 0;
      const shadowOn = o => isObj(o.shadow) && (o.shadow.blur > 0 || o.shadow.x !== 0 || o.shadow.y !== 0);
      if (o.type === 'shape') { paint(o, 'fill', o.locked); if (strokeOn(o)) slot(o.stroke, 'color', o.locked); }
      else if (o.type === 'text') {
        paint(o, 'color', o.locked);
        if (strokeOn(o)) slot(o.stroke, 'color', o.locked);
        if (shadowOn(o)) slot(o.shadow, 'color', o.locked);
      }
    }
    return out;
  }
  function pagesOf(doc, pageId) {
    return pageId == null ? doc.pages : doc.pages.filter(p => p.id === pageId);
  }
  // 文件（或某一頁）用到的顏色與次數；次數多到少，同次數依色碼。隱藏與鎖定的物件也算；看不見的描邊與陰影不算
  function docColors(doc, { pageId } = {}) {
    const counts = new Map();
    for (const p of pagesOf(doc, pageId)) {
      for (const s of colorSlots(p)) {
        const k = colorKey(s.get());
        if (k) counts.set(k, (counts.get(k) || 0) + 1);
      }
    }
    return [...counts].map(([color, count]) => ({ color, count }))
      .sort((a, b) => b.count - a.count || (a.color < b.color ? -1 : a.color > b.color ? 1 : 0));
  }
  // 用 map 換色（key 與值都用 colorKey 正規化）；保留原本的透明度，鎖定物件不改。全有或全無。
  function recolor(doc, map, { pageId } = {}) {
    return tx(doc, d => {
      if (!isObj(map)) bail('換色的顏色對照表不正確');
      const table = new Map();
      for (const [from, to] of Object.entries(map)) {
        const fk = colorKey(from), tk = parseColor(to);
        if (!fk) bail(`看不懂要被換掉的顏色：${from}`);
        if (!tk) bail(`看不懂要換成的顏色：${to}`);
        table.set(fk, tk);
      }
      if (pageId != null && !d.pages.some(p => p.id === pageId)) bail('找不到頁面');
      let changed = 0, skippedLocked = 0;
      for (const p of pagesOf(d, pageId)) {
        for (const s of colorSlots(p)) {
          const cur = parseColor(s.get());
          if (!cur) continue;
          const to = table.get(colorKey(s.get()));
          if (!to) continue;
          if (s.locked) { skippedLocked++; continue; }
          s.set(cur.a >= 1 ? '#' + hex2(to.r) + hex2(to.g) + hex2(to.b) : `rgba(${to.r},${to.g},${to.b},${+cur.a.toFixed(4)})`);
          changed++;
        }
      }
      return { changed, skippedLocked };
    });
  }

  // =====================================================================================
  // 復原／重做
  // =====================================================================================
  const bus = typeof EventTarget === 'function' ? new EventTarget() : null;
  function emit(detail) {
    if (!bus) return;
    let e;
    if (typeof CustomEvent === 'function') e = new CustomEvent('change', { detail });
    else { e = new Event('change'); e.detail = detail; }
    bus.dispatchEvent(e);
  }

  // run(label, fn)：fn(doc) 回 { ok:false } 或丟錯時整個還原；有變動才記一筆復原。
  // 拖曳中用 begin(label) → 每次移動先 rewind() 再套用總位移 → 放開時 end()：整段只記一筆；cancel() 回到 begin 前。
  // 復原／重做會就地換掉 doc 的內容（doc 物件本身不變），再呼叫 setDoc(doc) 通知。
  // 資產只增不減：還原快照時，快照裡沒有、但目前文件有的資產會保留（Blob 不在復原範圍內）。
  function createHistory(getDoc, setDoc, opts = {}) {
    const limit = opts.limit || 100;
    let undoS = [], redoS = [], pending = null;
    const push = (label, snap) => { undoS.push({ label, snap }); if (undoS.length > limit) undoS.shift(); redoS = []; };
    function restore(snap) {
      const cur = getDoc(), next = deserialize(snap);
      if (cur && isObj(cur.assets) && isObj(next.assets)) {
        for (const [k, v] of Object.entries(cur.assets)) if (!(k in next.assets)) next.assets[k] = v;
      }
      if (cur && typeof cur === 'object') { replaceInPlace(cur, next); if (setDoc) setDoc(cur); } else if (setDoc) setDoc(next);
    }
    return {
      run(label, fn) {
        const before = serialize(getDoc());
        let r;
        try { r = fn(getDoc()); } catch (e) { if (serialize(getDoc()) !== before) restore(before); throw e; }
        if (r && r.ok === false) { if (serialize(getDoc()) !== before) restore(before); return r; }
        if (!pending && serialize(getDoc()) !== before) push(label, before);
        emit({ label });
        return r === undefined ? { ok: true } : r;
      },
      begin(label) { if (!pending) pending = { label, snap: serialize(getDoc()) }; },
      // 拖曳中回到 begin 時的狀態，但不結束 pending
      rewind() {
        if (!pending) return false;
        if (serialize(getDoc()) !== pending.snap) restore(pending.snap);
        return true;
      },
      end() {
        if (!pending) return false;
        const pd = pending; pending = null;
        const changed = serialize(getDoc()) !== pd.snap;
        if (changed) push(pd.label, pd.snap);
        emit({ label: pd.label });
        return changed;
      },
      cancel() {
        if (!pending) return;
        const pd = pending; pending = null;
        if (serialize(getDoc()) !== pd.snap) restore(pd.snap);
        emit({ label: pd.label, cancel: true });
      },
      undo() {
        if (pending || !undoS.length) return false;      // 拖曳中（begin 之後）不能復原
        const e = undoS.pop();
        redoS.push({ label: e.label, snap: serialize(getDoc()) });
        restore(e.snap);
        emit({ label: e.label, undo: true });
        return true;
      },
      redo() {
        if (pending || !redoS.length) return false;
        const e = redoS.pop();
        undoS.push({ label: e.label, snap: serialize(getDoc()) });
        restore(e.snap);
        emit({ label: e.label, redo: true });
        return true;
      },
      get busy() { return !!pending; },
      get canUndo() { return undoS.length > 0; },
      get canRedo() { return redoS.length > 0; },
      get undoLabel() { return undoS.length ? undoS[undoS.length - 1].label : ''; },
      get redoLabel() { return redoS.length ? redoS[redoS.length - 1].label : ''; },
      clear() { undoS = []; redoS = []; pending = null; },
    };
  }

  const api = {
    // 常數
    SIZES, SIDE_MIN, SIDE_MAX, MAX_PAGES, MAX_OBJECTS, DOC_VERSION, STICKERS, SNAP_PX,
    // 文件
    createDoc, defaults, validate, migrate, serialize, deserialize,
    // 頁面
    addPage, duplicatePage, removePage, movePage, setPageProps,
    // 資產
    addAsset, pruneAssets,
    // 物件
    addObject, updateObjects, removeObjects, duplicateObjects, pasteObjects, reorder, findObject,
    // 幾何
    corners, bounds, toLocal, hitTest, inRect, resizeRect, rotateAngle, snapCandidates, snapBox, align, distribute,
    // 顏色
    colorKey, docColors, recolor,
    // 復原
    createHistory, bus,
  };
  Q.core = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);

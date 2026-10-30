// 平面設計核心（design-core.js）的單元測試
const test = require('node:test');
const assert = require('node:assert');
const core = require('../design-core.js');

// ---- 共用工具 ----------------------------------------------------------------------
const P = doc => doc.pages[0].id;
const near = (a, b, msg, eps = 1e-6) => assert.ok(Math.abs(a - b) < eps, `${msg || ''} ${a} ≠ ${b}`);
function add(doc, partial, pageId) {
  const r = core.addObject(doc, pageId || P(doc), partial);
  assert.ok(r.ok, r.reason);
  return r.id;
}
const O = (doc, id) => core.findObject(doc, id).obj;
const order = doc => doc.pages[0].objects.map(o => o.id);

// 失敗時文件完全沒變，原因是繁中
function unchanged(doc, fn, re) {
  const before = core.serialize(doc);
  const r = fn();
  assert.strictEqual(r.ok, false, '應該要失敗');
  assert.match(r.reason, /[一-鿿]/, '原因要是中文：' + r.reason);
  if (re) assert.match(r.reason, re);
  assert.strictEqual(core.serialize(doc), before, '失敗時文件不能被改到');
  return r;
}
// 給 history 用的文件容器
function withHistory(opts) {
  const state = { doc: core.createDoc() };
  const h = core.createHistory(() => state.doc, d => { state.doc = d; }, opts);
  return { state, h };
}

// =====================================================================================
// Task 1：文件模型、編輯操作、不變式、復原、讀檔遷移
// =====================================================================================
test('常數', () => {
  assert.deepStrictEqual(core.SIZES['1:1'], [1080, 1080]);
  assert.deepStrictEqual(core.SIZES['4:5'], [1080, 1350]);
  assert.deepStrictEqual(core.SIZES['9:16'], [1080, 1920]);
  assert.deepStrictEqual(core.SIZES['16:9'], [1920, 1080]);
  assert.strictEqual(core.SIDE_MIN, 64);
  assert.strictEqual(core.SIDE_MAX, 4096);
  assert.strictEqual(core.MAX_PAGES, 20);
  assert.strictEqual(core.MAX_OBJECTS, 200);
  assert.strictEqual(core.DOC_VERSION, 1);
  assert.strictEqual(core.SNAP_PX, 6);
  assert.deepStrictEqual(core.STICKERS, ['angry', 'cry', 'kiss', 'laugh', 'meh', 'shock', 'smile']);
});

test('createDoc 預設一頁 1080×1080 白底', () => {
  const doc = core.createDoc();
  assert.strictEqual(doc.version, 1);
  assert.strictEqual(doc.pages.length, 1);
  assert.strictEqual(doc.pages[0].w, 1080);
  assert.strictEqual(doc.pages[0].h, 1080);
  assert.deepStrictEqual(doc.pages[0].bg, { type: 'solid', color: '#ffffff' });
  assert.deepStrictEqual(doc.assets, {});
  assert.strictEqual(core.validate(doc), null);
  const d2 = core.createDoc({ w: 1080, h: 1350 });
  assert.strictEqual(d2.pages[0].h, 1350);
});

test('defaults 各類型的預設值', () => {
  const t = core.defaults('text');
  assert.strictEqual(t.text, '輸入文字');
  assert.strictEqual(t.font, 'WHZ-Heavy');
  assert.strictEqual(t.size, 80);
  assert.deepStrictEqual(t.stroke, { w: 0, color: '#000000' });
  assert.deepStrictEqual(t.shadow, { x: 0, y: 0, blur: 0, color: 'rgba(0,0,0,0.5)' });
  assert.strictEqual(t.w, 800);
  assert.strictEqual(t.rot, 0);
  assert.strictEqual(t.opacity, 1);
  assert.strictEqual(t.locked, false);
  assert.strictEqual(t.hidden, false);
  assert.ok(!('id' in t) && !('x' in t) && !('y' in t));
  assert.deepStrictEqual(core.defaults('image').view, { ox: 0.5, oy: 0.5, scale: 1 });
  assert.strictEqual(core.defaults('shape').kind, 'rect');
  assert.strictEqual(core.defaults('sticker').w, 240);
  assert.strictEqual(core.defaults('mosaic').h, 200);
  // 每次都是新物件，改了不影響下一次
  t.stroke.w = 9;
  assert.strictEqual(core.defaults('text').stroke.w, 0);
});

test('addObject 給唯一 id、套用預設值', () => {
  const doc = core.createDoc();
  const ids = [add(doc, { type: 'text' }), add(doc, { type: 'shape', x: 10, y: 10 }), add(doc, { type: 'mosaic', x: 0, y: 0 })];
  assert.strictEqual(new Set(ids).size, 3);
  assert.deepStrictEqual(ids, ['o1', 'o2', 'o3']);
  for (const id of ids) assert.strictEqual(O(doc, id).opacity, 1);
  assert.strictEqual(O(doc, 'o1').font, 'WHZ-Heavy');
  // 第二頁的物件 id 也不跟第一頁重複
  const pg = core.addPage(doc, {});
  assert.ok(pg.ok);
  assert.strictEqual(add(doc, { type: 'text' }, pg.id), 'o4');
  // partial 的 stroke 做淺合併
  const s = add(doc, { type: 'shape', stroke: { w: 3 } });
  assert.deepStrictEqual(O(doc, s).stroke, { w: 3, color: '#000000' });
  // 沒給 x／y 時放在頁面中央
  const c = O(doc, s);
  near(c.x + c.w / 2, 540); near(c.y + c.h / 2, 540);
});

test('全有或全無', () => {
  // 第 201 個物件
  const doc = core.createDoc();
  for (let i = 0; i < 200; i++) add(doc, { type: 'shape', x: 0, y: 0 });
  unchanged(doc, () => core.addObject(doc, P(doc), { type: 'shape', x: 0, y: 0 }), /200/);

  // 第 21 頁
  const d2 = core.createDoc();
  for (let i = 0; i < 19; i++) assert.ok(core.addPage(d2, {}).ok);
  assert.strictEqual(d2.pages.length, 20);
  unchanged(d2, () => core.addPage(d2, {}), /20/);
  unchanged(d2, () => core.duplicatePage(d2, P(d2)), /20/);

  const d3 = core.createDoc();
  const id = add(d3, { type: 'shape', x: 0, y: 0 });
  const mid = add(d3, { type: 'mosaic', x: 0, y: 0 });
  unchanged(d3, () => core.updateObjects(d3, P(d3), [{ id, opacity: 1.5 }]), /透明度/);
  unchanged(d3, () => core.updateObjects(d3, P(d3), [{ id, w: 0 }]));
  unchanged(d3, () => core.addObject(d3, P(d3), { type: 'shape', w: 0 }));
  unchanged(d3, () => core.addObject(d3, P(d3), { type: 'image', asset: 'nope', w: 100, h: 100 }));
  unchanged(d3, () => core.updateObjects(d3, P(d3), [{ id: mid, rot: 30 }]), /馬賽克/);
  unchanged(d3, () => core.addObject(d3, P(d3), { type: 'mosaic', rot: 30 }), /馬賽克/);
  // 一批裡有一個壞的，整批都不套用
  unchanged(d3, () => core.updateObjects(d3, P(d3), [{ id, x: 50 }, { id: mid, opacity: -1 }]));
  unchanged(d3, () => core.setPageProps(d3, P(d3), { w: 63 }), /64/);
  unchanged(d3, () => core.setPageProps(d3, P(d3), { w: 4097 }), /4096/);
  unchanged(d3, () => core.setPageProps(d3, P(d3), { w: 100.5 }));
  unchanged(d3, () => core.removePage(d3, P(d3)), /至少/);
  unchanged(d3, () => core.addObject(d3, P(d3), { type: 'sticker', sticker: 'nope' }));
  unchanged(d3, () => core.addObject(d3, P(d3), { type: 'shape', kind: 'star' }));
  unchanged(d3, () => core.addObject(d3, P(d3), { type: 'video' }));
  unchanged(d3, () => core.addObject(d3, 'nope', { type: 'shape' }));
  unchanged(d3, () => core.updateObjects(d3, P(d3), [{ id: 'nope', x: 1 }]));
  unchanged(d3, () => core.updateObjects(d3, P(d3), [{ id, type: 'text' }]));
  unchanged(d3, () => core.removeObjects(d3, P(d3), ['nope']));
  assert.strictEqual(core.validate(d3), null);
});

test('頁面操作：新增、複製、移動、刪除、改屬性', () => {
  const doc = core.createDoc();
  const p1 = P(doc);
  add(doc, { type: 'text' });
  const a = core.addPage(doc, { w: 1080, h: 1920, index: 0 });
  assert.ok(a.ok);
  assert.strictEqual(doc.pages[0].id, a.id);
  assert.strictEqual(doc.pages[0].h, 1920);
  const dp = core.duplicatePage(doc, p1);
  assert.ok(dp.ok);
  assert.deepStrictEqual(doc.pages.map(p => p.id), [a.id, p1, dp.id]);
  const copyObj = doc.pages[2].objects[0];
  assert.notStrictEqual(copyObj.id, doc.pages[1].objects[0].id, '複製頁的物件要有新 id');
  assert.ok(core.movePage(doc, dp.id, 0).ok);
  assert.deepStrictEqual(doc.pages.map(p => p.id), [dp.id, a.id, p1]);
  assert.ok(core.movePage(doc, dp.id, 99).ok, '超出範圍時夾到最後');
  assert.deepStrictEqual(doc.pages.map(p => p.id), [a.id, p1, dp.id]);
  assert.ok(core.removePage(doc, a.id).ok);
  assert.strictEqual(doc.pages.length, 2);
  assert.ok(core.setPageProps(doc, p1, { w: 1920, h: 1080, bg: { type: 'gradient', from: '#000000', to: '#ffffff', angle: 90 } }).ok);
  const pg = doc.pages.find(p => p.id === p1);
  assert.strictEqual(pg.w, 1920);
  assert.strictEqual(pg.bg.type, 'gradient');
  unchanged(doc, () => core.setPageProps(doc, p1, { bg: { type: 'image', asset: 'nope', fit: 'cover', view: { ox: 0.5, oy: 0.5, scale: 1 } } }));
  unchanged(doc, () => core.setPageProps(doc, p1, { bg: { type: 'weird' } }));
  assert.strictEqual(core.validate(doc), null);
});

test('鎖定的物件不能移動但能解鎖', () => {
  const doc = core.createDoc();
  const id = add(doc, { type: 'shape', x: 10, y: 10 });
  const other = add(doc, { type: 'shape', x: 10, y: 10 });
  assert.ok(core.updateObjects(doc, P(doc), [{ id, locked: true }]).ok);
  unchanged(doc, () => core.updateObjects(doc, P(doc), [{ id, x: 50 }]), /物件已鎖定/);
  unchanged(doc, () => core.removeObjects(doc, P(doc), [id]), /物件已鎖定/);
  unchanged(doc, () => core.reorder(doc, P(doc), [id], 'top'), /物件已鎖定/);
  unchanged(doc, () => core.align(doc, P(doc), [id], 'left'), /物件已鎖定/);
  assert.ok(core.updateObjects(doc, P(doc), [{ id, hidden: true }]).ok, '鎖定時仍可隱藏');
  assert.ok(core.updateObjects(doc, P(doc), [{ id, hidden: false, locked: false }]).ok, '可以解鎖');
  assert.ok(core.updateObjects(doc, P(doc), [{ id, x: 50 }]).ok);
  assert.strictEqual(O(doc, id).x, 50);
  assert.ok(other);
});

test('updateObjects 淺合併 stroke／shadow／view', () => {
  const doc = core.createDoc();
  const id = add(doc, { type: 'text' });
  assert.ok(core.updateObjects(doc, P(doc), [{ id, stroke: { w: 4 }, shadow: { blur: 8 } }]).ok);
  assert.deepStrictEqual(O(doc, id).stroke, { w: 4, color: '#000000' });
  assert.deepStrictEqual(O(doc, id).shadow, { x: 0, y: 0, blur: 8, color: 'rgba(0,0,0,0.5)' });
});

test('duplicateObjects 位移 20 且 id 不同', () => {
  const doc = core.createDoc();
  const id = add(doc, { type: 'shape', x: 100, y: 200 });
  const r = core.duplicateObjects(doc, P(doc), [id]);
  assert.ok(r.ok);
  assert.strictEqual(r.ids.length, 1);
  assert.notStrictEqual(r.ids[0], id);
  const c = O(doc, r.ids[0]);
  assert.strictEqual(c.x, 120);
  assert.strictEqual(c.y, 220);
  assert.deepStrictEqual(order(doc), [id, r.ids[0]], '副本放在最上層');
  const r2 = core.duplicateObjects(doc, P(doc), [id], { dx: 0, dy: 5 });
  assert.strictEqual(O(doc, r2.ids[0]).y, 205);
});

test('pasteObjects 給新 id 並位移', () => {
  const doc = core.createDoc();
  const id = add(doc, { type: 'shape', x: 100, y: 100 });
  const clip = [JSON.parse(JSON.stringify(O(doc, id)))];
  const r = core.pasteObjects(doc, P(doc), clip);
  assert.ok(r.ok);
  assert.notStrictEqual(r.ids[0], id);
  assert.strictEqual(O(doc, r.ids[0]).x, 120);
  // 貼到別頁
  const pg = core.addPage(doc, {});
  const r2 = core.pasteObjects(doc, pg.id, clip, { dx: 0, dy: 0 });
  assert.ok(r2.ok);
  assert.strictEqual(O(doc, r2.ids[0]).x, 100);
  assert.strictEqual(new Set([id, r.ids[0], r2.ids[0]]).size, 3);
  // 指向不存在資產的圖片不能貼
  unchanged(doc, () => core.pasteObjects(doc, P(doc), [{ type: 'image', asset: 'a9', x: 0, y: 0, w: 10, h: 10 }]));
});

test('reorder top/bottom/up/down 後的 objects 順序', () => {
  const doc = core.createDoc();
  const [a, b, c, d] = [0, 1, 2, 3].map(() => add(doc, { type: 'shape', x: 0, y: 0 }));
  assert.ok(core.reorder(doc, P(doc), [a], 'top').ok);
  assert.deepStrictEqual(order(doc), [b, c, d, a]);
  assert.ok(core.reorder(doc, P(doc), [a], 'bottom').ok);
  assert.deepStrictEqual(order(doc), [a, b, c, d]);
  assert.ok(core.reorder(doc, P(doc), [a], 'up').ok);
  assert.deepStrictEqual(order(doc), [b, a, c, d]);
  assert.ok(core.reorder(doc, P(doc), [c], 'down').ok);
  assert.deepStrictEqual(order(doc), [b, c, a, d]);
  // 多選時保持相對順序
  assert.ok(core.reorder(doc, P(doc), [b, a], 'top').ok);
  assert.deepStrictEqual(order(doc), [c, d, b, a]);
  assert.ok(core.reorder(doc, P(doc), [b, a], 'up').ok, '已經在最上面，不動也算成功');
  assert.deepStrictEqual(order(doc), [c, d, b, a]);
  assert.ok(core.reorder(doc, P(doc), [c, b], 'up').ok);
  assert.deepStrictEqual(order(doc), [d, c, a, b]);
  unchanged(doc, () => core.reorder(doc, P(doc), [a], 'sideways'));
});

test('findObject', () => {
  const doc = core.createDoc();
  const id = add(doc, { type: 'shape' });
  const f = core.findObject(doc, id);
  assert.strictEqual(f.page, doc.pages[0]);
  assert.strictEqual(f.index, 0);
  assert.strictEqual(f.obj.id, id);
  assert.strictEqual(core.findObject(doc, 'nope'), null);
});

test('validate 抓出各種壞資料', () => {
  const good = () => {
    const d = core.createDoc();
    add(d, { type: 'text' });
    return d;
  };
  const bad = (mut, re) => {
    const d = good();
    mut(d);
    const why = core.validate(d);
    assert.ok(typeof why === 'string', '應該要有原因');
    assert.match(why, /[一-鿿]/);
    if (re) assert.match(why, re);
  };
  bad(d => { d.pages[0].objects.push(Object.assign({}, d.pages[0].objects[0])); }, /重複/);
  bad(d => { d.pages[0].objects[0].type = 'video'; });
  bad(d => { d.pages[0].objects[0].h = -1; });
  bad(d => { d.pages[0].w = 1000.5; });
  bad(d => { d.pages = []; }, /至少/);
  bad(d => { d.pages[0].objects[0].align = 'justify'; });
  bad(d => { d.pages[0].objects.push(Object.assign(core.defaults('sticker'), { id: 'o9', type: 'sticker', x: 0, y: 0, sticker: 'heart' })); });
});

test('addAsset 依序給 id、pruneAssets 只刪沒被引用的', () => {
  const doc = core.createDoc();
  const a1 = core.addAsset(doc, { name: 'a.png', w: 100, h: 50, mime: 'image/png' });
  const a2 = core.addAsset(doc, { name: 'b.png', w: 100, h: 50, mime: 'image/png' });
  const a3 = core.addAsset(doc, { name: 'c.png', w: 100, h: 50, mime: 'image/png' });
  assert.deepStrictEqual([a1.id, a2.id, a3.id], ['a1', 'a2', 'a3']);
  unchanged(doc, () => core.addAsset(doc, { name: 'x', w: 0, h: 50, mime: 'image/png' }));
  add(doc, { type: 'image', asset: 'a1', x: 0, y: 0, w: 100, h: 50 });
  assert.ok(core.setPageProps(doc, P(doc), { bg: { type: 'image', asset: 'a3', fit: 'cover', view: { ox: 0.5, oy: 0.5, scale: 1 } } }).ok);
  const removed = core.pruneAssets(doc);
  assert.deepStrictEqual(removed, ['a2']);
  assert.deepStrictEqual(Object.keys(doc.assets).sort(), ['a1', 'a3']);
  // 已存在的 id 會跳過
  const a4 = core.addAsset(doc, { name: 'd.png', w: 10, h: 10, mime: 'image/png' });
  assert.strictEqual(a4.id, 'a4');
});

test('serialize／deserialize 來回一致', () => {
  const doc = core.createDoc();
  add(doc, { type: 'text', text: '你好' });
  const s = core.serialize(doc);
  assert.strictEqual(typeof s, 'string');
  assert.deepStrictEqual(core.deserialize(s), doc);
});

test('復原重做', () => {
  const { state, h } = withHistory();
  const init = core.serialize(state.doc);
  assert.strictEqual(h.canUndo, false);
  h.run('加文字', d => core.addObject(d, d.pages[0].id, { type: 'text' }));
  const after1 = core.serialize(state.doc);
  h.run('加形狀', d => core.addObject(d, d.pages[0].id, { type: 'shape' }));
  assert.strictEqual(state.doc.pages[0].objects.length, 2);
  assert.strictEqual(h.undo(), true);
  assert.strictEqual(h.undo(), true);
  assert.strictEqual(core.serialize(state.doc), init);
  assert.strictEqual(h.undo(), false);
  assert.strictEqual(h.redo(), true);
  assert.strictEqual(core.serialize(state.doc), after1);
  assert.strictEqual(h.canRedo, true);
  // 失敗的操作不記一筆，也不清掉重做
  const r = h.run('壞的', d => core.updateObjects(d, d.pages[0].id, [{ id: 'nope', x: 1 }]));
  assert.strictEqual(r.ok, false);
  assert.strictEqual(h.canRedo, true);
  h.clear();
  assert.strictEqual(h.canUndo, false);
});

test('拖曳合併', () => {
  const { state, h } = withHistory();
  const pid = state.doc.pages[0].id;
  h.run('加形狀', d => core.addObject(d, pid, { type: 'shape', x: 0, y: 0 }));
  const id = state.doc.pages[0].objects[0].id;
  const before = core.serialize(state.doc);
  h.begin('移動');
  assert.strictEqual(h.busy, true);
  assert.strictEqual(h.undo(), false, '拖曳中不能復原');
  assert.strictEqual(h.redo(), false);
  for (let i = 1; i <= 5; i++) {
    h.rewind();
    assert.strictEqual(core.findObject(state.doc, id).obj.x, 0, 'rewind 回到 begin 時的位置');
    assert.ok(core.updateObjects(state.doc, pid, [{ id, x: i * 10 }]).ok);
  }
  assert.strictEqual(h.busy, true, 'rewind 不結束 pending');
  assert.strictEqual(core.findObject(state.doc, id).obj.x, 50);
  assert.strictEqual(h.end(), true);
  assert.strictEqual(h.busy, false);
  assert.strictEqual(h.undo(), true);
  assert.strictEqual(core.serialize(state.doc), before, 'undo 一次就回到拖曳前');
  assert.strictEqual(h.undo(), true, '下一筆是加形狀');

  // cancel 回到 begin 前
  h.redo();
  const b2 = core.serialize(state.doc);
  h.begin('移動');
  h.rewind();
  core.updateObjects(state.doc, pid, [{ id, x: 999 }]);
  h.cancel();
  assert.strictEqual(h.busy, false);
  assert.strictEqual(core.serialize(state.doc), b2);
  assert.strictEqual(h.rewind(), false, '沒有 pending 時 rewind 不做事');
});

test('復原上限 100', () => {
  const { h } = withHistory();
  for (let i = 0; i < 105; i++) h.run('移', d => core.setPageProps(d, d.pages[0].id, { w: 100 + i }));
  let n = 0;
  while (h.undo()) n++;
  assert.strictEqual(n, 100);
  const { h: h2 } = withHistory({ limit: 3 });
  for (let i = 0; i < 5; i++) h2.run('移', d => core.setPageProps(d, d.pages[0].id, { w: 100 + i }));
  n = 0;
  while (h2.undo()) n++;
  assert.strictEqual(n, 3);
});

test('復原不會拿掉之後才加的資產（資產只增不減）', () => {
  const { state, h } = withHistory();
  h.run('加形狀', d => core.addObject(d, d.pages[0].id, { type: 'shape' }));
  const a = core.addAsset(state.doc, { name: 'a.png', w: 10, h: 10, mime: 'image/png' });
  h.run('加圖片', d => core.addObject(d, d.pages[0].id, { type: 'image', asset: a.id, w: 10, h: 10 }));
  h.undo();
  h.undo();
  assert.ok(state.doc.assets[a.id], '資產還在');
  assert.strictEqual(h.redo(), true);
  assert.strictEqual(h.redo(), true);
  assert.strictEqual(core.validate(state.doc), null);
});

test('migrate 拒絕較新版本', () => {
  const doc = core.createDoc();
  const raw = JSON.parse(core.serialize(doc));
  raw.version = 2;
  const r = core.migrate(raw);
  assert.strictEqual(r.ok, false);
  assert.match(r.reason, /較新版本/);
});

test('migrate 拒絕壞資料', () => {
  for (const raw of [null, {}, { version: 1, pages: 'x' }, { version: 1, pages: [] }, 'abc', [1, 2],
    { version: 1, pages: [{ id: 'p1', w: 1080, h: 1080, objects: [{ id: 'o1', type: 'video', x: 0, y: 0, w: 1, h: 1 }] }] },
    { version: 1, pages: [{ id: 'p1', w: 1080, h: 1080, objects: [{ id: 'o1', type: 'image', asset: 'zz', x: 0, y: 0, w: 1, h: 1 }] }] },
  ]) {
    const r = core.migrate(raw);
    assert.strictEqual(r.ok, false, JSON.stringify(raw));
    assert.match(r.reason, /[一-鿿]/);
  }
});

test('migrate 補齊缺欄位', () => {
  const raw = { version: 1, pages: [{ id: 'p1', w: 1080, h: 1080, objects: [{ id: 'o1', type: 'text', x: 10, y: 20, w: 300, h: 100 }] }] };
  const snap = JSON.stringify(raw);
  const r = core.migrate(raw);
  assert.ok(r.ok, r.reason);
  const o = r.doc.pages[0].objects[0];
  assert.strictEqual(o.font, 'WHZ-Heavy');
  assert.strictEqual(o.x, 10);
  assert.strictEqual(o.w, 300);
  assert.deepStrictEqual(o.stroke, { w: 0, color: '#000000' });
  assert.deepStrictEqual(r.doc.pages[0].bg, { type: 'solid', color: '#ffffff' });
  assert.deepStrictEqual(r.doc.assets, {});
  assert.strictEqual(JSON.stringify(raw), snap, '不能改到傳進來的物件');
  assert.strictEqual(core.validate(r.doc), null);
  // 部分的 stroke 也補齊
  const r2 = core.migrate({ version: 1, pages: [{ id: 'p1', w: 1080, h: 1080, objects: [{ id: 'o1', type: 'shape', x: 0, y: 0, w: 10, h: 10, stroke: { w: 2 } }] }] });
  assert.deepStrictEqual(r2.doc.pages[0].objects[0].stroke, { w: 2, color: '#000000' });
  // 序列化後的文件 migrate 回來一樣
  const doc = core.createDoc();
  add(doc, { type: 'text' });
  const r3 = core.migrate(JSON.parse(core.serialize(doc)));
  assert.deepStrictEqual(r3.doc, doc);
});

// =====================================================================================
// Task 2：幾何——命中、框選、變形、吸附、對齊
// =====================================================================================
const box = (x, y, w, h, extra) => Object.assign({ id: 'b', type: 'shape', x, y, w, h, rot: 0, hidden: false }, extra);
const page = (objects, w = 1080, h = 1080) => ({ id: 'p1', w, h, objects });

test('corners、bounds、toLocal', () => {
  const o = box(0, 0, 200, 20);
  assert.deepStrictEqual(core.corners(o).map(p => [p.x, p.y]), [[0, 0], [200, 0], [200, 20], [0, 20]]);
  const r = box(0, 0, 200, 20, { rot: 90 });
  const c = core.corners(r);
  // 順時針轉 90°：原本的左上角跑到右上
  near(c[0].x, 110); near(c[0].y, -90);
  near(c[2].x, 90); near(c[2].y, 110);
  const b = core.bounds(r);
  near(b.x, 90); near(b.y, -90); near(b.w, 20); near(b.h, 200);
  const l = core.toLocal(r, 110, -90);
  near(l.x, 0); near(l.y, 0);
});

test('hitTest 取最上層、略過隱藏', () => {
  const pg = page([box(0, 0, 100, 100, { id: 'a' }), box(50, 50, 100, 100, { id: 'b' }), box(60, 60, 10, 10, { id: 'c', hidden: true }), box(500, 500, 10, 10, { id: 'd', locked: true })]);
  assert.strictEqual(core.hitTest(pg, 65, 65), 'b');
  assert.strictEqual(core.hitTest(pg, 10, 10), 'a');
  assert.strictEqual(core.hitTest(pg, 300, 300), null);
  assert.strictEqual(core.hitTest(pg, 505, 505), 'd', '鎖定的仍可點到');
});

test('hitTest 考慮旋轉', () => {
  const pg = page([box(0, 0, 200, 20, { id: 'r', rot: 90 })]);
  assert.strictEqual(core.hitTest(pg, 100, 90), 'r');
  assert.strictEqual(core.hitTest(pg, 190, 10), null);
  // 轉 45° 的方塊：外接矩形角落的空白處點不到
  const pg2 = page([box(0, 0, 100, 100, { id: 's', rot: 45 })]);
  const bb = core.bounds(pg2.objects[0]);
  assert.strictEqual(core.hitTest(pg2, bb.x + 3, bb.y + 3), null);
  assert.strictEqual(core.hitTest(pg2, 50, 50), 's');
});

test('inRect 只選完全在框內的', () => {
  const pg = page([box(10, 10, 50, 50, { id: 'a' }), box(80, 80, 50, 50, { id: 'b' }), box(20, 20, 10, 10, { id: 'c', hidden: true }), box(0, 0, 50, 10, { id: 'r', rot: 90 })]);
  assert.deepStrictEqual(core.inRect(pg, { x: 0, y: 0, w: 100, h: 100 }), ['a']);
  assert.deepStrictEqual(core.inRect(pg, { x: 0, y: -50, w: 200, h: 200 }).sort(), ['a', 'b', 'r']);
});

test('resizeRect 未旋轉 se 拉 (50,30)', () => {
  const o = box(100, 100, 200, 100);
  const r = core.resizeRect(o, 'se', 50, 30);
  near(r.x, 100); near(r.y, 100); near(r.w, 250); near(r.h, 130);
  const n = core.resizeRect(o, 'nw', 50, 30);
  near(n.x, 150); near(n.y, 130); near(n.w, 150); near(n.h, 70);
  const e = core.resizeRect(o, 'e', 40, 999);
  near(e.x, 100); near(e.y, 100); near(e.w, 240); near(e.h, 100);
  const nn = core.resizeRect(o, 'n', 999, -20);
  near(nn.y, 80); near(nn.h, 120); near(nn.w, 200);
});

test('resizeRect 旋轉 90° 時拖 se，nw 角的頁面位置不變', () => {
  const o = box(100, 100, 200, 60, { rot: 90 });
  const before = core.corners(o)[0];
  const r = core.resizeRect(o, 'se', -30, 40);
  const after = core.corners(Object.assign({}, o, r))[0];
  near(after.x, before.x, 'x', 1e-6); near(after.y, before.y, 'y', 1e-6);
  // 轉 90° 時，頁面上往下拉 40 等於物件寬度 +40；往左拉 30 等於高度 +30
  near(r.w, 240); near(r.h, 90);
  // 任意角度、任意把手：對角固定
  const opp = { nw: 2, n: null, ne: 3, e: null, se: 0, s: null, sw: 1, w: null };
  for (const rot of [0, 30, 135, 270]) {
    const q = box(50, 80, 120, 70, { rot });
    for (const hd of ['nw', 'ne', 'se', 'sw']) {
      const before2 = core.corners(q)[opp[hd]];
      const res = core.resizeRect(q, hd, 17, -11, { keepRatio: rot === 135 });
      const after2 = core.corners(Object.assign({}, q, res))[opp[hd]];
      near(after2.x, before2.x, `${rot} ${hd} x`); near(after2.y, before2.y, `${rot} ${hd} y`);
    }
  }
});

test('resizeRect keepRatio 維持比例', () => {
  const o = box(0, 0, 200, 100);
  const r = core.resizeRect(o, 'se', 100, 0, { keepRatio: true });
  near(r.w / r.h, 2);
  assert.ok(r.w > 200);
  near(r.x, 0); near(r.y, 0);
  const r2 = core.resizeRect(o, 'se', 200, 100, { keepRatio: true });
  near(r2.w, 400); near(r2.h, 200);
  const r3 = core.resizeRect(o, 'e', 100, 0, { keepRatio: true });
  near(r3.w, 300); near(r3.h, 150);
  near(r3.y + r3.h / 2, 50, '邊把手等比時，垂直中線不動');
});

test('resizeRect 不小於 minSize', () => {
  const o = box(100, 100, 200, 100);
  const r = core.resizeRect(o, 'se', -500, -500);
  near(r.w, 8); near(r.h, 8);
  near(r.x, 100); near(r.y, 100);
  const r2 = core.resizeRect(o, 'nw', 500, 500, { minSize: 20 });
  near(r2.w, 20); near(r2.h, 20);
  near(r2.x + r2.w, 300); near(r2.y + r2.h, 200, '左上把手縮到底時，右下角不動');
  const r3 = core.resizeRect(o, 'se', -500, -500, { keepRatio: true, minSize: 10 });
  near(r3.h, 10); near(r3.w, 20);
});

test('rotateAngle step 15', () => {
  const o = box(0, 0, 100, 100); // 中心 (50,50)
  near(core.rotateAngle(o, 50, 0), 0);
  near(core.rotateAngle(o, 100, 50), 90);
  near(core.rotateAngle(o, 50, 100), 180);
  near(core.rotateAngle(o, 0, 50), 270);
  const t = 22 * Math.PI / 180;
  const px = 50 + 40 * Math.sin(t), py = 50 - 40 * Math.cos(t);
  near(core.rotateAngle(o, px, py), 22);
  assert.strictEqual(core.rotateAngle(o, px, py, { step: 15 }), 15);
  const t2 = -4 * Math.PI / 180;
  assert.strictEqual(core.rotateAngle(o, 50 + 40 * Math.sin(t2), 50 - 40 * Math.cos(t2), { step: 15 }), 0, '359.x 吸到 0 而不是 360');
});

test('snapCandidates', () => {
  const pg = page([box(100, 200, 50, 60, { id: 'a' }), box(0, 0, 10, 10, { id: 'me' }), box(300, 300, 10, 10, { id: 'h', hidden: true })], 1000, 800);
  const c = core.snapCandidates(pg, ['me']);
  for (const v of [0, 500, 1000, 100, 125, 150]) assert.ok(c.xs.includes(v), 'xs 少了 ' + v);
  for (const v of [0, 400, 800, 200, 230, 260]) assert.ok(c.ys.includes(v), 'ys 少了 ' + v);
  assert.ok(!c.xs.includes(5), '排除自己');
  assert.ok(!c.xs.includes(305), '排除隱藏的');
});

test('snapBox 在門檻內吸到頁面中心', () => {
  const cands = core.snapCandidates(page([]), []);
  const r = core.snapBox({ x: 543 - 50, y: 300, w: 100, h: 100 }, cands, { zoom: 1 });
  assert.strictEqual(r.dx, -3);
  assert.strictEqual(r.dy, 0);
  assert.ok(r.lines.some(l => l.axis === 'x' && l.pos === 540));
  assert.ok(!r.lines.some(l => l.axis === 'y'));
  // 同一個修正量對齊到的線都列出來
  const r2 = core.snapBox({ x: 2, y: 0, w: 540, h: 10 }, cands, { zoom: 1 });
  assert.strictEqual(r2.dx, -2);
  const xs = r2.lines.filter(l => l.axis === 'x').map(l => l.pos).sort((a, b) => a - b);
  assert.deepStrictEqual(xs, [0, 540]);
});

test('snapBox 門檻隨縮放換算', () => {
  // 門檻是螢幕像素：頁面門檻＝6／zoom。差 8 頁面像素：zoom 1（8 螢幕像素）不吸；縮小到 0.5（4 螢幕像素）會吸；放大到 2 更不吸。
  const cands = { xs: [540], ys: [] };
  const b = { x: 548, y: 0, w: 0, h: 0 };
  assert.strictEqual(core.snapBox(b, cands, { zoom: 1 }).dx, 0);
  assert.strictEqual(core.snapBox(b, cands, { zoom: 0.5 }).dx, -8);
  assert.strictEqual(core.snapBox(b, cands, { zoom: 2 }).dx, 0);
  assert.strictEqual(core.snapBox({ x: 544, y: 0, w: 0, h: 0 }, cands, { zoom: 2 }).dx, 0, '4 頁面像素＝8 螢幕像素，不吸');
  assert.strictEqual(core.snapBox({ x: 542, y: 0, w: 0, h: 0 }, cands, { zoom: 2 }).dx, -2);
  assert.strictEqual(core.snapBox(b, cands, { zoom: 1, threshold: 10 }).dx, -8);
  assert.deepStrictEqual(core.snapBox(b, cands, { zoom: 1 }).lines, []);
});

test('align 單一物件對齊頁面右邊', () => {
  const doc = core.createDoc();
  const id = add(doc, { type: 'shape', x: 10, y: 10, w: 100, h: 50 });
  assert.ok(core.align(doc, P(doc), [id], 'right').ok);
  assert.strictEqual(O(doc, id).x, 980);
  assert.ok(core.align(doc, P(doc), [id], 'vcenter').ok);
  assert.strictEqual(O(doc, id).y, 515);
  // 旋轉過的物件以 bounds 對齊
  const r = add(doc, { type: 'shape', x: 0, y: 0, w: 200, h: 20, rot: 90 });
  assert.ok(core.align(doc, P(doc), [r], 'left').ok);
  near(core.bounds(O(doc, r)).x, 0);
  // 多個時對齊整個選取範圍
  const a = add(doc, { type: 'shape', x: 100, y: 100, w: 50, h: 50 });
  const b = add(doc, { type: 'shape', x: 300, y: 400, w: 80, h: 50 });
  assert.ok(core.align(doc, P(doc), [a, b], 'left').ok);
  assert.strictEqual(O(doc, b).x, 100);
  assert.ok(core.align(doc, P(doc), [a, b], 'bottom').ok);
  assert.strictEqual(O(doc, a).y, 400);
  assert.ok(core.align(doc, P(doc), [a, b], 'hcenter').ok);
  near(O(doc, a).x + 25, O(doc, b).x + 40);
  unchanged(doc, () => core.align(doc, P(doc), [], 'left'));
  unchanged(doc, () => core.align(doc, P(doc), [a], 'middle'));
});

test('distribute 三個物件間距相等', () => {
  const doc = core.createDoc();
  const a = add(doc, { type: 'shape', x: 0, y: 0, w: 100, h: 10 });
  const c = add(doc, { type: 'shape', x: 500, y: 0, w: 100, h: 10 });
  const b = add(doc, { type: 'shape', x: 120, y: 0, w: 60, h: 10 });
  assert.ok(core.distribute(doc, P(doc), [a, b, c], 'h').ok);
  const [A, B, C] = [a, b, c].map(id => O(doc, id));
  assert.strictEqual(A.x, 0);
  assert.strictEqual(C.x, 500);
  near(B.x - (A.x + A.w), C.x - (B.x + B.w));
  // 垂直
  const d2 = core.createDoc();
  const ids = [[0, 30], [100, 10], [400, 50], [250, 20]].map(([y, h]) => add(d2, { type: 'shape', x: 0, y, w: 10, h }));
  assert.ok(core.distribute(d2, P(d2), ids, 'v').ok);
  const objs = ids.map(id => O(d2, id)).sort((p, q) => p.y - q.y);
  const gaps = objs.slice(1).map((o, i) => o.y - (objs[i].y + objs[i].h));
  for (const g of gaps) near(g, gaps[0]);
});

test('distribute 少於 3 個回 ok:false', () => {
  const doc = core.createDoc();
  const a = add(doc, { type: 'shape', x: 0, y: 0 });
  const b = add(doc, { type: 'shape', x: 300, y: 0 });
  unchanged(doc, () => core.distribute(doc, P(doc), [a, b], 'h'), /至少 3 個/);
});

// =====================================================================================
// 漸層填色、重新著色、弧形文字（規格 2026-10-30-design-paint-recolor-arc）
// =====================================================================================
const LIN = { type: 'linear', from: '#ff0000', to: '#0000ff', angle: 90 };
const RAD = { type: 'radial', from: '#ffffff', to: '#000000', cx: 0.5, cy: 0.5, r: 1 };

test('paint：形狀填色接受純色、線性、放射漸層', () => {
  const doc = core.createDoc();
  const id = add(doc, { type: 'shape', fill: LIN });
  assert.deepStrictEqual(O(doc, id).fill, LIN);
  assert.ok(core.updateObjects(doc, P(doc), { id, fill: RAD }).ok);
  assert.deepStrictEqual(O(doc, id).fill, RAD);
  assert.ok(core.updateObjects(doc, P(doc), { id, fill: '#123456' }).ok);
  assert.ok(core.updateObjects(doc, P(doc), { id, fill: { type: 'radial', from: '#fff', to: '#000' } }).ok, 'cx／cy／r 可省略（用預設）');
  assert.strictEqual(core.validate(doc), null);
});

test('paint：不合法的形狀填色被擋下且文件不變', () => {
  const doc = core.createDoc();
  const id = add(doc, { type: 'shape' });
  const bad = [
    { type: 'conic', from: '#fff', to: '#000' },
    { type: 'linear', from: '#fff', to: '#000' },                       // 少 angle
    { type: 'linear', from: '#fff', to: '#000', angle: NaN },
    { type: 'linear', from: '', to: '#000', angle: 0 },
    { type: 'linear', from: 1, to: '#000', angle: 0 },
    { type: 'radial', from: '#fff', to: '#000', cx: 1.5 },
    { type: 'radial', from: '#fff', to: '#000', cy: -0.1 },
    { type: 'radial', from: '#fff', to: '#000', r: 0.01 },
    { type: 'radial', from: '#fff', to: '#000', r: 2.5 },
    { type: 'radial', from: '#fff', to: '#000', r: 'x' },
    [LIN], null, 5, '',
  ];
  for (const f of bad) unchanged(doc, () => core.updateObjects(doc, P(doc), { id, fill: f }));
  unchanged(doc, () => core.addObject(doc, P(doc), { type: 'shape', fill: bad[0] }));
});

test('paint：文字顏色可用漸層，壞的被擋下', () => {
  const doc = core.createDoc();
  const id = add(doc, { type: 'text', color: LIN });
  assert.ok(core.updateObjects(doc, P(doc), { id, color: RAD }).ok);
  unchanged(doc, () => core.updateObjects(doc, P(doc), { id, color: { type: 'linear', from: '#fff', to: '#000', angle: Infinity } }));
  unchanged(doc, () => core.updateObjects(doc, P(doc), { id, color: { type: 'radial', from: '#fff', to: '#000', r: 3 } }));
  unchanged(doc, () => core.updateObjects(doc, P(doc), { id, color: {} }));
});

test('paint：stroke.color、shadow.color 仍須是純色字串', () => {
  const doc = core.createDoc();
  const t = add(doc, { type: 'text' });
  const s = add(doc, { type: 'shape' });
  unchanged(doc, () => core.updateObjects(doc, P(doc), { id: t, stroke: { color: LIN } }));
  unchanged(doc, () => core.updateObjects(doc, P(doc), { id: t, shadow: { color: LIN } }));
  unchanged(doc, () => core.updateObjects(doc, P(doc), { id: s, stroke: { color: RAD } }));
  const line = add(doc, { type: 'shape', kind: 'line' });
  unchanged(doc, () => core.updateObjects(doc, P(doc), { id: line, fill: LIN }), /填色/);
});

test('背景新增 radial，舊的 gradient 仍可用', () => {
  const doc = core.createDoc();
  const bgs = [RAD, { type: 'gradient', from: '#fff', to: '#000', angle: 180 }, { type: 'radial', from: '#fff', to: '#000' }];
  for (const bg of bgs) assert.ok(core.setPageProps(doc, P(doc), { bg }).ok);
  unchanged(doc, () => core.setPageProps(doc, P(doc), { bg: { type: 'radial', from: '#fff', to: '#000', r: 5 } }), /背景/);
  unchanged(doc, () => core.setPageProps(doc, P(doc), { bg: { type: 'radial', from: '#fff', cx: 0.5 } }), /背景/);
  unchanged(doc, () => core.setPageProps(doc, P(doc), { bg: { type: 'radial', from: '#fff', to: '#000', cx: 2 } }), /背景/);
});

test('migrate：舊檔純色原樣保留、文字補上 arc:0，新檔漸層保留', () => {
  const old = { version: 1, pages: [{ id: 'p1', w: 100, h: 100, objects: [
    { id: 'o1', type: 'text', x: 0, y: 0, w: 50, h: 50, text: 'a', color: '#abcdef' },
    { id: 'o2', type: 'shape', x: 0, y: 0, w: 50, h: 50, fill: LIN },
  ] }] };
  const r = core.migrate(old);
  assert.ok(r.ok, r.reason);
  const objs = r.doc.pages[0].objects;
  assert.strictEqual(objs[0].color, '#abcdef');
  assert.strictEqual(objs[0].arc, 0);
  assert.deepStrictEqual(objs[1].fill, LIN);
  assert.strictEqual(r.doc.version, core.DOC_VERSION);
  const bad = core.migrate({ version: 1, pages: [{ id: 'p1', w: 100, h: 100, objects: [{ id: 'o1', type: 'shape', x: 0, y: 0, w: 5, h: 5, fill: { type: 'x' } }] }] });
  assert.strictEqual(bad.ok, false);
  assert.match(bad.reason, /[一-鿿]/);
});

test('text.arc：預設 0，範圍 −360～360', () => {
  assert.strictEqual(core.defaults('text').arc, 0);
  const doc = core.createDoc();
  const id = add(doc, { type: 'text' });
  assert.strictEqual(O(doc, id).arc, 0);
  for (const v of [360, -360, 0, 90.5, -1]) { assert.ok(core.updateObjects(doc, P(doc), { id, arc: v }).ok, String(v)); assert.strictEqual(O(doc, id).arc, v); }
  for (const v of [361, -360.5, NaN, Infinity, '90', null]) {
    unchanged(doc, () => core.updateObjects(doc, P(doc), { id, arc: v }), /弧/);
  }
});

test('colorKey：解析 #rgb／#rrggbb／rgb()／rgba()，忽略透明度', () => {
  assert.strictEqual(core.colorKey('#ABC'), '#aabbcc');
  assert.strictEqual(core.colorKey('#2F6FED'), '#2f6fed');
  assert.strictEqual(core.colorKey('rgb(255, 0, 16)'), '#ff0010');
  assert.strictEqual(core.colorKey('rgba(0,0,0,0.5)'), '#000000');
  assert.strictEqual(core.colorKey('rgba(0 , 128,255 ,1)'), '#0080ff');
  assert.strictEqual(core.colorKey('  #fff '), '#ffffff');
  for (const v of ['', 'red', 'none', 'transparent', '#12', '#12345', 'rgb(1,2)', 'rgb(300,0,0)', null, undefined, 5, {}]) assert.strictEqual(core.colorKey(v), null, String(v));
});

// 一份有各種顏色的文件
function colorDoc() {
  const doc = core.createDoc();
  core.setPageProps(doc, 'p1', { bg: { type: 'gradient', from: '#ff0000', to: '#0000ff', angle: 0 } });
  const ids = {};
  ids.s1 = add(doc, { type: 'shape', fill: '#ff0000', stroke: { w: 2, color: '#000000' } });
  ids.s2 = add(doc, { type: 'shape', fill: RAD, stroke: { w: 0, color: '#000000' } });
  ids.t1 = add(doc, { type: 'text', color: 'rgba(255,0,0,0.5)', stroke: { w: 0, color: '#ffffff' }, shadow: { x: 1, y: 1, blur: 2, color: 'rgba(0,0,0,0.5)' } });
  ids.t2 = add(doc, { type: 'text', color: LIN });
  ids.img = null;
  const r = core.addPage(doc);
  ids.p2 = r.id;
  ids.s3 = add(doc, { type: 'shape', fill: '#FF0000' }, r.id);
  return { doc, ids };
}

test('docColors：全部頁計數，依次數多到少、同次數依色碼', () => {
  const { doc } = colorDoc();
  const all = core.docColors(doc);
  const get = c => (all.find(x => x.color === c) || {}).count;
  // 紅：p1 背景 from、s1 fill、t1 color、t2 LIN.from、s3 fill(大寫) ＝ 5
  assert.strictEqual(get('#ff0000'), 5);
  // 黑：s1 stroke（粗細 2）、s2 RAD.to、t1 shadow（有位移）＝ 3；粗細 0 的描邊與預設陰影看不見，不算
  assert.strictEqual(get('#000000'), 3);
  assert.strictEqual(get('#0000ff'), 2);   // 背景 to、LIN.to
  for (let i = 1; i < all.length; i++) {
    const a = all[i - 1], b = all[i];
    assert.ok(a.count > b.count || (a.count === b.count && a.color < b.color), `排序 ${a.color}/${b.color}`);
  }
  for (const x of all) assert.match(x.color, /^#[0-9a-f]{6}$/);
});

test('docColors：pageId 只看該頁；隱藏與鎖定物件也算；看不懂的顏色略過', () => {
  const { doc, ids } = colorDoc();
  assert.deepStrictEqual(core.docColors(doc, { pageId: ids.p2 }).find(x => x.color === '#ff0000'), { color: '#ff0000', count: 1 });
  const only2 = core.docColors(doc, { pageId: ids.p2 }).reduce((s, x) => s + x.count, 0);
  const all = core.docColors(doc).reduce((s, x) => s + x.count, 0);
  assert.ok(only2 < all);
  core.updateObjects(doc, 'p1', [{ id: ids.s1, hidden: true }, { id: ids.t1, locked: true }]);
  assert.strictEqual(core.docColors(doc, { pageId: 'p1' }).find(x => x.color === '#ff0000').count, 4);
  core.updateObjects(doc, 'p1', { id: ids.s1, fill: 'none' });
  assert.ok(!core.docColors(doc).some(x => x.color === 'none'));
  assert.deepStrictEqual(core.docColors(doc, { pageId: 'nope' }), []);
});

test('recolor：換色並保留透明度，漸層兩端與背景都換', () => {
  const { doc, ids } = colorDoc();
  const r = core.recolor(doc, { '#FF0000': '#00ff00' });
  assert.ok(r.ok, r.reason);
  assert.ok(r.changed >= 5);
  assert.strictEqual(r.skippedLocked, 0);
  assert.strictEqual(O(doc, ids.s1).fill, '#00ff00');
  assert.strictEqual(O(doc, ids.t1).color, 'rgba(0,255,0,0.5)');
  assert.strictEqual(O(doc, ids.t2).color.from, '#00ff00');
  assert.strictEqual(O(doc, ids.t2).color.to, '#0000ff');
  assert.strictEqual(doc.pages[0].bg.from, '#00ff00');
  assert.strictEqual(O(doc, ids.s3).fill, '#00ff00');
  assert.strictEqual(core.validate(doc), null);
  assert.ok(!core.docColors(doc).some(x => x.color === '#ff0000'));
});

test('recolor：rgba 的黑色換成紅色，alpha 不變', () => {
  const { doc, ids } = colorDoc();
  assert.ok(core.recolor(doc, { '#000000': '#ff0000' }).ok);
  assert.strictEqual(O(doc, ids.t1).shadow.color, 'rgba(255,0,0,0.5)');
  assert.strictEqual(O(doc, ids.s1).stroke.color, '#ff0000');
});

test('recolor：只換指定頁', () => {
  const { doc, ids } = colorDoc();
  const r = core.recolor(doc, { '#ff0000': '#00ff00' }, { pageId: ids.p2 });
  assert.ok(r.ok);
  assert.strictEqual(r.changed, 1);
  assert.strictEqual(O(doc, ids.s3).fill, '#00ff00');
  assert.strictEqual(O(doc, ids.s1).fill, '#ff0000');
  assert.strictEqual(doc.pages[0].bg.from, '#ff0000');
  unchanged(doc, () => core.recolor(doc, { '#ff0000': '#00ff00' }, { pageId: 'nope' }), /頁面/);
});

test('recolor：略過鎖定物件並回報數量，背景照換', () => {
  const { doc, ids } = colorDoc();
  core.updateObjects(doc, 'p1', [{ id: ids.s1, locked: true }, { id: ids.t2, locked: true }]);
  const r = core.recolor(doc, { '#ff0000': '#00ff00' });
  assert.ok(r.ok);
  assert.strictEqual(O(doc, ids.s1).fill, '#ff0000');
  assert.strictEqual(O(doc, ids.t2).color.from, '#ff0000');
  assert.strictEqual(O(doc, ids.t1).color, 'rgba(0,255,0,0.5)');
  assert.strictEqual(doc.pages[0].bg.from, '#00ff00');
  assert.strictEqual(r.skippedLocked, 2);
});

test('recolor：沒有可換的顏色回 changed:0，文件不變', () => {
  const { doc } = colorDoc();
  const before = core.serialize(doc);
  const r = core.recolor(doc, { '#123456': '#654321' });
  assert.deepStrictEqual({ ok: r.ok, changed: r.changed }, { ok: true, changed: 0 });
  assert.strictEqual(core.serialize(doc), before);
  assert.deepStrictEqual(core.recolor(doc, {}).changed, 0);
});

test('recolor：map 有壞色碼時全有或全無，回中文原因', () => {
  const { doc } = colorDoc();
  unchanged(doc, () => core.recolor(doc, { '#ff0000': '#00ff00', '#0000ff': 'banana' }), /顏色/);
  unchanged(doc, () => core.recolor(doc, { 'red': '#00ff00' }), /顏色/);
  unchanged(doc, () => core.recolor(doc, null), /顏色/);
  unchanged(doc, () => core.recolor(doc, [['#ff0000', '#00ff00']]), /顏色/);
});

test('recolor：復原一次就全部回來（交給 history.run 包起來）', () => {
  const { state, h } = withHistory();
  state.doc = colorDoc().doc;
  const before = core.serialize(state.doc);
  const r = h.run('換色', d => core.recolor(d, { '#ff0000': '#00ff00' }));
  assert.ok(r.ok && r.changed > 0);
  assert.notStrictEqual(core.serialize(state.doc), before);
  assert.ok(h.undo());
  assert.strictEqual(core.serialize(state.doc), before);
});

test('docColors／recolor：粗細 0 的描邊、沒有位移與模糊的陰影不列也不換', () => {
  const doc = core.createDoc();
  const pid = doc.pages[0].id;
  assert.ok(core.addObject(doc, pid, { type: 'text', color: '#ff0000' }).ok);   // 預設描邊 0、陰影 0
  assert.ok(core.addObject(doc, pid, { type: 'shape', kind: 'rect', fill: '#00ff00', stroke: { w: 4, color: '#0000ff' } }).ok);
  const colors = core.docColors(doc).map(c => c.color).sort();
  assert.deepEqual(colors, ['#0000ff', '#00ff00', '#ff0000', '#ffffff']);
  const r = core.recolor(doc, { '#000000': '#123456' });
  assert.equal(r.ok, true);
  assert.equal(r.changed, 0, '看不見的黑色描邊與陰影不會被換');
});

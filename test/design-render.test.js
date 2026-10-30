// 設計：文字排版（node，stub 的 ctx：每個字寬度都等於 size）
const test = require('node:test');
const assert = require('node:assert/strict');
const { layoutText, textHeight, paintStyle, render } = require('../design-render.js');

function stubCtx(size) {
  const c = { calls: 0, font: '', measureText: () => { c.calls++; return { width: size }; } };
  return c;
}
const fonts = (gen = 0) => ({ fontCss: (id, s) => `${s}px x`, gen: () => gen });
const T = (o) => ({ type: 'text', text: '', font: 'WHZ-Heavy', size: 100, w: 350, letterSpacing: 0, lineHeight: 1.25, ...o });

test('size 100、w 350 的五個字排成 3＋2 兩行', () => {
  const r = layoutText(stubCtx(100), T({ text: '一二三四五' }), fonts());
  assert.deepEqual(r.lines, ['一二三', '四五']);
  assert.equal(r.lineH, 125);
  assert.equal(r.height, 250);
});

test('\\n 強制換行', () => {
  const r = layoutText(stubCtx(100), T({ text: '甲\n乙', w: 800 }), fonts());
  assert.deepEqual(r.lines, ['甲', '乙']);
});

test('letterSpacing 20 讓每行少一個字', () => {
  const r = layoutText(stubCtx(100), T({ text: '一二三四五', letterSpacing: 20 }), fonts());
  assert.deepEqual(r.lines, ['一二', '三四', '五']);
});

test('空字串仍有一行', () => {
  const r = layoutText(stubCtx(100), T({ text: '' }), fonts());
  assert.equal(r.lines.length, 1);
  assert.equal(r.height, 125);
});

test('快取：同樣輸入不再量測，fonts.gen() 改變後失效', () => {
  const ctx = stubCtx(100);
  const o = T({ text: '快取測試字' });
  layoutText(ctx, o, fonts(1));
  const n = ctx.calls;
  assert.ok(n > 0);
  layoutText(ctx, o, fonts(1));
  assert.equal(ctx.calls, n);
  layoutText(ctx, o, fonts(2));
  assert.ok(ctx.calls > n);
});

test('textHeight 沒有 DOM 時用粗估（字寬＝字級）', () => {
  assert.equal(textHeight(T({ text: '一二三四五' }), fonts()), 250);
});

// ---- 漸層 paintStyle -------------------------------------------------------------
function gradCtx() {
  const log = [];
  const mk = (kind, args) => { const g = { kind, args, stops: [], addColorStop(o, c) { g.stops.push([o, c]); } }; log.push(g); return g; };
  return { log, createLinearGradient: (...a) => mk('linear', a), createRadialGradient: (...a) => mk('radial', a) };
}
const close = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) < eps, `${a} ≠ ${b}`);

test('paintStyle：純色字串原樣回傳', () => {
  assert.equal(paintStyle(gradCtx(), '#abcdef', 100, 50, 1), '#abcdef');
});

test('paintStyle：線性 90° 由左到右，座標在物件框內', () => {
  const ctx = gradCtx();
  const g = paintStyle(ctx, { type: 'linear', from: '#f00', to: '#00f', angle: 90 }, 200, 100, 2);
  assert.equal(g.kind, 'linear');
  const [x0, y0, x1, y1] = g.args;
  close(x0, 0); close(y0, 50); close(x1, 200); close(y1, 50);
  assert.deepEqual(g.stops, [[0, '#f00'], [1, '#00f']]);
});

test('paintStyle：線性 0° 由下往上；180° 由上往下', () => {
  const up = paintStyle(gradCtx(), { type: 'linear', from: 'a', to: 'b', angle: 0 }, 100, 200, 1).args;
  close(up[0], 50); close(up[1], 200); close(up[2], 50); close(up[3], 0);
  const down = paintStyle(gradCtx(), { type: 'linear', from: 'a', to: 'b', angle: 180 }, 100, 200, 1).args;
  close(down[1], 0); close(down[3], 200);
});

test('paintStyle：放射預設中心在框中央、半徑＝中心到角落', () => {
  const g = paintStyle(gradCtx(), { type: 'radial', from: '#fff', to: '#000' }, 200, 100, 1);
  assert.equal(g.kind, 'radial');
  const [x0, y0, r0, x1, y1, r1] = g.args;
  close(x0, 100); close(y0, 50); close(r0, 0); close(x1, 100); close(y1, 50);
  close(r1, Math.hypot(100, 50));
});

test('paintStyle：放射的 cx、cy、r 依框與比例換算', () => {
  const g = paintStyle(gradCtx(), { type: 'radial', from: '#fff', to: '#000', cx: 0.25, cy: 0.75, r: 0.5 }, 200, 100, 1);
  const [x0, y0, , x1, y1, r1] = g.args;
  close(x0, 50); close(y0, 75); close(x1, 50); close(y1, 75);
  close(r1, Math.hypot(100, 50) * 0.5);
});

test('paintStyle：壞掉的顏料退回黑色，不丟錯', () => {
  assert.equal(paintStyle(gradCtx(), null, 10, 10, 1), '#000000');
  assert.equal(paintStyle(gradCtx(), { type: 'conic' }, 10, 10, 1), '#000000');
});

// ---- 弧形文字 ---------------------------------------------------------------------
const A = o => T({ text: '一二三四五', w: 800, ...o });

test('arc：R ＝ 行寬 ÷ 弧度（五個字、每字 100、arc 180）', () => {
  const r = layoutText(stubCtx(100), A({ arc: 180 }), fonts());
  close(r.L, 500);
  close(r.R, 500 / Math.PI);
  const r2 = layoutText(stubCtx(100), A({ arc: -90 }), fonts());
  close(r2.R, 500 / (Math.PI / 2));
});

test('arc：字距算進行寬（沒有最後一個字距）', () => {
  const r = layoutText(stubCtx(100), A({ arc: 180, letterSpacing: 10 }), fonts());
  close(r.L, 540);
});

test('arc：第一個與最後一個字對稱於框的水平中心', () => {
  for (const arc of [120, 180, -120, -250, 360]) {
    const r = layoutText(stubCtx(100), A({ arc }), fonts());
    const g = r.glyphs, a = g[0], b = g[g.length - 1];
    close(a.x, -b.x); close(a.y, b.y);
    close(a.rot, -b.rot);
    assert.equal(g.length, 5);
    assert.deepEqual(g.map(q => q.ch).join(''), '一二三四五');
  }
});

test('arc：中間字在弧頂（arc>0 往上拱、arc<0 往下彎）', () => {
  const up = layoutText(stubCtx(100), A({ arc: 90 }), fonts()).glyphs;
  const mid = up[2];
  close(mid.x, 0); close(mid.rot, 0);
  assert.ok(up[0].y > mid.y, '兩端比弧頂低（y 往下為正）');
  const dn = layoutText(stubCtx(100), A({ arc: -90 }), fonts()).glyphs;
  assert.ok(dn[0].y < dn[2].y, '兩端比弧底高');
  assert.ok(up[0].rot < 0 && up[4].rot > 0, '往上拱：左邊字逆時針、右邊順時針');
  assert.ok(dn[0].rot > 0 && dn[4].rot < 0);
});

test('arc≠0 排成單行：\\n 當空白、不自動換行', () => {
  const r = layoutText(stubCtx(100), T({ text: '甲\n乙丙丁戊己庚', w: 200, arc: 90 }), fonts());
  assert.equal(r.lines.length, 1);
  assert.equal(r.glyphs.length, 8);
  assert.equal(r.glyphs[1].ch, ' ');
});

test('textHeight：arc 大於 0 與小於 0 都大於 0，且比平的單行高；arc 0 不變', () => {
  const flat = textHeight(A({ w: 800 }), fonts());
  assert.equal(flat, 125);
  for (const arc of [60, 180, 360, -60, -180, -360]) {
    const h = textHeight(A({ arc }), fonts());
    assert.ok(h > 0 && isFinite(h), `arc ${arc}: ${h}`);
    assert.ok(h >= flat - 1e-6, `arc ${arc} 不會比單行矮`);
  }
  assert.ok(textHeight(A({ arc: 180 }), fonts()) > textHeight(A({ arc: 60 }), fonts()), '彎越多越高');
  close(textHeight(A({ arc: 90 }), fonts()), textHeight(A({ arc: -90 }), fonts()));
});

test('textHeight：空字串與極小弧度不出錯', () => {
  assert.equal(textHeight(T({ text: '', arc: 90 }), fonts()), 125);
  assert.ok(textHeight(T({ text: '字', arc: 1 }), fonts()) >= 125 - 1e-6);
});

test('快取 key 包含 arc：不同 arc 不會拿到同一份排版', () => {
  const ctx = stubCtx(100);
  const f = fonts(7);
  const a0 = layoutText(ctx, A({ arc: 0 }), f), a1 = layoutText(ctx, A({ arc: 90 }), f), a2 = layoutText(ctx, A({ arc: -90 }), f);
  assert.notEqual(a0, a1); assert.notEqual(a1, a2);
  assert.ok(!a0.glyphs && a1.glyphs && a2.glyphs);
  const n = ctx.calls;
  assert.equal(layoutText(ctx, A({ arc: 90 }), f), a1, '同 arc 命中快取');
  assert.equal(ctx.calls, n);
  assert.equal(layoutText(ctx, A({}), f), a0, '沒有 arc 欄位視同 0');
});

test('render 不依賴 DOM 的弧形文字：用 stub 2d context 能畫完不丟錯', () => {
  const calls = [];
  const rec = new Proxy({}, { get: (t, k) => (k === 'measureText' ? () => ({ width: 100 }) : k in t ? t[k] : (...a) => { calls.push(k); } ), set: (t, k, v) => { t[k] = v; return true; } });
  const page = { w: 800, h: 400, bg: { type: 'radial', from: '#fff', to: '#000' }, objects: [
    { id: 'o1', type: 'text', x: 0, y: 0, w: 800, h: 300, rot: 0, opacity: 1, text: '一二三', font: 'x', size: 100, color: { type: 'linear', from: '#f00', to: '#00f', angle: 0 }, align: 'center', lineHeight: 1.25, letterSpacing: 0, arc: 120, stroke: { w: 4, color: '#000' }, shadow: { x: 0, y: 0, blur: 0, color: '#000' } },
  ] };
  rec.createLinearGradient = () => ({ addColorStop() {} });
  rec.createRadialGradient = () => ({ addColorStop() {} });
  render(rec, page, {});
  assert.ok(calls.filter(c => c === 'fillText').length >= 3);
  assert.ok(calls.filter(c => c === 'strokeText').length >= 3);
});

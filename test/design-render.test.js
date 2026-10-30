// 設計：文字排版（node，stub 的 ctx：每個字寬度都等於 size）
const test = require('node:test');
const assert = require('node:assert/strict');
const { layoutText, textHeight } = require('../design-render.js');

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

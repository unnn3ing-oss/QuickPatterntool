const test = require('node:test');
const assert = require('node:assert');
const S = require('../scheduler.js');

const PNG = 'data:image/png;base64,iVBORw0KGgo=';
const good = () => ({ id: 'a', text: '你好', images: [], pageUrl: 'https://www.facebook.com/tvbsnews', at: Date.now() + 60000 });

test('normalizePageUrl：只收 facebook.com 的 https 粉專頁面，並統一成 www', () => {
  assert.deepStrictEqual(S.normalizePageUrl('https://facebook.com/tvbsnews'), { ok: true, url: 'https://www.facebook.com/tvbsnews' });
  assert.deepStrictEqual(S.normalizePageUrl('  https://www.facebook.com/profile.php?id=123 '), { ok: true, url: 'https://www.facebook.com/profile.php?id=123' });
  for (const bad of ['', null, 'tvbsnews', 'http://www.facebook.com/x', 'https://evil.example/facebook.com/x',
    'https://www.facebook.com.evil.example/x', 'https://user:pw@www.facebook.com/x', 'https://www.facebook.com/', 'https://m.facebook.com/x']) {
    assert.strictEqual(S.normalizePageUrl(bad).ok, false, String(bad));
  }
});

test('validateItem：文字和圖片至少要有一樣、圖片格式與數量、時間與網址', () => {
  assert.strictEqual(S.validateItem(good()).ok, true);
  assert.strictEqual(S.validateItem(Object.assign(good(), { text: '  ' })).ok, false);
  assert.strictEqual(S.validateItem(Object.assign(good(), { text: '', images: [{ name: 'a', dataUrl: PNG }] })).ok, true);
  assert.strictEqual(S.validateItem(Object.assign(good(), { images: [{ name: 'a', dataUrl: 'data:text/html;base64,AAAA' }] })).ok, false);
  assert.strictEqual(S.validateItem(Object.assign(good(), { images: [{ name: 'a', dataUrl: 'https://x/a.png' }] })).ok, false);
  assert.strictEqual(S.validateItem(Object.assign(good(), { images: Array.from({ length: 11 }, () => ({ name: 'a', dataUrl: PNG })) })).ok, false);
  assert.strictEqual(S.validateItem(Object.assign(good(), { text: 'x'.repeat(S.MAX_TEXT + 1) })).ok, false);
  assert.strictEqual(S.validateItem(Object.assign(good(), { at: NaN })).ok, false);
  assert.strictEqual(S.validateItem(Object.assign(good(), { pageUrl: 'https://evil.example/x' })).ok, false);
  assert.strictEqual(S.validateItem(null).ok, false);
});

test('classify：等待／寬限內補發／錯過；執行中／卡住', () => {
  const at = 1_000_000;
  const p = { status: 'pending', at };
  assert.strictEqual(S.classify(p, at - 1), 'wait');
  assert.strictEqual(S.classify(p, at), 'fire');
  assert.strictEqual(S.classify(p, at + S.GRACE_MS), 'fire');
  assert.strictEqual(S.classify(p, at + S.GRACE_MS + 1), 'missed');
  const r = { status: 'running', startedAt: at };
  assert.strictEqual(S.classify(r, at + S.RUN_TIMEOUT_MS), 'busy');
  assert.strictEqual(S.classify(r, at + S.RUN_TIMEOUT_MS + 1), 'stale');
  for (const status of ['done', 'failed', 'missed']) assert.strictEqual(S.classify({ status, at }, at + 5), 'idle');
});

test('stuckMessage：已按發佈卻沒結果時，不能說沒發佈', () => {
  assert.match(S.stuckMessage('publishing'), /可能已經發出/);
  assert.match(S.stuckMessage('images'), /沒有發佈/);
  assert.match(S.stuckMessage('images'), /上傳圖片/);
});

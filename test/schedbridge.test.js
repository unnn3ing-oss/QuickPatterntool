const test = require('node:test');
const assert = require('node:assert');
const B = require('../schedbridge.js');

const ok = (over = {}) => Object.assign({ source: 'qpt-web', type: 'sched', v: 1, nonce: 'n1', op: 'list' }, over);

test('validateRequest：格式正確的請求通過，payload 預設為空物件', () => {
  assert.deepStrictEqual(B.validateRequest(ok()), { ok: true, nonce: 'n1', op: 'list', payload: {} });
  assert.deepStrictEqual(B.validateRequest(ok({ op: 'add', payload: { input: { text: 'x' } } })).payload, { input: { text: 'x' } });
  for (const op of B.OPS) assert.strictEqual(B.validateRequest(ok({ op })).ok, true, op);
});

test('OPS 白名單：排程操作與快速產圖的代抓，沒有別的', () => {
  assert.deepStrictEqual(B.OPS, ['ping', 'list', 'get', 'add', 'edit', 'remove', 'start', 'cancel', 'fetchArticle', 'fetchImage']);
});

test('validateRequest：來源標記、版本、nonce、op、payload 任何一項不對都拒絕', () => {
  const bad = [
    null, 'x', [], {}, ok({ source: 'hottopic' }), ok({ type: 'send-to-quickpattern' }), ok({ v: 2 }), ok({ v: undefined }),
    ok({ nonce: '' }), ok({ nonce: 5 }), ok({ nonce: 'x'.repeat(65) }),
    ok({ op: 'eval' }), ok({ op: undefined }), ok({ op: 'toString' }),
    ok({ payload: 'str' }), ok({ payload: [] }), ok({ payload: null })
  ];
  for (const d of bad) assert.strictEqual(B.validateRequest(d).ok, false, JSON.stringify(d));
});

test('senderAllowed：只信任自己的擴充功能、網頁版頁面（要有 tab）', () => {
  const good = { id: 'me', tab: { id: 1 }, url: 'https://unnn3ing-oss.github.io/QuickPatterntool/' };
  assert.strictEqual(B.senderAllowed(good, 'me'), true);
  assert.strictEqual(B.senderAllowed(Object.assign({}, good, { url: 'https://unnn3ing-oss.github.io/QuickPatterntool/index.html?x=1' }), 'me'), true);
  for (const s of [
    null, {}, Object.assign({}, good, { id: 'other' }), Object.assign({}, good, { tab: undefined }),
    Object.assign({}, good, { url: 'https://unnn3ing-oss.github.io/hottopic/' }),
    Object.assign({}, good, { url: 'https://unnn3ing-oss.github.io/QuickPatterntool-evil/' }),
    Object.assign({}, good, { url: 'https://evil.example/QuickPatterntool/' }),
    Object.assign({}, good, { url: 'http://unnn3ing-oss.github.io/QuickPatterntool/' }),
    Object.assign({}, good, { url: 'not a url' }),
    Object.assign({}, good, { url: 'https://www.facebook.com/' })
  ]) assert.strictEqual(B.senderAllowed(s, 'me'), false, JSON.stringify(s));
  assert.strictEqual(B.senderAllowed(good, ''), false);
});

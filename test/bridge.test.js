const test = require('node:test');
const assert = require('node:assert');
const { validateSend, senderAllowed, isFresh } = require('../bridge.js');

test('validateSend 接受 TVBS 網址', () => {
  const a = validateSend({ url: 'https://news.tvbs.com.tw/cars/4032757' });
  assert.strictEqual(a.ok, true);
  assert.strictEqual(a.url, 'https://news.tvbs.com.tw/cars/4032757');
  assert.strictEqual(a.title, null);
  const b = validateSend({ url: 'https://tvbs.com.tw/x', title: '標題' });
  assert.strictEqual(b.ok, true);
  assert.strictEqual(b.title, '標題');
});

test('validateSend 拒絕偽裝網域', () => {
  const bad = [
    'https://news.tvbs.com.tw.evil.com/',
    'https://eviltvbs.com.tw/',
    'https://news.tvbs.com.tw@evil.com/',
    'https://user:pw@news.tvbs.com.tw/',
    'http://news.tvbs.com.tw/x',
    'javascript:alert(1)',
    'not a url',
    'https://news.tvbs.com.tw/' + 'a'.repeat(2001 - 'https://news.tvbs.com.tw/'.length),
  ];
  assert.strictEqual(bad[bad.length - 1].length, 2001);
  for (const url of bad) assert.strictEqual(validateSend({ url }).ok, false, url);
});

test('validateSend 檢查 title', () => {
  const url = 'https://news.tvbs.com.tw/x';
  assert.strictEqual(validateSend({ url, title: 123 }).ok, false);
  assert.strictEqual(validateSend({ url, title: ['a'] }).ok, false);
  assert.strictEqual(validateSend({ url, title: 'a'.repeat(201) }).ok, false);
  assert.strictEqual(validateSend({ url, title: '\u0000\u0007' }).ok, false);
  const t = '平均爽領315萬！勞退　結清潮';
  const r = validateSend({ url, title: t });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.title, t);
});

test('validateSend 拒絕非物件', () => {
  for (const m of [null, undefined, 'https://news.tvbs.com.tw/x', ['a']]) {
    assert.strictEqual(validateSend(m).ok, false);
  }
});

test('senderAllowed', () => {
  const ok = { id: 'me', url: 'https://unnn3ing-oss.github.io/hottopic/' };
  assert.strictEqual(senderAllowed(ok, 'me'), true);
  assert.strictEqual(senderAllowed({ ...ok, id: 'x' }, 'me'), false);
  assert.strictEqual(senderAllowed({ id: 'me', url: 'https://unnn3ing-oss.github.io/QuickPatterntool/' }, 'me'), false);
  assert.strictEqual(senderAllowed({ id: 'me', url: 'https://unnn3ing-oss.github.io.evil.com/hottopic/' }, 'me'), false);
  assert.strictEqual(senderAllowed(null, 'me'), false);
});

test('isFresh', () => {
  const now = 1000000;
  assert.strictEqual(isFresh({ at: now - 119999 }, now), true);
  assert.strictEqual(isFresh({ at: now - 120000 }, now), false);
  assert.strictEqual(isFresh(null, now), false);
  assert.strictEqual(isFresh({}, now), false);
});

test('validateSend：改標的換行轉成空格，不會把兩行黏在一起', () => {
  const url = 'https://news.tvbs.com.tw/x';
  const r = validateSend({ url, title: '定期保養的 5 個重點\n第 3 項最多人漏掉' });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.title, '定期保養的 5 個重點 第 3 項最多人漏掉');
  assert.strictEqual(validateSend({ url, title: 'A\r\nB' }).title, 'A B');
  assert.strictEqual(validateSend({ url, title: '\n\n' }).ok, false);
});

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

// ---- 追蹤碼與留言 ----------------------------------------------------------
test('withUtm：格式固定為 ?&utm_source=facebook&utm_medium=XXX；已有參數接在後面、舊的 utm 先拿掉、#hash 保留', () => {
  assert.strictEqual(S.withUtm('https://news.tvbs.com.tw/politics/4039103', 'tvbsteatimenewscomments'),
    'https://news.tvbs.com.tw/politics/4039103?&utm_source=facebook&utm_medium=tvbsteatimenewscomments');
  assert.strictEqual(S.withUtm('https://news.tvbs.com.tw/x?a=1&utm_source=old&utm_medium=old#top', 'fbarticlepic'),
    'https://news.tvbs.com.tw/x?a=1&utm_source=facebook&utm_medium=fbarticlepic#top');
  assert.strictEqual(S.withUtm('  https://news.tvbs.com.tw/x  ', 'm'), 'https://news.tvbs.com.tw/x?&utm_source=facebook&utm_medium=m');
  for (const bad of ['', 'abc', 'javascript:alert(1)', 'ftp://x/y', null]) assert.strictEqual(S.withUtm(bad, 'm'), null, String(bad));
});

test('pageOf：三個預設粉專（網址大小寫、結尾斜線、有沒有 www 都認得）；其他粉專不是預設', () => {
  assert.deepStrictEqual(S.PAGES.map(p => p.name), ['新聞粉', '娛樂粉', '少康粉']);
  assert.strictEqual(S.pageOf('https://www.facebook.com/tvbsfb/').id, 'news');
  assert.strictEqual(S.pageOf('https://facebook.com/TVBSFB').id, 'news');
  assert.strictEqual(S.pageOf('https://www.facebook.com/tvbsteatimenews').id, 'tea');
  assert.strictEqual(S.pageOf('https://www.facebook.com/2100room/').id, 'room');
  assert.strictEqual(S.pageOf('https://www.facebook.com/someoneelse'), null);
  assert.strictEqual(S.pageOf('not a url'), null);
});

test('commentOf：三個粉專、有圖／純文字 各用自己的追蹤碼（照使用者指定的字串）', () => {
  const url = 'https://news.tvbs.com.tw/politics/4039103';
  const expected = {
    news: ['fbarticlepic', 'fbarticlecomments'],
    tea: ['tvbsteatimenewspic', 'tvbsteatimenewscomments'],
    room: ['2100roompic', '2100roomcomments']
  };
  for (const pg of S.PAGES) {
    for (const [hasImg, medium] of [[true, expected[pg.id][0]], [false, expected[pg.id][1]]]) {
      const c = S.commentOf({ note: '你也這樣覺得嗎？👀', articleUrl: url, pageUrl: pg.url, images: hasImg ? [{ dataUrl: 'x' }] : [] });
      assert.strictEqual(c, `你也這樣覺得嗎？👀\n${url}?&utm_source=facebook&utm_medium=${medium}`, pg.id + hasImg);
    }
  }
});

test('commentOf：沒有小編文只留網址；沒有網址只留小編文；都沒有就不留言；自訂粉專不加追蹤碼', () => {
  const base = { pageUrl: 'https://www.facebook.com/tvbsfb/', images: [] };
  assert.strictEqual(S.commentOf(Object.assign({ note: '', articleUrl: 'https://a.tw/x' }, base)), 'https://a.tw/x?&utm_source=facebook&utm_medium=fbarticlecomments');
  assert.strictEqual(S.commentOf(Object.assign({ note: '  哈囉  ', articleUrl: '' }, base)), '哈囉');
  assert.strictEqual(S.commentOf(Object.assign({ note: '', articleUrl: '' }, base)), '');
  assert.strictEqual(S.commentOf({ note: 'n', articleUrl: 'https://a.tw/x', pageUrl: 'https://www.facebook.com/custom', images: [] }), 'n\nhttps://a.tw/x');
});

test('validateItem：小編文長度、文章網址格式、圖片總大小', () => {
  const g = () => ({ id: 'a', text: '你好', images: [], pageUrl: 'https://www.facebook.com/tvbsfb/', at: 1 });
  assert.strictEqual(S.validateItem(Object.assign(g(), { note: 'x'.repeat(S.MAX_NOTE) })).ok, true);
  assert.strictEqual(S.validateItem(Object.assign(g(), { note: 'x'.repeat(S.MAX_NOTE + 1) })).ok, false);
  assert.strictEqual(S.validateItem(Object.assign(g(), { articleUrl: 'https://a.tw/x' })).ok, true);
  assert.strictEqual(S.validateItem(Object.assign(g(), { articleUrl: '' })).ok, true);
  for (const bad of ['abc', 'javascript:alert(1)', 5, 'https://a.tw/' + 'x'.repeat(S.MAX_URL)]) assert.strictEqual(S.validateItem(Object.assign(g(), { articleUrl: bad })).ok, false, String(bad));
  const big = { name: 'a', dataUrl: 'data:image/png;base64,' + 'A'.repeat(S.MAX_IMAGE_CHARS) };
  assert.strictEqual(S.validateItem(Object.assign(g(), { images: [big] })).ok, false);
});

test('buildItem：整理表單內容、驗證、時間要在一分鐘後；編輯時沿用 id 與建立時間', () => {
  const now = 1_000_000_000_000;
  const input = { pageUrl: 'https://facebook.com/tvbsfb/', text: '  內文  ', images: [], note: ' 小編 ', articleUrl: ' https://a.tw/x ', at: now + 120000 };
  const b = S.buildItem(input, { now });
  assert.strictEqual(b.ok, true);
  assert.deepStrictEqual({ text: b.item.text, note: b.item.note, articleUrl: b.item.articleUrl, pageUrl: b.item.pageUrl, status: b.item.status },
    { text: '內文', note: '小編', articleUrl: 'https://a.tw/x', pageUrl: 'https://www.facebook.com/tvbsfb/', status: 'pending' });
  assert.match(b.item.id, /^p/);
  const e = S.buildItem(input, { now, id: 'keep', createdAt: 42 });
  assert.strictEqual(e.item.id, 'keep');
  assert.strictEqual(e.item.createdAt, 42);
  assert.match(S.buildItem(Object.assign({}, input, { at: now + 30000 }), { now }).error, /一分鐘/);
  assert.strictEqual(S.buildItem(Object.assign({}, input, { pageUrl: 'https://evil.example/x' }), { now }).ok, false);
  assert.strictEqual(S.buildItem(Object.assign({}, input, { text: '', images: [] }), { now }).ok, false);
  assert.strictEqual(S.buildItem(null, { now }).ok, false);
});

test('canEdit / summarize / stuckMessage（留言階段）', () => {
  for (const [status, expected] of [['pending', true], ['failed', true], ['missed', true], ['running', false], ['done', false]]) assert.strictEqual(S.canEdit({ status }), expected, status);
  assert.deepStrictEqual(S.summarize({ id: 'a', images: [{ name: 'x.png', dataUrl: 'data:image/png;base64,AAAA' }] }).images, [{ name: 'x.png' }]);
  for (const step of ['finding', 'commenting']) assert.match(S.stuckMessage(step), /貼文已經發佈，但留言沒有完成/);
});

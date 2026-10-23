// 網頁版快速產圖用的文章代理（examples/article-proxy/worker.mjs，Cloudflare Worker）的單元測試。
// 用假的 fetch 取代對外連線，檢查：來源限制、網域限制、轉址每一跳都檢查、大小與類型限制、CORS。
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const ORIGIN = 'https://unnn3ing-oss.github.io';
const BASE = 'https://qpt-article-proxy.19jpz-3.workers.dev';
const ART = 'https://news.tvbs.com.tw/local/1111111';
let worker;
test.before(async () => { worker = (await import(pathToFileURL(path.join(__dirname, '..', 'examples', 'article-proxy', 'worker.mjs')).href)).default; });

// responses：{ 網址: Response 或函式 }；回傳實際打出去的網址
function stubFetch(t, responses) {
  const calls = [];
  const orig = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init });
    const r = responses[String(url)];
    if (!r) throw new Error('unexpected fetch ' + url);
    return typeof r === 'function' ? r() : r.clone();
  };
  t.after(() => { globalThis.fetch = orig; });
  return calls;
}
const call = (p, { origin = ORIGIN, method = 'GET' } = {}) => worker.fetch(new Request(BASE + p, { method, headers: origin ? { Origin: origin } : {} }));
const q = o => '?' + new URLSearchParams(o);
const html = (body, type = 'text/html; charset=utf-8') => new Response(body, { status: 200, headers: { 'Content-Type': type } });
const redirect = loc => new Response(null, { status: 302, headers: { Location: loc } });
const png = (n = 10) => new Response(new Uint8Array(n), { status: 200, headers: { 'Content-Type': 'image/png' } });

test('/article：回傳文章 HTML 與最終網址，帶 CORS（只回給允許的來源）', async t => {
  const calls = stubFetch(t, { [ART]: html('<title>標題</title>') });
  const res = await call('/article' + q({ url: ART }));
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true, url: ART, html: '<title>標題</title>' });
  assert.equal(res.headers.get('Access-Control-Allow-Origin'), ORIGIN);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].init.redirect, 'manual');
});

test('來源限制：沒有 Origin、或不在名單內 → 403，而且完全沒有對外連線', async t => {
  const calls = stubFetch(t, { [ART]: html('x') });
  for (const origin of [null, 'https://evil.example', 'http://unnn3ing-oss.github.io']) {
    const res = await call('/article' + q({ url: ART }), { origin });
    assert.equal(res.status, 403, String(origin));
    assert.equal(res.headers.get('Access-Control-Allow-Origin'), null);
  }
  assert.equal(calls.length, 0);
});

test('OPTIONS 預檢：允許的來源 204，其他 403', async t => {
  assert.equal((await call('/article', { method: 'OPTIONS' })).status, 204);
  assert.equal((await call('/article', { method: 'OPTIONS', origin: 'https://evil.example' })).status, 403);
  assert.equal((await call('/article', { method: 'POST' })).status, 405);
});

test('網址限制：非 https、非 tvbs.com.tw（含長得像的）、帶帳密、太長、缺少 → 拒絕，完全沒有對外連線', async t => {
  const calls = stubFetch(t, {});
  const bad = [
    'http://news.tvbs.com.tw/a', 'https://example.com/a', 'https://tvbs.com.tw.evil.com/a', 'https://eviltvbs.com.tw/a',
    'https://user:pw@news.tvbs.com.tw/a', 'https://127.0.0.1/a', 'ftp://news.tvbs.com.tw/a', 'not a url', '', 'https://news.tvbs.com.tw/' + 'a'.repeat(2100)
  ];
  for (const url of bad) {
    const res = await call('/article' + q({ url }));
    assert.ok(res.status === 400 || res.status === 403, `${url.slice(0, 40)} → ${res.status}`);
    assert.equal((await res.json()).ok, false);
  }
  assert.equal((await call('/article')).status, 400);
  assert.equal(calls.length, 0);
});

test('主網域 tvbs.com.tw 本身也允許；子網域也允許', async t => {
  stubFetch(t, { 'https://tvbs.com.tw/a': html('a'), 'https://sub.deep.tvbs.com.tw/a': html('b') });
  assert.equal((await call('/article' + q({ url: 'https://tvbs.com.tw/a' }))).status, 200);
  assert.equal((await call('/article' + q({ url: 'https://sub.deep.tvbs.com.tw/a' }))).status, 200);
});

test('轉址：在 TVBS 內跟著走並回報最終網址；轉到別的網站就停止（不會去抓）', async t => {
  const calls = stubFetch(t, {
    [ART]: redirect('/local/2222222'),
    'https://news.tvbs.com.tw/local/2222222': html('ok'),
    'https://news.tvbs.com.tw/x': redirect('https://example.com/steal'),
    'https://example.com/steal': html('不該被抓')
  });
  const a = await (await call('/article' + q({ url: ART }))).json();
  assert.equal(a.url, 'https://news.tvbs.com.tw/local/2222222');
  const res = await call('/article' + q({ url: 'https://news.tvbs.com.tw/x' }));
  assert.equal(res.status, 403);
  assert.ok(!calls.some(c => c.url.startsWith('https://example.com')), '不能對 TVBS 以外的網站發出請求');
});

test('轉址太多次 → 502', async t => {
  stubFetch(t, { [ART]: redirect(ART) });
  const res = await call('/article' + q({ url: ART }));
  assert.equal(res.status, 502);
  assert.match((await res.json()).error, /轉址太多次/);
});

test('文章：HTTP 錯誤、不是網頁、太大、連不上 → 帶中文原因', async t => {
  stubFetch(t, {
    'https://news.tvbs.com.tw/404': new Response('nope', { status: 404 }),
    'https://news.tvbs.com.tw/img': html('x', 'image/png'),
    'https://news.tvbs.com.tw/big': html('x'.repeat(5 * 1024 * 1024 + 1)),
    'https://news.tvbs.com.tw/big2': new Response('x', { status: 200, headers: { 'Content-Type': 'text/html', 'Content-Length': String(6 * 1024 * 1024) } })
  });
  const get = async p => call('/article' + q({ url: 'https://news.tvbs.com.tw/' + p }));
  assert.match((await (await get('404')).json()).error, /HTTP 404/);
  assert.match((await (await get('img')).json()).error, /不是網頁/);
  assert.equal((await get('big')).status, 413);
  assert.equal((await get('big2')).status, 413);
  assert.equal((await get('missing')).status, 504);   // 假的 fetch 丟錯 → 連不上
});

test('/image：回傳圖片本身（content-type 照原樣），Referer 是文章網址，帶 CORS', async t => {
  const calls = stubFetch(t, { 'https://img.tvbs.com.tw/a.png': png(1234) });
  const res = await call('/image' + q({ url: 'https://img.tvbs.com.tw/a.png', article: ART }));
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('Content-Type'), 'image/png');
  assert.equal(res.headers.get('Access-Control-Allow-Origin'), ORIGIN);
  assert.equal((await res.arrayBuffer()).byteLength, 1234);
  assert.equal(calls[0].init.headers.Referer, ART);
});

test('/image：非 TVBS 圖片、非 TVBS 文章、不是圖片、太大 → 拒絕', async t => {
  const calls = stubFetch(t, {
    'https://img.tvbs.com.tw/t.png': html('<html>', 'text/html'),
    'https://img.tvbs.com.tw/svg': new Response('<svg/>', { headers: { 'Content-Type': 'image/svg+xml' } }),
    'https://img.tvbs.com.tw/big.png': new Response('x', { headers: { 'Content-Type': 'image/png', 'Content-Length': String(21 * 1024 * 1024) } })
  });
  const img = (url, article = ART) => call('/image' + q({ url, article }));
  assert.equal((await img('https://example.com/a.png')).status, 403);
  assert.equal((await img('http://img.tvbs.com.tw/a.png')).status, 400);
  assert.equal((await img('https://img.tvbs.com.tw/a.png', 'https://example.com/a')).status, 403);
  assert.equal(calls.length, 0, '不合格的網址完全不發出請求');
  assert.match((await (await img('https://img.tvbs.com.tw/t.png')).json()).error, /不是圖片/);
  assert.match((await (await img('https://img.tvbs.com.tw/svg')).json()).error, /不是圖片/);
  assert.equal((await img('https://img.tvbs.com.tw/big.png')).status, 413);
});

test('其他路徑 404', async t => {
  stubFetch(t, {});
  assert.equal((await call('/')).status, 404);
  assert.equal((await call('/anything' + q({ url: ART }))).status, 404);
});

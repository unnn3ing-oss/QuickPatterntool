// QuickPatterntool 網頁版「快速產圖」用的 TVBS 文章代理（Cloudflare Worker）。
// 手機沒有外掛，網頁自己又不能直接讀別家網站（瀏覽器的跨網域限制），所以由這個小中間站代抓：
//   GET /article?url=<文章網址>                    → {"ok":true,"url":"<轉址後的文章網址>","html":"<原始 HTML>"}
//   GET /image?url=<圖片網址>&article=<文章網址>   → 圖片檔本身（網頁用 blob 讀）
// 標題、斷行、挑圖、圖說、hashtag 都在網頁那邊用 quickfill.js 解析（和外掛、側邊欄同一份），這裡只負責「代為下載」。
//
// 不是開放代理：
//   · 只允許 https、網域必須是 tvbs.com.tw（含子網域），文章與圖片都一樣；網址不能帶帳密
//   · 轉址每一跳都重新檢查網域（不會被導去別的網站）
//   · 只接受 ALLOWED_ORIGINS 內網頁的瀏覽器請求（沒有 Origin 或不在名單內一律 403）
//   · 文章最多 5MB、圖片最多 20MB、有逾時；圖片的 content-type 必須是圖片
// 部署步驟見同資料夾的 README.md。Worker 名稱請取 qpt-article-proxy（網頁預設連到 https://qpt-article-proxy.19jpz-3.workers.dev）。

const ALLOWED_HOST_SUFFIX = 'tvbs.com.tw';
const ALLOWED_ORIGINS = [
  'https://unnn3ing-oss.github.io',
  'http://localhost:8000',
  'http://127.0.0.1:8000',
];
const MAX_URL = 2000;
const MAX_ARTICLE_BYTES = 5 * 1024 * 1024;
const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
const ARTICLE_TIMEOUT_MS = 12000;
const IMAGE_TIMEOUT_MS = 18000;
const MAX_REDIRECTS = 4;
const IMAGE_TYPE = /^image\/(png|jpe?g|webp|gif|avif|bmp)\b/i;
const FETCH_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
  'Accept-Language': 'zh-TW,zh;q=0.9',
};

const hostAllowed = h => h === ALLOWED_HOST_SUFFIX || h.endsWith('.' + ALLOWED_HOST_SUFFIX);

// → URL 物件；不合格丟出帶中文原因的 Error（status 一併帶著）
function checkUrl(raw, what) {
  const bad = (status, msg) => Object.assign(new Error(msg), { status });
  if (typeof raw !== 'string' || !raw) throw bad(400, `缺少${what}網址`);
  if (raw.length > MAX_URL) throw bad(400, `${what}網址太長`);
  let u;
  try { u = new URL(raw); } catch (e) { throw bad(400, `${what}網址格式不正確`); }
  if (u.protocol !== 'https:') throw bad(400, `${what}只允許 https 網址`);
  if (u.username || u.password) throw bad(400, `${what}網址不能帶帳號密碼`);
  if (!hostAllowed(u.hostname.toLowerCase())) throw bad(403, `${what}網域不在允許名單（只允許 tvbs.com.tw）：${u.hostname}`);
  return u;
}

function cors(request) {
  const origin = request.headers.get('Origin');
  const h = { 'Vary': 'Origin', 'Access-Control-Allow-Methods': 'GET, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type' };
  if (origin && ALLOWED_ORIGINS.includes(origin)) h['Access-Control-Allow-Origin'] = origin;
  return h;
}
const originOk = request => ALLOWED_ORIGINS.includes(request.headers.get('Origin') || '');

function json(request, status, body) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...cors(request) } });
}
const fail = (request, status, error) => json(request, status, { ok: false, error });

// 手動跟著轉址走，每一跳都檢查網域；回傳 { res, url }（res 的 body 還沒讀）
async function fetchChecked(start, { timeoutMs, headers, what }) {
  let u = start;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    let res;
    try {
      res = await fetch(u.href, { headers, redirect: 'manual', signal: AbortSignal.timeout(timeoutMs) });
    } catch (e) {
      throw Object.assign(new Error(e && e.name === 'TimeoutError' ? `${what}下載逾時` : `抓不到${what}`), { status: 504 });
    }
    if (res.status >= 300 && res.status < 400 && res.headers.get('Location')) {
      let next;
      try { next = new URL(res.headers.get('Location'), u); } catch (e) { throw Object.assign(new Error(`${what}轉址網址不正確`), { status: 502 }); }
      u = checkUrl(next.href, `${what}轉址後的`);
      continue;
    }
    return { res, url: u };
  }
  throw Object.assign(new Error(`${what}轉址太多次`), { status: 502 });
}

// 讀 body 並限制大小（超過就中止，不把整個檔案吃進記憶體）
async function readLimited(res, maxBytes, what) {
  const tooBig = () => Object.assign(new Error(`${what}檔案太大，已停止讀取`), { status: 413 });
  if (Number(res.headers.get('Content-Length')) > maxBytes) throw tooBig();
  const reader = res.body.getReader();
  const chunks = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > maxBytes) { reader.cancel().catch(() => {}); throw tooBig(); }   // 不等取消完成（等的話被分流過的串流會卡住）
    chunks.push(value);
  }
  const out = new Uint8Array(size);
  let at = 0;
  for (const c of chunks) { out.set(c, at); at += c.length; }
  return out;
}

async function handleArticle(request, params) {
  const start = checkUrl(params.get('url'), '文章');
  const { res, url } = await fetchChecked(start, { timeoutMs: ARTICLE_TIMEOUT_MS, headers: FETCH_HEADERS, what: '文章' });
  if (!res.ok) return fail(request, 502, `文章讀取失敗（HTTP ${res.status}）`);
  const type = (res.headers.get('Content-Type') || '').toLowerCase();
  if (type && !/^(text\/|application\/xhtml)/.test(type)) return fail(request, 502, '這個網址不是網頁');
  const bytes = await readLimited(res, MAX_ARTICLE_BYTES, '文章');
  return json(request, 200, { ok: true, url: url.href, html: new TextDecoder('utf-8').decode(bytes) });
}

async function handleImage(request, params) {
  const article = checkUrl(params.get('article'), '文章');
  const start = checkUrl(params.get('url'), '圖片');
  const { res } = await fetchChecked(start, { timeoutMs: IMAGE_TIMEOUT_MS, headers: { ...FETCH_HEADERS, Referer: article.href }, what: '圖片' });
  if (!res.ok) return fail(request, 502, `圖片讀取失敗（HTTP ${res.status}）`);
  const type = (res.headers.get('Content-Type') || '').split(';')[0].trim().toLowerCase();
  if (!IMAGE_TYPE.test(type)) return fail(request, 502, '這個網址不是圖片');
  const bytes = await readLimited(res, MAX_IMAGE_BYTES, '圖片');
  return new Response(bytes, { status: 200, headers: { 'Content-Type': type, 'Cache-Control': 'public, max-age=3600', ...cors(request) } });
}

export default {
  async fetch(request) {
    if (request.method === 'OPTIONS') return new Response(null, { status: originOk(request) ? 204 : 403, headers: cors(request) });
    if (request.method !== 'GET') return fail(request, 405, '只支援 GET');
    if (!originOk(request)) return fail(request, 403, '這個網頁不在允許名單內');
    const { pathname, searchParams } = new URL(request.url);
    try {
      if (pathname === '/article') return await handleArticle(request, searchParams);
      if (pathname === '/image') return await handleImage(request, searchParams);
      return fail(request, 404, '沒有這個路徑');
    } catch (e) {
      return fail(request, e && e.status ? e.status : 500, e && e.status ? e.message : '代理發生錯誤');
    }
  },
};

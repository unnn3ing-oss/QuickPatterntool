// 網頁版 e2e 共用的測試環境（schedweb.e2e.js、qfweb.e2e.js 用）。
// 網頁版從假的網址 https://unnn3ing-oss.github.io/QuickPatterntool/ 載入（內容取自本機檔案），
// 並在頁面裡放「真的」bridge.js、quickfill.js、scheduler.js、schedbridge.js（內容腳本）、poster.js（背景），
// 接上假的 chrome.*（記憶體 storage／鬧鐘／分頁），所以「網頁 → postMessage → 橋接 → 背景」整條路都是真的程式在跑。
// 這個檔案不是測試（不叫 *.test.js），只被 e2e 檔 require。
const fs = require('node:fs');
const path = require('node:path');

const ROOT = process.env.QPT_ROOT || path.join(__dirname, '..');
const BASE = 'https://unnn3ing-oss.github.io/QuickPatterntool/';
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.ttf': 'font/ttf', '.woff2': 'font/woff2' };
const src = f => fs.readFileSync(path.join(ROOT, f), 'utf8');

// 假的 chrome.* ＋ 真的 scheduler／schedbridge／poster。withExtension:false 時什麼都不放（沒裝外掛的網頁版）。
const EXTENSION = () => `
(() => {
  const data = { fbQueue: window.__initialQueue || [] };
  const listeners = { storage: [], message: [] };
  window.__tabs = { created: [], sent: [], removed: [] };
  const clone = v => JSON.parse(JSON.stringify(v));
  window.chrome = {
    runtime: {
      id: 'me', getManifest: () => ({ version: '9.99' }),
      onMessage: { addListener: f => listeners.message.push(f) }, onInstalled: { addListener() {} }, onStartup: { addListener() {} },
      sendMessage: msg => new Promise(res => {
        let async = false;
        for (const f of listeners.message) { if (f(msg, { id: 'me', tab: { id: 5 }, url: location.href }, v => res(v)) === true) async = true; }
        if (!async) res(undefined);
      })
    },
    storage: {
      local: {
        get: async k => (k in data ? { [k]: clone(data[k]) } : {}),
        set: async o => {
          const changes = {};
          for (const k of Object.keys(o)) { changes[k] = { newValue: clone(o[k]) }; data[k] = clone(o[k]); }
          listeners.storage.forEach(f => f(changes, 'local'));
        }
      },
      onChanged: { addListener: f => listeners.storage.push(f) }
    },
    alarms: { create: async () => {}, getAll: async () => [], clear: async () => true, onAlarm: { addListener() {} } },
    tabs: {
      query: async () => [{ id: 7 }], create: async o => { window.__tabs.created.push(o); return { id: 100 + window.__tabs.created.length }; },
      sendMessage: async (id, m) => { window.__tabs.sent.push(m); return { started: true }; },
      remove: async id => { window.__tabs.removed.push(id); }, update: async () => {}, onRemoved: { addListener() {} }
    },
    notifications: { create: async () => {} }
  };
  window.__data = data;
})();
${src('bridge.js')}
${src('quickfill.js')}
${src('scheduler.js')}
${src('schedbridge.js')}
${src('poster.js')}
`;


// opts：queue 初始排程｜withExtension:false 模擬沒裝外掛｜routes(page) 在載入網頁前加上自己的網路攔截（文章、圖片）
async function openWeb(browser, t, { queue = [], withExtension = true, routes } = {}) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  t.after(() => ctx.close());
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.route('**/*', route => {
    const url = new URL(route.request().url());
    if (url.origin !== 'https://unnn3ing-oss.github.io' || !url.pathname.startsWith('/QuickPatterntool/')) return route.abort();
    const rel = decodeURIComponent(url.pathname.slice('/QuickPatterntool/'.length)) || 'index.html';
    const file = path.join(ROOT, rel);
    if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) return route.fulfill({ status: 404, body: '' });
    let body = fs.readFileSync(file);
    if (rel === 'index.html') {
      // 網頁的 CSP connect-src 只允許 GitHub，擋得住網頁自己亂連線；但這個測試環境把「背景」放在網頁裡，背景要去抓文章與圖片，
      // 所以測試時才放寬給 TVBS（真的擴充功能的背景是獨立環境，不受網頁 CSP 影響）。網頁自己用 fetch 抓 TVBS 的話，真實環境一樣會被擋。
      body = Buffer.from(body.toString('utf8').replace('connect-src https://api.github.com https://raw.githubusercontent.com', 'connect-src https://api.github.com https://raw.githubusercontent.com https://news.tvbs.com.tw https://img.tvbs.com.tw'));
    }
    return route.fulfill({ contentType: TYPES[path.extname(file)] || 'application/octet-stream', body });
  });
  if (routes) await routes(page);   // 後註冊的先比對，所以放在上面那條全部攔截之後
  if (withExtension) {
    await page.addInitScript(q => { window.__initialQueue = q; }, queue);
    await page.addInitScript(EXTENSION());
  }
  await page.goto(BASE);
  return { page, errors };
}

module.exports = { ROOT, BASE, EXTENSION, openWeb };

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const read = f => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
const ALLOWED = { id: 'me', url: 'https://unnn3ing-oss.github.io/hottopic/', tab: { windowId: 7 } };

// 在假的 chrome 裡載入 background.js，取出它註冊的 onMessage 處理函式
function load({ openImpl }) {
  const calls = [];
  let setResolve;
  const chrome = {
    runtime: { id: 'me', onInstalled: { addListener() {} }, onStartup: { addListener() {} }, onMessage: { addListener(fn) { chrome.handler = fn; } } },
    alarms: { get() {}, create() {}, onAlarm: { addListener() {} } },
    sidePanel: { setPanelBehavior: () => Promise.resolve(), open: opts => { calls.push(['open', opts]); return openImpl(); } },
    storage: { session: { set: v => { calls.push(['set', v]); return new Promise(r => { setResolve = r; }); } } },
    action: { setBadgeText: o => { calls.push(['badgeText', o.text]); return Promise.resolve(); }, setBadgeBackgroundColor: o => { calls.push(['badgeColor', o.color]); return Promise.resolve(); } },
  };
  const ctx = { chrome, console, Date, URL };
  ctx.self = ctx;
  ctx.importScripts = (...files) => files.forEach(f => vm.runInContext(read(f), ctx));
  vm.createContext(ctx);
  vm.runInContext(read('background.js'), ctx);
  return { chrome, calls, resolveSet: () => setResolve() };
}
const plain = v => JSON.parse(JSON.stringify(v));   // 跨 vm 的物件原型不同，比對前轉成一般物件
const msg = { type: 'hottopic:send', url: 'https://news.tvbs.com.tw/x', title: '標題' };

test('background：驗證通過後「同步」呼叫 sidePanel.open（不能先 await 別的，否則 Chrome 不承認使用者操作）', async () => {
  const { chrome, calls, resolveSet } = load({ openImpl: () => Promise.resolve() });
  const reply = new Promise(r => chrome.handler(msg, ALLOWED, r));
  assert.deepStrictEqual(plain(calls[0]), ['open', { windowId: 7 }]);   // handler 回傳前就已呼叫
  resolveSet();
  assert.deepStrictEqual(plain(await reply), { ok: true, opened: true });
  assert.ok(calls.some(c => c[0] === 'set' && c[1].pending.url === 'https://news.tvbs.com.tw/x' && c[1].pending.title === '標題'));
  assert.ok(!calls.some(c => c[0] === 'badgeText'));
});

test('background：sidePanel.open 失敗 → 仍暫存，回 opened:false，圖示顯示藍色 1', async () => {
  const { chrome, calls, resolveSet } = load({ openImpl: () => Promise.reject(new Error('may only be called in response to a user gesture')) });
  const reply = new Promise(r => chrome.handler(msg, ALLOWED, r));
  resolveSet();
  assert.deepStrictEqual(plain(await reply), { ok: true, opened: false });
  assert.ok(calls.some(c => c[0] === 'set'));
  assert.deepStrictEqual(calls.filter(c => c[0].startsWith('badge')), [['badgeText', '1'], ['badgeColor', '#1a73e8']]);
});

test('background：sender 不合格或內容不合格 → 不暫存、不開側邊欄', async () => {
  for (const [m, s, err] of [
    [msg, { id: 'me', url: 'https://evil.example/hottopic/', tab: { windowId: 1 } }, 'sender_not_allowed'],
    [{ type: 'hottopic:send', url: 'https://evil.example/x' }, ALLOWED, 'bad_url'],
  ]) {
    const { chrome, calls } = load({ openImpl: () => Promise.resolve() });
    const r = await new Promise(res => chrome.handler(m, s, res));
    assert.deepStrictEqual(plain(r), { ok: false, opened: false, error: err });
    assert.strictEqual(calls.length, 0);
  }
});

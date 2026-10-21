// 背景排程（poster.js）：用假的 chrome（記憶體 storage、鬧鐘、分頁）驅動，驗證狀態流轉。
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const read = f => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
const PNG = 'data:image/png;base64,iVBORw0KGgo=';
const PAGE = 'https://www.facebook.com/tvbsnews';
const clone = v => JSON.parse(JSON.stringify(v));
const tick = async (n = 12) => { for (let i = 0; i < n; i++) await new Promise(r => setImmediate(r)); };

function load({ send, fast, fetchImpl, reloadFails } = {}) {
  const log = { notify: [], removed: [], updated: [], created: [], sent: [], reloaded: [] };
  const data = {};
  const alarms = new Map();
  const handlers = { storage: [], alarm: [], message: [], removed: [], updated: [] };
  let tabSeq = 100;
  const chrome = {
    runtime: { id: 'me', getManifest: () => ({ version: '9.99' }), onMessage: { addListener: f => handlers.message.push(f) }, onInstalled: { addListener() {} }, onStartup: { addListener() {} } },
    storage: {
      local: {
        get: async k => (k in data ? { [k]: clone(data[k]) } : {}),
        set: async o => { for (const k of Object.keys(o)) data[k] = clone(o[k]); handlers.storage.forEach(f => f(Object.fromEntries(Object.keys(o).map(k => [k, { newValue: o[k] }])), 'local')); }
      },
      onChanged: { addListener: f => handlers.storage.push(f) }
    },
    alarms: {
      create: async (name, info) => { alarms.set(name, { name, scheduledTime: info.when || Date.now() + (info.delayInMinutes || 0) * 60000 }); },
      getAll: async () => [...alarms.values()],
      clear: async name => alarms.delete(name),
      onAlarm: { addListener: f => handlers.alarm.push(f) }
    },
    tabs: {
      query: async () => [{ id: 7 }],
      create: async o => { log.created.push(o); return { id: ++tabSeq }; },
      sendMessage: async (id, m) => { log.sent.push([id, m]); return send ? send(id, m) : { started: true }; },
      remove: async id => { log.removed.push(id); },
      update: async (id, o) => { log.updated.push([id, o]); },
      reload: async id => { log.reloaded.push(id); if (reloadFails) throw new Error('No tab with id'); },
      onUpdated: { addListener: f => handlers.updated.push(f), removeListener: f => { handlers.updated = handlers.updated.filter(x => x !== f); } },
      onRemoved: { addListener: f => handlers.removed.push(f) }
    },
    notifications: { create: async (id, o) => { log.notify.push(o); } }
  };
  const fetchLog = [];
  const ctx = {
    chrome, console, Date, URL, setTimeout: fast ? (fn => setTimeout(fn, 0)) : setTimeout, clearTimeout, AbortController, Blob, btoa,
    fetch: async (url, opts) => { fetchLog.push(url); if (!fetchImpl) throw new Error('no network'); return fetchImpl(url, opts); }
  };
  ctx.self = ctx;
  vm.createContext(ctx);
  vm.runInContext(read('bridge.js'), ctx);
  vm.runInContext(read('quickfill.js'), ctx);   // 背景沒有 document 也要能載入（只匯出純函式與下載函式）
  vm.runInContext(read('scheduler.js'), ctx);
  vm.runInContext(read('schedbridge.js'), ctx);
  vm.runInContext(read('poster.js'), ctx);
  const S = ctx.QptSched;
  const item = (over = {}) => Object.assign({
    id: 'i1', text: '貼文', images: [{ name: 'a.png', dataUrl: PNG }], pageUrl: PAGE, at: Date.now() - 1000, status: 'pending', createdAt: Date.now()
  }, over);
  const get = async id => (await S.list()).find(i => i.id === id);
  const fire = name => handlers.alarm.forEach(f => f({ name }));
  // 內容腳本回報：sender 預設是我們開的分頁（101）
  const report = (m, tabId = 101, url = PAGE) => {
    let out;
    handlers.message.forEach(f => { const r = f(m, { id: 'me', tab: { id: tabId }, url }, v => { out = v; }); if (r === true) out = 'async'; });
    return out;
  };
  const fromPanel = m => new Promise(res => handlers.message.forEach(f => { f(m, { id: 'me', url: 'chrome-extension://me/sidepanel.html' }, res); }));
  // 網頁版（內容腳本 schedbridge.js 轉進來）的請求
  const WEB = { id: 'me', tab: { id: 5 }, url: 'https://unnn3ing-oss.github.io/QuickPatterntool/' };
  const fromWeb = (op, payload, sender = WEB) => new Promise(res => {
    let handled = false;
    handlers.message.forEach(f => { if (f({ type: 'sched:api', op, payload }, sender, v => { handled = true; res(clone(v)); }) === true) handled = true; });
    if (!handled) res(undefined);
  });
  const loaded = tabId => handlers.updated.slice().forEach(f => f(tabId, { status: 'complete' }));   // 分頁重新整理完成
  return { S, data, alarms, log, handlers, item, get, fire, report, fromPanel, fromWeb, chrome, fetchLog, loaded };
}

test('到點：開粉專分頁、把文字與圖片交給內容腳本；回報成功 → done、關分頁、回到原分頁、發通知', async () => {
  const t = load();
  await t.S.add(t.item());
  t.fire('post:i1');
  await tick();
  assert.deepStrictEqual(clone(t.log.created), [{ url: PAGE, active: true }]);
  const [tabId, msg] = t.log.sent[0];
  assert.strictEqual(tabId, 101);
  assert.strictEqual(msg.type, 'fbpost:run');
  assert.deepStrictEqual(JSON.parse(JSON.stringify(msg.job)), { id: 'i1', mode: 'post', text: '貼文', images: [{ name: 'a.png', dataUrl: PNG }], comment: '', dryRun: false, reload: true, fresh: false });
  assert.strictEqual((await t.get('i1')).status, 'running');
  assert.ok(t.alarms.has('post-watch:i1'));

  t.report({ type: 'fbpost:progress', id: 'i1', step: 'images' });
  await tick();
  assert.strictEqual((await t.get('i1')).step, 'images');

  t.report({ type: 'fbpost:result', id: 'i1', ok: true, step: 'publishing' });
  await tick();
  const it = await t.get('i1');
  assert.strictEqual(it.status, 'done');
  assert.strictEqual(it.error, undefined);
  assert.deepStrictEqual(clone(t.log.removed), [101].map(Number));
  assert.deepStrictEqual(clone(t.log.updated), [[7, { active: true }]]);
  assert.ok(!t.alarms.has('post-watch:i1'));
  assert.strictEqual(t.log.notify[0].title, '已發佈到粉專');
});

test('回報失敗 → failed 並留下原因；分頁不關（方便看卡在哪）', async () => {
  const t = load();
  await t.S.add(t.item());
  t.fire('post:i1');
  await tick();
  t.report({ type: 'fbpost:result', id: 'i1', ok: false, step: 'text', error: '文字沒有輸入成功' });
  await tick();
  const it = await t.get('i1');
  assert.strictEqual(it.status, 'failed');
  assert.strictEqual(it.error, '文字沒有輸入成功');
  assert.strictEqual(it.step, 'text');
  assert.deepStrictEqual(t.log.removed, []);
  assert.match(t.log.notify[0].title, /失敗/);
});

test('試跑：不論結果都回到執行前的狀態，分頁保留；不會變成 done', async () => {
  const t = load();
  await t.S.add(t.item({ at: Date.now() + 3600000 }));
  const r = await t.fromPanel({ type: 'poster:start', id: 'i1', dryRun: true });
  assert.strictEqual(r.ok, true);
  await tick();
  assert.strictEqual(t.log.sent[0][1].job.dryRun, true);
  t.report({ type: 'fbpost:result', id: 'i1', ok: true, step: 'ready' });
  await tick();
  const it = await t.get('i1');
  assert.strictEqual(it.status, 'pending');
  assert.strictEqual(it.step, 'dry-ok');
  assert.deepStrictEqual(t.log.removed, []);
});

test('只信任「我們開的那個分頁」的回報；非 facebook 網址、別的分頁、別的 id 都忽略', async () => {
  const t = load();
  await t.S.add(t.item());
  t.fire('post:i1');
  await tick();
  t.report({ type: 'fbpost:result', id: 'i1', ok: true }, 999);
  t.report({ type: 'fbpost:result', id: 'i1', ok: true }, 101, 'https://evil.example/');
  t.report({ type: 'fbpost:result', id: 'nope', ok: true });
  await tick();
  assert.strictEqual((await t.get('i1')).status, 'running');
  // sender 不是自己的擴充功能
  let handled = false;
  t.handlers.message.forEach(f => { if (f({ type: 'fbpost:result', id: 'i1', ok: true }, { id: 'other', tab: { id: 101 }, url: PAGE + '/' }, () => { handled = true; })) handled = true; });
  await tick();
  assert.strictEqual(handled, false);
  assert.strictEqual((await t.get('i1')).status, 'running');
});

test('錯過：開機時發現超過寬限 → missed，不開分頁；寬限內仍會補發', async () => {
  const t = load();
  await t.S.add(t.item({ id: 'old', at: Date.now() - 11 * 60000 }));
  await t.S.add(t.item({ id: 'late', at: Date.now() - 5 * 60000 }));
  await t.handlers.storage[0]({ fbQueue: {} }, 'local');   // 觸發 sync
  await tick();
  assert.strictEqual((await t.get('old')).status, 'missed');
  assert.match((await t.get('old')).error, /沒有補發/);
  assert.ok(t.alarms.has('post:late'), '寬限內的要有鬧鐘');
  assert.ok(!t.alarms.has('post:old'));
  assert.strictEqual(t.log.created.length, 0);
  assert.ok(t.log.notify.some(n => /錯過/.test(n.title)));
});

test('對帳：pending 建鬧鐘、已刪除或已完成的清掉鬧鐘', async () => {
  const t = load();
  const at = Date.now() + 3600000;
  await t.S.add(t.item({ id: 'a', at }));
  await tick();
  assert.strictEqual(t.alarms.get('post:a').scheduledTime, at);
  t.alarms.set('post:ghost', { name: 'post:ghost', scheduledTime: at });
  await t.S.remove('a');
  await tick();
  assert.strictEqual([...t.alarms.keys()].filter(n => n.startsWith('post:')).length, 0);
});

test('一次只跑一筆：前一筆執行中，到點的這筆延後 1 分鐘；手動則直接拒絕', async () => {
  const t = load();
  await t.S.add(t.item({ id: 'a' }));
  await t.S.add(t.item({ id: 'b' }));
  t.fire('post:a');
  await tick();
  t.fire('post:b');
  await tick();
  assert.strictEqual(t.log.created.length, 1);
  assert.strictEqual((await t.get('b')).status, 'pending');
  assert.ok(t.alarms.get('post:b').scheduledTime > Date.now() + 50000);
  const r = await t.fromPanel({ type: 'poster:start', id: 'b' });
  assert.strictEqual(r.ok, false);
});

test('卡住監看：已按下發佈卻沒回報 → 失敗但註明「可能已經發出」；其他步驟註明沒有發佈', async () => {
  for (const [step, re] of [['publishing', /可能已經發出/], ['images', /沒有發佈/]]) {
    const t = load();
    await t.S.add(t.item());
    t.fire('post:i1');
    await tick();
    t.report({ type: 'fbpost:progress', id: 'i1', step });
    await tick();
    t.fire('post-watch:i1');
    await tick();
    const it = await t.get('i1');
    assert.strictEqual(it.status, 'failed', step);
    assert.match(it.error, re, step);
  }
});

test('使用者自己關掉發佈中的分頁 → 失敗', async () => {
  const t = load();
  await t.S.add(t.item());
  t.fire('post:i1');
  await tick();
  t.handlers.removed.forEach(f => f(101));
  await tick();
  const it = await t.get('i1');
  assert.strictEqual(it.status, 'failed');
  assert.match(it.error, /分頁被關掉/);
});

test('內容腳本一直沒就緒（頁面不是粉專／沒載入）→ deliver 丟出說明；到點流程則標成失敗', async () => {
  const t = load({ send: async () => { throw new Error('Could not establish connection'); }, fast: true });
  await t.S.add(t.item());
  t.fire('post:i1');
  for (let i = 0; i < 400 && ['pending', 'running'].includes((await t.get('i1')).status); i++) await new Promise(r => setTimeout(r, 5));
  const it = await t.get('i1');
  assert.strictEqual(it.status, 'failed');
  assert.match(it.error, /沒有準備好/);
  assert.ok(t.log.sent.length >= 60);
});

test('資料不合格（例如粉專網址被改壞）→ 不開分頁，直接失敗', async () => {
  const t = load();
  await t.S.add(t.item({ pageUrl: 'https://evil.example/x' }));
  t.fire('post:i1');
  await tick();
  assert.strictEqual(t.log.created.length, 0);
  assert.strictEqual((await t.get('i1')).status, 'failed');
});

test('已發佈的不會被重複發佈；不存在的 id 回錯誤', async () => {
  const t = load();
  await t.S.add(t.item({ status: 'done' }));
  const r = await t.fromPanel({ type: 'poster:start', id: 'i1' });
  assert.strictEqual(r.ok, false);
  t.fire('post:i1');
  await tick();
  assert.strictEqual(t.log.created.length, 0);
  assert.strictEqual((await t.fromPanel({ type: 'poster:start', id: 'zzz' })).ok, false);
});

// ---- 留言 ----------------------------------------------------------------
const NOTE_ITEM = { note: '你也這樣覺得嗎？👀', articleUrl: 'https://news.tvbs.com.tw/politics/4039103', pageUrl: 'https://www.facebook.com/tvbsteatimenews' };
const COMMENT = '你也這樣覺得嗎？👀\nhttps://news.tvbs.com.tw/politics/4039103?&utm_source=facebook&utm_medium=tvbsteatimenewscomments';

test('交給內容腳本的工作含「留言」（小編文＋換行＋帶追蹤碼的網址）；有圖用 pic、只有文字用 comments', async () => {
  for (const [images, medium] of [[[], 'tvbsteatimenewscomments'], [[{ name: 'a.png', dataUrl: PNG }], 'tvbsteatimenewspic']]) {
    const t = load();
    await t.S.add(t.item(Object.assign({ images }, NOTE_ITEM)));
    t.fire('post:i1');
    await tick();
    const job = t.log.sent[0][1].job;
    assert.strictEqual(job.mode, 'post');
    assert.strictEqual(job.comment, `你也這樣覺得嗎？👀\nhttps://news.tvbs.com.tw/politics/4039103?&utm_source=facebook&utm_medium=${medium}`);
  }
});

test('發佈並留言成功 → done、commentState:done、關分頁、通知「已發佈並留言」', async () => {
  const t = load();
  await t.S.add(t.item(NOTE_ITEM));
  t.fire('post:i1');
  await tick();
  t.report({ type: 'fbpost:result', id: 'i1', ok: true, step: 'commenting', commentState: 'done' });
  await tick();
  const it = await t.get('i1');
  assert.strictEqual(it.status, 'done');
  assert.strictEqual(it.commentState, 'done');
  assert.deepStrictEqual(clone(t.log.removed), [101]);
  assert.strictEqual(t.log.notify[0].title, '已發佈並留言');
});

test('貼文發佈了、留言失敗 → 仍是 done（不是 failed）、記下留言失敗原因、分頁留著、通知說明', async () => {
  const t = load();
  await t.S.add(t.item(NOTE_ITEM));
  t.fire('post:i1');
  await tick();
  t.report({ type: 'fbpost:result', id: 'i1', ok: true, step: 'commenting', commentState: 'failed', commentError: '找不到送出按鈕' });
  await tick();
  const it = await t.get('i1');
  assert.strictEqual(it.status, 'done');
  assert.strictEqual(it.commentState, 'failed');
  assert.strictEqual(it.commentError, '找不到送出按鈕');
  assert.strictEqual(it.error, undefined);
  assert.deepStrictEqual(clone(t.log.removed), []);
  assert.match(t.log.notify[0].title, /留言失敗/);
});

test('卡在留言階段（監看逾時／分頁被關）→ 貼文算已發佈、留言失敗，絕不標成失敗讓人重發', async () => {
  for (const how of ['watch', 'closed']) {
    const t = load();
    await t.S.add(t.item(NOTE_ITEM));
    t.fire('post:i1');
    await tick();
    t.report({ type: 'fbpost:progress', id: 'i1', step: 'commenting' });
    await tick();
    if (how === 'watch') t.fire('post-watch:i1'); else t.handlers.removed.forEach(f => f(101));
    await tick();
    const it = await t.get('i1');
    assert.strictEqual(it.status, 'done', how);
    assert.strictEqual(it.commentState, 'failed', how);
    assert.match(it.commentError, /貼文已經發佈/, how);
  }
});

test('補留言：只有 done 的才行；開粉專分頁、job 是 mode:comment 且不帶圖片；成功後貼文維持 done、留言 done、關分頁', async () => {
  const t = load();
  await t.S.add(t.item(Object.assign({ status: 'done', commentState: 'failed', commentError: 'x' }, NOTE_ITEM)));
  const r = await t.fromPanel({ type: 'poster:start', id: 'i1', mode: 'comment' });
  assert.strictEqual(r.ok, true);
  await tick();
  const job = t.log.sent[0][1].job;
  // 補留言用原貼文的圖片數量決定追蹤碼：這筆原本有附圖 → pic
  assert.deepStrictEqual(clone({ mode: job.mode, images: job.images, comment: job.comment, dryRun: job.dryRun }), { mode: 'comment', images: [], comment: COMMENT.replace('comments', 'pic'), dryRun: false });
  assert.strictEqual((await t.get('i1')).status, 'running');
  t.report({ type: 'fbpost:result', id: 'i1', ok: true, step: 'commenting', commentState: 'done' });
  await tick();
  const it = await t.get('i1');
  assert.strictEqual(it.status, 'done');
  assert.strictEqual(it.commentState, 'done');
  assert.strictEqual(it.commentError, undefined);
  assert.strictEqual(it.step, 'commented');
  assert.deepStrictEqual(clone(t.log.removed), [101]);
});

test('補留言失敗：貼文維持 done、留言標成失敗並記原因、分頁留著', async () => {
  const t = load();
  await t.S.add(t.item(Object.assign({ status: 'done' }, NOTE_ITEM)));
  await t.fromPanel({ type: 'poster:start', id: 'i1', mode: 'comment' });
  await tick();
  t.report({ type: 'fbpost:result', id: 'i1', ok: false, step: 'finding', error: '找不到剛發佈的貼文，沒辦法留言' });
  await tick();
  const it = await t.get('i1');
  assert.strictEqual(it.status, 'done');
  assert.strictEqual(it.commentState, 'failed');
  assert.match(it.commentError, /找不到剛發佈的貼文/);
  assert.deepStrictEqual(clone(t.log.removed), []);
});

test('試跑留言：貼文維持 done、留言狀態不變，只留下 dry-ok；分頁留著', async () => {
  const t = load();
  await t.S.add(t.item(Object.assign({ status: 'done', commentState: 'failed', commentError: '舊的失敗' }, NOTE_ITEM)));
  await t.fromPanel({ type: 'poster:start', id: 'i1', mode: 'comment', dryRun: true });
  await tick();
  assert.strictEqual(t.log.sent[0][1].job.dryRun, true);
  t.report({ type: 'fbpost:result', id: 'i1', ok: true, step: 'commenting', commentState: 'dry-ok' });
  await tick();
  const it = await t.get('i1');
  assert.strictEqual(it.status, 'done');
  assert.strictEqual(it.commentState, 'failed');
  assert.strictEqual(it.step, 'dry-ok');
  assert.deepStrictEqual(clone(t.log.removed), []);
});

test('補留言的限制：貼文還沒發佈、或根本沒有留言內容 → 拒絕，不開分頁', async () => {
  const t = load();
  await t.S.add(t.item(Object.assign({ id: 'a' }, NOTE_ITEM)));                       // pending
  await t.S.add(t.item({ id: 'b', status: 'done' }));                                  // done 但沒有小編文與網址
  assert.strictEqual((await t.fromPanel({ type: 'poster:start', id: 'a', mode: 'comment' })).ok, false);
  const r = await t.fromPanel({ type: 'poster:start', id: 'b', mode: 'comment' });
  assert.strictEqual(r.ok, false);
  assert.match(r.error, /沒有要留言的內容/);
  assert.strictEqual(t.log.created.length, 0);
});

// ---- 網頁版 API（sched:api）-----------------------------------------------
test('網頁版 API：來源不對（不是網頁版頁面、不是自己的擴充功能、沒有 tab）一律拒絕', async () => {
  const t = load();
  for (const sender of [
    { id: 'me', tab: { id: 5 }, url: 'https://evil.example/QuickPatterntool/' },
    { id: 'me', tab: { id: 5 }, url: 'https://unnn3ing-oss.github.io/other/' },
    { id: 'me', tab: { id: 5 }, url: 'https://www.facebook.com/x' },
    { id: 'me', url: 'https://unnn3ing-oss.github.io/QuickPatterntool/' }
  ]) {
    const r = await t.fromWeb('list', {}, sender);
    assert.deepStrictEqual(r, { ok: false, error: 'not_allowed' });
  }
  assert.deepStrictEqual(await t.fromWeb('hack', {}), { ok: false, error: 'not_allowed' });
  assert.strictEqual(await t.fromWeb('list', {}, { id: 'other', tab: { id: 5 }, url: WEB_URL }), undefined);   // 別的擴充功能：完全不回應
});
const WEB_URL = 'https://unnn3ing-oss.github.io/QuickPatterntool/';

test('網頁版 API：ping、list（圖片只回名稱）、get（完整含圖片）', async () => {
  const t = load();
  await t.S.add(t.item({ images: [{ name: 'a.png', dataUrl: PNG }] }));
  assert.deepStrictEqual(await t.fromWeb('ping'), { ok: true, data: { version: '9.99' } });
  const list = (await t.fromWeb('list')).data;
  assert.deepStrictEqual(list[0].images, [{ name: 'a.png' }]);
  const full = (await t.fromWeb('get', { id: 'i1' })).data;
  assert.strictEqual(full.images[0].dataUrl, PNG);
  assert.strictEqual((await t.fromWeb('get', { id: 'nope' })).ok, false);
});

test('網頁版 API：新增與編輯都重新驗證（粉專網址、時間、圖片格式）；編輯只限等待中／失敗／錯過', async () => {
  const t = load();
  const good = { pageUrl: 'https://www.facebook.com/tvbsfb/', text: '新貼文', images: [], note: '小編文', articleUrl: 'https://news.tvbs.com.tw/x', at: Date.now() + 3600000 };
  assert.strictEqual((await t.fromWeb('add', { input: Object.assign({}, good, { pageUrl: 'https://evil.example/x' }) })).ok, false);
  assert.strictEqual((await t.fromWeb('add', { input: Object.assign({}, good, { at: Date.now() }) })).ok, false);
  assert.strictEqual((await t.fromWeb('add', { input: Object.assign({}, good, { images: [{ name: 'a', dataUrl: 'javascript:alert(1)' }] }) })).ok, false);
  const added = await t.fromWeb('add', { input: good });
  assert.strictEqual(added.ok, true);
  const id = added.data.id;
  assert.strictEqual((await t.get(id)).status, 'pending');
  const edited = await t.fromWeb('edit', { id, input: Object.assign({}, good, { text: '改過的貼文' }) });
  assert.strictEqual(edited.ok, true);
  assert.strictEqual((await t.get(id)).text, '改過的貼文');
  await t.S.update(id, { status: 'done' });
  const r = await t.fromWeb('edit', { id, input: good });
  assert.strictEqual(r.ok, false);
  assert.match(r.error, /不能編輯/);
});

test('網頁版 API：刪除（執行中不能刪）；start 轉給背景執行（試跑）', async () => {
  const t = load();
  await t.S.add(t.item({ id: 'a' }));
  await t.S.add(t.item({ id: 'r', status: 'running', startedAt: Date.now() }));
  assert.strictEqual((await t.fromWeb('remove', { id: 'r' })).ok, false);
  assert.strictEqual((await t.fromWeb('remove', { id: 'a' })).ok, true);
  assert.strictEqual(await t.get('a'), undefined);
  await t.S.add(t.item({ id: 'b', at: Date.now() + 3600000 }));
  assert.strictEqual((await t.fromWeb('start', { id: 'b', dryRun: true })).ok, false);   // 另一筆（r）執行中，手動不能同時跑
  await t.S.remove('r');
  assert.strictEqual((await t.fromWeb('start', { id: 'b', dryRun: true })).ok, true);
  await tick();
  assert.strictEqual(t.log.sent[0][1].job.dryRun, true);
});

test('編輯排程時間：對帳會把鬧鐘改到新的時間', async () => {
  const t = load();
  const at = Date.now() + 3600000;
  await t.S.add(t.item({ at }));
  await tick();
  assert.strictEqual(t.alarms.get('post:i1').scheduledTime, at);
  const at2 = Date.now() + 7200000;
  const r = await t.S.edit('i1', { pageUrl: PAGE, text: '貼文', images: [], at: at2 });
  assert.strictEqual(r.ok, true);
  await tick();
  assert.strictEqual(t.alarms.get('post:i1').scheduledTime, at2);
});

// ---- 網頁版快速產圖：外掛代抓文章與圖片 --------------------------------------------
const ART = 'https://news.tvbs.com.tw/politics/4039103';
const respond = (body, { status = 200, type = 'text/html; charset=utf-8', url } = {}) => {
  const res = new Response(body, { status, headers: { 'content-type': type } });
  if (url) Object.defineProperty(res, 'url', { value: url });
  return res;
};
const PNG_BYTES = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');

test('代抓文章：只准 https 的 tvbs.com.tw；回傳 HTML 與最終網址', async () => {
  const t = load({ fetchImpl: async url => respond('<html><title>標題</title></html>', { url }) });
  const r = await t.fromWeb('fetchArticle', { url: ART });
  assert.deepStrictEqual(r, { ok: true, data: { html: '<html><title>標題</title></html>', url: ART } });
  assert.deepStrictEqual(clone(t.fetchLog), [ART]);
});

test('代抓文章：不是 TVBS、不是 https、網址格式不對、塞帳密 → 拒絕，而且根本沒有發出請求', async () => {
  const t = load({ fetchImpl: async url => respond('x', { url }) });
  for (const url of ['https://evil.example/x', 'http://news.tvbs.com.tw/x', 'https://news.tvbs.com.tw.evil.example/x', 'https://user:pw@news.tvbs.com.tw/x',
    'https://192.168.1.1/admin', 'file:///etc/passwd', 'javascript:alert(1)', 'abc', '', null, 5]) {
    const r = await t.fromWeb('fetchArticle', { url });
    assert.strictEqual(r.ok, false, String(url));
    assert.match(r.error, /只能抓 TVBS/);
  }
  assert.deepStrictEqual(clone(t.fetchLog), []);
});

test('代抓文章：轉址到 TVBS 以外的網站 → 停止、不回傳內容；HTTP 錯誤與連線失敗有說明', async () => {
  let t = load({ fetchImpl: async () => respond('<html>secret</html>', { url: 'https://evil.example/landing' }) });
  let r = await t.fromWeb('fetchArticle', { url: ART });
  assert.strictEqual(r.ok, false);
  assert.match(r.error, /轉址到 TVBS 以外/);
  assert.strictEqual(r.data, undefined);
  t = load({ fetchImpl: async url => respond('nope', { status: 404, url }) });
  assert.match((await t.fromWeb('fetchArticle', { url: ART })).error, /HTTP 404/);
  t = load({ fetchImpl: async () => { throw new Error('boom'); } });
  assert.match((await t.fromWeb('fetchArticle', { url: ART })).error, /連線失敗/);
});

test('代抓圖片：回傳 data URL；網址要是公開網站、回應要真的是圖片', async () => {
  const IMG = 'https://img.tvbs.com.tw/a.png';
  const t = load({ fetchImpl: async url => respond(PNG_BYTES, { type: 'image/png', url }) });
  const r = await t.fromWeb('fetchImage', { url: IMG, articleUrl: ART });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.data.type, 'image/png');
  assert.strictEqual(r.data.dataUrl, 'data:image/png;base64,' + PNG_BYTES.toString('base64'));
});

test('代抓圖片：內網／本機網址、不是圖片的回應、文章網址不是 TVBS、轉址到內網 → 拒絕', async () => {
  const t = load({ fetchImpl: async url => respond('<html>router</html>', { type: 'text/html', url }) });
  for (const url of ['http://192.168.1.1/a.png', 'http://localhost/a.png', 'https://nas/a.png', 'http://10.0.0.5/x.jpg', 'file:///etc/passwd', 'javascript:alert(1)', '', 'x'.repeat(2500)]) {
    const r = await t.fromWeb('fetchImage', { url, articleUrl: ART });
    assert.strictEqual(r.ok, false, url);
  }
  assert.deepStrictEqual(clone(t.fetchLog), [], '不安全的網址不能發出請求');
  assert.strictEqual((await t.fromWeb('fetchImage', { url: 'https://img.tvbs.com.tw/a.png', articleUrl: 'https://evil.example/x' })).ok, false);
  const notImage = await t.fromWeb('fetchImage', { url: 'https://img.tvbs.com.tw/a.png', articleUrl: ART });
  assert.strictEqual(notImage.ok, false);
  assert.match(notImage.error, /不是圖片/);
  const redirected = load({ fetchImpl: async () => respond(PNG_BYTES, { type: 'image/png', url: 'http://192.168.1.1/a.png' }) });
  const r2 = await redirected.fromWeb('fetchImage', { url: 'https://img.tvbs.com.tw/a.png', articleUrl: ART });
  assert.strictEqual(r2.ok, false);
  assert.match(r2.error, /不安全/);
});

test('代抓：來源不是網頁版頁面一律拒絕（和排程 API 同一套驗證）', async () => {
  const t = load({ fetchImpl: async url => respond('x', { url }) });
  const r = await t.fromWeb('fetchArticle', { url: ART }, { id: 'me', tab: { id: 5 }, url: 'https://evil.example/QuickPatterntool/' });
  assert.deepStrictEqual(r, { ok: false, error: 'not_allowed' });
  assert.deepStrictEqual(clone(t.fetchLog), []);
});

// ---- 不能卡住：心跳失聯、接手留言、手動中止 ----------------------------------------------
const lose = (t, id, step, extra) => t.S.update(id, Object.assign({ step, beat: Date.now() - 60000 }, extra));   // 模擬內容腳本已經 60 秒沒有心跳

test('開始執行會建立「心跳檢查」鬧鐘；進度與心跳更新 beat；結束後兩個鬧鐘都清掉', async () => {
  const t = load();
  await t.S.add(t.item());
  t.fire('post:i1');
  await tick();
  assert.ok(t.alarms.has('post-beat:i1') && t.alarms.has('post-watch:i1'));
  const first = (await t.get('i1')).beat;
  assert.ok(first > 0);
  await new Promise(r => setTimeout(r, 5));
  t.report({ type: 'fbpost:progress', id: 'i1', step: 'text' });
  await tick();
  assert.ok((await t.get('i1')).beat >= first);
  t.report({ type: 'fbpost:result', id: 'i1', ok: true, step: 'publishing' });
  await tick();
  assert.ok(!t.alarms.has('post-beat:i1') && !t.alarms.has('post-watch:i1'));
  assert.strictEqual((await t.get('i1')).beat, undefined);
});

test('心跳正常（最近有回報）→ 檢查不做任何事', async () => {
  const t = load();
  await t.S.add(t.item());
  t.fire('post:i1');
  await tick();
  t.fire('post-beat:i1');
  await tick();
  assert.strictEqual((await t.get('i1')).status, 'running');
});

test('內容腳本失聯（頁面重新載入、分頁當機）：在「輸入文字」等步驟 → 馬上標成失敗並說明，不用等 6 分鐘', async () => {
  const t = load();
  await t.S.add(t.item());
  t.fire('post:i1');
  await tick();
  await lose(t, 'i1', 'text');
  t.fire('post-beat:i1');
  await tick();
  const it = await t.get('i1');
  assert.strictEqual(it.status, 'failed');
  assert.match(it.error, /沒有回應.*停在「輸入文字」.*沒有發佈/);
  assert.ok(!t.alarms.has('post-beat:i1'));
});

test('失聯時已經按下發佈 → 失敗訊息說「貼文可能已經發出」', async () => {
  const t = load();
  await t.S.add(t.item());
  t.fire('post:i1');
  await tick();
  await lose(t, 'i1', 'publishing');
  t.fire('post-beat:i1');
  await tick();
  const it = await t.get('i1');
  assert.strictEqual(it.status, 'failed');
  assert.match(it.error, /可能已經發出/);
});

test('留言階段失聯（發佈後頁面重新載入）：重新交付一次「只留言」的工作；成功 → 已發佈＋留言完成', async () => {
  const t = load();
  await t.S.add(t.item(NOTE_ITEM));
  t.fire('post:i1');
  await tick();
  await lose(t, 'i1', 'commenting');
  t.fire('post-beat:i1');
  await tick();
  assert.strictEqual(t.log.sent.length, 2);
  const job = t.log.sent[1][1].job;
  assert.deepStrictEqual(clone({ mode: job.mode, images: job.images, dryRun: job.dryRun }), { mode: 'comment', images: [], dryRun: false });
  assert.match(job.comment, /utm_medium=/);
  const it = await t.get('i1');
  assert.strictEqual(it.status, 'running');
  assert.strictEqual(it.resume, true);
  t.report({ type: 'fbpost:result', id: 'i1', ok: true, step: 'commenting', commentState: 'done' });
  await tick();
  const done = await t.get('i1');
  assert.strictEqual(done.status, 'done');
  assert.strictEqual(done.commentState, 'done');
  assert.deepStrictEqual(clone(t.log.removed), [101]);
});

test('接手留言也失敗 → 貼文早就發佈了，只能算「已發佈＋留言失敗」，絕不標成失敗', async () => {
  const t = load();
  await t.S.add(t.item(NOTE_ITEM));
  t.fire('post:i1');
  await tick();
  await lose(t, 'i1', 'commenting');
  t.fire('post-beat:i1');
  await tick();
  t.report({ type: 'fbpost:result', id: 'i1', ok: false, step: 'finding', error: '找不到剛發佈的貼文' });
  await tick();
  const it = await t.get('i1');
  assert.strictEqual(it.status, 'done');
  assert.strictEqual(it.commentState, 'failed');
  assert.match(it.commentError, /找不到剛發佈的貼文/);
});

test('接手只做一次：第二次又失聯 → 不再重送，標成已發佈＋留言失敗', async () => {
  const t = load();
  await t.S.add(t.item(NOTE_ITEM));
  t.fire('post:i1');
  await tick();
  await lose(t, 'i1', 'commenting');
  t.fire('post-beat:i1');
  await tick();
  await lose(t, 'i1', 'finding');
  t.fire('post-beat:i1');
  await tick();
  assert.strictEqual(t.log.sent.length, 2, '不能無限重送');
  const it = await t.get('i1');
  assert.strictEqual(it.status, 'done');
  assert.strictEqual(it.commentState, 'failed');
  assert.match(it.commentError, /貼文已經發佈/);
});

test('補留言（mode:comment）失聯：不接手，直接記成留言失敗，貼文維持已發佈', async () => {
  const t = load();
  await t.S.add(t.item(Object.assign({ status: 'done' }, NOTE_ITEM)));
  await t.fromPanel({ type: 'poster:start', id: 'i1', mode: 'comment' });
  await tick();
  await lose(t, 'i1', 'finding');
  t.fire('post-beat:i1');
  await tick();
  assert.strictEqual(t.log.sent.length, 1);
  const it = await t.get('i1');
  assert.strictEqual(it.status, 'done');
  assert.strictEqual(it.commentState, 'failed');
});

test('手動中止：還沒發佈 → 標成失敗「沒有發佈」，並叫分頁的腳本停手', async () => {
  const t = load();
  await t.S.add(t.item());
  t.fire('post:i1');
  await tick();
  t.report({ type: 'fbpost:progress', id: 'i1', step: 'images' });
  await tick();
  const r = await t.fromPanel({ type: 'poster:cancel', id: 'i1' });
  assert.deepStrictEqual(clone(r), { ok: true });
  await tick();
  const it = await t.get('i1');
  assert.strictEqual(it.status, 'failed');
  assert.match(it.error, /已手動中止，沒有發佈/);
  assert.ok(t.log.sent.some(([id, m]) => id === 101 && m.type === 'fbpost:cancel'));
  assert.ok(!t.alarms.has('post-beat:i1') && !t.alarms.has('post-watch:i1'));
});

test('手動中止：已按下發佈 → 訊息警告貼文可能已經發出；留言階段 → 已發佈＋留言失敗（可補留言）', async () => {
  let t = load();
  await t.S.add(t.item());
  t.fire('post:i1');
  await tick();
  t.report({ type: 'fbpost:progress', id: 'i1', step: 'publishing' });
  await tick();
  await t.fromPanel({ type: 'poster:cancel', id: 'i1' });
  await tick();
  assert.match((await t.get('i1')).error, /可能已經發出/);

  t = load();
  await t.S.add(t.item(NOTE_ITEM));
  t.fire('post:i1');
  await tick();
  t.report({ type: 'fbpost:progress', id: 'i1', step: 'commenting' });
  await tick();
  await t.fromPanel({ type: 'poster:cancel', id: 'i1' });
  await tick();
  const it = await t.get('i1');
  assert.strictEqual(it.status, 'done');
  assert.strictEqual(it.commentState, 'failed');
  assert.match(it.commentError, /留言已手動中止/);
});

test('手動中止：沒在執行的回錯誤；網頁版也能中止（同一套來源驗證）', async () => {
  const t = load();
  await t.S.add(t.item());
  assert.strictEqual((await t.fromPanel({ type: 'poster:cancel', id: 'i1' })).ok, false);
  assert.strictEqual((await t.fromPanel({ type: 'poster:cancel', id: 'nope' })).ok, false);
  t.fire('post:i1');
  await tick();
  assert.deepStrictEqual(await t.fromWeb('cancel', { id: 'i1' }, { id: 'me', tab: { id: 5 }, url: 'https://evil.example/QuickPatterntool/' }), { ok: false, error: 'not_allowed' });
  assert.strictEqual((await t.get('i1')).status, 'running');
  assert.deepStrictEqual(await t.fromWeb('cancel', { id: 'i1' }), { ok: true });
  assert.strictEqual((await t.get('i1')).status, 'failed');
});

test('發佈完成後請背景重新整理：重整 → 等載入完 → 重新交付「只留言」的工作（fresh）；成功 → 已發佈＋留言完成、關分頁', async () => {
  const t = load();
  await t.S.add(t.item(NOTE_ITEM));
  t.fire('post:i1');
  await tick();
  assert.strictEqual(t.log.sent[0][1].job.reload, true);
  t.report({ type: 'fbpost:progress', id: 'i1', step: 'reloading' });
  t.report({ type: 'fbpost:reload', id: 'i1' });
  await tick();
  assert.deepStrictEqual(clone(t.log.reloaded), [101]);
  let it = await t.get('i1');
  assert.strictEqual(it.step, 'reloading');
  assert.strictEqual(it.status, 'running');
  assert.strictEqual(t.log.sent.length, 1, '頁面還沒載入完，不能先交付');
  t.loaded(999);   // 別的分頁載入完不算
  await tick();
  assert.strictEqual(t.log.sent.length, 1);
  t.loaded(101);
  await tick();
  assert.strictEqual(t.log.sent.length, 2);
  const job = t.log.sent[1][1].job;
  assert.deepStrictEqual(clone({ mode: job.mode, images: job.images, dryRun: job.dryRun, reload: job.reload, fresh: job.fresh }), { mode: 'comment', images: [], dryRun: false, reload: false, fresh: true });
  assert.match(job.comment, /utm_medium=/);
  assert.strictEqual(t.handlers.updated.length, 0, '監聽要拆掉');
  it = await t.get('i1');
  assert.strictEqual(it.step, 'finding');
  assert.strictEqual(it.resume, true);
  t.report({ type: 'fbpost:result', id: 'i1', ok: true, step: 'commenting', commentState: 'done' });
  await tick();
  const done = await t.get('i1');
  assert.strictEqual(done.status, 'done');
  assert.strictEqual(done.commentState, 'done');
  assert.deepStrictEqual(clone(t.log.removed), [101]);
});

test('重新整理失敗（分頁不見了）→ 貼文早已發佈：算「已發佈＋留言失敗」，不標成失敗', async () => {
  const t = load({ reloadFails: true });
  await t.S.add(t.item(NOTE_ITEM));
  t.fire('post:i1');
  await tick();
  t.report({ type: 'fbpost:reload', id: 'i1' });
  await tick();
  const it = await t.get('i1');
  assert.strictEqual(it.status, 'done');
  assert.strictEqual(it.commentState, 'failed');
  assert.match(it.commentError, /重新整理頁面失敗/);
  assert.strictEqual(t.log.sent.length, 1);
});

test('重新整理途中按「中止」：不再交付留言工作', async () => {
  const t = load();
  await t.S.add(t.item(NOTE_ITEM));
  t.fire('post:i1');
  await tick();
  t.report({ type: 'fbpost:reload', id: 'i1' });
  await tick();
  await t.fromPanel({ type: 'poster:cancel', id: 'i1' });
  await tick();
  t.loaded(101);
  await tick();
  assert.strictEqual(t.log.sent.filter(([, m]) => m.type === 'fbpost:run').length, 1);
  const it = await t.get('i1');
  assert.strictEqual(it.status, 'done');
  assert.strictEqual(it.commentState, 'failed');
});

test('重新整理的請求只有「發貼文」的正式執行才接受：試跑、補留言、重複請求、別的分頁都忽略', async () => {
  const t = load();
  await t.S.add(t.item(NOTE_ITEM));
  t.fire('post:i1');
  await tick();
  t.report({ type: 'fbpost:reload', id: 'i1' }, 555);                 // 不是我們開的分頁
  await tick();
  assert.deepStrictEqual(t.log.reloaded, []);
  t.report({ type: 'fbpost:reload', id: 'i1' });
  await tick();
  t.report({ type: 'fbpost:reload', id: 'i1' });                       // 重複
  await tick();
  assert.deepStrictEqual(clone(t.log.reloaded), [101]);

  const d = load();
  await d.S.add(d.item(NOTE_ITEM));
  await d.fromPanel({ type: 'poster:start', id: 'i1', dryRun: true });
  await tick();
  d.report({ type: 'fbpost:reload', id: 'i1' });
  await tick();
  assert.deepStrictEqual(d.log.reloaded, [], '試跑不會發佈，不重整');
});

// ---- 背景執行（v6.30）----------------------------------------------------------------
test('背景執行關閉（預設）：分頁在前景開，成功後切回原本的分頁', async () => {
  const t = load();
  await t.S.add(t.item());
  t.fire('post:i1');
  await tick();
  assert.strictEqual(t.log.created[0].active, true);
  t.report({ type: 'fbpost:result', id: 'i1', ok: true, step: 'publishing' });
  await tick();
  assert.deepStrictEqual(clone(t.log.updated), [[7, { active: true }]]);
});

test('背景執行開啟：分頁用 active:false 開，不搶焦點；成功後關分頁但不去切別的分頁', async () => {
  const t = load();
  await t.S.setSettings({ background: true });
  await t.S.add(t.item());
  t.fire('post:i1');
  await tick();
  assert.deepStrictEqual(clone(t.log.created), [{ url: PAGE, active: false }]);
  t.report({ type: 'fbpost:result', id: 'i1', ok: true, step: 'publishing' });
  await tick();
  assert.deepStrictEqual(clone(t.log.removed), [101]);
  assert.deepStrictEqual(t.log.updated, [], '背景執行沒有切走過，也就不用切回去');
});

test('背景執行：重新整理與接手留言的流程不變', async () => {
  const t = load();
  await t.S.setSettings({ background: true });
  await t.S.add(t.item(NOTE_ITEM));
  t.fire('post:i1');
  await tick();
  t.report({ type: 'fbpost:reload', id: 'i1' });
  await tick();
  t.loaded(101);
  await tick();
  assert.strictEqual(t.log.sent[1][1].job.mode, 'comment');
  t.report({ type: 'fbpost:result', id: 'i1', ok: true, step: 'commenting', commentState: 'done' });
  await tick();
  assert.strictEqual((await t.get('i1')).status, 'done');
  assert.deepStrictEqual(t.log.updated, []);
});

test('網頁版 API：getSettings／setSettings（只收布林）', async () => {
  const t = load();
  assert.deepStrictEqual(clone((await t.fromWeb('getSettings')).data), { background: false });
  assert.strictEqual((await t.fromWeb('setSettings', { background: true })).ok, true);
  assert.deepStrictEqual(clone((await t.fromWeb('getSettings')).data), { background: true });
  for (const bad of [{ background: 'yes' }, { background: 1 }, {}]) assert.strictEqual((await t.fromWeb('setSettings', bad)).ok, false);
  assert.deepStrictEqual(clone((await t.fromWeb('getSettings')).data), { background: true }, '亂填不會改到設定');
  assert.strictEqual((await t.fromWeb('setSettings', { background: false }, { id: 'me', tab: { id: 5 }, url: 'https://evil.example/' })).ok, false, '別的網站不能改');
  assert.deepStrictEqual(clone((await t.fromWeb('getSettings')).data), { background: true });
});

test('記錄「發文用了幾毫秒」：發佈完成的時間點 − 開始時間；留言與補留言不會洗掉它', async () => {
  const t = load();
  await t.S.add(t.item(NOTE_ITEM));
  t.fire('post:i1');
  await tick();
  const started = Date.now() - 60000;
  await t.S.update('i1', { startedAt: started });
  t.report({ type: 'fbpost:reload', id: 'i1', postedAt: started + 28000 });
  await tick();
  assert.strictEqual((await t.get('i1')).postMs, 28000);
  t.loaded(101);
  await tick();
  t.report({ type: 'fbpost:result', id: 'i1', ok: true, step: 'commenting', commentState: 'done' });
  await tick();
  assert.strictEqual((await t.get('i1')).postMs, 28000);
  await t.fromPanel({ type: 'poster:start', id: 'i1', mode: 'comment' });
  await tick();
  assert.strictEqual((await t.get('i1')).postMs, 28000, '補留言不會洗掉發文耗時');

  const u = load();
  await u.S.add(u.item());   // 沒有留言：直接回報結果
  u.fire('post:i1');
  await tick();
  const st = Date.now() - 60000;
  await u.S.update('i1', { startedAt: st });
  u.report({ type: 'fbpost:result', id: 'i1', ok: true, step: 'publishing', postedAt: st + 12345 });
  await tick();
  assert.strictEqual((await u.get('i1')).postMs, 12345);

  const v = load();   // 亂填的時間點不收
  await v.S.add(v.item());
  v.fire('post:i1');
  await tick();
  v.report({ type: 'fbpost:result', id: 'i1', ok: true, step: 'publishing', postedAt: 'x' });
  await tick();
  assert.strictEqual((await v.get('i1')).postMs, undefined);
});

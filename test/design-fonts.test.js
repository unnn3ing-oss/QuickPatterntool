// 設計：字型註冊表與載入器（用 stub 的 document／FontFace，不碰網路）
const test = require('node:test');
const assert = require('node:assert/strict');
const { createFonts, FONTS, GOOGLE_CSS } = require('../design-fonts.js');

// stub：記錄 fonts.load 的參數、head.appendChild 的節點、FontFace 的建立
function makeEnv(opts = {}) {
  const log = { loads: [], appended: [], faces: [], added: [] };
  const document = {
    head: { appendChild: n => log.appended.push(n) },
    createElement: tag => ({ tag }),
    fonts: {
      load: (spec, text) => {
        log.loads.push({ spec, text });
        if (opts.hang) return new Promise(() => {});
        if (opts.fail) return Promise.reject(new Error('x'));
        return Promise.resolve([]);
      },
      add: f => log.added.push(f),
    },
  };
  class FontFace {
    constructor(family, src, desc) { this.family = family; this.src = src; this.desc = desc; log.faces.push(this); }
    load() { return opts.fail ? Promise.reject(new Error('x')) : Promise.resolve(this); }
  }
  return { env: { document, FontFace, setTimeout, clearTimeout }, log };
}
const docWith = (...objs) => ({ pages: [{ objects: objs }] });
const txt = (font, text) => ({ type: 'text', font, text });

test('註冊表順序與欄位', () => {
  assert.deepEqual(FONTS.map(f => f.id), ['WHZ-Heavy', 'noto-serif-tc-400', 'noto-serif-tc-700', 'cactus', 'system']);
  assert.equal(FONTS[3].url, 'fonts/cactus-classical-serif.woff2');
});

test('沒用到的字型不發請求', async () => {
  const { env, log } = makeEnv();
  const f = createFonts(env);
  assert.equal(await f.ready(docWith(txt('WHZ-Heavy', '你好'))), true);
  assert.equal(log.appended.length, 0);
  assert.equal(log.faces.length, 0);
  assert.ok(log.loads.every(l => /WHZ-Heavy/.test(l.spec)), '只該載 WHZ-Heavy');
  assert.equal(f.state('cactus'), 'idle');
  assert.equal(f.state('noto-serif-tc-400'), 'idle');
});

test('選到 google 字型才插入樣式表，且只插一次', async () => {
  const { env, log } = makeEnv();
  const f = createFonts(env);
  assert.equal(log.appended.length, 0);
  await f.load('noto-serif-tc-400');
  await f.load('noto-serif-tc-700');
  await f.ensureText('noto-serif-tc-700', '新字');
  assert.equal(log.appended.length, 1);
  assert.equal(log.appended[0].rel, 'stylesheet');
  assert.equal(log.appended[0].href, GOOGLE_CSS);
  assert.equal(f.state('noto-serif-tc-400'), 'loaded');
});

test('ensureText 只補新字', async () => {
  const { env, log } = makeEnv();
  const f = createFonts(env);
  await f.ensureText('noto-serif-tc-400', '你好');
  assert.deepEqual(log.loads.at(-1), { spec: '400 80px "Noto Serif TC"', text: '你好' });
  await f.ensureText('noto-serif-tc-400', '你好嗎');
  assert.equal(log.loads.at(-1).text, '嗎');
  const n = log.loads.length;
  await f.ensureText('noto-serif-tc-400', '你好');
  assert.equal(log.loads.length, n, '沒有新字不該發請求');
  await f.ensureText('noto-serif-tc-700', '你');
  assert.equal(log.loads.at(-1).spec, '700 80px "Noto Serif TC"');
});

test('cactus 以 FontFace 載入 fonts/cactus-classical-serif.woff2', async () => {
  const { env, log } = makeEnv();
  const f = createFonts(env);
  assert.equal(await f.load('cactus'), true);
  assert.equal(log.faces.length, 1);
  assert.equal(log.faces[0].family, 'Cactus Classical Serif');
  assert.match(log.faces[0].src, /fonts\/cactus-classical-serif\.woff2/);
  assert.equal(log.added.length, 1);
  assert.equal(f.state('cactus'), 'loaded');
  await f.load('cactus');
  assert.equal(log.faces.length, 1, '只載一次');
});

test('載入失敗回 false、state 為 failed、onFontLoad 收到 failed', async () => {
  for (const id of ['cactus', 'noto-serif-tc-400']) {
    const { env } = makeEnv({ fail: true });
    const f = createFonts(env);
    const seen = [];
    f.onFontLoad((i, s) => seen.push([i, s]));
    assert.equal(await f.load(id), false);
    assert.equal(f.state(id), 'failed');
    assert.deepEqual(seen, [[id, 'loading'], [id, 'failed']]);
  }
});

test('onFontLoad 可取消、gen 在載好後遞增', async () => {
  const { env } = makeEnv();
  const f = createFonts(env);
  const seen = [];
  const off = f.onFontLoad((i, s) => seen.push(s));
  const g0 = f.gen();
  await f.load('cactus');
  assert.ok(f.gen() > g0);
  off();
  const n = seen.length;
  await f.load('noto-serif-tc-400');
  assert.equal(seen.length, n);
});

test('ready 逾時回 false', async () => {
  const { env } = makeEnv({ hang: true });
  const f = createFonts(env);
  const t0 = Date.now();
  const ok = await f.ready(docWith(txt('noto-serif-tc-400', '你好')), { timeout: 50 });
  assert.equal(ok, false);
  assert.ok(Date.now() - t0 < 100 + 50, '要在約 100ms 內結束');
});

test('ready 對 google 字型補載文件裡的字', async () => {
  const { env, log } = makeEnv();
  const f = createFonts(env);
  assert.equal(await f.ready(docWith(txt('noto-serif-tc-700', '早安'), txt('noto-serif-tc-700', '晚安'))), true);
  const texts = log.loads.map(l => l.text).join('');
  for (const ch of '早安晚') assert.ok(texts.includes(ch));
});

test('fontCss 帶粗細與備用字串', () => {
  const { env } = makeEnv();
  const f = createFonts(env);
  assert.match(f.fontCss('noto-serif-tc-700', 80), /^700 80px "Noto Serif TC", "Noto Serif TC", "Songti TC", "PMingLiU", "MingLiU", serif$/);
  assert.match(f.fontCss('cactus', 40), /^400 40px "Cactus Classical Serif", .*serif$/);
  assert.match(f.fontCss('system', 20), /^400 20px "PingFang TC", "Microsoft JhengHei", "Noto Sans TC", sans-serif$/);
  assert.equal(f.fontCss('不存在', 30), f.fontCss('WHZ-Heavy', 30));
  assert.match(f.fontCss('WHZ-Heavy', 30), /^400 30px "WHZ-Heavy", "PingFang TC"/);
});

test('list 列出五個字型與狀態；system 恆為 loaded', async () => {
  const { env } = makeEnv();
  const f = createFonts(env);
  const l = f.list();
  assert.equal(l.length, 5);
  assert.equal(l.find(x => x.id === 'system').state, 'loaded');
  assert.equal(l.find(x => x.id === 'cactus').state, 'idle');
  assert.equal(await f.load('system'), true);
});

// 修正：google 字型要等樣式表載好才 document.fonts.load（否則 @font-face 還沒註冊，load 回空陣列會被誤判成已載入）
function linkEnv() {
  const { env, log } = makeEnv();
  const handlers = {};
  env.document.createElement = tag => ({ tag, addEventListener: (type, fn) => { handlers[type] = fn; } });
  return { env, log, fire: type => handlers[type]() };
}
test('google 字型：樣式表載好之前不呼叫 fonts.load，載好後才呼叫', async () => {
  const { env, log, fire } = linkEnv();
  const f = createFonts(env);
  const p = f.load('noto-serif-tc-400');
  await new Promise(r => setTimeout(r, 10));
  assert.equal(log.loads.length, 0, '樣式表還沒載好');
  assert.equal(f.state('noto-serif-tc-400'), 'loading');
  fire('load');
  assert.equal(await p, true);
  assert.equal(log.loads.length, 1);
  assert.equal(f.state('noto-serif-tc-400'), 'loaded');
});
test('google 字型：樣式表載入失敗（離線）時狀態是 failed、ensureText 也回 false', async () => {
  const { env, log, fire } = linkEnv();
  const f = createFonts(env);
  const seen = [];
  f.onFontLoad((id, st) => seen.push(st));
  const p = f.load('noto-serif-tc-700');
  fire('error');
  assert.equal(await p, false);
  assert.equal(f.state('noto-serif-tc-700'), 'failed');
  assert.equal(await f.ensureText('noto-serif-tc-700', '新字'), false);
  assert.equal(log.loads.length, 0, '沒有樣式表就不呼叫 fonts.load');
  assert.ok(seen.includes('failed'));
});

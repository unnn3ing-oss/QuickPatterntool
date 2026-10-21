const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const read = f => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
const manifest = JSON.parse(read('manifest.json'));
const changelog = JSON.parse(read('changelog.json'));

test('manifest 版本是 6.30', () => {
  assert.strictEqual(manifest.version, '6.30');
});

test('content_scripts 只注入熱門新聞庫、Facebook（粉專排程）與網頁版（排程橋接）', () => {
  assert.strictEqual(manifest.content_scripts.length, 3);
  const hot = manifest.content_scripts.find(cs => cs.js.includes('bridge.js'));
  assert.deepStrictEqual(hot.matches, ['https://unnn3ing-oss.github.io/hottopic/*']);
  assert.deepStrictEqual(hot.js, ['bridge.js']);
  assert.strictEqual(hot.run_at, 'document_idle');
  const fb = manifest.content_scripts.find(cs => cs.js.includes('fbpost.js'));
  assert.deepStrictEqual(fb.matches, ['https://www.facebook.com/*']);
  assert.deepStrictEqual(fb.js, ['fbpost.js']);
  assert.strictEqual(fb.run_at, 'document_idle');
  assert.ok(!fb.all_frames);
  const web = manifest.content_scripts.find(cs => cs.js.includes('schedbridge.js'));
  assert.deepStrictEqual(web.matches, ['https://unnn3ing-oss.github.io/QuickPatterntool/*']);
  assert.deepStrictEqual(web.js, ['schedbridge.js']);
  assert.strictEqual(web.run_at, 'document_idle');
});

test('粉專排程需要 alarms、notifications、unlimitedStorage（圖片存在 storage.local）', () => {
  for (const p of ['alarms', 'notifications', 'unlimitedStorage']) assert.ok(manifest.permissions.includes(p), p);
});

test('permissions 仍含 storage 與 sidePanel，host_permissions 沒有變動', () => {
  assert.ok(manifest.permissions.includes('storage'));
  assert.ok(manifest.permissions.includes('sidePanel'));
  assert.deepStrictEqual(manifest.host_permissions, ['<all_urls>']);
});

test('changelog 有目前版本，且 5.00 說明了粉專排程', () => {
  const c = changelog[manifest.version];
  assert.ok(c && c.summary && c.items.length, '目前版本沒有 changelog');
  assert.ok(changelog['5.00'].items.join('').includes('粉專'));
});

test('changelog 有 4.50 且有 summary 與 items', () => {
  const c = changelog['4.50'];
  assert.ok(c && typeof c.summary === 'string' && c.summary.length > 0);
  assert.ok(Array.isArray(c.items) && c.items.length > 0);
});

test('網頁版專用的排程抽屜與快速產圖（schedweb、qfweb）在 SKIP 清單，不會被外掛下載；quickfill.js 不在（側邊欄與背景要用）', () => {
  const m = read('updater.js').match(/const SKIP = \[([\s\S]*?)\];/);
  const skip = new Function('return [' + m[1] + ']')();
  for (const f of ['schedweb.js', 'schedweb.css', 'qfweb.js', 'qfweb.css']) {
    assert.strictEqual(skip.some(re => re.test(f)), true, f);
    assert.ok(fs.existsSync(path.join(__dirname, '..', f)), f + ' 不存在');
  }
  assert.strictEqual(skip.some(re => re.test('quickfill.js')), false);
  for (const f of ['schedweb.js', 'qfweb.js', 'quickfill.js']) assert.ok(read('index.html').includes(`src="${f}"`), `網頁版要載入 ${f}`);
  // 網頁版 CSP 的 connect-src 不能放寬：網頁自己不能連 TVBS，文章與圖片一律請外掛代抓
  assert.ok(/connect-src https:\/\/api\.github\.com https:\/\/raw\.githubusercontent\.com;/.test(read('index.html')), 'index.html 的 connect-src 被改動了');
});

test('粉專排程的檔案都要隨外掛更新（不在 SKIP 清單）', () => {
  const m = read('updater.js').match(/const SKIP = \[([\s\S]*?)\];/);
  const skip = new Function('return [' + m[1] + ']')();
  for (const f of ['scheduler.js', 'poster.js', 'fbpost.js', 'schedbridge.js', 'schedui.js', 'sched.css', 'schedpanel.js']) {
    assert.strictEqual(skip.some(re => re.test(f)), false, f);
    assert.ok(fs.existsSync(path.join(__dirname, '..', f)), f + ' 不存在');
  }
});

test('updater SKIP 會略過 test/ 但不略過 bridge.js', () => {
  const m = read('updater.js').match(/const SKIP = \[([\s\S]*?)\];/);
  assert.ok(m, '找不到 SKIP 陣列');
  const skip = new Function('return [' + m[1] + ']')();
  const skipped = p => skip.some(re => re.test(p));
  assert.strictEqual(skipped('test/bridge.test.js'), true);
  assert.strictEqual(skipped('bridge.js'), false);
});

test('deploy.js 的 SKIP 與 updater.js 一致（都略過 test/）', () => {
  const get = f => {
    const m = read(f).match(/const SKIP = \[([\s\S]*?)\];/);
    assert.ok(m, f + ' 找不到 SKIP 陣列');
    return new Function('return [' + m[1] + ']')().map(String);
  };
  assert.deepStrictEqual(get('deploy.js'), get('updater.js'));
});

test('updater SKIP 會略過網頁版剪輯檔案（edit.css、edit-*.js、fonts/）', () => {
  const m = read('updater.js').match(/const SKIP = \[([\s\S]*?)\];/);
  const skip = new Function('return [' + m[1] + ']')();
  const skipped = p => skip.some(re => re.test(p));
  for (const f of ['edit.css', 'edit-core.js', 'edit-ui.js', 'edit-export.js', 'fonts/cactus-classical-serif.woff2', 'fonts/OFL-CactusClassicalSerif.txt']) assert.strictEqual(skipped(f), true, f);
  assert.strictEqual(skipped('whz-heavy.ttf'), false, '套版用的字型外掛也要');
  assert.strictEqual(skipped('app.js'), false);
});

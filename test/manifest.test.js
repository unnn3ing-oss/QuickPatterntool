const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const read = f => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
const manifest = JSON.parse(read('manifest.json'));
const changelog = JSON.parse(read('changelog.json'));

test('manifest 版本是 5.03', () => {
  assert.strictEqual(manifest.version, '5.03');
});

test('content_scripts 只注入熱門新聞庫與 Facebook（粉專排程）', () => {
  assert.strictEqual(manifest.content_scripts.length, 2);
  const hot = manifest.content_scripts.find(cs => cs.js.includes('bridge.js'));
  assert.deepStrictEqual(hot.matches, ['https://unnn3ing-oss.github.io/hottopic/*']);
  assert.deepStrictEqual(hot.js, ['bridge.js']);
  assert.strictEqual(hot.run_at, 'document_idle');
  const fb = manifest.content_scripts.find(cs => cs.js.includes('fbpost.js'));
  assert.deepStrictEqual(fb.matches, ['https://www.facebook.com/*']);
  assert.deepStrictEqual(fb.js, ['fbpost.js']);
  assert.strictEqual(fb.run_at, 'document_idle');
  assert.ok(!fb.all_frames);
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

test('粉專排程的檔案都要隨外掛更新（不在 SKIP 清單）', () => {
  const m = read('updater.js').match(/const SKIP = \[([\s\S]*?)\];/);
  const skip = new Function('return [' + m[1] + ']')();
  for (const f of ['scheduler.js', 'poster.js', 'fbpost.js', 'schedpanel.js']) {
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

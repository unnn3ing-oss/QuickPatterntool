const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const read = f => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
const manifest = JSON.parse(read('manifest.json'));
const changelog = JSON.parse(read('changelog.json'));

test('manifest 版本是 4.51', () => {
  assert.strictEqual(manifest.version, '4.51');
});

test('content_scripts 只注入熱門新聞庫', () => {
  assert.strictEqual(manifest.content_scripts.length, 1);
  const cs = manifest.content_scripts[0];
  assert.deepStrictEqual(cs.matches, ['https://unnn3ing-oss.github.io/hottopic/*']);
  assert.deepStrictEqual(cs.js, ['bridge.js']);
  assert.strictEqual(cs.run_at, 'document_idle');
});

test('permissions 仍含 storage 與 sidePanel，host_permissions 沒有變動', () => {
  assert.ok(manifest.permissions.includes('storage'));
  assert.ok(manifest.permissions.includes('sidePanel'));
  assert.deepStrictEqual(manifest.host_permissions, ['<all_urls>']);
});

test('changelog 有 4.50 且有 summary 與 items', () => {
  const c = changelog['4.50'];
  assert.ok(c && typeof c.summary === 'string' && c.summary.length > 0);
  assert.ok(Array.isArray(c.items) && c.items.length > 0);
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

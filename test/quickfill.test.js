const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// quickfill.js 是給瀏覽器用的：在最小的假 window／document 裡載入它（沒有 qfUrl 就只匯出純函式）
const win = {};
win.window = win;
win.document = { getElementById: () => null };
vm.runInNewContext(fs.readFileSync(path.join(__dirname, '..', 'quickfill.js'), 'utf8'), win);
const QF = win.QuickFill;

test('resolveTitle：override 優先', () => {
  assert.strictEqual(QF.resolveTitle('卡片改標', '文章標題'), '卡片改標');
});

test('resolveTitle：override 空白退回文章標題', () => {
  assert.strictEqual(QF.resolveTitle('  ', '文章標題'), '文章標題');
  assert.strictEqual(QF.resolveTitle(null, '文章標題'), '文章標題');
  assert.strictEqual(QF.resolveTitle(undefined, '文章標題'), '文章標題');
});

test('resolveTitle：都沒有回空字串', () => {
  assert.strictEqual(QF.resolveTitle(null, null), '');
  assert.strictEqual(QF.resolveTitle(undefined, undefined), '');
});

test('resolveTitle：不改動內容', () => {
  const t = '平均爽領315萬！勞退　結清潮湧現：6百名勞工';
  assert.strictEqual(QF.resolveTitle(t, 'x'), t);
});

test('breakTitle 對改標的換行維持原本行為（回歸）', () => {
  assert.strictEqual(QF.breakTitle('蔡英文現身！12萬洋流挺沈伯洋　賴清德：對手認知作戰已開始').length, 3);
});

test('overrideLines：改標有換行就照小編排好的分行，不再重新斷行', () => {
  assert.deepStrictEqual(Array.from(QF.overrideLines('定期保養的 5 個重點\n第 3 項最多人漏掉')), ['定期保養的 5 個重點', '第 3 項最多人漏掉']);
  assert.deepStrictEqual(Array.from(QF.overrideLines('iPhone 17 Pro開賣\n果粉：價格還能接受')), ['iPhone 17 Pro開賣', '果粉：價格還能接受']);
});

test('overrideLines：單行改標交給 breakTitle', () => {
  const t = '蔡英文現身！12萬洋流挺沈伯洋　賴清德：對手認知作戰已開始';
  assert.deepStrictEqual(Array.from(QF.overrideLines(t)), Array.from(QF.breakTitle(t)));
});

test('overrideOneLine：複製用的標題是單行（換行接成空格），單行原樣', () => {
  assert.strictEqual(QF.overrideOneLine('A B\nC'), 'A B C');
  assert.strictEqual(QF.overrideOneLine('平均爽領315萬！勞退　結清潮'), '平均爽領315萬！勞退　結清潮');
});

// vm 內建立的陣列跟測試檔不同 realm，轉一次才能 deepStrictEqual
const pick = (...a) => Array.from(QF.pickTags(...a));

test('pickTags：只留 2～3 字，最多 3 個', () => {
  assert.deepStrictEqual(pick(['沈伯洋', '政治', '民進黨主席', '柯', '國民黨', '立法院']), ['沈伯洋', '政治', '國民黨']);
});

test('pickTags：不夠 3 個就少於 3 個，不補長短標籤', () => {
  assert.deepStrictEqual(pick(['柯', '沈伯洋辦公室', '政治']), ['政治']);
  assert.deepStrictEqual(pick(['台灣大哥大', 'A']), []);
});

test('pickTags：無重複文字的優先，重複的最後才補', () => {
  assert.deepStrictEqual(pick(['沈伯洋', '伯洋', '政治', '立委']), ['政治', '立委', '沈伯洋']);
  assert.deepStrictEqual(pick(['沈伯洋', '伯洋']), ['沈伯洋', '伯洋']);
});

test('formatCopy：沒有 2～3 字標籤就略過 hashtag 那一行', () => {
  assert.strictEqual(QF.formatCopy({ title: '標題', caption: '', tags: ['台灣大哥大'] }), '【標題】');
});

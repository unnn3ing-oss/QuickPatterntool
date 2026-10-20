// =====================================================================================
// 剪輯介面（edit-ui.js）的瀏覽器流程測試：開真的 index.html、切到「剪輯」分頁，匯入素材，
// 然後用真的滑鼠與快捷鍵操作每一個主要功能，每一步都用 Q.ui.state.project 斷言結果，
// 並檢查 core.checkInvariants 為空、頁面沒有 console error、沒有 CSP 違規。最後呼叫匯出。
//
// 執行：node test/edit-ui.e2e.js
//   （不叫 *.test.js：需要 Chromium，不讓 node --test 去跑它）
//   EDIT_FIXTURES=<資料夾>   測試素材（放 landscape-720p-6s.webm、portrait-720x1280-4s.webm、noaudio-25fps-3s.webm、music-8s.webm、still.png）；
//                            沒指定或缺檔就用 ffmpeg 產生到暫存資料夾（VP9／Opus＋PNG）
//   SHOTS=<資料夾>           截圖輸出位置（沒設就不存圖）
//   CHROMIUM=<路徑>          瀏覽器執行檔（沒設時用 /opt/pw-browsers/chromium，再沒有就用 playwright 預設）
//   EDIT_VIEWPORTS=1600x1000,1280x800   要跑的視窗大小（逗號分隔）
// =====================================================================================
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { execFileSync } = require('child_process');

let chromium;
try { ({ chromium } = require('playwright')); } catch (_) { ({ chromium } = require('/opt/node22/lib/node_modules/playwright')); }

const ROOT = path.resolve(__dirname, '..');
const SHOTS = process.env.SHOTS ? path.resolve(process.env.SHOTS) : null;
const EXE = process.env.CHROMIUM || (fs.existsSync('/opt/pw-browsers/chromium') ? '/opt/pw-browsers/chromium' : undefined);
const VIEWPORTS = (process.env.EDIT_VIEWPORTS || '1600x1000,1280x800').split(',').map(s => s.split('x').map(Number));
const FILES = { land: 'landscape-720p-6s.webm', port: 'portrait-720x1280-4s.webm', mute: 'noaudio-25fps-3s.webm', music: 'music-8s.webm', still: 'still.png' };

let failed = 0, passed = 0;
function ok(cond, msg) { if (cond) { passed++; console.log('  ok  ', msg); } else { failed++; console.log('  FAIL', msg); } return !!cond; }
function eq(a, b, msg) { const r = JSON.stringify(a) === JSON.stringify(b); if (!r) console.log('       期望', JSON.stringify(b), '實際', JSON.stringify(a)); return ok(r, msg); }
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ---- 素材 ------------------------------------------------------------------------------
function ffmpeg(args) { execFileSync('ffmpeg', ['-v', 'error', '-y', ...args], { stdio: 'inherit' }); }
function fixturesDir() {
  const want = process.env.EDIT_FIXTURES;
  const all = Object.values(FILES);
  if (want && all.every(f => fs.existsSync(path.join(want, f)))) return want;
  const dir = path.join(os.tmpdir(), 'qpt-edit-ui-fixtures');
  fs.mkdirSync(dir, { recursive: true });
  const has = f => fs.existsSync(path.join(dir, f)), out = f => path.join(dir, f);
  if (!has(FILES.land)) ffmpeg(['-f', 'lavfi', '-i', 'testsrc2=size=1280x720:rate=30:duration=6', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=6:sample_rate=48000',
    '-ac', '2', '-c:v', 'libvpx-vp9', '-b:v', '1M', '-c:a', 'libopus', '-shortest', out(FILES.land)]);
  if (!has(FILES.port)) ffmpeg(['-f', 'lavfi', '-i', 'testsrc2=size=720x1280:rate=30:duration=4', '-f', 'lavfi', '-i', 'sine=frequency=660:duration=4:sample_rate=48000',
    '-ac', '2', '-c:v', 'libvpx-vp9', '-b:v', '800k', '-c:a', 'libopus', '-shortest', out(FILES.port)]);
  if (!has(FILES.mute)) ffmpeg(['-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=25:duration=3', '-c:v', 'libvpx-vp9', '-b:v', '500k', out(FILES.mute)]);
  if (!has(FILES.music)) ffmpeg(['-f', 'lavfi', '-i', 'sine=frequency=330:duration=8:sample_rate=48000', '-ac', '2', '-c:a', 'libopus', out(FILES.music)]);
  if (!has(FILES.still)) ffmpeg(['-f', 'lavfi', '-i', 'testsrc2=size=1600x1200', '-frames:v', '1', out(FILES.still)]);
  return dir;
}

// ---- 本機伺服器（WebCodecs 需要 localhost 這種安全來源）-----------------------------------
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json',
  '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.ttf': 'font/ttf' };
function serve() {
  return new Promise(res => {
    const server = http.createServer((req, rsp) => {
      const rel = decodeURIComponent(new URL(req.url, 'http://x').pathname).replace(/^\/+/, '') || 'index.html';
      const file = path.join(ROOT, rel);
      if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { rsp.writeHead(404); rsp.end(); return; }
      rsp.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream' });
      fs.createReadStream(file).pipe(rsp);
    }).listen(0, '127.0.0.1', () => res({ server, base: `http://127.0.0.1:${server.address().port}/index.html` }));
  });
}

// ---- 頁面端的小工具 --------------------------------------------------------------------
const settle = page => page.evaluate(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(r, 30)))));
// 專案摘要：[{ id, t（軌道名）, s（start）, d（duration）, in（srcIn）, kind, link }]，依軌道、start 排序
const clips = page => page.evaluate(() => {
  const Q = window.QPTEdit, p = Q.ui.state.project;
  const order = new Map(p.tracks.map((t, i) => [t.id, i]));
  return Object.values(p.clips).sort((a, b) => order.get(a.trackId) - order.get(b.trackId) || a.start - b.start)
    .map(c => ({ id: c.id, t: p.tracks.find(t => t.id === c.trackId).name, s: c.start, d: c.duration, in: Math.round(c.srcIn * 1000) / 1000, type: c.type, sp: c.speed, fr: c.freeze, rv: c.reverse, link: c.linkId, name: c.name }));
});
const on = (list, track) => list.filter(c => c.t === track);
const proj = (page, fn, arg) => page.evaluate(new Function('arg', `const p = window.QPTEdit.ui.state.project, Q = window.QPTEdit; return (${fn.toString()})(p, Q, arg);`), arg);
const invariants = page => page.evaluate(() => window.QPTEdit.core.checkInvariants(window.QPTEdit.ui.state.project));
// 時間軸上某個影格的螢幕 x、某個片段的外框
const frameX = (page, f) => page.evaluate(f => { const r = document.querySelector('.ed-tl-inner').getBoundingClientRect(); return r.left + 150 + f * window.QPTEdit.ui.ppf; }, f);
const clipBox = (page, id) => page.evaluate(id => { const e = document.querySelector(`.ed-clip[data-clip="${id}"]`); if (!e) return null; const r = e.getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height }; }, id);
const laneBox = (page, name) => page.evaluate(name => {
  const p = window.QPTEdit.ui.state.project, t = p.tracks.find(x => x.name === name);
  const e = document.querySelector(`.ed-lane[data-track="${t.id}"]`), r = e.getBoundingClientRect();
  return { x: r.left, y: r.top, w: r.width, h: r.height };
}, name);
async function drag(page, a, b, o = {}) {
  const mods = o.mods || [];
  for (const m of mods) await page.keyboard.down(m);
  await page.mouse.move(a.x, a.y);
  await page.mouse.down();
  const n = o.steps || 8;
  for (let i = 1; i <= n; i++) { await page.mouse.move(a.x + (b.x - a.x) * i / n, a.y + (b.y - a.y) * i / n); await sleep(8); }
  if (o.hold) await sleep(o.hold);
  if (o.cancel) { await page.keyboard.press('Escape'); }
  await page.mouse.up();
  for (const m of mods) await page.keyboard.up(m);
  await settle(page);
}
const statusText = page => page.evaluate(() => document.getElementById('edStatus').textContent);
const state = (page, key) => page.evaluate(k => window.QPTEdit.ui.state[k], key);

async function shot(page, name) {
  if (!SHOTS) return;
  fs.mkdirSync(SHOTS, { recursive: true });
  await page.screenshot({ path: path.join(SHOTS, name + '.png') });
}

// =====================================================================================
async function runViewport(browser, base, fix, [W, H]) {
  const tag = `${W}x${H}`;
  console.log(`\n==== 視窗 ${tag} ====`);
  const ctx = await browser.newContext({ viewport: { width: W, height: H } });
  const page = await ctx.newPage();
  const problems = [];
  page.on('pageerror', e => problems.push('pageerror: ' + e.message));
  page.on('console', m => { if (m.type() === 'error') problems.push('console.error: ' + m.text()); });
  await page.addInitScript(() => { window.__csp = []; document.addEventListener('securitypolicyviolation', e => window.__csp.push(e.violatedDirective + ' ' + e.blockedURI)); });
  await page.goto(base);
  const layoutBefore = await page.evaluate(() => { const r = document.getElementById('layoutApp').getBoundingClientRect(); return { x: Math.round(r.x), w: Math.round(r.width), h: Math.round(r.height) }; });
  await shot(page, `${tag}-0-layout-before`);

  // ---------------------------------------------------------------- 空狀態
  console.log('空狀態');
  await page.click('#funcEditBtn');
  await settle(page);
  ok(await page.isVisible('#editApp'), '剪輯分頁顯示');
  ok(!(await page.isVisible('#layoutApp')), '圖片套版隱藏');
  ok(await page.isVisible('#edEmpty'), '檢視器有「拖入影片」的空狀態提示');
  ok((await page.textContent('#edEmpty')).includes('拖進來'), '空狀態文字是繁體中文提示');
  ok(await page.isVisible('#edTimeline .ed-tl-empty'), '時間軸有空狀態提示');
  const wrapW = await page.evaluate(() => document.querySelector('.wrap').getBoundingClientRect().width);
  ok(wrapW > 1180 && wrapW >= W - 70, `剪輯分頁滿版寬（.wrap ${Math.round(wrapW)}px，視窗 ${W}px）`);
  await shot(page, `${tag}-1-empty`);
  // 空的時候亂按快捷鍵：不能出錯，要給提示
  await page.keyboard.press('F12');
  ok((await statusText(page)).includes('媒體庫'), '沒有素材時按 F12：提示先匯入（' + (await statusText(page)) + '）');
  for (const k of ['F9', 'F10', 'F11', 'Delete', 'Backspace', 'Control+b', 'Control+r', 'Shift+r', 'Space', 'j', 'l', 'k', 'x', 'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End', 'Control+z', 'Control+Shift+z', 'Alt+x', 'Control+a', 'Escape']) await page.keyboard.press(k);
  await settle(page);
  eq([await state(page, 'playhead'), await page.evaluate(() => QPTEdit.ui.player.playing), Object.keys(await proj(page, p => p.clips)).length], [0, false, 0], '空時間軸亂按快捷鍵：沒有任何改動、也不會播放');

  // ---------------------------------------------------------------- 匯入
  console.log('匯入：拖放、貼上、錯誤訊息、選檔');
  const b64 = fs.readFileSync(path.join(fix, FILES.still)).toString('base64');
  const fileEvent = (kind, name, type, data) => page.evaluate(({ kind, name, type, data }) => {
    const bin = atob(data), u8 = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
    const dt = new DataTransfer();
    dt.items.add(new File([u8], name, { type }));
    const ev = kind === 'drop' ? new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }) : new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true });
    (kind === 'drop' ? document.getElementById('edViewer') : document.body).dispatchEvent(ev);
    return ev.defaultPrevented;
  }, { kind, name, type, data });
  ok(await fileEvent('drop', 'notes.txt', 'text/plain', btoa('hello')), '拖進一個文字檔：事件被接手（瀏覽器不會把它開起來）');
  await page.waitForSelector('#edMsgs .ed-msg.err');
  ok((await page.textContent('#edMsgs')).includes('notes.txt') && (await page.textContent('#edMsgs')).includes('不是支援的格式'), '不支援的檔案：顯示繁中錯誤訊息（' + (await page.textContent('#edMsgs')).slice(0, 60) + '…）');
  await page.click('#edMsgs .ed-msg-x');
  ok(!(await page.isVisible('#edMsgs .ed-msg')), '錯誤訊息可以關掉');
  await fileEvent('drop', 'dropped.png', 'image/png', b64);
  await page.waitForFunction(() => window.QPTEdit.render.media.list().length === 1, null, { timeout: 30000 });
  await fileEvent('paste', 'pasted.png', 'image/png', b64);
  await page.waitForFunction(() => window.QPTEdit.render.media.list().length === 2, null, { timeout: 30000 });
  eq(await page.evaluate(() => QPTEdit.render.media.list().map(m => m.name)), ['dropped.png', 'pasted.png'], '拖放與 Ctrl+V 貼上都能匯入圖片');
  await page.evaluate(() => { for (const m of QPTEdit.render.media.list()) { document.querySelector(`.ed-mitem[data-media="${m.id}"] .ed-mdel`).click(); } });
  await settle(page);
  eq(await page.evaluate(() => QPTEdit.render.media.list().length), 0, '× 移除素材（沒被用到時）');
  console.log('匯入');
  await page.setInputFiles('#edFile', [FILES.land, FILES.port, FILES.mute, FILES.music, FILES.still].map(f => path.join(fix, f)));
  await page.waitForFunction(() => window.QPTEdit.render.media.list().length === 5 && document.querySelectorAll('.ed-mitem').length === 5, null, { timeout: 90000 });
  await settle(page);
  eq(await proj(page, p => Object.keys(p.mediaInfo).length), 5, '5 個素材都登錄到專案');
  eq(await proj(page, p => p.fps), 30, '專案影格率由第一支影片決定（30）');
  eq(await proj(page, p => [p.width, p.height]), [1280, 720], '輸出尺寸依第一支影片（1280×720）');
  ok((await page.textContent('#edMList')).includes('landscape-720p-6s.webm'), '媒體庫列出素材名稱');
  ok((await page.textContent('#edMList')).includes('1280×720'), '媒體庫顯示解析度');
  await shot(page, `${tag}-2-imported`);
  const ids = await page.evaluate(() => Object.fromEntries(QPTEdit.render.media.list().map(m => [m.name, m.id])));
  const M = k => ids[FILES[k]];
  const pickMedia = async k => { await page.click(`.ed-mitem[data-media="${M(k)}"]`); await settle(page); };

  // ---------------------------------------------------------------- 放上時間軸
  console.log('放上時間軸：加到結尾按鈕、F10、F9');
  await pickMedia('land');
  await page.click('#edAppend');
  await settle(page);
  let cl = await clips(page);
  eq(on(cl, 'V1').map(c => [c.s, c.d]), [[0, 180]], '加到結尾：V1 有 6 秒影片（0～180 格）');
  eq(on(cl, 'A1').map(c => [c.s, c.d]), [[0, 180]], '同時放上連結的音訊（A1）');
  ok(on(cl, 'V1')[0].link && on(cl, 'V1')[0].link === on(cl, 'A1')[0].link, '影像與聲音有連結');
  eq(await invariants(page), [], '不變式 OK');
  ok((await page.evaluate(() => document.querySelectorAll('.ed-clip').length)) === 2, '時間軸畫出 2 個片段');
  eq(await state(page, 'playhead'), 0, '加到結尾後播放頭回到新片段開頭');

  await pickMedia('mute');
  await page.keyboard.press('End');
  await settle(page);
  eq(await state(page, 'playhead'), 180, 'End 鍵：播放頭移到結尾');
  await page.keyboard.press('F10');
  await settle(page);
  cl = await clips(page);
  eq(on(cl, 'V1').map(c => [c.s, c.d]), [[0, 180], [180, 90]], 'F10 覆蓋：無聲影片接在 180（3 秒＝90 格）');
  eq(on(cl, 'A1').length, 1, '無聲影片沒有音訊片段');
  eq(await state(page, 'playhead'), 270, '覆蓋後播放頭移到新片段結尾');

  await pickMedia('music');
  await page.click('.ed-th[data-track] >> text=A2');
  await page.keyboard.press('Home');
  await page.keyboard.press('Home');
  await settle(page);
  const before = await proj(page, p => Q.core.projectDuration(p));
  await page.evaluate(() => window.QPTEdit.ui.seekTimeline(90));
  await page.keyboard.press('F9');
  await settle(page);
  cl = await clips(page);
  eq(on(cl, 'A2').map(c => [c.s, c.d]), [[90, 240]], 'F9 插入：音樂放到目的軌道 A2 的 90 格，長度 8 秒（240 格）');
  eq(await proj(page, p => Q.core.projectDuration(p)), before + 240, '插入讓後面的內容往後推 240 格');
  eq(await invariants(page), [], '不變式 OK');
  await shot(page, `${tag}-3-placed`);

  // 回到空時間軸（順便測復原堆疊）
  await page.evaluate(() => { const h = QPTEdit.ui.state.history; while (h.canUndo) h.undo(); });
  await settle(page);
  eq(Object.keys(await proj(page, p => p.clips)).length, 0, '全部復原後時間軸是空的');
  eq(await proj(page, p => Object.keys(p.mediaInfo).length), 5, '復原後素材資訊仍在（ensureMediaInfo）');


  // ---------------------------------------------------------------- 刀片、波紋刪除、復原／重做
  console.log('刀片、波紋刪除、復原／重做');
  await page.click('.ed-th-name:text-is("A1")');
  await pickMedia('land');
  await page.click('#edAppend');
  await settle(page);
  await page.evaluate(() => QPTEdit.ui.seekTimeline(90));
  await page.keyboard.press('b');
  eq(await state(page, 'tool'), 'blade', 'B 切到刀片工具');
  ok((await page.getAttribute('#edToolBlade', 'aria-pressed')) === 'true', '工具列的刀片鈕呈按下狀態');
  cl = await clips(page);
  let vb = await clipBox(page, on(cl, 'V1')[0].id);
  await page.mouse.move(await frameX(page, 90), vb.y + vb.h / 2);
  await settle(page);
  ok(await page.isVisible('.ed-bladeline'), '刀片工具：游標跟著一條切線');
  await page.mouse.click(await frameX(page, 90), vb.y + vb.h / 2);
  await settle(page);
  cl = await clips(page);
  eq(on(cl, 'V1').map(c => [c.s, c.d]), [[0, 90], [90, 90]], '刀片：V1 在 90 切成兩段');
  eq(on(cl, 'A1').map(c => [c.s, c.d]), [[0, 90], [90, 90]], '刀片：連結的 A1 一起切');
  eq(on(cl, 'V1')[1].in, 3, '右半的來源起點是 3 秒');
  eq(await invariants(page), [], '不變式 OK');
  await page.keyboard.press('a');
  vb = await clipBox(page, on(cl, 'V1')[1].id);
  await page.mouse.click(vb.x + vb.w / 2, vb.y + vb.h / 2);
  await settle(page);
  eq(await proj(page, p => Q.ui.state.selection.size), 2, '點右半：連結的音訊一起被選取（連結選取開啟）');
  await page.keyboard.press('Shift+Delete');
  await settle(page);
  cl = await clips(page);
  eq(on(cl, 'V1').map(c => [c.s, c.d]), [[0, 90]], 'Shift+Delete 波紋刪除：右半（影像）消失');
  eq(on(cl, 'A1').map(c => [c.s, c.d]), [[0, 90]], '波紋刪除：連結的聲音也消失');
  ok((await page.textContent('#edUndoLab')).includes('波紋刪除'), '復原鈕顯示動作名稱（波紋刪除）');
  await page.keyboard.press('Control+z');
  await settle(page);
  eq(on(await clips(page), 'V1').map(c => [c.s, c.d]), [[0, 90], [90, 90]], 'Ctrl+Z 復原：右半回來');
  await page.keyboard.press('Control+Shift+z');
  await settle(page);
  eq(on(await clips(page), 'V1').length, 1, 'Ctrl+Shift+Z 重做：再次刪除');
  await page.click('#edUndo');
  await settle(page);
  eq(on(await clips(page), 'V1').length, 2, '工具列「復原」鈕也能復原');

  // ---------------------------------------------------------------- 拖曳移動、修剪邊緣
  console.log('拖曳移動、修剪邊緣');
  await page.keyboard.press('a');
  cl = await clips(page);
  const right = on(cl, 'V1')[1];
  vb = await clipBox(page, right.id);
  await drag(page, { x: vb.x + vb.w / 2, y: vb.y + vb.h / 2 }, { x: vb.x + vb.w / 2 + 90, y: vb.y + vb.h / 2 });
  cl = await clips(page);
  eq(on(cl, 'V1').map(c => [c.s, c.d]), [[0, 90], [135, 90]], '拖曳移動：右半往右 45 格（90px）');
  eq(on(cl, 'A1').map(c => [c.s, c.d]), [[0, 90], [135, 90]], '連結的聲音跟著移動');
  eq(await invariants(page), [], '不變式 OK');
  ok((await page.textContent('#edUndoLab')).includes('移動'), '復原鈕：移動片段');
  // Esc 取消拖曳：不留下任何改動
  vb = await clipBox(page, right.id);
  await drag(page, { x: vb.x + vb.w / 2, y: vb.y + vb.h / 2 }, { x: vb.x + vb.w / 2 + 120, y: vb.y + vb.h / 2 }, { cancel: true });
  eq(on(await clips(page), 'V1').map(c => [c.s, c.d]), [[0, 90], [135, 90]], '拖曳中按 Esc：回到原位');
  // 拖到另一條影片軌（往上）
  vb = await clipBox(page, right.id);
  const v2 = await laneBox(page, 'V2');
  await drag(page, { x: vb.x + vb.w / 2, y: vb.y + vb.h / 2 }, { x: vb.x + vb.w / 2, y: v2.y + v2.h / 2 });
  cl = await clips(page);
  eq(on(cl, 'V2').map(c => [c.s, c.d]), [[135, 90]], '拖到上面一條軌：右半換到 V2');
  eq(on(cl, 'V1').map(c => [c.s, c.d]), [[0, 90]], 'V1 只剩左半');
  await page.keyboard.press('Control+z');
  await page.keyboard.press('Control+z');
  await settle(page);
  cl = await clips(page);
  eq(on(cl, 'V1').map(c => [c.s, c.d]), [[0, 90], [90, 90]], '復原兩次：右半回到 90');
  // 片段畫布重用：只移動位置時沿用同一張畫好的畫布（不重畫），內容改了（修剪）才重畫
  const cvInfo = id => page.evaluate(id => {
    const e = document.querySelector(`.ed-clip[data-clip="${id}"]`), cv = e && e.firstChild;
    if (!cv || cv.tagName !== 'CANVAS') return null;
    const d = cv.getContext('2d').getImageData(0, 0, cv.width, cv.height).data;
    let lit = 0; for (let i = 3; i < d.length; i += 4) if (d[i]) lit++;
    return { mark: cv.__g1 || 0, w: cv.width, ew: e.offsetWidth, lit: lit / (d.length / 4) };
  }, id);
  const movId = on(cl, 'V1')[1].id;
  await page.evaluate(id => { document.querySelector(`.ed-clip[data-clip="${id}"]`).firstChild.__g1 = 1; }, movId);
  vb = await clipBox(page, movId);
  await drag(page, { x: vb.x + vb.w / 2, y: vb.y + vb.h / 2 }, { x: vb.x + vb.w / 2 + 40, y: vb.y + vb.h / 2 });
  let ci = await cvInfo(movId);
  ok(ci && ci.mark === 1 && ci.lit > 0.9, `移動後沿用同一張畫布且有內容 ${JSON.stringify(ci)}`);
  await page.keyboard.press('Control+z'); await settle(page);
  cl = await clips(page);
  // 拖曳中按 Ctrl+Z／Delete：要被擋掉，放開後只多一筆「移動」，復原一次就回到拖曳前
  vb = await clipBox(page, on(cl, 'V1')[1].id);
  await page.mouse.move(vb.x + vb.w / 2, vb.y + vb.h / 2); await page.mouse.down();
  for (let i = 1; i <= 5; i++) { await page.mouse.move(vb.x + vb.w / 2 + i * 18, vb.y + vb.h / 2); await sleep(8); }
  await page.keyboard.press('Control+z');
  await page.keyboard.press('Delete');
  await page.mouse.up(); await settle(page);
  cl = await clips(page);
  eq(on(cl, 'V1').map(c => [c.s, c.d]), [[0, 90], [135, 90]], '拖曳中按 Ctrl+Z／Delete 被擋：片段照樣移到 135、沒被刪');
  ok((await page.textContent('#edUndoLab')).includes('移動'), '拖曳中按的快捷鍵沒有吃掉這筆「移動」');
  await page.keyboard.press('Control+z'); await settle(page);
  cl = await clips(page);
  eq(on(cl, 'V1').map(c => [c.s, c.d]), [[0, 90], [90, 90]], '再復原一次：回到拖曳前');
  eq(await invariants(page), [], '不變式 OK');
  // 修剪邊緣（選取工具拖片段邊緣）
  vb = await clipBox(page, on(cl, 'V1')[0].id);
  await drag(page, { x: vb.x + vb.w - 2, y: vb.y + vb.h / 2 }, { x: vb.x + vb.w - 2 - 40, y: vb.y + vb.h / 2 });
  cl = await clips(page);
  eq(on(cl, 'V1').map(c => [c.s, c.d]), [[0, 70], [90, 90]], '拖左半的右邊緣 -20 格：一般修剪（不推動後面）');
  ci = await cvInfo(on(cl, 'V1')[0].id);
  ok(ci && Math.abs(ci.w - ci.ew) <= 2 && ci.lit > 0.9, `修剪後畫布重畫成新寬度 ${JSON.stringify(ci)}`);
  eq(on(cl, 'A1').map(c => [c.s, c.d]), [[0, 70], [90, 90]], '連結的聲音一起修剪');
  await page.keyboard.press('Control+z');
  await settle(page);

  // ---------------------------------------------------------------- 修剪工具：滾動／滑移／滑動／波紋
  console.log('修剪工具（T）：滾動、滑移、滑動、波紋');
  await page.keyboard.press('t');
  eq(await state(page, 'tool'), 'trim', 'T 切到修剪工具');
  cl = await clips(page);
  const L0 = on(cl, 'V1')[0], R0 = on(cl, 'V1')[1];
  vb = await clipBox(page, R0.id);
  const jx = await frameX(page, 90), my = vb.y + vb.h / 2;
  await page.mouse.move(jx + 1, my);
  await settle(page);
  ok((await page.textContent('#edAction')).includes('滾動修剪'), '游標在兩片段交界：工具列顯示「滾動修剪」');
  await drag(page, { x: jx + 1, y: my }, { x: jx + 1 + 20, y: my });
  cl = await clips(page);
  eq(on(cl, 'V1').map(c => [c.s, c.d]), [[0, 100], [100, 80]], '滾動修剪：交界右移 10 格，總長不變');
  eq([on(cl, 'V1')[0].in, on(cl, 'V1')[1].in], [0, Math.round((3 + 10 / 30) * 1000) / 1000], '滾動修剪：左半來源不變，右半 srcIn +10 格');
  eq(on(cl, 'A1').map(c => [c.s, c.d]), [[0, 100], [100, 80]], '連結的聲音一起滾動');
  await page.keyboard.press('Control+z');
  await settle(page);
  // 滑移：片段中段上半部
  vb = await clipBox(page, R0.id);
  await page.mouse.move(vb.x + vb.w / 2, vb.y + 8);
  await settle(page);
  ok((await page.textContent('#edAction')).includes('滑移'), '片段上半部：工具列顯示「滑移」');
  await drag(page, { x: vb.x + vb.w / 2, y: vb.y + 8 }, { x: vb.x + vb.w / 2 + 30, y: vb.y + 8 });
  cl = await clips(page);
  eq([on(cl, 'V1')[1].s, on(cl, 'V1')[1].d, on(cl, 'V1')[1].in], [90, 90, 2.5], '滑移：位置與長度不變，srcIn 3 → 2.5（往右拖 15 格＝看到較早的畫面）');
  await page.keyboard.press('Control+z');
  await settle(page);
  // 滑動：片段中段下半部
  vb = await clipBox(page, R0.id);
  await page.mouse.move(vb.x + vb.w / 2, vb.y + vb.h - 6);
  await settle(page);
  ok((await page.textContent('#edAction')).includes('滑動'), '片段下半部：工具列顯示「滑動」');
  await drag(page, { x: vb.x + vb.w / 2, y: vb.y + vb.h - 6 }, { x: vb.x + vb.w / 2 + 20, y: vb.y + vb.h - 6 });
  cl = await clips(page);
  eq(on(cl, 'V1').map(c => [c.s, c.d]), [[0, 100], [100, 90]], '滑動：右半整個右移 10 格、左鄰居變長 10 格');
  eq([on(cl, 'V1')[1].in], [3], '滑動：內容（srcIn）不變');
  await page.keyboard.press('Control+z');
  await settle(page);
  // 波紋修剪：先在後面放一段，確認它被推動
  await pickMedia('mute');
  await page.keyboard.press('End');
  await page.keyboard.press('F10');
  await settle(page);
  cl = await clips(page);
  eq(on(cl, 'V1').map(c => [c.s, c.d]), [[0, 90], [90, 90], [180, 90]], '後面放了一段無聲影片（180～270）');
  vb = await clipBox(page, L0.id);
  await page.mouse.move(vb.x + 2, vb.y + vb.h / 2);
  await settle(page);
  ok((await page.textContent('#edAction')).includes('波紋修剪'), '片段開頭邊緣（前面沒有鄰居）：工具列顯示「波紋修剪」');
  const lastId = on(cl, 'V1')[2].id;
  vb = await clipBox(page, lastId);
  await drag(page, { x: vb.x + vb.w - 2, y: vb.y + vb.h / 2 }, { x: vb.x + vb.w - 2 - 40, y: vb.y + vb.h / 2 });
  cl = await clips(page);
  eq(on(cl, 'V1').map(c => [c.s, c.d]), [[0, 90], [90, 90], [180, 70]], '波紋修剪：最後一段尾端縮短 20 格');
  vb = await clipBox(page, L0.id);
  await drag(page, { x: vb.x + 2, y: vb.y + vb.h / 2 }, { x: vb.x + 2 + 20, y: vb.y + vb.h / 2 });
  cl = await clips(page);
  eq(on(cl, 'V1').map(c => [c.s, c.d]), [[0, 80], [80, 90], [170, 70]], '波紋修剪開頭：第一段縮短 10 格，後面的片段全部往前補');
  eq(on(cl, 'A1').map(c => [c.s, c.d]), [[0, 80], [80, 90]], '音訊軌也一起波紋（保持同步）');
  eq(await invariants(page), [], '不變式 OK');
  await page.keyboard.press('Control+z');
  await page.keyboard.press('Control+z');
  await page.keyboard.press('Control+z');
  await settle(page);
  cl = await clips(page);
  eq(on(cl, 'V1').map(c => [c.s, c.d]), [[0, 90], [90, 90]], '復原回到兩個相鄰的半段');
  await page.keyboard.press('a');

  // ---------------------------------------------------------------- 轉場
  console.log('轉場');
  vb = await clipBox(page, L0.id);
  await page.mouse.click(vb.x + vb.w / 2, vb.y + vb.h / 2);
  await settle(page);
  await page.click('.ed-tab[data-tab="trans"]');
  ok(await page.isVisible('#edTransList .ed-gitem'), '轉場分頁：列出轉場縮圖');
  eq(await page.evaluate(() => document.querySelectorAll('#edTransList .ed-gitem').length), 8, '列出 8 種轉場');
  await page.click('#edTransAdd');
  await settle(page);
  let trs = await proj(page, p => Object.values(p.transitions));
  eq(trs.length, 1, '「加到結尾」：新增 1 個轉場');
  eq([trs[0].type, trs[0].leftClipId === L0.id, trs[0].rightClipId === R0.id], ['crossDissolve', true, true], '轉場在左半與右半之間（交叉疊化）');
  ok(await page.isVisible('.ed-trans'), '時間軸上畫出轉場方塊');
  ok(await page.isVisible('.ed-sec[data-sec="fx-transition"]'), '點選轉場後檢查器顯示「轉場」區段');
  ok((await page.textContent('#edInspHead')).includes('轉場'), '檢查器標題顯示轉場');
  // 拖轉場右側把手改長度
  const tb = await page.evaluate(() => { const r = document.querySelector('.ed-trans-h.r').getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; });
  await drag(page, tb, { x: await frameX(page, 110), y: tb.y });
  trs = await proj(page, p => Object.values(p.transitions));
  eq(trs[0].duration, 40, '拖轉場邊緣：長度改成 40 格（置中對齊，左右各 20）');
  // 用檢查器改類型
  await page.selectOption('.ed-sec[data-sec="fx-transition"] select >> nth=0', 'wipe');
  await settle(page);
  eq(await proj(page, p => Object.values(p.transitions)[0].type), 'wipe', '檢查器改類型：擦拭');
  // 從轉場庫拖一個到剪接點
  await page.locator('#edTransList .ed-gitem[data-trans="push"]').scrollIntoViewIfNeeded();
  const gi = await page.evaluate(() => { const r = document.querySelector('#edTransList .ed-gitem[data-trans="push"]').getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; });
  const v1y = await laneBox(page, 'V1');
  await drag(page, gi, { x: await frameX(page, 90) + 3, y: v1y.y + v1y.h / 2 }, { steps: 14 });
  trs = await proj(page, p => Object.values(p.transitions));
  eq([trs.length, trs[0].type], [1, 'push'], '把轉場拖到剪接點：取代成「推擠」（同一個剪接點只有一個轉場）');
  eq(await invariants(page), [], '不變式 OK');
  await shot(page, `${tag}-4a-transition`);
  await page.keyboard.press('Delete');
  await settle(page);
  eq(await proj(page, p => Object.keys(p.transitions).length), 0, '選取轉場後按 Delete：刪除轉場');

  // ---------------------------------------------------------------- 單邊轉場（轉場屬於片段邊緣）
  console.log('單邊轉場：修剪拉開後保留、加到開頭、拖到片段開頭、聲音交叉淡化、復原重做');
  const layoutKey = () => page.evaluate(() => { const p = QPTEdit.ui.state.project; return JSON.stringify([p.clips, p.transitions]); });
  const before4b = await layoutKey();
  const trOf = () => proj(page, p => Object.values(p.transitions).map(x => ({ id: x.id, l: x.leftClipId, r: x.rightClipId, type: x.type, d: x.duration, side: Q.core.transitionSide(x) })).sort((a, b) => (a.id < b.id ? -1 : 1)));
  const transCenter = id => page.evaluate(id => { const r = document.querySelector(`.ed-trans[data-trans="${id}"]`).getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; }, id);
  vb = await clipBox(page, L0.id);
  await page.mouse.click(vb.x + vb.w / 2, vb.y + vb.h / 2);
  await page.click('.ed-tab[data-tab="trans"]');
  await page.click('#edTransList .ed-gitem[data-trans="crossDissolve"]');
  await page.click('#edTransAdd');
  await settle(page);
  let st = await trOf();
  eq(st.map(x => [x.l === L0.id, x.r === R0.id, x.side]), [[true, true, 'both']], '先在剪接點加交叉疊化（兩片段之間）');
  const tr4b = st[0].id;
  // 選取工具拖右半的左邊緣（片段上半部；轉場方塊在下半部）往右 15 格
  vb = await clipBox(page, R0.id);
  const px15 = (await frameX(page, 105)) - (await frameX(page, 90));
  await drag(page, { x: vb.x + 2, y: vb.y + 8 }, { x: vb.x + 2 + px15, y: vb.y + 8 });
  cl = await clips(page);
  eq(on(cl, 'V1').map(c => [c.s, c.d]), [[0, 90], [105, 75]], '拖右半的左邊緣 +15 格：剪接點拉開');
  st = await trOf();
  eq(st.map(x => [x.id, x.l, x.r === R0.id, x.side]), [[tr4b, null, true, 'in']], '轉場沒有被刪掉：跟著被修剪的右半開頭，變成開頭淡入');
  ok(await page.isVisible(`.ed-trans.in[data-trans="${tr4b}"]`), '時間軸畫出開頭淡入的轉場方塊');
  eq(await invariants(page), [], '不變式 OK');
  // 點選 → 檢查器編輯
  await page.mouse.click(...Object.values(await transCenter(tr4b)));
  await settle(page);
  ok(await page.isVisible('.ed-sec[data-sec="fx-transition"]'), '點選單邊轉場：檢查器顯示「轉場」區段');
  ok((await page.textContent('#edInspHead')).includes('開頭淡入'), '檢查器標題標示「開頭淡入」');
  eq(await page.evaluate(() => [...document.querySelectorAll('.ed-sec[data-sec="fx-transition"] .ed-fx-row')].filter(r => !r.hidden).map(r => (r.querySelector('.ed-fx-lab') || {}).textContent).includes('對齊')), false, '單邊轉場不顯示「對齊」');
  eq(await page.evaluate(id => [...document.querySelectorAll(`.ed-trans[data-trans="${id}"] .ed-trans-h`)].map(h => h.dataset.side), tr4b), ['r'], '開頭淡入只有右側把手（左側貼著片段開頭）');
  // 拖右側把手改長度
  const hr = await page.evaluate(id => { const r = document.querySelector(`.ed-trans[data-trans="${id}"] .ed-trans-h.r`).getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; }, tr4b);
  await drag(page, hr, { x: await frameX(page, 130), y: hr.y });
  st = await trOf();
  eq([st[0].side, st[0].d], ['in', 25], '拖開頭淡入的右側把手：長度改成 25 格');
  await page.selectOption('.ed-sec[data-sec="fx-transition"] select >> nth=0', 'dipToColor');
  await settle(page);
  st = await trOf();
  eq([st[0].side, st[0].type], ['in', 'dipToColor'], '檢查器改類型：浸入顏色');
  // 復原三次回到兩片段之間，重做三次回來
  for (let i = 0; i < 3; i++) await page.keyboard.press('Control+z');
  await settle(page);
  st = await trOf();
  eq(st.map(x => [x.id, x.side, x.type, x.d]), [[tr4b, 'both', 'crossDissolve', 15]], '復原三次：回到剪接點上的交叉疊化');
  cl = await clips(page);
  eq(on(cl, 'V1').map(c => [c.s, c.d]), [[0, 90], [90, 90]], '復原後片段接回去');
  for (let i = 0; i < 3; i++) await page.keyboard.press('Control+Shift+z');
  await settle(page);
  st = await trOf();
  eq(st.map(x => [x.id, x.side, x.type, x.d]), [[tr4b, 'in', 'dipToColor', 25]], '重做三次：開頭淡入、浸入顏色、25 格');
  // 加到開頭（左半在時間軸起點）、加到結尾（左半後面現在是空隙 → 尾端淡出）
  vb = await clipBox(page, L0.id);
  await page.mouse.click(vb.x + vb.w / 2, vb.y + 8);
  await page.click('#edTransList .ed-gitem[data-trans="fadeToBlack"]');
  ok(await page.isVisible('#edTransAddIn'), '轉場分頁有「加到開頭」按鈕');
  await page.click('#edTransAddIn');
  await settle(page);
  st = await trOf();
  const headL = st.find(x => x.r === L0.id && !x.l);
  ok(headL && headL.type === 'fadeToBlack' && headL.side === 'in', '「加到開頭」：左半開頭（時間軸起點）加上淡入');
  ok((await statusText(page)).includes('加在片段開頭（淡入）'), '狀態列提示「加在片段開頭（淡入）」');
  vb = await clipBox(page, L0.id);
  await page.mouse.click(vb.x + vb.w / 2, vb.y + 8);
  await page.click('#edTransList .ed-gitem[data-trans="crossDissolve"]');
  await page.click('#edTransAdd');
  await settle(page);
  st = await trOf();
  const tailL = st.find(x => x.l === L0.id && !x.r);
  ok(tailL && tailL.side === 'out', '「加到結尾」：左半後面是空隙 → 尾端淡出');
  eq(st.length, 3, '時間軸上有 3 個單邊轉場');
  ok(await page.isVisible('.ed-trans.out') && (await page.locator('.ed-trans.in').count()) === 2, '時間軸畫出尾端淡出與兩個開頭淡入');
  // 截圖：放大時間軸，看清楚貼在片段邊緣的單邊轉場（截完恢復原本的縮放）
  const zoom4b = await state(page, 'zoom');
  const zoomShot = async (name, f0) => {
    await page.evaluate(() => QPTEdit.ui.setZoom(QPTEdit.ui.state.zoom * 3.2, false));
    await page.evaluate(f => { const s = document.querySelector('.ed-tl-scroll') || document.querySelector('.ed-tl-inner').parentElement; s.scrollLeft = Math.max(0, f * QPTEdit.ui.ppf); }, f0);
    await settle(page);
    await shot(page, name);
    await page.evaluate(z => QPTEdit.ui.setZoom(z, false), zoom4b);
    await settle(page);
  };
  await page.evaluate(() => QPTEdit.ui.seekTimeline(8));
  await page.evaluate(id => QPTEdit.ui.selectTransition(id), headL.id);
  await zoomShot(`${tag}-4b-single-transitions`, 0);
  // 從轉場庫拖到片段開頭（前面是空隙）：先刪掉右半的開頭淡入，再把「擦拭」拖到右半開頭
  await page.mouse.click(...Object.values(await transCenter(tr4b)));
  await page.keyboard.press('Delete');
  await settle(page);
  eq((await trOf()).length, 2, '刪掉右半的開頭淡入');
  await page.locator('#edTransList .ed-gitem[data-trans="wipe"]').scrollIntoViewIfNeeded();
  const gw = await page.evaluate(() => { const r = document.querySelector('#edTransList .ed-gitem[data-trans="wipe"]').getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; });
  const v1l = await laneBox(page, 'V1');
  await drag(page, gw, { x: await frameX(page, 105) + 3, y: v1l.y + v1l.h / 2 }, { steps: 14 });
  st = await trOf();
  const headR = st.find(x => x.r === R0.id && !x.l);
  ok(headR && headR.type === 'wipe' && headR.side === 'in', '把轉場拖到片段開頭（前面是空隙）：加上開頭淡入（擦拭）');
  eq(await invariants(page), [], '不變式 OK');
  // 接回去：把右半的開頭拖回 90（拖過頭會被夾住）→ 剪接點兩側各有一個單邊 → 保留左側（左半的尾端淡出）變雙邊
  vb = await clipBox(page, R0.id);
  await drag(page, { x: vb.x + 2, y: vb.y + 8 }, { x: (await frameX(page, 86)), y: vb.y + 8 });
  cl = await clips(page);
  eq(on(cl, 'V1').map(c => [c.s, c.d]), [[0, 90], [90, 90]], '右半開頭拖回 90：片段接回去（不會蓋到左半）');
  st = await trOf();
  eq(st.map(x => [x.id, x.side]).sort(), [[headL.id, 'in'], [tailL.id, 'both']].sort(), '保留左側的轉場並轉成雙邊，右側的開頭淡入移除');
  eq(st.find(x => x.id === tailL.id).r, R0.id, '雙邊轉場接到右半');
  // 交叉淡化時的音訊片段：A1 上畫出淡出＋淡入兩條曲線（起點淡入只有一條）
  const xfs = await page.evaluate(() => { const p = QPTEdit.ui.state.project, a1 = p.tracks.find(t => t.name === 'A1'); return [...document.querySelectorAll(`.ed-lane[data-track="${a1.id}"] .ed-xfade`)].map(e => e.className.replace('ed-xfade ', '')).sort(); });
  eq(xfs, ['in', 'in', 'out'], '音訊軌畫出聲音淡化：剪接點交叉淡化（淡出＋淡入）、開頭淡入');
  const plan = await proj(page, (p, Q) => Q.core.audioTransitionPlan(p));
  ok(Object.values(plan).some(e => e.fades.some(f => f.dir === 'out')) && Object.values(plan).filter(e => e.fades.some(f => f.dir === 'in')).length === 2, '聲音計畫：左段淡出、右段淡入、左段開頭淡入');
  await page.evaluate(id => QPTEdit.ui.selectTransition(id), tailL.id);
  await page.evaluate(() => QPTEdit.ui.seekTimeline(82));
  await zoomShot(`${tag}-4c-audio-crossfade`, 30);
  // 復原：回到拉開的狀態（3 個單邊）；重做：接回去
  await page.keyboard.press('Control+z');
  await settle(page);
  eq((await trOf()).map(x => x.side).sort(), ['in', 'in', 'out'], '復原：回到拉開時的三個單邊轉場');
  await page.keyboard.press('Control+y');
  await settle(page);
  eq((await trOf()).map(x => x.side).sort(), ['both', 'in'], '重做：再接回去');
  eq(await invariants(page), [], '不變式 OK');
  // 回到這一段開始前的狀態（後面的測試沿用）
  await page.evaluate(want => {
    const Q = window.QPTEdit, key = () => { const p = Q.ui.state.project; return JSON.stringify([p.clips, p.transitions]); };
    for (let i = 0; i < 40 && key() !== want && Q.ui.state.history.canUndo; i++) Q.ui.undo();
  }, before4b);
  await settle(page);
  eq(await layoutKey(), before4b, '全部復原：回到這一段開始前');
  await page.keyboard.press('Escape');

  // ---------------------------------------------------------------- 字幕
  console.log('字幕');
  await page.click('.ed-tab[data-tab="title"]');
  eq(await page.evaluate(() => document.querySelectorAll('#edTitleList .ed-gitem').length), 6, '字幕分頁：列出 6 種樣式');
  await page.evaluate(() => QPTEdit.ui.seekTimeline(30));
  await page.click('#edTitleAdd');
  await settle(page);
  cl = await clips(page);
  eq(on(cl, 'V2').map(c => [c.s, c.d, c.type]), [[30, 90, 'title']], '在播放頭新增字幕：放在最上層的 V2，3 秒');
  ok(await page.isVisible('.ed-sec[data-sec="fx-title"]'), '選取字幕：檢查器出現「字幕」區段');
  const ta = page.locator('.ed-sec[data-sec="fx-title"] textarea');
  await ta.fill('測試字幕');
  await ta.press('Tab');
  await settle(page);
  eq(await proj(page, p => Object.values(p.clips).find(c => c.type === 'title').title.text), '測試字幕', '在檢查器改字幕文字');
  // 拖字幕樣式到 V2
  await page.locator('#edTitleList .ed-gitem[data-title="lowerThird"]').scrollIntoViewIfNeeded();
  const gt = await page.evaluate(() => { const r = document.querySelector('#edTitleList .ed-gitem[data-title="lowerThird"]').getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; });
  const v2l = await laneBox(page, 'V2');
  await drag(page, gt, { x: await frameX(page, 150), y: v2l.y + v2l.h / 2 }, { steps: 14 });
  cl = await clips(page);
  eq(on(cl, 'V2').map(c => [c.s, c.d]), [[30, 90], [150, 90]], '把字幕樣式拖到 V2 的 150 格');
  eq(await proj(page, p => Object.values(p.clips).filter(c => c.type === 'title').map(c => c.title.preset).sort()), ['lowerThird', 'static'], '字幕樣式正確（靜態、下三分之一條）');
  eq(await invariants(page), [], '不變式 OK');
  // 截圖用：多軌片段＋轉場＋字幕同時出現
  const l0box = await clipBox(page, L0.id);
  await page.mouse.click(l0box.x + l0box.w / 2, l0box.y + l0box.h - 8);
  await page.click('.ed-tab[data-tab="trans"]');
  await page.click('#edTransList .ed-gitem[data-trans="crossDissolve"]');
  await page.click('#edTransAdd');
  await settle(page);
  eq(await proj(page, p => Object.keys(p.transitions).length), 1, '再加一個交叉疊化（截圖用）');
  await page.evaluate(() => QPTEdit.ui.seekTimeline(90));
  await settle(page);
  await shot(page, `${tag}-4-multitrack`);
  await page.keyboard.press('Delete');
  await settle(page);
  eq(await proj(page, p => Object.keys(p.transitions).length), 0, '刪除轉場');
  await page.click('.ed-tab[data-tab="title"]');


  // ---------------------------------------------------------------- 檢查器：變形、音訊（增益、淡入淡出、EQ）
  console.log('檢查器：變形、音訊');
  cl = await clips(page);
  const v1a = on(cl, 'V1')[0], a1 = on(cl, 'A1')[0];
  let cb = await clipBox(page, v1a.id);
  await page.mouse.click(cb.x + cb.w / 2, cb.y + cb.h - 8);
  await settle(page);
  if (!(await page.isVisible('.ed-sec[data-sec="fx-transform"]'))) console.log('       DEBUG', JSON.stringify(await page.evaluate(() => ({ sel: [...QPTEdit.ui.state.selection], prim: QPTEdit.ui.state.primary, tr: QPTEdit.ui.state.selTransition, secs: [...document.querySelectorAll('.ed-sec')].map(s => s.dataset.sec + ':' + s.hidden), head: document.getElementById('edInspHead').textContent }))), JSON.stringify(cb));
  ok(await page.isVisible('.ed-sec[data-sec="fx-transform"]'), '選取影片片段：檢查器出現「變形」區段');
  ok(await page.isVisible('.ed-sec[data-sec="info"]'), '檢查器：片段資訊');
  const zl = page.locator('.ed-sec[data-sec="fx-transform"] .ed-fx-lab:text-is("縮放 X")');
  await zl.scrollIntoViewIfNeeded();
  const zb = await zl.boundingBox();
  await drag(page, { x: zb.x + zb.width / 2, y: zb.y + zb.height / 2 }, { x: zb.x + zb.width / 2 + 100, y: zb.y + zb.height / 2 });
  const tf = await proj(page, (p, Q, id) => p.clips[id].video.transform, v1a.id);
  ok(Math.abs(tf.zoomX - 1.5) < 0.02 && Math.abs(tf.zoomY - 1.5) < 0.02, `在標籤上左右拖曳：縮放 X／Y 連動變成 1.5（${tf.zoomX}）`);
  ok((await page.textContent('#edUndoLab')).includes('變形'), '拖曳整段只記一筆復原（調整變形）');
  await shot(page, `${tag}-5-inspector-transform`);
  await page.keyboard.press('Control+z');
  await settle(page);
  eq(await proj(page, (p, Q, id) => p.clips[id].video.transform.zoomX, v1a.id), 1, '一次復原就回到 1（拖曳過程沒有留下中間步驟）');

  // 音訊
  let ab = await clipBox(page, a1.id);
  await page.mouse.click(ab.x + ab.w / 2, ab.y + ab.h - 8);
  await settle(page);
  ok(await page.isVisible('.ed-sec[data-sec="audio"]'), '選取音訊片段：檢查器出現音訊區');
  const gain = page.locator('.ed-sec[data-sec="audio"] input[aria-label="增益"]');
  await gain.fill('-6');
  await gain.press('Tab');
  await settle(page);
  eq(await proj(page, (p, Q, id) => p.clips[id].audio.gainDb, a1.id), -6, '增益改成 -6 dB');
  const panLab = page.locator('.ed-sec[data-sec="audio"] .ed-fx-lab:text-is("Pan")');
  await panLab.scrollIntoViewIfNeeded();
  const pb = await panLab.boundingBox();
  await drag(page, { x: pb.x + 5, y: pb.y + pb.height / 2 }, { x: pb.x + 55, y: pb.y + pb.height / 2 });
  ok(Math.abs((await proj(page, (p, Q, id) => p.clips[id].audio.pan, a1.id)) - 0.25) < 0.011, 'Pan：標籤往右拖 50px → +25%');
  await page.keyboard.press('Control+z');
  await settle(page);
  eq(await proj(page, (p, Q, id) => p.clips[id].audio.pan, a1.id), 0, 'Pan 拖曳是一筆復原');
  // 淡入淡出：拖上緣兩端的圓點
  ab = await clipBox(page, a1.id);
  const hin = await page.evaluate(id => { const r = document.querySelector(`.ed-clip[data-clip="${id}"] .ed-fade-h.in`).getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; }, a1.id);
  await drag(page, hin, { x: await frameX(page, a1.s + 20), y: hin.y });
  eq(await proj(page, (p, Q, id) => p.clips[id].audio.fadeIn, a1.id), 20, '拖淡入把手：淡入 20 格');
  const hout = await page.evaluate(id => { const r = document.querySelector(`.ed-clip[data-clip="${id}"] .ed-fade-h.out`).getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; }, a1.id);
  await drag(page, hout, { x: await frameX(page, a1.s + a1.d - 15), y: hout.y });
  eq(await proj(page, (p, Q, id) => p.clips[id].audio.fadeOut, a1.id), 15, '拖淡出把手：淡出 15 格');
  ok((await page.locator(`.ed-clip[data-clip="${a1.id}"] .ed-fade-line`).count()) === 2, '時間軸畫出淡入、淡出曲線');
  await page.fill('.ed-sec[data-sec="audio"] input[aria-label="淡入曲線"]', '50');
  await page.press('.ed-sec[data-sec="audio"] input[aria-label="淡入曲線"]', 'Tab');
  await settle(page);
  eq(await proj(page, (p, Q, id) => p.clips[id].audio.fadeInCurve, a1.id), 0.5, '檢查器改淡入曲線 50%');
  // EQ
  await page.locator('.ed-sec[data-sec="audio"]').getByLabel('啟用 EQ').check();
  await settle(page);
  eq(await proj(page, (p, Q, id) => p.clips[id].audio.eq.enabled, a1.id), true, '啟用 EQ');
  const g3 = page.locator('input[aria-label="第 3 段增益"]');
  await g3.fill('6');
  await g3.press('Tab');
  await settle(page);
  eq(await proj(page, (p, Q, id) => p.clips[id].audio.eq.bands[2].gain, a1.id), 6, '第 3 段（500 Hz）增益 +6 dB');
  const resp = await page.evaluate(id => QPTEdit.render.eqResponse(QPTEdit.ui.state.project.clips[id].audio.eq, [500])[0], a1.id);
  ok(resp > 5 && resp < 7, `EQ 頻率響應在 500 Hz 約 +6 dB（${resp.toFixed(2)}）`);
  const eqPix = await page.evaluate(() => { const c = document.getElementById('edEqGraph'), d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data; let n = 0; for (let i = 0; i < d.length; i += 4) if (d[i] < 40 && d[i + 2] > 120) n++; return n; });
  ok(eqPix > 200, `頻率響應圖有畫出藍色曲線（${eqPix} 個像素）`);
  await page.locator('#edEqGraph').scrollIntoViewIfNeeded();
  await shot(page, `${tag}-6-inspector-audio-eq`);
  await page.locator('#edEqReset').click();
  await settle(page);
  eq(await invariants(page), [], '不變式 OK');

  // ---------------------------------------------------------------- 變速 50%、定格
  console.log('變速與定格');
  cl = await clips(page);
  cb = await clipBox(page, on(cl, 'V1')[0].id);
  await page.mouse.click(cb.x + cb.w / 2, cb.y + cb.h - 8);
  await settle(page);
  const beforeRight = on(cl, 'V1')[1].s;
  await page.keyboard.press('Control+r');
  await settle(page);
  ok(await page.isVisible('#edSpeedPct'), 'Ctrl+R 開啟變速視窗');
  await page.fill('#edSpeedPct', '50');
  await page.click('#edSpeedOk');
  await settle(page);
  cl = await clips(page);
  eq([on(cl, 'V1')[0].sp, on(cl, 'V1')[0].d], [0.5, 180], '變速 50%（波紋）：長度 90 → 180 格');
  eq([on(cl, 'A1')[0].sp, on(cl, 'A1')[0].d], [0.5, 180], '連結的聲音一起變速');
  eq(on(cl, 'V1')[1].s, beforeRight + 90, '後面的片段被往後推 90 格');
  ok((await page.locator('.ed-clip.video .ed-badge:text-is("50%")').count()) >= 1, '片段上顯示速度標籤「50%」');
  eq(await invariants(page), [], '不變式 OK');
  await page.evaluate(() => QPTEdit.ui.seekTimeline(30));
  cb = await clipBox(page, on(cl, 'V1')[0].id);
  await page.mouse.click(cb.x + cb.w / 2, cb.y + cb.h - 8);
  await page.keyboard.press('Shift+r');
  await settle(page);
  ok(await page.isVisible('#edFreezeSec'), 'Shift+R 開啟定格視窗');
  eq(await page.inputValue('#edFreezeSec'), '2', '定格預設長度 2 秒');
  await page.click('#edFreezeIns');
  await settle(page);
  cl = await clips(page);
  const fz = on(cl, 'V1').filter(c => c.fr);
  eq(fz.map(c => [c.s, c.d]), [[30, 60]], '插入定格：在播放頭（30）插入 60 格定格片段');
  ok((await page.locator('.ed-clip.freeze .ed-badge:text-is("定格")').count()) >= 1, '定格片段顯示「定格」標籤');
  eq(await invariants(page), [], '不變式 OK');

  // ---------------------------------------------------------------- 輸出比例
  console.log('輸出比例');
  await page.selectOption('#edAspect', '9:16');
  await settle(page);
  eq(await proj(page, p => [p.aspect, p.width, p.height]), ['9:16', 1080, 1920], '改成 9:16：輸出 1080×1920');
  await page.waitForFunction(() => document.getElementById('edCanvas').height === 1280, null, { timeout: 5000 }).catch(() => {});
  eq(await page.evaluate(() => [document.getElementById('edCanvas').width, document.getElementById('edCanvas').height]), [720, 1280], '檢視器畫布跟著變成直式（預覽縮小到長邊 1280）');
  ok((await page.textContent('#edVDims')).includes('1080×1920'), '檢視器上方顯示輸出尺寸');
  await shot(page, `${tag}-6b-aspect-916`);

  // ---------------------------------------------------------------- 來源模式與來源 In／Out
  console.log('來源模式');
  await page.click('.ed-tab[data-tab="media"]');
  await page.dblclick(`.ed-mitem[data-media="${M('land')}"]`);
  await settle(page);
  eq(await state(page, 'mode'), 'source', '雙擊素材：檢視器切到來源模式');
  ok((await page.getAttribute('#edModeSource', 'aria-pressed')) === 'true', '「來源」鈕呈作用中');
  await page.keyboard.press('Shift+ArrowRight');
  await page.keyboard.press('i');
  await page.keyboard.press('Shift+ArrowRight');
  await page.keyboard.press('o');
  await settle(page);
  const sio = await state(page, 'sourceInOut');
  ok(sio && sio.mediaId === M('land') && Math.abs(sio.srcIn - 1) < 1e-6 && Math.abs(sio.srcOut - 61 / 30) < 1e-6, `來源 In／Out：1.00 秒 – 2.03 秒（${JSON.stringify(sio)}）`);
  ok((await page.textContent('#edSrcIO')).includes('來源 In'), '來源 In／Out 列顯示範圍');
  await shot(page, `${tag}-6c-source-mode`);
  await page.click('#edAppend');
  await settle(page);
  cl = await clips(page);
  ok(cl.some(c => c.t === 'V1' && c.in === 1 && c.d === 31), '加到結尾：只放來源 In～Out 這一段（31 格，srcIn 1 秒）');
  await page.click('#edModeTimeline');
  await settle(page);
  eq(await state(page, 'mode'), 'timeline', '按「時間軸」切回時間軸模式');

  // ---------------------------------------------------------------- 標記、旗標
  console.log('標記與旗標');
  await page.keyboard.press('Escape');
  await page.evaluate(() => QPTEdit.ui.seekTimeline(45));
  await page.keyboard.press('m');
  await settle(page);
  eq(await proj(page, p => p.markers.map(m => m.frame)), [45], 'M：在播放頭加時間軸標記');
  await page.fill('.ed-pop input[aria-label="標記名稱"]', '重點');
  await page.press('.ed-pop input[aria-label="標記名稱"]', 'Enter');
  await settle(page);
  eq(await proj(page, p => p.markers[0].name), '重點', '標記視窗：改名稱');
  await page.click('.ed-mk');
  await settle(page);
  await page.click('.ed-pop .ed-swatch[data-color="red"]');
  await settle(page);
  eq(await proj(page, p => p.markers[0].color), 'red', '點標記開啟視窗，改顏色（紅）');
  await page.click('.ed-mk');
  await page.fill('.ed-pop textarea', '這裡要補畫面');
  await page.keyboard.press('Escape');
  await page.mouse.click(20, 700);
  await settle(page);
  eq(await proj(page, p => p.markers[0].note), '這裡要補畫面', '標記備註（關閉視窗時存檔）');
  const mk0 = await page.evaluate(() => { const r = document.querySelector('.ed-mk').getBoundingClientRect(); return { x: r.left + 4, y: r.top + 6 }; });
  await drag(page, mk0, { x: mk0.x + 40, y: mk0.y });
  eq(await proj(page, p => p.markers[0].frame), 65, '拖曳標記：移到 65 格');
  // 旗標
  cl = await clips(page);
  cb = await clipBox(page, on(cl, 'V1')[0].id);
  await page.mouse.click(cb.x + cb.w / 2, cb.y + cb.h - 8);
  await page.click('#edFlag');
  await page.click('.ed-pop .ed-swatch[data-color="green"]');
  await settle(page);
  eq(await proj(page, (p, Q, id) => p.clips[id].flags, on(cl, 'V1')[0].id), ['green'], '旗標：加綠色');
  ok((await page.locator(`.ed-clip[data-clip="${on(cl, 'V1')[0].id}"] .ed-cflags i`).count()) === 1, '片段上顯示旗標色條');
  await page.keyboard.press('Escape');
  // 片段標記：選取的片段在播放頭下時 M 加片段標記
  await page.evaluate(() => QPTEdit.ui.seekTimeline(10));
  await page.keyboard.press('m');
  await settle(page);
  eq(await proj(page, (p, Q, id) => p.clips[id].markers.map(m => m.offset), on(cl, 'V1')[0].id), [10], '選取片段後按 M：加片段標記');
  ok(await page.isVisible('[data-cmarker]'), '片段上畫出標記');
  await page.keyboard.press('Escape');
  await page.keyboard.press('Escape');

  // ---------------------------------------------------------------- In／Out、三點剪輯、替換
  console.log('In／Out、三點剪輯、替換');
  await page.keyboard.press('Escape');
  await page.evaluate(() => QPTEdit.ui.seekTimeline(30));
  await page.keyboard.press('i');
  await page.evaluate(() => QPTEdit.ui.seekTimeline(59));
  await page.keyboard.press('o');
  await settle(page);
  eq(await proj(page, p => [p.inPoint, p.outPoint]), [30, 60], 'I／O：時間軸 In＝30、Out＝60（Out 是最後一格＋1）');
  ok(await page.isVisible('.ed-io-tint') && await page.isVisible('.ed-io-band'), 'In／Out 範圍有底色（時間尺色帶＋軌道底色）');
  await pickMedia('mute');
  await page.keyboard.press('F10');
  await settle(page);
  cl = await clips(page);
  ok(cl.some(c => c.t === 'V1' && c.s === 30 && c.d === 30 && c.name === FILES.mute), '三點剪輯：F10 依時間軸 In～Out 放 30 格（30～60）');
  eq(await invariants(page), [], '不變式 OK');
  await page.keyboard.press('Control+z');
  await page.keyboard.press('Alt+x');
  await settle(page);
  eq(await proj(page, p => [p.inPoint, p.outPoint]), [null, null], 'Alt+X：清除 In／Out');
  // 替換：用另一個素材取代播放頭下的片段（長度不變）
  await page.evaluate(() => QPTEdit.ui.seekTimeline(10));
  await pickMedia('port');
  const vAt = p => Object.values(p.clips).filter(c => c.start <= 10 && c.start + c.duration > 10 && p.tracks.find(t => t.id === c.trackId).kind === 'video').map(c => [c.mediaId, c.duration]);
  const mbefore = await page.evaluate(`(${vAt.toString()})(QPTEdit.ui.state.project)`);
  await page.keyboard.press('F11');
  await settle(page);
  const mafter = await page.evaluate(`(${vAt.toString()})(QPTEdit.ui.state.project)`);
  eq(mafter.map(x => x[0]), [M('port')], 'F11 替換：播放頭下的影片片段換成另一個素材');
  eq(mafter.map(x => x[1]), mbefore.map(x => x[1]), '替換：片段長度不變');
  eq(await invariants(page), [], '不變式 OK');
  await page.keyboard.press('Control+z');
  await settle(page);

  // ---------------------------------------------------------------- 右鍵選單、吸附、空白鍵不會重按按鈕
  console.log('右鍵選單、吸附');
  cl = await clips(page);
  const rc = on(cl, 'V1')[0];
  cb = await clipBox(page, rc.id);
  await page.mouse.click(cb.x + cb.w / 2, cb.y + cb.h - 8, { button: 'right' });
  await page.waitForSelector('.ed-menu');
  ok((await page.textContent('.ed-menu')).includes('波紋刪除') && (await page.textContent('.ed-menu')).includes('取消連結'), '片段右鍵選單：切開／刪除／波紋刪除／連結／變速／定格…');
  await page.click('.ed-menu-item:has-text("取消連結")');
  await settle(page);
  eq(await proj(page, (p, Q, id) => p.clips[id].linkId, rc.id), null, '右鍵「取消連結」：片段不再連結');
  await page.keyboard.press('Control+z');
  await settle(page);
  ok(!!(await proj(page, (p, Q, id) => p.clips[id].linkId, rc.id)), '復原後恢復連結');
  // 連結選取關閉：單獨移動影像會不同步，片段上出現紅字偏移
  await page.keyboard.press('Control+Shift+l');
  eq(await state(page, 'linkedSelection'), false, 'Ctrl+Shift+L：連結選取關閉');
  cl = await clips(page);
  const vv = on(cl, 'V1').find(c => c.link);
  const aaB = cl.find(c => c.link === vv.link && c.t.startsWith('A'));
  cb = await clipBox(page, vv.id);
  await drag(page, { x: cb.x + cb.w / 2, y: cb.y + cb.h / 2 }, { x: cb.x + cb.w / 2 + 20, y: cb.y + cb.h / 2 });
  cl = await clips(page);
  const vv2 = cl.find(c => c.id === vv.id), aa = cl.find(c => c.link === vv.link && c.t.startsWith('A'));
  eq([vv2.s - vv.s, aa.s - aaB.s], [10, 0], '連結選取關閉：只有影像往右 10 格，聲音沒動');
  ok((await page.locator('.ed-clip .ed-badge.bad').count()) >= 1, '不同步的片段顯示紅色偏移數字');
  eq(await invariants(page), [], '不變式 OK（連結選取關閉時允許不同步）');
  await page.keyboard.press('Control+z');
  await page.keyboard.press('Control+Shift+l');
  eq(await state(page, 'linkedSelection'), true, '再按一次：連結選取開啟');
  // 吸附：把片段拖到離播放頭 1 格的位置，吸附開著會貼齊；關掉就停在拖到的位置
  await page.keyboard.press('Escape');
  cl = await clips(page);
  const mv = on(cl, 'V1').filter(c => c.type === 'media').pop();
  const ph = mv.s - 50, wantStart = ph + 1;
  await page.evaluate(f => QPTEdit.ui.seekTimeline(f), ph);
  await settle(page);
  eq(await state(page, 'playhead'), ph, `播放頭放在 ${ph}`);
  cb = await clipBox(page, mv.id);
  await drag(page, { x: cb.x + 20, y: cb.y + cb.h / 2 }, { x: cb.x + 20 + (wantStart - mv.s) * 2, y: cb.y + cb.h / 2 }, { hold: 40 });
  eq(on(await clips(page), 'V1').find(c => c.id === mv.id).s, ph, `吸附開啟：靠近播放頭（相差 1 格）時貼齊到 ${ph}`);
  await page.keyboard.press('Control+z');
  await page.keyboard.press('n');
  await settle(page);
  eq(await state(page, 'snapping'), false, 'N：關閉吸附');
  cb = await clipBox(page, mv.id);
  await drag(page, { x: cb.x + 20, y: cb.y + cb.h / 2 }, { x: cb.x + 20 + (wantStart - mv.s) * 2, y: cb.y + cb.h / 2 });
  eq(on(await clips(page), 'V1').find(c => c.id === mv.id).s, wantStart, `吸附關閉：停在拖到的位置（${wantStart}）`);
  await page.keyboard.press('Control+z');
  await settle(page);
  // 點了工具列按鈕之後按空白鍵：播放／暫停，不會再「點」一次那顆按鈕
  await page.click('#edToggleSnap');
  eq(await state(page, 'snapping'), true, '工具列「吸附」鈕：開啟');
  await page.keyboard.press('Space');
  await sleep(200);
  eq([await state(page, 'snapping'), await page.evaluate(() => QPTEdit.ui.player.playing)], [true, true], '點過按鈕後按空白鍵：播放，而且不會再切換吸附');
  await page.keyboard.press('Space');
  await settle(page);

  // ---------------------------------------------------------------- 縮放
  console.log('時間軸縮放');
  const z0 = await state(page, 'zoom');
  await page.evaluate(() => { const r = document.getElementById('edZoom'); r.value = '80'; r.dispatchEvent(new Event('input', { bubbles: true })); });
  await settle(page);
  const z1 = await state(page, 'zoom');
  ok(z1 > z0, `縮放滑桿：放大（${Math.round(z0)} → ${Math.round(z1)} px/秒）`);
  cl = await clips(page);
  cb = await clipBox(page, on(cl, 'V1')[0].id);
  ok(Math.abs(cb.w - on(cl, 'V1')[0].d * z1 / 30) < 1.5, `片段寬度跟著縮放（${Math.round(cb.w)}px）`);
  await page.keyboard.press('-');
  ok((await state(page, 'zoom')) < z1, '「-」縮小');
  await page.keyboard.press('=');
  const sbx = await page.evaluate(() => { const r = document.querySelector('.ed-tl-scroll').getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height - 12 }; });
  await page.mouse.move(sbx.x, sbx.y);
  await page.keyboard.down('Control');
  await page.mouse.wheel(0, -400);
  await page.keyboard.up('Control');
  await settle(page);
  ok((await state(page, 'zoom')) > z1 * 1.2, 'Ctrl＋滾輪：放大');
  await page.keyboard.press('Shift+z');
  await settle(page);
  const fit = await page.evaluate(() => { const Q = QPTEdit, p = Q.ui.state.project, sc = document.querySelector('.ed-tl-scroll'); return Q.core.projectDuration(p) * Q.ui.ppf <= sc.clientWidth - 150; });
  ok(fit, 'Shift+Z：全部顯示（整個時間軸剛好放進視窗）');

  // ---------------------------------------------------------------- 軌道：鎖定、靜音、獨奏、新增、改名、刪除
  console.log('軌道控制');
  const v1id = await proj(page, p => p.tracks.find(t => t.name === 'V1').id);
  await page.click(`.ed-th[data-track="${v1id}"] .ed-thb.lock`);
  await settle(page);
  eq(await proj(page, p => p.tracks.find(t => t.name === 'V1').locked), true, '鎖定 V1');
  cl = await clips(page);
  const beforeLocked = JSON.stringify(await clips(page));
  cb = await clipBox(page, on(cl, 'V1')[1].id);
  await drag(page, { x: cb.x + cb.w / 2, y: cb.y + cb.h / 2 }, { x: cb.x + cb.w / 2 + 60, y: cb.y + cb.h / 2 });
  eq(JSON.stringify(await clips(page)), beforeLocked, '鎖定的軌道上拖曳移動：沒有任何改動');
  ok((await statusText(page)).includes('鎖定'), '狀態列說明原因：' + (await statusText(page)));
  await page.click(`.ed-th[data-track="${v1id}"] .ed-thb.lock`);
  await page.click('.ed-th.audio .ed-thb.mute >> nth=0');
  await page.click('.ed-th.audio .ed-thb.solo >> nth=1');
  await settle(page);
  eq(await proj(page, p => [p.tracks.find(t => t.name === 'A1').muted, p.tracks.find(t => t.name === 'A2').solo]), [true, true], '靜音 A1、獨奏 A2');
  await page.click('.ed-th.video .ed-thb.hide >> nth=0');
  await settle(page);
  eq(await proj(page, p => p.tracks.filter(t => t.hidden).length), 1, '隱藏一條影片軌');
  await page.click('.ed-th.video .ed-thb.hide >> nth=0');
  await page.click('.ed-th.audio .ed-thb.mute >> nth=0');
  await page.click('.ed-th.audio .ed-thb.solo >> nth=1');
  await page.click('#edAddV');
  await settle(page);
  eq(await proj(page, p => p.tracks.filter(t => t.kind === 'video').map(t => t.name)), ['V1', 'V2', 'V3'], '＋影片軌：新增 V3');
  eq(await page.evaluate(() => document.querySelector('.ed-th .ed-th-name').textContent), 'V3', 'V3 顯示在最上面');
  await page.dblclick('.ed-th.video .ed-th-name >> nth=0');
  await page.fill('.ed-th-input', 'B-roll');
  await page.press('.ed-th-input', 'Enter');
  await settle(page);
  eq(await proj(page, p => p.tracks.find(t => t.id === p.tracks.filter(x => x.kind === 'video')[2].id).name), 'B-roll', '雙擊軌道名稱：改名');
  await page.click('.ed-th.video .ed-th-name >> nth=0', { button: 'right' });
  await page.click('.ed-menu-item:has-text("刪除這條軌道")');
  await settle(page);
  eq(await proj(page, p => p.tracks.filter(t => t.kind === 'video').length), 2, '右鍵刪除空軌道');
  await page.click('#edAddA');
  await settle(page);
  eq(await proj(page, p => p.tracks.filter(t => t.kind === 'audio').length), 3, '＋音訊軌');
  await page.keyboard.press('Control+z');
  await settle(page);
  eq(await proj(page, p => p.tracks.filter(t => t.kind === 'audio').length), 2, '復原：音訊軌回到 2 條');

  // ---------------------------------------------------------------- 播放與鍵盤
  console.log('播放與鍵盤');
  await page.keyboard.press('Home');
  await settle(page);
  eq(await state(page, 'playhead'), 0, 'Home：回到開頭');
  await page.keyboard.press('ArrowRight');
  eq(await state(page, 'playhead'), 1, '→：往後一格');
  await page.keyboard.press('Shift+ArrowRight');
  eq(await state(page, 'playhead'), 31, 'Shift+→：往後一秒（30 格）');
  await page.keyboard.press('ArrowLeft');
  eq(await state(page, 'playhead'), 30, '←：往前一格');
  await page.keyboard.press('ArrowDown');
  ok((await state(page, 'playhead')) > 30, '↓：跳到下一個剪輯點（' + (await state(page, 'playhead')) + '）');
  const rb = await page.evaluate(() => { const r = document.querySelector('.ed-ruler').getBoundingClientRect(); return { y: r.top + 14 }; });
  await page.mouse.click(await frameX(page, 60), rb.y);
  eq(await state(page, 'playhead'), 60, '點時間尺：播放頭移到 60 格');
  await page.keyboard.press('Space');
  await sleep(900);
  const playing = await page.evaluate(() => [QPTEdit.ui.player.playing, QPTEdit.ui.state.playhead]);
  ok(playing[0] && playing[1] > 62, `空白鍵播放：播放頭前進（${playing[1]}）`);
  await page.keyboard.press('Space');
  await settle(page);
  eq(await page.evaluate(() => QPTEdit.ui.player.playing), false, '再按一次空白鍵：暫停');
  await page.keyboard.press('l');
  await page.keyboard.press('l');
  eq(await page.evaluate(() => QPTEdit.ui.player.rate), 2, 'L 連按兩次：2 倍速');
  await page.keyboard.press('k');
  eq(await page.evaluate(() => QPTEdit.ui.player.playing), false, 'K：停止');
  await page.keyboard.press('Space');
  await sleep(150);
  await page.click('#funcResizeBtn');
  await settle(page);
  eq(await page.evaluate(() => QPTEdit.ui.player.playing), false, '切到別的分頁：暫停播放');
  await page.click('#funcEditBtn');
  await settle(page);

  // ---------------------------------------------------------------- 匯出
  console.log('匯出');
  await page.evaluate(() => { const Q = QPTEdit; Q.ui.state.history.run('設 In／Out', p => Q.core.setInOut(p, 0, 30)); });
  await settle(page);
  ok(await page.evaluate(() => { const e = new Event('beforeunload', { cancelable: true }); window.dispatchEvent(e); return e.defaultPrevented; }), '有未匯出的改動：關閉頁面會提醒（beforeunload）');
  await page.click('#edExportBtn');
  await page.waitForSelector('#edExportDialog[open]');
  await settle(page);
  ok((await page.textContent('#edExportDialog')).includes('匯出影片'), '匯出對話框打開');
  await shot(page, `${tag}-7-export-dialog`);
  await page.click('#edExQuality button[data-v="small"]');
  const [dl] = await Promise.all([page.waitForEvent('download', { timeout: 120000 }), page.click('#edExGo')]);
  const outFile = path.join(os.tmpdir(), `qpt-edit-ui-${process.pid}-${tag}.mp4`);
  await dl.saveAs(outFile);
  await page.waitForFunction(() => /已匯出/.test(document.getElementById('edExMsg').textContent), null, { timeout: 60000 });
  ok(fs.statSync(outFile).size > 2000, `匯出成功：${dl.suggestedFilename()}（${fs.statSync(outFile).size} bytes）`);
  const probe = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-show_streams', '-of', 'json', outFile]).toString());
  const vs = probe.streams.find(x => x.codec_type === 'video'), as = probe.streams.find(x => x.codec_type === 'audio');
  eq([vs && vs.width, vs && vs.height], [1080, 1920], '輸出影片 1080×1920（9:16）');
  eq(vs && +vs.nb_frames, 30, '輸出剛好 30 格（In～Out 1 秒）');
  ok(!!as, '輸出有聲音軌');
  try { execFileSync('ffmpeg', ['-v', 'error', '-i', outFile, '-f', 'null', '-'], { stdio: 'pipe' }); ok(true, 'ffmpeg 解碼沒有錯誤'); } catch (e) { ok(false, 'ffmpeg 解碼失敗：' + e.stderr); }
  fs.rmSync(outFile, { force: true });
  ok(!(await page.evaluate(() => { const e = new Event('beforeunload', { cancelable: true }); window.dispatchEvent(e); return e.defaultPrevented; })), '匯出完成後關閉頁面不再提醒');
  await shot(page, `${tag}-7b-export-done`);
  await page.click('#edExClose');
  await settle(page);

  // ---------------------------------------------------------------- 回到其他分頁：版面沒被影響
  console.log('其他分頁的版面');
  await page.evaluate(() => { const Q = QPTEdit; Q.ui.state.history.run('改一下', p => Q.core.clearInOut(p)); });
  await page.click('#funcLayoutBtn');
  await settle(page);
  const layoutAfter = await page.evaluate(() => { const r = document.getElementById('layoutApp').getBoundingClientRect(); return { x: Math.round(r.x), w: Math.round(r.width), h: Math.round(r.height) }; });
  eq(layoutAfter, layoutBefore, '切回「圖片套版」：版面位置與大小和進剪輯分頁前一模一樣');
  eq(await page.evaluate(() => getComputedStyle(document.querySelector('.wrap')).maxWidth), '1180px', '.wrap 的寬度限制恢復成 1180px');
  ok(!(await page.isVisible('#editApp')), '剪輯分頁隱藏');
  ok(!(await page.isVisible('#resizeApp')), '「尺寸」面板在圖片套版分頁不會露出來');
  await shot(page, `${tag}-8-layout-after`);
  for (const [btn, app] of [['#funcWatermarkBtn', '#watermarkApp'], ['#funcCollageBtn', '#collageApp'], ['#funcResizeBtn', '#resizeApp']]) {
    await page.click(btn);
    await settle(page);
    const r = await page.evaluate(a => { const e = document.querySelector(a).getBoundingClientRect(); return { w: Math.round(e.width), noScroll: document.documentElement.scrollWidth <= innerWidth + 1 }; }, app);
    ok(r.w <= 1180 && r.noScroll, `${app}：寬度 ${r.w}px（沒有被剪輯的滿版影響）`);
    await shot(page, `${tag}-9-tab-${app.slice(1)}`);
  }
  await page.click('#funcEditBtn');
  await settle(page);
  ok(await page.isVisible('#editApp'), '再切回剪輯：仍在、狀態保留');
  ok((await clips(page)).length > 5, '再切回剪輯：時間軸內容還在');
  eq(await page.evaluate(() => window.__csp), [], '沒有 CSP 違規');


  // ---------------------------------------------------------------- 其他操作：拖放素材、框選、片尾淡出轉場、檢查器變速、刪除有片段的軌道
  console.log('其他操作');
  await page.evaluate(() => { const h = QPTEdit.ui.state.history; while (h.canUndo) h.undo(); });
  await settle(page);
  eq(Object.keys(await proj(page, p => p.clips)).length, 0, '全部復原：時間軸清空');
  eq(await proj(page, p => p.aspect), 'source', '復原也把輸出比例還原');
  await page.evaluate(() => { QPTEdit.ui.setZoom(60, false); document.querySelector('.ed-tl-scroll').scrollLeft = 0; });
  await settle(page);
  await page.click('.ed-tab[data-tab="media"]');
  ok((await page.textContent(`.ed-mitem[data-media="${M('land')}"]`)).includes('In／Out'), '媒體庫的素材上顯示它設定過的來源 In／Out 範圍');
  await page.dblclick(`.ed-mitem[data-media="${M('land')}"]`);
  await page.click('#edSrcIO >> text=清除');
  await page.click('#edModeTimeline');
  eq(await state(page, 'sourceInOut'), null, '清除來源 In／Out');
  await page.click('.ed-th-name:text-is("V1")');
  await page.click('.ed-th-name:text-is("A1")');
  await pickMedia('land');
  await page.click('#edAppend');
  await settle(page);
  const dragFromLib = async (key, toFrame, trackName) => {
    const sel = `.ed-mitem[data-media="${M(key)}"]`;
    await page.locator(sel).scrollIntoViewIfNeeded();
    const r = await page.evaluate(s => { const b = document.querySelector(s).getBoundingClientRect(); return { x: b.left + b.width / 2, y: b.top + b.height / 2 }; }, sel);
    const lane = await laneBox(page, trackName);
    await drag(page, r, { x: await frameX(page, toFrame), y: lane.y + lane.h / 2 }, { steps: 16 });
  };
  await dragFromLib('still', 30, 'V2');
  await dragFromLib('music', 0, 'A2');
  cl = await clips(page);
  eq(on(cl, 'V2').map(c => [c.s, c.d]), [[30, 150]], '把圖片拖到 V2 的 30 格：預設 5 秒（150 格）');
  eq(on(cl, 'A2').map(c => [c.s, c.d]), [[0, 240]], '把音樂拖到 A2：8 秒（240 格）');
  await dragFromLib('mute', 0, 'A1');
  ok(/沒有聲音/.test(await statusText(page)), '把沒有聲音的影片拖到音訊軌：狀態列說明原因（' + (await statusText(page)) + '）');
  eq(on(await clips(page), 'A1').length, 1, '沒有放進去');
  eq(await invariants(page), [], '不變式 OK');
  // 框選（選取工具，在空白處拖出矩形）與 Ctrl+A
  await page.keyboard.press('Escape');
  const lv2 = await laneBox(page, 'V2'), la2 = await laneBox(page, 'A2');
  await drag(page, { x: await frameX(page, 450), y: lv2.y + 4 }, { x: await frameX(page, 5), y: la2.y + la2.h - 4 }, { steps: 12 });
  eq(await proj(page, p => Q.ui.state.selection.size), 4, '框選：拖出矩形選到 4 個片段');
  await page.keyboard.press('Escape');
  eq(await proj(page, p => Q.ui.state.selection.size), 0, 'Esc：取消選取');
  await page.keyboard.press('Control+a');
  eq(await proj(page, p => Q.ui.state.selection.size), 4, 'Ctrl+A：全選');
  await page.keyboard.press('Escape');
  // 片尾淡出轉場（最後一個片段後面沒有片段）
  cl = await clips(page);
  const lastV = on(cl, 'V1')[0];
  cb = await clipBox(page, lastV.id);
  await page.mouse.click(cb.x + cb.w / 2, cb.y + cb.h - 8);
  await page.click('.ed-tab[data-tab="trans"]');
  await page.click('#edTransList .ed-gitem[data-trans="fadeToBlack"]');
  await page.click('#edTransAdd');
  await settle(page);
  trs = await proj(page, p => Object.values(p.transitions));
  eq([trs.length, trs[0].type, trs[0].rightClipId, trs[0].align], [1, 'fadeToBlack', null, 'end'], '片段結尾加「淡出到黑」：沒有右片段，對齊在結尾');
  await page.keyboard.press('Escape');
  await page.keyboard.press('Delete');
  await settle(page);
  eq(await proj(page, p => Object.keys(p.transitions).length), 1, '沒選到轉場時，Delete 不會誤刪別的東西（沒有選取：只提示）');
  // 檢查器：倒播、速度標籤拖曳
  cb = await clipBox(page, lastV.id);
  await page.mouse.click(cb.x + cb.w / 2, cb.y + cb.h - 8);
  await settle(page);
  ok(await page.isVisible('.ed-sec[data-sec="speed"]'), '選取影片片段：檢查器有「速度」區');
  await page.locator('.ed-sec[data-sec="speed"]').getByLabel('倒播').check();
  await settle(page);
  cl = await clips(page);
  eq([on(cl, 'V1')[0].rv, on(cl, 'A1')[0].rv], [true, true], '檢查器勾選倒播：影像與連結的聲音都倒播');
  ok((await page.locator('.ed-clip .ed-badge:text-is("倒播")').count()) >= 1, '片段上顯示「倒播」標籤');
  await page.keyboard.press('Control+z');
  await settle(page);
  const spLab = page.locator('.ed-sec[data-sec="speed"] .ed-fx-lab:text-is("速度")');
  await spLab.scrollIntoViewIfNeeded();
  const sb = await spLab.boundingBox();
  await drag(page, { x: sb.x + 5, y: sb.y + sb.height / 2 }, { x: sb.x + 55, y: sb.y + sb.height / 2 });
  cl = await clips(page);
  ok(Math.abs(on(cl, 'V1')[0].sp - 1.5) < 0.011, `拖曳「速度」標籤：+50px → 150%（${on(cl, 'V1')[0].sp}）`);
  eq(on(cl, 'V1')[0].d, 120, '波紋變速：長度 180 → 120 格');
  if (on(cl, 'V1')[0].d !== 120) console.log('       DEBUG', JSON.stringify(cl));
  await page.keyboard.press('Control+z');
  await settle(page);
  eq(on(await clips(page), 'V1')[0].sp, 1, '速度拖曳也只記一筆復原');
  eq(await invariants(page), [], '不變式 OK');
  // 刪除有片段的軌道：要先確認，可以復原
  await page.click('.ed-th.video .ed-th-name >> nth=0', { button: 'right' });
  await page.click('.ed-menu-item:has-text("刪除這條軌道")');
  await page.waitForSelector('#confirmOverlay.open');
  await page.click('#confirmOkBtn');
  await settle(page);
  eq(await proj(page, p => p.tracks.filter(t => t.kind === 'video').length), 1, '右鍵刪除有片段的軌道（確認後）：V2 不見了');
  eq(await proj(page, p => Object.values(p.clips).filter(c => c.type === 'media' && p.mediaInfo[c.mediaId].kind === 'image').length), 0, '軌道上的圖片片段一起被刪掉');
  await page.keyboard.press('Control+z');
  await settle(page);
  eq(await proj(page, p => p.tracks.filter(t => t.kind === 'video').length), 2, 'Ctrl+Z：軌道與片段都回來');
  eq(await invariants(page), [], '不變式 OK');
  eq(await page.evaluate(() => window.__csp), [], '沒有 CSP 違規（最終）');

  console.log('問題清單：', problems.length ? problems : '無');
  await ctx.close();
  return problems;
}

(async () => {
  const fix = fixturesDir();
  const { server, base } = await serve();
  const browser = await chromium.launch(EXE ? { executablePath: EXE } : {});
  let all = [];
  try {
    for (const vp of VIEWPORTS) all = all.concat(await runViewport(browser, base, fix, vp));
  } catch (e) { failed++; console.log('  FAIL 測試中斷：', e && e.stack || e); }
  ok(all.length === 0, '整段流程沒有 console error／頁面例外／CSP 違規' + (all.length ? '：' + all.join(' | ') : ''));
  await browser.close(); server.close();
  console.log(`\n${passed} 項通過，${failed} 項失敗`);
  process.exit(failed ? 1 : 0);
})();

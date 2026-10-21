// Facebook 粉專排程發文的背景端（由 background.js importScripts 載入）。
// 流程：排定時間到 → 鬧鐘 post:<id> 觸發 → 開粉專分頁 → 把內容交給 fbpost.js（內容腳本）填好、按發佈、在剛發的貼文留言
//       → 內容腳本回報結果 → 更新狀態、關分頁、發通知。
// 背景腳本隨時可能被 Chrome 收掉，所以「現在跑到哪」一律寫進 storage（status／step），
// 並設一個「卡住監看」鬧鐘 post-watch:<id>，保證不會永遠停在執行中。
// 另外替網頁版（透過 schedbridge.js）提供排程清單的讀寫，以及快速產圖要用的「代抓文章／圖片」（sched:api）。
(function (root) {
  const S = root.QptSched;
  const B = root.QptSchedBridge;
  const ALARM = 'post:';
  const WATCH = 'post-watch:';
  const BEAT = 'post-beat:';          // 每分鐘檢查一次內容腳本還活不活著
  const BEAT_LOST_MS = 45 * 1000;      // 超過這麼久沒收到心跳（內容腳本每 4 秒一次）就當它失聯了
  const MAX_RESUME = 1;                // 腳本在留言階段失聯時，最多重新交付一次（頁面被重新載入的情況）
  const FB_ORIGIN = 'https://www.facebook.com';
  const DELIVER_TRIES = 180;         // 等內容腳本就緒：最多 180 次 × 0.5 秒（發文要快：頁面一就緒就交付）
  const DELIVER_EVERY_MS = 500;
  const RELOAD_WAIT_MS = 30 * 1000;  // 重新整理後等頁面載入的上限
  const BUSY_RETRY_MS = 60 * 1000;   // 前一筆還在跑，等 1 分鐘再試

  const c = () => root.chrome;
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const when = t => new Date(t).toLocaleString('zh-TW', { hour12: false });

  function notify(title, message) {
    try { Promise.resolve(c().notifications.create('', { type: 'basic', iconUrl: 'icons/icon-128.png', title, message })).catch(() => {}); }
    catch (e) { /* 沒有通知權限：狀態仍會顯示在側邊欄 */ }
  }
  const preview = item => ((item.text || '').trim().split('\n')[0] || `${item.images.length} 張圖片`).slice(0, 30);
  const isCommentStep = step => step === 'reloading' || step === 'finding' || step === 'commenting';

  async function clearWatchers(id) {
    for (const name of [WATCH + id, BEAT + id]) { try { await c().alarms.clear(name); } catch (e) { /* ignore */ } }
  }
  async function closeTab(item) {
    // 成功就關掉我們開的分頁，並回到原本在看的分頁；失敗時留著，方便看卡在哪
    try { if (item.tabId != null) await c().tabs.remove(item.tabId); } catch (e) { /* 已被關掉 */ }
    try { if (item.prevTabId != null) await c().tabs.update(item.prevTabId, { active: true }); } catch (e) { /* 原分頁不在了 */ }
  }

  // ---- 結束一次執行 -----------------------------------------------------
  // result：{ ok, step, error, commentState('none'|'done'|'failed'|'dry-ok'), commentError }
  // 發貼文：成功 → done（留言失敗也算 done，另外記 commentState）；失敗 → failed。
  // 試跑：不論結果都回到執行前的狀態，只留下 step／error 讓側邊欄顯示。
  // 補留言（mode:comment）：貼文維持 done，只更新留言狀態。
  async function finish(item, result) {
    const base = { tabId: undefined, startedAt: undefined, finishedAt: Date.now(), prevStatus: undefined, dryRun: false, mode: undefined, beat: undefined, resume: undefined, resumed: undefined };
    await clearWatchers(item.id);
    if (item.mode === 'comment') {
      if (item.dryRun) {
        await S.update(item.id, Object.assign(base, {
          status: 'done', step: result.ok ? 'dry-ok' : result.step, error: undefined,
          commentError: result.ok ? undefined : result.error
        }));   // 試跑留言：留言狀態維持原樣
        notify(result.ok ? '試跑留言完成' : '試跑留言失敗', result.ok ? '留言已打好、尚未送出，請到 Facebook 分頁確認' : result.error);
        return;
      }
      await S.update(item.id, Object.assign(base, {
        status: 'done', step: result.ok ? 'commented' : result.step, error: undefined,
        commentState: result.ok ? 'done' : 'failed', commentError: result.ok ? undefined : result.error
      }));
      if (result.ok) { notify('留言完成', preview(item)); await closeTab(item); }
      else notify('補留言失敗', `${preview(item)}：${result.error}`);
      return;
    }

    if (item.dryRun) {
      await S.update(item.id, Object.assign(base, {
        status: item.prevStatus || 'pending', step: result.ok ? 'dry-ok' : result.step, error: result.ok ? undefined : result.error
      }));   // 試跑完成後分頁留著讓你檢查，不再追蹤它
      notify(result.ok ? '試跑完成' : '試跑失敗', result.ok ? '內容已填好、尚未發佈，請到 Facebook 分頁確認' : result.error);
      return;
    }

    const commentState = result.ok && result.commentState && result.commentState !== 'none' ? result.commentState : undefined;
    if (result.ok && typeof result.postMs === 'number') base.postMs = result.postMs;
    await S.update(item.id, Object.assign(base, {
      status: result.ok ? 'done' : 'failed', step: result.step, error: result.ok ? undefined : result.error,
      commentState, commentError: commentState === 'failed' ? result.commentError : undefined
    }));
    if (!result.ok) { notify('粉專排程發佈失敗', `${preview(item)}：${result.error}`); return; }
    if (commentState === 'failed') {
      // 貼文發佈了、留言沒成：分頁留著，方便手動留言
      notify('已發佈到粉專，但留言失敗', `${preview(item)}：${result.commentError}`);
      return;
    }
    notify(commentState === 'done' ? '已發佈並留言' : '已發佈到粉專', preview(item));
    await closeTab(item);
  }

  // 失敗收尾。貼文已經發佈、卡在留言階段時，不能把整筆標成失敗（會誤導人重發）：算已發佈、留言失敗。
  function failItem(item, error, step) {
    if (item.mode !== 'comment' && isCommentStep(step)) return finish(item, { ok: true, step, commentState: 'failed', commentError: error });
    return finish(item, { ok: false, error, step });
  }
  async function failRunning(id, error, step) {
    const item = (await S.list()).find(i => i.id === id);
    if (!item || item.status !== 'running') return;
    await failItem(item, error, step || item.step);
  }

  // ---- 開始一次執行 -----------------------------------------------------
  // opts.manual：從側邊欄／網頁版手動按；opts.dryRun：只填內容、不按發佈（補留言時：只打好留言、不送出）
  // opts.mode：post（發貼文，之後留言）｜comment（貼文已發佈，只補留言）
  async function start(id, opts) {
    const { manual = false, dryRun = false } = opts || {};
    const mode = opts && opts.mode === 'comment' ? 'comment' : 'post';
    const now = Date.now();
    const list = await S.list();
    const item = list.find(i => i.id === id);
    if (!item) return { ok: false, error: 'not_found' };

    if (list.some(i => i.id !== id && S.classify(i, now) === 'busy')) {
      if (manual) return { ok: false, error: '另一筆正在執行中，請稍後再試' };
      await c().alarms.create(ALARM + id, { when: now + BUSY_RETRY_MS });
      return { ok: true, deferred: true };
    }
    if (item.status === 'running') return { ok: false, error: '這筆正在執行中' };
    if (mode === 'comment') {
      if (item.status !== 'done') return { ok: false, error: '貼文還沒發佈，不能補留言' };
      if (!S.commentOf(item)) return { ok: false, error: '這筆沒有要留言的內容（小編文和文章網址都是空的）' };
    } else if (item.status === 'done') {
      return { ok: false, error: '這筆已經發佈過了' };
    }

    if (!manual) {   // 到點自動執行：只有「等待中」且在寬限內才發
      const act = S.classify(item, now);
      if (item.status !== 'pending' || act === 'idle') return { ok: false, error: 'not_pending' };
      if (act === 'wait') { await c().alarms.create(ALARM + id, { when: item.at }); return { ok: true, deferred: true }; }
      if (act === 'missed') { await markMissed(item); return { ok: false, error: 'missed' }; }
    }

    const v = S.validateItem(item);
    if (!v.ok) {
      await finish(Object.assign({}, item, { dryRun, mode, prevStatus: item.status }), { ok: false, error: v.error, step: 'start' });
      return { ok: false, error: v.error };
    }

    await S.update(id, {
      status: 'running', startedAt: now, beat: now, dryRun, mode, prevStatus: item.status, step: 'start', error: undefined, finishedAt: undefined, tabId: undefined, resume: undefined, resumed: undefined, postMs: mode === 'comment' ? item.postMs : undefined
    });
    // 背景執行：新分頁不搶焦點，你原本在看的分頁不會被切走（也就不需要切回去）
    let background = false;
    try { background = (await S.getSettings()).background; } catch (e) { /* 讀不到設定：照一般方式（前景）執行 */ }
    let prev = null;
    if (!background) { try { [prev] = await c().tabs.query({ active: true, lastFocusedWindow: true }); } catch (e) { /* ignore */ } }
    let tab;
    try { tab = await c().tabs.create({ url: item.pageUrl, active: !background }); }
    catch (e) { await failRunning(id, '無法開啟 Facebook 分頁', 'start'); return { ok: false, error: 'tab_failed' }; }
    await S.update(id, { tabId: tab.id, prevTabId: prev ? prev.id : undefined });
    await c().alarms.create(WATCH + id, { delayInMinutes: S.RUN_TIMEOUT_MS / 60000 });
    await c().alarms.create(BEAT + id, { delayInMinutes: 1, periodInMinutes: 1 });

    // 不 await：整段交付最久 90 秒，期間每次 sendMessage 都會讓背景腳本保持存活；結果由 fbpost:result 訊息回報
    deliver(tab.id, item, dryRun, mode).catch(err => failRunning(id, err.message || String(err), 'start'));
    return { ok: true };
  }

  // 內容腳本要等頁面載入才會就緒，所以重複送，直到它回「已開始」
  async function deliver(tabId, item, dryRun, mode) {
    const m = mode === 'comment' ? 'comment' : 'post';
    const job = {
      type: 'fbpost:run',
      job: {
        id: item.id, mode: m, text: item.text, images: m === 'comment' ? [] : item.images, comment: S.commentOf(item), dryRun,
        reload: m === 'post' && !dryRun,          // 發佈完成後先重新整理頁面，再找剛發的貼文留言（動態牆不會即時長出新貼文）
        fresh: m === 'comment' && !!item.resume   // 接手留言：剛發佈的貼文，不是很久以前的
      }
    };
    for (let i = 0; i < DELIVER_TRIES; i++) {
      try {
        const r = await c().tabs.sendMessage(tabId, job);
        if (r && r.started) return;
        if (r && r.busy) throw new Error('頁面上已有另一個發文動作在進行');
      } catch (e) {
        if (e && /另一個發文動作/.test(e.message)) throw e;   // 其他錯誤（內容腳本還沒就緒）就等下一輪
      }
      await sleep(DELIVER_EVERY_MS);
    }
    throw new Error('Facebook 頁面沒有準備好（沒載入完成，或網址不是粉專頁面）');
  }

  // 重新整理分頁並等它載入完（最多 30 秒；逾時也繼續，交付時會再等內容腳本就緒）
  function reloadTab(tabId) {
    return new Promise((resolve, reject) => {
      const tabs = c().tabs;
      let timer;
      const done = err => { clearTimeout(timer); try { tabs.onUpdated.removeListener(on); } catch (e) { /* ignore */ } if (err) reject(err); else resolve(); };
      const on = (id, info) => { if (id === tabId && info && info.status === 'complete') done(); };
      tabs.onUpdated.addListener(on);
      timer = setTimeout(() => done(), RELOAD_WAIT_MS);
      Promise.resolve(tabs.reload(tabId)).catch(done);
    });
  }
  // 貼文發佈後，Facebook 不會即時把新貼文長到「目前這個頁面」的動態牆上，所以內容腳本請背景把分頁重新整理，
  // 載入完再交付一次「只留言」的工作（resume：留言失敗只算留言失敗，貼文早就發出去了）
  // 從開始執行到「按下發佈、視窗關閉」用了幾毫秒（內容腳本回報完成的時間點；不含之後的重新整理與留言）
  function postMsOf(item, postedAt) {
    const t = Number(postedAt);
    if (!item.startedAt || !isFinite(t) || t < item.startedAt || t > Date.now() + 5000) return undefined;
    return Math.round(t - item.startedAt);
  }
  async function reloadThenComment(item, postMs) {
    await S.update(item.id, Object.assign({ resume: true, beat: Date.now(), step: 'reloading' }, postMs !== undefined ? { postMs } : {}));
    try { await reloadTab(item.tabId); }
    catch (e) { await failRunning(item.id, '貼文已發佈，但重新整理頁面失敗：' + (e.message || e), 'reloading'); return; }
    const now = (await S.list()).find(i => i.id === item.id);
    if (!now || now.status !== 'running') return;   // 重整途中被中止或分頁被關掉了
    await S.update(item.id, { beat: Date.now(), step: 'finding' });
    deliver(item.tabId, now, false, 'comment').catch(err => failRunning(item.id, err.message || String(err), 'finding'));
  }

  async function markMissed(item) {
    await c().alarms.clear(ALARM + item.id);
    await S.update(item.id, { status: 'missed', error: `排定 ${when(item.at)}，但那時瀏覽器沒開或電腦休眠，已超過 ${S.GRACE_MS / 60000} 分鐘所以沒有補發` });
    notify('粉專排程錯過了', `${preview(item)}（排定 ${when(item.at)}）`);
  }

  // ---- 內容腳本失聯／手動中止 ------------------------------------------------------
  // 內容腳本每 4 秒回報一次心跳。頁面被重新載入、分頁當機時腳本會被帶走，不會有人回報結果，
  // 如果等到 6 分鐘的「卡住監看」才收尾，畫面就會一直顯示「執行中」。所以每分鐘檢查一次：失聯超過 45 秒就處理。
  async function checkBeat(id) {
    const item = (await S.list()).find(i => i.id === id);
    if (!item || item.status !== 'running') { try { await c().alarms.clear(BEAT + id); } catch (e) { /* ignore */ } return; }
    if (Date.now() - (item.beat || item.startedAt || 0) <= BEAT_LOST_MS) return;
    // 貼文已經發佈、只差留言：頁面重新載入後內容腳本會重新注入，再交付一次「只留言」的工作，接著做
    if (item.mode !== 'comment' && !item.dryRun && isCommentStep(item.step) && item.tabId != null && (item.resumed || 0) < MAX_RESUME) {
      await S.update(id, { resume: true, resumed: (item.resumed || 0) + 1, beat: Date.now(), step: 'finding' });
      deliver(item.tabId, item, false, 'comment').catch(err => failRunning(id, err.message || String(err), 'finding'));
      return;
    }
    const label = S.STEP_LABELS[item.step] || '開始';
    const msg = item.step === 'publishing' || isCommentStep(item.step) ? S.stuckMessage(item.step)
      : `Facebook 分頁沒有回應（可能重新載入、被關掉或當機），停在「${label}」這一步，沒有發佈`;
    await failRunning(id, msg, item.step);
  }

  // 手動中止：叫分頁的腳本停手，並把這筆收尾。已經按下發佈的、已經發佈在留言的，訊息都說清楚「貼文可能已經發出」。
  async function cancel(id) {
    const item = (await S.list()).find(i => i.id === id);
    if (!item || item.status !== 'running') return { ok: false, error: '這筆沒有在執行中' };
    const step = item.step;
    const msg = step === 'publishing' ? '已手動中止；中止時已按下發佈，貼文可能已經發出，請先到粉專確認，再決定要不要重發'
      : isCommentStep(step) ? '貼文已經發佈，留言已手動中止（可以按「補留言」）'
      : '已手動中止，沒有發佈';
    try { if (item.tabId != null) await c().tabs.sendMessage(item.tabId, { type: 'fbpost:cancel', id }); } catch (e) { /* 分頁已經不在了 */ }
    await failRunning(id, msg, step);
    return { ok: true };
  }

  // ---- 對帳：鬧鐘和佇列保持一致（啟動、安裝、佇列變動時呼叫）-------------------
  let syncing = Promise.resolve();
  function sync() {
    syncing = syncing.then(doSync).catch(() => {});
    return syncing;
  }
  async function doSync() {
    const now = Date.now();
    const list = await S.list();
    const alarms = await c().alarms.getAll();
    const byName = new Map(alarms.map(a => [a.name, a]));
    const wanted = new Set();
    for (const item of list) {
      const act = S.classify(item, now);
      if (act === 'missed') { await markMissed(item); continue; }
      if (act === 'stale') { await failItem(item, S.stuckMessage(item.step), item.step); continue; }
      if (item.status !== 'pending') continue;
      wanted.add(ALARM + item.id);
      const have = byName.get(ALARM + item.id);
      if (!have || (item.at > now && Math.abs(have.scheduledTime - item.at) > 1000)) {
        await c().alarms.create(ALARM + item.id, { when: Math.max(item.at, now + 1000) });
      }
    }
    for (const a of alarms) {
      if (a.name.startsWith(ALARM) && !wanted.has(a.name)) await c().alarms.clear(a.name);
    }
  }

  // ---- 網頁版快速產圖：外掛代為下載文章與圖片 -----------------------------------------
  // 網頁版（github.io）抓別家網站會被瀏覽器的跨網域限制擋住，外掛有權限抓，所以請外掛代勞；解析標題、挑圖都在網頁那邊做。
  // 這等於讓網頁用外掛的身分發出請求，所以限制很嚴：
  //   文章：只能是 https 的 tvbs.com.tw 網址（與熱門新聞庫橋接同一條規則，bridge.js 的 validateSend），轉址後也必須還在 tvbs.com.tw；
  //   圖片：網址要是公開網站（不能是內網、本機，轉址後也一樣），而且回應必須真的是圖片（content-type）才會回傳，有大小與逾時上限。
  async function blobToDataUrl(blob) {
    const bytes = new Uint8Array(await blob.arrayBuffer());
    let bin = '';
    for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return `data:${blob.type};base64,${root.btoa(bin)}`;
  }
  const fetchFailMessage = (e, what, seconds) => (e && e.reason === 'timeout' ? `${what}讀取逾時（超過 ${seconds} 秒），請稍後再試`
    : e && e.reason === 'toobig' ? `${what}檔案太大，已停止讀取` : '連線失敗，請確認網址和網路');

  async function webFetchArticle(p) {
    const QF = root.QuickFill, BR = root.QptBridge;
    if (!QF || !BR) return { ok: false, error: 'internal_error' };
    const v = BR.validateSend({ url: p && p.url });
    if (!v.ok) return { ok: false, error: '網頁版快速產圖只能抓 TVBS 的文章網址（https://….tvbs.com.tw/…）' };
    let got;
    try { got = await QF.fetchLimited(v.url, { timeoutMs: QF.LIMITS.ARTICLE_TIMEOUT, maxBytes: QF.LIMITS.MAX_ARTICLE_BYTES }); }
    catch (e) { return { ok: false, error: fetchFailMessage(e, '文章', QF.LIMITS.ARTICLE_TIMEOUT / 1000) }; }
    if (!got.res.ok) return { ok: false, error: `文章讀取失敗（HTTP ${got.res.status}）` };
    const f = BR.validateSend({ url: got.res.url || v.url });   // 轉址之後也必須還在 TVBS
    if (!f.ok) return { ok: false, error: '文章被轉址到 TVBS 以外的網站，已停止' };
    return { ok: true, data: { html: await got.blob.text(), url: f.url } };
  }

  async function webFetchImage(p) {
    const QF = root.QuickFill, BR = root.QptBridge;
    if (!QF || !BR) return { ok: false, error: 'internal_error' };
    const a = BR.validateSend({ url: p && p.articleUrl });
    const imageUrl = p && typeof p.url === 'string' ? p.url : '';
    if (!a.ok || !imageUrl || imageUrl.length > 2000 || !QF.isAllowedImageUrl(imageUrl, a.url)) return { ok: false, error: '圖片網址不安全，已略過' };
    let got;
    try { got = await QF.fetchLimited(imageUrl, { timeoutMs: QF.LIMITS.IMAGE_TIMEOUT, maxBytes: QF.LIMITS.MAX_IMAGE_BYTES }); }
    catch (e) { return { ok: false, error: fetchFailMessage(e, '圖片', QF.LIMITS.IMAGE_TIMEOUT / 1000) }; }
    if (!got.blob) return { ok: false, error: `圖片讀取失敗（HTTP ${got.res.status}）` };
    if (!QF.isAllowedImageUrl(got.res.url || imageUrl, a.url)) return { ok: false, error: '圖片被轉址到不安全的位置，已略過' };
    if (!/^image\/(png|jpe?g|webp|gif|avif|bmp)/i.test(got.blob.type)) return { ok: false, error: '這個網址不是圖片' };
    return { ok: true, data: { dataUrl: await blobToDataUrl(got.blob), type: got.blob.type } };
  }

  // ---- 網頁版的排程操作（來自 schedbridge.js）---------------------------------
  // 網頁傳來的資料一律當作不可信：新增／編輯都重新驗證（S.buildItem），圖片只在要編輯時單筆取。
  async function webApi(op, p) {
    const payload = p && typeof p === 'object' ? p : {};
    switch (op) {
      case 'ping': return { ok: true, data: { version: c().runtime.getManifest().version } };
      case 'list': return { ok: true, data: (await S.list()).map(S.summarize) };
      case 'get': {
        const item = (await S.list()).find(i => i.id === payload.id);
        return item ? { ok: true, data: item } : { ok: false, error: '找不到這筆排程' };
      }
      case 'add': {
        const r = await S.addItem(payload.input);
        return r.ok ? { ok: true, data: S.summarize(r.item) } : r;
      }
      case 'edit': {
        const r = await S.edit(payload.id, payload.input);
        return r.ok ? { ok: true, data: S.summarize(r.item) } : r;
      }
      case 'remove': {
        const item = (await S.list()).find(i => i.id === payload.id);
        if (!item) return { ok: true };
        if (item.status === 'running') return { ok: false, error: '正在執行中，不能刪除' };
        await S.remove(payload.id);
        return { ok: true };
      }
      case 'start': {
        if (typeof payload.id !== 'string') return { ok: false, error: 'bad_request' };
        return start(payload.id, { manual: true, dryRun: !!payload.dryRun, mode: payload.mode === 'comment' ? 'comment' : 'post' });
      }
      case 'cancel': return typeof payload.id === 'string' ? cancel(payload.id) : { ok: false, error: 'bad_request' };
      case 'getSettings': return { ok: true, data: await S.getSettings() };
      case 'setSettings': return typeof payload.background === 'boolean' ? { ok: true, data: await S.setSettings({ background: payload.background }) } : { ok: false, error: 'bad_request' };
      case 'fetchArticle': return webFetchArticle(payload);
      case 'fetchImage': return webFetchImage(payload);
      default: return { ok: false, error: 'unknown_op' };
    }
  }

  // ---- 事件接線 -----------------------------------------------------------
  function register() {
    c().alarms.onAlarm.addListener(alarm => {
      if (alarm.name.startsWith(ALARM)) start(alarm.name.slice(ALARM.length)).catch(() => {});
      else if (alarm.name.startsWith(BEAT)) checkBeat(alarm.name.slice(BEAT.length)).catch(() => {});
      else if (alarm.name.startsWith(WATCH)) {
        const id = alarm.name.slice(WATCH.length);
        S.list().then(list => {
          const item = list.find(i => i.id === id);
          if (item && item.status === 'running') return failRunning(id, S.stuckMessage(item.step), item.step);
        }).catch(() => {});
      }
    });

    c().runtime.onMessage.addListener((msg, sender, sendResponse) => {
      if (!msg || typeof msg.type !== 'string' || sender.id !== c().runtime.id) return;

      // 來自側邊欄（擴充功能自己的頁面，沒有 tab）：手動執行
      if (msg.type === 'poster:start') {
        if (sender.tab || typeof msg.id !== 'string') return;
        start(msg.id, { manual: true, dryRun: !!msg.dryRun, mode: msg.mode === 'comment' ? 'comment' : 'post' })
          .then(sendResponse, () => sendResponse({ ok: false, error: 'internal_error' }));
        return true;
      }

      if (msg.type === 'poster:cancel') {
        if (sender.tab || typeof msg.id !== 'string') return;
        cancel(msg.id).then(sendResponse, () => sendResponse({ ok: false, error: 'internal_error' }));
        return true;
      }

      // 來自網頁版（內容腳本 schedbridge.js 轉進來）：排程清單的讀寫
      if (msg.type === 'sched:api') {
        if (!B || !B.senderAllowed(sender, c().runtime.id) || !B.OPS.includes(msg.op)) { sendResponse({ ok: false, error: 'not_allowed' }); return; }
        webApi(msg.op, msg.payload).then(sendResponse, () => sendResponse({ ok: false, error: 'internal_error' }));
        return true;
      }

      // 來自 Facebook 分頁的內容腳本：進度與結果。只信任「我們開的那個分頁」回報的。
      if (msg.type === 'fbpost:progress' || msg.type === 'fbpost:result' || msg.type === 'fbpost:reload') {
        if (!sender.tab || typeof msg.id !== 'string' || typeof sender.url !== 'string' || !sender.url.startsWith(FB_ORIGIN + '/')) return;
        (async () => {
          const item = (await S.list()).find(i => i.id === msg.id);
          if (!item || item.status !== 'running' || item.tabId !== sender.tab.id) return;
          if (msg.type === 'fbpost:progress') { await S.update(item.id, { step: String(msg.step || '').slice(0, 20), beat: Date.now() }); return; }
          if (msg.type === 'fbpost:reload') {
            if (item.mode !== 'comment' && !item.dryRun && !item.resume) await reloadThenComment(item, postMsOf(item, msg.postedAt));
            return;
          }
          // 接手繼續留言（resume）失敗：貼文早就發佈了，只能算「留言失敗」，不能把整筆標成失敗
          if (item.resume && !msg.ok) {
            await finish(item, { ok: true, step: String(msg.step || item.step || '').slice(0, 20), commentState: 'failed', commentError: String(msg.error || '留言失敗').slice(0, 300) });
            return;
          }
          await finish(item, {
            ok: !!msg.ok, step: String(msg.step || item.step || '').slice(0, 20),
            error: msg.ok ? undefined : String(msg.error || '發佈失敗').slice(0, 300),
            commentState: ['none', 'done', 'failed', 'dry-ok'].includes(msg.commentState) ? msg.commentState : undefined,
            commentError: msg.commentError ? String(msg.commentError).slice(0, 300) : undefined,
            postMs: item.resume ? item.postMs : postMsOf(item, msg.postedAt)
          });
        })().catch(() => {});
        sendResponse({ ok: true });
        return;
      }
    });

    // 使用者自己把正在發佈的分頁關掉
    c().tabs.onRemoved.addListener(tabId => {
      S.list().then(list => {
        const item = list.find(i => i.status === 'running' && i.tabId === tabId);
        if (!item) return;
        const msg = item.step === 'publishing' || isCommentStep(item.step) ? S.stuckMessage(item.step) : '發佈途中分頁被關掉了，沒有發佈';
        return failRunning(item.id, msg, item.step);
      }).catch(() => {});
    });

    c().storage.onChanged.addListener((changes, area) => { if (area === 'local' && changes[S.KEY]) sync(); });
    c().runtime.onInstalled.addListener(() => { sync(); });
    c().runtime.onStartup.addListener(() => { sync(); });
    sync();
  }

  if (S && root.chrome && root.chrome.alarms && root.chrome.tabs && root.chrome.storage && root.chrome.storage.local) register();
  root.QptPoster = { start, sync, deliver, finish, webApi, cancel, checkBeat };
})(typeof self !== 'undefined' ? self : this);

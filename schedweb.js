// 網頁版專用：右側的「排程」隱藏式抽屜。點右邊緣的「排程」頁籤就會從右側彈出 FB 粉專排程（新增、編輯、清單、試跑、留言）。
// 排程資料存在 Chrome 外掛裡，網頁沒辦法直接讀，所以透過 schedbridge.js（外掛注入到這個頁面的內容腳本）用 postMessage 溝通；
// 沒有安裝外掛（或外掛版本太舊）時，抽屜只會顯示說明，不會壞掉。介面本身見 schedui.js（和外掛側邊欄共用）。
(function () {
  const S = window.QptSched;
  const UI = window.QptSchedUI;
  if (!S || !UI) return;
  const ORIGIN = location.origin;
  const PAGE_KEY = 'qpt-sched-page';
  const PING_MS = 1500, CALL_MS = 8000;

  // ---- 和外掛溝通 ----------------------------------------------------------------
  const pending = new Map();
  const changeHandlers = [];
  let seq = 0;
  window.addEventListener('message', event => {
    if (event.source !== window || event.origin !== ORIGIN) return;
    const d = event.data;
    if (!d || d.source !== 'quickpattern') return;
    if (d.type === 'sched-result' && pending.has(d.nonce)) {
      const done = pending.get(d.nonce);
      pending.delete(d.nonce);
      done({ ok: !!d.ok, data: d.data, error: d.error });
    } else if (d.type === 'sched-changed') changeHandlers.forEach(fn => { try { fn(); } catch (e) { /* ignore */ } });
    else if (d.type === 'sched-ready') detect();
  });
  function call(op, payload, timeout) {
    return new Promise(resolve => {
      const nonce = `w${Date.now().toString(36)}${(seq++).toString(36)}${Math.random().toString(36).slice(2, 8)}`;
      const timer = setTimeout(() => { pending.delete(nonce); resolve({ ok: false, error: 'no_extension' }); }, timeout || CALL_MS);
      pending.set(nonce, r => { clearTimeout(timer); resolve(r); });
      try { window.postMessage({ source: 'qpt-web', type: 'sched', v: 1, nonce, op, payload: payload || {} }, ORIGIN); }
      catch (e) { clearTimeout(timer); pending.delete(nonce); resolve({ ok: false, error: 'no_extension' }); }
    });
  }
  const friendly = e => ({
    no_extension: '沒有收到外掛的回應：請確認已安裝並啟用「圖片套版產生器」外掛，並更新到最新版後重新整理本頁',
    not_allowed: '外掛拒絕了這個請求，請更新外掛到最新版後重新整理本頁',
    internal_error: '外掛發生錯誤，請稍後再試',
    unknown_op: '外掛版本太舊，請更新到最新版'
  })[e] || e || '失敗';

  // ---- 介面需要的資料存取（和側邊欄同一組 api 介面）-------------------------------------
  let badge = null;
  const lsGet = k => { try { return localStorage.getItem(k); } catch (e) { return null; } };
  const lsSet = (k, v) => { try { localStorage.setItem(k, v); } catch (e) { /* 沒有儲存權限：不記住而已 */ } };
  const api = {
    async list() {
      const r = await call('list');
      if (!r.ok) throw new Error(friendly(r.error));
      showBadge(r.data);
      return r.data;
    },
    async get(id) { const r = await call('get', { id }); return r.ok ? r.data : null; },
    async add(input) { const r = await call('add', { input }); return { ok: r.ok, error: friendly(r.error) }; },
    async edit(id, input) { const r = await call('edit', { id, input }); return { ok: r.ok, error: friendly(r.error) }; },
    async remove(id) { await call('remove', { id }); },
    async start(id, o) { const r = await call('start', { id, dryRun: !!(o && o.dryRun), mode: o && o.mode === 'comment' ? 'comment' : 'post' }); return { ok: r.ok, error: friendly(r.error) }; },
    async loadPrefs() { return { pageUrl: lsGet(PAGE_KEY) || '' }; },
    async savePrefs(p) { lsSet(PAGE_KEY, p.pageUrl || ''); },
    onChange(cb) { changeHandlers.push(cb); }
  };

  // 「帶入目前圖文」：目前展開的（沒有就取最後完成的）套版圖，標題放進【】
  async function compose() {
    const items = typeof batchItems !== 'undefined' ? batchItems : [];
    const openId = typeof expandedBatchItemId !== 'undefined' ? expandedBatchItemId : null;
    const finished = it => it && it.done && it.resultDataUrl;
    const pick = items.find(it => it.id === openId && finished(it)) || [...items].reverse().find(finished);
    if (!pick) return { text: '', image: null, articleUrl: '' };
    const title = String(pick.title || '').replace(/\s*\n\s*/g, ' ').trim();
    return { text: title ? `【${title}】` : '', image: pick.resultDataUrl, articleUrl: '' };
  }

  // ---- 抽屜 ---------------------------------------------------------------------
  const h = (tag, props, ...kids) => {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(props || {})) {
      if (v == null || v === false) continue;
      if (k === 'text') el.textContent = v;
      else if (k === 'class') el.className = v;
      else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
      else el.setAttribute(k, v === true ? '' : v);
    }
    for (const kid of kids) if (kid) el.append(kid);
    return el;
  };
  const tab = h('button', { type: 'button', class: 'sched-tab', id: 'schedTab', 'aria-expanded': 'false', 'aria-controls': 'schedDrawerPanel', title: 'FB 粉專排程' },
    h('span', { text: '排程' }));
  badge = h('span', { class: 'sched-tab-badge', hidden: true, 'aria-hidden': 'true' });
  tab.append(badge);
  const close = h('button', { type: 'button', class: 'sched-close', 'aria-label': '關閉排程', text: '✕' });
  const note = h('div', { class: 'sched-ext-note', hidden: true, role: 'status' });
  const body = h('div', { class: 'sched-body' });
  const panel = h('div', { class: 'sched-panel', id: 'schedDrawerPanel', role: 'dialog', 'aria-label': 'FB 粉專排程', 'aria-modal': 'false' },
    h('div', { class: 'sched-drawer-head' }, h('strong', { text: 'FB 粉專排程' }), close), note, body);
  const drawer = h('aside', { class: 'sched-drawer', id: 'schedDrawer' }, tab, panel);
  document.body.append(drawer);

  function showBadge(items) {
    const n = items.filter(i => i.status === 'pending' || i.status === 'running').length;
    badge.textContent = String(n);
    badge.hidden = n === 0;
    tab.title = n ? `FB 粉專排程（${n} 筆等待中）` : 'FB 粉專排程';
  }

  let mounted = false, ui = null;
  async function detect() {
    if (mounted) return true;
    const r = await call('ping', {}, PING_MS);
    if (!r.ok) {
      note.hidden = false;
      note.textContent = '';
      note.append(
        '要先安裝「圖片套版產生器」Chrome 外掛才能排程（上方「安裝插件」）。已經安裝的話，請更新到最新版，並重新整理本頁。 ',
        h('button', { type: 'button', class: 'sched-retry', text: '重新偵測', onclick: () => detect() }));
      return false;
    }
    note.hidden = true;
    mounted = true;
    ui = UI.mount(body, { api, compose, confirm: window.askConfirm });
    return true;
  }

  function setOpen(open) {
    drawer.classList.toggle('open', open);
    tab.setAttribute('aria-expanded', String(open));
    if (open) { detect().then(() => { if (ui) ui.refresh(); }); close.focus({ preventScroll: true }); }
  }
  tab.addEventListener('click', () => setOpen(!drawer.classList.contains('open')));
  close.addEventListener('click', () => { setOpen(false); tab.focus(); });
  document.addEventListener('keydown', e => {
    if (e.key !== 'Escape' || !drawer.classList.contains('open')) return;
    const modal = document.querySelector('.modal-overlay.open');   // 確認視窗開著時，Esc 先關那個
    if (!modal) { setOpen(false); tab.focus(); }
  });

  detect();   // 先偵測一次：有外掛就先把清單抓下來，頁籤上才有「等待中」數量
  if (typeof document !== 'undefined') setTimeout(() => { if (!mounted) detect(); }, 1500);   // 內容腳本可能比頁面晚一點才就緒
})();

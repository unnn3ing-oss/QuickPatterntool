// 從 GitHub 抓最新版本來更新這個擴充功能。
//
// Chrome 的「載入未封裝項目」沒有自動更新機制，所以做法是：
//   1. 向 GitHub 取得 main 分支最新的檔案清單（每個檔案的 git blob SHA）
//   2. 把每個檔案和擴充功能「自己現在的檔案」比對，找出有差異的
//   3. 使用者在側邊欄按「更新」，並（只需一次）選定擴充功能所在的資料夾後，
//      把有差異的檔案下載、驗證、寫回該資料夾，再呼叫 chrome.runtime.reload() 重新載入
//
// 背景腳本（background.js）會定時只做第 1、2 步，有新版就在圖示上顯示「新」。
(function (root) {
  const REPO = { owner: 'unnn3ing-oss', repo: 'QuickPatterntool', branch: 'main' };
  // 擴充功能用不到的檔案（說明文件、網頁版專用的頁面與圖示），不需要同步
  const SKIP = [/^README\.md$/i, /^examples\//, /^\.gitignore$/, /^\.github\//,
    /^index\.html$/, /^favicon/, /^apple-touch-icon/, /^deploy\.(js|css)$/];
  const TEXT_EXT = /\.(js|html|css|json|md|svg|txt)$/i;
  const API = `https://api.github.com/repos/${REPO.owner}/${REPO.repo}`;
  const RAW = `https://raw.githubusercontent.com/${REPO.owner}/${REPO.repo}`;

  // 檔案路徑必須是「資料夾裡的相對路徑」：不能是空的、絕對路徑，也不能含 .、..、反斜線、冒號。
  // （瀏覽器的檔案 API 本來就會擋 ..，這裡再擋一次，不單靠它。）
  function isSafePath(p) {
    return typeof p === 'string' && !!p && !p.startsWith('/')
      && p.split('/').every(seg => seg && seg !== '.' && seg !== '..' && !/[\\:\0]/.test(seg));
  }

  async function request(url, headers = {}) {
    let res;
    try { res = await fetch(url, { headers: { Accept: 'application/vnd.github+json', ...headers }, cache: 'no-store' }); }
    catch (e) { throw new Error('連不上 GitHub，請確認網路連線'); }
    if (res.status === 403 || res.status === 429) throw new Error('GitHub 暫時限制查詢次數，請稍後再試');
    if (!res.ok && res.status !== 304) throw new Error(`連不上 GitHub（HTTP ${res.status}）`);
    return res;
  }
  const getJson = async url => (await request(url)).json();

  // 上一次查到的 commit、檔案清單和 ETag 存在 chrome.storage.local：
  // 下次先帶 ETag 問「有變嗎」，沒變（HTTP 304）就不用再抓檔案清單，每小時的檢查只花 1 次 API，
  // 而且 304 不計入 GitHub 的次數限制（未登入每個 IP 每小時 60 次，辦公室共用 IP 很容易用完）。
  const CACHE_KEY = 'qpt-update-cache';
  async function cacheGet() {
    try { return (await chrome.storage.local.get(CACHE_KEY))[CACHE_KEY] || null; } catch (e) { return null; }
  }
  async function cacheSet(v) {
    try { await chrome.storage.local.set({ [CACHE_KEY]: v }); } catch (e) { /* 存不了就下次再查 */ }
  }

  // git 的 blob SHA-1：sha1("blob <位元組數>\0" + 內容)，和 GitHub 檔案清單裡的 sha 同一種算法
  async function gitBlobSha(bytes) {
    const header = new TextEncoder().encode(`blob ${bytes.length}\0`);
    const all = new Uint8Array(header.length + bytes.length);
    all.set(header, 0);
    all.set(bytes, header.length);
    const digest = await crypto.subtle.digest('SHA-1', all);
    return Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, '0')).join('');
  }

  async function localSha(path) {
    let res;
    try { res = await fetch(chrome.runtime.getURL(path), { cache: 'no-store' }); } catch (e) { return null; }
    if (!res.ok) return null;
    const bytes = new Uint8Array(await res.arrayBuffer());
    const sha = await gitBlobSha(bytes);
    return { sha, bytes };
  }

  // 回傳 'same'｜'new'（本機沒有這個檔）｜'modified'
  // Windows 用 git clone 取得的文字檔可能被轉成 CRLF，換行不同不算有新版
  async function compareFile(path, remoteSha) {
    const local = await localSha(path);
    if (!local) return 'new';
    if (local.sha === remoteSha) return 'same';
    if (TEXT_EXT.test(path)) {
      const text = new TextDecoder().decode(local.bytes).replace(/\r\n/g, '\n');
      if ((await gitBlobSha(new TextEncoder().encode(text))) === remoteSha) return 'same';
    }
    return 'modified';
  }

  // 讀最新版 manifest.json 裡的 version（例如 "1.24"），給畫面顯示「目前 v1.23 → 最新 v1.24」。
  // 只是顯示用：抓不到或格式怪怪的就回傳 null，不影響檢查更新。內容有用 git blob SHA 驗證。
  async function fetchRemoteVersion(commitSha, files) {
    const f = files.find(x => x.path === 'manifest.json');
    if (!f) return null;
    try {
      const res = await fetch(`${RAW}/${commitSha}/manifest.json`, { cache: 'no-store' });
      if (!res.ok) return null;
      const bytes = new Uint8Array(await res.arrayBuffer());
      if ((await gitBlobSha(bytes)) !== f.sha) return null;
      const v = JSON.parse(new TextDecoder().decode(bytes)).version;
      return typeof v === 'string' && /^\d+(\.\d+){0,3}$/.test(v) ? v : null;
    } catch (e) { return null; }
  }

  // 取得 main 最新的 commit 和（要同步的）檔案清單；盡量用快取
  async function getRemote() {
    const cache = await cacheGet();
    const res = await request(`${API}/commits/${REPO.branch}`, cache && cache.etag ? { 'If-None-Match': cache.etag } : {});
    if (res.status === 304 && cache) {
      if (cache.version !== undefined) return cache;
      const upgraded = { ...cache, version: await fetchRemoteVersion(cache.sha, cache.files) };   // 舊版快取沒有版本號
      await cacheSet(upgraded);
      return upgraded;
    }
    const commit = await res.json();
    const info = { sha: commit.sha, date: commit.commit.committer.date, message: commit.commit.message.split('\n')[0] };
    let files = cache && cache.sha === commit.sha ? cache.files : null;
    if (!files) {
      const tree = await getJson(`${API}/git/trees/${commit.commit.tree.sha}?recursive=1`);
      if (tree.truncated) throw new Error('檔案太多，GitHub 沒有回傳完整清單');
      const blobs = tree.tree.filter(t => t.type === 'blob' && !SKIP.some(re => re.test(t.path)));
      if (blobs.some(t => !isSafePath(t.path))) throw new Error('GitHub 上的檔案清單含有不安全的路徑，已停止');
      files = blobs.map(t => ({ path: t.path, sha: t.sha, size: t.size }));
    }
    const sameCommit = cache && cache.sha === commit.sha && cache.version !== undefined;
    const version = sameCommit ? cache.version : await fetchRemoteVersion(commit.sha, files);
    const out = { ...info, files, version, etag: res.headers.get('etag') || null };
    await cacheSet(out);
    return out;
  }

  // 回傳 { sha, date, message, version（GitHub 上最新版的版本號）, localVersion, changed: [{path, sha, size, status}], hasUpdate }
  async function checkLatest() {
    const remote = await getRemote();
    const changed = [];
    for (const f of remote.files) {
      const status = await compareFile(f.path, f.sha);
      if (status !== 'same') changed.push({ ...f, status });
    }
    return { sha: remote.sha, date: remote.date, message: remote.message, version: remote.version || null,
      localVersion: chrome.runtime.getManifest().version, changed, hasUpdate: changed.length > 0 };
  }

  // 新版 manifest 比現在的多了哪些「讓擴充功能能做更多事」的設定？回傳中文說明的陣列（空陣列＝沒有增加）
  // 未封裝的擴充功能重新載入時，Chrome 不一定會再問一次權限，所以更新前由這裡先攔下來讓使用者確認。
  function diffManifest(oldM, newM) {
    const out = [];
    const set = (m, k) => new Set([].concat((m && m[k]) || []));
    const labels = { permissions: '權限', optional_permissions: '選用權限', host_permissions: '可存取的網站', optional_host_permissions: '選用的網站存取' };
    const hadAllUrls = ['<all_urls>', '*://*/*'].some(p => set(oldM, 'host_permissions').has(p));
    for (const k of Object.keys(labels)) {
      const old = set(oldM, k);
      const added = [...set(newM, k)].filter(x => !old.has(x));
      if (k === 'host_permissions' && hadAllUrls) continue;   // 原本就能存取所有網站，新增的網站只是重複
      if (added.length) out.push(`新增${labels[k]}：${added.join('、')}`);
    }
    const sensitive = { content_scripts: '會在網頁裡執行的程式（content_scripts）', externally_connectable: '開放給網頁連線的設定（externally_connectable）',
      content_security_policy: '內容安全政策（CSP）', update_url: '更新網址（update_url）' };
    for (const [k, label] of Object.entries(sensitive)) {
      if (JSON.stringify((newM || {})[k] ?? null) !== JSON.stringify((oldM || {})[k] ?? null)) out.push(`${label}有變動`);
    }
    return out;
  }

  // ---- 記住使用者選的資料夾（FileSystemDirectoryHandle 可以存進 IndexedDB）----
  function idb() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open('qpt-updater', 1);
      req.onupgradeneeded = () => req.result.createObjectStore('kv');
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  async function kv(mode, fn) {
    const db = await idb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction('kv', mode);
      const req = fn(tx.objectStore('kv'));
      tx.oncomplete = () => resolve(req && req.result);
      tx.onerror = () => reject(tx.error);
    });
  }

  // 選到的資料夾必須真的是這個擴充功能（有 manifest.json 且名稱相同），避免寫進別的資料夾
  async function verifyFolder(dir) {
    let manifest;
    try {
      const file = await (await dir.getFileHandle('manifest.json')).getFile();
      manifest = JSON.parse(await file.text());
    } catch (e) {
      throw new Error('這個資料夾裡找不到 manifest.json，請選擇擴充功能的資料夾');
    }
    if (manifest.name !== chrome.runtime.getManifest().name) {
      throw new Error('這個資料夾不是「圖片套版產生器」擴充功能的資料夾');
    }
  }

  // 要在按鈕點擊中呼叫（選資料夾需要使用者操作）
  async function pickFolder() {
    const dir = await root.showDirectoryPicker({ id: 'qpt-extension', mode: 'readwrite' });
    await verifyFolder(dir);
    await kv('readwrite', s => s.put(dir, 'folder'));
    return dir;
  }

  // 之前有沒有選過資料夾（只看有沒有記錄，不會跳權限詢問）
  async function hasSavedFolder() {
    try { return !!(await kv('readonly', s => s.get('folder'))); } catch (e) { return false; }
  }

  // 取回之前選過的資料夾；權限過期時（需使用者操作）重新要求
  async function getFolder() {
    let dir;
    try { dir = await kv('readonly', s => s.get('folder')); } catch (e) { return null; }
    if (!dir) return null;
    const opts = { mode: 'readwrite' };
    if ((await dir.queryPermission(opts)) !== 'granted') {
      if ((await dir.requestPermission(opts)) !== 'granted') return null;
    }
    try { await verifyFolder(dir); } catch (e) { return null; }
    return dir;
  }

  async function writeFile(dir, path, bytes) {
    const parts = path.split('/');
    let cur = dir;
    for (const p of parts.slice(0, -1)) cur = await cur.getDirectoryHandle(p, { create: true });
    const handle = await cur.getFileHandle(parts[parts.length - 1], { create: true });
    const w = await handle.createWritable();
    await w.write(bytes);
    await w.close();
  }

  // 先把所有有差異的檔案下載並驗證完，全部沒問題才開始寫入，避免寫到一半停住造成版本不一致。
  // 新版 manifest.json 如果增加了權限或敏感設定，會先呼叫 confirmFn(說明陣列)，回傳 false 就整個取消；
  // manifest.json 最後才寫入，這樣即使中途失敗，也不會是「新設定配舊程式」。
  async function apply(dir, info, onProgress = () => {}, confirmFn = null) {
    const downloads = [];
    for (let i = 0; i < info.changed.length; i++) {
      const f = info.changed[i];
      if (!isSafePath(f.path)) throw new Error(`檔案路徑不安全（${f.path}），已取消更新`);
      onProgress(`下載 ${i + 1}/${info.changed.length}：${f.path}`);
      const res = await fetch(`${RAW}/${info.sha}/${f.path.split('/').map(encodeURIComponent).join('/')}`, { cache: 'no-store' });
      if (!res.ok) throw new Error(`下載 ${f.path} 失敗（HTTP ${res.status}）`);
      const bytes = new Uint8Array(await res.arrayBuffer());
      if ((await gitBlobSha(bytes)) !== f.sha) throw new Error(`${f.path} 下載內容和 GitHub 上的不一致，已取消更新`);
      downloads.push({ path: f.path, bytes });
    }
    const manifest = downloads.find(d => d.path === 'manifest.json');
    if (manifest) {
      let newM;
      try { newM = JSON.parse(new TextDecoder().decode(manifest.bytes)); } catch (e) { throw new Error('新版的 manifest.json 格式不正確，已取消更新'); }
      const risks = diffManifest(chrome.runtime.getManifest(), newM);
      if (risks.length && !(confirmFn && await confirmFn(risks))) {
        const err = new Error('已取消更新');
        err.name = 'AbortError';
        throw err;
      }
    }
    downloads.sort((a, b) => (a.path === 'manifest.json') - (b.path === 'manifest.json'));
    for (let i = 0; i < downloads.length; i++) {
      onProgress(`寫入 ${i + 1}/${downloads.length}：${downloads[i].path}`);
      await writeFile(dir, downloads[i].path, downloads[i].bytes);
    }
  }

  root.Updater = { REPO, checkLatest, pickFolder, getFolder, hasSavedFolder, apply, gitBlobSha, diffManifest, isSafePath };
})(self);

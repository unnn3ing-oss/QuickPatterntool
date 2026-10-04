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
    /^index\.html$/, /^favicon/, /^apple-touch-icon/];
  const TEXT_EXT = /\.(js|html|css|json|md|svg|txt)$/i;
  const API = `https://api.github.com/repos/${REPO.owner}/${REPO.repo}`;
  const RAW = `https://raw.githubusercontent.com/${REPO.owner}/${REPO.repo}`;

  async function getJson(url) {
    let res;
    try { res = await fetch(url, { headers: { Accept: 'application/vnd.github+json' }, cache: 'no-store' }); }
    catch (e) { throw new Error('連不上 GitHub，請確認網路連線'); }
    if (res.status === 403 || res.status === 429) throw new Error('GitHub 暫時限制查詢次數，請稍後再試');
    if (!res.ok) throw new Error(`連不上 GitHub（HTTP ${res.status}）`);
    return res.json();
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

  // Windows 用 git clone 取得的文字檔可能被轉成 CRLF，換行不同不算有新版
  async function sameContent(path, remoteSha) {
    const local = await localSha(path);
    if (!local) return false;
    if (local.sha === remoteSha) return true;
    if (TEXT_EXT.test(path)) {
      const text = new TextDecoder().decode(local.bytes).replace(/\r\n/g, '\n');
      return (await gitBlobSha(new TextEncoder().encode(text))) === remoteSha;
    }
    return false;
  }

  // 回傳 { sha, date, message, changed: [{path, sha, size}], hasUpdate }
  async function checkLatest() {
    const commit = await getJson(`${API}/commits/${REPO.branch}`);
    const tree = await getJson(`${API}/git/trees/${commit.commit.tree.sha}?recursive=1`);
    if (tree.truncated) throw new Error('檔案太多，GitHub 沒有回傳完整清單');
    const files = tree.tree.filter(t => t.type === 'blob' && !SKIP.some(re => re.test(t.path)));
    const changed = [];
    for (const f of files) {
      if (!(await sameContent(f.path, f.sha))) changed.push({ path: f.path, sha: f.sha, size: f.size });
    }
    return {
      sha: commit.sha,
      date: commit.commit.committer.date,
      message: commit.commit.message.split('\n')[0],
      changed,
      hasUpdate: changed.length > 0,
    };
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

  // 先把所有有差異的檔案下載並驗證完，全部沒問題才開始寫入，避免寫到一半停住造成版本不一致
  async function apply(dir, info, onProgress = () => {}) {
    const downloads = [];
    for (let i = 0; i < info.changed.length; i++) {
      const f = info.changed[i];
      onProgress(`下載 ${i + 1}/${info.changed.length}：${f.path}`);
      const res = await fetch(`${RAW}/${info.sha}/${f.path.split('/').map(encodeURIComponent).join('/')}`, { cache: 'no-store' });
      if (!res.ok) throw new Error(`下載 ${f.path} 失敗（HTTP ${res.status}）`);
      const bytes = new Uint8Array(await res.arrayBuffer());
      if ((await gitBlobSha(bytes)) !== f.sha) throw new Error(`${f.path} 下載內容和 GitHub 上的不一致，已取消更新`);
      downloads.push({ path: f.path, bytes });
    }
    for (let i = 0; i < downloads.length; i++) {
      onProgress(`寫入 ${i + 1}/${downloads.length}：${downloads[i].path}`);
      await writeFile(dir, downloads[i].path, downloads[i].bytes);
    }
  }

  root.Updater = { REPO, checkLatest, pickFolder, getFolder, apply, gitBlobSha };
})(self);

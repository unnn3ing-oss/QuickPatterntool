// 網頁版專用：把 Chrome 擴充功能的最新版檔案「準備」到你的電腦上。
//
// 網頁沒辦法直接替瀏覽器安裝擴充功能，所以這裡只負責第 1 步：
//   A. 寫入資料夾：讓使用者選一個空資料夾，把檔案直接寫進去（File System Access API）
//   B. 下載 ZIP：不能選資料夾的瀏覽器／資料夾時的備案
// 第 2 步（到 chrome://extensions 載入未封裝項目）要使用者自己做，彈窗裡有說明。
//
// 檔案清單取自 GitHub main 分支最新內容，並排除擴充功能用不到的檔案
// （和 updater.js 的 SKIP 保持一致，新增網頁版專用檔案時兩邊都要加）。
(function () {
  const REPO = { owner: 'unnn3ing-oss', repo: 'QuickPatterntool', branch: 'main' };
  const EXT_NAME = '圖片套版產生器';
  const SKIP = [/^README\.md$/i, /^examples\//, /^\.gitignore$/, /^\.github\//,
    /^index\.html$/, /^favicon/, /^apple-touch-icon/, /^deploy\.(js|css)$/];
  const API = `https://api.github.com/repos/${REPO.owner}/${REPO.repo}`;
  const RAW = `https://raw.githubusercontent.com/${REPO.owner}/${REPO.repo}`;

  // ---- 從 GitHub 取得檔案 -------------------------------------------------------
  async function getJson(url) {
    let res;
    try { res = await fetch(url, { headers: { Accept: 'application/vnd.github+json' }, cache: 'no-store' }); }
    catch (e) { throw new Error('連不上 GitHub，請確認網路連線'); }
    if (res.status === 403 || res.status === 429) throw new Error('GitHub 暫時限制查詢次數，請稍後再試');
    if (!res.ok) throw new Error(`連不上 GitHub（HTTP ${res.status}）`);
    return res.json();
  }

  async function gitBlobSha(bytes) {
    const header = new TextEncoder().encode(`blob ${bytes.length}\0`);
    const all = new Uint8Array(header.length + bytes.length);
    all.set(header, 0);
    all.set(bytes, header.length);
    const digest = await crypto.subtle.digest('SHA-1', all);
    return Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, '0')).join('');
  }

  // 回傳 [{ path, bytes }]；每個檔案都用 git blob SHA 驗證內容，任何一個不符就整批取消
  async function fetchExtensionFiles(onProgress) {
    onProgress('取得最新版檔案清單…');
    const commit = await getJson(`${API}/commits/${REPO.branch}`);
    const tree = await getJson(`${API}/git/trees/${commit.commit.tree.sha}?recursive=1`);
    if (tree.truncated) throw new Error('檔案太多，GitHub 沒有回傳完整清單');
    const list = tree.tree.filter(t => t.type === 'blob' && !SKIP.some(re => re.test(t.path)));
    if (!list.some(f => f.path === 'manifest.json')) throw new Error('GitHub 上找不到 manifest.json');
    const files = [];
    for (let i = 0; i < list.length; i++) {
      const f = list[i];
      onProgress(`下載 ${i + 1}/${list.length}：${f.path}`);
      let res;
      try { res = await fetch(`${RAW}/${commit.sha}/${f.path.split('/').map(encodeURIComponent).join('/')}`, { cache: 'no-store' }); }
      catch (e) { throw new Error('下載檔案失敗，請確認網路連線'); }
      if (!res.ok) throw new Error(`下載 ${f.path} 失敗（HTTP ${res.status}）`);
      const bytes = new Uint8Array(await res.arrayBuffer());
      if ((await gitBlobSha(bytes)) !== f.sha) throw new Error(`${f.path} 下載內容和 GitHub 上的不一致，已取消`);
      files.push({ path: f.path, bytes });
    }
    return files;
  }

  // ---- A. 寫入資料夾 -----------------------------------------------------------
  // 只允許寫進「空資料夾」或「已經是這個擴充功能的資料夾」，避免蓋掉使用者其他檔案
  async function assertSafeFolder(dir) {
    const names = [];
    for await (const [name] of dir.entries()) names.push(name);
    if (!names.length) return;
    let ours = false;
    try {
      const file = await (await dir.getFileHandle('manifest.json')).getFile();
      ours = JSON.parse(await file.text()).name === EXT_NAME;
    } catch (e) { /* 沒有 manifest.json 或不是 JSON，就不是我們的資料夾 */ }
    if (!ours) throw new Error(`「${dir.name}」裡已經有其他檔案。請選一個空的資料夾（選取視窗裡可以按「新增資料夾」）`);
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

  // 先檢查資料夾、再下載、全部驗證通過才開始寫入
  async function deployToFolder(dir, onProgress) {
    await assertSafeFolder(dir);
    const files = await fetchExtensionFiles(onProgress);
    for (let i = 0; i < files.length; i++) {
      onProgress(`寫入 ${i + 1}/${files.length}：${files[i].path}`);
      await writeFile(dir, files[i].path, files[i].bytes);
    }
    return files.length;
  }

  // ---- B. 打包 ZIP（不壓縮，只是把檔案裝在一起）-------------------------------------
  let crcTable = null;
  function crc32(bytes) {
    if (!crcTable) {
      crcTable = new Uint32Array(256);
      for (let n = 0; n < 256; n++) {
        let c = n;
        for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
        crcTable[n] = c >>> 0;
      }
    }
    let crc = 0xFFFFFFFF;
    for (let i = 0; i < bytes.length; i++) crc = crcTable[(crc ^ bytes[i]) & 0xFF] ^ (crc >>> 8);
    return (crc ^ 0xFFFFFFFF) >>> 0;
  }

  function buildZip(entries) {
    const enc = new TextEncoder();
    const now = new Date();
    const dosTime = (now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1);
    const dosDate = ((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate();
    const local = [], central = [];
    let offset = 0;
    for (const e of entries) {
      const name = enc.encode(e.name);
      const crc = crc32(e.bytes);
      const lh = new DataView(new ArrayBuffer(30));
      lh.setUint32(0, 0x04034b50, true); lh.setUint16(4, 20, true); lh.setUint16(6, 0x0800, true);   // 0x0800 = 檔名為 UTF-8
      lh.setUint16(8, 0, true); lh.setUint16(10, dosTime, true); lh.setUint16(12, dosDate, true);
      lh.setUint32(14, crc, true); lh.setUint32(18, e.bytes.length, true); lh.setUint32(22, e.bytes.length, true);
      lh.setUint16(26, name.length, true); lh.setUint16(28, 0, true);
      local.push(lh, name, e.bytes);
      const ch = new DataView(new ArrayBuffer(46));
      ch.setUint32(0, 0x02014b50, true); ch.setUint16(4, 20, true); ch.setUint16(6, 20, true); ch.setUint16(8, 0x0800, true);
      ch.setUint16(10, 0, true); ch.setUint16(12, dosTime, true); ch.setUint16(14, dosDate, true);
      ch.setUint32(16, crc, true); ch.setUint32(20, e.bytes.length, true); ch.setUint32(24, e.bytes.length, true);
      ch.setUint16(28, name.length, true); ch.setUint32(42, offset, true);
      central.push(ch, name);
      offset += 30 + name.length + e.bytes.length;
    }
    const centralSize = central.reduce((n, p) => n + (p.byteLength !== undefined ? p.byteLength : p.length), 0);
    const end = new DataView(new ArrayBuffer(22));
    end.setUint32(0, 0x06054b50, true);
    end.setUint16(8, entries.length, true); end.setUint16(10, entries.length, true);
    end.setUint32(12, centralSize, true); end.setUint32(16, offset, true);
    return new Blob([...local, ...central, end], { type: 'application/zip' });
  }

  async function buildZipOfExtension(onProgress) {
    const files = await fetchExtensionFiles(onProgress);
    onProgress('打包 ZIP…');
    return { blob: buildZip(files.map(f => ({ name: `QuickPatterntool-extension/${f.path}`, bytes: f.bytes }))), count: files.length };
  }

  window.Deploy = { fetchExtensionFiles, deployToFolder, buildZip, buildZipOfExtension, crc32, REPO };

  // ---- 彈窗 --------------------------------------------------------------------
  const overlay = document.getElementById('deployOverlay');
  if (!overlay) return;
  const openBtn = document.getElementById('deployBtn');
  const closeBtn = document.getElementById('deployCloseBtn');
  const pickBtn = document.getElementById('deployPickBtn');
  const zipBtn = document.getElementById('deployZipBtn');
  const copyUrlBtn = document.getElementById('deployCopyUrl');
  const statusEl = document.getElementById('deployStatus');
  let busy = false;

  const setStatus = (msg, kind) => { statusEl.textContent = msg; statusEl.className = 'deploy-status' + (kind ? ` ${kind}` : ''); };
  const setBusy = b => { busy = b; pickBtn.disabled = zipBtn.disabled = b; };
  const close = () => overlay.classList.remove('open');

  openBtn.addEventListener('click', () => overlay.classList.add('open'));
  closeBtn.addEventListener('click', close);
  overlay.addEventListener('click', e => { if (e.target === overlay) close(); });
  document.addEventListener('keydown', e => { if (e.key === 'Escape' && overlay.classList.contains('open')) close(); });

  // 不支援選資料夾的瀏覽器（Firefox、Safari）只留 ZIP
  if (typeof window.showDirectoryPicker !== 'function') {
    pickBtn.hidden = true;
    zipBtn.classList.add('primary');
  }

  pickBtn.addEventListener('click', async () => {
    if (busy) return;
    let dir;
    try { dir = await window.showDirectoryPicker({ id: 'qpt-extension', mode: 'readwrite' }); }
    catch (err) { if (err && err.name === 'AbortError') return; setStatus(`無法開啟這個資料夾：${err.message || err}`, 'err'); return; }
    setBusy(true);
    try {
      const n = await deployToFolder(dir, msg => setStatus(msg));
      setStatus(`已把 ${n} 個檔案寫入「${dir.name}」。接著請做第 2 步，載入時選這個資料夾。`, 'ok');
    } catch (err) {
      setStatus(err.message || String(err), 'err');
    } finally { setBusy(false); }
  });

  zipBtn.addEventListener('click', async () => {
    if (busy) return;
    setBusy(true);
    try {
      const { blob, count } = await buildZipOfExtension(msg => setStatus(msg));
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = 'QuickPatterntool-extension.zip';
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 10000);
      setStatus(`已下載 ZIP（${count} 個檔案）。請先解壓縮，第 2 步載入時選解壓縮後的「QuickPatterntool-extension」資料夾。`, 'ok');
    } catch (err) {
      setStatus(err.message || String(err), 'err');
    } finally { setBusy(false); }
  });

  copyUrlBtn.addEventListener('click', async () => {
    const label = copyUrlBtn.textContent;
    let ok = false;
    try { await navigator.clipboard.writeText('chrome://extensions'); ok = true; } catch (e) { /* 剪貼簿被拒絕 */ }
    copyUrlBtn.textContent = ok ? '已複製 ✓' : '複製失敗，請手動輸入';
    setTimeout(() => { copyUrlBtn.textContent = label; }, 1600);
  });
})();

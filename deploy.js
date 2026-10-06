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
  const EXT_FOLDER = 'QuickPatterntool';   // 建議的資料夾名稱（ZIP 裡的最上層資料夾也用這個名稱）
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

  // 和 updater.js 的 isSafePath 相同：相對路徑，不含 .、..、反斜線、冒號
  function isSafePath(p) {
    return typeof p === 'string' && !!p && !p.startsWith('/')
      && p.split('/').every(seg => seg && seg !== '.' && seg !== '..' && !/[\\:\0]/.test(seg));
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
    if (list.some(f => !isSafePath(f.path))) throw new Error('GitHub 上的檔案清單含有不安全的路徑，已停止');
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
  // 瀏覽器的「選資料夾」視窗沒有辦法預先填好資料夾名稱，所以改成：
  //   - 選到空資料夾，或本來就是這個擴充功能的資料夾 → 直接寫在裡面
  //   - 選到有其他東西的資料夾 → 在裡面建立（或沿用）名為 EXT_FOLDER 的子資料夾，只新增、不動其他檔案
  async function isOurs(dir) {
    try {
      const file = await (await dir.getFileHandle('manifest.json')).getFile();
      return JSON.parse(await file.text()).name === EXT_NAME;
    } catch (e) { return false; }   // 沒有 manifest.json 或不是 JSON，就不是我們的資料夾
  }
  async function isEmpty(dir) {
    for await (const _ of dir.entries()) return false;
    return true;
  }
  // 回傳 { dir, label }：實際要寫入的資料夾，以及給使用者看的路徑
  async function resolveTarget(picked) {
    if ((await isEmpty(picked)) || (await isOurs(picked))) return { dir: picked, label: picked.name };
    let sub = null;
    try { sub = await picked.getDirectoryHandle(EXT_FOLDER); } catch (e) { /* 還沒有同名資料夾 */ }
    if (sub) {
      if (!(await isEmpty(sub)) && !(await isOurs(sub))) {
        throw new Error(`「${picked.name}」裡已經有一個「${EXT_FOLDER}」資料夾，但裡面不是空的，也不是這個插件。請換一個資料夾，或把它改名。`);
      }
    } else {
      sub = await picked.getDirectoryHandle(EXT_FOLDER, { create: true });
    }
    return { dir: sub, label: `${picked.name}/${EXT_FOLDER}` };
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

  // 先決定目標資料夾、再下載、全部驗證通過才開始寫入。回傳 { count, label }
  async function deployToFolder(picked, onProgress) {
    const target = await resolveTarget(picked);
    const files = await fetchExtensionFiles(onProgress);
    for (let i = 0; i < files.length; i++) {
      onProgress(`寫入 ${i + 1}/${files.length}：${files[i].path}`);
      await writeFile(target.dir, files[i].path, files[i].bytes);
    }
    return { count: files.length, label: target.label };
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
    return { blob: buildZip(files.map(f => ({ name: `${EXT_FOLDER}/${f.path}`, bytes: f.bytes }))), count: files.length };
  }

  window.Deploy = { fetchExtensionFiles, deployToFolder, buildZip, buildZipOfExtension, crc32, REPO, EXT_FOLDER };

  // ---- 彈窗（步驟精靈）------------------------------------------------------------
  const overlay = document.getElementById('deployOverlay');
  if (!overlay) return;
  const openBtn = document.getElementById('deployBtn');
  const closeBtn = document.getElementById('deployCloseBtn');
  const pickBtn = document.getElementById('deployPickBtn');
  const zipBtn = document.getElementById('deployZipBtn');
  const copyUrlBtn = document.getElementById('deployCopyUrl');
  const copyNameBtn = document.getElementById('deployCopyName');
  const statusEl = document.getElementById('deployStatus');
  const prevBtn = document.getElementById('deployPrevBtn');
  const nextBtn = document.getElementById('deployNextBtn');
  const panels = [...overlay.querySelectorAll('.deploy-panel')];
  const dots = [...overlay.querySelectorAll('#deploySteps li')];
  const loadFolderEl = document.getElementById('deployLoadFolder');
  const TOTAL = panels.length;
  let step = 1;
  let busy = false;

  document.getElementById('deployFolderName').textContent = EXT_FOLDER;
  overlay.querySelectorAll('.deploy-folder-name').forEach(el => { el.textContent = EXT_FOLDER; });
  loadFolderEl.textContent = EXT_FOLDER;

  const setStatus = (msg, kind) => { statusEl.textContent = msg; statusEl.className = 'deploy-status' + (kind ? ` ${kind}` : ''); };
  const refreshNav = () => {
    prevBtn.disabled = busy || step === 1;
    nextBtn.disabled = busy;
    nextBtn.textContent = step === TOTAL ? '完成' : '下一步';
  };
  const setBusy = b => { busy = b; pickBtn.disabled = zipBtn.disabled = b; refreshNav(); };

  function goTo(n, focus = true) {
    step = Math.min(TOTAL, Math.max(1, n));
    panels.forEach((p, i) => { p.hidden = i !== step - 1; });
    dots.forEach((d, i) => {
      d.classList.toggle('done', i < step - 1);
      d.classList.toggle('current', i === step - 1);
      if (i === step - 1) d.setAttribute('aria-current', 'step'); else d.removeAttribute('aria-current');
    });
    refreshNav();
    if (focus) panels[step - 1].querySelector('h3').focus({ preventScroll: true });
    overlay.querySelector('.deploy-body').scrollTop = 0;
  }

  const close = () => overlay.classList.remove('open');
  const open = () => { setStatus(''); loadFolderEl.textContent = EXT_FOLDER; goTo(1, false); overlay.classList.add('open'); };

  openBtn.addEventListener('click', open);
  closeBtn.addEventListener('click', close);
  overlay.addEventListener('click', e => { if (e.target === overlay) close(); });
  document.addEventListener('keydown', e => { if (e.key === 'Escape' && overlay.classList.contains('open')) close(); });
  prevBtn.addEventListener('click', () => { if (!busy) goTo(step - 1); });
  nextBtn.addEventListener('click', () => { if (busy) return; if (step === TOTAL) close(); else goTo(step + 1); });

  // 不支援選資料夾的瀏覽器（Firefox、Safari）只留 ZIP
  if (typeof window.showDirectoryPicker !== 'function') {
    pickBtn.hidden = true;
    zipBtn.classList.add('primary');
    zipBtn.textContent = '下載 ZIP';
  }

  pickBtn.addEventListener('click', async () => {
    if (busy) return;
    let dir;
    try { dir = await window.showDirectoryPicker({ id: 'qpt-extension', mode: 'readwrite' }); }
    catch (err) { if (err && err.name === 'AbortError') return; setStatus(`無法開啟這個資料夾：${err.message || err}`, 'err'); return; }
    setBusy(true);
    try {
      const { count, label } = await deployToFolder(dir, msg => setStatus(msg));
      loadFolderEl.textContent = label;
      setStatus(`已把 ${count} 個檔案寫入「${label}」。請按「下一步」繼續。`, 'ok');
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
      a.download = `${EXT_FOLDER}.zip`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 10000);
      loadFolderEl.textContent = EXT_FOLDER;
      setStatus(`已下載 ZIP（${count} 個檔案）。請先解壓縮，解壓縮後的資料夾就是「${EXT_FOLDER}」，再按「下一步」。`, 'ok');
    } catch (err) {
      setStatus(err.message || String(err), 'err');
    } finally { setBusy(false); }
  });

  // 複製按鈕共用：按下後短暫顯示結果
  function bindCopy(btn, text) {
    btn.addEventListener('click', async () => {
      const label = btn.dataset.label || (btn.dataset.label = btn.textContent);
      let ok = false;
      try { await navigator.clipboard.writeText(typeof text === 'function' ? text() : text); ok = true; } catch (e) { /* 剪貼簿被拒絕 */ }
      btn.textContent = ok ? '已複製 ✓' : '複製失敗，請手動輸入';
      setTimeout(() => { btn.textContent = label; }, 1600);
    });
  }
  bindCopy(copyUrlBtn, 'chrome://extensions');
  bindCopy(copyNameBtn, EXT_FOLDER);
})();

// 網頁版專用：上排「圖片套版／浮水印」功能切換，以及「浮水印」功能本身。
//
// 浮水印：一次放一張或多張照片，把 Logo（內建的 TVBS NEWS Logo，或自己上傳的圖）疊在上面，
// 位置只能在周圍 8 個點（沒有正中央），可調大小、透明度、邊距，下載時維持原圖尺寸。設定套用到所有照片。
// 預覽用縮小的畫布，下載時用原圖大小重畫一次；位置、大小都用「佔整張圖的比例」記錄，所以兩邊的結果一致。
//
// 需要在 app.js 之後載入（會用到它的 isImageFile、askConfirm）。
(function () {
  const $ = id => document.getElementById(id);
  const layoutApp = $('layoutApp');
  const wmApp = $('watermarkApp');
  if (!layoutApp || !wmApp) return;

  // ---- 功能切換 ------------------------------------------------------------------
  const funcBtns = { layout: $('funcLayoutBtn'), watermark: $('funcWatermarkBtn') };
  function setFunc(name) {
    layoutApp.hidden = name !== 'layout';
    wmApp.hidden = name !== 'watermark';
    for (const [key, btn] of Object.entries(funcBtns)) {
      btn.classList.toggle('active', key === name);
      btn.setAttribute('aria-pressed', String(key === name));
    }
    if (name === 'watermark') schedule();
  }
  funcBtns.layout.addEventListener('click', () => setFunc('layout'));
  funcBtns.watermark.addEventListener('click', () => setFunc('watermark'));
  const watermarkActive = () => !wmApp.hidden;

  // ---- 內建 Logo：TVBS NEWS（向量，放多大都清楚；背景透明）-------------------------------
  const BUILTIN_LOGO_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 132 25" width="528" height="100" fill="none"><g clip-path="url(#clip0_7130_350)"><path d="M78.3538 4.48739H68.4378C68.2348 4.48739 67.8308 4.53813 67.6316 4.5682C64.5875 5.01354 61.9605 7.57477 61.6222 10.5438C61.564 11.0492 61.5771 11.5341 61.6523 11.9944C61.9342 14.2193 63.6611 15.8184 66.0043 15.9406C66.2261 15.9631 66.4534 15.9725 66.6846 15.9706H70.377C70.377 15.9744 70.3826 15.9782 70.3845 15.9763C70.5123 15.9706 70.6363 15.9725 70.7547 15.9857C71.698 16.0345 72.3933 16.6772 72.506 17.5716C72.5361 17.7558 72.5417 17.9512 72.5192 18.1542C72.3745 19.4244 71.0272 20.5124 69.7024 20.5801C69.6103 20.5857 69.5164 20.5951 69.4168 20.6008H59.822L59.0535 23.0624C59.0535 23.0624 59.0479 23.0718 59.046 23.0774L58.8938 23.5735L58.8242 23.7971L58.7942 23.8967C58.7791 23.9475 58.8073 23.9869 58.8562 23.9869H69.8095C70.0106 23.9869 70.4165 23.9343 70.6157 23.9042C73.6579 23.4608 76.2849 20.8977 76.6232 17.9306C76.6795 17.4251 76.6664 16.9403 76.5931 16.4799C76.3112 14.2569 74.5825 12.6559 72.2392 12.5337C71.9912 12.5074 71.7356 12.4999 71.4744 12.5056V12.5018H67.8684C67.8684 12.5018 67.8646 12.4943 67.8609 12.4943C67.7331 12.5018 67.6091 12.498 67.4888 12.4868C66.5474 12.436 65.8521 11.7953 65.7394 10.8989C65.7093 10.7148 65.7037 10.5193 65.7281 10.3164C65.8728 9.04424 67.0341 8.04455 68.357 7.9769C68.4509 7.97126 68.5449 7.96187 68.6426 7.95623H77.3541L78.3501 4.76738L78.367 4.71101L78.4008 4.60578L78.4121 4.57007C78.4271 4.52122 78.3989 4.48176 78.3501 4.48176" fill="#EDF1F5"/><path d="M15.5197 7.89239H15.1495C15.0988 7.89239 15.0255 7.88299 14.9898 7.84353C14.9541 7.80407 14.9485 7.74958 14.9748 7.6932V7.68569L16.121 5.61679C16.2206 5.42324 16.3522 5.23908 16.5138 5.07748C16.9591 4.63401 17.521 4.37845 18.1016 4.31268V4.30705C18.8119 4.22812 19.5485 4.19242 20.2814 4.20182L31.4922 4.19994L32.6704 0.364672L32.753 0.0903218C32.7681 0.0414649 32.7399 0.000124454 32.691 0.000124454H10.8858L10.8764 0.0076409C9.35999 -0.0130293 7.83791 0.0583769 6.37033 0.223739V0.235013C5.1677 0.36843 4.00453 0.89646 3.08376 1.81535C2.7474 2.15171 2.47681 2.52941 2.27199 2.93154L0.0847039 7.04491L0.069671 7.07498C-0.0449547 7.34557 -0.0224054 7.61052 0.146715 7.7928C0.319593 7.97883 0.667228 8.02017 0.905875 8.02017H10.448L6.52442 20.8094L6.51502 20.8545C6.31959 21.7865 6.5526 22.4874 7.17647 23.1113C7.77215 23.7089 8.54822 24.0001 9.32993 23.9982H16.6397L21.578 7.89427H15.516L15.5197 7.89239Z" fill="#EDF1F5"/><path d="M57.0471 14.3153C56.8629 14.1743 56.6637 14.0503 56.4533 13.9394C56.3424 13.8793 56.2278 13.8248 56.1113 13.7741C57.5093 12.8796 58.6142 11.6582 58.9281 10.0591C59.0258 9.5611 59.0709 8.92972 58.9957 8.46934C58.7138 6.24447 56.5923 4.64535 54.2491 4.52321C53.9991 4.4969 53.4824 4.49126 53.4824 4.49126L43.6903 4.48563C42.4238 4.48563 42.2773 4.43113 41.5745 5.18841C41.4204 5.35565 41.3076 5.49659 41.3076 5.49659L26.814 20.8527C26.8028 20.8621 26.6994 20.9466 26.628 20.9466C26.5115 20.9466 26.4176 20.8564 26.4138 20.7437L30.3374 7.89245H26.1526L21.5093 23.0757C21.5093 23.0757 21.5056 23.0794 21.5056 23.0832L21.2519 23.9081C21.2368 23.9588 21.265 23.9983 21.3158 23.9983H29.4429L43.7129 7.95071H52.7758C52.7758 7.95071 53.193 7.95446 53.3133 7.96762C54.2547 8.01647 54.95 8.65913 55.0646 9.55359C55.0947 9.73962 55.1003 9.93317 55.0759 10.138C54.9312 11.4101 53.1892 12.4963 51.8664 12.5639C51.7724 12.5696 51.6784 12.5771 51.5807 12.5846H49.1398L48.0837 15.9726H52.2065C52.2065 15.9726 52.2121 15.9801 52.2159 15.9783C52.3437 15.9726 52.4677 15.9764 52.5879 15.9877C53.5294 16.0365 54.1457 16.6792 54.2585 17.5736C54.2885 17.7578 54.2923 17.9532 54.2716 18.158C54.1269 19.4283 52.7796 20.5163 51.4548 20.584C51.3628 20.5896 51.2688 20.599 51.1692 20.6046H45.2199L48.5197 9.86176H43.9778L39.6935 23.8179L39.6672 23.9025C39.6521 23.9513 39.6803 23.9927 39.7292 23.9927H51.6409C51.6784 23.9927 52.4602 23.987 52.6086 23.9814C55.9591 23.8236 58.7909 21.2961 58.9337 18.3384C58.9562 17.8668 58.9074 17.412 58.7984 16.9817C58.5635 15.8937 57.9378 14.9654 57.0489 14.3115" fill="#EDF1F5"/><path d="M131.046 13.1424C131.046 11.0848 129.36 9.4086 127.29 9.4086H124.689C123.954 9.4086 123.359 8.8148 123.359 8.0857C123.359 7.35661 123.956 6.76281 124.689 6.76281H130.088L130.817 4.50224H124.689C122.701 4.50224 121.083 6.10888 121.083 8.0857C121.083 10.0625 122.701 11.6692 124.689 11.6692H127.29C128.107 11.6692 128.77 12.3306 128.77 13.1424C128.77 13.9542 128.105 14.6156 127.29 14.6156H121.579L121.096 16.8762H127.29C129.36 16.8762 131.046 15.2019 131.046 13.1424Z" fill="#EDF1F5"/><path d="M105.661 6.73462V4.48721H96.7292V16.8611H105.661V14.6137H98.9898V11.8139H105.661V9.56832H98.9898V6.73462H105.661Z" fill="#EDF1F5"/><path d="M94.2674 16.8612V4.50224H91.8527V13.3848L88.382 4.50224H84.7253V16.8612H87.1399V7.97859L90.6107 16.8612H94.2674Z" fill="#EDF1F5"/><path d="M118.151 4.50637L116.598 11.7767L115.046 4.50637H112.583L111.031 11.7767L109.477 4.50637H107.278L109.92 16.8766H112.139L113.814 9.03879L115.488 16.8766H117.709L120.349 4.50637H118.151Z" fill="#EDF1F5"/><path d="M129.798 23.9943L84.6952 23.9831V20.0933L131.017 20.1046L129.798 23.9943Z" fill="#EDF1F5"/></g><defs><clipPath id="clip0_7130_350"><rect width="131.045" height="24" fill="white"/></clipPath></defs></svg>`;

  // ---- 狀態 ----------------------------------------------------------------------
  // 位置只有 4 個角：[px, py]，0＝貼齊左／上（扣掉邊距）、1＝貼齊右／下
  const ANCHORS = [[0, 0], [1, 0], [0, 1], [1, 1]];
  const ANCHOR_NAME = { '0,0': '左上', '1,0': '右上', '0,1': '左下', '1,1': '右下' };
  const HIT_PAD = 48;                      // 預覽上拖曳 Logo 的判定區：在 Logo 外圍再加大這麼多（螢幕上的像素），Logo 本身大小不變
  // px／py 是「全部照片共用」的位置；某張照片在預覽上單獨拖過，就會有自己的 p.pos 蓋掉它
  const DEFAULTS = { px: 1, py: 0, size: 13, transparency: 0, margin: 3 };   // 預設右上角、13%、邊距 3%、不透明
  const PREVIEW_MAX = 1080;                // 預覽畫布的長邊
  const THUMB = 208;                       // 展示窗縮圖的邊長（畫素，顯示成 104px）
  const MAX_PHOTOS = 50;                   // 一次最多放幾張
  const MAX_EXPORT_PIXELS = 100e6;         // 下載圖的畫素上限（超過會等比縮小，避免瀏覽器畫布失敗）
  const st = {
    photos: [], cur: 0, nextId: 1,
    fmt: 'auto',
    logoMode: 'new', logoNew: null, logoOld: null, custom: null, customUrl: null,   // 浮水印圖：new＝新版 TVBS NEWS（SVG）、old＝舊版 新聞網（PNG）、custom＝自己上傳
    ...DEFAULTS,
  };
  const photo = () => st.photos[st.cur] || null;

  const canvas = $('wmCanvas');
  const emptyEl = $('wmEmpty');
  const statusEl = $('wmStatus');
  const downloadBtn = $('wmDownloadBtn');
  const downloadAllBtn = $('wmDownloadAllBtn');
  const photoHint = $('wmPhotoHint');
  const logoDrop = $('wmLogoDrop');
  const logoThumb = $('wmLogoThumb');
  const logoText = $('wmLogoText');
  const logoHint = $('wmLogoHint');
  const shelf = $('wmShelf');
  const thumbsEl = $('wmThumbs');
  const sliders = { size: $('wmSize'), transparency: $('wmTransparency'), margin: $('wmMargin') };
  const outs = { size: $('wmSizeOut'), transparency: $('wmTransparencyOut'), margin: $('wmMarginOut') };
  let busy = false;

  {
    const load = (src, key) => { const im = new Image(); im.onload = () => { st[key] = im; schedule(); }; im.src = src; };
    load('data:image/svg+xml;charset=utf-8,' + encodeURIComponent(BUILTIN_LOGO_SVG), 'logoNew');
    if (typeof LOGO_DATA_URI === 'string') load(LOGO_DATA_URI, 'logoOld');   // 舊版：app.js 裡畫在純色背景底部的那顆 PNG（170×100，白色）
  }
  const LOGO_HINT_DEFAULT = '新版是向量圖、放多大都清楚；舊版是 170×100 的白色 PNG，放大會偏糊。兩個都是淺色，照片偏亮時可以改成自己上傳的圖。';
  const currentLogo = () => (st.logoMode === 'custom' ? st.custom : st.logoMode === 'old' ? st.logoOld : st.logoNew);

  // ---- 繪製 ----------------------------------------------------------------------
  // 這張照片實際用的位置：自己單獨設定過就用自己的，否則用共用的
  const posOf = p => (p && p.pos) || [st.px, st.py];

  // 浮水印在 W×H 的畫面上的位置（pos 預設是目前這張照片的位置）
  function logoRect(W, H, logo, pos = posOf(photo())) {
    const w = W * st.size / 100;
    const h = w * logo.naturalHeight / logo.naturalWidth;
    const m = Math.min(W, H) * st.margin / 100;
    const rx = W - w - 2 * m, ry = H - h - 2 * m;
    return {
      x: rx > 0 ? m + pos[0] * rx : (W - w) / 2,
      y: ry > 0 ? m + pos[1] * ry : (H - h) / 2,
      w, h, m, rx, ry,
    };
  }
  // 在 g 上畫「照片＋浮水印」。src 可以是 Image 或縮圖畫布；ox/oy 是照片左上角在 g 上的位置
  function drawComposite(g, src, ox, oy, W, H, opaqueBg, pos) {
    g.imageSmoothingQuality = 'high';
    if (opaqueBg) { g.fillStyle = '#fff'; g.fillRect(ox, oy, W, H); }
    g.drawImage(src, ox, oy, W, H);
    const logo = currentLogo();
    if (!logo) return;
    const r = logoRect(W, H, logo, pos);
    g.save();
    g.globalAlpha = 1 - st.transparency / 100;
    g.drawImage(logo, ox + r.x, oy + r.y, r.w, r.h);
    g.restore();
  }

  let raf = 0;
  function schedule() { if (!raf) raf = requestAnimationFrame(() => { raf = 0; render(); }); }

  let dragging = false, hover = false, zoneScale = 1;
  function drawGuides(g, W, H, cur) {      // 拖曳時在預覽上標出 4 個角可以停的位置（只在畫面上，不會下載出去）
    const logo = currentLogo();
    if (!logo) return;
    g.save();
    g.lineWidth = Math.max(2, W / 400);
    g.setLineDash([g.lineWidth * 3, g.lineWidth * 3]);
    for (const a of ANCHORS) {
      const r = logoRect(W, H, logo, a);
      g.strokeStyle = a[0] === cur[0] && a[1] === cur[1] ? 'rgba(255,255,255,0.95)' : 'rgba(255,255,255,0.55)';
      g.shadowColor = 'rgba(0,0,0,0.6)'; g.shadowBlur = 4;
      g.strokeRect(r.x, r.y, r.w, r.h);
    }
    g.restore();
  }
  // 判定區（可以抓到 Logo 的範圍）：Logo 外圍加大 HIT_PAD 個螢幕像素
  function zoneOf(r, scale) {
    const pad = HIT_PAD * scale;
    return { x: r.x - pad, y: r.y - pad, w: r.w + 2 * pad, h: r.h + 2 * pad };
  }
  function drawZone(g, W, H, pos) {         // 滑鼠移進判定區時，用淡淡的虛線框讓使用者知道可以抓
    const logo = currentLogo();
    if (!logo) return;
    const z = zoneOf(logoRect(W, H, logo, pos), zoneScale);
    g.save();
    g.lineWidth = Math.max(1.5, W / 500);
    g.setLineDash([g.lineWidth * 4, g.lineWidth * 3]);
    g.fillStyle = 'rgba(255,255,255,0.10)';
    g.strokeStyle = 'rgba(255,255,255,0.7)';
    g.shadowColor = 'rgba(0,0,0,0.5)'; g.shadowBlur = 3;
    g.beginPath();
    g.roundRect(z.x, z.y, z.w, z.h, 10 * zoneScale);
    g.fill(); g.stroke();
    g.restore();
  }

  function render() {
    for (const k of Object.keys(sliders)) outs[k].textContent = `${st[k]}%`;
    const p = photo(), logo = currentLogo();
    const curPos = posOf(p);
    for (const b of $('wmGrid').querySelectorAll('button')) {
      b.classList.toggle('active', Number(b.dataset.px) === curPos[0] && Number(b.dataset.py) === curPos[1]);
    }
    $('wmPosHint').textContent = p && p.pos
      ? `這張照片的位置是在預覽上單獨調整的；按上面的位置鈕會套用到全部照片。`
      : '按上面的位置鈕會套用到全部照片；在預覽上拖曳 Logo 則只改目前這一張。';
    const n = st.photos.length;
    if (p) {
      const s = Math.min(1, PREVIEW_MAX / Math.max(p.img.naturalWidth, p.img.naturalHeight));
      const W = Math.max(1, Math.round(p.img.naturalWidth * s)), H = Math.max(1, Math.round(p.img.naturalHeight * s));
      if (canvas.width !== W || canvas.height !== H) { canvas.width = W; canvas.height = H; }
      const g = canvas.getContext('2d');
      g.clearRect(0, 0, W, H);
      drawComposite(g, p.img, 0, 0, W, H, false, curPos);
      if (dragging) drawGuides(g, W, H, curPos); else if (hover) drawZone(g, W, H, curPos);
    }
    canvas.hidden = !p;
    emptyEl.hidden = !!p;
    const ready = !!p && !!logo;
    downloadBtn.disabled = busy || !ready;
    downloadBtn.textContent = n > 1 ? '下載本張' : '下載圖片';
    downloadAllBtn.hidden = n < 2;
    downloadAllBtn.disabled = busy || !logo;
    downloadAllBtn.textContent = `全部下載（${n} 張）`;
    if (!busy) {
      statusEl.textContent = !p ? '請先上傳照片' : !logo ? '請上傳浮水印圖' : (n > 1 ? `預覽已更新（第 ${st.cur + 1}／${n} 張）` : '預覽已更新');
    }
    drawThumbs();
  }

  // ---- 展示窗（多張照片）----------------------------------------------------------
  // 縮圖：照片完整縮進正方形（不裁切，才看得到邊角的浮水印），上面疊同樣的浮水印
  function paintThumb(c, p) {
    const g = c.getContext('2d');
    g.fillStyle = '#e8eef7'; g.fillRect(0, 0, THUMB, THUMB);
    const k = Math.min(THUMB / p.small.width, THUMB / p.small.height);
    const w = Math.round(p.small.width * k), h = Math.round(p.small.height * k);
    drawComposite(g, p.small, Math.round((THUMB - w) / 2), Math.round((THUMB - h) / 2), w, h, false, posOf(p));
  }

  let thumbKey = '';
  function drawThumbs() {
    shelf.hidden = st.photos.length < 2;
    const key = st.photos.map(p => p.id).join(',');
    if (key !== thumbKey) {            // 張數或順序變了才重建；平常只重畫縮圖內容
      thumbKey = key;
      thumbsEl.textContent = '';
      st.photos.forEach((p, i) => {
        const wrap = document.createElement('div');
        wrap.className = 'wm-thumb';
        wrap.dataset.id = String(p.id);
        wrap.title = `#${i + 1} ${p.name}`;
        const c = document.createElement('canvas');
        c.width = c.height = THUMB;
        const badge = document.createElement('span');
        badge.className = 'wm-thumb-no';
        badge.textContent = String(i + 1);
        const rm = document.createElement('button');
        rm.type = 'button';
        rm.className = 'remove-btn wm-thumb-rm';
        rm.title = '移除這張'; rm.setAttribute('aria-label', `移除第 ${i + 1} 張`);
        rm.innerHTML = '<svg viewBox="0 0 12 12" aria-hidden="true"><path d="M3 3l6 6M9 3l-6 6"/></svg>';
        rm.addEventListener('click', e => { e.stopPropagation(); removePhoto(p.id); });
        wrap.addEventListener('click', () => { st.cur = st.photos.findIndex(x => x.id === p.id); schedule(); });
        wrap.append(c, badge, rm);
        thumbsEl.append(wrap);
      });
      updateShelfNav();
    }
    st.photos.forEach((p, i) => {
      const wrap = thumbsEl.children[i];
      if (!wrap) return;
      wrap.classList.toggle('active-thumb', i === st.cur);
      wrap.classList.toggle('own-pos', !!p.pos);
      wrap.title = `#${i + 1} ${p.name}${p.pos ? '（位置單獨設定）' : ''}`;
      paintThumb(wrap.firstChild, p);
    });
    const active = thumbsEl.children[st.cur];
    if (active && lastCentered !== `${thumbKey}|${st.cur}`) {
      lastCentered = `${thumbKey}|${st.cur}`;
      thumbsEl.scrollTo({ left: active.offsetLeft - (thumbsEl.clientWidth - active.offsetWidth) / 2 });
    }
  }
  let lastCentered = '';
  function updateShelfNav() {
    const max = thumbsEl.scrollWidth - thumbsEl.clientWidth;
    $('wmShelfPrev').disabled = thumbsEl.scrollLeft <= 1;
    $('wmShelfNext').disabled = thumbsEl.scrollLeft >= max - 1;
  }
  $('wmShelfPrev').addEventListener('click', () => thumbsEl.scrollBy({ left: -thumbsEl.clientWidth * 0.8 }));
  $('wmShelfNext').addEventListener('click', () => thumbsEl.scrollBy({ left: thumbsEl.clientWidth * 0.8 }));
  thumbsEl.addEventListener('scroll', updateShelfNav, { passive: true });
  thumbsEl.addEventListener('wheel', e => {     // 滑鼠滾輪也能左右捲動（觸控板本來就可以）
    if (Math.abs(e.deltaX) > Math.abs(e.deltaY)) return;
    if (thumbsEl.scrollWidth <= thumbsEl.clientWidth) return;
    e.preventDefault();
    thumbsEl.scrollBy({ left: e.deltaY, behavior: 'auto' });
  }, { passive: false });
  new ResizeObserver(updateShelfNav).observe(thumbsEl);

  function removePhoto(id) {
    const i = st.photos.findIndex(p => p.id === id);
    if (i < 0) return;
    const [p] = st.photos.splice(i, 1);
    URL.revokeObjectURL(p.url);
    if (st.cur > i || st.cur >= st.photos.length) st.cur = Math.max(0, st.cur - 1);
    updateHint();
    schedule();
  }

  // ---- 載入照片／浮水印圖 --------------------------------------------------------
  function loadImage(file) {
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(file);
      const im = new Image();
      im.onload = () => resolve({ im, url });
      im.onerror = () => { URL.revokeObjectURL(url); reject(new Error('decode')); };
      im.src = url;
    });
  }
  const isImage = f => (typeof isImageFile === 'function' ? isImageFile(f) : !!f && /^image\//.test(f.type));

  function updateHint(extra) {
    const n = st.photos.length, p = photo();
    const base = !n ? '輸出會保持原圖尺寸'
      : n === 1 ? `已載入：${p.name}（${p.img.naturalWidth}×${p.img.naturalHeight}），輸出會保持原圖尺寸`
      : `已載入 ${n} 張；目前第 ${st.cur + 1} 張：${p.name}（${p.img.naturalWidth}×${p.img.naturalHeight}）`;
    photoHint.textContent = extra ? `${base}。${extra}` : base;
  }

  // 一次加入一張或多張（依序載入，免得很多大圖同時解碼）；已有的照片會保留，新的接在後面
  async function addPhotos(fileList) {
    const files = [...(fileList || [])];
    if (!files.length) return;
    const images = files.filter(isImage);
    const notes = [];
    if (images.length < files.length) notes.push(`略過 ${files.length - images.length} 個不是圖片的檔案`);
    const room = MAX_PHOTOS - st.photos.length;
    if (images.length > room) notes.push(`一次最多 ${MAX_PHOTOS} 張，多出的 ${images.length - room} 張沒有加入`);
    const wasEmpty = st.photos.length === 0;
    let failed = 0;
    for (const file of images.slice(0, Math.max(0, room))) {
      try {
        const { im, url } = await loadImage(file);
        const k = Math.min(1, THUMB / Math.max(im.naturalWidth, im.naturalHeight));
        const small = document.createElement('canvas');      // 縮圖用的小圖，之後重畫縮圖不用每次縮大圖
        small.width = Math.max(1, Math.round(im.naturalWidth * k));
        small.height = Math.max(1, Math.round(im.naturalHeight * k));
        const g = small.getContext('2d');
        g.imageSmoothingQuality = 'high';
        g.drawImage(im, 0, 0, small.width, small.height);
        st.photos.push({ id: st.nextId++, name: file.name, mime: file.type, img: im, url, small });
      } catch (e) { failed++; }
    }
    if (failed) notes.push(`${failed} 張無法開啟（可能是不支援的格式，例如 HEIC，請改用 JPG／PNG）`);
    if (wasEmpty) st.cur = 0;
    updateHint(notes.join('；'));
    schedule();
  }

  async function setLogo(file) {
    if (!isImage(file)) { logoHint.textContent = file ? `無法辨識「${file.name}」為圖片檔` : ''; return; }
    try {
      const { im, url } = await loadImage(file);
      if (st.customUrl) URL.revokeObjectURL(st.customUrl);
      st.custom = im; st.customUrl = url;
      logoThumb.src = url; logoThumb.hidden = false;
      logoText.hidden = true;
      logoHint.textContent = `已載入：${file.name}（${im.naturalWidth}×${im.naturalHeight}）`;
      schedule();
    } catch (e) { logoHint.textContent = `「${file.name}」無法開啟，請改用 PNG／JPG／SVG`; }
  }

  // 點擊／拖曳上傳區
  function bindDrop(zone, input, handler) {
    zone.addEventListener('click', () => input.click());
    zone.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); input.click(); } });
    input.addEventListener('click', e => e.stopPropagation());
    input.addEventListener('change', () => { handler(input.files); input.value = ''; });
    zone.addEventListener('dragover', e => { e.preventDefault(); zone.classList.add('drag'); });
    zone.addEventListener('dragleave', () => zone.classList.remove('drag'));
    zone.addEventListener('drop', e => { e.preventDefault(); e.stopPropagation(); zone.classList.remove('drag'); handler(e.dataTransfer.files); });
  }
  bindDrop($('wmPhotoDrop'), $('wmPhotoInput'), addPhotos);
  bindDrop(logoDrop, $('wmLogoInput'), files => setLogo(files[0]));

  // 把照片拖到預覽區也可以
  const stage = $('wmStage');
  stage.addEventListener('dragover', e => { e.preventDefault(); stage.classList.add('drag'); });
  stage.addEventListener('dragleave', () => stage.classList.remove('drag'));
  stage.addEventListener('drop', e => { e.preventDefault(); stage.classList.remove('drag'); addPhotos(e.dataTransfer.files); });

  // Ctrl+V 貼上：浮水印功能開著時一律由這裡處理（在捕捉階段攔下，免得 app.js 把圖貼到看不見的「圖片套版」裡）
  document.addEventListener('paste', e => {
    if (!watermarkActive()) return;
    const files = e.clipboardData ? [...e.clipboardData.items].filter(i => i.kind === 'file' && /^image\//.test(i.type)).map(i => i.getAsFile()) : [];
    e.stopImmediatePropagation();
    if (!files.length) return;
    e.preventDefault();
    if (document.activeElement === logoDrop && st.logoMode === 'custom') setLogo(files[0]); else addPhotos(files);
  }, true);

  // ---- 浮水印圖來源 ---------------------------------------------------------------
  const logoToggle = $('wmLogoToggle');
  logoToggle.querySelectorAll('button').forEach(btn => btn.addEventListener('click', () => {
    st.logoMode = btn.dataset.logo;
    logoToggle.querySelectorAll('button').forEach(b => b.classList.toggle('active', b === btn));
    logoDrop.hidden = st.logoMode !== 'custom';
    schedule();
  }));

  // ---- 位置、滑桿、輸出格式 --------------------------------------------------------
  // 左側的位置鈕＝「全部套用」。如果有照片已經在預覽上單獨拖過，會先問一聲再全部改掉
  $('wmGrid').querySelectorAll('button').forEach(btn => btn.addEventListener('click', async () => {
    const target = [Number(btn.dataset.px), Number(btn.dataset.py)];
    const own = st.photos.filter(p => p.pos).length;
    if (own > 0 && st.photos.length > 1) {
      const ok = await askConfirm({
        title: '要把全部照片的位置都改掉嗎？',
        message: `有 ${own} 張照片的浮水印位置是在預覽上單獨調整過的。\n繼續的話，全部 ${st.photos.length} 張都會改成「${ANCHOR_NAME[target.join()]}」，單獨調整的位置會被蓋掉。`,
        okText: '全部改變'
      });
      if (!ok) return;
    }
    for (const p of st.photos) p.pos = null;
    st.px = target[0]; st.py = target[1];
    schedule();
  }));
  for (const [key, el] of Object.entries(sliders)) {
    el.addEventListener('input', () => { st[key] = Number(el.value); schedule(); });
  }
  const fmtToggle = $('wmFormat');
  function syncFormat() { fmtToggle.querySelectorAll('button').forEach(b => b.classList.toggle('active', b.dataset.fmt === st.fmt)); }
  fmtToggle.querySelectorAll('button').forEach(btn => btn.addEventListener('click', () => { st.fmt = btn.dataset.fmt; syncFormat(); }));

  // ---- 在預覽上拖曳浮水印（只會吸附到 4 個角；只改目前這一張）／滾輪 --------------------------
  let drag = false;
  const toCanvas = e => {
    const r = canvas.getBoundingClientRect();
    return { x: (e.clientX - r.left) * canvas.width / r.width, y: (e.clientY - r.top) * canvas.height / r.height, scale: canvas.width / r.width };
  };
  // 滑鼠在判定區內就回傳 Logo 的矩形（判定區比 Logo 大，方便快速抓；Logo 本身大小不變）
  function hitLogo(p) {
    const logo = currentLogo();
    if (!logo || !photo()) return null;
    const r = logoRect(canvas.width, canvas.height, logo);
    const z = zoneOf(r, p.scale);
    return p.x >= z.x && p.x <= z.x + z.w && p.y >= z.y && p.y <= z.y + z.h ? r : null;
  }
  // 滑鼠目前在畫面的哪個位置 → 最近的角
  function nearestAnchor(p) {
    const fx = p.x / canvas.width, fy = p.y / canvas.height;
    let best = ANCHORS[0], bd = Infinity;
    for (const a of ANCHORS) {
      const d = (a[0] - fx) ** 2 + (a[1] - fy) ** 2;
      if (d < bd) { bd = d; best = a; }
    }
    return best;
  }
  canvas.addEventListener('pointerdown', e => {
    const p = toCanvas(e);
    if (!hitLogo(p)) return;
    e.preventDefault();
    zoneScale = p.scale;
    drag = dragging = true;
    canvas.setPointerCapture(e.pointerId);
    canvas.classList.add('dragging');
    schedule();
  });
  canvas.addEventListener('pointermove', e => {
    const p = toCanvas(e);
    zoneScale = p.scale;
    if (!drag) {
      const over = !!hitLogo(p);
      canvas.classList.toggle('over-logo', over);
      if (over !== hover) { hover = over; schedule(); }
      return;
    }
    const cur = photo();
    const a = nearestAnchor(p);
    const next = a[0] === st.px && a[1] === st.py ? null : a;       // 拖回跟大家一樣的位置，就不算「單獨設定」
    const same = (cur.pos || null) === next || (cur.pos && next && cur.pos[0] === next[0] && cur.pos[1] === next[1]);
    if (!same) { cur.pos = next; schedule(); }
  });
  const endDrag = e => {
    if (!drag) return;
    drag = dragging = false;
    canvas.classList.remove('dragging');
    if (canvas.hasPointerCapture(e.pointerId)) canvas.releasePointerCapture(e.pointerId);
    schedule();
  };
  canvas.addEventListener('pointerup', endDrag);
  canvas.addEventListener('pointercancel', endDrag);
  canvas.addEventListener('pointerleave', () => { if (!drag) { canvas.classList.remove('over-logo'); if (hover) { hover = false; schedule(); } } });
  canvas.addEventListener('wheel', e => {
    if (!hitLogo(toCanvas(e))) return;              // 沒有停在浮水印上就照常捲動頁面
    e.preventDefault();
    st.size = Math.min(60, Math.max(5, st.size + (e.deltaY < 0 ? 2 : -2)));
    sliders.size.value = st.size;
    schedule();
  }, { passive: false });

  // ---- 下載／全部清除 --------------------------------------------------------------
  const safeBase = name => (name.replace(/\.[^.]+$/, '').replace(/[\\/:*?"<>|]/g, '').trim().slice(0, 60)) || '照片';
  const extFor = p => (st.fmt === 'png' ? 'png' : st.fmt === 'jpeg' ? 'jpg' : (p.mime === 'image/jpeg' ? 'jpg' : 'png'));

  // 回傳 { blob, filename, note }
  async function exportPhoto(p) {
    let W = p.img.naturalWidth, H = p.img.naturalHeight, note = '';
    if (W * H > MAX_EXPORT_PIXELS) {
      const s = Math.sqrt(MAX_EXPORT_PIXELS / (W * H));
      W = Math.round(W * s); H = Math.round(H * s);
      note = `（${p.name} 太大，已縮小成 ${W}×${H}）`;
    }
    const ext = extFor(p);
    const c = document.createElement('canvas');
    c.width = W; c.height = H;
    drawComposite(c.getContext('2d'), p.img, 0, 0, W, H, ext === 'jpg', posOf(p));
    const blob = await new Promise((resolve, reject) => c.toBlob(b => (b ? resolve(b) : reject(new Error('產生圖片失敗'))), ext === 'png' ? 'image/png' : 'image/jpeg', 0.95));
    return { blob, filename: `${safeBase(p.name)}_浮水印.${ext}`, note };
  }
  function saveBlob(blob, filename) {
    const a = document.createElement('a');
    a.download = filename;
    a.href = URL.createObjectURL(blob);
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 10000);
  }
  async function run(fn) {
    if (busy) return;
    busy = true; render();
    try { await fn(); } catch (err) { statusEl.textContent = `下載失敗：${err.message || err}`; }
    finally { busy = false; const keep = statusEl.textContent; render(); statusEl.textContent = keep; }
  }

  downloadBtn.addEventListener('click', () => run(async () => {
    const { blob, filename, note } = await exportPhoto(photo());
    saveBlob(blob, filename);
    statusEl.textContent = `已下載：${filename}${note}`;
  }));
  // 全部下載：檔名是「YYMMDDHHMM_第幾張」，例如 2610122312_1。時間只在按下按鈕的那一刻取一次，
  // 同一批的照片就算下載到一半換了分鐘也沿用同一個時間，只靠編號區分順序。每張之間隔 0.5～1 秒。
  const pad2 = n => String(n).padStart(2, '0');
  const stampNow = () => { const d = new Date(); return `${pad2(d.getFullYear() % 100)}${pad2(d.getMonth() + 1)}${pad2(d.getDate())}${pad2(d.getHours())}${pad2(d.getMinutes())}`; };
  const DL_GAP_MIN = 500, DL_GAP_MAX = 1000;
  downloadAllBtn.addEventListener('click', () => run(async () => {
    const list = [...st.photos], notes = [];
    const stamp = stampNow();
    for (let i = 0; i < list.length; i++) {
      statusEl.textContent = `產生中 ${i + 1}／${list.length}：${list[i].name}`;
      const { blob, note } = await exportPhoto(list[i]);
      if (note) notes.push(note);
      saveBlob(blob, `${stamp}_${i + 1}.${extFor(list[i])}`);
      if (i < list.length - 1) await new Promise(r => setTimeout(r, DL_GAP_MIN + Math.random() * (DL_GAP_MAX - DL_GAP_MIN)));   // 間隔一下，瀏覽器比較不會擋掉連續下載
    }
    statusEl.textContent = `已下載 ${list.length} 張（${stamp}_1 ～ ${stamp}_${list.length}）${notes.join('')}`;
  }));

  $('wmResetBtn').addEventListener('click', async () => {
    if (!(await askConfirm())) return;
    for (const p of st.photos) URL.revokeObjectURL(p.url);
    if (st.customUrl) URL.revokeObjectURL(st.customUrl);
    Object.assign(st, { photos: [], cur: 0, fmt: 'auto', custom: null, customUrl: null, logoMode: 'new', ...DEFAULTS });
    updateHint();
    logoThumb.hidden = true; logoThumb.removeAttribute('src'); logoText.hidden = false;
    logoHint.textContent = LOGO_HINT_DEFAULT;
    logoDrop.hidden = true;
    logoToggle.querySelectorAll('button').forEach(b => b.classList.toggle('active', b.dataset.logo === 'new'));
    for (const [k, el] of Object.entries(sliders)) el.value = st[k];
    syncFormat();
    schedule();
  });

  // 測試與除錯用
  window.Watermark = { state: st, logoRect, setFunc, ANCHORS, posOf };
  schedule();
})();

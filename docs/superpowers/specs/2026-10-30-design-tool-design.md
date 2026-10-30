# 平面設計功能（網頁版新分頁）— 設計規格

日期：2026-10-30
狀態：使用者已確認，待寫實作計畫
標示：**［事實］** 是從程式讀到的；**［決定］** 是使用者已拍板；**［預設］** 是我暫定、可改的數值；**［推論］** 是判斷。

## 1. 目標與成功標準

在網頁版新增「設計」分頁，做**社群圖卡／封面圖等級的輕量平面設計**（精簡版 Canva，不是 Photoshop／Illustrator）。

使用者：
- 用途 1：新聞社群圖卡（不內建新聞套版；之後使用者自己累積參考範本）。
- 用途 2：個人 IG（its.jeannn_）的貼文、輪播、限動。
- 不做接案文件（報價單、PDF 作品集）。

成功標準：
1. 能從空白畫布排出一張含文字、圖片、形狀、貼圖的圖，匯出 PNG／JPG（300 DPI）。
2. 能做多頁（IG 輪播），一次匯出 ZIP。
3. 專案能匯出成 `.json`，之後匯入還原，內容與版面一致。
4. Noto Serif TC 只在被選用時才下載；沒選到就不載入。
5. 整套設計檔案**不依賴主工具的程式**，日後可整批搬去獨立網站。

## 2. 決策記錄

| 項目 | 決定 |
|---|---|
| 落點 | 網頁版新分頁；外掛不動［決定］ |
| 長期 | 先內嵌，長大再切獨立網站（比照 QuickCut）［決定］ |
| 新聞套版 | 不內建［決定］ |
| 範本／存檔 | 第一版只做「匯出／匯入 `.json`」；「我的範本（瀏覽器自動存）」「參考範本（repo）」等整體完成後再加［決定］ |
| 字型 | 加 Noto Serif TC，選用才下載；來源先用 Google Fonts，註冊表同時支援自架 woff2，日後可補［決定］ |
| 字重 | Noto Serif TC 提供一般（400）與粗體（700）［決定］ |
| 仙人掌明體 | 列入字型選單，選用才下載（自架 `fonts/cactus-classical-serif.woff2`，約 10MB）［決定］ |
| 專案檔內嵌圖片 | 縮到最長邊 2048px［決定］ |
| 規格書是否推上 repo | 先不推，留在工作區［決定］ |

## 3. 功能範圍

### P0（第一版）

| 模組 | 內容 |
|---|---|
| 畫布與頁面 | 尺寸預設 1:1（1080×1080）、4:5（1080×1350）、9:16（1080×1920）、16:9（1920×1080）、自訂（64～4096 px）；背景純色／線性漸層（兩色＋角度）／圖片；多頁（上限 20 頁）；縮放與平移檢視 |
| 物件 | 文字、圖片、形狀（矩形、橢圓、線、箭頭）、貼圖（沿用 `stickers/*.png`）、馬賽克；每頁上限 200 個物件［預設］ |
| 文字 | 字型、字級、顏色、對齊（左／中／右）、行高、字距、描邊、陰影 |
| 圖片 | 蓋滿／完整顯示、裁切位置與縮放、圓角、透明度、抽色（黑白） |
| 編輯 | 選取（含框選、多選）、移動、縮放、旋轉、複製貼上、刪除、圖層順序、鎖定、隱藏、復原／重做、方向鍵微調 |
| 輔助 | 吸附參考線（頁面邊與中心、其他物件的邊與中心）、對齊與等距分佈 |
| 匯出 | 目前頁 PNG／JPG；全部頁 ZIP；複製目前頁到剪貼簿 |
| 專案檔 | 匯出／匯入 `.json` |

### P1（第二階段，不在本規格的實作範圍）
相片版型（底片框、寶麗來框、留白框、雙圖並排）、相機資訊文字一鍵插入、個人色票、主頁九宮格預覽、「送去」尺寸／浮水印分頁、我的範本（IndexedDB）、參考範本（`examples/design/`）。

### 不做
去背、AI 生圖與排版、向量鋼筆、CMYK、動畫與影片、雲端同步與協作、接案文件、內建新聞範本。

## 4. 架構

### 4.1 檔案

| 檔案 | 職責 | 碰 DOM？ | node 可測？ |
|---|---|---|---|
| `design-core.js` | 文件模型、編輯操作與不變式、復原、命中測試、吸附數學、讀檔遷移 | 否 | 是（`module.exports`） |
| `design-fonts.js` | 字型註冊表與載入器 | 只用 `document.fonts`／`FontFace` | 部分（stub） |
| `design-render.js` | `render(ctx, page, opts)`：把一頁畫到 Canvas，預覽與匯出共用 | 否（只收 ctx） | 部分 |
| `design-export.js` | PNG／JPG 編碼、300 DPI 寫入、ZIP 寫入器、專案檔序列化 | 否 | 部分 |
| `design-ui.js` | 工具列、面板、選取框與把手、快捷鍵、觸控 | 是 | 靠 e2e |
| `design.css` | 樣式 | — | — |

載入順序：**core → fonts → render → export → ui**；各模組掛在 `QPTDesign.*`；其他模組可能較晚載入，一律在用到時才讀 `Q.core` 等，不在載入時假設存在（沿用剪輯模組做法）。

### 4.2 與主工具的接縫（只有一處）
- 接縫是 `watermark.js` 的 `setFunc`／`qpt:func` 分頁切換事件［事實：DESIGN.md 第 1 節］。`index.html` 新增「設計」分頁按鈕與容器（容器 id 建議 `designApp`），`watermark.js` 的 `apps` 表要加入它。
- `design-*` **不 import `app.js`、`stickers.js`、`watermark.js`**。需要的小功能在 `design-*` 內自備一份：
  - PNG `pHYs` 寫入與 CRC-32：`app.js` 已有一份［事實：`app.js` 的 `pngCrc32`、`pHYs` 插入］，`design-export.js` 另寫一份。
  - 貼圖：只引用資源檔 `stickers/<id>.png`（id：angry、cry、kiss、laugh、meh、shock、smile）［事實：`stickers.js` 以此路徑載入］，不引用 `stickers.js`。
  - 字型：`WHZ-Heavy` 靠 `style.css` 的 `@font-face`［事實］。日後獨立網站要自帶這個 `@font-face` 與 `whz-heavy.ttf`。
- 切成獨立網站時搬走：`design-*.js`、`design.css`、`stickers/`、`whz-heavy.ttf`、一份 `@font-face`。

## 5. 文件模型

```
文件 { version: 1, pages: [頁面], assets: { [assetId]: 資產 } }
頁面 { id, w, h, bg, objects: [物件] }     // objects 陣列順序 = 圖層順序（後面的在上）
bg   { type: 'solid', color } | { type: 'gradient', from, to, angle } | { type: 'image', asset, fit, view }
資產 { name, w, h, mime }                  // 記憶體中另有 Blob 與 Object URL，不在 JSON 內
```

物件共通欄位：`id`、`type`、`x`、`y`、`w`、`h`（頁面像素，未旋轉時的左上角與尺寸）、`rot`（度，繞中心）、`opacity`（0～1）、`locked`、`hidden`。

| type | 專屬欄位 |
|---|---|
| `text` | `text`、`font`（字型 id）、`size`、`color`、`align`、`lineHeight`、`letterSpacing`、`stroke{w,color}`、`shadow{x,y,blur,color}`；寬度固定、自動換行（逐字量測，全形英數混排），高度由內容決定 |
| `image` | `asset`、`fit`（`cover`｜`contain`）、`view{ox,oy,scale}`（0～1 比例，同尺寸分頁的記法）、`radius`、`gray`（抽色旗標） |
| `shape` | `kind`（`rect`｜`ellipse`｜`line`｜`arrow`）、`fill`、`stroke{w,color}`、`radius` |
| `sticker` | `id`（上列 7 個之一） |
| `mosaic` | 無額外欄位；`rot` 固定為 0（只能軸對齊），其餘沿用共通欄位 |

規則：
- **座標是頁面像素**，不用比例，和現有 1080 套版一致［事實］。
- **馬賽克作用在它下方所有圖層**［決定］：渲染時它讀取目前畫布上已畫好的像素。方塊大小 = 短邊 ÷ 5、至少 14px，每格取真實平均色（`getImageData`）［事實：沿用現有貼圖與馬賽克設計］；畫布被污染讀不到像素時改用灰色蓋住。
- **抽色**用 `globalCompositeOperation = 'saturation'` 疊黑色，只作用在該圖片自己的離屏畫布，再畫到頁面（不是整頁抽色）［推論：與現有 `photo(ctx)` 同一手法，但範圍縮到單一圖片］。
- 文件帶 `version`；讀檔經 `migrate(doc)`。**讀到比自己新的版本一律拒絕並顯示繁中說明**，不默默讀壞。
- 圖片資產在記憶體用 Object URL，不轉 base64［事實：現有記憶體原則］；只在匯出專案檔時轉成內嵌 data URL，最長邊超過 2048px 的先縮小［決定］。

## 6. 字型（`design-fonts.js`）

註冊表每筆：`{ id, name, family, weight, source, fallback }`。

| 字型 id | source | 載入 |
|---|---|---|
| `WHZ-Heavy` | `preload` | `style.css` 已 `@font-face`；進頁面時 `document.fonts.load` 等一次［事實：`app.js` 做法］ |
| `system` | `system` | 不下載，用系統黑體備用字串 |
| `noto-serif-tc-400`、`noto-serif-tc-700` | `google` | 選到才載入 |
| `cactus` | `file` | 以 `FontFace` 載入 `fonts/cactus-classical-serif.woff2`（family `Cactus Classical Serif`）［事實：檔案已在 repo，授權檔 `OFL-CactusClassicalSerif.txt` 同目錄］；選到才下載，整檔一次抓 |
| （日後）Noto Serif TC 自架 | `file` | 離線需求時，放 woff2 進 `fonts/`、把 `source` 由 `google` 改 `file` 即可［決定］ |

行為：
- **載入時機**：使用者在字型選單選到、或匯入／開啟的文件裡有物件用到時才載入；沒用到的字型完全不發請求。
- **`google` 來源**：Google Fonts 以 `unicode-range` 分片，瀏覽器只抓用到的字所在分片。因此除了在選到時載入外，**文字內容出現新字時**要以 `document.fonts.load("<weight> 80px \"Noto Serif TC\"", 文字)` 補載對應分片，完成後通知重畫。樣式表（`<link rel=stylesheet>`）在第一次需要時才動態插入頁面，而不是預先寫在 HTML。
- **載入中**：先用 `fallback`（`"Noto Serif TC"`, `"Songti TC"`, `"PMingLiU"`, `"MingLiU"`, serif）畫，載好後自動重畫。
- **失敗**：字型選單項目顯示「載入失敗」，維持備用字型，不阻擋編輯與匯出。
- **匯出前**一律 `await ready(doc)`（等該文件用到的所有字型與其文字分片載好），避免第一次匯出悄悄換成備用字型［事實：DESIGN.md 第 2 節的同類問題］。
- 狀態通知：`onFontLoad(cb)`，cb 收到 `(id, 'loading'|'loaded'|'failed')`，UI 用來顯示「下載中…」。
- 與已停用的 `edit-fx.js` 載入器（`loadFont`、`fontState`、`onFontLoad`）同一種模式，但**自備一份**，不引用它［決定：接縫原則］。

## 7. 編輯操作與復原（`design-core.js`）

- 所有編輯操作**全有或全無**：在副本上套用、跑不變式檢查，通過才整份換進去；失敗時文件完全不變，回傳 `{ok:false, reason}`（繁中原因）。
- 不變式：物件 id 在文件內唯一；`w`、`h` > 0；`opacity` 在 0～1；`asset` 指向存在的資產；頁數與物件數不超過上限；`mosaic.rot === 0`。
- 復原用序列化快照，上限 100 步［事實：剪輯模組做法］。資產 Blob 不在復原範圍內（資產只增不減，直到存檔時才清理沒被引用的）。
- 拖曳類操作（移動、縮放、旋轉）：`history.begin` 起頭，每次移動「回到起點再套用總位移」，放開才 `end()`，整段拖曳只留一筆；Esc 取消回到拖曳前［事實：剪輯模組做法］。
- 成功後 core 會換掉子物件，所以 UI 不長期握著物件參考，一律用 id 重查。
- 命中測試考慮旋轉（把點反轉進物件座標系）。
- 吸附為純數學：輸入「被拖物件的邊與中心」與「候選線」，輸出位移修正與要顯示的線；門檻以**螢幕像素**計（預設 6px，換算成頁面像素時除以目前縮放），所以放大縮小手感一致。

## 8. 渲染（`design-render.js`）

- `render(ctx, page, opts)`：`opts` 含 `scale`、`assets`（解碼好的影像）、`fonts`（就緒狀態）；**預覽與匯出呼叫同一個函式**，所見即所得。
- 繪製順序：背景 → 依 `objects` 順序逐一繪製（含馬賽克讀取已畫像素）。
- 選取框、把手、吸附線、框選矩形是蓋在畫布上的 DOM，**不會輸出**［事實：現有 `.fx-layer` 做法］。
- 影像尚未解碼完成的物件先畫佔位，解碼完成後通知重畫；匯出前等所有影像就緒。
- 文字排版的結果（斷行、高度）以「文字＋字型＋寬度＋樣式」為 key 快取，字型載入完成時使快取失效。

## 9. 互動（`design-ui.js`）

- **選取與變形**：點選、Shift 加選、框選；8 個縮放把手（角把手等比、邊把手單向；文字的邊把手改寬度、角把手連字級一起等比）、旋轉把手（Shift 吸附每 15°）。
- **文字編輯**：雙擊進入編輯，用蓋在畫布上的輸入框，位置、行高、字級與畫布一致；輸入框不輸出［事實：現有 `.title-overlay` 做法］。
- **快捷鍵**：Delete／Backspace 刪除；Ctrl／Cmd＋Z、Shift＋Z、Y 復原重做；Ctrl／Cmd＋C、V、D 複製貼上與重複；方向鍵微調 1px、Shift＋方向鍵 10px；Esc 取消目前拖曳或取消選取；`]`、`[` 調圖層順序。
- **檢視**：滾輪（無修飾鍵）上下捲動、Ctrl／Cmd＋滾輪縮放、空白鍵＋拖曳平移；提供「符合視窗」。
- **觸控**：沿用現有 pointer events 兩指縮放做法［事實：DESIGN.md 第 8 節手機版面］；手機版面規則依 `CLAUDE.md`，寫在網頁版專用檔（`design.css` 與 `watermark.css` 最後面），**不動 `style.css`**。
- **頁面列**：縮圖列顯示全部頁，可新增、複製、刪除、拖曳排序。
- **字型選單**：每項顯示載入狀態；選到未載入的字型時立即開始載入。
- 所有提示與錯誤訊息用繁體中文。

## 10. 匯出與專案檔（`design-export.js`）

- **PNG**：`canvas.toBlob`，再在位元組層插入 `pHYs`（300 DPI）。
- **JPG**：品質 95%［事實：拼圖同值］，透明處墊白；寫入 JFIF 的密度欄位為 300 DPI（`design-export.js` 自備實作，不引用拼圖程式）。
- **輸出尺寸**：1x（等於頁面像素）。
- **ZIP**：自寫的「只儲存、不壓縮」寫入器（PNG／JPG 本來就壓過），含 CRC-32、本地檔頭、中央目錄；檔名 `page-01.png`…。［事實］`deploy.js` 已有同款的 `buildZip`（不壓縮）與 `crc32`，但依接縫原則**不引用它**，在 `design-export.js` 自備一份（可照著寫，測試用位元組比對）。
- **剪貼簿**：`ClipboardItem` 寫入 PNG；瀏覽器不支援時改提示下載。
- **專案檔**：`JSON.stringify(doc)` 加內嵌資產（見第 5 節）；副檔名 `.json`，內含 `app: "QuickPatterntool-design"` 與 `version`，匯入時先驗證再 `migrate`。匯入覆蓋目前文件前先確認，並可復原（匯入視為一次編輯）。
- 匯入檔大小上限 100MB［預設］，超過直接拒絕並說明。

## 11. CSP、版號與更新清單

- **`index.html` 的 CSP** 需放寬：`style-src` 加 `https://fonts.googleapis.com`、`font-src` 加 `https://fonts.gstatic.com`；`index.html` 是網頁版專用檔，不升版［事實：CLAUDE.md］。另外專案檔匯入用 `<input type=file>` 與 `FileReader`，不需要 `connect-src`。
- **`updater.js` 與 `deploy.js` 的 `SKIP` 兩邊一致**新增規則 `/^design(-[a-z]+)?\.(js|css)$/`，日後新增 `design-*` 檔不必再改。這次動到 `updater.js`，所以**第一次上線要升個位數版號**（`7.30` → `7.31`），並同步 `changelog.json`（繁中一筆）與 `test/manifest.test.js` 寫死的版本號；之後只改 `design-*` 與其他網頁版專用檔就不升版。
- **`docs/` 目錄**不在目前的網頁版專用清單內。使用者決定規格先不推；日後若要推，需把 `docs/` 一併加入 `SKIP`（併入上面那次升版）。見第 14 節。
- 仙人掌明體 woff2 在 `fonts/`，而 `fonts/` **已經在** `updater.js` 與 `deploy.js` 的 `SKIP` 內（`/^fonts\//`）［事實，已確認］，所以外掛更新不會下載這個 10MB 檔，不需要額外處理。

## 12. 測試

- **單元（`node --test test/*.test.js`，新增 `test/design-*.test.js`）**：文件操作與不變式、全有或全無、復原與拖曳合併、命中測試（含旋轉）、吸附、`migrate`（含拒絕較新版本）、ZIP 寫入器（用已知內容比對位元組與 CRC）、字型註冊表（stub `document.fonts`／`FontFace`，檢查「沒用到就不發請求」「新字會補載」）。
- **e2e（Playwright，`/opt/pw-browsers/chromium`，暫時副本加 `executablePath`，跑完刪掉）**：開設計分頁、建文字／圖片／形狀、拖曳與縮放、多頁、匯出 PNG 並檢查像素與 `pHYs`、匯出 ZIP 檔名、專案檔匯出再匯入後版面相同。
- **Google Fonts 無法在沙盒實測**（無網路）：以 stub 驗證呼叫參數；真正下載需使用者在部署後的瀏覽器確認。
- 暫存腳本與截圖放 scratchpad，不放進專案。

## 13. 文件同步

- `DESIGN.md` 新增「設計」一節（為什麼這樣切、接縫、字型載入策略、馬賽克規則）。
- `README.md` 補使用方式。
- `CLAUDE.md` 的網頁版專用檔案清單加入 `design.js/css`（`design-*`）。

## 14. 未決與後續（不阻擋實作規劃）

| 項目 | 目前狀態 |
|---|---|
| 本規格檔是否進 repo | 使用者決定先不推；`docs/` 暫不加入 `SKIP`，等設計功能第一次上線再一併決定 |
| P1 項目 | 整體完成後各自另開規格 |

# 平面設計（網頁版「設計」分頁）P0 實作計畫

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal：** 在網頁版新增「設計」分頁，能用文字、圖片、形狀、貼圖、馬賽克排出多頁圖卡，匯出 PNG／JPG（300 DPI）、ZIP 與 `.json` 專案檔。

**Architecture：** 6 個網頁版專用檔案，掛在 `window.QPTDesign.*`。純邏輯在 `design-core.js`（node 可測），渲染、字型、匯出各成一檔，DOM 只在 `design-ui.js`。跟主工具只有一個接縫：`watermark.js` 的 `apps`／`funcBtns` 表＋`index.html` 的分頁按鈕與容器。寫法比照 `edit-core.js`：IIFE＋`module.exports`，所有操作都是全有或全無，成功回 `{ ok: true, ... }`，失敗回 `{ ok: false, reason: '繁中' }`。

**Tech Stack：** 原生 JS（無打包、無相依套件）、Canvas 2D、`node --test`、Playwright（`/opt/pw-browsers/chromium`）。

**Spec：** `docs/superpowers/specs/2026-10-30-design-tool-design.md`。實作時兩份要一起看，本計畫只寫規格沒定的決定。

## Global Constraints

- 介面文字、錯誤訊息、註解一律**繁體中文（台灣口吻）**。
- `design-*` **不 import、不呼叫** `app.js`、`stickers.js`、`watermark.js`、`deploy.js`、`edit-*.js`。需要的 CRC-32、ZIP、pHYs、JFIF、馬賽克演算法都自備一份，可以照著抄。
- 各模組掛 `root.QPTDesign = root.QPTDesign || {}`。載入順序 core → fonts → render → export → ui。別的模組一律在**用到時**才讀 `Q.core` 等，不在載入時假設它已經存在。
- 頁面尺寸：1:1 `1080×1080`、4:5 `1080×1350`、9:16 `1080×1920`、16:9 `1920×1080`；自訂 `64～4096` 的整數。
- 上限：頁數 20、每頁物件 200、復原 100 步、匯入檔 100MB、專案檔內嵌圖片最長邊 2048px。
- 貼圖 id：`angry cry kiss laugh meh shock smile`，路徑 `stickers/<id>.png`。
- 馬賽克：方塊大小＝`max(14, round(min(w,h)/5))`（頁面像素），每格取平均色；`getImageData` 失敗時用 `#808080` 蓋住。
- 匯出：PNG 在 IHDR 後插入 `pHYs`（300 DPI）；JPG 品質 0.95，先墊白底，JFIF 密度設 300；ZIP 只儲存不壓縮，檔名 `page-01.png`…；專案檔帶 `app: "QuickPatterntool-design"` 與 `version: 1`。
- 預覽的 DOM 疊層（選取框、把手、吸附線、框選、文字輸入框）**不會輸出**。
- 不動 `style.css`。手機版面規則寫在 `design.css`，必要時寫在 `watermark.css` 最後面。
- **不 commit、不 push**（`CLAUDE.md`：使用者說「推」才做）。每個任務做完只跑測試、回報結果。
- 暫存腳本與截圖一律放 scratchpad，不放進專案。e2e 照現有 `test/*.e2e.js` 的寫法：`require('playwright')`，找不到就整檔略過。在沙盒裡跑時，用暫時的副本加 `executablePath: '/opt/pw-browsers/chromium'`，跑完刪掉。

## Review Focus

1. **旋轉後的物件**：轉 90° 後拖角把手，對角要固定不動；點選旋轉物件的角落空白處（框外）不能選到它。→ Task 2 的 `resizeRect`、`hitTest` 測試。
2. **壞的專案檔**：不是 JSON、`app` 不對、`version` 比自己新、超過 100MB、`asset` 指向不存在的資產。目前文件要完全不變，並顯示繁中原因。→ Task 1 的 `migrate` 測試、Task 5 的 `parseProject` 測試。
3. **字型載不到**（沙盒沒網路、Google Fonts 失敗或卡住）：匯出不能卡住，要用備用字型完成。`ready()` 最多等 10 秒［預設］就回 `false`。→ Task 3 的測試。
4. **在文字輸入框或面板欄位裡打字時**，Delete／Backspace／Ctrl＋Z／方向鍵不能動到物件或文件。→ Task 7 的 e2e。
5. **頁面上有污染的畫布**（`file://` 載入貼圖時）：馬賽克改用灰色蓋住，不丟錯、不中斷渲染。→ Task 4 的 e2e。

## 派工（以最少的 sub-agent、依難度配模型）

| 批次 | Agent | 模型 | 任務 | 為什麼用這個模型 |
|---|---|---|---|---|
| 1 | **A：核心** | `opus` | Task 1、2 | 不變式、全有或全無、旋轉幾何、復原合併，錯了會一路傳到 UI，需要最強推理 |
| 1（與 A 並行） | **B：引擎** | `sonnet` | Task 3、4、5 | 介面已定、演算法有現成可以照抄（pHYs／ZIP／馬賽克），屬中等難度 |
| 2（等 A、B 完成） | **C：介面** | `opus` | Task 6、7、8 | 最大塊：互動狀態、拖曳／縮放／旋轉、文字疊層、e2e，跨檔整合 |
| 3 | **D：收尾** | `haiku` | Task 9 | 照清單改文件、版號、SKIP，機械性工作 |
| 最後 | **審查** | `opus` | 整個分支 | 一次看完全部，對照規格與 Review Focus |

- A 和 B 只碰各自的檔案，所以可以並行。B 的 `parseProject` 用注入的 `migrate` 測，不必等 A 做完。
- 每個 agent 收到的是「本計畫＋規格＋自己的 Task 段落」，回報時附上測試輸出。

---

### Task 1：文件模型、編輯操作、不變式、復原、讀檔遷移（Agent A）

**Files：**
- Create：`design-core.js`
- Test：`test/design-core.test.js`

**Interfaces：**
- Produces（`QPTDesign.core`，同時 `module.exports`）：
  - 常數：`SIZES`（見 Global Constraints）、`SIDE_MIN=64`、`SIDE_MAX=4096`、`MAX_PAGES=20`、`MAX_OBJECTS=200`、`DOC_VERSION=1`、`STICKERS`、`SNAP_PX=6`。
  - `createDoc({ w=1080, h=1080 }={}) → doc`：一頁，`bg={type:'solid',color:'#ffffff'}`，`assets={}`。
  - `defaults(type) → object`：該類型的完整預設欄位，不含 id、x、y。預設值：
    - text：`text:'輸入文字'`、`font:'WHZ-Heavy'`、`size:80`、`color:'#111111'`、`align:'center'`、`lineHeight:1.25`、`letterSpacing:0`、`stroke:{w:0,color:'#000000'}`、`shadow:{x:0,y:0,blur:0,color:'rgba(0,0,0,0.5)'}`、`w:800`、`h:100`
    - image：`fit:'cover'`、`view:{ox:0.5,oy:0.5,scale:1}`、`radius:0`、`gray:false`
    - shape：`kind:'rect'`、`fill:'#2f6fed'`、`stroke:{w:0,color:'#000000'}`、`radius:0`、`w:400`、`h:300`
    - sticker：`sticker:'smile'`、`w:240`、`h:240`（貼圖名稱放 `sticker` 欄位；`id` 是物件自己的 id）
    - mosaic：`w:300`、`h:200`
    - 共通：`rot:0`、`opacity:1`、`locked:false`、`hidden:false`
  - 頁面操作：`addPage(doc,{w,h,index,bg}) → {ok,id}`、`duplicatePage(doc,pageId) → {ok,id}`、`removePage(doc,pageId)`、`movePage(doc,pageId,toIndex)`、`setPageProps(doc,pageId,{w,h,bg})`。
  - 資產：`addAsset(doc,{name,w,h,mime}) → {ok,id}`，id 依序為 `a1`、`a2`…（跳過已存在的）；`pruneAssets(doc) → string[]`（刪掉沒被引用的，回傳被刪的 id；只在存檔時呼叫）。
  - 物件操作：
    - `addObject(doc,pageId,partial) → {ok,id}`，id 依序為 `o1`、`o2`…，在全文件內唯一。
    - `updateObjects(doc,pageId,[{id,...patch}])`：`stroke`／`shadow`／`view` 做淺合併。
    - `removeObjects(doc,pageId,ids)`
    - `duplicateObjects(doc,pageId,ids,{dx=20,dy=20}) → {ok,ids}`
    - `pasteObjects(doc,pageId,objs,{dx=20,dy=20}) → {ok,ids}`：給新 id。
    - `reorder(doc,pageId,ids,'up'|'down'|'top'|'bottom')`
    - `findObject(doc,id) → {page,obj,index}|null`
  - 鎖定規則：`locked:true` 的物件只能改 `locked`、`hidden`。其他欄位的 patch，以及移除、重排它，一律回 `{ok:false,reason:'物件已鎖定'}`。
  - `validate(doc) → null | '繁中原因'`：規格第 7 節的不變式，再加上：`page.w/h` 是 64～4096 的整數；`type` 是 5 種之一；`sticker.sticker` 在 `STICKERS` 內；`shape.kind` 在 4 種之內。
  - `migrate(raw) → {ok:true,doc}|{ok:false,reason}`：補齊缺的欄位（用 `defaults`），再跑 `validate`。
  - `serialize(doc) → string`、`deserialize(str) → doc`
  - `createHistory(getDoc,setDoc,{limit=100})`：API 與 `edit-core.js:1395` 的 `createHistory` 相同（`run/begin/end/cancel/undo/redo/busy/canUndo/canRedo/clear`），**另加** `rewind()`：拖曳中把文件還原到 `begin` 時的狀態，但不結束 pending。拖曳時每次移動先 `rewind()`，再套用總位移。

- [ ] **Step 1：寫失敗的測試** `test/design-core.test.js`。測試名稱與斷言：
  - `createDoc 預設一頁 1080×1080 白底`：`doc.version===1`、`doc.pages.length===1`、`validate(doc)===null`。
  - `addObject 給唯一 id、套用預設值`：連加 3 個物件，id 互不相同，且 `obj.opacity===1`。
  - `全有或全無`：用 `unchanged(doc, fn)` 檢查以下每個失敗操作，`serialize(doc)` 前後要相同，`reason` 符合 `/[一-鿿]/`：
    - 第 201 個物件
    - 第 21 頁
    - `opacity:1.5`
    - `w:0`
    - `asset:'nope'`
    - `type:'mosaic'` 的 `rot:30`
    - `setPageProps` 的 `w:63` 與 `w:4097`
    - 刪除最後一頁（`reason` 含「至少」）
  - `鎖定的物件不能移動但能解鎖`
  - `duplicateObjects 位移 20 且 id 不同`
  - `reorder top/bottom/up/down 後的 objects 順序`
  - `復原重做`：`run` 兩次之後 `undo` 兩次，回到初始；`redo` 一次。
  - `拖曳合併`：`begin`，`rewind`＋`updateObjects` 做 5 次，`end` 之後 `undo` 一次就回到拖曳前。`cancel` 會回到 `begin` 前。`busy` 時 `undo()===false`。
  - `復原上限 100`：`run` 105 次，`undo` 只能成功 100 次。
  - `migrate 拒絕較新版本`：`migrate({version:2,pages:[…]})` 回 `ok:false`，`reason` 含「較新版本」。
  - `migrate 拒絕壞資料`：`null`、`{}`、`pages` 不是陣列，三種都回 `ok:false`。
  - `migrate 補齊缺欄位`：只有 `{id,type:'text',x,y,w,h}` 的文字物件，補完後有 `font==='WHZ-Heavy'`。
  - `pruneAssets 只刪沒被引用的`
- [ ] **Step 2：跑測試，確認失敗。** 執行 `node --test test/design-core.test.js`，預期 FAIL（`Cannot find module '../design-core.js'`）。
- [ ] **Step 3：實作 `design-core.js`。** 檔頭註解比照 `edit-core.js`。做法照抄 `edit-core.js`：`copy` 出副本 → 在副本上執行 → `validate` → 用 `replaceInPlace` 換回去；中途錯誤用 `EditError`／`bail` 拋出。
- [ ] **Step 4：跑測試，確認通過。** 執行 `node --test test/design-core.test.js`，預期 PASS。

### Task 2：幾何——命中、框選、變形、吸附、對齊（Agent A）

**Files：**
- Modify：`design-core.js`（同一個 API 物件）
- Test：`test/design-core.test.js`（追加）

**Interfaces：**
- Produces：
  - `corners(o) → [{x,y}×4]`：以中心旋轉 `rot` 度，順序是左上、右上、右下、左下。
  - `bounds(o) → {x,y,w,h}`：旋轉後的外接矩形。
  - `toLocal(o,px,py) → {x,y}`：把點轉進物件「未旋轉」的座標系，原點是物件左上角。
  - `hitTest(page,px,py) → id|null`：從最上層往下找，略過 `hidden`；鎖定的物件仍然可以點到。
  - `inRect(page,{x,y,w,h}) → ids`：`bounds` 完全落在框內、而且沒隱藏的物件。
  - `resizeRect(o,handle,dx,dy,{keepRatio=false,minSize=8}) → {x,y,w,h}`
    - `handle` ∈ `'nw','n','ne','e','se','s','sw','w'`；`dx/dy` 是頁面座標的位移。
    - 算法：把位移旋轉進物件座標系 → 改對應的邊 → 夾到 `minSize` 以上 → 依舊的「對邊或對角」在頁面上的位置不變，反推新的中心點 → 換算回 `x,y`。
    - `keepRatio` 時用投影到對角線的長度等比縮放。
  - `rotateAngle(o,px,py,{step=0}) → deg`：從中心指向該點的角度，0° 在正上方；`step=15` 時取最近的倍數；結果正規化到 0～360。
  - `snapCandidates(page,excludeIds) → {xs:number[],ys:number[]}`：頁面的 `0`、`w/2`、`w`（y 同理），加上其他沒隱藏的物件 `bounds` 的左、中、右（上、中、下）。
  - `snapBox(box,cands,{threshold=SNAP_PX,zoom=1}) → {dx,dy,lines:[{axis:'x'|'y',pos}]}`
    - 頁面門檻＝`threshold/zoom`。
    - x、y 兩軸各自取 box 的三條線（左／中／右，上／中／下）與候選線距離最近、而且在門檻內的一組；同一個修正量下對齊到的線全部列入 `lines`。
  - `align(doc,pageId,ids,'left'|'hcenter'|'right'|'top'|'vcenter'|'bottom')`：只選一個時對齊頁面，多個時對齊整個選取範圍的 `bounds`。
  - `distribute(doc,pageId,ids,'h'|'v')`：3 個以上才能用，否則 `reason` 含「至少 3 個」；依 `bounds` 排序後讓間距相等。

- [ ] **Step 1：追加失敗的測試。**
  - `hitTest 取最上層、略過隱藏`
  - `hitTest 考慮旋轉`：`{x:0,y:0,w:200,h:20,rot:90}` 的中心是 `(100,10)`；點 `(100,90)` 命中，點 `(190,10)` 不命中。
  - `inRect 只選完全在框內的`
  - `resizeRect 未旋轉 se 拉 (50,30)` → `w+50、h+30`，`x、y` 不變。
  - `resizeRect 旋轉 90° 時拖 se，nw 角的頁面位置不變`：比較 `corners()[0]` 前後，誤差小於 1e-6。
  - `resizeRect keepRatio 維持比例`、`resizeRect 不小於 minSize`
  - `rotateAngle step 15`：從 22° 方向的點算出 15。
  - `snapBox 在門檻內吸到頁面中心`：box 中心 x＝543、zoom 1 → `dx===-3`，`lines` 含 `{axis:'x',pos:540}`。
  - `snapBox 門檻隨縮放換算`：同樣差 8 頁面像素，zoom 1 不吸，zoom 0.5 吸（門檻＝6/zoom）。
  - `align 單一物件對齊頁面右邊`、`distribute 三個物件間距相等`、`distribute 少於 3 個回 ok:false`。
- [ ] **Step 2：跑測試，確認失敗。** 執行 `node --test test/design-core.test.js`，預期新增的測試 FAIL。
- [ ] **Step 3：實作上列函式。** 只有 `align`／`distribute` 會改文件，所以只有它們走全有或全無；其他都是純函式。
- [ ] **Step 4：跑全部單元測試。** 執行 `node --test test/*.test.js`，預期全部 PASS。

### Task 3：字型註冊表與載入器（Agent B）

**Files：**
- Create：`design-fonts.js`
- Test：`test/design-fonts.test.js`

**Interfaces：**
- Produces：
  - `createFonts(env) → api`，其中 `env = { document, FontFace, setTimeout }`。
  - 瀏覽器端：`QPTDesign.fonts = createFonts(window)`。
  - `module.exports = { createFonts, FONTS }`。
  - `FONTS`（陣列，順序即選單順序）：

    | id | name | family | weight | source |
    |---|---|---|---|---|
    | `WHZ-Heavy` | 粗體（預設） | `WHZ-Heavy` | 400 | `preload` |
    | `noto-serif-tc-400` | 思源宋體 | `Noto Serif TC` | 400 | `google` |
    | `noto-serif-tc-700` | 思源宋體 粗 | `Noto Serif TC` | 700 | `google` |
    | `cactus` | 仙人掌明體 | `Cactus Classical Serif` | 400 | `file`，`url: 'fonts/cactus-classical-serif.woff2'` |
    | `system` | 系統黑體 | — | 400 | `system` |

  - 備用字型：
    - 明體類用規格第 6 節的 serif 備用字串。
    - 黑體類用 `'"PingFang TC", "Microsoft JhengHei", "Noto Sans TC", sans-serif'`。
  - `GOOGLE_CSS = 'https://fonts.googleapis.com/css2?family=Noto+Serif+TC:wght@400;700&display=swap'`
  - api：
    - `list() → [{id,name,state}]`
    - `fontCss(id,size) → string`：給 `ctx.font` 用的字串，例如 `700 80px "Noto Serif TC", "Songti TC", …`；不認得的 id 改用 `WHZ-Heavy`。
    - `state(id) → 'idle'|'loading'|'loaded'|'failed'`
    - `load(id) → Promise<boolean>`
    - `ensureText(id,text) → Promise<boolean>`
    - `ready(doc,{timeout=10000}) → Promise<boolean>`
    - `onFontLoad(cb) → 取消函式`
    - `gen() → number`：任何字型或分片載好就 +1。
  - 載入行為：
    - `google`：第一次需要時插入 `<link rel=stylesheet href=GOOGLE_CSS>` 到 `head`（只插一次），再呼叫 `document.fonts.load('<weight> 80px "Noto Serif TC"', 文字)`。
    - `ensureText` 只對這個字型還沒要求過的新字元發請求；沒有新字元時不發請求，直接回傳。
    - `file`：`new FontFace(family,'url("…") format("woff2")')`，接著 `.load()`，再 `document.fonts.add(face)`。
    - `preload`：`document.fonts.load('80px "WHZ-Heavy"')`。
    - `system`：直接回 `true`。
    - 失敗（reject）時狀態設為 `'failed'`，resolve 成 `false`，不拋錯。
  - `ready(doc)`：先收集所有 `type==='text'` 物件用到的字型，以及各字型出現過的文字；對每個字型做 `load`，google 字型再做 `ensureText`；整體跟 `timeout` 賽跑，超時就回 `false`。

- [ ] **Step 1：寫失敗的測試。** 用 stub 的 `document`（`fonts.load` 記錄參數、`head.appendChild` 記錄節點）和 stub 的 `FontFace`。
  - `沒用到的字型不發請求`：`createFonts` 之後，再對只有 `WHZ-Heavy` 文字的 doc 呼叫 `ready`，結果是沒有插入 link、沒有建立 FontFace。
  - `選到 google 字型才插入樣式表，且只插一次`
  - `ensureText 只補新字`：先 `'你好'`，再 `'你好嗎'`，第二次 `fonts.load` 的文字參數只含「嗎」；再 `'你好'` 一次時不呼叫。
  - `cactus 以 FontFace 載入 fonts/cactus-classical-serif.woff2`
  - `載入失敗回 false、state 為 failed、onFontLoad 收到 failed`
  - `ready 逾時回 false`：`fonts.load` 永遠不 resolve，`timeout:50` 時 100ms 內 resolve 成 `false`。
  - `fontCss 帶粗細與備用字串`
- [ ] **Step 2：跑測試，確認失敗。** 執行 `node --test test/design-fonts.test.js`，預期 FAIL。
- [ ] **Step 3：實作 `design-fonts.js`。** 結構參考 `edit-fx.js:212-250`，但要自備一份，不引用它。
- [ ] **Step 4：跑測試，確認通過。** 執行 `node --test test/design-fonts.test.js`，預期 PASS。

### Task 4：渲染（Agent B）

**Files：**
- Create：`design-render.js`
- Test：`test/design-render.test.js`（node：排版）、`test/design-render.e2e.js`（Chromium：像素）

**Interfaces：**
- Consumes：文件結構（規格第 5 節）、`fonts.fontCss(id,size)`、`fonts.gen()`。
- Produces（`QPTDesign.render`，同時 `module.exports`）：
  - `render(ctx,page,opts) → {pending:boolean}`
    - `opts = { scale=1, images:{[assetId]:CanvasImageSource|null}, stickers:{[id]:CanvasImageSource|null}, fonts, skipIds:Set }`
    - `skipIds` 給文字編輯中的物件用，渲染時跳過。
    - 有影像還沒就緒時畫斜線灰底佔位，`pending` 回 `true`。
  - `layoutText(ctx,obj,fonts) → {lines:string[],lineH:number,height:number}`
    - 逐字量測：`measureText(ch).width + letterSpacing`；累計超過 `obj.w` 就換行，`\n` 強制換行。
    - `lineH = size*lineHeight`，`height = lines.length*lineH`。
    - 快取 key 是 `text|font|size|w|letterSpacing|lineHeight|fonts.gen()`。
  - `textHeight(obj,fonts) → number`：用模組內部的離屏 canvas 算；UI 拿它更新 `h`。
- 繪製規則（規格沒寫死的部分）：
  - 背景漸層角度照 CSS 的定義：0°＝由下往上、90°＝由左往右；漸層線長＝`|w·sinθ|+|h·cosθ|`。
  - 影像擺放（`image` 物件與圖片背景共用）：
    - `k = (fit==='cover' ? max(w/iw,h/ih) : min(w/iw,h/ih)) * view.scale`
    - `dw=iw·k`、`dh=ih·k`
    - `dx=(w−dw)·view.ox`、`dy=(h−dh)·view.oy`
    - 這和 `resize.js` 的 `fx/fy` 是同一種記法。
  - 圖片物件要先畫到自己的離屏 canvas，依序做：圓角裁切 →（`gray` 時）`saturation` 疊黑 → 再以 `opacity`、`rot` 畫到頁面上。
  - 文字：先畫描邊（`lineWidth=stroke.w*2`、`lineJoin='round'`），再畫填色；陰影只加在第一次繪製。對齊方式 left／center／right 以物件寬為準；`letterSpacing` 用逐字 `fillText` 實作。
  - 形狀：
    - `rect` 支援 `radius`。
    - `ellipse` 內切於框。
    - `line` 從左邊中點畫到右邊中點，用 `stroke`；`stroke.w` 是 0 時改用 2px 的 `fill` 色。
    - `arrow` 畫線加三角形箭頭，頭長＝`max(16, stroke.w*4)`。
  - 馬賽克：在 canvas 像素座標（頁面座標×`scale`）上照 `stickers.js` 的 `pixelate` 寫法實作，方塊大小用頁面像素算好再乘以 `scale`。

- [ ] **Step 1：寫 node 測試** `test/design-render.test.js`。stub 的 `ctx.measureText` 讓每個字寬度都等於 `size`。
  - `size 100、w 350、'一二三四五'` 排出 3＋2 兩行；`'\n'` 會強制換行。
  - `letterSpacing 20` 讓每行少一個字。
  - `fonts.gen()` 改變後快取失效（呼叫次數會增加）。
- [ ] **Step 2：寫 e2e** `test/design-render.e2e.js`。用 `about:blank` 加 `addScriptTag` 載入 core、fonts、render，在 canvas 上畫完後讀像素。
  - `純色背景`
  - `漸層 90° 左端是 from、右端是 to`
  - `rect 填色＋opacity 0.5 會和背景混色`
  - `旋轉 90° 的長條 rect 改成直的`
  - `gray 圖片的 r=g=b`
  - `馬賽克區內同一格顏色一致、區外不變`
  - `污染畫布上的馬賽克是灰色、不丟錯`：先畫一張跨來源的圖，讓畫布被污染。
  - `scale 0.5 與 1 輸出比例一致`
- [ ] **Step 3：跑測試，確認失敗。** 執行 `node --test test/design-render.test.js`，再照 Global Constraints 用暫時副本跑 e2e，預期 FAIL。
- [ ] **Step 4：實作 `design-render.js`。**
- [ ] **Step 5：跑測試，確認全部通過。** 執行 `node --test test/design-render.test.js`，再用暫時副本跑 e2e，預期全部 PASS。

### Task 5：匯出與專案檔（Agent B）

**Files：**
- Create：`design-export.js`
- Test：`test/design-export.test.js`

**Interfaces：**
- Consumes：
  - `render.render`
  - `fonts.ready`
  - `core.migrate`：可由 `opts.migrate` 注入。
  - `core.pruneAssets`
- Produces（`QPTDesign.export`，同時 `module.exports`）：
  - 位元組工具：
    - `crc32(Uint8Array) → number`（uint32）
    - `pngWithDpi(Uint8Array,dpi=300) → Uint8Array`：IHDR 之後插入 `pHYs`；本來就有 `pHYs` 的話換掉，不重複。
    - `jpgWithDpi(Uint8Array,dpi=300) → Uint8Array`：沒有 JFIF APP0 就原樣回傳。
    - `buildZip([{name,bytes}],date=new Date()) → Uint8Array`：存放方式 0；UTF-8 檔名旗標 0x0800；DOS 時間取自 `date`。
  - 渲染輸出：
    - `renderPage(doc,pageIndex,env,{fmt}) → Promise<HTMLCanvasElement>`：先 `await env.fonts.ready(doc)`，再等影像就緒；`fmt==='jpg'` 時先墊白。
    - `env = { fonts, images, stickers, loadImages(doc) → Promise }`，由 UI 提供。
    - `exportPage(doc,i,fmt,env) → Promise<Blob>`
    - `exportZip(doc,fmt,env) → Promise<Blob>`：檔名 `page-01.png`…，兩位數補零。
    - `copyPage(doc,i,env) → Promise<{ok:true}|{ok:false,reason:'這個瀏覽器不支援複製圖片，請改用下載'}>`
  - 專案檔：
    - `serializeProject(doc,blobs,{downscale}) → Promise<string>`
      - 先在副本上 `pruneAssets`。
      - 每個資產用 `downscale(blob,2048)` 處理後轉成 data URL，放在 `assets[id].data`。
      - 輸出格式：`{app:'QuickPatterntool-design',version:1,doc}`。
      - `downscale` 預設用 canvas 實作，node 測試時注入。
    - `parseProject(input,{migrate,maxBytes=100*1024*1024}) → Promise<{ok:true,doc,blobs}|{ok:false,reason}>`
      - `input` 是 `File`、`Blob` 或字串。
      - 依序檢查：大小 → JSON 解析 → `app` 欄位 → `migrate` → data URL 解碼成 Blob。
      - 失敗訊息：超過大小是「檔案超過 100MB」；其他是「不是有效的設計專案檔」，或沿用 `migrate` 給的原因。

- [ ] **Step 1：寫失敗的測試。**
  - `crc32('123456789') === 0xCBF43926`
  - `pngWithDpi 插在 IHDR 後`：用最小的 1×1 PNG（Buffer 寫死），檢查：
    - 第 33 位元組起是 `pHYs`
    - 每公尺像素數＝`11811`
    - 單位＝1
    - CRC 正確
    - 對已經插過的 PNG 再呼叫一次，`pHYs` 只有一個
  - `jpgWithDpi 改 JFIF 密度`：位元組 13＝1，14～17＝`0x012C`；不是 JFIF 的原樣回傳。
  - `buildZip 單檔位元組結構`：`a.txt`／`hi` 搭配固定日期，檢查：
    - 本地檔頭簽章 `0x04034b50`
    - 方法 0
    - CRC＝`crc32('hi')`
    - 中央目錄 `0x02014b50`
    - EOCD `0x06054b50`
    - 筆數 1
    - 中央目錄的位移正確
  - `buildZip 多檔順序與檔名 page-01.png、page-02.png`
  - `parseProject 拒絕`：
    - 非 JSON
    - `app` 不對
    - 超過大小上限：用 `maxBytes:10` 測
    - `migrate` 回 `ok:false` 時沿用它的 `reason`
    - 以上每種 `reason` 都要有中文
  - `serializeProject → parseProject 來回一致`：注入的 `downscale` 會記錄最長邊參數 2048；沒被引用的資產不會寫進檔案。
- [ ] **Step 2：跑測試，確認失敗。** 執行 `node --test test/design-export.test.js`，預期 FAIL。
- [ ] **Step 3：實作 `design-export.js`。** 位元組格式照 `app.js:671-720` 與 `deploy.js:120-165` 抄一份。
- [ ] **Step 4：跑全部單元測試。** 執行 `node --test test/*.test.js`，預期全部 PASS。

### Task 6：分頁接縫、版面骨架、畫布檢視、頁面列、背景（Agent C）

**Files：**
- Modify：`index.html`
  - CSP：`style-src` 加 `https://fonts.googleapis.com`，`font-src` 加 `https://fonts.gstatic.com`。
  - 分頁按鈕 `funcDesignBtn`（文字「設計」，放在「剪輯」前面）。
  - `<section id="designApp" hidden>`。
  - `design.css` 的 `<link>`。
  - 5 個 `<script>`，依載入順序放在 `stickers.js` 之後。
- Modify：`watermark.js:18-19`：`apps` 加 `design: $('designApp')`，`funcBtns` 加 `design: $('funcDesignBtn')`。
- Create：`design-ui.js`、`design.css`
- Test：`test/design-ui.e2e.js`

**Interfaces：**
- Consumes：`QPTDesign.core/fonts/render/export`，各自的介面見 Task 1～5。
- Produces：`QPTDesign.ui = { state, getDoc(), select(ids), rerender() }`，給 e2e 檢查用。
  - `state` 的內容：`{ doc, pageId, selection:string[], zoom, panX, panY, history }`。
- 版面：
  - 左邊是工具列：文字、圖片、形狀（4 種）、貼圖（7 個）、馬賽克。
  - 中間是畫布舞台；舞台上方是檢視列（縮放比例、符合視窗、復原、重做），下方是頁面縮圖列。
  - 右邊是屬性面板：沒選物件時顯示「頁面」設定，包括尺寸預設與自訂、背景純色／漸層／圖片。
- 檢視：
  - 畫布的實際像素＝頁面尺寸 × `devicePixelRatio` × `zoom`，上限 4096。
  - 滾輪捲動；Ctrl／Cmd＋滾輪以游標為中心縮放（10%～400%）。
  - 空白鍵＋拖曳平移；兩指觸控縮放。
  - 切到這個分頁時（`qpt:func` 的 `detail==='design'`）重畫，第一次顯示時自動「符合視窗」。
- 頁面列：新增、複製、刪除、拖曳排序，全部走 `history.run`。縮圖用 `render` 以小比例畫出。

- [ ] **Step 1：寫 e2e**（參考 `test/stickersweb.e2e.js` 的 `open()`）。
  - `點「設計」分頁顯示 #designApp、其他 app 隱藏`
  - `預設一頁 1080×1080`
  - `改成 4:5 頁面變 1080×1350`
  - `自訂 5000 被拒並顯示繁中訊息`
  - `新增、複製、刪除頁面，第 21 頁被拒`
  - `背景改成漸層後畫布像素改變`
  - `Ctrl＋滾輪縮放改變 zoom`
  - `頁面沒有 pageerror`
- [ ] **Step 2：跑 e2e，確認失敗。** 照 Global Constraints 用暫時副本跑，預期 FAIL。
- [ ] **Step 3：實作 Task 6 範圍的 `index.html`、`watermark.js`、`design-ui.js`、`design.css`。**
- [ ] **Step 4：跑 e2e，確認通過；再跑全部單元測試。** 執行 `node --test test/*.test.js`，預期全部 PASS（`manifest.test.js` 的 SKIP 測試也要過）。

### Task 7：物件、選取與變形、吸附、快捷鍵、屬性面板、文字編輯、字型選單（Agent C）

**Files：**
- Modify：`design-ui.js`、`design.css`
- Test：`test/design-ui.e2e.js`（追加）

**Interfaces：**
- Consumes：
  - `core` 的 `addObject`、`updateObjects`、`hitTest`、`inRect`、`resizeRect`、`rotateAngle`、`snapCandidates`、`snapBox`、`align`、`distribute`、`reorder`
  - `history.begin`、`rewind`、`end`、`cancel`
  - `fonts.list`、`load`、`ensureText`、`onFontLoad`
  - `render.textHeight`
- 互動規則（規格第 9 節沒寫死的部分）：
  - 新物件放在頁面中央，並且自動選取。
  - 圖片：用檔案選擇器或拖進畫布。先 `URL.createObjectURL`，再 `addAsset`，再 `addObject`；物件尺寸依原圖比例，長邊為頁面短邊的 60%。
  - 選取框、把手、旋轉把手、吸附線、框選矩形都放在 `.dz-overlay`（DOM），依 `zoom`／`pan` 定位。
  - 拖曳：`pointerdown` 時 `begin`；每次 `pointermove` 先 `rewind`，再套用「總位移＋吸附修正」；`pointerup` 時 `end`；拖曳中按 Esc 就 `cancel`。
  - 文字：
    - 邊把手只改 `w`，之後用 `textHeight` 更新 `h`。
    - 角把手等比縮放，連 `size` 一起乘上比例。
    - 雙擊進入編輯：`<textarea class="dz-text-edit">`，字型、字級、行高、對齊都跟畫布一致；編輯中把該物件放進 `skipIds`。
    - 失焦或按 Esc 時，寫回 `text` 並更新 `h`，這整段只記一筆復原。
    - 每次輸入都呼叫 `ensureText`。
  - 快捷鍵：照規格第 9 節。`document.activeElement` 是 `input`／`textarea`／`select`／`[contenteditable]` 時一律不處理。
  - 屬性面板依類型顯示規格第 3 節的欄位。拉滑桿時第一次 `input` 就 `begin`、`change` 時 `end`，所以一次拉動只記一筆。
  - 字型選單：每項顯示「下載中…」或「載入失敗」，選到時立刻 `load`。
  - 多選時面板顯示對齊（6 種）與等距分佈（2 種）。
  - `onFontLoad` 與影像解碼完成都觸發 `rerender()`，同一個 frame 內合併成一次（`requestAnimationFrame`）。

- [ ] **Step 1：追加 e2e。**
  - `加文字→雙擊編輯→輸入「測試」→點外面，物件 text 是「測試」，Ctrl+Z 一次回到「輸入文字」`
  - `在 textarea 按 Backspace 不刪物件`、`在面板 input 按方向鍵不移動物件`
  - `拖曳物件，靠近頁面中心時出現吸附線，放開後中心對齊 540`
  - `拖 se 把手放大、Shift 拖旋轉把手得到 15 的倍數`
  - `拖曳中按 Esc 回到原位、復原堆疊沒有新增`
  - `Shift 點選與框選多選、對齊左邊後 x 相同`
  - `Ctrl+C／V 貼上 id 不同、Ctrl+D 重複、Delete 刪除、] [ 調順序`
  - `鎖定的物件拖不動`、`隱藏的物件不畫出`
  - `上傳圖片後物件出現，圓角、抽色改變像素`
  - `選思源宋體 → 字型選單顯示下載中或載入失敗`：沙盒沒網路，只檢查兩者之一出現，而且頁面沒有 `pageerror`。
- [ ] **Step 2：跑 e2e，確認新增的測試失敗。**
- [ ] **Step 3：實作。**
- [ ] **Step 4：跑 e2e，確認全部通過。**

### Task 8：匯出、剪貼簿、專案檔、手機版面（Agent C）

**Files：**
- Modify：`design-ui.js`、`design.css`；`watermark.css` 只在必要時才動，而且只加在最後面。
- Test：`test/design-ui.e2e.js`（追加）

**Interfaces：**
- Consumes：`export.exportPage`、`exportZip`、`copyPage`、`serializeProject`、`parseProject`。
- 規則：
  - 匯出按鈕群組：目前頁 PNG、目前頁 JPG、全部 ZIP（PNG）、複製。
  - 匯出中按鈕停用，並顯示「匯出中…」。
  - 下載檔名：`design-YYYYMMDD-HHmm.png`、`.jpg`、`.zip`，專案檔是 `.json`。
  - 匯入：`<input type=file accept=".json,application/json">`。文件裡已經有物件時，先確認「匯入會取代目前的設計（可以復原）」。透過 `history.run('匯入專案', …)` 把整份換掉，失敗時顯示 `reason`，文件不變。成功後對新文件呼叫 `fonts.ready(doc)`（不等待），用到的字型才會開始下載。
  - 手機（≤820px）：單欄，畫布在最上面，工具列改成橫向捲動，屬性面板放在畫布下方。

- [ ] **Step 1：追加 e2e。**
  - `匯出 PNG：下載檔第 33 位元組起是 pHYs、像素和畫布一致`：抽 5 點比對。
  - `匯出 ZIP：兩頁時中央目錄檔名是 page-01.png、page-02.png`
  - `匯出 JPG 的 JFIF 密度是 300`
  - `專案檔匯出再匯入：serialize(doc) 相同（id 與資產內容都一樣）、畫布像素一致`
  - `匯入壞檔顯示繁中錯誤、doc 不變`
  - `匯入後 Ctrl+Z 回到匯入前`
  - `複製：stub navigator.clipboard.write 後收到 image/png`
  - `390×844 視窗：畫布在面板之上、沒有水平捲軸`
- [ ] **Step 2：跑 e2e，確認新增的測試失敗。**
- [ ] **Step 3：實作。**
- [ ] **Step 4：跑全部單元測試＋設計相關的 e2e，並另外截兩張圖（桌機 1280×900、手機 390×844）存到 scratchpad。** 執行 `node --test test/*.test.js`，預期全部 PASS。

### Task 9：SKIP、版號、文件同步（Agent D）

**Files：**
- Modify：`updater.js:13-14`、`deploy.js:14-15`：兩邊的 SKIP 都加上 `/^design(-[a-z]+)?\.(js|css)$/` 與 `/^docs\//`，兩邊要完全一致。
- Modify：`manifest.json`：`7.30` → `7.40`。
- Modify：`changelog.json`：最上面新增一筆。
  - `"7.40": { "summary": "外掛更新清單略過網頁版「設計」分頁的檔案", "items": ["網頁版新增「設計」分頁（平面設計）；它的程式與說明文件只在網頁版使用，外掛更新時不會下載"] }`
- Modify：`test/manifest.test.js`：`7.30` → `7.40`；新增測試「`design-core.js`、`design.css`、`docs/x.md` 在 SKIP 清單，`app.js` 不在」。
- Modify：`CLAUDE.md`：網頁版專用清單加入 `design-*.js/css`、`docs/`。
- Modify：`DESIGN.md`：新增「## 11. 設計（網頁版，`design-*.js`）」，內容是規格第 13 節列的 4 點：為什麼這樣切、接縫、字型載入策略、馬賽克規則。各寫 2～4 句，說法取自規格第 4.2、5、6 節。
- Modify：`README.md`：在網頁版功能的地方補「設計」的用法，5～8 行。
- Modify：規格第 14 節第一列：狀態改為「已決定：隨 7.40 上線，`docs/` 已加入 `SKIP`」。

- [ ] **Step 1：先寫 `test/manifest.test.js` 的新測試與版號斷言。** 執行 `node --test test/manifest.test.js`，預期 FAIL。
- [ ] **Step 2：改 SKIP、`manifest.json`、`changelog.json`。** 再執行 `node --test test/*.test.js`，預期全部 PASS。
- [ ] **Step 3：改文件。** 執行 `git diff --stat origin/main`：外掛會用到的檔案應該只有 `updater.js`、`manifest.json`、`changelog.json`。

### 最後：整分支審查（opus）

- 對照規格第 1 節的成功標準 1～5 和本計畫的 Review Focus，逐項確認有沒有測試或 e2e 證據。
- 確認 `design-*` 裡沒有出現 `Watermark.`、`Deploy.`、`QPTEdit`、`pngCrc32` 等主工具的符號。
- 回報給使用者：測試輸出、兩張截圖、`git diff --stat origin/main`。**不 commit，等使用者說「推」。**

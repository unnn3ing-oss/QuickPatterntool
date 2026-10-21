# QuickPatterntool（圖片套版產生器）— 協作規則

網頁版（GitHub Pages）＋ Chrome MV3 側邊欄外掛，兩邊共用 `app.js`、`style.css`。使用方式見 `README.md`，設計邏輯（為什麼這樣做）見 `DESIGN.md`，改動功能前先讀它，改完要同步更新。

## 溝通
- 一律用**繁體中文（台灣口吻）**，絕不用簡體。
- **結論先行**，再展開；善用標題、粗體、清單、表格。
- 區分「已知事實」和「推論」；決策類問題給多方案優缺比較。

## 作業流程（最重要）
1. **先改好、測好、給我看（截圖／測試結果），不要直接推。**
2. 我明確說「**推**」才推。Stop hook 提醒「有未提交變更」時，回「Not committing until you say OK」並列出變更的檔案，不要因此提交。
3. 說「推」之後依序做：
   1. `git fetch origin main`，把當時的 `origin/main` 推一份備份到 `backup/vX.Y-<簡述>`（版本號是**推之前**的那版）。
   2. commit，結尾加兩行：`Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>` 與 `Claude-Session: <本次 session 連結>`。
   3. 推到開發分支與 `main`（`git push origin HEAD:main`）。
   4. 確認 `HEAD == origin/main`、工作區乾淨。
   5. 回報：推到哪個 commit、備份分支名、外掛怎麼更新、請我確認什麼。
4. 如果 `main` 在別處前進了（push 被拒），把 `origin/main` **merge** 進來（不要 rebase／force），衝突的 `manifest.json`／`changelog.json` 取較新的版本號再 +1，並同步 `test/manifest.test.js`。
5. 沒有我的要求不要開 PR。

## 版本號（`manifest.json` 的 `version`）
| 這次改了什麼 | 遞增 | 例 |
|---|---|---|
| 更改功能或介面（大改版、新增主要功能） | 主版本 +1，後兩位歸零 | `4.52` → `5.00` |
| 部分小功能 | 十位數 +1，個位歸零 | `4.52` → `4.60` |
| 介面完善、小 BUG | 個位數 +1 | `4.52` → `4.53` |

- 混合類型取最大的。數字照一般進位（`4.59` → `4.60`）。
- 升版時同步：
  - `changelog.json` 新增一筆（繁體中文）：`"4.53": { "summary": "一行簡述", "items": ["…"] }`。
  - `test/manifest.test.js` 裡寫死的版本號。
- **只改網頁版專用檔案時不升版**、不動 `manifest.json`／`changelog.json`，外掛才不會跳更新通知。

### 哪些檔案算「外掛會用到」
- 網頁版專用（不升版）：`index.html`、`deploy.js/css`、`watermark.js/css`、`collage.js/css`、`resize.js/css`、`schedweb.js/css`、`favicon*`、`apple-touch-icon*`、`README.md`、`CLAUDE.md`、`DESIGN.md`、`examples/`、`test/`、`.github/`。
- 清單寫在 `updater.js` 和 `deploy.js` 的 `SKIP`，**兩邊必須一致**。新增網頁版專用檔案時要加進去（這會動到 `updater.js`，所以那次要升個位數版號）。
- 推之前用 `git diff --stat origin/main` 檢查有沒有動到外掛檔案。
- `icons/*.png` **不在**略過清單，改圖示會觸發外掛更新。

## 測試
- 單元測試：`node --test test/*.test.js`（要全過）。
- 側邊欄 e2e：`test/sidepanel.e2e.js`。本機沙盒沒有預設瀏覽器，要用暫時的副本加上 `executablePath: '/opt/pw-browsers/chromium'`，跑完刪掉，不要改原檔。
- 瀏覽器自動化（Playwright）用 `/opt/pw-browsers/chromium`，**不要**執行 `playwright install`。沙盒沒有網路，要測 `chrome.tabs.create` 這類行為就 stub 後檢查參數。
- 暫存腳本、截圖放 scratchpad，不要放進專案。

## 外掛更新方式（回報時用）
側邊欄「版本更新」→「檢查更新」→「更新到最新版」。只動到圖示或 `manifest.json` 時，再提醒到 `chrome://extensions` 按重新載入（⟳）。網頁版要等 GitHub Pages 部署 1～2 分鐘，並強制重新整理。

## 其他
- 網頁版在手機寬度本來就會橫向捲動（既有狀況），除非我要求，不處理。
- 熱門新聞庫（`unnn3ing-oss/hottopic`）是另一個專案，這裡只負責 `bridge.js` 這端，不修改它。

# 文章代理（網頁版「快速產圖」在手機上用）

手機的 Chrome 沒有外掛，網頁版的「快速產圖」又不能直接讀 TVBS 的網頁（瀏覽器的跨網域限制），所以由這個 Cloudflare Worker 代為下載文章與圖片。標題、斷行、挑圖、圖說、hashtag 仍在網頁用 `quickfill.js` 解析（跟外掛、側邊欄同一套規則）。

> 和 LinePushPatternTool 的 `og-image-proxy` 是**各自獨立**的 Worker：那個只回「第一張圖」、沒有標題；這個回整份文章 HTML 與指定的圖片，兩邊互不影響。

## 部署步驟（約 5 分鐘，只做一次）

1. 登入 <https://dash.cloudflare.com>（跟 `og-image-proxy` 同一個帳號）。
2. **Workers & Pages** → **Create** → **Create Worker**，名稱**一定要填 `qpt-article-proxy`** → **Deploy**。
3. 按 **Edit code**，把編輯器裡的內容**全部刪掉**，貼上 `worker.mjs` 的全部內容 → 右上角 **Deploy**。
4. 完成。網址會是 `https://qpt-article-proxy.19jpz-3.workers.dev`（跟 `og-image-proxy` 同一個帳號子網域），網頁已經預設連這個網址，不用再設定。
   - 如果帳號子網域或 Worker 名稱不同，要同步改 `qfweb.js` 的 `PROXY` 與 `index.html` 的 CSP `connect-src`（`test/manifest.test.js` 會檢查兩邊一致）。

## 驗證

- 瀏覽器直接開 `https://qpt-article-proxy.19jpz-3.workers.dev/article?url=https://news.tvbs.com.tw/…` 會看到 `{"ok":false,"error":"這個網頁不在允許名單內"…}`——這是正常的（只接受來自網頁版的請求）。
- 手機開網頁版，在圖片卡片的「快速產圖」貼上 TVBS 文章網址按 Enter，應該會顯示「完成：標題、圖片都帶入了」。

## 安全限制（程式裡寫死的）

| 項目 | 規則 |
|---|---|
| 網域 | 只允許 `https://`、`tvbs.com.tw`（含子網域），文章與圖片都一樣；網址不能帶帳密 |
| 轉址 | 手動跟著走，**每一跳**都重新檢查網域，轉去別的網站就停止（不會對該網站發出請求） |
| 來源 | 只接受 `https://unnn3ing-oss.github.io`（和本機 `localhost:8000`）網頁的瀏覽器請求；沒有 `Origin` 或不在名單內一律 403 |
| 大小與時間 | 文章 ≤ 5MB、12 秒；圖片 ≤ 20MB、18 秒；超過就中止 |
| 圖片類型 | `content-type` 必須是 png／jpeg／webp／gif／avif／bmp（SVG、HTML 一律不收） |

Cloudflare 免費方案每天 10 萬次請求，遠超過使用量。要放寬網域時改 `worker.mjs` 的 `ALLOWED_HOST_SUFFIX`（並重新評估風險）。

# 輕境健康平衡工作室 — 簽到 app 專案說明

## 專案結構
- `index.html`：簽到 app 主程式（單檔）；`qj-sw.js`：Service Worker
- `line-webhook/`：LINE 機器人與排程 API（Vercel）
- `scripts/`：排程腳本（GC 漏簽比對、備份、IG 企劃等）
- `.github/workflows/`：GitHub Actions（每日備份等）
- `.claude/agents/`：subagent 團隊（營運長、簽到系統工程師、系統健檢員…）

## 部署（很容易忘）
- `index.html` / `qj-sw.js`：**push 到 main 就自動部署 GitHub Pages**
- `line-webhook/` 改完：**一定要手動 `vercel --prod`**，只 push 到 GitHub 不會部署
- Vercel 時區是 UTC，處理日期時間一律用 Asia/Taipei 換算

## 操作正式站的紅線
- 正式站資料極度小心：分頁留在背景會整包覆蓋其他裝置的新寫入
- LINE 查詢課卡必須與紙本 100% 相符（已使用堂數、簽到記錄口徑要一致，已封存 archived 的舊期記錄不可混入）
- 日曆取消課程靠標題文字判斷，不是 STATUS
- 危險操作（刪資料、覆蓋整包）先問用戶

## 修正記錄規則（必做）
- 所有待修問題與已完成修正都記在 [`TODO_CHANGELOG.md`](TODO_CHANGELOG.md)
- 開始修之前：先讀該檔，確認是否已修過、是否有相關待修項目
- 修完之後：**一定要**在「已完成」補一筆（日期、改了什麼、原因、commit），並把「待修」對應項目移走
- 修正流程可用 `/qj-fix <問題描述>`

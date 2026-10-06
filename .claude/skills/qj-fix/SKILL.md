---
name: qj-fix
description: 修正輕境簽到 app（index.html / line-webhook / scripts）的問題時使用。固定流程：先讀 TODO_CHANGELOG.md 查重 → 修改 → 提醒部署 → 補記錄。用戶描述 app 的 bug 或想調整的功能時都用這個。
---

# 輕境 app 修正流程

用戶的問題：$ARGUMENTS

## 步驟

1. **讀 `CLAUDE.md` 與 `TODO_CHANGELOG.md`**
   - 在「已完成」搜尋相關關鍵字：以前是否修過同一處？（是的話，先看那次的 commit 與原因，避免改回去）
   - 在「待修」看有沒有相關項目，一併處理
2. **定位並修改**
   - 先讀相關程式碼再改；遵守 CLAUDE.md 的紅線（正式站資料、課卡口徑、Asia/Taipei 時區）
   - 改動盡量小，不順手重構
3. **驗證**：能跑就跑（本機預覽或腳本 dry-run），說明驗證了什麼、沒驗證什麼
4. **commit**：訊息寫清楚「修了什麼＋原因」
5. **部署提醒**
   - 只改 `index.html` / `qj-sw.js` → push main 即部署
   - 改了 `line-webhook/` → 必須手動 `vercel --prod`（不要只 push）
   - 推送或部署前先向用戶確認
6. **更新 `TODO_CHANGELOG.md`**（不可省略）
   - 「已完成」最上方（對應月份）加一行：`日期｜改了什麼｜原因｜commit`
   - 「待修」中已處理的項目移除
   - 若修的過程發現其他問題但這次沒處理，加到「待修」
7. 回報：改了什麼、是否已部署、還有什麼待修

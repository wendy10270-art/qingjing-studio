# line-webhook

兩支 Vercel serverless function，一起支援「上課前一天 LINE 提醒」：

- **`api/webhook.js`** — LINE Messaging API webhook：學員加官方帳號好友後回覆手機號碼，綁定 LINE `userId`。中英文都支援：打「提醒」／「綁定」用中文流程，打「remind」／「bind」用英文流程（供外國學員使用），觸發語言會存進綁定資料，之後的提醒訊息也會用同一種語言發送。同一支 function 也處理「我要體驗」對話式收集流程（見下方說明）。
- **`api/confirm-send.js`** — 每天 18:00 `scripts/line_reminder.py` 會準備好明天的提醒內容，用 ntfy 通知店長預覽＋附一顆「確認送出」按鈕；店長點下去才會呼叫這支 function 真的推播給學員。**不會有人沒看過內容就自動發送。**
- **`api/send-payroll-email.js`** — 「薪資結算」分頁按「📧 寄送Email」時呼叫，把 index.html 已經排版好的 HTML 薪資明細，透過 Gmail SMTP（nodemailer）寄到老師信箱。用 Gmail 而不是 Resend 之類的服務，是因為工作室沒有自己的網域——Resend 沒驗證網域的話只能寄給帳號自己的信箱，Gmail + App 密碼則不受此限制。
- **`api/backup-db.js`** — 每日全庫自動備份用。由 GitHub Actions（`.github/workflows/daily-backup.yml`）每天凌晨排程呼叫，伺服器端用 Admin SDK 把 `qingjing`（s/r/sch/t/l）+ `qingjing_ledger` 整包讀出來，存進 Firebase 的 `qingjing_backups/{yyyy-mm-dd}` 節點（30 天內自動輪替），不落地存本機、不進 git——這個 repo 是公開的，備份裡有學員個資。背景：2026-09-18 學員「盧韻如」的主檔被永久刪除、事後救不回來，才發現系統從來沒有排程備份。

綁定資料寫在獨立的 Firebase 節點 `qingjing_line_bindings`（電話末8碼 → `{userId,name,boundAt}`），待確認的當日批次寫在 `qingjing_line_pending`；兩者都不會動到 `qingjing/s` 學員陣列。

## 「我要體驗」對話式收集流程

新同學在跟官方帳號的對話裡打「我要體驗」（精確比對，之後可以把 LINE OA 選單按鈕設成傳送這句文字；也支援英文版，打「trial」直接進英文流程），全程用「阿勇店長」第一人稱口吻問問題，開場會附一張阿勇的照片（`public/along3.png`，去背+quick reply 一起送出，見 `lineReplyImageAndQuick`）。

打「我要體驗」（中文關鍵字）會先問一次語言（中文／English），選完才正式開始問；打「trial」則直接跳過語言選擇、進英文版。流程依序問：

1. 想體驗哪一種課程（器械皮拉提斯／重訓課程／瑜珈課程／不確定請幫我推薦——選「不確定」會先跳課程介紹再重選一次）
2. 上課人數（一對一／一對二可揪1位朋友／一對三可揪2位朋友）
3. 方便上課的時段（Quick Reply 按鈕，可以連續點選多個，選好後點「都選好了」，也接受直接打字）
4. 之前有沒有上過 Pilates 器械課程（完全沒有／上過團體課／上過一對一，選了後兩者會追問大概上多久）
5. 目前的舊傷／不適（開放式文字，沒有請填「無」）
6. 近期手術或特別醫療狀況（開放式文字，沒有請填「無」）
7. 平常運動習慣頻率（無規律／每週1~2次／每週3次以上）
8. 這次想透過課程達成的目標（開放式文字）

回答到一半可以打「取消」/ "cancel" 中止；中途再打一次關鍵字（中或英文都可）會直接重啟整個流程。中途狀態存在 Firebase `qingjing_trial_flow/{convoKey}`，30 分鐘沒動作就視為放棄。全部答完後，會整理成一則訊息用 LINE push message 直接推播給工作室負責人（`OWNER_LINE_USER_IDS`，可以設多個人），格式跟既有「新場租已登記」通知一樣走 LINE Messaging API 直接 push，不寫入日曆、不建立學員檔案、不做老師配對——後續媒合老師/時間由負責人自己接手。

這個流程完全獨立於「提醒/綁定」跟「查詢/課卡」關鍵字，進行中不會被那些關鍵字打斷。

## 部署

```
cd line-webhook
vercel --prod
```

部署後會拿到一個網址，例如 `https://<你的專案>.vercel.app`：

- Webhook URL：`https://<你的專案>.vercel.app/api/webhook`
- 確認送出 URL：`https://<你的專案>.vercel.app/api/confirm-send`

## 環境變數（Vercel 專案設定 → Environment Variables）

- `LINE_CHANNEL_ACCESS_TOKEN` — LINE Developers Console → Messaging API 頁「發行」的長期權杖（`webhook.js` 回覆綁定訊息、`confirm-send.js` 推播提醒都會用到）
- `LINE_CHANNEL_SECRET` — LINE Developers Console → 基本設定頁（`webhook.js` 驗證來源用）
- `CONFIRM_SECRET` — 自己設一組隨機字串即可，用來保護「確認送出」網址不被亂猜到亂觸發
- `FIREBASE_SERVICE_ACCOUNT_KEY` — 所有 function 存取 Firebase 都是透過 `lib/firebaseAdmin.js`（Admin SDK），不再用裸 REST API + 公開 API Key。這個變數的值是 Firebase 主控台「專案設定 → 服務帳戶 → 產生新的私密金鑰」下載的整包 JSON 內容，貼進去存成一個環境變數即可。這把金鑰等同資料庫最高權限，只能存在這裡（Vercel 加密環境變數），不能出現在程式碼或任何公開頁面裡。
- `GMAIL_USER` — 拿來寄薪資明細信的 Gmail 帳號（例如 `motivation.studio.226@gmail.com`）。
- `GMAIL_APP_PASSWORD` — 該 Gmail 帳號的「應用程式密碼」，不是登入密碼。要先在該 Google 帳號開啟兩步驟驗證，再到 [myaccount.google.com/apppasswords](https://myaccount.google.com/apppasswords) 產生一組 16 碼專用密碼，隨時可以到同一頁面收回。
- `EMAIL_PUSH_SECRET` — 自己設一組隨機字串即可，保護這支寄信 API 不被亂猜到亂觸發（跟 `CHECKIN_PUSH_SECRET`／`TEACHER_PUSH_SECRET` 分開設，外流互不影響）。
- `OWNER_LINE_USER_IDS` — 「我要體驗」流程收集完資料要推播通知的工作室負責人 LINE userId，多個人用逗號分隔（例如 `Uxxxx1,Uxxxx2`）。取得方式：每個要收到通知的人都要在跟官方帳號的 1 對 1 對話裡打「我的ID」，bot 會把各自的 userId 回傳，複製貼上、用逗號接起來存成這個環境變數。沒設定的話流程照樣能跑完、學員看得到完成訊息，只是不會推播給任何人（會留在 log 裡）。（舊的 `OWNER_LINE_USER_ID`〔單數〕仍相容，會自動併入。）
- `BACKUP_SECRET` — 自己設一組隨機字串即可，保護 `api/backup-db.js` 不被亂猜到亂觸發（跟 `CHECKIN_PUSH_SECRET`／`GC_BACKFILL_DB_SECRET`／`SCRIPTS_DB_SECRET` 分開設，外流互不影響）。GitHub Actions 那邊要設同一組字串到 repo secret `BACKUP_SECRET`。

## 接上 LINE

LINE Developers Console → Messaging API → Webhook URL 貼上 `api/webhook` 網址 → 按「Verify」確認 200 → 打開「Use webhook」。

## 接上 GitHub Actions

`scripts/line_reminder.py` 需要知道「確認送出」的網址和密鑰，才能把按鈕放進 ntfy 通知裡。在 GitHub repo 設定這兩個 secret：

- `CONFIRM_URL` — 上面的 `api/confirm-send` 網址
- `CONFIRM_SECRET` — 和 Vercel 上設定的同一組字串

（`NTFY_TOPIC` 沿用既有的 secret，跟 `daily_digest.py` 共用同一個 ntfy 主題。）

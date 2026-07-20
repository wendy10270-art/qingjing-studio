# line-webhook

兩支 Vercel serverless function，一起支援「上課前一天 LINE 提醒」：

- **`api/webhook.js`** — LINE Messaging API webhook：學員加官方帳號好友後回覆手機號碼，綁定 LINE `userId`。中英文都支援：打「提醒」／「綁定」用中文流程，打「remind」／「bind」用英文流程（供外國學員使用），觸發語言會存進綁定資料，之後的提醒訊息也會用同一種語言發送。
- **`api/confirm-send.js`** — 每天 18:00 `scripts/line_reminder.py` 會準備好明天的提醒內容，用 ntfy 通知店長預覽＋附一顆「確認送出」按鈕；店長點下去才會呼叫這支 function 真的推播給學員。**不會有人沒看過內容就自動發送。**
- **`api/send-payroll-email.js`** — 「薪資結算」分頁按「📧 寄送Email」時呼叫，把 index.html 已經排版好的 HTML 薪資明細，透過 Gmail SMTP（nodemailer）寄到老師信箱。用 Gmail 而不是 Resend 之類的服務，是因為工作室沒有自己的網域——Resend 沒驗證網域的話只能寄給帳號自己的信箱，Gmail + App 密碼則不受此限制。

綁定資料寫在獨立的 Firebase 節點 `qingjing_line_bindings`（電話末8碼 → `{userId,name,boundAt}`），待確認的當日批次寫在 `qingjing_line_pending`；兩者都不會動到 `qingjing/s` 學員陣列。

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

## 接上 LINE

LINE Developers Console → Messaging API → Webhook URL 貼上 `api/webhook` 網址 → 按「Verify」確認 200 → 打開「Use webhook」。

## 接上 GitHub Actions

`scripts/line_reminder.py` 需要知道「確認送出」的網址和密鑰，才能把按鈕放進 ntfy 通知裡。在 GitHub repo 設定這兩個 secret：

- `CONFIRM_URL` — 上面的 `api/confirm-send` 網址
- `CONFIRM_SECRET` — 和 Vercel 上設定的同一組字串

（`NTFY_TOPIC` 沿用既有的 secret，跟 `daily_digest.py` 共用同一個 ntfy 主題。）

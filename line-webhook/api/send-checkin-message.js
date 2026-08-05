// Called from index.html's check-in success screen when staff taps "傳送 LINE 訊息".
// Looks up the LINE binding for a phone number and pushes a one-off text message
// immediately — this is a real-time, staff-initiated send (not the batched/confirmed
// daily reminder flow in confirm-send.js), so no separate confirm step is needed here;
// the tap itself IS the confirmation.

const { fb } = require('../lib/firebaseAdmin');

const CHANNEL_ACCESS_TOKEN = process.env.LINE_CHANNEL_ACCESS_TOKEN || '';
// Separate from CONFIRM_SECRET on purpose: this key is embedded client-side in index.html
// (GitHub Pages is fully public), so it's visible to anyone who views page source. Keeping
// it distinct from CONFIRM_SECRET means a leak here can't be used to trigger the daily
// batch-reminder confirm endpoint too.
const CHECKIN_PUSH_SECRET = process.env.CHECKIN_PUSH_SECRET || '';
// 阿勇（店長的狗）照片，跟課後訊息一起送，served from this same Vercel project's /public
// 2026-07-16：換成一組 8 張不同表情的去背貼圖，每次隨機挑一張送（*_preview.png 是縮圖版，
// LINE 的 previewImageUrl 限制檔案要 <=1MB，原圖有幾張超過，所以另外存一份縮圖當預覽用）
const SEND_ALONG_IMAGE = true;
const ALONG_IMAGES = Array.from({ length: 8 }, (_, i) => ({
  original: `https://line-webhook-gules.vercel.app/along${i + 1}.png`,
  preview: `https://line-webhook-gules.vercel.app/along${i + 1}_preview.png`,
}));
function pickAlongImage() {
  return ALONG_IMAGES[Math.floor(Math.random() * ALONG_IMAGES.length)];
}

function phoneKey(phone) {
  const digits = (phone || '').replace(/\D/g, '');
  return digits.length >= 8 ? digits.slice(-8) : null;
}

// 一對二/一對三共用群組時，綁定記的是 groupId/roomId，不是打字那個人的 userId；
// push 的 "to" 三種 ID 用法完全一樣，只要挑對哪一個存在就好。
function bindingTarget(binding) {
  return binding.groupId || binding.roomId || binding.userId;
}

async function pushLine(to, text) {
  const messages = [{ type: 'text', text }];
  if (SEND_ALONG_IMAGE) {
    const img = pickAlongImage();
    messages.push({ type: 'image', originalContentUrl: img.original, previewImageUrl: img.preview });
  }
  const res = await fetch('https://api.line.me/v2/bot/message/push', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${CHANNEL_ACCESS_TOKEN}`,
    },
    body: JSON.stringify({ to, messages }),
  });
  if (!res.ok) throw new Error(`LINE push failed: ${res.status} ${await res.text()}`);
}

module.exports = async (req, res) => {
  // index.html 呼叫這支 API 是跨網域請求（GitHub Pages → Vercel），瀏覽器一定會先送 OPTIONS
  // 預檢，沒有正確回應 CORS 標頭的話，瀏覽器會直接擋掉，連真正的 POST 都不會送出去
  // （Safari/PWA 上就是「FetchEvent.respondWith received an error: TypeError: Load failed」）。
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.status(204).end();
    return;
  }
  if (req.method !== 'POST') {
    res.status(405).send('method not allowed');
    return;
  }
  if (!CHECKIN_PUSH_SECRET || req.query.key !== CHECKIN_PUSH_SECRET) {
    res.status(403).send('forbidden');
    return;
  }
  if (!CHANNEL_ACCESS_TOKEN) {
    res.status(500).json({ ok: false, error: 'LINE_CHANNEL_ACCESS_TOKEN 未設定' });
    return;
  }

  const { phone, message, previewAllAlongImages } = req.body || {};
  const key = phoneKey(phone);
  if (!key || (!message && !previewAllAlongImages)) {
    res.status(400).json({ ok: false, error: '缺少 phone 或 message' });
    return;
  }
  // CHECKIN_PUSH_SECRET 是嵌在前端原始碼裡的（GitHub Pages 全公開，任何人都看得到這把鑰匙），
  // 拿到鑰匙的人目前能自訂 message 內容、冒充工作室發任意文字給任何已綁定的學員。
  // 這裡加兩層淺層防護：訊息長度上限（擋大量灌水/釣魚長文），跟每個學員的簡單發送頻率限制
  // （擋同一支電話短時間被連續轟炸）。不是完整解法（真正解法是把 Database 規則收緊、
  // 讓瀏覽器端改走 App Check 驗證），但能大幅降低鑰匙外洩後的濫用規模。
  if (message && message.length > 1000) {
    res.status(400).json({ ok: false, error: '訊息過長' });
    return;
  }

  let binding;
  try {
    binding = await fb(`/qingjing_line_bindings/${key}`, { method: 'GET' });
  } catch (e) {
    res.status(500).json({ ok: false, error: '查詢綁定失敗：' + e.message });
    return;
  }
  if (!previewAllAlongImages) {
    try {
      const lastSent = await fb(`/qingjing_checkin_push_ratelimit/${key}`, { method: 'GET' });
      const now = Date.now();
      if (lastSent && now - lastSent < 10000) {
        res.status(429).json({ ok: false, error: '發送太頻繁，請稍候再試' });
        return;
      }
      await fb(`/qingjing_checkin_push_ratelimit/${key}`, { method: 'PUT', body: JSON.stringify(now) });
    } catch (e) {
      // 頻率限制檢查失敗不該擋住正常簽到訊息發送，記錄下來繼續走正常流程
      console.warn('rate limit check failed:', e.message);
    }
  }
  const to = binding && bindingTarget(binding);
  if (!to) {
    res.status(200).json({ ok: false, error: 'notBound' });
    return;
  }

  // 一次性除錯用途：把全部阿勇貼圖選項送給同一人看，方便店長挑圖，不是正常簽到流程會走的路徑
  if (previewAllAlongImages) {
    try {
      // LINE push 每次最多 5 則訊息，每張圖片配一則文字標號＝2 則，一批最多放 2 張圖（4 則）
      for (let i = 0; i < ALONG_IMAGES.length; i += 2) {
        const batch = ALONG_IMAGES.slice(i, i + 2);
        const messages = batch.flatMap((img, idx) => [
          { type: 'text', text: `第 ${i + idx + 1} 張` },
          { type: 'image', originalContentUrl: img.original, previewImageUrl: img.preview },
        ]);
        await fetch('https://api.line.me/v2/bot/message/push', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${CHANNEL_ACCESS_TOKEN}` },
          body: JSON.stringify({ to, messages }),
        });
      }
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
      return;
    }
    res.status(200).json({ ok: true, sent: ALONG_IMAGES.length });
    return;
  }

  try {
    await pushLine(to, message);
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
    return;
  }

  res.status(200).json({ ok: true });
};

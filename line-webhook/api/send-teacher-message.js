// Called from index.html when the store manager confirms a prepaid-rent deduction
// (gcRentSavePrepaid) — pushes "已扣1堂，剩餘N堂" straight to the teacher's LINE,
// same real-time/no-confirm-step reasoning as send-checkin-message.js (the manager's
// tap in the settle screen IS the confirmation).
//
// Looks up qingjing_line_bindings_teacher (separate from the student-facing
// qingjing_line_bindings) so a teacher and a student sharing a phone's last 8 digits
// can never resolve to each other's binding.

const { fb } = require('../lib/firebaseAdmin');

const CHANNEL_ACCESS_TOKEN = process.env.LINE_CHANNEL_ACCESS_TOKEN || '';
// Separate from CHECKIN_PUSH_SECRET/CONFIRM_SECRET on purpose — this key is embedded
// client-side in index.html (GitHub Pages is fully public), so isolating it means a
// leak here can't be used to trigger the other push endpoints too.
const TEACHER_PUSH_SECRET = process.env.TEACHER_PUSH_SECRET || '';

// 跟 send-checkin-message.js 一樣附上阿勇（店長的狗）貼圖，維持「阿勇店長」人設一致——
// 只要是這隻狗簽名發的訊息就都附一張，不分學員版還是老師版
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

function bindingTarget(binding) {
  return binding.groupId || binding.roomId || binding.userId;
}

async function pushLine(to, text) {
  const img = pickAlongImage();
  const messages = [
    { type: 'text', text },
    { type: 'image', originalContentUrl: img.original, previewImageUrl: img.preview },
  ];
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
  if (!TEACHER_PUSH_SECRET || req.query.key !== TEACHER_PUSH_SECRET) {
    res.status(403).send('forbidden');
    return;
  }
  if (!CHANNEL_ACCESS_TOKEN) {
    res.status(500).json({ ok: false, error: 'LINE_CHANNEL_ACCESS_TOKEN 未設定' });
    return;
  }

  const { phone, message } = req.body || {};
  const key = phoneKey(phone);
  if (!key || !message) {
    res.status(400).json({ ok: false, error: '缺少 phone 或 message' });
    return;
  }

  let binding;
  try {
    binding = await fb(`/qingjing_line_bindings_teacher/${key}`, { method: 'GET' });
  } catch (e) {
    res.status(500).json({ ok: false, error: '查詢綁定失敗：' + e.message });
    return;
  }
  const to = binding && bindingTarget(binding);
  if (!to) {
    res.status(200).json({ ok: false, error: 'notBound' });
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

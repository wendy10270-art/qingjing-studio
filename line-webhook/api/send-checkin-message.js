// Called from index.html's check-in success screen when staff taps "傳送 LINE 訊息".
// Looks up the LINE binding for a phone number and pushes a one-off text message
// immediately — this is a real-time, staff-initiated send (not the batched/confirmed
// daily reminder flow in confirm-send.js), so no separate confirm step is needed here;
// the tap itself IS the confirmation.

const FB_URL = 'https://qingjing-studio-default-rtdb.firebaseio.com';
const FB_API_KEY = 'AIzaSyBg3_toi-Kqyi9iw2IbW9C5HhkbgJappxI';
const CHANNEL_ACCESS_TOKEN = process.env.LINE_CHANNEL_ACCESS_TOKEN || '';
// Separate from CONFIRM_SECRET on purpose: this key is embedded client-side in index.html
// (GitHub Pages is fully public), so it's visible to anyone who views page source. Keeping
// it distinct from CONFIRM_SECRET means a leak here can't be used to trigger the daily
// batch-reminder confirm endpoint too.
const CHECKIN_PUSH_SECRET = process.env.CHECKIN_PUSH_SECRET || '';
// 阿勇（店長的狗）照片，跟課後訊息一起送，served from this same Vercel project's /public
const ALONG_IMAGE_URL = 'https://line-webhook-gules.vercel.app/along.png';

async function fb(path, opts) {
  const res = await fetch(`${FB_URL}${path}.json?auth=${FB_API_KEY}`, opts);
  if (!res.ok) throw new Error(`Firebase ${path} failed: ${res.status}`);
  return res.json();
}

function phoneKey(phone) {
  const digits = (phone || '').replace(/\D/g, '');
  return digits.length >= 8 ? digits.slice(-8) : null;
}

async function pushLine(userId, text) {
  const messages = [
    { type: 'text', text },
    { type: 'image', originalContentUrl: ALONG_IMAGE_URL, previewImageUrl: ALONG_IMAGE_URL },
  ];
  const res = await fetch('https://api.line.me/v2/bot/message/push', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${CHANNEL_ACCESS_TOKEN}`,
    },
    body: JSON.stringify({ to: userId, messages }),
  });
  if (!res.ok) throw new Error(`LINE push failed: ${res.status} ${await res.text()}`);
}

module.exports = async (req, res) => {
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

  const { phone, message } = req.body || {};
  const key = phoneKey(phone);
  if (!key || !message) {
    res.status(400).json({ ok: false, error: '缺少 phone 或 message' });
    return;
  }

  let binding;
  try {
    binding = await fb(`/qingjing_line_bindings/${key}`, { method: 'GET' });
  } catch (e) {
    res.status(500).json({ ok: false, error: '查詢綁定失敗：' + e.message });
    return;
  }
  if (!binding || !binding.userId) {
    res.status(200).json({ ok: false, error: 'notBound' });
    return;
  }

  try {
    await pushLine(binding.userId, message);
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
    return;
  }

  res.status(200).json({ ok: true });
};

// Triggered by the "確認送出" action button on the ntfy preview notification
// that scripts/line_reminder.py sends every day at 18:00. Nothing goes out to
// students until this endpoint runs — it reads the pending batch that script
// wrote to Firebase and actually pushes each LINE message.
//
// item.userId despite the name may hold a groupId/roomId instead of a personal
// userId (for shared 1-on-2/1-on-3 students bound to a LINE group) — LINE's
// push "to" field works identically for all three ID types, so no branching
// needed here; see line_reminder.py's resolution of `to`.

const FB_URL = 'https://qingjing-studio-default-rtdb.firebaseio.com';
const FB_API_KEY = 'AIzaSyBg3_toi-Kqyi9iw2IbW9C5HhkbgJappxI';
const CHANNEL_ACCESS_TOKEN = process.env.LINE_CHANNEL_ACCESS_TOKEN || '';
const CONFIRM_SECRET = process.env.CONFIRM_SECRET || '';

async function fb(path, opts) {
  const res = await fetch(`${FB_URL}${path}.json?auth=${FB_API_KEY}`, opts);
  if (!res.ok) throw new Error(`Firebase ${path} failed: ${res.status}`);
  return res.json();
}

async function pushLine(userId, text) {
  const res = await fetch('https://api.line.me/v2/bot/message/push', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${CHANNEL_ACCESS_TOKEN}`,
    },
    body: JSON.stringify({ to: userId, messages: [{ type: 'text', text }] }),
  });
  if (!res.ok) throw new Error(`LINE push failed: ${res.status} ${await res.text()}`);
}

module.exports = async (req, res) => {
  if (!CONFIRM_SECRET || req.query.key !== CONFIRM_SECRET) {
    res.status(403).send('forbidden');
    return;
  }
  if (!CHANNEL_ACCESS_TOKEN) {
    res.status(500).send('LINE_CHANNEL_ACCESS_TOKEN 未設定');
    return;
  }

  let pending;
  try {
    pending = await fb('/qingjing_line_pending', { method: 'GET' });
  } catch (e) {
    res.status(500).send('讀取待確認清單失敗：' + e.message);
    return;
  }

  if (!pending || !pending.items || !pending.items.length) {
    res.status(200).send('沒有待確認的提醒');
    return;
  }
  if (pending.sentAt) {
    res.status(200).send('這批提醒已經送出過了，不會重複發送');
    return;
  }

  // 先標記已送出，降低被連點兩下造成重複推播的機會
  try {
    await fb('/qingjing_line_pending', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sentAt: Date.now() }),
    });
  } catch (e) {
    res.status(500).send('標記已送出失敗，請勿重試以免重複推播：' + e.message);
    return;
  }

  let ok = 0;
  let fail = 0;
  for (const item of pending.items) {
    try {
      await pushLine(item.userId, item.text);
      ok++;
    } catch (e) {
      console.error('push failed', item.name, e);
      fail++;
    }
  }

  res.status(200).send(`已送出 ${ok} 則${fail ? `，${fail} 則失敗` : ''}`);
};

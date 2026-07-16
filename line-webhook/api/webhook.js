// LINE Messaging API webhook — binds a student's LINE userId to their phone
// number so scripts/line_reminder.py can push personal class reminders.
//
// Binding data lives in its own top-level Firebase node (qingjing_line_bindings),
// separate from the qingjing/s student array. The main app overwrites the whole
// `s` array on every save() (see index.html doFirebaseWrite), so writing directly
// into a student record here would race with that and could silently get clobbered.

const crypto = require('crypto');

const FB_URL = 'https://qingjing-studio-default-rtdb.firebaseio.com';
const FB_API_KEY = 'AIzaSyBg3_toi-Kqyi9iw2IbW9C5HhkbgJappxI';
const CHANNEL_SECRET = process.env.LINE_CHANNEL_SECRET || '';
const CHANNEL_ACCESS_TOKEN = process.env.LINE_CHANNEL_ACCESS_TOKEN || '';

module.exports.config = { api: { bodyParser: false } };

function readRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function verifySignature(rawBody, signature) {
  if (!signature || !CHANNEL_SECRET) return false;
  const expected = crypto.createHmac('sha256', CHANNEL_SECRET).update(rawBody).digest('base64');
  const a = Buffer.from(expected);
  const b = Buffer.from(signature);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

async function fb(path, opts) {
  const res = await fetch(`${FB_URL}${path}.json?auth=${FB_API_KEY}`, opts);
  if (!res.ok) throw new Error(`Firebase ${path} failed: ${res.status}`);
  return res.json();
}

// Mirrors the phone matching already used in index.html (s.phone.replace(/\D/g,'').slice(-8))
function normalizePhone(text) {
  const digits = (text || '').replace(/\D/g, '');
  return digits.length >= 8 ? digits.slice(-8) : null;
}

// 共用課卡（同一個學員卡有多人一起用，如 altRecipients：[{name,phone}]）時，
// 每一位額外的使用者也要能用自己的手機號碼綁定自己的 LINE
function matchesPhone(s, last8) {
  const p1 = s.phone && s.phone.replace(/\D/g, '').slice(-8);
  if (p1 === last8) return true;
  return (s.altRecipients || []).some((r) => r && r.phone && r.phone.replace(/\D/g, '').slice(-8) === last8);
}

async function findStudentsByPhone(last8) {
  const students = (await fb('/qingjing/s', { method: 'GET' })) || [];
  return students.filter((s) => s && matchesPhone(s, last8));
}

// dest 是 {userId} 或 {groupId} 或 {roomId} 三選一——一對二/一對三共用群組時，
// 通知要發到整個群組，不是打字的那個人的私人帳號，所以綁的是 groupId 不是 userId。
async function bindPhone(last8, dest, name, lang) {
  await fb(`/qingjing_line_bindings/${last8}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...dest, name, boundAt: Date.now(), lang }),
  });
}

async function unbindUserId(userId) {
  const bindings = (await fb('/qingjing_line_bindings', { method: 'GET' })) || {};
  const key = Object.keys(bindings).find((k) => bindings[k] && bindings[k].userId === userId);
  if (key) await fb(`/qingjing_line_bindings/${key}`, { method: 'DELETE' });
}

// bot 被踢出群組/多人聊天室時，把綁在那個 groupId/roomId 上的綁定也一起清掉，
// 不然店家以為還在通知，其實 bot 早就不在群組裡了，訊息根本送不到
async function unbindConvo(id) {
  const bindings = (await fb('/qingjing_line_bindings', { method: 'GET' })) || {};
  const key = Object.keys(bindings).find(
    (k) => bindings[k] && (bindings[k].groupId === id || bindings[k].roomId === id)
  );
  if (key) await fb(`/qingjing_line_bindings/${key}`, { method: 'DELETE' });
}

// 「有沒有剛打過關鍵字、正在等對方回電話號碼」的暫存狀態，10 分鐘內有效。
// 連語言一起記，因為關鍵字（決定語言）跟電話號碼是兩則分開的訊息。
// key 是「這個對話」的識別碼——群組/多人聊天室用 groupId/roomId（同一群組裡誰打關鍵字都算數，
// 因為接下來的電話號碼也可能是另一個人代打），個人對話才用 userId。
const PENDING_BIND_TTL_MS = 10 * 60 * 1000;

async function getPendingBind(convoKey) {
  const v = await fb(`/qingjing_line_pending_bind/${convoKey}`, { method: 'GET' });
  if (!v || typeof v.ts !== 'number' || Date.now() - v.ts >= PENDING_BIND_TTL_MS) return null;
  return v;
}

async function setPendingBind(convoKey, lang) {
  await fb(`/qingjing_line_pending_bind/${convoKey}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ts: Date.now(), lang }),
  });
}

async function clearPendingBind(convoKey) {
  await fb(`/qingjing_line_pending_bind/${convoKey}`, { method: 'DELETE' });
}

async function lineReply(replyToken, text) {
  if (!CHANNEL_ACCESS_TOKEN) return;
  await fetch('https://api.line.me/v2/bot/message/reply', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${CHANNEL_ACCESS_TOKEN}`,
    },
    body: JSON.stringify({ replyToken, messages: [{ type: 'text', text }] }),
  });
}

const KEYWORDS_ZH = ['提醒', '綁定'];
const KEYWORDS_EN = ['remind', 'reminder', 'bind', 'register'];

const GREETING_TEXT =
  '嗨，歡迎加入輕境 🌿\n如果想開啟「上課前一天 LINE 提醒」，請輸入「提醒」開始綁定。\n\n' +
  'Hi, welcome to Motivation Studio 🌿\nTo turn on class reminders (sent the day before), please type "remind" to get started.';

const MSG = {
  zh: {
    askPhone: '請直接輸入您在工作室登記的手機號碼（例如 0912345678），完成上課前一天的提醒綁定 🌿',
    notPhone: '這不像手機號碼喔，麻煩重新輸入「提醒」再試一次。',
    lookupError: '系統暫時無法查詢，請稍後再試一次，或直接聯繫工作室。',
    notFound: '找不到對應的學員資料，麻煩直接聯繫工作室確認登記的電話號碼喔 🙏',
    ambiguous: '這支電話對到多位不同的學員資料，麻煩直接聯繫工作室確認喔 🙏',
    bindError: '綁定時發生問題，請稍後再試一次，或直接聯繫工作室。',
    bindSuccess: (name) => `✅ 綁定成功，${name}！之後上課前一天會提醒您唷 🌿`,
  },
  en: {
    askPhone: 'Please enter the phone number registered with the studio (e.g. 0912345678) to complete your class reminder registration 🌿',
    notPhone: 'That doesn\'t look like a phone number. Please type "remind" again to retry.',
    lookupError: 'Lookup is temporarily unavailable, please try again shortly or contact the studio directly.',
    notFound: 'We couldn\'t find a matching record. Please contact the studio to confirm your registered phone number 🙏',
    ambiguous: 'This phone number matches multiple different student records. Please contact the studio to confirm 🙏',
    bindError: 'Something went wrong while registering, please try again or contact the studio directly.',
    bindSuccess: (name) => `✅ Registered successfully, ${name}! We'll remind you the day before your class 🌿`,
  },
};

async function handleEvent(event) {
  if (event.type === 'unfollow') {
    await unbindUserId(event.source.userId).catch((e) => console.error('unbind error', e));
    return;
  }

  // bot 被踢出群組/多人聊天室：清掉綁在這個對話上的綁定，避免之後還誤以為能發到這裡
  if (event.type === 'leave' || event.type === 'memberLeave') {
    const id = event.source.groupId || event.source.roomId;
    if (id) await unbindConvo(id).catch((e) => console.error('unbind convo error', e));
    return;
  }

  if (event.type === 'follow') {
    await lineReply(event.replyToken, GREETING_TEXT);
    return;
  }

  if (event.type !== 'message' || !event.message || event.message.type !== 'text') {
    return; // 非文字訊息（貼圖、圖片等）一律不回應
  }

  // 一對二/一對三共用群組：通知要發到整個群組，不是打字那個人的私人帳號，
  // 所以綁定要記 groupId/roomId，不是 userId；但「誰打了關鍵字/電話號碼」這個
  // 暫存狀態也要用同一把 key（convoKey），這樣同群組裡不同人接力打字也認得出來。
  const sourceType = event.source.type; // 'user' | 'group' | 'room'
  const convoKey = event.source.groupId || event.source.roomId || event.source.userId;
  const dest =
    sourceType === 'group'
      ? { groupId: event.source.groupId }
      : sourceType === 'room'
      ? { roomId: event.source.roomId }
      : { userId: event.source.userId };
  const text = event.message.text.trim();
  const textLower = text.toLowerCase();

  const pending = await getPendingBind(convoKey).catch((e) => {
    console.error('pending check error', e);
    return null;
  });

  if (!pending) {
    // 還沒有人打過關鍵字：只有打關鍵字才回應，其他訊息（客人問問題等）完全不打擾，交給店家手動聊天
    // 中英文關鍵字都認，用哪個語言的關鍵字觸發，後面就用哪個語言回覆
    const isZh = KEYWORDS_ZH.some((k) => text.includes(k));
    const isEn = !isZh && KEYWORDS_EN.some((k) => textLower.includes(k));
    if (isZh || isEn) {
      const lang = isEn ? 'en' : 'zh';
      await setPendingBind(convoKey, lang).catch((e) => console.error('set pending error', e));
      await lineReply(event.replyToken, MSG[lang].askPhone);
    }
    return;
  }

  // 已經打過關鍵字，這則訊息當作電話號碼處理，用打關鍵字當下記住的語言回覆
  await clearPendingBind(convoKey).catch((e) => console.error('clear pending error', e));
  const lang = pending.lang === 'en' ? 'en' : 'zh';
  const m = MSG[lang];

  const last8 = normalizePhone(text);
  if (!last8) {
    await lineReply(event.replyToken, m.notPhone);
    return;
  }

  let matches;
  try {
    matches = await findStudentsByPhone(last8);
  } catch (e) {
    console.error('lookup error', e);
    await lineReply(event.replyToken, m.lookupError);
    return;
  }

  if (matches.length === 0) {
    await lineReply(event.replyToken, m.notFound);
    return;
  }

  // 同一支電話可能對到同一人的多筆購課方案（例如瑜珈+皮拉提斯分開記錄），
  // 只要名字都一樣就當同一人綁定；名字不一樣（例如共用電話）才視為無法判斷。
  const names = new Set(matches.map((s) => s.name));
  if (names.size > 1) {
    await lineReply(event.replyToken, m.ambiguous);
    return;
  }

  const student = matches[0];
  // 共用課卡：這支電話如果是某位 altRecipient 的，綁定顯示用她自己的名字，不是整個共用課卡的複合名稱
  const altMatch = (student.altRecipients || []).find(
    (r) => r && r.phone && r.phone.replace(/\D/g, '').slice(-8) === last8
  );
  const bindName = altMatch ? altMatch.name : student.name;
  try {
    await bindPhone(last8, dest, bindName, lang);
    await lineReply(event.replyToken, m.bindSuccess(bindName));
  } catch (e) {
    console.error('bind error', e);
    await lineReply(event.replyToken, m.bindError);
  }
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.status(200).send('ok');
    return;
  }

  const rawBody = await readRawBody(req);
  const signature = req.headers['x-line-signature'];

  if (!verifySignature(rawBody, signature)) {
    res.status(401).send('invalid signature');
    return;
  }

  let body;
  try {
    body = JSON.parse(rawBody.toString('utf8'));
  } catch (e) {
    res.status(400).send('bad json');
    return;
  }

  const events = body.events || [];
  for (const event of events) {
    try {
      await handleEvent(event);
    } catch (e) {
      console.error('event handling error', e);
    }
  }

  res.status(200).send('ok');
};

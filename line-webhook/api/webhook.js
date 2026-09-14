// LINE Messaging API webhook — binds a student's LINE userId to their phone
// number so scripts/line_reminder.py can push personal class reminders.
// Also binds teachers the same way (phone → qingjing_teacher_phones lookup,
// tried only when the phone doesn't match any student) so index.html can push
// them prepaid-rent deduction notices — see qingjing_line_bindings_teacher.
//
// Binding data lives in its own top-level Firebase node (qingjing_line_bindings),
// separate from the qingjing/s student array. The main app overwrites the whole
// `s` array on every save() (see index.html doFirebaseWrite), so writing directly
// into a student record here would race with that and could silently get clobbered.

const crypto = require('crypto');
const { fb } = require('../lib/firebaseAdmin');

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

// Mirrors the phone matching already used in index.html (s.phone.replace(/\D/g,'').slice(-8))
function normalizePhone(text) {
  const digits = (text || '').replace(/\D/g, '');
  return digits.length >= 8 ? digits.slice(-8) : null;
}

// 老師的電話存在 qingjing_teacher_phones（{teacherName: phone}，index.html 師資管理的「場租設定」
// 畫面維護），跟學員清單分開查，找到的話回傳老師姓名；找不到回傳 null。
async function findTeacherByPhone(last8) {
  const phones = (await fb('/qingjing_teacher_phones', { method: 'GET' })) || {};
  const name = Object.keys(phones).find((n) => phones[n] && phones[n].replace(/\D/g, '').slice(-8) === last8);
  return name || null;
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

// 簽到記錄陣列（qingjing/r，對應 index.html 的全域變數 R）：每筆有 sid（對應學員 id）、
// date、time、confirmed 等欄位。confirmed 是店長內部核對薪資用的旗標（薪資結算月結才
// 用 confirmed!==false 篩，見 index.html 第 5022/5052/9050 行），跟學員看到的「已使用
// 堂數」（s.used，簽到當下就 +1，不看 confirmed）無關。這裡列給學員看的簽到記錄，要跟
// 已使用堂數口徑一致，所以不篩 confirmed，否則會出現「顯示已用1堂、記錄清單卻空白」的
// 不一致（2026-09-16 老闆實測發現）。
async function findRecordsBySid(sid) {
  const records = (await fb('/qingjing/r', { method: 'GET' })) || [];
  return records.filter((r) => r && r.sid === sid).sort((a, b) => (b.date || '').localeCompare(a.date || ''));
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

// 老師綁定存獨立節點（qingjing_line_bindings_teacher），跟學員綁定分開，避免老師跟學員剛好
// 電話末8碼相同時互相綁錯對象
async function bindTeacherPhone(last8, dest, name, lang) {
  await fb(`/qingjing_line_bindings_teacher/${last8}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...dest, name, boundAt: Date.now(), lang }),
  });
}

// 打關鍵字（提醒/remind）前先查這個對話是不是已經綁定過，避免重複綁定時又問一次電話號碼——
// 之前完全沒有這個檢查，已綁定的人再打一次關鍵字，體驗上就像「綁定失效了」（2026-07-27 查出）
function matchesDest(binding, dest) {
  const k = Object.keys(dest)[0];
  return !!(binding && binding[k] === dest[k]);
}
async function findExistingBinding(dest) {
  const bindings = (await fb('/qingjing_line_bindings', { method: 'GET' })) || {};
  const key = Object.keys(bindings).find((k) => matchesDest(bindings[k], dest));
  if (key) return { name: bindings[key].name };
  const tBindings = (await fb('/qingjing_line_bindings_teacher', { method: 'GET' })) || {};
  const tKey = Object.keys(tBindings).find((k) => matchesDest(tBindings[k], dest));
  if (tKey) return { name: tBindings[tKey].name };
  return null;
}

async function unbindUserId(userId) {
  const bindings = (await fb('/qingjing_line_bindings', { method: 'GET' })) || {};
  const key = Object.keys(bindings).find((k) => bindings[k] && bindings[k].userId === userId);
  if (key) await fb(`/qingjing_line_bindings/${key}`, { method: 'DELETE' });
  const tBindings = (await fb('/qingjing_line_bindings_teacher', { method: 'GET' })) || {};
  const tKey = Object.keys(tBindings).find((k) => tBindings[k] && tBindings[k].userId === userId);
  if (tKey) await fb(`/qingjing_line_bindings_teacher/${tKey}`, { method: 'DELETE' });
}

// bot 被踢出群組/多人聊天室時，把綁在那個 groupId/roomId 上的綁定也一起清掉，
// 不然店家以為還在通知，其實 bot 早就不在群組裡了，訊息根本送不到
async function unbindConvo(id) {
  const bindings = (await fb('/qingjing_line_bindings', { method: 'GET' })) || {};
  const key = Object.keys(bindings).find(
    (k) => bindings[k] && (bindings[k].groupId === id || bindings[k].roomId === id)
  );
  if (key) await fb(`/qingjing_line_bindings/${key}`, { method: 'DELETE' });
  const tBindings = (await fb('/qingjing_line_bindings_teacher', { method: 'GET' })) || {};
  const tKey = Object.keys(tBindings).find(
    (k) => tBindings[k] && (tBindings[k].groupId === id || tBindings[k].roomId === id)
  );
  if (tKey) await fb(`/qingjing_line_bindings_teacher/${tKey}`, { method: 'DELETE' });
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

async function lineReplyFlex(replyToken, altText, contents) {
  if (!CHANNEL_ACCESS_TOKEN) return;
  await fetch('https://api.line.me/v2/bot/message/reply', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${CHANNEL_ACCESS_TOKEN}`,
    },
    body: JSON.stringify({ replyToken, messages: [{ type: 'flex', altText, contents }] }),
  });
}

const KEYWORDS_ZH = ['提醒', '綁定'];
const KEYWORDS_EN = ['remind', 'reminder', 'bind', 'register'];

// 查課卡狀態關鍵字——跟提醒/綁定關鍵字分開判斷，觸發後直接反查綁定、組 Flex 卡片回覆，
// 不需要再問電話號碼（因為要查課卡狀態的人一定已經綁定過，見 handleCourseCardQuery）
const KEYWORDS_QUERY_ZH = ['查詢', '課卡', '查課卡', '我的課表'];
const KEYWORDS_QUERY_EN = ['query', 'mycard', 'my card', 'my courses'];

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
    bindSuccessTeacher: (name) => `✅ 綁定成功，${name}老師！之後場租扣堂會通知您剩餘堂數 🌿`,
    alreadyBound: (name) => `✅ ${name}，這個對話已經綁定過提醒通知囉，不用再輸入電話號碼 🌿`,
    guideBind: '請先輸入「提醒」完成綁定，之後就能直接查詢課卡狀態囉 🌿',
    noCards: '目前查不到課卡資料，麻煩直接聯繫工作室確認喔 🙏',
  },
  en: {
    askPhone: 'Please enter the phone number registered with the studio (e.g. 0912345678) to complete your class reminder registration 🌿',
    notPhone: 'That doesn\'t look like a phone number. Please type "remind" again to retry.',
    lookupError: 'Lookup is temporarily unavailable, please try again shortly or contact the studio directly.',
    notFound: 'We couldn\'t find a matching record. Please contact the studio to confirm your registered phone number 🙏',
    ambiguous: 'This phone number matches multiple different student records. Please contact the studio to confirm 🙏',
    bindError: 'Something went wrong while registering, please try again or contact the studio directly.',
    bindSuccess: (name) => `✅ Registered successfully, ${name}! We'll remind you the day before your class 🌿`,
    bindSuccessTeacher: (name) => `✅ Registered successfully, ${name}! We'll notify you when your rental sessions get deducted 🌿`,
    alreadyBound: (name) => `✅ ${name}, this chat is already registered for reminders — no need to enter your phone number again 🌿`,
    guideBind: 'Please type "remind" first to complete registration, then you can check your course card status anytime 🌿',
    noCards: 'No course card data found. Please contact the studio to confirm 🙏',
  },
};

// ---- 課卡狀態查詢：Flex Message 卡片 ----

const WD_ZH = '日一二三四五六';
const WD_EN = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const GOLD = '#8B6914';
const GOLD2 = '#C4973A';
const GOLD3 = '#F0D89A';
const GOLD4 = '#FBF3DC';
const EXPIRY_WARN_COLOR = '#C05A20'; // 比照 index.html 到期提醒訊息按鈕配色
const EXPIRY_DANGER_COLOR = '#C0392B';

function todayStr() {
  const d = new Date();
  return d.getFullYear() + '/' + String(d.getMonth() + 1).padStart(2, '0') + '/' + String(d.getDate()).padStart(2, '0');
}

function parseDateStr(str) {
  const [y, mo, d] = String(str || '').split('/');
  return new Date(+y || 1970, (+mo || 1) - 1, +d || 1);
}

// 共用課卡時查詢者看到的姓名要是自己的名字（altRecipients 裡的），不是整張課卡的複合名稱——
// 跟 bindPhone 時決定 bindName 用的是同一套邏輯（見 handleEvent 裡 altMatch 那段）
function studentDisplayName(s, last8) {
  const alt = (s.altRecipients || []).find(
    (r) => r && r.phone && r.phone.replace(/\D/g, '').slice(-8) === last8
  );
  return alt ? alt.name : s.name;
}

// 已用堂數逐格畫成色塊，堂數多（>12）時格子會太擠、也可能超出卡片寬度，改用比例橫條
function buildProgressBar(used, total) {
  const u = Math.max(0, used || 0);
  const t = Math.max(0, total || 0);
  if (t > 0 && t <= 12) {
    const boxes = [];
    for (let i = 0; i < t; i++) {
      boxes.push({
        type: 'box',
        layout: 'vertical',
        width: '16px',
        height: '16px',
        cornerRadius: '4px',
        backgroundColor: i < u ? GOLD2 : GOLD3,
        contents: [],
      });
    }
    return { type: 'box', layout: 'horizontal', spacing: 'xs', contents: boxes };
  }
  const remain = Math.max(t - u, 0);
  const bar = {
    type: 'box',
    layout: 'horizontal',
    contents: [
      {
        type: 'box',
        layout: 'vertical',
        flex: Math.max(u, t ? 1 : 0),
        height: '10px',
        cornerRadius: '5px',
        backgroundColor: GOLD2,
        contents: [],
      },
    ],
  };
  if (remain > 0) {
    bar.contents.push({
      type: 'box',
      layout: 'vertical',
      flex: remain,
      height: '10px',
      cornerRadius: '5px',
      backgroundColor: GOLD3,
      contents: [],
    });
  }
  return bar;
}

// 「過期就當沒約」：跟 index.html（signStudentIn 那段對 nextBooking 的處理）同一套邏輯，
// nextBooking 日期已經過去就不顯示，避免學員看到早就上完、失效的舊預約時間
function buildNextBookingRow(s, lang) {
  if (!s.nextBooking || !s.nextBooking.date || s.nextBooking.date < todayStr()) return null;
  const d = parseDateStr(s.nextBooking.date);
  const time = s.nextBooking.time || '';
  const label =
    lang === 'en'
      ? `${s.nextBooking.date} (${WD_EN[d.getDay()]}) ${time}`.trim()
      : `${s.nextBooking.date}（星期${WD_ZH[d.getDay()]}）${time}`.trim();
  return {
    type: 'box',
    layout: 'baseline',
    spacing: 'sm',
    margin: 'md',
    contents: [
      { type: 'text', text: lang === 'en' ? 'Next class' : '下次上課', size: 'xs', color: '#9A8C78', flex: 2 },
      { type: 'text', text: label, size: 'sm', color: '#3A2E1E', flex: 5, wrap: true },
    ],
  };
}

// 快到期／已過期判斷比照 index.html runDataCheck()（第 9252 行附近）的 ed<now 過期判斷，
// 另外加 14 天內的「即將到期」提醒門檻，比照到期提醒按鈕（diff2>=0&&diff2<=14）那段
function buildExpiryRow(s, lang) {
  if (!s.expiryDate) return null;
  const ed = parseDateStr(s.expiryDate);
  const now = new Date();
  const diffDays = Math.ceil((ed - now) / 86400000);
  let color = '#3A2E1E';
  let weight = 'regular';
  let suffix = '';
  if (diffDays < 0) {
    color = EXPIRY_DANGER_COLOR;
    weight = 'bold';
    suffix = lang === 'en' ? ' (expired)' : '（已過期）';
  } else if (diffDays <= 14) {
    color = EXPIRY_WARN_COLOR;
    weight = 'bold';
    suffix = lang === 'en' ? ` (in ${diffDays}d)` : `（剩 ${diffDays} 天）`;
  }
  return {
    type: 'box',
    layout: 'baseline',
    spacing: 'sm',
    margin: 'sm',
    contents: [
      { type: 'text', text: lang === 'en' ? 'Expires' : '到期日', size: 'xs', color: '#9A8C78', flex: 2 },
      { type: 'text', text: `${s.expiryDate}${suffix}`, size: 'sm', color, weight, flex: 5, wrap: true },
    ],
  };
}

// 簽到記錄清單——Flex Message 沒有捲動功能、卡片高度有限，只列最近 5 筆，
// 超過的話最下面補一行「還有 X 筆更早的紀錄」，不整批塞進去
const ATTENDANCE_SHOW_LIMIT = 5;

function buildAttendanceSection(records, lang) {
  if (!records || records.length === 0) return null;
  const recent = records.slice(0, ATTENDANCE_SHOW_LIMIT);
  const moreCount = records.length - recent.length;

  const rows = recent.map((r) => {
    const d = parseDateStr(r.date);
    const dateLabel =
      lang === 'en'
        ? `${r.date} (${WD_EN[d.getDay()]})`
        : `${r.date}（${WD_ZH[d.getDay()]}）`;
    return {
      type: 'box',
      layout: 'baseline',
      spacing: 'sm',
      contents: [
        { type: 'text', text: '・', size: 'xs', color: GOLD2, flex: 0 },
        { type: 'text', text: dateLabel, size: 'xs', color: '#5A4A34', flex: 1, wrap: true },
      ],
    };
  });

  if (moreCount > 0) {
    rows.push({
      type: 'text',
      text: lang === 'en' ? `+${moreCount} earlier record${moreCount > 1 ? 's' : ''}` : `還有 ${moreCount} 筆更早的紀錄`,
      size: 'xxs',
      color: '#9A8C78',
      margin: 'xs',
    });
  }

  return {
    type: 'box',
    layout: 'vertical',
    margin: 'md',
    spacing: 'xs',
    contents: [
      { type: 'text', text: lang === 'en' ? 'Attendance' : '簽到記錄', size: 'xs', color: '#9A8C78' },
      { type: 'separator', margin: 'xs', color: GOLD3 },
      { type: 'box', layout: 'vertical', margin: 'xs', spacing: 'xs', contents: rows },
    ],
  };
}

function buildCourseCardBubble(s, records, last8, lang) {
  const name = studentDisplayName(s, last8);
  const used = s.used || 0;
  const total = s.total || 0;
  const bodyContents = [
    {
      type: 'box',
      layout: 'baseline',
      contents: [
        { type: 'text', text: String(used), size: 'xxl', weight: 'bold', color: GOLD, flex: 0 },
        {
          type: 'text',
          text: `/ ${total} ${lang === 'en' ? 'sessions used' : '堂已使用'}`,
          size: 'sm',
          color: '#9A8C78',
          margin: 'sm',
          gravity: 'bottom',
          wrap: true,
        },
      ],
    },
    buildProgressBar(used, total),
  ];
  const nextRow = buildNextBookingRow(s, lang);
  const expiryRow = buildExpiryRow(s, lang);
  if (nextRow) bodyContents.push(nextRow);
  if (expiryRow) bodyContents.push(expiryRow);
  const attendanceSection = buildAttendanceSection(records, lang);
  if (attendanceSection) bodyContents.push(attendanceSection);

  return {
    type: 'bubble',
    size: 'kilo',
    header: {
      type: 'box',
      layout: 'horizontal',
      paddingAll: '16px',
      backgroundColor: GOLD2,
      contents: [
        {
          type: 'text',
          text: s.course || (lang === 'en' ? 'Course' : '課程'),
          color: '#FFFFFF',
          weight: 'bold',
          size: 'md',
          flex: 3,
          wrap: true,
        },
        {
          type: 'text',
          text: name || '',
          color: GOLD4,
          size: 'sm',
          align: 'end',
          gravity: 'center',
          flex: 2,
          wrap: true,
        },
      ],
    },
    body: { type: 'box', layout: 'vertical', spacing: 'md', paddingAll: '16px', contents: bodyContents },
    footer: {
      type: 'box',
      layout: 'vertical',
      paddingAll: '12px',
      contents: [
        {
          type: 'text',
          text: lang === 'en' ? 'Questions? Please ask your teacher 🌿' : '如有疑問請洽老師 🌿',
          size: 'xs',
          color: '#9A8C78',
          align: 'center',
          wrap: true,
        },
      ],
    },
  };
}

// 反查這個對話綁的是哪個學員（last8 + name）——跟 findExistingBinding 很像，但那個只回傳 name，
// 這裡多回傳 last8 才能拿去 findStudentsByPhone 撈課卡資料。只查學員綁定節點，不查老師的，
// 因為老師沒有課卡資料
async function findStudentBinding(dest) {
  const bindings = (await fb('/qingjing_line_bindings', { method: 'GET' })) || {};
  const key = Object.keys(bindings).find((k) => matchesDest(bindings[k], dest));
  if (!key) return null;
  return { last8: key, name: bindings[key].name };
}

async function handleCourseCardQuery(dest, lang, replyToken) {
  const m = MSG[lang];
  let binding;
  try {
    binding = await findStudentBinding(dest);
  } catch (e) {
    console.error('query binding lookup error', e);
    await lineReply(replyToken, m.lookupError);
    return;
  }
  if (!binding) {
    await lineReply(replyToken, m.guideBind);
    return;
  }

  let students;
  try {
    students = await findStudentsByPhone(binding.last8);
  } catch (e) {
    console.error('query students lookup error', e);
    await lineReply(replyToken, m.lookupError);
    return;
  }

  const cards = students.filter((s) => studentDisplayName(s, binding.last8) === binding.name);
  if (cards.length === 0) {
    await lineReply(replyToken, m.noCards);
    return;
  }

  let bubbles;
  try {
    bubbles = await Promise.all(
      cards.map(async (s) => buildCourseCardBubble(s, await findRecordsBySid(s.id), binding.last8, lang))
    );
  } catch (e) {
    console.error('query records lookup error', e);
    await lineReply(replyToken, m.lookupError);
    return;
  }
  const contents = bubbles.length === 1 ? bubbles[0] : { type: 'carousel', contents: bubbles };
  const altText = lang === 'en' ? `${binding.name}'s course card status` : `${binding.name} 的課卡狀態`;
  await lineReplyFlex(replyToken, altText, contents);
}

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

  // 2026-07-28 曾經整個擋掉群組觸發新綁定流程，因為當時「提醒」「綁定」是子字串比對，
  // 在跟課程無關的群組閒聊裡很容易被誤觸發。但下面已經改成「完全比對」（訊息要剛好等於
  // 關鍵字本身，不是包含），這個問題已經解決了；1on2/1on3 共用群組本來就需要能在群組裡
  // 綁定（見上面 dest/convoKey 的設計、以及「電話號碼也可能是另一個人代打」的註解），
  // 繼續整個擋掉群組觸發等於讓這個功能形同虛設，改回不分對話類型都能觸發。

  if (!pending) {
    // 還沒有人打過關鍵字：只有打「完全等於」關鍵字的訊息才回應，其他訊息（客人問問題、日常聊天等）
    // 完全不打擾，交給店家手動聊天。改成精確比對（而非子字串 includes）是因為子字串太容易在正常
    // 對話裡意外命中「提醒」「綁定」這兩個字（2026-07-28 誤觸發事故）。
    // 查課卡狀態：跟綁定流程分開判斷，直接反查綁定→組 Flex 卡片回覆，不用再問電話號碼
    // （要查課卡狀態的人一定已經綁定過，沒綁過的引導去打「提醒」）
    const isQueryZh = KEYWORDS_QUERY_ZH.includes(text);
    const isQueryEn = !isQueryZh && KEYWORDS_QUERY_EN.includes(textLower);
    if (isQueryZh || isQueryEn) {
      const qLang = isQueryEn ? 'en' : 'zh';
      await handleCourseCardQuery(dest, qLang, event.replyToken).catch((e) =>
        console.error('course card query error', e)
      );
      return;
    }

    // 中英文關鍵字都認，用哪個語言的關鍵字觸發，後面就用哪個語言回覆
    const isZh = KEYWORDS_ZH.includes(text);
    const isEn = !isZh && KEYWORDS_EN.includes(textLower);
    if (isZh || isEn) {
      const lang = isEn ? 'en' : 'zh';
      const existing = await findExistingBinding(dest).catch((e) => {
        console.error('existing bind check error', e);
        return null; // 查詢失敗就當作沒查到，退回原本「問電話」的流程，不要卡住整個綁定功能
      });
      if (existing) {
        await lineReply(event.replyToken, MSG[lang].alreadyBound(existing.name));
        return;
      }
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

  // 電話沒對到任何學員時，再查一次是不是老師的電話（場租/明日課程通知走的是另一個綁定節點）
  if (matches.length === 0) {
    let teacherName;
    try {
      teacherName = await findTeacherByPhone(last8);
    } catch (e) {
      console.error('teacher lookup error', e);
      await lineReply(event.replyToken, m.lookupError);
      return;
    }
    if (teacherName) {
      try {
        await bindTeacherPhone(last8, dest, teacherName, lang);
        await lineReply(event.replyToken, m.bindSuccessTeacher(teacherName));
      } catch (e) {
        console.error('teacher bind error', e);
        await lineReply(event.replyToken, m.bindError);
      }
      return;
    }
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

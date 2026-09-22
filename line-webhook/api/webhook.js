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
// 「我要體驗」流程收集完資料要推播給工作室負責人的 LINE userId，可能不只一個人（例如
// Winnie、Jungle 都要收到），所以用逗號分隔存成 OWNER_LINE_USER_IDS。沒有既有機制能拿到
// 這個值，負責人要先在跟官方帳號的 1 對 1 對話裡打「我的ID」（見下面 MY_ID_KEYWORD），
// bot 會把 userId 回傳，再手動貼進 Vercel 環境變數。OWNER_LINE_USER_ID（單數）保留給舊設定
// 相容，兩個環境變數都有設的話會合併、去重。
const OWNER_LINE_USER_IDS = Array.from(
  new Set(
    [process.env.OWNER_LINE_USER_ID, ...(process.env.OWNER_LINE_USER_IDS || '').split(',')]
      .map((id) => (id || '').trim())
      .filter(Boolean)
  )
);

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
// 續課時舊一期的簽到記錄會標記 archived=true（同一學員 id 沿用，不建新 id，見
// index.html 第7214/7269行），已使用堂數（s.used）續課時會歸零重算，只算當期，
// 所以這裡也要排除 archived===true 的舊期記錄，否則查詢卡片的記錄清單會比已使用堂數多
// 出舊期的簽到記錄，兩者對不上（2026-09-22 查出）。
async function findRecordsBySid(sid) {
  const records = (await fb('/qingjing/r', { method: 'GET' })) || [];
  return records
    .filter((r) => r && r.sid === sid && !r.archived)
    .sort((a, b) => (b.date || '').localeCompare(a.date || ''));
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

// 用文字快速按鈕問問題（LINE Quick Reply）——點下去等同直接打那句文字，
// 所以後面判斷答案時跟真的手打完全一樣處理，不用另外解析 postback data。
async function lineReplyQuick(replyToken, text, options) {
  if (!CHANNEL_ACCESS_TOKEN) return;
  await fetch('https://api.line.me/v2/bot/message/reply', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${CHANNEL_ACCESS_TOKEN}`,
    },
    body: JSON.stringify({
      replyToken,
      messages: [
        {
          type: 'text',
          text,
          quickReply: {
            items: options.map((label) => ({
              type: 'action',
              action: { type: 'message', label: label.slice(0, 20), text: label },
            })),
          },
        },
      ],
    }),
  });
}

// 「我要體驗」流程開場歡迎詞附一張阿勇店長的照片，圖檔放在 public/ 底下，
// Vercel 會直接把 public/ 當靜態檔案伺服器出去，用正式網域組成 LINE 圖片訊息需要的網址。
// along3.png 是背景去背、舉手比讚的那張，之前做迷因梗圖也是用同一批素材。
const ALONG_PHOTO = {
  original: 'https://line-webhook-gules.vercel.app/along3.png',
  preview: 'https://line-webhook-gules.vercel.app/along3_preview.png',
};

async function lineReplyImageAndQuick(replyToken, imageUrl, previewUrl, text, options) {
  if (!CHANNEL_ACCESS_TOKEN) return;
  await fetch('https://api.line.me/v2/bot/message/reply', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${CHANNEL_ACCESS_TOKEN}`,
    },
    body: JSON.stringify({
      replyToken,
      messages: [
        { type: 'image', originalContentUrl: imageUrl, previewImageUrl: previewUrl },
        {
          type: 'text',
          text,
          quickReply: {
            items: options.map((label) => ({
              type: 'action',
              action: { type: 'message', label: label.slice(0, 20), text: label },
            })),
          },
        },
      ],
    }),
  });
}

async function pushLineText(to, text) {
  if (!CHANNEL_ACCESS_TOKEN || !to) return false;
  const res = await fetch('https://api.line.me/v2/bot/message/push', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${CHANNEL_ACCESS_TOKEN}`,
    },
    body: JSON.stringify({ to, messages: [{ type: 'text', text }] }),
  });
  return res.ok;
}

// 抓對方 LINE 暱稱給老闆通知用——只是錦上添花，抓不到（沒加好友、群組取不到等）就放棄，
// 不能因為這支 API 失敗就擋住整個體驗預約流程
async function getDisplayName(event) {
  if (!CHANNEL_ACCESS_TOKEN) return null;
  const { type, userId, groupId, roomId } = event.source;
  if (!userId) return null;
  try {
    const url =
      type === 'group'
        ? `https://api.line.me/v2/bot/group/${groupId}/member/${userId}`
        : type === 'room'
        ? `https://api.line.me/v2/bot/room/${roomId}/member/${userId}`
        : `https://api.line.me/v2/bot/profile/${userId}`;
    const res = await fetch(url, { headers: { Authorization: `Bearer ${CHANNEL_ACCESS_TOKEN}` } });
    if (!res.ok) return null;
    const data = await res.json();
    return data.displayName || null;
  } catch (e) {
    console.warn('getDisplayName failed:', e.message);
    return null;
  }
}

// ---- 「我要體驗」對話式資訊收集：課程 → 人數 → 時段 → 器械經驗 → 舊傷 → 醫療狀況 →
// 運動習慣 → 目標 → 通知老闆 ----
// 全程用「阿勇店長」第一人稱口吻講話，比較親切、像真人在聊天，不是制式問卷。
// 有中英文兩種版本（有外國學生），中文用「我要體驗」觸發、英文用「trial」觸發，
// 觸發用哪個語言，後面全部問題跟結尾都用同一個語言回覆（存在 state.lang 裡）。
// 常態功能，跟任何檔期無關。中途狀態存 Firebase（qingjing_trial_flow/{convoKey}），
// 30 分鐘沒動作就當放棄，下次打關鍵字重新開始（避免半年前的殘留狀態突然復活接話）。
const TRIAL_STATE_TTL_MS = 30 * 60 * 1000;

const TRIAL_I18N = {
  zh: {
    keyword: '我要體驗',
    cancelWord: '取消',
    listSep: '、',
    start:
      '哈囉，我是阿勇店長 🌿 很開心你想來體驗看看！我先問你幾個小問題，這樣才能幫你安排最適合的老師和時間～\n\n首先，你想體驗哪一種課程呢？',
    // 跟 index.html 的 PLANS 課程類型（器械皮拉提斯／重訓課程／瑜珈課程）同一套名稱，
    // 多加一個「不確定」給第一次接觸、還不知道要選哪種的新同學
    courseOptions: ['器械皮拉提斯', '重訓課程', '瑜珈課程', '不確定，請幫我推薦'],
    coursePickOptions: ['器械皮拉提斯', '重訓課程', '瑜珈課程'],
    notSure: '不確定，請幫我推薦',
    courseIntro:
      '沒問題，我簡單跟你介紹一下 🌿\n\n' +
      '🧘‍♀️ 器械皮拉提斯：用專業器械訓練核心、雕塑體態，適合想改善姿勢、核心無力的人\n' +
      '🏋️ 重訓課程：透過重量訓練提升肌力和代謝，適合想增肌、變得更有力量的人\n' +
      '🧘 瑜珈課程：伸展放鬆、調整身心平衡，適合想紓壓、增加柔軟度的人\n\n' +
      '看完之後，想先體驗哪一種呢？',
    capacityQ: '好唷～那這堂課你是想自己一個人上，還是要揪朋友一起呢？',
    // 一對二、一對三是跟其他同學共用時段的小班課，要自己揪朋友一起來，選項裡先講清楚
    capacityOptions: ['一對一', '一對二（可以揪1位朋友）', '一對三（可以揪2位朋友）'],
    // 時段要能複選，同一組按鈕可以連續點好幾次，累積記錄，點「都選好了」才算完成這一題；
    // 也接受直接打整句話（例如「平日晚上跟週末都可以」）當成其中一個答案項目一起累加。
    timeslotQ: (done) => `了解！那你平常方便上課的時間大概是什麼時候呢？可以點選多個時段，都選好之後點「${done}」，當然也可以直接打字跟我說 🌿`,
    timeslotOptions: ['平日白天', '平日晚上', '週末白天', '週末晚上'],
    timeslotDone: '都選好了',
    timeslotNeedOne: '要先點一個方便的時段唷 🙏',
    timeslotRecorded: (list, done) => `記錄囉：${list}\n還有其他方便的時段可以繼續點，都選好了就點「${done}」`,
    experienceQ: (course) => `再麻煩回答幾個小問題，這樣老師上課前會更清楚你的狀況唷！\n\n你以前有上過${course ? '「' + course + '」或類似的' : ''}運動課程經驗嗎？`,
    experienceOptions: ['完全沒有', '有，上過團體課', '有，上過一對一'],
    experienceNone: '完全沒有',
    experienceDurationQ: '大概上了多久呢？（例如：3個月、半年、1年以上）',
    injuryQ: '好的～那目前身體有沒有什麼舊傷、不舒服或會痛的地方呢？（比如腰痠、肩頸僵硬、膝蓋不適、椎間盤突出這些都可以說，沒有的話回「無」就可以）',
    medicalQ: '那最近有動過手術，或有什麼比較特別的身體狀況要讓老師知道的嗎？（比如三個月內開過刀、懷孕、高血壓這些，沒有的話一樣回「無」）',
    frequencyQ: '平常有運動習慣嗎？大概多常呢？',
    frequencyOptions: ['沒有固定運動', '每週1~2次', '每週3次以上'],
    goalQ: '最後一題～這次想透過課程改善或達成什麼呢？（比如改善體態姿勢、練核心肌力、放鬆緊繃肌肉、提升體能之類的都可以）',
    thanks: '謝謝你耐心回答這些問題～已經收到你的資料了，我會盡快幫你安排最適合的老師和時間，很快會有人跟你聯絡喔 🌿\n\n阿勇店長',
    cancelReply: (kw) => `好的，先幫你取消這次的填寫囉，之後想再約體驗的話，再跟我說「${kw}」就可以啦 🌿`,
  },
  en: {
    keyword: 'trial',
    cancelWord: 'cancel',
    listSep: ', ',
    start:
      "Hi, I'm Boss Yong 🌿 So glad you'd like to try a class! I'll ask a few quick questions so I can match you with the right teacher and time.\n\nFirst, which class would you like to try?",
    courseOptions: ['Pilates Reformer', 'Strength Training', 'Yoga', 'Not sure, please recommend'],
    coursePickOptions: ['Pilates Reformer', 'Strength Training', 'Yoga'],
    notSure: 'Not sure, please recommend',
    courseIntro:
      "No problem, here's a quick overview 🌿\n\n" +
      '🧘‍♀️ Pilates Reformer: uses specialized equipment to build core strength and improve posture — great if you want better alignment or a stronger core\n' +
      '🏋️ Strength Training: builds muscle and boosts metabolism — great if you want to get stronger\n' +
      '🧘 Yoga: stretching and relaxation for body and mind — great if you want to de-stress and improve flexibility\n\n' +
      'Which one would you like to try?',
    capacityQ: 'Great — would you like to come by yourself, or bring a friend along?',
    capacityOptions: ['1-on-1', '1-on-2 (bring 1 friend)', '1-on-3 (bring 2 friends)'],
    timeslotQ: (done) =>
      `Got it! What times generally work for you? You can tap multiple options, then tap "${done}" when you're done — or just type it out 🌿`,
    timeslotOptions: ['Weekday daytime', 'Weekday evening', 'Weekend daytime', 'Weekend evening'],
    timeslotDone: "That's all",
    timeslotNeedOne: 'Please pick at least one time slot 🙏',
    timeslotRecorded: (list, done) => `Noted: ${list}\nFeel free to add more, then tap "${done}" when you're done`,
    experienceQ: (course) =>
      `A few more quick questions so your teacher knows what to expect!\n\nHave you taken${course ? ' ' + course + ' or similar' : ''} classes before?`,
    experienceOptions: ['None at all', 'Yes, group classes', 'Yes, private 1-on-1'],
    experienceNone: 'None at all',
    experienceDurationQ: 'About how long did/have you practiced? (e.g. 3 months, 6 months, 1+ year)',
    injuryQ: 'Got it — do you currently have any old injuries, discomfort, or pain? (e.g. lower back, neck/shoulder tightness, knee issues, herniated disc — just type "none" if not)',
    medicalQ: 'Have you had any surgery recently, or any other medical conditions we should know about? (e.g. surgery within 3 months, pregnancy, high blood pressure — type "none" if not)',
    frequencyQ: 'Do you exercise regularly? About how often?',
    frequencyOptions: ['No regular exercise', '1-2 times a week', '3+ times a week'],
    goalQ: 'Last question — what would you like to achieve or improve through this class? (e.g. posture, core strength, relaxation, fitness, etc.)',
    thanks:
      "Thanks so much for answering these questions! We've got your info and will arrange the best teacher and time for you soon — someone will reach out shortly 🌿\n\nBoss Yong",
    cancelReply: (kw) => `No problem, I've cancelled this for now. Just message "${kw}" again whenever you're ready 🌿`,
  },
};

function trialLangOf(state) {
  return state && state.lang === 'en' ? 'en' : 'zh';
}

async function getTrialState(convoKey) {
  const v = await fb(`/qingjing_trial_flow/${convoKey}`, { method: 'GET' });
  if (!v || typeof v.ts !== 'number' || Date.now() - v.ts >= TRIAL_STATE_TTL_MS) return null;
  return v;
}
async function setTrialState(convoKey, state) {
  await fb(`/qingjing_trial_flow/${convoKey}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...state, ts: Date.now() }),
  });
}
async function clearTrialState(convoKey) {
  await fb(`/qingjing_trial_flow/${convoKey}`, { method: 'DELETE' });
}

const LANG_PICK_PROMPT = '請選擇語言 / Please select your language 🌿';
const LANG_PICK_OPTIONS = ['中文', 'English'];

async function beginTrialQuestions(convoKey, replyToken, lang) {
  const T = TRIAL_I18N[lang];
  await setTrialState(convoKey, { step: 'course', lang });
  await lineReplyImageAndQuick(replyToken, ALONG_PHOTO.original, ALONG_PHOTO.preview, T.start, T.courseOptions);
}

// 選單按鈕固定送出中文「我要體驗」四個字，但可能是外國學生在點，所以中文關鍵字觸發時
// 一律先問語言，選完才真正開始問課程；英文關鍵字「trial」是已經知道要打英文的人直接打的，
// 不用再繞一層語言選擇。
async function startTrialFlow(convoKey, replyToken, lang) {
  if (lang === 'zh') {
    await setTrialState(convoKey, { step: 'lang' });
    await lineReplyQuick(replyToken, LANG_PICK_PROMPT, LANG_PICK_OPTIONS);
    return;
  }
  await beginTrialQuestions(convoKey, replyToken, lang);
}

async function handleTrialAnswer(state, text, event) {
  const { replyToken } = event;
  const convoKey = event.source.groupId || event.source.roomId || event.source.userId;

  // 中途又打一次任一語言的關鍵字：大概率是想重新開始（例如答錯、想重填，或想切換語言），
  // 直接重啟整個流程，不要把關鍵字本身誤存成某一題的答案。這個判斷要放在最前面，
  // 不看目前語言是哪個，兩種關鍵字都要認得出來。
  if (text === TRIAL_I18N.zh.keyword) {
    await startTrialFlow(convoKey, replyToken, 'zh');
    return;
  }
  if (text.toLowerCase() === TRIAL_I18N.en.keyword) {
    await startTrialFlow(convoKey, replyToken, 'en');
    return;
  }

  if (state.step === 'lang') {
    await beginTrialQuestions(convoKey, replyToken, text === 'English' ? 'en' : 'zh');
    return;
  }

  const lang = trialLangOf(state);
  const T = TRIAL_I18N[lang];
  const textLower = text.toLowerCase();

  if (text === T.cancelWord || (lang === 'en' && textLower === T.cancelWord)) {
    await clearTrialState(convoKey);
    await lineReply(replyToken, T.cancelReply(T.keyword));
    return;
  }

  if (state.step === 'course') {
    if (text === T.notSure) {
      // 先給個簡單的課程介紹，還不算答完這一題，等他們看完介紹再選一次；
      // 順便刷新一下 ts，避免看介紹看比較久導致 30 分鐘逾時被清掉
      await setTrialState(convoKey, state);
      await lineReplyQuick(replyToken, T.courseIntro, T.coursePickOptions);
      return;
    }
    await setTrialState(convoKey, { ...state, step: 'capacity', course: text });
    await lineReplyQuick(replyToken, T.capacityQ, T.capacityOptions);
    return;
  }

  if (state.step === 'capacity') {
    await setTrialState(convoKey, { ...state, step: 'timeslot', capacity: text, timeslots: [] });
    await lineReplyQuick(replyToken, T.timeslotQ(T.timeslotDone), [...T.timeslotOptions, T.timeslotDone]);
    return;
  }

  if (state.step === 'timeslot') {
    // Firebase Realtime Database 會把空陣列（[]）當成沒有資料，讀回來時 state.timeslots
    // 會是 undefined，不是 []，這裡一律用 Array.isArray 保底，不能直接假設一定是陣列。
    const currentTimeslots = Array.isArray(state.timeslots) ? state.timeslots : [];
    if (text === T.timeslotDone) {
      if (!currentTimeslots.length) {
        await lineReplyQuick(replyToken, T.timeslotNeedOne, [...T.timeslotOptions, T.timeslotDone]);
        return;
      }
      await setTrialState(convoKey, { ...state, timeslots: currentTimeslots, step: 'experience' });
      await lineReplyQuick(replyToken, T.experienceQ(state.course), T.experienceOptions);
      return;
    }
    const timeslots = currentTimeslots.includes(text) ? currentTimeslots : [...currentTimeslots, text];
    await setTrialState(convoKey, { ...state, timeslots });
    await lineReplyQuick(
      replyToken,
      T.timeslotRecorded(timeslots.join(T.listSep), T.timeslotDone),
      [...T.timeslotOptions, T.timeslotDone]
    );
    return;
  }

  if (state.step === 'experience') {
    if (text === T.experienceNone) {
      await setTrialState(convoKey, { ...state, step: 'injury', experience: text });
      await lineReply(replyToken, T.injuryQ);
      return;
    }
    // 選過團體課／一對一都要多問一句大概上多久，方便老師抓程度
    await setTrialState(convoKey, { ...state, step: 'experienceDuration', experience: text });
    await lineReply(replyToken, T.experienceDurationQ);
    return;
  }

  if (state.step === 'experienceDuration') {
    await setTrialState(convoKey, { ...state, step: 'injury', experienceDuration: text });
    await lineReply(replyToken, T.injuryQ);
    return;
  }

  if (state.step === 'injury') {
    await setTrialState(convoKey, { ...state, step: 'medical', injury: text });
    await lineReply(replyToken, T.medicalQ);
    return;
  }

  if (state.step === 'medical') {
    await setTrialState(convoKey, { ...state, step: 'frequency', medical: text });
    await lineReplyQuick(replyToken, T.frequencyQ, T.frequencyOptions);
    return;
  }

  if (state.step === 'frequency') {
    await setTrialState(convoKey, { ...state, step: 'goal', frequency: text });
    await lineReply(replyToken, T.goalQ);
    return;
  }

  if (state.step === 'goal') {
    const displayName = await getDisplayName(event);
    const experienceLine = state.experienceDuration
      ? `${state.experience || ''}（約 ${state.experienceDuration}）`
      : state.experience || '';
    // 通知老闆的摘要固定用中文（老闆讀中文），只有語言是英文時多加一行提醒改用英文回覆對方
    const summary =
      '🌱 有新的體驗預約填寫完成！\n\n' +
      (lang === 'en' ? '🌐 語言：English（請用英文跟他聯絡）\n' : '') +
      '👤 LINE 暱稱：' + (displayName || '（讀不到暱稱）') + '\n' +
      '🧘 體驗課程：' + (state.course || '') + '\n' +
      '👥 上課人數：' + (state.capacity || '') + '\n' +
      '⏰ 方便時段：' + (Array.isArray(state.timeslots) ? state.timeslots.join(T.listSep) : '') + '\n' +
      '📋 相關運動經驗：' + experienceLine + '\n' +
      '🤕 舊傷／不適：' + (state.injury || '') + '\n' +
      '🏥 近期手術／醫療狀況：' + (state.medical || '') + '\n' +
      '🏃 運動習慣：' + (state.frequency || '') + '\n' +
      '🎯 想達成的目標：' + text + '\n\n' +
      '麻煩幫忙安排合適的老師和時間 🙏\n\n輕境運動工作室';
    let pushed = false;
    if (OWNER_LINE_USER_IDS.length) {
      const results = await Promise.all(
        OWNER_LINE_USER_IDS.map((id) =>
          pushLineText(id, summary).catch((e) => {
            console.error('owner push failed for', id, e);
            return false;
          })
        )
      );
      pushed = results.some(Boolean);
    } else {
      console.warn('OWNER_LINE_USER_IDS 未設定，體驗預約資訊沒有推播出去：', summary);
    }
    await clearTrialState(convoKey);
    await lineReply(replyToken, T.thanks);
    if (!pushed) console.warn('trial flow finished but owner notification did not send');
    return;
  }
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
  if (nextRow) bodyContents.push(nextRow);
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

  // 老闆專用小工具：在跟官方帳號的 1 對 1 對話裡打「我的ID」，把 userId 讀回去，
  // 拿去設 OWNER_LINE_USER_ID 環境變數（「我要體驗」流程收集完資料要推播給這個 id）。
  // 純粹回傳訊息來源自己的 id，不會洩漏給別人，風險很低，故意不做額外權限檢查。
  if (text === '我的ID' || textLower === 'my id') {
    await lineReply(event.replyToken, 'userId: ' + (event.source.userId || '（無，這是群組/多人聊天室）'));
    return;
  }

  // 「我要體驗」對話流程：中途狀態存在的話，這則訊息一律當成「回答目前這一題」，
  // 不要再拿去跟「提醒」「綁定」「查詢」等其他關鍵字比對，避免誤觸發別的流程。
  const trialState = await getTrialState(convoKey).catch((e) => {
    console.error('trial state check error', e);
    return null;
  });
  if (trialState) {
    await handleTrialAnswer(trialState, text, event).catch((e) => console.error('trial answer error', e));
    return;
  }

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

    // 「我要體驗」/ "trial"——常態功能（不限定任何檔期），精確比對跟其他關鍵字同一套邏輯，
    // 避免子字串誤觸發；中英文哪個關鍵字觸發，後面就用哪個語言問問題
    if (text === TRIAL_I18N.zh.keyword) {
      await startTrialFlow(convoKey, event.replyToken, 'zh').catch((e) => console.error('start trial flow error', e));
      return;
    }
    if (textLower === TRIAL_I18N.en.keyword) {
      await startTrialFlow(convoKey, event.replyToken, 'en').catch((e) => console.error('start trial flow error', e));
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

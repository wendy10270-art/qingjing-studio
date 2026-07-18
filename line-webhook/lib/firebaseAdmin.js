// 伺服器端一律透過 Firebase Admin SDK（服務帳戶金鑰）存取 Firebase，不再用裸 REST API + 公開
// API Key。Admin SDK 會完全繞過 Realtime Database 的安全規則，所以就算之後把資料庫規則從
// 「任何人都能讀寫」收緊成只允許已驗證來源，這裡的伺服器程式也不會受影響——只有 index.html
// （瀏覽器端，走 App Check）跟這裡（伺服器端，走 Admin SDK）兩條路能通過。
//
// FIREBASE_SERVICE_ACCOUNT_KEY 是在 Firebase 主控台「專案設定→服務帳戶」產生的私密金鑰
// JSON，整包存成一個 Vercel 環境變數（Production）。這把金鑰等同資料庫最高權限，只存在
// Vercel 的加密環境變數裡，不會出現在程式碼或任何公開頁面。

// firebase-admin v12+ 的 CJS 預設匯出（require('firebase-admin')）在 Vercel 的打包環境下
// 讀不到 .credential.cert（undefined），改用官方現在建議的 modular API 就正常了。
const { initializeApp, cert, getApps } = require('firebase-admin/app');
const { getDatabase } = require('firebase-admin/database');

const DATABASE_URL = 'https://qingjing-studio-default-rtdb.firebaseio.com';

function getApp() {
  if (getApps().length) return getApps()[0];
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT_KEY;
  if (!raw) throw new Error('FIREBASE_SERVICE_ACCOUNT_KEY 未設定');
  const serviceAccount = JSON.parse(raw);
  return initializeApp({
    credential: cert(serviceAccount),
    databaseURL: DATABASE_URL,
  });
}

// 保持跟舊版「裸 fetch REST API」一樣的介面（path + {method, body}），
// 這樣呼叫端的程式碼幾乎不用改，只是底層換成 Admin SDK。
async function fb(path, opts) {
  const ref = getDatabase(getApp()).ref(String(path).replace(/^\//, ''));
  const method = (opts && opts.method) || 'GET';

  if (method === 'GET') {
    const snap = await ref.once('value');
    return snap.val();
  }
  const body = opts && opts.body ? JSON.parse(opts.body) : undefined;
  if (method === 'PUT') {
    await ref.set(body);
    return body;
  }
  if (method === 'PATCH') {
    await ref.update(body);
    return body;
  }
  if (method === 'DELETE') {
    await ref.remove();
    return null;
  }
  throw new Error('Unsupported method: ' + method);
}

module.exports = { fb };

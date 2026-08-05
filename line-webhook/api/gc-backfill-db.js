// 專給 scripts/gc_backfill.py（每天 23:30 打烊後的每日補簽排程）用的資料庫存取代理。
//
// 背景：資料庫規則收緊成「只有登入過的人能讀寫」（2026-08-05）之後，這支 Python
// 排程原本直接用公開的 Firebase apiKey 當 ?auth= 打 REST API 的做法就失效了——
// apiKey 不是登入權杖，資料庫規則看不到 auth，一律當未登入擋掉。
// index.html 走 Firebase 匿名登入解決，這支獨立的 Python 腳本沒有瀏覽器環境跑不了
// 匿名登入，所以改成跟 gc-token.js／send-checkin-message.js 同樣模式：伺服器端用
// Admin SDK（fb()，繞過資料庫規則）代為讀寫，前面用只有這支腳本知道的金鑰把關。
//
// 只開放 gc_backfill.py 實際需要的三個路徑（白名單），不是任意路徑都能讀寫，
// 免得這支 API 變相成為一個繞過規則的萬用後門。
const { fb } = require('../lib/firebaseAdmin');

const GC_BACKFILL_DB_SECRET = process.env.GC_BACKFILL_DB_SECRET || '';
const ALLOWED_PATHS = new Set(['qingjing/s', 'qingjing/r', 'qingjing_teacher_calmap', 'qingjing']);

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, PATCH, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') {
    res.status(204).end();
    return;
  }
  if (!GC_BACKFILL_DB_SECRET || req.query.key !== GC_BACKFILL_DB_SECRET) {
    res.status(403).json({ ok: false, error: 'forbidden' });
    return;
  }
  const path = String(req.query.path || '');
  if (!ALLOWED_PATHS.has(path)) {
    res.status(400).json({ ok: false, error: 'path not allowed' });
    return;
  }

  try {
    if (req.method === 'GET') {
      const data = await fb(`/${path}`, { method: 'GET' });
      res.status(200).json({ ok: true, data });
      return;
    }
    if (req.method === 'PATCH') {
      // Vercel 預設會幫忙 parse JSON body 成物件，直接丟給 fb() 就好，不用自己再 stringify
      await fb(`/${path}`, { method: 'PATCH', body: JSON.stringify(req.body || {}) });
      res.status(200).json({ ok: true });
      return;
    }
    res.status(405).json({ ok: false, error: 'method not allowed' });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
};

// 專給沒有瀏覽器環境（跑不了 index.html 的匿名登入）的 GitHub Actions 排程腳本用的
// 資料庫存取代理：scripts/daily_digest.py、scripts/teacher_reminder.py、
// scripts/line_reminder.py。
//
// 背景：資料庫規則收緊成「只有登入過的人能讀寫」（2026-08-05）之後，這三支腳本
// 原本直接裸打 Firebase REST API（或帶著早就證實無效的公開 apiKey）的做法會被規則
// 擋下來。跟 gc-backfill-db.js（專給 scripts/gc_backfill.py 用）同樣模式：伺服器端用
// Admin SDK（fb()，繞過資料庫規則）代為讀寫，前面用只有這幾支腳本知道的金鑰把關。
//
// 只開放這三支腳本實際需要的路徑（白名單），不是任意路徑都能讀寫，免得這支 API
// 變相成為一個繞過規則的萬用後門。
const { fb } = require('../lib/firebaseAdmin');

const SCRIPTS_DB_SECRET = process.env.SCRIPTS_DB_SECRET || '';
const READABLE_PATHS = new Set([
  'qingjing',
  'qingjing_ledger',
  'qingjing_teacher_phones',
  'qingjing_teacher_calmap',
  'qingjing_line_bindings_teacher',
  'qingjing_line_bindings',
]);
// line_reminder.py 把當天待確認的推播清單整包 PUT 進去，等店長按 ntfy 上的「確認送出」
// 才由 confirm-send.js（走同一套 fb()）真的推播出去
const WRITABLE_PATHS = new Set(['qingjing_line_pending']);

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, PUT, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') {
    res.status(204).end();
    return;
  }
  if (!SCRIPTS_DB_SECRET || req.query.key !== SCRIPTS_DB_SECRET) {
    res.status(403).json({ ok: false, error: 'forbidden' });
    return;
  }
  const path = String(req.query.path || '');

  try {
    if (req.method === 'GET') {
      if (!READABLE_PATHS.has(path)) {
        res.status(400).json({ ok: false, error: 'path not allowed' });
        return;
      }
      const data = await fb(`/${path}`, { method: 'GET' });
      res.status(200).json({ ok: true, data });
      return;
    }
    if (req.method === 'PUT') {
      if (!WRITABLE_PATHS.has(path)) {
        res.status(400).json({ ok: false, error: 'path not allowed' });
        return;
      }
      // Vercel 預設會幫忙 parse JSON body 成物件，直接丟給 fb() 就好，不用自己再 stringify
      await fb(`/${path}`, { method: 'PUT', body: JSON.stringify(req.body || {}) });
      res.status(200).json({ ok: true });
      return;
    }
    res.status(405).json({ ok: false, error: 'method not allowed' });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
};

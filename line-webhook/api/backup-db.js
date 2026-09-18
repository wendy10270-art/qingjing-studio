// 每日全庫自動備份（取代手動跑 scripts/backup_full_db.py）。
//
// 背景：2026-09-18 學員「盧韻如」的主檔被 deleteStu 永久刪除，事後發現系統從來沒有
// 排程備份（後台顯示「從未備份」）。這支 API 就是補這個洞：由 GitHub Actions 排程
// 每天固定時間打這支 API，伺服器端用 Admin SDK 把整個 qingjing（s/r/sch/t/l）+
// qingjing_ledger 讀出來，存進 Firebase 自己的 qingjing_backups/{yyyy-mm-dd} 節點。
//
// 為什麼不存 GitHub Actions artifact 或 commit 進 repo：這個 repo 是公開的
// （wendy10270-art/qingjing-studio），備份裡有學員姓名、電話等個資，寫進任何公開
// 可見的地方都是外洩。存進 Firebase RTDB（跟現有資料同一顆資料庫、同一套安全規則）
// 才不會多一個外洩管道。
//
// 跟 gc-backfill-db.js／scripts-db.js 同樣模式：伺服器端用 Admin SDK（fb()，繞過
// 資料庫規則）讀寫，前面用只有這支排程知道的金鑰把關，不開放任意路徑。
const { fb } = require('../lib/firebaseAdmin');

const BACKUP_SECRET = process.env.BACKUP_SECRET || '';
const READ_PATHS = ['qingjing', 'qingjing_ledger'];
const RETENTION_DAYS = 30;

function todayDateKey() {
  // 用台北時間當天日期當 key，跟其他排程（daily_digest 等）看到的「今天」一致
  const now = new Date();
  const taipei = new Date(now.toLocaleString('en-US', { timeZone: 'Asia/Taipei' }));
  const y = taipei.getFullYear();
  const m = String(taipei.getMonth() + 1).padStart(2, '0');
  const d = String(taipei.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

async function pruneOldBackups(allBackups, keepDateKey) {
  if (!allBackups || typeof allBackups !== 'object') return [];
  const cutoff = Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000;
  const removed = [];
  for (const dateKey of Object.keys(allBackups)) {
    if (dateKey === keepDateKey) continue;
    const t = Date.parse(dateKey); // 'yyyy-mm-dd' 可直接被 Date.parse 解析（UTC 午夜）
    if (!Number.isNaN(t) && t < cutoff) {
      await fb(`/qingjing_backups/${dateKey}`, { method: 'DELETE' });
      removed.push(dateKey);
    }
  }
  return removed;
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') {
    res.status(204).end();
    return;
  }
  const key = req.query.key || (req.body && req.body.key);
  if (!BACKUP_SECRET || key !== BACKUP_SECRET) {
    res.status(403).json({ ok: false, error: 'forbidden' });
    return;
  }
  if (req.method !== 'GET' && req.method !== 'POST') {
    res.status(405).json({ ok: false, error: 'method not allowed' });
    return;
  }

  try {
    const snapshot = {};
    for (const path of READ_PATHS) {
      snapshot[path] = await fb(`/${path}`, { method: 'GET' });
    }

    const dateKey = todayDateKey();
    const backedUpAt = new Date().toISOString();
    await fb(`/qingjing_backups/${dateKey}`, {
      method: 'PUT',
      body: JSON.stringify({ backedUpAt, data: snapshot }),
    });

    // 寫入成功後才清舊快照，避免清舊的那步失敗連累今天這份沒存到
    const allBackups = await fb('/qingjing_backups', { method: 'GET' });
    const removed = await pruneOldBackups(allBackups, dateKey);

    const qj = snapshot.qingjing || {};
    res.status(200).json({
      ok: true,
      dateKey,
      backedUpAt,
      counts: {
        s: Array.isArray(qj.s) ? qj.s.length : (qj.s ? Object.keys(qj.s).length : 0),
        r: Array.isArray(qj.r) ? qj.r.length : (qj.r ? Object.keys(qj.r).length : 0),
        ledger: Array.isArray(snapshot.qingjing_ledger) ? snapshot.qingjing_ledger.length : 0,
      },
      removedOldBackups: removed,
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
};

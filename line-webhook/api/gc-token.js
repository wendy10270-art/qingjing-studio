// Mints a fresh Google Calendar access_token from the refresh_token stashed in
// Firebase by gc-oauth-callback.js. index.html calls this instead of talking to
// Google Identity Services directly — this is what actually fixes "have to
// reconnect every time I reopen the app": a real refresh_token doesn't expire
// just because the browser tab was closed, unlike the ~1hr access_token the old
// client-only flow relied on.

const { fb } = require('../lib/firebaseAdmin');

const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET || '';
// 前端每次呼叫都要帶這把鑰匙，避免任何人拿到這支網址就能換到工作室的 Google 日曆存取權
const GC_TOKEN_SECRET = process.env.GC_TOKEN_SECRET || '';

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') {
    res.status(204).end();
    return;
  }
  if (!GC_TOKEN_SECRET || req.query.key !== GC_TOKEN_SECRET) {
    res.status(403).json({ ok: false, error: 'forbidden' });
    return;
  }
  if (!GOOGLE_CLIENT_SECRET) {
    res.status(500).json({ ok: false, error: 'server_not_configured' });
    return;
  }

  let stored;
  try {
    stored = await fb('/qingjing_gc_refresh_token');
  } catch (e) {
    res.status(500).json({ ok: false, error: '查詢 Firebase 失敗：' + e.message });
    return;
  }
  if (!stored || !stored.refresh_token || !stored.client_id) {
    res.status(200).json({ ok: false, error: 'not_connected' });
    return;
  }

  try {
    const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        refresh_token: stored.refresh_token,
        client_id: stored.client_id,
        client_secret: GOOGLE_CLIENT_SECRET,
        grant_type: 'refresh_token',
      }),
    });
    const tokenData = await tokenRes.json();
    if (!tokenRes.ok || !tokenData.access_token) {
      // invalid_grant 通常代表 refresh_token 被使用者自己在 Google 帳號設定裡撤銷了，
      // 這種情況真的需要走一次完整的重新連接，不是這支 API 能補救的
      throw new Error(tokenData.error_description || tokenData.error || `refresh failed: ${tokenRes.status}`);
    }
    res.status(200).json({ ok: true, access_token: tokenData.access_token, expires_in: tokenData.expires_in });
  } catch (e) {
    console.error('gc-token refresh error', e);
    res.status(200).json({ ok: false, error: e.message });
  }
};

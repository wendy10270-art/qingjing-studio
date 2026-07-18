// Google redirects here after the studio manager approves calendar access
// (started from index.html's GC.connect(), which opens a popup pointing at
// Google's own /o/oauth2/v2/auth endpoint directly — no "start" endpoint needed
// since building that URL doesn't require the client secret).
//
// This is the one step that DOES need the client secret, so it has to happen
// server-side: exchange the one-time `code` for an access_token + refresh_token,
// stash the refresh_token in Firebase (qingjing_gc_refresh_token), and hand the
// access_token back to the popup's opener via postMessage. From then on the
// frontend never talks to Google's auth servers again — see gc-token.js.

const { fb } = require('../lib/firebaseAdmin');

const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET || '';
// 一定要跟 index.html 開授權視窗時用的 redirect_uri 完全一致，Google 才會接受
const REDIRECT_URI = 'https://line-webhook-gules.vercel.app/api/gc-oauth-callback';

function popupResponsePage(payload) {
  // 回傳一個小頁面給彈出視窗本身，用 postMessage 把結果丟回開啟它的主視窗，然後自己關掉
  return `<!doctype html><html><body style="font-family:sans-serif;padding:24px;text-align:center;color:#666">
<p>${payload.ok ? '連接成功，正在關閉視窗…' : '連接失敗：' + (payload.error || '未知錯誤')}</p>
<script>
  if (window.opener) window.opener.postMessage(${JSON.stringify(payload)}, '*');
  setTimeout(function(){ window.close(); }, ${payload.ok ? 800 : 4000});
</script>
</body></html>`;
}

module.exports = async (req, res) => {
  const { code, state, error } = req.query || {};

  if (error) {
    res.status(200).send(popupResponsePage({ type: 'gc-oauth-result', ok: false, error }));
    return;
  }
  if (!code || !state) {
    res.status(400).send(popupResponsePage({ type: 'gc-oauth-result', ok: false, error: '缺少 code 或 state' }));
    return;
  }

  let clientId;
  try {
    clientId = JSON.parse(Buffer.from(state, 'base64').toString('utf8')).client_id;
  } catch (e) {
    res.status(400).send(popupResponsePage({ type: 'gc-oauth-result', ok: false, error: 'state 格式錯誤' }));
    return;
  }
  if (!clientId || !GOOGLE_CLIENT_SECRET) {
    res.status(500).send(popupResponsePage({ type: 'gc-oauth-result', ok: false, error: '伺服器尚未設定 client secret' }));
    return;
  }

  try {
    const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code,
        client_id: clientId,
        client_secret: GOOGLE_CLIENT_SECRET,
        redirect_uri: REDIRECT_URI,
        grant_type: 'authorization_code',
      }),
    });
    const tokenData = await tokenRes.json();
    if (!tokenRes.ok || !tokenData.access_token) {
      throw new Error(tokenData.error_description || tokenData.error || `token exchange failed: ${tokenRes.status}`);
    }

    // refresh_token 只有在使用者「第一次」同意（或用 prompt=consent 強制重新同意）時才會回傳；
    // 沒有的話代表這個 Google 帳號之前已經核准過，直接沿用 Firebase 裡既有的那組即可
    if (tokenData.refresh_token) {
      await fb('/qingjing_gc_refresh_token', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ client_id: clientId, refresh_token: tokenData.refresh_token, savedAt: Date.now() }),
      });
    }

    res.status(200).send(popupResponsePage({
      type: 'gc-oauth-result',
      ok: true,
      access_token: tokenData.access_token,
      expires_in: tokenData.expires_in,
    }));
  } catch (e) {
    console.error('gc-oauth-callback exchange error', e);
    res.status(200).send(popupResponsePage({ type: 'gc-oauth-result', ok: false, error: e.message }));
  }
};

// Called from index.html's 薪資結算 tab — sends the already-rendered HTML payroll
// breakdown straight to a teacher's inbox via Gmail SMTP, so they get a properly
// laid-out table instead of a screenshot or a wall of copy-pasted plain text.
//
// Uses Gmail (nodemailer) instead of a transactional-email provider like Resend
// on purpose: Resend's shared sending domain can only deliver to the account
// owner's own inbox until a custom domain is DNS-verified, and this studio
// doesn't own a domain. Gmail + an App Password can send to any recipient with
// no domain needed.
//
// Separate secret from CHECKIN_PUSH_SECRET/TEACHER_PUSH_SECRET/GC_TOKEN_SECRET on
// purpose — this key is embedded client-side in index.html (GitHub Pages is fully
// public), so isolating it means a leak here can't be used to trigger the other
// push endpoints too.

const nodemailer = require('nodemailer');

const GMAIL_USER = process.env.GMAIL_USER || '';
const GMAIL_APP_PASSWORD = process.env.GMAIL_APP_PASSWORD || '';
const EMAIL_PUSH_SECRET = process.env.EMAIL_PUSH_SECRET || '';

let _transporter = null;
function getTransporter() {
  if (!_transporter) {
    _transporter = nodemailer.createTransport({
      service: 'gmail',
      auth: { user: GMAIL_USER, pass: GMAIL_APP_PASSWORD },
    });
  }
  return _transporter;
}

module.exports = async (req, res) => {
  // 跟 send-teacher-message.js 同樣理由：index.html 呼叫這支 API 是跨網域請求
  // （GitHub Pages → Vercel），瀏覽器一定會先送 OPTIONS 預檢
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.status(204).end();
    return;
  }
  if (req.method !== 'POST') {
    res.status(405).send('method not allowed');
    return;
  }
  if (!EMAIL_PUSH_SECRET || req.query.key !== EMAIL_PUSH_SECRET) {
    res.status(403).send('forbidden');
    return;
  }
  if (!GMAIL_USER || !GMAIL_APP_PASSWORD) {
    res.status(500).json({ ok: false, error: 'GMAIL_USER 或 GMAIL_APP_PASSWORD 未設定' });
    return;
  }

  const { to, subject, html } = req.body || {};
  if (!to || !subject || !html) {
    res.status(400).json({ ok: false, error: '缺少 to、subject 或 html' });
    return;
  }

  try {
    await getTransporter().sendMail({
      from: `輕境運動工作室 <${GMAIL_USER}>`,
      to,
      subject,
      html,
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
    return;
  }

  res.status(200).json({ ok: true });
};

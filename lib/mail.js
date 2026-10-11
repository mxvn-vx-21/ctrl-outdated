/* Transactional email via Resend. Server-side only: RESEND_API_KEY and MAIL_FROM come from the environment. */
export class MailError extends Error {}
export const mailConfigured = (env) => !!(env.RESEND_API_KEY && env.MAIL_FROM);

export async function sendMail(env, { to, subject, html, text }) {
  let res;
  try {
    res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: env.MAIL_FROM, to: [to], subject, html, text }),
      signal: AbortSignal.timeout(10000),
    });
  } catch { throw new MailError('network'); }
  if (!res.ok) {
    let name = ''; try { name = (await res.json()).name || ''; } catch { /* ignore */ }
    console.error('Resend rejected the request', res.status, name); // never log the body/recipient
    throw new MailError('provider');
  }
}

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const FONT = "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";

function layout({ base, title, preheader, intro, cta, url, expiry, footer }) {
  const button = cta ? `<tr><td style="padding:8px 0 20px"><a href="${esc(url)}" style="display:block;background:#0b0b0b;color:#ffffff;text-decoration:none;text-align:center;font-weight:600;font-size:16px;padding:16px 20px;border-radius:14px">${esc(cta)}</a></td></tr>
    <tr><td style="font-size:13px;color:#6b6b6b;padding-bottom:6px">Or copy and paste this link into your browser:</td></tr>
    <tr><td style="font-size:13px;word-break:break-all;padding-bottom:18px"><a href="${esc(url)}" style="color:#0b0b0b">${esc(url)}</a></td></tr>` : '';
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light"><title>${esc(title)}</title></head>
<body style="margin:0;padding:0;background:#f5f5f5;font-family:${FONT};color:#0b0b0b">
<div style="display:none;max-height:0;overflow:hidden;opacity:0">${esc(preheader)}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f5f5f5"><tr><td align="center" style="padding:24px 12px">
<table role="presentation" width="560" cellpadding="0" cellspacing="0" style="width:100%;max-width:560px;background:#ffffff;border:1px solid #e4e4e4;border-radius:20px;overflow:hidden">
<tr><td><img src="${esc(base)}/email-header.png" width="560" alt="CTRL" style="display:block;width:100%;height:auto;border:0"></td></tr>
<tr><td style="padding:28px 32px 8px"><table role="presentation" width="100%" cellpadding="0" cellspacing="0">
<tr><td style="font-size:26px;font-weight:700;padding-bottom:12px">${esc(title)}</td></tr>
<tr><td style="font-size:16px;line-height:1.55;color:#333;padding-bottom:20px">${intro}</td></tr>
${button}
${expiry ? `<tr><td style="font-size:13px;color:#6b6b6b;padding-bottom:12px">${esc(expiry)}</td></tr>` : ''}
</table></td></tr>
<tr><td style="padding:12px 32px 28px;font-size:12px;line-height:1.5;color:#8c8c8c;border-top:1px solid #f0f0f0">${esc(footer)}<br>CTRL · Your life, under control.</td></tr>
</table></td></tr></table></body></html>`;
}

export function verifyEmail({ to, base, url }) {
  const expiry = 'This link expires in 15 minutes and can be used once.';
  return {
    to, subject: 'Verify your CTRL account',
    html: layout({ base, title: 'Verify your email', preheader: 'Confirm your email to activate your CTRL workspace.',
      intro: 'Click the button below to verify your email and activate your workspace.', cta: 'Verify email', url, expiry,
      footer: "You received this because someone used this address to create a CTRL workspace. If that wasn't you, you can ignore this email." }),
    text: `Verify your CTRL account\n\nOpen this link to verify your email and activate your workspace:\n${url}\n\n${expiry}\n\nIf you didn't request this, ignore this email.`,
  };
}
export function recoverEmail({ to, base, url }) {
  const expiry = 'This link expires in 30 minutes and can be used once.';
  return {
    to, subject: 'Reset your CTRL code',
    html: layout({ base, title: 'Reset your code', preheader: 'Choose a new 4-character code for your CTRL workspace.',
      intro: 'We received a request to reset the access code for your CTRL workspace. Use the button below to choose a new one. Your tasks and notes are not affected.', cta: 'Choose a new code', url, expiry,
      footer: "If you didn't ask for this, you can ignore this email. Your current code keeps working." }),
    text: `Reset your CTRL code\n\nOpen this link to choose a new 4-character code (your data is not affected):\n${url}\n\n${expiry}\n\nIf you didn't ask for this, ignore this email. Your current code keeps working.`,
  };
}
export function existsEmail({ to, base }) {
  const url = `${base}/recover`;
  return {
    to, subject: 'You already have a CTRL workspace',
    html: layout({ base, title: 'You already have a workspace', preheader: 'This email is already linked to a CTRL workspace.',
      intro: 'Someone tried to create a new CTRL workspace with this email address, but one already exists. If it was you, log in with your 4-character code, or reset it if you have forgotten it.', cta: 'Forgot your code?', url, expiry: '',
      footer: "If this wasn't you, no action is needed. Nothing has changed on your workspace." }),
    text: `You already have a CTRL workspace\n\nSomeone tried to create a workspace with this email, but one already exists. If it was you, log in with your code or reset it here:\n${url}\n\nIf this wasn't you, no action is needed.`,
  };
}

import { HttpError, bad, json } from './http.js';
import {
  TOKEN_RE, assertNotLocked, buildCookie, codeHash, cookieName, globalSlowdown, hmacHex, limit,
  maskEmail, normalizeEmail, randomToken, readCookie, recordFailure, sha256Hex, validCode,
} from './security.js';
import { existsEmail, mailConfigured, recoverEmail, sendMail, verifyEmail } from './mail.js';

const SESSION_DAYS = 30;
const CODE_RULE = 'Your code must be exactly 4 characters: letters, numbers or symbols (no spaces).';
const MAIL_FAIL = "We couldn't send the email right now. Please try again in a moment.";

function requireMail(c) {
  if (!mailConfigured(c.env)) throw new HttpError(503, 'Email sending isn\'t set up on this server yet.', 'mail_not_configured');
}
async function send(c, message) {
  try { await sendMail(c.env, message); } catch { throw new HttpError(502, MAIL_FAIL, 'mail_failed'); }
}
async function startSession(c, workspaceId) {
  const token = randomToken();
  await c.store.createSession(workspaceId, await sha256Hex(token), SESSION_DAYS);
  return buildCookie(cookieName(c.secure), token, SESSION_DAYS * 86400, c.secure);
}
const emailKey = (c, email) => hmacHex(c.env.CODE_PEPPER, 'email:' + email);
const tokenArg = (v) => { if (typeof v !== 'string' || !TOKEN_RE.test(v)) throw new HttpError(400, "This link isn't valid. Please request a new one.", 'invalid_token'); return v; };

async function tokenProblem(c, token, kind) {
  const s = await c.store.tokenStatus(await sha256Hex(token), kind);
  if (s === 'used') return new HttpError(410, 'This link has already been used.', 'token_used');
  if (s === 'expired') return new HttpError(410, 'This link has expired. Please request a new one.', 'token_expired');
  return new HttpError(400, "This link isn't valid. Please request a new one.", 'invalid_token');
}

export async function getSession(c) {
  const t = readCookie(c.request, cookieName(c.secure));
  if (!t || t.length > 100) return null;
  return c.store.getSession(await sha256Hex(t));
}

export async function sessionInfo(c) {
  const s = await getSession(c);
  return json(s ? { authed: true, email: maskEmail(s.email) } : { authed: false });
}

export async function signup(c, body) {
  const email = normalizeEmail(body.email);
  if (!email) throw bad('Please enter a valid email address.');
  if (!validCode(body.code)) throw bad(CODE_RULE, 'bad_code');
  if (body.acknowledged !== true) throw bad('Please confirm that you understand how your code works.');
  requireMail(c);
  await limit(c, 'signup:ip:' + c.ipKey, 8, 3600);
  await limit(c, 'signup:email:' + (await emailKey(c, email)), 4, 3600);
  await c.store.purgeStale();

  const token = randomToken();
  const r = await c.store.createPending({ email, codeHash: await codeHash(c.env, body.code), tokenHash: await sha256Hex(token), ttlMin: 15 });
  if (r.result === 'code_taken') throw new HttpError(409, 'That code is already taken. Please choose a different one.', 'code_taken');

  // For an email that already has a workspace we answer identically (no enumeration) but send a different email.
  const message = r.result === 'created' ? verifyEmail({ to: email, base: c.base, url: `${c.base}/verify/${token}` }) : existsEmail({ to: email, base: c.base });
  try { await sendMail(c.env, message); }
  catch {
    if (r.workspaceId) await c.store.deleteWorkspace(r.workspaceId); // release the reservation; nothing was sent
    throw new HttpError(502, MAIL_FAIL, 'mail_failed');
  }
  return json({ ok: true });
}

export async function resend(c, body) {
  const email = normalizeEmail(body.email);
  if (!email) throw bad('Please enter a valid email address.');
  requireMail(c);
  await limit(c, 'resend:email:' + (await emailKey(c, email)), 1, 60, 'Please wait a moment before requesting another email.');
  await limit(c, 'resend:ip:' + c.ipKey, 10, 3600);
  const w = await c.store.findPendingByEmail(email);
  if (w) {
    const token = randomToken();
    await c.store.replaceToken({ workspaceId: w.id, kind: 'verify', tokenHash: await sha256Hex(token), ttlMin: 15 });
    await send(c, verifyEmail({ to: email, base: c.base, url: `${c.base}/verify/${token}` }));
  }
  return json({ ok: true }); // identical whether or not a pending signup exists
}

export async function verify(c, body) {
  const token = tokenArg(body.token);
  await limit(c, 'verify:ip:' + c.ipKey, 30, 600);
  const id = await c.store.consumeVerify(await sha256Hex(token));
  if (!id) throw await tokenProblem(c, token, 'verify');
  return json({ ok: true }, 200, { 'Set-Cookie': await startSession(c, id) });
}

export async function login(c, body) {
  if (!validCode(body.code)) throw bad('Enter all 4 characters of your code.', 'bad_code');
  await assertNotLocked(c);
  await limit(c, 'login:ip:' + c.ipKey, 40, 600);
  await globalSlowdown(c);
  const w = await c.store.findActiveByCode(await codeHash(c.env, body.code));
  if (!w) {
    await recordFailure(c);
    throw new HttpError(401, 'No workspace found with this code.', 'invalid_code');
  }
  return json({ ok: true }, 200, { 'Set-Cookie': await startSession(c, w.id) });
}

export async function recover(c, body) {
  const email = normalizeEmail(body.email);
  if (!email) throw bad('Please enter a valid email address.');
  requireMail(c);
  await limit(c, 'recover:ip:' + c.ipKey, 6, 3600);
  await limit(c, 'recover:email:' + (await emailKey(c, email)), 1, 60, 'Please wait a moment before requesting another email.');
  const w = await c.store.findActiveByEmail(email);
  if (w) {
    const token = randomToken();
    await c.store.replaceToken({ workspaceId: w.id, kind: 'recover', tokenHash: await sha256Hex(token), ttlMin: 30 });
    await send(c, recoverEmail({ to: email, base: c.base, url: `${c.base}/reset/${token}` }));
  }
  return json({ ok: true }); // generic: same answer for unknown emails
}

/** Lets the reset page show "expired / already used" before the user types a new code. Does not consume the token. */
export async function checkToken(c, body) {
  const token = tokenArg(body.token);
  await limit(c, 'check:ip:' + c.ipKey, 30, 600);
  const kind = body.kind === 'verify' ? 'verify' : 'recover';
  if ((await c.store.tokenStatus(await sha256Hex(token), kind)) !== 'valid') throw await tokenProblem(c, token, kind);
  return json({ valid: true });
}

export async function reset(c, body) {
  const token = tokenArg(body.token);
  if (!validCode(body.code)) throw bad(CODE_RULE, 'bad_code');
  if (body.acknowledged !== true) throw bad('Please confirm that you understand how your code works.');
  await limit(c, 'reset:ip:' + c.ipKey, 15, 600);
  const r = await c.store.resetCode({ tokenHash: await sha256Hex(token), codeHash: await codeHash(c.env, body.code) });
  if (r.result === 'code_taken') throw new HttpError(409, 'That code is already taken. Please choose a different one.', 'code_taken');
  if (r.result === 'invalid') throw await tokenProblem(c, token, 'recover');
  return json({ ok: true }, 200, { 'Set-Cookie': await startSession(c, r.workspaceId) });
}

export async function logout(c) {
  const t = readCookie(c.request, cookieName(c.secure));
  if (t) await c.store.deleteSession(await sha256Hex(t));
  return json({ ok: true }, 200, { 'Set-Cookie': buildCookie(cookieName(c.secure), '', 0, c.secure) });
}

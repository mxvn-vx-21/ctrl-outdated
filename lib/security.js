import { HttpError } from './http.js';

const enc = new TextEncoder();
const toHex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
const toB64Url = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

/** Keyed hash. Secret = CODE_PEPPER (kept in Cloudflare, never in the database). */
export async function hmacHex(secret, msg) {
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return toHex(await crypto.subtle.sign('HMAC', key, enc.encode(msg)));
}
export const sha256Hex = async (msg) => toHex(await crypto.subtle.digest('SHA-256', enc.encode(msg)));
/** 256-bit random token, URL-safe (43 chars). */
export const randomToken = () => toB64Url(crypto.getRandomValues(new Uint8Array(32)));
export const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;

/**
 * Access code = exactly 4 characters from printable ASCII (letters, digits, punctuation, symbols), no spaces.
 * Case-sensitive. Never trimmed or normalised. (ASCII-only avoids Unicode normalisation mismatches between devices.)
 */
export const CODE_RE = /^[\x21-\x7E]{4}$/;
export const validCode = (c) => typeof c === 'string' && CODE_RE.test(c);

export function normalizeEmail(e) {
  if (typeof e !== 'string') return null;
  const v = e.trim().toLowerCase();
  return v.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(v) ? v : null;
}
export const maskEmail = (e) => { const [u, d] = e.split('@'); return `${u[0]}***@${d}`; };

export const codeHash = (env, code) => hmacHex(env.CODE_PEPPER, 'code:' + code);

/** Fixed-window rate limit; throws 429. */
export async function limit(c, key, max, windowSec, message) {
  const r = await c.store.rateHit(key, max, windowSec);
  if (r.count > max) {
    throw new HttpError(429, message || `Too many attempts. Please try again in ${fmtWait(r.retry)}.`, 'rate_limited', { retryAfter: r.retry });
  }
}
export const fmtWait = (s) => (s >= 90 ? `${Math.ceil(s / 60)} minutes` : `${s} seconds`);

/** Progressive lockout for wrong codes: 4 free misses, then 30s, 60s, 2m, 4m … up to 1h (per client). */
export async function assertNotLocked(c) {
  const wait = await c.store.lockWait(c.ipKey);
  if (wait > 0) throw new HttpError(429, `Too many wrong codes. Try again in ${fmtWait(wait)}.`, 'locked', { retryAfter: wait });
}
export async function recordFailure(c) {
  const fails = await c.store.recordFail(c.ipKey);
  if (fails >= 5) await c.store.setLock(c.ipKey, Math.min(30 * 2 ** (fails - 5), 3600));
}
/** Soft global slow-down (not a lockout, so attackers can't lock everyone out). */
export async function globalSlowdown(c) {
  const n = await c.store.globalFails();
  if (n > 300) await new Promise((r) => setTimeout(r, Math.min(3000, (n - 300) * 5)));
}

export const cookieName = (secure) => (secure ? '__Host-ctrl_session' : 'ctrl_session');
export const buildCookie = (name, value, maxAge, secure) =>
  `${name}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure ? '; Secure' : ''}`;
export function readCookie(request, name) {
  const hit = (request.headers.get('Cookie') || '').split(/;\s*/).find((p) => p.startsWith(name + '='));
  return hit ? hit.slice(name.length + 1) : null;
}

import { HttpError, bad, json } from './http.js';
import { TABLES, clean } from './data.js';
import { hmacHex } from './security.js';
import * as auth from './auth.js';

const AUTH_POST = { signup: auth.signup, resend: auth.resend, verify: auth.verify, login: auth.login, recover: auth.recover, check: auth.checkToken, reset: auth.reset };

async function body(request) {
  try { const b = await request.json(); if (b && typeof b === 'object' && !Array.isArray(b)) return b; } catch { /* fallthrough */ }
  throw bad('Invalid request');
}

/** Core request handler. `store` is injected (Postgres in production, in-memory in tests). */
export async function handle({ request, env, seg, store }) {
  const url = new URL(request.url);
  const method = request.method;
  if (!env.CODE_PEPPER || String(env.CODE_PEPPER).length < 32) throw new HttpError(503, 'Server not configured: set CODE_PEPPER (32+ characters).', 'not_configured');

  if (method !== 'GET' && method !== 'HEAD') { // CSRF: custom header (can't be sent cross-site without CORS) + Origin check
    if (request.headers.get('X-CTRL') !== '1') throw new HttpError(403, 'Bad request', 'csrf');
    const origin = request.headers.get('Origin');
    if (origin && new URL(origin).host !== url.host) throw new HttpError(403, 'Bad origin', 'csrf');
  }

  const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
  const c = {
    request, env, store, url, ip, ipKey: await hmacHex(env.CODE_PEPPER, 'ip:' + ip),
    base: String(env.APP_URL || url.origin).replace(/\/$/, ''), secure: url.protocol === 'https:',
  };

  if (seg[0] === 'auth') {
    if (seg[1] === 'session' && method === 'GET') return auth.sessionInfo(c);
    if (seg[1] === 'logout' && method === 'POST') return auth.logout(c);
    if (method === 'POST' && AUTH_POST[seg[1]]) return AUTH_POST[seg[1]](c, await body(request));
    throw new HttpError(404, 'Not found');
  }

  // Everything below needs a valid session. The workspace comes ONLY from the server-side session.
  const session = await auth.getSession(c);
  if (!session) throw new HttpError(401, 'Please enter your code to continue.', 'unauthenticated');
  const ws = session.workspaceId;

  if (seg[0] === 'state' && method === 'GET') return json(await store.list(ws));
  if (seg[0] === 'all' && method === 'DELETE') { await store.clearAll(ws); return json({ ok: true }); }

  if (TABLES.includes(seg[0])) {
    const table = seg[0];
    const checkFolder = async (o) => {
      if (table === 'notes' && o.folder_id != null && !(await store.folderExists(ws, o.folder_id))) throw bad("That folder doesn't exist.");
    };
    if (seg.length === 1 && method === 'POST') {
      const o = clean(table, await body(request), false); await checkFolder(o);
      return json(await store.insert(ws, table, o), 201);
    }
    const id = Number(seg[1]);
    if (seg.length === 2 && Number.isInteger(id) && id > 0) {
      if (method === 'PUT') {
        const o = clean(table, await body(request), true); await checkFolder(o);
        const keys = Object.keys(o);
        const bump = !(table === 'notes' && keys.every((k) => k === 'is_pinned' || k === 'folder_id')); // pin/move keeps "last updated"
        const row = await store.update(ws, table, id, o, bump);
        if (!row) throw new HttpError(404, 'Not found');
        return json(row);
      }
      if (method === 'DELETE') { await store.remove(ws, table, id); return json({ ok: true }); }
    }
  }
  throw new HttpError(404, 'Not found');
}

export function errorResponse(e) {
  if (e instanceof HttpError) {
    const headers = e.extra && e.extra.retryAfter ? { 'Retry-After': String(e.extra.retryAfter) } : {};
    return json({ error: e.message, code: e.code, retryAfter: e.extra && e.extra.retryAfter }, e.status, headers);
  }
  // Never log request bodies, codes, emails or SQL detail.
  console.error('API error', e && e.name, e && e.code, e && e.constraint_name);
  return json({ error: 'Something went wrong on our side. Please try again.' }, 500);
}

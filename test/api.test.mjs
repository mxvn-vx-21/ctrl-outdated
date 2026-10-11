import test from 'node:test';
import assert from 'node:assert/strict';
import { handle, errorResponse } from '../lib/router.js';
import { validCode, normalizeEmail } from '../lib/security.js';
import { makeMemStore } from './memstore.js';

const PEPPER = 'p'.repeat(40);
let sent = []; let mailMode = 'ok';
globalThis.fetch = async (url, init) => {
  if (!String(url).startsWith('https://api.resend.com/emails')) throw new Error('unexpected fetch ' + url);
  if (mailMode === 'fail') return new Response('{"name":"validation_error"}', { status: 422 });
  if (mailMode === 'net') throw new TypeError('network down');
  sent.push({ ...JSON.parse(init.body), auth: init.headers.Authorization });
  return new Response('{"id":"x"}', { status: 200 });
};
const baseEnv = { CODE_PEPPER: PEPPER, RESEND_API_KEY: 're_test', MAIL_FROM: 'CTRL <no-reply@example.test>', APP_URL: 'https://ctrl.example.test' };

function client(store, { ip = '1.1.1.1', env = baseEnv } = {}) {
  let cookie = '';
  const call = async (method, path, body, extra = {}) => {
    const headers = { 'CF-Connecting-IP': ip, ...extra };
    if (method !== 'GET') { headers['Content-Type'] = 'application/json'; if (!extra.noCsrf) headers['X-CTRL'] = '1'; }
    if (cookie) headers.Cookie = cookie;
    const request = new Request('https://ctrl.example.test/api/' + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
    let res; try { res = await handle({ request, env, seg: path.split('/'), store }); } catch (e) { res = errorResponse(e); }
    const set = res.headers.get('Set-Cookie'); if (set) cookie = set.split(';')[0];
    const data = await res.json().catch(() => ({}));
    return { status: res.status, data, setCookie: set, headers: res.headers };
  };
  return { call, clearCookie: () => { cookie = ''; } };
}
const tokenFromMail = (m) => m.text.match(/\/(?:verify|reset)\/([A-Za-z0-9_-]{43})/)[1];
async function makeAccount(store, email, code, ip) {
  const c = client(store, { ip }); sent = [];
  const r = await c.call('POST', 'auth/signup', { email, code, acknowledged: true });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const v = await c.call('POST', 'auth/verify', { token: tokenFromMail(sent.at(-1)) });
  assert.equal(v.status, 200); return c;
}

test('code format: exactly 4 printable ASCII chars, case-sensitive, no trimming', () => {
  for (const ok of ['aB7$', 'x./!', 'M0nO', '@#k9', 'C^2_', '1234', 'abcd']) assert.ok(validCode(ok), ok);
  for (const no of ['abc', 'abcde', '', 'ab c', ' abc', 'abc ', 'ab\n!', 'éabc', '😀abc', '12', null, undefined, 1234, ['a', 'b', 'c', 'd']]) assert.ok(!validCode(no), String(no));
  assert.equal(normalizeEmail('  Me@Example.COM '), 'me@example.com'); assert.equal(normalizeEmail('nope'), null);
});

test('signup rejects bad codes and missing acknowledgement on the server', async () => {
  const c = client(makeMemStore());
  for (const code of ['abc', 'abcde', 'ab c', '', 1234]) assert.equal((await c.call('POST', 'auth/signup', { email: 'a@b.co', code, acknowledged: true })).status, 400);
  assert.equal((await c.call('POST', 'auth/signup', { email: 'a@b.co', code: 'aB7$' })).status, 400);
  assert.equal((await c.call('POST', 'auth/signup', { email: 'bad', code: 'aB7$', acknowledged: true })).status, 400);
  assert.equal(sent.length, 0);
});

test('special-character codes work end to end and are case-sensitive', async () => {
  const store = makeMemStore();
  for (const [i, code] of ['aB7$', 'x./!', 'M0nO', '@#k9', 'C^2_'].entries()) {
    await makeAccount(store, `u${i}@example.com`, code, `9.9.9.${i}`);
    const c = client(store, { ip: `8.8.8.${i}` });
    assert.equal((await c.call('POST', 'auth/login', { code })).status, 200, code);
  }
  const c = client(store, { ip: '7.7.7.7' });
  assert.equal((await c.call('POST', 'auth/login', { code: 'm0No' })).status, 401); // case matters
});

test('account is inactive until the email is verified; token is single-use and expires', async () => {
  const store = makeMemStore(); sent = [];
  const c = client(store);
  assert.equal((await c.call('POST', 'auth/signup', { email: 'new@example.com', code: 'Q1w!', acknowledged: true })).status, 200);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].auth, 'Bearer re_test'); assert.deepEqual(sent[0].to, ['new@example.com']);
  assert.match(sent[0].html, /Verify email/); assert.match(sent[0].html, /expires in 15 minutes/);
  assert.ok(!JSON.stringify(sent[0]).includes('Q1w!'), 'code must never be emailed');
  const token = tokenFromMail(sent[0]);
  assert.equal((await client(store, { ip: '2.2.2.2' }).call('POST', 'auth/login', { code: 'Q1w!' })).status, 401, 'pending account cannot log in');
  const v = await c.call('POST', 'auth/verify', { token });
  assert.equal(v.status, 200); assert.match(v.setCookie, /HttpOnly/); assert.match(v.setCookie, /SameSite=Lax/);
  assert.equal((await c.call('POST', 'auth/verify', { token })).data.code, 'token_used');
  assert.equal((await client(store, { ip: '2.2.2.3' }).call('POST', 'auth/login', { code: 'Q1w!' })).status, 200);
  // expiry
  sent = []; const c2 = client(store, { ip: '3.3.3.3' });
  await c2.call('POST', 'auth/signup', { email: 'late@example.com', code: 'Z9z?', acknowledged: true });
  store.advance(16 * 60e3);
  const late = await c2.call('POST', 'auth/verify', { token: tokenFromMail(sent[0]) });
  assert.equal(late.status, 410); assert.equal(late.data.code, 'token_expired');
  assert.equal((await c2.call('POST', 'auth/verify', { token: 'x'.repeat(43) })).data.code, 'invalid_token');
  assert.equal((await c2.call('POST', 'auth/verify', { token: 'short' })).status, 400);
});

test('duplicate codes are refused; concurrent signups cannot both win', async () => {
  const store = makeMemStore(); await makeAccount(store, 'a@example.com', 'dup!', '4.4.4.1');
  const r = await client(store, { ip: '4.4.4.2' }).call('POST', 'auth/signup', { email: 'b@example.com', code: 'dup!', acknowledged: true });
  assert.equal(r.status, 409); assert.equal(r.data.code, 'code_taken');
  const s2 = makeMemStore();
  const res = await Promise.all(['c@example.com', 'd@example.com'].map((e, i) => client(s2, { ip: `5.5.5.${i}` }).call('POST', 'auth/signup', { email: e, code: 'race', acknowledged: true })));
  assert.deepEqual(res.map((x) => x.status).sort(), [200, 409]);
});

test('existing email: identical response, no second workspace, different email', async () => {
  const store = makeMemStore(); await makeAccount(store, 'dup@example.com', 'ab12', '6.6.6.1'); sent = [];
  const r = await client(store, { ip: '6.6.6.2' }).call('POST', 'auth/signup', { email: 'dup@example.com', code: 'zz99', acknowledged: true });
  assert.equal(r.status, 200); assert.match(sent[0].subject, /already have/i); assert.equal(store.db.workspaces.length, 1);
});

test('login: invalid code, progressive lockout, lockout expiry', async () => {
  const store = makeMemStore(); await makeAccount(store, 'l@example.com', 'good', '1.0.0.1');
  const c = client(store, { ip: '10.0.0.9' });
  for (let i = 0; i < 4; i++) { const r = await c.call('POST', 'auth/login', { code: 'bad' + i }); assert.equal(r.status, 401); assert.equal(r.data.error, 'No workspace found with this code.'); }
  assert.equal((await c.call('POST', 'auth/login', { code: 'bad5' })).status, 401);        // 5th miss sets 30s lock
  const locked = await c.call('POST', 'auth/login', { code: 'good' });
  assert.equal(locked.status, 429); assert.ok(Number(locked.headers.get('Retry-After')) > 0, 'right code also blocked while locked');
  store.advance(31e3); assert.equal((await c.call('POST', 'auth/login', { code: 'bad6' })).status, 401);
  assert.equal((await c.call('POST', 'auth/login', { code: 'good' })).status, 429);       // lock doubled to 60s
  store.advance(61e3); assert.equal((await c.call('POST', 'auth/login', { code: 'good' })).status, 200);
  assert.equal((await client(store, { ip: '10.0.0.10' }).call('POST', 'auth/login', { code: 'ab' })).status, 400);
});

test('sessions: required for data, logout invalidates, cookie never in body', async () => {
  const store = makeMemStore(); const c = await makeAccount(store, 's@example.com', 'sess', '1.2.3.4');
  assert.equal((await c.call('GET', 'auth/session')).data.authed, true);
  assert.equal((await c.call('GET', 'auth/session')).data.email, 's***@example.com');
  assert.equal((await c.call('GET', 'state')).status, 200);
  const stolen = [...store.db.sessions][0].hash; assert.equal(stolen.length, 64, 'only a hash is stored');
  assert.equal((await c.call('POST', 'auth/logout', {})).status, 200);
  const cookieAfter = c; // browser now holds an expired cookie; replay the old one:
  assert.equal(store.db.sessions.length, 0);
  assert.equal((await client(store).call('GET', 'state')).status, 401);
  void cookieAfter;
});

test('workspace data isolation (read, write, update, delete, folders)', async () => {
  const store = makeMemStore();
  const A = await makeAccount(store, 'a@example.com', 'AAAA', '1.1.1.1'); const B = await makeAccount(store, 'b@example.com', 'BBBB', '2.2.2.2');
  const ta = (await A.call('POST', 'tasks', { title: 'A task', due_date: '2026-10-12', priority: 2, workspace_id: 'evil' })).data;
  const fa = (await A.call('POST', 'folders', { name: 'Secret' })).data;
  const na = (await A.call('POST', 'notes', { title: 'A note', content: { blocks: [{ t: 'C', x: 'milk', c: true }] }, folder_id: fa.id })).data;
  assert.ok(!('workspace_id' in ta), 'internal ids are not exposed');
  assert.equal(store.db.tasks[0].workspace_id, [...store.db.workspaces].find((w) => w.email === 'a@example.com').id, 'client-supplied workspace_id ignored');
  const sb = (await B.call('GET', 'state')).data; assert.deepEqual([sb.tasks.length, sb.notes.length, sb.folders.length], [0, 0, 0]);
  assert.equal((await B.call('PUT', `tasks/${ta.id}`, { title: 'hacked' })).status, 404);
  assert.equal((await B.call('PUT', `notes/${na.id}`, { title: 'hacked' })).status, 404);
  await B.call('DELETE', `tasks/${ta.id}`); await B.call('DELETE', `folders/${fa.id}`);
  assert.equal((await B.call('POST', 'notes', { title: 'x', content: { blocks: [] }, folder_id: fa.id })).status, 400, "can't file a note in another workspace's folder");
  await B.call('DELETE', 'all');
  const sa = (await A.call('GET', 'state')).data;
  assert.equal(sa.tasks[0].title, 'A task'); assert.equal(sa.tasks[0].priority, 2); assert.equal(sa.tasks[0].due_date, '2026-10-12');
  assert.equal(sa.notes[0].content.blocks[0].c, true); assert.equal(sa.folders[0].name, 'Secret');
  // another device = a fresh client logging in with the same code
  const A2 = client(store, { ip: '3.3.3.3' }); await A2.call('POST', 'auth/login', { code: 'AAAA' });
  assert.equal((await A2.call('GET', 'state')).data.tasks[0].title, 'A task');
});

test('recovery: generic response, single-use token, new code replaces old, sessions revoked', async () => {
  const store = makeMemStore(); const A = await makeAccount(store, 'r@example.com', 'old1', '1.1.1.1'); sent = [];
  const c = client(store, { ip: '5.5.5.5' });
  const unknown = await c.call('POST', 'auth/recover', { email: 'nobody@example.com' });
  const real = await client(store, { ip: '5.5.5.6' }).call('POST', 'auth/recover', { email: 'r@example.com' });
  assert.deepEqual(unknown.data, real.data); assert.equal(sent.length, 1, 'only the real account gets mail');
  assert.ok(!JSON.stringify(sent[0]).includes('old1'), 'plaintext code is never emailed'); assert.match(sent[0].html, /30 minutes/);
  const token = tokenFromMail(sent[0]);
  assert.equal((await c.call('POST', 'auth/check', { token, kind: 'recover' })).status, 200);
  const taken = await makeAccount(store, 'o@example.com', 'tkn!', '1.1.1.9');
  assert.equal((await c.call('POST', 'auth/reset', { token, code: 'tkn!', acknowledged: true })).status, 409);
  assert.equal((await c.call('POST', 'auth/check', { token, kind: 'recover' })).status, 200, 'token survives a taken-code attempt');
  assert.equal((await c.call('POST', 'auth/reset', { token, code: 'bad', acknowledged: true })).status, 400);
  assert.equal((await c.call('POST', 'auth/reset', { token, code: 'new2', acknowledged: true })).status, 200);
  assert.equal((await c.call('POST', 'auth/reset', { token, code: 'new3', acknowledged: true })).data.code, 'token_used');
  assert.equal((await A.call('GET', 'state')).status, 401, 'old sessions revoked');
  assert.equal((await client(store, { ip: '6.6.6.6' }).call('POST', 'auth/login', { code: 'old1' })).status, 401);
  assert.equal((await client(store, { ip: '6.6.6.7' }).call('POST', 'auth/login', { code: 'new2' })).status, 200);
  void taken;
  store.advance(61e3); sent = []; await client(store, { ip: '7.7.7.7' }).call('POST', 'auth/recover', { email: 'r@example.com' }); store.advance(31 * 60e3);
  assert.equal((await c.call('POST', 'auth/reset', { token: tokenFromMail(sent[0]), code: 'zzzz', acknowledged: true })).data.code, 'token_expired');
});

test('resend: cooldown, new token invalidates the old one, generic for unknown email', async () => {
  const store = makeMemStore(); const c = client(store); sent = [];
  await c.call('POST', 'auth/signup', { email: 'p@example.com', code: 'pend', acknowledged: true });
  const first = tokenFromMail(sent[0]);
  assert.equal((await c.call('POST', 'auth/resend', { email: 'p@example.com' })).status, 200);
  assert.equal(sent.length, 2); const second = tokenFromMail(sent[1]); assert.notEqual(first, second);
  assert.equal((await c.call('POST', 'auth/resend', { email: 'p@example.com' })).status, 429, '60s cooldown');
  store.advance(61e3);
  assert.equal((await c.call('POST', 'auth/verify', { token: first })).status, 400, 'old token no longer valid');
  const unknown = await c.call('POST', 'auth/resend', { email: 'ghost@example.com' });
  assert.equal(unknown.status, 200); assert.equal(sent.length, 2, 'nothing sent for unknown email');
  assert.equal((await c.call('POST', 'auth/verify', { token: second })).status, 200);
});

test('provider failure: honest error, reservation released; missing config handled', async () => {
  const store = makeMemStore(); const c = client(store); sent = [];
  mailMode = 'fail';
  const r = await c.call('POST', 'auth/signup', { email: 'f@example.com', code: 'fail', acknowledged: true });
  assert.equal(r.status, 502); assert.ok(!JSON.stringify(r.data).includes('re_test'));
  assert.equal(store.db.workspaces.length, 0, 'code not held after a failed send');
  mailMode = 'net'; assert.equal((await c.call('POST', 'auth/signup', { email: 'f@example.com', code: 'fail', acknowledged: true })).status, 502);
  mailMode = 'ok'; assert.equal((await c.call('POST', 'auth/signup', { email: 'f@example.com', code: 'fail', acknowledged: true })).status, 200, 'same code usable after failure');
  const noKey = client(makeMemStore(), { env: { ...baseEnv, RESEND_API_KEY: undefined } });
  assert.equal((await noKey.call('POST', 'auth/signup', { email: 'x@example.com', code: 'nok!', acknowledged: true })).data.code, 'mail_not_configured');
  const noPepper = client(makeMemStore(), { env: { ...baseEnv, CODE_PEPPER: 'short' } });
  assert.equal((await noPepper.call('GET', 'auth/session')).status, 503);
});

test('CSRF: mutating requests need the custom header and a same-origin Origin', async () => {
  const c = client(makeMemStore());
  assert.equal((await c.call('POST', 'auth/login', { code: 'abcd' }, { noCsrf: true })).status, 403);
  assert.equal((await c.call('POST', 'auth/login', { code: 'abcd' }, { Origin: 'https://evil.example' })).status, 403);
  assert.equal((await c.call('POST', 'auth/login', { code: 'abcd' }, { Origin: 'https://ctrl.example.test' })).status, 401);
});

test('rate limits: signup per IP and per email', async () => {
  const store = makeMemStore(); const c = client(store, { ip: '9.9.9.9' }); let last;
  for (let i = 0; i < 9; i++) last = await c.call('POST', 'auth/signup', { email: `e${i}@example.com`, code: `c${i}!!`, acknowledged: true });
  assert.equal(last.status, 429); assert.ok(last.headers.get('Retry-After'));
});

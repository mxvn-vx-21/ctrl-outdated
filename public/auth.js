/* CTRL account screens: landing, sign up, verify, log in, recover. Secrets never touch URLs or storage:
   the code lives only in memory (A.code) and in request bodies; the session is an HttpOnly cookie. */
import { $, $$, esc, ico, api, toast } from './common.js';

const A = {
  email: '', code: '', err: '', errKind: '', busy: false, resendAt: 0, info: '', notice: '', recoverEmail: '',
  verify: { state: 'idle', token: '' }, reset: { state: 'idle', token: '' },
};
let ctx = { enter: async () => {}, refresh: async () => false };
export const initAuth = (c) => { ctx = c; };
export const setNotice = (m) => { A.notice = m; };

const path = () => location.pathname.replace(/\/+$/, '') || '/';
export function go(p, replace = false) { history[replace ? 'replaceState' : 'pushState']({}, '', p); renderAuth(); scrollTo(0, 0); }
const okChar = (ch) => /^[\x21-\x7E]$/.test(ch); // exactly the characters the server accepts

/* ---------- building blocks ---------- */
const arrow = ico('arrow');
const shell = (inner, { back, mtn = true } = {}) =>
  `<div class="auth"><div class="auth-top">${back ? `<button class="back" data-go="${back}" aria-label="Back">${ico('back')}</button>` : ''}</div>
   <main class="auth-main"><div class="wm" aria-label="CTRL">CTRL</div>${inner}</main>${mtn ? '<div class="mtn" aria-hidden="true"></div>' : ''}</div>`;
const boxes = (value, { error = false } = {}) =>
  `<div class="code ${error ? 'bad' : ''}" role="group" aria-label="4-character code">${[0, 1, 2, 3].map((i) =>
    `<input type="text" name="c${i}" inputmode="text" autocomplete="off" autocapitalize="off" autocorrect="off" spellcheck="false" enterkeyhint="${i === 3 ? 'go' : 'next'}" aria-label="Character ${i + 1} of 4" value="${esc(Array.from(value)[i] || '')}" data-1p-ignore data-lpignore="true">`).join('')}${error ? '<span class="dot" aria-hidden="true">!</span>' : ''}</div>`;
const errLine = (m) => `<p class="err" role="alert" ${m ? '' : 'hidden'}>${esc(m)}</p>`;
const spaced = (c) => esc(Array.from(c).join(' '));

/* ---------- screens ---------- */
function landing() {
  return `<div class="landing"><div class="mtn-full" aria-hidden="true"></div>
  <header class="ltop"><div class="wm sm">CTRL</div><nav><button class="textbtn" data-go="/login">Log in</button><button class="pillbtn" data-go="/signup">Sign up</button></nav></header>
  <section class="lhero"><h1>Your life,<br>under control.</h1><p>Tasks. Notes. Plans.<br>All in one simple space.</p>
    <div class="cta"><button class="btn" data-go="/signup">Create your space ${arrow}</button><button class="btn ghost" data-go="/login">Access your workspace</button></div></section>
  <ul class="lfeat"><li>${ico('cloud')}<span>Synced</span></li><li>${ico('bolt')}<span>Fast</span></li><li>${ico('phone')}<span>Works everywhere</span></li></ul></div>`;
}
function signup1() {
  return shell(`<h2>Create your space.</h2><p class="sub">Just an email and a 4-character code.</p>
  <form data-a="signup1" novalidate>
    <label class="fld">${ico('mail')}<span><small>Your email address</small><input type="email" name="email" id="a-email" autocomplete="email" inputmode="email" autocapitalize="off" spellcheck="false" placeholder="you@example.com" value="${esc(A.email)}"></span></label>
    <div class="fld col"><div class="fh">${ico('lock')}<span>Choose a 4-character code</span></div>${boxes(A.code)}
      <p class="hint">Use any characters: letters, numbers, symbols (no spaces).<br>Examples: aB7$, x./!, C^2_</p></div>
    <p class="warn">Anyone who knows your code can open your workspace, so pick something others can't guess.</p>
    ${errLine(A.err)}<button class="btn" type="submit">Continue ${arrow}</button>
  </form>
  <p class="alt">Already have a space? <button class="textbtn u" data-go="/login">Log in</button></p>`, { back: '/', mtn: false });
}
function signup2() {
  return shell(`<h2>Confirm your details.</h2><p class="sub">Make sure everything looks good.</p>
  <div class="sumrows"><div class="sum">${ico('mail')}<span><small>Email</small>${esc(A.email)}</span><button class="textbtn u" data-go="/signup">Edit</button></div>
  <div class="sum">${ico('lock')}<span><small>Your code</small><b class="mono">${spaced(A.code)}</b></span><button class="textbtn u" data-go="/signup">Edit</button></div></div>
  <form data-a="signup2" novalidate>
    <label class="chk"><input type="checkbox" id="ack1"><span>I understand that <b>anyone who knows my code can access this workspace</b>.</span></label>
    <label class="chk"><input type="checkbox" id="ack2"><span>I understand I need access to this email to reset my code if I forget it.</span></label>
    ${errLine(A.err)}<button class="btn" type="submit" id="create" disabled>Create Account ${arrow}</button>
  </form>`, { back: '/signup', mtn: false });
}
function checkEmail() {
  const who = A.email ? `<b>${esc(A.email)}</b>` : '<b>your email address</b>';
  return shell(`<h2>Check your email.</h2><p class="sub">We've sent a verification link to<br>${who}</p>
  <div class="mailart" aria-hidden="true">${ico('mail')}</div>
  <ol class="steps"><li><i>1</i>Open your email</li><li><i>2</i>Click the verification link</li><li><i>3</i>Return here to continue</li></ol>
  ${A.info ? `<p class="info" role="status">${esc(A.info)}</p>` : ''}
  <button class="btn" data-a="verified">I've Verified My Email</button>
  ${A.email ? '<p class="alt"><button class="textbtn u" id="resend" data-a="resend">Resend Email</button></p>' : ''}
  <p class="hint">The link expires in 15 minutes. Check your spam folder if it doesn't arrive.</p>`, { back: '/signup', mtn: false });
}
function verifying() {
  const v = A.verify;
  const bad = (title, body, btn, to) => shell(`<h2>${title}</h2><p class="sub">${body}</p><button class="btn" data-go="${to}">${btn}</button>`, { mtn: true });
  if (v.state === 'loading') return shell('<h2>Verifying…</h2><div class="spin" role="status" aria-label="Verifying"></div>');
  if (v.state === 'ok') {
    const code = A.code.length === 4 ? `<b class="mono">${spaced(A.code)}</b>` : '<span class="muted">The 4-character code you chose when you signed up.</span>';
    return shell(`<div class="okbadge">${ico('check')}</div><h2>Email verified!</h2><p class="sub">Your workspace is ready.</p>
      <div class="sum solo">${ico('lock')}<span><small>Your code</small>${code}</span></div>
      <p class="hint">Use this code to access your workspace anytime, on any device. We can't show it again: it isn't stored in a readable form.</p>
      <button class="btn" data-a="enter">Enter Workspace ${arrow}</button>`);
  }
  if (v.state === 'expired') return bad('Link expired.', 'Verification links last 15 minutes. Start again and we\'ll send a fresh one.', 'Back to sign up', '/signup');
  if (v.state === 'used') return bad('Already used.', 'This link has already been used. If you verified your email, log in with your code.', 'Log in', '/login');
  if (v.state === 'neterr') return shell(`<h2>Can't reach CTRL.</h2><p class="sub">Check your connection and try again.</p><button class="btn" data-a="retryVerify">Try again</button>`);
  return bad('Link not valid.', "This verification link isn't valid. Please request a new one.", 'Back to sign up', '/signup');
}
function login() {
  const invalid = A.errKind === 'invalid_code';
  return shell(`<h2>${invalid ? 'Invalid code.' : 'Welcome back.'}</h2>
  <p class="sub">${invalid ? "That code doesn't exist." : 'Enter your 4-character code to continue.'}</p>
  ${A.notice && !A.err ? `<p class="info" role="status">${esc(A.notice)}</p>` : ''}
  <form data-a="login" novalidate>${boxes(A.code, { error: invalid })}
    ${A.err ? `<div class="errbox" role="alert">${esc(A.err)}</div>` : ''}
    <button class="btn" type="submit">${invalid ? 'Try Again' : 'Access Workspace'} ${arrow}</button></form>
  <p class="alt"><button class="textbtn u" data-go="/recover">Forgot your code?</button></p>
  <p class="alt sm">New here? <button class="textbtn u" data-go="/signup">Create your space</button></p>`, { back: '/' });
}
function recover() {
  return shell(`<h2>Recover your code.</h2><p class="sub">Enter your email and we'll send a link to choose a new code.</p>
  <form data-a="recover" novalidate><label class="fld">${ico('mail')}<span><small>Your email address</small><input type="email" name="email" id="a-email" autocomplete="email" inputmode="email" autocapitalize="off" spellcheck="false" placeholder="you@example.com" value="${esc(A.email)}"></span></label>
  ${errLine(A.err)}<button class="btn" type="submit">Send Recovery Link ${arrow}</button></form>
  <p class="alt"><button class="textbtn u" data-go="/login">Back to login</button></p>`, { back: '/login' });
}
function recoverSent() {
  return shell(`<h2>Check your email.</h2><p class="sub">If an account exists for <b>${esc(A.recoverEmail || 'that address')}</b>, we've sent a link to reset your code. It expires in 30 minutes.</p>
  <div class="mailart" aria-hidden="true">${ico('mail')}</div><p class="hint">Nothing arrived? Check spam, or wait a minute and try again.</p>
  <button class="btn" data-go="/login">Back to login</button><p class="alt"><button class="textbtn u" data-go="/recover">Try again</button></p>`);
}
function resetScreen() {
  const r = A.reset;
  if (r.state === 'checking') return shell('<h2>One moment…</h2><div class="spin" role="status" aria-label="Checking link"></div>');
  const msg = { expired: ['Link expired.', 'Recovery links last 30 minutes.'], used: ['Already used.', 'This recovery link has already been used.'], invalid: ['Link not valid.', "This recovery link isn't valid (or this page was reloaded). Open the link from your email again, or request a new one."], neterr: ["Can't reach CTRL.", 'Check your connection and try again.'] }[r.state];
  if (msg) return shell(`<h2>${msg[0]}</h2><p class="sub">${msg[1]}</p><button class="btn" data-go="/recover">Request a new link</button>`);
  return shell(`<h2>Choose a new code.</h2><p class="sub">Your tasks and notes are untouched.</p>
  <form data-a="reset" novalidate>${boxes(A.code)}<p class="hint">Any 4 letters, numbers or symbols (no spaces).</p>
  <label class="chk"><input type="checkbox" id="ack1"><span>I understand that <b>anyone who knows my code can access this workspace</b>.</span></label>
  ${errLine(A.err)}<button class="btn" type="submit" id="create" disabled>Save New Code ${arrow}</button></form>`);
}

/* ---------- router ---------- */
export function renderAuth() {
  const p = path(); let m;
  if ((m = p.match(/^\/verify\/([\w-]+)$/))) return startVerify(m[1]);
  if ((m = p.match(/^\/reset\/([\w-]+)$/))) return startReset(m[1]);
  const screens = { '/signup': signup1, '/signup/confirm': signup2, '/check-email': checkEmail, '/verifying': verifying, '/login': login, '/recover': recover, '/recover/sent': recoverSent, '/reset': resetScreen };
  let fn = screens[p];
  if (!fn) { if (p !== '/') history.replaceState({}, '', '/'); fn = landing; }
  if ((p === '/signup/confirm') && !(A.email && A.code.length === 4)) { history.replaceState({}, '', '/signup'); fn = signup1; }
  if (p === '/verifying' && A.verify.state === 'idle') { history.replaceState({}, '', '/'); fn = landing; }
  $('#app').innerHTML = fn();
  document.title = 'CTRL — Your life, under control.';
  const first = $('.code input[value=""]') || $('.fld input'); if (first && fn !== landing && matchMedia('(pointer:fine)').matches) first.focus();
  startTick();
}

async function startVerify(token) {
  A.verify = { state: 'loading', token }; history.replaceState({}, '', '/verifying'); renderAuth(); await runVerify();
}
async function runVerify() {
  try { await api('POST', 'auth/verify', { token: A.verify.token }); A.verify.state = 'ok'; A.verify.token = ''; }
  catch (e) { A.verify.state = e.code === 'token_expired' ? 'expired' : e.code === 'token_used' ? 'used' : e.code === 'network' ? 'neterr' : 'invalid'; }
  if (path() === '/verifying') renderAuth();
}
async function startReset(token) {
  A.reset = { state: 'checking', token }; A.code = ''; A.err = ''; history.replaceState({}, '', '/reset'); renderAuth();
  try { await api('POST', 'auth/check', { token, kind: 'recover' }); A.reset.state = 'ready'; }
  catch (e) { A.reset.state = e.code === 'token_expired' ? 'expired' : e.code === 'token_used' ? 'used' : e.code === 'network' ? 'neterr' : 'invalid'; }
  if (path() === '/reset') renderAuth();
}

/* ---------- actions ---------- */
const busy = (btn, on) => { if (btn) { btn.disabled = on; btn.classList.toggle('busy', on); } };
const FORMS = {
  signup1() {
    A.email = $('#a-email').value.trim(); A.err = '';
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(A.email)) A.err = 'Please enter a valid email address.';
    else if (Array.from(A.code).length !== 4) A.err = 'Your code needs exactly 4 characters.';
    if (A.err) return renderAuth();
    go('/signup/confirm');
  },
  async signup2(form) {
    const btn = $('#create'); busy(btn, true); A.err = '';
    try {
      await api('POST', 'auth/signup', { email: A.email, code: A.code, acknowledged: true });
      A.resendAt = Date.now() + 60000; A.info = ''; go('/check-email');
    } catch (e) {
      if (e.code === 'code_taken' || e.code === 'bad_code') { A.err = e.message; go('/signup', true); }
      else { A.err = e.message; renderAuth(); }
    }
  },
  async login() {
    const btn = $('form[data-a="login"] .btn');
    if (A.errKind === 'invalid_code' && A.code === A.lastBad) { A.code = ''; A.err = ''; A.errKind = ''; renderAuth(); return; } // "Try Again"
    if (Array.from(A.code).length !== 4) { A.err = 'Enter all 4 characters of your code.'; A.errKind = 'incomplete'; renderAuth(); return; }
    busy(btn, true);
    try { await api('POST', 'auth/login', { code: A.code }); A.code = ''; A.err = ''; A.errKind = ''; A.notice = ''; await ctx.enter(); }
    catch (e) { A.err = e.message; A.errKind = e.code === 'invalid_code' ? 'invalid_code' : 'other'; A.lastBad = A.code; renderAuth(); }
  },
  async recover() {
    A.email = $('#a-email').value.trim(); A.err = '';
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(A.email)) { A.err = 'Please enter a valid email address.'; return renderAuth(); }
    busy($('form .btn'), true);
    try { await api('POST', 'auth/recover', { email: A.email }); A.recoverEmail = A.email; go('/recover/sent'); }
    catch (e) { A.err = e.message; renderAuth(); }
  },
  async reset() {
    A.err = '';
    if (Array.from(A.code).length !== 4) { A.err = 'Your code needs exactly 4 characters.'; return renderAuth(); }
    busy($('#create'), true);
    try { await api('POST', 'auth/reset', { token: A.reset.token, code: A.code, acknowledged: true }); A.code = ''; A.reset = { state: 'idle', token: '' }; toast('Code updated. You\'re in.'); await ctx.enter(); }
    catch (e) {
      A.err = e.message;
      if (['token_expired', 'token_used', 'invalid_token'].includes(e.code)) A.reset.state = e.code === 'token_expired' ? 'expired' : e.code === 'token_used' ? 'used' : 'invalid';
      renderAuth();
    }
  },
};
const ACT = {
  async resend() {
    if (Date.now() < A.resendAt) return;
    try { await api('POST', 'auth/resend', { email: A.email }); A.resendAt = Date.now() + 60000; A.info = ''; toast('Verification email sent'); }
    catch (e) { A.info = e.message; if (e.retryAfter) A.resendAt = Date.now() + e.retryAfter * 1000; renderAuth(); }
    tick();
  },
  async verified() {
    A.info = '';
    try { if (await ctx.refresh()) return; A.info = "We haven't seen your verification yet. Open the link in your email. If you opened it on another device, log in here with your code."; }
    catch { A.info = "Can't reach CTRL. Check your connection and try again."; }
    renderAuth();
  },
  enter() { A.code = ''; ctx.enter(); },
  async retryVerify() { A.verify.state = 'loading'; renderAuth(); await runVerify(); },
};

/* ---------- code boxes & delegated events ---------- */
const boxesOf = (el) => $$('input', el.closest('.code'));
const syncCode = (el) => { A.code = boxesOf(el).map((i) => i.value).join(''); };
const hint = (m) => { const e = $('.hint') || $('.sub'); if (e && m) toast(m); };
document.addEventListener('input', (e) => {
  const t = e.target; if (!t.closest?.('.auth')) return;
  if (t.matches('.code input')) {
    if (e.isComposing) return;
    const chars = Array.from(t.value), ok = chars.filter(okChar);
    if (chars.length && !ok.length) { t.value = ''; hint('Use letters, numbers or symbols only (no spaces or emoji).'); return; }
    t.value = ok.length ? ok[ok.length - 1] : '';
    syncCode(t); if (A.errKind !== 'invalid_code') { A.err = ''; }
    const bs = boxesOf(t), i = bs.indexOf(t); if (t.value && i < 3) bs[i + 1].focus();
  } else if (t.matches('input[type=checkbox]')) {
    const all = $$('.chk input').every((c) => c.checked); const b = $('#create'); if (b) b.disabled = !all;
  } else if (t.id === 'a-email') A.email = t.value;
});
document.addEventListener('focusin', (e) => { if (e.target.matches?.('.auth .code input')) e.target.select(); });
document.addEventListener('keydown', (e) => {
  const t = e.target; if (!t.matches?.('.auth .code input')) return;
  const bs = boxesOf(t), i = bs.indexOf(t);
  if (e.key === 'Backspace' && !t.value && i > 0) { e.preventDefault(); bs[i - 1].value = ''; bs[i - 1].focus(); syncCode(t); }
  else if (e.key === 'ArrowLeft' && i > 0) { e.preventDefault(); bs[i - 1].focus(); }
  else if (e.key === 'ArrowRight' && i < 3) { e.preventDefault(); bs[i + 1].focus(); }
});
document.addEventListener('paste', (e) => {
  const t = e.target; if (!t.matches?.('.auth .code input')) return;
  e.preventDefault();
  const text = e.clipboardData.getData('text'), chars = Array.from(text).filter(okChar);
  if (chars.length < Array.from(text).length) hint('Spaces and unsupported characters were skipped.');
  const bs = boxesOf(t); let i = Math.max(0, bs.indexOf(t));
  for (const ch of chars) { if (i > 3) break; bs[i++].value = ch; }
  syncCode(t); bs[Math.min(i, 3)].focus();
});
document.addEventListener('click', (e) => {
  const t = e.target.closest?.('.auth [data-go], .landing [data-go], .auth [data-a], .landing [data-a]'); if (!t) return;
  if (t.dataset.go) { A.err = ''; A.errKind = ''; go(t.dataset.go); }
  else if (ACT[t.dataset.a]) ACT[t.dataset.a](t);
});
document.addEventListener('submit', (e) => {
  const f = e.target.closest?.('.auth form[data-a]'); if (!f) return;
  e.preventDefault(); if (FORMS[f.dataset.a]) FORMS[f.dataset.a](f);
});

/* Resend countdown (only while that screen is showing). */
let timer;
function tick() {
  const b = $('#resend'); if (!b) { clearInterval(timer); timer = null; return; }
  const left = Math.max(0, Math.ceil((A.resendAt - Date.now()) / 1000));
  b.disabled = left > 0; b.textContent = left > 0 ? `Resend Email (${left}s)` : 'Resend Email';
}
function startTick() { clearInterval(timer); timer = null; if ($('#resend')) { tick(); timer = setInterval(tick, 1000); } }

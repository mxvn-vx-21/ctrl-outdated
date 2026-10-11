/* Shared helpers for the app and the account screens. */
export const $ = (s, r = document) => r.querySelector(s);
export const $$ = (s, r = document) => [...r.querySelectorAll(s)];
export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export const ICONS = {
  home: 'M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z M9 22V12h6v10',
  done: 'M22 11.08V12a10 10 0 1 1-5.93-9.14 M22 4L12 14.01l-3-3',
  memo: 'M12 20h9 M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z',
  settings: 'M4 21v-7 M4 10V3 M12 21v-9 M12 8V3 M20 21v-5 M20 12V3 M1 14h6 M9 8h6 M17 16h6',
  plus: 'M12 5v14 M5 12h14', x: 'M18 6L6 18 M6 6l12 12', check: 'M20 6L9 17l-5-5',
  more: 'M12 5h.01 M12 12h.01 M12 19h.01', back: 'M19 12H5 M12 19l-7-7 7-7',
  trash: 'M3 6h18 M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6 M10 11v6 M14 11v6 M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2',
  star: 'M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z',
  cal: 'M3 4h18v18H3z M16 2v4 M8 2v4 M3 10h18', edit: 'M12 20h9 M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z',
  mail: 'M4 4h16a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2z M22 6l-10 7L2 6',
  lock: 'M5 11h14v10H5z M8 11V7a4 4 0 0 1 8 0v4', arrow: 'M5 12h14 M12 5l7 7-7 7',
  cloud: 'M18 10h-1.26A8 8 0 1 0 9 20h9a5 5 0 0 0 0-10z', bolt: 'M13 2L3 14h9l-1 8 10-12h-9l1-8z',
  phone: 'M7 2h10a2 2 0 0 1 2 2v16a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2z M12 18h.01',
  out: 'M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4 M16 17l5-5-5-5 M21 12H9',
};
export const ico = (n, extra = '') => `<svg class="ico" viewBox="0 0 24 24" aria-hidden="true" ${extra}><path d="${ICONS[n]}"/></svg>`;
export const icoSearch = '<svg class="ico" viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="8"/><path d="M21 21l-4.35-4.35"/></svg>';

export function toast(msg) {
  $('.toast')?.remove();
  const t = document.createElement('div'); t.className = 'toast'; t.setAttribute('role', 'status'); t.textContent = msg;
  document.body.append(t); setTimeout(() => t.remove(), 3500);
}

export class ApiError extends Error {
  constructor(message, status, code, retryAfter) { super(message); this.status = status; this.code = code; this.retryAfter = retryAfter; }
}
export const hooks = { onUnauthorized() {} };

/** All requests go to same-origin /api. The session lives in an HttpOnly cookie (never in JS-readable storage). */
export async function api(method, path, body) {
  let r;
  try {
    r = await fetch('/api/' + path, {
      method, credentials: 'same-origin', keepalive: method !== 'GET',
      headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(method !== 'GET' ? { 'X-CTRL': '1' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch { throw new ApiError("Can't reach CTRL. Check your connection and try again.", 0, 'network'); }
  const d = await r.json().catch(() => ({}));
  if (r.status === 401 && d.code === 'unauthenticated') hooks.onUnauthorized();
  if (!r.ok) throw new ApiError(d.error || 'Something went wrong. Please try again.', r.status, d.code, d.retryAfter);
  return d;
}

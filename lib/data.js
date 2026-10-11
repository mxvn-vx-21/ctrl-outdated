import { bad } from './http.js';

export const TABLES = ['tasks', 'notes', 'folders', 'countdowns'];
const str = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
const int = (v, min, max, name) => { if (!Number.isInteger(v) || v < min || v > max) throw bad(`${name} is invalid`); return v; };
const date = (v, nullable) => {
  if (v == null || v === '') { if (nullable) return null; throw bad('A date is required'); }
  if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v) || Number.isNaN(Date.parse(v))) throw bad('Invalid date');
  return v;
};

/** Whitelists + validates writable columns. workspace_id is NEVER taken from the client. */
export function clean(table, b, partial) {
  if (!b || typeof b !== 'object' || Array.isArray(b)) throw bad('Invalid request');
  const has = (k) => Object.prototype.hasOwnProperty.call(b, k);
  const o = {};
  if (table === 'tasks') {
    if (!partial || has('title')) { const v = str(b.title, 300); if (!v) throw bad('Please give your task a title.'); o.title = v; }
    if (has('description')) o.description = str(b.description, 5000);
    if (has('due_date')) o.due_date = date(b.due_date, true);
    if (has('due_time')) o.due_time = b.due_time == null ? null : int(b.due_time, 0, 1439, 'due_time');
    if (o.due_date === null) o.due_time = null;
    if (has('priority')) o.priority = int(b.priority, 0, 2, 'priority');
    if (has('is_completed')) o.is_completed = !!b.is_completed;
  } else if (table === 'notes') {
    if (has('title')) o.title = str(b.title, 300);
    if (has('content')) {
      const arr = b.content && Array.isArray(b.content.blocks) ? b.content.blocks.slice(0, 5000) : null;
      if (!arr) throw bad('Invalid note content');
      o.content = { v: 1, blocks: arr.map((x) => ({ t: x && typeof x.t === 'string' && 'PBNC'.includes(x.t) && x.t ? x.t : 'P', x: String((x && x.x) ?? '').slice(0, 20000), c: !!(x && x.c), b: !!(x && x.b), i: !!(x && x.i) })) };
      o.content_format_version = 1;
    }
    if (has('is_pinned')) o.is_pinned = !!b.is_pinned;
    if (has('folder_id')) o.folder_id = b.folder_id == null ? null : int(b.folder_id, 1, Number.MAX_SAFE_INTEGER, 'folder_id');
  } else if (table === 'folders') {
    const v = str(b.name, 80); if (!v) throw bad('Please enter a name.'); o.name = v;
  } else if (table === 'countdowns') {
    if (!partial || has('title')) { const v = str(b.title, 300); if (!v) throw bad('Please add a title.'); o.title = v; }
    if (!partial || has('target_date')) o.target_date = date(b.target_date, false);
  }
  if (!Object.keys(o).length) throw bad('Nothing to update');
  return o;
}

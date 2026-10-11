/* In-memory implementation of the store contract (same semantics as lib/pgstore.js) used by the tests. */
export function makeMemStore() {
  let offset = 0; // simulated clock advance (ms)
  const now = () => Date.now() + offset;
  const db = { workspaces: [], sessions: [], tokens: [], rate: new Map(), fails: new Map(), tasks: [], notes: [], folders: [], countdowns: [], seq: { tasks: 0, notes: 0, folders: 0, countdowns: 0 } };
  const uid = () => crypto.randomUUID();
  const strip = ({ workspace_id, ...r }) => r;
  const s = {
    db, advance(ms) { offset += ms; },
    async purgeStale() { db.workspaces = db.workspaces.filter((w) => !(w.status === 'pending' && now() - w.created > 3600e3)); },
    async rateHit(key, max, windowSec) {
      let r = db.rate.get(key);
      if (!r || now() - r.start > windowSec * 1000) r = { count: 0, start: now() };
      r.count++; db.rate.set(key, r);
      return { count: r.count, retry: Math.max(1, Math.ceil((r.start + windowSec * 1000 - now()) / 1000)) };
    },
    async lockWait(key) { const f = db.fails.get(key); return f && f.locked > now() ? Math.ceil((f.locked - now()) / 1000) : 0; },
    async recordFail(key) {
      let f = db.fails.get(key);
      if (!f || now() - f.last > 3600e3) f = { fails: 0, last: now(), locked: 0 };
      f.fails++; f.last = now(); db.fails.set(key, f); return f.fails;
    },
    async setLock(key, secs) { db.fails.get(key).locked = now() + secs * 1000; },
    async globalFails() { return [...db.fails.values()].filter((f) => now() - f.last < 600e3).reduce((a, f) => a + f.fails, 0); },
    async createPending({ email, codeHash, tokenHash, ttlMin }) {
      db.workspaces = db.workspaces.filter((w) => !(w.status === 'pending' && w.email === email));
      if (db.workspaces.some((w) => w.email === email)) return { result: 'exists' };
      if (db.workspaces.some((w) => w.code_hash === codeHash)) return { result: 'code_taken' };
      const w = { id: uid(), email, code_hash: codeHash, status: 'pending', created: now() };
      db.workspaces.push(w);
      db.tokens.push({ hash: tokenHash, ws: w.id, kind: 'verify', exp: now() + ttlMin * 60e3, used: false });
      return { result: 'created', workspaceId: w.id };
    },
    async deleteWorkspace(id) { db.workspaces = db.workspaces.filter((w) => w.id !== id); db.tokens = db.tokens.filter((t) => t.ws !== id); },
    async findPendingByEmail(email) { return db.workspaces.find((w) => w.email === email && w.status === 'pending' && now() - w.created < 3600e3) || null; },
    async findActiveByEmail(email) { return db.workspaces.find((w) => w.email === email && w.status === 'active') || null; },
    async findActiveByCode(h) { return db.workspaces.find((w) => w.code_hash === h && w.status === 'active') || null; },
    async replaceToken({ workspaceId, kind, tokenHash, ttlMin }) {
      db.tokens = db.tokens.filter((t) => !(t.ws === workspaceId && t.kind === kind && !t.used));
      db.tokens.push({ hash: tokenHash, ws: workspaceId, kind, exp: now() + ttlMin * 60e3, used: false });
    },
    async consumeVerify(h) {
      const t = db.tokens.find((x) => x.hash === h && x.kind === 'verify' && !x.used && x.exp > now());
      if (!t) return null; t.used = true;
      const w = db.workspaces.find((x) => x.id === t.ws); w.status = 'active'; return w.id;
    },
    async tokenStatus(h, kind) { const t = db.tokens.find((x) => x.hash === h && x.kind === kind); return !t ? 'missing' : t.used ? 'used' : t.exp < now() ? 'expired' : 'valid'; },
    async resetCode({ tokenHash, codeHash }) {
      const t = db.tokens.find((x) => x.hash === tokenHash && x.kind === 'recover' && !x.used && x.exp > now());
      if (!t) return { result: 'invalid' };
      if (db.workspaces.some((w) => w.code_hash === codeHash && w.id !== t.ws)) return { result: 'code_taken' };
      db.workspaces.find((w) => w.id === t.ws).code_hash = codeHash; t.used = true;
      db.sessions = db.sessions.filter((x) => x.ws !== t.ws); return { result: 'ok', workspaceId: t.ws };
    },
    async createSession(ws, hash, days) { db.sessions.push({ hash, ws, exp: now() + days * 864e5 }); },
    async getSession(h) {
      const x = db.sessions.find((y) => y.hash === h && y.exp > now()); if (!x) return null;
      const w = db.workspaces.find((z) => z.id === x.ws && z.status === 'active'); return w ? { workspaceId: w.id, email: w.email } : null;
    },
    async deleteSession(h) { db.sessions = db.sessions.filter((x) => x.hash !== h); },
    async list(ws) { const g = (t) => db[t].filter((r) => r.workspace_id === ws).map(strip); return { tasks: g('tasks'), notes: g('notes'), folders: g('folders'), countdowns: g('countdowns') }; },
    async folderExists(ws, id) { return db.folders.some((f) => f.id === id && f.workspace_id === ws); },
    async insert(ws, table, o) { const row = { id: ++db.seq[table], ...o, workspace_id: ws }; db[table].push(row); return strip(row); },
    async update(ws, table, id, o) { const r = db[table].find((x) => x.id === id && x.workspace_id === ws); if (!r) return null; Object.assign(r, o); return strip(r); },
    async remove(ws, table, id) { db[table] = db[table].filter((x) => !(x.id === id && x.workspace_id === ws)); },
    async clearAll(ws) { for (const t of ['tasks', 'notes', 'folders', 'countdowns']) db[t] = db[t].filter((r) => r.workspace_id !== ws); },
  };
  return s;
}

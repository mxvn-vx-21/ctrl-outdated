/* All SQL lives here. Every data query is scoped by workspace_id taken from the server-side session. */
const strip = (rows) => rows.map(({ workspace_id, ...r }) => r);

export function makeStore(sql) {
  return {
    /* ---- housekeeping ---- */
    async purgeStale() {
      await sql`delete from workspaces where status = 'pending' and created_at < now() - interval '1 hour'`;
      await sql`delete from email_tokens where expires_at < now() - interval '1 day'`;
      await sql`delete from sessions where expires_at < now()`;
      await sql`delete from rate_limits where window_start < now() - interval '1 day'`;
      await sql`delete from login_failures where last_fail < now() - interval '1 day'`;
    },

    /* ---- rate limiting ---- */
    async rateHit(key, max, windowSec) {
      const [r] = await sql`
        insert into rate_limits (key, count, window_start) values (${key}, 1, now())
        on conflict (key) do update set
          count = case when rate_limits.window_start < now() - (${windowSec}::int * interval '1 second') then 1 else rate_limits.count + 1 end,
          window_start = case when rate_limits.window_start < now() - (${windowSec}::int * interval '1 second') then now() else rate_limits.window_start end
        returning count, greatest(1, ceil(extract(epoch from (window_start + (${windowSec}::int * interval '1 second') - now()))))::int as retry`;
      return { count: r.count, retry: r.retry };
    },
    async lockWait(key) {
      const [r] = await sql`select ceil(extract(epoch from (locked_until - now())))::int as wait from login_failures where key = ${key} and locked_until > now()`;
      return r ? r.wait : 0;
    },
    async recordFail(key) {
      const [r] = await sql`
        insert into login_failures (key, fails, last_fail) values (${key}, 1, now())
        on conflict (key) do update set
          fails = case when login_failures.last_fail < now() - interval '1 hour' then 1 else login_failures.fails + 1 end,
          last_fail = now()
        returning fails`;
      return r.fails;
    },
    async setLock(key, secs) {
      await sql`update login_failures set locked_until = now() + (${secs}::int * interval '1 second') where key = ${key}`;
    },
    async globalFails() {
      const [r] = await sql`select coalesce(sum(fails), 0)::int as n from login_failures where last_fail > now() - interval '10 minutes'`;
      return r.n;
    },

    /* ---- accounts ---- */
    /** Atomic: replaces this email's pending signup, reserves the code (unique), stores the verify token. */
    async createPending({ email, codeHash, tokenHash, ttlMin }) {
      try {
        return await sql.begin(async (tx) => {
          await tx`delete from workspaces where status = 'pending' and email = ${email}`;
          const [ex] = await tx`select 1 as x from workspaces where email = ${email}`;
          if (ex) return { result: 'exists' };
          const [w] = await tx`insert into workspaces (email, code_hash) values (${email}, ${codeHash}) returning id`;
          await tx`insert into email_tokens (token_hash, workspace_id, kind, expires_at)
                   values (${tokenHash}, ${w.id}, 'verify', now() + (${ttlMin}::int * interval '1 minute'))`;
          return { result: 'created', workspaceId: w.id };
        });
      } catch (e) {
        if (e.code === '23505') return String(e.constraint_name || '').includes('code') ? { result: 'code_taken' } : { result: 'exists' };
        throw e;
      }
    },
    async deleteWorkspace(id) { await sql`delete from workspaces where id = ${id}`; },
    async findPendingByEmail(email) {
      const [w] = await sql`select id from workspaces where email = ${email} and status = 'pending' and created_at > now() - interval '1 hour'`;
      return w || null;
    },
    async findActiveByEmail(email) {
      const [w] = await sql`select id from workspaces where email = ${email} and status = 'active'`;
      return w || null;
    },
    async findActiveByCode(codeHash) {
      const [w] = await sql`select id from workspaces where code_hash = ${codeHash} and status = 'active'`;
      return w || null;
    },
    async replaceToken({ workspaceId, kind, tokenHash, ttlMin }) {
      await sql.begin(async (tx) => {
        await tx`delete from email_tokens where workspace_id = ${workspaceId} and kind = ${kind} and used_at is null`;
        await tx`insert into email_tokens (token_hash, workspace_id, kind, expires_at)
                 values (${tokenHash}, ${workspaceId}, ${kind}, now() + (${ttlMin}::int * interval '1 minute'))`;
      });
    },
    /** Single statement: marks the token used AND activates the workspace; null if invalid/used/expired. */
    async consumeVerify(tokenHash) {
      const rows = await sql`
        with t as (
          update email_tokens set used_at = now()
          where token_hash = ${tokenHash} and kind = 'verify' and used_at is null and expires_at > now()
          returning workspace_id)
        update workspaces w set status = 'active', verified_at = now() from t where w.id = t.workspace_id returning w.id`;
      return rows[0] ? rows[0].id : null;
    },
    async tokenStatus(tokenHash, kind) {
      const [t] = await sql`select used_at is not null as used, expires_at < now() as expired from email_tokens where token_hash = ${tokenHash} and kind = ${kind}`;
      return !t ? 'missing' : t.used ? 'used' : t.expired ? 'expired' : 'valid';
    },
    /** Changes the code with a valid recovery token, all-or-nothing; the token stays usable if the code is taken. */
    async resetCode({ tokenHash, codeHash }) {
      try {
        return await sql.begin(async (tx) => {
          const [t] = await tx`select workspace_id from email_tokens
            where token_hash = ${tokenHash} and kind = 'recover' and used_at is null and expires_at > now() for update`;
          if (!t) return { result: 'invalid' };
          await tx`update workspaces set code_hash = ${codeHash}, code_changed_at = now() where id = ${t.workspace_id} and status = 'active'`;
          await tx`update email_tokens set used_at = now() where token_hash = ${tokenHash}`;
          await tx`delete from sessions where workspace_id = ${t.workspace_id}`;
          return { result: 'ok', workspaceId: t.workspace_id };
        });
      } catch (e) {
        if (e.code === '23505') return { result: 'code_taken' };
        throw e;
      }
    },

    /* ---- sessions ---- */
    async createSession(workspaceId, tokenHash, days) {
      await sql`insert into sessions (token_hash, workspace_id, expires_at) values (${tokenHash}, ${workspaceId}, now() + (${days}::int * interval '1 day'))`;
    },
    async getSession(tokenHash) {
      const [s] = await sql`
        select s.workspace_id, w.email, (s.last_seen < now() - interval '1 hour') as stale
        from sessions s join workspaces w on w.id = s.workspace_id
        where s.token_hash = ${tokenHash} and s.expires_at > now() and w.status = 'active'`;
      if (!s) return null;
      if (s.stale) await sql`update sessions set last_seen = now() where token_hash = ${tokenHash}`;
      return { workspaceId: s.workspace_id, email: s.email };
    },
    async deleteSession(tokenHash) { await sql`delete from sessions where token_hash = ${tokenHash}`; },

    /* ---- workspace data (always scoped) ---- */
    async list(ws) {
      const [tasks, notes, folders, countdowns] = await Promise.all([
        sql`select * from tasks where workspace_id = ${ws} order by id`,
        sql`select * from notes where workspace_id = ${ws} order by is_pinned desc, updated_at desc`,
        sql`select * from folders where workspace_id = ${ws} order by lower(name)`,
        sql`select * from countdowns where workspace_id = ${ws} order by target_date, id`,
      ]);
      return { tasks: strip(tasks), notes: strip(notes), folders: strip(folders), countdowns: strip(countdowns) };
    },
    async folderExists(ws, id) {
      const [r] = await sql`select 1 as x from folders where id = ${id} and workspace_id = ${ws}`;
      return !!r;
    },
    async insert(ws, table, o) {
      const row = { ...o, workspace_id: ws };
      if (row.content) row.content = sql.json(row.content);
      const [r] = await sql`insert into ${sql(table)} ${sql(row)} returning *`;
      return strip([r])[0];
    },
    async update(ws, table, id, o, bump) {
      const row = { ...o };
      if (bump) row.updated_at = new Date();
      if (row.content) row.content = sql.json(row.content);
      const [r] = await sql`update ${sql(table)} set ${sql(row)} where id = ${id} and workspace_id = ${ws} returning *`;
      return r ? strip([r])[0] : null;
    },
    async remove(ws, table, id) { await sql`delete from ${sql(table)} where id = ${id} and workspace_id = ${ws}`; },
    async clearAll(ws) {
      await sql.begin(async (tx) => {
        await tx`delete from notes where workspace_id = ${ws}`;
        await tx`delete from folders where workspace_id = ${ws}`;
        await tx`delete from tasks where workspace_id = ${ws}`;
        await tx`delete from countdowns where workspace_id = ${ws}`;
      });
    },
  };
}

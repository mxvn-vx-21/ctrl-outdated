import postgres from 'postgres';
import { SCHEMA } from '../../lib/schema.js';
import { makeStore } from '../../lib/pgstore.js';
import { handle, errorResponse } from '../../lib/router.js';
import { HttpError } from '../../lib/http.js';

/* Dates stay 'YYYY-MM-DD' strings and ids stay numbers (no timezone shifts). */
const TYPES = {
  bigint: { to: 20, from: [20], serialize: (x) => String(x), parse: (x) => Number(x) },
  date: { to: 1082, from: [1082], serialize: (x) => x, parse: (x) => x },
};
let schemaReady;

export async function onRequest({ request, env, params, waitUntil }) {
  const seg = Array.isArray(params.path) ? params.path : [params.path].filter(Boolean);
  let sql;
  try {
    if (!env.HYPERDRIVE) throw new HttpError(503, 'Database binding "HYPERDRIVE" is missing.', 'not_configured');
    sql = postgres(env.HYPERDRIVE.connectionString, { max: 5, fetch_types: false, types: TYPES });
    schemaReady ||= sql.unsafe(SCHEMA).catch((e) => { schemaReady = undefined; throw e; });
    await schemaReady;
    return await handle({ request, env, seg, store: makeStore(sql) });
  } catch (e) {
    return errorResponse(e);
  } finally {
    if (sql) waitUntil(sql.end());
  }
}

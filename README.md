# CTRL — your life, under control  (`https://ctrl.monster`)

Public, multi-user version of the former MONO web app. Same stack as before: static front end in `public/` (no build step) + one Cloudflare Pages Function (`functions/api/[[path]].js`) + Postgres through Hyperdrive. No new services except **Resend** for email.

## What was added
| Area | Where |
|---|---|
| Landing, sign up, confirm, check-email, verify, log in, invalid code, recovery, reset | `public/auth.js`, `public/auth.css` |
| Existing app (Today / Done / Memo / Settings) | `public/app.js` (only wiring changed: session, loading state, CTRL branding) |
| API: accounts, sessions, rate limits, email tokens | `lib/auth.js`, `lib/security.js`, `lib/router.js` |
| All SQL | `lib/pgstore.js`, schema/migration in `lib/schema.js` (copy: `schema.sql`) |
| Email templates (Resend) | `lib/mail.js` |
| Tests | `test/` (`npm test`) |

## How codes and sessions work (read this)
- A workspace is identified by a **4-character code**: exactly 4 characters from printable ASCII (letters, digits, punctuation, symbols; **no spaces, no emoji**), **case-sensitive**, never trimmed or altered. ASCII-only avoids different phones normalising accents differently.
- The database stores only `HMAC-SHA256(CODE_PEPPER, code)` (unique-indexed), never the code. `CODE_PEPPER` lives only in Cloudflare's secrets, so a stolen database dump alone cannot be brute-forced offline.
- **Honest limit:** there are only ~78 million possible codes. If an attacker obtains *both* the database and `CODE_PEPPER`, every code can be recovered in seconds. Online guessing is slowed by per-IP progressive lockouts (5th wrong guess → 30 s, doubling to 1 h), per-IP request limits and a global slow-down, but a determined distributed attacker could still hit someone's code over time, and anyone who learns a code can open that workspace. That is by design; the sign-up screen says so and requires acknowledgement. For stronger protection consider Cloudflare Turnstile and WAF rate-limit rules on `/api/auth/*`.
- Because codes are unique, “that code is already taken” is necessarily visible at sign-up; sign-up is rate-limited (8/hour/IP) to slow enumeration.
- Sessions: random 256-bit token in an `HttpOnly`, `SameSite=Lax` cookie (`Secure` + `__Host-` prefix on HTTPS); only its SHA-256 is stored; 30-day expiry; logout deletes it; resetting the code revokes all sessions. All writes require an `X-CTRL` header and a same-origin `Origin` (CSRF).
- Verification and recovery links: 256-bit single-use tokens (hash stored), 15 min (verify) / 30 min (recovery). Links open a page that POSTs the token, so email scanners that merely fetch the URL cannot burn it.
- **Recovery resets rather than reveals** the code (it cannot be read back). The mock-up's “Your Workspace Code” email was therefore replaced by a “Choose a new code” link.
- Every data row has a `workspace_id` taken from the session on the server, never from the client; every read/update/delete filters on it.

## Environment / secrets
| Name | Type | Purpose |
|---|---|---|
| `CODE_PEPPER` | secret | 32+ random chars (`openssl rand -hex 32`). **Back it up; never change it** (all codes would stop matching; users could still recover by email). |
| `RESEND_API_KEY` | secret | Resend API key (server-side only) |
| `MAIL_FROM` | secret | Sender, e.g. `CTRL <no-reply@ctrl.monster>` — must be on a domain verified in Resend |
| `APP_URL` | var (in `wrangler.toml`) | `https://ctrl.monster` |
| `HYPERDRIVE` | binding (in `wrangler.toml`) | Hyperdrive config for your Postgres |

The old `APP_PASSCODE` / `SESSION_SECRET` are no longer used and can be deleted.

## Deploy
1. **Postgres 13+** reachable from the internet with TLS. Existing database? Keep it: the API migrates it automatically (below).
2. **Hyperdrive**: dashboard → Storage & databases → Hyperdrive → Create → paste the connection string → copy the ID into `wrangler.toml`.
3. **Resend**: create an account and API key; **Domains → Add `ctrl.monster`** and add the DNS records Resend shows (SPF `TXT`, DKIM `TXT`/`CNAME`, optionally DMARC). Wait until the domain says *Verified*. Until then Resend refuses to send from `@ctrl.monster`. (Resend's test sender `onboarding@resend.dev` only delivers to your own account email.)
4. Push this folder to GitHub → Cloudflare **Workers & Pages → Create → Pages → Connect to Git**. Framework: None. Build command `npm install`. Output directory `public`.
5. Project → **Settings → Variables and Secrets**: add secrets `CODE_PEPPER`, `RESEND_API_KEY`, `MAIL_FROM`. Redeploy.
6. Project → **Custom domains** → add `ctrl.monster` (and `www` if wanted). DNS on Cloudflare is configured automatically.
7. Open `https://ctrl.monster` → Create your space.

### Database migration (automatic, idempotent, non-destructive)
On the first API request after deploy the function runs `lib/schema.js`: it creates `workspaces`, `sessions`, `email_tokens`, `rate_limits`, `login_failures`; adds `workspace_id` to `tasks`, `notes`, `folders`, `countdowns`; replaces the global folder-name index with a per-workspace one. **Nothing is deleted.** Rows from the old single-user MONO deployment keep `workspace_id = NULL` and are invisible to everyone until you assign them. After creating your own workspace, claim them in a Postgres console:

    select id, email from workspaces;                       -- copy your id
    update tasks      set workspace_id = '<id>' where workspace_id is null;
    update folders    set workspace_id = '<id>' where workspace_id is null;
    update notes      set workspace_id = '<id>' where workspace_id is null;
    update countdowns set workspace_id = '<id>' where workspace_id is null;

(The old app kept nothing in browser storage, so there is no local data to import.)

## PWA
`manifest.webmanifest` (name CTRL, 192/512/maskable icons, standalone, `/` scope). Sessions last 30 days, so an installed app stays signed in. No service worker is used (the app needs the network for its data). *Existing installs:* remove and re-add to home screen once to pick up the new name/icon.

## Local development
    npm install
    cp .dev.vars.example .dev.vars        # fill in
    export WRANGLER_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE="postgres://..."
    npm run dev                            # http://localhost:8788
    npm test                               # logic tests (no DB needed)

## Manual verification checklist (production)
1. Sign up with `aB7$`; confirm the email arrives from your sender; link opens “Email verified”.
2. Reuse the link → “already used”. Wait 16 min on another signup → “expired”.
3. Log in on a second device with `aB7$`; add a task; see it on the first device.
4. `ab7$` (wrong case) → invalid; 5 wrong tries → temporary lockout message.
5. Sign up with 3 or 5 characters / a space → rejected. Same code from another email → “already taken”.
6. “Forgot your code?” → email → choose new code → old code stops working, other devices signed out.
7. Settings → Sign out; reload → landing page. Use two workspaces and confirm neither sees the other's data.
8. Install to phone home screen; reopen → still signed in.

## Notes
- The greeting no longer includes a hard-coded name (it was personal to the previous private deployment).
- No Terms of Service/Privacy pages exist yet, so none are linked or claimed; add real ones before a wide public launch.
- `public/logo.png` is still the provisional mascot cut-out; replace it (and regenerate the `icon-*.png` files) with your final artwork.

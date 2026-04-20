# 01 — Security Findings

> Severity ordering: **Critical → High → Medium → Low**.
> File refs are clickable `[path:line](path:line)`.
> "Verified" = I checked the line(s) directly; "Inferred" = deduced from cross-references.

---

## Remediation status (2026-04-19)

| ID | Severity | Status | Where the fix lives |
|---|---|---|---|
| S-C1 | Critical | ✅ Fixed | `database/09_security_hardening.sql` (REVOKEs blanket grants + ALTER DEFAULT PRIVILEGES; per-table re-grants) — old block in `04_rls.sql` deleted |
| S-C2 | Critical | ✅ Mitigated | `database/10_one_shot_recovery.sql` (verified-email gate, conflict tickets instead of silent re-link, audit per row) |
| S-C3 | Critical | ✅ Fixed | `09_security_hardening.sql` `lookup_client_for_sale(query)` RPC + `delegated_sellers_clients_select` policy dropped |
| S-C4 | Critical | ✅ Fixed | `vercel.json` adds CSP, X-Frame-Options DENY, HSTS, Referrer-Policy, X-Content-Type-Options, Permissions-Policy, COOP |
| S-C5 | Critical | ✅ Fixed | `09_security_hardening.sql` — anon SELECT dropped on `parcels`/`project_offers`/`parcel_tree_batches`/`visit_slot_options`; new column-narrowed `public_*` views are the only anon read surface |
| S-H1 | High | ✅ Mitigated | Covered by CSP from S-C4; defense-in-depth against XSS-driven token theft |
| S-H2 | High | ✅ Fixed | `src/lib/supabase.js` — `maybeStripAuthHash()` clears `#access_token` on load + on every auth event |
| S-H3 | High | ⚠️ Scaffolded | `09_security_hardening.sql` adds `admin_users.mfa_required/mfa_enrolled` + `staff_needs_mfa()`. UI gate (`src/lib/mfaGate.js` + `RequireStaff`) is wired but enforcement is `ENFORCE = false` until the enrolment screen ships — flip the constant when ready. |
| S-H4 | High | ✅ Fixed | Recovery block extracted from `04_rls.sql` to one-shot `10_one_shot_recovery.sql` (token-gated) |
| S-H5 | High | ✅ Fixed | `src/lib/supabase.js` — `lock` no-op removed, default Web Locks back in service; transient lock errors retried in `AuthContext.init` |
| S-H6 | High | ⚠️ Documented | Table↔guard matrix at the bottom of `09_security_hardening.sql` (manual cross-check on every new admin route) |
| S-M1 | Medium | ✅ Fixed | `AuthContext.purgePiiSessionStorage()` runs on every `clearState()` |
| S-M2 | Medium | ✅ Fixed | `src/lib/supabase.js` throws in PROD on placeholder env, loud console error in dev |
| S-M3 | Medium | ✅ Fixed | `src/lib/passwordPolicy.js` central validator (≥10 chars, letter+digit, common-password block) wired into Login, Register, Reset, UserManagement placeholder |
| S-M4 | Medium | ✅ Fixed | `src/lib/safePaths.js` strict allowlist (rejects backslash / %2F / control chars / `@`) used by Login redirect |
| S-M5 | Medium | ✅ Fixed | `AuthContext.forceClearSupabaseToken()` purges `sb-*-auth-token` on logout regardless of signOut() outcome |
| S-M6 | Medium | ✅ Fixed | `getCanonicalOrigin()` — uses `VITE_APP_ORIGIN` in production, falls back to window in dev |
| S-M7 | Medium | ✅ Fixed | Reset SQL moved to `database/dev/` + token-gated guards in both files |
| S-L1 | Low | ✅ Fixed | `safeWarn`/`safeError` redactors in `AuthContext.jsx` strip emails / phones / tokens in PROD |
| S-L2 | Low | ✅ Fixed | 60s `setInterval` replaced by `visibilitychange` revalidation + 15min safety net |
| S-L3 | Low | ⏸️ Deferred | Sentry/Glitchtip needs creds + DSN; tracked separately |
| S-L4 | Low | ✅ Fixed | Inline theme `<script>` in `index.html` extracted to `public/theme-init.js`; CSP `script-src 'self'` strict |

**Summary:** 17 fixed, 2 mitigated, 2 scaffolded (S-H3, S-H6), 1 deferred (S-L3 — needs external account).

---

## Summary

| Severity | Count | Short list |
|---|---:|---|
| Critical | 5 | Blanket `GRANT` to anon/authenticated on public schema · Auto-linking by email/phone lets accounts be hijacked · No CSP/clickjacking headers · Delegated sellers can read **all** clients (PII) · Public anon read on sensitive catalog tables |
| High | 6 | No security headers on Vercel · Password-only Supabase auth with no 2FA on admin · Session in localStorage + no CSP = XSS → full takeover · `detectSessionInUrl` exposes access tokens · Unconditional one-shot migration in RLS file · `authLockSingleTab` disables cross-tab refresh lock |
| Medium | 7 | `sessionStorage` holds PII draft data · Placeholder fallback Supabase URL · Inconsistent password length rules · Open-redirect validation only partial · Logout can timeout silently · `forgot-password` redirect uses `window.origin` · Seed/reset SQL scripts co-located with prod |
| Low | 4 | PII in `console.warn` on auth failure · `validateTimer` every 60s burns tokens · No error tracker wired · Custom theme script runs inline at top of `<head>` |

---

## 🔴 Critical

### S-C1 — Blanket table/function grants to `anon` and `authenticated`
- File: [database/04_rls.sql:479-489](database/04_rls.sql:479)
- What: `GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO authenticated;` and `GRANT SELECT ON ALL TABLES IN SCHEMA public TO anon;`, plus `GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO anon;`. Also `ALTER DEFAULT PRIVILEGES` makes every future table/function open by default ([04_rls.sql:491-511](database/04_rls.sql:491)).
- Attack: Security becomes entirely dependent on RLS being **correctly set on every table that will ever be created**. One new table merged without an RLS policy (or with `enable row level security` forgotten) = fully world-readable/writable. The `anon` function grant means any SECURITY DEFINER function callable unauthenticated is a privilege-escalation vector — e.g., [03_functions.sql:1864 `create_buyer_stub_for_sale`](database/03_functions.sql:1864) granted to authenticated is one rename of grant away from anon.
- Fix: Remove the blanket grants. Grant per-table only (`GRANT SELECT ON public.projects TO anon; …`). Remove `ALTER DEFAULT PRIVILEGES`. This is the standard Supabase recommendation for any real app.

### S-C2 — Account hijack via auto-link by email/phone in RLS recovery block
- File: [database/04_rls.sql:527-575](database/04_rls.sql:527)
- What: `UPDATE public.clients … SET auth_user_id = au.id … WHERE c.auth_user_id IS NULL AND LOWER(c.email) = LOWER(au.email);` runs on every apply. Then `INSERT INTO public.client_phone_identities … ON CONFLICT (phone_canonical) DO UPDATE SET client_id = COALESCE(existing, excluded), auth_user_id = COALESCE(existing, excluded)`. Similar logic runs on every session resolve via [ensure_current_client_profile](database/03_functions.sql:168).
- Attack: If an attacker signs up with a victim's email **before the victim registers**, and the victim's `clients` row already exists (created by a staff member, ambassador stub, or import) with no `auth_user_id`, the attacker's auth user is auto-linked. They now inherit all of the victim's sales, installments, and commissions. Same trick works via phone — see C5 in [AUDIT_RELATIONS_PROBLEMES.md](../AUDIT_RELATIONS_PROBLEMES.md).
- Severity: critical if email confirmation is disabled in Supabase; still high even with confirmation because a family-shared phone number is the exploitation vector for the phone variant.
- Fix: (1) require verified email and verified phone before any auto-link; (2) when linking a phone to an auth user, require that no other active auth user already has that phone; (3) log every auto-link to `audit_logs` with before/after values; (4) do not auto-update an existing `clients.auth_user_id` or re-point `sales.client_id` silently — flag for admin review.

### S-C3 — Delegated sellers can `SELECT` every `clients` row (mass PII leak)
- File: [database/04_rls.sql:592-595](database/04_rls.sql:592)
- What: `create policy delegated_sellers_clients_select on public.clients for select to authenticated using (public.is_delegated_seller());` — no `client_id` scoping, no project scoping.
- Attack: Any client promoted to "delegated seller" (i.e., given the `/admin/sell` page access) can `SELECT * FROM public.clients` and dump every buyer in the database — full name, email, phone, CIN, address, balances. The policy comment claims it is "needed for buyer lookup in the Sell wizard" but that can be done through a narrower RPC (search by phone/email) instead of unrestricted SELECT.
- Fix: Replace the policy with an RPC `lookup_client_for_sale(query text)` that SECURITY DEFINER-filters to exact-match lookup, returns only the fields the wizard needs, and logs each lookup. Or limit the policy to clients that are already linked to a sale owned by the seller.

### S-C4 — No CSP / no clickjacking protection / no security headers
- File: [vercel.json](vercel.json) (entire file is `{"rewrites":[{"source":"/(.*)","destination":"/index.html"}]}`)
- What: No `Content-Security-Policy`, no `X-Frame-Options` / `frame-ancestors`, no `Referrer-Policy`, no `Strict-Transport-Security`, no `X-Content-Type-Options`. Supabase session is stored in localStorage (default) — any XSS = full account takeover, and with no CSP there is no defense-in-depth.
- Attack: An attacker embeds `https://app.example.com/admin/recouvrement` in an `<iframe>` on a phishing site and uses clickjacking to trick staff into approving a payout. Or an XSS in any third-party dep (`lucide-react`, `react-router`) becomes a full admin breach.
- Fix: Add a `headers` block to `vercel.json`:
  ```json
  {
    "headers": [{
      "source": "/(.*)",
      "headers": [
        {"key":"X-Frame-Options","value":"DENY"},
        {"key":"Content-Security-Policy","value":"default-src 'self'; connect-src 'self' https://*.supabase.co https://*.supabase.in; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; script-src 'self'; frame-ancestors 'none'"},
        {"key":"Referrer-Policy","value":"strict-origin-when-cross-origin"},
        {"key":"Strict-Transport-Security","value":"max-age=63072000; includeSubDomains; preload"},
        {"key":"X-Content-Type-Options","value":"nosniff"},
        {"key":"Permissions-Policy","value":"camera=(), microphone=(), geolocation=()"}
      ]
    }]
  }
  ```
  Note: the inline theme script in [index.html:12-27](index.html:12) will need either `'unsafe-inline'` for `script-src` (bad) or a nonce / a move to an external file (good).

### S-C5 — `anon` can SELECT `parcels` + `project_offers` (internal pricing, reservation state)
- File: [database/04_rls.sql:41-77](database/04_rls.sql:41)
- What: `public_select_parcels for select to anon using (true)` and same for `project_offers`, `parcel_tree_batches`, `visit_slot_options`. These tables carry internal fields (base price, reserved status, commission rules in adjacent `project_commission_rules`).
- Attack: A competitor or scraper hits the REST endpoint `https://<project>.supabase.co/rest/v1/parcels?select=*` with only the anon key (readable from any browser bundle) and exfiltrates the full portfolio — pricing, availability, internal codes — in one request.
- Fix: Replace with a narrower public view that exposes only the columns needed by the public catalog (title, image, status ∈ {'available'}, public price). Keep the raw `parcels` table staff-only.

---

## 🟠 High

### S-H1 — Session tokens in `localStorage` + no CSP = XSS → full account takeover
- File: [src/lib/supabase.js:18-25](src/lib/supabase.js:18)
- What: Supabase client uses default `persistSession: true` which stores the access + refresh tokens in `localStorage`. Combined with S-C4 (no CSP), any XSS — even in a third-party dep — reads `localStorage` and exfiltrates the refresh token (valid for weeks by default).
- Fix: Short term — add CSP (S-C4). Long term — consider a cookie-backed session via a Supabase Edge Function or server-side proxy so the token is `HttpOnly`.

### S-H2 — `detectSessionInUrl: true` exposes access token in URL hash
- File: [src/lib/supabase.js:22](src/lib/supabase.js:22)
- What: Magic-link / password-reset flows return the access token in `#access_token=…`. Any `<a target="_blank">` or analytics script loaded on the `/reset-password` page before the hash is consumed can read `window.location.hash` and leak the token.
- Fix: Clear the hash immediately after Supabase consumes it (`window.history.replaceState(null,'',location.pathname)`), and keep `/reset-password` free of third-party scripts. Consider disabling hash-based flows in favor of the OTP-code flow.

### S-H3 — No 2FA / step-up auth on admin, finance, or danger-zone routes
- File: [src/App.jsx:88-112](src/App.jsx:88), [src/components/RequireStaff.jsx](src/components/RequireStaff.jsx)
- What: A single password is enough to sign commission payouts, approve refunds, modify `admin_users`, or run the danger-zone. Supabase supports MFA; nothing enforces it.
- Fix: Gate `/admin/finance`, `/admin/users`, `/admin/danger-zone` behind `supabase.auth.mfa.challenge()` step-up. Add a DB check `admin_users.mfa_enrolled` and deny login otherwise.

### S-H4 — Unconditional data migration inside RLS script (runs on every apply)
- File: [database/04_rls.sql:527-575](database/04_rls.sql:527)
- What: The "recovery" block is labeled "safe to re-run" but performs `UPDATE` and `INSERT … ON CONFLICT DO UPDATE` on live data every time the file is applied. If RLS is iterated in prod (which is normal), these queries will keep re-linking and potentially re-pointing client rows. This is the fuel for S-C2.
- Fix: Move the recovery block into a separate, explicitly-versioned `09_migrate_...sql` file. Make it a one-time migration with an `audit_logs` entry per row it touches. Never bundle it with RLS.

### S-H5 — `authLockSingleTab` disables cross-tab lock → refresh-token race → forced logout
- File: [src/lib/supabase.js:12-23](src/lib/supabase.js:12)
- What: The lock function is a no-op (`async (_, __, fn) => fn()`). Two tabs refreshing the token concurrently can each call `/token?grant_type=refresh_token`, invalidating each other's refresh token (Supabase rotates them). Result: one tab's session dies.
- Risk vector: stale session → the user re-logs → during the narrow window, error messages may leak account existence.
- Fix: Use `@supabase/supabase-js` default (WebLocks) and handle the `NavigatorLockAcquireTimeoutError` explicitly as "another tab is refreshing, retry in 500ms" rather than silencing via no-op.

### S-H6 — Role gating is entirely client-side for some admin pages
- Files: [src/components/RequireStaff.jsx:32-39](src/components/RequireStaff.jsx:32), [src/lib/adminAccess.js:14-16](src/lib/adminAccess.js:14)
- What: `canAccessAdminPath` is a JS prefix match on `allowedPages`. If RLS on the underlying table is weak (see S-C1), a user who bypasses the React guard by calling Supabase directly can still read/write the data. Example: `fetch("https://<proj>.supabase.co/rest/v1/commission_events?select=*")` — only RLS stops them.
- Fix: Verify every table used by the admin UI has RLS that enforces the same scope the client guard enforces. Prefer SECURITY DEFINER RPCs for any action the client cannot be trusted to gate.

---

## 🟡 Medium

### S-M1 — `sessionStorage` holds draft sale including client PII
- File: [src/admin/pages/SellPage.jsx:401-458,706-708](src/admin/pages/SellPage.jsx:401)
- What: `FORM_STORAGE_KEY`, `STEP_STORAGE_KEY`, `DRAWER_STORAGE_KEY` are written every keystroke with form state (buyer name, phone, price). On a shared/kiosk machine the next user can recover the previous seller's in-progress sale.
- Fix: Clear on logout (not just on successful submit). Prefer `sessionStorage` over `localStorage` (already done — good) and purge on auth-state change.

### S-M2 — `VITE_SUPABASE_*` placeholder fallback
- File: [src/lib/supabase.js:18](src/lib/supabase.js:18)
- What: If env vars are missing, client is created against `https://placeholder.supabase.co` with key `"placeholder"`. No user-visible error — requests will silently 401/404.
- Fix: `throw new Error(...)` at boot when env is missing, or render a bright error screen. Never let the app run against a placeholder.

### S-M3 — Inconsistent password length rule
- File: [src/pages/ResetPasswordPage.jsx:46](src/pages/ResetPasswordPage.jsx:46) requires ≥ 8. [src/admin/pages/UserManagementPage.jsx:1040](src/admin/pages/UserManagementPage.jsx:1040) placeholder says "Minimum 6 caractères". Register / Supabase defaults differ.
- Fix: One central `validatePassword()` function, 12+ chars recommended, enforced in register, reset, and admin-create flows.

### S-M4 — `login` uses `fromPath` with partial validation
- File: [src/pages/LoginPage.jsx:40-45](src/pages/LoginPage.jsx:40)
- What: Checks `startsWith('/')`, `!startsWith('//')`, `!includes('://')`. Misses path traversal `\\evil.com` (backslash), Unicode slashes, `%2F` encoded. Modern React-Router won't parse these, but a future change to `<a href>` could.
- Fix: Use a strict allowlist of known app routes rather than free-form path matching.

### S-M5 — `logout` swallows timeout and does not force-clear localStorage
- File: [src/lib/AuthContext.jsx:585-596](src/lib/AuthContext.jsx:585)
- What: If `signOut()` times out (5s), local state is cleared but `localStorage` token may remain (the Supabase client sometimes skips clearing on network error). Next visit re-hydrates a half-session.
- Fix: On timeout, manually `localStorage.removeItem('sb-<project-ref>-auth-token')`. (Add a comment noting the exact key name based on the project ref.)

### S-M6 — `forgotPassword` redirect uses `window.location.origin`
- File: [src/lib/AuthContext.jsx:601](src/lib/AuthContext.jsx:601)
- What: `redirectTo: ${window.location.origin}/reset-password` — if the app is ever served under a preview subdomain (Vercel preview) and an attacker gets the victim to initiate password reset from a preview URL they control, the reset link goes to the preview origin.
- Fix: Hardcode the canonical prod origin when env is `VITE_ENV === 'production'`. Still allow `origin` in dev.

### S-M7 — `01_reset_full.sql` and `01b_reset_keep_accounts.sql` are tracked in git alongside prod SQL
- File: [database/01_reset_full.sql](database/01_reset_full.sql)
- What: Human error = someone runs `01_reset_full.sql` against the prod DB in the SQL editor and wipes data. File structure doesn't force separation.
- Fix: Move destructive scripts to `database/dev/` with a `README.txt` stating "NEVER run against prod", and add a `RAISE EXCEPTION IF current_database() = 'prod_name'` guard at the top of each.

---

## 🟢 Low

### S-L1 — PII in `console.warn` on auth failures
- Files: [src/lib/AuthContext.jsx:101,149,199,239,431,549](src/lib/AuthContext.jsx:101) — multiple `console.warn(...)` include `e?.message` which can carry email/UUID.
- Fix: In prod, drop console logs or route them through a structured logger that redacts.

### S-L2 — 60s periodic `getUser()` on every authenticated tab
- File: [src/lib/AuthContext.jsx:337-355](src/lib/AuthContext.jsx:337)
- What: `setInterval(…, 60_000)` hits Supabase every minute per tab. Rate-limits your project; cost; and minor info-leak through traffic analysis.
- Fix: Only revalidate on tab focus (`visibilitychange`) and on 401 response, not on a fixed timer.

### S-L3 — No error tracker wired
- Files: [src/components/AppErrorBoundary.jsx](src/components/AppErrorBoundary.jsx) — likely logs only to console.
- Fix: Add Sentry or similar; scrub PII before sending.

### S-L4 — Inline `<script>` in `<head>` for theme flicker
- File: [index.html:12-27](index.html:12)
- What: Inline script blocks the strict `script-src 'self'` CSP (S-C4). Small surface but annoying.
- Fix: Move to `/src/init-theme.js` or use a CSP nonce.

---

## What I did NOT find

- No `dangerouslySetInnerHTML`, no `innerHTML=`, no `eval()` in `src/**` — good.
- No hardcoded Supabase URL or service-role key in git history (grep found none).
- No hardcoded demo password / admin bypass flag.

---

## Next steps (concrete)

1. Ship **S-C4** (headers) today — pure config change, no code risk.
2. Investigate **S-C3** and **S-C5** together — both are RLS policy tightening.
3. Design a migration plan for **S-C1** (remove blanket grants) — this needs care because the app currently relies on "anything RLS allows, authenticated can do".
4. Design **S-C2** mitigation: add a `link_requests` table and manual admin approval for any auth↔client merge.

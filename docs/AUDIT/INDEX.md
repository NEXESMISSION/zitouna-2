# Audit Index

This folder holds two rounds of audit findings plus a consolidated
questions file. Read in order.

## Files

| # | File | Lines | Round | Content |
|---|------|------:|-------|---------|
| 00 | [00_QUESTIONS_FOR_USER.md](00_QUESTIONS_FOR_USER.md) | 201 | R1 | Questions that came out of round 1 |
| 01 | [01_SECURITY_FINDINGS.md](01_SECURITY_FINDINGS.md) | 177 | R1 | Security (auth, RLS grants, headers) |
| 02 | [02_DATABASE_RLS_FINDINGS.md](02_DATABASE_RLS_FINDINGS.md) | 169 | R1 | DB schema + RLS policy gaps |
| 03 | [03_BUSINESS_LOGIC_FINDINGS.md](03_BUSINESS_LOGIC_FINDINGS.md) | 157 | R1 | Commission / installment / sale logic |
| 04 | [04_FRONTEND_CORRECTNESS_FINDINGS.md](04_FRONTEND_CORRECTNESS_FINDINGS.md) | 159 | R1 | React state, realtime, auth gates |
| 10 | [10_SECURITY_DEEP_AUDIT.md](10_SECURITY_DEEP_AUDIT.md) | 292 | R2 | Deep security pass, incl. `08_notifications.sql` |
| 11 | [11_DATABASE_DEEP_AUDIT.md](11_DATABASE_DEEP_AUDIT.md) | 169 | R2 | Deep DB/RLS pass |
| 12 | [12_BUSINESS_LOGIC_DEEP_AUDIT.md](12_BUSINESS_LOGIC_DEEP_AUDIT.md) | 199 | R2 | Deep business-logic pass |
| 13 | [13_FRONTEND_DEEP_AUDIT.md](13_FRONTEND_DEEP_AUDIT.md) | 161 | R2 | Deep React/state pass |
| 99 | [99_QUESTIONS_FOR_USER_v2.md](99_QUESTIONS_FOR_USER_v2.md) | ~300 | R2 | Consolidated question list — answer these |

R1 = first audit round (pre-notifications rewrite).
R2 = second audit round (run 2026-04-18, after `database/08_notifications.sql` shipped).

## Severity rollup — round 2

| Domain         | Critical | High | Medium | Low |
|----------------|---------:|-----:|-------:|----:|
| Security (10)  | 2 | 3 | 5 | — |
| Database (11)  | 3 | 6 | 7 | 4 |
| Business (12)  | 3 | — | — | — |
| Frontend (13)  | 2 | — | — | — |
| **Total R2**   | **10** | **9+** | **12+** | **4+** |

## Top-10 most damaging items across R1 + R2

These are the ones that would hurt you in production today.

1. **DB11-C1** — `emit_notification` is `SECURITY DEFINER` with no identity check → any authenticated user can forge admin phishing notifications
2. **DB11-C2** — Blanket `ALTER DEFAULT PRIVILEGES GRANT EXECUTE … TO anon` means even unauthenticated callers can invoke those forgery helpers
3. **BL12-C1** — `expire_pending_sales_reservations` RPC is referenced by the client but never defined; expiry silently broken
4. **BL12-C2** — Double-payout race on `commission_payout_request_items` (no unique index on `commission_event_id`)
5. **BL12-C3** — Cancelled sale does not reverse its commission events → beneficiary still withdraws
6. **S-C1 (R1)** — Blanket `GRANT ALL` to `authenticated` on every table
7. **S-C2 (R1)** — Auto-link by email/phone in RLS recovery block → account hijack
8. **S-C3 (R1)** — Delegated sellers can `SELECT *` from `clients` (PII leak)
9. **FE2-C1** — Module-scope data cache leaks PII across users on switch
10. **FE2-C2** — `useNotifications` re-subscribes realtime channel on every parent re-render

## Next steps

1. You read `99_QUESTIONS_FOR_USER_v2.md` and answer the Q0 and Q1
   questions at minimum — those gate every patch.
2. I produce a patch plan ranked by damage × effort.
3. Patches land as small PR-sized diffs with tests/invariants per fix.

## Provenance

All four R2 reports were written by parallel subagents scoped to their
domain on 2026-04-18. Each was given the matching R1 report as context
and instructed to dedup against it. The `Already covered` sections in
each R2 report tell you what R1 called out that's still current.

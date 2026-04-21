#!/usr/bin/env node
/**
 * Concurrency probe for DEV_SECURITY_AUDIT finding H1.
 *
 * Fires N parallel calls to request_ambassador_payout from the same user
 * with *different* idempotency keys and a small amount, then counts how
 * many winning requests ended up in pending_review status.
 *
 * After the advisory-lock fix in database/dev/security_remediation_2026_04_21.sql,
 * exactly ONE call should succeed — the rest must fail with
 * INSUFFICIENT_BALANCE or NO_PAYABLE_EVENTS because the first transaction
 * has already claimed all payable events before the next one runs.
 *
 * Before the fix, 2+ calls can succeed, each claiming overlapping
 * commission_events — that's the double-booking bug.
 *
 * Usage:
 *   PROBE_SUPABASE_URL=... \
 *   PROBE_SUPABASE_ANON_KEY=... \
 *   PROBE_JWT_USER_A=... \
 *   PROBE_PAYOUT_AMOUNT=1 \
 *   PROBE_PAYOUT_PARALLELISM=10 \
 *   npm run security:race-probe
 *
 * PROBE_JWT_USER_A must be for a user that has payable balance on
 * staging — the probe is inherently destructive (creates real payout
 * request rows). Clean up the rows afterward or run against a
 * disposable project.
 */

import { readFileSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createClient } from '@supabase/supabase-js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const projectRoot = join(__dirname, '..', '..')

function loadDotEnv() {
  for (const name of ['.env.local', '.env']) {
    const p = join(projectRoot, name)
    if (!existsSync(p)) continue
    const text = readFileSync(p, 'utf8')
    for (const line of text.split('\n')) {
      const trimmed = line.trim()
      if (!trimmed || trimmed.startsWith('#')) continue
      const eq = trimmed.indexOf('=')
      if (eq === -1) continue
      const key = trimmed.slice(0, eq).trim()
      let val = trimmed.slice(eq + 1).trim()
      if (
        (val.startsWith('"') && val.endsWith('"'))
        || (val.startsWith("'") && val.endsWith("'"))
      ) {
        val = val.slice(1, -1)
      }
      if (process.env[key] === undefined) process.env[key] = val
    }
    break
  }
}

loadDotEnv()

function env(name, ...alts) {
  const v = [name, ...alts].map((k) => process.env[k]).find((x) => x && String(x).trim())
  return v ? String(v).trim() : ''
}

const url = env('PROBE_SUPABASE_URL', 'VITE_SUPABASE_URL', 'SUPABASE_URL')
const anonKey = env('PROBE_SUPABASE_ANON_KEY', 'VITE_SUPABASE_ANON_KEY', 'SUPABASE_ANON_KEY')
const jwt = env('PROBE_JWT_USER_A')
const amount = Number(env('PROBE_PAYOUT_AMOUNT') || '1')
const parallelism = Number(env('PROBE_PAYOUT_PARALLELISM') || '10')

if (!url || !anonKey || !jwt) {
  console.error(
    '[race-payout-probe] Missing env. Required: PROBE_SUPABASE_URL, PROBE_SUPABASE_ANON_KEY, PROBE_JWT_USER_A',
  )
  process.exit(1)
}
if (!(amount > 0)) {
  console.error('[race-payout-probe] PROBE_PAYOUT_AMOUNT must be > 0')
  process.exit(1)
}
if (!(parallelism >= 2)) {
  console.error('[race-payout-probe] PROBE_PAYOUT_PARALLELISM must be >= 2')
  process.exit(1)
}

const sb = createClient(url, anonKey, {
  global: { headers: { Authorization: `Bearer ${jwt}` } },
})

async function oneCall(i) {
  const key = `race-probe-${Date.now()}-${i}-${Math.random().toString(36).slice(2, 8)}`
  const { data, error } = await sb.rpc('request_ambassador_payout', {
    p_amount: amount,
    p_idempotency_key: key,
  })
  return { i, key, data, error: error ? { code: error.code, message: error.message } : null }
}

async function main() {
  console.log(
    `[race-payout-probe] firing ${parallelism} parallel calls, amount=${amount}`,
  )
  const started = Date.now()
  const results = await Promise.all(
    Array.from({ length: parallelism }, (_, i) => oneCall(i)),
  )
  const elapsed = Date.now() - started

  const successes = results.filter((r) => !r.error && r.data?.ok === true && !r.data?.idempotent)
  const idempotentHits = results.filter((r) => !r.error && r.data?.idempotent === true)
  const errors = results.filter((r) => r.error)
  const otherFails = results.filter(
    (r) => !r.error && !(r.data?.ok === true) && !(r.data?.idempotent === true),
  )

  console.log(
    `\nResults (${elapsed}ms):`,
    `\n  successes:         ${successes.length}`,
    `\n  idempotent hits:   ${idempotentHits.length}`,
    `\n  errors:            ${errors.length}`,
    `\n  other non-ok:      ${otherFails.length}`,
  )

  for (const s of successes.slice(0, 5)) {
    console.log(`  [win] requestId=${s.data.requestId} code=${s.data.code}`)
  }
  const errorBuckets = new Map()
  for (const e of errors) {
    const key = `${e.error.code || ''}:${e.error.message?.slice(0, 80) || ''}`
    errorBuckets.set(key, (errorBuckets.get(key) || 0) + 1)
  }
  if (errorBuckets.size) {
    console.log('  error distribution:')
    for (const [k, n] of errorBuckets) console.log(`    ${n}× ${k}`)
  }

  console.log('\nExpectation:')
  console.log('  After the H1 advisory-lock fix, exactly 1 success — other')
  console.log('  calls should fail with NO_PAYABLE_EVENTS or INSUFFICIENT_BALANCE.')
  console.log('  >1 success indicates the race is still present.\n')

  if (successes.length > 1) {
    console.error(
      `[FAIL] race detected: ${successes.length} concurrent successes — H1 is NOT fixed.`,
    )
    process.exit(1)
  }
  if (successes.length === 0) {
    console.warn(
      '[WARN] 0 successes — test user has no payable balance or all requests lost to errors.',
    )
  } else {
    console.log('[ok] H1 advisory lock holds — only 1 concurrent claim succeeded.')
  }
}

main().catch((e) => {
  console.error('[race-payout-probe] fatal:', e)
  process.exit(1)
})

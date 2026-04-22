#!/usr/bin/env node
/**
 * Phase C — parallel INSERT into `sales` for the same parcel (delegated seller).
 *
 * If two concurrent requests both pass RLS and the DB lacks a unique guard
 * on (parcel_id) for non-terminal states, you can get double sales — this
 * probe tries to surface that on staging.
 *
 * **Requires a real delegated-seller** setup (same as production Sell wizard):
 *   - JWT for a user linked to `clients` with `allowed_pages` or
 *     `page_access_grants` covering /admin/sell or /sell
 *   - A real `project_id`, `parcel_id` (bigint), buyer `client_id`,
 *     and `seller_client_id` = delegated seller's clients.id
 *   - Parcel should be `available` or whatever your transition allows
 *
 * Usage (staging only):
 *   PROBE_SUPABASE_URL=... PROBE_SUPABASE_ANON_KEY=... \
 *   PROBE_JWT_DELEGATED_SELLER=... \
 *   PROBE_PROJECT_ID=proj-... \
 *   PROBE_PARCEL_ID=123 \
 *   PROBE_BUYER_CLIENT_ID=uuid \
 *   PROBE_SELLER_CLIENT_ID=uuid \
 *   PROBE_PARALLELISM=5 \
 *   npm run security:race-sale-probe
 *
 * If any env is missing, the script exits 0 with a skip message (safe for CI).
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

const url = env('PROBE_SUPABASE_URL', 'VITE_SUPABASE_URL')
const anonKey = env('PROBE_SUPABASE_ANON_KEY', 'VITE_SUPABASE_ANON_KEY')
const jwt = env('PROBE_JWT_DELEGATED_SELLER', 'PROBE_JWT_USER_A')
const projectId = env('PROBE_PROJECT_ID')
const parcelId = Number(env('PROBE_PARCEL_ID'))
const buyerClientId = env('PROBE_BUYER_CLIENT_ID')
const sellerClientId = env('PROBE_SELLER_CLIENT_ID')
const parallelism = Math.max(2, Number(env('PROBE_PARALLELISM') || '5'))

const required = [url, anonKey, jwt, projectId, buyerClientId, sellerClientId]
const parcelOk = Number.isFinite(parcelId) && parcelId > 0

if (required.some((x) => !x) || !parcelOk) {
  console.log(
    '[race-delegated-sale-probe] SKIP — set PROBE_SUPABASE_URL, PROBE_SUPABASE_ANON_KEY, '
      + 'PROBE_JWT_DELEGATED_SELLER (or PROBE_JWT_USER_A), PROBE_PROJECT_ID, PROBE_PARCEL_ID, '
      + 'PROBE_BUYER_CLIENT_ID, PROBE_SELLER_CLIENT_ID',
  )
  process.exit(0)
}

const sb = createClient(url, anonKey, {
  global: { headers: { Authorization: `Bearer ${jwt}` } },
})

function salePayload(i) {
  return {
    code: `RACE-${Date.now()}-${i}`,
    project_id: projectId,
    parcel_id: parcelId,
    parcel_ids: [parcelId],
    client_id: buyerClientId,
    seller_client_id: sellerClientId,
    payment_type: 'full',
    agreed_price: 1,
    status: 'pending_finance',
    pipeline_status: 'pending_finance',
  }
}

async function oneInsert(i) {
  const { data, error } = await sb.from('sales').insert(salePayload(i)).select('id').single()
  return { i, data, error: error ? { message: error.message, code: error.code } : null }
}

async function main() {
  console.log(
    `[race-delegated-sale-probe] ${parallelism} parallel inserts parcel_id=${parcelId} (staging)`,
  )
  const results = await Promise.all(
    Array.from({ length: parallelism }, (_, i) => oneInsert(i)),
  )

  const wins = results.filter((r) => !r.error && r.data?.id)
  const errs = results.filter((r) => r.error)

  console.log(`  successes: ${wins.length}, errors: ${errs.length}`)
  for (const e of errs.slice(0, 5)) {
    console.log(`  [err] ${e.error.code || ''} ${e.error.message?.slice(0, 120)}`)
  }

  if (wins.length > 1) {
    console.error(
      `[FAIL] ${wins.length} concurrent inserts succeeded — possible double-sale or race.`
      + ' Inspect DB constraints and reservation flow.',
    )
    process.exit(1)
  }
  if (wins.length === 1) {
    console.log('[ok] At most one concurrent insert won — no obvious double-sale in this burst.')
  } else {
    console.log('[info] 0 inserts succeeded — RLS/parcel state rejected all (expected if parcel not available).')
  }
}

main().catch((e) => {
  console.error('[race-delegated-sale-probe] fatal:', e)
  process.exit(1)
})

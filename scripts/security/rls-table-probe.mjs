#!/usr/bin/env node
/**
 * Direct PostgREST table probes — the other half of security:rls-probe.
 *
 * Where rls-rpc-probe exercises SECURITY DEFINER RPCs, this script goes
 * straight at the REST endpoints (same thing the client uses in db.js)
 * and verifies that every sensitive table behaves under each role.
 *
 * Usage:
 *   npm run security:table-probe
 *
 * Required env:
 *   PROBE_SUPABASE_URL  (or VITE_SUPABASE_URL)
 *   PROBE_SUPABASE_ANON_KEY  (or VITE_SUPABASE_ANON_KEY)
 *
 * Optional env (enables more rows in the matrix):
 *   PROBE_JWT_USER_A            Supabase access_token for a test client
 *   PROBE_JWT_USER_B            another test client
 *   PROBE_FOREIGN_CLIENT_ID     another client's UUID (cross-tenant)
 *   PROBE_OWN_PAYMENT_ID        installment_payments.id owned by USER_A
 *   PROBE_OWN_PLAN_ID           installment_plans.id  owned by USER_A
 *
 * Safe against prod? Use staging. Every destructive probe uses placeholder
 * UUIDs or runs against ids you supply; no probe touches real money. Still
 * — use a disposable project.
 */

import { readFileSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createClient } from '@supabase/supabase-js'
import { TABLE_PROBE_MATRIX } from './rls-table-matrix.mjs'

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
const jwtA = env('PROBE_JWT_USER_A', 'SUPABASE_PROBE_JWT_A')
const jwtB = env('PROBE_JWT_USER_B', 'SUPABASE_PROBE_JWT_B')

const substitutions = {
  __FOREIGN_CLIENT_ID__: env('PROBE_FOREIGN_CLIENT_ID'),
  __OWN_PAYMENT_ID__: env('PROBE_OWN_PAYMENT_ID'),
  __OWN_PLAN_ID__: env('PROBE_OWN_PLAN_ID'),
}

function makeClient(accessToken) {
  if (!url || !anonKey) {
    console.error(
      '[rls-table-probe] Missing PROBE_SUPABASE_URL / VITE_SUPABASE_URL or anon key. See .env.example',
    )
    process.exit(1)
  }
  if (accessToken) {
    return createClient(url, anonKey, {
      global: { headers: { Authorization: `Bearer ${accessToken}` } },
    })
  }
  return createClient(url, anonKey)
}

function substitutePlaceholders(obj) {
  if (obj == null || typeof obj !== 'object') return obj
  const out = Array.isArray(obj) ? [] : {}
  for (const [k, v] of Object.entries(obj)) {
    if (typeof v === 'string' && Object.hasOwn(substitutions, v)) {
      const resolved = substitutions[v]
      if (!resolved) return null
      out[k] = resolved
    } else {
      out[k] = v
    }
  }
  return out
}

async function runProbe(client, row) {
  const where = row.where ? substitutePlaceholders(row.where) : null
  if (row.where && where === null) {
    return { skipped: true, reason: 'missing placeholder env for WHERE' }
  }
  const payload = row.payload ? substitutePlaceholders(row.payload) : null
  if (row.payload && payload === null) {
    return { skipped: true, reason: 'missing placeholder env for payload' }
  }

  let builder = client.from(row.table)

  if (row.op === 'select') {
    builder = builder.select('*')
    if (where) {
      for (const [k, v] of Object.entries(where)) builder = builder.eq(k, v)
    }
    if (row.limit) builder = builder.limit(row.limit)
  } else if (row.op === 'insert') {
    builder = builder.insert(payload).select()
  } else if (row.op === 'update') {
    builder = builder.update(payload)
    if (where) {
      for (const [k, v] of Object.entries(where)) builder = builder.eq(k, v)
    }
    builder = builder.select()
  } else if (row.op === 'delete') {
    builder = builder.delete()
    if (where) {
      for (const [k, v] of Object.entries(where)) builder = builder.eq(k, v)
    }
    builder = builder.select()
  } else {
    return { ok: false, detail: `unknown op: ${row.op}` }
  }

  const { data, error } = await builder

  return evaluate(row, data, error)
}

function evaluate(row, data, error) {
  if (row.expect === 'deny') {
    const style = row.denyStyle || 'strict'
    if (error) return { ok: true, detail: `deny (${error.code || error.message})` }
    if (style === 'empty_result') {
      if (Array.isArray(data) && data.length === 0) {
        return { ok: true, detail: 'deny (empty result — RLS filtered)' }
      }
      return {
        ok: false,
        detail: `expected error or empty result; got ${Array.isArray(data) ? data.length : typeof data} rows`,
      }
    }
    return {
      ok: false,
      detail: `expected PostgREST error; data=${JSON.stringify(data)?.slice(0, 300)}`,
    }
  }

  if (row.expect === 'allow') {
    if (error) return { ok: false, detail: error.message || String(error) }
    return { ok: true, detail: 'allow' }
  }

  if (row.expect === 'allow_limited') {
    if (error) return { ok: false, detail: error.message || String(error) }
    const n = Array.isArray(data) ? data.length : 0
    if (row.maxRows != null && n > row.maxRows) {
      return { ok: false, detail: `row cap breach: got ${n}, max=${row.maxRows}` }
    }
    return { ok: true, detail: `allow (${n} rows, cap=${row.maxRows ?? '∞'})` }
  }

  return { ok: false, detail: `unknown expect: ${row.expect}` }
}

async function main() {
  const clients = {
    anon: makeClient(null),
    user_a: jwtA ? makeClient(jwtA) : null,
    user_b: jwtB ? makeClient(jwtB) : null,
  }

  if (!jwtA) {
    console.warn('[rls-table-probe] PROBE_JWT_USER_A not set — skipping user_a probes.\n')
  }

  let passed = 0
  let failed = 0
  let skipped = 0

  for (const row of TABLE_PROBE_MATRIX) {
    if (row.needsEnv?.length) {
      const missing = row.needsEnv.filter((k) => !env(k))
      if (missing.length) {
        console.log(`[skip] ${row.id} — missing env: ${missing.join(', ')}`)
        skipped += 1
        continue
      }
    }

    const role = row.role || 'anon'
    const client = clients[role]
    if (!client) {
      console.log(`[skip] ${row.id} — no client for role ${role}`)
      skipped += 1
      continue
    }

    let result
    try {
      result = await runProbe(client, row)
    } catch (e) {
      result = { ok: false, detail: e?.message || String(e) }
    }

    if (result.skipped) {
      console.log(`[skip] ${row.id} — ${result.reason}`)
      skipped += 1
      continue
    }

    const label = `${row.table}.${row.op}`
    if (result.ok) {
      console.log(`[ok]   ${row.id} (${label}) ${result.detail || ''}`)
      passed += 1
    } else {
      console.error(`[FAIL] ${row.id} (${label}) ${result.detail}`)
      if (row.description) console.error(`        → ${row.description}`)
      failed += 1
    }
  }

  console.log(
    `\n[rls-table-probe] done: ${passed} passed, ${failed} failed, ${skipped} skipped`,
  )

  if (failed > 0) process.exit(1)
}

main().catch((e) => {
  console.error('[rls-table-probe] fatal:', e)
  process.exit(1)
})

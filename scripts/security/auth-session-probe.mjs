#!/usr/bin/env node
/**
 * Phase D (light) — PostgREST behavior with bad / missing auth.
 * Does not replace Supabase Auth unit tests; catches "silent empty data" class
 * issues if the client ever sent malformed Authorization headers.
 *
 * Usage:
 *   npm run security:auth-probe
 *
 * Required: PROBE_SUPABASE_URL, PROBE_SUPABASE_ANON_KEY (or VITE_*).
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

function env(...names) {
  for (const k of names) {
    const v = process.env[k]
    if (v && String(v).trim()) return String(v).trim()
  }
  return ''
}

const url = env('PROBE_SUPABASE_URL', 'VITE_SUPABASE_URL', 'SUPABASE_URL')
const anonKey = env('PROBE_SUPABASE_ANON_KEY', 'VITE_SUPABASE_ANON_KEY', 'SUPABASE_ANON_KEY')

if (!url || !anonKey) {
  console.error('[auth-session-probe] Missing PROBE_SUPABASE_URL / anon key.')
  process.exit(1)
}

/** JWT-shaped but invalid signature — PostgREST must reject. */
const BOGUS_JWT
  = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIwMDAwMDAwMC0wMDAwLTAwMDAtMDAwMC0wMDAwMDAwMDAwMDEifQ.invalidsig'

async function assertFails(label, client) {
  const { data, error } = await client.from('clients').select('id').limit(1)
  if (!error) {
    console.error(`[FAIL] ${label}: expected error, got data=${JSON.stringify(data)?.slice(0, 80)}`)
    return false
  }
  console.log(`[ok]   ${label} → ${error.code || ''} ${String(error.message).slice(0, 120)}`)
  return true
}

async function main() {
  let failed = 0

  const anon = createClient(url, anonKey)
  const { data: anonData, error: anonErr } = await anon.from('projects').select('id').limit(1)
  if (anonErr) {
    console.error('[FAIL] anon catalog read:', anonErr.message)
    failed += 1
  } else {
    console.log(`[ok]   anon → projects readable (${Array.isArray(anonData) ? anonData.length : '?'} row sample)`)
  }

  const badBearer = createClient(url, anonKey, {
    global: { headers: { Authorization: `Bearer ${BOGUS_JWT}` } },
  })
  if (!(await assertFails('bogus JWT on clients.select', badBearer))) failed += 1

  const wrongScheme = createClient(url, anonKey, {
    global: { headers: { Authorization: `Basic ${Buffer.from('x:y').toString('base64')}` } },
  })
  if (!(await assertFails('Basic auth on clients.select', wrongScheme))) failed += 1

  const jwtA = env('PROBE_JWT_USER_A', 'SUPABASE_PROBE_JWT_A')
  if (jwtA) {
    const good = createClient(url, anonKey, {
      global: { headers: { Authorization: `Bearer ${jwtA}` } },
    })
    const { error } = await good.from('clients').select('id').limit(1)
    if (error) {
      console.log(`[info] PROBE_JWT_USER_A → clients.select: ${error.message}`)
    } else {
      console.log('[ok]   PROBE_JWT_USER_A → clients.select: no error (expected for linked user)')
    }
  } else {
    console.log('[skip] PROBE_JWT_USER_A not set — skipped real-session sanity check')
  }

  console.log(
    failed > 0
      ? `\n[auth-session-probe] FAILED (${failed})`
      : '\n[auth-session-probe] OK',
  )
  if (failed > 0) process.exit(1)
}

main().catch((e) => {
  console.error('[auth-session-probe] fatal:', e)
  process.exit(1)
})

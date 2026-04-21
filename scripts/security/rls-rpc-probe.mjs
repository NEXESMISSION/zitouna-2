#!/usr/bin/env node
/**
 * RPC / RLS smoke probes against a Supabase project (staging strongly recommended).
 *
 * Usage:
 *   Set env (see .env.example), then:
 *     npm run security:rls-probe
 *
 * Uses the anon key + optional user JWTs (Authorization) — never the service role.
 */

import { readFileSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createClient } from '@supabase/supabase-js'
import { PROBE_MATRIX } from './rls-probe-matrix.mjs'

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
const foreignClientId = env('PROBE_FOREIGN_CLIENT_ID')

function makeClient(accessToken) {
  if (!url || !anonKey) {
    console.error(
      '[rls-rpc-probe] Missing PROBE_SUPABASE_URL / VITE_SUPABASE_URL or anon key. See .env.example',
    )
    process.exit(1)
  }
  if (accessToken) {
    return createClient(url, anonKey, {
      global: {
        headers: { Authorization: `Bearer ${accessToken}` },
      },
    })
  }
  return createClient(url, anonKey)
}

function substituteArgs(row) {
  let args = row.args
  if (typeof args === 'object' && args !== null && !Array.isArray(args)) {
    args = { ...args }
    const json = JSON.stringify(args)
    if (json.includes('__FOREIGN_CLIENT_ID__')) {
      if (!foreignClientId) return null
      for (const k of Object.keys(args)) {
        if (args[k] === '__FOREIGN_CLIENT_ID__') args[k] = foreignClientId
      }
    }
  }
  return args
}

function denySatisfied(row, data, error) {
  if (error) return { ok: true, note: `deny (${error.code || error.message})` }

  const style = row.denyStyle || 'strict'

  if (style === 'json_ok_false') {
    if (data && data.ok === false) return { ok: true, note: 'deny (json ok:false)' }
    return { ok: false, note: 'expected error or data.ok===false' }
  }

  if (style === 'empty_array') {
    if (Array.isArray(data) && data.length === 0) return { ok: true, note: 'deny (empty array)' }
    return { ok: false, note: 'expected error or empty array' }
  }

  if (style === 'parrainage_anomaly_safe') {
    const keys = ['cycles', 'mismatched_l1', 'self_referrals', 'duplicate_upline', 'orphan_commissions']
    if (
      data
      && typeof data === 'object'
      && keys.every((k) => Array.isArray(data[k]) && data[k].length === 0)
    ) {
      return { ok: true, note: 'deny (empty anomaly arrays)' }
    }
    return { ok: false, note: 'expected error or empty anomaly report' }
  }

  if (style === 'strict') {
    return { ok: false, note: 'expected PostgREST/Postgres error for this role' }
  }

  return { ok: false, note: `unknown denyStyle: ${style}` }
}

function evaluateAllow(error) {
  if (error) return { ok: false, note: error.message || String(error) }
  return { ok: true, note: 'allow' }
}

async function runProbe(client, row) {
  const args = substituteArgs(row)
  if (args === null) {
    return { skipped: true, reason: 'missing PROBE_FOREIGN_CLIENT_ID for cross-tenant probe' }
  }

  const { data, error } = await client.rpc(row.rpc, args)

  if (row.expect === 'deny') {
    const ev = denySatisfied(row, data, error)
    if (!ev.ok) {
      return {
        ok: false,
        detail: `${ev.note}; data=${JSON.stringify(data)?.slice(0, 400)}`,
      }
    }
    return { ok: true, detail: ev.note }
  }

  if (row.expect === 'allow') {
    const ev = evaluateAllow(error)
    if (!ev.ok) return { ok: false, detail: ev.note }
    return { ok: true, detail: 'allow' }
  }

  return { ok: true, detail: 'unknown expect' }
}

async function main() {
  const clients = {
    anon: makeClient(null),
    user_a: jwtA ? makeClient(jwtA) : null,
    user_b: jwtB ? makeClient(jwtB) : null,
  }

  if (!jwtA) {
    console.warn('[rls-rpc-probe] PROBE_JWT_USER_A not set — skipping user_a probes.\n')
  }

  let failed = 0
  let skipped = 0
  let passed = 0

  for (const row of PROBE_MATRIX) {
    if (row.expect === 'skip') {
      skipped += 1
      continue
    }

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

    if (result.ok) {
      console.log(`[ok]   ${row.id} (${row.rpc}) ${result.detail || ''}`)
      passed += 1
    } else {
      console.error(`[FAIL] ${row.id} (${row.rpc}) ${result.detail}`)
      failed += 1
    }
  }

  console.log(
    `\n[rls-rpc-probe] done: ${passed} passed, ${failed} failed, ${skipped} skipped`,
  )

  if (failed > 0) {
    process.exit(1)
  }
}

main().catch((e) => {
  console.error('[rls-rpc-probe] fatal:', e)
  process.exit(1)
})

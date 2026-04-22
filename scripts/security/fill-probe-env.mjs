#!/usr/bin/env node
/**
 * Logs in with a test user (default: rls_probe_a@zitouna.test from 06_seed_dev.sql)
 * and prints PROBE_* env vars so table/RPC probes stop skipping.
 *
 * Usage:
 *   npm run security:fill-probe-env
 *
 * Optional env (or use defaults for seed users):
 *   PROBE_TEST_EMAIL     default: rls_probe_a@zitouna.test
 *   PROBE_TEST_PASSWORD  default: 123456
 *
 * Same Supabase URL/anon key as the app: VITE_SUPABASE_URL + VITE_SUPABASE_ANON_KEY
 */

import { readFileSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'
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

/** Matches database/06_seed_dev.sql deterministic client ids. */
function clientUuidFromSeedEmail(email) {
  const h = createHash('md5').update(email).digest('hex').slice(0, 12)
  const tier = email.startsWith('rls_probe_a') ? '8000' : email.startsWith('rls_probe_b') ? '8001' : null
  if (!tier) return null
  return `d0000000-0000-4000-${tier}-${h}`
}

const DEFAULT_EMAIL = 'rls_probe_a@zitouna.test'
const DEFAULT_PASSWORD = '123456'
const FOREIGN_EMAIL = 'rls_probe_b@zitouna.test'

async function main() {
  const url = env('VITE_SUPABASE_URL', 'PROBE_SUPABASE_URL', 'SUPABASE_URL')
  const anonKey = env('VITE_SUPABASE_ANON_KEY', 'PROBE_SUPABASE_ANON_KEY', 'SUPABASE_ANON_KEY')
  const email = env('PROBE_TEST_EMAIL') || DEFAULT_EMAIL
  const password = env('PROBE_TEST_PASSWORD') || DEFAULT_PASSWORD

  if (!url || !anonKey) {
    console.error('Missing VITE_SUPABASE_URL or VITE_SUPABASE_ANON_KEY in .env.local')
    process.exit(1)
  }

  const sb = createClient(url, anonKey)
  const { data: auth, error: authErr } = await sb.auth.signInWithPassword({ email, password })
  if (authErr || !auth.session?.access_token) {
    console.error('[fill-probe-env] Login failed:', authErr?.message || 'no session')
    console.error('  Use a user that exists on this project (e.g. run database/06_seed_dev.sql on local DB).')
    process.exit(1)
  }

  const token = auth.session.access_token
  const userSb = createClient(url, anonKey, {
    global: { headers: { Authorization: `Bearer ${token}` } },
  })

  const { data: meRows, error: meErr } = await userSb.from('clients').select('id').eq('auth_user_id', auth.user.id).maybeSingle()
  if (meErr) {
    console.error('[fill-probe-env] clients lookup:', meErr.message)
    process.exit(1)
  }
  const ownClientId = meRows?.id || clientUuidFromSeedEmail(email)
  if (!ownClientId) {
    console.error('[fill-probe-env] Could not resolve client id for', email)
    process.exit(1)
  }

  const foreignId = email.startsWith('rls_probe_a') ? clientUuidFromSeedEmail(FOREIGN_EMAIL) : clientUuidFromSeedEmail(DEFAULT_EMAIL)

  let paymentId = ''
  const { data: plans } = await userSb.from('installment_plans').select('id').eq('client_id', ownClientId).limit(5)
  const planIds = (plans || []).map((p) => p.id)
  if (planIds.length) {
    const { data: pays } = await userSb
      .from('installment_payments')
      .select('id')
      .in('plan_id', planIds)
      .eq('status', 'pending')
      .limit(1)
    if (pays?.length) paymentId = pays[0].id
  }

  console.log('\n# Copy into PowerShell (current session):\n')
  console.log(`$env:PROBE_JWT_USER_A="${token}"`)
  console.log(`$env:PROBE_FOREIGN_CLIENT_ID="${foreignId}"`)
  if (paymentId) {
    console.log(`$env:PROBE_OWN_PAYMENT_ID="${paymentId}"`)
  } else {
    console.log(`# $env:PROBE_OWN_PAYMENT_ID="..."  # run database/dev/probe_installment_for_rls_probe_a.sql first`)
  }

  console.log('\n# Or bash:\n')
  console.log(`export PROBE_JWT_USER_A='${token}'`)
  console.log(`export PROBE_FOREIGN_CLIENT_ID='${foreignId}'`)
  if (paymentId) {
    console.log(`export PROBE_OWN_PAYMENT_ID='${paymentId}'`)
  } else {
    console.log(`# export PROBE_OWN_PAYMENT_ID='...'  # after SQL seed payment`)
  }

  console.log('\n# Then run:')
  console.log('npm run security:probe-all\n')

  if (!paymentId) {
    console.log(
      '[fill-probe-env] No pending installment_payments row for this user.\n'
        + '  Apply database/dev/probe_installment_for_rls_probe_a.sql in the SQL editor, then re-run this script.\n',
    )
  }
}

main().catch((e) => {
  console.error('[fill-probe-env] fatal:', e)
  process.exit(1)
})

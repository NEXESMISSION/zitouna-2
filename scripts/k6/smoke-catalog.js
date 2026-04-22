/**
 * Phase F — minimal k6 baseline (public catalog only, no login).
 *
 * Install: https://k6.io/docs/get-started/installation/
 * Run:
 *   k6 run --vus 10 --duration 30s scripts/k6/smoke-catalog.js
 *
 * Set env for your staging project:
 *   K6_SUPABASE_URL=https://xxx.supabase.co
 *   K6_SUPABASE_ANON_KEY=eyJ...
 *
 * Uses raw HTTP to PostgREST (same as the browser) so you measure REST + RLS,
 * not the Vercel SPA shell.
 */

import http from 'k6/http'
import { check, sleep } from 'k6'

const url = __ENV.K6_SUPABASE_URL || ''
const key = __ENV.K6_SUPABASE_ANON_KEY || ''

export const options = {
  thresholds: {
    http_req_failed: ['rate<0.05'],
    http_req_duration: ['p(95)<5000'],
  },
}

export default function () {
  if (!url || !key) {
    console.error('Set K6_SUPABASE_URL and K6_SUPABASE_ANON_KEY')
    return
  }
  const res = http.get(
    `${url}/rest/v1/projects?select=id,title&limit=5`,
    {
      headers: {
        apikey: key,
        Authorization: `Bearer ${key}`,
        Accept: 'application/json',
      },
    },
  )
  check(res, {
    'status 200': (r) => r.status === 200,
    'has json': (r) => r.body && r.body.length > 2,
  })
  sleep(0.3)
}

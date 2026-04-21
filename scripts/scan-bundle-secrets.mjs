#!/usr/bin/env node
/**
 * Scans Vite output under dist/ for accidental secret leakage.
 * Run after `npm run build` (see npm script `scan:bundle`).
 *
 * Flags:
 *   - JWT payloads whose `role` is `service_role` (Supabase service key)
 *   - Literal high-risk strings (service role labels, Stripe secret prefix, etc.)
 *
 * The public anon key is a JWT and may appear — that is expected; we only
 * fail on service_role in decoded payloads or forbidden literals.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const root = join(__dirname, '..')
const distDir = join(root, 'dist')

const JWT_RE = /\b(eyJ[A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)\b/g

const LITERAL_DENY = [
  { re: /SUPABASE_SERVICE_ROLE_KEY|SERVICE_ROLE_KEY|sb_secret_[a-z0-9_]+/i, msg: 'service role env name pattern' },
  { re: /\bsk_live_[0-9a-zA-Z]{20,}/, msg: 'Stripe secret key pattern (sk_live_)' },
  { re: /\bxox[baprs]-[0-9]{10,}-[0-9]{10,}-[a-zA-Z0-9]{20,}/, msg: 'Slack token pattern' },
]

function decodeJwtPayload(segment) {
  let s = segment.replace(/-/g, '+').replace(/_/g, '/')
  const pad = 4 - (s.length % 4)
  if (pad !== 4) s += '='.repeat(pad)
  const json = Buffer.from(s, 'base64').toString('utf8')
  return JSON.parse(json)
}

function walkJsFiles(dir) {
  const out = []
  let entries
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return out
  }
  for (const e of entries) {
    const p = join(dir, e.name)
    if (e.isDirectory()) out.push(...walkJsFiles(p))
    else if (e.isFile() && /\.(js|mjs|css)$/i.test(e.name)) out.push(p)
  }
  return out
}

function main() {
  let st
  try {
    st = statSync(distDir)
  } catch {
    console.error('[scan-bundle-secrets] dist/ not found. Run `npm run build` first.')
    process.exit(1)
  }
  if (!st.isDirectory()) {
    console.error('[scan-bundle-secrets] dist is not a directory.')
    process.exit(1)
  }

  const files = walkJsFiles(distDir)
  if (!files.length) {
    console.error('[scan-bundle-secrets] No .js/.css files under dist/. Run `npm run build`.')
    process.exit(1)
  }

  const findings = []

  for (const file of files) {
    const content = readFileSync(file, 'utf8')
    const rel = file.slice(root.length + 1)

    for (const { re, msg } of LITERAL_DENY) {
      if (re.test(content)) {
        findings.push({ file: rel, kind: 'literal', detail: msg })
      }
    }

    let m
    JWT_RE.lastIndex = 0
    while ((m = JWT_RE.exec(content)) !== null) {
      try {
        const payload = decodeJwtPayload(m[2])
        if (payload && (payload.role === 'service_role' || payload.role === 'supabase_admin')) {
          findings.push({
            file: rel,
            kind: 'jwt',
            detail: `JWT payload role=${JSON.stringify(payload.role)} (service key material)`,
          })
        }
      } catch {
        /* not a JWT we care about */
      }
    }
  }

  if (findings.length) {
    console.error('[scan-bundle-secrets] FAILED — possible secrets in bundle:\n')
    for (const f of findings) {
      console.error(`  ${f.file}  (${f.kind}) ${f.detail}`)
    }
    console.error('\nRemove secrets from client bundle; use anon key + RLS only on the frontend.')
    process.exit(1)
  }

  console.log(`[scan-bundle-secrets] OK — scanned ${files.length} file(s) under dist/`)
}

main()

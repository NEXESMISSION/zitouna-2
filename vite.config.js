import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { execSync } from 'node:child_process'
import { writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { resolve, dirname } from 'node:path'

const devPort = Number(process.env.PORT || process.env.VITE_PORT || 3012)

// PLAN 05 §4: embed a build id into the bundle and emit it to /version.json
// so the running tab can poll for new deploys. Order of fallbacks:
//   1. `git rev-parse --short HEAD` — works on any dev machine with git.
//   2. `VERCEL_GIT_COMMIT_SHA` — set by Vercel CI even when git is not on PATH.
//   3. `Date.now()` — last-resort unique-enough value so comparisons still
//      produce "different" on each build.
function resolveBuildSha() {
  try {
    return execSync('git rev-parse --short HEAD', { stdio: ['ignore', 'pipe', 'ignore'] })
      .toString()
      .trim()
  } catch {
    /* fall through */
  }
  const vercelSha = process.env.VERCEL_GIT_COMMIT_SHA
  if (typeof vercelSha === 'string' && vercelSha.length > 0) {
    return vercelSha.slice(0, 7)
  }
  return String(Date.now())
}

const BUILD_SHA = resolveBuildSha()

// https://vite.dev/config/
export default defineConfig({
  plugins: [
    react(),
    {
      name: 'emit-version-json',
      apply: 'build',
      // Rollup's closeBundle fires once the dist/ directory is fully written.
      // Writing here guarantees the file lives alongside index.html and is
      // picked up by Vercel's static deploy.
      closeBundle() {
        try {
          const out = resolve('dist', 'version.json')
          const outDir = dirname(out)
          if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true })
          writeFileSync(out, JSON.stringify({ build: BUILD_SHA }) + '\n', 'utf8')
          // Lightweight visibility in CI logs.
          console.log(`[emit-version-json] wrote dist/version.json { build: "${BUILD_SHA}" }`)
        } catch (err) {
          console.warn('[emit-version-json] failed to write version.json', err)
        }
      },
    },
  ],
  define: {
    // PLAN 05 §4: accessible from client code as `__BUILD_SHA__`.
    __BUILD_SHA__: JSON.stringify(BUILD_SHA),
  },
  build: {
    rollupOptions: {
      output: {
        // RESEARCH 05 §15: without explicit chunk boundaries, the bundler's
        // automatic splitting can produce different hashes between builds
        // even when the underlying code didn't change. Pinning the big
        // vendors to stable chunk names means an unchanged library release
        // ships the same filename → CDN cache lives across deploys and
        // users with older tabs don't hit 404s on library chunks.
        // Rolldown (vite 8) wants manualChunks as a function.
        manualChunks: (id) => {
          if (!id.includes('node_modules')) return undefined
          if (/node_modules[\\/](react|react-dom|react-router|react-router-dom|scheduler)[\\/]/.test(id)) {
            return 'react-vendor'
          }
          if (/node_modules[\\/]@supabase[\\/]/.test(id)) {
            return 'supabase-vendor'
          }
          return undefined
        },
      },
    },
  },
  server: {
    host: 'localhost',
    port: devPort,
    strictPort: true,
    hmr: {
      host: 'localhost',
      port: devPort,
      clientPort: devPort,
      protocol: 'ws',
    },
  },
})

import { createClient } from '@supabase/supabase-js'

const url = String(import.meta.env?.VITE_SUPABASE_URL || '').trim()
const anonKey = String(import.meta.env?.VITE_SUPABASE_ANON_KEY || '').trim()

if (!url || !anonKey) {
  console.error(
    '[Zitouna] VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY must be set in .env',
  )
}

// GoTrue uses the Web Locks API by default. React Strict Mode (dev) mounts, unmounts, and
// remounts effects quickly, which can orphan a lock and cause timeouts / steal races that
// abort getUser() and trigger a forced sign-out. A no-op lock serializes only within this
// tab via the client’s internal queue; cross-tab refresh is still handled server-side.
const authLockSingleTab = async (_name, _acquireTimeout, fn) => fn()

export const supabase = createClient(url || 'https://placeholder.supabase.co', anonKey || 'placeholder', {
  auth: {
    persistSession: true,
    autoRefreshToken: true,
    detectSessionInUrl: true,
    lock: authLockSingleTab,
  },
})

import { createContext, useContext, useEffect } from 'react'

/**
 * Theme system — light only.
 *
 * The dark-green theme has been removed. `useTheme()` still exists so
 * existing call sites (`const { theme } = useTheme()`) keep working; it
 * now always returns `'light'`. `setTheme`/`toggleTheme` are no-ops.
 */

const VALUE = Object.freeze({
  theme: 'light',
  setTheme: () => {},
  toggleTheme: () => {},
})

const ThemeContext = createContext(VALUE)

function applyTheme() {
  if (typeof document === 'undefined') return
  // /admin routes keep their own data-theme="admin" canvas (ZADM
  // stylesheet targets that attribute). Everything else forces "light".
  const path = (typeof window !== 'undefined' && window.location?.pathname) || ''
  const theme = path.indexOf('/admin') === 0 ? 'admin' : 'light'
  const root = document.documentElement
  if (root) root.setAttribute('data-theme', theme)
  if (document.body) document.body.setAttribute('data-theme', theme)
}

export function ThemeProvider({ children }) {
  useEffect(() => {
    applyTheme()
    // Drop any legacy dark preference so a refresh can't resurrect it if
    // the bootstrap script ever runs before a future logic change.
    try { window.localStorage?.removeItem('zb_theme') } catch { /* ignore */ }
  }, [])

  return <ThemeContext.Provider value={VALUE}>{children}</ThemeContext.Provider>
}

export function useTheme() {
  return useContext(ThemeContext)
}

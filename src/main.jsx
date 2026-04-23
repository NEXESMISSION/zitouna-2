import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import './index.css'
// Plan 06 — shared skeleton shapes + reduced-motion / sr-only helpers.
// Loaded after index.css so .sk-* tokens override nothing, and before
// App.css so legacy .pub-sk / .sp-sk / .inv-sk cascade as they did.
import './styles/skeletons.css'
import './styles/accessibility.css'
// PWA + responsive shell: safe-area insets, touch targets, table overflow,
// mobile drawer/modal sizing, installed-app refinements. Loaded LAST so
// the safety-net rules win over any page CSS that forgot them.
import './styles/pwa-responsive.css'
// Light-mode overrides. Loaded last so `html[data-theme="light"]` rules win
// over all earlier dark-theme declarations. Does nothing when the user is in
// dark mode (the default).
import './styles/theme-light.css'
// Product decision: no skeleton / loader / shimmer animations anywhere.
// This file neutralizes every placeholder pattern in the app. Loaded
// LAST so its rules win over per-page skeleton styles. Delete this
// import to restore the original loading animations.
import './styles/no-loading.css'
// Parcelle Detail redesign — scoped under .ppv2.
import './pages/plot-page.css'
import App from './App.jsx'
import { AuthProvider } from './lib/AuthContext.jsx'
import { ThemeProvider } from './lib/ThemeContext.jsx'
import { registerServiceWorker } from './lib/registerServiceWorker.js'
import PullToRefresh from './components/PullToRefresh.jsx'

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <ThemeProvider>
      <AuthProvider>
        <BrowserRouter>
          <App />
          {/* App-level pull-to-refresh gesture. Self-gates to scrollY<=2 and
              no-modal-open so it can't fire inside a wizard or a confirm. */}
          <PullToRefresh />
        </BrowserRouter>
      </AuthProvider>
    </ThemeProvider>
  </StrictMode>,
)

// Kick off PWA service-worker registration after React has claimed the
// root. Dev-mode builds short-circuit inside this helper.
registerServiceWorker()

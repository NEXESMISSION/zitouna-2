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
import App from './App.jsx'
import { AuthProvider } from './lib/AuthContext.jsx'
import { registerServiceWorker } from './lib/registerServiceWorker.js'

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <AuthProvider>
      <BrowserRouter>
        <App />
      </BrowserRouter>
    </AuthProvider>
  </StrictMode>,
)

// Kick off PWA service-worker registration after React has claimed the
// root. Dev-mode builds short-circuit inside this helper.
registerServiceWorker()

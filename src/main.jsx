import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import './index.css'
// Plan 06 — shared skeleton shapes + reduced-motion / sr-only helpers.
// Loaded after index.css so .sk-* tokens override nothing, and before
// App.css so legacy .pub-sk / .sp-sk / .inv-sk cascade as they did.
import './styles/skeletons.css'
import './styles/accessibility.css'
import App from './App.jsx'
import { AuthProvider } from './lib/AuthContext.jsx'

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <AuthProvider>
      <BrowserRouter>
        <App />
      </BrowserRouter>
    </AuthProvider>
  </StrictMode>,
)

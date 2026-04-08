import { useEffect, useState } from 'react'
import { Routes, Route, Navigate } from 'react-router-dom'
import './App.css'
import LoginPage          from './pages/LoginPage.jsx'
import RegisterPage       from './pages/RegisterPage.jsx'
import ForgotPasswordPage from './pages/ForgotPasswordPage.jsx'
import BrowsePage         from './pages/BrowsePage.jsx'
import DashboardPage      from './pages/DashboardPage.jsx'
import ProjectPage        from './pages/ProjectPage.jsx'
import PlotPage           from './pages/PlotPage.jsx'
import { isSupabaseConfigured, supabase } from './lib/supabaseClient.js'

export default function App() {
  const [session, setSession] = useState(null)
  const [loading, setLoading] = useState(isSupabaseConfigured)

  useEffect(() => {
    if (!isSupabaseConfigured || !supabase) return

    let mounted = true

    supabase.auth.getSession()
      .then(({ data, error }) => {
        if (!mounted) return
        if (error) {
          console.error('Supabase session error:', error.message)
        }
        setSession(data?.session ?? null)
      })
      .catch((error) => {
        if (!mounted) return
        console.error('Supabase init failed:', error)
      })
      .finally(() => {
        if (!mounted) return
        setLoading(false)
      })

    const { data: listener } = supabase.auth.onAuthStateChange((_event, nextSession) => {
      setSession(nextSession ?? null)
    })

    return () => {
      mounted = false
      listener.subscription.unsubscribe()
    }
  }, [])

  if (loading) {
    return (
      <main className="screen screen--login">
        <div className="login-content" style={{ textAlign: 'center' }}>
          <p>Chargement...</p>
        </div>
      </main>
    )
  }

  return (
    <Routes>
      <Route path="/"                                element={session ? <Navigate to="/browse" replace /> : <LoginPage />} />
      <Route path="/register"                        element={session ? <Navigate to="/browse" replace /> : <RegisterPage />} />
      <Route path="/forgot-password"                 element={<ForgotPasswordPage />} />
      <Route path="/browse"                          element={session ? <BrowsePage /> : <Navigate to="/" replace />} />
      <Route path="/dashboard"                       element={session ? <DashboardPage /> : <Navigate to="/" replace />} />
      <Route path="/project/:id"                     element={session ? <ProjectPage /> : <Navigate to="/" replace />} />
      <Route path="/project/:projectId/plot/:plotId" element={session ? <PlotPage /> : <Navigate to="/" replace />} />
      <Route path="*"                                element={<Navigate to="/" replace />} />
    </Routes>
  )
}

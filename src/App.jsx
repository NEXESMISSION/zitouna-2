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
import { supabase } from './lib/supabaseClient.js'

export default function App() {
  const [session, setSession] = useState(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let mounted = true

    supabase.auth.getSession().then(({ data }) => {
      if (!mounted) return
      setSession(data.session ?? null)
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

  if (loading) return null

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

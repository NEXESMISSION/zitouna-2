import { useState, useEffect } from 'react'
import { Routes, Route, Navigate } from 'react-router-dom'
import './App.css'
import LoginPage          from './pages/LoginPage.jsx'
import RegisterPage       from './pages/RegisterPage.jsx'
import ForgotPasswordPage from './pages/ForgotPasswordPage.jsx'
import BrowsePage         from './pages/BrowsePage.jsx'
import DashboardPage      from './pages/DashboardPage.jsx'
import ProjectPage        from './pages/ProjectPage.jsx'
import PlotPage           from './pages/PlotPage.jsx'
import { supabase, isSupabaseConfigured } from './lib/supabase.js'

function PrivateRoute({ session, children }) {
  if (session === undefined) return null
  return session ? children : <Navigate to="/" replace />
}

export default function App() {
  const [session, setSession] = useState(undefined)

  useEffect(() => {
    if (!isSupabaseConfigured) {
      setSession(null)
      return
    }
    supabase.auth.getSession().then(({ data }) => {
      setSession(data.session ?? null)
    })
    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, s) => {
      setSession(s ?? null)
    })
    return () => subscription.unsubscribe()
  }, [])

  return (
    <Routes>
      <Route path="/"              element={<LoginPage />} />
      <Route path="/register"      element={<RegisterPage />} />
      <Route path="/forgot-password" element={<ForgotPasswordPage />} />

      <Route path="/dashboard" element={
        <PrivateRoute session={session}><DashboardPage /></PrivateRoute>
      } />
      <Route path="/browse" element={
        <PrivateRoute session={session}><BrowsePage /></PrivateRoute>
      } />
      <Route path="/project/:id" element={
        <PrivateRoute session={session}><ProjectPage /></PrivateRoute>
      } />
      <Route path="/project/:projectId/plot/:plotId" element={
        <PrivateRoute session={session}><PlotPage /></PrivateRoute>
      } />

      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  )
}

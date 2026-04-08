import { useEffect } from 'react'
import { Routes, Route, Navigate, useParams, useLocation } from 'react-router-dom'
import './App.css'
import LoginPage          from './pages/LoginPage.jsx'
import RegisterPage       from './pages/RegisterPage.jsx'
import ForgotPasswordPage from './pages/ForgotPasswordPage.jsx'
import ResetPasswordPage  from './pages/ResetPasswordPage.jsx'
import BrowsePage         from './pages/BrowsePage.jsx'
import DashboardPage      from './pages/DashboardPage.jsx'
import InstallmentsPage   from './pages/InstallmentsPage.jsx'
import ProjectPage        from './pages/ProjectPage.jsx'
import PlotPage           from './pages/PlotPage.jsx'
import PurchaseMandatPage from './pages/PurchaseMandatPage.jsx'
import VisitSuccessPage   from './pages/VisitSuccessPage.jsx'
import AdminDashboard     from './pages/AdminDashboard.jsx'
import TunisMapLandingPage from './pages/TunisMapLandingPage.jsx'

function LegacyMandatToVisiteRedirect() {
  const { id } = useParams()
  return <Navigate to={`/project/${id}/visite`} replace />
}

function ScrollToTopOnRouteChange() {
  const { pathname } = useLocation()

  useEffect(() => {
    window.scrollTo({ top: 0, left: 0, behavior: 'auto' })
  }, [pathname])

  return null
}

export default function App() {
  return (
    <>
      <ScrollToTopOnRouteChange />
      <Routes>
        <Route path="/"                                element={<BrowsePage />} />
        <Route path="/maps"                            element={<TunisMapLandingPage />} />
        <Route path="/login"                           element={<LoginPage />} />
        <Route path="/register"                        element={<RegisterPage />} />
        <Route path="/forgot-password"                 element={<ForgotPasswordPage />} />
        <Route path="/reset-password"                  element={<ResetPasswordPage />} />
        <Route path="/browse"                          element={<BrowsePage />} />
        <Route path="/dashboard"                       element={<DashboardPage />} />
        <Route path="/installments"                    element={<InstallmentsPage />} />
        <Route path="/project/:id"                     element={<ProjectPage />} />
        <Route path="/project/:id/visite"               element={<PurchaseMandatPage />} />
        <Route path="/project/:id/visite/success"       element={<VisitSuccessPage />} />
        <Route path="/project/:id/mandat"               element={<LegacyMandatToVisiteRedirect />} />
        <Route path="/project/:projectId/plot/:plotId" element={<PlotPage />} />
        <Route path="/owner"                           element={<Navigate to="/admin" replace />} />
        <Route path="/admin"                           element={<AdminDashboard />} />
        <Route path="*"                                element={<Navigate to="/browse" replace />} />
      </Routes>
    </>
  )
}

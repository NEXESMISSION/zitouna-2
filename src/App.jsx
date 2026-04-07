import { Routes, Route, Navigate } from 'react-router-dom'
import './App.css'
import LoginPage          from './pages/LoginPage.jsx'
import RegisterPage       from './pages/RegisterPage.jsx'
import ForgotPasswordPage from './pages/ForgotPasswordPage.jsx'
import BrowsePage         from './pages/BrowsePage.jsx'
import DashboardPage      from './pages/DashboardPage.jsx'
import ProjectPage        from './pages/ProjectPage.jsx'
import PlotPage           from './pages/PlotPage.jsx'

export default function App() {
  return (
    <Routes>
      <Route path="/"                                element={<LoginPage />} />
      <Route path="/register"                        element={<RegisterPage />} />
      <Route path="/forgot-password"                 element={<ForgotPasswordPage />} />
      <Route path="/browse"                          element={<BrowsePage />} />
      <Route path="/dashboard"                       element={<DashboardPage />} />
      <Route path="/project/:id"                     element={<ProjectPage />} />
      <Route path="/project/:projectId/plot/:plotId" element={<PlotPage />} />
      <Route path="*"                                element={<Navigate to="/" replace />} />
    </Routes>
  )
}

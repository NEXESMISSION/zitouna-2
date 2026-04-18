import { Suspense, lazy, useEffect } from 'react'
import { Routes, Route, Navigate, useParams, useLocation } from 'react-router-dom'
import AppErrorBoundary from './components/AppErrorBoundary.jsx'
import RequireCustomerAuth from './components/RequireCustomerAuth.jsx'
import RequireStaff from './components/RequireStaff.jsx'
import './App.css'

const LoginPage = lazy(() => import('./pages/LoginPage.jsx'))
const RegisterPage = lazy(() => import('./pages/RegisterPage.jsx'))
const ForgotPasswordPage = lazy(() => import('./pages/ForgotPasswordPage.jsx'))
const ResetPasswordPage = lazy(() => import('./pages/ResetPasswordPage.jsx'))
const BrowsePage = lazy(() => import('./pages/BrowsePage.jsx'))
const DashboardPage = lazy(() => import('./pages/DashboardPage.jsx'))
const InstallmentsPage = lazy(() => import('./pages/InstallmentsPage.jsx'))
const ProjectPage = lazy(() => import('./pages/ProjectPage.jsx'))
const PlotPage = lazy(() => import('./pages/PlotPage.jsx'))
const PurchaseMandatPage = lazy(() => import('./pages/PurchaseMandatPage.jsx'))
const VisitSuccessPage = lazy(() => import('./pages/VisitSuccessPage.jsx'))
const ReferralInvitePage = lazy(() => import('./pages/ReferralInvitePage.jsx'))

const AdminLayout = lazy(() => import('./admin/AdminLayout.jsx'))
const ProjectsPage = lazy(() => import('./admin/pages/ProjectsPage.jsx'))
const ProjectDetailPage = lazy(() => import('./admin/pages/ProjectDetailPage.jsx'))
const SellPage = lazy(() => import('./admin/pages/SellPage.jsx'))
const CashSalesPage = lazy(() => import('./admin/pages/CashSalesPage.jsx'))
const ClientsPage = lazy(() => import('./admin/pages/ClientsPage.jsx'))
const ClientProfilePage = lazy(() => import('./admin/pages/ClientProfilePage.jsx'))
const AuditLogPage = lazy(() => import('./admin/pages/AuditLogPage.jsx'))
const UserManagementPage = lazy(() => import('./admin/pages/UserManagementPage.jsx'))
const FinanceDashboardPage = lazy(() => import('./admin/pages/FinanceDashboardPage.jsx'))
const ReferralCommissionSettingsPage = lazy(() => import('./admin/pages/ReferralCommissionSettingsPage.jsx'))
const NotaryDashboardPage = lazy(() => import('./admin/pages/NotaryDashboardPage.jsx'))
const RecouvrementPage = lazy(() => import('./admin/pages/RecouvrementPage.jsx'))
const CoordinationPage = lazy(() => import('./admin/pages/CoordinationPage.jsx'))
const ServiceJuridiquePage = lazy(() => import('./admin/pages/ServiceJuridiquePage.jsx'))
const AdminProfilePage = lazy(() => import('./admin/pages/AdminProfilePage.jsx'))
const CallCenterPage = lazy(() => import('./admin/pages/CallCenterPage.jsx'))
const CallCenterCalendarPage = lazy(() => import('./admin/pages/CallCenterCalendarPage.jsx'))
const CommercialCalendarPage = lazy(() => import('./admin/pages/CommercialCalendarPage.jsx'))
const AccessGrantsPage = lazy(() => import('./admin/pages/AccessGrantsPage.jsx'))
const CommissionLedgerPage = lazy(() => import('./admin/pages/CommissionLedgerPage.jsx'))
const ClientLinkRepairPage = lazy(() => import('./admin/pages/ClientLinkRepairPage.jsx'))
const CommissionAnomaliesPage = lazy(() => import('./admin/pages/CommissionAnomaliesPage.jsx'))
const CommissionAnalyticsPage = lazy(() => import('./admin/pages/CommissionAnalyticsPage.jsx'))
import CommissionTrackerPage from './admin/pages/CommissionTrackerPage.jsx'

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
    <AppErrorBoundary>
      <ScrollToTopOnRouteChange />
      <Suspense fallback={<div className="app-loader"><div className="app-loader-spinner" /></div>}>
      <Routes>
        {/* Public routes */}
        <Route path="/"                                element={<BrowsePage />} />
        <Route path="/browse"                          element={<BrowsePage />} />
        <Route path="/project/:id"                     element={<ProjectPage />} />
        <Route path="/project/:projectId/plot/:plotId" element={<PlotPage />} />
        <Route path="/project/:id/mandat"              element={<LegacyMandatToVisiteRedirect />} />
        <Route path="/owner"                           element={<Navigate to="/browse" replace />} />
        <Route path="/ref/:code"                       element={<ReferralInvitePage />} />

        {/* Auth pages (no guard, just UI) */}
        <Route path="/login"            element={<LoginPage />} />
        <Route path="/register"         element={<RegisterPage />} />
        <Route path="/forgot-password"  element={<ForgotPasswordPage />} />
        <Route path="/reset-password"   element={<ResetPasswordPage />} />

        {/* Customer portfolio (auth required when Supabase is configured) */}
        <Route path="/dashboard"    element={<RequireCustomerAuth><DashboardPage /></RequireCustomerAuth>} />
        <Route path="/installments" element={<RequireCustomerAuth><InstallmentsPage /></RequireCustomerAuth>} />
        <Route path="/project/:id/visite"         element={<PurchaseMandatPage />} />
        <Route path="/project/:id/visite/success" element={<VisitSuccessPage />} />

        {/* Admin (no auth required now) */}
        <Route path="/admin" element={<RequireStaff><AdminLayout /></RequireStaff>}>
          <Route index element={<AdminProfilePage />} />
          <Route path="dashboard"            element={<AdminProfilePage />} />
          <Route path="profile"              element={<AdminProfilePage />} />
          <Route path="projects"             element={<ProjectsPage />} />
          <Route path="projects/:projectId"  element={<ProjectDetailPage />} />
          <Route path="clients"              element={<ClientsPage />} />
          <Route path="clients/:clientId"    element={<ClientProfilePage />} />
          <Route path="finance"              element={<FinanceDashboardPage />} />
          <Route path="referral-settings"    element={<ReferralCommissionSettingsPage />} />
          <Route path="commission-ledger" element={<CommissionLedgerPage />} />
          <Route path="commissions" element={<CommissionTrackerPage />} />
          <Route path="commissions/analytics" element={<CommissionAnalyticsPage />} />
          <Route path="commissions/anomalies" element={<CommissionAnomaliesPage />} />
          <Route path="legal"                element={<NotaryDashboardPage />} />
          <Route path="coordination"         element={<CoordinationPage />} />
          <Route path="juridique"            element={<ServiceJuridiquePage />} />
          <Route path="recouvrement"         element={<RecouvrementPage />} />
          <Route path="users"                element={<UserManagementPage />} />
          <Route path="client-link-repair"   element={<ClientLinkRepairPage />} />
          <Route path="audit-log"            element={<AuditLogPage />} />
          <Route path="access-grants"       element={<AccessGrantsPage />} />
          <Route path="sell"                 element={<SellPage />} />
          <Route path="cash-sales"           element={<CashSalesPage />} />
          <Route path="call-center"          element={<CallCenterPage />} />
          <Route path="call-center-calendar" element={<CallCenterCalendarPage />} />
          <Route path="commercial-calendar"  element={<CommercialCalendarPage />} />
        </Route>

        <Route path="*" element={<Navigate to="/browse" replace />} />
      </Routes>
      </Suspense>
    </AppErrorBoundary>
  )
}

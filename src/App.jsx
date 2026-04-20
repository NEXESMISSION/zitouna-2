import { Suspense, useEffect } from 'react'
import { Routes, Route, Navigate, useParams, useLocation } from 'react-router-dom'
import AppErrorBoundary from './components/AppErrorBoundary.jsx'
import ChunkErrorBoundary from './components/ChunkErrorBoundary.jsx'
import RequireCustomerAuth from './components/RequireCustomerAuth.jsx'
import RequireStaff from './components/RequireStaff.jsx'
import NotificationToaster from './components/NotificationToaster.jsx'
import VersionBanner from './components/VersionBanner.jsx'
import lazyWithRetry, { clearChunkReloadFlag } from './lib/lazyWithRetry.js'
import './App.css'

const LoginPage = lazyWithRetry(() => import('./pages/LoginPage.jsx'))
const RegisterPage = lazyWithRetry(() => import('./pages/RegisterPage.jsx'))
const ForgotPasswordPage = lazyWithRetry(() => import('./pages/ForgotPasswordPage.jsx'))
const ResetPasswordPage = lazyWithRetry(() => import('./pages/ResetPasswordPage.jsx'))
const BrowsePage = lazyWithRetry(() => import('./pages/BrowsePage.jsx'))
const DashboardPage = lazyWithRetry(() => import('./pages/DashboardPage.jsx'))
const InstallmentsPage = lazyWithRetry(() => import('./pages/InstallmentsPage.jsx'))
const ProjectPage = lazyWithRetry(() => import('./pages/ProjectPage.jsx'))
const PlotPage = lazyWithRetry(() => import('./pages/PlotPage.jsx'))
const PurchaseMandatPage = lazyWithRetry(() => import('./pages/PurchaseMandatPage.jsx'))
const VisitSuccessPage = lazyWithRetry(() => import('./pages/VisitSuccessPage.jsx'))
const ReferralInvitePage = lazyWithRetry(() => import('./pages/ReferralInvitePage.jsx'))

const AdminLayout = lazyWithRetry(() => import('./admin/AdminLayout.jsx'))
const ProjectsPage = lazyWithRetry(() => import('./admin/pages/ProjectsPage.jsx'))
const ProjectDetailPage = lazyWithRetry(() => import('./admin/pages/ProjectDetailPage.jsx'))
const SellPage = lazyWithRetry(() => import('./admin/pages/SellPage.jsx'))
const CashSalesPage = lazyWithRetry(() => import('./admin/pages/CashSalesPage.jsx'))
const ClientsPage = lazyWithRetry(() => import('./admin/pages/ClientsPage.jsx'))
const ClientProfilePage = lazyWithRetry(() => import('./admin/pages/ClientProfilePage.jsx'))
const AuditLogPage = lazyWithRetry(() => import('./admin/pages/AuditLogPage.jsx'))
const UserManagementPage = lazyWithRetry(() => import('./admin/pages/UserManagementPage.jsx'))
const FinanceDashboardPage = lazyWithRetry(() => import('./admin/pages/FinanceDashboardPage.jsx'))
const NotaryDashboardPage = lazyWithRetry(() => import('./admin/pages/NotaryDashboardPage.jsx'))
const RecouvrementPage = lazyWithRetry(() => import('./admin/pages/RecouvrementPage.jsx'))
const RecouvrementV2Page = lazyWithRetry(() => import('./admin/pages/RecouvrementV2Page.jsx'))
const CoordinationPage = lazyWithRetry(() => import('./admin/pages/CoordinationPage.jsx'))
const ServiceJuridiquePage = lazyWithRetry(() => import('./admin/pages/ServiceJuridiquePage.jsx'))
const AdminProfilePage = lazyWithRetry(() => import('./admin/pages/AdminProfilePage.jsx'))
const CallCenterPage = lazyWithRetry(() => import('./admin/pages/CallCenterPage.jsx'))
const CallCenterCalendarPage = lazyWithRetry(() => import('./admin/pages/CallCenterCalendarPage.jsx'))
const CommercialCalendarPage = lazyWithRetry(() => import('./admin/pages/CommercialCalendarPage.jsx'))
const CommissionLedgerPage = lazyWithRetry(() => import('./admin/pages/CommissionLedgerPage.jsx'))
const ClientLinkRepairPage = lazyWithRetry(() => import('./admin/pages/ClientLinkRepairPage.jsx'))
const CommissionAnomaliesPage = lazyWithRetry(() => import('./admin/pages/CommissionAnomaliesPage.jsx'))
const CommissionAnalyticsPage = lazyWithRetry(() => import('./admin/pages/CommissionAnalyticsPage.jsx'))
const DangerZonePage = lazyWithRetry(() => import('./admin/pages/DangerZonePage.jsx'))
// RESEARCH 05 §5: was eagerly imported — now lazy, consistent with the rest.
const CommissionTrackerPage = lazyWithRetry(() => import('./admin/pages/CommissionTrackerPage.jsx'))

function LegacyMandatToVisiteRedirect() {
  const { id } = useParams()
  return <Navigate to={`/project/${id}/visite`} replace />
}

function ScrollToTopOnRouteChange() {
  const { pathname } = useLocation()

  useEffect(() => {
    window.scrollTo({ top: 0, left: 0, behavior: 'auto' })
    // PLAN 05 §1 optional polish: clear the one-shot hard-reload flag on each
    // successful navigation. Any route change that reached here means the
    // chunk for the new route loaded, so lazyWithRetry is free to spend its
    // reload budget again if a *different* deploy later invalidates another
    // chunk during the same session.
    try { clearChunkReloadFlag() } catch { /* ignore */ }
  }, [pathname])

  return null
}

export default function App() {
  return (
    <AppErrorBoundary>
      <ScrollToTopOnRouteChange />
      <NotificationToaster />
      <VersionBanner />
      <ChunkErrorBoundary>
      <Suspense
        fallback={
          <>
            {/* Plan 06 §10 — three distinct global loader variants.
                Route-level lazy chunks use the subtle top progress bar so
                users see the chrome stay intact while the code fetches,
                not a full-screen spinner. CSS lives in styles/skeletons.css
                (.app-loader--chunk / .app-loader--chunk__bar). */}
            <div
              className="app-loader--chunk"
              role="progressbar"
              aria-busy="true"
              aria-label="Chargement de la page…"
            >
              <div className="app-loader--chunk__bar" />
            </div>
            <div className="app-loader" data-fallback="suspense" aria-hidden="true" />
          </>
        }
      >
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
          <Route path="commission-ledger" element={<CommissionLedgerPage />} />
          <Route path="commissions" element={<CommissionTrackerPage />} />
          <Route path="commissions/analytics" element={<CommissionAnalyticsPage />} />
          <Route path="commissions/anomalies" element={<CommissionAnomaliesPage />} />
          <Route path="legal"                element={<NotaryDashboardPage />} />
          <Route path="coordination"         element={<CoordinationPage />} />
          <Route path="juridique"            element={<ServiceJuridiquePage />} />
          <Route path="recouvrement"         element={<RecouvrementPage />} />
          <Route path="recouvrement2"        element={<RecouvrementV2Page />} />
          <Route path="users"                element={<UserManagementPage />} />
          <Route path="client-link-repair"   element={<ClientLinkRepairPage />} />
          <Route path="audit-log"            element={<AuditLogPage />} />
          <Route path="sell"                 element={<SellPage />} />
          <Route path="cash-sales"           element={<CashSalesPage />} />
          <Route path="call-center"          element={<CallCenterPage />} />
          <Route path="call-center-calendar" element={<CallCenterCalendarPage />} />
          <Route path="commercial-calendar"  element={<CommercialCalendarPage />} />
          <Route path="danger-zone"          element={<DangerZonePage />} />
        </Route>

        <Route path="*" element={<Navigate to="/browse" replace />} />
      </Routes>
      </Suspense>
      </ChunkErrorBoundary>
    </AppErrorBoundary>
  )
}

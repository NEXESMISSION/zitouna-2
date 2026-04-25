import { Suspense, useEffect } from 'react'
import { Routes, Route, Navigate, useLocation } from 'react-router-dom'
import AppErrorBoundary from './components/AppErrorBoundary.jsx'
import ChunkErrorBoundary from './components/ChunkErrorBoundary.jsx'
import RequireCustomerAuth from './components/RequireCustomerAuth.jsx'
import RequireStaff from './components/RequireStaff.jsx'
import NotificationToaster from './components/NotificationToaster.jsx'
import VersionBanner from './components/VersionBanner.jsx'
import lazyWithRetry, { clearChunkReloadFlag } from './lib/lazyWithRetry.js'
import { registerRoutePreloader } from './lib/routePreload.js'
import { useAuth } from './lib/AuthContext.jsx'
import './App.css'

const LoginPage = lazyWithRetry(() => import('./pages/LoginPage.jsx'))
const RegisterPage = lazyWithRetry(() => import('./pages/RegisterPage.jsx'))
const ForgotPasswordPage = lazyWithRetry(() => import('./pages/ForgotPasswordPage.jsx'))
const ResetPasswordPage = lazyWithRetry(() => import('./pages/ResetPasswordPage.jsx'))
const BrowsePage = lazyWithRetry(() => import('./pages/BrowsePage.jsx'))
const DashboardPage = lazyWithRetry(() => import('./pages/DashboardPage.jsx'))
const InstallmentsPage = lazyWithRetry(() => import('./pages/InstallmentsPage.jsx'))
const MyCommissionsPage = lazyWithRetry(() => import('./pages/MyCommissionsPage.jsx'))
const MyPayoutPage = lazyWithRetry(() => import('./pages/MyPayoutPage.jsx'))
const MyActivityPage = lazyWithRetry(() => import('./pages/MyActivityPage.jsx'))
const MyParcellesPage = lazyWithRetry(() => import('./pages/MyParcellesPage.jsx'))
const MyTreePage = lazyWithRetry(() => import('./pages/MyTreePage.jsx'))
const MyHarvestsPage = lazyWithRetry(() => import('./pages/MyHarvestsPage.jsx'))
const MyProfilePage = lazyWithRetry(() => import('./pages/MyProfilePage.jsx'))
const HubPage = lazyWithRetry(() => import('./pages/HubPage.jsx'))
const ProjectPage = lazyWithRetry(() => import('./pages/ProjectPage.jsx'))
const PlotPage = lazyWithRetry(() => import('./pages/PlotPage.jsx'))
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
const CommissionsShell = lazyWithRetry(() => import('./admin/components/commissions/CommissionsShell.jsx'))
const ClientLinkRepairPage = lazyWithRetry(() => import('./admin/pages/ClientLinkRepairPage.jsx'))
const PhoneChangesPage = lazyWithRetry(() => import('./admin/pages/PhoneChangesPage.jsx'))
const CommissionAnomaliesPage = lazyWithRetry(() => import('./admin/pages/CommissionAnomaliesPage.jsx'))
const CommissionAnalyticsPage = lazyWithRetry(() => import('./admin/pages/CommissionAnalyticsPage.jsx'))
const ReverseGrantsPage = lazyWithRetry(() => import('./admin/pages/ReverseGrantsPage.jsx'))
const DangerZonePage = lazyWithRetry(() => import('./admin/pages/DangerZonePage.jsx'))
// RESEARCH 05 §5: was eagerly imported — now lazy, consistent with the rest.
const CommissionTrackerPage = lazyWithRetry(() => import('./admin/pages/CommissionTrackerPage.jsx'))
const DistributionsPage = lazyWithRetry(() => import('./admin/pages/DistributionsPage.jsx'))
const RetraitsPage = lazyWithRetry(() => import('./admin/pages/RetraitsPage.jsx'))

// Wire each lazy component into the preload registry so nav surfaces can
// warm the chunk on hover/focus/idle. When the user finally clicks, the
// module is already cached — Suspense resolves without flashing a fallback.
const PRELOAD_PAIRS = [
  ['/admin/projects', ProjectsPage],
  ['/admin/sell', SellPage],
  ['/admin/cash-sales', CashSalesPage],
  ['/admin/clients', ClientsPage],
  ['/admin/audit-log', AuditLogPage],
  ['/admin/users', UserManagementPage],
  ['/admin/finance', FinanceDashboardPage],
  ['/admin/legal', NotaryDashboardPage],
  ['/admin/recouvrement', RecouvrementPage],
  ['/admin/recouvrement2', RecouvrementV2Page],
  ['/admin/coordination', CoordinationPage],
  ['/admin/juridique', ServiceJuridiquePage],
  ['/admin/call-center', CallCenterPage],
  ['/admin/call-center/calendar', CallCenterCalendarPage],
  ['/admin/commercial-calendar', CommercialCalendarPage],
  ['/admin/commissions', CommissionTrackerPage],
  ['/admin/commissions/ledger', CommissionLedgerPage],
  ['/admin/commissions/analytics', CommissionAnalyticsPage],
  ['/admin/commissions/reverse-grants', ReverseGrantsPage],
  ['/admin/commissions/anomalies', CommissionAnomaliesPage],
  ['/admin/distributions', DistributionsPage],
  ['/admin/retraits', RetraitsPage],
  ['/admin/client-link-repair', ClientLinkRepairPage],
]
for (const [path, Comp] of PRELOAD_PAIRS) {
  if (typeof Comp?.preload === 'function') registerRoutePreloader(path, Comp.preload)
}

// Landing behavior for "/": logged-in clients land on their dashboard
// (their home), guests see the public browse page. While auth is still
// bootstrapping we keep the page blank — Suspense fallback has already
// rendered the skeleton, re-rendering here would just flash.
function RootLanding() {
  const { ready } = useAuth()
  if (!ready) return null
  // Everyone lands on /dashboard (incl. staff/admins). Admin area is
  // reachable from the sidebar for those who have access.
  return <Navigate to="/dashboard" replace />
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
            {/* Route-level Suspense fallback: top progress bar + a generic
                page-shaped skeleton so the switch doesn't flash a blank
                screen. When chunks are preloaded (see preloadRoute()) the
                fallback usually never appears. */}
            <div
              className="app-loader--chunk"
              role="progressbar"
              aria-busy="true"
              aria-label="Chargement de la page…"
            >
              <div className="app-loader--chunk__bar" />
            </div>
            <div className="app-loader--page" aria-hidden="true">
              <div className="app-loader--page__hero">
                <span className="sk sk-avatar sk-avatar--lg" />
                <div className="app-loader--page__hero-text">
                  <span className="sk sk-line sk-line--title" />
                  <span className="sk sk-line sk-line--sub" />
                </div>
              </div>
              <div className="app-loader--page__strip">
                {[0, 1, 2, 3].map((i) => (
                  <span key={i} className="sk sk-kpi" />
                ))}
              </div>
              <div className="app-loader--page__grid">
                {[0, 1, 2, 3, 4, 5].map((i) => (
                  <span key={i} className="sk sk-card sk-card--light" />
                ))}
              </div>
            </div>
          </>
        }
      >
      <Routes>
        {/* Public routes */}
        <Route path="/"                                element={<RootLanding />} />
        <Route path="/browse"                          element={<BrowsePage />} />
        <Route path="/project/:id"                     element={<ProjectPage />} />
        <Route path="/project/:projectId/plot/:plotId" element={<PlotPage />} />
        <Route path="/project/:id/mandat"              element={<Navigate to="/browse" replace />} />
        <Route path="/project/:id/visite"              element={<Navigate to="/browse" replace />} />
        <Route path="/project/:id/visite/success"      element={<Navigate to="/browse" replace />} />
        <Route path="/owner"                           element={<Navigate to="/browse" replace />} />
        <Route path="/ref/:code"                       element={<ReferralInvitePage />} />

        {/* Auth pages (no guard, just UI) */}
        <Route path="/login"            element={<LoginPage />} />
        <Route path="/register"         element={<RegisterPage />} />
        <Route path="/forgot-password"  element={<ForgotPasswordPage />} />
        <Route path="/reset-password"   element={<ResetPasswordPage />} />

        {/* Customer portfolio (auth required when Supabase is configured) */}
        <Route path="/dashboard"      element={<RequireCustomerAuth><DashboardPage /></RequireCustomerAuth>} />
        <Route path="/installments"   element={<RequireCustomerAuth><InstallmentsPage /></RequireCustomerAuth>} />
        <Route path="/my/commissions" element={<RequireCustomerAuth><MyCommissionsPage /></RequireCustomerAuth>} />
        <Route path="/my/payout"      element={<RequireCustomerAuth><MyPayoutPage /></RequireCustomerAuth>} />
        <Route path="/my/activity"    element={<RequireCustomerAuth><MyActivityPage /></RequireCustomerAuth>} />
        <Route path="/my/parcelles"   element={<RequireCustomerAuth><MyParcellesPage /></RequireCustomerAuth>} />
        <Route path="/my/tree"        element={<RequireCustomerAuth><MyTreePage /></RequireCustomerAuth>} />
        <Route path="/my/harvests"    element={<RequireCustomerAuth><MyHarvestsPage /></RequireCustomerAuth>} />
        <Route path="/my/profile"     element={<RequireCustomerAuth><MyProfilePage /></RequireCustomerAuth>} />
        <Route path="/hub"            element={<RequireCustomerAuth><HubPage /></RequireCustomerAuth>} />

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
          {/* Unified commissions shell: /admin/commissions/* with tabbed sub-routes.
              Legacy routes (/admin/commission-ledger, /admin/commissions/anomalies,
              /admin/commissions/analytics) are preserved and redirected below so
              bookmarks keep working. */}
          <Route path="commissions" element={<CommissionsShell />}>
            <Route index                 element={<CommissionTrackerPage />} />
            <Route path="network"        element={<Navigate to="/admin/commissions" replace />} />
            <Route path="ledger"         element={<CommissionLedgerPage />} />
            <Route path="analytics"      element={<CommissionAnalyticsPage />} />
            <Route path="reverse-grants" element={<ReverseGrantsPage />} />
            <Route path="anomalies"      element={<CommissionAnomaliesPage />} />
          </Route>
          <Route path="commission-ledger" element={<Navigate to="/admin/commissions/ledger" replace />} />
          <Route path="distributions"      element={<DistributionsPage />} />
          <Route path="retraits"           element={<RetraitsPage />} />
          <Route path="legal"                element={<NotaryDashboardPage />} />
          <Route path="coordination"         element={<CoordinationPage />} />
          <Route path="juridique"            element={<ServiceJuridiquePage />} />
          <Route path="recouvrement"         element={<RecouvrementPage />} />
          <Route path="recouvrement2"        element={<RecouvrementV2Page />} />
          <Route path="users"                element={<UserManagementPage />} />
          <Route path="client-link-repair"   element={<ClientLinkRepairPage />} />
          <Route path="phone-changes"        element={<PhoneChangesPage />} />
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

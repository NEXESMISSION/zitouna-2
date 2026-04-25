import { useMemo } from 'react'
import { useNavigate } from 'react-router-dom'
import DashboardShell from '../components/DashboardShell.jsx'
import { useAuth } from '../lib/AuthContext.jsx'
import { useMyCommissionLedger } from '../lib/useSupabase.js'
import MyReferralTreeGraph from '../components/MyReferralTreeGraph.jsx'
import { buildTree } from '../components/MyReferralTree.jsx'
import EmptyState from '../components/EmptyState.jsx'
import '../components/my-referral-tree.css'
import './dashboard-page.css'

/*
 * /my/tree — full-page referral tree viewer.
 *
 *   Previously the tree lived inside a modal overlay triggered from the
 *   commissions section of the dashboard. Here it gets its own page so
 *   the graph can use the whole viewport (pan + zoom + search).
 */

export default function MyTreePage() {
  const navigate = useNavigate()
  const { clientProfile, profileStatus, ready } = useAuth()

  const terminalProfileReason = profileStatus?.reason
  const profileResolutionFinalized =
    Boolean(terminalProfileReason) &&
    ['rpc_error', 'ambiguous_client_profile', 'phone_conflict', 'admin_no_buyer_profile', 'not_authenticated'].includes(
      terminalProfileReason,
    )
  const clientId =
    ready
      ? (clientProfile?.id || (profileResolutionFinalized ? '' : null))
      : null

  const { events: ledger, loading } = useMyCommissionLedger({
    clientId: clientId || null,
    enabled: Boolean(clientId),
  })

  const { root, totalNodes, totalEarnings } = useMemo(
    () => buildTree(clientId, ledger),
    [clientId, ledger],
  )

  const myName = clientProfile?.full_name || clientProfile?.name || 'Moi'
  const isEmpty = !clientId || root.length === 0

  return (
    <DashboardShell active="tree">
      <div className="zb-greeting">
        <h1 className="zb-greeting-h1">Mon arbre</h1>
        <p style={{ color: 'var(--zb-muted)', fontSize: 14, margin: '6px 0 0' }}>
          {isEmpty
            ? 'Réseau visible dès la 1re commission.'
            : `${totalNodes} membre${totalNodes > 1 ? 's' : ''} · ${Math.round(totalEarnings).toLocaleString('fr-FR')} TND`}
        </p>
      </div>

          {loading ? (
            <div
              className="zb-card zb-tree-sk"
              aria-busy="true"
              aria-live="polite"
            >
              <div className="zb-tree-sk-head">
                <div className="sk sk-line sk-line--title" style={{ width: '45%' }} />
                <div className="sk sk-line sk-line--sub" style={{ width: '30%' }} />
              </div>
              <div className="zb-tree-sk-body">
                <div className="zb-tree-sk-node zb-tree-sk-node--root">
                  <span className="sk sk-avatar sk-avatar--sm" />
                  <div className="sk sk-line" style={{ width: '55%' }} />
                </div>
                {[0, 1, 2].map((i) => (
                  <div key={i} className="zb-tree-sk-branch">
                    <div className="zb-tree-sk-node">
                      <span className="sk sk-avatar sk-avatar--sm" />
                      <div className="sk sk-line" style={{ width: `${60 - i * 6}%` }} />
                    </div>
                    <div className="zb-tree-sk-children">
                      {[0, 1].map((j) => (
                        <div key={j} className="zb-tree-sk-node zb-tree-sk-node--leaf">
                          <span className="sk sk-avatar sk-avatar--sm" />
                          <div className="sk sk-line" style={{ width: `${50 - j * 8}%` }} />
                        </div>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          ) : isEmpty ? (
            <div className="zb-card" style={{ padding: 40 }}>
              <EmptyState
                title="Aucun filleul pour le moment"
                description="Partagez votre code de parrainage."
                action={{ label: 'Retour', onClick: () => navigate('/my/commissions') }}
              />
            </div>
          ) : (
            <div
              className="zb-card"
              style={{
                padding: 0,
                overflow: 'hidden',
                height: 'min(78vh, 820px)',
                display: 'flex',
                flexDirection: 'column',
              }}
            >
              <MyReferralTreeGraph
                myClientId={clientId}
                myName={myName}
                root={root}
                totalNodes={totalNodes}
                totalEarnings={totalEarnings}
              />
            </div>
          )}
    </DashboardShell>
  )
}

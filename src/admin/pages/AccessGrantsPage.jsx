import { useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useAccessGrants, useClients } from '../../lib/useSupabase.js'
import { useAuth } from '../../lib/AuthContext.jsx'
import { useToast } from '../components/AdminToast.jsx'
import './zitouna-admin-page.css'

export default function AccessGrantsPage() {
  const navigate = useNavigate()
  const { adminUser } = useAuth()
  const { addToast } = useToast()
  const { clients } = useClients()
  const { accessGrants, grantAuditLog, revoke } = useAccessGrants()
  const [tab, setTab] = useState('active')

  const clientLabel = (id) => (clients || []).find((c) => String(c.id) === String(id))?.name || id

  const rows = useMemo(
    () =>
      (accessGrants || [])
        .filter((g) => !g.revokedAt)
        .sort((a, b) => String(b.grantedAt || '').localeCompare(String(a.grantedAt || ''))),
    [accessGrants],
  )

  const handleRevoke = async (g) => {
    if (!window.confirm(`Révoquer l’accès ${g.pageKey} pour le client ${g.clientId} ?`)) return
    const r = await revoke(g.id, adminUser?.id || null)
    if (!r?.ok) {
      addToast('Révocation impossible', 'error')
      return
    }
    addToast('Accès révoqué — le client perd cette page au prochain chargement de session.')
  }

  return (
    <div className="zitu-page" dir="ltr">
      <div className="zitu-page__column">
        <button type="button" className="ds-back-btn" onClick={() => navigate(-1)}>
          <span className="ds-back-btn__icon" aria-hidden>←</span>
          <span className="ds-back-btn__label">Back</span>
        </button>
        <header className="zitu-page__header">
          <div className="zitu-page__header-icon">A</div>
          <div className="zitu-page__header-text">
            <h1>Coffre des droits d acces</h1>
            <p>Attribution depuis la checklist notaire ou elevation admin, avec revocation manuelle et historique d audit.</p>
          </div>
        </header>

        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 12 }}>
          <button
            type="button"
            className={`zitu-page__btn zitu-page__btn--sm ${tab === 'active' ? 'zitu-page__btn--primary' : ''}`}
            onClick={() => setTab('active')}
          >
            Accès actifs ({rows.length})
          </button>
          <button
            type="button"
            className={`zitu-page__btn zitu-page__btn--sm ${tab === 'history' ? 'zitu-page__btn--primary' : ''}`}
            onClick={() => setTab('history')}
          >
            Historique audit ({(grantAuditLog || []).length})
          </button>
        </div>

        {tab === 'history' ? (
          (grantAuditLog || []).length === 0 ? (
            <div className="ds-empty">
              <strong className="ds-empty__title">Aucun enregistrement</strong>
              <p className="ds-empty__hint">Les octrois et révocations apparaîtront ici.</p>
            </div>
          ) : (
            <div className="zitu-page__card-list">
              {(grantAuditLog || []).map((g) => {
                const revoked = Boolean(g.revokedAt)
                return (
                  <div key={g.id} className="zitu-page__card zitu-page__card--static">
                    <div className="zitu-page__card-top">
                      <div>
                        <div className="zitu-page__card-name">{g.pageKey}</div>
                        <div className="zitu-page__card-meta">
                          {clientLabel(g.clientId)} · Vente {g.sourceSaleId || '—'} · règle {g.sourceChecklistKey || '—'}
                        </div>
                      </div>
                      <span
                        className="zitu-page__badge"
                        style={{
                          background: revoked ? '#fef2f2' : '#ecfdf5',
                          color: revoked ? '#b91c1c' : '#059669',
                        }}
                      >
                        {revoked ? 'Révoqué' : 'Actif'}
                      </span>
                    </div>
                    <div className="zitu-page__detail-row" style={{ border: 'none', paddingTop: 0 }}>
                      <span className="zitu-page__detail-label">Accordé</span>
                      <span className="zitu-page__detail-value">{g.grantedAt || '—'}</span>
                    </div>
                    {revoked ? (
                      <div className="zitu-page__detail-row" style={{ border: 'none' }}>
                        <span className="zitu-page__detail-label">Révoqué</span>
                        <span className="zitu-page__detail-value">{g.revokedAt || '—'}</span>
                      </div>
                    ) : null}
                  </div>
                )
              })}
            </div>
          )
        ) : null}

        {tab === 'active' && rows.length === 0 ? (
          <div className="ds-empty">
            <div className="ds-empty__icon" aria-hidden>
              —
            </div>
            <strong className="ds-empty__title">Aucun accès actif</strong>
            <p className="ds-empty__hint">Les accès apparaissent après complétion notaire avec règles projet.</p>
          </div>
        ) : null}

        {tab === 'active' && rows.length > 0 ? (
          <div className="zitu-page__card-list">
            {rows.map((g) => (
              <div key={g.id} className="zitu-page__card zitu-page__card--static">
                <div className="zitu-page__card-top">
                  <div>
                    <div className="zitu-page__card-name">{g.pageKey}</div>
                    <div className="zitu-page__card-meta">
                      {clientLabel(g.clientId)} · Vente {g.sourceSaleId || '—'} · {g.sourceChecklistKey || '—'}
                    </div>
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <span className="zitu-page__badge" style={{ background: '#ecfdf5', color: '#059669' }}>
                      Actif
                    </span>
                    <button type="button" className="zitu-page__btn zitu-page__btn--sm" onClick={() => handleRevoke(g)}>
                      Révoquer
                    </button>
                  </div>
                </div>
                <div className="zitu-page__detail-row" style={{ border: 'none', paddingTop: 0 }}>
                  <span className="zitu-page__detail-label">Accordé</span>
                  <span className="zitu-page__detail-value">{g.grantedAt || '—'}</span>
                </div>
              </div>
            ))}
          </div>
        ) : null}
      </div>
    </div>
  )
}

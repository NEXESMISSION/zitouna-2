import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useClients, useSales } from '../../lib/useSupabase.js'
import { useAuth } from '../../lib/AuthContext.jsx'
import * as db from '../../lib/db.js'
import SaleSnapshotTracePanel from '../components/SaleSnapshotTracePanel.jsx'
import './notary-dashboard.css'
import './zitouna-admin-page.css'

const DOC_KEY_FROM_WF = {
  contract: 'contract',
  cahier: 'cahier',
  seller_contract: 'sellerContract',
}

function fmtMoney(v) {
  return `${(Number(v) || 0).toLocaleString('fr-FR')} TND`
}

function fmtDate(iso) {
  if (!iso) return '—'
  try {
    return new Date(iso).toLocaleDateString('fr-FR', { day: '2-digit', month: 'short', year: 'numeric' })
  } catch {
    return String(iso)
  }
}

function normalizePlotIds(sale) {
  const ids = Array.isArray(sale?.plotIds)
    ? sale.plotIds
    : sale?.plotId != null
      ? [sale.plotId]
      : []
  return ids.map((x) => Number(x)).filter((n) => Number.isFinite(n))
}

function initials(name) {
  const parts = String(name || '').trim().split(/\s+/).filter(Boolean)
  if (parts.length === 0) return 'CL'
  return `${parts[0][0] || ''}${parts[1]?.[0] || ''}`.toUpperCase()
}

const DOC_ITEMS = [
  { key: 'contract', title: 'Contrat', desc: 'Contrat de vente principal' },
  { key: 'cahier', title: 'Cahier des charges', desc: 'Document des conditions legales' },
  { key: 'sellerContract', title: 'Contrat vendeur', desc: 'Contrat du vendeur/mandat (optionnel)' },
]

/** Lignes checklist pour l’UI notaire : snapshot vente si présent, sinon workflow projet. */
function checklistRowsForNotary(sale, projectWorkflows = {}) {
  const raw =
    sale?.checklistSnapshot?.items?.length
      ? sale.checklistSnapshot.items
      : projectWorkflows[sale?.projectId]?.signatureChecklist || []
  return raw.map((it) => {
    const docKey = DOC_KEY_FROM_WF[it.key] || it.key
    const meta = DOC_ITEMS.find((d) => d.key === docKey)
    return {
      docKey,
      title: it.label || meta?.title || it.key,
      desc: meta?.desc || '',
      required: Boolean(it.required),
      wfKey: it.key,
    }
  })
}

function requiredDocKeysFromRows(rows) {
  const req = rows.filter((r) => r.required).map((r) => r.docKey)
  return req.length ? req : ['contract', 'cahier']
}

export default function NotaryDashboardPage() {
  const navigate = useNavigate()
  const { adminUser } = useAuth()
  const { sales, update: updateSale } = useSales()
  const { clients } = useClients()
  const [query, setQuery] = useState('')
  const [selectedSale, setSelectedSale] = useState(null)
  const [docsBySale, setDocsBySale] = useState({})
  const [saving, setSaving] = useState(false)
  const [notice, setNotice] = useState('')
  const [warningNotice, setWarningNotice] = useState('')
  const [projectWorkflows, setProjectWorkflows] = useState({})
  const checklistDraftTimerRef = useRef(null)

  const pendingProjectIds = useMemo(() => {
    const ids = new Set()
    for (const s of sales || []) {
      // Dossiers appear here as soon as a sale exists (coordination) and later stay here (pending_legal).
      const st = String(s.status || '')
      if ((st === 'pending_coordination' || st === 'pending_finance' || st === 'pending_legal') && s.projectId) {
        ids.add(String(s.projectId))
      }
    }
    return [...ids]
  }, [sales])

  useEffect(() => {
    let cancelled = false
    async function load() {
      const result = {}
      for (const pid of pendingProjectIds) {
        if (projectWorkflows[pid]) { result[pid] = projectWorkflows[pid]; continue }
        try { result[pid] = await db.fetchProjectWorkflowConfig(pid) } catch { /* ignore */ }
      }
      if (!cancelled) setProjectWorkflows(prev => ({ ...prev, ...result }))
    }
    if (pendingProjectIds.length) load()
    return () => { cancelled = true }
  }, [pendingProjectIds])

  const dossiers = useMemo(() => {
    const q = query.trim().toLowerCase()
    return (sales || [])
      .filter((sale) => {
        const st = String(sale.status || '')
        return st === 'pending_coordination' || st === 'pending_finance' || st === 'pending_legal'
      })
      .filter((sale) => !q
        || String(sale.clientName || '').toLowerCase().includes(q)
        || String(sale.projectTitle || '').toLowerCase().includes(q)
        || String(sale.code || sale.id || '').toLowerCase().includes(q))
      .map((sale) => {
        const client = (clients || []).find((c) => String(c.id) === String(sale.clientId))
        const plotIds = normalizePlotIds(sale)
        const total = Number(sale.agreedPrice || sale.amount || 0)
        const deposit = Number(sale.deposit || sale.advancePaid || 0)
        const fee = sale.feeSnapshot || {}
        const cPct = Number(fee.companyFeePct ?? 5) / 100
        const nPct = Number(fee.notaryFeePct ?? 2) / 100
        const companyFee = Math.round(total * cPct)
        const notaryFee = Math.round(total * nPct)
        const remaining = Math.max(0, total - deposit)
        return {
          ...sale,
          client,
          plotIds,
          total,
          deposit,
          companyFee,
          notaryFee,
          remaining,
        }
      })
      .sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')))
  }, [sales, clients, query])

  const selectedDocs = selectedSale ? (docsBySale[selectedSale.id] || {}) : {}

  useEffect(() => {
    if (!selectedSale?.id) return
    const docKeys = selectedSale.notaryChecklistSigned?.docKeys
    if (!docKeys || typeof docKeys !== 'object') return
    setDocsBySale((prev) => {
      if (prev[selectedSale.id]) return prev
      return { ...prev, [selectedSale.id]: { ...docKeys } }
    })
  }, [selectedSale?.id, selectedSale?.notaryChecklistSigned])

  const persistNotaryChecklistDraft = useCallback((saleId, docMap, rows) => {
    if (!saleId || !adminUser?.id || !docMap || !rows?.length) return
    const docKeys = {}
    const wfKeys = {}
    for (const row of rows) {
      docKeys[row.docKey] = Boolean(docMap[row.docKey])
      wfKeys[row.wfKey] = Boolean(docMap[row.docKey])
    }
    const now = new Date().toISOString()
    db.updateSale(saleId, {
      notaryChecklistSigned: {
        docKeys,
        wfKeys,
        savedAt: now,
        savedBy: adminUser.id,
      },
    }).catch((e) => console.warn('notaryChecklistDraft save:', e?.message || e))
  }, [adminUser?.id])
  const readyCount = useMemo(
    () =>
      dossiers.filter((d) => {
        const rows = checklistRowsForNotary(d, projectWorkflows)
        const req = requiredDocKeysFromRows(rows)
        const docMap = docsBySale[d.id] || {}
        return req.every((k) => docMap[k])
      }).length,
    [dossiers, docsBySale],
  )

  const toggleDoc = (docKey) => {
    if (!selectedSale) return
    const rowsSnapshot = checklistRowsForNotary(selectedSale, projectWorkflows)
    setDocsBySale((prev) => {
      const cur = prev[selectedSale.id] || {}
      const nextForSale = { ...cur, [docKey]: !cur[docKey] }
      if (checklistDraftTimerRef.current) window.clearTimeout(checklistDraftTimerRef.current)
      checklistDraftTimerRef.current = window.setTimeout(() => {
        persistNotaryChecklistDraft(selectedSale.id, nextForSale, rowsSnapshot)
      }, 600)
      return { ...prev, [selectedSale.id]: nextForSale }
    })
  }

  const notaryChecklistRows = useMemo(
    () => (selectedSale ? checklistRowsForNotary(selectedSale, projectWorkflows) : []),
    [selectedSale, projectWorkflows],
  )

  const requiredDocKeysForSale = useMemo(
    () => requiredDocKeysFromRows(notaryChecklistRows),
    [notaryChecklistRows],
  )

  const selectedAllDocsChecked = selectedSale
    ? requiredDocKeysForSale.every((key) => Boolean(selectedDocs[key]))
    : false

  const completeSale = async () => {
    if (!selectedSale || !selectedAllDocsChecked) return
    // Must not complete notary step unless finance is paid/validated.
    // Coordination may send dossiers early, but completion is gated by finance.
    if (!selectedSale.financeValidatedAt && !selectedSale.financeConfirmedAt) {
      setWarningNotice('Paiement finance non valide. La confirmation de reglement est obligatoire avant la finalisation notariale.')
      return
    }
    setSaving(true)
    try {
      const now = new Date().toISOString()
      const actorId = adminUser?.id || null
      const docKeys = {}
      const wfKeys = {}
      for (const row of notaryChecklistRows) {
        docKeys[row.docKey] = Boolean(selectedDocs[row.docKey])
        wfKeys[row.wfKey] = Boolean(selectedDocs[row.docKey])
      }
      const patch = {
        status: 'completed',
        pipelineStatus: 'completed',
        stampedAt: now,
        notaryCompletedAt: now,
        notaryCompletedBy: actorId,
        sellerContractSigned: Boolean(selectedDocs.sellerContract),
        notaryChecklistSigned: {
          docKeys,
          wfKeys,
          savedAt: now,
          savedBy: actorId,
          finalizedAt: now,
          finalizedBy: actorId,
        },
      }
      const saved = await updateSale(selectedSale.id, patch)
      // useSales.update returns only { id, ...patch }. Merge with the displayed
      // selectedSale (full row) so downstream logic sees paymentType / snapshots / price.
      const saleRow = { ...selectedSale, ...patch, ...(saved || {}) }
      await db.insertCommissionEventsForCompletedSale(saleRow, actorId, adminUser?.email || '')

      if (String(saleRow.paymentType || '').toLowerCase() === 'installments') {
        const dest = String(saleRow.postNotaryDestination || '').toLowerCase()
        if (dest === 'plans' || dest === '') {
          try {
            const planId = await db.ensureInstallmentPlanFromSale(saleRow, { startDate: now.slice(0, 10) })
            if (planId) {
              console.info('[notary] installment plan ensured', { saleId: saleRow.id, planId })
            } else {
              console.warn('[notary] installment plan NOT created — missing snapshot fields', {
                saleId: saleRow.id,
                duration: saleRow.offerSnapshot?.duration ?? saleRow.offerDuration,
                downPct: saleRow.offerSnapshot?.downPayment ?? saleRow.offerDownPayment,
                agreedPrice: saleRow.pricingSnapshot?.agreedPrice ?? saleRow.agreedPrice,
              })
            }
          } catch (e) {
            console.warn('[notary] ensureInstallmentPlanFromSale failed:', e?.message || e, { saleId: saleRow.id })
          }
        } else {
          console.info('[notary] installment plan skipped — destination is not plans', { saleId: saleRow.id, dest })
        }
      }

      const wf = projectWorkflows[selectedSale.projectId]
      const checklistItems = saleRow.checklistSnapshot?.items?.length
        ? saleRow.checklistSnapshot.items
        : wf?.signatureChecklist || []
      let grantClientId = saleRow.clientId
      if (saleRow.buyerAuthUserId) {
        const linked = await db.fetchClientIdByAuthUserId(saleRow.buyerAuthUserId)
        if (linked) grantClientId = linked
      }
      for (const item of checklistItems) {
        const dk = DOC_KEY_FROM_WF[item.key] || item.key
        if (!selectedDocs[dk]) continue
        const pages = item.grantAllowedPages || item.grant_allowed_pages
        if (Array.isArray(pages) && grantClientId) {
          for (const pk of pages) {
            await db.grantPageAccessLive({
              clientId: grantClientId,
              pageKey: pk,
              sourceSaleId: selectedSale.id,
              sourceChecklistKey: item.key,
              actorUserId: actorId,
              actorEmail: adminUser?.email || '',
            })
          }
        }
      }
      if (saleRow.sellerContractSigned && saleRow.clientId) {
        // Parcel ownership is handled by database triggers / sale status updates
      }
      setNotice(`Vente ${selectedSale.code || selectedSale.id} completee avec succes.`)
      setSelectedSale(null)
      setTimeout(() => setNotice(''), 2600)
    } finally {
      setSaving(false)
    }
  }

  // Count dossiers blocked by finance so users understand why some cards are locked.
  const lockedCount = useMemo(
    () => dossiers.filter((d) => !d.financeValidatedAt && !d.financeConfirmedAt).length,
    [dossiers],
  )

  return (
    <div className="nd nd--v2">
      <button type="button" className="ds-back-btn nd-v2__back" onClick={() => navigate(-1)}>
        <span className="ds-back-btn__icon" aria-hidden>←</span>
        <span className="ds-back-btn__label">Retour</span>
      </button>

      <section className="nd__hero nd-v2__hero">
        <div className="nd__hero-top">
          <div className="nd__hero-icon" aria-hidden>🖋️</div>
          <div>
            <h1 className="nd__hero-title nd-v2__hero-title">Bureau du notaire</h1>
            <p className="nd__hero-subtitle nd-v2__hero-subtitle">Finaliser la vente après paiement et signatures</p>
          </div>
        </div>
        <div className="nd__hero-kpi nd-v2__hero-kpi">
          <div className="nd__kpi-block">
            <span className="nd__kpi-value nd-v2__kpi-value">{dossiers.length}</span>
            <span className="nd__kpi-label nd-v2__kpi-label">Dossiers en cours</span>
          </div>
          <span className="nd__kpi-sep" />
          <div className="nd__kpi-block">
            <span className="nd__kpi-value nd-v2__kpi-value">{readyCount}</span>
            <span className="nd__kpi-label nd-v2__kpi-label">Prêts à finaliser</span>
          </div>
          <span className="nd__kpi-sep" />
          <div className="nd__kpi-block">
            <span className="nd__kpi-value nd-v2__kpi-value">{lockedCount}</span>
            <span className="nd__kpi-label nd-v2__kpi-label">En attente paiement</span>
          </div>
        </div>
      </section>

      {/* Inline guidance: explains the single job on this page in plain French. */}
      <div className="nd-v2__guide" role="note">
        <span className="nd-v2__guide-icon" aria-hidden>💡</span>
        <div>
          <div className="nd-v2__guide-title">Comment procéder</div>
          <div className="nd-v2__guide-text">
            1. Choisissez un dossier dans la liste. 2. Vérifiez les informations. 3. Cochez chaque document signé. 4. Cliquez sur <strong>Finaliser la vente</strong>.
          </div>
        </div>
      </div>

      <div className="nd-v2__toolbar">
        <label className="nd-v2__search-wrap">
          <span className="nd__search-icon" aria-hidden>🔎</span>
          <input
            className="nd__search nd-v2__search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Rechercher un client, un projet ou une référence"
            aria-label="Rechercher un dossier"
          />
        </label>
      </div>

      <div className="nd-v2__section-head">
        <h2 className="nd-v2__section-title">Dossiers à traiter</h2>
        <span className="nd-v2__section-hint" title="Un dossier est « prêt » lorsque tous les documents requis sont cochés et que le paiement finance est validé.">
          {readyCount} prêt{readyCount > 1 ? 's' : ''} sur {dossiers.length}
        </span>
      </div>

      {dossiers.length === 0 ? (
        <div className="nd__empty nd-v2__empty">
          <div className="nd-v2__empty-icon" aria-hidden>📭</div>
          <strong className="nd-v2__empty-title">Aucun dossier à traiter</strong>
          <p className="nd-v2__empty-text">
            Les nouveaux dossiers apparaissent ici dès que l'équipe <strong>Coordination</strong> crée une vente.
          </p>
          <button type="button" className="nd-v2__empty-btn" onClick={() => navigate('/admin/coordination')}>
            Aller à la Coordination
          </button>
        </div>
      ) : (
        <section className="nd__card-list nd-v2__card-list" aria-label="Liste des dossiers">
          {dossiers.map((sale) => {
            const checks = docsBySale[sale.id] || {}
            const rows = checklistRowsForNotary(sale, projectWorkflows)
            const reqKeys = requiredDocKeysFromRows(rows)
            const reqChecked = reqKeys.filter((k) => checks[k]).length
            const reqTotal = reqKeys.length
            const financeOk = Boolean(sale.financeValidatedAt || sale.financeConfirmedAt)
            const isReady = financeOk && reqChecked === reqTotal && reqTotal > 0
            const statusLabel = !financeOk
              ? 'Paiement non validé'
              : isReady
                ? 'Prêt à finaliser'
                : 'Documents incomplets'
            const statusTone = !financeOk ? 'warn' : isReady ? 'ok' : 'info'
            return (
              <button
                key={sale.id}
                type="button"
                className={`nd__card nd-v2__card nd-v2__card--${statusTone}`}
                aria-label={`Ouvrir le dossier de ${sale.clientName || 'client'}`}
                onClick={() => {
                  // Do not open the notary dossier until finance is paid/validated.
                  if (!sale.financeValidatedAt && !sale.financeConfirmedAt) {
                    setWarningNotice("Paiement non validé. Ouvrez la page Finance et confirmez le règlement avant d'ouvrir ce dossier notaire.")
                    return
                  }
                  setSelectedSale(sale)
                }}
              >
                <div className="nd__card-head">
                  <div className="nd__card-user">
                    <span className="nd__card-initials nd-v2__card-initials">{initials(sale.clientName)}</span>
                    <div style={{ minWidth: 0 }}>
                      <p className="nd__card-name nd-v2__card-name">{sale.clientName || 'Client'}</p>
                      <div className="nd__card-ref nd-v2__card-ref">Réf. {sale.code || sale.id}</div>
                    </div>
                  </div>
                  <span className={`nd-v2__status nd-v2__status--${statusTone}`}>{statusLabel}</span>
                </div>

                <div className="nd-v2__card-meta">
                  <span className="nd-v2__meta-label">Projet</span>
                  <span className="nd-v2__meta-value">
                    {sale.projectTitle || '—'}
                    {sale.plotIds.length ? ` • Parcelle${sale.plotIds.length > 1 ? 's' : ''} ${sale.plotIds.map((id) => `#${id}`).join(', ')}` : ''}
                  </span>
                </div>

                <div className="nd-v2__card-amounts">
                  <div>
                    <div className="nd-v2__amount-label">Montant de la vente</div>
                    <div className="nd-v2__amount-value">{fmtMoney(sale.total)}</div>
                  </div>
                  <div className="nd-v2__amount-sep" aria-hidden />
                  <div>
                    <div className="nd-v2__amount-label">Reste à encaisser</div>
                    <div className="nd-v2__amount-value nd-v2__amount-value--accent">{fmtMoney(sale.remaining)}</div>
                  </div>
                </div>

                <div className="nd-v2__card-foot">
                  <span className="nd-v2__progress" aria-label={`${reqChecked} documents cochés sur ${reqTotal}`}>
                    <span className="nd-v2__progress-bar">
                      <span className="nd-v2__progress-fill" style={{ width: `${reqTotal ? (reqChecked / reqTotal) * 100 : 0}%` }} />
                    </span>
                    <span className="nd-v2__progress-text">{reqChecked}/{reqTotal || 0} documents requis</span>
                  </span>
                  <span className="nd-v2__card-cta" aria-hidden>Ouvrir →</span>
                </div>
              </button>
            )
          })}
        </section>
      )}

      {selectedSale && (
        <div className="nd__overlay" role="presentation" onClick={() => setSelectedSale(null)}>
          <div className="nd__stamp-modal nd-v2__modal" role="dialog" aria-modal="true" aria-labelledby="nd-v2-modal-title" onClick={(e) => e.stopPropagation()}>
            <div className="nd__stamp-modal-head nd-v2__modal-head">
              <div>
                <h3 id="nd-v2-modal-title" className="nd-v2__modal-title">Finalisation du dossier</h3>
                <div className="nd-v2__modal-sub">
                  {selectedSale.clientName || 'Client'} · Réf. {selectedSale.code || selectedSale.id}
                </div>
              </div>
              <button type="button" className="nd__stamp-modal-x" aria-label="Fermer" onClick={() => setSelectedSale(null)}>✕</button>
            </div>
            <div className="nd__stamp-modal-body nd-v2__modal-body">

              <div className="nd-v2__stepper" aria-hidden>
                <span className="nd-v2__step nd-v2__step--done">1. Vérifier</span>
                <span className="nd-v2__step-sep" />
                <span className="nd-v2__step nd-v2__step--current">2. Cocher les documents</span>
                <span className="nd-v2__step-sep" />
                <span className="nd-v2__step">3. Finaliser</span>
              </div>

              <div style={{ marginBottom: 14 }}>
                <SaleSnapshotTracePanel sale={selectedSale} />
              </div>

              <section className="nd__stamp-section nd-v2__section">
                <header className="nd-v2__section-head-row">
                  <div className="nd-v2__section-head-title">Identité du client</div>
                  <div className="nd-v2__section-head-hint">Informations figées à la création de la vente</div>
                </header>
                <div className="nd__stamp-row"><span>Nom complet</span><strong>{selectedSale.clientName || '—'}</strong></div>
                <div className="nd__stamp-row"><span>CIN</span><strong>{selectedSale.client?.cin || '—'}</strong></div>
                <div className="nd__stamp-row"><span>Téléphone</span><strong>{selectedSale.client?.phone || '—'}</strong></div>
                <div className="nd__stamp-row"><span>Email</span><strong>{selectedSale.client?.email || '—'}</strong></div>
              </section>

              <section className="nd__stamp-section nd-v2__section">
                <header className="nd-v2__section-head-row">
                  <div className="nd-v2__section-head-title">Vente et parcelles</div>
                  <div className="nd-v2__section-head-hint">Objet exact du contrat</div>
                </header>
                <div className="nd__stamp-row"><span>Référence</span><strong>{selectedSale.code || selectedSale.id}</strong></div>
                <div className="nd__stamp-row"><span>Projet</span><strong>{selectedSale.projectTitle || '—'}</strong></div>
                <div className="nd__stamp-row"><span>Parcelles</span><strong>{selectedSale.plotIds.map((id) => `#${id}`).join(', ') || '—'}</strong></div>
                <div className="nd__stamp-row"><span>Mode de paiement</span><strong>{selectedSale.paymentType === 'installments' ? 'Échelonné' : 'Comptant'}</strong></div>
                <div className="nd__stamp-row"><span>Date de création</span><strong>{fmtDate(selectedSale.createdAt)}</strong></div>
              </section>

              <section className="nd__stamp-section nd-v2__section">
                <header className="nd-v2__section-head-row">
                  <div className="nd-v2__section-head-title">Validations internes</div>
                  <div className="nd-v2__section-head-hint">Étapes déjà franchies par les autres équipes</div>
                </header>
                <div className="nd__stamp-row">
                  <span>Finance validée</span>
                  <strong style={{ color: (selectedSale.financeValidatedAt || selectedSale.financeConfirmedAt) ? '#059669' : '#b45309' }}>
                    {(selectedSale.financeValidatedAt || selectedSale.financeConfirmedAt) ? fmtDate(selectedSale.financeValidatedAt || selectedSale.financeConfirmedAt) : 'En attente'}
                  </strong>
                </div>
                <div className="nd__stamp-row">
                  <span>Juridique validé</span>
                  <strong>{fmtDate(selectedSale.juridiqueValidatedAt)}</strong>
                </div>
              </section>

              <section className="nd__stamp-section nd-v2__section">
                <header className="nd-v2__section-head-row">
                  <div className="nd-v2__section-head-title">Récapitulatif financier</div>
                  <div className="nd-v2__section-head-hint">Montants issus du snapshot de la vente</div>
                </header>
                <div className="nd__stamp-row"><span>Montant de la vente</span><strong>{fmtMoney(selectedSale.total)}</strong></div>
                <div className="nd__stamp-row"><span>Avance reçue</span><strong>{fmtMoney(selectedSale.deposit)}</strong></div>
                <div className="nd__stamp-row"><span>Frais société</span><strong>{fmtMoney(selectedSale.companyFee)}</strong></div>
                <div className="nd__stamp-row"><span>Frais notaire</span><strong>{fmtMoney(selectedSale.notaryFee)}</strong></div>
                <div className="nd__stamp-row nd__stamp-row--total"><span>Reste à encaisser</span><strong>{fmtMoney(selectedSale.remaining)}</strong></div>
              </section>

              <section className="nd__stamp-section nd-v2__section nd-v2__section--checklist">
                <header className="nd-v2__section-head-row">
                  <div className="nd-v2__section-head-title">Documents à signer</div>
                  <div className="nd-v2__section-head-hint">Cochez chaque document une fois signé par les parties</div>
                </header>
                <div className="nd__doc-checklist nd-v2__doc-checklist">
                  {notaryChecklistRows.map((item) => {
                    const checked = Boolean(selectedDocs[item.docKey])
                    return (
                      <label
                        key={item.docKey}
                        className={`nd__doc-item nd-v2__doc-item ${checked ? 'nd-v2__doc-item--checked' : ''} ${item.required ? 'nd-v2__doc-item--required' : 'nd-v2__doc-item--optional'}`}
                      >
                        <input
                          type="checkbox"
                          checked={checked}
                          onChange={() => toggleDoc(item.docKey)}
                          aria-label={`${item.title} ${item.required ? '(requis)' : '(optionnel)'}`}
                        />
                        <span className="nd__doc-item-body nd-v2__doc-item-body">
                          <span className="nd-v2__doc-title-row">
                            <strong>{item.title}</strong>
                            {item.required
                              ? <span className="nd-v2__doc-tag nd-v2__doc-tag--required">Requis</span>
                              : <span className="nd-v2__doc-tag nd-v2__doc-tag--optional">Optionnel</span>}
                          </span>
                          {item.desc ? <small>{item.desc}</small> : null}
                        </span>
                      </label>
                    )
                  })}
                </div>
                {!selectedAllDocsChecked ? (
                  <div className="nd-v2__inline-hint" role="status">
                    Cochez tous les documents <strong>requis</strong> pour activer la finalisation.
                  </div>
                ) : null}
              </section>

              <div className="nd-v2__modal-footer">
                <button
                  type="button"
                  className="nd-v2__btn-secondary"
                  onClick={() => setSelectedSale(null)}
                  disabled={saving}
                >
                  Annuler
                </button>
                <button
                  type="button"
                  className="nd__btn-stamp nd-v2__btn-primary"
                  onClick={completeSale}
                  disabled={!selectedAllDocsChecked || saving}
                  title={selectedAllDocsChecked ? 'Clôturer définitivement cette vente' : 'Cochez tous les documents requis'}
                >
                  {saving ? 'Validation en cours…' : 'Finaliser la vente'}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {notice ? (
        <div className="nd-v2__toast-overlay" onClick={() => setNotice('')}>
          <div className="nd-v2__toast nd-v2__toast--ok" onClick={(e) => e.stopPropagation()} role="alertdialog">
            <div className="nd-v2__toast-icon">✓</div>
            <div className="nd-v2__toast-title">Vente finalisée</div>
            <div className="nd-v2__toast-text">{notice}</div>
            <button type="button" onClick={() => setNotice('')} className="nd-v2__toast-btn">OK</button>
          </div>
        </div>
      ) : null}

      {warningNotice ? (
        <div className="nd-v2__toast-overlay" onClick={() => setWarningNotice('')}>
          <div className="nd-v2__toast nd-v2__toast--warn" onClick={(e) => e.stopPropagation()} role="alertdialog">
            <div className="nd-v2__toast-icon">!</div>
            <div className="nd-v2__toast-title">Paiement requis</div>
            <div className="nd-v2__toast-text">{warningNotice}</div>
            <button type="button" onClick={() => setWarningNotice('')} className="nd-v2__toast-btn">J'ai compris</button>
          </div>
        </div>
      ) : null}
    </div>
  )
}

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

  return (
    <div className="nd">
      <button type="button" className="ds-back-btn" onClick={() => navigate(-1)}>
        <span className="ds-back-btn__icon" aria-hidden>←</span>
        <span className="ds-back-btn__label">Back</span>
      </button>

      <section className="nd__hero">
        <div className="nd__hero-top">
          <div className="nd__hero-icon">🖋️</div>
          <div>
            <h1 className="nd__hero-title">Etude notariale</h1>
            <p className="nd__hero-subtitle">Validation finale des dossiers de vente</p>
          </div>
        </div>
        <div className="nd__hero-kpi">
          <div className="nd__kpi-block">
            <span className="nd__kpi-value">{dossiers.length}</span>
            <span className="nd__kpi-label">Dossiers</span>
          </div>
          <span className="nd__kpi-sep" />
          <div className="nd__kpi-block">
            <span className="nd__kpi-value">{readyCount}</span>
            <span className="nd__kpi-label">Complets</span>
          </div>
        </div>
      </section>

      <div className="nd__workflow">
        Ouvrez un dossier et cochez tous les documents marqués <strong>requis</strong> selon la checklist figée sur la vente (snapshot à la création).
      </div>

      <div className="nd__search-wrap">
        <span className="nd__search-icon">🔎</span>
        <input
          className="nd__search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Rechercher client, projet, reference..."
        />
      </div>

      <div className="nd__ready-row">
        <span className="nd__ready-label">Dossiers prêts (checklist requise complète)</span>
        <span className="nd__ready-count">{readyCount}</span>
      </div>

      {dossiers.length === 0 ? (
        <div className="nd__empty">
          <strong>Aucun dossier pret pour le notaire</strong>
          <div style={{ marginTop: 6 }}>
            Les dossiers apparaissent ici dès la création (Coordination) puis restent ici quand ils passent en <strong>pending_legal</strong>.
          </div>
          <div style={{ marginTop: 8 }}>
            <button type="button" className="adm-btn adm-btn--primary" onClick={() => navigate('/admin/coordination')}>
              Aller à la coordination
            </button>
          </div>
        </div>
      ) : (
        <section className="nd__card-list">
          {dossiers.map((sale) => {
            const checks = docsBySale[sale.id] || {}
            const rows = checklistRowsForNotary(sale, projectWorkflows)
            const checkedCount = rows.filter((r) => checks[r.docKey]).length
            return (
              <button
                key={sale.id}
                type="button"
                className="nd__card"
                onClick={() => {
                  // Do not open the notary dossier until finance is paid/validated.
                  if (!sale.financeValidatedAt && !sale.financeConfirmedAt) {
                    setWarningNotice('Paiement finance non valide. Ouvrez la page Finance et confirmez le reglement avant d ouvrir le dossier notaire.')
                    return
                  }
                  setSelectedSale(sale)
                }}
              >
                <div className="nd__card-head">
                  <div className="nd__card-user">
                    <span className="nd__card-initials">{initials(sale.clientName)}</span>
                    <div>
                      <p className="nd__card-name">{sale.clientName || 'Client'}</p>
                      <div className="nd__card-ref">{sale.code || sale.id}</div>
                    </div>
                  </div>
                  <span className="nd__badge">
                    {checkedCount}/{rows.length || 3} docs
                  </span>
                </div>
                <div className="nd__card-phone">
                  {sale.projectTitle || 'Projet'} • {sale.plotIds.map((id) => `#${id}`).join(', ') || '—'}
                </div>
                <div className="nd__card-body">
                  <div>
                    <div className="nd__card-body-label">Montant total</div>
                    <div className="nd__card-body-value">{fmtMoney(sale.total)}</div>
                  </div>
                  <div className="nd__card-body-arrow">→</div>
                </div>
                <div className="nd__card-foot">
                  <span className="nd__card-foot-label">Reste a encaisser</span>
                  <span className="nd__card-foot-value">{fmtMoney(sale.remaining)}</span>
                </div>
              </button>
            )
          })}
        </section>
      )}

      {selectedSale && (
        <div className="nd__overlay" role="presentation" onClick={() => setSelectedSale(null)}>
          <div className="nd__stamp-modal" role="dialog" aria-modal="true" onClick={(e) => e.stopPropagation()}>
            <div className="nd__stamp-modal-head">
              <h3>Dossier notaire complet</h3>
              <button type="button" className="nd__stamp-modal-x" onClick={() => setSelectedSale(null)}>✕</button>
            </div>
            <div className="nd__stamp-modal-body">
              <div style={{ marginBottom: 14 }}>
                <SaleSnapshotTracePanel sale={selectedSale} />
              </div>
              <div className="nd__stamp-section">
                <div className="nd__stamp-section-title">Identite client</div>
                <div className="nd__stamp-row"><span>Nom</span><strong>{selectedSale.clientName || '—'}</strong></div>
                <div className="nd__stamp-row"><span>CIN</span><strong>{selectedSale.client?.cin || '—'}</strong></div>
                <div className="nd__stamp-row"><span>Telephone</span><strong>{selectedSale.client?.phone || '—'}</strong></div>
                <div className="nd__stamp-row"><span>Email</span><strong>{selectedSale.client?.email || '—'}</strong></div>
              </div>

              <div className="nd__stamp-section">
                <div className="nd__stamp-section-title">Vente / parcelles</div>
                <div className="nd__stamp-row"><span>Reference</span><strong>{selectedSale.code || selectedSale.id}</strong></div>
                <div className="nd__stamp-row"><span>Projet</span><strong>{selectedSale.projectTitle || '—'}</strong></div>
                <div className="nd__stamp-row"><span>Parcelles</span><strong>{selectedSale.plotIds.map((id) => `#${id}`).join(', ') || '—'}</strong></div>
                <div className="nd__stamp-row"><span>Type paiement</span><strong>{selectedSale.paymentType === 'installments' ? 'Echelonne' : 'Comptant'}</strong></div>
                <div className="nd__stamp-row"><span>Date creation</span><strong>{fmtDate(selectedSale.createdAt)}</strong></div>
              </div>

              <div className="nd__stamp-section">
                <div className="nd__stamp-section-title">Validations internes</div>
                <div className="nd__stamp-row"><span>Finance validee</span><strong>{fmtDate(selectedSale.financeValidatedAt)}</strong></div>
                <div className="nd__stamp-row"><span>Juridique valide</span><strong>{fmtDate(selectedSale.juridiqueValidatedAt)}</strong></div>
              </div>

              <div className="nd__stamp-section">
                <div className="nd__stamp-section-title">Financier complet</div>
                <div className="nd__stamp-row"><span>Montant vente</span><strong>{fmtMoney(selectedSale.total)}</strong></div>
                <div className="nd__stamp-row"><span>Avance recue</span><strong>{fmtMoney(selectedSale.deposit)}</strong></div>
                <div className="nd__stamp-row"><span>Frais societe</span><strong>{fmtMoney(selectedSale.companyFee)}</strong></div>
                <div className="nd__stamp-row"><span>Frais notaire</span><strong>{fmtMoney(selectedSale.notaryFee)}</strong></div>
                <div className="nd__stamp-row nd__stamp-row--total"><span>Reste</span><strong>{fmtMoney(selectedSale.remaining)}</strong></div>
              </div>

              <div className="nd__stamp-section">
                <div className="nd__stamp-section-title">Checklist signature (snapshot vente)</div>
                <div className="nd__doc-checklist">
                  {notaryChecklistRows.map((item) => (
                    <label key={item.docKey} className="nd__doc-item">
                      <input
                        type="checkbox"
                        checked={Boolean(selectedDocs[item.docKey])}
                        onChange={() => toggleDoc(item.docKey)}
                      />
                      <span className="nd__doc-item-body">
                        <strong>
                          {item.title}
                          {item.required ? <span style={{ color: '#b45309', fontSize: 10, marginLeft: 6 }}>(requis)</span> : null}
                        </strong>
                        <small>{item.desc}</small>
                      </span>
                    </label>
                  ))}
                </div>
              </div>

              <div className="nd__stamp-section">
                <button
                  type="button"
                  className="nd__btn-stamp"
                  onClick={completeSale}
                  disabled={!selectedAllDocsChecked || saving}
                >
                  {saving ? 'Validation...' : 'Sell (complete sale)'}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {notice ? (
        <div style={{ position: 'fixed', top: 0, left: 0, right: 0, bottom: 0, zIndex: 1800, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'rgba(15,23,42,.25)', backdropFilter: 'blur(4px)' }} onClick={() => setNotice('')}>
          <div style={{ padding: '20px 28px', borderRadius: 16, textAlign: 'center', background: 'linear-gradient(135deg, #065f46, #059669)', color: '#fff', boxShadow: '0 16px 48px rgba(0,0,0,.28)', minWidth: 240, maxWidth: 320 }} onClick={(e) => e.stopPropagation()}>
            <div style={{ width: 40, height: 40, borderRadius: 12, background: 'rgba(255,255,255,.18)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 20, margin: '0 auto 10px' }}>✓</div>
            <div style={{ fontSize: 14, fontWeight: 800, marginBottom: 4 }}>Success</div>
            <div style={{ fontSize: 12, fontWeight: 500, opacity: .85, lineHeight: 1.4 }}>{notice}</div>
            <button type="button" onClick={() => setNotice('')} style={{ marginTop: 14, padding: '8px 24px', borderRadius: 10, border: '1.5px solid rgba(255,255,255,.3)', background: 'rgba(255,255,255,.15)', color: '#fff', fontSize: 12, fontWeight: 700, cursor: 'pointer' }}>OK</button>
          </div>
        </div>
      ) : null}

      {warningNotice ? (
        <div style={{ position: 'fixed', top: 0, left: 0, right: 0, bottom: 0, zIndex: 1800, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'rgba(15,23,42,.25)', backdropFilter: 'blur(4px)' }} onClick={() => setWarningNotice('')}>
          <div style={{ padding: '20px 28px', borderRadius: 16, textAlign: 'center', background: 'linear-gradient(135deg, #b45309, #d97706)', color: '#fff', boxShadow: '0 16px 48px rgba(0,0,0,.28)', minWidth: 240, maxWidth: 360 }} onClick={(e) => e.stopPropagation()}>
            <div style={{ width: 40, height: 40, borderRadius: 12, background: 'rgba(255,255,255,.18)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 20, margin: '0 auto 10px' }}>!</div>
            <div style={{ fontSize: 14, fontWeight: 800, marginBottom: 4 }}>Paiement requis</div>
            <div style={{ fontSize: 12, fontWeight: 500, opacity: .9, lineHeight: 1.4 }}>{warningNotice}</div>
            <button type="button" onClick={() => setWarningNotice('')} style={{ marginTop: 14, padding: '8px 24px', borderRadius: 10, border: '1.5px solid rgba(255,255,255,.3)', background: 'rgba(255,255,255,.15)', color: '#fff', fontSize: 12, fontWeight: 700, cursor: 'pointer' }}>OK</button>
          </div>
        </div>
      ) : null}
    </div>
  )
}

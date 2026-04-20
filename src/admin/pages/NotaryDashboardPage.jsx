import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useClients, useSales } from '../../lib/useSupabase.js'
import { useAuth } from '../../lib/AuthContext.jsx'
import * as db from '../../lib/db.js'
import AdminModal from '../components/AdminModal.jsx'
import SaleSnapshotTracePanel from '../components/SaleSnapshotTracePanel.jsx'
import { getPagerPages } from './pager-util.js'
import './sell-field.css'
import './notary-dashboard.css'

const DOSSIERS_PER_PAGE = 15

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
  { key: 'cahier', title: 'Cahier des charges', desc: 'Document des conditions légales' },
  { key: 'sellerContract', title: 'Contrat vendeur', desc: 'Contrat du vendeur/mandat (optionnel)' },
]

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
  const { sales, loading: salesLoading, update: updateSale } = useSales()
  const { clients } = useClients()
  const [query, setQuery] = useState('')
  const [page, setPage] = useState(1)
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
        const isInst = sale.paymentType === 'installments'
        const downPct = Number(sale.offerDownPayment) || 0
        const firstInstallment = isInst && downPct > 0 ? Math.round(total * downPct / 100) : total
        // Araboun (deposit) is an advance on the 1st installment — Finance
        // collects (firstInstallment − deposit) at validation, so after the
        // notary step the total collected equals firstInstallment itself
        // (NOT deposit + firstInstallment — that would double-count the araboun).
        const alreadyCollected = Math.max(deposit, firstInstallment)
        const remaining = Math.max(0, total - alreadyCollected)
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
        const financeOk = Boolean(d.financeValidatedAt || d.financeConfirmedAt)
        return financeOk && req.every((k) => docMap[k])
      }).length,
    [dossiers, docsBySale, projectWorkflows],
  )

  const lockedCount = useMemo(
    () => dossiers.filter((d) => !d.financeValidatedAt && !d.financeConfirmedAt).length,
    [dossiers],
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
    if (!selectedSale || !selectedAllDocsChecked || saving) return
    if (!selectedSale.financeValidatedAt && !selectedSale.financeConfirmedAt) {
      setWarningNotice('Paiement finance non validé. La confirmation de règlement est obligatoire avant la finalisation notariale.')
      return
    }
    setSaving(true)
    // Safety net: if any await stalls (slow Supabase, realtime reconnect, RLS
    // hiccup), release the button after 30s so the user can retry instead of
    // being stuck on "Validation…" forever.
    const watchdog = window.setTimeout(() => {
      setSaving(false)
      setWarningNotice("La finalisation n'a pas répondu à temps. Vérifiez votre connexion puis réessayez.")
    }, 30000)
    const withStep = async (label, fn) => {
      try { return await fn() } catch (e) { const err = new Error(`${label}: ${e?.message || e}`); err.cause = e; throw err }
    }
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
      const saved = await withStep('updateSale', () => updateSale(selectedSale.id, patch))
      const saleRow = { ...selectedSale, ...patch, ...(saved || {}) }
      await withStep('insertCommissionEvents', () =>
        db.insertCommissionEventsForCompletedSale(saleRow, actorId, adminUser?.email || ''),
      )

      // Sale-based pyramid: this sale just completed at notary, so the buyer
      // enters the seller's pyramid as a direct child. Upsert is idempotent
      // — if the buyer already has a parent (their first purchase already
      // fixed the link) or inserting would form a cycle (reverse sale up
      // the existing chain), the upsert rejects and we log it. Either way
      // the commission events above were already computed against the graph
      // AS-OF-THIS-MOMENT, so this link only affects FUTURE sales.
      try {
        const buyerId = saleRow.clientId
        const sellerId = saleRow.sellerClientId
        if (buyerId && sellerId && String(buyerId) !== String(sellerId)) {
          const res = await db.upsertSellerRelation({
            childClientId: buyerId,
            parentClientId: sellerId,
            sourceSaleId: saleRow.id,
          })
          if (!res?.ok) {
            console.info('[notary] seller relation not created:', res?.reason, { buyerId, sellerId, saleId: saleRow.id })
          }
        }
      } catch (e) {
        console.warn('[notary] upsertSellerRelation (buyer→seller) failed:', e?.message || e)
      }

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
              })
            }
          } catch (e) {
            console.warn('[notary] ensureInstallmentPlanFromSale failed:', e?.message || e, { saleId: saleRow.id })
          }
        }
      }

      const wf = projectWorkflows[selectedSale.projectId]
      const checklistItems = saleRow.checklistSnapshot?.items?.length
        ? saleRow.checklistSnapshot.items
        : wf?.signatureChecklist || []
      let grantClientId = saleRow.clientId
      if (saleRow.buyerAuthUserId) {
        try {
          const linked = await db.fetchClientIdByAuthUserId(saleRow.buyerAuthUserId)
          if (linked) grantClientId = linked
        } catch (e) {
          console.warn('[notary] fetchClientIdByAuthUserId failed — falling back to sale.clientId:', e?.message || e)
        }
      }
      for (const item of checklistItems) {
        const dk = DOC_KEY_FROM_WF[item.key] || item.key
        if (!selectedDocs[dk]) continue
        const pages = item.grantAllowedPages || item.grant_allowed_pages
        if (Array.isArray(pages) && grantClientId) {
          for (const pk of pages) {
            try {
              await db.grantPageAccessLive({
                clientId: grantClientId,
                pageKey: pk,
                sourceSaleId: selectedSale.id,
                sourceChecklistKey: item.key,
                actorUserId: actorId,
                actorEmail: adminUser?.email || '',
              })
            } catch (e) {
              console.warn('[notary] grantPageAccessLive failed — sale finalized, grant deferred:', e?.message || e, { pageKey: pk })
            }
          }
        }
      }

      setNotice(`Vente ${selectedSale.code || selectedSale.id} finalisée avec succès.`)
      setSelectedSale(null)
      setTimeout(() => setNotice(''), 2600)
    } catch (e) {
      console.error('[notary] completeSale failed:', e)
      setWarningNotice(`Échec de la finalisation: ${e?.message || 'erreur inconnue'}. Vérifiez votre connexion et réessayez.`)
    } finally {
      window.clearTimeout(watchdog)
      setSaving(false)
    }
  }

  const openCard = (sale) => {
    if (!sale.financeValidatedAt && !sale.financeConfirmedAt) {
      setWarningNotice("Paiement non validé. Ouvrez la page Finance et confirmez le règlement avant d'ouvrir ce dossier.")
      return
    }
    setSelectedSale(sale)
  }

  const pageCount = Math.max(1, Math.ceil(dossiers.length / DOSSIERS_PER_PAGE))
  const safePage = Math.min(Math.max(1, page), pageCount)
  const pagedDossiers = useMemo(
    () => dossiers.slice((safePage - 1) * DOSSIERS_PER_PAGE, safePage * DOSSIERS_PER_PAGE),
    [dossiers, safePage],
  )
  const onQueryChange = (e) => { setQuery(e.target.value); setPage(1) }

  const showSkeletons = salesLoading && dossiers.length === 0

  return (
    <div className="sell-field" dir="ltr">
      <button type="button" className="sp-back-btn" onClick={() => navigate(-1)}>
        <span className="sp-back-btn__icon-wrap" aria-hidden>←</span>
        <span>Retour</span>
      </button>

      <header className="sp-hero">
        <div className="sp-hero__avatar nd-hero__icon" aria-hidden>
          <span>🖋️</span>
        </div>
        <div className="sp-hero__info">
          <h1 className="sp-hero__name">Bureau du notaire</h1>
          <p className="sp-hero__role">Finaliser les ventes signées</p>
        </div>
        <div className="sp-hero__kpis">
          <span className="sp-hero__kpi-num">
            {showSkeletons ? <span className="sk-num sk-num--wide" /> : dossiers.length}
          </span>
          <span className="sp-hero__kpi-label">dossier{dossiers.length > 1 ? 's' : ''}</span>
        </div>
      </header>

      <div className="sp-cat-bar">
        <div className="sp-cat-stats">
          <strong>{showSkeletons ? <span className="sk-num" /> : dossiers.length}</strong> total
          <span className="sp-cat-stat-dot" />
          <strong>{showSkeletons ? <span className="sk-num" /> : readyCount}</strong> prêt{readyCount > 1 ? 's' : ''}
          <span className="sp-cat-stat-dot" />
          <strong>{showSkeletons ? <span className="sk-num" /> : lockedCount}</strong> bloqué{lockedCount > 1 ? 's' : ''}
        </div>
        <div className="sp-cat-filters">
          <input
            className="sp-cat-search"
            placeholder="Rechercher un client, projet, référence…"
            value={query}
            onChange={onQueryChange}
            aria-label="Rechercher un dossier"
          />
        </div>
      </div>

      <div className="sp-cards">
        {showSkeletons ? (
          Array.from({ length: 6 }).map((_, i) => (
            <div key={`sk-${i}`} className="sp-card sp-card--skeleton" aria-hidden>
              <div className="sp-card__head">
                <div className="sp-card__user">
                  <span className="sp-card__initials sk-box" />
                  <div style={{ flex: 1 }}>
                    <p className="sk-line sk-line--title" />
                    <p className="sk-line sk-line--sub" />
                  </div>
                </div>
                <span className="sk-line sk-line--badge" />
              </div>
              <div className="sp-card__body">
                <span className="sk-line sk-line--price" />
                <span className="sk-line sk-line--info" />
              </div>
            </div>
          ))
        ) : dossiers.length === 0 ? (
          <div className="sp-empty">
            <span className="sp-empty__emoji" aria-hidden>📭</span>
            <div className="sp-empty__title">
              {query ? 'Aucun résultat.' : 'Aucun dossier à traiter.'}
            </div>
            {!query && (
              <p className="nd-empty__text">
                Les nouveaux dossiers apparaissent dès qu'une vente est créée par la Coordination.
              </p>
            )}
          </div>
        ) : pagedDossiers.map((sale) => {
          const checks = docsBySale[sale.id] || {}
          const rows = checklistRowsForNotary(sale, projectWorkflows)
          const reqKeys = requiredDocKeysFromRows(rows)
          const reqChecked = reqKeys.filter((k) => checks[k]).length
          const reqTotal = reqKeys.length
          const financeOk = Boolean(sale.financeValidatedAt || sale.financeConfirmedAt)
          const isReady = financeOk && reqChecked === reqTotal && reqTotal > 0
          const tone = !financeOk ? 'orange' : isReady ? 'green' : 'blue'
          const badgeLabel = !financeOk ? 'Paiement en attente' : isReady ? 'Prêt à finaliser' : 'Documents requis'
          const pct = reqTotal ? (reqChecked / reqTotal) * 100 : 0
          return (
            <button
              key={sale.id}
              type="button"
              className={`sp-card sp-card--${tone}`}
              onClick={() => openCard(sale)}
              aria-label={`Ouvrir le dossier de ${sale.clientName || 'client'}`}
            >
              <div className="sp-card__head">
                <div className="sp-card__user">
                  <span className="sp-card__initials">{initials(sale.clientName)}</span>
                  <div style={{ minWidth: 0 }}>
                    <p className="sp-card__name">{sale.clientName || 'Client'}</p>
                    <p className="sp-card__sub">
                      {sale.projectTitle || '—'}
                      {sale.plotIds.length ? ` · ${sale.plotIds.map((id) => `#${id}`).join(', ')}` : ''}
                    </p>
                  </div>
                </div>
                <span className={`sp-badge sp-badge--${tone}`}>{badgeLabel}</span>
              </div>

              <div className="sp-card__body">
                <div className="sp-card__price">
                  <span className="sp-card__amount">{(sale.total || 0).toLocaleString('fr-FR')}</span>
                  <span className="sp-card__currency">TND</span>
                </div>
                <div className="sp-card__info">
                  <span>{reqChecked}/{reqTotal} docs</span>
                </div>
              </div>

              <div className="nd-progress" aria-hidden>
                <span className="nd-progress__fill" style={{ width: `${pct}%` }} />
              </div>
            </button>
          )
        })}
      </div>

      {!showSkeletons && dossiers.length > DOSSIERS_PER_PAGE && (
        <div className="sp-pager" role="navigation" aria-label="Pagination">
          <button
            type="button"
            className="sp-pager__btn sp-pager__btn--nav"
            disabled={safePage <= 1}
            onClick={() => setPage(Math.max(1, safePage - 1))}
            aria-label="Page précédente"
          >
            ‹
          </button>
          {getPagerPages(safePage, pageCount).map((p, i) =>
            p === '…' ? (
              <span key={`dots-${i}`} className="sp-pager__ellipsis" aria-hidden>…</span>
            ) : (
              <button
                key={p}
                type="button"
                className={`sp-pager__btn${p === safePage ? ' sp-pager__btn--active' : ''}`}
                onClick={() => setPage(p)}
                aria-current={p === safePage ? 'page' : undefined}
              >
                {p}
              </button>
            ),
          )}
          <button
            type="button"
            className="sp-pager__btn sp-pager__btn--nav"
            disabled={safePage >= pageCount}
            onClick={() => setPage(Math.min(pageCount, safePage + 1))}
            aria-label="Page suivante"
          >
            ›
          </button>
          <span className="sp-pager__info">
            {(safePage - 1) * DOSSIERS_PER_PAGE + 1}–{Math.min(safePage * DOSSIERS_PER_PAGE, dossiers.length)} / {dossiers.length}
          </span>
        </div>
      )}

      {selectedSale && (
        <AdminModal open onClose={() => setSelectedSale(null)} title="">
          <div className="sp-detail nd-detail">
            <div className="sp-detail__banner">
              <div className="sp-detail__banner-top">
                <span className="sp-badge sp-badge--blue">Finalisation</span>
                <span className="sp-detail__date">{fmtDate(selectedSale.createdAt)}</span>
              </div>
              <div className="sp-detail__price">
                <span className="sp-detail__price-num">{(selectedSale.total || 0).toLocaleString('fr-FR')}</span>
                <span className="sp-detail__price-cur">TND</span>
              </div>
              <p className="sp-detail__banner-sub">
                {selectedSale.clientName || 'Client'} · Réf. {selectedSale.code || selectedSale.id}
              </p>
            </div>

            <div className="sp-detail__section">
              <div className="sp-detail__section-title">Client</div>
              <div className="sp-detail__row"><span>Nom</span><strong>{selectedSale.clientName || '—'}</strong></div>
              <div className="sp-detail__row"><span>CIN</span><strong style={{ direction: 'ltr' }}>{selectedSale.client?.cin || '—'}</strong></div>
              <div className="sp-detail__row"><span>Téléphone</span><strong style={{ direction: 'ltr' }}>{selectedSale.client?.phone || '—'}</strong></div>
              {selectedSale.client?.email && (
                <div className="sp-detail__row"><span>Email</span><strong style={{ wordBreak: 'break-all' }}>{selectedSale.client.email}</strong></div>
              )}
            </div>

            <div className="sp-detail__section">
              <div className="sp-detail__section-title">Vente</div>
              <div className="sp-detail__row"><span>Projet</span><strong>{selectedSale.projectTitle || '—'}</strong></div>
              <div className="sp-detail__row"><span>Parcelles</span><strong>{selectedSale.plotIds.map((id) => `#${id}`).join(', ') || '—'}</strong></div>
              <div className="sp-detail__row"><span>Mode</span><strong>{selectedSale.paymentType === 'installments' ? 'Échelonné' : 'Comptant'}</strong></div>
            </div>

            <div className="sp-detail__section">
              <div className="sp-detail__section-title">Finance</div>
              <div className="sp-detail__row">
                <span>Paiement validé</span>
                <strong style={{ color: (selectedSale.financeValidatedAt || selectedSale.financeConfirmedAt) ? '#059669' : '#d97706' }}>
                  {(selectedSale.financeValidatedAt || selectedSale.financeConfirmedAt)
                    ? fmtDate(selectedSale.financeValidatedAt || selectedSale.financeConfirmedAt)
                    : 'En attente'}
                </strong>
              </div>
              <div className="sp-detail__row"><span>Avance reçue</span><strong>{fmtMoney(selectedSale.deposit)}</strong></div>
              {selectedSale.paymentType === 'installments' && (Number(selectedSale.offerDownPayment) || 0) > 0 && (
                <div className="sp-detail__row">
                  <span>1er versement ({Number(selectedSale.offerDownPayment)}%) encaissé</span>
                  <strong>{fmtMoney(Math.round(selectedSale.total * Number(selectedSale.offerDownPayment) / 100))}</strong>
                </div>
              )}
              <div className="sp-detail__row"><span>Frais société</span><strong>{fmtMoney(selectedSale.companyFee)}</strong></div>
              <div className="sp-detail__row"><span>Frais notaire</span><strong>{fmtMoney(selectedSale.notaryFee)}</strong></div>
              <div className="sp-detail__row sp-detail__row--highlight">
                <span>{selectedSale.paymentType === 'installments' ? 'Capital restant (échéances)' : 'Reste à encaisser'}</span>
                <strong>{fmtMoney(selectedSale.remaining)}</strong>
              </div>
            </div>

            <div className="sp-detail__section">
              <div className="sp-detail__section-title">Documents à signer</div>
              <div className="nd-checklist">
                {notaryChecklistRows.map((item) => {
                  const checked = Boolean(selectedDocs[item.docKey])
                  return (
                    <label
                      key={item.docKey}
                      className={`nd-check ${checked ? 'nd-check--on' : ''} ${item.required ? '' : 'nd-check--optional'}`}
                    >
                      <input
                        type="checkbox"
                        checked={checked}
                        onChange={() => toggleDoc(item.docKey)}
                        aria-label={`${item.title} ${item.required ? '(requis)' : '(optionnel)'}`}
                      />
                      <span className="nd-check__body">
                        <span className="nd-check__title">
                          {item.title}
                          <span className={`nd-check__tag ${item.required ? 'nd-check__tag--req' : 'nd-check__tag--opt'}`}>
                            {item.required ? 'Requis' : 'Optionnel'}
                          </span>
                        </span>
                        {item.desc && <span className="nd-check__desc">{item.desc}</span>}
                      </span>
                    </label>
                  )
                })}
              </div>
              {!selectedAllDocsChecked && (
                <div className="nd-hint">Cochez tous les documents <strong>requis</strong> pour activer la finalisation.</div>
              )}
            </div>

            <div className="sp-detail__section">
              <SaleSnapshotTracePanel sale={selectedSale} />
            </div>

            <div className="sp-detail__actions">
              <button
                type="button"
                className="sp-detail__btn"
                onClick={() => setSelectedSale(null)}
                disabled={saving}
              >
                Annuler
              </button>
              <button
                type="button"
                className="sp-detail__btn sp-detail__btn--edit"
                onClick={completeSale}
                disabled={!selectedAllDocsChecked || saving}
                title={selectedAllDocsChecked ? 'Clôturer définitivement cette vente' : 'Cochez tous les documents requis'}
              >
                {saving ? 'Validation…' : 'Finaliser la vente'}
              </button>
            </div>
          </div>
        </AdminModal>
      )}

      {notice && (
        <div className="nd-toast-wrap" onClick={() => setNotice('')}>
          <div className="nd-toast nd-toast--ok" onClick={(e) => e.stopPropagation()} role="alertdialog">
            <div className="nd-toast__icon">✓</div>
            <div className="nd-toast__title">Vente finalisée</div>
            <div className="nd-toast__text">{notice}</div>
            <button type="button" onClick={() => setNotice('')} className="nd-toast__btn">OK</button>
          </div>
        </div>
      )}

      {warningNotice && (
        <div className="nd-toast-wrap" onClick={() => setWarningNotice('')}>
          <div className="nd-toast nd-toast--warn" onClick={(e) => e.stopPropagation()} role="alertdialog">
            <div className="nd-toast__icon">!</div>
            <div className="nd-toast__title">Action bloquée</div>
            <div className="nd-toast__text">{warningNotice}</div>
            <button type="button" onClick={() => setWarningNotice('')} className="nd-toast__btn">J'ai compris</button>
          </div>
        </div>
      )}
    </div>
  )
}

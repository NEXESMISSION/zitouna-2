/*
 * DB schema additions required for the Comptant / m²-priced offer feature.
 * Run these once before relying on the new fields — the UI tolerates their
 * absence (the extra keys are simply ignored server-side until added):
 *
 *   ALTER TABLE public.project_offers ADD COLUMN mode text NOT NULL DEFAULT 'installments';
 *   ALTER TABLE public.project_offers ADD COLUMN cash_amount numeric(14,2);
 *   ALTER TABLE public.project_offers ADD COLUMN price_per_sqm numeric(14,2);
 *
 * (table name is `project_offers` — see db.js fetchOffers/upsertOffer).
 */
import { useMemo, useState, useEffect, useRef } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { useProjects, useOffers, useProjectWorkflow } from '../../lib/useSupabase.js'
import CommissionRulesEditor from '../components/CommissionRulesEditor.jsx'
import * as db from '../../lib/db.js'
import { emitInvalidate } from '../../lib/dataEvents.js'
import { runSafeAction } from '../../lib/runSafeAction.js'
import AdminModal from '../components/AdminModal.jsx'
import RenderDataGate from '../../components/RenderDataGate.jsx'
import EmptyState from '../../components/EmptyState.jsx'
import { SkeletonDetail } from '../../components/skeletons/index.js'
import './zitouna-admin-page.css'
import './projects-admin.css'
import './project-detail-admin.css'

const CY = 2026

const EMPTY_PARCEL = {
  id: '',
  label: '',
  trees: '',
  area: '',
  pricePerTree: '',
  status: 'available',
  /** @type {{ year: string | number, count: string }[]} */
  treeBatches: [{ year: CY, count: '' }],
}

/** Normalise UI rows → { year, count } for `parcel_tree_batches` (count > 0 only). */
function normalizeBatchInput(batches) {
  if (!Array.isArray(batches) || !batches.length) return []
  return batches
    .map((b) => ({
      year: Number(b?.year) || CY,
      count: Math.max(0, Math.floor(Number(String(b?.count ?? '').replace(',', '.')) || 0)),
    }))
    .filter((b) => b.count > 0)
}

function sumBatchTrees(list) {
  return (list || []).reduce((s, b) => s + (Number(b.count) || 0), 0)
}

const EMPTY_PROJECT = { title: '', city: '', region: '', address: '', mapUrl: '' }
const EMPTY_OFFER = { label: '', mode: 'installments', avancePct: '', duration: '', cashAmount: '', note: '', usePricePerSqm: false, pricePerSqm: '' }
const EMPTY_CHECK_ITEM = { key: '', label: '', required: true, grantAllowedPagesText: '' }
const DH = { treeSante: 95, humidity: 65, nutrients: 80 }

function fmt(v) { return `${(Number(v) || 0).toLocaleString('fr-FR')} DT` }
function ti(y) { const a = CY - y; if (a < 3) return { rate: 0, label: 'Jeune' }; if (a < 6) return { rate: 45, label: 'Dev.' }; if (a < 10) return { rate: 75, label: 'Croissance' }; return { rate: 90, label: 'Production' } }
function pRev(p) { if (!p.treeBatches?.length) return p.trees * 90; return p.treeBatches.reduce((s, b) => s + b.count * ti(b.year).rate, 0) }
function sLbl(s) { return s === 'available' ? 'Dispo' : s === 'reserved' ? 'Réservée' : 'Vendue' }
function pillCls(s) { return s === 'available' ? 'pdp-pill pdp-pill--avail' : s === 'reserved' ? 'pdp-pill pdp-pill--reserved' : 'pdp-pill pdp-pill--sold' }

// Sum of parcel surfaces in m². Plots here expose area_m2 as `.area`.
function sumParcelArea(plots) {
  return (plots || []).reduce((s, p) => s + (Number(p.area) || 0), 0)
}
// Format that sum as "X Ha" once >= 10 000 m², else "Y m²". '—' if empty.
function fmtArea(totalM2) {
  const t = Number(totalM2) || 0
  if (!t) return '—'
  if (t >= 10000) {
    const ha = t / 10000
    const rounded = ha >= 10 ? Math.round(ha) : Math.round(ha * 10) / 10
    return `${rounded.toLocaleString('fr-FR')} Ha`
  }
  return `${Math.round(t).toLocaleString('fr-FR')} m²`
}

export default function ProjectDetailPage() {
  const navigate = useNavigate()
  const { projectId } = useParams()
  const { projects, loading: projectsLoading, error: projectsError, refresh: refreshProjects } = useProjects()
  const { offersByProject, refresh: refreshOffers } = useOffers()
  const [modal, setModal] = useState(null)
  const [pf, setPf] = useState(EMPTY_PROJECT)
  const [pcf, setPcf] = useState(EMPTY_PARCEL)
  const [of, setOf] = useState(EMPTY_OFFER)
  const [eoIdx, setEoIdx] = useState(-1)
  const [editOfferDbId, setEditOfferDbId] = useState(null)
  const [parcelQ, setParcelQ] = useState('')
  const [saving, setSaving] = useState(false)
  const [opError, setOpError] = useState('')
  const reportOpError = (msg) => {
    setOpError(msg)
    window.setTimeout(() => setOpError(''), 6000)
  }
  const [healthLocal, setHealthLocal] = useState({})
  // Snapshot of the last-applied health per project — drives the Apply/Cancel
  // buttons (dirty detection) and the cancel-to-saved-values handler.
  const [healthSaved, setHealthSaved] = useState({})
  // Draft held by the checklist-item edit modal. `idx === -1` = creating a new
  // item; any other number = editing existing at that index.
  const [checklistDraft, setChecklistDraft] = useState({ idx: -1, key: '', label: '', grantAllowedPagesText: '', required: true })
  // Active tab — the page is split into focused workspaces to avoid the
  // overwhelming "everything on one scroll" layout.
  const [activeTab, setActiveTab] = useState('overview')
  const [confirmDelete, setConfirmDelete] = useState(false)

  const project = useMemo(() => projects.find(p => String(p.id) === String(projectId)), [projects, projectId])
  const { workflow, updateWorkflow, loading: workflowLoading } = useProjectWorkflow(project?.id || '')
  const [wfCompany, setWfCompany] = useState(5)
  const [wfNotary, setWfNotary] = useState(2)
  const [wfMinPay, setWfMinPay] = useState(100)
  const [wfResH, setWfResH] = useState(48)
  const [wfArabon, setWfArabon] = useState(50)
  const [wfAdvance, setWfAdvance] = useState('')
  const [wfFirstDue, setWfFirstDue] = useState('')
  const [wfEndDue, setWfEndDue] = useState('')
  const [checklistItems, setChecklistItems] = useState([])
  const [wfMsg, setWfMsg] = useState(null)
  const [wfErr, setWfErr] = useState(false)

  // Signature of the last applied workflow snapshot, so the effect below
  // only writes state when the workflow genuinely changed (project switch or
  // remote refresh). Without this guard, React 19's `set-state-in-effect` lint
  // rule flags the effect — and rightly so: the effect would otherwise write
  // on every render. Ref avoids an extra render cycle vs. a state flag.
  const appliedWfSigRef = useRef('')

  useEffect(() => {
    if (!workflow || !project?.id) return
    const sig = JSON.stringify({
      pid: project.id,
      c: workflow.companyFeePct,
      n: workflow.notaryFeePct,
      m: workflow.minimumPayoutThreshold,
      r: workflow.reservationHours,
      a: workflow.arabonDefault,
      av: workflow.defaultAdvanceAmount,
      fd: workflow.installmentsFirstDueDate,
      ed: workflow.installmentsEndDate,
      cl: workflow.signatureChecklist,
    })
    if (appliedWfSigRef.current === sig) return
    appliedWfSigRef.current = sig
    // Syncing derived workflow values to editable form state when the
    // project/workflow changes. The signature ref above dedupes reruns, so
    // these setState calls only fire on a real workflow change — no cascade.
    /* eslint-disable react-hooks/set-state-in-effect */
    setWfCompany(Number(workflow.companyFeePct ?? 5))
    setWfNotary(Number(workflow.notaryFeePct ?? 2))
    setWfMinPay(Number(workflow.minimumPayoutThreshold ?? 100))
    setWfResH(Number(workflow.reservationHours ?? 48))
    setWfArabon(Number(workflow.arabonDefault ?? 50))
    setWfAdvance(workflow.defaultAdvanceAmount == null ? '' : String(workflow.defaultAdvanceAmount))
    setWfFirstDue(workflow.installmentsFirstDueDate || '')
    setWfEndDue(workflow.installmentsEndDate || '')
    const normalized = (workflow.signatureChecklist || []).map((it) => ({
      key: String(it?.key || '').trim(),
      label: String(it?.label || '').trim(),
      required: it?.required !== false,
      grantAllowedPagesText: Array.isArray(it?.grantAllowedPages) ? it.grantAllowedPages.join(', ') : '',
    }))
    setChecklistItems(normalized)
    /* eslint-enable react-hooks/set-state-in-effect */
  }, [project?.id, workflow])

  const saveWorkflowConfig = async () => {
    if (!project?.id) return
    const checklist = checklistItems
      .map((it) => ({
        key: String(it.key || '').trim(),
        label: String(it.label || '').trim(),
        required: it.required !== false,
        grantAllowedPages: String(it.grantAllowedPagesText || '')
          .split(',')
          .map((x) => x.trim())
          .filter(Boolean),
      }))
      .filter((it) => it.key && it.label)
      .map((it) => ({
        ...it,
        grantAllowedPages: it.grantAllowedPages.length ? it.grantAllowedPages : null,
      }))

    if (!checklist.length) {
      setWfErr(true)
      setWfMsg('Ajoutez au moins un élément dans la checklist notaire avant d’enregistrer.')
      window.setTimeout(() => { setWfMsg(null); setWfErr(false) }, 3500)
      return
    }
    try {
      await updateWorkflow({
        companyFeePct: wfCompany,
        notaryFeePct: wfNotary,
        minimumPayoutThreshold: wfMinPay,
        reservationHours: wfResH,
        arabonDefault: wfArabon,
        defaultAdvanceAmount: wfAdvance === '' ? null : Number(wfAdvance),
        installmentsFirstDueDate: wfFirstDue || null,
        installmentsEndDate: wfEndDue || null,
        signatureChecklist: checklist,
      })
      setWfErr(false)
      setWfMsg("Enregistré. S'applique aux nouvelles ventes (les ventes existantes gardent leur configuration d’origine).")
    } catch (e) {
      setWfErr(true)
      setWfMsg(`Erreur : ${String(e?.message || e)}`)
    }
    window.setTimeout(() => { setWfMsg(null); setWfErr(false) }, 4000)
  }

  const plots = useMemo(() => project?.plots || [], [project?.plots])
  const offers = offersByProject[project?.id] || []
  const totalTrees = plots.reduce((s, p) => s + (p.trees || 0), 0)
  const totalAreaM2 = useMemo(() => sumParcelArea(plots), [plots])
  const totalValue = plots.reduce((s, p) => s + (Number(p.totalPrice) || 0), 0)
  const totalRevenue = plots.reduce((s, p) => s + pRev(p), 0)
  const avail = plots.filter(p => p.status === 'available').length
  const filteredPlots = useMemo(() => {
    const q = parcelQ.trim()
    if (!q) return plots
    const qLower = q.toLowerCase()
    return plots.filter(p =>
      (p.label && String(p.label).toLowerCase().includes(qLower)) ||
      String(p.id).includes(q) ||
      String(p.trees).includes(q) ||
      String(p.area).includes(q)
    )
  }, [plots, parcelQ])

  const projHealth = healthLocal[project?.id] || { ...DH }
  const setHealth = (field, val) => { setHealthLocal(prev => ({ ...prev, [project.id]: { ...projHealth, [field]: Number(val) } })) }
  // Apply = snapshot current values as the "saved" baseline. Cancel = revert
  // the local edit to the saved baseline. Persistence to DB isn't wired yet
  // (no column) — this keeps the interaction truthful and ready to plug in.
  const applyHealth = () => {
    if (!project?.id) return
    setHealthSaved(prev => ({ ...prev, [project.id]: { ...projHealth } }))
  }
  const cancelHealth = () => {
    if (!project?.id) return
    const baseline = healthSaved[project.id] || { ...DH }
    setHealthLocal(prev => ({ ...prev, [project.id]: { ...baseline } }))
  }

  // Checklist modal helpers — open with idx === -1 for a new item.
  const openChecklistEdit = (idx) => {
    if (idx === -1) {
      setChecklistDraft({ idx: -1, key: '', label: '', grantAllowedPagesText: '', required: true })
    } else {
      const row = checklistItems[idx] || {}
      setChecklistDraft({
        idx,
        key: row.key || '',
        label: row.label || '',
        grantAllowedPagesText: row.grantAllowedPagesText || '',
        required: row.required !== false,
      })
    }
    setModal('wf-checklist')
  }
  const saveChecklistDraft = () => {
    const payload = {
      key: checklistDraft.key.trim(),
      label: checklistDraft.label.trim(),
      grantAllowedPagesText: checklistDraft.grantAllowedPagesText.trim(),
      required: !!checklistDraft.required,
    }
    if (!payload.key || !payload.label) return
    if (checklistDraft.idx === -1) {
      setChecklistItems((prev) => [...prev, payload])
    } else {
      updateChecklistRow(checklistDraft.idx, payload)
    }
    setModal(null)
  }
  const avgPrice = plots.length ? totalValue / plots.length : 0

  const openEdit = () => { if (!project) return; setPf({ title: project.title, city: project.city, region: project.region || '', address: project.address || '', mapUrl: project.mapUrl || '' }); setModal('edit') }
  const saveEdit = async () => {
    if (saving) return
    const res = await runSafeAction({
      setBusy: setSaving, onError: reportOpError, label: 'Enregistrer le projet',
    }, async () => {
      // Preserve existing area / year (no longer editable from this form) —
      // db.upsertProject always writes these columns so we echo the stored
      // values rather than clobbering them with empty strings / current year.
      await db.upsertProject({
        id: project.id,
        title: pf.title.trim() || project.title,
        city: pf.city.trim() || project.city,
        region: pf.region.trim(),
        address: pf.address.trim(),
        area: project.area || '',
        year: project.year || new Date().getFullYear(),
        mapUrl: pf.mapUrl.trim(),
      })
      emitInvalidate('projects')
      await refreshProjects()
    })
    if (res.ok) setModal(null)
  }
  const delProject = async () => {
    if (saving) return
    const res = await runSafeAction({
      setBusy: setSaving, onError: reportOpError, label: 'Supprimer le projet',
    }, async () => {
      await db.deleteProject(project.id)
      emitInvalidate('projects')
    })
    if (res.ok) navigate('/admin/projects')
  }

  const openAdd = () => {
    setPcf({ ...EMPTY_PARCEL, status: 'available', treeBatches: [{ year: CY, count: '' }] })
    setModal('add-parcel')
  }
  const saveNew = async () => {
    const batches = normalizeBatchInput(pcf.treeBatches)
    const t = batches.length ? sumBatchTrees(batches) : Number(pcf.trees)
    const a = Number(pcf.area)
    if (!Number.isFinite(t) || t <= 0) return
    // The user-facing identifier (free-form text, optional but recommended).
    // Trim + lowercase for storage / comparison; length capped by input.
    const label = String(pcf.label || '').trim().toLowerCase().slice(0, 16)
    if (!label) return
    if (saving) return
    const res = await runSafeAction({
      setBusy: setSaving, onError: reportOpError, label: 'Ajouter la parcelle',
    }, async () => {
      // New parcels: no price/tree collected in the add form — pricing is
      // handled later (per-batch). Start with pricePerTree=0 and let the
      // edit flow / public pricing fill it in.
      // `plotNumber: 0` asks db.upsertParcelForProject to auto-assign the
      // next integer for this project (race-safe via unique index).
      await db.upsertParcelForProject(project.id, {
        plotNumber: 0,
        label,
        trees: t,
        area: a > 0 ? a : 0,
        pricePerTree: 0,
        totalPrice: 0,
        status: 'available',
        treeBatches: batches,
      })
      emitInvalidate('projects')
      await refreshProjects()
    })
    if (res.ok) setModal(null)
  }
  const openEditPl = (pl) => {
    const batchRows = pl.treeBatches?.length
      ? pl.treeBatches.map((b) => ({
          year: Number(b.year) || CY,
          count: String(b.count ?? ''),
        }))
      : [{ year: CY, count: String(pl.trees ?? '') }]
    setPcf({
      id: String(pl.id),
      label: pl.label || '',
      trees: String(pl.trees),
      area: String(pl.area),
      pricePerTree: String(pl.pricePerTree),
      status: pl.status,
      dbId: pl.dbId,
      treeBatches: batchRows,
    })
    setModal({ type: 'edit-parcel', plotId: pl.id, plot: pl })
  }
  const saveEditPl = async (pl) => {
    const batches = normalizeBatchInput(pcf.treeBatches)
    const t = batches.length ? sumBatchTrees(batches) : Number(pcf.trees)
    const a = Number(pcf.area)
    if (!Number.isFinite(t) || t <= 0) return
    if (saving) return
    // Prix/arbre is no longer editable here — carry over the existing value.
    const pp = Number(pl.pricePerTree) || 0
    const label = String(pcf.label || '').trim().toLowerCase().slice(0, 16)
    const res = await runSafeAction({
      setBusy: setSaving, onError: reportOpError, label: 'Enregistrer la parcelle',
    }, async () => {
      await db.upsertParcelForProject(project.id, {
        dbId: pl.dbId || pcf.dbId,
        plotNumber: pl.id,
        label,
        trees: t,
        area: a > 0 ? a : pl.area,
        pricePerTree: pp,
        totalPrice: Math.max(0, t * pp),
        status: pcf.status || pl.status,
        treeBatches: batches,
      })
      emitInvalidate('projects')
      await refreshProjects()
    })
    if (res.ok) setModal(null)
  }

  const parcelBatchRows = pcf.treeBatches?.length ? pcf.treeBatches : [{ year: CY, count: '' }]
  const updateBatchRow = (idx, patch) => {
    setPcf((f) => {
      const rows = [...(f.treeBatches?.length ? f.treeBatches : [{ year: CY, count: '' }])]
      rows[idx] = { ...rows[idx], ...patch }
      return { ...f, treeBatches: rows }
    })
  }
  const addBatchRow = () => {
    setPcf((f) => ({
      ...f,
      treeBatches: [...(f.treeBatches?.length ? f.treeBatches : [{ year: CY, count: '' }]), { year: CY, count: '' }],
    }))
  }
  const removeBatchRow = (idx) => {
    setPcf((f) => {
      const rows = [...(f.treeBatches?.length ? f.treeBatches : [{ year: CY, count: '' }])]
      if (rows.length <= 1) return f
      rows.splice(idx, 1)
      return { ...f, treeBatches: rows }
    })
  }

  const delPl = async (dbId) => {
    if (saving) return
    const res = await runSafeAction({
      setBusy: setSaving, onError: reportOpError, label: 'Supprimer la parcelle',
    }, async () => {
      await db.deleteParcelById(dbId)
      emitInvalidate('projects')
      await refreshProjects()
    })
    if (res.ok) setModal(null)
  }

  const openAddO = () => { setOf(EMPTY_OFFER); setEoIdx(-1); setEditOfferDbId(null); setModal('offer') }
  const openEditO = (o, i) => {
    // Old rows predate the `mode` column — treat them as installments.
    const mode = o.mode === 'cash' ? 'cash' : 'installments'
    const pricePerSqm = Number(o.pricePerSqm ?? 0)
    setOf({
      label: o.name || o.label,
      mode,
      avancePct: String(o.downPayment ?? o.avancePct ?? ''),
      duration: String(o.duration ?? ''),
      cashAmount: String(o.cashAmount ?? ''),
      note: o.note || '',
      usePricePerSqm: pricePerSqm > 0,
      pricePerSqm: pricePerSqm > 0 ? String(pricePerSqm) : '',
    })
    setEoIdx(i); setEditOfferDbId(o.dbId || null); setModal('offer')
  }
  const saveO = async () => {
    if (!of.label.trim()) return
    if (saving) return
    const isCash = of.mode === 'cash'
    const payload = {
      dbId: editOfferDbId,
      label: of.label.trim(),
      note: of.note.trim(),
      mode: of.mode,
      avancePct: isCash ? 0 : (Number(of.avancePct) || 0),
      duration: isCash ? 0 : (Number(of.duration) || 0),
      cashAmount: isCash ? (Number(of.cashAmount) || 0) : 0,
      pricePerSqm: of.usePricePerSqm ? (Number(of.pricePerSqm) || 0) : 0,
    }
    const res = await runSafeAction({
      setBusy: setSaving, onError: reportOpError, label: 'Enregistrer l’offre',
    }, async () => {
      await db.upsertOffer(project.id, payload)
      await refreshOffers()
    })
    if (res.ok) setModal(null)
  }
  const delO = async () => {
    if (!editOfferDbId) return
    if (saving) return
    const res = await runSafeAction({
      setBusy: setSaving, onError: reportOpError, label: 'Supprimer l’offre',
    }, async () => {
      await db.deleteOffer(editOfferDbId)
      await refreshOffers()
    })
    if (res.ok) setModal(null)
  }

  // Plan 03 §6.6: a single <RenderDataGate> handles the four states
  // (loading / error / not-found-after-ready / found). Previously this was
  // hand-rolled inline and could get stuck on the skeleton if the list never
  // resolved. The gate is keyed on the projects list; the concrete "not
  // found" empty state fires only when the fetch is ready but the id does
  // not resolve.
  if (!project) {
    const listReady = !projectsLoading && !projectsError
    return (
      <div className="zitu-page" dir="ltr"><div className="pdp-root">
        <button type="button" className="ds-back-btn" onClick={() => navigate('/admin/projects')}>
          <span className="ds-back-btn__icon">←</span><span className="ds-back-btn__label">Projets</span>
        </button>
        <RenderDataGate
          loading={projectsLoading && projects.length === 0}
          error={projectsError}
          data={listReady ? [] : null}
          onRetry={refreshProjects}
          skeleton={<SkeletonDetail sections={4} lines={4} />}
          empty={
            <EmptyState
              icon="📭"
              title="Projet introuvable"
              hint="Ce projet n'existe plus ou a été supprimé."
              action={{ label: 'Retour à la liste', onClick: () => navigate('/admin/projects') }}
            />
          }
        >
          {() => null}
        </RenderDataGate>
      </div></div>
    )
  }

  const epData = typeof modal === 'object' && modal?.type === 'edit-parcel' ? modal : null

  const updateChecklistRow = (idx, patch) => {
    setChecklistItems((prev) => prev.map((row, i) => (i === idx ? { ...row, ...patch } : row)))
  }

  const moveChecklistRow = (idx, dir) => {
    setChecklistItems((prev) => {
      const target = idx + dir
      if (target < 0 || target >= prev.length) return prev
      const next = [...prev]
      const tmp = next[idx]
      next[idx] = next[target]
      next[target] = tmp
      return next
    })
  }

  return (
    <div className="zitu-page" dir="ltr">
      <div className="pdp-root">

        <button type="button" className="ds-back-btn" onClick={() => navigate('/admin/projects')}>
          <span className="ds-back-btn__icon">←</span><span className="ds-back-btn__label">Projets</span>
        </button>

        {opError && (
          <div className="pdp-alert pdp-alert--err" role="alert">{opError}</div>
        )}

        {/* ── Hero ── Map thumbnail + identity + progress */}
        {(() => {
          const engaged = Math.max(0, plots.length - avail)
          const engagedPct = plots.length > 0 ? Math.round((engaged / plots.length) * 100) : 0
          const monogram = String(project.title || 'P').trim().charAt(0).toUpperCase()
          return (
            <div className="pdp-hero">
              <div className="pdp-hero__visual" aria-hidden="true">
                {project.mapUrl ? (
                  <iframe
                    className="pdp-hero__map"
                    title="Carte du projet"
                    src={project.mapUrl}
                    loading="lazy"
                    tabIndex={-1}
                  />
                ) : (
                  <div className="pdp-hero__monogram">{monogram}</div>
                )}
              </div>
              <div className="pdp-hero__body">
                <div className="pdp-hero__tags">
                  <span className="pdp-hero__chip">PROJET FONCIER</span>
                  {project.year ? <span className="pdp-hero__chip pdp-hero__chip--muted">{project.year}</span> : null}
                </div>
                <h1 className="pdp-hero__title">{project.title}</h1>
                <p className="pdp-hero__meta">
                  <span className="pdp-hero__meta-icon" aria-hidden>📍</span>
                  <span>{project.address ? project.address : `${project.city || '—'}${project.region ? ` · ${project.region}` : ''}`}</span>
                  {totalAreaM2 > 0 ? (
                    <>
                      <span className="pdp-hero__meta-dot" aria-hidden>•</span>
                      <span>{fmtArea(totalAreaM2)}</span>
                    </>
                  ) : null}
                </p>

                <div className="pdp-hero__stats">
                  <div className="pdp-hero__stat">
                    <span className="pdp-hero__stat-num">{plots.length}</span>
                    <span className="pdp-hero__stat-unit">Parcelles</span>
                  </div>
                  <div className="pdp-hero__stat">
                    <span className="pdp-hero__stat-num">{totalTrees.toLocaleString('fr-FR')}</span>
                    <span className="pdp-hero__stat-unit">Arbres</span>
                  </div>
                </div>

                <div className="pdp-hero__progress" role="group" aria-label="Engagement des parcelles">
                  <div className="pdp-hero__progress-head">
                    <span className="pdp-hero__progress-label">Parcelles engagées</span>
                    <span className="pdp-hero__progress-val">
                      <strong>{engaged}</strong><span className="pdp-hero__progress-dim"> / {plots.length}</span>
                      <span className="pdp-hero__progress-pct">{engagedPct}%</span>
                    </span>
                  </div>
                  <div className="pdp-hero__progress-track" aria-hidden>
                    <div className="pdp-hero__progress-fill" style={{ width: `${engagedPct}%` }} />
                  </div>
                </div>
              </div>
            </div>
          )
        })()}

        {/* ── Action row — Modifier primary, destructive tucked right.
            The "+ Ajouter une parcelle" CTA lives in the Parcelles tab head. ── */}
        <div className="pdp-actions">
          <button type="button" className="pdp-btn pdp-btn--primary" onClick={openEdit}>
            <span className="pdp-btn__icon" aria-hidden>✎</span>
            <span>Modifier le projet</span>
          </button>
          <span className="pdp-actions__spacer" />
          <button
            type="button"
            className="pdp-btn pdp-btn--icon-danger"
            onClick={() => setConfirmDelete(true)}
            aria-label="Supprimer le projet"
            title="Supprimer le projet"
          >
            <svg aria-hidden width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M3 6h18" />
              <path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
              <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
              <path d="M10 11v6" />
              <path d="M14 11v6" />
            </svg>
          </button>
        </div>

        {/* ── KPI strip — 4 dashboard cards with icon + hue ── */}
        <div className="pdp-kpi-strip">
          <div className="pdp-kpi pdp-kpi--blue">
            <div className="pdp-kpi__glyph" aria-hidden>
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <line x1="12" y1="1" x2="12" y2="23" /><path d="M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6" />
              </svg>
            </div>
            <div className="pdp-kpi__main">
              <span className="pdp-kpi__label">Valeur totale</span>
              <span className="pdp-kpi__value">{fmt(totalValue)}</span>
            </div>
          </div>

          <div className="pdp-kpi pdp-kpi--green">
            <div className="pdp-kpi__glyph" aria-hidden>
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="23 6 13.5 15.5 8.5 10.5 1 18" /><polyline points="17 6 23 6 23 12" />
              </svg>
            </div>
            <div className="pdp-kpi__main">
              <span className="pdp-kpi__label">Revenu est. / an</span>
              <span className="pdp-kpi__value pdp-kpi__value--accent">~{fmt(totalRevenue)}</span>
            </div>
          </div>

          <div className="pdp-kpi pdp-kpi--amber">
            <div className="pdp-kpi__glyph" aria-hidden>
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <rect x="3" y="3" width="18" height="18" rx="2" /><line x1="3" y1="9" x2="21" y2="9" /><line x1="9" y1="21" x2="9" y2="9" />
              </svg>
            </div>
            <div className="pdp-kpi__main">
              <span className="pdp-kpi__label">Parcelles dispo.</span>
              <span className="pdp-kpi__value">
                {avail}<span className="pdp-kpi__value-suffix"> / {plots.length}</span>
              </span>
              <div className="pdp-kpi__bar" aria-hidden>
                <div
                  className="pdp-kpi__bar-fill"
                  style={{ width: `${plots.length ? Math.round((avail / plots.length) * 100) : 0}%` }}
                />
              </div>
            </div>
          </div>

          <div className="pdp-kpi pdp-kpi--violet">
            <div className="pdp-kpi__glyph" aria-hidden>
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M20.59 13.41l-7.17 7.17a2 2 0 0 1-2.83 0L2 12V2h10l8.59 8.59a2 2 0 0 1 0 2.82z" /><line x1="7" y1="7" x2="7.01" y2="7" />
              </svg>
            </div>
            <div className="pdp-kpi__main">
              <span className="pdp-kpi__label">Offres actives</span>
              <span className="pdp-kpi__value">{offers.length}</span>
            </div>
          </div>
        </div>

        {/* ── Tabs — split the heavy config into focused workspaces ── */}
        <div className="pdp-tabs" role="tablist" aria-label="Sections du projet">
          {[
            { k: 'overview',    label: 'Aperçu',      icon: '🏠' },
            { k: 'workflow',    label: 'Workflow',    icon: '⚙️' },
            { k: 'commissions', label: 'Commissions', icon: '💰' },
            { k: 'parcels',     label: 'Parcelles',   icon: '🗺️', count: plots.length },
            { k: 'offers',      label: 'Offres',      icon: '🏷️', count: offers.length },
          ].map((t) => (
            <button
              key={t.k}
              type="button"
              role="tab"
              aria-selected={activeTab === t.k}
              className={`pdp-tab${activeTab === t.k ? ' pdp-tab--active' : ''}`}
              onClick={() => setActiveTab(t.k)}
            >
              <span className="pdp-tab__icon" aria-hidden>{t.icon}</span>
              <span className="pdp-tab__label">{t.label}</span>
              {t.count != null ? <span className="pdp-tab__count">{t.count}</span> : null}
            </button>
          ))}
        </div>

        {/* ── Tab: Aperçu (Santé du projet) ── */}
        {activeTab === 'overview' && (() => {
          // Snapshot of the last-applied values so we can show Apply/Cancel
          // only when the user actually edits something.
          const savedHealth = healthSaved[project?.id] || { ...DH }
          const isDirty = (
            Number(projHealth.treeSante) !== Number(savedHealth.treeSante) ||
            Number(projHealth.humidity) !== Number(savedHealth.humidity) ||
            Number(projHealth.nutrients) !== Number(savedHealth.nutrients)
          )
          const statusFor = (v) => {
            const n = Number(v) || 0
            if (n >= 85) return { key: 'great', label: 'Excellent', color: '#059669', bg: '#ecfdf5', border: '#a7f3d0' }
            if (n >= 70) return { key: 'good',  label: 'Bon',       color: '#1d4ed8', bg: '#eff6ff', border: '#bfdbfe' }
            if (n >= 50) return { key: 'fair',  label: 'Moyen',     color: '#b45309', bg: '#fffbeb', border: '#fde68a' }
            return            { key: 'low',   label: 'Critique',  color: '#b91c1c', bg: '#fef2f2', border: '#fecaca' }
          }
          const metrics = [
            { k: 'treeSante', l: 'Santé des arbres', icon: '🌳' },
            { k: 'humidity',  l: 'Humidité du sol',  icon: '💧' },
            { k: 'nutrients', l: 'Nutriments',       icon: '🌱' },
          ]
          return (
            <section className="pdp-section">
              <div className="pdp-section__head">
                <span className="pdp-section__badge" aria-hidden>✦</span>
                <div className="pdp-section__body">
                  <h2 className="pdp-section__title">Santé du projet</h2>
                </div>
                {isDirty ? (
                  <div className="pdp-section__actions pdp-health__actions">
                    <span className="pdp-health__dirty" aria-live="polite">● Modifications non enregistrées</span>
                    <button type="button" className="pdp-btn pdp-btn--ghost" onClick={cancelHealth}>Annuler</button>
                    <button type="button" className="pdp-btn pdp-btn--primary" onClick={applyHealth}>Appliquer</button>
                  </div>
                ) : null}
              </div>

              <div className="pdp-health">
                {metrics.map(({ k, l, icon }) => {
                  const v = Number(projHealth[k]) || 0
                  const st = statusFor(v)
                  // SVG gauge math — circumference for r=42 is 2πr ≈ 263.89
                  const circ = 263.89
                  const dash = (v / 100) * circ
                  return (
                    <div key={k} className="pdp-health-item">
                      <div className="pdp-health-item__gauge" aria-hidden>
                        <svg viewBox="0 0 100 100" className="pdp-health-item__svg">
                          <circle cx="50" cy="50" r="42" className="pdp-health-item__track" />
                          <circle
                            cx="50" cy="50" r="42"
                            className="pdp-health-item__arc"
                            style={{ stroke: st.color, strokeDasharray: `${dash} ${circ - dash}` }}
                          />
                        </svg>
                        <div className="pdp-health-item__center">
                          <span className="pdp-health-item__icon">{icon}</span>
                          <span className="pdp-health-item__pct" style={{ color: st.color }}>{v}<small>%</small></span>
                        </div>
                      </div>
                      <div className="pdp-health-item__meta">
                        <span className="pdp-health-item__label">{l}</span>
                        <span
                          className="pdp-health-item__status"
                          style={{ color: st.color, background: st.bg, borderColor: st.border }}
                        >
                          {st.label}
                        </span>
                      </div>
                      <input
                        type="range" min="0" max="100"
                        value={v}
                        onChange={(e) => setHealth(k, e.target.value)}
                        className="pdp-health-item__slider"
                        style={{ '--thumb-color': st.color, '--fill-color': st.color, '--fill-pct': `${v}%` }}
                        aria-label={l}
                      />
                    </div>
                  )
                })}
              </div>
            </section>
          )
        })()}

        {/* ── Tab: Workflow ── */}
        {activeTab === 'workflow' && (
        <section className="pdp-section">
          <div className="pdp-section__head">
            <div className="pdp-section__body">
              <h2 className="pdp-section__title">Workflow de vente &amp; frais{workflowLoading ? <span className="pdp-section__hint" style={{ marginLeft: 8 }}>(chargement…)</span> : null}</h2>
            </div>
            <div className="pdp-section__actions">
              <button type="button" className="pdp-btn" onClick={() => setModal('wf-config')} aria-label="Modifier les paramètres">
                <span className="pdp-btn__icon" aria-hidden>✎</span>
                <span>Modifier</span>
              </button>
            </div>
          </div>

          {/* Compact read-only summary of the 5 config values */}
          <div className="pdp-wf-summary">
            <div className="pdp-wf-chip"><span className="pdp-wf-chip__lbl">Frais société</span><span className="pdp-wf-chip__val">{wfCompany}<small>%</small></span></div>
            <div className="pdp-wf-chip"><span className="pdp-wf-chip__lbl">Frais notaire</span><span className="pdp-wf-chip__val">{wfNotary}<small>%</small></span></div>
            <div className="pdp-wf-chip"><span className="pdp-wf-chip__lbl">Seuil payout</span><span className="pdp-wf-chip__val">{wfMinPay}<small> TND</small></span></div>
            <div className="pdp-wf-chip"><span className="pdp-wf-chip__lbl">Réservation</span><span className="pdp-wf-chip__val">{wfResH}<small> h</small></span></div>
            <div className="pdp-wf-chip"><span className="pdp-wf-chip__lbl">Arabon défaut</span><span className="pdp-wf-chip__val">{wfArabon}<small> TND</small></span></div>
          </div>

          {/* Checklist — compact row list */}
          <div className="pdp-wf-checklist-head">
            <h3 className="pdp-wf-subtitle">Checklist notaire {checklistItems.length > 0 ? <span className="pdp-section__count-chip">{checklistItems.length}</span> : null}</h3>
            <button type="button" className="pdp-btn pdp-btn--sm" onClick={() => openChecklistEdit(-1)}>
              <span className="pdp-btn__icon" aria-hidden>＋</span>
              <span>Ajouter</span>
            </button>
          </div>

          <div className="pdp-wf-checklist">
            {checklistItems.length === 0 ? (
              <div className="pdp-empty pdp-empty--sm">
                <div className="pdp-empty__icon">📋</div>
                <strong className="pdp-empty__title">Aucun document</strong>
                <p className="pdp-empty__hint">Cliquez sur « Ajouter » pour créer le premier.</p>
              </div>
            ) : checklistItems.map((item, idx) => {
              const pagesCount = String(item.grantAllowedPagesText || '').split(',').map(s => s.trim()).filter(Boolean).length
              const required = item.required !== false
              return (
                <div key={`${idx}-${item.key}`} className="pdp-wf-row">
                  <span className="pdp-wf-row__idx">#{idx + 1}</span>
                  <button
                    type="button"
                    className="pdp-wf-row__main"
                    onClick={() => openChecklistEdit(idx)}
                    aria-label={`Modifier ${item.label || item.key || 'document'}`}
                  >
                    <span className="pdp-wf-row__label">{item.label || <em>Libellé manquant</em>}</span>
                    <span className="pdp-wf-row__meta">
                      <code className="pdp-wf-row__key">{item.key || '—'}</code>
                      <span className={`pdp-wf-row__pill ${required ? 'pdp-wf-row__pill--req' : 'pdp-wf-row__pill--opt'}`}>
                        {required ? 'Obligatoire' : 'Optionnel'}
                      </span>
                      {pagesCount > 0 ? (
                        <span className="pdp-wf-row__pill pdp-wf-row__pill--pages" title="Pages accordées">
                          🔑 {pagesCount} page{pagesCount > 1 ? 's' : ''}
                        </span>
                      ) : null}
                    </span>
                  </button>
                  <div className="pdp-wf-row__controls">
                    <button type="button" className="pdp-wf-ctl" onClick={() => moveChecklistRow(idx, -1)} aria-label="Monter" disabled={idx === 0}>↑</button>
                    <button type="button" className="pdp-wf-ctl" onClick={() => moveChecklistRow(idx, 1)} aria-label="Descendre" disabled={idx === checklistItems.length - 1}>↓</button>
                    <button
                      type="button"
                      className="pdp-wf-ctl pdp-wf-ctl--danger"
                      onClick={() => setChecklistItems((prev) => prev.filter((_, i) => i !== idx))}
                      aria-label="Supprimer"
                      title="Supprimer"
                    >
                      <svg aria-hidden width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M3 6h18" /><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" /><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
                      </svg>
                    </button>
                  </div>
                </div>
              )
            })}
          </div>

          {wfMsg ? (
            <div className={`pdp-alert ${wfErr ? 'pdp-alert--err' : 'pdp-alert--ok'}`}>{wfMsg}</div>
          ) : null}
          <div className="pdp-section__footer">
            <button type="button" className="pdp-btn pdp-btn--primary" disabled={workflowLoading} onClick={() => void saveWorkflowConfig()}>
              {workflowLoading ? 'Chargement…' : 'Enregistrer le workflow'}
            </button>
          </div>
        </section>
        )}

        {/* ── Tab: Commissions ── */}
        {activeTab === 'commissions' && (
        <section className="pdp-section">
          <div className="pdp-section__head">
            <div className="pdp-section__body">
              <h2 className="pdp-section__title">Commissions parrainage</h2>
              <p className="pdp-section__hint">
                Règles L1 / L2 / L3 versées aux parrains. Le <strong>seuil payout</strong> (onglet Workflow) détermine quand ils peuvent retirer.
              </p>
            </div>
          </div>

          <CommissionRulesEditor projectId={project?.id || ''} />
        </section>
        )}

        {/* ── Tab: Parcelles ── */}
        {activeTab === 'parcels' && (
        <section className="pdp-section">
          <div className="pdp-section__head">
            <div className="pdp-section__body">
              <h2 className="pdp-section__title">
                Parcelles
                <span className="pdp-section__count-chip">{plots.length}</span>
              </h2>
              <p className="pdp-section__hint">Cliquez une ligne pour modifier (arbres, prix, statut). Utilisez la recherche pour filtrer.</p>
            </div>
            <div className="pdp-section__actions">
              <button type="button" className="pdp-btn pdp-btn--primary" onClick={openAdd}>
                <span className="pdp-btn__icon" aria-hidden>＋</span>
                <span>Ajouter une parcelle</span>
              </button>
            </div>
          </div>

          <div className="pdp-search-row">
            <div className="pdp-search-wrap">
              <span className="pdp-search-wrap__icon" aria-hidden>🔎</span>
              <input className="pdp-search" placeholder="Rechercher : identifiant, arbres, surface…" value={parcelQ} onChange={e => setParcelQ(e.target.value)} />
            </div>
          </div>

          {plots.length === 0 ? (
            <div className="pdp-empty">
              <div className="pdp-empty__icon">🌱</div>
              <strong className="pdp-empty__title">Aucune parcelle pour ce projet</strong>
              <p className="pdp-empty__hint">Ajoutez votre première parcelle pour commencer.</p>
              <button type="button" className="pdp-btn pdp-btn--primary" onClick={openAdd}>+ Ajouter une parcelle</button>
            </div>
          ) : filteredPlots.length === 0 ? (
            <div className="pdp-empty">
              <div className="pdp-empty__icon">🔍</div>
              <strong className="pdp-empty__title">Aucun résultat</strong>
              <p className="pdp-empty__hint">Aucune parcelle ne correspond à « {parcelQ} ».</p>
              <button type="button" className="pdp-btn" onClick={() => setParcelQ('')}>Effacer la recherche</button>
            </div>
          ) : (
            <>
              <div className="pdp-parcel-table-wrap">
                <div className="pdp-parcel-table-scroll">
                  <table className="pdp-parcel-table">
                    <thead>
                      <tr>
                        <th>Parcelle</th>
                        <th>Arbres</th>
                        <th>m²</th>
                        <th>Prix</th>
                        <th>Statut</th>
                      </tr>
                    </thead>
                    <tbody>
                      {filteredPlots.map(pl => (
                        <tr key={pl.dbId || pl.id} onClick={() => openEditPl(pl)}>
                          <td className="pdp-td--id">{pl.label || pl.id}</td>
                          <td className="pdp-td--strong">{pl.trees}</td>
                          <td>{pl.area}</td>
                          <td className="pdp-td--strong">{(Number(pl.totalPrice) || 0).toLocaleString('fr-FR')}</td>
                          <td><span className={pillCls(pl.status)}>{sLbl(pl.status)}</span></td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
              <div className="pdp-results-count">{filteredPlots.length}/{plots.length} parcelle{plots.length > 1 ? 's' : ''} affichée{filteredPlots.length > 1 ? 's' : ''}</div>
            </>
          )}
        </section>
        )}

        {/* ── Tab: Offres ── */}
        {activeTab === 'offers' && (
        <section className="pdp-section">
          <div className="pdp-section__head">
            <div className="pdp-section__body">
              <h2 className="pdp-section__title">
                Offres de paiement
                <span className="pdp-section__count-chip">{offers.length}</span>
              </h2>
              <p className="pdp-section__hint">Formules d'achat proposées au client (avance + mensualités). Simulation sur le prix moyen d'une parcelle.</p>
            </div>
            <div className="pdp-section__actions">
              <button type="button" className="pdp-btn pdp-btn--primary pdp-btn--sm" onClick={openAddO}>+ Offre</button>
            </div>
          </div>

          {offers.length === 0 ? (
            <div className="pdp-empty">
              <div className="pdp-empty__icon">💳</div>
              <strong className="pdp-empty__title">Aucune offre de paiement</strong>
              <p className="pdp-empty__hint">Créez une formule (ex. « 20% avance, 24 mois ») pour que les clients puissent choisir.</p>
              <button type="button" className="pdp-btn pdp-btn--primary" onClick={openAddO}>+ Créer une offre</button>
            </div>
          ) : (
            <div className="pdp-offers">{offers.map((o, i) => {
              const isCash = o.mode === 'cash'
              const pv = !isCash && avgPrice && o.duration
                ? { mo: (avgPrice - avgPrice * (o.downPayment ?? o.avancePct ?? 0) / 100) / o.duration }
                : null
              return (
                <button key={o.dbId || i} type="button" className="pdp-offer-card" onClick={() => openEditO(o, i)}>
                  <div className="pdp-offer-card__top">
                    <span className="pdp-offer-card__name">{o.name || o.label}</span>
                    {o.note && <span className="pdp-offer-card__note">{o.note}</span>}
                  </div>
                  <div className="pdp-offer-card__meta">
                    {isCash ? (
                      <>
                        <span><strong>Comptant</strong></span>
                        {Number(o.cashAmount) > 0 && (<><span>·</span><span><strong>{Number(o.cashAmount).toLocaleString('fr-FR')}</strong> DT</span></>)}
                      </>
                    ) : (
                      <>
                        <span><strong>{o.downPayment ?? o.avancePct}%</strong> avance</span>
                        <span>·</span>
                        <span><strong>{o.duration}</strong> mois</span>
                        {pv && <><span>·</span><span>~<strong>{Math.round(pv.mo).toLocaleString('fr-FR')}</strong> DT/mois</span></>}
                      </>
                    )}
                    {Number(o.pricePerSqm) > 0 && (<><span>·</span><span>{Number(o.pricePerSqm).toLocaleString('fr-FR')} DT/m²</span></>)}
                  </div>
                </button>
              )
            })}</div>
          )}
        </section>
        )}

        {/* ── Modals ── */}
        <AdminModal open={modal === 'edit'} onClose={() => setModal(null)} title="Modifier le projet">
          <div className="pdp-modal-body">
            <div className="zitu-page__field"><label className="zitu-page__field-label">Nom</label><input className="zitu-page__input" value={pf.title} onChange={e => setPf(f => ({ ...f, title: e.target.value }))} /></div>
            <div className="zitu-page__form-grid">
              <div className="zitu-page__field"><label className="zitu-page__field-label">Ville</label><input className="zitu-page__input" value={pf.city} onChange={e => setPf(f => ({ ...f, city: e.target.value }))} /></div>
              <div className="zitu-page__field"><label className="zitu-page__field-label">Région</label><input className="zitu-page__input" value={pf.region} onChange={e => setPf(f => ({ ...f, region: e.target.value }))} /></div>
            </div>
            <div className="zitu-page__field">
              <label className="zitu-page__field-label">Superficie</label>
              <div className="zitu-page__input" style={{ display: 'flex', alignItems: 'center', background: '#f8fafc', color: '#0f172a', cursor: 'default' }} aria-readonly="true">
                {fmtArea(totalAreaM2)}
              </div>
              <span className="pdp-field__hint">Calculée automatiquement d'après les parcelles.</span>
            </div>
            <div className="zitu-page__field"><label className="zitu-page__field-label">Adresse</label><input className="zitu-page__input" placeholder="Ex : 12 rue des Oliviers, Borj Cedria" value={pf.address || ''} onChange={e => setPf(f => ({ ...f, address: e.target.value }))} /></div>
            <div className="zitu-page__field"><label className="zitu-page__field-label">URL carte</label><input className="zitu-page__input" value={pf.mapUrl} onChange={e => setPf(f => ({ ...f, mapUrl: e.target.value }))} /></div>
            <div className="zitu-page__form-actions">
              <button type="button" className="zitu-page__btn zitu-page__btn--danger" disabled={saving} onClick={delProject}>Supprimer</button>
              <button type="button" className="zitu-page__btn" onClick={() => setModal(null)}>Annuler</button>
              <button type="button" className="zitu-page__btn zitu-page__btn--primary" disabled={saving} onClick={saveEdit}>{saving ? 'Enregistrement…' : 'Enregistrer'}</button>
            </div>
          </div>
        </AdminModal>

        <AdminModal open={modal === 'add-parcel'} onClose={() => setModal(null)} title="Ajouter une parcelle">
          <div className="pdp-modal-body">
            <div className="zitu-page__field">
              <label className="zitu-page__field-label">Identifiant *</label>
              <input
                className="zitu-page__input"
                type="text"
                maxLength={16}
                placeholder="a1, b1, 1, A-42…"
                value={pcf.label}
                onChange={e => setPcf(f => ({ ...f, label: e.target.value }))}
              />
              <span className="pdp-field__hint">Texte libre, unique dans le projet. Le n° interne est attribué automatiquement.</span>
            </div>
            <div className="pdp-batches pdp-batches--edit">
              <div className="pdp-field__label">Composition du verger *</div>
              <p className="pdp-field__hint" style={{ margin: '0 0 8px' }}>Une ligne par cohorte (année de plantation + nombre d’arbres). Le total alimente le catalogue comme sur le site public.</p>
              {parcelBatchRows.map((b, i) => {
                const info = ti(Number(b.year) || CY)
                return (
                  <div key={i} className="pdp-batch-edit-row">
                    <label className="pdp-batch-edit-row__field">
                      <span className="pdp-batch-edit-row__lbl">Année</span>
                      <input
                        className="zitu-page__input"
                        type="number"
                        min={1980}
                        max={2035}
                        placeholder={String(CY)}
                        value={b.year}
                        onChange={(e) => updateBatchRow(i, { year: e.target.value })}
                      />
                    </label>
                    <label className="pdp-batch-edit-row__field">
                      <span className="pdp-batch-edit-row__lbl">Arbres</span>
                      <input
                        className="zitu-page__input"
                        type="number"
                        min={0}
                        placeholder="120"
                        value={b.count}
                        onChange={(e) => updateBatchRow(i, { count: e.target.value })}
                      />
                    </label>
                    <div className="pdp-batch-edit-row__meta" title="Aperçu productivité">
                      <span className="pdp-batch-edit-row__age">{CY - (Number(b.year) || CY)}a · {info.label}</span>
                      {Number(b.count) > 0 && info.rate > 0 && (
                        <span className="pdp-batch-edit-row__rev">~{Math.round(Number(b.count) * info.rate).toLocaleString('fr-FR')} DT/an</span>
                      )}
                      {Number(b.count) > 0 && info.rate === 0 && <span className="pdp-batch-edit-row__rev">Non prod.</span>}
                    </div>
                    <button
                      type="button"
                      className="pdp-batch-edit-row__rm"
                      disabled={parcelBatchRows.length <= 1}
                      onClick={() => removeBatchRow(i)}
                      aria-label="Retirer cette cohorte"
                    >
                      −
                    </button>
                  </div>
                )
              })}
              <button type="button" className="pdp-batch-add" onClick={addBatchRow}>
                + Ajouter une génération
              </button>
              <div className="pdp-batch-total">
                Total : <strong>{sumBatchTrees(normalizeBatchInput(pcf.treeBatches)).toLocaleString('fr-FR')}</strong> arbres
              </div>
            </div>
            <div className="zitu-page__field"><label className="zitu-page__field-label">Surface m²</label><input className="zitu-page__input" type="number" placeholder="400" value={pcf.area} onChange={e => setPcf(f => ({ ...f, area: e.target.value }))} /></div>
            <p className="pdp-field__hint" style={{ margin: 0 }}>La nouvelle parcelle est créée avec le statut <strong>Disponible</strong>. Le prix se règle depuis l’édition de la parcelle.</p>
            <div className="zitu-page__form-actions">
              <button type="button" className="zitu-page__btn" onClick={() => setModal(null)}>Annuler</button>
              <button
                type="button"
                className="zitu-page__btn zitu-page__btn--primary"
                disabled={
                  !String(pcf.label || '').trim()
                  || sumBatchTrees(normalizeBatchInput(pcf.treeBatches)) <= 0
                  || saving
                }
                onClick={saveNew}
              >
                {saving ? 'Ajout…' : 'Ajouter'}
              </button>
            </div>
          </div>
        </AdminModal>

        {/* ── Workflow config modal (5 fee inputs) ── */}
        <AdminModal open={modal === 'wf-config'} onClose={() => setModal(null)} title="Paramètres du workflow">
          <div className="pdp-modal-body">
            <p className="pdp-section__hint" style={{ margin: '0 0 12px' }}>
              Ces valeurs s'appliquent aux <strong>nouvelles ventes</strong> uniquement.
            </p>
            <div className="zitu-page__form-grid">
              <div className="zitu-page__field">
                <label className="zitu-page__field-label">Frais société (%)</label>
                <input className="zitu-page__input" type="number" value={wfCompany} onChange={(e) => setWfCompany(Number(e.target.value))} />
                <span className="pdp-field__hint">Commission Zitouna prélevée sur la vente.</span>
              </div>
              <div className="zitu-page__field">
                <label className="zitu-page__field-label">Frais notaire (%)</label>
                <input className="zitu-page__input" type="number" value={wfNotary} onChange={(e) => setWfNotary(Number(e.target.value))} />
                <span className="pdp-field__hint">Frais d'acte transférés au notaire.</span>
              </div>
            </div>
            <div className="zitu-page__form-grid">
              <div className="zitu-page__field">
                <label className="zitu-page__field-label">Réservation (heures)</label>
                <input className="zitu-page__input" type="number" value={wfResH} onChange={(e) => setWfResH(Number(e.target.value))} />
                <span className="pdp-field__hint">Durée pendant laquelle la parcelle reste bloquée après arabon.</span>
              </div>
              <div className="zitu-page__field">
                <label className="zitu-page__field-label">Arabon défaut (TND)</label>
                <input className="zitu-page__input" type="number" value={wfArabon} onChange={(e) => setWfArabon(Number(e.target.value))} />
                <span className="pdp-field__hint">Acompte proposé par défaut au moment de la réservation.</span>
              </div>
            </div>
            <div className="zitu-page__field">
              <label className="zitu-page__field-label">Seuil payout min. (TND)</label>
              <input className="zitu-page__input" type="number" value={wfMinPay} onChange={(e) => setWfMinPay(Number(e.target.value))} />
              <span className="pdp-field__hint">Plancher de <strong>retrait</strong> du portefeuille parrainage — pas le montant L1/L2.</span>
            </div>

            <div className="pdp-section__hint" style={{ margin: '12px 0 4px', fontWeight: 700 }}>Échéancier par défaut</div>
            <div className="zitu-page__form-grid">
              <div className="zitu-page__field">
                <label className="zitu-page__field-label">Avance par défaut (TND)</label>
                <input className="zitu-page__input" type="number" value={wfAdvance} placeholder="Ex : 5000" onChange={(e) => setWfAdvance(e.target.value)} />
                <span className="pdp-field__hint">Montant d'acompte pré-rempli au moment de la vente.</span>
              </div>
              <div className="zitu-page__field">
                <label className="zitu-page__field-label">1ʳᵉ échéance</label>
                <input className="zitu-page__input" type="date" value={wfFirstDue} onChange={(e) => setWfFirstDue(e.target.value)} />
                <span className="pdp-field__hint">Date du premier paiement d'échéance proposée.</span>
              </div>
              <div className="zitu-page__field">
                <label className="zitu-page__field-label">Dernière échéance</label>
                <input className="zitu-page__input" type="date" value={wfEndDue} onChange={(e) => setWfEndDue(e.target.value)} />
                <span className="pdp-field__hint">Date de la dernière échéance proposée.</span>
              </div>
            </div>

            <div className="zitu-page__form-actions">
              <button type="button" className="zitu-page__btn" onClick={() => setModal(null)}>Fermer</button>
              <button type="button" className="zitu-page__btn zitu-page__btn--primary" onClick={() => setModal(null)}>Valider</button>
            </div>
          </div>
        </AdminModal>

        {/* ── Checklist item edit modal ── */}
        <AdminModal
          open={modal === 'wf-checklist'}
          onClose={() => setModal(null)}
          title={checklistDraft.idx === -1 ? 'Nouveau document' : `Modifier document #${checklistDraft.idx + 1}`}
        >
          <div className="pdp-modal-body">
            <div className="zitu-page__field">
              <label className="zitu-page__field-label">Clé technique *</label>
              <input
                className="zitu-page__input"
                placeholder="ex : contract"
                value={checklistDraft.key}
                onChange={(e) => setChecklistDraft((d) => ({ ...d, key: e.target.value }))}
              />
              <span className="pdp-field__hint">Identifiant interne (sans espaces). Sert à lier le document au système.</span>
            </div>
            <div className="zitu-page__field">
              <label className="zitu-page__field-label">Libellé affiché *</label>
              <input
                className="zitu-page__input"
                placeholder="ex : Contrat de vente signé"
                value={checklistDraft.label}
                onChange={(e) => setChecklistDraft((d) => ({ ...d, label: e.target.value }))}
              />
              <span className="pdp-field__hint">Texte vu par le notaire dans la checklist.</span>
            </div>
            <div className="zitu-page__field">
              <label className="zitu-page__field-label">Pages accordées (optionnel)</label>
              <input
                className="zitu-page__input"
                placeholder="ex : /admin/sell, /admin/reports"
                value={checklistDraft.grantAllowedPagesText}
                onChange={(e) => setChecklistDraft((d) => ({ ...d, grantAllowedPagesText: e.target.value }))}
              />
              <span className="pdp-field__hint">Séparez les pages par une virgule. Laissez vide si non applicable.</span>
            </div>
            <label className="pdp-check-row">
              <input
                type="checkbox"
                checked={checklistDraft.required}
                onChange={(e) => setChecklistDraft((d) => ({ ...d, required: e.target.checked }))}
              />
              Document obligatoire
            </label>
            <div className="zitu-page__form-actions">
              <button type="button" className="zitu-page__btn" onClick={() => setModal(null)}>Annuler</button>
              <button
                type="button"
                className="zitu-page__btn zitu-page__btn--primary"
                disabled={!checklistDraft.key.trim() || !checklistDraft.label.trim()}
                onClick={saveChecklistDraft}
              >
                {checklistDraft.idx === -1 ? 'Ajouter' : 'Enregistrer'}
              </button>
            </div>
          </div>
        </AdminModal>

        <AdminModal open={modal === 'offer'} onClose={() => setModal(null)} title={eoIdx >= 0 ? "Modifier l'offre" : 'Nouvelle offre'}>
          <div className="pdp-modal-body">
            <div className="zitu-page__field"><label className="zitu-page__field-label">Nom *</label><input className="zitu-page__input" placeholder="Essentiel 20/24" value={of.label} onChange={e => setOf(f => ({ ...f, label: e.target.value }))} /></div>

            {/* Mode de paiement — segmented control. 'cash' collapses the
                installment fields to a single "Montant total" input. */}
            <div className="zitu-page__field">
              <label className="zitu-page__field-label">Mode de paiement</label>
              <div role="radiogroup" aria-label="Mode de paiement" style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
                {[
                  { v: 'cash', lbl: '💵 Comptant' },
                  { v: 'installments', lbl: '📅 Versements' },
                ].map((opt) => {
                  const active = of.mode === opt.v
                  return (
                    <button
                      key={opt.v}
                      type="button"
                      role="radio"
                      aria-checked={active}
                      onClick={() => setOf((f) => ({ ...f, mode: opt.v }))}
                      className={`pdp-btn${active ? ' pdp-btn--primary' : ''}`}
                      style={{ justifyContent: 'center' }}
                    >
                      {opt.lbl}
                    </button>
                  )
                })}
              </div>
            </div>

            {of.mode === 'cash' ? (
              <div className="zitu-page__field">
                <label className="zitu-page__field-label">Montant total (DT)</label>
                <input className="zitu-page__input" type="number" placeholder="18000" value={of.cashAmount} onChange={e => setOf(f => ({ ...f, cashAmount: e.target.value }))} />
                <span className="pdp-field__hint">Prix unique à régler en une fois.</span>
              </div>
            ) : (
              <div className="zitu-page__form-grid">
                <div className="zitu-page__field"><label className="zitu-page__field-label">Avance %</label><input className="zitu-page__input" type="number" placeholder="20" value={of.avancePct} onChange={e => setOf(f => ({ ...f, avancePct: e.target.value }))} /></div>
                <div className="zitu-page__field"><label className="zitu-page__field-label">Mois</label><input className="zitu-page__input" type="number" placeholder="24" value={of.duration} onChange={e => setOf(f => ({ ...f, duration: e.target.value }))} /></div>
              </div>
            )}

            <div className="zitu-page__field"><label className="zitu-page__field-label">Note</label><input className="zitu-page__input" placeholder="Le plus populaire…" value={of.note} onChange={e => setOf(f => ({ ...f, note: e.target.value }))} /></div>

            {/* Optional m² pricing metadata — the full pricing math isn't wired
                here yet; we just persist the value so downstream code can use it. */}
            <label className="pdp-check-row">
              <input
                type="checkbox"
                checked={!!of.usePricePerSqm}
                onChange={(e) => setOf((f) => ({ ...f, usePricePerSqm: e.target.checked }))}
              />
              Calcul au prix du m²
            </label>
            {of.usePricePerSqm && (
              <div className="zitu-page__field">
                <label className="zitu-page__field-label">Prix / m² (DT)</label>
                <input className="zitu-page__input" type="number" placeholder="120" value={of.pricePerSqm} onChange={e => setOf(f => ({ ...f, pricePerSqm: e.target.value }))} />
              </div>
            )}

            {of.mode !== 'cash' && avgPrice > 0 && Number(of.avancePct) > 0 && Number(of.duration) > 0 && (
              <div className="pdp-offer-preview">
                <span className="pdp-offer-preview__label">Simulation (parcelle moy. {fmt(avgPrice)})</span>
                <div className="pdp-offer-preview__row"><span>Avance</span><strong>{fmt(avgPrice * Number(of.avancePct) / 100)}</strong></div>
                <div className="pdp-offer-preview__row"><span>Mensualité</span><strong>{fmt((avgPrice - avgPrice * Number(of.avancePct) / 100) / Number(of.duration))}</strong></div>
              </div>
            )}
            <div className="zitu-page__form-actions">
              {eoIdx >= 0 && editOfferDbId && <button type="button" className="zitu-page__btn zitu-page__btn--danger" disabled={saving} onClick={delO}>Supprimer</button>}
              <button type="button" className="zitu-page__btn" onClick={() => setModal(null)}>Annuler</button>
              <button type="button" className="zitu-page__btn zitu-page__btn--primary" disabled={!of.label.trim() || saving} onClick={saveO}>{saving ? 'Enregistrement…' : eoIdx >= 0 ? 'Enregistrer' : 'Ajouter'}</button>
            </div>
          </div>
        </AdminModal>

        <AdminModal open={confirmDelete} onClose={() => setConfirmDelete(false)} title="Supprimer le projet ?">
          <div className="pdp-modal-body">
            <p className="pdp-confirm-text">
              Cette action supprimera définitivement le projet <strong>{project.title}</strong> ainsi que ses parcelles et offres associées. Cette opération est <strong className="pdp-confirm-text__danger">irréversible</strong>.
            </p>
            <div className="zitu-page__form-actions">
              <button type="button" className="zitu-page__btn" onClick={() => setConfirmDelete(false)}>Annuler</button>
              <button type="button" className="zitu-page__btn zitu-page__btn--danger" disabled={saving} onClick={() => { setConfirmDelete(false); void delProject() }}>Supprimer définitivement</button>
            </div>
          </div>
        </AdminModal>

        {epData && (
          <div className="prj-overlay" onClick={() => setModal(null)}><div className="prj-sheet" onClick={e => e.stopPropagation()}>
            <div className="prj-sheet__head">
              <h3 className="prj-sheet__title">
                Parcelle {epData.plot?.label || epData.plotId}
                <span style={{ marginLeft: 8, fontSize: 12, fontWeight: 500, color: '#64748b' }}>N° interne: {epData.plotId}</span>
              </h3>
              <button type="button" className="prj-sheet__close" onClick={() => setModal(null)}>✕</button>
            </div>
            <div className="pdp-modal-body">
              <div className="zitu-page__field">
                <label className="zitu-page__field-label">Identifiant</label>
                <input
                  className="zitu-page__input"
                  type="text"
                  maxLength={16}
                  placeholder="a1, b1, 1, A-42…"
                  value={pcf.label}
                  onChange={e => setPcf(f => ({ ...f, label: e.target.value }))}
                />
                <span className="pdp-field__hint">Unique dans le projet. Laisser vide pour revenir au N° interne.</span>
              </div>
              <div className="zitu-page__field"><label className="zitu-page__field-label">Surface m²</label><input className="zitu-page__input" type="number" value={pcf.area} onChange={e => setPcf(f => ({ ...f, area: e.target.value }))} /></div>
              <div className="pdp-batches pdp-batches--edit">
                <div className="pdp-field__label">Composition du verger</div>
                <p className="pdp-field__hint" style={{ margin: '0 0 8px' }}>Même présentation que sur le site public — modifiez les cohortes ci-dessous.</p>
                {parcelBatchRows.map((b, i) => {
                  const info = ti(Number(b.year) || CY)
                  return (
                    <div key={i} className="pdp-batch-edit-row">
                      <label className="pdp-batch-edit-row__field">
                        <span className="pdp-batch-edit-row__lbl">Année</span>
                        <input
                          className="zitu-page__input"
                          type="number"
                          min={1980}
                          max={2035}
                          placeholder={String(CY)}
                          value={b.year}
                          onChange={(e) => updateBatchRow(i, { year: e.target.value })}
                        />
                      </label>
                      <label className="pdp-batch-edit-row__field">
                        <span className="pdp-batch-edit-row__lbl">Arbres</span>
                        <input
                          className="zitu-page__input"
                          type="number"
                          min={0}
                          value={b.count}
                          onChange={(e) => updateBatchRow(i, { count: e.target.value })}
                        />
                      </label>
                      <div className="pdp-batch-edit-row__meta" title="Aperçu productivité">
                        <span className="pdp-batch-edit-row__age">{CY - (Number(b.year) || CY)}a · {info.label}</span>
                        {Number(b.count) > 0 && info.rate > 0 && (
                          <span className="pdp-batch-edit-row__rev">~{Math.round(Number(b.count) * info.rate).toLocaleString('fr-FR')} DT/an</span>
                        )}
                        {Number(b.count) > 0 && info.rate === 0 && <span className="pdp-batch-edit-row__rev">Non prod.</span>}
                      </div>
                      <button
                        type="button"
                        className="pdp-batch-edit-row__rm"
                        disabled={parcelBatchRows.length <= 1}
                        onClick={() => removeBatchRow(i)}
                        aria-label="Retirer cette cohorte"
                      >
                        −
                      </button>
                    </div>
                  )
                })}
                <button type="button" className="pdp-batch-add" onClick={addBatchRow}>
                  + Ajouter une génération
                </button>
                <div className="pdp-batch-total">
                  Total : <strong>{sumBatchTrees(normalizeBatchInput(pcf.treeBatches)).toLocaleString('fr-FR')}</strong> arbres
                </div>
              </div>
              <div className="zitu-page__field"><label className="zitu-page__field-label">Statut</label><select className="zitu-page__input" value={pcf.status} onChange={e => setPcf(f => ({ ...f, status: e.target.value }))}><option value="available">Disponible</option><option value="reserved">Réservée</option><option value="sold">Vendue</option></select></div>
              {(() => {
                const draft = normalizeBatchInput(pcf.treeBatches)
                const previewPlot = {
                  ...epData.plot,
                  trees: draft.length ? sumBatchTrees(draft) : Number(pcf.trees) || 0,
                  treeBatches: draft.length ? draft : [],
                }
                const batches = previewPlot.treeBatches || []
                const batchTotal = batches.reduce((s, b) => s + (Number(b.count) || 0) * (Number(b.pricePerTree) || 0), 0)
                const totalPrice = batchTotal > 0 ? batchTotal : (Number(epData.plot.totalPrice) || 0)
                return (
                  <div className="pdp-edit-preview">
                    <div className="pdp-edit-preview__item"><span>Prix total</span><strong>{fmt(totalPrice)}</strong></div>
                    <div className="pdp-edit-preview__item"><span>Revenu/an</span><strong>~{pRev(previewPlot).toLocaleString('fr-FR')} DT</strong></div>
                  </div>
                )
              })()}
              <div className="zitu-page__form-actions" style={{ marginTop: 14 }}>
                {epData.plot.dbId && <button type="button" className="zitu-page__btn zitu-page__btn--danger" disabled={saving} onClick={() => delPl(epData.plot.dbId)}>Supprimer</button>}
                <button type="button" className="zitu-page__btn" onClick={() => setModal(null)}>Annuler</button>
                <button type="button" className="zitu-page__btn zitu-page__btn--primary" disabled={saving} onClick={() => saveEditPl(epData.plot)}>{saving ? 'Enregistrement…' : 'Enregistrer'}</button>
              </div>
            </div>
          </div></div>
        )}

      </div>
    </div>
  )
}

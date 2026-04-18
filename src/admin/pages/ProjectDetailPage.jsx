import { useMemo, useState, useEffect } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { useProjects, useOffers, useProjectWorkflow } from '../../lib/useSupabase.js'
import CommissionRulesEditor from '../components/CommissionRulesEditor.jsx'
import * as db from '../../lib/db.js'
import AdminModal from '../components/AdminModal.jsx'
import './zitouna-admin-page.css'
import './projects-admin.css'

const EMPTY_PARCEL = { id: '', trees: '', area: '', pricePerTree: '', status: 'available' }
const EMPTY_PROJECT = { title: '', city: '', region: '', area: '', year: '', mapUrl: '' }
const EMPTY_OFFER = { label: '', avancePct: '', duration: '', note: '' }
const EMPTY_CHECK_ITEM = { key: '', label: '', required: true, grantAllowedPagesText: '' }
const DH = { treeSante: 95, humidity: 65, nutrients: 80 }

function fmt(v) { return `${(Number(v) || 0).toLocaleString('fr-FR')} DT` }
const CY = 2026
function ti(y) { const a = CY - y; if (a < 3) return { rate: 0, label: 'Jeune' }; if (a < 6) return { rate: 45, label: 'Dev.' }; if (a < 10) return { rate: 75, label: 'Croissance' }; return { rate: 90, label: 'Production' } }
function pRev(p) { if (!p.treeBatches?.length) return p.trees * 90; return p.treeBatches.reduce((s, b) => s + b.count * ti(b.year).rate, 0) }
function sLbl(s) { return s === 'available' ? 'Dispo' : s === 'reserved' ? 'Réservée' : 'Vendue' }

// Local scoped stylesheet — only affects this page via .pdp- prefix.
// Keeps admin.css / projects-admin.css untouched while providing better
// visual hierarchy, inline guidance, and mobile single-column layout.
const PAGE_CSS = `
.pdp-section { background: #fff; border: 1px solid #e2e8f0; border-radius: 12px; padding: 14px; margin: 0 0 14px; box-shadow: 0 1px 2px rgba(15,23,42,.03); }
.pdp-section__head { display: flex; align-items: flex-start; gap: 10px; margin-bottom: 10px; }
.pdp-section__num { flex: none; width: 26px; height: 26px; border-radius: 999px; background: linear-gradient(135deg,#2563eb,#1d4ed8); color: #fff; font-weight: 800; font-size: 13px; display: inline-flex; align-items: center; justify-content: center; box-shadow: 0 2px 6px rgba(37,99,235,.28); }
.pdp-section__body { flex: 1; min-width: 0; }
.pdp-section__title { margin: 0; font-size: 18px; font-weight: 800; color: #0f172a; letter-spacing: -.01em; line-height: 1.2; }
.pdp-section__hint { margin: 4px 0 0; font-size: 13px; color: #475569; line-height: 1.45; }
.pdp-section__hint strong { color: #0f172a; }
.pdp-section__actions { display: flex; gap: 6px; flex-wrap: wrap; margin-left: auto; }

.pdp-alert { margin: 10px 0 0; padding: 8px 10px; border-radius: 8px; font-size: 13px; line-height: 1.4; }
.pdp-alert--ok { background: #ecfdf5; border: 1px solid #a7f3d0; color: #065f46; }
.pdp-alert--err { background: #fef2f2; border: 1px solid #fecaca; color: #991b1b; }
.pdp-alert--info { background: #eff6ff; border: 1px solid #bfdbfe; color: #1e3a8a; }

.pdp-field-hint { display: block; margin-top: 4px; font-size: 12px; color: #64748b; line-height: 1.4; }

.pdp-checklist-item { border: 1px solid #e2e8f0; border-radius: 10px; padding: 10px; background: #f8fafc; }
.pdp-checklist-item__head { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin-bottom: 6px; }
.pdp-checklist-item__idx { font-size: 12px; font-weight: 800; color: #2563eb; background: rgba(37,99,235,.1); padding: 2px 8px; border-radius: 999px; }
.pdp-checklist-item__controls { display: flex; gap: 4px; }

.pdp-empty { text-align: center; padding: 22px 12px; background: #f8fafc; border: 1px dashed #cbd5e1; border-radius: 10px; }
.pdp-empty__icon { font-size: 26px; margin-bottom: 4px; }
.pdp-empty__title { display: block; font-size: 14px; font-weight: 700; color: #334155; margin-bottom: 2px; }
.pdp-empty__hint { margin: 0 0 10px; font-size: 13px; color: #64748b; }

.pdp-divider { display: flex; align-items: center; gap: 8px; margin: 14px 0 8px; }
.pdp-divider__line { flex: 1; height: 1px; background: #e2e8f0; }
.pdp-divider__label { font-size: 12px; font-weight: 700; color: #64748b; text-transform: uppercase; letter-spacing: .05em; }

.pdp-row { display: flex; flex-wrap: wrap; gap: 8px; }
.pdp-row > * { flex: 1 1 140px; }

@media (max-width: 600px) {
  .pdp-section { padding: 12px; }
  .pdp-section__title { font-size: 17px; }
  .pdp-section__hint { font-size: 13px; }
  .pdp-section__head { flex-wrap: wrap; }
  .pdp-section__actions { margin-left: 0; width: 100%; }
  .pdp-row > * { flex: 1 1 100%; }
}
`

export default function ProjectDetailPage() {
  const navigate = useNavigate()
  const { projectId } = useParams()
  const { projects, refresh: refreshProjects } = useProjects()
  const { offersByProject, refresh: refreshOffers } = useOffers()
  const [modal, setModal] = useState(null)
  const [pf, setPf] = useState(EMPTY_PROJECT)
  const [pcf, setPcf] = useState(EMPTY_PARCEL)
  const [of, setOf] = useState(EMPTY_OFFER)
  const [eoIdx, setEoIdx] = useState(-1)
  const [editOfferDbId, setEditOfferDbId] = useState(null)
  const [parcelQ, setParcelQ] = useState('')
  const [saving, setSaving] = useState(false)
  const [healthLocal, setHealthLocal] = useState({})

  const project = useMemo(() => projects.find(p => String(p.id) === String(projectId)), [projects, projectId])
  const { workflow, updateWorkflow, loading: workflowLoading } = useProjectWorkflow(project?.id || '')
  const [wfCompany, setWfCompany] = useState(5)
  const [wfNotary, setWfNotary] = useState(2)
  const [wfMinPay, setWfMinPay] = useState(100)
  const [wfResH, setWfResH] = useState(48)
  const [wfArabon, setWfArabon] = useState(50)
  const [checklistItems, setChecklistItems] = useState([])
  const [wfMsg, setWfMsg] = useState(null)
  const [wfErr, setWfErr] = useState(false)

  useEffect(() => {
    if (!workflow || !project?.id) return
    setWfCompany(Number(workflow.companyFeePct ?? 5))
    setWfNotary(Number(workflow.notaryFeePct ?? 2))
    setWfMinPay(Number(workflow.minimumPayoutThreshold ?? 100))
    setWfResH(Number(workflow.reservationHours ?? 48))
    setWfArabon(Number(workflow.arabonDefault ?? 50))
    const normalized = (workflow.signatureChecklist || []).map((it) => ({
      key: String(it?.key || '').trim(),
      label: String(it?.label || '').trim(),
      required: it?.required !== false,
      grantAllowedPagesText: Array.isArray(it?.grantAllowedPages) ? it.grantAllowedPages.join(', ') : '',
    }))
    setChecklistItems(normalized)
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
      await updateWorkflow({ companyFeePct: wfCompany, notaryFeePct: wfNotary, minimumPayoutThreshold: wfMinPay, reservationHours: wfResH, arabonDefault: wfArabon, signatureChecklist: checklist })
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
  const totalValue = plots.reduce((s, p) => s + (Number(p.totalPrice) || 0), 0)
  const totalRevenue = plots.reduce((s, p) => s + pRev(p), 0)
  const avail = plots.filter(p => p.status === 'available').length
  const filteredPlots = useMemo(() => { const q = parcelQ.trim(); if (!q) return plots; return plots.filter(p => String(p.id).includes(q) || String(p.trees).includes(q) || String(p.area).includes(q)) }, [plots, parcelQ])

  const projHealth = healthLocal[project?.id] || { ...DH }
  const setHealth = (field, val) => { setHealthLocal(prev => ({ ...prev, [project.id]: { ...projHealth, [field]: Number(val) } })) }
  const avgPrice = plots.length ? totalValue / plots.length : 0

  const openEdit = () => { if (!project) return; setPf({ title: project.title, city: project.city, region: project.region || '', area: project.area || '', year: String(project.year || ''), mapUrl: project.mapUrl || '' }); setModal('edit') }
  const saveEdit = async () => {
    setSaving(true)
    try {
      await db.upsertProject({ id: project.id, title: pf.title.trim() || project.title, city: pf.city.trim() || project.city, region: pf.region.trim(), area: pf.area.trim() || project.area, year: Number(pf.year) || project.year, mapUrl: pf.mapUrl.trim() })
      await refreshProjects()
      setModal(null)
    } catch (e) { console.error('saveEdit', e) }
    finally { setSaving(false) }
  }
  const delProject = async () => {
    setSaving(true)
    try { await db.deleteProject(project.id); navigate('/admin/projects') }
    catch (e) { console.error('delProject', e) }
    finally { setSaving(false) }
  }

  const openAdd = () => { setPcf(EMPTY_PARCEL); setModal('add-parcel') }
  const saveNew = async () => {
    const pid = Number(pcf.id), t = Number(pcf.trees), a = Number(pcf.area), pp = Number(pcf.pricePerTree)
    if (!Number.isFinite(pid) || pid <= 0 || !Number.isFinite(t) || t <= 0) return
    setSaving(true)
    try {
      await db.upsertParcelForProject(project.id, { plotNumber: pid, trees: t, area: a > 0 ? a : 0, pricePerTree: pp > 0 ? pp : 0, totalPrice: Math.max(0, t * (pp > 0 ? pp : 0)), status: pcf.status || 'available' })
      await refreshProjects()
      setModal(null)
    } catch (e) { console.error('saveNew', e) }
    finally { setSaving(false) }
  }
  const openEditPl = (pl) => { setPcf({ id: String(pl.id), trees: String(pl.trees), area: String(pl.area), pricePerTree: String(pl.pricePerTree), status: pl.status, dbId: pl.dbId }); setModal({ type: 'edit-parcel', plotId: pl.id, plot: pl }) }
  const saveEditPl = async (pl) => {
    const t = Number(pcf.trees), a = Number(pcf.area), pp = Number(pcf.pricePerTree)
    if (!Number.isFinite(t) || t <= 0) return
    setSaving(true)
    try {
      await db.upsertParcelForProject(project.id, { dbId: pl.dbId || pcf.dbId, plotNumber: pl.id, trees: t, area: a > 0 ? a : pl.area, pricePerTree: pp > 0 ? pp : pl.pricePerTree, totalPrice: Math.max(0, t * (pp > 0 ? pp : pl.pricePerTree)), status: pcf.status || pl.status })
      await refreshProjects()
      setModal(null)
    } catch (e) { console.error('saveEditPl', e) }
    finally { setSaving(false) }
  }
  const delPl = async (dbId) => {
    setSaving(true)
    try { await db.deleteParcelById(dbId); await refreshProjects(); setModal(null) }
    catch (e) { console.error('delPl', e) }
    finally { setSaving(false) }
  }

  const openAddO = () => { setOf(EMPTY_OFFER); setEoIdx(-1); setEditOfferDbId(null); setModal('offer') }
  const openEditO = (o, i) => { setOf({ label: o.name || o.label, avancePct: String(o.downPayment ?? o.avancePct), duration: String(o.duration), note: o.note || '' }); setEoIdx(i); setEditOfferDbId(o.dbId || null); setModal('offer') }
  const saveO = async () => {
    if (!of.label.trim()) return
    setSaving(true)
    try {
      await db.upsertOffer(project.id, { dbId: editOfferDbId, label: of.label.trim(), avancePct: Number(of.avancePct) || 0, duration: Number(of.duration) || 0, note: of.note.trim() })
      await refreshOffers()
      setModal(null)
    } catch (e) { console.error('saveO', e) }
    finally { setSaving(false) }
  }
  const delO = async () => {
    if (!editOfferDbId) return
    setSaving(true)
    try { await db.deleteOffer(editOfferDbId); await refreshOffers(); setModal(null) }
    catch (e) { console.error('delO', e) }
    finally { setSaving(false) }
  }

  if (!project) return (
    <div className="zitu-page" dir="ltr"><div className="zitu-page__column">
      <style>{PAGE_CSS}</style>
      <button type="button" className="ds-back-btn" onClick={() => navigate('/admin/projects')}><span className="ds-back-btn__icon">←</span><span className="ds-back-btn__label">Projets</span></button>
      <div className="pdp-empty"><div className="pdp-empty__icon">📭</div><strong className="pdp-empty__title">Projet introuvable</strong><p className="pdp-empty__hint">Ce projet n’existe plus ou a été supprimé.</p>
        <button type="button" className="zitu-page__btn zitu-page__btn--primary" onClick={() => navigate('/admin/projects')}>Retour à la liste</button>
      </div>
    </div></div>
  )

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
      <style>{PAGE_CSS}</style>
      <div className="zitu-page__column">

        <button type="button" className="ds-back-btn" onClick={() => navigate('/admin/projects')}>
          <span className="ds-back-btn__icon">←</span><span className="ds-back-btn__label">Projets</span>
        </button>

        {/* ── Hero : identité du projet + chiffres clés ── */}
        <div className="ds-hero">
          <div className="ds-hero__top">
            <div className="ds-hero__icon">🗂️</div>
            <div>
              <h1 className="ds-hero__title">{project.title}</h1>
              <p className="ds-hero__sub">{project.city}{project.region ? `, ${project.region}` : ''} · {project.area}</p>
            </div>
          </div>
          <div className="ds-hero__kpi">
            <div className="ds-hero__kpi-block"><span className="ds-hero__kpi-num">{plots.length}</span><span className="ds-hero__kpi-unit">PARCELLES</span></div>
            <span className="ds-hero__kpi-sep" />
            <div className="ds-hero__kpi-block"><span className="ds-hero__kpi-num">{totalTrees}</span><span className="ds-hero__kpi-unit">ARBRES</span></div>
            <span className="ds-hero__kpi-sep" />
            <div className="ds-hero__kpi-block"><span className="ds-hero__kpi-num">{project.year}</span><span className="ds-hero__kpi-unit">ANNÉE</span></div>
          </div>
        </div>

        <div style={{ display: 'flex', gap: 6, marginBottom: 10, flexWrap: 'wrap' }}>
          <button type="button" className="zitu-page__btn" onClick={openEdit}>Modifier le projet</button>
          <button type="button" className="zitu-page__btn zitu-page__btn--primary" onClick={openAdd}>+ Ajouter une parcelle</button>
        </div>

        {project.mapUrl && <div className="prj-map"><iframe title="Carte" src={project.mapUrl} loading="lazy" /></div>}

        {/* ── Vue d'ensemble : stats globales ── */}
        <div className="zitu-page__stats" style={{ marginBottom: 6 }}>
          <div className="zitu-page__stat" style={{ background: 'linear-gradient(135deg,#fff,#f8fbff)', border: '1px solid #dbeafe' }}><div className="zitu-page__stat-label">Valeur totale</div><div className="zitu-page__stat-value">{fmt(totalValue)}</div></div>
          <div className="zitu-page__stat" style={{ background: 'linear-gradient(135deg,#fff,#f8fbff)', border: '1px solid #dbeafe' }}><div className="zitu-page__stat-label">Revenu estimé / an</div><div className="zitu-page__stat-value">~{fmt(totalRevenue)}</div></div>
        </div>
        <div className="zitu-page__stats" style={{ marginBottom: 12 }}>
          <div className="zitu-page__stat" style={{ background: 'linear-gradient(135deg,#fff,#f8fbff)', border: '1px solid #dbeafe' }}><div className="zitu-page__stat-label">Parcelles dispo.</div><div className="zitu-page__stat-value">{avail}/{plots.length}</div></div>
          <div className="zitu-page__stat" style={{ background: 'linear-gradient(135deg,#fff,#f8fbff)', border: '1px solid #dbeafe' }}><div className="zitu-page__stat-label">Offres actives</div><div className="zitu-page__stat-value">{offers.length}</div></div>
        </div>

        {/* ── Santé du projet (indicatif visuel) ── */}
        <div className="prj-health-section">
          <div style={{ fontSize: 12, fontWeight: 800, color: '#475569', textTransform: 'uppercase', letterSpacing: '.03em', marginBottom: 4 }}>Santé du projet</div>
          <p style={{ margin: '0 0 8px', fontSize: 13, color: '#64748b' }}>Indicateurs visuels (suivi terrain). Ajustez les curseurs selon vos relevés.</p>
          <div className="prj-health__grid">
            {[{ k: 'treeSante', l: 'Santé des arbres' }, { k: 'humidity', l: 'Humidité du sol' }, { k: 'nutrients', l: 'Nutriments' }].map(({ k, l }) => (
              <div key={k} className="prj-health__item">
                <span className="prj-health__bar" style={{ width: `${projHealth[k]}%` }} />
                <div className="prj-health__info"><span>{l}</span><strong>{projHealth[k]}%</strong></div>
                <input type="range" min="0" max="100" value={projHealth[k]} className="prj-health__slider" onChange={e => setHealth(k, e.target.value)} aria-label={l} />
              </div>
            ))}
          </div>
        </div>

        {/* ══ ÉTAPE 1 : Workflow de vente & frais ══ */}
        <section className="pdp-section" style={{ marginTop: 14 }}>
          <div className="pdp-section__head">
            <span className="pdp-section__num">1</span>
            <div className="pdp-section__body">
              <h2 className="pdp-section__title">Workflow de vente &amp; frais</h2>
              <p className="pdp-section__hint">
                Réglez les <strong>frais société et notaire</strong>, la durée de réservation, l’arabon par défaut et la checklist notaire.
                Ces réglages s’appliquent aux <strong>nouvelles ventes uniquement</strong> — les ventes existantes conservent leur configuration d’origine.
                {workflowLoading ? ' (Chargement…)' : ''}
              </p>
            </div>
          </div>

          <div className="zitu-page__form-grid">
            <div className="zitu-page__field">
              <label className="zitu-page__field-label">Frais société (%)</label>
              <input className="zitu-page__input" type="number" value={wfCompany} onChange={(e) => setWfCompany(Number(e.target.value))} />
              <span className="pdp-field-hint">Commission prélevée par Zitouna sur chaque vente.</span>
            </div>
            <div className="zitu-page__field">
              <label className="zitu-page__field-label">Frais notaire (%)</label>
              <input className="zitu-page__input" type="number" value={wfNotary} onChange={(e) => setWfNotary(Number(e.target.value))} />
              <span className="pdp-field-hint">Frais d’acte transférés au notaire.</span>
            </div>
            <div className="zitu-page__field">
              <label className="zitu-page__field-label">Seuil payout min. (TND)</label>
              <input className="zitu-page__input" type="number" value={wfMinPay} onChange={(e) => setWfMinPay(Number(e.target.value))} />
              <span className="pdp-field-hint">
                Plancher de <strong>retrait</strong> du portefeuille parrainage — pas le montant L1/L2. Les règles L1/L2 se configurent plus bas (étape 2).
              </span>
            </div>
            <div className="zitu-page__field">
              <label className="zitu-page__field-label">Réservation (heures)</label>
              <input className="zitu-page__input" type="number" value={wfResH} onChange={(e) => setWfResH(Number(e.target.value))} />
              <span className="pdp-field-hint">Durée pendant laquelle une parcelle reste bloquée après arabon.</span>
            </div>
            <div className="zitu-page__field">
              <label className="zitu-page__field-label">Arabon défaut (TND)</label>
              <input className="zitu-page__input" type="number" value={wfArabon} onChange={(e) => setWfArabon(Number(e.target.value))} />
              <span className="pdp-field-hint">Acompte proposé par défaut au moment de la réservation.</span>
            </div>
          </div>

          <div className="pdp-divider">
            <span className="pdp-divider__label">Checklist notaire</span>
            <span className="pdp-divider__line" />
          </div>
          <p style={{ margin: '0 0 10px', fontSize: 13, color: '#64748b' }}>
            Liste des documents à cocher par le notaire avant signature. Chaque élément peut autoriser l’accès à une ou plusieurs pages admin.
          </p>

          <div className="zitu-page__field">
            <div style={{ display: 'grid', gap: 10 }}>
              {checklistItems.length === 0 ? (
                <div className="pdp-empty">
                  <div className="pdp-empty__icon">📋</div>
                  <strong className="pdp-empty__title">Aucun élément dans la checklist</strong>
                  <p className="pdp-empty__hint">Ajoutez au moins un document (ex. contrat, pièce d’identité) pour activer la signature.</p>
                </div>
              ) : checklistItems.map((item, idx) => (
                <div key={`${idx}-${item.key}`} className="pdp-checklist-item">
                  <div className="pdp-checklist-item__head">
                    <span className="pdp-checklist-item__idx">#{idx + 1}</span>
                    <div className="pdp-checklist-item__controls">
                      <button type="button" className="zitu-page__btn zitu-page__btn--secondary zitu-page__btn--sm" onClick={() => moveChecklistRow(idx, -1)} aria-label="Monter">↑</button>
                      <button type="button" className="zitu-page__btn zitu-page__btn--secondary zitu-page__btn--sm" onClick={() => moveChecklistRow(idx, 1)} aria-label="Descendre">↓</button>
                      <button
                        type="button"
                        className="zitu-page__btn zitu-page__btn--danger zitu-page__btn--sm"
                        onClick={() => setChecklistItems((prev) => prev.filter((_, i) => i !== idx))}
                      >
                        Supprimer
                      </button>
                    </div>
                  </div>
                  <div style={{ display: 'grid', gap: 8 }}>
                    <div>
                      <label className="zitu-page__field-label">Clé technique</label>
                      <input
                        className="zitu-page__input"
                        placeholder="ex : contract"
                        value={item.key}
                        onChange={(e) => updateChecklistRow(idx, { key: e.target.value })}
                      />
                      <span className="pdp-field-hint">Identifiant interne (sans espaces). Utilisé pour lier le document au système.</span>
                    </div>
                    <div>
                      <label className="zitu-page__field-label">Libellé affiché</label>
                      <input
                        className="zitu-page__input"
                        placeholder="ex : Contrat de vente signé"
                        value={item.label}
                        onChange={(e) => updateChecklistRow(idx, { label: e.target.value })}
                      />
                      <span className="pdp-field-hint">Texte vu par le notaire dans la checklist.</span>
                    </div>
                    <div>
                      <label className="zitu-page__field-label">Pages accordées (optionnel)</label>
                      <input
                        className="zitu-page__input"
                        placeholder="ex : /admin/sell, /admin/reports"
                        value={item.grantAllowedPagesText}
                        onChange={(e) => updateChecklistRow(idx, { grantAllowedPagesText: e.target.value })}
                      />
                      <span className="pdp-field-hint">Séparez les pages par une virgule. Laissez vide si non applicable.</span>
                    </div>
                    <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, color: '#334155' }}>
                      <input
                        type="checkbox"
                        checked={item.required !== false}
                        onChange={(e) => updateChecklistRow(idx, { required: e.target.checked })}
                      />
                      Document obligatoire
                    </label>
                  </div>
                </div>
              ))}
              <button
                type="button"
                className="zitu-page__btn zitu-page__btn--secondary"
                onClick={() => setChecklistItems((prev) => [...prev, { ...EMPTY_CHECK_ITEM }])}
              >
                + Ajouter un élément à la checklist
              </button>
            </div>
          </div>

          {wfMsg ? (
            <div className={`pdp-alert ${wfErr ? 'pdp-alert--err' : 'pdp-alert--ok'}`}>{wfMsg}</div>
          ) : null}
          <div style={{ display: 'flex', gap: 8, marginTop: 12, flexWrap: 'wrap' }}>
            <button type="button" className="zitu-page__btn zitu-page__btn--primary" disabled={workflowLoading} onClick={() => void saveWorkflowConfig()}>
              {workflowLoading ? 'Chargement…' : 'Enregistrer le workflow'}
            </button>
          </div>
        </section>

        {/* ══ ÉTAPE 2 : Commissions parrainage (L1 / L2…) ══ */}
        <section className="pdp-section">
          <div className="pdp-section__head">
            <span className="pdp-section__num">2</span>
            <div className="pdp-section__body">
              <h2 className="pdp-section__title">Commissions parrainage</h2>
              <p className="pdp-section__hint">
                Définissez les pourcentages versés aux parrains (niveaux L1, L2…). Ces règles alimentent le portefeuille parrainage des utilisateurs.
                Le <strong>seuil payout</strong> (étape 1) détermine quand ils peuvent retirer.
              </p>
            </div>
          </div>

          {/*
            Embedded commission-rules editor — same component as
            /admin/referral-settings so admins configure L1/L2… where they
            already set fees and payout threshold, without page-hopping.
          */}
          <CommissionRulesEditor projectId={project?.id || ''} />

          {project?.id ? (
            <div style={{ marginTop: 12, fontSize: 13, color: '#64748b', display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
              <button
                type="button"
                className="zitu-page__btn zitu-page__btn--secondary zitu-page__btn--sm"
                onClick={() => navigate(`/admin/referral-settings?project=${encodeURIComponent(project.id)}`)}
              >
                Ouvrir la page dédiée
              </button>
              <span>— même éditeur, avec une URL partageable.</span>
            </div>
          ) : null}
        </section>

        {/* ══ ÉTAPE 3 : Parcelles ══ */}
        <section className="pdp-section">
          <div className="pdp-section__head">
            <span className="pdp-section__num">3</span>
            <div className="pdp-section__body">
              <h2 className="pdp-section__title">Parcelles <span style={{ fontSize: 14, fontWeight: 700, color: '#2563eb', background: 'rgba(37,99,235,.08)', padding: '2px 8px', borderRadius: 6, marginLeft: 6 }}>{plots.length}</span></h2>
              <p className="pdp-section__hint">Cliquez une ligne pour modifier (arbres, prix, statut). Utilisez la recherche pour filtrer.</p>
            </div>
            <div className="pdp-section__actions">
              <button type="button" className="zitu-page__btn zitu-page__btn--primary zitu-page__btn--sm" onClick={openAdd}>+ Parcelle</button>
            </div>
          </div>

          <div className="zitu-page__search-wrap" style={{ marginBottom: 8 }}>
            <input className="zitu-page__search" placeholder="Rechercher : n° parcelle, arbres, surface…" value={parcelQ} onChange={e => setParcelQ(e.target.value)} />
            <span className="zitu-page__search-icon" aria-hidden>🔎</span>
          </div>

          {plots.length === 0 ? (
            <div className="pdp-empty">
              <div className="pdp-empty__icon">🌱</div>
              <strong className="pdp-empty__title">Aucune parcelle pour ce projet</strong>
              <p className="pdp-empty__hint">Ajoutez votre première parcelle pour commencer.</p>
              <button type="button" className="zitu-page__btn zitu-page__btn--primary" onClick={openAdd}>+ Ajouter une parcelle</button>
            </div>
          ) : filteredPlots.length === 0 ? (
            <div className="pdp-empty">
              <div className="pdp-empty__icon">🔍</div>
              <strong className="pdp-empty__title">Aucun résultat</strong>
              <p className="pdp-empty__hint">Aucune parcelle ne correspond à « {parcelQ} ».</p>
              <button type="button" className="zitu-page__btn" onClick={() => setParcelQ('')}>Effacer la recherche</button>
            </div>
          ) : (
            <>
              <div className="prj-table-head">
                <span className="prj-table-head__col prj-table-head__col--id">#</span>
                <span className="prj-table-head__col">Arbres</span>
                <span className="prj-table-head__col">m²</span>
                <span className="prj-table-head__col">Prix</span>
                <span className="prj-table-head__col prj-table-head__col--status">Statut</span>
              </div>
              <div className="prj-table">
                {filteredPlots.map(pl => (
                  <button key={pl.dbId || pl.id} type="button" className="prj-table-row" onClick={() => openEditPl(pl)}>
                    <span className="prj-table-row__id">#{pl.id}</span>
                    <span className="prj-table-row__val">{pl.trees}</span>
                    <span className="prj-table-row__val">{pl.area}</span>
                    <span className="prj-table-row__val">{(Number(pl.totalPrice) || 0).toLocaleString('fr-FR')}</span>
                    <span className="prj-table-row__status">{sLbl(pl.status)}</span>
                  </button>
                ))}
              </div>
              <div className="prj-results-count">{filteredPlots.length}/{plots.length} parcelle{plots.length > 1 ? 's' : ''} affichée{filteredPlots.length > 1 ? 's' : ''}</div>
            </>
          )}
        </section>

        {/* ══ ÉTAPE 4 : Offres de paiement ══ */}
        <section className="pdp-section">
          <div className="pdp-section__head">
            <span className="pdp-section__num">4</span>
            <div className="pdp-section__body">
              <h2 className="pdp-section__title">Offres de paiement</h2>
              <p className="pdp-section__hint">Formules d’achat proposées au client (avance + mensualités). La simulation s’ajuste au prix moyen d’une parcelle.</p>
            </div>
            <div className="pdp-section__actions">
              <button type="button" className="zitu-page__btn zitu-page__btn--primary zitu-page__btn--sm" onClick={openAddO}>+ Offre</button>
            </div>
          </div>

          {offers.length === 0 ? (
            <div className="pdp-empty">
              <div className="pdp-empty__icon">💳</div>
              <strong className="pdp-empty__title">Aucune offre de paiement</strong>
              <p className="pdp-empty__hint">Créez une formule (ex. « 20% avance, 24 mois ») pour que les clients puissent choisir.</p>
              <button type="button" className="zitu-page__btn zitu-page__btn--primary" onClick={openAddO}>+ Créer une offre</button>
            </div>
          ) : (
            <div className="prj-offers__list">{offers.map((o, i) => {
              const pv = avgPrice && o.duration ? { mo: (avgPrice - avgPrice * (o.downPayment ?? o.avancePct ?? 0) / 100) / o.duration } : null
              return (
                <button key={o.dbId || i} type="button" className="prj-offer" onClick={() => openEditO(o, i)}>
                  <div className="prj-offer__top"><span className="prj-offer__name">{o.name || o.label}</span>{o.note && <span className="prj-offer__note">{o.note}</span>}</div>
                  <div className="prj-offer__meta"><span>{o.downPayment ?? o.avancePct}% avance</span><span>·</span><span>{o.duration} mois</span>{pv && <span>· ~{Math.round(pv.mo).toLocaleString('fr-FR')} DT/mois</span>}</div>
                </button>
              )
            })}</div>
          )}
        </section>

        {/* ── Modals (inchangés sur le plan logique) ── */}
        <AdminModal open={modal === 'edit'} onClose={() => setModal(null)} title="Modifier le projet">
          <div className="zitu-page__field"><label className="zitu-page__field-label">Nom</label><input className="zitu-page__input" value={pf.title} onChange={e => setPf(f => ({ ...f, title: e.target.value }))} /></div>
          <div className="zitu-page__form-grid">
            <div className="zitu-page__field"><label className="zitu-page__field-label">Ville</label><input className="zitu-page__input" value={pf.city} onChange={e => setPf(f => ({ ...f, city: e.target.value }))} /></div>
            <div className="zitu-page__field"><label className="zitu-page__field-label">Région</label><input className="zitu-page__input" value={pf.region} onChange={e => setPf(f => ({ ...f, region: e.target.value }))} /></div>
          </div>
          <div className="zitu-page__form-grid">
            <div className="zitu-page__field"><label className="zitu-page__field-label">Superficie</label><input className="zitu-page__input" value={pf.area} onChange={e => setPf(f => ({ ...f, area: e.target.value }))} /></div>
            <div className="zitu-page__field"><label className="zitu-page__field-label">Année</label><input className="zitu-page__input" type="number" value={pf.year} onChange={e => setPf(f => ({ ...f, year: e.target.value }))} /></div>
          </div>
          <div className="zitu-page__field"><label className="zitu-page__field-label">URL carte</label><input className="zitu-page__input" value={pf.mapUrl} onChange={e => setPf(f => ({ ...f, mapUrl: e.target.value }))} /></div>
          <div className="zitu-page__form-actions">
            <button type="button" className="zitu-page__btn zitu-page__btn--danger" disabled={saving} onClick={delProject}>Supprimer</button>
            <button type="button" className="zitu-page__btn" onClick={() => setModal(null)}>Annuler</button>
            <button type="button" className="zitu-page__btn zitu-page__btn--primary" disabled={saving} onClick={saveEdit}>{saving ? 'Enregistrement…' : 'Enregistrer'}</button>
          </div>
        </AdminModal>

        <AdminModal open={modal === 'add-parcel'} onClose={() => setModal(null)} title="Ajouter une parcelle">
          <div className="zitu-page__form-grid">
            <div className="zitu-page__field"><label className="zitu-page__field-label">N° *</label><input className="zitu-page__input" type="number" placeholder="6" value={pcf.id} onChange={e => setPcf(f => ({ ...f, id: e.target.value }))} /></div>
            <div className="zitu-page__field"><label className="zitu-page__field-label">Arbres *</label><input className="zitu-page__input" type="number" placeholder="50" value={pcf.trees} onChange={e => setPcf(f => ({ ...f, trees: e.target.value }))} /></div>
          </div>
          <div className="zitu-page__form-grid">
            <div className="zitu-page__field"><label className="zitu-page__field-label">Surface m²</label><input className="zitu-page__input" type="number" placeholder="400" value={pcf.area} onChange={e => setPcf(f => ({ ...f, area: e.target.value }))} /></div>
            <div className="zitu-page__field"><label className="zitu-page__field-label">Prix/arbre</label><input className="zitu-page__input" type="number" placeholder="1500" value={pcf.pricePerTree} onChange={e => setPcf(f => ({ ...f, pricePerTree: e.target.value }))} /></div>
          </div>
          <div className="zitu-page__field"><label className="zitu-page__field-label">Statut</label><select className="zitu-page__input" value={pcf.status} onChange={e => setPcf(f => ({ ...f, status: e.target.value }))}><option value="available">Disponible</option><option value="reserved">Réservée</option><option value="sold">Vendue</option></select></div>
          <div className="zitu-page__form-actions">
            <button type="button" className="zitu-page__btn" onClick={() => setModal(null)}>Annuler</button>
            <button type="button" className="zitu-page__btn zitu-page__btn--primary" disabled={!pcf.id || !pcf.trees || saving} onClick={saveNew}>{saving ? 'Ajout…' : 'Ajouter'}</button>
          </div>
        </AdminModal>

        <AdminModal open={modal === 'offer'} onClose={() => setModal(null)} title={eoIdx >= 0 ? "Modifier l'offre" : 'Nouvelle offre'}>
          <div className="zitu-page__field"><label className="zitu-page__field-label">Nom *</label><input className="zitu-page__input" placeholder="Essentiel 20/24" value={of.label} onChange={e => setOf(f => ({ ...f, label: e.target.value }))} /></div>
          <div className="zitu-page__form-grid">
            <div className="zitu-page__field"><label className="zitu-page__field-label">Avance %</label><input className="zitu-page__input" type="number" placeholder="20" value={of.avancePct} onChange={e => setOf(f => ({ ...f, avancePct: e.target.value }))} /></div>
            <div className="zitu-page__field"><label className="zitu-page__field-label">Mois</label><input className="zitu-page__input" type="number" placeholder="24" value={of.duration} onChange={e => setOf(f => ({ ...f, duration: e.target.value }))} /></div>
          </div>
          <div className="zitu-page__field"><label className="zitu-page__field-label">Note</label><input className="zitu-page__input" placeholder="Le plus populaire…" value={of.note} onChange={e => setOf(f => ({ ...f, note: e.target.value }))} /></div>
          {avgPrice > 0 && Number(of.avancePct) > 0 && Number(of.duration) > 0 && (
            <div className="prj-offer-preview-box">
              <span className="prj-offer-preview-box__lbl">Simulation (parcelle moy. {fmt(avgPrice)})</span>
              <div className="prj-offer-preview-box__row"><span>Avance</span><strong>{fmt(avgPrice * Number(of.avancePct) / 100)}</strong></div>
              <div className="prj-offer-preview-box__row"><span>Mensualité</span><strong>{fmt((avgPrice - avgPrice * Number(of.avancePct) / 100) / Number(of.duration))}</strong></div>
            </div>
          )}
          <div className="zitu-page__form-actions">
            {eoIdx >= 0 && editOfferDbId && <button type="button" className="zitu-page__btn zitu-page__btn--danger" disabled={saving} onClick={delO}>Supprimer</button>}
            <button type="button" className="zitu-page__btn" onClick={() => setModal(null)}>Annuler</button>
            <button type="button" className="zitu-page__btn zitu-page__btn--primary" disabled={!of.label.trim() || saving} onClick={saveO}>{saving ? 'Enregistrement…' : eoIdx >= 0 ? 'Enregistrer' : 'Ajouter'}</button>
          </div>
        </AdminModal>

        {epData && (
          <div className="prj-overlay" onClick={() => setModal(null)}><div className="prj-sheet" onClick={e => e.stopPropagation()}>
            <div className="prj-sheet__head"><h3 className="prj-sheet__title">Parcelle #{epData.plotId}</h3><button type="button" className="prj-sheet__close" onClick={() => setModal(null)}>✕</button></div>
            <div className="zitu-page__form-grid">
              <div className="zitu-page__field"><label className="zitu-page__field-label">Arbres</label><input className="zitu-page__input" type="number" value={pcf.trees} onChange={e => setPcf(f => ({ ...f, trees: e.target.value }))} /></div>
              <div className="zitu-page__field"><label className="zitu-page__field-label">Surface m²</label><input className="zitu-page__input" type="number" value={pcf.area} onChange={e => setPcf(f => ({ ...f, area: e.target.value }))} /></div>
            </div>
            <div className="zitu-page__form-grid">
              <div className="zitu-page__field"><label className="zitu-page__field-label">Prix/arbre</label><input className="zitu-page__input" type="number" value={pcf.pricePerTree} onChange={e => setPcf(f => ({ ...f, pricePerTree: e.target.value }))} /></div>
              <div className="zitu-page__field"><label className="zitu-page__field-label">Statut</label><select className="zitu-page__input" value={pcf.status} onChange={e => setPcf(f => ({ ...f, status: e.target.value }))}><option value="available">Disponible</option><option value="reserved">Réservée</option><option value="sold">Vendue</option></select></div>
            </div>
            <div className="prj-edit-preview">
              <div className="prj-edit-preview__item"><span>Prix total</span><strong>{fmt(Number(pcf.trees) * Number(pcf.pricePerTree))}</strong></div>
              <div className="prj-edit-preview__item"><span>Revenu/an</span><strong>~{pRev(epData.plot).toLocaleString('fr-FR')} DT</strong></div>
            </div>
            {epData.plot.treeBatches?.length > 0 && (
              <div className="prj-batches-section">
                <div className="zitu-page__field-label" style={{ marginBottom: 4 }}>Verger</div>
                {epData.plot.treeBatches.map((b, i) => {
                  const info = ti(b.year)
                  return (
                    <div key={i} className="prj-batch-row">
                      <div className="prj-batch-row__left"><span className="prj-batch-row__year">{b.year}</span><span className="prj-batch-row__age">{CY - b.year}a · {info.label}</span></div>
                      <div className="prj-batch-row__right"><strong>{b.count}</strong><span className="prj-batch-row__rev">{info.rate > 0 ? `~${(b.count * info.rate).toLocaleString('fr-FR')} DT/an` : 'Non prod.'}</span></div>
                    </div>
                  )
                })}
              </div>
            )}
            <div className="zitu-page__form-actions" style={{ marginTop: 12 }}>
              {epData.plot.dbId && <button type="button" className="zitu-page__btn zitu-page__btn--danger" disabled={saving} onClick={() => delPl(epData.plot.dbId)}>Supprimer</button>}
              <button type="button" className="zitu-page__btn" onClick={() => setModal(null)}>Annuler</button>
              <button type="button" className="zitu-page__btn zitu-page__btn--primary" disabled={saving} onClick={() => saveEditPl(epData.plot)}>{saving ? 'Enregistrement…' : 'Enregistrer'}</button>
            </div>
          </div></div>
        )}

      </div>
    </div>
  )
}

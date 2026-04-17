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
function sLbl(s) { return s === 'available' ? 'Dispo' : s === 'reserved' ? 'Reserve' : 'Vendue' }

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
      setWfMsg('Ajoutez au moins un élément dans la checklist')
      window.setTimeout(() => setWfMsg(null), 3000)
      return
    }
    try {
      await updateWorkflow({ companyFeePct: wfCompany, notaryFeePct: wfNotary, minimumPayoutThreshold: wfMinPay, reservationHours: wfResH, arabonDefault: wfArabon, signatureChecklist: checklist })
      setWfMsg("Enregistré — s'applique aux nouvelles ventes (snapshots inchangés).")
    } catch (e) {
      setWfMsg(`Erreur : ${String(e?.message || e)}`)
    }
    window.setTimeout(() => setWfMsg(null), 3200)
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
      <button type="button" className="ds-back-btn" onClick={() => navigate('/admin/projects')}><span className="ds-back-btn__icon">←</span><span className="ds-back-btn__label">Projets</span></button>
      <div className="ds-empty"><div className="ds-empty__icon">📭</div><strong className="ds-empty__title">Projet introuvable</strong><p className="ds-empty__hint">Retournez a la liste des projets.</p></div>
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
      <div className="zitu-page__column">

        <button type="button" className="ds-back-btn" onClick={() => navigate('/admin/projects')}>
          <span className="ds-back-btn__icon">←</span><span className="ds-back-btn__label">Projets</span>
        </button>

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
            <div className="ds-hero__kpi-block"><span className="ds-hero__kpi-num">{project.year}</span><span className="ds-hero__kpi-unit">ANNEE</span></div>
          </div>
        </div>

        <div style={{ display: 'flex', gap: 6, marginBottom: 8 }}>
          <button type="button" className="zitu-page__btn" onClick={openEdit}>Modifier</button>
          <button type="button" className="zitu-page__btn zitu-page__btn--primary" onClick={openAdd}>+ Parcelle</button>
        </div>

        {project.mapUrl && <div className="prj-map"><iframe title="Carte" src={project.mapUrl} loading="lazy" /></div>}

        <div className="zitu-page__stats" style={{ marginBottom: 6 }}>
          <div className="zitu-page__stat" style={{ background: 'linear-gradient(135deg,#fff,#f8fbff)', border: '1px solid #dbeafe' }}><div className="zitu-page__stat-label">Valeur</div><div className="zitu-page__stat-value">{fmt(totalValue)}</div></div>
          <div className="zitu-page__stat" style={{ background: 'linear-gradient(135deg,#fff,#f8fbff)', border: '1px solid #dbeafe' }}><div className="zitu-page__stat-label">Revenu/an</div><div className="zitu-page__stat-value">~{fmt(totalRevenue)}</div></div>
        </div>
        <div className="zitu-page__stats" style={{ marginBottom: 8 }}>
          <div className="zitu-page__stat" style={{ background: 'linear-gradient(135deg,#fff,#f8fbff)', border: '1px solid #dbeafe' }}><div className="zitu-page__stat-label">Disponibles</div><div className="zitu-page__stat-value">{avail}/{plots.length}</div></div>
          <div className="zitu-page__stat" style={{ background: 'linear-gradient(135deg,#fff,#f8fbff)', border: '1px solid #dbeafe' }}><div className="zitu-page__stat-label">Offres</div><div className="zitu-page__stat-value">{offers.length}</div></div>
        </div>

        <div className="prj-health-section">
          <div style={{ fontSize: 10, fontWeight: 800, color: '#475569', textTransform: 'uppercase', letterSpacing: '.03em', marginBottom: 6 }}>Sante du projet</div>
          <div className="prj-health__grid">
            {[{ k: 'treeSante', l: 'Sante arbre' }, { k: 'humidity', l: 'Humidite sol' }, { k: 'nutrients', l: 'Nutriments' }].map(({ k, l }) => (
              <div key={k} className="prj-health__item">
                <span className="prj-health__bar" style={{ width: `${projHealth[k]}%` }} />
                <div className="prj-health__info"><span>{l}</span><strong>{projHealth[k]}%</strong></div>
                <input type="range" min="0" max="100" value={projHealth[k]} className="prj-health__slider" onChange={e => setHealth(k, e.target.value)} />
              </div>
            ))}
          </div>
        </div>

        <section className="prj-health-section" style={{ marginTop: 12 }}>
          <div style={{ fontSize: 10, fontWeight: 800, color: '#475569', textTransform: 'uppercase', letterSpacing: '.03em', marginBottom: 8 }}>
            Workflow vente &amp; frais (base de données)
          </div>
          <p style={{ fontSize: 11, color: '#64748b', margin: '0 0 10px' }}>
            Frais société / notaire, réservation, seuil payout, checklist signatures. Les ventes déjà créées gardent leur snapshot.
            {workflowLoading ? ' Chargement…' : ''}
          </p>
          <div className="zitu-page__form-grid">
            <div className="zitu-page__field"><label className="zitu-page__field-label">Frais société %</label><input className="zitu-page__input" type="number" value={wfCompany} onChange={(e) => setWfCompany(Number(e.target.value))} /></div>
            <div className="zitu-page__field"><label className="zitu-page__field-label">Frais notaire %</label><input className="zitu-page__input" type="number" value={wfNotary} onChange={(e) => setWfNotary(Number(e.target.value))} /></div>
            <div className="zitu-page__field">
              <label className="zitu-page__field-label">Seuil payout min. (TND)</label>
              <input className="zitu-page__input" type="number" value={wfMinPay} onChange={(e) => setWfMinPay(Number(e.target.value))} />
              <span style={{ fontSize: 10, color: '#64748b', marginTop: 4, display: 'block', lineHeight: 1.4 }}>
                Plancher de <strong>retrait</strong> du portefeuille parrainage — pas le montant L1/L2. Les règles L1/L2 se configurent plus bas.
              </span>
            </div>
            <div className="zitu-page__field"><label className="zitu-page__field-label">Réservation (h)</label><input className="zitu-page__input" type="number" value={wfResH} onChange={(e) => setWfResH(Number(e.target.value))} /></div>
            <div className="zitu-page__field"><label className="zitu-page__field-label">Arabon défaut (TND)</label><input className="zitu-page__input" type="number" value={wfArabon} onChange={(e) => setWfArabon(Number(e.target.value))} /></div>
          </div>
          <div className="zitu-page__field" style={{ marginTop: 8 }}>
            <label className="zitu-page__field-label">Checklist notaire</label>
            <div style={{ display: 'grid', gap: 8 }}>
              {checklistItems.map((item, idx) => (
                <div key={`${idx}-${item.key}`} style={{ border: '1px solid var(--100)', borderRadius: 10, padding: 10, background: '#fff' }}>
                  <div style={{ display: 'grid', gap: 6 }}>
                    <input
                      className="zitu-page__input"
                      placeholder="Clé (ex: contract)"
                      value={item.key}
                      onChange={(e) => updateChecklistRow(idx, { key: e.target.value })}
                    />
                    <input
                      className="zitu-page__input"
                      placeholder="Label affiché"
                      value={item.label}
                      onChange={(e) => updateChecklistRow(idx, { label: e.target.value })}
                    />
                    <input
                      className="zitu-page__input"
                      placeholder="Pages accordées (séparées par virgule) ex: /admin/sell"
                      value={item.grantAllowedPagesText}
                      onChange={(e) => updateChecklistRow(idx, { grantAllowedPagesText: e.target.value })}
                    />
                    <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12 }}>
                      <input
                        type="checkbox"
                        checked={item.required !== false}
                        onChange={(e) => updateChecklistRow(idx, { required: e.target.checked })}
                      />
                      Requis
                    </label>
                  </div>
                  <div style={{ display: 'flex', gap: 6, marginTop: 8 }}>
                    <button type="button" className="zitu-page__btn zitu-page__btn--secondary zitu-page__btn--sm" onClick={() => moveChecklistRow(idx, -1)}>↑</button>
                    <button type="button" className="zitu-page__btn zitu-page__btn--secondary zitu-page__btn--sm" onClick={() => moveChecklistRow(idx, 1)}>↓</button>
                    <button
                      type="button"
                      className="zitu-page__btn zitu-page__btn--danger zitu-page__btn--sm"
                      onClick={() => setChecklistItems((prev) => prev.filter((_, i) => i !== idx))}
                    >
                      Supprimer
                    </button>
                  </div>
                </div>
              ))}
              <button
                type="button"
                className="zitu-page__btn zitu-page__btn--secondary zitu-page__btn--sm"
                onClick={() => setChecklistItems((prev) => [...prev, { ...EMPTY_CHECK_ITEM }])}
              >
                + Ajouter un élément
              </button>
            </div>
          </div>
          {wfMsg ? <div style={{ fontSize: 12, color: '#059669', marginTop: 6 }}>{wfMsg}</div> : null}
          <button type="button" className="zitu-page__btn zitu-page__btn--primary" style={{ marginTop: 8 }} disabled={workflowLoading} onClick={() => void saveWorkflowConfig()}>Enregistrer le workflow projet</button>

          {/*
            Embedded commission-rules editor — same component as
            /admin/referral-settings so admins configure L1/L2… where they
            already set fees and payout threshold, without page-hopping.
          */}
          <CommissionRulesEditor projectId={project?.id || ''} />
          {project?.id ? (
            <p style={{ margin: '10px 0 0', fontSize: 12, color: '#64748b' }}>
              <button
                type="button"
                className="zitu-page__btn zitu-page__btn--secondary zitu-page__btn--sm"
                onClick={() => navigate(`/admin/referral-settings?project=${encodeURIComponent(project.id)}`)}
              >
                Ouvrir la page commissions dédiée
              </button>
              <span style={{ marginLeft: 8 }}>— même éditeur, URL partageable.</span>
            </p>
          ) : null}
        </section>

        <section className="prj-offers">
          <div className="prj-offers__head"><span className="prj-offers__title">Offres de paiement</span><button type="button" className="zitu-page__btn zitu-page__btn--primary zitu-page__btn--sm" onClick={openAddO}>+ Ajouter</button></div>
          {offers.length === 0 ? <p className="prj-offers__empty">Aucune offre.</p> : (
            <div className="prj-offers__list">{offers.map((o, i) => {
              const pv = avgPrice && o.duration ? { mo: (avgPrice - avgPrice * (o.downPayment ?? o.avancePct ?? 0) / 100) / o.duration } : null
              return (
                <button key={o.dbId || i} type="button" className="prj-offer" onClick={() => openEditO(o, i)}>
                  <div className="prj-offer__top"><span className="prj-offer__name">{o.name || o.label}</span>{o.note && <span className="prj-offer__note">{o.note}</span>}</div>
                  <div className="prj-offer__meta"><span>{o.downPayment ?? o.avancePct}%</span><span>·</span><span>{o.duration} mois</span>{pv && <span>· ~{Math.round(pv.mo).toLocaleString('fr-FR')} DT/mois</span>}</div>
                </button>
              )
            })}</div>
          )}
        </section>

        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', margin: '10px 0 6px', fontSize: 10, fontWeight: 800, color: '#475569', textTransform: 'uppercase', letterSpacing: '.03em' }}>
          <span>Parcelles</span>
          <span style={{ fontSize: 10, fontWeight: 800, color: '#2563eb', background: 'rgba(37,99,235,.08)', padding: '2px 6px', borderRadius: 5 }}>{plots.length}</span>
        </div>
        <div className="zitu-page__search-wrap" style={{ marginBottom: 6 }}>
          <input className="zitu-page__search" placeholder="N° parcelle, arbres, surface..." value={parcelQ} onChange={e => setParcelQ(e.target.value)} />
          <span className="zitu-page__search-icon" aria-hidden>🔎</span>
        </div>
        <div className="prj-table-head">
          <span className="prj-table-head__col prj-table-head__col--id">#</span>
          <span className="prj-table-head__col">Arbres</span>
          <span className="prj-table-head__col">m²</span>
          <span className="prj-table-head__col">Prix</span>
          <span className="prj-table-head__col prj-table-head__col--status">Statut</span>
        </div>
        <section className="prj-table">
          {filteredPlots.length === 0 ? (
            <div className="ds-empty" style={{ margin: '4px 0' }}><div className="ds-empty__icon">🌱</div><strong className="ds-empty__title">{plots.length === 0 ? 'Aucune parcelle' : 'Aucun resultat'}</strong></div>
          ) : (
            filteredPlots.map(pl => (
              <button key={pl.dbId || pl.id} type="button" className="prj-table-row" onClick={() => openEditPl(pl)}>
                <span className="prj-table-row__id">#{pl.id}</span>
                <span className="prj-table-row__val">{pl.trees}</span>
                <span className="prj-table-row__val">{pl.area}</span>
                <span className="prj-table-row__val">{(Number(pl.totalPrice) || 0).toLocaleString('fr-FR')}</span>
                <span className="prj-table-row__status">{sLbl(pl.status)}</span>
              </button>
            ))
          )}
        </section>
        <div className="prj-results-count">{filteredPlots.length}/{plots.length} parcelles</div>

        <AdminModal open={modal === 'edit'} onClose={() => setModal(null)} title="Modifier le projet">
          <div className="zitu-page__field"><label className="zitu-page__field-label">Nom</label><input className="zitu-page__input" value={pf.title} onChange={e => setPf(f => ({ ...f, title: e.target.value }))} /></div>
          <div className="zitu-page__form-grid">
            <div className="zitu-page__field"><label className="zitu-page__field-label">Ville</label><input className="zitu-page__input" value={pf.city} onChange={e => setPf(f => ({ ...f, city: e.target.value }))} /></div>
            <div className="zitu-page__field"><label className="zitu-page__field-label">Region</label><input className="zitu-page__input" value={pf.region} onChange={e => setPf(f => ({ ...f, region: e.target.value }))} /></div>
          </div>
          <div className="zitu-page__form-grid">
            <div className="zitu-page__field"><label className="zitu-page__field-label">Superficie</label><input className="zitu-page__input" value={pf.area} onChange={e => setPf(f => ({ ...f, area: e.target.value }))} /></div>
            <div className="zitu-page__field"><label className="zitu-page__field-label">Annee</label><input className="zitu-page__input" type="number" value={pf.year} onChange={e => setPf(f => ({ ...f, year: e.target.value }))} /></div>
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
          <div className="zitu-page__field"><label className="zitu-page__field-label">Statut</label><select className="zitu-page__input" value={pcf.status} onChange={e => setPcf(f => ({ ...f, status: e.target.value }))}><option value="available">Disponible</option><option value="reserved">Reserve</option><option value="sold">Vendue</option></select></div>
          <div className="zitu-page__form-actions">
            <button type="button" className="zitu-page__btn" onClick={() => setModal(null)}>Annuler</button>
            <button type="button" className="zitu-page__btn zitu-page__btn--primary" disabled={!pcf.id || !pcf.trees || saving} onClick={saveNew}>{saving ? 'Ajout…' : 'Ajouter'}</button>
          </div>
        </AdminModal>

        <AdminModal open={modal === 'offer'} onClose={() => setModal(null)} title={eoIdx >= 0 ? 'Modifier l\'offre' : 'Nouvelle offre'}>
          <div className="zitu-page__field"><label className="zitu-page__field-label">Nom *</label><input className="zitu-page__input" placeholder="Essentiel 20/24" value={of.label} onChange={e => setOf(f => ({ ...f, label: e.target.value }))} /></div>
          <div className="zitu-page__form-grid">
            <div className="zitu-page__field"><label className="zitu-page__field-label">Avance %</label><input className="zitu-page__input" type="number" placeholder="20" value={of.avancePct} onChange={e => setOf(f => ({ ...f, avancePct: e.target.value }))} /></div>
            <div className="zitu-page__field"><label className="zitu-page__field-label">Mois</label><input className="zitu-page__input" type="number" placeholder="24" value={of.duration} onChange={e => setOf(f => ({ ...f, duration: e.target.value }))} /></div>
          </div>
          <div className="zitu-page__field"><label className="zitu-page__field-label">Note</label><input className="zitu-page__input" placeholder="Le plus populaire..." value={of.note} onChange={e => setOf(f => ({ ...f, note: e.target.value }))} /></div>
          {avgPrice > 0 && Number(of.avancePct) > 0 && Number(of.duration) > 0 && (
            <div className="prj-offer-preview-box">
              <span className="prj-offer-preview-box__lbl">Simulation (parcelle moy. {fmt(avgPrice)})</span>
              <div className="prj-offer-preview-box__row"><span>Avance</span><strong>{fmt(avgPrice * Number(of.avancePct) / 100)}</strong></div>
              <div className="prj-offer-preview-box__row"><span>Mensualite</span><strong>{fmt((avgPrice - avgPrice * Number(of.avancePct) / 100) / Number(of.duration))}</strong></div>
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
              <div className="zitu-page__field"><label className="zitu-page__field-label">Statut</label><select className="zitu-page__input" value={pcf.status} onChange={e => setPcf(f => ({ ...f, status: e.target.value }))}><option value="available">Disponible</option><option value="reserved">Reserve</option><option value="sold">Vendue</option></select></div>
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

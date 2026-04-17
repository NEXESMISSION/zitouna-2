import { useMemo, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { useProjects } from '../../lib/useSupabase.js'
import CommissionRulesEditor from '../components/CommissionRulesEditor.jsx'
import './zitouna-admin-page.css'

export default function ReferralCommissionSettingsPage() {
  const navigate = useNavigate()
  const [searchParams, setSearchParams] = useSearchParams()
  const { projects } = useProjects()
  const [manualSelectedId, setManualSelectedId] = useState('')

  // Deep-link from the project detail page: ?project=<id>. Honour it on mount
  // and whenever projects load, so the admin lands on the right entry.
  const queryProject = searchParams.get('project') || ''

  // Derive the effective selection instead of syncing via useEffect:
  // 1) explicit manual selection wins,
  // 2) otherwise fall back to the URL-provided project when it exists,
  // 3) otherwise default to the first available project.
  const selectedId = useMemo(() => {
    const list = projects || []
    if (!list.length) return ''
    if (manualSelectedId && list.some((p) => p.id === manualSelectedId)) return manualSelectedId
    if (queryProject && list.some((p) => p.id === queryProject)) return queryProject
    return list[0].id
  }, [projects, queryProject, manualSelectedId])

  const onSelectProject = (id) => {
    setManualSelectedId(id)
    // Keep the URL in sync so refresh / share keeps the same project selected.
    const next = new URLSearchParams(searchParams)
    if (id) next.set('project', id); else next.delete('project')
    setSearchParams(next, { replace: true })
  }

  const projectList = projects || []
  const selectedProject = projectList.find((p) => p.id === selectedId) || null
  const hasProjects = projectList.length > 0

  return (
    <div className="zitu-page" dir="ltr">
      {/* Local styles: responsive, high-readability page shell. Editor styles untouched. */}
      <style>{`
        .rcs-shell { max-width: 960px; margin: 0 auto; padding: 16px; }
        .rcs-back {
          display: inline-flex; align-items: center; gap: 8px;
          background: transparent; border: 1px solid rgba(148,163,184,0.35);
          color: inherit; padding: 8px 14px; border-radius: 10px;
          font-size: 14px; cursor: pointer; margin-bottom: 18px;
        }
        .rcs-back:hover { background: rgba(148,163,184,0.12); }
        .rcs-hero {
          display: flex; gap: 16px; align-items: flex-start;
          padding: 20px 22px; border-radius: 16px;
          background: linear-gradient(135deg, #0f766e 0%, #0284c7 100%);
          color: #fff; margin-bottom: 18px;
          box-shadow: 0 6px 24px rgba(2,132,199,0.25);
        }
        .rcs-hero__badge {
          width: 46px; height: 46px; flex: 0 0 46px;
          border-radius: 12px; background: rgba(255,255,255,0.18);
          display: flex; align-items: center; justify-content: center;
          font-size: 22px; font-weight: 700;
        }
        .rcs-hero h1 { margin: 0 0 6px; font-size: 22px; font-weight: 700; line-height: 1.25; }
        .rcs-hero p { margin: 0; font-size: 14px; line-height: 1.5; opacity: 0.95; }

        .rcs-steps {
          display: grid; grid-template-columns: 1fr 1fr; gap: 10px;
          margin-bottom: 18px;
        }
        .rcs-step {
          display: flex; gap: 10px; align-items: flex-start;
          padding: 12px 14px; border-radius: 12px;
          background: rgba(148,163,184,0.10);
          border: 1px solid rgba(148,163,184,0.25);
        }
        .rcs-step__num {
          width: 26px; height: 26px; flex: 0 0 26px;
          border-radius: 50%; background: #0f766e; color: #fff;
          display: flex; align-items: center; justify-content: center;
          font-size: 13px; font-weight: 700;
        }
        .rcs-step__title { font-size: 14px; font-weight: 600; margin: 0 0 2px; }
        .rcs-step__hint { font-size: 13px; margin: 0; opacity: 0.8; line-height: 1.4; }

        .rcs-card {
          border: 1px solid rgba(148,163,184,0.25);
          border-radius: 14px; padding: 18px 20px; margin-bottom: 18px;
          background: rgba(255,255,255,0.02);
        }
        .rcs-card__head {
          display: flex; align-items: center; justify-content: space-between;
          gap: 12px; margin-bottom: 12px; flex-wrap: wrap;
        }
        .rcs-card__title {
          font-size: 18px; font-weight: 700; margin: 0;
          display: flex; align-items: center; gap: 10px;
        }
        .rcs-card__chip {
          display: inline-flex; align-items: center; gap: 6px;
          font-size: 12px; font-weight: 600; padding: 4px 10px;
          border-radius: 999px; background: rgba(15,118,110,0.15);
          color: #0f766e; border: 1px solid rgba(15,118,110,0.3);
        }
        .rcs-card__hint { font-size: 13px; margin: 0 0 12px; opacity: 0.75; line-height: 1.5; }

        .rcs-select {
          width: 100%; font-size: 15px; padding: 12px 14px;
          border-radius: 10px; border: 1px solid rgba(148,163,184,0.4);
          background: #fff; color: #0f172a; cursor: pointer;
          appearance: none;
          background-image: url("data:image/svg+xml;charset=UTF-8,%3csvg xmlns='http://www.w3.org/2000/svg' width='12' height='8' viewBox='0 0 12 8'%3e%3cpath fill='%23475569' d='M6 8L0 0h12z'/%3e%3c/svg%3e");
          background-repeat: no-repeat;
          background-position: right 14px center;
          padding-right: 38px;
        }
        .rcs-select:focus { outline: 2px solid #0284c7; outline-offset: 1px; }
        .rcs-select:disabled { opacity: 0.6; cursor: not-allowed; }

        .rcs-empty {
          padding: 14px; border-radius: 10px; font-size: 13px;
          background: rgba(234,179,8,0.12); color: #854d0e;
          border: 1px solid rgba(234,179,8,0.35); margin-top: 10px;
        }

        .rcs-editor-intro {
          display: flex; gap: 10px; padding: 12px 14px;
          border-radius: 10px; background: rgba(2,132,199,0.08);
          border: 1px solid rgba(2,132,199,0.25);
          font-size: 13px; line-height: 1.5; margin-bottom: 14px;
        }
        .rcs-editor-intro__icon { font-weight: 700; color: #0284c7; }

        @media (max-width: 600px) {
          .rcs-shell { padding: 12px; }
          .rcs-hero { padding: 16px; border-radius: 14px; }
          .rcs-hero h1 { font-size: 19px; }
          .rcs-steps { grid-template-columns: 1fr; }
          .rcs-card { padding: 14px; }
          .rcs-card__title { font-size: 17px; }
        }
      `}</style>

      <div className="zitu-page__column rcs-shell">
        <button type="button" className="rcs-back" onClick={() => navigate(-1)}>
          <span aria-hidden>←</span>
          <span>Retour</span>
        </button>

        {/* Hero: explain the page in one sentence */}
        <section className="rcs-hero" aria-labelledby="rcs-title">
          <div className="rcs-hero__badge" aria-hidden>%</div>
          <div>
            <h1 id="rcs-title">Commissions de parrainage</h1>
            <p>
              Définissez, par projet, les commissions versées aux parrains des niveaux
              supérieurs (uplines) lors d'une vente. Montant fixe ou pourcentage — figés
              au moment de la création de la vente.
            </p>
          </div>
        </section>

        {/* Quick steps: help any staff member understand on first visit */}
        <ol className="rcs-steps" aria-label="Étapes">
          <li className="rcs-step">
            <span className="rcs-step__num">1</span>
            <div>
              <p className="rcs-step__title">Choisissez un projet</p>
              <p className="rcs-step__hint">Les règles sont propres à chaque projet.</p>
            </div>
          </li>
          <li className="rcs-step">
            <span className="rcs-step__num">2</span>
            <div>
              <p className="rcs-step__title">Éditez les règles</p>
              <p className="rcs-step__hint">Ajoutez un niveau, puis saisissez le montant ou le %.</p>
            </div>
          </li>
        </ol>

        {/* Step 1 — project picker, prominent */}
        <section className="rcs-card" aria-labelledby="rcs-step-project">
          <div className="rcs-card__head">
            <h2 id="rcs-step-project" className="rcs-card__title">
              <span aria-hidden>1.</span> Projet
            </h2>
            {selectedProject ? (
              <span className="rcs-card__chip" title="Projet sélectionné">
                Sélectionné : {selectedProject.title}
              </span>
            ) : null}
          </div>
          <p className="rcs-card__hint">
            Sélectionnez le projet dont vous souhaitez configurer les commissions de parrainage.
          </p>
          <label htmlFor="rcs-project-select" style={{ display: 'none' }}>Projet</label>
          <select
            id="rcs-project-select"
            className="rcs-select"
            value={selectedId}
            onChange={(e) => onSelectProject(e.target.value)}
            disabled={!hasProjects}
          >
            {!hasProjects ? (
              <option value="">Aucun projet disponible</option>
            ) : (
              projectList.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.title}
                </option>
              ))
            )}
          </select>
          {!hasProjects ? (
            <div className="rcs-empty">
              Aucun projet n'est encore créé. Créez d'abord un projet pour pouvoir définir ses règles de commission.
            </div>
          ) : null}
        </section>

        {/* Step 2 — rules editor (unchanged component) */}
        <section className="rcs-card" aria-labelledby="rcs-step-rules">
          <div className="rcs-card__head">
            <h2 id="rcs-step-rules" className="rcs-card__title">
              <span aria-hidden>2.</span> Règles de commission
            </h2>
          </div>
          <p className="rcs-card__hint">
            Configurez un niveau par rangée. Vous pouvez combiner un montant fixe (TND)
            et/ou un pourcentage (%) du prix convenu.
          </p>
          <div className="rcs-editor-intro" role="note">
            <span className="rcs-editor-intro__icon" aria-hidden>i</span>
            <span>
              Astuce : les règles sont enregistrées par projet. Les ventes déjà créées
              conservent les valeurs en vigueur au moment de leur enregistrement.
            </span>
          </div>
          <CommissionRulesEditor projectId={selectedId} />
        </section>
      </div>
    </div>
  )
}

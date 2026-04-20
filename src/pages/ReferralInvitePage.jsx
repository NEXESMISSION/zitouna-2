import { useEffect, useState } from 'react'
import { useParams, useNavigate, Link } from 'react-router-dom'
import { supabase } from '../lib/supabase.js'
import RenderDataGate from '../components/RenderDataGate.jsx'
import EmptyState from '../components/EmptyState.jsx'
import ErrorPanel from '../components/ErrorPanel.jsx'

export default function ReferralInvitePage() {
  const { code } = useParams()
  const navigate = useNavigate()
  // Plan 04 §3.4 — single state shape that lets us distinguish the three
  // terminal branches ("still fetching" vs "fetch returned null" vs
  // "fetch returned a row"). The seed reflects the URL at mount time so
  // the effect body never needs to call setState synchronously (which
  // react-hooks/set-state-in-effect flags as a cascading render).
  const [state, setState] = useState(() => ({
    loading: Boolean(code),
    referrer: null,
    err: '',
  }))
  // Retry nonce — bumping it re-runs the fetch effect below.
  const [retryTick, setRetryTick] = useState(0)

  useEffect(() => {
    if (!code) return undefined
    try {
      sessionStorage.setItem('zitouna_ref_code', code)
    } catch {
      /* sessionStorage may be unavailable (private mode, SSR) */
    }
    let cancelled = false
    ;(async () => {
      try {
        const { data, error } = await supabase
          .from('clients')
          .select('id, full_name, code')
          .eq('referral_code', code)
          .maybeSingle()
        if (cancelled) return
        // setState inside an async callback (not synchronously in the
        // effect body) is accepted by the rule.
        setState({ loading: false, referrer: data || null, err: error?.message || '' })
      } catch (e) {
        if (!cancelled) setState({ loading: false, referrer: null, err: String(e?.message || e) })
      }
    })()
    return () => { cancelled = true }
  }, [code, retryTick])

  const retry = () => {
    // Two event-handler setStates (legal outside of effect bodies):
    // flip to loading and bump the nonce so the effect re-runs.
    setState({ loading: true, referrer: null, err: '' })
    setRetryTick((t) => t + 1)
  }

  return (
    <div className="auth-page" style={{ padding: 32, maxWidth: 480, margin: '0 auto', textAlign: 'center' }}>
      <h1 style={{ fontSize: 24, fontWeight: 800 }}>Bienvenue sur Zitouna Bladi 🌿</h1>
      {!code ? (
        <p>Lien d&apos;invitation invalide.</p>
      ) : (
        <RenderDataGate
          loading={state.loading}
          error={state.err || null}
          data={state.referrer}
          skeleton="line"
          isEmpty={(data) => !data}
          onRetry={retry}
          errorView={(err) => (
            <ErrorPanel
              error={err}
              title="Impossible de vérifier le code"
              hint="Vérifiez votre connexion puis réessayez."
              onRetry={retry}
            />
          )}
          empty={
            <EmptyState
              title="Lien d'invitation introuvable"
              description="Ce code n'est plus valide. Vous pouvez tout de même créer un compte."
              action={{ label: 'Créer un compte', onClick: () => navigate('/register') }}
            />
          }
        >
          {(referrer) => (
            <>
              <p style={{ marginTop: 12 }}>Vous êtes invité par <strong>{referrer.full_name}</strong> ({referrer.code}).</p>
              <p style={{ color: '#5b6a58', fontSize: 14, lineHeight: 1.5, marginTop: 16 }}>
                Créez votre compte pour rejoindre le programme d&apos;investissement dans l&apos;oliveraie. Votre parrain sera automatiquement enregistré.
              </p>
              <button className="btn btn--primary" style={{ marginTop: 24 }} onClick={() => navigate(`/register?ref=${code}`)}>
                Créer mon compte
              </button>
              <p style={{ fontSize: 12, marginTop: 16 }}><Link to="/login">Déjà inscrit ? Se connecter</Link></p>
            </>
          )}
        </RenderDataGate>
      )}
    </div>
  )
}

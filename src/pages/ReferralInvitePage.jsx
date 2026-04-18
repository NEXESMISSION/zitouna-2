import { useEffect, useState } from 'react'
import { useParams, useNavigate, Link } from 'react-router-dom'
import { supabase } from '../lib/supabase.js'

export default function ReferralInvitePage() {
  const { code } = useParams()
  const navigate = useNavigate()
  const [referrer, setReferrer] = useState(null)
  const [err, setErr] = useState('')

  useEffect(() => {
    if (!code) return
    try {
      sessionStorage.setItem('zitouna_ref_code', code)
    } catch {
      /* sessionStorage may be unavailable (private mode, SSR) */
    }
    ;(async () => {
      const { data, error } = await supabase
        .from('clients')
        .select('id, full_name, code')
        .eq('referral_code', code)
        .maybeSingle()
      if (error) setErr(error.message)
      else setReferrer(data)
    })()
  }, [code])

  return (
    <div className="auth-page" style={{ padding: 32, maxWidth: 480, margin: '0 auto', textAlign: 'center' }}>
      <h1 style={{ fontSize: 24, fontWeight: 800 }}>Bienvenue sur Zitouna Bladi 🌿</h1>
      {!code ? (
        <p>Lien d'invitation invalide.</p>
      ) : err ? (
        <p style={{ color: '#b91c1c' }}>Erreur : {err}</p>
      ) : referrer ? (
        <>
          <p style={{ marginTop: 12 }}>Vous êtes invité par <strong>{referrer.full_name}</strong> ({referrer.code}).</p>
          <p style={{ color: '#5b6a58', fontSize: 14, lineHeight: 1.5, marginTop: 16 }}>
            Créez votre compte pour rejoindre le programme d'investissement dans l'oliveraie. Votre parrain sera automatiquement enregistré.
          </p>
          <button className="btn btn--primary" style={{ marginTop: 24 }} onClick={() => navigate(`/register?ref=${code}`)}>
            Créer mon compte
          </button>
          <p style={{ fontSize: 12, marginTop: 16 }}><Link to="/login">Déjà inscrit ? Se connecter</Link></p>
        </>
      ) : (
        <p>Chargement…</p>
      )}
    </div>
  )
}

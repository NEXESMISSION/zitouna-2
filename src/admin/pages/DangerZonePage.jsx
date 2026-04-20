import { useState } from 'react'
import { useAuth } from '../../lib/AuthContext.jsx'
import * as db from '../../lib/db.js'
import { emitInvalidate } from '../../lib/dataEvents.js'

export default function DangerZonePage() {
  const { adminUser } = useAuth()
  const [busy, setBusy] = useState(false)
  const [confirmText, setConfirmText] = useState('')
  const [result, setResult] = useState(null)
  const [err, setErr] = useState('')

  const CONFIRM_PHRASE = 'REBUILD COMMISSIONS'

  const runRebuild = async () => {
    if (busy) return
    if (confirmText.trim() !== CONFIRM_PHRASE) {
      setErr(`Tapez exactement "${CONFIRM_PHRASE}" pour confirmer.`)
      return
    }
    setBusy(true)
    setErr('')
    setResult(null)
    try {
      const summary = await db.rebuildCommissionGraphFromSalesHistory({
        actorUserId: adminUser?.id || null,
        actorEmail: adminUser?.email || '',
      })
      setResult(summary)
      setConfirmText('')
      emitInvalidate('sales')
    } catch (e) {
      setErr(String(e?.message || e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="adm-page" style={{ padding: 24, maxWidth: 820 }}>
      <h1>Zone de danger</h1>
      <p style={{ color: '#64748b' }}>
        Opérations irréversibles réservées à la phase de test. Ne pas exécuter en production sans sauvegarde.
      </p>

      <section style={{
        marginTop: 24, padding: 20, borderRadius: 10,
        border: '2px solid #fecaca', background: '#fef2f2',
      }}>
        <h2 style={{ margin: 0, color: '#991b1b' }}>Reconstruire le graphe des commissions</h2>
        <p style={{ marginTop: 8, color: '#7f1d1d' }}>
          Supprime toutes les <code>seller_relations</code> et tous les <code>commission_events</code> non verrouillés
          (les événements déjà <strong>payés</strong> ou attachés à une demande de paiement <strong>approuvée</strong>
          sont conservés), puis rejoue chronologiquement chaque vente finalisée chez le notaire sous le nouveau modèle :
          le lien pyramide est créé au moment de la finalisation notariale, <code>enfant = acheteur</code>,
          <code> parent = vendeur</code>.
        </p>

        <label style={{ display: 'block', marginTop: 16, fontWeight: 600, color: '#7f1d1d' }}>
          Pour confirmer, tapez&nbsp;: <code>{CONFIRM_PHRASE}</code>
        </label>
        <input
          type="text"
          value={confirmText}
          onChange={(e) => setConfirmText(e.target.value)}
          disabled={busy}
          style={{
            width: '100%', padding: '8px 12px', marginTop: 6,
            borderRadius: 6, border: '1px solid #fca5a5', fontFamily: 'monospace',
          }}
          placeholder={CONFIRM_PHRASE}
        />

        <button
          type="button"
          onClick={runRebuild}
          disabled={busy || confirmText.trim() !== CONFIRM_PHRASE}
          style={{
            marginTop: 12, padding: '10px 18px',
            background: busy ? '#94a3b8' : '#dc2626',
            color: 'white', border: 0, borderRadius: 6, fontWeight: 600,
            cursor: busy ? 'wait' : 'pointer',
          }}
        >
          {busy ? 'Reconstruction en cours…' : 'Reconstruire maintenant'}
        </button>

        {err && (
          <div style={{
            marginTop: 12, padding: 10, borderRadius: 6,
            background: '#fef3c7', color: '#92400e', border: '1px solid #fde68a',
          }}>{err}</div>
        )}

        {result && (
          <div style={{
            marginTop: 12, padding: 12, borderRadius: 6,
            background: '#ecfdf5', color: '#065f46', border: '1px solid #a7f3d0',
          }}>
            <strong>Reconstruction terminée.</strong>
            <ul style={{ marginTop: 8 }}>
              <li>Relations supprimées&nbsp;: {result.deletedRelations}</li>
              <li>Événements supprimés&nbsp;: {result.deletedEvents}</li>
              <li>Ventes rejouées&nbsp;: {result.replayedSales}</li>
              <li>Nouveaux liens créés&nbsp;: {result.createdLinks}</li>
              <li>Nouveaux événements créés&nbsp;: {result.createdEvents}</li>
              {result.skippedSales?.length > 0 && (
                <li>Ventes ignorées (verrouillées)&nbsp;: {result.skippedSales.length}</li>
              )}
              {result.errors?.length > 0 && (
                <li style={{ color: '#92400e' }}>Erreurs&nbsp;: {result.errors.length}</li>
              )}
            </ul>
            {result.errors?.length > 0 && (
              <details style={{ marginTop: 8 }}>
                <summary>Détails des erreurs</summary>
                <pre style={{ whiteSpace: 'pre-wrap', fontSize: 12 }}>
                  {JSON.stringify(result.errors, null, 2)}
                </pre>
              </details>
            )}
          </div>
        )}
      </section>
    </div>
  )
}

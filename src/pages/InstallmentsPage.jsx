import { useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import TopBar from '../TopBar.jsx'
import { loadInstallments, saveInstallments } from '../installmentsStore.js'

function fmtDate(iso) {
  return new Date(iso).toLocaleDateString('fr-FR', { day: '2-digit', month: 'short', year: 'numeric' })
}

function isPayable(status) {
  return status === 'pending' || status === 'rejected'
}

export default function InstallmentsPage() {
  const navigate = useNavigate()
  const [plans, setPlans] = useState(loadInstallments)
  const [selectedKeys, setSelectedKeys] = useState([])
  const [receiptName, setReceiptName] = useState('')
  const [note, setNote] = useState('')

  const selectedCount = selectedKeys.length
  const selectedTotal = useMemo(() => {
    const keySet = new Set(selectedKeys)
    let total = 0
    plans.forEach((plan) => {
      plan.payments.forEach((p) => {
        const key = `${plan.id}:${p.month}`
        if (keySet.has(key)) total += p.amount
      })
    })
    return total
  }, [plans, selectedKeys])

  const toggle = (planId, month) => {
    const key = `${planId}:${month}`
    setSelectedKeys((prev) => (prev.includes(key) ? prev.filter((k) => k !== key) : [...prev, key]))
  }

  const submitBatch = () => {
    if (!receiptName || selectedKeys.length === 0) return
    const keySet = new Set(selectedKeys)
    const next = plans.map((plan) => ({
      ...plan,
      status: 'active',
      payments: plan.payments.map((p) => {
        const key = `${plan.id}:${p.month}`
        if (!keySet.has(key)) return p
        return {
          ...p,
          status: 'submitted',
          receiptName: receiptName,
          rejectedNote: undefined,
          note: note || undefined,
        }
      }),
    }))
    setPlans(next)
    saveInstallments(next)
    setSelectedKeys([])
    setReceiptName('')
    setNote('')
  }

  return (
    <main className="screen screen--app">
      <section className="dashboard-page installments-page" style={{ paddingBottom: '6rem' }}>
        <TopBar />
        <div className="detail-nav">
          <button type="button" className="back-btn" onClick={() => navigate('/dashboard')}>
            Retour dashboard
          </button>
        </div>

        <div className="installments-head">
          <h2>Mes échéances de paiement</h2>
          <p>Sélectionnez plusieurs mensualités puis envoyez un seul reçu.</p>
        </div>

        <div className="installments-list">
          {plans.map((plan) => (
            <div key={plan.id} className="installments-plan">
              <div className="installments-plan-top">
                <strong>{plan.projectTitle}</strong>
                <span>{plan.city} · #{plan.id}</span>
              </div>
              <div className="installments-items">
                {plan.payments.map((p) => {
                  const key = `${plan.id}:${p.month}`
                  const payable = isPayable(p.status)
                  const checked = selectedKeys.includes(key)
                  return (
                    <label key={key} className={`inst-item${payable ? '' : ' inst-item--off'}`}>
                      <input
                        type="checkbox"
                        checked={checked}
                        disabled={!payable}
                        onChange={() => toggle(plan.id, p.month)}
                      />
                      <span className="inst-item-main">
                        F.{p.month} · {fmtDate(p.dueDate)} · {p.amount.toLocaleString()} DT
                      </span>
                      <span className={`inst-item-status inst-item-status--${p.status}`}>
                        {p.status === 'approved' ? 'Confirmé' : p.status === 'submitted' ? 'En révision' : p.status === 'rejected' ? 'Rejeté' : 'En attente'}
                      </span>
                    </label>
                  )
                })}
              </div>
            </div>
          ))}
        </div>

        <div className="installments-batch">
          <div className="installments-batch-line">
            <strong>{selectedCount} sélectionnée(s)</strong>
            <span>{selectedTotal.toLocaleString()} DT</span>
          </div>
          <label className="upload-zone">
            <input
              type="file"
              accept="image/*,.pdf"
              style={{ display: 'none' }}
              onChange={(e) => { if (e.target.files?.[0]) setReceiptName(e.target.files[0].name) }}
            />
            {receiptName ? `Fichier: ${receiptName}` : 'Choisir un reçu pour la sélection'}
          </label>
          <textarea
            className="upload-note"
            placeholder="Note optionnelle pour cette soumission groupée…"
            value={note}
            onChange={(e) => setNote(e.target.value)}
          />
          <button
            type="button"
            className={`proj-gold-cta${selectedCount > 0 && receiptName ? ' proj-gold-cta--active' : ''}`}
            disabled={selectedCount === 0 || !receiptName}
            onClick={submitBatch}
          >
            Payer la sélection
          </button>
        </div>
      </section>
    </main>
  )
}


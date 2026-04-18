import AdminModal from './AdminModal.jsx'
import * as tree from '../lib/referralTree.js'

function formatTnd(amount) {
  const n = Number(amount)
  if (!Number.isFinite(n)) return '—'
  return `${n.toLocaleString('fr-FR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} TND`
}

function formatDateTime(value) {
  if (!value) return '—'
  const d = new Date(value)
  if (Number.isNaN(d.getTime())) return String(value)
  return d.toLocaleString('fr-FR', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  })
}

function formatDate(value) {
  if (!value) return '—'
  const d = new Date(value)
  if (Number.isNaN(d.getTime())) return String(value)
  return d.toLocaleDateString('fr-FR', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  })
}

function normalizeLevel(raw) {
  if (raw === null || raw === undefined) return null
  const key = typeof raw === 'string' ? raw.toLowerCase().replace(/^l/, '') : String(raw)
  if (key === '1') return 1
  if (key === '2') return 2
  const num = Number(key)
  return Number.isFinite(num) ? num : null
}

function Section({ title, rows, children }) {
  return (
    <section style={{ border: '1px solid var(--adm-border)', borderRadius: 8, padding: 12 }}>
      <div style={{ fontWeight: 700, fontSize: 13, marginBottom: 8, letterSpacing: 0.3 }}>
        {title}
      </div>
      {Array.isArray(rows) && rows.length > 0 ? (
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: '140px 1fr',
            rowGap: 6,
            fontSize: 13,
          }}
        >
          {rows.map(([label, value], i) => (
            <Fragment key={i}>
              <div style={{ color: 'var(--adm-text-dim)' }}>{label}</div>
              <div style={{ fontWeight: 600 }}>{value}</div>
            </Fragment>
          ))}
        </div>
      ) : null}
      {children}
    </section>
  )
}

function Fragment({ children }) {
  // Lightweight inline fragment wrapper keeps grid children flat without
  // depending on React.Fragment import noise.
  return <>{children}</>
}

function LevelBadge({ level }) {
  const normalized = normalizeLevel(level)
  const label = normalized === 1 ? 'L1' : normalized === 2 ? 'L2' : level ? `L${level}` : '—'
  const bg = normalized === 1 ? '#dbeafe' : normalized === 2 ? '#ede9fe' : '#e2e8f0'
  const color = normalized === 1 ? '#1d4ed8' : normalized === 2 ? '#6d28d9' : '#475569'
  return (
    <span
      style={{
        display: 'inline-block',
        padding: '2px 8px',
        borderRadius: 999,
        background: bg,
        color,
        fontWeight: 700,
        fontSize: 12,
        letterSpacing: 0.3,
      }}
    >
      {label}
    </span>
  )
}

function clientLabel(client) {
  if (!client) return '—'
  return client.full_name || client.name || client.code || '—'
}

export default function CommissionEventDetailModal({ eventId, open, onClose, data }) {
  if (!open || !eventId) return null

  const commissionEvents = Array.isArray(data?.commissionEvents) ? data.commissionEvents : []
  const clients = Array.isArray(data?.clients) ? data.clients : []
  const sellerRelations = Array.isArray(data?.sellerRelations) ? data.sellerRelations : []
  const sales = Array.isArray(data?.sales) ? data.sales : []

  const event = commissionEvents.find((e) => e && String(e.id) === String(eventId))

  const footer = (
    <button className="adm-btn adm-btn--secondary" onClick={onClose}>
      Fermer
    </button>
  )

  if (!event) {
    return (
      <AdminModal open onClose={onClose} title="Détail commission" width={560} footer={footer}>
        <div>Événement introuvable.</div>
      </AdminModal>
    )
  }

  const beneficiary = clients.find((c) => c && String(c.id) === String(event.beneficiary_client_id)) || null
  const sale = sales.find((s) => s && String(s.id) === String(event.sale_id)) || null
  const seller = sale ? clients.find((c) => c && String(c.id) === String(sale.seller_client_id)) || null : null
  const buyer = sale ? clients.find((c) => c && String(c.id) === String(sale.client_id)) || null : null

  const parentMap = tree.buildParentMap(sellerRelations)
  const uplineIds = beneficiary ? tree.resolveUplineChain(beneficiary.id, parentMap) : []
  const uplineClients = uplineIds.map((id) => ({
    id,
    client: clients.find((c) => c && String(c.id) === String(id)) || null,
  }))

  let ruleSnapshotText = '—'
  if (event.rule_snapshot !== null && event.rule_snapshot !== undefined) {
    try {
      ruleSnapshotText = JSON.stringify(event.rule_snapshot, null, 2)
    } catch {
      ruleSnapshotText = String(event.rule_snapshot)
    }
  }

  const eventRows = [
    ['Niveau', <LevelBadge key="lvl" level={event.level} />],
    ['Montant', formatTnd(event.amount)],
    ['Statut', event.status || '—'],
    ['Créé le', formatDateTime(event.created_at)],
  ]

  const beneficiaryRows = [
    ['Nom', clientLabel(beneficiary)],
    ['Code', beneficiary?.code || '—'],
    ['Téléphone', beneficiary?.phone || beneficiary?.phone_normalized || '—'],
  ]

  const project = sale?.project_id
    ? (data?.projects || []).find((p) => String(p.id) === String(sale.project_id))
    : null
  const saleRows = [
    ['Code vente', sale?.code || '—'],
    ['Projet', project?.title || sale?.project_id || '—'],
    ['Prix convenu', sale?.agreed_price != null ? formatTnd(sale.agreed_price) : '—'],
    ['Notaire finalisé', formatDate(sale?.notary_completed_at)],
  ]

  const sellerRows = [
    ['Nom', clientLabel(seller)],
    ['Code', seller?.code || '—'],
  ]

  const buyerRows = [
    ['Nom', clientLabel(buyer)],
    ['Code', buyer?.code || '—'],
  ]

  return (
    <AdminModal open onClose={onClose} title="Détail commission" width={560} footer={footer}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        <Section title="ÉVÉNEMENT" rows={eventRows} />
        <Section title="BÉNÉFICIAIRE" rows={beneficiaryRows} />
        <Section title="VENTE" rows={saleRows} />
        <Section title="VENDEUR DIRECT" rows={sellerRows} />
        <Section title="ACHETEUR" rows={buyerRows} />
        <Section title="CHAÎNE PARRAINAGE">
          {uplineClients.length ? (
            <>
              <div
                style={{
                  fontSize: 13,
                  color: 'var(--adm-text-dim)',
                  marginBottom: 10,
                  lineHeight: 1.5,
                }}
              >
                {`Vente réalisée par ${clientLabel(uplineClients[0]?.client)}. ${Math.max(
                  uplineClients.length - 1,
                  0,
                )} personnes remontent la chaîne et reçoivent une commission indirecte sur cette vente.`}
              </div>
              <ol
                style={{
                  listStyle: 'none',
                  padding: 0,
                  margin: 0,
                  display: 'flex',
                  flexDirection: 'column',
                  fontSize: 13,
                }}
              >
                {uplineClients.map((entry, depth) => {
                  const c = entry.client
                  const palette =
                    depth === 0
                      ? '#1e40af'
                      : depth === 1
                      ? '#2563eb'
                      : depth === 2
                      ? '#f59e0b'
                      : depth === 3
                      ? '#10b981'
                      : '#64748b'
                  const isLast = depth === uplineClients.length - 1
                  const shortId = String(entry.id || '').slice(0, 8)
                  const rightLabel =
                    depth === 0
                      ? 'Bénéficiaire'
                      : depth === 1
                      ? 'Direct'
                      : `Indirect · Niveau ${depth}`
                  return (
                    <li
                      key={`${entry.id}-${depth}`}
                      style={{
                        display: 'grid',
                        gridTemplateColumns: '40px 1fr auto',
                        alignItems: 'center',
                        gap: 10,
                        minHeight: 36,
                      }}
                    >
                      <span
                        style={{
                          display: 'inline-flex',
                          justifyContent: 'center',
                          alignItems: 'center',
                          width: 32,
                          height: 24,
                          borderRadius: 6,
                          background: palette,
                          color: '#ffffff',
                          fontWeight: 700,
                          fontSize: 12,
                          letterSpacing: 0.3,
                        }}
                        title={depth === 0 ? 'Bénéficiaire' : `Niveau ${depth}`}
                      >
                        {`L${depth}`}
                      </span>
                      <span
                        style={{
                          fontWeight: 600,
                          paddingLeft: 12,
                          paddingTop: 6,
                          paddingBottom: 6,
                          borderLeft: isLast
                            ? '2px dashed transparent'
                            : '2px dashed var(--adm-border)',
                          marginLeft: 4,
                        }}
                      >
                        {c ? clientLabel(c) : shortId || '—'}
                        {c?.code ? (
                          <span
                            style={{
                              color: 'var(--adm-text-dim)',
                              fontWeight: 500,
                              marginLeft: 6,
                            }}
                          >
                            · {c.code}
                          </span>
                        ) : null}
                      </span>
                      <span
                        style={{
                          color: 'var(--adm-text-dim)',
                          fontSize: 12,
                          fontWeight: 500,
                          whiteSpace: 'nowrap',
                        }}
                      >
                        {rightLabel}
                      </span>
                    </li>
                  )
                })}
              </ol>
            </>
          ) : (
            <div style={{ color: 'var(--adm-text-dim)', fontSize: 13 }}>—</div>
          )}
        </Section>
        <Section title="RÈGLE (SNAPSHOT)">
          <pre
            style={{
              fontSize: 11,
              margin: 0,
              padding: 8,
              background: '#f8fafc',
              border: '1px solid var(--adm-border)',
              borderRadius: 6,
              whiteSpace: 'pre-wrap',
              wordBreak: 'break-word',
              maxHeight: 240,
              overflow: 'auto',
            }}
          >
            {ruleSnapshotText}
          </pre>
        </Section>
      </div>
    </AdminModal>
  )
}

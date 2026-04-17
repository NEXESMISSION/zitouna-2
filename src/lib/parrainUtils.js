export function resolveParrainClientIdForBuyer(buyerClient, clients = []) {
  if (!buyerClient) return ''
  if (buyerClient.referredByClientId) return buyerClient.referredByClientId
  if (!buyerClient.referralCode || !Array.isArray(clients)) return ''

  const code = String(buyerClient.referralCode || '').trim().toUpperCase()
  if (!code) return ''

  const sponsor = clients.find((c) => String(c.referralCode || '').trim().toUpperCase() === code)
  return sponsor?.id || ''
}


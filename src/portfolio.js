// Mock data: what this client has already purchased
// Revenue estimate: 1 olive tree ≈ 30 kg olives/year × 3 DT/kg = 90 DT/tree/year

export const myPurchases = [
  {
    projectId: 'tunis',
    plotId: 101,
    city: 'Tunis',
    region: 'La Marsa',
    trees: 48,
    invested: 72000,
    since: '2023-03',
    annualRevenue: 48 * 90, // 4 320 DT/year
  },
  {
    projectId: 'sousse',
    plotId: 201,
    city: 'Sousse',
    region: 'El Kantaoui',
    trees: 75,
    invested: 112500,
    since: '2024-01',
    annualRevenue: 75 * 90, // 6 750 DT/year
  },
]

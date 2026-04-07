// Mock installment plans for the current client
// Each plan represents a property being purchased in monthly payments
// Payment statuses: 'approved' | 'submitted' | 'rejected' | 'pending'

export const myInstallments = [
  {
    id: 'INS-001',
    projectId: 'tunis',
    plotId: 101,
    projectTitle: 'Projet Olivier — La Marsa',
    city: 'Tunis',
    region: 'La Marsa',
    totalPrice: 72000,
    downPayment: 14400,   // 20%
    monthlyAmount: 1920,  // (72000 - 14400) / 30
    totalMonths: 30,
    startDate: '2024-01-15',
    status: 'active',     // active | late | completed
    payments: [
      { month: 1, dueDate: '2024-02-15', amount: 1920, status: 'approved' },
      { month: 2, dueDate: '2024-03-15', amount: 1920, status: 'approved' },
      { month: 3, dueDate: '2024-04-15', amount: 1920, status: 'submitted', receiptName: 'recu_mars_2024.pdf' },
      { month: 4, dueDate: '2024-05-15', amount: 1920, status: 'pending' },
    ],
  },
  {
    id: 'INS-002',
    projectId: 'sousse',
    plotId: 201,
    projectTitle: 'Projet Olivier — El Kantaoui',
    city: 'Sousse',
    region: 'El Kantaoui',
    totalPrice: 112500,
    downPayment: 22500,   // 20%
    monthlyAmount: 2500,  // (112500 - 22500) / 36
    totalMonths: 36,
    startDate: '2024-02-01',
    status: 'late',
    payments: [
      { month: 1, dueDate: '2024-03-01', amount: 2500, status: 'approved' },
      { month: 2, dueDate: '2024-04-01', amount: 2500, status: 'rejected', rejectedNote: 'Reçu illisible. Veuillez soumettre une photo plus nette du virement.' },
      { month: 3, dueDate: '2024-05-01', amount: 2500, status: 'pending' },
    ],
  },
]

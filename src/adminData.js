export const mockUsers = [
  { id: 1, firstName: 'Lassaad', lastName: 'Ben Salah', email: 'lassaad@gmail.com',  phone: '+216 55 123 456', cin: '12345678', balance: 25000, joined: '2024-01-15', plots: ['tunis-101', 'sousse-201'] },
  { id: 2, firstName: 'Ahmed',   lastName: 'Trabelsi',  email: 'ahmed@gmail.com',    phone: '+216 22 987 654', cin: '87654321', balance: 0,     joined: '2024-02-20', plots: ['sfax-301'] },
  { id: 3, firstName: 'Fatma',   lastName: 'Karray',    email: 'fatma@gmail.com',    phone: '+216 29 456 789', cin: '11223344', balance: 5000,  joined: '2024-03-10', plots: [] },
  { id: 4, firstName: 'Mohamed', lastName: 'Chtioui',   email: 'med.chtioui@gmail.com', phone: '+216 98 654 321', cin: '44556677', balance: 12000, joined: '2024-04-02', plots: ['nabeul-401'] },
]

export const mockReceipts = [
  {
    id: 'REC-001', userId: 1, userName: 'Lassaad Ben Salah',
    planId: 'INS-001', month: 3, amount: 1920,
    dueDate: '2024-04-15', submittedDate: '2024-04-14',
    fileName: 'recu_mars_2024.pdf', status: 'submitted', note: '',
    projectTitle: 'Projet Olivier — La Marsa',
  },
  {
    id: 'REC-002', userId: 1, userName: 'Lassaad Ben Salah',
    planId: 'INS-002', month: 2, amount: 2500,
    dueDate: '2024-04-01', submittedDate: '2024-04-05',
    fileName: 'virement_avril.jpg', status: 'submitted', note: 'Resoumission après correction',
    projectTitle: 'Projet Olivier — El Kantaoui',
  },
  {
    id: 'REC-003', userId: 2, userName: 'Ahmed Trabelsi',
    planId: 'INS-003', month: 1, amount: 3000,
    dueDate: '2024-04-10', submittedDate: '2024-04-09',
    fileName: 'recu_paiement_1.pdf', status: 'submitted', note: '',
    projectTitle: 'Projet Olivier — Thyna',
  },
]

export const mockOffersByProject = {
  tunis: [
    { id: 'OFF-TN-001', label: 'Standard Tunis', avancePct: 20, duration: 24, note: 'Parcelles premium urbaines' },
    { id: 'OFF-TN-002', label: 'Confort Tunis',  avancePct: 30, duration: 36, note: 'Le plus choisi a Tunis' },
  ],
  sousse: [
    { id: 'OFF-SO-001', label: 'Standard Sousse', avancePct: 20, duration: 24, note: 'Equilibre cout / duree' },
    { id: 'OFF-SO-002', label: 'Longue duree',    avancePct: 25, duration: 60, note: 'Mensualites reduites' },
  ],
  sfax: [
    { id: 'OFF-SF-001', label: 'Accéléré Sfax', avancePct: 45, duration: 18, note: 'Solde plus rapide' },
    { id: 'OFF-SF-002', label: 'Premium Sfax',  avancePct: 35, duration: 36, note: 'Plan flexible' },
  ],
  nabeul: [
    { id: 'OFF-NA-001', label: 'Standard Nabeul', avancePct: 20, duration: 24, note: 'Ideal debut investissement' },
  ],
}

// Backward-compatible flat list (used by Owner dashboard legacy UI)
export const mockOffers = Object.values(mockOffersByProject).flat()

export const mockSales = [
  { id: 'SALE-001', userId: 1, userName: 'Lassaad Ben Salah', projectId: 'tunis',  plotId: 101, projectTitle: 'La Marsa',    date: '2024-01-15', amount: 72000,  type: 'installment', adminId: 'admin1' },
  { id: 'SALE-002', userId: 1, userName: 'Lassaad Ben Salah', projectId: 'sousse', plotId: 201, projectTitle: 'El Kantaoui', date: '2024-02-01', amount: 112500, type: 'installment', adminId: 'admin1' },
  { id: 'SALE-003', userId: 2, userName: 'Ahmed Trabelsi',    projectId: 'sfax',   plotId: 301, projectTitle: 'Thyna',       date: '2024-03-05', amount: 108000, type: 'cash',        adminId: 'admin2' },
  { id: 'SALE-004', userId: 4, userName: 'Mohamed Chtioui',   projectId: 'nabeul', plotId: 401, projectTitle: 'Hammamet',    date: '2024-04-02', amount: 95000,  type: 'installment', adminId: 'admin1' },
]

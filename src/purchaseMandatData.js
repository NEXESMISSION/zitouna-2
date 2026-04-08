/** Mock data for rendez-vous de visite form (frontend only) */

/** Only two hour slots — labels shown in the visite <select> */
export const mockRendezvousHours = [
  {
    id: 'slot-morning',
    label: 'Matin — 09h00 à 11h00 (2 h)',
    hint: 'Créneau matinal : accueil à l’agence ou lien visioconférence envoyé la veille.',
  },
  {
    id: 'slot-afternoon',
    label: 'Après-midi — 14h00 à 16h00 (2 h)',
    hint: 'Créneau après-midi : même organisation — merci d’arriver 10 min avant.',
  },
]

/** Payment interval for installment summary (dropdown) */
export const mockPaymentIntervals = [
  { value: 'mensuel', label: 'Mensuel' },
  { value: 'trimestriel', label: 'Trimestriel' },
  { value: 'semestriel', label: 'Semestriel' },
]

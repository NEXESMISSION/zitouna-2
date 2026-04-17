function toIsoDate(d) {
  return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10)
}

export function generatePaymentSchedule({
  totalPrice = 0,
  downPayment = 0,
  totalMonths = 12,
  startDate = toIsoDate(new Date()),
}) {
  const months = Math.max(1, Number(totalMonths) || 1)
  const remain = Math.max(0, Math.round((Number(totalPrice) - Number(downPayment)) * 100) / 100)
  const baseMonthly = Math.round((remain / months) * 100) / 100
  const priorSum = Math.round(baseMonthly * (months - 1) * 100) / 100
  const lastMonthly = Math.round((remain - priorSum) * 100) / 100
  const start = new Date(startDate)

  const payments = []
  for (let i = 0; i < months; i += 1) {
    const due = new Date(start)
    due.setMonth(due.getMonth() + i)
    payments.push({
      month: i + 1,
      dueDate: toIsoDate(due),
      amount: i === months - 1 ? lastMonthly : baseMonthly,
      status: 'pending',
    })
  }
  return payments
}


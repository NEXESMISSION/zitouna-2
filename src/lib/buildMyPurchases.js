const REVENUE_PER_TREE = 90

// Trees attributable to one plot. Legacy per-parcel tree count wins when
// set, otherwise we pro-rate the project's total tree batches by surface
// share — matches the "parcels are pure surfaces" model now used for m²-
// priced projects.
function plotTreeShare(plot, project) {
  const direct = Number(plot?.trees) || 0
  if (direct > 0) return direct
  const projectTotalTrees = Array.isArray(project?.treeBatches) && project.treeBatches.length
    ? project.treeBatches.reduce((s, b) => s + (Number(b?.count) || 0), 0)
    : (Number(project?.totalTrees) || 0)
  if (projectTotalTrees <= 0) return 0
  const totalArea = (project?.plots || []).reduce((s, p) => s + (Number(p.area) || 0), 0)
  const myArea = Number(plot?.area) || 0
  if (totalArea <= 0 || myArea <= 0) return 0
  return Math.max(0, projectTotalTrees * (myArea / totalArea))
}

function computePlotAnnualRevenue(plot, project) {
  const total = Number(project?.annualRevenueTotal) || 0
  if (total > 0) {
    const totalArea = (project?.plots || []).reduce((s, p) => s + (Number(p.area) || 0), 0)
    const myArea = Number(plot?.area) || 0
    if (totalArea > 0 && myArea > 0) return Math.round((myArea / totalArea) * total)
  }
  return Math.round(plotTreeShare(plot, project) * REVENUE_PER_TREE)
}

export function buildMyPurchases(mySales, allProjects) {
  const projectsById = new Map()
  const plotsByKey = new Map()
  for (const p of allProjects || []) {
    projectsById.set(p.id, p)
    for (const pl of p.plots || []) {
      plotsByKey.set(`${p.id}:${pl.id}`, pl)
    }
  }
  const flat = []
  for (const sale of mySales || []) {
    const proj = projectsById.get(sale.projectId)
    const plotIds = Array.isArray(sale.plotIds) ? sale.plotIds : (sale.plotId ? [sale.plotId] : [])
    // Resolve every plot in the sale up-front so we can distribute the
    // `sale.agreedPrice` back across plots pro-rata by surface. This is
    // the fallback used for m²-priced projects (plot.totalPrice is 0
    // because the price lives on the offer, not the catalog) — without
    // it the dashboard shows "Investi 0 DT" on every parcel even though
    // the sale was recorded correctly.
    const resolvedPlots = plotIds.map((pid) => (
      plotsByKey.get(`${sale.projectId}:${pid}`)
      || plotsByKey.get(`${sale.projectId}:${Number(pid)}`)
      || null
    ))
    const saleCatalogSum = resolvedPlots.reduce(
      (s, pl) => s + (Number(pl?.totalPrice) || 0),
      0,
    )
    const saleAgreedPrice = Number(sale?.agreedPrice) || 0
    const saleAreaSum = resolvedPlots.reduce(
      (s, pl) => s + (Number(pl?.area) || 0),
      0,
    )
    const useAgreedFallback = saleAgreedPrice > 0 && saleCatalogSum <= 0

    plotIds.forEach((pid, idx) => {
      const plot = resolvedPlots[idx]
      // For m²-priced projects the plot carries no per-parcel tree count
      // (they're defined at project level and pro-rated). Fall back to
      // the rounded surface-share so dashboard KPIs and parcel cards
      // surface something meaningful instead of 0.
      const trees = Math.max(
        Number(plot?.trees) || 0,
        Math.round(plotTreeShare(plot, proj)),
      )
      const area = Number(plot?.area) || 0
      const catalogPrice = Number(plot?.totalPrice) || 0
      let invested = catalogPrice
      if (invested <= 0 && useAgreedFallback) {
        if (saleAreaSum > 0 && area > 0) {
          invested = Math.round(saleAgreedPrice * (area / saleAreaSum))
        } else {
          invested = Math.round(saleAgreedPrice / Math.max(plotIds.length, 1))
        }
      }
      const annualRevenue = computePlotAnnualRevenue(plot, proj)
      const projectAnnualRevenueTotal = Number(proj?.annualRevenueTotal) || 0
      const projectTotalArea = (proj?.plots || []).reduce((s, p) => s + (Number(p.area) || 0), 0)
      flat.push({
        saleId: sale.id,
        projectId: sale.projectId,
        plotId: pid,
        city: proj?.city || '',
        region: proj?.region || '',
        projectTitle: proj?.title || sale.projectId,
        trees,
        invested,
        annualRevenue,
        area,
        projectAnnualRevenueTotal,
        projectTotalArea,
        surfaceShare: projectTotalArea > 0 ? area / projectTotalArea : 0,
        mapUrl: plot?.mapUrl || '',
        status: sale.status,
        createdAt: sale.createdAt,
      })
    })
  }
  return flat
}

export { computePlotAnnualRevenue, REVENUE_PER_TREE }

// Shared helper for admin-action click handlers.
//
// Fixes the "click does nothing → requires hard refresh" bug class. Before this
// helper, many handlers used:
//
//   setBusy(true)
//   try { await a(); await b() } catch (e) { console.error(e) } finally { setBusy(false) }
//
// If any `await` hung indefinitely (slow Supabase, realtime stall, stuck JWT
// refresh), `finally` never ran, the button stayed on its "…" label forever,
// and the only recovery was a hard refresh. If an await threw, the catch
// only logged — the user saw the spinner disappear with no explanation.
//
// This helper wraps the work with:
//   1. Re-entry guard (rejects while already running).
//   2. Watchdog timeout (default 30s) so the busy state always releases.
//   3. Proper try/catch/finally with a user-visible error reporter.
//
// Usage:
//   await runSafeAction({
//     setBusy: setSaving,
//     onError: (msg) => setNotice(msg),
//     label: 'Enregistrer le projet',
//   }, async () => {
//     await db.upsertProject(...)
//     await refresh()
//   })
//
// Returns { ok: true, result } on success, { ok: false, error, timedOut } on
// failure — callers may ignore the return and just rely on onError for UI.

const DEFAULT_WATCHDOG_MS = 30000
const inflightActions = new Map()

export async function runSafeAction(options, work) {
  const {
    setBusy,
    onError,
    label = 'action',
    watchdogMs = DEFAULT_WATCHDOG_MS,
    timeoutMessage,
    errorMessage,
    actionKey = null,
  } = options || {}

  if (typeof work !== 'function') {
    throw new TypeError('runSafeAction: work must be a function')
  }
  if (actionKey && inflightActions.has(actionKey)) {
    const err = new Error(`action_in_progress:${actionKey}`)
    if (onError) onError('Action déjà en cours, veuillez patienter.')
    return { ok: false, error: err, timedOut: false, inProgress: true }
  }

  let timedOut = false
  const controller = new AbortController()
  const { signal } = controller
  if (setBusy) setBusy(true)
  if (actionKey) inflightActions.set(actionKey, true)

  const watchdog = window.setTimeout(() => {
    timedOut = true
    try { controller.abort() } catch { /* ignore */ }
    if (setBusy) setBusy(false)
    if (onError) {
      onError(
        timeoutMessage
          || `${label} : délai dépassé. Vérifiez votre connexion puis réessayez.`,
      )
    } else {
      console.warn(`[runSafeAction:${label}] watchdog fired`)
    }
  }, watchdogMs)

  try {
    const result = await work(signal)
    return { ok: true, result }
  } catch (e) {
    console.error(`[runSafeAction:${label}]`, e)
    if (!timedOut && onError) {
      const raw = e?.message || String(e) || 'erreur inconnue'
      onError(errorMessage ? `${errorMessage} (${raw})` : `Échec — ${label} : ${raw}`)
    }
    return { ok: false, error: e, timedOut }
  } finally {
    window.clearTimeout(watchdog)
    if (!timedOut && setBusy) setBusy(false)
    if (actionKey) inflightActions.delete(actionKey)
  }
}

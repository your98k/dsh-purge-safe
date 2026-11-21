/**
 * Read-only observation clock for task-board stalls.
 *
 * The clock remembers when an in-progress task was first observed without a
 * report.  It never dispatches work, sends messages, or performs I/O beyond
 * its in-memory timer bookkeeping.  Stage decisions belong to ticket-stage.
 */

export const DEFAULT_STALL_MINUTES = 20
const TICK_MS = 5000
const KEY_SEPARATOR = '\u0000'

const firstSeen = new Map()
let singleton = null

/** Stable identity: task ids are only unique inside a root session. */
export function taskIdentity(taskOrRoot, maybeTaskId) {
  if (taskOrRoot && typeof taskOrRoot === 'object') {
    return taskIdentity(taskOrRoot.root ?? taskOrRoot.rootId ?? taskOrRoot.rootSession, taskOrRoot.id)
  }
  const root = taskOrRoot === undefined || taskOrRoot === null ? '' : String(taskOrRoot)
  const id = maybeTaskId === undefined || maybeTaskId === null ? '' : String(maybeTaskId)
  return root ? root + KEY_SEPARATOR + id : id
}

/** Read and normalize the persisted clock setting. */
export function clockConfig(settings) {
  const raw = settings && settings.stallMinutes
  const minutes = raw === undefined || raw === null ? DEFAULT_STALL_MINUTES : Number(raw)
  if (!Number.isFinite(minutes) || minutes <= 0) return { minutes: 0, enabled: false }
  return {
    minutes: Math.min(Math.max(Math.round(minutes), 1), 240),
    enabled: true,
  }
}

/**
 * Observe a complete task snapshot.  Tasks missing from a later complete
 * snapshot are removed from the in-memory ledger, so old sessions do not leak
 * timestamps forever.
 */
export function sweepStalled(tasks, config, now = Date.now()) {
  if (!config || config.enabled !== true) {
    firstSeen.clear()
    return
  }
  const live = new Set()
  for (const task of Array.isArray(tasks) ? tasks : []) {
    if (!task || !task.id || task.status !== 'in_progress') continue
    const key = taskIdentity(task)
    live.add(key)
    if (task.reportAt) {
      firstSeen.delete(key)
      continue
    }
    if (!firstSeen.has(key)) firstSeen.set(key, now)
  }
  for (const key of Array.from(firstSeen.keys())) {
    if (!live.has(key)) firstSeen.delete(key)
  }
}

/** First observation time for a root-scoped task, or NaN when not observed. */
export function claimedAt(rootOrTask, maybeTaskId) {
  const at = firstSeen.get(taskIdentity(rootOrTask, maybeTaskId))
  return Number.isFinite(at) ? at : NaN
}

/** Start one process-local observation timer. */
export function startClock(_ctx, collect, config) {
  if (singleton) return singleton
  let disposed = false
  const tick = () => {
    if (disposed) return
    try {
      const cfg = typeof config === 'function' ? config() : clockConfig()
      const tasks = typeof collect === 'function' ? collect() : []
      sweepStalled(tasks, cfg)
    } catch {
      // A diagnostic timer must never affect the primary request path.
    }
  }
  const timer = setInterval(tick, TICK_MS)
  if (timer && typeof timer.unref === 'function') timer.unref()
  const dispose = () => {
    disposed = true
    clearInterval(timer)
    firstSeen.clear()
    if (singleton === dispose) singleton = null
  }
  singleton = dispose
  return dispose
}

/** Test/support hook. */
export function resetStalled() {
  firstSeen.clear()
}


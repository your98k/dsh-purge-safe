import { taskStage, STAGE_RANK } from './ticket-stage.js'

export {
  taskStage,
  boardBySession,
  parseNeeds,
  stageLabel,
  stageTone,
  PERSON_STAGES,
  STAGE_RANK,
} from './ticket-stage.js'

const ROOT_SEPARATOR = '\u0000'

function text(value) {
  return value === undefined || value === null ? '' : String(value)
}

function rootOf(value) {
  if (!value || typeof value !== 'object') return ''
  return text(value.root ?? value.rootId ?? value.rootSession ?? value.root_session ?? value.parent_session)
}

function engagementOf(value) {
  if (!value || typeof value !== 'object') return ''
  return text(value.engagement ?? value.engagementId ?? value.engagement_id)
}

function scopedKey(root, engagement, value) {
  return root + ROOT_SEPARATOR + engagement + ROOT_SEPARATOR + text(value)
}

function scopeMatches(task, report) {
  const taskRoot = rootOf(task)
  const reportRoot = rootOf(report)
  if (taskRoot && reportRoot && taskRoot !== reportRoot) return false
  const taskEngagement = engagementOf(task)
  const reportEngagement = engagementOf(report)
  if (taskEngagement && reportEngagement && taskEngagement !== reportEngagement) return false
  return true
}

function newerReport(next, current) {
  if (!current) return true
  const nextId = Number(next && next.id)
  const currentId = Number(current && current.id)
  if (Number.isFinite(nextId) && Number.isFinite(currentId) && nextId !== currentId) return nextId > currentId
  const nextAt = Date.parse(next && next.created_at ? next.created_at : '')
  const currentAt = Date.parse(current && current.created_at ? current.created_at : '')
  return Number.isFinite(nextAt) && (!Number.isFinite(currentAt) || nextAt > currentAt)
}

function putLatest(map, key, report) {
  const current = map.get(key)
  if (newerReport(report, current)) map.set(key, report)
}

/**
 * Merge task projections and reports without allowing duplicate task-N ids in
 * different roots (or different engagements) to cross-link.
 *
 * The host annotates each report with `root` and `engagement` while reading its
 * root-specific database.  For a single-root pure call, a missing root is
 * inferred; for a multi-root call it is intentionally not inferred.
 */
export function mergeTeamBoardTasks(tasks, reports, options = {}) {
  const sourceTasks = Array.isArray(tasks) ? tasks.filter(Boolean) : []
  const roots = new Set(sourceTasks.map(rootOf).filter(Boolean))
  const defaultRoot = roots.size === 1 ? Array.from(roots)[0] : ''
  const normalizedReports = (Array.isArray(reports) ? reports : []).filter(Boolean).map((report) => {
    if (rootOf(report) || !defaultRoot) return report
    return Object.assign({ root: defaultRoot }, report)
  })

  const exact = new Map()
  const fallback = new Map()
  const taggedOwners = new Set()
  for (const report of normalizedReports) {
    const reportRoot = rootOf(report)
    const reportEngagement = engagementOf(report)
    if (typeof report.team_task_id === 'string' && report.team_task_id.trim() !== '') {
      if (!reportRoot) continue
      putLatest(exact, scopedKey(reportRoot, reportEngagement, report.team_task_id.trim()), report)
      if (typeof report.session_id === 'string' && report.session_id !== '') {
        /* A tagged report suppresses owner fallback for that root even when a
           malformed/mixed input labels it with another engagement. */
        taggedOwners.add(scopedKey(reportRoot, '', report.session_id))
      }
      continue
    }
    if (!reportRoot || typeof report.session_id !== 'string' || report.session_id === '') continue
    putLatest(fallback, scopedKey(reportRoot, reportEngagement, report.session_id), report)
  }

  const claimedAt = typeof options.claimedAt === 'function' ? options.claimedAt : () => NaN
  const staleMs = options.staleMs
  const merged = sourceTasks.map((task) => {
    const root = rootOf(task)
    const engagement = engagementOf(task)
    const taskId = text(task.id)
    const ownerId = typeof task.ownerId === 'string' ? task.ownerId : ''
    let report = null
    let linkedBy = null

    const taggedKey = scopedKey(root, engagement, taskId)
    const exactReport = exact.get(taggedKey)
    if (exactReport && scopeMatches(task, exactReport)
      && (!ownerId || String(exactReport.session_id || '') === ownerId)) {
      report = exactReport
      linkedBy = 'task'
    } else if (!exactReport && ownerId
      && !taggedOwners.has(scopedKey(root, '', ownerId))
      && !taggedOwners.has(scopedKey(root, engagement, ownerId))) {
      const fallbackReport = fallback.get(scopedKey(root, engagement, ownerId))
      if (fallbackReport && scopeMatches(task, fallbackReport)) {
        report = fallbackReport
        linkedBy = 'session'
      }
    }

    const stage = taskStage({
      task,
      report,
      tasks: sourceTasks.filter((candidate) => rootOf(candidate) === root),
      staleMs,
      claimedAt: claimedAt(task),
      now: options.now,
    })
    return Object.assign({}, task, {
      stage: stage.stage,
      needs: stage.needs,
      stageReason: stage.reason,
      sessionId: task.ownerId || null,
      reportAt: report ? report.created_at : null,
      reportLinkedBy: linkedBy,
    })
  })

  merged.sort((a, b) => {
    const rank = (value) => STAGE_RANK[value] ?? 9
    return rank(a.stage) - rank(b.stage)
      || rootOf(a).localeCompare(rootOf(b))
      || text(a.id).localeCompare(text(b.id))
  })
  return merged
}


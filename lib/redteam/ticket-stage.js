/**
 * Shared stage rules for the host task board and the session map.
 *
 * The host task projection describes ownership and lifecycle, while agent
 * reports describe what the worker needs.  This module is the one place that
 * joins those two facts into a display stage.
 */

export const PERSON_STAGES = ['person/answer', 'person/review', 'person/blocked', 'person/failed']

export const STAGE_RANK = {
  'person/answer': 0,
  'person/blocked': 1,
  'person/failed': 2,
  'person/review': 3,
  working: 4,
  queued: 5,
  idle: 6,
  ended: 7,
  unknown: 8,
}

function isFinishedTask(task) {
  return Boolean(task) && (task.status === 'completed' || task.status === 'deleted')
}

function taskId(value) {
  if (value && typeof value === 'object') return value.id === undefined ? '' : String(value.id)
  return value === undefined || value === null ? '' : String(value)
}

function rootId(value) {
  if (!value || typeof value !== 'object') return ''
  return value.root === undefined && value.rootId === undefined
    ? ''
    : String(value.root ?? value.rootId ?? '')
}

/**
 * Whether a pending task has a dependency that is not known to be finished.
 * `blockedBy` is a list of task ids; `tasks` is the current root's snapshot.
 * Unknown dependencies are treated as unfinished so a stale/incomplete
 * projection cannot make a blocked task look runnable.
 */
export function hasUnfinishedDependency(task, tasks) {
  const blockedBy = Array.isArray(task && task.blockedBy) ? task.blockedBy : []
  if (blockedBy.length === 0) return false
  const byId = new Map()
  for (const candidate of Array.isArray(tasks) ? tasks : []) {
    const id = taskId(candidate)
    if (id) byId.set(id, candidate)
  }
  return blockedBy.some((dependency) => {
    const id = taskId(dependency)
    const candidate = byId.get(id) || (dependency && typeof dependency === 'object' ? dependency : null)
    return !candidate || !isFinishedTask(candidate)
  })
}

/**
 * Calculate one task's stage.
 *
 * `staleMs` and `claimedAt` are deliberately inputs.  The clock only records
 * an observation time; it never decides a stage or performs orchestration.
 */
export function taskStage(input = {}) {
  const task = input.task || null
  const report = input.report || null
  const now = Number.isFinite(input.now) ? input.now : Date.now()
  const staleMs = Number(input.staleMs) > 0 ? Number(input.staleMs) : 0
  const claimedAt = Number.isFinite(input.claimedAt) ? input.claimedAt : NaN
  const tasks = input.tasks || input.taskList || input.allTasks

  if (task && (task.status === 'completed' || task.status === 'deleted')) {
    return { stage: 'ended', needs: [], reason: '' }
  }

  if (report) {
    const status = String(report.status || '')
    const acknowledged = Boolean(report.acknowledged_at)
    if (!acknowledged) {
      if (status === 'waiting') {
        return { stage: 'person/answer', needs: parseNeeds(report.needs), reason: String(report.blocked_reason || '') }
      }
      if (status === 'blocked') {
        return { stage: 'person/blocked', needs: parseNeeds(report.needs), reason: String(report.blocked_reason || '') }
      }
      if (status === 'failed') {
        return { stage: 'person/failed', needs: parseNeeds(report.needs), reason: String(report.blocked_reason || '') }
      }
      if (status === 'ready') return { stage: 'person/review', needs: [], reason: '' }
    }
    if (status === 'dropped') return { stage: 'idle', needs: [], reason: '' }
  }

  if (task && task.status === 'in_progress') {
    if (staleMs > 0) {
      const reportAt = report && report.created_at ? Date.parse(report.created_at) : NaN
      const since = Number.isFinite(reportAt) ? reportAt : claimedAt
      if (Number.isFinite(since) && now - since >= staleMs) {
        const minutes = Math.max(1, Math.round((now - since) / 60000))
        return {
          stage: 'person/blocked',
          needs: [],
          reason: report ? minutes + ' 分钟没有新回报' : '认领后 ' + minutes + ' 分钟没有回报',
        }
      }
    }
    return { stage: report ? 'working' : 'queued', needs: [], reason: '' }
  }

  if (task && task.status === 'pending') {
    if (task.ready === false || hasUnfinishedDependency(task, tasks)) {
      return { stage: 'queued', needs: [], reason: '等待前置任务' }
    }
    return { stage: 'idle', needs: [], reason: '' }
  }

  if (report) {
    if (!report.acknowledged_at && report.status === 'waiting') {
      return { stage: 'person/answer', needs: parseNeeds(report.needs), reason: '' }
    }
    if (!report.acknowledged_at && report.status === 'ready') {
      return { stage: 'person/review', needs: [], reason: '' }
    }
    return { stage: 'idle', needs: [], reason: '' }
  }
  return { stage: 'unknown', needs: [], reason: '' }
}

/** needs may be a JSON string in older rows, an array in current rows, or empty. */
export function parseNeeds(value) {
  if (Array.isArray(value)) return value
  if (typeof value !== 'string' || value.trim() === '') return []
  try {
    const parsed = JSON.parse(value)
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

/**
 * Attach the best stage per owner for the session map.
 */
export function boardBySession(tasks, reports, opts = {}) {
  const out = new Map()
  const list = Array.isArray(tasks) ? tasks : []
  const byOwner = new Map()
  for (const task of list) {
    if (!task || typeof task.ownerId !== 'string' || !task.ownerId) continue
    const report = reports && typeof reports.get === 'function' ? reports.get(task.ownerId) || null : null
    const ownerRoot = rootId(task)
    const scopedTasks = ownerRoot
      ? list.filter((candidate) => rootId(candidate) === ownerRoot)
      : list
    const next = taskStage({
      task,
      report,
      tasks: scopedTasks,
      staleMs: opts.staleMs,
      now: opts.now,
      claimedAt: typeof opts.claimedAt === 'function' ? opts.claimedAt(task) : opts.claimedAt,
    })
    const seen = byOwner.get(task.ownerId)
    if (seen === undefined || (STAGE_RANK[next.stage] ?? 9) < (STAGE_RANK[seen.stage] ?? 9)) {
      byOwner.set(task.ownerId, Object.assign({}, next, { task }))
    }
  }
  for (const [sessionId, entry] of byOwner) out.set(sessionId, entry)
  if (reports && typeof reports.forEach === 'function') {
    for (const [sessionId, report] of reports) {
      if (out.has(sessionId)) continue
      out.set(sessionId, Object.assign({}, taskStage({ report, now: opts.now }), { task: null }))
    }
  }
  return out
}

export function stageLabel(stage) {
  switch (stage) {
    case 'ended': return '已完成'
    case 'person/answer': return '等人提供'
    case 'person/review': return '等人验收'
    case 'person/blocked': return '受阻'
    case 'person/failed': return '失败待处理'
    case 'working': return '在跑'
    case 'queued': return '排队中'
    case 'idle': return '空闲'
    default: return '未接入'
  }
}

export function stageTone(stage) {
  if (stage === 'ended') return 'done'
  if (stage === 'working') return 'live'
  if (typeof stage === 'string' && stage.startsWith('person/')) return 'wait'
  return 'quiet'
}


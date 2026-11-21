/**
 * 情报数据云端同步：把一份 `cve.db.gz` 从配好的地址拉下来替换本地 `kb/cve.db`。
 *
 * 为什么要单独一层：
 *   · 代码和数据是两回事。代码随包走，数据要能单独更新（4.7 万 EXP + 40 万 CVE
 *     不能每次改一版插件就重发一个 55MB 的包）。
 *   · **数据不再随包发**（和上游一致）：要用就自己构建，或者指向一个自己搭的镜像。
 *
 * 协议（最小、可自托管）：
 *   GET  <base>/intel/manifest.json   → `{ version, built_at, sha256, size, sources }`
 *   GET  <base>/intel/cve.db.gz       → 压缩库本体
 * **没有默认 base**：本仓库不带这份数据，"默认指向某个 GitHub 仓库"只会永远 404。
 * 想用就设 `REDTEAM_INTEL_BASE`（镜像 / 自托管 / 自己跑个静态服务）。
 *
 * 三条硬规则：
 *   1. **校验不过就不换**：sha256 对不上、下载不完整、解压失败 —— 一律保留旧库；
 *   2. **原子替换**：先写同目录 `.tmp`，校验通过再 rename 顶上去；
 *   3. **全程静默**：没有网/没配 base/云端没数据都只是"跳过"，绝不让工具报错。
 */
import { createHash, randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import http from 'node:http'
import https from 'node:https'
import { join } from 'node:path'
import { cveDbStatus, resetCveDbCache, validateCveDbFile, withCveDbWrite } from './cve-db.js'

/** 没有默认数据源：仓库不带这份数据，写死一个地址只会永远 404。
 *  要用就设 `REDTEAM_INTEL_BASE`（不含尾斜杠）。 */
const DEFAULT_BASE = ''

/** 单次下载上限：压缩库现在约 53MB，给到 400MB 兜底（有人在云端放全量未压缩版也接得住）。 */
const MAX_BYTES = 400 * 1024 * 1024

/** 同步节流：同一台机器一天最多自动查一次云端清单。0 = 关闭自动检查。 */
const AUTO_CHECK_HOURS = 24

export function intelBaseUrl(env = process.env) {
  const raw = String(env.REDTEAM_INTEL_BASE || '').trim()
  return (raw || DEFAULT_BASE).replace(/\/+$/, '')
}

/** 没配数据源就当作关掉 —— 不然每次启动都要为一个注定 404 的地址记一行日志。 */
export function intelSyncEnabled(env = process.env) {
  if (String(env.REDTEAM_INTEL_SYNC ?? '') === '0') return false
  return String(env.REDTEAM_INTEL_BASE || '').trim() !== ''
}

/** 本地记录的同步状态（存在 kb/ 下，不进数据库 —— 换库时它自己不该被换掉）。 */
function statePath(root) { return join(root, 'kb', 'intel-sync.json') }
function dbPath(root) { return join(root, 'kb', 'cve.db') }

function readState(root) {
  try { return JSON.parse(readFileSync(statePath(root), 'utf8')) } catch { return {} }
}

function writeState(root, patch) {
  try {
    mkdirSync(join(root, 'kb'), { recursive: true })
    writeFileSync(statePath(root), JSON.stringify({ ...readState(root), ...patch }, null, 2))
  } catch { /* 写不进去不影响数据本身 */ }
}

/** GET 一个 URL → Buffer（跟随重定向，带超时与体积上限）。 */
function fetchBuffer(url, timeoutMs, hops = 0) {
  return new Promise((resolve, reject) => {
    if (hops > 6) { reject(new Error('redirect')); return }
    const lib = url.startsWith('http:') ? http : https
    const req = lib.get(url, {
      headers: {
        'User-Agent': 'dsh-purge-safe-redteam',
        /* raw.githubusercontent 对无 Accept 的请求会降级，显式要二进制 */
        Accept: 'application/octet-stream, application/json, */*',
      },
    }, (res) => {
      const code = res.statusCode || 0
      if (code >= 300 && code < 400 && res.headers.location) {
        res.resume()
        resolve(fetchBuffer(new URL(res.headers.location, url).href, timeoutMs, hops + 1))
        return
      }
      if (code !== 200) { res.resume(); reject(new Error('HTTP ' + code)); return }
      const chunks = []
      let bytes = 0
      res.on('data', (c) => {
        bytes += c.length
        if (bytes > MAX_BYTES) { req.destroy(); reject(new Error('too large')); return }
        chunks.push(c)
      })
      res.on('end', () => resolve(Buffer.concat(chunks)))
      res.on('error', reject)
    })
    req.setTimeout(timeoutMs, () => { req.destroy(); reject(new Error('timeout')) })
    req.on('error', reject)
  })
}

async function fetchJson(url, timeoutMs) {
  const buf = await fetchBuffer(url, timeoutMs)
  return JSON.parse(buf.toString('utf8'))
}

/**
 * 云端清单。拿不到就返回 `{ ok:false }` —— 调用方据此跳过，不报错。
 * @returns `{ ok, version, built_at, sha256, size, sources, url, error? }`
 */
export async function fetchIntelManifest(options = {}) {
  const base = options.base || intelBaseUrl()
  /* 没配数据源：直接按"拿不到"处理，别去请求一个相对地址（会抛 URI 解析错）。 */
  if (!base) return { ok: false, url: '', error: 'no-base', note: '没有配数据源（REDTEAM_INTEL_BASE）' }
  const url = base + '/intel/manifest.json'
  try {
    const raw = await fetchJson(url, options.timeoutMs || 20000)
    const sha = String(raw?.sha256 || '').toLowerCase()
    if (!/^[0-9a-f]{64}$/.test(sha)) return { ok: false, url, error: 'invalid-manifest-sha256' }
    const size = Number(raw?.size)
    if (!Number.isSafeInteger(size) || size <= 0) return { ok: false, url, error: 'invalid-manifest-size' }
    const file = String(raw?.file || 'cve.db.gz')
    if (!/^[A-Za-z0-9._-]+$/.test(file)) return { ok: false, url, error: 'invalid-manifest-file' }
    return {
      ok: true,
      url,
      version: Number(raw?.version) || 0,
      built_at: Number(raw?.built_at) || 0,
      sha256: sha,
      size,
      file,
      sources: raw?.sources ?? null,
    }
  } catch (error) {
    return { ok: false, url, error: String(error?.message ?? error) }
  }
}

/** 本地库的"身份"：版本 + 构建时间，用来和云端清单比对。 */
export function localIntelInfo(root) {
  const st = cveDbStatus(root)
  const state = readState(root)
  return {
    available: st.available === true,
    path: dbPath(root),
    version: Number(st.version) || 0,
    built_at: Number(st.built_at) || 0,
    count: Number(st.count) || 0,
    sha256: String(state.sha256 || ''),
    synced_at: Number(state.synced_at) || 0,
    source: String(state.source || ''),
  }
}

/**
 * 云端 vs 本地：给面板 / preflight / 工具共用的一份对比。
 * 不联网时也能看本地这边；联网结果靠 `fetchIntelManifest` 补。
 */
export function intelCompare(local, remote) {
  if (!remote || remote.ok !== true) {
    return { state: 'unknown', reason: remote?.error || '拿不到云端清单' }
  }
  if (!local || local.available !== true) {
    return { state: 'remote_newer', reason: '本机没有可用底库，需要首次安装' }
  }
  if (remote.sha256 && local.sha256 && remote.sha256 === local.sha256) {
    return { state: 'same', reason: '本机与云端是同一份（sha256 相同）' }
  }
  if (remote.built_at > 0 && local.built_at > 0) {
    if (remote.built_at > local.built_at) {
      return { state: 'remote_newer', reason: '云端更新（' + ageText(remote.built_at, local.built_at) + '）' }
    }
    if (remote.built_at < local.built_at) {
      return { state: 'local_newer', reason: '本机比云端新（本机是本地构建或云端还没同步）' }
    }
    return { state: 'same', reason: '构建时间相同' }
  }
  return { state: 'unknown', reason: '缺少构建时间，无法比较' }
}

function ageText(a, b) {
  const days = Math.abs(a - b) / 86400000
  if (days < 1) return '不到一天'
  if (days < 30) return Math.round(days) + ' 天'
  return Math.round(days / 30) + ' 个月'
}

/**
 * 同步云端数据到本机。
 *
 * @param root 红队数据根
 * @param options `{ force, base, dryRun, timeoutMs }`
 *   - force: 忽略节流与"云端更旧"判断，只要能下载就换
 *   - dryRun: 只比对，不下载不替换
 * @returns `{ action, reason?, remote?, local?, bytes?, sha256?, error? }`
 *   action: `updated` | `skipped` | `failed`
 */
export async function syncIntel(root, options = {}) {
  if (!root) return { action: 'skipped', reason: 'no-root' }
  /* 显式传了 base 就算启用：调用方（工具 / 测试）已经点明了数据源，不必再要求环境变量。 */
  if (!options.base && !intelSyncEnabled() && options.force !== true) return { action: 'skipped', reason: 'disabled' }
  return withCveDbWrite(root, () => syncIntelUnlocked(root, options))
}

async function syncIntelUnlocked(root, options = {}) {
  const remote = await fetchIntelManifest(options)
  const local = localIntelInfo(root)
  const cmp = intelCompare(local, remote)

  if (options.dryRun === true) {
    return { action: 'skipped', reason: 'dry-run', remote, local, compare: cmp }
  }
  if (remote.ok !== true) {
    return { action: 'skipped', reason: 'no-manifest', remote, local, compare: cmp, error: remote.error }
  }
  if (options.force !== true) {
    if (cmp.state === 'same') return { action: 'skipped', reason: 'up-to-date', remote, local, compare: cmp }
    /* 本机更新：默认不降级。只有在 force 时才允许按云端覆盖。 */
    if (cmp.state === 'local_newer' && options.allowDowngrade !== true) {
      return { action: 'skipped', reason: 'local-newer', remote, local, compare: cmp }
    }
  }

  const base = options.base || intelBaseUrl()
  const url = base + '/intel/' + (remote.file || 'cve.db.gz')
  const dst = dbPath(root)
  const tempToken = `${process.pid}-${randomUUID()}`
  const tmp = `${dst}.sync-${tempToken}.tmp`
  const tmpDb = `${dst}.sync-probe-${tempToken}.db`
  const timeoutMs = Number(options.timeoutMs) > 0 ? Number(options.timeoutMs) : 180000

  try {
    try { rmSync(tmp, { force: true }); rmSync(tmpDb, { force: true }) } catch { /* stale temp is disposable */ }
    const buf = await fetchBuffer(url, timeoutMs)
    const sha = createHash('sha256').update(buf).digest('hex')
    if (sha !== remote.sha256) {
      throw new Error('sha256 不符（云端 ' + remote.sha256.slice(0, 12) + '，下载 ' + sha.slice(0, 12) + '）')
    }
    if (buf.length !== remote.size) {
      throw new Error('体积不符（清单 ' + remote.size + '，下载 ' + buf.length + '）')
    }
    mkdirSync(join(root, 'kb'), { recursive: true })
    /* 下载的是 **gz**，必须先验结构再解压——直接把 gz 字节 rename 成 cve.db
       会得到一个打不开的库（SQLite 只认解压后的头）。 */
    writeFileSync(tmp, buf)
    const { createReadStream, createWriteStream } = await import('node:fs')
    const { createGunzip } = await import('node:zlib')
    const { pipeline } = await import('node:stream/promises')
    await pipeline(createReadStream(tmp), createGunzip(), createWriteStream(tmpDb))
    const checked = validateCveDbFile(tmpDb)
    if (!checked.ok) throw new Error('SQLite 校验失败：' + checked.error)
    /* 先校验解压库，再用 rename 原子顶替；绝不先 rm 旧库。 */
    resetCveDbCache()
    try {
      renameSync(tmpDb, dst)
    } catch (error) {
      return {
        action: 'deferred', reason: 'locked', remote, local, compare: cmp,
        error: String(error?.message ?? error),
        hint: '本机底库正被别的进程占用，重启后再同步',
      }
    }
    writeState(root, {
      sha256: sha, synced_at: Date.now(), source: url,
      version: remote.version, built_at: remote.built_at,
    })
    resetCveDbCache()
    const after = localIntelInfo(root)
    return { action: 'updated', remote, local: after, compare: cmp, bytes: buf.length, sha256: sha }
  } catch (error) {
    try { rmSync(tmp, { force: true }) } catch { /* ignore */ }
    return {
      action: 'failed',
      error: String(error?.message ?? error),
      remote, local, compare: cmp,
      note: '同步失败，继续用本机这份；不影响任何查询',
    }
  } finally {
    try { rmSync(tmp, { force: true }); rmSync(tmpDb, { force: true }) } catch { /* 清理失败不覆盖旧库 */ }
  }
}

function rotateHours() {
  const raw = Number(process.env.REDTEAM_INTEL_CHECK_HOURS)
  return Number.isFinite(raw) && raw >= 0 ? raw : AUTO_CHECK_HOURS
}

/**
 * 启动时的按龄检查：只比对清单，发现云端更新才真下载。
 * 失败静默（返回 skipped），绝不影响开工。
 */
export async function syncIntelIfStale(options = {}) {
  /* 同 syncIntel：显式给了 base 就是启用。 */
  if (!options.base && !intelSyncEnabled()) return { action: 'skipped', reason: 'disabled' }
  const root = options.root
  if (!root) return { action: 'skipped', reason: 'no-root' }
  const hours = rotateHours()
  if (hours === 0 && options.force !== true) return { action: 'skipped', reason: 'auto-off' }
  if (options.force !== true) {
    const state = readState(root)
    const last = Number(state.checked_at) || 0
    if (last > 0 && Date.now() - last < hours * 3600000) {
      return { action: 'skipped', reason: 'fresh', age_hours: Math.round(((Date.now() - last) / 3600000) * 10) / 10 }
    }
  }
  writeState(root, { checked_at: Date.now() })
  /* 先只比清单：比上了才下载，避免每 24 小时白拉 53MB */
  const remote = await fetchIntelManifest(options)
  const local = localIntelInfo(root)
  const cmp = intelCompare(local, remote)
  if (remote.ok !== true) return { action: 'skipped', reason: 'no-manifest', compare: cmp, error: remote.error }
  if (cmp.state !== 'remote_newer' && options.force !== true) {
    return { action: 'skipped', reason: cmp.state, compare: cmp }
  }
  return syncIntel(root, { ...options, force: options.force === true })
}

/** 状态汇总：面板行 / preflight / 工具共用。不联网时只报本地。 */
export function intelSyncStatus(root) {
  const local = localIntelInfo(root)
  const state = readState(root)
  return {
    enabled: intelSyncEnabled(),
    base: intelBaseUrl(),
    auto_check_hours: rotateHours(),
    last_checked_at: Number(state.checked_at) || 0,
    last_synced_at: Number(state.synced_at) || 0,
    local,
  }
}


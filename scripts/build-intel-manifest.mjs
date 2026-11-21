/**
 * 生成 `intel/manifest.json`：给运行期同步用的"数据身份卡"。
 *
 * 插件同步时只认这张卡：版本、构建时间、sha256、体积。对不上就不换。
 * 每次重建底库后必须重跑本脚本，否则云端的卡和库不一致，同步会一直报 sha256 不符。
 *
 * 用法：
 *   node scripts/build-intel-manifest.mjs          # 读 intel/cve.db.gz 生成 manifest.json
 *   node scripts/build-intel-manifest.mjs --print  # 只打印，不写盘
 */
import { createHash, randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'
import { createGunzip } from 'node:zlib'
import { pipeline } from 'node:stream/promises'

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const INTEL = path.join(ROOT, 'intel')
const GZ = path.join(INTEL, 'cve.db.gz')
const OUT = path.join(INTEL, 'manifest.json')
const printOnly = process.argv.includes('--print')

if (!fs.existsSync(GZ)) {
  console.error('缺少 intel/cve.db.gz（先跑 node scripts/build-cve-db.mjs）')
  process.exit(1)
}

const gzBytes = fs.readFileSync(GZ)
const sha256 = createHash('sha256').update(gzBytes).digest('hex')

/* 始终从这次 hash 的 gzip 解压探针读 meta，避免旁边旧的 cve.db 与 gzip 错配。 */
async function readMeta() {
  const tmp = path.join(INTEL, `.manifest-probe-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.db`)
  let db = null
  try {
    await pipeline(fs.createReadStream(GZ), createGunzip(), fs.createWriteStream(tmp))
    db = new DatabaseSync(tmp, { readOnly: true })
    const out = {}
    for (const row of db.prepare('SELECT key, value FROM meta').all()) out[row.key] = row.value
    return out
  } finally {
    try { db?.close() } catch { /* ignore */ }
    try { fs.rmSync(tmp, { force: true }) } catch { /* ignore */ }
  }
}

const meta = await readMeta()
const sources = (() => {
  try { return JSON.parse(meta.sources || '{}') } catch { return {} }
})()

const manifest = {
  /* 让运行期能判断"这张卡配不配得上当前代码" */
  version: Number(meta.version) || 0,
  built_at: Number(meta.built_at) || 0,
  file: 'cve.db.gz',
  size: gzBytes.length,
  sha256,
  sources,
}

const text = JSON.stringify(manifest, null, 2) + '\n'
if (printOnly) {
  process.stdout.write(text)
} else {
  const tmpOut = `${OUT}.tmp-${process.pid}-${randomUUID()}`
  try {
    fs.writeFileSync(tmpOut, text)
    fs.renameSync(tmpOut, OUT)
  } finally {
    try { fs.rmSync(tmpOut, { force: true }) } catch { /* cleanup is best effort */ }
  }
  console.log('intel/manifest.json 已写入')
  console.log('  version   ' + manifest.version)
  console.log('  built_at  ' + manifest.built_at + '  (' + new Date(manifest.built_at).toISOString() + ')')
  console.log('  size      ' + (manifest.size / 1048576).toFixed(1) + ' MB')
  console.log('  sha256    ' + sha256)
  console.log('  rows      ' + (sources.rows ?? '?') + ' | EXP ' + (sources.exploitdb ?? '?')
    + ' | PoC-GH ' + (sources.poc_github ?? '?') + ' | 模板 ' + (sources.nuclei_templates ?? '?'))
}


#!/usr/bin/env node
// 万函「行李」：把一个 agent 的会话 + 记忆打包成 .wanhan-agent.zip，换台机器再装回去
//
//   node scripts/agent-bundle.mjs list [--limit 20]
//   node scripts/agent-bundle.mjs pack <会话id|会话目录> [--out 文件] [--with 路径]... [--no-memory]
//   node scripts/agent-bundle.mjs restore <包.zip> [--to 工作区] [--sessions-dir 目录] [--rules] [--force] [--dry-run]
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import zlib from 'node:zlib'
import { fileURLToPath } from 'node:url'
import { zipRead, zipWrite } from './lib/zip.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const VERSION = 1
const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])

const argv = process.argv.slice(2)
const cmd = argv[0]
const flags = {}
const rest = []
for (let i = 1; i < argv.length; i++) {
  const a = argv[i]
  if (a.startsWith('--')) {
    const k = a.slice(2)
    if (k === 'dry-run' || k === 'rules' || k === 'force' || k === 'no-memory') flags[k] = true
    else if (k === 'with') (flags.with ||= []).push(argv[++i])
    else flags[k] = argv[++i]
  } else rest.push(a)
}

// ---------- 会话读写 ----------

const sessionsRoot = () =>
  flags['sessions-dir'] ? path.resolve(flags['sessions-dir']) : path.join(os.homedir(), '.dsh', 'sessions')

/** 按 zstd 帧头逐帧算长度 —— 不能靠扫 magic，压缩数据里可能恰好出现同样的字节 */
function zstdFrameEnd(buf, start) {
  let p = start + 4
  const fhd = buf[p++]
  const fcsFlag = fhd >> 6
  const single = (fhd >> 5) & 1
  const checksum = (fhd >> 2) & 1
  const dictFlag = fhd & 3
  if (!single) p += 1
  p += [0, 1, 2, 4][dictFlag]
  p += [single ? 1 : 0, 2, 4, 8][fcsFlag]
  for (;;) {
    if (p + 3 > buf.length) throw new Error('帧头越界')
    const h = buf[p] | (buf[p + 1] << 8) | (buf[p + 2] << 16)
    p += 3
    const last = h & 1
    const type = (h >> 1) & 3
    const size = h >> 3
    if (type === 1) p += 1
    else if (type !== 3) p += size
    else throw new Error('zstd 非法块类型')
    if (last) break
  }
  if (checksum) p += 4
  if (p > buf.length) throw new Error('zstd 帧越界')
  return p
}

function zstdDecodeAll(buf) {
  const parts = []
  let p = 0
  while (p < buf.length) {
    if (buf.readUInt32LE(p) !== 0xfd2fb528) throw new Error('zstd magic 不对，文件可能已损坏')
    const end = zstdFrameEnd(buf, p)
    parts.push(zlib.zstdDecompressSync(buf.subarray(p, end)))
    p = end
  }
  return Buffer.concat(parts)
}

/** 只解第一帧 —— 会话头就在第一条记录里，够用来列表 */
function readHeader(file) {
  const buf = fs.readFileSync(file)
  try {
    const text = zlib.zstdDecompressSync(buf.subarray(0, zstdFrameEnd(buf, 0))).toString('utf8')
    const line = text.split('\n').find((l) => l.trim())
    return JSON.parse(line)
  } catch {
    return null
  }
}

function allSessions() {
  const root = sessionsRoot()
  if (!fs.existsSync(root)) return []
  const out = []
  for (const slug of fs.readdirSync(root)) {
    const slugDir = path.join(root, slug)
    if (!fs.statSync(slugDir).isDirectory()) continue
    for (const name of fs.readdirSync(slugDir)) {
      // 目录名有两种：主会话 `session-<uuid>`，子代理会话直接是 `<uuid>`。
      // 只认带前缀的会让子代理「找不到自己」，所以按「里面有会话日志」来判定。
      const file = path.join(slugDir, name, 'session.v4.jsonl.zstd')
      if (!fs.existsSync(file)) continue
      const st = fs.statSync(file)
      out.push({
        id: name,
        short: name.replace(/^session-/, ''),
        dirName: name,
        dir: path.join(slugDir, name),
        file,
        size: st.size,
        mtime: st.mtimeMs,
        slug,
        header: readHeader(file),
      })
    }
  }
  return out.sort((a, b) => b.mtime - a.mtime)
}

function findSession(key) {
  const list = allSessions()
  const hit = list.find(
    (s) =>
      s.id === key ||
      s.short === key ||
      s.dirName === key ||
      s.id.startsWith('session-' + key) ||
      s.id.startsWith(key) ||
      s.dir === path.resolve(key) ||
      s.file === path.resolve(key),
  )
  if (!hit) throw new Error(`没找到会话：${key}（用 list 看有哪些）`)
  return hit
}

/** DSH 的目录名规则：C:\\Users\\x -> --C-Users-x-- */
function slugFor(cwd) {
  return '--' + cwd.replace(/[:\\/]/g, '-') + '--'
}

/** 把会话头里的 cwd 换成目标路径（换机器必须换，否则指向一个不存在的工作区） */
function rewriteCwd(zstdBuf, newCwd) {
  const text = zstdDecodeAll(zstdBuf).toString('utf8')
  const lines = text.split('\n')
  let touched = false
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].trim()) continue
    const rec = JSON.parse(lines[i])
    if (rec.type === 'session') {
      rec.cwd = newCwd
      lines[i] = JSON.stringify(rec)
      touched = true
    }
    break
  }
  if (!touched) throw new Error('会话文件第一条不是 session 记录，不能改路径')
  return zlib.zstdCompressSync(Buffer.from(lines.join('\n'), 'utf8'))
}

// ---------- 打包 ----------

function walk(dir, base = '', acc = []) {
  for (const name of fs.readdirSync(dir)) {
    if (name === 'node_modules' || name === '.git' || name === 'dist') continue
    const abs = path.join(dir, name)
    const rel = base ? `${base}/${name}` : name
    const st = fs.statSync(abs)
    if (st.isDirectory()) walk(abs, rel, acc)
    else acc.push({ abs, rel, size: st.size })
  }
  return acc
}

function cmdList() {
  const limit = Number(flags.limit || 20)
  const list = allSessions().slice(0, limit)
  console.log(`最近 ${list.length} 个会话（共 ${allSessions().length} 个）\n`)
  for (const s of list) {
    const h = s.header || {}
    const when = new Date(s.mtime).toLocaleString('zh-CN', { hour12: false })
    console.log(`${s.short}`)
    console.log(`  ${when} · ${(s.size / 1024).toFixed(0)}KB · 预设 ${h.agentPreset || '?'} · ${h.cwd || s.slug}`)
  }
}

function cmdPack() {
  const key = rest[0]
  if (!key) throw new Error('用法：pack <会话id|会话目录>')
  const s = findSession(key)
  const h = s.header || {}
  const cwd = h.cwd || ''
  const files = []

  const sessionBytes = fs.readFileSync(s.file)
  files.push({ name: 'session/session.v4.jsonl.zstd', data: sessionBytes })

  if (!flags['no-memory']) {
    const homeRules = path.join(os.homedir(), '.dsh', 'AGENTS.md')
    if (fs.existsSync(homeRules)) files.push({ name: 'memory/home-AGENTS.md', data: fs.readFileSync(homeRules) })
    const wsRules = cwd ? path.join(cwd, 'AGENTS.md') : ''
    if (wsRules && fs.existsSync(wsRules)) files.push({ name: 'memory/workspace-AGENTS.md', data: fs.readFileSync(wsRules) })
  }

  for (const extra of [].concat(flags.with || [])) {
    const abs = path.resolve(extra)
    if (!fs.existsSync(abs)) throw new Error(`--with 路径不存在：${extra}`)
    const st = fs.statSync(abs)
    if (st.isDirectory()) {
      for (const f of walk(abs)) files.push({ name: `extra/${path.basename(abs)}/${f.rel}`, data: fs.readFileSync(f.abs) })
    } else {
      files.push({ name: `extra/${path.basename(abs)}`, data: fs.readFileSync(abs) })
    }
  }

  const manifest = {
    format: 'wanhan-agent',
    version: VERSION,
    createdAt: new Date().toISOString(),
    session: { id: s.id, dirName: s.dirName, cwd, createdAt: h.createdAt || null, agentPreset: h.agentPreset || null, logBytes: sessionBytes.length },
    source: { host: os.hostname(), node: process.version, platform: process.platform },
    files: files.map((f) => ({ path: f.name, bytes: f.data.length })),
  }
  files.push({ name: 'manifest.json', data: Buffer.from(JSON.stringify(manifest, null, 2), 'utf8') })
  files.push({ name: 'README.md', data: Buffer.from(readmeFor(manifest), 'utf8') })

  const out = path.resolve(flags.out || `${s.short.slice(0, 8)}.wanhan-agent.zip`)
  fs.mkdirSync(path.dirname(out), { recursive: true })
  fs.writeFileSync(out, zipWrite(files))

  const kb = (fs.statSync(out).size / 1024).toFixed(0)
  console.log(`打包完成：${out}（${kb}KB）`)
  console.log(`  会话 ${s.id} · 预设 ${h.agentPreset || '?'} · 源工作区 ${cwd}`)
  console.log(`  含 ${files.length} 个文件`)
}

function readmeFor(m) {
  return `# 万函行李包（agent bundle）

- 格式：${m.format} v${m.version}
- 打包时间：${m.createdAt}
- 会话：${m.session.id}
- 预设：${m.session.agentPreset || '?'}
- 原工作区：${m.session.cwd || '?'}

## 怎么恢复

1. 目标机器装好 DeepSeek Harness
2. 在这个包所在的目录跑：

       node scripts/agent-bundle.mjs restore <本文件> --to <目标工作区路径>

3. 打开 DSH，找到会话 ${m.session.id}

## 包里有什么

- session/  —— 原始会话日志（可直接放回 ~/.dsh/sessions）
- memory/   —— 规则记忆（home-AGENTS / workspace-AGENTS）
- extra/    —— 打包时额外勾选的文件

## 包里没有什么（故意的）

- 任何 key、密码、凭证
- 模型本身（还是你那边租的那个）
- 没勾选的工程文件
`
}

// ---------- 恢复 ----------

function cmdRestore() {
  const file = rest[0]
  if (!file) throw new Error('用法：restore <包.zip> [--to 工作区]')
  const entries = zipRead(fs.readFileSync(path.resolve(file)))
  const byName = new Map(entries.map((e) => [e.name, e.data]))
  const manifest = JSON.parse(byName.get('manifest.json').toString('utf8'))
  const sessionBuf = byName.get('session/session.v4.jsonl.zstd')
  if (!sessionBuf) throw new Error('包里没有 session/ 目录，不是行李包')

  const target = path.resolve(flags.to || manifest.session.cwd || '')
  if (!flags.to && !manifest.session.cwd) throw new Error('包里没记工作区，请用 --to 指定')
  if (flags.to && !fs.existsSync(target)) fs.mkdirSync(target, { recursive: true })

  const id = manifest.session.id
  // 目录名原样保留：主会话是 session-<uuid>，子代理会话是裸 <uuid>，不能强行加前缀
  const dirName = manifest.session.dirName || id
  const destDir = path.join(sessionsRoot(), slugFor(target), dirName)
  const destFile = path.join(destDir, 'session.v4.jsonl.zstd')

  const plan = []
  plan.push(`会话 → ${destFile}`)
  if (byName.has('memory/workspace-AGENTS.md')) plan.push(`工作区规则 → ${path.join(target, 'AGENTS.md')}`)
  if (byName.has('memory/home-AGENTS.md') && flags.rules) plan.push(`全局规则 → ${path.join(os.homedir(), '.dsh', 'AGENTS.md')}`)
  for (const e of entries) if (e.name.startsWith('extra/')) plan.push(`附加 → ${path.join(target, e.name.slice('extra/'.length))}`)

  console.log(flags['dry-run'] ? '将要做：' : '开始恢复：')
  for (const p of plan) console.log('  ' + p)

  if (flags['dry-run']) return
  if (fs.existsSync(destFile) && !flags.force) throw new Error(`目标已存在：${destFile}（要覆盖加 --force）`)

  fs.mkdirSync(destDir, { recursive: true })
  const rewritten = rewriteCwd(sessionBuf, target)
  fs.writeFileSync(destFile, rewritten)

  const wsRules = byName.get('memory/workspace-AGENTS.md')
  if (wsRules) {
    const p = path.join(target, 'AGENTS.md')
    if (!fs.existsSync(p) || flags.force) fs.writeFileSync(p, wsRules)
    else console.log(`  跳过（已存在）：${p}`)
  }
  if (flags.rules && byName.has('memory/home-AGENTS.md')) {
    const p = path.join(os.homedir(), '.dsh', 'AGENTS.md')
    if (!fs.existsSync(p) || flags.force) fs.writeFileSync(p, byName.get('memory/home-AGENTS.md'))
    else console.log(`  跳过（已存在）：${p}`)
  }
  for (const e of entries) {
    if (!e.name.startsWith('extra/')) continue
    const p = path.join(target, e.name.slice('extra/'.length))
    fs.mkdirSync(path.dirname(p), { recursive: true })
    if (!fs.existsSync(p) || flags.force) fs.writeFileSync(p, e.data)
  }

  console.log(`\n完成。会话已放到：${destFile}`)
  console.log(`工作区已指向：${target}`)
  console.log('下一步：打开 DSH，在会话列表里找这个 id。如果列表没刷新，重启一次 DSH。')
}

// ---------- 入口 ----------

try {
  if (cmd === 'list') cmdList()
  else if (cmd === 'pack') cmdPack()
  else if (cmd === 'restore') cmdRestore()
  else {
    console.log('用法：')
    console.log('  node scripts/agent-bundle.mjs list [--limit 20]')
    console.log('  node scripts/agent-bundle.mjs pack <会话id|会话目录> [--out 文件] [--with 路径] [--no-memory]')
    console.log('  node scripts/agent-bundle.mjs restore <包.zip> [--to 工作区] [--rules] [--force] [--dry-run]')
    console.log(`\n（脚本位置：${HERE}）`)
  }
} catch (e) {
  console.error('出错：' + (e && e.message ? e.message : e))
  process.exit(1)
}

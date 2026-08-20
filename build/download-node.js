'use strict'
// 下载并解压内置 Node 运行时到 resources/node（跨平台）
// 用法: node build/download-node.js [v24.14.0]
//  - Windows: node-vXX-win-x64.zip  (用 bsdtar 解压, Windows 10+ 自带)
//  - macOS:   node-vXX-darwin-{x64,arm64}.tar.gz
//  - Linux:   node-vXX-linux-{x64,arm64}.tar.gz
const fs = require('node:fs')
const path = require('node:path')
const { spawnSync } = require('node:child_process')

const VERSION = process.argv[2] || 'v24.14.0'
// Windows ARM64 可通过 x86（ia32）模拟运行；TARGET_ARCH 支持 x86/x64/arm64。
const targetArch = process.env.TARGET_ARCH || process.arch
const arch = targetArch === 'x86' || targetArch === 'ia32' ? 'x86'
  : targetArch === 'arm64' ? 'arm64' : 'x64'
// Node 官方 Windows 包使用 win-x86；其他平台没有 x86 目标。
if (arch === 'x86' && process.platform !== 'win32') {
  throw new Error('TARGET_ARCH=x86 仅支持 Windows')
}
if (!['x86', 'x64', 'arm64'].includes(arch)) {
  throw new Error(`不支持的目标架构: ${targetArch}`)
}
const root = path.resolve(__dirname)
const proj = path.dirname(root)
const destDir = path.join(proj, 'resources', 'node')

const plat = process.platform === 'win32' ? 'win' : process.platform // darwin | linux
const ext = process.platform === 'win32' ? 'zip' : 'tar.gz'
const file = `node-${VERSION}-${plat}-${arch}.${ext}`
const url = `https://nodejs.org/dist/${VERSION}/${file}`

function findFile(dir, name) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) {
      const r = findFile(p, name)
      if (r) return r
    } else if (e.name === name) return p
  }
  return null
}

async function main() {
  fs.mkdirSync(destDir, { recursive: true })
  const tmp = path.join(proj, 'build', `node-dl-${Date.now()}`)
  fs.mkdirSync(tmp, { recursive: true })
  const archive = path.join(tmp, file)

  console.log(`download ${url}`)
  const res = await fetch(url)
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${url}`)
  fs.writeFileSync(archive, Buffer.from(await res.arrayBuffer()))

  // Windows Git Bash tar 会误解析 D:\ 路径，改用 PowerShell 解 zip。
  const r = process.platform === 'win32'
    ? spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-Command',
        'Expand-Archive -LiteralPath "' + archive + '" -DestinationPath "' + tmp + '" -Force'], { stdio: 'inherit' })
    : spawnSync('tar', ['-xf', archive, '-C', tmp], { stdio: 'inherit' })
  if (r.status !== 0) throw new Error(`archive extract failed (exit ${r.status})`)

  const name = process.platform === 'win32' ? 'node.exe' : 'node'
  const bin = findFile(tmp, name)
  if (!bin) throw new Error(`node binary not found under ${tmp}`)
  const target = path.join(destDir, name)
  fs.copyFileSync(bin, target)
  if (process.platform !== 'win32') fs.chmodSync(target, 0o755)

  fs.rmSync(tmp, { recursive: true, force: true })
  console.log(`node runtime -> ${target}`)
}

main().catch((e) => { console.error(e); process.exit(1) })

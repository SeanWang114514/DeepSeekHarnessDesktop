'use strict'
// 克隆 deepseek-harness 并构建（跨平台）
//  - 已存在 resources/harness/package.json 则跳过克隆（本地复用现有目录）
//  - 移除根 package.json 的 packageManager 字段（避免自动切到 pnpm 11）
//  - 写 .npmrc: node-linker=hoisted + manage-package-manager-versions=false
//  - pnpm install --no-frozen-lockfile && pnpm run build
//  - 构建完成后删除 .git（减小打包体积）
const fs = require('node:fs')
const path = require('node:path')
const { spawnSync } = require('node:child_process')

const proj = path.dirname(path.resolve(__dirname))
const h = path.join(proj, 'resources', 'harness')

function run(cmd, args, cwd) {
  console.log(`> ${cmd} ${args.join(' ')}`)
  const r = spawnSync(cmd, args, { cwd, stdio: 'inherit', shell: process.platform === 'win32' })
  if (r.status !== 0) {
    console.error(`[build-harness] ${cmd} failed (exit ${r.status})`)
    process.exit(1)
  }
}

if (!fs.existsSync(path.join(h, 'package.json'))) {
  run('git', ['clone', '--depth', '1', '--branch', 'master',
    'https://github.com/deepseek-ai/deepseek-harness.git', h], proj)
}

const pkgPath = path.join(h, 'package.json')
const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'))
delete pkg.packageManager
// x86 Electron/Node on Windows ARM 需要同时带上 ia32 原生依赖（尤其 esbuild）。
// pnpm 默认只安装当前 CI runner 的 x64 optional package。
if (process.env.TARGET_ARCH === 'x86') {
  pkg.pnpm = { ...(pkg.pnpm || {}), supportedArchitectures: {
    ...(pkg.pnpm?.supportedArchitectures || {}),
    os: ['win32'],
    cpu: ['x64', 'ia32'],
  } }
}
fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2))
fs.writeFileSync(path.join(h, '.npmrc'), 'manage-package-manager-versions=false\nnode-linker=hoisted\n')

run('pnpm', ['install', '--no-frozen-lockfile'], h)

// pnpm 10 在 Windows x64 runner 上不会始终物化 sharp/koffi 的 ia32
// optional package；用 npm 明确指定目标平台补齐它们。
if (process.env.TARGET_ARCH === 'x86') {
  const nativeTmp = path.join(proj, 'build', `native-ia32-${process.pid}`)
  fs.rmSync(nativeTmp, { recursive: true, force: true })
  fs.mkdirSync(nativeTmp, { recursive: true })
  fs.writeFileSync(path.join(nativeTmp, 'package.json'), JSON.stringify({
    name: 'native-ia32-deps', version: '1.0.0', private: true,
    dependencies: {
      '@img/sharp-win32-ia32': '0.35.3',
      '@koromix/koffi-win32-ia32': '3.1.5',
    },
    pnpm: { supportedArchitectures: { os: ['win32'], cpu: ['ia32'] } },
  }, null, 2))
  fs.writeFileSync(path.join(nativeTmp, '.npmrc'), 'node-linker=hoisted\n')
  run('pnpm', ['install', '--no-frozen-lockfile', '--ignore-scripts'], nativeTmp)
  for (const name of ['@img/sharp-win32-ia32', '@koromix/koffi-win32-ia32']) {
    const source = path.join(nativeTmp, 'node_modules', name)
    const target = path.join(h, 'node_modules', name)
    if (!fs.existsSync(source)) {
      console.error(`[build-harness] npm did not install ${name}`)
      process.exit(1)
    }
    fs.rmSync(target, { recursive: true, force: true })
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.cpSync(source, target, { recursive: true, dereference: true })
  }
  fs.rmSync(nativeTmp, { recursive: true, force: true })
}

// x86 运行时不能留下任何 x64 原生包。许多包会优先发现同级的 x64 optional
// dependency，即使 ia32 包已经存在，最终就会报 Mismatched native module。
function normalizeIa32NativePackages(root) {
  const specs = [
    ['@esbuild/win32-x64', '@esbuild/win32-ia32', 'esbuild.exe'],
    ['@img/sharp-win32-x64', '@img/sharp-win32-ia32', null],
    ['@koromix/koffi-win32-x64', '@koromix/koffi-win32-ia32', null],
  ]
  const nm = path.join(root, 'node_modules')
  const found = new Set()
  function walk(dir) {
    let entries
    try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { return }
    for (const e of entries) {
      if (e.name === '.git') continue
      const p = path.join(dir, e.name)
      // pnpm hoisted 安装可能留下目录 junction；Dirent.isDirectory()
      // 对 junction 返回 false，因此必须先按名字处理，不能只依赖 isDirectory。
      for (const [x64Name, ia32Name, marker] of specs) {
        if (e.name === x64Name || p.endsWith(path.sep + x64Name)) {
          const parent = path.dirname(p)
          const dst = path.join(parent, ia32Name)
          const rootIa32 = path.join(nm, ia32Name)
          if ((!fs.existsSync(dst) || (marker && !fs.existsSync(path.join(dst, marker)))) && fs.existsSync(rootIa32)) {
            fs.rmSync(dst, { recursive: true, force: true })
            fs.cpSync(rootIa32, dst, { recursive: true, dereference: true })
          }
          fs.rmSync(p, { recursive: true, force: true })
          found.add(x64Name)
          continue
        }
      }
      let isDir = false
      try { isDir = fs.statSync(p).isDirectory() } catch {}
      // 已处理的平台包不再深入，避免扫描 pnpm store 的巨大重复树。
      if (isDir && !e.name.startsWith('win32-')) walk(p)
    }
  }
  walk(nm)
  console.log('[build-harness] removed x64 native packages:', [...found].join(', ') || 'none')
}

// pnpm 可能把不同 CPU 的 optional package 留在 workspace 子目录，
// 但 Electron 启动时从 harness 根目录解析 esbuild。确保 ia32 二进制位于
// 根 node_modules/@esbuild 下，否则 Windows ARM 上会误加载 win32-x64。
if (process.env.TARGET_ARCH === 'x86') {
  const ia32 = path.join(h, 'node_modules', '@esbuild', 'win32-ia32')
  const candidates = [
    ia32,
    path.join(h, 'website', 'node_modules', '@esbuild', 'win32-ia32'),
    path.join(h, 'apps', 'web', 'node_modules', '@esbuild', 'win32-ia32'),
  ]
  const source = candidates.find((p) => fs.existsSync(path.join(p, 'esbuild.exe')))
  if (!source) {
    console.error('[build-harness] missing @esbuild/win32-ia32 after pnpm install')
    process.exit(1)
  }
  if (source !== ia32) {
    fs.rmSync(ia32, { recursive: true, force: true })
    fs.mkdirSync(path.dirname(ia32), { recursive: true })
    fs.cpSync(source, ia32, { recursive: true, dereference: true })
  }
  const required = [
    ['@esbuild/win32-ia32', 'esbuild.exe'],
    ['@img/sharp-win32-ia32', null],
    ['@koromix/koffi-win32-ia32', null],
  ]
  for (const [name, marker] of required) {
    const target = path.join(h, 'node_modules', name)
    const candidates = [
      target,
      path.join(h, 'website', 'node_modules', name),
      path.join(h, 'apps', 'web', 'node_modules', name),
    ]
    let source = candidates.find((p) => fs.existsSync(p) && (!marker || fs.existsSync(path.join(p, marker))))
    if (!source) {
      const pnpmDir = path.join(h, 'node_modules', '.pnpm')
      if (fs.existsSync(pnpmDir)) {
        for (const entry of fs.readdirSync(pnpmDir)) {
          const candidate = path.join(pnpmDir, entry, 'node_modules', name)
          if (fs.existsSync(candidate) && (!marker || fs.existsSync(path.join(candidate, marker)))) {
            source = candidate
            break
          }
        }
      }
    }
    if (!source) {
      console.error(`[build-harness] missing ${name} after pnpm install`)
      process.exit(1)
    }
    if (source !== target) {
      fs.rmSync(target, { recursive: true, force: true })
      fs.mkdirSync(path.dirname(target), { recursive: true })
      fs.cpSync(source, target, { recursive: true, dereference: true })
    }
    console.log(`[build-harness] ia32 native dependency: ${name}`)
  }
  normalizeIa32NativePackages(h)
}

run('pnpm', ['run', 'build'], h)

fs.rmSync(path.join(h, '.git'), { recursive: true, force: true })
console.log('harness ready:', h)

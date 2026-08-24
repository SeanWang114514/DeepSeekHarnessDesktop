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

// x86（ia32）下 koffi 的 Windows 结构布局是 32 位的：STARTUPINFOW=68、
// PROCESS_INFORMATION=16；而 harness 源码硬编码了 x64 的 104/24，导致
// sandbox-windows-acl 在加载时直接抛 "STARTUPINFOW layout mismatch"。
// 这里把源码里两个布局守卫改成按 process.arch 动态取值。
function patchWindowsAclForIa32() {
  const aclSrc = path.join(h, 'packages', 'sandbox', 'sandbox-windows-acl', 'src', 'ffi.ts')
  if (!fs.existsSync(aclSrc)) {
    console.error('[build-harness] sandbox-windows-acl/src/ffi.ts not found')
    process.exit(1)
  }
  let src = fs.readFileSync(aclSrc, 'utf8')
  const orig = src
  src = src.replace(
    /STARTUPINFOW\.size\s*!==\s*104/,
    "STARTUPINFOW.size !== (process.arch === 'ia32' ? 68 : 104)",
  )
  src = src.replace(
    /PROCESS_INFORMATION\.size\s*!==\s*24/,
    "PROCESS_INFORMATION.size !== (process.arch === 'ia32' ? 16 : 24)",
  )
  if (src === orig) {
    console.error('[build-harness] ffi.ts layout guards not found (upstream changed?)')
    process.exit(1)
  }
  fs.writeFileSync(aclSrc, src)
  console.log('[build-harness] patched sandbox-windows-acl ffi.ts for ia32 layout')
}

if (process.env.TARGET_ARCH === 'x86') patchWindowsAclForIa32()

run('pnpm', ['install', '--no-frozen-lockfile'], h)

// pnpm 10 在 Windows x64 runner 上不会始终物化 sharp/koffi 的 ia32
// optional package；用 npm 明确指定目标平台补齐它们。
if (process.env.TARGET_ARCH === 'x86') {
  // 读取 harness 实际解析到的 JS 包版本：koffi / esbuild 的 platform 包版本
  // 必须与 JS 包完全一致，否则会报 "Mismatched native Koffi modules"。
  const resolveVer = (name) => {
    for (const base of [h, path.join(h, 'node_modules')]) {
      try {
        const pj = path.join(base, name, 'package.json')
        if (fs.existsSync(pj)) return JSON.parse(fs.readFileSync(pj, 'utf8')).version
      } catch {}
    }
    const store = path.join(h, 'node_modules', '.pnpm')
    if (fs.existsSync(store)) {
      for (const entry of fs.readdirSync(store)) {
        if (entry.startsWith(name.replace('/', '+') + '@')) {
          try {
            return JSON.parse(fs.readFileSync(path.join(store, entry, 'node_modules', name, 'package.json'), 'utf8')).version
          } catch {}
        }
      }
    }
    return null
  }
  const koffiVer = resolveVer('koffi')
  const esbuildVer = resolveVer('esbuild')
  const sharpVer = '0.35.3'
  const libvipsVer = '1.3.2'
  if (!koffiVer || !esbuildVer) {
    console.error(`[build-harness] cannot resolve koffi (${koffiVer}) / esbuild (${esbuildVer})`)
    process.exit(1)
  }
  console.log(`[build-harness] ia32 native versions: koffi=${koffiVer} esbuild=${esbuildVer} sharp=${sharpVer} libvips=${libvipsVer}`)

  // 在隔离的临时项目里明确安装 ia32 平台包（CPU 只声明 ia32）。
  const nativeTmp = path.join(proj, 'build', `native-ia32-${process.pid}`)
  fs.rmSync(nativeTmp, { recursive: true, force: true })
  fs.mkdirSync(nativeTmp, { recursive: true })
  fs.writeFileSync(path.join(nativeTmp, 'package.json'), JSON.stringify({
    name: 'native-ia32-deps', version: '1.0.0', private: true,
    dependencies: {
      '@img/sharp-win32-ia32': sharpVer,
      '@img/sharp-libvips-win32-ia32': libvipsVer,
      '@koromix/koffi-win32-ia32': koffiVer,
      '@esbuild/win32-ia32': esbuildVer,
    },
    pnpm: { supportedArchitectures: { os: ['win32'], cpu: ['ia32'] } },
  }, null, 2))
  fs.writeFileSync(path.join(nativeTmp, '.npmrc'), 'node-linker=hoisted\n')
  run('pnpm', ['install', '--no-frozen-lockfile', '--ignore-scripts'], nativeTmp)
  for (const name of [
    '@img/sharp-win32-ia32',
    '@img/sharp-libvips-win32-ia32',
    '@koromix/koffi-win32-ia32',
    '@esbuild/win32-ia32',
  ]) {
    const source = path.join(nativeTmp, 'node_modules', name)
    const target = path.join(h, 'node_modules', name)
    if (!fs.existsSync(source)) {
      console.error(`[build-harness] did not install ${name}`)
      process.exit(1)
    }
    fs.rmSync(target, { recursive: true, force: true })
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.cpSync(source, target, { recursive: true, dereference: true })
    console.log(`[build-harness] ia32 native dependency: ${name}`)
  }
  fs.rmSync(nativeTmp, { recursive: true, force: true })
}

// 最终校验：harness 根 node_modules 下必须存在 ia32 原生二进制。
// 注意：不要在这里删除 win32-x64 包——构建阶段（x64 runner）还需要它们
// （例如 rolldown 的 @rolldown/binding-win32-x64-msvc），而且 esbuild/sharp/
// koffi 在运行时都是按 process.arch 选择平台包的，x64 包存在不影响 x86 加载。
if (process.env.TARGET_ARCH === 'x86') {
  const mustExist = [
    ['@esbuild/win32-ia32', 'esbuild.exe'],
    ['@img/sharp-win32-ia32', null],
    ['@koromix/koffi-win32-ia32', null],
  ]
  for (const [name, marker] of mustExist) {
    const dir = path.join(h, 'node_modules', name)
    if (!fs.existsSync(dir) || (marker && !fs.existsSync(path.join(dir, marker)))) {
      console.error(`[build-harness] missing ia32 native package: ${name}`)
      process.exit(1)
    }
  }
  // esbuild 主包还要求 @esbuild 命名空间下存在 win32-ia32
  const esbuildNs = path.join(h, 'node_modules', '@esbuild', 'win32-ia32')
  if (!fs.existsSync(path.join(esbuildNs, 'esbuild.exe'))) {
    console.error('[build-harness] @esbuild/win32-ia32 missing under @esbuild namespace')
    process.exit(1)
  }
}

run('pnpm', ['run', 'build'], h)

fs.rmSync(path.join(h, '.git'), { recursive: true, force: true })
console.log('harness ready:', h)

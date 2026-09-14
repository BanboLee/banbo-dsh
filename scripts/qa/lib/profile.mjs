import { chmodSync, copyFileSync, cpSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { runChild } from './process.mjs'

export const BUNDLES = [
  ['plugins/fish-shell', '@banbolee/dsh-fish-shell'],
  ['plugins/rtk', '@banbolee/dsh-rtk'],
  ['plugins/codegraph-mcp', '@banbolee/dsh-codegraph-mcp'],
  ['plugins/dsh-llm-pi-ai-with-session', '@banbolee/dsh-llm-pi-ai-with-session'],
  ['plugins/dsh-lsp-diagnostics', '@banbolee/dsh-lsp-diagnostics'],
]

export function writeToolWrappers(layout, tools) {
  const wrappers = {
    dsh: join(layout.bin, 'dsh'),
    pnpm: join(layout.bin, 'pnpm'),
  }
  writeFileSync(wrappers.dsh, `#!/bin/sh\nexec "${tools.node}" "${tools.dsh}" "$@"\n`, { mode: 0o700 })
  writeFileSync(wrappers.pnpm, `#!/bin/sh\nexec "${tools.pnpm}" "$@"\n`, { mode: 0o700 })
  chmodSync(wrappers.dsh, 0o700)
  chmodSync(wrappers.pnpm, 0o700)
  return wrappers
}

export function readDshWrapperTarget(wrapper) {
  const match = /^exec "[^"]+" "([^"]+)" "\$@"$/m.exec(readFileSync(wrapper, 'utf8'))
  if (match === null) throw new Error(`invalid dsh wrapper: ${wrapper}`)
  return match[1]
}

export function resolveDshInstallationBin(candidate) {
  const content = readFileSync(candidate, 'utf8')
  return content.startsWith('#!/bin/sh\nexec "') ? readDshWrapperTarget(candidate) : realpathSync(candidate)
}

export function targetTuiPackagePath(dsh) {
  return resolve(dirname(dsh), '..', '..', '..', '@deepseek-harness-tui', 'dsh-tui')
}

export async function packBundles(repoRoot, layout, pnpm, environment, targetTui) {
  const tarballs = []
  const stagedTui = join(layout.root, 'target-tui')
  cpSync(targetTui, stagedTui, { recursive: true })
  const tuiPackagePath = join(stagedTui, 'package.json')
  const tuiPackage = JSON.parse(readFileSync(tuiPackagePath))
  tuiPackage.bundledDependencies = Object.keys(tuiPackage.dependencies)
  delete tuiPackage.scripts.prepare
  writeFileSync(tuiPackagePath, `${JSON.stringify(tuiPackage, null, 2)}\n`)
  await runChild(pnpm, [
    '--config.node-linker=hoisted',
    '--config.ignore-scripts=true',
    '--dir', stagedTui,
    'pack',
    '--pack-destination', layout.packs,
  ], {
    cwd: repoRoot,
    env: environment,
  })
  tarballs.push(join(layout.packs, `deepseek-harness-tui-dsh-tui-${tuiPackage.version}.tgz`))
  rmSync(stagedTui, { recursive: true, force: true })
  for (const [directory, name] of BUNDLES) {
    await runChild(pnpm, ['--dir', join(repoRoot, directory), 'pack', '--pack-destination', layout.packs], {
      cwd: repoRoot,
      env: environment,
    })
    tarballs.push(join(layout.packs, `${name}-${JSON.parse(readFileSync(join(repoRoot, directory, 'package.json'))).version}.tgz`))
  }
  return tarballs
}

export async function installProfile(wrapper, matrix, tarballs, repoRoot, environment) {
  await runChild(wrapper, [
    'plugin', '--profile', 'dsh-tui', 'add', '-w',
    ...tarballs,
    '--offline',
    '--config.auto-install-peers=false',
  ], { cwd: repoRoot, env: environment })
}

function render(template, values) {
  return template.replace(/\{\{([A-Z_]+)\}\}/g, (_match, name) => {
    const value = values[name]
    if (typeof value !== 'string') throw new Error(`missing template value ${name}`)
    return value
  })
}

export function renderProfileFiles(repoRoot, layout, environment) {
  const fixtures = join(repoRoot, 'scripts', 'qa', 'fixtures')
  const values = {
    QA_LOOPBACK_PORT: environment.QA_LOOPBACK_PORT,
    QA_CODEGRAPH: environment.QA_CODEGRAPH,
    QA_WORKSPACE: environment.DSH_TUI_WORKSPACE_TARGET,
    QA_TS_LSP: environment.QA_TS_LSP,
    QA_GOPLS: environment.QA_GOPLS,
    QA_RTK: environment.QA_RTK,
  }
  writeFileSync(
    join(layout.dshHome, 'settings.yaml'),
    render(readFileSync(join(fixtures, 'dsh-tui-qa-settings.yaml'), 'utf8'), values),
  )
  writeFileSync(
    join(layout.dshHome, 'profiles', 'dsh-tui', 'cordis.patch.yml'),
    render(readFileSync(join(fixtures, 'dsh-tui-qa.patch.yml'), 'utf8'), values),
  )
  cpSync(join(fixtures, 'workspace'), layout.workspace, { recursive: true })
  copyFileSync(join(fixtures, 'workspace', 'qa-symbol.ts'), join(layout.workspace, 'qa-symbol.ts'))
}

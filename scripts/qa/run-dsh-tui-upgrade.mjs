#!/usr/bin/env node
import { createServer } from 'node:net'
import { existsSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseOptions, requireOption } from './lib/cli.mjs'
import {
  assertIsolatedQaRoot,
  buildQaEnvironment,
  cleanupQaRuntimeHome,
  createQaLayout,
  writeQaEnvironment,
} from './lib/environment.mjs'
import {
  installProfile,
  packBundles,
  renderProfileFiles,
  targetTuiPackagePath,
  writeToolWrappers,
} from './lib/profile.mjs'
import { runChild } from './lib/process.mjs'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
const DEFAULTS = {
  node: '/home/lixingxin/.local/share/nvm/v26.7.0/bin/node',
  dsh: '/home/lixingxin/.local/share/nvm/v26.7.0/bin/dsh',
  pnpm: '/home/lixingxin/.local/share/pnpm/pnpm',
  rtk: '/data00/home/lixingxin/project/rtk/target/release/rtk',
  codegraph: '/home/lixingxin/.codegraph/versions/v1.6.0/bin/codegraph',
  typescriptLanguageServer: '/data00/home/lixingxin/.local/share/nvim/mason/bin/typescript-language-server',
  gopls: '/data00/home/lixingxin/.local/bin/trae-gopls',
  clangd: '/usr/bin/clangd',
  rustAnalyzer: '/data00/home/lixingxin/.cargo/bin/rust-analyzer',
  pythonLanguageServer: '/data00/home/lixingxin/.local/bin/pyright-langserver',
  go: '/home/lixingxin/.goenv/shims/go',
}

async function allocatePort() {
  const server = createServer()
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('failed to allocate loopback port')
  await new Promise((resolve, reject) => server.close((error) => error === undefined ? resolve() : reject(error)))
  return address.port
}

function assertExecutable(path, label) {
  if (!existsSync(path)) throw new Error(`${label} does not exist: ${path}`)
}

async function main() {
  const options = parseOptions(process.argv.slice(2))
  if (requireOption(options, 'gates') !== 'G4,G5,G6') throw new Error('gates must be exactly G4,G5,G6')
  const qaRoot = assertIsolatedQaRoot(requireOption(options, 'qa-root'), repoRoot)
  const matrixPath = resolve(requireOption(options, 'matrix'))
  const matrix = JSON.parse(readFileSync(matrixPath, 'utf8'))
  const layout = createQaLayout(qaRoot)
  process.once('exit', () => cleanupQaRuntimeHome(layout))
  for (const [label, path] of Object.entries(DEFAULTS)) {
    if (['clangd', 'rustAnalyzer', 'pythonLanguageServer'].includes(label)) continue
    assertExecutable(path, label)
  }
  const codegraphRealpath = realpathSync(DEFAULTS.codegraph)
  if (!codegraphRealpath.includes('/.codegraph/versions/')) {
    throw new Error(`QA_CODEGRAPH is not an official bundled release: ${codegraphRealpath}`)
  }
  const nodeVersion = (await runChild(DEFAULTS.node, ['--version'], { cwd: repoRoot, env: {} })).output.trim()
  if (!nodeVersion.startsWith(`v${matrix.nodeMajor}.`)) throw new Error(`Node version mismatch: ${nodeVersion}`)
  const dshVersion = (await runChild(DEFAULTS.node, [DEFAULTS.dsh, '--version'], { cwd: repoRoot, env: {} })).output.trim()
  if (dshVersion !== matrix.dsh) throw new Error(`dsh version mismatch: ${dshVersion}`)
  const wrappers = writeToolWrappers(layout, {
    node: DEFAULTS.node,
    dsh: DEFAULTS.dsh,
    pnpm: DEFAULTS.pnpm,
  })
  const environment = buildQaEnvironment({
    qaRoot,
    runtimeHome: layout.runtimeHome,
    nodeBin: dirname(DEFAULTS.node),
    codegraph: codegraphRealpath,
    rtk: DEFAULTS.rtk,
    typescriptLanguageServer: DEFAULTS.typescriptLanguageServer,
    gopls: DEFAULTS.gopls,
    realDsh: DEFAULTS.dsh,
    go: DEFAULTS.go,
    loopbackPort: await allocatePort(),
  })
  const envFile = writeQaEnvironment(qaRoot, environment)
  const targetTui = targetTuiPackagePath(realpathSync(DEFAULTS.dsh))
  const targetTuiVersion = JSON.parse(readFileSync(resolve(targetTui, 'package.json'), 'utf8')).version
  if (targetTuiVersion !== matrix.dshTui) throw new Error(`installed dsh-tui version mismatch: ${targetTuiVersion}`)
  const tarballs = await packBundles(repoRoot, layout, DEFAULTS.pnpm, environment, targetTui)
  await installProfile(wrappers.dsh, matrix, tarballs, repoRoot, environment)
  renderProfileFiles(repoRoot, layout, environment)
  await runChild(DEFAULTS.node, [
    resolve(repoRoot, 'scripts/qa/validate-dsh-tui-graph.mjs'),
    '--profile', 'dsh-tui',
    '--matrix', matrixPath,
    '--env-file', envFile,
  ], { cwd: repoRoot, env: environment })
  const dump = await runChild(wrappers.dsh, ['--profile', 'dsh-tui', '--dump-config'], {
    cwd: layout.workspace,
    env: environment,
  })
  for (const row of ['fish-shell', 'tool-fish', 'fish-preset-policy', 'rtk', 'mcp-codegraph', 'llm-pi-ai-with-session', 'lsp-diagnostics']) {
    if (!dump.output.includes(row)) throw new Error(`profile dump is missing ${row}`)
  }
  await runChild(DEFAULTS.node, [
    resolve(repoRoot, 'scripts/qa/run-dsh-tui-pty.mjs'),
    '--case', 'startup',
    '--env-file', envFile,
  ], { cwd: repoRoot, env: environment })
  const realRunArgs = [
    resolve(repoRoot, 'scripts/qa/run-dsh-tui-real.mjs'),
    '--all-core',
    '--env-file', envFile,
    '--matrix', matrixPath,
  ]
  if (options.get('all-real-lsp-providers') === true) {
    realRunArgs.push(
      '--real-lsp-providers', 'typescript,go,clangd,rust,python',
      '--typescript-command', DEFAULTS.typescriptLanguageServer,
      '--go-command', DEFAULTS.gopls,
      '--clangd-command', DEFAULTS.clangd,
      '--rust-command', DEFAULTS.rustAnalyzer,
      '--python-command', DEFAULTS.pythonLanguageServer,
    )
  }
  await runChild(DEFAULTS.node, realRunArgs, { cwd: repoRoot, env: environment })
  const evidence = {
    qaRoot,
    nodeVersion,
    dshVersion,
    tarballCount: tarballs.length,
    gates: { G4: 'passed', G5: 'passed', G6: 'passed' },
  }
  writeFileSync(resolve(layout.evidence, 'upgrade.json'), `${JSON.stringify(evidence, null, 2)}\n`)
  process.stdout.write(`${JSON.stringify(evidence, null, 2)}\n`)
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`)
  process.exitCode = 1
})

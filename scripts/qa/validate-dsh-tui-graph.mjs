#!/usr/bin/env node
import { existsSync, readFileSync, realpathSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseOptions, requireOption } from './lib/cli.mjs'
import { readQaEnvironment } from './lib/environment.mjs'
import { assertInstalledRealpath, validateDependencyGraph } from './lib/graph.mjs'
import { readDshWrapperTarget } from './lib/profile.mjs'
import { runChild } from './lib/process.mjs'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')

async function main() {
  const options = parseOptions(process.argv.slice(2))
  const profile = requireOption(options, 'profile')
  const matrixPath = resolve(requireOption(options, 'matrix'))
  const envFile = options.get('env-file')
  const environment = typeof envFile === 'string' ? readQaEnvironment(resolve(envFile)) : process.env
  const matrix = JSON.parse(readFileSync(matrixPath, 'utf8'))
  const dshWrapper = environment.PATH.split(':').map((path) => resolve(path, 'dsh'))
    .find((path) => {
      try {
        return realpathSync(path).length > 0
      } catch (error) {
        if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return false
        throw error
      }
    })
  if (dshWrapper === undefined) throw new Error('QA dsh wrapper is missing from PATH')
  const listed = await runChild(dshWrapper, ['plugin', '--profile', profile, 'list', '--depth=8', '--json'], {
    cwd: repoRoot,
    env: environment,
  })
  const dshTarget = realpathSync(readDshWrapperTarget(dshWrapper))
  const dshRoot = resolve(dirname(dshTarget), '..')
  const fallbackPackages = [
    ['@deepseek-ai/cordis', matrix.cordis],
    ['@earendil-works/pi-ai', matrix.piAi],
  ]
  const fallbackGraph = fallbackPackages.map(([name]) => {
    const packagePath = resolve(dshRoot, 'node_modules', name, 'package.json')
    if (!existsSync(packagePath)) throw new Error(`cannot locate package.json for ${name}`)
    return JSON.parse(readFileSync(packagePath, 'utf8'))
  })
  const result = validateDependencyGraph([...JSON.parse(listed.output), ...fallbackGraph], matrix)
  const profileRoot = resolve(environment.DSH_HOME, 'profiles', profile)
  const { createRequire } = await import('node:module')
  const requireFromProfile = createRequire(resolve(profileRoot, 'package.json'))
  const packageNames = ['@deepseek-harness-tui/dsh-tui', ...Object.keys(matrix.bundles)]
  const realpaths = {}
  for (const packageName of packageNames) {
    const packagePath = requireFromProfile.resolve(`${packageName}/package.json`)
    realpaths[packageName] = assertInstalledRealpath(packageName, packagePath, environment.DSH_HOME, repoRoot)
  }
  process.stdout.write(`${JSON.stringify({ profile, versions: result.versions, realpaths }, null, 2)}\n`)
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`)
  process.exitCode = 1
})

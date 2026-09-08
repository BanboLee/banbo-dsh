import { realpathSync } from 'node:fs'
import { relative, resolve, sep } from 'node:path'

class QaGraphError extends Error {
  name = 'QaGraphError'

  constructor(message) {
    super(message)
  }
}

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function collectVersions(value, versions = new Map()) {
  if (Array.isArray(value)) {
    for (const item of value) collectVersions(item, versions)
    return versions
  }
  if (!isRecord(value)) return versions

  if (typeof value.name === 'string' && typeof value.version === 'string') {
    const current = versions.get(value.name) ?? new Set()
    current.add(value.version)
    versions.set(value.name, current)
  }
  for (const section of ['dependencies', 'devDependencies', 'optionalDependencies']) {
    const dependencies = value[section]
    if (!isRecord(dependencies)) continue
    for (const [name, dependency] of Object.entries(dependencies)) {
      if (isRecord(dependency) && typeof dependency.version === 'string') {
        const current = versions.get(name) ?? new Set()
        current.add(dependency.version)
        versions.set(name, current)
      }
      collectVersions(dependency, versions)
    }
  }
  return versions
}

function expectedVersion(name, matrix) {
  if (name === '@deepseek-harness-tui/dsh-tui') return matrix.dshTui
  if (name === '@deepseek-ai/cordis') return matrix.cordis
  if (name === '@earendil-works/pi-ai') return matrix.piAi
  if (name.startsWith('@deepseek-ai/dsh-')) return matrix.dsh
  return matrix.bundles[name]
}

export function validateDependencyGraph(graph, matrix) {
  const versions = collectVersions(graph)
  const required = [
    '@deepseek-harness-tui/dsh-tui',
    '@deepseek-ai/cordis',
    '@earendil-works/pi-ai',
    ...Object.keys(matrix.bundles),
  ]
  for (const name of required) {
    if (!versions.has(name)) throw new QaGraphError(`${name} is missing from the installed graph`)
  }
  for (const [name, resolved] of versions) {
    const expected = expectedVersion(name, matrix)
    if (expected === undefined) continue
    const mismatches = [...resolved].filter((version) => version !== expected)
    if (mismatches.length > 0) {
      throw new QaGraphError(`${name} resolved incompatible versions ${[...resolved].join(', ')}; expected ${expected}`)
    }
  }
  return {
    versions: Object.fromEntries([...versions].map(([name, resolved]) => [name, [...resolved].sort()])),
  }
}

function isWithin(candidate, parent) {
  const path = relative(resolve(parent), resolve(candidate))
  return path === '' || (path !== '..' && !path.startsWith(`..${sep}`))
}

export function assertInstalledRealpath(packageName, packagePath, dshHome, repoRoot) {
  const installed = realpathSync(packagePath)
  if (!isWithin(installed, dshHome) || isWithin(installed, repoRoot)) {
    throw new QaGraphError(`${packageName} resolves outside isolated DSH_HOME: ${installed}`)
  }
  return installed
}

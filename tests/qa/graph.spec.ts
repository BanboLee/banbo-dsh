import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  assertInstalledRealpath,
  validateDependencyGraph,
} from '../../scripts/qa/lib/graph.mjs'

const matrix = {
  nodeMajor: 26,
  dsh: '0.1.2-rc.1',
  dshTui: '0.10.0-beta.5',
  cordis: '4.0.2',
  piAi: '0.84.4',
  bundles: {
    'dsh-fish-shell': '0.4.0',
    'dsh-rtk': '0.1.0',
    'dsh-codegraph-mcp': '0.1.0',
    'dsh-llm-pi-ai-with-session': '0.1.0',
    'dsh-lsp-diagnostics': '0.1.0',
  },
} as const

const roots: string[] = []

function packageNode(name: string, version: string, dependencies: Record<string, unknown> = {}) {
  return { name, version, dependencies }
}

function validGraph(): unknown {
  return [{
    name: 'dsh-tui-profile',
    dependencies: {
      '@deepseek-harness-tui/dsh-tui': packageNode('@deepseek-harness-tui/dsh-tui', matrix.dshTui, {
        '@deepseek-ai/dsh-agent': packageNode('@deepseek-ai/dsh-agent', matrix.dsh),
        '@deepseek-ai/cordis': packageNode('@deepseek-ai/cordis', matrix.cordis),
        '@earendil-works/pi-ai': packageNode('@earendil-works/pi-ai', matrix.piAi),
      }),
      ...Object.fromEntries(
        Object.entries(matrix.bundles).map(([name, version]) => [name, packageNode(name, version)]),
      ),
    },
  }]
}

describe('isolated dsh-tui graph validation', () => {
  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
  })

  it('accepts one coherent target family when every required package is present', () => {
    // Given: a graph containing the pinned TUI, Harness, Cordis, pi-ai, and bundle versions.
    const graph = validGraph()

    // When: the installed dependency closure is checked.
    const result = validateDependencyGraph(graph, matrix)

    // Then: all required package versions are reported without mismatches.
    expect(result.versions['@deepseek-ai/dsh-agent']).toEqual([matrix.dsh])
    expect(result.versions['dsh-fish-shell']).toEqual([matrix.bundles['dsh-fish-shell']])
  })

  it('rejects a mixed Harness family when an incompatible duplicate is present', () => {
    // Given: an otherwise valid graph with a stale duplicate Harness package.
    const graph = validGraph()
    const root = Array.isArray(graph) ? graph[0] : undefined
    if (typeof root !== 'object' || root === null) throw new TypeError('invalid graph fixture')
    Object.assign(root, {
      devDependencies: {
        '@deepseek-ai/dsh-agent': packageNode('@deepseek-ai/dsh-agent', '0.1.1'),
      },
    })

    // When: the graph is validated against the matrix.
    const validate = () => validateDependencyGraph(graph, matrix)

    // Then: the incompatible duplicate blocks G4.
    expect(validate).toThrow(/@deepseek-ai\/dsh-agent.*0\.1\.1/)
  })

  it('rejects a missing local bundle when the profile closure is incomplete', () => {
    // Given: a graph without the required RTK bundle.
    const graph = validGraph()
    const root = Array.isArray(graph) ? graph[0] : undefined
    if (typeof root !== 'object' || root === null || !('dependencies' in root)) {
      throw new TypeError('invalid graph fixture')
    }
    const dependencies = root.dependencies
    if (typeof dependencies !== 'object' || dependencies === null) throw new TypeError('invalid dependencies fixture')
    delete dependencies['dsh-rtk']

    // When: the graph is validated against the complete matrix.
    const validate = () => validateDependencyGraph(graph, matrix)

    // Then: the absent bundle blocks G4.
    expect(validate).toThrow(/dsh-rtk.*missing/)
  })

  it('rejects a bundle realpath that resolves through the workspace', () => {
    // Given: an installed-package path located in the repository instead of the isolated profile.
    const root = mkdtempSync(join(tmpdir(), 'dsh-tui-qa-graph-'))
    roots.push(root)
    const dshHome = join(root, 'dsh-home')
    const repoRoot = join(root, 'repo')
    const packagePath = join(repoRoot, 'plugins', 'rtk', 'package.json')
    mkdirSync(join(repoRoot, 'plugins', 'rtk'), { recursive: true })
    mkdirSync(dshHome, { recursive: true })
    writeFileSync(packagePath, '{}')

    // When: the package realpath is checked.
    const validate = () => assertInstalledRealpath('dsh-rtk', packagePath, dshHome, repoRoot)

    // Then: workspace-linked installation is rejected.
    expect(validate).toThrow(/outside isolated DSH_HOME/)
  })
})

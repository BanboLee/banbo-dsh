import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, normalize } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
const installScript = join(repoRoot, 'scripts', 'sync-rtk-codegraph-to-profile.sh')

interface PackageManifest {
  readonly name: string
  readonly type?: string
  readonly files: readonly string[]
  readonly peerDependencies: Readonly<Record<string, string>>
  readonly dsh: {
    readonly bundle?: {
      readonly patch?: string
    }
  }
}

interface BundleExpectation {
  readonly directory: string
  readonly packageName: string
  readonly files: readonly string[]
  readonly peerDependencies: Readonly<Record<string, string>>
}

const bundleExpectations: readonly BundleExpectation[] = [
  {
    directory: 'plugins/rtk',
    packageName: 'dsh-rtk',
    files: ['index.js', 'grep-compress.js', 'cordis.patch.yml', 'README.md'],
    peerDependencies: {
      '@deepseek-ai/cordis': '>=4.0.1 <5.0.0-0',
    },
  },
  {
    directory: 'plugins/codegraph-mcp',
    packageName: 'dsh-codegraph-mcp',
    files: ['cordis.patch.yml', 'README.md'],
    peerDependencies: {
      '@deepseek-ai/cordis': '>=4.0.1 <5.0.0-0',
      '@deepseek-ai/dsh-mcp-client': '^0.1.1-rc.2',
    },
  },
  {
    directory: 'plugins/dsh-llm-pi-ai-with-session',
    packageName: 'dsh-llm-pi-ai-with-session',
    files: ['index.js', 'adapter.js', 'context.js', 'stream.js', 'cordis.patch.yml', 'README.md'],
    peerDependencies: {
      '@deepseek-ai/cordis': '>=4.0.1 <5.0.0-0',
      '@deepseek-ai/dsh-llm': '^0.1.1-rc.2 || ^0.1.2-alpha.4',
      '@earendil-works/pi-ai': '^0.84.2',
    },
  },
  {
    directory: 'plugins/dsh-lsp-diagnostics',
    packageName: 'dsh-lsp-diagnostics',
    files: ['index.js', 'collector.js', 'framing.js', 'runtime.js', 'render.js', 'coordinator.js', 'cordis.patch.yml', 'README.md'],
    peerDependencies: {
      '@deepseek-ai/cordis': '>=4.0.1 <5.0.0-0',
      '@deepseek-ai/dsh-fs': '>=0.1.1-rc.2 <0.1.2-0',
      '@deepseek-ai/dsh-llm': '>=0.1.1-rc.2 <0.1.2-0',
      '@deepseek-ai/dsh-subprocess': '>=0.1.1-rc.2 <0.1.2-0',
      '@deepseek-ai/dsh-tools': '>=0.1.1-rc.2 <0.1.2-0',
    },
  },
] as const

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function stringField(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key]
  return typeof value === 'string' ? value : undefined
}

function stringArrayField(record: Record<string, unknown>, key: string): readonly string[] {
  const value = record[key]
  if (!Array.isArray(value)) return []
  return value.filter((item): item is string => typeof item === 'string')
}

function stringRecordField(record: Record<string, unknown>, key: string): Readonly<Record<string, string>> {
  const value = record[key]
  if (!isRecord(value)) return {}
  return Object.fromEntries(
    Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === 'string'),
  )
}

function recordField(record: Record<string, unknown>, key: string): Record<string, unknown> {
  const value = record[key]
  return isRecord(value) ? value : {}
}

function readManifest(directory: string): PackageManifest {
  const parsed: unknown = JSON.parse(readFileSync(join(repoRoot, directory, 'package.json'), 'utf8'))
  if (!isRecord(parsed)) throw new TypeError(`package.json in ${directory} is not an object`)
  const name = stringField(parsed, 'name')
  if (name === undefined) throw new TypeError(`package.json in ${directory} has no name`)
  const dsh = recordField(parsed, 'dsh')
  const bundle = recordField(dsh, 'bundle')
  return {
    name,
    type: stringField(parsed, 'type'),
    files: stringArrayField(parsed, 'files'),
    peerDependencies: stringRecordField(parsed, 'peerDependencies'),
    dsh: { bundle: { patch: stringField(bundle, 'patch') } },
  }
}

function readRepoFile(relativePath: string): string {
  return readFileSync(join(repoRoot, relativePath), 'utf8')
}

function readStringArrayJson(relativePath: string): readonly string[] {
  const parsed: unknown = JSON.parse(readFileSync(relativePath, 'utf8'))
  if (!Array.isArray(parsed) || !parsed.every((item): item is string => typeof item === 'string')) {
    throw new TypeError(`${relativePath} did not contain a JSON string array`)
  }
  return parsed
}

describe('DSH bundle package manifests', () => {
  for (const expected of bundleExpectations) {
    it(`${expected.packageName} declares the installable DSH bundle shape`, () => {
      const manifest = readManifest(expected.directory)

      expect(manifest.name).toBe(expected.packageName)
      expect(manifest.type).toBe('module')
      expect(manifest.dsh.bundle?.patch).toBe('./cordis.patch.yml')
      expect(manifest.files).toEqual(expect.arrayContaining([...expected.files]))
      expect(manifest.peerDependencies).toEqual(expected.peerDependencies)

      const patchPath = join(repoRoot, expected.directory, manifest.dsh.bundle?.patch ?? 'missing')
      expect(normalize(patchPath)).toBe(join(repoRoot, expected.directory, 'cordis.patch.yml'))
      expect(existsSync(patchPath)).toBe(true)
    })
  }
})

describe('Task-5 install surface', () => {
  it('documents copy-paste install commands at the root', () => {
    const readme = readRepoFile('README.md')

    expect(readme).toContain('dsh plugin --profile <profile> add -w ./plugins/rtk')
    expect(readme).toContain('dsh plugin --profile <profile> add -w ./plugins/codegraph-mcp')
  })

  it('provides an observable two-plugin sync script without requiring the real profile in help/error paths', () => {
    const help = spawnSync('bash', [installScript, '--help'], {
      cwd: repoRoot,
      encoding: 'utf8',
      env: { ...process.env, DSH_BIN: '/definitely/not/dsh' },
    })
    const invalid = spawnSync('bash', [installScript, '../real-profile'], {
      cwd: repoRoot,
      encoding: 'utf8',
      env: { ...process.env, DSH_BIN: '/definitely/not/dsh' },
    })

    expect(help.status).toBe(0)
    expect(help.stdout).toContain('dsh plugin --profile <profile> add -w ./plugins/rtk')
    expect(help.stdout).toContain('dsh plugin --profile <profile> add -w ./plugins/codegraph-mcp')
    expect(invalid.status).not.toBe(0)
    expect(invalid.stderr).toMatch(/invalid profile/i)
  })

  it('passes the workspace-root flag before both local bundle paths when invoking dsh plugin add', () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'fake-dsh-argv-'))
    try {
      const fakeDsh = join(tempDir, 'dsh')
      const argvFile = join(tempDir, 'argv.json')
      writeFileSync(fakeDsh, [
        '#!/usr/bin/env node',
        "import { writeFileSync } from 'node:fs'",
        'const out = process.env.FAKE_DSH_ARGV_OUT',
        'if (out === undefined) process.exit(99)',
        'writeFileSync(out, JSON.stringify(process.argv.slice(2)))',
      ].join('\n') + '\n')
      chmodSync(fakeDsh, 0o755)

      const result = spawnSync('bash', [installScript, 'task5-fake'], {
        cwd: repoRoot,
        encoding: 'utf8',
        env: {
          ...process.env,
          DSH_BIN: fakeDsh,
          DSH_HOME: join(tempDir, 'dsh-home'),
          FAKE_DSH_ARGV_OUT: argvFile,
        },
      })

      expect(result.status).toBe(0)
      expect(readStringArrayJson(argvFile)).toEqual([
        'plugin',
        '--profile',
        'task5-fake',
        'add',
        '-w',
        join(repoRoot, 'plugins', 'rtk'),
        join(repoRoot, 'plugins', 'codegraph-mcp'),
      ])
    } finally {
      rmSync(tempDir, { recursive: true, force: true })
    }
  })
})

function extractLockImporterDevDeps(
  lock: string,
  importer: string,
): Readonly<Record<string, { readonly specifier: string; readonly version: string }>> {
  const lines = lock.split('\n')
  const header = `  ${importer}:`
  const start = lines.findIndex((line) => line === header)
  if (start === -1) return {}
  const result: Record<string, { readonly specifier: string; readonly version: string }> = {}
  let current: string | undefined
  for (let index = start + 1; index < lines.length; index += 1) {
    const line = lines[index]
    if (line === undefined) continue
    if (/^  \S/.test(line) || /^\S/.test(line)) break
    const depMatch = /^ {6}'([^']+)':$/.exec(line)
    if (depMatch !== null && depMatch[1] !== undefined) {
      current = depMatch[1]
      result[current] = { specifier: '', version: '' }
      continue
    }
    if (current === undefined) continue
    const specMatch = /^ {8}specifier: (.+)$/.exec(line)
    if (specMatch !== null && specMatch[1] !== undefined) {
      result[current] = { ...result[current], specifier: specMatch[1] }
    }
    const verMatch = /^ {8}version: (.+)$/.exec(line)
    if (verMatch !== null && verMatch[1] !== undefined) {
      result[current] = { ...result[current], version: verMatch[1] }
    }
  }
  return result
}

describe('dsh-lsp-diagnostics dependency locking', () => {
  it('resolves every direct devDependency to its exact pinned version in pnpm-lock.yaml', () => {
    const lock = readRepoFile('pnpm-lock.yaml')
    const manifest: unknown = JSON.parse(readRepoFile('plugins/dsh-lsp-diagnostics/package.json'))
    if (!isRecord(manifest)) throw new TypeError('dsh-lsp-diagnostics package.json is not an object')
    const devDeps = stringRecordField(manifest, 'devDependencies')
    const resolved = extractLockImporterDevDeps(lock, 'plugins/dsh-lsp-diagnostics')
    for (const [name, expected] of Object.entries(devDeps)) {
      const entry = resolved[name]
      expect(entry, `direct devDependency ${name} must be recorded in pnpm-lock.yaml`).toBeDefined()
      expect(entry?.specifier).toBe(expected)
      expect(entry?.version.startsWith(expected)).toBe(true)
      // The resolved package key must exist at exactly this version — never a
      // transitive prerelease standing in for the direct dependency.
      expect(lock.includes(`'${name}@${expected}`)).toBe(true)
    }
  })
})

describe('real headless E2E discoverability', () => {
  it('exposes and documents the opt-in fail-loud command and binary overrides', () => {
    // Given the root package manifest and README
    const manifest: unknown = JSON.parse(readRepoFile('package.json'))
    if (!isRecord(manifest)) throw new TypeError('root package.json is not an object')
    const scripts = stringRecordField(manifest, 'scripts')
    const packageManager = stringField(manifest, 'packageManager')
    const readme = readRepoFile('README.md')

    // When the real headless E2E entry point is inspected
    const command = scripts['test:e2e:headless']

    // Then the gate and every executable override are discoverable
    expect(command).toBe('RUN_REAL_HEADLESS_E2E=1 vitest run tests/e2e')
    expect(packageManager).toBe('pnpm@9.3.0')
    expect(readme).toContain('test:e2e:headless')
    expect(readme).toContain('corepack pnpm')
    expect(readme).toContain('DSH_REAL_E2E_DSH_BIN')
    expect(readme).toContain('DSH_REAL_E2E_NODE_BIN')
    expect(readme).toContain('DSH_REAL_E2E_RTK_BIN')
    expect(readme).toContain('DSH_REAL_E2E_CODEGRAPH_BIN')
    expect(readme).toContain('fail')
  })
})

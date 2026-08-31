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

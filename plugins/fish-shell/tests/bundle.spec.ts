import { describe, expect, it } from 'vitest'
import { parse as parseYaml } from 'yaml'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { FISH_PROMPT_SETUP } from '../terminal-fish.js'

const PATCH_PATH = fileURLToPath(new URL('../cordis.patch.yml', import.meta.url))

interface PatchRow {
  id?: string
  name?: string
  disabled?: boolean
  group?: boolean
  insert?: PatchRow[]
  /** `cordis:group` rows hold their child rows here; leaf rows hold the
   * plugin config object (`shellPath`, `shellArgs`, `timeoutMs`, …). */
  config?: PatchRow[] | Record<string, unknown>
  isolate?: Record<string, boolean>
}

function patchRows(source: string): PatchRow[] {
  const rows = parseYaml(source) as PatchRow[]
  return rows.flatMap(row => row.insert ?? [row])
}

/** The child rows of a `cordis:group` row (empty for a leaf row). */
function configRows(row: PatchRow | undefined): PatchRow[] {
  return Array.isArray(row?.config) ? row.config : []
}

/** The plugin config object of a leaf row (empty for a group row). */
function configObject(row: PatchRow | undefined): Record<string, unknown> {
  const config = row?.config
  return config !== undefined && !Array.isArray(config) ? config : {}
}

/** Every row at every level: host rows, insert blocks, and group children. */
function allRows(rows: PatchRow[]): PatchRow[] {
  return rows.flatMap(row => [row, ...allRows(row.insert ?? []), ...allRows(configRows(row))])
}

describe('@banbolee/dsh-fish-shell bundle patch', () => {
  it('inserts the fish-preset-policy row mounting the policy module after the tool rows', () => {
    const rows = patchRows(readFileSync(PATCH_PATH, 'utf8'))
    const matching = rows.filter(row => row.id === 'fish-preset-policy')
    expect(matching).toHaveLength(1)
    expect(matching[0]?.name).toBe('@banbolee/dsh-fish-shell/policy')
    const ids = rows.map(row => row.id)
    expect(ids.indexOf('fish-preset-policy')).toBeGreaterThan(ids.indexOf('tool-fish'))
  })

  it('no longer repoints the roster default at fish (dsh-tui-agent-presets block removed)', () => {
    const source = readFileSync(PATCH_PATH, 'utf8')
    const rows = patchRows(source)
    expect(rows.map(row => row.id)).not.toContain('dsh-tui-agent-presets')
    expect(source).not.toContain('default: fish')
  })

  it('mounts the L2 terminal surface as one isolated group driven with fish argv', () => {
    const source = readFileSync(PATCH_PATH, 'utf8')
    const tree = parseYaml(source) as PatchRow[]

    // The host plane still mounts no `terminal-fish` row: persistent.js
    // self-manages a FishTerminalBackend, and a host row injecting `terminals`
    // would stay pending forever in profiles whose host plane has no
    // `terminals` service. The L2 sessions live in their own isolate group
    // instead (fish-shell-tty-v3 §3.1), so `terminal-fish.js` stays a library
    // export only: it must never appear as a patch row at any level.
    expect(allRows(tree).filter(row => row.name === '@banbolee/dsh-fish-shell/terminal-fish')).toHaveLength(0)

    const groups = allRows(tree).filter(row => row.id === 'fish-terminal-group')
    expect(groups).toHaveLength(1)
    const group = groups[0]
    expect(group?.name).toBe('cordis:group')
    expect(group?.group).toBe(true)
    // `terminals` is entry-local to the group; mounting it at the host plane
    // would leave the entry pending.
    expect(group?.isolate).toEqual({ terminals: true })

    const children = configRows(group)
    expect(children.map(row => [row.id, row.name])).toEqual([
      ['pty', '@deepseek-ai/dsh-terminal'],
      ['terminal-fish-pty', '@banbolee/dsh-fish-shell/terminal'],
      ['terminal-tools', '@deepseek-ai/dsh-tool-terminal'],
      ['fish-terminal-tools', '@banbolee/dsh-fish-shell/terminal-tools'],
    ])

    // The group is appended after the host-plane rows (bash disabled +
    // fish-shell/tool-fish/fish-preset-policy), which stay untouched.
    const hostIds = patchRows(source).map(row => row.id)
    expect(hostIds.indexOf('fish-terminal-group')).toBeGreaterThan(hostIds.indexOf('fish-preset-policy'))

    // The backend row mounts this bundle's `terminal.js` — the official
    // `BashTerminalBackend` plus the harness home contract in the PTY child
    // environment (the official row exposes no `env` field, and its
    // `childEnvironment()` is module-private). It is driven with fish argv; the
    // prompt setup rides in the trailing `-C` and must stay byte-identical to
    // the exported constant (the patch is YAML, so it cannot import it). The
    // home facts are NOT configured here: the row must not be able to bypass
    // the injection, and the backend type must stay the schema default
    // (`shell`), which the real lane asserts through `listBackends()`.
    const backend = children.find(row => row.id === 'terminal-fish-pty')
    const backendConfig = configObject(backend)
    expect(backendConfig['shellPath']).toBe('fish')
    const shellArgs = backendConfig['shellArgs'] as string[]
    expect(shellArgs.slice(0, 3)).toEqual(['--no-config', '-i', '-C'])
    expect(shellArgs).toHaveLength(4)
    expect(shellArgs[3]).toBe(FISH_PROMPT_SETUP)
    expect(backendConfig['timeoutMs']).toBe(300000)
    expect(backendConfig['backendType']).toBeUndefined()
    expect(backendConfig['env']).toBeUndefined()
  })

  it('still disables the host bash executor/tool and mounts fish-shell + tool-fish', () => {
    const source = readFileSync(PATCH_PATH, 'utf8')
    const rows = parseYaml(source) as PatchRow[]
    expect(rows.filter(row => row.id === 'bash-sandbox' && row.disabled === true)).toHaveLength(1)
    expect(rows.filter(row => row.id === 'tool-bash' && row.disabled === true)).toHaveLength(1)
    const insert = patchRows(source)
    expect(insert.filter(row => row.id === 'fish-shell' && row.name === '@banbolee/dsh-fish-shell')).toHaveLength(1)
    expect(insert.filter(row => row.id === 'tool-fish' && row.name === '@banbolee/dsh-fish-shell/tool')).toHaveLength(1)
  })
})

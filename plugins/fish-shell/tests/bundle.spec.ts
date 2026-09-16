import { describe, expect, it } from 'vitest'
import { parse as parseYaml } from 'yaml'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const PATCH_PATH = fileURLToPath(new URL('../cordis.patch.yml', import.meta.url))

interface PatchRow {
  id?: string
  name?: string
  disabled?: boolean
  insert?: PatchRow[]
}

function patchRows(source: string): PatchRow[] {
  const rows = parseYaml(source) as PatchRow[]
  return rows.flatMap(row => row.insert ?? [row])
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

  it('no longer mounts the fish-terminal host plugin row (persistent PTY is policy-managed)', () => {
    const source = readFileSync(PATCH_PATH, 'utf8')
    // The terminals service is entry-local to the minimal preset's isolate
    // realm and invisible at the host plane (headless / dsh-tui / composition
    // test profiles), so a host row injecting terminals would stay pending
    // forever. persistent.js self-manages a FishTerminalBackend instead;
    // terminal-fish.js remains exported as a library for direct assembly.
    expect(source).not.toContain('fish-terminal')
    expect(source).not.toContain('@banbolee/dsh-fish-shell/terminal-fish')
    expect(parseYaml(source) as PatchRow[]).not.toContain(expect.objectContaining({ id: 'fish-terminal' }))
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

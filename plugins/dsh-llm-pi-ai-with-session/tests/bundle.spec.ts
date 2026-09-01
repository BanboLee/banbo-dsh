import { describe, it, expect } from 'vitest'
import { parse as parseYaml } from 'yaml'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const PATCH_PATH = fileURLToPath(new URL('../cordis.patch.yml', import.meta.url))

interface PatchRow {
  id?: string
  name?: string
  insert?: PatchRow[]
}

function patchRows(source: string): PatchRow[] {
  const rows = parseYaml(source) as PatchRow[]
  return rows.flatMap(row => row.insert ?? [row])
}

describe('dsh-llm-pi-ai-with-session bundle patch', () => {
  it('inserts exactly one llm-pi-ai-with-session row mounting the plugin package', () => {
    const rows = patchRows(readFileSync(PATCH_PATH, 'utf8'))
    const matching = rows.filter(row => row.id === 'llm-pi-ai-with-session')
    expect(matching).toHaveLength(1)
    expect(matching[0]?.name).toBe('dsh-llm-pi-ai-with-session')
  })

  it('does not patch llm-pi-ai or llm-deepseek rows (separate route through the adapter seam)', () => {
    const rows = patchRows(readFileSync(PATCH_PATH, 'utf8'))
    const ids = rows.map(row => row.id)
    expect(ids).not.toContain('llm-pi-ai')
    expect(ids).not.toContain('llm-deepseek')
  })
})

import { describe, it, expect } from 'vitest'
import { realpathSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parse as parseYaml } from 'yaml'
import {
  ROW_ID,
  BRIDGE_PACKAGE,
  patchPath,
  readPatch,
  composePatch,
  rowById,
  parseRowConfig,
} from './helpers'

describe('@banbolee/dsh-codegraph-mcp bundle patch', () => {
  it('inserts exactly one mcp-codegraph row consuming the official @deepseek-ai/dsh-mcp-client bridge', () => {
    const rows = composePatch(readPatch(patchPath()))
    const matching = rows.filter((row) => row.id === ROW_ID)
    expect(matching).toHaveLength(1)
    expect(matching[0].name).toBe(BRIDGE_PACKAGE)
  })

  it('defaults to the plan contract: stdio codegraph server via `serve --mcp` with CODEGRAPH_NO_DAEMON=1', () => {
    const config = parseRowConfig(rowById(composePatch(readPatch(patchPath())), ROW_ID))
    expect(config.serverName).toBe('codegraph')
    expect(config.transport).toBe('stdio')
    expect(config.command).toBe('codegraph')
    expect(config.args).toEqual(['serve', '--mcp'])
    expect(config.env).toEqual({ CODEGRAPH_NO_DAEMON: '1' })
  })

  it('ships no project path by default (codegraph derives it from the client rootUri)', () => {
    const config = parseRowConfig(rowById(composePatch(readPatch(patchPath())), ROW_ID))
    expect(config.args).not.toContain('--path')
  })
})

describe('profile override for a project path', () => {
  it('appends --path <workspace-realpath> through a profile patch without editing package code', () => {
    const workspace = mkdtempSync(join(tmpdir(), 'codegraph-ws-'))
    try {
      const realpath = realpathSync(workspace)
      const override = [
        `- id: ${ROW_ID}`,
        '  config:',
        '    serverName: codegraph',
        '    transport: stdio',
        '    command: codegraph',
        `    args: ['serve', '--mcp', '--path', '${realpath}']`,
        '    env:',
        "      CODEGRAPH_NO_DAEMON: '1'",
      ].join('\n')
      const composed = composePatch([...readPatch(patchPath()), ...(parseYaml(override) as unknown[])])
      const config = parseRowConfig(rowById(composed, ROW_ID))
      expect(config.args).toEqual(['serve', '--mcp', '--path', realpath])
      // Unrelated keys survive because the profile restates them (whole-config replacement).
      expect(config.serverName).toBe('codegraph')
      expect(config.env).toEqual({ CODEGRAPH_NO_DAEMON: '1' })
    } finally {
      rmSync(workspace, { recursive: true, force: true })
    }
  })
})

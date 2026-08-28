/**
 * Test helpers for the dsh-codegraph-mcp bundle.
 *
 * These model just enough of the DSH bundle/profile patch contract (documented
 * in deepseek-harness/packages/bundle/base/cordis.patch.yml and
 * packages/bundle/README.md) to test the bundle: a bundle patch `insert:`s
 * rows, and a later profile patch layer addresses a row by id and replaces its
 * WHOLE config (last write wins). The real composition/boot is exercised by
 * the separate profile composition lane; this package proves the row contract
 * deterministically.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { parse as parseYaml } from 'yaml'

/** Bundle row id inserted by cordis.patch.yml. */
export const ROW_ID = 'mcp-codegraph'
/** Official DSH MCP bridge package the row consumes. */
export const BRIDGE_PACKAGE = '@deepseek-ai/dsh-mcp-client'

export interface BundleRow {
  id: string
  name: string
  config: Record<string, unknown>
}

/** Absolute path to the bundle patch under test. */
export function patchPath(): string {
  return join(dirname(fileURLToPath(import.meta.url)), '..', 'cordis.patch.yml')
}

/** Parse a DSH cordis patch document into its operation list. */
export function readPatch(file: string): unknown[] {
  return parseYaml(readFileSync(file, 'utf8')) as unknown[]
}

/**
 * Compose a patch operation list into rows: collect `insert:`ed rows, then
 * apply later by-id overrides (whole-config replacement, last write wins).
 */
export function composePatch(operations: unknown[]): BundleRow[] {
  const rows = new Map<string, BundleRow>()
  for (const operation of operations as Array<Record<string, unknown>>) {
    if (Array.isArray(operation.insert)) {
      for (const row of operation.insert as Array<Record<string, unknown>>) {
        if (typeof row.id !== 'string' || typeof row.name !== 'string') continue
        rows.set(row.id, {
          id: row.id,
          name: row.name,
          config: (row.config ?? {}) as Record<string, unknown>,
        })
      }
      continue
    }
    if (typeof operation.id === 'string') {
      const existing = rows.get(operation.id)
      if (existing === undefined) continue
      if (operation.config !== null && typeof operation.config === 'object') {
        rows.set(operation.id, { ...existing, config: operation.config as Record<string, unknown> })
      }
    }
  }
  return [...rows.values()]
}

export function rowById(rows: BundleRow[], id: string): BundleRow {
  const row = rows.find((candidate) => candidate.id === id)
  if (row === undefined) throw new Error(`bundle patch has no row with id "${id}"`)
  return row
}

/** Typed projection of the mcp-codegraph row config (parse at the boundary). */
export interface McpRowConfig {
  serverName: string
  transport: 'stdio'
  command: string
  args: string[]
  env: Record<string, string>
}

export function parseRowConfig(row: BundleRow): McpRowConfig {
  if (row.config.transport !== 'stdio') {
    throw new Error(`mcp-codegraph row must use stdio transport, got ${JSON.stringify(row.config.transport)}`)
  }
  return {
    serverName: String(row.config.serverName),
    transport: 'stdio',
    command: String(row.config.command),
    args: Array.isArray(row.config.args) ? row.config.args.map(String) : [],
    env: (row.config.env ?? {}) as Record<string, string>,
  }
}

import { readFileSync, existsSync, statSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it } from 'vitest'
import { runExec } from '../../../tests/helpers/process'

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
const blockFile = join(root, 'plugins', 'codegraph-mcp', 'instructions', 'CODEGRAPH.md')
const scriptFile = join(root, 'scripts', 'install-codegraph-instructions.sh')
const START = '<!-- CODEGRAPH_START -->'
const END = '<!-- CODEGRAPH_END -->'

/** Extract the fenced block (markers inclusive, trailing newline stripped). */
function fencedBlock(): string {
  const text = readFileSync(blockFile, 'utf8')
  const start = text.indexOf(START)
  const end = text.indexOf(END)
  expect(start, 'block must contain the start marker').toBeGreaterThanOrEqual(0)
  expect(end, 'block must contain the end marker').toBeGreaterThan(start)
  return text.slice(start, end + END.length)
}

describe('@banbolee/dsh-codegraph-mcp agent instructions block', () => {
  it('ships one marker-fenced CodeGraph block usable by dsh-agent-instructions', () => {
    const block = fencedBlock()
    // Exactly one fenced section, markers paired once each.
    expect(block.split(START)).toHaveLength(2)
    expect(block.split(END)).toHaveLength(2)
    expect(block).toContain('## CodeGraph')
  })

  it('points agents and subagents at the server-qualified tool name first', () => {
    const block = fencedBlock()
    expect(block).toContain('mcp__codegraph__codegraph_explore')
    expect(block).toMatch(/reach for it BEFORE/i)
    expect(block).toMatch(/projectPath/)
  })

  it('stays short (bounded block, since the main agent reads it every turn)', () => {
    const block = fencedBlock()
    expect(block.length).toBeLessThan(2000)
  })

  it('has an executable install script next to the other bundle scripts', () => {
    expect(existsSync(scriptFile)).toBe(true)
    const mode = statSync(scriptFile).mode
    // Owner-execute bit set (matching the other scripts' executable convention).
    expect(mode & 0o100, 'script must be executable').not.toBe(0)
  })
})

describe('install-codegraph-instructions.sh (deterministic, no live codegraph)', () => {
  const dirs: string[] = []

  afterEach(() => {
    while (dirs.length > 0) {
      const dir = dirs.pop()!
      try {
        rmSync(dir, { recursive: true, force: true })
      } catch {
        // ignore cleanup failures
      }
    }
  })

  function tmpTarget(prefix: string): { dir: string; file: string } {
    const dir = mkdtempSync(join(tmpdir(), `dsh-cg-${prefix}-`))
    dirs.push(dir)
    return { dir, file: join(dir, 'AGENTS.md') }
  }

  it('creates a fresh target with exactly the fenced block', async () => {
    const { file } = tmpTarget('create')
    const run = await runExec(scriptFile, [file])
    expect(run.code).toBe(0)
    expect(run.stdout.trim()).toBe('created')
    expect(readFileSync(file, 'utf8')).toBe(fencedBlock() + '\n')
  })

  it('reports unchanged on an identical re-run and touches nothing', async () => {
    const { file } = tmpTarget('idempotent')
    const first = await runExec(scriptFile, [file])
    expect(first.code).toBe(0)
    const before = readFileSync(file, 'utf8')
    const second = await runExec(scriptFile, [file])
    expect(second.code).toBe(0)
    expect(second.stdout.trim()).toBe('unchanged')
    expect(readFileSync(file, 'utf8')).toBe(before)
  })

  it('appends the block after existing content and preserves it', async () => {
    const { file } = tmpTarget('append')
    writeFileSync(file, '# my project\n\nMy own AGENTS.md instructions.\n')
    const run = await runExec(scriptFile, [file])
    expect(run.code).toBe(0)
    expect(run.stdout.trim()).toBe('appended')
    const text = readFileSync(file, 'utf8')
    expect(text).toContain('# my project')
    expect(text).toContain('My own AGENTS.md instructions.')
    expect(text).toContain(START)
    expect(text.indexOf('# my project')).toBeLessThan(text.indexOf(START))
  })

  it('replaces only the fenced section when the block changed (self-heal)', async () => {
    const { file } = tmpTarget('update')
    await runExec(scriptFile, [file])
    // Corrupt the installed block the way a stale install would.
    const stale = readFileSync(file, 'utf8').replace('mcp__codegraph__codegraph_explore', 'mcp__codegraph__codegraph_search')
    writeFileSync(file, stale)
    const run = await runExec(scriptFile, [file])
    expect(run.code).toBe(0)
    expect(run.stdout.trim()).toBe('updated')
    const text = readFileSync(file, 'utf8')
    expect(text).toContain('mcp__codegraph__codegraph_explore')
    expect(text).not.toContain('mcp__codegraph__codegraph_search')
  })

  it('fails loud on a half-written fence instead of guessing', async () => {
    const { file } = tmpTarget('badfence')
    writeFileSync(file, `# x\n\n${START}\npartial\n`)
    const run = await runExec(scriptFile, [file])
    expect(run.code).not.toBe(0)
    expect(run.stderr).toContain('without')
  })

  it('defaults to $DSH_HOME/AGENTS.md when no target is given', async () => {
    const { dir } = tmpTarget('dshhome')
    const home = join(dir, 'home')
    mkdirSync(home, { recursive: true })
    const run = await runExec(scriptFile, [], { DSH_HOME: home })
    expect(run.code).toBe(0)
    expect(existsSync(join(home, 'AGENTS.md'))).toBe(true)
  })

  it('defaults to ~/.dsh/AGENTS.md when DSH_HOME is unset (harness default home)', async () => {
    const { dir } = tmpTarget('homedefault')
    // Empty DSH_HOME overrides any ambient value from the parent env, and HOME
    // points at the disposable dir so the no-arg default lands in ~/.dsh/AGENTS.md.
    const run = await runExec(scriptFile, [], { DSH_HOME: '', HOME: dir })
    expect(run.code).toBe(0)
    expect(existsSync(join(dir, '.dsh', 'AGENTS.md'))).toBe(true)
  })
})

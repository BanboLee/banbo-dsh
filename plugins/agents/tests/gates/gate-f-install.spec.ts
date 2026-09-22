/**
 * Gate F — real isolated install / uninstall lane (plan §14.3 item 15, §18).
 *
 * The plan's release gates claim an install → dump → uninstall cycle with user
 * data retained, but that evidence used to be manual prose. This lane makes it
 * executable. It is OPT-IN because it shells out to the real `dsh` CLI and lets
 * pnpm resolve the published dependency family, which the repository's
 * determinism rule forbids in the default suite:
 *
 *     BANBO_REAL_INSTALL=1 npx vitest run --config vitest.gates.config.ts \
 *       plugins/agents/tests/gates/gate-f-install.spec.ts
 *
 * CI runs exactly that step, so the claim is enforced rather than remembered.
 */

import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, describe, expect, it } from 'vitest'

const ENABLED = process.env.BANBO_REAL_INSTALL === '1'
const PACKAGE_NAME = '@banbolee/dsh-agents'
const pluginRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')

const scratch = mkdtempSync(join(tmpdir(), 'banbo-gate-f-'))
afterAll(() => {
  rmSync(scratch, { recursive: true, force: true })
})

/** Run one command with an isolated harness home, failing with its stderr. */
function run(command: string, args: readonly string[], dshHome: string): string {
  try {
    return execFileSync(command, [...args], {
      cwd: pluginRoot,
      encoding: 'utf8',
      env: { ...process.env, DSH_HOME: dshHome },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
  } catch (error) {
    const failure = error as { status?: number, stdout?: string, stderr?: string }
    throw new Error(
      `${command} ${args.join(' ')} exited ${String(failure.status)}\n--- stdout ---\n${failure.stdout ?? ''}\n--- stderr ---\n${failure.stderr ?? ''}`,
    )
  }
}

function dshAvailable(): boolean {
  try {
    execFileSync('dsh', ['--version'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
    return true
  } catch {
    return false
  }
}

describe.skipIf(!ENABLED)('gate F — real isolated install and uninstall', () => {
  it('installs the packed bundle, exposes the roster row, and removes it without touching user data', { timeout: 300_000 }, () => {
    expect(dshAvailable(), 'this lane needs the real `dsh` CLI on PATH').toBe(true)
    expect(existsSync(join(pluginRoot, 'lib', 'client.js')), 'run `pnpm build:agents` first').toBe(true)

    // 1. The published artifact, not the working tree.
    const packDir = mkdtempSync(join(scratch, 'pack-'))
    execFileSync('npm', ['pack', '--json', '--pack-destination', packDir], { cwd: pluginRoot, encoding: 'utf8' })
    const tarball = join(packDir, execFileSync('ls', [packDir], { encoding: 'utf8' }).trim().split('\n')[0]!)
    expect(tarball.endsWith('.tgz')).toBe(true)

    // 2. An isolated harness home, plus user data that must survive removal.
    const dshHome = mkdtempSync(join(scratch, 'dsh-home-'))
    const stateDir = join(dshHome, 'banbo-agents')
    const userDefinition = join(stateDir, 'agents', 'probe.yaml')
    mkdirSync(dirname(userDefinition), { recursive: true })
    writeFileSync(userDefinition, 'id: probe\n')
    const profile = 'gate-f'

    // 3. Install from the tarball.
    run('dsh', ['plugin', '--profile', profile, 'add', '-w', tarball], dshHome)

    // 4. The bundle patch put our row on the roster.
    const installed = run('dsh', ['--profile', profile, '--dump-config'], dshHome)
    expect(installed).toContain('banbo-agents')
    expect(installed).toContain(PACKAGE_NAME)

    // 5. Uninstall.
    run('dsh', ['plugin', '--profile', profile, 'remove', PACKAGE_NAME], dshHome)

    // 6. The row is gone and the official roster is back to its default.
    const removed = run('dsh', ['--profile', profile, '--dump-config'], dshHome)
    expect(removed).not.toContain(PACKAGE_NAME)
    expect(removed).not.toContain('id: banbo-agents')

    // 7. Uninstall is not a data-deletion: the user's own files stay exactly.
    expect(readFileSync(userDefinition, 'utf8')).toBe('id: probe\n')
  })
})

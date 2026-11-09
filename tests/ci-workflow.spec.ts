/**
 * CI workflow contract — `.github/workflows/ci.yml`.
 *
 * This file exists because of a real failure on `main`: the `fish-packed-offline`
 * job declared `actions/setup-node` with `cache: pnpm`, but the job runs no
 * workspace `pnpm install`. The action caches `pnpm store path`, so with no store
 * its POST step failed the job with
 *
 *     Path(s) specified in the action for caching were not found
 *
 * — a red run whose actual lane never even started. The rule that came out of it
 * is general, so it is asserted generally:
 *
 *   **a job may enable the pnpm cache only if it installs the workspace.**
 *
 * The YAML is PARSED, not grepped: a comment explaining why a job has no cache
 * must not be mistaken for the configuration itself, and this repository has
 * already been bitten by comments describing behaviour the code no longer had.
 */

import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { parse } from 'yaml'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const ciPath = join(repoRoot, '.github', 'workflows', 'ci.yml')

interface Step {
  readonly name?: string
  readonly uses?: string
  readonly run?: string
  readonly with?: Readonly<Record<string, unknown>>
}

interface Job {
  readonly 'runs-on'?: string
  readonly steps: readonly Step[]
}

interface Workflow {
  readonly jobs: Readonly<Record<string, Job>>
}

function load(): Workflow {
  return parse(readFileSync(ciPath, 'utf8')) as Workflow
}

/**
 * Split one `run:` script into individual COMMANDS.
 *
 * Line-based on purpose, and each line is tokenized rather than regex-matched as
 * a whole. Two failure modes this avoids:
 *
 *   - a step that runs `pnpm install` AND an unrelated `npm install -g <cli>`
 *     must still count (the global install must not disqualify the step);
 *   - a step that runs only `npm install -g <cli>` must not count.
 *
 * Shell separators (`&&`, `||`, `;`) and a leading `sudo` are dropped so the
 * command word is always first.
 *
 * @param script the step's `run:` body.
 * @returns the tokenized commands, one array per line.
 */
function commandsOf(script: string): string[][] {
  return script
    .split(/\r?\n/u)
    .map((line) => line.trim())
    // Comments and blank lines are not commands.
    .filter((line) => line !== '' && !line.startsWith('#'))
    .map((line) => line
      // `a && b`, `a || b`, `a; b` are separate commands.
      .split(/&&|\|\||;/u)
      .map((part) => part.trim())
      .filter((part) => part !== '')
      .map((part) => part.split(/\s+/u).filter((token) => token !== 'sudo')))
    .flat()
}

/**
 * Whether one COMMAND creates the pnpm store the cache would save.
 *
 * ONLY a non-global `pnpm install` qualifies. The store belongs to pnpm; `npm ci`
 * and a local `npm install` populate `node_modules` through npm's own cache and
 * leave `pnpm store path` empty, so a job that runs one of those and enables the
 * pnpm cache still fails its POST step. Treating them as equivalent would make
 * this test pass over exactly the failure it exists to catch.
 *
 * @param tokens one tokenized command.
 * @returns whether it is a workspace `pnpm install`.
 */
function isWorkspacePnpmInstall(tokens: readonly string[]): boolean {
  if (tokens[0] !== 'pnpm') return false
  // Walk the arguments, skipping the VALUE of flags that take one (`--filter x`,
  // `-C dir`). Without this, `pnpm --filter <selector> install` would read the
  // SELECTOR as the subcommand and miss the real `install`.
  const takesValue = new Set(['--filter', '-F', '--dir', '-C', '--reporter', '--registry'])
  let subcommand: string | undefined
  for (let index = 1; index < tokens.length; index += 1) {
    const token = tokens[index]!
    if (takesValue.has(token)) {
      index += 1
      continue
    }
    if (token.startsWith('-')) continue
    subcommand = token
    break
  }
  if (subcommand !== 'install' && subcommand !== 'i') return false
  // A GLOBAL pnpm install (`pnpm add -g`) does not populate the workspace store
  // in the way the cache needs; it is also not how this repository installs.
  return !tokens.some((token) => token === '-g' || token === '--global' || token.startsWith('--global='))
}

/** Whether one job's steps populate the pnpm store (a workspace `pnpm install`). */
function installsWorkspace(job: Job): boolean {
  return job.steps.some((step) => commandsOf(step.run ?? '').some((tokens) => isWorkspacePnpmInstall(tokens)))
}

/** Whether one job's `setup-node` step enables the pnpm store cache. */
function cachesPnpm(job: Job): boolean {
  return job.steps.some((step) => {
    if (step.uses === undefined || !step.uses.startsWith('actions/setup-node')) return false
    return step.with?.['cache'] === 'pnpm'
  })
}

describe('CI workflow pnpm cache pairing', () => {
  it('never enables the pnpm cache in a job that does not install the workspace', () => {
    // The exact regression. `setup-node`'s pnpm cache is a POST-step restore/save
    // against `pnpm store path`; without an install the store directory does not
    // exist and the SAVE half fails the job — after every real step succeeded.
    const offenders = Object.entries(load().jobs)
      .filter(([, job]) => cachesPnpm(job) && !installsWorkspace(job))
      .map(([name]) => name)
    expect(offenders, 'these jobs cache the pnpm store they never populate').toEqual([])
  })

  it('keeps the cache on the jobs that DO install, so this does not become a blanket ban', () => {
    // The positive control: the rule above must not be satisfiable by deleting
    // every cache. The main test job installs the workspace, so it keeps one.
    const jobs = load().jobs
    const test = jobs['test']
    expect(test, 'the test job must exist').toBeDefined()
    expect(installsWorkspace(test!), 'the test job must install the workspace').toBe(true)
    expect(cachesPnpm(test!), 'the test job should keep its pnpm cache').toBe(true)
  })

  it('keeps `fish-packed-offline` free of a pnpm cache and of a workspace install', () => {
    // Both halves are deliberate. The lane packs in a temp tree with its own
    // `--store-dir` and loads the runtime from the GLOBAL `dsh` installation, so
    // it neither needs the checkout's `node_modules` nor produces a cacheable
    // store. Adding an install here purely to justify a cache would make the job
    // slower than the work it gates.
    const job = load().jobs['fish-packed-offline']
    expect(job, 'the fish-packed-offline job must exist').toBeDefined()
    expect(cachesPnpm(job!), 'fish-packed-offline must not cache the pnpm store').toBe(false)
    expect(installsWorkspace(job!), 'fish-packed-offline must not install the workspace').toBe(false)
    // …and it must still do its actual work.
    expect(job!.steps.some((step) => /fish-packed-offline\.mjs/u.test(step.run ?? ''))).toBe(true)
  })

  it('detects the failure mode itself, so the helper cannot silently pass', () => {
    // Guards the guard: a job shaped like the broken one must be reported as an
    // offender by the very helpers the assertions above use.
    const broken: Job = {
      steps: [
        { uses: 'actions/setup-node@v4', with: { 'node-version': 22, cache: 'pnpm' } },
        { name: 'Install pnpm', uses: 'pnpm/action-setup@v4' },
      ],
    }
    expect(cachesPnpm(broken)).toBe(true)
    expect(installsWorkspace(broken)).toBe(false)
    // `pnpm/action-setup` installs the CLI, not dependencies.
    expect(installsWorkspace({ steps: [{ uses: 'pnpm/action-setup@v4', with: { version: '9.3.0' } }] })).toBe(false)
  })

  /* ------------------------------ which install actually fills the store --- */

  it.each([
    ['a frozen workspace install', 'pnpm install --frozen-lockfile'],
    ['the `i` alias', 'pnpm i --frozen-lockfile'],
    ['a filtered install', 'pnpm --filter @banbolee/dsh-rtk install'],
    ['a multi-line script', 'echo preparing\npnpm install --frozen-lockfile\npnpm test'],
    ['an install after `&&`', 'echo preparing && pnpm install --frozen-lockfile'],
    ['a `sudo`-prefixed install', 'sudo pnpm install --frozen-lockfile'],
  ])('counts %s as populating the pnpm store', (_label, run) => {
    expect(installsWorkspace({ steps: [{ run }] })).toBe(true)
  })

  it.each([
    // These populate `node_modules` through NPM's cache; `pnpm store path` stays
    // empty, so a job with only these still fails the setup-node POST step.
    ['npm ci', 'npm ci --include=dev'],
    ['a local npm install', 'npm install --no-audit --no-fund'],
    ['a global npm install (the dsh CLI)', 'npm install -g @deepseek-ai/dsh@0.2.2-rc.1'],
    ['a global npm install with --global', 'npm install --global npm@11.21.0'],
    // A global PNPM install does not fill the workspace store either.
    ['a global pnpm install', 'pnpm add -g @deepseek-ai/dsh@0.2.2-rc.1'],
    ['a pnpm test run', 'pnpm test'],
    ['a pnpm pack', 'pnpm pack --config.node-linker=hoisted'],
  ])('does NOT count %s as populating the pnpm store', (_label, run) => {
    // This is the risk the review named: treating `npm ci` as equivalent would
    // let this suite pass over the exact job shape that fails in CI.
    expect(installsWorkspace({ steps: [{ run }] })).toBe(false)
  })

  it('counts a step that installs the workspace AND a global CLI', () => {
    // The mixed positive case: one step, two commands. The global install must not
    // disqualify the step, because the workspace install does populate the store.
    const run = 'pnpm install --frozen-lockfile\nnpm install -g @deepseek-ai/dsh@0.2.2-rc.1'
    expect(installsWorkspace({ steps: [{ run }] })).toBe(true)
    // …and the same pair on ONE line separated by `&&`.
    expect(installsWorkspace({ steps: [{ run: 'pnpm install && npm install -g @deepseek-ai/dsh@0.2.2-rc.1' }] })).toBe(true)
    // Order must not matter either.
    expect(installsWorkspace({ steps: [{ run: 'npm install -g @deepseek-ai/dsh@0.2.2-rc.1 && pnpm install' }] })).toBe(true)
  })

  it('does not count a comment that mentions an install', () => {
    // A step whose comment says "pnpm install" but whose command is something else
    // must not satisfy the rule.
    expect(installsWorkspace({ steps: [{ run: '# pnpm install --frozen-lockfile\nnode scripts/qa/x.mjs' }] })).toBe(false)
  })
})

/* ------------------------------------------- the harness this lane provisions --- */

/** Index of the first step whose `run:` matches `pattern`, or -1. */
function stepIndex(steps: readonly Step[], pattern: RegExp): number {
  return steps.findIndex((step) => pattern.test(step.run ?? ''))
}

/**
 * The pins the CI runner provisions are a CORRECTNESS input, not a preference.
 *
 * The gates and the composition lane resolve the real packages beside the global
 * `dsh`, so the versions installed here decide whether those probes run against
 * the family the manifests declare — a stale pin silently verifies the wrong
 * harness. `tests/release-workflow.spec.ts` asserts the same pair (and its step
 * order) for the release lane; this is the push/PR counterpart.
 */
describe('CI provisions the pinned DSH CLI and TUI', () => {
  const DSH_INSTALL = /@deepseek-ai\/dsh@/u
  const TUI_INSTALL = /@deepseek-harness-tui\/dsh-tui@/u
  const DSH_PIN = '@deepseek-ai/dsh@0.2.2-rc.1'
  const TUI_PIN = '@deepseek-harness-tui/dsh-tui@0.19.0'
  const STALE_DSH_PIN = '@deepseek-ai/dsh@0.2.1-rc.5'
  const STALE_TUI_PIN = '@deepseek-harness-tui/dsh-tui@0.18.0'

  const jobsProvisioning = (pattern: RegExp) =>
    Object.entries(load().jobs).filter(([, job]) => stepIndex(job.steps, pattern) > -1)

  it('installs the exact DSH pin, and never the previous one', () => {
    const provisioning = jobsProvisioning(DSH_INSTALL)
    expect(provisioning.length, 'some job must provision the DSH CLI').toBeGreaterThan(0)
    for (const [name, job] of provisioning) {
      const text = job.steps.map((step) => step.run ?? '').join('\n')
      // Exact string, not a range: `^0.2.2-rc.1` would let the runner drift to a
      // newer rc.x and quietly change the harness every gate is measured against.
      expect(text, `${name} must install ${DSH_PIN}`).toContain(DSH_PIN)
      expect(text, `${name} must not install ${STALE_DSH_PIN}`).not.toContain(STALE_DSH_PIN)
    }
  })

  it('installs the exact TUI pin beside it, and never the previous one', () => {
    const provisioning = jobsProvisioning(TUI_INSTALL)
    expect(provisioning.length, 'some job must provision the dsh-tui probes').toBeGreaterThan(0)
    for (const [name, job] of provisioning) {
      const text = job.steps.map((step) => step.run ?? '').join('\n')
      expect(text, `${name} must install ${TUI_PIN}`).toContain(TUI_PIN)
      expect(text, `${name} must not install ${STALE_TUI_PIN}`).not.toContain(STALE_TUI_PIN)
    }
  })

  it('installs the DSH CLI BEFORE the TUI in every job that provisions the TUI', () => {
    // The TUI declares a peer on `@deepseek-ai/dsh`, so installing it first would
    // resolve against whatever the runner happened to have. Asserted on STEP
    // ORDER, not on the text: two adjacent `run` strings can appear in any order
    // in a passing `includes` check.
    const jobs = Object.entries(load().jobs).filter(([, job]) => stepIndex(job.steps, TUI_INSTALL) > -1)
    expect(jobs.length, 'some job must provision the dsh-tui probes').toBeGreaterThan(0)
    for (const [name, job] of jobs) {
      const dsh = stepIndex(job.steps, DSH_INSTALL)
      const tui = stepIndex(job.steps, TUI_INSTALL)
      expect(dsh, `${name} provisions the TUI, so it must install the DSH CLI too`).toBeGreaterThan(-1)
      expect(dsh, `${name}: the DSH CLI install step must precede the TUI install step`).toBeLessThan(tui)
    }
  })
})

describe('CI excludes deprecated release surfaces', () => {
  it('does not dispatch or provision the frozen CodeGraph headless lane', () => {
    expect(load().jobs).not.toHaveProperty('real-e2e')
    const runs = Object.values(load().jobs).flatMap((job) => job.steps.map((step) => step.run ?? '')).join('\n')
    expect(runs).not.toContain('test:e2e:headless')
    expect(runs).not.toContain('codegraph')
  })

  it('keeps frozen plugin typechecks and the legacy E2E command out of root scripts', () => {
    const manifest = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8'))
    expect(manifest.scripts).not.toHaveProperty('test:e2e:headless')
    expect(manifest.scripts.typecheck).not.toContain('plugins/codegraph-mcp')
    expect(manifest.scripts.typecheck).not.toContain('plugins/dsh-llm-pi-ai-with-session')
    for (const directory of ['agents', 'fish-shell', 'dsh-lsp-diagnostics', 'rtk']) {
      expect(manifest.scripts.typecheck).toContain(`plugins/${directory}/tsconfig.json`)
    }
  })
})

/**
 * Release workflow contract — `.github/workflows/release.yml`.
 *
 * The release lane is the one operation in this repository that cannot be undone
 * (a published npm version is immutable), so its SHAPE is a contract, not a
 * style choice. These assertions lock the properties a later edit could quietly
 * remove:
 *
 *   - the dispatch inputs exist and `dry_run` defaults to TRUE;
 *   - the run is bound to an exact commit and to `main`;
 *   - permissions carry `contents: write` (tags + GitHub Releases) and
 *     `id-token: write` (npm provenance);
 *   - every deterministic gate runs BEFORE the first pack, and the gates include
 *     the packed-artifact lane (the only thing that inspects a tarball);
 *   - the journal is uploaded with `if: always()`, so a partial failure leaves
 *     evidence;
 *   - a real publish happens only under `dry_run: false`, serially, under a
 *     candidate dist-tag, with provenance and public access.
 *
 * The YAML is parsed rather than grepped wherever possible: a regex over the raw
 * file cannot tell a step from a comment, and this repository has already been
 * bitten by comments that described behaviour the code no longer had.
 */

import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { parse } from 'yaml'

import { MIN_NPM_VERSION, checkNpmVersion, compareVersions } from '../scripts/release/lib/npm-capability.mjs'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const workflowPath = join(repoRoot, '.github', 'workflows', 'release.yml')
const releaseScriptPath = join(repoRoot, 'scripts', 'release', 'release.mjs')

interface WorkflowStep {
  readonly name?: string
  readonly if?: string
  readonly run?: string
  readonly uses?: string
  readonly env?: Readonly<Record<string, string>>
  readonly with?: Readonly<Record<string, unknown>>
  readonly 'continue-on-error'?: boolean
}

interface Workflow {
  readonly name?: string
  readonly on?: unknown
  readonly permissions?: Readonly<Record<string, string>>
  readonly env?: Readonly<Record<string, string>>
  readonly jobs: Readonly<Record<string, { readonly steps: readonly WorkflowStep[] }>>
}

/** The YAML 1.1 `on:` key parses as the boolean `true`; accept both spellings. */
function triggers(workflow: Workflow): Record<string, unknown> {
  const raw = workflow as unknown as Record<string, unknown>
  const value = raw['on'] ?? raw[true as unknown as string]
  if (value === null || typeof value !== 'object') throw new TypeError('release.yml declares no triggers')
  return value as Record<string, unknown>
}

function load(): Workflow {
  return parse(readFileSync(workflowPath, 'utf8')) as Workflow
}

/** The single job this workflow runs. */
function job(workflow: Workflow): { readonly steps: readonly WorkflowStep[] } {
  const jobs = Object.values(workflow.jobs)
  expect(jobs).toHaveLength(1)
  return jobs[0]!
}

/** Index of the first step whose name matches `pattern`. */
function stepIndex(steps: readonly WorkflowStep[], pattern: RegExp): number {
  return steps.findIndex((step) => pattern.test(step.name ?? ''))
}

describe('release workflow triggers and inputs', () => {
  it('is manual only, and names the dispatch inputs', () => {
    const trigger = triggers(load())
    expect(Object.keys(trigger)).toEqual(['workflow_dispatch'])
    const dispatch = trigger.workflow_dispatch as { inputs?: Record<string, { default?: unknown, required?: unknown, type?: unknown }> }
    const inputs = dispatch.inputs ?? {}
    // `prior_run_id` is the resume handle: it names the earlier dispatch of THIS
    // release whose journal is downloaded and adopted.
    expect(Object.keys(inputs).sort()).toEqual(['dry_run', 'prior_run_id', 'release_sha'])
    // The safety property: an unset dispatch never publishes.
    expect(inputs.dry_run?.default).toBe(true)
    expect(inputs.dry_run?.type).toBe('boolean')
    // A release names a commit, not a branch: a branch can move between the
    // decision and the checkout.
    expect(inputs.release_sha?.required).toBe(true)
    expect(inputs.release_sha?.type).toBe('string')
    // Resuming is optional, and its absence must be a legal first release.
    expect(inputs.prior_run_id?.required).toBeFalsy()
    expect(inputs.prior_run_id?.default).toBe('')
  })

  it('never runs on push or pull_request', () => {
    const text = readFileSync(workflowPath, 'utf8')
    expect(text).not.toMatch(/^\s*push:/m)
    expect(text).not.toMatch(/^\s*pull_request:/m)
  })
})

describe('release workflow permissions and toolchain', () => {
  it('grants exactly the two scopes the lane needs', () => {
    const permissions = load().permissions ?? {}
    // Tags and GitHub Releases need write; everything else stays read-only.
    expect(permissions.contents).toBe('write')
    // npm provenance is signed with the per-run OIDC token.
    expect(permissions['id-token']).toBe('write')
    expect(Object.keys(permissions).sort()).toEqual(['contents', 'id-token'])
  })

  it('pins the Node, pnpm and npm versions explicitly', () => {
    const env = load().env ?? {}
    expect(env.RELEASE_NODE_VERSION).toBe('22')
    expect(env.RELEASE_PNPM_VERSION).toBe('9.3.0')
    // The npm pin is a CORRECTNESS floor, not a preference: `npm dist-tag add|rm`
    // only speaks tokenless OIDC from 11.21.0 (verified by unpacking the published
    // CLIs — 11.20.0 has no OIDC in lib/commands/dist-tag.js, 11.21.0 does; in
    // 12.x the first is 12.2.0). A publish-only floor (11.5.1) would publish all
    // six versions and then fail at the first dist-tag call.
    expect(env.RELEASE_NPM_VERSION).toBe(MIN_NPM_VERSION)
    expect(checkNpmVersion(env.RELEASE_NPM_VERSION ?? '').ok).toBe(true)
    // …and the floor itself is above the publish-only capability, so the two
    // cannot be confused by a later edit.
    expect(compareVersions(env.RELEASE_NPM_VERSION ?? '0.0.0', '11.5.1')).toBeGreaterThan(0)
    const text = readFileSync(workflowPath, 'utf8')
    expect(text).toContain('pnpm/action-setup@v4')
    expect(text).toContain('actions/setup-node@v4')
    expect(text).toContain('npm install --global')
  })

  it('installs the pinned DSH, TUI and fish BEFORE any gate that needs them', () => {
    const env = load().env ?? {}
    // The gates boot real isolated profiles through the global `dsh` and resolve
    // `dsh-tui` beside it; without both, Gate B/F and the dsh-tui composition lane
    // SKIP, so a release runner would silently skip the checks that inspect a
    // packed tarball.
    expect(env.RELEASE_DSH_VERSION).toBe('0.2.1-rc.2')
    expect(env.RELEASE_DSH_TUI_VERSION).toBe('0.16.1')
    const steps = job(load()).steps
    const dsh = stepIndex(steps, /Install the pinned DSH CLI/)
    const tui = stepIndex(steps, /Install the pinned DSH TUI/)
    const fish = stepIndex(steps, /^Install fish$/)
    const gates = stepIndex(steps, /agents platform gates/)
    expect(dsh, 'the DSH CLI install step must exist').toBeGreaterThan(-1)
    expect(tui, 'the DSH TUI install step must exist').toBeGreaterThan(-1)
    expect(fish, 'the fish install step must exist').toBeGreaterThan(-1)
    expect(gates, 'the gates step must exist').toBeGreaterThan(-1)
    // Order is load-bearing: dsh first (the TUI declares a peer on it), and both
    // plus fish before the gates that spawn them.
    expect(dsh).toBeLessThan(tui)
    expect(tui).toBeLessThan(gates)
    expect(fish).toBeLessThan(gates)
    // The versions come from the env block, never from a literal in the step, so
    // the pin has exactly one home.
    for (const index of [dsh, tui]) {
      expect(steps[index]?.run).toContain('${RELEASE_DSH')
    }
  })

  it('serialises releases and never cancels one in progress', () => {
    // Two overlapping dispatches would interleave publish and promote against ONE
    // shared candidate dist-tag, so the tag could end up describing a mixture of
    // two releases. Cancelling mid-publish would abandon a run after some versions
    // reached the registry — the partial state the journal exists to recover from.
    const workflow = load() as Workflow & { readonly concurrency?: { readonly group?: string, readonly 'cancel-in-progress'?: boolean } }
    expect(workflow.concurrency?.group).toContain('release')
    expect(workflow.concurrency?.['cancel-in-progress']).toBe(false)
  })

  it('gives git an identity and push credentials before anything is published', () => {    const steps = job(load()).steps
    const identity = stepIndex(steps, /Configure the release git identity/)
    const publish = stepIndex(steps, /^Publish all six/)
    expect(identity, 'the git identity step must exist').toBeGreaterThan(-1)
    // Annotated tags are created AFTER publishing, so a missing identity must be
    // discovered before it.
    expect(identity).toBeLessThan(publish)
    const text = steps[identity]?.run ?? ''
    expect(text).toContain('git config user.name')
    expect(text).toContain('git config user.email')
    // Credentials ride on the remote URL, and the log prints the redacted form.
    expect(text).toContain('git remote set-url origin')
    expect(text).toContain("sed -E 's#(https://)[^@/]*@#\\1***@#'")
  })

  it('fails closed when a named prior run cannot be read', () => {
    // A supplied `prior_run_id` is an explicit statement that this dispatch
    // CONTINUES that run. If the artifact cannot be downloaded or located, the
    // run must abort: "I could not read what already happened" is not "nothing
    // happened", and a fresh journal would either try to re-publish (impossible)
    // or report the release clean while six versions sit on the registry.
    const steps = job(load()).steps
    const download = steps.find((step) => /Download the prior release journal/.test(step.name ?? ''))
    const locate = steps.find((step) => /Locate the prior journal/.test(step.name ?? ''))
    expect(download, 'the download step must exist').toBeDefined()
    expect(locate, 'the locate step must exist').toBeDefined()
    // The silent-swallow switch must be gone.
    expect(download?.['continue-on-error']).toBeUndefined()
    // Both steps are gated on the id, so an ABSENT id is a fresh start and a
    // PRESENT id always runs them.
    expect(download?.if).toContain("inputs.prior_run_id != ''")
    expect(locate?.if).toContain("inputs.prior_run_id != ''")
    // …and a missing journal is an error, not a silent fallthrough.
    const body = locate?.run ?? ''
    expect(body).toContain('::error::')
    expect(body).toContain('exit 1')
    expect(body).not.toContain('RELEASE_PRIOR_JOURNAL=""')
  })

  it('passes --prior-journal only on resume, and survives `set -u` on a fresh dispatch', () => {
    // EXECUTED, not just inspected. The previous shape expanded
    // `"${RELEASE_PRIOR_JOURNAL}"` unconditionally, so a fresh dispatch (where the
    // variable is never set) aborted the step with "unbound variable" before node
    // ran. YAML shape assertions cannot catch that — only running bash can.
    //
    // The extracted `prior_args` block is executed under `set -euo pipefail` with
    // the real input shapes, and the resulting argv is recorded.
    const steps = job(load()).steps
    const preflight = steps.find((step) => /^Preflight the dispatch/.test(step.name ?? ''))
    const body = preflight?.run ?? ''
    const block = /prior_args=\(\)[\s\S]*?\n\s*fi/.exec(body)?.[0]
    expect(block, 'the preflight step must build the prior-journal argv conditionally').toBeDefined()

    const argvFor = (priorJournal: string | undefined): string[] => {
      // `node` is replaced by a printf stub so the test observes the ARGV instead
      // of invoking the release script.
      const script = [
        'set -euo pipefail',
        ...(priorJournal === undefined ? [] : [`RELEASE_PRIOR_JOURNAL=${JSON.stringify(priorJournal)}`]),
        block,
        'printf "%s\\n" preflight "${prior_args[@]}" --journal journal.json',
      ].join('\n')
      const result = spawnSync('bash', ['-c', script], { encoding: 'utf8' })
      expect(result.status, `bash exited ${String(result.status)}: ${result.stderr}`).toBe(0)
      return (result.stdout as string).split('\n').filter((line: string) => line !== '')
    }

    // FRESH dispatch: the variable is UNDEFINED. `set -u` must not abort, and no
    // `--prior-journal` may reach the script.
    expect(argvFor(undefined)).toEqual(['preflight', '--journal', 'journal.json'])
    // An explicitly empty value behaves the same (that is what the job env default
    // produces when the locate step never ran).
    expect(argvFor('')).toEqual(['preflight', '--journal', 'journal.json'])
    // RESUME: the flag and its value are passed exactly once.
    expect(argvFor('prior-release/release-journal.json')).toEqual([
      'preflight', '--prior-journal', 'prior-release/release-journal.json', '--journal', 'journal.json',
    ])
  })
})

describe('release workflow ordering', () => {
  it('checks out the exact release SHA with full history and tags', () => {
    const steps = job(load()).steps
    const checkout = steps.find((step) => step.uses?.startsWith('actions/checkout@'))
    expect(checkout).toBeDefined()
    const withInputs = checkout?.with ?? {}
    expect(withInputs.ref).toBe('${{ inputs.release_sha }}')
    expect(withInputs['fetch-depth']).toBe(0)
    expect(withInputs['fetch-tags']).toBe(true)
  })

  it('runs every deterministic gate before the first pack', () => {
    const steps = job(load()).steps
    const pack = stepIndex(steps, /^Pack and validate/)
    expect(pack).toBeGreaterThan(0)
    for (const gate of [/test suite/i, /Typecheck/i, /Build the agents/i, /agents platform gates/i]) {
      const index = stepIndex(steps, gate)
      expect(index, `${gate} must exist`).toBeGreaterThan(-1)
      expect(index, `${gate} must run before packing`).toBeLessThan(pack)
    }
    // The packed-artifact lane is the only check that inspects a real tarball, so
    // a release must include it.
    expect(steps.some((step) => step.run?.includes('test:agents:gates'))).toBe(true)
  })

  it('packs once, validates, and only then publishes', () => {
    const steps = job(load()).steps
    const preflight = stepIndex(steps, /^Preflight/)
    const pack = stepIndex(steps, /^Pack and validate/)
    const publish = stepIndex(steps, /^Publish all six/)
    const promote = stepIndex(steps, /^Promote latest/)
    expect(preflight).toBeGreaterThan(-1)
    expect(preflight).toBeLessThan(pack)
    expect(pack).toBeLessThan(publish)
    expect(publish).toBeLessThan(promote)
  })

  it('publishes only under an explicit dry_run: false, and promotes after publishing', () => {
    const steps = job(load()).steps
    const publish = steps.find((step) => /^Publish all six/.test(step.name ?? ''))
    const promote = steps.find((step) => /^Promote latest/.test(step.name ?? ''))
    expect(publish?.if).toContain('!inputs.dry_run')
    expect(promote?.if).toContain('!inputs.dry_run')
    // Promotion must never be reachable before the publish step in the file.
    expect(stepIndex(steps, /^Publish all six/)).toBeLessThan(stepIndex(steps, /^Promote latest/))
  })
})

describe('release workflow evidence', () => {
  it('uploads the journal and tarballs unconditionally, and again at the end', () => {
    const steps = job(load()).steps
    const uploads = steps.filter((step) => step.uses?.startsWith('actions/upload-artifact@'))
    expect(uploads.length).toBeGreaterThanOrEqual(2)
    for (const upload of uploads) {
      // `if: always()` is what makes a run that died mid-publish diagnosable.
      expect(upload.if).toBe('always()')
    }
    // The journal path is an `env:` reference, so the assertion resolves it
    // through the workflow's own env block instead of assuming a literal path.
    const journalEnv = load().env?.RELEASE_JOURNAL ?? ''
    expect(journalEnv).toContain('release-journal')
    expect(uploads.some((upload) => String(upload.with?.path ?? '') === '${{ env.RELEASE_JOURNAL }}')).toBe(true)
  })

  it('creates six annotated tags and six GitHub Releases at the same commit', () => {
    const text = readFileSync(workflowPath, 'utf8')
    expect(text).toContain('--no-follow-tags')
    // Releases are created by the script subcommand, which owns the idempotence
    // check (an existing release is verified against this dispatch instead of
    // failing the resumed run). The workflow therefore calls `releases` and does
    // NOT hand-write `gh release create` — one owner for the release identity.
    expect(text).toContain('release.mjs releases')
    // A comment may name the command it replaced; the assertion is about a CALL,
    // so only a line that actually invokes it counts.
    expect(text.split('\n').filter((line) => !line.trimStart().startsWith('#') && line.includes('gh release create'))).toEqual([])
    const source = readFileSync(releaseScriptPath, 'utf8')
    expect(source).toContain("'--target', sha")
    expect(source).toContain("'--title', title")
    // Tag names come from the script, so the pushed tags and the created
    // releases cannot drift from the ones finalize made.
    expect(text).toContain('release-tags.tsv')
    expect(source).toContain('release-tags.tsv')
  })
})

describe('release script surface', () => {
  it('exposes the subcommands the workflow calls', () => {
    const source = readFileSync(releaseScriptPath, 'utf8')
    // The workflow invokes `<script> <subcommand>`; the dispatch table is the
    // single place that decides which subcommands exist.
    const table = /const COMMANDS = \{([^}]+)\}/.exec(source)
    expect(table, 'release.mjs declares no COMMANDS table').not.toBeNull()
    for (const command of ['preflight', 'pack', 'publish', 'finalize', 'releases', 'report']) {
      expect(table![1], `missing subcommand ${command}`).toContain(command)
    }
  })

  it('publishes with provenance and public access under a candidate tag', () => {
    const source = readFileSync(releaseScriptPath, 'utf8')
    expect(source).toContain("'--provenance'")
    expect(source).toContain("'--access', 'public'")
    expect(source).toContain('journal.candidateTag')
    // The integrity check is what proves the registry holds OUR artefact.
    expect(source).toContain('assertRegistryIntegrity')
  })

  it('refuses to re-publish a version whose integrity differs', () => {
    const source = readFileSync(releaseScriptPath, 'utf8')
    expect(source).toContain('classifyPublishedVersion')
    expect(source).toMatch(/immutable/i)
  })
})

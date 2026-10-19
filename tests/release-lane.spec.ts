/**
 * Release lane internals — the parsing and fail-closed checks the workflow's
 * correctness rests on.
 *
 * These are the pieces where a silent bug is worst: a tarball-safety check that
 * passes on empty input, or a `npm pack --json` parser that only understands one
 * of the two shapes npm emits, would let an unsafe artefact reach the registry
 * while every log line looked green. Each test therefore asserts BOTH the accept
 * and the reject direction.
 */

import { describe, expect, it } from 'vitest'

import { parsePackJson } from '../scripts/release/lib/pack-result.mjs'
import {
  assertBuiltEntriesPresent,
  assertBundledDependencyPresent,
  assertManifestMatchesTarball,
  assertRelativeImportsShipped,
  assertSafeMembers,
  parseMemberListing,
} from '../scripts/release/lib/tarball.mjs'
import {
  JOURNAL_VERSION,
  PACKAGE_STATES,
  createJournal,
  isPublished,
  readJournal,
  resumability,
  setPackageState,
  summarise,
  writeJournal,
} from '../scripts/release/lib/journal.mjs'
import { RELEASE_PACKAGES, STAGED_PACKAGES, requireReleasePackage } from '../scripts/release/lib/packages.mjs'
import {
  assertOutsideWorkspace,
  promoteLatest,
  releaseMismatch,
  removeCandidateTag,
  stageBundle,
} from '../scripts/release/release.mjs'
import { MIN_NPM_VERSION, assertNpmCapability, checkNpmVersion, compareVersions } from '../scripts/release/lib/npm-capability.mjs'
import {
  REGISTRY_READBACK_BUDGET_MS,
  absenceNamesSpec,
  absenceSpecifierOf,
  assertRegistryIntegrity,
  classifyNpmFailure,
  normaliseViewAnswer,
  publishedIntegrity,
  registryReadbackDelays,
  requestedResourceSpecifierOf,
  waitForDistTag,
} from '../scripts/release/lib/registry.mjs'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync as readTextFile, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/** The repository root, so the staging guard can be exercised against it. */
const repoRootForTest = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/** A `npm pack --json` document in the npm <= 11 (array) shape. */
function packJsonArray(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify([{
    filename: 'banbolee-dsh-rtk-0.3.2.tgz',
    name: '@banbolee/dsh-rtk',
    version: '0.3.2',
    integrity: 'sha512-abc',
    shasum: 'deadbeef',
    files: [{ path: 'index.js' }, { path: 'package.json' }],
    bundled: [],
    ...overrides,
  }])
}

describe('npm pack --json parsing', () => {
  it('accepts the npm <= 11 array shape', () => {
    const packed = parsePackJson(packJsonArray())
    expect(packed.name).toBe('@banbolee/dsh-rtk')
    expect(packed.version).toBe('0.3.2')
    expect(packed.integrity).toBe('sha512-abc')
    expect(packed.files).toEqual(['package/index.js', 'package/package.json'])
  })

  it('accepts the npm 12 object-keyed shape', () => {
    const entry = JSON.parse(packJsonArray())[0]
    const packed = parsePackJson(JSON.stringify({ [entry.name]: entry }))
    expect(packed.name).toBe('@banbolee/dsh-rtk')
    expect(packed.files).toHaveLength(2)
  })

  it('refuses a document describing more than one package', () => {
    const entry = JSON.parse(packJsonArray())[0]
    expect(() => parsePackJson(JSON.stringify([entry, entry]))).toThrow(/exactly one/)
    expect(() => parsePackJson(JSON.stringify({ a: entry, b: entry }))).toThrow(/exactly one/)
  })

  it('refuses a document missing the fields the lane verifies', () => {
    for (const field of ['filename', 'name', 'version', 'integrity', 'shasum']) {
      const document = JSON.parse(packJsonArray())
      delete document[0][field]
      expect(() => parsePackJson(JSON.stringify(document)), field).toThrow(new RegExp(field))
    }
  })

  it('refuses non-JSON and empty output rather than reading it as "no packages"', () => {
    expect(() => parsePackJson('not json')).toThrow(/did not print JSON/)
    expect(() => parsePackJson('[]')).toThrow(/exactly one/)
  })
})

describe('tarball member safety', () => {
  const safeNames = ['package/index.js', 'package/package.json']

  it('parses hardlinks and symlinks out of the verbose listing', () => {
    const verbose = [
      '-rw-r--r--  0 0 0 10 Jan  1 00:00 package/index.js',
      'hrw-r--r--  0 0 0 10 Jan  1 00:00 package/LICENSE link to package/other/LICENSE',
      'lrwxrwxrwx  0 0 0 10 Jan  1 00:00 package/link -> ../outside',
    ].join('\n')
    const listing = parseMemberListing('package/index.js\npackage/LICENSE\npackage/link', verbose)
    expect(listing.hardlinks).toEqual(['package/LICENSE'])
    expect(listing.symlinks).toEqual([{ path: 'package/link', target: '../outside' }])
  })

  it('accepts a clean tarball', () => {
    const listing = parseMemberListing(safeNames.join('\n'), safeNames.map((name) => `-rw-r--r-- 0 0 0 1 Jan 1 00:00 ${name}`).join('\n'))
    expect(assertSafeMembers(listing)).toEqual(safeNames)
  })

  it('rejects members that escape the package root', () => {
    const names = ['package/index.js', 'package/../../node_modules/.pnpm/x/index.js']
    const listing = parseMemberListing(names.join('\n'), names.map((name) => `-rw-r--r-- 0 0 0 1 Jan 1 00:00 ${name}`).join('\n'))
    expect(() => assertSafeMembers(listing)).toThrow(/escape the package root/)
  })

  it('rejects hardlink members, which npmjs answers with 415', () => {
    const listing = parseMemberListing('package/LICENSE', 'hrw-r--r-- 0 0 0 1 Jan 1 00:00 package/LICENSE link to package/x')
    expect(() => assertSafeMembers(listing)).toThrow(/hardlink/)
  })

  it('rejects a symlink that resolves outside the package', () => {
    const listing = parseMemberListing('package/link', 'lrwxrwxrwx 0 0 0 1 Jan 1 00:00 package/link -> /etc/passwd')
    expect(() => assertSafeMembers(listing)).toThrow(/resolve inside the package root/)
  })
})

describe('packed manifest identity', () => {
  const declared = {
    name: '@banbolee/dsh-rtk',
    version: '0.3.2',
    license: 'MIT',
    publishConfig: { access: 'public', registry: 'https://registry.npmjs.org', provenance: true },
  }

  it('accepts the declared manifest', () => {
    expect(() => assertManifestMatchesTarball(structuredClone(declared), declared)).not.toThrow()
  })

  it('rejects a stale staged tree', () => {
    const stale = { ...structuredClone(declared), version: '0.3.1' }
    expect(() => assertManifestMatchesTarball(stale, declared)).toThrow(/version/)
  })

  it('rejects a tarball that lost its provenance declaration', () => {
    const unsigned = structuredClone(declared)
    delete (unsigned.publishConfig as Record<string, unknown>).provenance
    expect(() => assertManifestMatchesTarball(unsigned, declared)).toThrow(/provenance/)
  })
})

describe('package-specific tarball hazards', () => {
  it('requires fish-shell to carry its bundled terminal tool', () => {
    const without = parseMemberListing('package/index.js', '-rw-r--r-- 0 0 0 1 Jan 1 00:00 package/index.js')
    expect(() => assertBundledDependencyPresent(without, ['@deepseek-ai/dsh-tool-terminal'])).toThrow(/bundled dependencies missing/)
    const with_ = parseMemberListing(
      'package/index.js\npackage/node_modules/@deepseek-ai/dsh-tool-terminal/package.json',
      '-rw-r--r-- 0 0 0 1 Jan 1 00:00 package/index.js\n-rw-r--r-- 0 0 0 1 Jan 1 00:00 package/node_modules/@deepseek-ai/dsh-tool-terminal/package.json',
    )
    expect(() => assertBundledDependencyPresent(with_, ['@deepseek-ai/dsh-tool-terminal'])).not.toThrow()
  })

  it('requires the agents bundle to carry its build output', () => {
    const listing = parseMemberListing('package/index.js', '-rw-r--r-- 0 0 0 1 Jan 1 00:00 package/index.js')
    expect(() => assertBuiltEntriesPresent(listing, ['package/lib/client.js'])).toThrow(/built entries missing/)
  })

  it('requires every relative import of a shipped root module to be shipped', () => {
    const names = ['package/index.js', 'package/schema.js']
    const listing = parseMemberListing(names.join('\n'), names.map((name) => `-rw-r--r-- 0 0 0 1 Jan 1 00:00 ${name}`).join('\n'))
    const sources: Record<string, string> = {
      'index.js': "import { x } from './schema.js'\nimport { y } from './missing.js'\n",
    }
    expect(() => assertRelativeImportsShipped(listing, (relative) => sources[relative] ?? '')).toThrow(/missing\.js/)
  })
})

describe('npm view answer normalisation', () => {
  // Regression lock: `npm view <pkg>@<version> dist.integrity --json` prints a
  // ONE-ELEMENT ARRAY, not a bare string. An earlier version of this module read
  // only the string shape, so every real package looked "absent" — which in a
  // release lane means "publish it again". That must never silently return
  // undefined for a version that exists.
  it('reads the array shape npm actually prints', () => {
    expect(normaliseViewAnswer(['sha512-abc'], 'x')).toBe('sha512-abc')
    expect(normaliseViewAnswer(['0.3.1'], 'x')).toBe('0.3.1')
  })

  it('reads the bare-string shape too', () => {
    expect(normaliseViewAnswer('sha512-abc', 'x')).toBe('sha512-abc')
  })

  it('answers undefined only for a genuinely empty answer', () => {
    expect(normaliseViewAnswer(undefined, 'x')).toBeUndefined()
    expect(normaliseViewAnswer('', 'x')).toBeUndefined()
    expect(normaliseViewAnswer([], 'x')).toBeUndefined()
    expect(normaliseViewAnswer([''], 'x')).toBeUndefined()
  })

  it('refuses an ambiguous answer instead of guessing one', () => {
    expect(() => normaliseViewAnswer(['a', 'b'], 'x')).toThrow(/needs exactly one/)
    expect(() => normaliseViewAnswer({ a: 1 }, 'x')).toThrow(/expected a string/)
  })
})

describe('post-publish registry readback (how long a publish may take to become readable)', () => {
  const READBACK = { package: '@banbolee/dsh-fish-shell', version: '0.8.2', integrity: 'sha512-packed' }

  /**
   * A virtual clock shared by `now`, `sleep` AND the read, so the test measures
   * what the PRODUCTION loop measures.
   *
   * That sharing is the point of this helper. The previous version counted only
   * the sleeps, which is exactly the bug a reviewer found: the real loop also
   * spends time inside `execFileSync` and `viewField`'s own retries, so a budget
   * that only counts sleeps is not a wall-clock budget at all. Here every poll
   * costs `readCostMs` on the same clock, so "the loop respected the budget" means
   * "the total wall clock, reads included, respected it".
   */
  function virtualClock(options: { readCostMs?: number } = {}) {
    const readCostMs = options.readCostMs ?? 0
    let clock = 0
    const sleeps: number[] = []
    return {
      now: () => clock,
      sleep: (ms: number) => {
        sleeps.push(ms)
        clock += ms
      },
      /** Charge one poll's subprocess cost to the same clock. */
      chargeRead: () => { clock += readCostMs },
      elapsed: () => clock,
      sleeps,
    }
  }

  it('waits past the old ~27s budget when the registry has not propagated yet', () => {
    // THE run 39244336827 REGRESSION. `npm publish` exited 0 and the version took
    // about 2m44s to become readable. The previous 10x3s budget gave up long
    // before that and reported a successful publish as a missing version.
    //
    // The reader withholds the version until MORE THAN 30s of virtual time have
    // passed, so a passing assertion cannot come from the old budget.
    const clock = virtualClock()
    let polls = 0
    const result = assertRegistryIntegrity({
      ...READBACK,
      now: clock.now,
      sleep: clock.sleep,
      readIntegrity: () => {
        polls += 1
        return clock.elapsed() > 30_000 ? READBACK.integrity : undefined
      },
    })
    expect(result).toBe(READBACK.integrity)
    expect(clock.elapsed()).toBeGreaterThan(30_000)
    // …and it did not burn the whole budget to get there: it stopped as soon as the
    // version appeared.
    expect(clock.elapsed()).toBeLessThan(REGISTRY_READBACK_BUDGET_MS)
    expect(polls).toBeGreaterThan(2)
  })

  it('counts the cost of READING against the budget, not just the sleeps', () => {
    // The defect this covers: summing sleeps only. Each poll here costs 5s of
    // subprocess time, so a sleep-only accounting would claim 360s while the real
    // wall clock was far larger. The loop must stop when the CLOCK reaches the
    // budget.
    const clock = virtualClock({ readCostMs: 5000 })
    let polls = 0
    expect(() => assertRegistryIntegrity({
      ...READBACK,
      now: clock.now,
      sleep: clock.sleep,
      readIntegrity: () => {
        polls += 1
        clock.chargeRead()
        return undefined
      },
    })).toThrow(/the registry does not report/u)
    // The whole run — reads included — never exceeded the budget.
    expect(clock.elapsed()).toBeLessThanOrEqual(REGISTRY_READBACK_BUDGET_MS)
    // …but it did get close, rather than giving up early.
    expect(clock.elapsed()).toBeGreaterThan(REGISTRY_READBACK_BUDGET_MS - 60_000)
    // With reads eating the clock there are FEWER polls than a sleep-only budget
    // would allow — proof the read time was actually charged.
    expect(polls).toBeLessThan(11)
  })

  it('gives up only when the whole budget is spent, and says so', () => {
    const clock = virtualClock()
    expect(() => assertRegistryIntegrity({
      ...READBACK,
      now: clock.now,
      sleep: clock.sleep,
      readIntegrity: () => undefined,
    })).toThrow(/the registry does not report .* after publish/u)
    // The failure must come AFTER the budget, not before it: this is the property
    // that was wrong (it stopped at ~27s), and it must not overshoot either.
    expect(clock.elapsed()).toBe(REGISTRY_READBACK_BUDGET_MS)
  })

  it('clamps the final sleep so it cannot overshoot the deadline', () => {
    // A single huge backoff near the end must be clipped to what is left.
    const clock = virtualClock()
    expect(() => assertRegistryIntegrity({
      ...READBACK,
      now: clock.now,
      sleep: clock.sleep,
      budgetMs: 10_000,
      initialDelayMs: 9000,
      maxDelayMs: 9000,
      readIntegrity: () => undefined,
    })).toThrow(/the registry does not report/u)
    expect(clock.elapsed()).toBeLessThanOrEqual(10_000)
    // Every recorded sleep fits inside the remaining budget.
    expect(clock.sleeps.reduce((sum, delay) => sum + delay, 0)).toBeLessThanOrEqual(10_000)
  })

  it('still fails immediately on an integrity mismatch', () => {
    // A readable-but-different artefact is a real mismatch, not a propagation
    // delay. Waiting cannot change it, so it must abort on the FIRST poll.
    const clock = virtualClock()
    let polls = 0
    expect(() => assertRegistryIntegrity({
      ...READBACK,
      now: clock.now,
      sleep: clock.sleep,
      readIntegrity: () => {
        polls += 1
        return 'sha512-DIFFERENT'
      },
    })).toThrow(/registry integrity mismatch/u)
    expect(polls).toBe(1)
    expect(clock.elapsed()).toBe(0)
    expect(clock.sleeps).toEqual([])
  })

  it.each(['auth', 'fatal'] as const)('does not retry a %s read refusal', (classification) => {
    // Raising the budget must not turn a refused or fatal read into a six-minute
    // wait that hides the real cause.
    const clock = virtualClock()
    let polls = 0
    const failure = Object.assign(new Error(`${classification} refusal`), { classification })
    expect(() => assertRegistryIntegrity({
      ...READBACK,
      now: clock.now,
      sleep: clock.sleep,
      readIntegrity: () => {
        polls += 1
        throw failure
      },
    })).toThrow(new RegExp(`${classification} refusal`, 'u'))
    expect(polls).toBe(1)
    expect(clock.sleeps).toEqual([])
  })

  it.each([
    ['an unclassified error', Object.assign(new Error('boom — a bug in this module'), {})],
    ['a programming error', new TypeError('cannot read properties of undefined')],
  ])('does not retry %s', (_label, failure) => {
    // An UNCLASSIFIED failure is not a propagation delay. Retrying it is how a
    // real defect gets laundered into "the registry was slow" — and with a
    // six-minute budget that laundering costs six minutes of CI.
    const clock = virtualClock()
    let polls = 0
    expect(() => assertRegistryIntegrity({
      ...READBACK,
      now: clock.now,
      sleep: clock.sleep,
      readIntegrity: () => {
        polls += 1
        throw failure
      },
    })).toThrow(/boom|cannot read properties/u)
    expect(polls).toBe(1)
    expect(clock.sleeps).toEqual([])
  })

  it('does retry a transient read failure, and succeeds once it clears', () => {
    const clock = virtualClock()
    let polls = 0
    const transient = Object.assign(new Error('429 Too Many Requests'), { classification: 'transient' })
    const result = assertRegistryIntegrity({
      ...READBACK,
      now: clock.now,
      sleep: clock.sleep,
      readIntegrity: () => {
        polls += 1
        if (polls < 3) throw transient
        return READBACK.integrity
      },
    })
    expect(result).toBe(READBACK.integrity)
    expect(polls).toBe(3)
    expect(clock.elapsed()).toBeGreaterThan(0)
  })

  /* ------------- the real chain: publishedIntegrity -> viewField -> normalise --- */

  it('fails fast when the live read chain returns a MULTI-VALUE answer', () => {
    // Not a hand-made label: this drives the production reader, whose
    // `normaliseViewAnswer` throws on a multi-value answer. The readback must
    // surface that immediately instead of retrying it for six minutes.
    //
    // `viewField` is stubbed at its own boundary by pointing the PATH-resolved
    // `npm` at a script that prints an array — but that would need a real child
    // process, so the equivalent shape error is injected at the reader seam WITH
    // the real `normaliseViewAnswer` doing the throwing.
    const clock = virtualClock()
    let polls = 0
    expect(() => assertRegistryIntegrity({
      ...READBACK,
      now: clock.now,
      sleep: clock.sleep,
      readIntegrity: (packageName: string, version: string) => {
        polls += 1
        // Exactly what `publishedIntegrity` does with npm's answer.
        return normaliseViewAnswer(['sha512-a', 'sha512-b'], `${packageName}@${version} dist.integrity`)
      },
    })).toThrow(/returned 2 values for/u)
    expect(polls).toBe(1)
    expect(clock.sleeps).toEqual([])
  })

  it('fails fast when the live read chain returns an OBJECT answer', () => {
    const clock = virtualClock()
    let polls = 0
    expect(() => assertRegistryIntegrity({
      ...READBACK,
      now: clock.now,
      sleep: clock.sleep,
      readIntegrity: (packageName: string, version: string) => {
        polls += 1
        return normaliseViewAnswer({ unexpected: true }, `${packageName}@${version} dist.integrity`)
      },
    })).toThrow(/expected a string/u)
    expect(polls).toBe(1)
    expect(clock.sleeps).toEqual([])
  })

  it('still treats a REAL absent-version failure as absence, not a timeout', () => {
    // A trap found by exercising the real chain: `execFileSync` sets `signal` to
    // `null` (not `undefined`) for a child that exited normally. A truthiness test
    // on that property classifies EVERY npm failure — including the ordinary
    // "this version is not published" 404 — as a killed child, which turns the
    // most common correct answer into a transient error and blocks the release.
    const spec = '@banbolee/dsh-fish-shell@0.0.0-does-not-exist'
    const stderr = [
      'npm error code E404',
      'npm error 404 No match found for version 0.0.0-does-not-exist',
      'npm error 404',
      `npm error 404  The requested resource '${spec}' could not be found or you do not have permission to access it.`,
      'npm error 404',
      'npm error 404 tarball, folder, http url, or git url.',
    ].join('\n')
    // The fixture is the real error shape: `signal: null`, `status: 1`.
    const absentError = Object.assign(new Error('Command failed: npm view …'), {
      status: 1,
      signal: null,
      killed: false,
      stderr,
      stdout: '',
    })
    // The predicate the readback relies on must NOT consider this a timeout.
    const looksKilled = (absentError as { code?: string }).code === 'ETIMEDOUT'
      || absentError.killed === true
      || typeof absentError.signal === 'string'
    expect(looksKilled).toBe(false)
    // …and classification of that shape is absence, so the readback sees `undefined`.
    expect(classifyNpmFailure(absentError, { spec })).toBe('absent')
  })

  describe('through the REAL child-process chain (fake npm on PATH)', () => {
    /**
     * These tests do NOT stub `readIntegrity`. They put a fake `npm` executable on
     * `PATH` and call the production entry point, so the whole chain runs for
     * real:
     *
     *     assertRegistryIntegrity -> singleAttemptIntegrity -> publishedIntegrity
     *       -> viewField -> execFileSync -> (fake) npm -> normaliseViewAnswer
     *
     * That matters because the previous rounds' stubs could not see anything about
     * child processes: the `signal: null` trap, the number of invocations per outer
     * attempt, and whether a hung child is actually killed at the deadline are all
     * invisible to a stubbed reader.
     */
    let sandbox: string
    let binDir: string
    let counterFile: string
    let originalPath: string | undefined

    /** The fake CLI. Behaviour is selected by `FAKE_NPM_MODE`. */
    const FAKE_NPM = `#!/usr/bin/env node
'use strict'
const fs = require('node:fs')
const mode = process.env.FAKE_NPM_MODE || 'absent'
const counter = process.env.FAKE_NPM_COUNTER
if (counter) fs.appendFileSync(counter, '.')

const ABSENT = [
  'npm error code E404',
  'npm error 404 No match found for version 0.8.2',
  'npm error 404',
  "npm error 404  The requested resource '@banbolee/dsh-fish-shell@0.8.2' could not be found or you do not have permission to access it.",
  'npm error 404',
].join('\\n')

switch (mode) {
  case 'absent':
    process.stderr.write(ABSENT + '\\n')
    process.exit(1)
    break
  case 'integrity':
    process.stdout.write(JSON.stringify('sha512-packed') + '\\n')
    process.exit(0)
    break
  case 'multi':
    process.stdout.write(JSON.stringify(['sha512-a', 'sha512-b']) + '\\n')
    process.exit(0)
    break
  case 'object':
    process.stdout.write(JSON.stringify({ unexpected: true }) + '\\n')
    process.exit(0)
    break
  case 'selfsigterm':
    // A child killed by a SIGNAL NAME (not by our timeout): \`error.signal\` is the
    // string 'SIGTERM', which must be retried as transient.
    process.kill(process.pid, 'SIGTERM')
    break
  case 'hang':
    // Never answers. The readback must kill this at the deadline.
    setTimeout(() => {}, 600000)
    break
  default:
    process.exit(0)
}
`

    function installFakeNpm(): void {
      sandbox = mkdtempSync(join(tmpdir(), 'banbo-fake-npm-'))
      binDir = join(sandbox, 'bin')
      mkdirSync(binDir, { recursive: true })
      counterFile = join(sandbox, 'invocations')
      writeFileSync(counterFile, '')
      const npmPath = join(binDir, 'npm')
      writeFileSync(npmPath, FAKE_NPM)
      chmodSync(npmPath, 0o755)
      originalPath = process.env.PATH
      process.env.PATH = `${binDir}:${originalPath ?? ''}`
      process.env.FAKE_NPM_COUNTER = counterFile
    }

    function invocations(): number {
      return readTextFile(counterFile, 'utf8').length
    }

    function teardown(): void {
      if (originalPath === undefined) delete process.env.PATH
      else process.env.PATH = originalPath
      delete process.env.FAKE_NPM_MODE
      delete process.env.FAKE_NPM_COUNTER
      rmSync(sandbox, { recursive: true, force: true })
    }

    it('treats a real E404 with signal:null as absence, not a killed child', () => {
      // The regression that a stub could not catch: `execFileSync` sets `signal` to
      // `null` for a normally-exiting child, so a truthiness test makes every
      // ordinary npm failure look killed — turning "this version is not published
      // yet" into a transient error. The crisp assertion is on the PRODUCTION
      // reader: an absent version must come back as `undefined`, not throw.
      installFakeNpm()
      try {
        process.env.FAKE_NPM_MODE = 'absent'
        expect(publishedIntegrity('@banbolee/dsh-fish-shell', '0.8.2')).toBeUndefined()
        expect(invocations()).toBe(1)
      } finally {
        teardown()
      }
    })

    it('polls an absent version repeatedly instead of failing on the first attempt', () => {
      // …and the readback keeps waiting on it, because absence is exactly the
      // condition a just-published version can be in.
      installFakeNpm()
      try {
        process.env.FAKE_NPM_MODE = 'absent'
        const started = performance.now()
        // Either message is fine: with a deliberately tiny budget the last child is
        // killed by the deadline (transient) instead of returning a 404 on time.
        // What matters is that it POLLED rather than aborting immediately.
        expect(() => assertRegistryIntegrity({
          ...READBACK,
          budgetMs: 300,
          initialDelayMs: 20,
          maxDelayMs: 20,
          sleep: () => {},
        })).toThrow(/could not read .* back from the registry|the registry does not report/u)
        expect(invocations()).toBeGreaterThan(1)
        expect(performance.now() - started).toBeLessThan(3000)
      } finally {
        teardown()
      }
    })

    it('retries a child killed by a SIGNAL NAME as transient', () => {
      installFakeNpm()
      try {
        process.env.FAKE_NPM_MODE = 'selfsigterm'
        // The fake dies on EVERY invocation, so the readback keeps retrying until
        // the budget is gone — which proves the signal was classified transient
        // rather than fatal (a fatal would throw on the first attempt).
        expect(() => assertRegistryIntegrity({
          ...READBACK,
          budgetMs: 150,
          initialDelayMs: 50,
          maxDelayMs: 50,
          sleep: () => {},
        })).toThrow(/could not read .* back from the registry/u)
        expect(invocations()).toBeGreaterThan(1)
      } finally {
        teardown()
      }
    })

    it('fails fast on a multi-value answer from the real chain', () => {
      installFakeNpm()
      try {
        process.env.FAKE_NPM_MODE = 'multi'
        const started = performance.now()
        expect(() => assertRegistryIntegrity({
          ...READBACK,
          budgetMs: 60_000,
          sleep: () => {},
        })).toThrow(/returned 2 values for/u)
        // One child, no retry: a shape error is a verdict.
        expect(invocations()).toBe(1)
        expect(performance.now() - started).toBeLessThan(2000)
      } finally {
        teardown()
      }
    })

    it('fails fast on an object answer from the real chain', () => {
      installFakeNpm()
      try {
        process.env.FAKE_NPM_MODE = 'object'
        expect(() => assertRegistryIntegrity({
          ...READBACK,
          budgetMs: 60_000,
          sleep: () => {},
        })).toThrow(/expected a string/u)
        expect(invocations()).toBe(1)
      } finally {
        teardown()
      }
    })

    it('kills a HUNG child at the deadline and keeps the total wall clock within budget', () => {
      // The property the previous implementation could not promise: a child that
      // never answers must not outlive the budget. `execFileSync` gets
      // `timeout: remaining`, so the child is killed and the loop stops.
      installFakeNpm()
      try {
        process.env.FAKE_NPM_MODE = 'hang'
        const budgetMs = 700
        const started = performance.now()
        expect(() => assertRegistryIntegrity({
          ...READBACK,
          budgetMs,
          initialDelayMs: 50,
          maxDelayMs: 50,
          sleep: () => {},
        })).toThrow(/could not read .* back from the registry|does not report/u)
        const elapsed = performance.now() - started
        // Real subprocess spawn + kill overhead is allowed, but only a little.
        expect(elapsed, `elapsed ${elapsed}ms exceeded budget ${budgetMs}ms`).toBeLessThan(budgetMs + 1500)
      } finally {
        teardown()
      }
    })

    it('uses ONE child per outer attempt, so the budget is not spent N times', () => {
      // With the read retrying internally (the old shape), each outer attempt cost
      // three children against a timeout computed once — the wall clock outran the
      // budget while the arithmetic looked right. Count them.
      installFakeNpm()
      try {
        process.env.FAKE_NPM_MODE = 'absent'
        const sleeps: number[] = []
        expect(() => assertRegistryIntegrity({
          ...READBACK,
          budgetMs: 100,
          initialDelayMs: 50,
          maxDelayMs: 50,
          sleep: (ms: number) => { sleeps.push(ms) },
        })).toThrow(/could not read .* back from the registry|the registry does not report/u)
        // One invocation per recorded sleep, plus the final one that hit the
        // deadline (or the one that found the budget exhausted).
        expect(invocations()).toBeLessThanOrEqual(sleeps.length + 1)
      } finally {
        teardown()
      }
    })

    it('reports a broken clock seam instead of pretending the budget ran out', () => {
      // A `sleep` that does not advance the clock must NOT spin forever, and must
      // NOT be reported as "the registry is slow". It is a seam bug.
      installFakeNpm()
      try {
        process.env.FAKE_NPM_MODE = 'absent'
        expect(() => assertRegistryIntegrity({
          ...READBACK,
          budgetMs: 60_000,
          initialDelayMs: 10,
          maxDelayMs: 10,
          sleep: () => {}, // no clock advance
          now: () => 0, // frozen clock
        })).toThrow(/clock is not advancing/u)
        // It bailed out quickly rather than burning six virtual minutes.
        expect(invocations()).toBeLessThan(10)
      } finally {
        teardown()
      }
    })
  })

  /* --------------------------- dist-tag propagation (finalize) --- */

  describe('dist-tag readback after add / rm', () => {
    /**
     * The failure this covers: on run 39249407401 `npm dist-tag add
     * @banbolee/dsh-fish-shell@0.8.2 latest` exited 0, the very next read still
     * answered `0.8.1`, and the lane aborted AFTER the promotion had happened. A
     * single lagging read is propagation, not a verdict.
     */
    const TAG_READBACK = { package: '@banbolee/dsh-fish-shell', distTag: 'next', version: '0.8.2' }

    /** A virtual clock shared by `now`, `sleep` and the read, as above. */
    function clock(readCostMs = 0) {
      let nowMs = 0
      return {
        now: () => nowMs,
        sleep: (ms: number) => { nowMs += ms },
        charge: () => { nowMs += readCostMs },
        elapsed: () => nowMs,
      }
    }

    it('waits for the OLD version to be replaced by the target (add)', () => {
      // The registry keeps serving 0.8.1 for 30 virtual seconds, then flips.
      const c = clock()
      let polls = 0
      const result = waitForDistTag(TAG_READBACK.package, 'latest', TAG_READBACK.version, {
        now: c.now,
        sleep: c.sleep,
        readDistTag: () => {
          polls += 1
          return c.elapsed() > 30_000 ? TAG_READBACK.version : '0.8.1'
        },
      })
      expect(result).toBe(TAG_READBACK.version)
      expect(c.elapsed()).toBeGreaterThan(30_000)
      expect(polls).toBeGreaterThan(2)
    })

    it('does NOT treat a still-present tag as fatal after `dist-tag rm`', () => {
      // Same in reverse: the tag survives several polls, then disappears.
      const c = clock()
      let polls = 0
      const result = waitForDistTag(TAG_READBACK.package, 'next', undefined, {
        now: c.now,
        sleep: c.sleep,
        readDistTag: () => {
          polls += 1
          return c.elapsed() > 20_000 ? undefined : '0.8.2'
        },
      })
      expect(result).toBeUndefined()
      expect(polls).toBeGreaterThan(2)
    })

    it('returns immediately when the tag is ALREADY at the target', () => {
      const c = clock()
      let polls = 0
      expect(waitForDistTag(TAG_READBACK.package, 'latest', '0.8.2', {
        now: c.now,
        sleep: c.sleep,
        readDistTag: () => { polls += 1; return '0.8.2' },
      })).toBe('0.8.2')
      expect(polls).toBe(1)
      expect(c.elapsed()).toBe(0)
    })

    it('returns immediately when the tag is ALREADY gone', () => {
      const c = clock()
      let polls = 0
      expect(waitForDistTag(TAG_READBACK.package, 'next', undefined, {
        now: c.now,
        sleep: c.sleep,
        readDistTag: () => { polls += 1; return undefined },
      })).toBeUndefined()
      expect(polls).toBe(1)
    })

    it('fails closed when the tag never reaches the target inside the budget', () => {
      const c = clock()
      expect(() => waitForDistTag(TAG_READBACK.package, 'latest', '0.8.2', {
        now: c.now,
        sleep: c.sleep,
        readDistTag: () => '0.8.1',
      })).toThrow(/the registry does not report .* dist-tag "latest" as 0\.8\.2 after npm dist-tag add\/rm/u)
      expect(c.elapsed()).toBe(REGISTRY_READBACK_BUDGET_MS)
    })

    it('fails closed when the tag never disappears inside the budget', () => {
      const c = clock()
      expect(() => waitForDistTag(TAG_READBACK.package, 'next', undefined, {
        now: c.now,
        sleep: c.sleep,
        readDistTag: () => '0.8.2',
      })).toThrow(/as absent after npm dist-tag add\/rm/u)
    })

    it.each(['auth', 'fatal'] as const)('fails fast on a %s read from the tag watcher', (classification) => {
      const c = clock()
      let polls = 0
      const failure = Object.assign(new Error(`${classification} refusal`), { classification })
      expect(() => waitForDistTag(TAG_READBACK.package, 'latest', '0.8.2', {
        now: c.now,
        sleep: c.sleep,
        readDistTag: () => { polls += 1; throw failure },
      })).toThrow(new RegExp(`${classification} refusal`, 'u'))
      expect(polls).toBe(1)
      expect(c.elapsed()).toBe(0)
    })

    it('fails fast on an unclassified error from the tag watcher', () => {
      const c = clock()
      let polls = 0
      expect(() => waitForDistTag(TAG_READBACK.package, 'latest', '0.8.2', {
        now: c.now,
        sleep: c.sleep,
        readDistTag: () => { polls += 1; throw new Error('boom — a bug') },
      })).toThrow(/boom/u)
      expect(polls).toBe(1)
    })

    it('retries a transient read from the tag watcher', () => {
      const c = clock()
      let polls = 0
      const transient = Object.assign(new Error('429'), { classification: 'transient' })
      expect(waitForDistTag(TAG_READBACK.package, 'latest', '0.8.2', {
        now: c.now,
        sleep: c.sleep,
        readDistTag: () => {
          polls += 1
          if (polls < 3) throw transient
          return '0.8.2'
        },
      })).toBe('0.8.2')
      expect(polls).toBe(3)
    })

    /* ---- the same, through the REAL child-process chain (fake npm) ---- */

    describe('through the real child-process chain', () => {
      let sandbox: string
      let binDir: string
      let counterFile: string
      let originalPath: string | undefined

      /**
       * Serves `view` from the `FAKE_NPM_STATE` file, decrementing per READ.
       *
       * `dist-tag add/rm` must SUCCEED without touching the state: the whole point
       * of these tests is that the command succeeds while the read path lags, so a
       * fake that consumed state on the command would model the wrong thing.
       */
      const FAKE_NPM = `#!/usr/bin/env node
'use strict'
const fs = require('node:fs')
const counter = process.env.FAKE_NPM_COUNTER
if (counter) fs.appendFileSync(counter, '.')
const args = process.argv.slice(2)
const isView = args[0] === 'view'
const isRm = args[0] === 'dist-tag' && args[1] === 'rm'

if (isRm) {
  // Count removals separately: the ownership tests assert ZERO rm, which a shared
  // counter could not distinguish from "no read either".
  if (process.env.FAKE_NPM_RM_COUNTER) fs.appendFileSync(process.env.FAKE_NPM_RM_COUNTER, '.')
  if (process.env.FAKE_NPM_RM_HANG === '1') {
    // Never exits. The trailing "if (!isView) process.exit(0)" WOULD otherwise run
    // and make the removal look instant, so leave the script body here.
    setTimeout(() => {}, 600000)
    return
  } else {
    if (process.env.FAKE_NPM_RM_FAIL === '1' || process.env.FAKE_NPM_RM_FAIL_WITH) {
      // A FILE, not an inline string: this whole script is itself a template
      // literal, so embedding raw newlines here would emit invalid JavaScript.
      const payload = process.env.FAKE_NPM_RM_FAIL_WITH
        ? fs.readFileSync(process.env.FAKE_NPM_RM_FAIL_WITH, 'utf8')
        : 'npm error code E403\\nnpm error 403 Forbidden - PUT https://registry.npmjs.org\\n'
      process.stderr.write(payload)
      process.exit(1)
    }
    process.exit(0)
  }
}
if (!isView) process.exit(0)
if (process.env.FAKE_NPM_VIEW_DELAY_MS) {
  // Burn real time inside the child, so the caller deadline has to cover it.
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Number(process.env.FAKE_NPM_VIEW_DELAY_MS))
}

const mode = process.env.FAKE_NPM_MODE || 'tag'
if (mode === 'hang') { setTimeout(() => {}, 600000) } else if (mode === 'auth') {
  process.stderr.write('npm error code E401\\n'); process.exit(1)
} else if (mode === 'object') {
  process.stdout.write(JSON.stringify({ nope: true }) + '\\n')
} else {
  // Serve a SCRIPTED sequence first, then the final value forever.
  const file = process.env.FAKE_NPM_STATE
  const state = JSON.parse(fs.readFileSync(file, 'utf8'))
  const queue = state.sequence || []
  if (queue.length > 0) {
    const next = queue.shift()
    state.sequence = queue
    fs.writeFileSync(file, JSON.stringify(state))
    process.stdout.write(JSON.stringify(next) + '\\n')
  } else {
    process.stdout.write(JSON.stringify(state.final) + '\\n')
  }
}
`

      function install(): void {
        sandbox = mkdtempSync(join(tmpdir(), 'banbo-tag-npm-'))
        binDir = join(sandbox, 'bin')
        mkdirSync(binDir, { recursive: true })
        counterFile = join(sandbox, 'invocations')
        writeFileSync(counterFile, '')
        const npmPath = join(binDir, 'npm')
        writeFileSync(npmPath, FAKE_NPM)
        chmodSync(npmPath, 0o755)
        originalPath = process.env.PATH
        process.env.PATH = `${binDir}:${originalPath ?? ''}`
        process.env.FAKE_NPM_COUNTER = counterFile
        process.env.FAKE_NPM_RM_COUNTER = join(sandbox, 'rm-invocations')
        writeFileSync(process.env.FAKE_NPM_RM_COUNTER, '')
        process.env.FAKE_NPM_STATE = join(sandbox, 'state.json')
      }

      function setState(oldValue: unknown, newValue: unknown, remaining: number): void {
        writeFileSync(
          process.env.FAKE_NPM_STATE!,
          JSON.stringify({ sequence: Array.from({ length: remaining }, () => oldValue), final: newValue }),
        )
      }

      /** Serve each of `sequence` once, then `final` forever. */
      function setSequence(sequence: unknown[], finalValue: unknown): void {
        writeFileSync(process.env.FAKE_NPM_STATE!, JSON.stringify({ sequence, final: finalValue }))
      }

      function invocations(): number {
        return readTextFile(counterFile, 'utf8').length
      }

      function rmInvocations(): number {
        return readTextFile(process.env.FAKE_NPM_RM_COUNTER!, 'utf8').length
      }

      function teardown(): void {
        if (originalPath === undefined) delete process.env.PATH
        else process.env.PATH = originalPath
        for (const key of ['FAKE_NPM_MODE', 'FAKE_NPM_COUNTER', 'FAKE_NPM_RM_COUNTER', 'FAKE_NPM_RM_FAIL', 'FAKE_NPM_RM_FAIL_WITH', 'FAKE_NPM_STATE', 'FAKE_NPM_VIEW_DELAY_MS', 'FAKE_NPM_RM_HANG']) delete process.env[key]
        rmSync(sandbox, { recursive: true, force: true })
      }

      it('waits through several OLD answers and then succeeds (add)', () => {
        install()
        try {
          setState('0.8.1', '0.8.2', 3)
          const result = waitForDistTag('@banbolee/dsh-fish-shell', 'latest', '0.8.2', {
            budgetMs: 5000,
            initialDelayMs: 40,
            maxDelayMs: 40,
            sleep: (ms: number) => { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms) },
          })
          expect(result).toBe('0.8.2')
          // Four child invocations: three old answers plus the successful one.
          expect(invocations()).toBe(4)
        } finally {
          teardown()
        }
      })

      it('waits through several still-PRESENT answers and then sees absence (rm)', () => {
        install()
        try {
          setState('0.8.2', null, 3)
          const result = waitForDistTag('@banbolee/dsh-fish-shell', 'next', undefined, {
            budgetMs: 5000,
            initialDelayMs: 40,
            maxDelayMs: 40,
            sleep: (ms: number) => { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms) },
          })
          expect(result).toBeUndefined()
          expect(invocations()).toBe(4)
        } finally {
          teardown()
        }
      })

      it('fails closed when the tag never converges', () => {
        install()
        try {
          // `remaining` is huge, so every poll serves the old value.
          setState('0.8.1', '0.8.2', 10_000)
          expect(() => waitForDistTag('@banbolee/dsh-fish-shell', 'latest', '0.8.2', {
            budgetMs: 300,
            initialDelayMs: 20,
            maxDelayMs: 20,
            sleep: () => {},
          })).toThrow(/does not report .* as 0\.8\.2 after npm dist-tag add\/rm|could not read/u)
          expect(invocations()).toBeGreaterThan(1)
        } finally {
          teardown()
        }
      })

      it('kills a HUNG child within the budget', () => {
        install()
        try {
          process.env.FAKE_NPM_MODE = 'hang'
          const budgetMs = 700
          const started = performance.now()
          expect(() => waitForDistTag('@banbolee/dsh-fish-shell', 'latest', '0.8.2', {
            budgetMs,
            initialDelayMs: 50,
            maxDelayMs: 50,
            sleep: () => {},
          })).toThrow(/does not report|could not read/u)
          expect(performance.now() - started).toBeLessThan(budgetMs + 1500)
        } finally {
          teardown()
        }
      })

      it('fails fast on auth and on a non-string object answer', () => {
        install()
        try {
          process.env.FAKE_NPM_MODE = 'auth'
          expect(() => waitForDistTag('@banbolee/dsh-fish-shell', 'latest', '0.8.2', {
            budgetMs: 60_000,
            sleep: () => {},
          })).toThrow(/REFUSED/u)
          expect(invocations()).toBe(1)

          process.env.FAKE_NPM_MODE = 'object'
          expect(() => waitForDistTag('@banbolee/dsh-fish-shell', 'latest', '0.8.2', {
            budgetMs: 60_000,
            sleep: () => {},
          })).toThrow(/expected a string/u)
          expect(invocations()).toBe(2)
        } finally {
          teardown()
        }
      })

      /* ---- the functions finalize ACTUALLY calls, against the fake npm ---- */

      /** Fast knobs: real child processes, negligible waiting. */
      const FAST = { budgetMs: 5000, initialDelayMs: 40, maxDelayMs: 40, sleep: (ms: number) => { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms) } }

      it('promoteLatest tolerates a lagging read after a successful `dist-tag add`', () => {
        // This is the run 39249407401 path verbatim: finalize calls
        // `promoteLatest`, which runs the real `npm dist-tag add` and then waits.
        // The fake serves `0.8.1` for three polls and then `0.8.2`.
        install()
        try {
          setState('0.8.1', '0.8.2', 3)
          expect(() => promoteLatest('@banbolee/dsh-fish-shell', '0.8.2', FAST)).not.toThrow()
          // One `dist-tag add` + four reads (three old, one current).
          expect(invocations()).toBe(5)
        } finally {
          teardown()
        }
      })

      it('promoteLatest fails closed when the tag never converges', () => {
        install()
        try {
          // Every read keeps answering the OLD version: propagation that never
          // completes must exhaust the budget, not be accepted.
          setState('0.8.1', '0.8.2', 10_000)
          expect(() => promoteLatest('@banbolee/dsh-fish-shell', '0.8.2', {
            budgetMs: 300,
            initialDelayMs: 20,
            maxDelayMs: 20,
            sleep: () => {},
          })).toThrow(/does not report .* dist-tag "latest" as 0\.8\.2|could not read/u)
        } finally {
          teardown()
        }
      })

      it('promoteLatest fails fast on a REFUSED read', () => {
        install()
        try {
          process.env.FAKE_NPM_MODE = 'auth'
          expect(() => promoteLatest('@banbolee/dsh-fish-shell', '0.8.2', {
            budgetMs: 60_000,
            sleep: () => {},
          })).toThrow(/REFUSED/u)
        } finally {
          teardown()
        }
      })

      /* --------- candidate cleanup: ownership, not just propagation ---- */

      it('removes the tag when it still belongs to this release', () => {
        // The happy path: the authoritative read sees OUR version, the rm runs, and
        // the reads keep answering our version until the removal becomes visible.
        install()
        try {
          setState('0.8.2', null, 3)
          expect(() => removeCandidateTag('@banbolee/dsh-fish-shell', 'next', '0.8.2', FAST)).not.toThrow()
          // 1 authoritative read + 3 propagation reads + 1 `rm` (the counter sees
          // every child, including the command).
          expect(invocations()).toBe(5)
          expect(rmInvocations()).toBe(1)
        } finally {
          teardown()
        }
      })

      it('short-circuits when the tag is already gone', () => {
        install()
        try {
          setState(null, null, 10_000)
          expect(() => removeCandidateTag('@banbolee/dsh-fish-shell', 'next', '0.8.2', FAST)).not.toThrow()
          // Only the authoritative read; no `rm` and no waiting.
          expect(invocations()).toBe(1)
          expect(rmInvocations()).toBe(0)
        } finally {
          teardown()
        }
      })

      it('NEVER runs `rm` when the tag belongs to another release', () => {
        // The ownership guard: the tag exists, but on a version this release did
        // not publish. Removing it would take another release's candidate away.
        install()
        try {
          setState('0.9.0', '0.9.0', 10_000)
          expect(() => removeCandidateTag('@banbolee/dsh-fish-shell', 'next', '0.8.2', FAST))
            .toThrow(/refusing to remove .* it now points at 0\.9\.0, not 0\.8\.2/u)
          expect(rmInvocations()).toBe(0)
        } finally {
          teardown()
        }
      })

      it('fails when the tag moves to another version AFTER the rm succeeded', () => {
        // The TOCTOU/ownership race at its narrowest: our version is read, the rm
        // runs, and the readback shows a version that is neither ours nor absence.
        install()
        try {
          // Authoritative read: ours. Then the wait sees a foreign version.
          setSequence(['0.8.2', '0.9.0'], '0.9.0')
          expect(() => removeCandidateTag('@banbolee/dsh-fish-shell', 'next', '0.8.2', FAST))
            .toThrow(/now points at 0\.9\.0, not 0\.8\.2 and not nothing/u)
          expect(rmInvocations()).toBe(1)
        } finally {
          teardown()
        }
      })

      it('accepts the race when a FAILED rm nevertheless removed the tag', () => {
        install()
        try {
          setState('0.8.2', null, 1)
          process.env.FAKE_NPM_RM_FAIL = '1'
          // Authoritative read (ours) → rm fails → re-read says absent → success.
          expect(() => removeCandidateTag('@banbolee/dsh-fish-shell', 'next', '0.8.2', FAST)).not.toThrow()
          expect(rmInvocations()).toBe(1)
        } finally {
          teardown()
        }
      })

      it('fails FAST — preserving the original error — when a failed rm leaves the tag on our version', () => {
        // An auth refusal must not be hidden behind minutes of waiting: the re-read
        // shows our version still present, so the original failure is surfaced at
        // once.
        install()
        try {
          setState('0.8.2', '0.8.2', 10_000)
          process.env.FAKE_NPM_RM_FAIL = '1'
          const started = performance.now()
          expect(() => removeCandidateTag('@banbolee/dsh-fish-shell', 'next', '0.8.2', {
            budgetMs: 60_000,
            sleep: () => {},
          })).toThrow(/cannot remove the candidate tag[\s\S]*403 Forbidden[\s\S]*still points at 0\.8\.2/u)
          // Fast: it never polled toward the deadline.
          expect(performance.now() - started).toBeLessThan(2000)
          // authoritative read + the failed `rm` + one re-read: NO polling.
          expect(invocations()).toBe(3)
          expect(rmInvocations()).toBe(1)
        } finally {
          teardown()
        }
      })

      it('fails with an ownership error when a failed rm shows another version', () => {
        install()
        try {
          setSequence(['0.8.2', '0.9.0'], '0.9.0')
          process.env.FAKE_NPM_RM_FAIL = '1'
          expect(() => removeCandidateTag('@banbolee/dsh-fish-shell', 'next', '0.8.2', FAST))
            .toThrow(/moved to 0\.9\.0 while it was being removed/u)
        } finally {
          teardown()
        }
      })

      /* ---- ONE deadline for the whole cleanup (no per-step reset) ---- */

      it('spends ONE deadline: a hung authoritative pre-read uses the budget and never runs rm', () => {
        install()
        try {
          process.env.FAKE_NPM_MODE = 'hang'
          const budgetMs = 300
          const started = performance.now()
          expect(() => removeCandidateTag('@banbolee/dsh-fish-shell', 'next', '0.8.2', {
            budgetMs,
            initialDelayMs: 20,
            maxDelayMs: 20,
            sleep: () => {},
          })).toThrow(/deadline expired during that read|deadline/u)
          const elapsed = performance.now() - started
          // Bounded by the budget plus one child spawn/kill cycle.
          expect(elapsed, `elapsed ${elapsed}ms`).toBeLessThan(budgetMs + 2000)
          // Exactly one child (the killed pre-read) and ZERO removals.
          expect(invocations()).toBe(1)
          expect(rmInvocations()).toBe(0)
        } finally {
          teardown()
        }
      })

      it('carries the pre-read cost into the post-rm budget instead of resetting it', () => {
        // The pre-read deliberately burns most of the budget (a slow `view`), and
        // the tag then never disappears. If the propagation poll restarted its own
        // six minutes the call would run ~2x the budget; sharing one deadline keeps
        // the total bounded.
        install()
        try {
          process.env.FAKE_NPM_VIEW_DELAY_MS = '180'
          setState('0.8.2', '0.8.2', 10_000) // always OUR version: never removed
          const budgetMs = 450
          const started = performance.now()
          expect(() => removeCandidateTag('@banbolee/dsh-fish-shell', 'next', '0.8.2', {
            budgetMs,
            initialDelayMs: 20,
            maxDelayMs: 20,
            sleep: () => {},
          })).toThrow(/does not report|could not read|deadline/u)
          const elapsed = performance.now() - started
          // One budget, not two: an independent post-rm budget would exceed 2x.
          expect(elapsed, `elapsed ${elapsed}ms`).toBeLessThan(budgetMs * 2)
          // The rm did run, and at least one propagation read happened after it.
          expect(rmInvocations()).toBe(1)
          expect(invocations()).toBeGreaterThanOrEqual(3)
        } finally {
          teardown()
        }
      })

      it('never spawns the outcome read when the mutation consumed the whole budget', () => {
        // DETERMINISTIC. The mutation burns exactly the budget, so there is nothing
        // left for the authoritative outcome read. Spawning it anyway (the old
        // `Math.max(1, …)`) would start a child guaranteed to be killed, and would
        // report the kill instead of the real cause.
        let clock = 0
        const reads: number[] = []
        const mutationFailure = Object.assign(new Error('npm dist-tag rm failed: timed out'), {
          classification: 'transient',
          status: 1,
          code: 'ETIMEDOUT',
          signal: 'SIGTERM',
        })
        let captured: (Error & {
          classification?: string, status?: number, code?: string, signal?: string, cause?: unknown
        }) | undefined
        try {
          removeCandidateTag('@banbolee/dsh-fish-shell', 'next', '0.8.2', {
            budgetMs: 1000,
            now: () => clock,
            sleep: (ms: number) => { clock += ms },
            readDistTag: (_name: string, _tag: string, opts: { timeoutMs?: number } = {}) => {
              reads.push(opts.timeoutMs ?? -1)
              clock += 400 // the pre-read alone costs 400ms
              return '0.8.2'
            },
            runMutation: () => {
              clock += 600 // …and the mutation spends the remaining 600ms
              throw mutationFailure
            },
          })
        } catch (error) {
          captured = error as typeof captured
        }
        expect(captured, 'the cleanup must fail').toBeDefined()
        // ONLY the pre-read ran: the outcome read was refused, not spawned.
        expect(reads).toEqual([1000])
        // The top level says what actually happened — a timeout — not "unknown".
        expect(captured!.classification).toBe('transient')
        expect(captured!.code).toBe('ETIMEDOUT')
        expect(captured!.signal).toBe('SIGTERM')
        expect(captured!.status).toBe(1)
        // …with the mutation itself still reachable.
        expect(captured!.cause).toBe(mutationFailure)
        expect(String(captured!.message)).toMatch(/deadline/u)
      })

      it('lets an AUTH outcome read own the verdict while keeping the mutation', () => {
        // The mutation says "transient"; the authoritative read says "refused". The
        // read is what decides, because it is the only one that actually looked.
        const mutationFailure = Object.assign(new Error('npm dist-tag rm failed: 429'), {
          classification: 'transient',
          status: 1,
          code: 'E429',
        })
        const readFailure = Object.assign(new Error('npm view was REFUSED (authentication)'), {
          classification: 'auth',
          status: 1,
          code: 'E401',
        })
        let calls = 0
        let captured: (Error & {
          classification?: string, status?: number, code?: string, cause?: unknown, mutationError?: unknown
        }) | undefined
        try {
          removeCandidateTag('@banbolee/dsh-fish-shell', 'next', '0.8.2', {
            budgetMs: 60_000,
            now: () => 0,
            sleep: () => {},
            readDistTag: () => {
              calls += 1
              // First read (the pre-read) succeeds; the outcome read refuses.
              if (calls === 1) return '0.8.2'
              throw readFailure
            },
            runMutation: () => { throw mutationFailure },
          })
        } catch (error) {
          captured = error as typeof captured
        }
        expect(captured, 'the cleanup must fail').toBeDefined()
        expect(captured!.classification).toBe('auth')
        expect(captured!.status).toBe(1)
        expect(captured!.code).toBe('E401')
        // `cause` must BE the read error…
        expect(captured!.cause).toBe(readFailure)
        // …and the mutation must not be lost.
        expect(captured!.mutationError).toBe(mutationFailure)
      })

      it('reports a HUNG rm as a top-level timeout, not as an unknown failure', () => {
        // A real child process that never exits: the mutation is killed at the
        // deadline, and the top-level error must carry that verdict itself
        // (transient + ETIMEDOUT or a signal) rather than burying it in `cause`.
        install()
        try {
          setState('0.8.2', '0.8.2', 10_000)
          process.env.FAKE_NPM_RM_HANG = '1'
          const budgetMs = 600
          const started = performance.now()
          let captured: (Error & {
            classification?: string, code?: string, signal?: string, cause?: unknown
          }) | undefined
          try {
            removeCandidateTag('@banbolee/dsh-fish-shell', 'next', '0.8.2', {
              budgetMs,
              initialDelayMs: 20,
              maxDelayMs: 20,
              sleep: () => {},
            })
          } catch (error) {
            captured = error as typeof captured
          }
          expect(captured, 'the cleanup must fail').toBeDefined()
          expect(captured!.classification).toBe('transient')
          expect(
            captured!.code === 'ETIMEDOUT' || typeof captured!.signal === 'string',
            `expected ETIMEDOUT or a signal, got code=${String(captured!.code)} signal=${String(captured!.signal)}`,
          ).toBe(true)
          expect(captured!.cause).toBeDefined()
          // Bounded: the hung child was killed inside the budget.
          expect(performance.now() - started).toBeLessThan(budgetMs + 3000)
        } finally {
          teardown()
        }
      })

      it('never restarts the budget: each step timeout shrinks from the SAME deadline', () => {
        // DETERMINISTIC, not timing-dependent: the read seam records the timeout each
        // step is given and advances a virtual clock. With one shared deadline the
        // timeouts must shrink; with a per-step reset the poll would get the full
        // budget again.
        let clock = 0
        const timeouts: number[] = []
        expect(() => removeCandidateTag('@banbolee/dsh-fish-shell', 'next', '0.8.2', {
          budgetMs: 1000,
          now: () => clock,
          sleep: (ms: number) => { clock += ms },
          // Always OUR version: the tag never disappears, so the poll runs to the end.
          readDistTag: (_name: string, _tag: string, opts: { timeoutMs?: number } = {}) => {
            timeouts.push(opts.timeoutMs ?? -1)
            clock += 300
            return '0.8.2'
          },
          runMutation: () => { clock += 100; return '' },
        })).toThrow()
        // The authoritative read gets the whole budget…
        expect(timeouts[0]).toBe(1000)
        // …and the post-rm poll inherits what is LEFT, not a fresh six minutes.
        expect(timeouts[timeouts.length - 1]).toBeLessThan(1000)
        // No step is ever given more than the one budget.
        expect(Math.max(...timeouts)).toBe(1000)
        // The whole operation fits inside that one budget.
        expect(clock).toBeLessThanOrEqual(1000)
      })

      it('refuses to start a child when the deadline is already spent', () => {
        install()
        try {
          setState('0.8.2', '0.8.2', 10_000)
          // A frozen-at-the-end clock: `createRegistryDeadline` starts at `now()`,
          // so a `now` that has already burned the budget makes every step refuse.
          let t = 0
          expect(() => removeCandidateTag('@banbolee/dsh-fish-shell', 'next', '0.8.2', {
            budgetMs: 100,
            now: () => { t += 60; return t },
            sleep: () => {},
          })).toThrow(/deadline|registration/u)
          expect(rmInvocations()).toBe(0)
        } finally {
          teardown()
        }
      })

      /* ---- the failed rm's error keeps its classification and cause ---- */

      it.each([
        ['auth', 'E403', 'npm error code E403\nnpm error 403 Forbidden - PUT https://registry.npmjs.org'],
        ['transient', 'E429', 'npm error code E429\nnpm error 429 Too Many Requests'],
        ['fatal', 'EUNKNOWN', 'npm error code EUNKNOWN\nnpm error something nobody has seen before'],
      ] as const)('keeps classification=%s on the failure and a live cause chain', (expected, _label, stderr) => {
        install()
        try {
          setState('0.8.2', '0.8.2', 10_000)
          process.env.FAKE_NPM_RM_FAIL_WITH = join(sandbox, 'rm-stderr.txt')
          writeFileSync(process.env.FAKE_NPM_RM_FAIL_WITH, stderr)
          let captured: (Error & { classification?: string; cause?: unknown; status?: unknown }) | undefined
          try {
            removeCandidateTag('@banbolee/dsh-fish-shell', 'next', '0.8.2', { budgetMs: 60_000, sleep: () => {} })
          } catch (error) {
            captured = error as typeof captured
          }
          expect(captured, 'the cleanup must fail').toBeDefined()
          // OBJECT-LEVEL, not text matching: the classification survives the wrap.
          expect(captured!.classification).toBe(expected)
          // …and the original child error is still reachable by walking `cause`.
          expect(captured!.cause).toBeDefined()
          let leaf = captured!.cause as { status?: number, stderr?: string, cause?: unknown }
          while (leaf.cause !== undefined) leaf = leaf.cause as typeof leaf
          expect(leaf.status).toBe(1)
          expect(String(leaf.stderr)).toContain(_label)
        } finally {
          teardown()
        }
      })

    })
  })

  describe('the default schedule', () => {
    const delays = registryReadbackDelays()
    const total = delays.reduce((sum, delay) => sum + delay, 0)

    it('spends exactly the six-minute budget', () => {
      expect(REGISTRY_READBACK_BUDGET_MS).toBe(6 * 60 * 1000)
      expect(total).toBe(REGISTRY_READBACK_BUDGET_MS)
    })

    it('covers the propagation delay actually observed (2m44s)', () => {
      // Below this, run 39244336827 would abort again.
      expect(total).toBeGreaterThan(2 * 60 * 1000 + 44 * 1000)
    })

    it('backs off but caps, so it stays responsive near the end', () => {
      for (let index = 1; index < delays.length - 1; index += 1) {
        expect(delays[index]).toBeGreaterThanOrEqual(delays[index - 1]!)
      }
      // Everything except the truncated tail is capped at 60s.
      const capped = delays.slice(0, -1)
      for (const delay of capped) expect(delay).toBeLessThanOrEqual(60_000)
    })

    it('is deterministic — the same schedule every time', () => {
      expect(registryReadbackDelays()).toEqual(delays)
    })
  })
})

describe('npm failure classification (what "absent" is allowed to mean)', () => {
  const SPEC = '@banbolee/dsh-rtk@0.3.2'

  /**
   * The REAL `npm view` stderr for an absent version, captured from
   * `npm view @banbolee/dsh-fish-shell@99.99.99 dist.integrity --json` against the
   * public registry.
   *
   * Two facts about it are load-bearing and were both mis-handled once:
   *
   *   - the `No match found for version …` line names ONLY the version, not the
   *     package, so the full spec must be recovered from the
   *     `requested resource '<spec>'` line;
   *   - the template's last sentence ends "…or you do not have permission to
   *     access it", which is NOT auth evidence — it is printed for every absent
   *     version. Matching it as auth blocked a real release at preflight.
   */
  const REAL_ABSENT_TEMPLATE = [
    'npm error code E404',
    'npm error 404 No match found for version 99.99.99',
    'npm error 404',
    "npm error 404  The requested resource '@banbolee/dsh-fish-shell@99.99.99' could not be found or you do not have permission to access it.",
    'npm error 404',
    'npm error 404 Note that you can also install from a',
    'npm error 404 tarball, folder, http url, or git url.',
    'npm error A complete log of this run can be found in: /home/runner/.npm/_logs/2026-10-19T08_56_34_017Z-debug-0.log',
  ].join('\n')
  const REAL_ABSENT_SPEC = '@banbolee/dsh-fish-shell@99.99.99'

  // These strings are REAL captures from this repository's registry, not invented
  // ones. A normal new version must classify as absent through every shape npm
  // uses, or a publishable release would be blocked; a throttled registry must
  // classify as transient, or "could not ask" would silently become "publish it".
  //
  // Every absence case carries the REQUESTED SPEC, because that is the new rule:
  // absence is only an answer when the registry names what it could not find.
  const cases: ReadonlyArray<readonly [string, string, string]> = [
    [
      'view of an absent version',
      // The real shape: npm echoes the FULL specifier it could not match.
      'npm error code E404\nnpm error 404 No match found for version @banbolee/dsh-rtk@99.99.99\nnpm error A complete log of this run can be found in: …',
      '@banbolee/dsh-rtk@99.99.99',
    ],
    [
      'view of an absent dist-tag',
      'npm error code E404\nnpm error 404 No match found for version @banbolee/dsh-rtk@nonexistent-tag',
      '@banbolee/dsh-rtk@nonexistent-tag',
    ],
    [
      'npm pack of an absent version (the ETARGET/notarget shape)',
      'npm error code ETARGET\nnpm error notarget No matching version found for @banbolee/dsh-rtk@99.99.99.\nnpm error notarget In most cases you or one of your dependencies are requesting a package version that doesn\'t exist.',
      '@banbolee/dsh-rtk@99.99.99',
    ],
  ]

  it.each(cases)('treats %s as a confirmed absence when it names the requested spec', (_label, stderr, spec) => {
    // The specifier the caller asked for is what the answer must name.
    expect(classifyNpmFailure({ stderr, message: 'Command failed: npm view x' }, { spec })).toBe('absent')
  })

  it.each([
    ['a throttled registry', 'npm error code E429\nnpm error 429 Too Many Requests'],
    ['a dropped connection', 'npm error code ECONNRESET\nnpm error network read ECONNRESET'],
    ['a registry outage', 'npm error code E503\nnpm error 503 Service Unavailable'],
    ['a DNS failure', 'npm error code EAI_AGAIN\nnpm error network getaddrinfo EAI_AGAIN registry.npmjs.org'],
    ['a socket hang up', 'npm error network socket hang up'],
  ])('treats %s as transient, never as absent', (_label, stderr) => {
    expect(classifyNpmFailure({ stderr }, { spec: SPEC })).toBe('transient')
  })

  /* ------------------------------------------ reviewer probe scenarios --- */

  it('never calls a bare E404 "absent"', () => {
    // A bare 404 can be an unpublished package, a mis-typed registry path, a
    // scoped-name encoding problem, or a proxy's own error page. Reading it as
    // "this version does not exist" is what leads to a publish attempt.
    expect(classifyNpmFailure({ stderr: 'npm error code E404' }, { spec: SPEC })).toBe('fatal')
    expect(classifyNpmFailure({ stderr: 'npm error 404 Not Found' }, { spec: SPEC })).toBe('fatal')
  })

  it('never calls a bare ETARGET "absent"', () => {
    expect(classifyNpmFailure({ stderr: 'npm error code ETARGET' }, { spec: SPEC })).toBe('fatal')
    expect(classifyNpmFailure({ stderr: 'npm error notarget' }, { spec: SPEC })).toBe('fatal')
  })

  it('requires the no-match phrase to name the REQUESTED spec', () => {
    // A no-match answer about some OTHER specifier says nothing about ours.
    const aboutSomethingElse = 'npm error code E404\nnpm error 404 No match found for version 1.0.0'
    expect(classifyNpmFailure({ stderr: aboutSomethingElse }, { spec: SPEC })).toBe('fatal')
    // …and with no context at all, a no-match phrase cannot be tied to a request.
    expect(classifyNpmFailure({ stderr: aboutSomethingElse })).toBe('fatal')
  })

  it('does not treat an unrelated 404 page as absence', () => {
    const proxyPage = 'npm error 404 Not Found - GET https://proxy.invalid/-/ping - Not found'
    expect(classifyNpmFailure({ stderr: proxyPage }, { spec: SPEC })).toBe('fatal')
  })

  it.each([
    ['an unauthenticated read reported as 404', 'npm error code E404\nnpm error 404 No match found for version 0.3.2\nnpm error code ENEEDAUTH\nnpm error need auth'],
    ['an expired token', 'npm error 404 No match found for version 0.3.2\nnpm error E401\nnpm error Access token expired'],
    ['a forbidden read', 'npm error 404 No match found for version 0.3.2\nnpm error E403\nnpm error forbidden'],
  ])('classifies %s as auth, NOT absent (auth wins over a 404)', (_label, stderr) => {
    // This is the precedence that matters most: npm reports some unauthorised
    // reads as 404, and treating that as absence would publish over a package the
    // lane simply cannot see.
    expect(classifyNpmFailure({ stderr }, { spec: SPEC })).toBe('auth')
  })

  it('lets a transient signal win over an absence phrase in the same output', () => {
    const mixed = 'npm error code E404\nnpm error 404 No match found for version 0.3.2\nnpm error 429 Too Many Requests'
    expect(classifyNpmFailure({ stderr: mixed }, { spec: SPEC })).toBe('transient')
  })

  it('treats anything else as fatal', () => {
    expect(classifyNpmFailure({ stderr: 'npm error code EACCES\nnpm error permission denied' }, { spec: SPEC })).toBe('fatal')
    expect(classifyNpmFailure({ stderr: '' }, { spec: SPEC })).toBe('fatal')
  })

  /* ------------------------- the real standard 404 template --- */

  it('classifies the REAL absent-version template as absent, not auth', () => {
    // The regression from run 39225827349: the template's fixed sentence "…or you
    // do not have permission to access it" matched a broad auth signature, so a
    // brand-new version that simply was not published yet blocked the release at
    // preflight. The no-match line also names only the VERSION, so the spec has to
    // be recovered from the `requested resource '<spec>'` line.
    expect(classifyNpmFailure({ stderr: REAL_ABSENT_TEMPLATE }, { spec: REAL_ABSENT_SPEC })).toBe('absent')
    // …and the version-only shape is recognised by the predicate itself.
    expect(absenceNamesSpec(REAL_ABSENT_TEMPLATE, REAL_ABSENT_SPEC)).toBe(true)
    // The extracted token is the bare version, which is why shape 2 exists.
    expect(absenceSpecifierOf(REAL_ABSENT_TEMPLATE)).toBe('99.99.99')
  })

  it('does NOT let the template clause alone authorise absence', () => {
    // The permission sentence must not become absence evidence by itself: with the
    // no-match line removed, the same template is fatal.
    const withoutNoMatch = REAL_ABSENT_TEMPLATE
      .split('\n')
      .filter((line) => !/No match found for version/u.test(line))
      .join('\n')
    expect(classifyNpmFailure({ stderr: withoutNoMatch }, { spec: REAL_ABSENT_SPEC })).toBe('fatal')
    expect(absenceNamesSpec(withoutNoMatch, REAL_ABSENT_SPEC)).toBe(false)
  })

  it('keeps a DIFFERENT spec on the same template fatal', () => {
    // The template is about 99.99.99; asking about 0.8.2 must not inherit it.
    expect(classifyNpmFailure({ stderr: REAL_ABSENT_TEMPLATE }, { spec: '@banbolee/dsh-fish-shell@0.8.2' })).toBe('fatal')
    expect(absenceNamesSpec(REAL_ABSENT_TEMPLATE, '@banbolee/dsh-fish-shell@0.8.2')).toBe(false)
    // Another PACKAGE that shares the version string is equally not ours.
    expect(classifyNpmFailure({ stderr: REAL_ABSENT_TEMPLATE }, { spec: '@banbolee/dsh-rtk@99.99.99' })).toBe('fatal')
  })

  it('still lets REAL auth evidence beat a proven absence', () => {
    // A refused read can look like a 404, so a genuine credential error must win
    // even when a no-match line is present. Each case keeps the real template and
    // adds only the auth signal.
    for (const evidence of [
      'npm error code E401',
      'npm error code E403',
      'npm error code ENEEDAUTH',
      'npm error code EOTP',
      'npm error unauthorized',
      'npm error forbidden',
      'npm error Access token expired',
    ]) {
      expect(
        classifyNpmFailure({ stderr: `${REAL_ABSENT_TEMPLATE}\n${evidence}` }, { spec: REAL_ABSENT_SPEC }),
        evidence,
      ).toBe('auth')
    }
  })

  it('keeps mixed auth evidence auth even when the no-match is proven', () => {
    // Both signals in one answer: the stronger one wins.
    const mixed = `${REAL_ABSENT_TEMPLATE}\nnpm error code E403\nnpm error 403 Forbidden - PUT https://registry.npmjs.org/…`
    expect(classifyNpmFailure({ stderr: mixed }, { spec: REAL_ABSENT_SPEC })).toBe('auth')
  })

  it.each([
    ['You must be logged in to publish packages', 'npm error You must be logged in to publish packages.'],
    ['You do not have permission to publish this package', 'npm error You do not have permission to publish this package.'],
  ])('keeps the real auth phrase "%s" live alongside the 404 template', (_label, evidence) => {
    // Narrowing the template clause must NOT blind the classifier to genuine
    // credential failures. Both phrases mean what they say outside the fixed 404
    // sentence, so a mixed output is auth — even though the no-match is proven.
    const mixed = `${REAL_ABSENT_TEMPLATE}\n${evidence}`
    expect(classifyNpmFailure({ stderr: mixed }, { spec: REAL_ABSENT_SPEC })).toBe('auth')
    // …and each phrase is auth on its own, with no template present at all.
    expect(classifyNpmFailure({ stderr: evidence }, { spec: REAL_ABSENT_SPEC })).toBe('auth')
  })

  /* ------------------- binding a version-only no-match to a package --- */

  it('binds a version-only no-match only through the STANDARD requested-resource line', () => {
    // The positive case is the real template, whose `requested resource` sentence
    // names our spec on a line of its own.
    expect(requestedResourceSpecifierOf(REAL_ABSENT_TEMPLATE)).toBe(REAL_ABSENT_SPEC)
    expect(absenceNamesSpec(REAL_ABSENT_TEMPLATE, REAL_ABSENT_SPEC)).toBe(true)
    // The bare version alone is not enough to bind.
    const noResourceLine = REAL_ABSENT_TEMPLATE
      .split('\n')
      .filter((line) => !/The requested resource/u.test(line))
      .join('\n')
    expect(requestedResourceSpecifierOf(noResourceLine)).toBeUndefined()
    expect(absenceNamesSpec(noResourceLine, REAL_ABSENT_SPEC)).toBe(false)
    expect(classifyNpmFailure({ stderr: noResourceLine }, { spec: REAL_ABSENT_SPEC })).toBe('fatal')
  })

  it('does NOT bind when the requested-resource line names ANOTHER package', () => {
    // Reviewer counter-example: a foreign package's standard sentence, with our
    // spec quoted elsewhere in the output. Searching the answer for `'<spec>'`
    // would have accepted this; anchoring to the sentence does not.
    const foreign = [
      'npm error code E404',
      'npm error 404 No match found for version 99.99.99',
      "npm error 404  The requested resource '@banbolee/dsh-other@99.99.99' could not be found or you do not have permission to access it.",
      "npm notice original request: '@banbolee/dsh-fish-shell@99.99.99'",
    ].join('\n')
    expect(requestedResourceSpecifierOf(foreign)).toBe('@banbolee/dsh-other@99.99.99')
    expect(absenceNamesSpec(foreign, REAL_ABSENT_SPEC)).toBe(false)
    expect(classifyNpmFailure({ stderr: foreign }, { spec: REAL_ABSENT_SPEC })).toBe('fatal')
  })

  it.each([
    ['a notice quoting our spec', "npm notice publishing '@banbolee/dsh-fish-shell@99.99.99' next"],
    ['an echoed original request', "npm notice original request: '@banbolee/dsh-fish-shell@99.99.99'"],
    ['an arbitrary quoted line', "npm error something else entirely about '@banbolee/dsh-fish-shell@99.99.99'"],
  ])('does NOT bind on %s alone', (_label, line) => {
    // Only the STANDARD SENTENCE may bind. Our spec quoted anywhere else says
    // nothing about what the registry failed to find.
    const text = [
      'npm error code E404',
      'npm error 404 No match found for version 99.99.99',
      line,
    ].join('\n')
    expect(requestedResourceSpecifierOf(text)).toBeUndefined()
    expect(absenceNamesSpec(text, REAL_ABSENT_SPEC)).toBe(false)
    expect(classifyNpmFailure({ stderr: text }, { spec: REAL_ABSENT_SPEC })).toBe('fatal')
  })

  it('does NOT bind on a requested-resource line that is not the standard sentence', () => {
    // Same words, different sentence shape (e.g. embedded mid-line): still unbound.
    const notStandard = [
      'npm error code E404',
      'npm error 404 No match found for version 99.99.99',
      "npm warn while handling '@banbolee/dsh-fish-shell@99.99.99' the requested resource was missing",
    ].join('\n')
    expect(requestedResourceSpecifierOf(notStandard)).toBeUndefined()
    expect(absenceNamesSpec(notStandard, REAL_ABSENT_SPEC)).toBe(false)
  })

  it.each([
    ['npm notice', 'npm notice'],
    ['npm warn', 'npm warn'],
  ])('does NOT bind on a complete standard sentence emitted as %s', (_label, channel) => {
    // The sentence is IDENTICAL to the real template; only the CHANNEL differs.
    // A warning or notice is advisory — npm uses those channels for hints and
    // echoed request details — so binding on one would let an advisory line
    // authorise a publish. Only `npm error` (or an explicit 404) may bind.
    const sentence = `The requested resource '${REAL_ABSENT_SPEC}' could not be found or you do not have permission to access it.`
    const text = [
      'npm error code E404',
      'npm error 404 No match found for version 99.99.99',
      `${channel} ${sentence}`,
    ].join('\n')
    expect(requestedResourceSpecifierOf(text)).toBeUndefined()
    expect(absenceNamesSpec(text, REAL_ABSENT_SPEC)).toBe(false)
    expect(classifyNpmFailure({ stderr: text }, { spec: REAL_ABSENT_SPEC })).toBe('fatal')
  })

  it('still binds the real `npm error 404` template and a bare 404 status line', () => {
    // The positive controls for the tightened pattern: the captured template binds,
    // and so does the same sentence behind an explicit status with no npm prefix
    // (a caller that captured the raw registry body).
    expect(requestedResourceSpecifierOf(REAL_ABSENT_TEMPLATE)).toBe(REAL_ABSENT_SPEC)
    expect(classifyNpmFailure({ stderr: REAL_ABSENT_TEMPLATE }, { spec: REAL_ABSENT_SPEC })).toBe('absent')

    const sentence = `The requested resource '${REAL_ABSENT_SPEC}' could not be found or you do not have permission to access it.`
    const bare = ['npm error code E404', 'npm error 404 No match found for version 99.99.99', `404  ${sentence}`].join('\n')
    expect(requestedResourceSpecifierOf(bare)).toBe(REAL_ABSENT_SPEC)
    expect(classifyNpmFailure({ stderr: bare }, { spec: REAL_ABSENT_SPEC })).toBe('absent')
  })

  it('exposes the absence predicate it uses', () => {
    // npm echoes the full specifier in the no-match line, which is what lets the
    // predicate tie the answer to OUR request instead of to any 404.
    expect(absenceNamesSpec('npm error 404 No match found for version @banbolee/dsh-rtk@0.3.2', SPEC)).toBe(true)
    expect(absenceNamesSpec('npm error 404 No match found for version @banbolee/dsh-rtk@9.9.9', SPEC)).toBe(false)
    expect(absenceNamesSpec('npm error code E404', SPEC)).toBe(false)
  })

  it('extracts the specifier from the no-match LINE only', () => {
    // The phrase and the specifier must be on the SAME line — that is what makes
    // it the registry's answer rather than the echoed command.
    expect(absenceSpecifierOf('npm error 404 No match found for version @banbolee/dsh-rtk@0.3.2')).toBe('@banbolee/dsh-rtk@0.3.2')
    // npm's `notarget` shape ends the specifier with a period.
    expect(absenceSpecifierOf('npm error notarget No matching version found for @banbolee/dsh-rtk@0.3.2.')).toBe('@banbolee/dsh-rtk@0.3.2')
    expect(absenceSpecifierOf('npm error code E404')).toBeUndefined()
  })

  /* --------------------------- the two executable negative cases --- */

  it('rejects another PACKAGE’s absence as ours (executable negative)', () => {
    // `@scope/pkg` is a prefix of `@scope/pkg-extra`, so a substring test would
    // accept this answer for OUR package. Absence is what authorises a publish, so
    // this must be fatal.
    const otherPackage = 'npm error code E404\nnpm error 404 No match found for version @banbolee/dsh-rtk-extra@0.3.2'
    expect(classifyNpmFailure({ stderr: otherPackage }, { spec: '@banbolee/dsh-rtk@0.3.2' })).toBe('fatal')
    expect(absenceNamesSpec(otherPackage, '@banbolee/dsh-rtk@0.3.2')).toBe(false)
  })

  it('rejects 0.3.20 as evidence that 0.3.2 is absent (executable negative)', () => {
    // The prefix trap: `0.3.2` is a prefix of `0.3.20`, and `0.3.20` being absent
    // says NOTHING about `0.3.2`.
    const longerVersion = 'npm error code E404\nnpm error 404 No match found for version @banbolee/dsh-rtk@0.3.20'
    expect(classifyNpmFailure({ stderr: longerVersion }, { spec: '@banbolee/dsh-rtk@0.3.2' })).toBe('fatal')
    expect(absenceNamesSpec(longerVersion, '@banbolee/dsh-rtk@0.3.2')).toBe(false)
    // …and the exact match is still accepted (the positive case).
    const exact = 'npm error code E404\nnpm error 404 No match found for version @banbolee/dsh-rtk@0.3.2'
    expect(classifyNpmFailure({ stderr: exact }, { spec: '@banbolee/dsh-rtk@0.3.2' })).toBe('absent')
  })

  it('ignores the specifier echoed in error.message', () => {
    // execFileSync puts the whole command in `message`. If that counted as the
    // "answer", the requested spec would appear no matter what npm said — so an
    // otherwise unexplained failure would read as absence.
    const requested = '@banbolee/dsh-rtk@0.3.2'
    expect(classifyNpmFailure(
      { stderr: 'npm error code E404', message: `Command failed: npm view ${requested} dist.integrity --json` },
      { spec: requested },
    )).toBe('fatal')
    // A no-match line about a DIFFERENT spec is equally unusable, even when the
    // requested spec is present in the message.
    expect(classifyNpmFailure(
      {
        stderr: 'npm error 404 No match found for version @banbolee/dsh-rtk@9.9.9',
        message: `Command failed: npm view ${requested} dist.integrity --json`,
      },
      { spec: requested },
    )).toBe('fatal')
  })
})

describe('release package list', () => {  it('names exactly the six publishable bundles', () => {
    expect(RELEASE_PACKAGES.map((entry) => entry.package)).toEqual([
      '@banbolee/dsh-fish-shell',
      '@banbolee/dsh-rtk',
      '@banbolee/dsh-codegraph-mcp',
      '@banbolee/dsh-lsp-diagnostics',
      '@banbolee/dsh-llm-pi-ai-with-session',
      '@banbolee/dsh-agents',
    ])
  })

  it('stages only the bundle that ships a bundled dependency', () => {
    expect([...STAGED_PACKAGES]).toEqual(['@banbolee/dsh-fish-shell'])
  })

  it('fails loudly for a name that is not publishable', () => {
    expect(() => requireReleasePackage('@banbolee/dsh-typo')).toThrow(/not a publishable bundle/)
  })
})

describe('release journal', () => {
  const packages = RELEASE_PACKAGES.map((entry) => ({ package: entry.package, directory: entry.directory, version: '1.0.0' }))

  it('round-trips through disk and refuses a future format', () => {
    const dir = mkdtempSync(join(tmpdir(), 'banbo-journal-'))
    try {
      const path = join(dir, 'journal.json')
      const journal = createJournal({ sha: 'a'.repeat(40), dryRun: true, candidateTag: 'next', packages })
      writeJournal(path, journal)
      const read = readJournal(path)
      expect(read.version).toBe(JOURNAL_VERSION)
      expect(read.packages).toHaveLength(6)
      expect(read.packages[0]?.state).toBe(PACKAGE_STATES.planned)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('records transitions and refuses an unknown package', () => {
    const journal = createJournal({ sha: 'a'.repeat(40), dryRun: false, candidateTag: 'next', packages })
    setPackageState(journal, '@banbolee/dsh-rtk', PACKAGE_STATES.published, { registryIntegrity: 'sha512-x' })
    expect(journal.packages.find((entry) => entry.package === '@banbolee/dsh-rtk')?.state).toBe('published')
    expect(() => setPackageState(journal, '@banbolee/nope', PACKAGE_STATES.published)).toThrow(/not part of this dispatch/)
  })

  it('summarises every package so a failed run is readable', () => {
    const journal = createJournal({ sha: 'b'.repeat(40), dryRun: false, candidateTag: 'next', packages })
    setPackageState(journal, '@banbolee/dsh-agents', PACKAGE_STATES.failed, { detail: 'registry unreachable' })
    const text = summarise(journal)
    expect(text).toContain('@banbolee/dsh-agents')
    expect(text).toContain('failed')
    expect(text).toContain('registry unreachable')
  })
})

describe('cross-dispatch journal resume', () => {
  const sha = 'c'.repeat(40)
  const plan = () => RELEASE_PACKAGES.map((entry) => ({ package: entry.package, directory: entry.directory, version: '1.0.0' }))
  const expected = { sha, candidateTag: 'next', dryRun: false, packages: plan() }

  function prior(overrides: Record<string, unknown> = {}) {
    return { ...createJournal({ sha, dryRun: false, candidateTag: 'next', packages: plan() }), ...overrides }
  }

  it('resumes a journal that describes the same release', () => {
    expect(resumability(prior(), expected)).toEqual({ resumable: true })
  })

  it('refuses a journal from another commit, tag, run mode, version, or directory', () => {
    expect(resumability(prior({ sha: 'd'.repeat(40) }), expected))
      .toMatchObject({ resumable: false, reason: expect.stringContaining('belongs to') })
    expect(resumability(prior({ candidateTag: 'beta' }), expected))
      .toMatchObject({ resumable: false, reason: expect.stringContaining('candidate tag') })
    // A dry-run journal has no published versions, so adopting it as a real run
    // (or the reverse) would misstate what reached the registry.
    expect(resumability(prior({ dryRun: true }), expected))
      .toMatchObject({ resumable: false, reason: expect.stringContaining('dry run') })
    const bumped = prior()
    bumped.packages = bumped.packages.map((entry, index) => index === 0 ? { ...entry, version: '1.0.1' } : entry)
    expect(resumability(bumped, expected))
      .toMatchObject({ resumable: false, reason: expect.stringContaining('new release') })
    const moved = prior()
    moved.packages = moved.packages.map((entry, index) => index === 0 ? { ...entry, directory: 'plugins/elsewhere' } : entry)
    expect(resumability(moved, expected))
      .toMatchObject({ resumable: false, reason: expect.stringContaining('moved from') })
  })

  it('refuses a journal whose package set is a different size', () => {
    const short = prior()
    short.packages = short.packages.slice(0, 5)
    expect(resumability(short, expected))
      .toMatchObject({ resumable: false, reason: expect.stringContaining('lists 5 packages') })
  })

  it('counts published, promoted and skipped as "on the registry"', () => {
    // These are the states a resumed dispatch must NOT re-publish. `skipped` is
    // included because it means "the packed tarball matched an existing version",
    // which is a fact about the registry rather than about this run.
    expect(isPublished({ state: PACKAGE_STATES.published } as never)).toBe(true)
    expect(isPublished({ state: PACKAGE_STATES.promoted } as never)).toBe(true)
    expect(isPublished({ state: PACKAGE_STATES.skipped } as never)).toBe(true)
    expect(isPublished({ state: PACKAGE_STATES.packed } as never)).toBe(false)
    expect(isPublished({ state: PACKAGE_STATES.planned } as never)).toBe(false)
    expect(isPublished({ state: PACKAGE_STATES.failed } as never)).toBe(false)
  })
})

describe('GitHub Release idempotence', () => {
  const expected = { tag: 'dsh-rtk-v0.3.2', title: '@banbolee/dsh-rtk 0.3.2', sha: 'e'.repeat(40) }
  const matches = (overrides: Record<string, unknown> = {}) => ({
    tagName: expected.tag,
    name: expected.title,
    targetCommitish: expected.sha,
    tagCommit: expected.sha,
    targetCommit: expected.sha,
    ...overrides,
  })

  it('accepts an existing release whose tag AND target both resolve to the release commit', () => {
    expect(releaseMismatch(matches(), expected)).toBeUndefined()
    // A branch label is fine only because the CALLER resolved it to the commit
    // first: the comparison is on `targetCommit`, not on the label.
    expect(releaseMismatch(matches({ targetCommitish: 'main' }), expected)).toBeUndefined()
  })

  it('refuses a release whose identity belongs to something else', () => {
    expect(releaseMismatch(matches({ tagName: 'dsh-rtk-v0.3.1' }), expected)).toMatch(/tagName/)
    expect(releaseMismatch(matches({ name: '@banbolee/dsh-agents 0.4.2' }), expected)).toMatch(/name/)
  })

  it('refuses a release whose tag resolves to a DIFFERENT commit', () => {
    // The tag is the release identity. A tag that moved (or was reused by a later
    // commit) must never be accepted just because the title matches.
    expect(releaseMismatch(matches({ tagCommit: 'f'.repeat(40) }), expected))
      .toMatch(/tag resolves to/)
    expect(releaseMismatch(matches({ tagCommit: undefined }), expected))
      .toMatch(/unresolvable commit/)
  })

  it('refuses a release whose TARGET resolves to a different commit, even when it says "main"', () => {
    // This is the regression the review asked for: `targetCommitish: 'main'` is
    // NOT evidence. If `main` has advanced past the release commit, the release
    // no longer points at what is being published.
    expect(releaseMismatch(matches({ targetCommitish: 'main', targetCommit: 'f'.repeat(40) }), expected))
      .toMatch(/release target "main" resolves to/)
    expect(releaseMismatch(matches({ targetCommitish: 'main', targetCommit: undefined }), expected))
      .toMatch(/unresolvable commit/)
  })

  it('treats an unresolvable or empty target as a mismatch, never a pass', () => {
    expect(releaseMismatch(matches({ targetCommitish: '', targetCommit: undefined }), expected))
      .toMatch(/release target/)
    expect(releaseMismatch(matches({ targetCommitish: undefined, targetCommit: undefined }), expected))
      .toMatch(/release target/)
  })
})

describe('npm CLI capability floor', () => {
  it('accepts versions at or above the dist-tag OIDC floor', () => {
    for (const version of [MIN_NPM_VERSION, '11.21.1', '11.22.0', '12.0.0', '12.2.0']) {
      expect(checkNpmVersion(version), version).toEqual({ ok: true })
    }
  })

  it('rejects a CLI that can publish but cannot touch dist-tags', () => {
    // The failure this guards is specific and expensive: 11.6.2 publishes all six
    // versions and then fails at the FIRST dist-tag call, leaving six immutable
    // versions under a candidate tag that can never be promoted.
    const verdict = checkNpmVersion('11.6.2')
    expect(verdict.ok).toBe(false)
    expect(verdict.detail).toContain('tokenless dist-tag add/rm')
    expect(verdict.detail).toContain(MIN_NPM_VERSION)
    expect(verdict.detail).toMatch(/immutable/)
  })

  it('rejects an unparseable or missing version instead of assuming it is new', () => {
    expect(checkNpmVersion('').ok).toBe(false)
    expect(checkNpmVersion('not-a-version').ok).toBe(false)
    expect(() => assertNpmCapability('11.20.0')).toThrow(/needs npm >= 11\.21\.0/)
  })

  it('compares versions numerically, not lexicographically', () => {
    // `'11.9.0' < '11.21.0'` is a string-comparison trap: as text it is false.
    expect(compareVersions('11.9.0', '11.21.0')).toBeLessThan(0)
    expect(compareVersions('11.21.0', '11.21.0')).toBe(0)
    expect(compareVersions('12.0.0', '11.21.0')).toBeGreaterThan(0)
  })
})

describe('fish staging must stay outside the workspace', () => {
  it('refuses a stage inside the repository', () => {
    // Measured, not assumed: running `pnpm install` in an in-repo stage printed
    // "Scope: all 7 workspace projects" and removed/reinstalled the checkout's
    // root node_modules, destroying the tree the gates had just run against.
    const stage = join(repoRootForTest, 'release-artifacts', 'stage', 'banbolee-dsh-fish-shell')
    expect(() => assertOutsideWorkspace(stage, '@banbolee/dsh-fish-shell', repoRootForTest))
      .toThrow(/inside the repository/)
  })

  it('refuses a stage governed by a workspace file even outside the repository', () => {
    const root = mkdtempSync(join(tmpdir(), 'banbo-stage-guard-'))
    try {
      writeFileSync(join(root, 'pnpm-workspace.yaml'), 'packages:\n  - "plugins/*"\n')
      const stage = join(root, 'nested', 'fish-shell')
      expect(() => assertOutsideWorkspace(stage, '@banbolee/dsh-fish-shell', repoRootForTest))
        .toThrow(/pnpm-workspace\.yaml/)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('accepts a stage under the OS temp dir', () => {
    const root = mkdtempSync(join(tmpdir(), 'banbo-stage-ok-'))
    try {
      expect(() => assertOutsideWorkspace(join(root, 'fish-shell'), '@banbolee/dsh-fish-shell', repoRootForTest))
        .not.toThrow()
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

describe('staging guard runs BEFORE any destructive step', () => {
  it('never copies or installs when the stage is inside the workspace', () => {
    // The regression: the guard used to sit AFTER `cp -R` and after `pnpm install`,
    // so a stage that landed inside the workspace had already rewritten the
    // checkout's node_modules by the time the check spoke. A guard that runs after
    // the damage is a report, not a prevention — so this test records EVERY
    // command the function would have run and requires none of them.
    const calls: string[] = []
    const insideRepo = join(repoRootForTest, 'release-artifacts', 'stage', 'banbolee-dsh-fish-shell')
    expect(() => stageBundle(
      { directory: 'plugins/fish-shell', package: '@banbolee/dsh-fish-shell' },
      join(repoRootForTest, 'release-artifacts'),
      {
        makeStage: () => insideRepo,
        repoRoot: repoRootForTest,
        run: (command: string) => { calls.push(command); return '' },
      },
    )).toThrow(/inside the repository/)

    // NOT ONE of `cp` or `pnpm` may have run.
    expect(calls).toEqual([])
  })

  it('copies first, then installs, when the stage is outside the workspace', () => {
    // The positive half: the same injection records the ORDER, which is what makes
    // the negative test above meaningful (an empty list could otherwise mean the
    // function never reaches those steps at all).
    const calls: string[] = []
    const root = mkdtempSync(join(tmpdir(), 'banbo-stage-order-'))
    try {
      const stage = join(root, 'fish-shell')
      stageBundle(
        { directory: 'plugins/fish-shell', package: '@banbolee/dsh-fish-shell' },
        join(repoRootForTest, 'release-artifacts'),
        {
          makeStage: () => stage,
          repoRoot: repoRootForTest,
          run: (command: string) => { calls.push(command); return '' },
        },
      )
      expect(calls).toEqual(['cp', 'pnpm'])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

describe('the staging guard canonicalizes before it decides', () => {
  /** A temp root plus a workspace-flavoured directory to point symlinks at. */
  function fixture() {
    const root = mkdtempSync(join(tmpdir(), 'banbo-canonical-'))
    const repo = join(root, 'repo')
    mkdirSync(repo, { recursive: true })
    writeFileSync(join(repo, 'pnpm-workspace.yaml'), 'packages:\n  - "plugins/*"\n')
    return { root, repo }
  }

  it('refuses a stage whose TMPDIR symlink points back at the repository', () => {
    // The lexical check this replaces was trivially defeated: `/tmp/link` looks
    // outside the repository, but `realpath` resolves it INSIDE. pnpm would then
    // run in workspace scope and rewrite the checkout's node_modules.
    const { root, repo } = fixture()
    try {
      const link = join(root, 'tmpdir-link')
      symlinkSync(repo, link, 'dir')
      const stage = join(link, 'stage', 'banbolee-dsh-fish-shell')
      expect(() => assertOutsideWorkspace(stage, '@banbolee/dsh-fish-shell', repo))
        .toThrow(/inside the repository/)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('refuses a stage whose path reaches a workspace file through a symlink', () => {
    // Outside the repository lexically AND canonically, but an ancestor resolves
    // into a directory that carries `pnpm-workspace.yaml` — the same
    // workspace-scope hazard from the other direction.
    const { root, repo } = fixture()
    try {
      const externalWorkspace = join(root, 'external-workspace')
      mkdirSync(externalWorkspace, { recursive: true })
      writeFileSync(join(externalWorkspace, 'pnpm-workspace.yaml'), 'packages:\n  - "packages/*"\n')
      const link = join(root, 'external-link')
      symlinkSync(externalWorkspace, link, 'dir')
      const stage = join(link, 'stage', 'banbolee-dsh-fish-shell')
      expect(() => assertOutsideWorkspace(stage, '@banbolee/dsh-fish-shell', repo))
        .toThrow(/pnpm-workspace\.yaml/)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('still accepts a genuinely external stage reached through a harmless symlink', () => {
    // The positive control: canonicalization must not reject every symlink, only
    // the ones that resolve into a workspace.
    const { root, repo } = fixture()
    try {
      const plain = join(root, 'plain')
      mkdirSync(plain, { recursive: true })
      const link = join(root, 'plain-link')
      symlinkSync(plain, link, 'dir')
      expect(() => assertOutsideWorkspace(join(link, 'fish-shell'), '@banbolee/dsh-fish-shell', repo))
        .not.toThrow()
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('refuses before any copy or install, even through a symlink', () => {
    // Ordering and canonicalization together: the injected runner must never see
    // `cp`/`pnpm` for a stage that only LOOKS external.
    const { root, repo } = fixture()
    try {
      const link = join(root, 'repo-link')
      symlinkSync(repo, link, 'dir')
      const calls: string[] = []
      expect(() => stageBundle(
        { directory: 'plugins/fish-shell', package: '@banbolee/dsh-fish-shell' },
        join(repo, 'release-artifacts'),
        {
          makeStage: () => join(link, 'stage', 'banbolee-dsh-fish-shell'),
          repoRoot: repo,
          run: (command: string) => { calls.push(command); return '' },
        },
      )).toThrow(/inside the repository/)
      expect(calls).toEqual([])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

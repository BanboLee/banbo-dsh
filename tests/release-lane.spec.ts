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
import { assertOutsideWorkspace, releaseMismatch, stageBundle } from '../scripts/release/release.mjs'
import { MIN_NPM_VERSION, assertNpmCapability, checkNpmVersion, compareVersions } from '../scripts/release/lib/npm-capability.mjs'
import { absenceNamesSpec, absenceSpecifierOf, classifyNpmFailure, normaliseViewAnswer } from '../scripts/release/lib/registry.mjs'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
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

describe('npm failure classification (what "absent" is allowed to mean)', () => {
  const SPEC = '@banbolee/dsh-rtk@0.3.2'

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

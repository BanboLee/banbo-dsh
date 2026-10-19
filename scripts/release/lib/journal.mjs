/**
 * The release journal — the durable record of one dispatch.
 *
 * The release lane is a multi-step, partially irreversible operation: six
 * packages are published one after another, and a failure in the fifth leaves
 * four versions on the registry that can never be withdrawn (npm has no
 * unpublish for a version that other packages may already depend on). The
 * journal exists so that fact is *observable* rather than inferred from a red
 * run:
 *
 *   - every step rewrites it, so the uploaded artefact describes the state the
 *     run actually reached, including a run that died mid-publish;
 *   - it is written to a fixed path the workflow uploads with `if: always()`,
 *     so a failed run still produces evidence;
 *   - it records the exact integrity npm reported for each published version, so
 *     a later dispatch can prove "this version is already the artefact we built"
 *     instead of guessing.
 *
 * The journal is written atomically (temp file + rename): a run killed during a
 * write must leave the previous complete journal, never a truncated one.
 *
 * @module banbo-release/journal
 */

import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

/** The journal format version; a reader refuses anything else. */
export const JOURNAL_VERSION = 1

/** Lifecycle states a package can reach inside one dispatch. */
export const PACKAGE_STATES = Object.freeze({
  planned: 'planned',
  packed: 'packed',
  published: 'published',
  promoted: 'promoted',
  skipped: 'skipped',
  failed: 'failed',
})

/**
 * @typedef {object} PackageJournalEntry
 * @property {string} package published npm name
 * @property {string} directory repository-relative directory
 * @property {string} version version this dispatch would publish
 * @property {string} state one of {@link PACKAGE_STATES}
 * @property {string} [integrity] `sha512-…` npm reported for the packed tarball
 * @property {string} [registryIntegrity] `sha512-…` the registry reports for the version
 * @property {string} [detail] human-readable note (a failure reason, a skip reason)
 */

/**
 * @typedef {object} Journal
 * @property {number} version journal format version
 * @property {string} sha the exact commit this dispatch releases
 * @property {boolean} dryRun whether the dispatch may publish
 * @property {string} candidateTag the npm dist-tag a real publish uses
 * @property {string} startedAt ISO timestamp of the dispatch
 * @property {string} updatedAt ISO timestamp of the last write
 * @property {string} step the last completed step
 * @property {PackageJournalEntry[]} packages one entry per publishable bundle
 */

/**
 * Create the journal for one dispatch.
 *
 * @param {object} options `sha`, `dryRun`, `candidateTag`, and `packages`.
 * @returns {Journal} the fresh journal.
 */
export function createJournal(options) {
  const now = new Date().toISOString()
  return {
    version: JOURNAL_VERSION,
    sha: options.sha,
    dryRun: options.dryRun,
    candidateTag: options.candidateTag,
    startedAt: now,
    updatedAt: now,
    step: 'preflight',
    packages: options.packages.map((entry) => ({
      package: entry.package,
      directory: entry.directory,
      version: entry.version,
      state: PACKAGE_STATES.planned,
    })),
  }
}

/**
 * Read one journal from disk.
 *
 * @param {string} path journal path.
 * @returns {Journal} the parsed journal.
 * @throws {Error} when the file is absent, unparseable, or a future version.
 */
export function readJournal(path) {
  let text
  try {
    text = readFileSync(path, 'utf8')
  } catch (error) {
    throw new Error(`cannot read the release journal at ${path}: ${String(error?.message ?? error)}`)
  }
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch (error) {
    throw new Error(`the release journal at ${path} is not valid JSON: ${String(error?.message ?? error)}`)
  }
  if (parsed?.version !== JOURNAL_VERSION) {
    throw new Error(`the release journal at ${path} has version ${JSON.stringify(parsed?.version)}, expected ${JOURNAL_VERSION}`)
  }
  if (!Array.isArray(parsed.packages)) throw new Error(`the release journal at ${path} carries no package list`)
  return parsed
}

/**
 * Write one journal atomically.
 *
 * @param {string} path journal path.
 * @param {Journal} journal the journal to persist.
 * @returns {Journal} the same journal, with `updatedAt` refreshed.
 */
export function writeJournal(path, journal) {
  const next = { ...journal, updatedAt: new Date().toISOString() }
  mkdirSync(dirname(path), { recursive: true })
  const temp = `${path}.${process.pid}.tmp`
  try {
    writeFileSync(temp, `${JSON.stringify(next, null, 2)}\n`)
    renameSync(temp, path)
  } finally {
    rmSync(temp, { force: true })
  }
  return next
}

/**
 * Record one package's state transition, failing loudly for an unknown package.
 *
 * @param {Journal} journal the journal to update in place.
 * @param {string} packageName published npm name.
 * @param {string} state one of {@link PACKAGE_STATES}.
 * @param {object} [detail] extra fields (`integrity`, `registryIntegrity`, `detail`).
 * @returns {Journal} the same journal.
 * @throws {Error} when the package is not in this dispatch.
 */
export function setPackageState(journal, packageName, state, detail = {}) {
  const entry = journal.packages.find((candidate) => candidate.package === packageName)
  if (entry === undefined) throw new Error(`"${packageName}" is not part of this dispatch's journal`)
  Object.assign(entry, { state }, detail)
  return journal
}

/**
 * Record the step the dispatch reached.
 *
 * @param {Journal} journal the journal to update in place.
 * @param {string} step step name.
 * @returns {Journal} the same journal.
 */
export function setStep(journal, step) {
  journal.step = step
  return journal
}

/**
 * Summarise a journal for a human reading the run summary.
 *
 * @param {Journal} journal the journal to summarise.
 * @returns {string} a markdown table.
 */
export function summarise(journal) {
  const rows = journal.packages.map((entry) => {
    const note = entry.detail === undefined ? '' : ` ${entry.detail}`
    return `| \`${entry.package}\` | ${entry.version} | ${entry.state} |${note} |`
  })
  return [
    `Release dispatch for \`${journal.sha}\` (dry run: ${journal.dryRun}, candidate tag: \`${journal.candidateTag}\`)`,
    '',
    '| package | version | state | |',
    '|---|---|---|---|',
    ...rows,
  ].join('\n')
}

/**
 * Whether one journal entry records a version that reached the registry.
 *
 * `skipped` counts: it means "this dispatch packed a tarball whose integrity
 * matched an already-published version", which is a fact about the registry, not
 * about this run.
 *
 * @param {PackageJournalEntry} entry one journal entry.
 * @returns {boolean} whether the version is on the registry.
 */
export function isPublished(entry) {
  return entry.state === PACKAGE_STATES.published
    || entry.state === PACKAGE_STATES.promoted
    || entry.state === PACKAGE_STATES.skipped
}

/**
 * Decide whether a prior journal may be resumed by this dispatch, and why not.
 *
 * Cross-dispatch resume is what makes a partial release recoverable at all: the
 * published versions are immutable, so the ONLY correct continuation of a run
 * that published 4 of 6 is "publish the remaining 2", not "pack everything again
 * and hope". The journal is the record of that state, and the rules below are
 * what make trusting it safe:
 *
 *   - same release commit — a journal from a different SHA describes different
 *     code, and resuming it would promote versions built from something else;
 *   - same candidate tag — the promotion step removes that tag, so resuming
 *     across a changed tag would leave the old one pointing at a release nobody
 *     promotes;
 *   - same package set and versions — a version bump means a NEW release, and
 *     merging two journals would mix artefacts;
 *   - the prior run was a real run (not a dry run) if this one is.
 *
 * A refusal returns the reason rather than throwing, so the caller can decide
 * between "start fresh" (nothing published yet) and "hard fail" (a published
 * version exists that this dispatch would not account for).
 *
 * @param {Journal} prior the previously uploaded journal.
 * @param {object} expected `sha`, `candidateTag`, `dryRun`, `packages`.
 * @returns {{ resumable: boolean, reason?: string }} the verdict.
 */
export function resumability(prior, expected) {
  if (prior.sha !== expected.sha) {
    return {
      resumable: false,
      reason: `the previous journal belongs to ${prior.sha}, this dispatch releases ${expected.sha}`,
    }
  }
  if (prior.candidateTag !== expected.candidateTag) {
    return {
      resumable: false,
      reason: `the previous journal used candidate tag "${prior.candidateTag}", this dispatch uses "${expected.candidateTag}"`,
    }
  }
  if (prior.dryRun !== expected.dryRun) {
    return {
      resumable: false,
      reason: `the previous journal is ${prior.dryRun ? 'a dry run' : 'a real run'}, this dispatch is ${expected.dryRun ? 'a dry run' : 'a real run'}`,
    }
  }
  if (prior.packages.length !== expected.packages.length) {
    return {
      resumable: false,
      reason: `the previous journal lists ${prior.packages.length} packages, this dispatch lists ${expected.packages.length}`,
    }
  }
  for (const wanted of expected.packages) {
    const found = prior.packages.find((entry) => entry.package === wanted.package)
    if (found === undefined) {
      return { resumable: false, reason: `the previous journal has no entry for ${wanted.package}` }
    }
    if (found.version !== wanted.version) {
      return {
        resumable: false,
        reason: `${wanted.package} is ${found.version} in the previous journal and ${wanted.version} now; a version change is a new release`,
      }
    }
    if (found.directory !== wanted.directory) {
      return { resumable: false, reason: `${wanted.package} moved from ${found.directory} to ${wanted.directory}` }
    }
  }
  return { resumable: true }
}

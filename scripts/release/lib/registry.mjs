/**
 * Registry interaction for the release lane.
 *
 * Everything here is READ-ONLY against npmjs: the actual `npm publish` stays in
 * the workflow, where its provenance environment is visible. This module owns
 * the two questions a resumable release must answer before it publishes
 * anything:
 *
 *   1. does this exact version already exist (so a re-dispatch is not a blind
 *      re-publish)? and
 *   2. after publishing, does the registry hold the artefact we built?
 *
 * A missing answer is never treated as "no": an unreachable registry fails the
 * step, because "we could not tell whether this version exists" must not become
 * "publish it again".
 *
 * @module banbo-release/registry
 */

import { execFileSync } from 'node:child_process'

/** Registry npm publishes this repository's packages to. */
export const REGISTRY = 'https://registry.npmjs.org'

/**
 * Error signatures that are worth retrying: the registry did not give a
 * definitive answer, so the caller must not treat the version as absent OR as
 * present.
 *
 * These are the failures `npm` reports for a throttled or flaky registry. They
 * are listed explicitly (rather than "anything not matching ABSENT") so an
 * unexpected error still propagates as a hard failure instead of being retried
 * into a timeout.
 */
const TRANSIENT_SIGNATURES = [
  /\bE429\b/,
  /\bEAI_AGAIN\b/,
  /\bECONNRESET\b/,
  /\bECONNREFUSED\b/,
  /\bETIMEDOUT\b/,
  /\bESOCKETTIMEDOUT\b/,
  /\bENOTFOUND\b/,
  /\bE500\b/,
  /\bE502\b/,
  /\bE503\b/,
  /\bE504\b/,
  /rate.?limit/i,
  /\bToo Many Requests\b/i,
  /\bsocket hang up\b/i,
]

/**
 * Error signatures that mean "the registry refused to answer THIS caller".
 *
 * These take precedence over absence, because npm reports an unauthenticated or
 * unauthorised read as a 404 in some paths — treating that as "the version does
 * not exist" would make the lane try to publish over a package it merely cannot
 * see. Auth is therefore checked BEFORE absence, never after.
 */
const AUTH_SIGNATURES = [
  /\bE401\b/,
  /\bE403\b/,
  /\bENEEDAUTH\b/,
  /\bEOTP\b/,
  /\bunauthorized\b/i,
  /\bforbidden\b/i,
  /\bauthentication (?:failed|required)\b/i,
  /\byou (?:must be logged in|do not have permission)\b/i,
  /\bincorrect or missing password\b/i,
  /\bAccess token expired\b/i,
]

/**
 * The one absence phrase that identifies WHAT was not found.
 *
 * `npm view` prints `No match found for version <spec>` for an absent version or
 * dist-tag, and `npm pack` prints `notarget No matching version found for <spec>`.
 * Both name the requested specifier ON THE SAME LINE, which is what makes the
 * answer about OUR request rather than about something else that happened to 404.
 *
 * A bare `E404` is deliberately NOT accepted: a 404 can be an unpublished
 * package, a mis-typed registry path, a scoped-name encoding problem, or a
 * proxy's own 404 page. Those must not be read as "this version is absent",
 * because that answer leads directly to a publish attempt.
 */
const ABSENCE_LINE = /(?:No match found for version|No matching version found for|is not in this registry)\s+(?<specifier>[^\s'"]+)/i

/**
 * Extract the specifier a no-match LINE names, or `undefined`.
 *
 * The extraction is line-scoped and anchored to the phrase ON PURPOSE:
 *
 *   - only the text that carries the phrase is considered, so a specifier that
 *     appears elsewhere — the `npm view <spec>` in the echoed command line, a
 *     `Command failed:` message, a different package mentioned in a note — can
 *     never be mistaken for the registry's answer about our request;
 *   - the specifier is captured as ONE whitespace-delimited token right after the
 *     phrase, which is exactly how npm formats it.
 *
 * @param {string} text the captured stderr/stdout/message.
 * @returns {string | undefined} the specifier the no-match line names.
 */
export function absenceSpecifierOf(text) {
  if (typeof text !== 'string') return undefined
  for (const line of text.split(/\r?\n/u)) {
    const match = ABSENCE_LINE.exec(line)
    if (match?.groups?.specifier !== undefined) {
      // Strip the trailing sentence punctuation npm appends in some shapes
      // (`notarget … for @scope/name@1.2.3.`) without touching a legitimate
      // character inside a specifier.
      return match.groups.specifier.replace(/[.,;:]+$/u, '')
    }
  }
  return undefined
}

/**
 * Whether one failure is a no-match answer about the EXACT requested specifier.
 *
 * The comparison is a full-string equality, not a substring test. Substring
 * matching is a real hazard here: `0.3.2` is a prefix of `0.3.20`, and
 * `@scope/pkg` is a substring of `@scope/pkg-extra`, so a loose `includes()`
 * would accept another package's or another version's absence as ours — and
 * "ours is absent" is the answer that authorises a publish.
 *
 * @param {string} text the captured stderr/stdout/message.
 * @param {string} spec the requested `<package>@<version|tag>`.
 * @returns {boolean} whether the no-match line names exactly `spec`.
 */
export function absenceNamesSpec(text, spec) {
  if (typeof spec !== 'string' || spec === '') return false
  const named = absenceSpecifierOf(text)
  return named !== undefined && named === spec
}

/**
 * Classify one failed `npm` invocation into the three answers this lane needs.
 *
 * PRECEDENCE IS THE POINT, and it is auth → transient → absence → fatal:
 *
 *   - an auth failure is never "absent". npm reports some unauthorised reads as
 *     404, and treating that as absence makes the lane publish over a package it
 *     simply cannot see;
 *   - a transient failure (429, 5xx, connection reset) is never "absent" either:
 *     "we could not ask" must not become "it does not exist";
 *   - absence requires a no-match LINE that names the requested specifier
 *     EXACTLY (see {@link absenceNamesSpec}); a bare `E404`/`ETARGET`, a
 *     specifier mentioned only in the echoed command, or another package's
 *     absence is fatal;
 *   - everything else is fatal and propagates.
 *
 * A mixed answer (e.g. a 404 page that also mentions a timeout) therefore
 * classifies by the stronger signal: auth or transient wins over absence.
 *
 * @param {unknown} error the thrown execFileSync error.
 * @param {object} [context] what was being asked for.
 * @param {string} [context.spec] the requested `<package>@<version|tag>`.
 * @returns {'absent' | 'transient' | 'auth' | 'fatal'} the classification.
 */
export function classifyNpmFailure(error, context = {}) {
  const stderr = String(error?.stderr ?? '')
  const stdout = String(error?.stdout ?? '')
  // `error.message` is EXCLUDED from the absence decision. execFileSync puts the
  // whole command line there (`Command failed: npm view @scope/pkg@1.2.3 …`), so
  // including it would let the REQUESTED spec appear in the "answer" no matter
  // what the registry said — the exact confusion this function must not make. It
  // is still consulted for auth/transient, where a message-only signal is safe.
  const answer = `${stderr}\n${stdout}`
  const everything = `${answer}\n${String(error?.message ?? '')}`

  // 1. Auth first: a 404 for a package this caller cannot see is not absence.
  if (AUTH_SIGNATURES.some((pattern) => pattern.test(everything))) return 'auth'
  // 2. Transient next: the registry did not answer definitively.
  if (TRANSIENT_SIGNATURES.some((pattern) => pattern.test(everything))) return 'transient'

  // 3. Absence needs a no-match LINE naming the requested specifier exactly.
  const spec = typeof context.spec === 'string' && context.spec !== '' ? context.spec : undefined
  if (spec !== undefined && absenceNamesSpec(answer, spec)) return 'absent'
  return 'fatal'
}

/**
 * Run one `npm view` query, returning `undefined` when the version is absent.
 *
 * The distinction this function owns is the whole reason a release can be
 * resumed safely:
 *
 *   - an ABSENT signature (`E404` / `ETARGET` / `notarget` / `No match found for
 *     version`) is the ONE failure that means "not there yet", and it resolves to
 *     `undefined`;
 *   - a TRANSIENT signature (429, connection reset, 5xx) is retried a bounded
 *     number of times and then THROWS, because "we could not ask" must never
 *     become "it does not exist";
 *   - everything else throws immediately.
 *
 * @param {string} spec `<package>@<version>` or `<package>@<dist-tag>`.
 * @param {string} field the field to print.
 * @param {object} [options] retry knobs (`attempts`, `delayMs`) and the
 *   `sleep` seam the tests drive.
 * @returns {unknown} the parsed JSON value, or `undefined` for a confirmed absence.
 * @throws {Error} on any failure that is not a confirmed absence.
 */
export function viewField(spec, field, options = {}) {
  const { attempts = 3, delayMs = 2000, sleep: sleepFn = sleep } = options
  let lastFatal
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const stdout = execFileSync('npm', ['view', spec, field, '--json', '--registry', REGISTRY], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      }).trim()
      if (stdout === '') return undefined
      try {
        return JSON.parse(stdout)
      } catch (error) {
        throw new Error(`npm view ${spec} ${field} printed non-JSON output: ${String(error?.message ?? error)}`)
      }
    } catch (error) {
      // The spec is passed as context so an absence answer must NAME what was
      // asked for; a bare 404 about something else cannot become `undefined`.
      const classification = classifyNpmFailure(error, { spec })
      if (classification === 'absent') return undefined
      if (classification === 'auth') {
        throw new Error(
          `npm view ${spec} ${field} was REFUSED (authentication/authorisation), which is not the same as "absent": `
          + `${String(error?.stderr ?? '').trim() || String(error?.message ?? error)}\n`
          + 'Fix the registry credentials (or the trusted-publisher permission) before retrying — '
          + 'never treat an unauthorised read as an unpublished version.',
        )
      }
      if (classification === 'fatal') {
        throw new Error(`npm view ${spec} ${field} failed: ${String(error?.stderr ?? '').trim() || String(error?.message ?? error)}`)
      }
      lastFatal = error
      if (attempt < attempts - 1) sleepFn(delayMs)
    }
  }
  throw new Error(
    `npm view ${spec} ${field} kept failing with a transient registry error after ${attempts} attempts; `
    + `refusing to treat it as absent: ${String(lastFatal?.stderr ?? '').trim() || String(lastFatal?.message ?? lastFatal)}`,
  )
}

/**
 * Normalise a `npm view` answer to the single string this lane expects.
 *
 * npm prints an ARRAY when the query matches several documents (a version range
 * or a tag that resolves through more than one entry), and a bare string when it
 * matches one. Treating only the string case as valid silently produced
 * `undefined` for every real package — which read as "this version is absent"
 * and would have made the release lane re-publish published versions. Both
 * shapes are therefore accepted here, and anything else is a hard error.
 *
 * Exported because it is the exact place a wrong answer is most expensive: a
 * silent `undefined` here means "publish it again".
 *
 * @param {unknown} value the parsed JSON value.
 * @param {string} what the field being read, for the error message.
 * @returns {string | undefined} the single string, or `undefined` when absent.
 * @throws {Error} when the value is neither a string nor a one-element string array.
 */
export function normaliseViewAnswer(value, what) {
  if (value === undefined || value === null) return undefined
  if (typeof value === 'string') return value === '' ? undefined : value
  if (Array.isArray(value)) {
    const strings = value.filter((item) => typeof item === 'string' && item !== '')
    if (strings.length === 1) return strings[0]
    if (strings.length === 0) return undefined
    throw new Error(`npm view returned ${strings.length} values for ${what}; the release lane needs exactly one`)
  }
  throw new Error(`npm view returned ${typeof value} for ${what}; expected a string`)
}

/**
 * Read the integrity the registry reports for one exact version.
 *
 * @param {string} packageName published npm name.
 * @param {string} version exact version.
 * @returns {string | undefined} `sha512-…`, or `undefined` when the version is absent.
 */
export function publishedIntegrity(packageName, version) {
  return normaliseViewAnswer(viewField(`${packageName}@${version}`, 'dist.integrity'), `${packageName}@${version} dist.integrity`)
}

/**
 * Read the version a dist-tag currently points at.
 *
 * @param {string} packageName published npm name.
 * @param {string} distTag dist-tag name (`latest`, a candidate tag, …).
 * @returns {string | undefined} the version, or `undefined` when the tag is absent.
 */
export function distTagVersion(packageName, distTag) {
  return normaliseViewAnswer(viewField(`${packageName}@${distTag}`, 'version'), `${packageName}@${distTag} version`)
}

/**
 * Classify one package's state before publishing anything.
 *
 * Three outcomes, and the distinction is what prevents a blind re-publish:
 *
 *   - `absent` — the version does not exist; a real run publishes it.
 *   - `identical` — the version exists with the SAME integrity this dispatch
 *     packed. A resumed run continues past it (this is the only safe way to
 *     recover from a partial failure).
 *   - `conflict` — the version exists with a DIFFERENT integrity, or the
 *     registry could not be read. Fail closed: a published version is immutable,
 *     so the artefact must be re-versioned by a human, never overwritten by a
 *     retry.
 *
 * @param {object} options `package`, `version`, and `integrity` (the packed one).
 * @returns {{ outcome: 'absent' | 'identical' | 'conflict', registryIntegrity?: string, detail?: string }}
 */
export function classifyPublishedVersion(options) {
  const { package: packageName, version, integrity } = options
  const existing = publishedIntegrity(packageName, version)
  if (existing === undefined) return { outcome: 'absent' }
  if (existing === integrity) return { outcome: 'identical', registryIntegrity: existing }
  return {
    outcome: 'conflict',
    registryIntegrity: existing,
    detail: `${packageName}@${version} already exists with integrity ${existing}, but this dispatch packed ${integrity}`,
  }
}

/**
 * Assert the registry's integrity for a just-published version matches ours.
 *
 * npm returns success once it has accepted the upload; this is the check that
 * the artefact now readable from the registry is byte-identical to the one this
 * run built. A mismatch fails the package (and therefore the release), because a
 * silently different artefact is exactly what provenance exists to rule out.
 *
 * Only two conditions are retried, and the reason is the same in both cases: the
 * publish has just succeeded, so the registry may not have propagated the version
 * yet.
 *
 *   - the version is not readable YET (a confirmed absence — the readback raced
 *     the registry's own replication);
 *   - the read itself failed transiently (429 / connection reset / 5xx).
 *
 * A readable version with a DIFFERENT integrity is NOT retried: that is a real
 * mismatch, not a propagation delay, and waiting would only delay the abort.
 *
 * @param {object} options `package`, `version`, `integrity`, and optional retry knobs.
 * @returns {string} the registry's integrity.
 * @throws {Error} when the registry reports a different integrity, or none at all.
 */
export function assertRegistryIntegrity(options) {
  const { package: packageName, version, integrity, attempts = 10, delayMs = 3000, sleep: sleepFn = sleep } = options
  let last
  let lastError
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      last = publishedIntegrity(packageName, version)
      lastError = undefined
    } catch (error) {
      // A transient read failure is retried; `viewField` already retried the
      // classification internally, so reaching here means it stayed flaky.
      lastError = error
      last = undefined
    }
    if (last === integrity) return last
    if (last !== undefined) {
      // Readable and different: fail now, no amount of waiting changes it.
      throw new Error(
        `registry integrity mismatch for ${packageName}@${version}: registry ${last} != packed ${integrity}`,
      )
    }
    if (attempt < attempts - 1) sleepFn(delayMs)
  }
  if (lastError !== undefined) {
    throw new Error(
      `could not read ${packageName}@${version} back from the registry after ${attempts} attempts: ${String(lastError?.message ?? lastError)}`,
    )
  }
  throw new Error(`the registry does not report ${packageName}@${version} after publish; refusing to continue`)
}

/** Block the current thread for `ms` (the release lane is a script, not a server). */
function sleep(ms) {
  // `Atomics.wait` on a shared buffer keeps this synchronous, which lets the
  // whole lane stay a sequence of `execFileSync` steps with no event-loop
  // interleaving — the same shape as the rest of the repository's scripts.
  const buffer = new Int32Array(new SharedArrayBuffer(4))
  Atomics.wait(buffer, 0, 0, ms)
}

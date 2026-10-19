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
  // These two are REAL auth phrases npm emits for a publish the caller is not
  // allowed to make (`You must be logged in to publish packages`,
  // `You do not have permission to publish this package`). They are restored here
  // because the fix for the 404 template must not blind the classifier to genuine
  // credential failures.
  //
  // The ONLY reason they are safe again is that {@link withoutStandardTemplateClause}
  // removes the 404 template's fixed permission sentence from the auth input
  // BEFORE these run. Outside that one sentence, both phrases mean what they say.
  /\byou must be logged in\b/i,
  /\byou do not have permission\b/i,
  /\bincorrect or missing password\b/i,
  /\bAccess token expired\b/i,
]

/**
 * The permission clause npm puts in EVERY standard 404.
 *
 * The real template (captured from `npm view @banbolee/dsh-fish-shell@99.99.99`
 * against the public registry) is:
 *
 *     npm error code E404
 *     npm error 404 No match found for version 99.99.99
 *     npm error 404  The requested resource '@banbolee/dsh-fish-shell@99.99.99' could not be found
 *                    or you do not have permission to access it.
 *
 * That last sentence is a fixed part of the template: it appears for a version
 * that simply does not exist, with no authentication problem anywhere in the run.
 * Matching `you do not have permission` as auth evidence therefore turned the
 * MOST COMMON correct answer — "this new version is not published yet" — into an
 * auth failure, and blocked the release before it could publish anything.
 *
 * So ONLY this exact sentence is neutralised before the auth signatures are
 * evaluated; every other occurrence of the phrase stays live. The pattern is
 * anchored to the whole standard wording, so a genuine
 * `You do not have permission to publish this package` is NOT touched and still
 * classifies as auth.
 */
const STANDARD_404_PERMISSION_CLAUSE = /could not be found or you do not have permission to access it/gu

/**
 * Remove the template's permission clause, keeping everything else intact.
 *
 * Deliberately narrow: it rewrites the standard sentence's tail to
 * `could not be found`, which is what the sentence means when there is no auth
 * problem. A different sentence that merely contains the words "you do not have
 * permission" is left alone and continues to match {@link AUTH_SIGNATURES}.
 *
 * @param {string} text the captured stderr/stdout/message.
 * @returns {string} the same text without the standard 404 permission sentence.
 */
function withoutStandardTemplateClause(text) {
  return text.replace(STANDARD_404_PERMISSION_CLAUSE, 'could not be found')
}

/**
 * The one absence phrase that identifies WHAT was not found.
 *
 * `npm view` prints `No match found for version <specifier>` for an absent version
 * or dist-tag, and `npm pack` prints `notarget No matching version found for
 * <specifier>`. Two shapes of `<specifier>` occur in practice:
 *
 *   - the FULL spec (`@scope/pkg@1.2.3`) — `npm pack`'s `notarget` shape;
 *   - ONLY the version/tag (`1.2.3`) — `npm view`'s `No match found for version`
 *     shape, verified against the real CLI.
 *
 * Both are handled by {@link absenceNamesSpec}, which pairs the version-only form
 * with the `requested resource '<full spec>'` line npm prints in the same answer.
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
 * npm's standard `requested resource` sentence, anchored to a WHOLE ERROR line.
 *
 * The real line (captured from `npm view @banbolee/dsh-fish-shell@99.99.99`) is:
 *
 *     npm error 404  The requested resource '@banbolee/dsh-fish-shell@99.99.99' could not be found or you do not have permission to access it.
 *
 * This is the ONLY thing allowed to bind a version-only no-match to a package,
 * and it must be an ERROR line. Two accepted shapes:
 *
 *   - `npm error <status> The requested resource '<spec>' …` — the real template;
 *   - `<status> The requested resource '<spec>' …` with an explicit 3-digit
 *     status, for a caller that captured the raw registry body instead of npm's
 *     prefixed output.
 *
 * `npm warn` and `npm notice` lines are deliberately REJECTED even when they carry
 * the identical sentence. A warning or notice is advisory: npm uses that channel
 * for hints, deprecation chatter and echoed request details, and a NOTICE saying
 * "the requested resource … could not be found" is not the registry's verdict on
 * the version being published. Binding on it would let an advisory line authorise
 * a publish, which is the one decision this module must never hand to a hint.
 *
 * It is matched as a complete sentence with an explicit capture, NOT by searching
 * the answer for `'<spec>'`: a quoted spec can appear in a notice, in an echoed
 * original request, in a "did you mean" hint, or in any other quoted line, and
 * none of those say anything about what the registry failed to find.
 */
const REQUESTED_RESOURCE_LINE = /^\s*(?:npm error\s+|\s*)(?<status>\d{3})\s+The requested resource '(?<spec>[^']+)' could not be found or you do not have permission to access it\.?\s*$/iu

/**
 * The full specifier named by npm's `requested resource` ERROR line, or `undefined`.
 *
 * Line-anchored and channel-restricted: the sentence must occupy the whole line,
 * be prefixed by `npm error` (or carry an explicit 3-digit status), and be the
 * standard wording. Anything else — the phrase embedded in a longer sentence, a
 * different wording, a `npm warn`/`npm notice` variant, a quoted spec somewhere
 * else — yields `undefined`, and the caller then refuses to bind.
 *
 * @param {string} text the captured stderr/stdout/message.
 * @returns {string | undefined} the specifier the standard sentence names.
 */
export function requestedResourceSpecifierOf(text) {
  if (typeof text !== 'string') return undefined
  for (const line of text.split(/\r?\n/u)) {
    const match = REQUESTED_RESOURCE_LINE.exec(line)
    if (match?.groups?.spec !== undefined) return match.groups.spec
  }
  return undefined
}

/**
 * Whether one failure is a no-match answer about the EXACT requested specifier.
 *
 * The comparison is a full-string equality, never a substring test. Substring
 * matching is a real hazard here: `0.3.2` is a prefix of `0.3.20`, and
 * `@scope/pkg` is a substring of `@scope/pkg-extra`, so a loose `includes()` would
 * accept another package's or another version's absence as ours — and "ours is
 * absent" is the answer that authorises a publish.
 *
 * Two accepted shapes, both of which tie the answer to OUR request:
 *
 *   1. the no-match line names the full spec (npm's `notarget` shape);
 *   2. the no-match line names ONLY the version/tag (npm's `No match found for
 *      version <v>` shape) AND npm's standard `requested resource '<full spec>'`
 *      sentence — matched as a WHOLE line — names exactly our spec. That sentence
 *      is what proves the bare version belongs to the package we asked about
 *      rather than to some other package sharing the version string.
 *
 * Shape 2 is deliberately NOT satisfied by finding `'<spec>'` anywhere in the
 * answer: an unrelated package's `requested resource` line, a notice quoting our
 * spec, or an echoed original request must all leave the answer unbound.
 *
 * @param {string} text the captured stderr/stdout/message.
 * @param {string} spec the requested `<package>@<version|tag>`.
 * @returns {boolean} whether the answer is a no-match about exactly `spec`.
 */
export function absenceNamesSpec(text, spec) {
  if (typeof spec !== 'string' || spec === '') return false
  const named = absenceSpecifierOf(text)
  if (named === undefined) return false
  // Shape 1: the line names the whole specifier.
  if (named === spec) return true
  // Shape 2: the line names only the version/tag, and npm's standard
  // `requested resource` SENTENCE names exactly our specifier.
  const at = spec.lastIndexOf('@')
  if (at <= 0) return false
  const versionPart = spec.slice(at + 1)
  if (named !== versionPart) return false
  const resource = requestedResourceSpecifierOf(text)
  return resource !== undefined && resource === spec
}

/**
 * Classify one failed `npm` invocation into the answers this lane needs.
 *
 * PRECEDENCE, and why it is this order:
 *
 *   1. **A proven no-match about OUR request is `absent`, even when the standard
 *      404 template is present.** npm's fixed template ends with "…could not be
 *      found or you do not have permission to access it", which is NOT auth
 *      evidence — it is printed for every absent version. The proof required here
 *      is exact: the no-match line must name our spec (or our version together
 *      with the `requested resource '<our spec>'` line). Anything weaker falls
 *      through.
 *   2. **Genuine auth evidence beats absence.** An `E401`/`E403`/`ENEEDAUTH`/
 *      `EOTP` code, an `unauthorized`/`forbidden` message, or an expired-token
 *      message means the read was REFUSED — so even if a no-match line is also
 *      present, the answer is `auth`. npm reports some unauthorised reads as 404,
 *      and treating that as absence would publish over a package we cannot see.
 *      The template's permission CLAUSE is stripped before this check so it
 *      cannot masquerade as such evidence.
 *   3. **Transient evidence beats absence too** ("we could not ask" must not
 *      become "it does not exist").
 *   4. Everything else is `fatal` — including a bare `E404`/`ETARGET`, a
 *      specifier that appears only in the echoed command, and another package's
 *      or another version's absence.
 *
 * Note that steps 1 and 2 are ordered so that a PROVEN absence wins over the
 * template clause but loses to a real credential error; both directions are
 * covered by tests with the real captured template.
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
  // what the registry said — the exact confusion this function must not make.
  const answer = `${stderr}\n${stdout}`
  const spec = typeof context.spec === 'string' && context.spec !== '' ? context.spec : undefined

  // 1. A PROVEN no-match about our request is absence, even though the standard
  //    404 template also carries the permission clause.
  const provenAbsent = spec !== undefined && absenceNamesSpec(answer, spec)

  // 2. Genuine auth evidence, with the template clause neutralised first. A real
  //    credential error wins over an absence claim, because a refused read can
  //    look like a 404.
  const authEvidence = withoutStandardTemplateClause(`${answer}\n${String(error?.message ?? '')}`)
  if (AUTH_SIGNATURES.some((pattern) => pattern.test(authEvidence))) return 'auth'

  // 3. Transient evidence.
  if (TRANSIENT_SIGNATURES.some((pattern) => pattern.test(`${answer}\n${String(error?.message ?? '')}`))) return 'transient'

  // 4. The proven absence from step 1.
  if (provenAbsent) return 'absent'
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

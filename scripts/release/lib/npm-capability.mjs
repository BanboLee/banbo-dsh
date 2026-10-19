/**
 * npm CLI capability checks for the release lane.
 *
 * The lane authenticates with npm TRUSTED PUBLISHING (tokenless OIDC), so the npm
 * CLI version is a CORRECTNESS input, not a convenience: a CLI that predates a
 * capability silently falls back to "no credentials" and the step fails halfway
 * through an irreversible sequence.
 *
 * The two capabilities this lane needs are NOT the same release:
 *
 *   - `npm publish` (with `--provenance`) has accepted a tokenless OIDC exchange
 *     since npm **11.5.1**;
 *   - `npm dist-tag add|rm` did NOT: verified by unpacking the published CLI
 *     tarballs and looking for the OIDC exchange in `lib/commands/dist-tag.js` —
 *     11.20.0 has none, **11.21.0** is the first 11.x release that calls
 *     `oidc()` from the dist-tag command, and in the 12.x line it appears in
 *     **12.2.0** (12.0.0–12.1.0 have none).
 *
 * That distinction is the whole reason this module exists. A run on 11.6.2 — the
 * version this lane previously pinned, chosen only for `publish` — publishes all
 * six packages and then fails at the FIRST `dist-tag add`, because that call
 * needs credentials the workflow deliberately does not have. The registry would
 * be left holding six published versions under a candidate tag that can never be
 * promoted.
 *
 * The minimum below is therefore the maximum of the two capabilities.
 *
 * @module banbo-release/npm-capability
 */

/**
 * The lowest npm CLI that can publish AND manipulate dist-tags with OIDC alone.
 *
 * `11.21.0` (the first 11.x with dist-tag OIDC) is preferred over `12.2.0`
 * because 11.x is the current LTS-ish line for Node 22 runners; both work, and
 * the check below accepts anything at or above the floor.
 */
export const MIN_NPM_VERSION = '11.21.0'

/** Capability floors, each with the reason a human needs to read in a failure. */
export const NPM_CAPABILITIES = Object.freeze([
  Object.freeze({
    capability: 'tokenless publish with provenance',
    minimum: '11.5.1',
    evidence: 'npm/lib/commands/publish.js calls the OIDC exchange (lib/utils/oidc.js) before publishing',
  }),
  Object.freeze({
    capability: 'tokenless dist-tag add/rm',
    minimum: '11.21.0',
    evidence: 'npm/lib/commands/dist-tag.js calls oidc(); absent in 11.20.0 and in 12.0.0–12.1.0',
  }),
])

/**
 * Compare two `major.minor.patch` versions numerically.
 *
 * Prereleases are compared by their numeric triple only: every floor here is a
 * stable release, and a prerelease of the floor is NOT accepted (an `-rc` of a
 * capability release may not carry the capability yet).
 *
 * @param {string} left a version like `11.21.0`.
 * @param {string} right a version like `11.21.0`.
 * @returns {number} negative, zero, or positive.
 */
export function compareVersions(left, right) {
  const parse = (value) => {
    const match = /^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/.exec(value.trim())
    if (match === null) throw new Error(`"${value}" is not a semantic version`)
    return [Number(match[1]), Number(match[2]), Number(match[3])]
  }
  const a = parse(left)
  const b = parse(right)
  for (let index = 0; index < 3; index += 1) {
    if (a[index] !== b[index]) return a[index] - b[index]
  }
  return 0
}

/**
 * Decide whether one npm CLI version can run this lane.
 *
 * @param {string} version the reported CLI version.
 * @returns {{ ok: boolean, detail?: string }} the verdict.
 */
export function checkNpmVersion(version) {
  if (typeof version !== 'string' || version.trim() === '') {
    return { ok: false, detail: 'npm did not report a version' }
  }
  let comparison
  try {
    comparison = compareVersions(version, MIN_NPM_VERSION)
  } catch (error) {
    return { ok: false, detail: `cannot compare "${version}" with ${MIN_NPM_VERSION}: ${String(error?.message ?? error)}` }
  }
  if (comparison >= 0) return { ok: true }
  const missing = NPM_CAPABILITIES
    .filter((entry) => compareVersions(version, entry.minimum) < 0)
    .map((entry) => `${entry.capability} (needs ${entry.minimum}: ${entry.evidence})`)
  return {
    ok: false,
    detail:
      `npm ${version} cannot run this lane with tokenless OIDC; the release needs npm >= ${MIN_NPM_VERSION}.\n`
      + `Missing: ${missing.join('; ')}.\n`
      + 'A run on an older CLI publishes all six versions and then fails at the first dist-tag call, '
      + 'leaving six immutable versions under a candidate tag that cannot be promoted. '
      + 'Install a newer npm (`npm install --global npm@' + MIN_NPM_VERSION + '`) and re-run.',
  }
}

/**
 * Assert that a version string satisfies the lane, throwing a fixable error.
 *
 * @param {string} version the reported CLI version.
 * @throws {Error} when the CLI is too old.
 */
export function assertNpmCapability(version) {
  const verdict = checkNpmVersion(version)
  if (!verdict.ok) throw new Error(verdict.detail)
}

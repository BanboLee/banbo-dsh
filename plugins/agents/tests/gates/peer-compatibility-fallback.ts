/**
 * Gate B's fallback peer evaluator — the answer the probe falls back to when
 * the platform's own `evaluatePluginCompatibility` cannot be resolved from the
 * `dsh` on PATH (a CI image without a global `dsh`, or one laid out
 * differently).
 *
 * The fallback exists so Gate B can still decide, so it must answer what the
 * official evaluator answers. It may only ever be STRICTER, never more
 * permissive: a manifest the platform refuses must not read as compatible just
 * because the real evaluator was unavailable.
 *
 * Reference: `@deepseek-ai/dsh-app-boot`'s `lib/types/plugin-compatibility.js`
 * (0.2.0-rc.1), reproduced here in behaviour — every throw included:
 *
 *   - a runtime version that is not a valid semver is a `throw`;
 *   - a manifest that is not a plain object (null, array, primitive) is a `throw`;
 *   - a declared `peerDependencies` that is not a plain object is a `throw`;
 *   - every declared range must be a string — checked for EVERY entry, before
 *     the dsh-name filter — else `throw`;
 *   - only the `@deepseek-ai/dsh` and `@deepseek-ai/dsh-*` names are read;
 *   - the exact spellings `workspace:^`, `workspace:~` and `workspace:*` mean
 *     the RUNNING runtime. The match is exact, so a padded spelling is an
 *     ordinary (invalid) range rather than a special case;
 *   - an empty or blank range is INCOMPATIBLE and never `*`: the official code
 *     tests `requirement.trim() === ''` before asking `semver.satisfies`,
 *     which by itself answers `true` for `''` (an empty range parses as `*`);
 *   - prereleases participate in ranges (`includePrerelease: true`);
 *   - once any peer is incompatible the manifest must carry a non-empty string
 *     `name` and `version`, else `throw`. That rule is why the probes in the
 *     spec always declare an identity: the platform asks for one exactly when
 *     it is about to refuse a plugin.
 */

/** A manifest is compatible when it has no dsh peer the runtime fails. */
export type PeerChecker = (manifest: unknown, runtimeVersion: string) => boolean

/** The slices of `semver` the evaluator itself uses. */
export interface SemverLike {
  valid(value: string): string | null
  satisfies(version: string, range: string, options?: { includePrerelease?: boolean }): boolean
}

const DSH_PEER = '@deepseek-ai/dsh'
const DSH_PEER_PREFIX = '@deepseek-ai/dsh-'
/** The `workspace:` protocol spellings that refer to the running runtime. */
const WORKSPACE_RUNTIME_RANGES: readonly string[] = ['workspace:^', 'workspace:~', 'workspace:*']

/** `Object.hasOwn`, spelled so the file does not need a recent `lib` in scope. */
function hasOwn(value: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key)
}

/** The official `objectOf`: a plain, non-null, non-array object or a throw. */
function objectOf(value: unknown, field: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error(`${field} must be an object`)
  return value as Record<string, unknown>
}

/** The official `identityField`: an own, non-empty trimmed string or a throw. */
function identityOf(fields: Record<string, unknown>, field: string): string {
  const value = hasOwn(fields, field) ? fields[field] : undefined
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`Plugin manifest ${field} must be a non-empty string when dsh peers are incompatible`)
  }
  return value
}

/**
 * Build the fallback from a `semver`, so the caller names the copy it means
 * and a test can hand in a recording double.
 */
export function fallbackPeerChecker(semver: SemverLike): PeerChecker {
  return (manifest, runtimeVersion) => {
    if (typeof runtimeVersion !== 'string' || semver.valid(runtimeVersion) === null) {
      throw new Error(`Invalid dsh runtime version: ${JSON.stringify(runtimeVersion)}; expected a semantic version`)
    }
    const fields = objectOf(manifest, 'Plugin manifest')
    if (!hasOwn(fields, 'peerDependencies')) return true
    const dependencies = objectOf(fields.peerDependencies, 'Plugin manifest peerDependencies')

    const incompatible: string[] = []
    for (const [name, range] of Object.entries(dependencies)) {
      if (typeof range !== 'string') {
        throw new Error(`Plugin manifest peerDependencies[${JSON.stringify(name)}] must be a string`)
      }
      if (name !== DSH_PEER && !name.startsWith(DSH_PEER_PREFIX)) continue
      const requirement = WORKSPACE_RUNTIME_RANGES.includes(range) ? runtimeVersion : range
      if (requirement.trim() === '' || !semver.satisfies(runtimeVersion, requirement, { includePrerelease: true })) {
        incompatible.push(name)
      }
    }
    if (incompatible.length === 0) return true
    // The platform refuses with a named issue, so it insists on an identity
    // here; a fallback that answered `false` for an anonymous manifest would
    // answer a different question than the evaluator it stands in for.
    identityOf(fields, 'name')
    identityOf(fields, 'version')
    return false
  }
}

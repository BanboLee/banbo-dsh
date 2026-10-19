/**
 * The six publishable bundles, in the order the release workflow publishes them.
 *
 * Order matters for two reasons:
 *   - `@banbolee/dsh-agents` is the only package with a build output (`lib/`) and
 *     the only one whose packed surface needs an import probe, so it goes LAST:
 *     a failure there must not leave the cheaper packages half-published.
 *   - `@banbolee/dsh-fish-shell` carries a bundled dependency and is therefore
 *     the most fragile pack; it goes FIRST so its staged tree is validated while
 *     nothing has reached the registry yet.
 *
 * `directory` is the repository path; `package` is the published name. The two
 * are deliberately independent (AGENTS.md: directory names never change, the
 * npm name is always `@banbolee/dsh-<name>`).
 *
 * @typedef {object} ReleasePackage
 * @property {string} directory repository-relative package directory
 * @property {string} package published npm name
 * @property {string} versionField manifest field carrying the release version
 */

/** @type {readonly ReleasePackage[]} */
export const RELEASE_PACKAGES = Object.freeze([
  { directory: 'plugins/fish-shell', package: '@banbolee/dsh-fish-shell' },
  { directory: 'plugins/rtk', package: '@banbolee/dsh-rtk' },
  { directory: 'plugins/codegraph-mcp', package: '@banbolee/dsh-codegraph-mcp' },
  { directory: 'plugins/dsh-lsp-diagnostics', package: '@banbolee/dsh-lsp-diagnostics' },
  { directory: 'plugins/dsh-llm-pi-ai-with-session', package: '@banbolee/dsh-llm-pi-ai-with-session' },
  { directory: 'plugins/agents', package: '@banbolee/dsh-agents' },
])

/**
 * Every package that must be packed from a staged tree rather than the checkout.
 *
 * Only fish-shell qualifies today: it is the one bundle that ships a
 * `bundledDependencies` entry, and in the repository's symlinked `node_modules`
 * that dependency's transitive members resolve through `.pnpm`, producing
 * tarball members like `package/../../node_modules/.pnpm/...` that npmjs
 * rejects. The staging recipe is documented in the workflow.
 */
export const STAGED_PACKAGES = Object.freeze(new Set(['@banbolee/dsh-fish-shell']))

/** The one package whose tarball carries build output that must import. */
export const BUILT_PACKAGES = Object.freeze(new Set(['@banbolee/dsh-agents']))

/**
 * Resolve one package's entry from the release list, failing loudly for an
 * unknown name so a typo can never silently skip a bundle.
 *
 * @param {string} packageName published npm name.
 * @returns {ReleasePackage} the matching entry.
 * @throws {Error} when the name is not one of the six publishable bundles.
 */
export function requireReleasePackage(packageName) {
  const entry = RELEASE_PACKAGES.find((candidate) => candidate.package === packageName)
  if (entry === undefined) {
    throw new Error(
      `"${packageName}" is not a publishable bundle; expected one of ${RELEASE_PACKAGES.map((candidate) => candidate.package).join(', ')}`,
    )
  }
  return entry
}

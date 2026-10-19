/**
 * Fail-closed tarball safety checks for the release lane.
 *
 * Every rule here exists because breaking it is either rejected by npmjs at
 * upload time or installs a package that cannot work. `npm publish --dry-run`
 * cannot catch the registry-side ones: a dry run never uploads, so the registry
 * never applies its own structural rules — that is exactly how a 415 "Hard link
 * is not allowed" reached a real publish in this repository.
 *
 * The checks are split into three layers:
 *
 *   1. {@link assertSafeMembers} — shape rules every npm tarball must satisfy:
 *      every member lives under `package/`, no member has a `..` component, no
 *      member is a hardlink, and any symlink resolves inside the package root.
 *   2. {@link assertManifestMatchesTarball} — the packed `package.json` must be
 *      the manifest the repository declares (name, version, and the same file
 *      whitelist outcome), so a stale staged tree can never ship.
 *   3. {@link assertBundledDependencyPresent} / {@link assertImportProbe} — the
 *      two package-specific hazards this repository actually has: fish-shell's
 *      bundled terminal tool, and the agents bundle's built `lib/` output.
 *
 * @module banbo-release/tarball
 */

/**
 * @typedef {object} MemberListing
 * @property {readonly string[]} names every member path, from `tar -tzf`
 * @property {readonly string[]} hardlinks member paths whose tar entry is a link (`h`)
 * @property {readonly Array<{ path: string, target: string }>} symlinks member paths and their targets
 */

/**
 * Parse `tar -tvzf` output into the listing this module validates.
 *
 * The verbose listing is used (not `tar -tzf`) because only it carries the entry
 * TYPE, which is the whole point: a hardlink and a regular file have identical
 * paths. `tar -tvzf` prints the type as the first character of each line and the
 * link target after `->` for links.
 *
 * @param {string} namesOutput stdout of `tar -tzf`.
 * @param {string} verboseOutput stdout of `tar -tvzf`.
 * @returns {MemberListing} the parsed listing.
 */
export function parseMemberListing(namesOutput, verboseOutput) {
  const names = namesOutput.split('\n').filter((line) => line !== '')
  const hardlinks = []
  const symlinks = []
  for (const line of verboseOutput.split('\n')) {
    if (line === '') continue
    const type = line[0]
    // GNU tar writes a link entry as `<mode> <owner> … <path> link to <target>`
    // for hardlinks and `<path> -> <target>` for symlinks; a regular entry ends
    // with its path. Each case takes the field BEFORE the marker, because the
    // marker itself is followed by the target.
    const hardlinkMarker = line.indexOf(' link to ')
    const symlinkMarker = line.indexOf(' -> ')
    let path
    if (hardlinkMarker !== -1) path = line.slice(line.lastIndexOf(' ', hardlinkMarker - 1) + 1, hardlinkMarker)
    else if (symlinkMarker !== -1) path = line.slice(line.lastIndexOf(' ', symlinkMarker - 1) + 1, symlinkMarker)
    else path = line.slice(line.lastIndexOf(' ') + 1)
    if (type === 'h') hardlinks.push(path)
    if (type === 'l') symlinks.push({ path, target: line.slice(symlinkMarker + 4) })
  }
  return { names, hardlinks, symlinks }
}

/**
 * Assert the registry's structural rules over one packed tarball.
 *
 * @param {MemberListing} listing parsed member listing.
 * @returns {readonly string[]} the member names, for callers that assert content.
 * @throws {Error} naming every violation found, not just the first.
 */
export function assertSafeMembers(listing) {
  const problems = []
  const escaping = listing.names.filter((name) => !name.startsWith('package/') || /(^|\/)\.\.(\/|$)/.test(name))
  if (escaping.length > 0) {
    problems.push(`members escape the package root: ${escaping.join(', ')}`)
  }
  if (listing.hardlinks.length > 0) {
    // npmjs rejects these with `415 Unsupported Media Type — Hard link is not
    // allowed`. pnpm's default import method hardlinks store files, which is why
    // a staged pack must use `--config.package-import-method=copy`.
    problems.push(`hardlink members are rejected by npmjs (415): ${listing.hardlinks.join(', ')}`)
  }
  const escapingLinks = listing.symlinks.filter((link) => link.target.startsWith('/') || /(^|\/)\.\.(\/|$)/.test(link.target))
  if (escapingLinks.length > 0) {
    problems.push(`symlink members must resolve inside the package root: ${escapingLinks.map((link) => `${link.path} -> ${link.target}`).join(', ')}`)
  }
  if (problems.length > 0) throw new Error(`unsafe tarball:\n  - ${problems.join('\n  - ')}`)
  return listing.names
}

/**
 * Assert one packed `package.json` is the manifest the repository declares.
 *
 * A staged tree can be stale (the stage step copies the checkout, then installs
 * into it); comparing the packed manifest against the repository's own manifest
 * is what makes "we published the code we tested" a checked fact rather than an
 * assumption.
 *
 * @param {object} packed the parsed `package/package.json` from the tarball.
 * @param {object} declared the repository's manifest for the same package.
 * @throws {Error} on any identity, version, or licence mismatch.
 */
export function assertManifestMatchesTarball(packed, declared) {
  const mismatches = []
  for (const field of ['name', 'version', 'license']) {
    if (packed?.[field] !== declared?.[field]) {
      mismatches.push(`${field}: tarball ${JSON.stringify(packed?.[field])} != declared ${JSON.stringify(declared?.[field])}`)
    }
  }
  // `publishConfig` decides where the package goes and whether provenance is
  // attested; a tarball that lost it would publish to the wrong place silently.
  for (const field of ['access', 'registry']) {
    if (packed?.publishConfig?.[field] !== declared?.publishConfig?.[field]) {
      mismatches.push(
        `publishConfig.${field}: tarball ${JSON.stringify(packed?.publishConfig?.[field])} != declared ${JSON.stringify(declared?.publishConfig?.[field])}`,
      )
    }
  }
  // Provenance is the release's whole authentication story: a package whose
  // manifest dropped it would publish unsigned without failing anything else.
  if (declared?.publishConfig?.provenance === true && packed?.publishConfig?.provenance !== true) {
    mismatches.push('publishConfig.provenance: declared true but absent from the tarball')
  }
  if (mismatches.length > 0) {
    throw new Error(`packed manifest does not match the declared one:\n  - ${mismatches.join('\n  - ')}`)
  }
}

/**
 * Assert fish-shell's bundled terminal tool really travelled inside the tarball.
 *
 * The `terminal-tools` row resolves `@deepseek-ai/dsh-tool-terminal` from INSIDE
 * this package (it is a `dependencies` + `bundledDependencies` entry, never a
 * peer), so an offline profile only works when the dependency is packed. This is
 * the check that turns "the bundle installs offline" from a hope into a gate.
 *
 * @param {MemberListing} listing parsed member listing.
 * @param {readonly string[]} bundledDependencies the manifest's bundled list.
 * @throws {Error} when a bundled dependency is missing from the tarball.
 */
export function assertBundledDependencyPresent(listing, bundledDependencies) {
  const missing = []
  for (const dependency of bundledDependencies) {
    const prefix = `package/node_modules/${dependency}/`
    if (!listing.names.some((name) => name.startsWith(prefix))) missing.push(dependency)
  }
  if (missing.length > 0) {
    throw new Error(
      `bundled dependencies missing from the tarball: ${missing.join(', ')}; `
      + 'pack from a staged tree installed with --config.node-linker=hoisted and --config.package-import-method=copy',
    )
  }
}

/**
 * Assert the agents bundle's built `lib/` surface travelled inside the tarball.
 *
 * `plugins/agents` is the only bundle that publishes build output rather than
 * hand-written sources: its Host Remote, generated Typert descriptors, and the
 * classic-script client are produced by `node scripts/build.mjs`. Publishing a
 * tarball without them installs a package that throws on first import, and
 * `files` is a manual whitelist, so this is a real failure mode rather than a
 * hypothetical one.
 *
 * @param {MemberListing} listing parsed member listing.
 * @param {readonly string[]} requiredEntries member paths that must be present.
 * @throws {Error} naming every missing member.
 */
export function assertBuiltEntriesPresent(listing, requiredEntries) {
  const shipped = new Set(listing.names)
  const missing = requiredEntries.filter((entry) => !shipped.has(entry))
  if (missing.length > 0) {
    throw new Error(
      `built entries missing from the tarball: ${missing.join(', ')}; run \`node plugins/agents/scripts/build.mjs\` before packing`,
    )
  }
}

/**
 * Assert the packed package's relative imports all resolve inside the tarball.
 *
 * A manual `files` whitelist makes "added a module, forgot to list it" a
 * publishable mistake: the package installs and then fails at import time. This
 * walks the shipped root modules' relative imports and requires each target to
 * be a member too.
 *
 * @param {MemberListing} listing parsed member listing.
 * @param {(relativePath: string) => string} readSource reads one shipped member's text.
 * @returns {readonly string[]} the checked import targets.
 * @throws {Error} naming every import that the tarball does not carry.
 */
export function assertRelativeImportsShipped(listing, readSource) {
  const shipped = new Set(listing.names)
  const rootModules = listing.names.filter((name) => /^package\/[^/]+\.js$/.test(name))
  const missing = []
  const checked = []
  for (const member of rootModules) {
    const relative = member.slice('package/'.length)
    const source = readSource(relative)
    for (const match of source.matchAll(/from\s+'(\.\/[^']+)'/g)) {
      const target = normalizeRelative(relative, match[1])
      checked.push(target)
      if (!shipped.has(`package/${target}`)) missing.push(`${relative} imports ${match[1]}`)
    }
  }
  if (missing.length > 0) {
    throw new Error(`relative imports missing from the tarball:\n  - ${missing.join('\n  - ')}`)
  }
  return checked
}

/**
 * Resolve `./x.js` against a member's directory, POSIX-only, without touching
 * the filesystem (the paths are tarball members, not local files).
 *
 * @param {string} fromMember member path relative to `package/`.
 * @param {string} specifier the relative import specifier.
 * @returns {string} the normalized target, relative to `package/`.
 */
function normalizeRelative(fromMember, specifier) {
  const base = fromMember.split('/').slice(0, -1)
  for (const part of specifier.split('/')) {
    if (part === '.' || part === '') continue
    if (part === '..') base.pop()
    else base.push(part)
  }
  return base.join('/')
}

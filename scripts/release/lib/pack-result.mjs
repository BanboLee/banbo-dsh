/**
 * `npm pack --json` result parsing.
 *
 * npm changed this output shape inside the version range this repository
 * supports: npm <= 11 prints ONE ARRAY ENTRY PER PACKED PACKAGE, while npm 12
 * prints an OBJECT KEYED BY PACKAGE NAME. Both describe the same tarball, and a
 * release gate that understood only one of them would either crash or — worse —
 * read an empty list and pass. This module is the single place that knows.
 *
 * @module banbo-release/pack-result
 */

/**
 * @typedef {object} PackedTarball
 * @property {string} filename absolute path of the produced tarball
 * @property {string} name packed package name
 * @property {string} version packed package version
 * @property {string} integrity `sha512-…` of the tarball, as npm computed it
 * @property {string} shasum hex sha1 of the tarball, as npm computed it
 * @property {readonly string[]} files tarball members, each prefixed `package/`
 * @property {readonly string[]} bundled names npm recorded as bundled deps
 */

/**
 * Parse one `npm pack --json` document.
 *
 * @param {string} stdout the command's stdout.
 * @returns {PackedTarball} the single packed tarball.
 * @throws {Error} when the document is not one of the two known shapes, or
 *   describes anything other than exactly one package (the release always packs
 *   one package at a time, so "two results" means the invocation was wrong).
 */
export function parsePackJson(stdout) {
  let parsed
  try {
    parsed = JSON.parse(stdout)
  } catch (error) {
    throw new Error(`npm pack --json did not print JSON: ${String(error?.message ?? error)}`)
  }
  if (parsed === null || typeof parsed !== 'object') {
    throw new Error('npm pack --json printed no object')
  }
  // npm <= 11: an array of results. npm 12: an object keyed by package name.
  const entries = Array.isArray(parsed) ? parsed : Object.values(parsed)
  if (entries.length !== 1) {
    throw new Error(`npm pack --json described ${entries.length} packages; the release packs exactly one at a time`)
  }
  const entry = entries[0]
  if (entry === null || typeof entry !== 'object') throw new Error('npm pack --json printed a non-object entry')
  const { filename, name, version, integrity, shasum, files, bundled } = entry
  for (const [field, value] of Object.entries({ filename, name, version, integrity, shasum })) {
    if (typeof value !== 'string' || value === '') throw new Error(`npm pack --json is missing "${field}"`)
  }
  if (!Array.isArray(files)) throw new Error('npm pack --json is missing the packed file list')
  const members = files.map((file) => {
    const path = file?.path
    if (typeof path !== 'string' || path === '') throw new Error('npm pack --json carries a file entry with no path')
    return `package/${path}`
  })
  return {
    filename,
    name,
    version,
    integrity,
    shasum,
    files: Object.freeze(members),
    bundled: Object.freeze(Array.isArray(bundled) ? bundled.filter((item) => typeof item === 'string') : []),
  }
}

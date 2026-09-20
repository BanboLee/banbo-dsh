import { dirname, isAbsolute, join } from 'node:path'

/** @typedef {'always' | 'if-contained' | 'never'} SessionFallback */

/**
 * @typedef {object} FsSeam
 * @property {(path: string, opts?: { cwd?: string, signal?: AbortSignal }) => Promise<any>} resolve
 * @property {(statTarget: any, signal?: AbortSignal) => Promise<{ version: string, type: string, size?: number } | undefined>} stat
 * @property {(parentTarget: any, childTarget: any) => boolean} contains
 * @property {(processTarget: any) => string} processPath
 */

const GO_MARKERS = /** @type {const} */ (['go.work', 'go.mod', '.git'])
const TYPESCRIPT_MARKERS = /** @type {const} */ (['tsconfig.json', 'jsconfig.json', 'package.json', '.git'])
const DEFAULT_MARKERS = /** @type {const} */ (['.git'])

/**
 * Return project markers for the already-routed source extension.
 * @param {string} extension
 * @returns {readonly string[]}
 */
function markersForExtension(extension) {
  if (extension === '.go') return GO_MARKERS
  if (extension === '.ts' || extension === '.tsx') return TYPESCRIPT_MARKERS
  return DEFAULT_MARKERS
}

/**
 * Stat one marker path. Missing or inaccessible markers are simply not roots.
 * @param {FsSeam} fs
 * @param {string} markerPath
 * @param {AbortSignal | undefined} signal
 * @returns {Promise<boolean>}
 */
async function markerExists(fs, markerPath, signal) {
  try {
    if (signal?.aborted) return false
    const marker = await fs.resolve(markerPath, { signal })
    if (signal?.aborted) return false
    const info = await fs.stat(marker, signal)
    if (signal?.aborted) return false
    return info?.type === 'file' || info?.type === 'directory'
  } catch {
    return false
  }
}

/**
 * Resolve an existing directory root candidate.
 * @param {FsSeam} fs
 * @param {string} directory
 * @param {AbortSignal | undefined} signal
 * @returns {Promise<any | undefined>}
 */
async function resolveDirectory(fs, directory, signal) {
  try {
    if (signal?.aborted) return undefined
    const root = await fs.resolve(directory, { signal })
    if (signal?.aborted) return undefined
    const info = await fs.stat(root, signal)
    if (signal?.aborted) return undefined
    return info?.type === 'directory' ? root : undefined
  } catch {
    return undefined
  }
}

/**
 * Walk from the target's directory to the filesystem root looking for project markers.
 * @param {FsSeam} fs
 * @param {string} startDirectory
 * @param {readonly string[]} markers
 * @param {AbortSignal | undefined} signal
 * @returns {Promise<any | undefined>}
 */
async function nearestMarkedDirectory(fs, startDirectory, markers, signal) {
  let directory = startDirectory
  for (;;) {
    for (const marker of markers) {
      if (await markerExists(fs, join(directory, marker), signal)) {
        return resolveDirectory(fs, directory, signal)
      }
    }
    const parent = dirname(directory)
    if (parent === directory) return undefined
    directory = parent
  }
}

/**
 * Resolve the session root fallback and optionally require it to contain target.
 * @param {FsSeam} fs
 * @param {string} sessionRoot
 * @param {any} target
 * @param {SessionFallback} fallback
 * @param {AbortSignal | undefined} signal
 * @returns {Promise<any | undefined>}
 */
async function resolveSessionFallback(fs, sessionRoot, target, fallback, signal) {
  if (fallback === 'never') return undefined
  if (typeof sessionRoot !== 'string' || sessionRoot.trim().length === 0) return undefined
  const workspace = await resolveDirectory(fs, sessionRoot, signal)
  if (workspace === undefined) return undefined
  if (fallback === 'always') return workspace
  try {
    return fs.contains(workspace, target) === true ? workspace : undefined
  } catch {
    return undefined
  }
}

/**
 * Resolve the LSP workspace for a target. Prefer a project marker rooted at the
 * target itself (so sibling git worktrees work), then fall back to the session
 * workspace according to the caller's policy.
 *
 * @param {object} input
 * @param {FsSeam} input.fs
 * @param {any} input.target
 * @param {string} input.extension
 * @param {string} input.sessionRoot
 * @param {AbortSignal} [input.signal]
 * @param {SessionFallback} [input.sessionFallback]
 * @param {'language' | 'git'} [input.markerMode]
 * @returns {Promise<any | undefined>}
 */
export async function resolveWorkspaceRoot({
  fs,
  target,
  extension,
  sessionRoot,
  signal,
  sessionFallback = 'if-contained',
  markerMode = 'language',
}) {
  if (sessionFallback === 'if-contained') {
    const sessionWorkspace = await resolveSessionFallback(fs, sessionRoot, target, sessionFallback, signal)
    if (sessionWorkspace !== undefined) return sessionWorkspace
  }

  try {
    if (signal?.aborted) return undefined
    const targetPath = fs.processPath(target)
    if (typeof targetPath === 'string' && isAbsolute(targetPath)) {
      const markers = markerMode === 'git' ? DEFAULT_MARKERS : markersForExtension(extension)
      const marked = await nearestMarkedDirectory(fs, dirname(targetPath), markers, signal)
      if (marked !== undefined) return marked
    }
  } catch {
    // Fall through to the configured session fallback.
  }

  if (sessionFallback === 'if-contained') return undefined
  return resolveSessionFallback(fs, sessionRoot, target, sessionFallback, signal)
}

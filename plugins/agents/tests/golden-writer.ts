/// <reference types="node" />
/**
 * Golden regeneration for the two contract specs that pin model-visible text:
 * `builtin-catalog.spec.ts` (§5.4 D12, the canonical persona sections) and
 * `delegation-composition.spec.ts` (the complete model-visible schema of every
 * shipped named tool).
 *
 * GOLDENS ARE REWRITTEN ONLY UNDER AN EXPLICIT OPT-IN:
 *
 *   env NODE_ENV=development pnpm run test:agents:update-goldens
 *
 * Every other entry point — `pnpm test`, CI, a bare `vitest run <file>` — only
 * READS. `goldensWritable` is the single guard for that, and a test pins its
 * truth table so the opt-in cannot be weakened silently.
 *
 * Why the writer lives here instead of in a standalone script: the schema
 * goldens are the output of the real delegation runtime, whose fixture already
 * exists inside `delegation-composition.spec.ts`. A separate script would have to
 * duplicate that fixture (and the rendering it exercises), which is exactly how a
 * golden starts disagreeing with the code it is supposed to pin. Running the
 * writer inside the spec keeps one source of truth, and mirrors the repository's
 * existing `RUN_REAL_HEADLESS_E2E=1` / `BANBO_REAL_INSTALL=1` opt-in style.
 *
 * SAFETY, because an update run must never be able to damage the file it updates
 * (a first version could: a golden VALUE that happened to contain the end
 * sentinel moved the region boundary, and the spec was written half-rewritten):
 *
 *   1. each sentinel must appear EXACTLY ONCE as a whole line (so a copy of it
 *      inside a value is not mistaken for the boundary);
 *   2. `begin` must come before `end`;
 *   3. every replacement pattern must match exactly once, and no written value or
 *      region body may contain a sentinel;
 *   4. the candidate is re-rewritten before anything is written, and must already
 *      be a fixed point;
 *   5. the write goes to a sibling temporary file and is then moved into place
 *      with `rename`, so a crash cannot leave a truncated spec.
 *
 * The rewrite is a pure function of (source, live values), so the same source
 * state always produces the same bytes and re-running the writer with no change
 * is a zero diff. The specs assert `rewrite(source) === source` (a fixed point)
 * on every strict run — the automated form of that idempotence check.
 */
import { randomUUID } from 'node:crypto'
import { readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'

/** Opt-in only: nothing but an explicit `UPDATE_GOLDENS=1` may rewrite goldens. */
export function goldensWritable(env: { UPDATE_GOLDENS?: string | undefined }): boolean {
  return env.UPDATE_GOLDENS === '1'
}

/**
 * Normalize line endings: CRLF and a lone CR both become LF.
 *
 * ONE definition for the whole gate — the persona scanner, the fail-closed guard,
 * the section extractor, the golden derivation AND this writer — because two
 * different notions of "a line" let a CRLF or lone-CR payload read as a real
 * same-named `<h1>` to CommonMark while the gate saw one long line. Normalizing
 * (rather than refusing every `\r`) keeps a CRLF file usable while the shadow is
 * still caught by the duplicate-heading rule.
 */
export function normalizeNewlines(text: string): string {
  return text.replace(/\r\n?/g, '\n')
}

/**
 * The spec's own source — what the writer rewrites and the tests compare against.
 *
 * `import.meta.url` is passed in by the caller: `new URL(import.meta.url)` inside
 * this module would point at the helper, not at the spec being regenerated.
 *
 * Line endings are normalized on read, so the comparison, the fixed-point check
 * and the bytes written all speak LF: a CRLF spec is compared as LF and rewritten
 * as LF instead of churning on every run.
 */
export function specSource(specUrl: string): string {
  return normalizeNewlines(readFileSync(new URL(specUrl), 'utf8'))
}

/** The one whole-line occurrence of a sentinel, with `begin` required before `end`. */
function sentinelRegion(source: string, begin: string, end: string): { from: number, to: number } {
  const wholeLine = (marker: string): number => {
    const escaped = marker.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const matches = [...source.matchAll(new RegExp(`^${escaped}$`, 'gm'))]
    if (matches.length !== 1) {
      throw new Error(`the golden sentinel "${marker}" must appear exactly once as a whole line, found ${matches.length}`)
    }
    return matches[0]!.index!
  }
  const from = wholeLine(begin)
  const to = wholeLine(end)
  if (!(from < to)) throw new Error(`the golden sentinels are out of order: "${begin}" (at ${from}) is not before "${end}" (at ${to})`)
  return { from, to }
}

/** Refuse to write a value or a region body that carries a sentinel of its own. */
function assertNoSentinel(text: string, markers: string[], what: string): void {
  for (const marker of markers) {
    if (text.includes(marker)) {
      throw new Error(`${what} must not contain the sentinel "${marker}"; a copy of it inside the region would move the boundary`)
    }
  }
}

/** Replace a whole `[begin, end]` region with a freshly serialized body. */
export function replaceGoldenRegion(source: string, begin: string, end: string, body: string): string {
  const { from, to } = sentinelRegion(source, begin, end)
  assertNoSentinel(body, [begin, end], 'a golden region body')
  return `${source.slice(0, from)}${begin}\n${body}\n${source.slice(to)}`
}

/**
 * Rewrite value lines inside a `[begin, end]` region.
 *
 * Each entry is `[pattern, value]`: the pattern must capture the line PREFIX in
 * group 1 (e.g. `const D12_MAIN_UNIT = `) and match the rest of that line; the
 * remainder is replaced by the JSON-encoded value — the same escaping the blocks
 * are generated with. A function replacement is used on purpose: a string
 * replacement would interpret `$&`/`$1` inside the value.
 */
export function rewriteGoldenValues(
  source: string,
  begin: string,
  end: string,
  values: Array<[RegExp, string]>,
): string {
  const { from, to } = sentinelRegion(source, begin, end)
  const region = source.slice(from, to + end.length)
  const next = values.reduce((accumulated, [pattern, value]) => {
    assertNoSentinel(value, [begin, end], 'a golden value')
    const matches = [...accumulated.matchAll(new RegExp(pattern.source, pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`))]
    if (matches.length !== 1) {
      throw new Error(`the golden line matching ${String(pattern)} must match exactly once, found ${matches.length}`)
    }
    return accumulated.replace(pattern, (_match, prefix: string) => `${prefix}${JSON.stringify(value)}`)
  }, region)
  return source.slice(0, from) + next + source.slice(to + end.length)
}

/**
 * Replace `path` with `content` atomically.
 *
 * The temporary file is a SIBLING of the target (same filesystem, so `rename` is
 * atomic) and its name carries a random suffix on top of the pid: a pid-only name
 * was shared by every writer of the same process, so two concurrent writers of
 * the same target raced each other's `rename` (ENOENT) — and a failing `rename`
 * used to leave the temporary file behind on disk. `finally` removes it whatever
 * happens; after a successful rename it is already gone, and `force` makes the
 * second removal a no-op.
 */
export function writeAtomically(path: URL, content: string): void {
  const temporary = `${path.pathname}.update-goldens-${process.pid}-${randomUUID()}.tmp`
  try {
    writeFileSync(temporary, content)
    renameSync(temporary, path)
  } finally {
    rmSync(temporary, { force: true })
  }
}

/**
 * Write back, but only under the explicit opt-in, and only when the rewrite is
 * stable. A strict run is a pure read.
 */
export function updateGoldens(specUrl: string, rewrite: (source: string) => string): void {
  if (!goldensWritable(process.env)) return
  const path = new URL(specUrl)
  // Normalized on read, like `specSource`: comparing raw bytes against a
  // normalized rewrite would rewrite a CRLF spec on every run.
  const current = specSource(specUrl)
  const next = rewrite(current)
  const settled = rewrite(next)
  if (settled !== next) {
    throw new Error(`${path.pathname}: the golden rewrite does not settle — running it twice still changes the file; refusing to write`)
  }
  if (next === current) {
    console.log(`[update-goldens] ${path.pathname} is already up to date`)
    return
  }
  writeAtomically(path, next)
  console.log(`[update-goldens] rewrote ${path.pathname}`)
}

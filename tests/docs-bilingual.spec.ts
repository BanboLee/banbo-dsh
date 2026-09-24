/**
 * Bilingual README contract — AGENTS.md 「文档语言约定（强制）」.
 *
 * The repository is English-primary: `README.md` is English (what npm and GitHub
 * render) and `README.zh.md` is its Chinese counterpart, for the root README and
 * for every plugin. The convention only holds if something checks it: the drift
 * this replaces was real — the root English README had been missing a whole
 * plugin row, an uninstall note and a correct bundle count for as long as it
 * existed, and nothing failed.
 *
 * These assertions are structural on purpose. They pin the facts that make the
 * pair usable — both files exist, they are the right way round, they agree on
 * shape, they are both published, and neither translates an identifier — while
 * leaving the prose free to be reworded.
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/** Every directory that must carry a bilingual README pair. */
function readmeOwners(): Array<{ label: string, dir: string }> {
  const owners = [{ label: 'root', dir: repoRoot }]
  const pluginsDir = join(repoRoot, 'plugins')
  for (const name of readdirSync(pluginsDir)) {
    const dir = join(pluginsDir, name)
    // A plugin is anything with a package.json; scratch directories are not.
    if (existsSync(join(dir, 'package.json'))) owners.push({ label: `plugins/${name}`, dir })
  }
  return owners
}

const read = (path: string): string => readFileSync(path, 'utf8')

/** Heading levels in document order, e.g. `#, ##, ###`. */
const headingShape = (text: string): string =>
  text.split('\n').filter((line) => /^#{1,6} /.test(line)).map((line) => line.match(/^#+/u)![0]).join(',')

/** Fenced-code-block contents, which are never translated. */
function fencedBlocks(text: string): string[] {
  const blocks: string[] = []
  let open = false
  let current: string[] = []
  for (const line of text.split('\n')) {
    if (line.startsWith('```')) {
      if (open) { blocks.push(current.join('\n')); current = [] }
      open = !open
      continue
    }
    if (open) current.push(line)
  }
  return blocks
}

/**
 * A code block reduced to its COMMANDS and structure.
 *
 * The load-bearing part of a code block is the command or path itself — a
 * mangled `dsh plugin ... add` is a broken instruction, and a mangled directory
 * name in a tree diagram is a wrong path. Two kinds of text are therefore
 * dropped, because both are prose a translation is supposed to change:
 *
 *   - a whole-line comment (`  # settings.yaml — …`), and
 *   - everything after a run of two or more spaces, which is the alignment
 *     convention README examples use for annotations
 *     (`├── agents/*.yaml        your definitions`).
 *
 * One space is never a separator, so `dsh plugin --profile <profile> add
 * @banbolee/dsh-rtk` stays whole and fails loudly if a translator touches it.
 * Dropping whole-line comments must come FIRST: after the split a comment line
 * becomes `#`, which would survive as a "command" and be compared verbatim.
 */
const commandLines = (block: string): string =>
  block.split('\n')
    .filter((line) => !/^\s*#/u.test(line))
    .map((line) => line.split(/ {2,}/u)[0]!.trimEnd())
    .filter((line) => line !== '')
    .join('\n')

/**
 * The text with every fenced code block removed.
 *
 * Inline-code extraction must not see fences: a closing ``` ends with a backtick
 * that would otherwise pair with the opening backtick of an inline span several
 * lines later, inventing a span that spans a heading and a table row.
 */
const withoutFences = (text: string): string => {
  const kept: string[] = []
  let open = false
  for (const line of text.split('\n')) {
    if (line.startsWith('```')) { open = !open; continue }
    if (!open) kept.push(line)
  }
  return kept.join('\n')
}

/**
 * Inline code spans, with wrapping normalized away.
 *
 * Both READMEs hard-wrap prose, and the English one sometimes wraps INSIDE a
 * span (`` `ctx.fs.readBytes(target, signal,\nmaxDocumentBytes)` ``). Collapsing
 * runs of whitespace to a single space before extracting makes the two sides
 * comparable without weakening the check: an identifier that was translated is
 * still missing, which is the failure this guards against.
 */
const inlineCode = (text: string): Set<string> =>
  new Set([...withoutFences(text).replace(/\s+/gu, ' ').matchAll(/`([^`]+)`/gu)].map((match) => match[1]!))

/** Markdown link targets, which are never translated. */
const linkTargets = (text: string): Set<string> =>
  new Set([...text.matchAll(/\]\(([^)\s]+)\)/gu)].map((match) => match[1]!))

/**
 * The text with the language switcher removed.
 *
 * The switcher is the one place the two files legitimately point at DIFFERENT
 * targets — each links to the other — so comparing its targets would always
 * fail. It is checked on its own instead.
 */
const withoutSwitcher = (text: string): string =>
  text.split('\n').filter((line) => !/^\*{0,2}(English|中文)\*{0,2} \|/u.test(line)).join('\n')

const owners = readmeOwners()

describe('bilingual READMEs — the pair exists and is the right way round', () => {
  it('covers the root and every plugin', () => {
    // Six plugins plus the root. A drop means the walk stopped finding them,
    // which would make every assertion below vacuous.
    expect(owners.length).toBeGreaterThanOrEqual(7)
  })

  it('has an English README.md and a Chinese README.zh.md for each owner', () => {
    for (const { label, dir } of owners) {
      expect(existsSync(join(dir, 'README.md')), `${label} is missing README.md`).toBe(true)
      expect(existsSync(join(dir, 'README.zh.md')), `${label} is missing README.zh.md`).toBe(true)
      // The pre-convention spelling must be gone, or the pair is ambiguous.
      expect(existsSync(join(dir, 'README.en.md')), `${label} still has the old README.en.md`).toBe(false)
    }
  })

  it('puts the English text in README.md and the Chinese text in README.zh.md', () => {
    for (const { label, dir } of owners) {
      const en = read(join(dir, 'README.md'))
      const zh = read(join(dir, 'README.zh.md'))
      // CJK ideographs are the cheap discriminator: the primary file must not be
      // Chinese, and the counterpart must not be English-only.
      expect((en.match(/[\u4e00-\u9fff]/gu) ?? []).length, `${label}: README.md looks Chinese`).toBeLessThan(50)
      expect((zh.match(/[\u4e00-\u9fff]/gu) ?? []).length, `${label}: README.zh.md looks English`).toBeGreaterThan(200)
    }
  })

  it('carries the language switcher in both files, English first', () => {
    for (const { label, dir } of owners) {
      const en = read(join(dir, 'README.md'))
      const zh = read(join(dir, 'README.zh.md'))
      expect(en, `${label}: README.md needs the switcher`).toContain('**English** | [中文](./README.zh.md)')
      expect(zh, `${label}: README.zh.md needs the switcher`).toContain('[English](./README.md) | **中文**')
    }
  })
})

describe('bilingual READMEs — the two agree on shape', () => {
  it('uses the same heading levels in the same order', () => {
    for (const { label, dir } of owners) {
      const en = headingShape(read(join(dir, 'README.md')))
      const zh = headingShape(read(join(dir, 'README.zh.md')))
      expect(zh, `${label}: heading structure drifted`).toBe(en)
      expect(en.length, `${label}: no headings found`).toBeGreaterThan(0)
    }
  })

  it('keeps every fenced code block byte-identical apart from its comments', () => {
    for (const { label, dir } of owners) {
      const en = fencedBlocks(read(join(dir, 'README.md'))).map(commandLines)
      const zh = fencedBlocks(read(join(dir, 'README.zh.md'))).map(commandLines)
      expect(zh, `${label}: commands inside code blocks drifted`).toEqual(en)
    }
  })

  it('never translates an inline code span or a link target', () => {
    for (const { label, dir } of owners) {
      const en = read(join(dir, 'README.md'))
      const zh = read(join(dir, 'README.zh.md'))
      const zhCode = inlineCode(zh)
      for (const span of inlineCode(en)) {
        expect(zhCode.has(span), `${label}: inline code ${JSON.stringify(span)} was translated or dropped`).toBe(true)
      }
      // The switcher is the one place the two files legitimately link to
      // DIFFERENT targets (each points at the other), so it is excluded.
      const zhLinks = linkTargets(withoutSwitcher(zh))
      for (const target of linkTargets(withoutSwitcher(en))) {
        expect(zhLinks.has(target), `${label}: link target ${JSON.stringify(target)} was translated or dropped`).toBe(true)
      }
    }
  })

  it('publishes both files, so the Chinese README reaches npm', () => {
    for (const { label, dir } of owners) {
      const manifest = join(dir, 'package.json')
      if (!existsSync(manifest)) continue
      const files: unknown = JSON.parse(read(manifest)).files
      if (!Array.isArray(files)) continue
      expect(files, `${label}: package.json must publish README.md`).toContain('README.md')
      expect(files, `${label}: package.json must publish README.zh.md`).toContain('README.zh.md')
    }
  })
})

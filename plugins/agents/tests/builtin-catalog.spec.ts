/**
 * Integration check for the package's own built-in catalog.
 *
 * The unit suites validate the loader against synthetic fixtures. This one runs
 * it against the files that actually ship, so a typo in `catalog/*.yaml` or a
 * persona that drifts from the §5.3 skeleton fails here rather than at a user's
 * first startup.
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'

import { loadCatalog } from '../catalog.js'
import { TOOL_CAPABILITIES } from '../schema.js'
import { CAPABILITY_TOOLS } from '../tool-surface.js'
import { goldensWritable, normalizeNewlines, rewriteGoldenValues, specSource, updateGoldens } from './golden-writer.js'

const pluginRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const builtinDir = join(pluginRoot, 'catalog')

const scratch: string[] = []
function emptyRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'banbo-builtin-'))
  scratch.push(root)
  mkdirSync(join(root, 'prompts'), { recursive: true })
  return root
}
afterEach(() => {
  while (scratch.length > 0) rmSync(scratch.pop()!, { recursive: true, force: true })
})

/** Load the shipped catalog against an empty user layer. */
function loadBuiltin() {
  return loadCatalog({ rootDir: emptyRoot(), builtinDir })
}

/** A heading the scanner found, with the text a reader (and the model) sees. */
type ScannedHeading = {
  /** 0-based line index of the heading's first line (the paragraph start for Setext). */
  index: number
  level: number
  kind: 'atx' | 'setext' | 'html'
  text: string
  /**
   * Every normalized form of the title a reader could take for the same heading.
   * The level is DELIBERATELY not part of the key: `## Collaboration Protocol`,
   * `> ## Collaboration Protocol` and a `-`-underlined Setext H2 are the same
   * words to a reader as the H1, so they must collide with it (an earlier version
   * exempted ATX H2–H6 and the reviewer walked straight through that hole).
   */
  keys: string[]
  line: string
}

/**
 * Characters that render as nothing and must not be able to hide or split a title.
 *
 * Unicode's own \`Default_Ignorable_Code_Point\` — a hand-written BMP list missed
 * U+034F (combining grapheme joiner), U+180B–U+180E and the supplementary-plane
 * variation selectors U+E0100…, each of which was demonstrated to slip a heading
 * past the key.
 */
const DEFAULT_IGNORABLE = /\p{Default_Ignorable_Code_Point}/gu

/** Raw HTML headings are real headings: `<h1>…</h1>`, attributes and line breaks allowed. */
const HTML_HEADING_OPEN = /^ {0,3}<h([1-6])(?:[ \t][^>]*)?>/i
const HTML_HEADING_CLOSE = /<\/h[1-6]>/i

/** ATX: 1–6 `#`, 0–3 leading spaces, optional closing `#` sequence. */
const ATX_HEADING = /^ {0,3}(#{1,6})(?:$|[ \t]+(.*)$)/

/** Setext underline: `=+` (level 1) or `-+` (level 2), 0–3 leading spaces. */
const SETEXT_UNDERLINE = /^ {0,3}(=+|-+)[ \t]*$/

/**
 * An indented code block line: four or more columns (after tab expansion) followed
 * by content. Shared by the guard and the scanner, because a line like this used
 * to be collected into a Setext paragraph — `    opaque` + `Collaboration
 * Protocol` + `===` then read as ONE heading whose text was not the canonical
 * title, hiding a real `<h1>Collaboration Protocol</h1>`.
 */
const INDENTED_CODE = /^ {4,}\S/

/** The named entities a persona could plausibly use; numeric ones are decoded too. */
const NAMED_ENTITIES: Record<string, string> = { nbsp: '\u00a0', amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }

function decodeEntities(value: string): string {
  return value.replace(/&(#[0-9]+|#x[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]*);/g, (match, body: string) => {
    if (body.startsWith('#x') || body.startsWith('#X')) {
      const code = Number.parseInt(body.slice(2), 16)
      return Number.isFinite(code) ? String.fromCodePoint(code) : match
    }
    if (body.startsWith('#')) {
      const code = Number.parseInt(body.slice(1), 10)
      return Number.isFinite(code) ? String.fromCodePoint(code) : match
    }
    return NAMED_ENTITIES[body.toLowerCase()] ?? match
  })
}

/**
 * The plain text of a heading, as a reader (and a model) ends up seeing it:
 * comments gone, link/image markup reduced to its label, raw HTML (including
 * `<span>` and `<wbr>`) dropped, emphasis and code markers dropped, entities
 * decoded, and every `separator`-class character — whitespace, and the invisible
 * class — reduced to one space. Case-folded, NFKC, trimmed.
 *
 * `separator` is a parameter because "invisible" is ambiguous in the direction
 * that matters: deleting `&#8203;` keeps `Collaboration&#8203;Protocol` joined,
 * while turning it into a space keeps `Collaboration Protocol` split. Both
 * policies are checked (see `headingTextKeys`), so neither can hide a shadow.
 */
function headingKeyWith(text: string, separator: string): string {
  return decodeEntities(
    text
      .replace(/<!--[\s\S]*?-->/g, separator)
      .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
      .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
      .replace(/<wbr\s*\/?>/gi, separator)
      .replace(/<[^>]*>/g, separator)
      .replace(/[*_`~]/g, ''),
  )
    // AFTER decoding: `&#8203;` only becomes a ZWSP here, and an invisible
    // character that arrived as an entity must be stripped like a literal one
    // (before this fix `# Collaboration&#8203; Protocol` slipped through).
    .replace(DEFAULT_IGNORABLE, separator)
    .replace(/\s+/g, ' ')
    .trim()
    .normalize('NFKC')
    .toLowerCase()
}

/**
 * Every form of a heading text a reader could take for the same heading.
 *
 * The cross product of two ambiguities: an HTML comment can contribute nothing
 * (`# Collaboration <!-- Protocol -->` renders as "Collaboration") or its words
 * can read as part of the title; and an invisible character can be dropped or act
 * as a space. Four keys at most, deduplicated.
 */
function headingTextKeys(text: string): string[] {
  return [...new Set([text, text.replace(/<!--|-->/g, '')].flatMap((variant) => [headingKeyWith(variant, ' '), headingKeyWith(variant, '')]))]
}

/** CommonMark tab stops: a tab advances to the next multiple of four columns. */
function detab(line: string): string {
  let expanded = ''
  for (const character of line) expanded += character === '\t' ? ' '.repeat(4 - (expanded.length % 4)) : character
  return expanded
}

/** Strip blockquote and list-item container prefixes before heading detection. */
function stripContainers(line: string): string {
  let rest = line
  for (;;) {
    const next = rest
      .replace(/^ {0,3}>[ \t]?/, '')
      .replace(/^ {0,3}(?:[-*+]|\d{1,9}[.)])[ \t]+/, '')
    if (next === rest) return rest
    rest = next
  }
}

/**
 * A BARE list marker on its own line (`+`, `*`, `1.`). In CommonMark that is an
 * empty list-item block of its own, so the NEXT line starts fresh — but the
 * extractor used to collect it into a following Setext paragraph, making the
 * heading text `+\nCollaboration Protocol` and hiding a real same-named `<h1>`.
 *
 * A run of `-` is excluded on purpose: it is a legitimate Setext underline, so
 * the underline check wins and this predicate stays false for `-`, `---`, `----`.
 */
const BARE_LIST_MARKER = /^ {0,3}(?:[*+-]|\d{1,9}[.)])[ \t]*$/
const isBareListMarker = (line: string): boolean => !SETEXT_UNDERLINE.test(line) && BARE_LIST_MARKER.test(line)

/**
 * A fenced code block opener (` ``` ` or `~~~`, 0–3 leading spaces). Matched on a
 * CONTAINER-STRIPPED line, so `> ``` ` and `> > ~~~` count too: a fence hides a
 * `# …` line from the extractor, and quoting it changed nothing in CommonMark.
 */
const FENCE_LINE = /^ {0,3}(?:```|~~~)/

/**
 * The block-start WHITELIST. The personas only ever need blank lines, paragraph
 * text lines, ATX headings and list items (plus their continuations), so every
 * OTHER CommonMark block start is refused. CommonMark's block constructs are a
 * FINITE enumeration — that is why the gate can stop here instead of chasing
 * "one more category" forever: thematic break, fenced code, indented code, HTML
 * block, link reference definition, block quote and (GFM) table are the rest.
 */
const LIST_ITEM = /^ {0,3}(?:[*+-]|\d{1,9}[.)])(?:[ \t]+|$)/
/** A thematic break: `***`, `---` or `___`, three or more, spaces allowed. */
const THEMATIC_BREAK = /^ {0,3}(?:(?:\*[ \t]*){3,}|(?:_[ \t]*){3,}|(?:-[ \t]*){3,})$/
/** A `-` run, the one thematic break that can also be a Setext underline. */
const DASH_RUN = /^ {0,3}-+[ \t]*$/
/** Block quote. */
const BLOCK_QUOTE = /^ {0,3}>/
/** HTML block start (CommonMark conditions 1–7, approximated by a leading tag-ish `<`). */
const HTML_BLOCK_START = /^ {0,3}<[a-zA-Z!/?]/
/** Link reference definition. */
const LINK_REFERENCE_DEFINITION = /^ {0,3}\[[^\]]*\]:/
/** GFM table: a delimiter row, or a row that starts with `|`. */
const TABLE_DELIMITER = /^ {0,3}\|?[ \t]*:?-+:?[ \t]*(?:\|[ \t]*:?-+:?[ \t]*)*\|?[ \t]*$/
const TABLE_ROW = /^ {0,3}\|/

/** Does this line START a block the scanner must treat as a boundary? */
function startsBlock(line: string): boolean {
  return line.trim() === ''
    || SETEXT_UNDERLINE.test(line)
    || FENCE_LINE.test(line)
    || INDENTED_CODE.test(line)
    || LIST_ITEM.test(line)
    || ATX_HEADING.test(line)
    || HTML_HEADING_OPEN.test(line)
    || BLOCK_QUOTE.test(line)
    || HTML_BLOCK_START.test(line)
    || LINK_REFERENCE_DEFINITION.test(line)
    || TABLE_DELIMITER.test(line)
    || TABLE_ROW.test(line)
    || THEMATIC_BREAK.test(line)
}

/**
 * Every heading in `text`, with level, kind and rendered text.
 *
 * ONE scanner for BOTH jobs — the equivalent-shadow check and the section
 * boundary — because two rules let a shadow sit outside the golden unnoticed.
 *
 * This is a hand-written extractor, NOT a CommonMark parser: the repository
 * declares no Markdown dependency (`markdown-it` is only a transitive package in
 * `node_modules`), and adding one is a decision for the maintainer, not for a
 * test helper. It covers the constructs that were demonstrated to slip past the
 * ATX-only version: ATX at ANY level (0–3 leading spaces, closing `#`s), multi-line
 * Setext (`=` level 1, `-` level 2), raw HTML headings `<h1>`–`<h6>` (attributes
 * and line breaks included), and all of them inside blockquotes / list items.
 *
 * NOT covered, stated plainly in §14.1 item 17 / §16.16: fenced and indented code
 * blocks (a `#` line inside one is treated as a heading — the personas carry no
 * fences, and any drift shows up as a golden mismatch first), headings inside
 * other HTML blocks, reference-style link definitions, tables/other extensions,
 * and any construct a real CommonMark parser would normalize differently.
 */
function scanHeadings(text: string): ScannedHeading[] {
  // CRLF and lone CR are line endings too: without this a CRLF Setext pair stays
  // one "line" and a lone-CR pair is not split at all, while CommonMark reads both
  // as a real `<h1>` carrying the canonical title.
  const lines = normalizeNewlines(text).split('\n')
  const raws = lines.map((line) => detab(line))
  const contents = raws.map(stripContainers)
  /**
   * Is this line a paragraph line — or does EITHER form start a block?
   *
   * The raw form matters: `- Collaboration Protocol` stripped is a harmless
   * paragraph line, but the MARKER is a block boundary, and without it the contents
   * of two adjacent list items merged into one Setext paragraph (`opaque` +
   * `Collaboration Protocol` + `===`), hiding a real same-named `<h1>` inside the
   * second item.
   */
  const boundary = (at: number): boolean => startsBlock(raws[at]!) || startsBlock(contents[at]!)
    || isBareListMarker(raws[at]!) || isBareListMarker(contents[at]!)
  const headings: ScannedHeading[] = []
  const push = (index: number, level: number, kind: ScannedHeading['kind'], raw: string): void => {
    headings.push({ index, level, kind, text: raw, keys: headingTextKeys(raw), line: lines[index]! })
  }
  for (let index = 0; index < lines.length; index += 1) {
    const content = contents[index]!
    const atx = ATX_HEADING.exec(content)
    if (atx !== null) {
      push(index, atx[1]!.length, 'atx', (atx[2] ?? '').replace(/[ \t]+#+[ \t]*$/, ''))
      continue
    }
    const html = HTML_HEADING_OPEN.exec(content)
    if (html !== null) {
      // The closing tag may be on a later line: raw HTML headings may span lines.
      let cursor = index
      let inner = content.slice(html[0].length)
      while (!HTML_HEADING_CLOSE.test(inner) && cursor + 1 < lines.length) {
        cursor += 1
        inner += `\n${contents[cursor]!}`
      }
      push(index, Number(html[1]), 'html', inner.replace(HTML_HEADING_CLOSE, ''))
      index = cursor
      continue
    }
    if (content.trim() === '' || SETEXT_UNDERLINE.test(content)) continue
    // A non-paragraph block start ends the Setext candidate right here — on EITHER
    // form of the line, so a list marker cannot be swallowed: indented code, a bare
    // list marker, a list item, a fence, a thematic break, a block quote, an HTML
    // block, a table, a link reference definition.
    if (boundary(index)) continue
    // A paragraph, then its underline: a Setext heading takes the WHOLE paragraph,
    // so a title broken across lines (`Collaboration\nProtocol\n======`) is one
    // heading rather than three paragraph lines.
    let cursor = index
    const paragraph: string[] = []
    while (cursor < lines.length && !boundary(cursor)) {
      paragraph.push(contents[cursor]!)
      cursor += 1
    }
    const underline = cursor < lines.length ? SETEXT_UNDERLINE.exec(contents[cursor]!) : null
    if (underline !== null && paragraph.length > 0) {
      push(index, underline[1]!.startsWith('=') ? 1 : 2, 'setext', paragraph.join('\n'))
    }
    if (paragraph.length > 0) index = cursor - 1
  }
  return headings
}

/**
 * The entities the extractor resolves. Anything else — `&Tab;`, `&ensp;`,
 * `&NewLine;`, an upper-case hex escape like `&#X20;` — is REFUSED rather than
 * silently left as literal text, because a heading could then differ from the
 * protected one only by an entity nobody normalizes.
 */
const SUPPORTED_ENTITY = /^&(?:#[0-9]+|#x[0-9a-f]+|nbsp|amp|lt|gt|quot|apos);$/

/** A tag with a quoted attribute holding `>`: `<span title=">">`, the parser traps. */
const TAG_WITH_QUOTED_ANGLE = /<\s*[a-zA-Z][a-zA-Z0-9-]*\s[^<>]*=\s*(?:"[^"]*>|'[^']*'>)/

/**
 * Is this heading text inside the SUPPORTED SUBSET?
 *
 * This is a POSITIVE grammar, in the spirit of "fail closed on anything the
 * extractor cannot reliably normalize" — not a denylist of known-bad shapes (that
 * denylist was walked through four times: a CGJ entity, an escaped `)` in a link
 * destination, a quoted `>` split across lines, a tab-indented continuation).
 * Supported inline content is exactly:
 *
 *  - ordinary characters, emphasis / code markers (which the key drops);
 *  - entities in `SUPPORTED_ENTITY`;
 *  - inline links in the SIMPLE form `[label](destination)`, where the destination
 *    has no whitespace, `(`, `)`, `\`, `<` or `>`.
 *
 * Everything else returns the offending construct.
 */
function unsupportedHeadingSyntax(text: string): string | undefined {
  if (/[<>]/.test(text)) return 'a raw HTML tag or an angle bracket in a heading'
  if (/\\[!-/:-@[-`{-~]/.test(text)) return 'a backslash escape in a heading'
  // Images FIRST: `![alt](dest)`, `![alt](dest "title")`, reference-style
  // `![alt][label]` / `![alt][]` / `![alt]`, an image nested in a link
  // `[![alt](d)](d2)`, and data-URI destinations are all refused. The alt text and
  // what a consumer renderer puts in `textContent` are not the same string
  // everywhere, and the extractor cannot normalize that away — a heading must be
  // plain text. (Checked before the reference-link rule so `![alt][label]` reports
  // the image, not the link.)
  if (/!\[/.test(text)) {
    return 'an image inside a heading — inline image semantics (alt text vs DOM textContent) are not normalized reliably; write the heading as plain text'
  }
  if (/\[[^\]]*\](?!\()/.test(text)) return 'a reference-style link inside a heading'
  for (const match of text.matchAll(/\]\(/g)) {
    const destination = text.slice(match.index + 2)
    if (!/^[^\s()\\<>]+\)/.test(destination)) {
      return 'a link destination (or title) the extractor cannot parse reliably: escapes, parentheses, angle brackets or a title'
    }
  }
  return undefined
}

/**
 * FAIL CLOSED. `name` is refused when the persona contains Markdown this
 * hand-written extractor cannot normalize reliably — anything outside the
 * supported subset above, plus heading-shaped lines a real CommonMark parser
 * would NOT read as headings. The message names the file, the construct, the
 * offending line and the remedy.
 */
function assertNoUnsupportedMarkdown(rawText: string, name: string): void {
  // Same line endings as the scanner and the extractor (CRLF / lone CR → LF).
  const text = normalizeNewlines(rawText)
  const refuse = (construct: string, line: string): never => {
    throw new Error(
      `${name} uses Markdown the heading gate cannot normalize reliably (${construct}): ${JSON.stringify(line)} — simplify the markup, or extend the extractor in builtin-catalog.spec.ts`,
    )
  }
  // WHITELIST: blank lines, paragraph text lines, ATX headings and list items (with
  // their continuations) are what a persona may be made of. Every other CommonMark
  // block start is refused — the checks below are the COMPLETE enumeration of block
  // constructs CommonMark defines, which is why this gate terminates instead of
  // acquiring "one more category" forever.
  let previousLineIsText = false
  let previousRawIsListItem = false
  for (const rawLine of text.split('\n')) {
    // Tabs are expanded first (CommonMark tab stops), so a tab-indented
    // continuation cannot hide a heading behind `^ {4,}`.
    const line = detab(rawLine)
    // Block-level rules run on the line AND on its container-stripped form: a
    // blockquote or list prefix must not smuggle an unsupported block past them
    // (`> ``` ', `> > ~~~` — the "container prefix × unsupported block" class).
    const stripped = stripContainers(line)
    const candidates = stripped === line ? [line] : [line, stripped]
    for (const candidate of candidates) {
      if (FENCE_LINE.test(candidate)) {
        refuse('a fenced code block (also when quoted or nested: a `# …` line inside it would be read as a heading)', candidate)
      }
      if (HTML_BLOCK_START.test(candidate)) {
        refuse('an HTML block (a line that starts with a tag, `<!--`, `<!` or `<?`) — the gate does not parse raw HTML', candidate)
      }
      if (BLOCK_QUOTE.test(candidate)) refuse('a block quote (the whitelist is blank lines, paragraphs, ATX headings and list items)', candidate)
      if (LINK_REFERENCE_DEFINITION.test(candidate)) refuse('a link reference definition (a block of its own, and the extractor does not resolve references)', candidate)
      if (TABLE_DELIMITER.test(candidate) || TABLE_ROW.test(candidate)) {
        refuse('a GFM table (a delimiter row, or a row that starts with `|`) — outside the supported subset', candidate)
      }
      if (THEMATIC_BREAK.test(candidate) && !(DASH_RUN.test(candidate) && previousLineIsText)) {
        refuse('a thematic break (`***`, `---` or `___` on its own line) — only a Setext underline is allowed, and it must directly follow a paragraph line', candidate)
      }
      if (/^ {4,}\S/.test(candidate)) {
        refuse('an indented code block line (four or more columns after tab expansion) — it is not a heading, and it used to be merged into a following Setext title', candidate)
      }
      // Setext underline first: a run of `-` is a legitimate underline, not an empty
      // list item. `+`, `*` and `1.` on their own line are list blocks of their own.
      if (isBareListMarker(candidate)) {
        refuse('a bare list-item marker (an empty list item: `+`, `*` or `1.` alone on a line) — it is a block of its own and used to be merged into a following Setext title', candidate)
      }
      if (/\|/.test(candidate) && /(?:^|\|)[ \t]*#{1,6}[ \t]/.test(candidate)) refuse('a table cell that starts like an ATX heading', candidate)
      if (/<\/?h[1-6](?![a-zA-Z0-9])/i.test(candidate)) refuse('a raw HTML heading (any form: nested, multi-line, unclosed, with attributes; container prefixes included)', candidate)
      if (TAG_WITH_QUOTED_ANGLE.test(candidate)) refuse('a raw HTML tag whose quoted attribute contains ">"', candidate)
    }
    // A Setext heading INSIDE a list item: the marker width, the content indentation
    // and lazy continuation decide where the item ends, and the extractor cannot
    // normalize that combination — so fail closed instead of merging the item bodies
    // of two adjacent items into one title.
    if (SETEXT_UNDERLINE.test(stripped) && previousRawIsListItem) {
      refuse('a Setext heading inside a list item (a `===` / `---` underline whose preceding line starts a list item) — the container × Setext combination cannot be normalized reliably', line)
    }
    // Context for the Setext `---` exception: only a plain paragraph line can be
    // underlined, so `- opaque` + `---` is a thematic break, not an underline.
    previousLineIsText = !startsBlock(stripped) && stripped.trim() !== ''
    previousRawIsListItem = LIST_ITEM.test(line)
  }
  for (const match of text.matchAll(/&[a-zA-Z0-9#]+;/g)) {
    if (!SUPPORTED_ENTITY.test(match[0])) refuse('an entity the extractor does not resolve', match[0])
  }
  for (const found of scanHeadings(text)) {
    const unsupported = unsupportedHeadingSyntax(found.text)
    if (unsupported !== undefined) refuse(unsupported, found.line)
  }
}

/**
 * Body text of one `# Heading` section, trimmed, up to the next level-1 heading.
 *
 * Rules:
 *
 *  1. the canonical heading must match one WHOLE line exactly and appear exactly
 *     ONCE — a lenient `line.trim() === heading` match used to disagree with the
 *     §5.3 skeleton test, so a heading with a trailing space (or a duplicated
 *     heading) could make the golden read a different section than the skeleton
 *     validated (D12-X2);
 *  2. NO heading may reuse another heading's rendering key, at ANY level: a
 *     shadow `## Collaboration Protocol`, `> ## Collaboration Protocol`, a
 *     `-`-underlined Setext H2, `<h1>Collaboration Protocol</h1>`, a link, a
 *     `<span>`, a different case or an embedded invisible character are all the
 *     same words to a reader as the protected H1, so they are refused. The
 *     canonical section is STILL the only thing goldenized;
 *  3. the section ends at the next LEVEL-1 heading in any spelling — ATX with
 *     leading spaces, multi-line Setext H1, raw HTML `<h1>`, blockquote- or
 *     list-wrapped — otherwise a shadow heading would be swallowed into the
 *     canonical body instead of being seen.
 */
function sectionBody(rawText: string, heading: string): string {
  // One notion of "a line" for the whole gate: the whole-line regex, the line
  // numbers and the body boundary all work on normalized line endings, so a CRLF
  // or lone-CR persona is extracted exactly like an LF one.
  const text = normalizeNewlines(rawText)
  const matches = [...text.matchAll(new RegExp(`^${heading.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'gm'))]
  if (matches.length !== 1) throw new Error(`"${heading}" must appear exactly once as a whole line, found ${matches.length}`)
  const scanned = scanHeadings(text)
  const seen = new Map<string, string>()
  for (const found of scanned) {
    for (const key of found.keys) {
      if (key === '') continue
      const previous = seen.get(key)
      if (previous !== undefined) {
        throw new Error(`the heading "${found.line}" renders as "${key}", already used by "${previous}"; an equivalent shadow of a protected section sits outside the golden and is refused`)
      }
      seen.set(key, found.line)
    }
  }
  const lines = text.split('\n')
  const start = text.slice(0, matches[0]!.index!).split('\n').length - 1
  const boundaries = new Set(scanned.filter((found) => found.level === 1).map((found) => found.index))
  const body: string[] = []
  for (let index = start + 1; index < lines.length; index += 1) {
    if (boundaries.has(index)) break
    body.push(lines[index]!)
  }
  return body.join('\n').trim()
}

/** §5.3 fixes these headings and their order so persona lint is mechanical. */
const REQUIRED_HEADINGS = [  '# Role',
  '# Responsibilities',
  '# Non-goals',
  '# Tool Policy',
  '# Delegation Policy',
  '# Collaboration Protocol',
  '# Output Contract',
  '# Failure Policy',
]

// D12-GOLDEN-BEGIN (generated: keep in sync with the personas)
/**
 * §5.4 D12 — one canonical text PER PERSONA, generated from the shipped files.
 *
 * The unit is a whole SECTION, taken by heading boundary and never by keyword:
 * the `# Delegation Policy` body of a main persona, the `# Collaboration
 * Protocol` body of a continuable child persona (role lead-in included, because
 * that is part of what the model reads). Two bypasses died to that choice, both
 * proven by controlled experiment: parking a canonical copy in an HTML comment
 * while an amended rule stayed live, and appending a creation permission between
 * a child's lead-in and the shared rule. With a section boundary there is nowhere
 * to hide — a comment inside the section is part of the unit, and so is the
 * lead-in.
 *
 * Cost, stated plainly: changing the wording of D12 REQUIRES regenerating these
 * constants in the same commit:
 *
 *   env NODE_ENV=development pnpm run test:agents:update-goldens
 *
 * See §14.1 item 17 and §16.16.
 */
const D12_BANBO_MAIN = "- 按**产出性质**选专家，而不是按任务大小：\n  - 审查、风险与覆盖评估、方案挑错 → `agent_review`\n  - 修改代码 → `agent_implement`\n  - 查外部资料与背景 → `agent_research`\n  - 定位本地实现 → `agent_explorer`\n  - 拆解任务、长期协调一个子项目 → `agent_planner`\n  - 跑命令、验证、机械性小改动 → `agent_executor`\n- **同一件事只有一种做法：要么你自己做完，要么派出去——不许既派出去、又自己再做一遍。** 派出去之后，你在这件事上的工作只剩：写清 prompt、等结果、判断、合并、向用户汇报。\n- 你的本职是子 Agent 做不了的事：跨结果判断、取舍、与用户沟通、给出最终结论。子 Agent 已经覆盖的范围里不要重复劳动。\n- 前台是默认：下一步依赖子结果，或会改同一文件时，前台等待。\n- 用后台有两种正当理由，**只有两种**：\n  - **你手上有与它完全无关的事要做**——那就在等它的同时把那件事做掉；\n  - **你手上一件别的事都没有，就是在等它**——那就**直接结束本轮**，让它的消息把你唤醒。**空手结束本轮去等，是正确做法，不是失败。**\n- **不要自己发明\"等\"**：没有 wait 调用，用 shell `sleep` 等待也不算等待。子 Agent 的消息（`send_message` 投递的内容和结算通知）**会唤醒你开新一轮**，你不需要盯着它。\n- 结束本轮前要么已经拿到结论，要么**明确说明你在等谁的消息、等它做什么**。\n- **\"我自己也把它做一遍\"永远不是并行的理由。**\n- **默认复用**：同角色 child 可能 idle、可能还在跑，也可能压根没有——**新建同角色 child 前先用 `list_agents` 查一眼**：有 idle 的 continuable 同角色 child 就用 `send_message` 追加新活（不要重复委派），有多个 idle 候选时**选上下文最接近这次任务的那个**。只要**存在同角色 child（idle 或正在跑）而仍要另起一个**，就必须说得出理由——命中的是**四种例外**中的哪一种：**任务无关**（新活与那个 child 的工作无关——不是同一份工作、同一 MR、同一模块，也不是上一轮的延续）、**上下文拖累**（已有 child 上下文太长或被污染，接活效果更差）、**需要隔离**（要一个不带着旧上下文的干净 child）、**上一轮没交出结论**（失败、被中断或超时——没拿到结论的那次委派要**重新委派**，但不必复用那个 idle child，它的上下文不可信）。\n- 同角色 child 正在跑、又来了一件同类的活（同一份工作、同一 MR、同一模块，或上一轮的延续）：**既不新建、也不干等**——把新活并成同一件事，等它这一轮的唤醒消息到达后，用**一次** `send_message` 追加给它。**正在跑但与新活无关**（不是同一份工作、同一 MR、同一模块，也不是上一轮的延续）时才可以另起一个，并说明命中的例外。\n- 多个互不依赖的 one-shot 结果都返回后才能继续时，用 `delegate_batch`。batch 不接受需要保留对话的 Agent。\n- 委派给 `agent_review` 时**不要把你自己的结论写进 prompt**：让它从原始材料（diff、文件、命令输出）独立判断。要它验证某个假设，就把假设写成**待验证的问题**，而不是\"我已确认 X\"。喂结论只会换来一个橡皮图章。"
const D12_PLANNER_MAIN = "- 先理解任务，再决定自己规划、单个委派、用 `delegate_batch` 并行，还是复用已有 continuable 子 Agent。\n- **默认复用**：同角色 child 可能 idle、可能还在跑，也可能压根没有——**新建同角色 child 前先用 `list_agents` 查一眼**：有 idle 的 continuable 同角色 child 就用 `send_message` 追加新活（不要重复委派），有多个 idle 候选时**选上下文最接近这次任务的那个**。只要**存在同角色 child（idle 或正在跑）而仍要另起一个**，就必须说得出理由——命中的是**四种例外**中的哪一种：**任务无关**（新活与那个 child 的工作无关——不是同一份工作、同一 MR、同一模块，也不是上一轮的延续）、**上下文拖累**（已有 child 上下文太长或被污染，接活效果更差）、**需要隔离**（要一个不带着旧上下文的干净 child）、**上一轮没交出结论**（失败、被中断或超时——没拿到结论的那次委派要**重新委派**，但不必复用那个 idle child，它的上下文不可信）。\n- 同角色 child 正在跑、又来了一件同类的活（同一份工作、同一 MR、同一模块，或上一轮的延续）：**既不新建、也不干等**——把新活并成同一件事，等它这一轮的唤醒消息到达后，用**一次** `send_message` 追加给它。**正在跑但与新活无关**（不是同一份工作、同一 MR、同一模块，也不是上一轮的延续）时才可以另起一个，并说明命中的例外。\n- 需要外部资料时委派 `agent_research`，需要摸清本地结构时委派 `agent_explorer`，需要独立计划审查时委派 `agent_review`。当 `remainingDepth` 为 0 时不再看见任何 `agent_*` 工具。\n- **同一件事只有一种做法：要么你自己做完，要么派出去——不许既派出去、又自己再做一遍。** 派出去之后你在这件事上的工作只剩：写清 prompt、等结果、判断、合并、汇报。\n- 你的本职是子 Agent 做不了的事：跨结果判断、取舍、给出最终计划。子 Agent 已经覆盖的范围里不要重复劳动。\n- 前台是默认：下一步依赖子结果时前台等待。\n- 用后台有两种正当理由，**只有两种**：**你手上有与它完全无关的事要做**（那就边等边做掉）；或者**你一件别的事都没有、就是在等它**（那就**直接结束本轮**，让它的消息把你唤醒）。**空手结束本轮去等，是正确做法，不是失败。**\n- **不要自己发明\"等\"**：没有 wait 调用，用 shell `sleep` 等待也不算等待。子 Agent 的消息（`send_message` 投递的内容和结算通知）**会唤醒你开新一轮**，你不需要盯着它。\n- 结束本轮前要么已经拿到结论，要么**明确说明你在等谁的消息、等它做什么**。\n- **\"我自己也把它做一遍\"永远不是并行的理由。**\n- 委派给 `agent_review` 时**不要把你自己的结论写进 prompt**：让它从原始材料（diff、文件、命令输出）独立判断。要它验证某个假设，就把假设写成**待验证的问题**，而不是\"我已确认 X\"。喂结论只会换来一个橡皮图章。\n- `delegate_batch` 只用于相互独立的 one-shot 任务；需要保留上下文时使用单个具名委派。\n- 并发超限时减少 batch、复用已有 child 或向用户说明下一步，不静默排队。"
const D12_PLANNER_CHILD = "有阻塞或需要澄清时，把问题写进最终回答交给父 Agent。用 `list_agents` 在**新建同角色 child 前先查一眼**，其余时候只在\"我要复用某个 child 的上下文\"时查一次——**不是进度轮询工具**，子 Agent 运行期间不要反复查询。同角色 child 可能 idle、可能还在跑，也可能压根没有：有 idle 的 continuable 同角色 child 就用 `send_message` 追加新活——**默认复用**；有多个 idle 候选时**选上下文最接近这次任务的那个**。只要**存在同角色 child（idle 或正在跑）而仍要另起一个**，就必须说得出理由——命中的是**四种例外**中的哪一种：**任务无关**（新活与那个 child 的工作无关——不是同一份工作、同一 MR、同一模块，也不是上一轮的延续）、**上下文拖累**（已有 child 上下文太长或被污染，接活效果更差）、**需要隔离**（要一个不带着旧上下文的干净 child）、**上一轮没交出结论**（失败、被中断或超时——没拿到结论的那次委派要**重新委派**，但不必复用那个 idle child，它的上下文不可信）。同角色 child 正在跑、又来了一件同类的活（同一份工作、同一 MR、同一模块，或上一轮的延续）：**既不新建、也不干等**——把新活并成同一件事，等它这一轮的唤醒消息到达后，用**一次** `send_message` 追加给它。**正在跑但与新活无关**（不是同一份工作、同一 MR、同一模块，也不是上一轮的延续）时才可以另起一个，并说明命中的例外。它显示 `ready` 只说明对方本轮已经结束——**可能成功、也可能失败或被中断**；没收到它的结论，这件事就算没完成：去 `send_message` 要结果、重新委派，或明确说明没拿到，**不许静默跳过**。`send_message` 用于补充信息或继续上下文，不用来轮询或催促。**中断纪律（先问后断）**：只要你要中断任何一个 child，**第一步永远是 `send_message` 问它要一份\"基于你已有证据的结论\"，并等它回复**——父 Agent 要求停止时也一样；拿到回复后再决定是否真的中断。发完消息等几秒、它还没回就中断，不算问过。允许中断的理由只有：它明显跑偏、在重复无效操作、你已从别处拿到足够结论，或父 Agent 要求停止；`interrupt_agent` 只是请求停止，**不把它当作硬杀**；**\"跑得久\"本身不是理由**（审查类任务通常需要数分钟到十几分钟）。中断之后必须在最终回答里说明哪部分没查完。"
const D12_EXECUTOR_CHILD = "发现问题时把它写进最终回答交给父 Agent。用 `list_agents` 在**新建同角色 child 前先查一眼**，其余时候只在\"我要复用某个 child 的上下文\"时查一次——**不是进度轮询工具**，子 Agent 运行期间不要反复查询。同角色 child 可能 idle、可能还在跑，也可能压根没有：有 idle 的 continuable 同角色 child 就用 `send_message` 追加新活——**默认复用**；有多个 idle 候选时**选上下文最接近这次任务的那个**。只要**存在同角色 child（idle 或正在跑）而仍要另起一个**，就必须说得出理由——命中的是**四种例外**中的哪一种：**任务无关**（新活与那个 child 的工作无关——不是同一份工作、同一 MR、同一模块，也不是上一轮的延续）、**上下文拖累**（已有 child 上下文太长或被污染，接活效果更差）、**需要隔离**（要一个不带着旧上下文的干净 child）、**上一轮没交出结论**（失败、被中断或超时——没拿到结论的那次委派要**重新委派**，但不必复用那个 idle child，它的上下文不可信）。同角色 child 正在跑、又来了一件同类的活（同一份工作、同一 MR、同一模块，或上一轮的延续）：**既不新建、也不干等**——把新活并成同一件事，等它这一轮的唤醒消息到达后，用**一次** `send_message` 追加给它。**正在跑但与新活无关**（不是同一份工作、同一 MR、同一模块，也不是上一轮的延续）时才可以另起一个，并说明命中的例外。它显示 `ready` 只说明对方本轮已经结束——**可能成功、也可能失败或被中断**；没收到它的结论，这件事就算没完成：去 `send_message` 要结果、重新委派，或明确说明没拿到，**不许静默跳过**。`send_message` 用于补充信息或继续上下文，不用来轮询或催促。**中断纪律（先问后断）**：只要你要中断任何一个 child，**第一步永远是 `send_message` 问它要一份\"基于你已有证据的结论\"，并等它回复**——父 Agent 要求停止时也一样；拿到回复后再决定是否真的中断。发完消息等几秒、它还没回就中断，不算问过。允许中断的理由只有：它明显跑偏、在重复无效操作、你已从别处拿到足够结论，或父 Agent 要求停止；`interrupt_agent` 只是请求停止，**不把它当作硬杀**；**\"跑得久\"本身不是理由**（审查类任务通常需要数分钟到十几分钟）。中断之后必须在最终回答里说明哪部分没查完。"
const D12_IMPLEMENT_CHILD = "范围冲突或需要产品决策时把问题写进最终回答。用 `list_agents` 在**新建同角色 child 前先查一眼**，其余时候只在\"我要复用某个 child 的上下文\"时查一次——**不是进度轮询工具**，子 Agent 运行期间不要反复查询。同角色 child 可能 idle、可能还在跑，也可能压根没有：有 idle 的 continuable 同角色 child 就用 `send_message` 追加新活——**默认复用**；有多个 idle 候选时**选上下文最接近这次任务的那个**。只要**存在同角色 child（idle 或正在跑）而仍要另起一个**，就必须说得出理由——命中的是**四种例外**中的哪一种：**任务无关**（新活与那个 child 的工作无关——不是同一份工作、同一 MR、同一模块，也不是上一轮的延续）、**上下文拖累**（已有 child 上下文太长或被污染，接活效果更差）、**需要隔离**（要一个不带着旧上下文的干净 child）、**上一轮没交出结论**（失败、被中断或超时——没拿到结论的那次委派要**重新委派**，但不必复用那个 idle child，它的上下文不可信）。同角色 child 正在跑、又来了一件同类的活（同一份工作、同一 MR、同一模块，或上一轮的延续）：**既不新建、也不干等**——把新活并成同一件事，等它这一轮的唤醒消息到达后，用**一次** `send_message` 追加给它。**正在跑但与新活无关**（不是同一份工作、同一 MR、同一模块，也不是上一轮的延续）时才可以另起一个，并说明命中的例外。它显示 `ready` 只说明对方本轮已经结束——**可能成功、也可能失败或被中断**；没收到它的结论，这件事就算没完成：去 `send_message` 要结果、重新委派，或明确说明没拿到，**不许静默跳过**。`send_message` 用于补充信息或继续上下文，不用来轮询或催促。**中断纪律（先问后断）**：只要你要中断任何一个 child，**第一步永远是 `send_message` 问它要一份\"基于你已有证据的结论\"，并等它回复**——父 Agent 要求停止时也一样；拿到回复后再决定是否真的中断。发完消息等几秒、它还没回就中断，不算问过。允许中断的理由只有：它明显跑偏、在重复无效操作、你已从别处拿到足够结论，或父 Agent 要求停止；`interrupt_agent` 只是请求停止，**不把它当作硬杀**；**\"跑得久\"本身不是理由**（审查类任务通常需要数分钟到十几分钟）。中断之后必须在最终回答里说明哪部分没查完。"
const D12_REVIEW_CHILD = "结论与证据一起给。用 `list_agents` 在**新建同角色 child 前先查一眼**，其余时候只在\"我要复用某个 child 的上下文\"时查一次——**不是进度轮询工具**，子 Agent 运行期间不要反复查询。同角色 child 可能 idle、可能还在跑，也可能压根没有：有 idle 的 continuable 同角色 child 就用 `send_message` 追加新活——**默认复用**；有多个 idle 候选时**选上下文最接近这次任务的那个**。只要**存在同角色 child（idle 或正在跑）而仍要另起一个**，就必须说得出理由——命中的是**四种例外**中的哪一种：**任务无关**（新活与那个 child 的工作无关——不是同一份工作、同一 MR、同一模块，也不是上一轮的延续）、**上下文拖累**（已有 child 上下文太长或被污染，接活效果更差）、**需要隔离**（要一个不带着旧上下文的干净 child）、**上一轮没交出结论**（失败、被中断或超时——没拿到结论的那次委派要**重新委派**，但不必复用那个 idle child，它的上下文不可信）。同角色 child 正在跑、又来了一件同类的活（同一份工作、同一 MR、同一模块，或上一轮的延续）：**既不新建、也不干等**——把新活并成同一件事，等它这一轮的唤醒消息到达后，用**一次** `send_message` 追加给它。**正在跑但与新活无关**（不是同一份工作、同一 MR、同一模块，也不是上一轮的延续）时才可以另起一个，并说明命中的例外。它显示 `ready` 只说明对方本轮已经结束——**可能成功、也可能失败或被中断**；没收到它的结论，这件事就算没完成：去 `send_message` 要结果、重新委派，或明确说明没拿到，**不许静默跳过**。`send_message` 用于补充信息或继续上下文，不用来轮询或催促。**中断纪律（先问后断）**：只要你要中断任何一个 child，**第一步永远是 `send_message` 问它要一份\"基于你已有证据的结论\"，并等它回复**——父 Agent 要求停止时也一样；拿到回复后再决定是否真的中断。发完消息等几秒、它还没回就中断，不算问过。允许中断的理由只有：它明显跑偏、在重复无效操作、你已从别处拿到足够结论，或父 Agent 要求停止；`interrupt_agent` 只是请求停止，**不把它当作硬杀**；**\"跑得久\"本身不是理由**（审查类任务通常需要数分钟到十几分钟）。中断之后必须在最终回答里说明哪部分没查完。"

/** Every delegating persona's section, keyed by its persona path. */
const D12_GOLDENS: Record<string, string> = {
  'prompts/banbo-main.md': D12_BANBO_MAIN,
  'prompts/planner-main.md': D12_PLANNER_MAIN,
  'prompts/planner-child.md': D12_PLANNER_CHILD,
  'prompts/executor-child.md': D12_EXECUTOR_CHILD,
  'prompts/implement-child.md': D12_IMPLEMENT_CHILD,
  'prompts/review-child.md': D12_REVIEW_CHILD,
}
// D12-GOLDEN-END

/** Sentinel markers of the generated value lines; each must own its whole line. */
const D12_GOLDEN_BEGIN = '// D12-GOLDEN-BEGIN (generated: keep in sync with the personas)'
const D12_GOLDEN_END = '// D12-GOLDEN-END'

/**
 * Which section carries the rule, per persona. One golden per file because the
 * sections are not interchangeable: the four child personas differ in their role
 * lead-in, and the two main personas carry different delegation policies.
 */
const D12_SECTION_BY_PERSONA: Record<string, string> = {
  'prompts/banbo-main.md': '# Delegation Policy',
  'prompts/planner-main.md': '# Delegation Policy',
  'prompts/planner-child.md': '# Collaboration Protocol',
  'prompts/executor-child.md': '# Collaboration Protocol',
  'prompts/implement-child.md': '# Collaboration Protocol',
  'prompts/review-child.md': '# Collaboration Protocol',
}

/** The constant each persona's golden lives in, so the writer can target it. */
const D12_CONSTANT_BY_PERSONA: Record<string, string> = {
  'prompts/banbo-main.md': 'D12_BANBO_MAIN',
  'prompts/planner-main.md': 'D12_PLANNER_MAIN',
  'prompts/planner-child.md': 'D12_PLANNER_CHILD',
  'prompts/executor-child.md': 'D12_EXECUTOR_CHILD',
  'prompts/implement-child.md': 'D12_IMPLEMENT_CHILD',
  'prompts/review-child.md': 'D12_REVIEW_CHILD',
}

/**
 * The D12 unit of one persona: its whole rule-bearing section body, taken by
 * heading boundary.
 *
 * The anchor uniqueness guard is what makes a shadow copy impossible BEFORE the
 * comparison even runs: if `默认复用` (or the look-ahead phrase) appears twice — the
 * canonical text parked in a comment next to an amended live rule, say — the gate
 * fails loudly instead of silently picking one of the two.
 */
function personaD12SectionFrom(text: string, persona: string): string {
  const heading = D12_SECTION_BY_PERSONA[persona]
  if (heading === undefined) throw new Error(`no D12 section is declared for ${persona}`)
  for (const anchor of ['默认复用', '新建同角色 child 前']) {
    const seen = text.split(anchor).length - 1
    if (seen !== 1) throw new Error(`${persona} carries "${anchor}" ${seen} time(s); the D12 gate requires exactly one, or a copy can shadow the live rule`)
  }
  return sectionBody(text, heading)
}

/** As above, for the shipped file. */
function personaD12Section(persona: string): string {
  return personaD12SectionFrom(readFileSync(join(pluginRoot, persona), 'utf8'), persona)
}

/** Derive every persona's unit; the writer and the gate both use this. */
function personaD12Sections(): Record<string, string> {
  return Object.fromEntries(Object.keys(D12_GOLDENS).map((persona) => [persona, personaD12Section(persona)]))
}

/** The source the writer would produce for these units (pure). */
function d12Source(source: string): string {
  const units = personaD12Sections()
  const fields = Object.entries(units).map(([persona, unit]) => {
    const constant = D12_CONSTANT_BY_PERSONA[persona]
    if (constant === undefined) throw new Error(`no golden constant is declared for ${persona}`)
    return [new RegExp(`^(const ${constant} = )[\\s\\S]*?(?=\\n)`, 'm'), unit] as [RegExp, string]
  })
  return rewriteGoldenValues(source, D12_GOLDEN_BEGIN, D12_GOLDEN_END, fields)
}

describe('built-in catalog loads', () => {
  it('ships exactly the seven documented agents', () => {
    const { definitions } = loadBuiltin()
    expect([...definitions.keys()].sort()).toEqual([
      'banbo', 'executor', 'explorer', 'implement', 'planner', 'research', 'review',
    ])
  })

  it('composes without a user agents/ directory at all', () => {
    // A fresh install has no `$DSH_HOME/banbo-agents/agents/`; that must be an
    // empty layer rather than an error.
    expect(() => loadBuiltin()).not.toThrow()
  })

  it('matches the §5.1 authorisation matrix', () => {
    const { definitions } = loadBuiltin()
    const edges = Object.fromEntries(
      [...definitions.values()].map((definition) => [definition.id, [...definition.allowedChildren].sort()]),
    )
    expect(edges).toEqual({
      banbo: ['executor', 'explorer', 'implement', 'planner', 'research', 'review'],
      planner: ['explorer', 'research', 'review'],
      executor: ['explorer', 'implement', 'research', 'review'],
      implement: ['explorer', 'research'],
      review: ['explorer', 'research'],
      research: [],
      explorer: [],
    })
  })

  it('matches the §5.1 forms, depth caps and continuation modes', () => {
    const { definitions } = loadBuiltin()
    const shape = Object.fromEntries([...definitions.values()].map((definition) => [definition.id, {
      main: definition.main === undefined ? undefined : definition.main.maxDepth,
      child: definition.child === undefined ? undefined : definition.child.continuation,
    }]))
    expect(shape).toEqual({
      banbo: { main: 2, child: undefined },
      planner: { main: 1, child: 'optional' },
      executor: { main: undefined, child: 'optional' },
      implement: { main: undefined, child: 'optional' },
      review: { main: undefined, child: 'optional' },
      research: { main: undefined, child: 'one-shot' },
      explorer: { main: undefined, child: 'one-shot' },
    })
  })

  it('gives every main form a distinct preset id equal to its agent id', () => {
    const { definitions } = loadBuiltin()
    for (const definition of definitions.values()) {
      if (definition.main === undefined) continue
      expect(definition.main.presetId, definition.id).toBe(definition.id)
    }
  })

  it('keeps `goal` and `present` off every child form (§5.2)', () => {
    const { definitions } = loadBuiltin()
    for (const definition of definitions.values()) {
      if (definition.child === undefined) continue
      expect(definition.child.tools, definition.id).not.toContain('goal')
      expect(definition.child.tools, definition.id).not.toContain('present')
    }
  })

  it('keeps shell, write and agent-control away from the one-shot agents (§5.2)', () => {
    const { definitions } = loadBuiltin()
    for (const id of ['research', 'explorer']) {
      const tools = definitions.get(id)!.child!.tools
      expect(tools, id).not.toContain('exec')
      expect(tools, id).not.toContain('write')
      expect(tools, id).not.toContain('edit')
      expect(tools, id).not.toContain('agent-control')
    }
  })

  it('uses only capabilities from the closed set', () => {
    const { definitions } = loadBuiltin()
    for (const definition of definitions.values()) {
      for (const form of [definition.main, definition.child]) {
        for (const capability of form?.tools ?? []) {
          expect(TOOL_CAPABILITIES, `${definition.id}: ${capability}`).toContain(capability)
        }
      }
    }
  })

  it('loads every referenced persona', () => {
    const { personas } = loadBuiltin()
    expect([...personas.keys()].sort()).toEqual([
      'prompts/banbo-main.md',
      'prompts/executor-child.md',
      'prompts/explorer-child.md',
      'prompts/implement-child.md',
      'prompts/planner-child.md',
      'prompts/planner-main.md',
      'prompts/research-child.md',
      'prompts/review-child.md',
    ])
  })

  it('gives every child explicit when-to-use and when-not-to-use guidance', () => {
    const { definitions } = loadBuiltin()
    for (const definition of definitions.values()) {
      if (definition.child === undefined) continue
      expect(definition.child.guidance, `${definition.id} when-to-use`).toMatch(/当.+时使用/)
      expect(definition.child.guidance, `${definition.id} when-not-to-use`).toContain('不要使用')
    }
  })
})

describe('built-in personas follow the §5.3 skeleton', () => {
  const personaFiles = [
    'banbo-main.md',
    'planner-main.md',
    'planner-child.md',
    'executor-child.md',
    'implement-child.md',
    'review-child.md',
    'research-child.md',
    'explorer-child.md',
  ]

  it('refuses Markdown the heading extractor cannot normalize reliably (fail closed)', () => {
    // The repository declares no Markdown parser and adding one is the
    // maintainer's call, so the gate FAILS CLOSED instead of guessing: syntax it
    // cannot normalize reliably turns every persona that uses it red, with a
    // message naming the construct, the line and the remedy (§14.1 item 17).
    for (const name of personaFiles) {
      assertNoUnsupportedMarkdown(readFileSync(join(pluginRoot, 'prompts', name), 'utf8'), name)
    }
  })

  it('carries every required heading exactly once with a non-empty section', () => {
    for (const name of personaFiles) {
      const text = readFileSync(join(pluginRoot, 'prompts', name), 'utf8')
      const positions = REQUIRED_HEADINGS.map((heading) => {
        const matches = [...text.matchAll(new RegExp(`^${heading}$`, 'gm'))]
        expect(matches.length, `${name} must carry "${heading}" exactly once`).toBe(1)
        return matches[0]!.index
      })
      positions.forEach((start, index) => {
        const end = index + 1 < positions.length ? positions[index + 1]! : text.length
        const body = text.slice(start + REQUIRED_HEADINGS[index]!.length, end).trim()
        expect(body.length, `${name} section "${REQUIRED_HEADINGS[index]}" must not be empty`).toBeGreaterThan(0)
      })
    }
  })

  it('mentions only runtime tools its capability set actually grants', () => {
    const { definitions, personas } = loadBuiltin()
    // Distinctive names only: the shared English verbs (`read`, `write`, `edit`,
    // `skill`, `goal`, `present`) would match ordinary prose, so the curated
    // list in the sibling test keeps covering those.
    const ambiguous = new Set(['read', 'write', 'edit', 'skill', 'goal', 'present'])
    const runtimeNames = new Set<string>()
    for (const surface of Object.values(CAPABILITY_TOOLS)) {
      for (const group of [surface.all, surface.prefer, surface.optional]) {
        for (const tool of group ?? []) if (!ambiguous.has(tool)) runtimeNames.add(tool)
      }
    }
    for (const definition of definitions.values()) {
      for (const [form, profile] of [['main', definition.main], ['child', definition.child]] as const) {
        if (profile === undefined) continue
        const visible = new Set<string>()
        for (const capability of profile.tools) {
          const surface = CAPABILITY_TOOLS[capability]!
          for (const group of [surface.all, surface.prefer, surface.optional]) {
            for (const tool of group ?? []) visible.add(tool)
          }
        }
        const text = personas.get(profile.persona)!
        for (const tool of runtimeNames) {
          if (visible.has(tool)) continue
          expect(new RegExp(`\\b${tool}\\b`).test(text), `${definition.id}.${form} persona mentions ungranted tool "${tool}"`).toBe(false)
        }
      }
    }
  })

  it('names no agent_* tool outside its own allowed children', () => {
    const { definitions, personas } = loadBuiltin()
    for (const definition of definitions.values()) {
      for (const [form, profile] of [['main', definition.main], ['child', definition.child]] as const) {
        if (profile === undefined) continue
        const allowed = new Set(definition.allowedChildren.map((child) => `agent_${child}`))
        const text = personas.get(profile.persona)!
        for (const match of text.matchAll(/\bagent_[A-Za-z0-9_]+/g)) {
          expect(allowed.has(match[0]), `${definition.id}.${form} names unknown/unauthorized tool ${match[0]}`).toBe(true)
        }
      }
    }
  })

  it('carries every required heading in the fixed order', () => {
    for (const name of personaFiles) {
      // Prefix a newline so `# Role` as the very first line is matched by the
      // same `\n<heading>\n` pattern as every other heading.
      const text = `\n${readFileSync(join(pluginRoot, 'prompts', name), 'utf8')}`
      const seen = REQUIRED_HEADINGS.map((heading) => text.indexOf(`\n${heading}\n`))
      expect(seen.every((index) => index >= 0), `${name} is missing a required heading`).toBe(true)
      const ordered = [...seen].sort((left, right) => left - right)
      expect(seen, `${name} has headings out of order`).toEqual(ordered)
    }
  })

  it('never promises a capability the tool layer does not have (§5.3)', () => {
    const forbidden = [
      /独立\s*sandbox/,
      /read-only 文件系统/,
      /可靠地?硬杀/,
      /settlement notice 一定已被父模型消费/,
      /主 Agent 可由本插件指定模型/,
      /禁用 Agent 会立即从 picker 消失/,
      /deadline 会硬杀同进程代码/,
    ]
    for (const name of personaFiles) {
      const text = readFileSync(join(pluginRoot, 'prompts', name), 'utf8')
      for (const pattern of forbidden) {
        expect(pattern.test(text), `${name} matches ${String(pattern)}`).toBe(false)
      }
    }
  })

  it('gives every delegating persona the full delegation discipline (§5.4)', () => {
    // A real session showed a coordinator delegating correctly and then doing
    // the same work itself, polling with `list_agents`, and interrupting the
    // reviewer because "it ran too long" — while a child that had DIED on a
    // provider error sat at `ready` unnoticed. Every rule below exists because
    // that session violated it, so each one is pinned to the personas that can
    // delegate. Keep the list mechanical: these are the load-bearing clauses.
    //
    // §16.16 — the D12 goldens below are GENERATED; after an intentional rule
    // change regenerate them with:
    //
    //   env NODE_ENV=development pnpm run test:agents:update-goldens
    //
    // This strict path never writes: `updateGoldens` returns immediately unless
    // `UPDATE_GOLDENS=1` is set, and the assertion right after it proves the
    // block on disk is byte-identical to what the writer emits for the personas
    // as they are NOW — which is also the proof that re-running the writer with
    // no source change is a zero diff.
    updateGoldens(import.meta.url, d12Source)
    expect(d12Source(specSource(import.meta.url)), 'the D12 golden block must be exactly what the writer emits (idempotent regeneration)')
      .toBe(specSource(import.meta.url))
    const { definitions } = loadBuiltin()
    const required = [
      // 1A/1C — one owner per piece of work.
      /不许既派出去、又自己再做一遍/,
      // 2A — background needs an unrelated reason, not "I'll do it too".
      /永远不是并行的理由/,
      // 2C — a background child must be accounted for before the turn ends.
      /结束本轮前要么已经拿到结论/,
      // §16.15 — the POSITIVE rule that was missing: having nothing else to do
      // and simply waiting IS a legitimate reason to background, and ending the
      // turn empty-handed to be woken by the child's message is correct rather
      // than a failure. Without this the persona pushed the model into inventing
      // a wait (`sleep 300` in a real session), because it read "harvest before
      // the turn ends" as "never end the turn without the result".
      /空手结束本轮去等，是正确做法/,
      /会唤醒你开新一轮/,
      /不要自己发明/,
      /用 shell `sleep` 等待也不算等待/,
      // 3A — no status polling.
      /不是进度轮询工具/,
      // 4A — `ready` means the turn ended, NOT that the work is done.
      /没收到它的结论，这件事就算没完成/,
      // 5A — duration is not a reason; reviews legitimately take a while.
      /"跑得久"本身不是理由/,
      /数分钟到十几分钟/,
      // 5B — ask, and WAIT for the reply, before interrupting. The ask must be
      // the FIRST step and must survive an explicit stop order: a real session
      // showed the model reading "stop it" as an immediate order and calling
      // `interrupt_agent` without ever asking the child for what it had, so the
      // clause is no longer allowed to sit mid-paragraph as a trailing detail.
      /第一步永远是 `send_message`/,
      /要求停止时也一样/,
      /并等它回复/,
      /不算问过/,
      // 5C — say what was left unverified.
      /哪部分没查完/,
      // 6 — reuse before create. A real session piled up same-role children
      // because "reuse if you happen to have one" was advice, not a
      // precondition. The look must be stated BEFORE the exception list so the
      // rule cannot be read as "create, unless ..."; the FOUR exceptions are
      // pinned by name so a new child has to argue against four cases. The new
      // fourth one is a child that never produced a conclusion (failed,
      // interrupted, timed out): it is idle, but its context cannot be trusted,
      // so D6's "re-delegate" is allowed to mean a NEW child.
      /默认复用/,
      /新建同角色 child 前/,
      /idle 的 continuable 同角色 child/,
      /选上下文最接近这次任务的那个/,
      /四种例外/,
      /任务无关/,
      /上下文拖累/,
      /需要隔离/,
      /上一轮没交出结论/,
      /说得出理由/,
      /既不新建、也不干等/,
      /唤醒消息到达后/,
    ]
    let checked = 0
    for (const definition of definitions.values()) {
      if (definition.allowedChildren.length === 0) continue
      for (const profile of [definition.main, definition.child]) {
        if (profile === undefined) continue
        const text = readFileSync(join(pluginRoot, profile.persona), 'utf8')
        for (const pattern of required) {
          expect(pattern.test(text), `${definition.id} (${profile.persona}) is missing ${String(pattern)}`).toBe(true)
        }
        // The merge is ONE append, not a stream of nudges: a running same-role
        // child must receive the folded work in a single `send_message` after
        // the wake-up message arrives.
        expect(text, `${definition.id} (${profile.persona}) must append the merged work once`)
          .toContain('用**一次** `send_message` 追加给它')
        // Prominence, not just presence: the ask-first sentence must precede the
        // list of legitimate interrupt reasons. Buried after it, it lost to a
        // direct "stop it" instruction.
        const askAt = text.indexOf('第一步永远是 `send_message`')
        const reasonsAt = text.indexOf('允许中断的理由只有')
        expect(askAt, `${definition.id} (${profile.persona}) must state ask-first before the reasons`).toBeGreaterThanOrEqual(0)
        expect(reasonsAt, `${definition.id} (${profile.persona}) must list the interrupt reasons`).toBeGreaterThan(askAt)
        // Reuse-before-create, by POSITION not presence: the `list_agents` look
        // must be stated before the exception list, otherwise the wording reads
        // as "create a new child unless ..." and the look becomes an optional
        // extra — the same failure mode D9's ask-first clause had.
        const lookAt = text.indexOf('新建同角色 child 前')
        const exceptionAt = text.indexOf('四种例外')
        expect(lookAt, `${definition.id} (${profile.persona}) must state look-before-create`).toBeGreaterThanOrEqual(0)
        expect(exceptionAt, `${definition.id} (${profile.persona}) must list the four exceptions`).toBeGreaterThan(lookAt)
        // The no-conclusion exception must sit INSIDE the closed list, not float
        // as a separate sentence: a loose "you can always start a new one" would
        // reopen the hole the closed set exists to close.
        const noConclusionAt = text.indexOf('上一轮没交出结论')
        expect(noConclusionAt, `${definition.id} (${profile.persona}) must keep the no-conclusion exception inside the list`).toBeGreaterThan(exceptionAt)
        // Canonical equality over the COMPLETE D12 unit — the whole rule-bearing
        // SECTION, taken by heading boundary (never by keyword). Two earlier
        // attempts failed in opposite directions, both proven by controlled
        // experiment: a `新建` word count plus a synonym blacklist was bypassed by
        // "急需时可另起同角色 child。" prefixed to the bullet, and the same count
        // misfired on a PROHIBITION sentence ("同一工作流里绝不应新建重复 child。")
        // which legitimately adds a third 新建. Keyword-based extraction was then
        // bypassed twice more: a canonical copy parked in an HTML comment, and a
        // creation permission inserted before the shared rule's marker. A section
        // boundary leaves nowhere to hide — the lead-in and any comment inside the
        // section are part of the unit — so this compares the whole section body
        // against its golden, and the derivation refuses a duplicated anchor.
        const sectionHeading = D12_SECTION_BY_PERSONA[profile.persona]
        expect(sectionHeading, `${definition.id} (${profile.persona}) must declare its D12 section`).toBeDefined()
        const actualUnit = sectionBody(text, sectionHeading!)
        const goldenUnit = D12_GOLDENS[profile.persona]
        expect(goldenUnit, `${definition.id} (${profile.persona}) must be covered by a D12 golden`).toBeDefined()
        // In update mode the constants are the PRE-write values (the module was
        // imported before the file changed), so the file — which the fixed-point
        // assertion at the top of this test just verified against the personas —
        // is the thing being updated. The strict run is the gate.
        if (!goldensWritable(process.env)) {
          const driftAt = actualUnit === goldenUnit ? -1 : actualUnit.split('').findIndex((ch, index) => ch !== goldenUnit![index])
          expect(actualUnit, `${definition.id} (${profile.persona}) must equal the D12 golden (drift at char ${driftAt}; run \`pnpm run test:agents:update-goldens\` if the rule changed on purpose)`)
            .toBe(goldenUnit)
        }
        checked += 1
      }
    }
    // Seven of the eight shipped personas delegate; a drop means this gate went
    // vacuous rather than that the team got simpler.
    expect(checked, 'the delegating personas must stay covered').toBeGreaterThanOrEqual(6)
  })

  it('keeps golden regeneration opt-in, deterministic and a zero-diff no-op', () => {
    // Two guarantees about the WRITER rather than about the goldens, pinned here
    // because the update run itself cannot assert them (its constants are the
    // pre-write values): nothing but an explicit `UPDATE_GOLDENS=1` may write,
    // and the rewrite is a pure function of the persona state — so re-running it
    // with no source change cannot move the file.
    expect(goldensWritable({}), 'the strict suite must never write').toBe(false)
    expect(goldensWritable({ UPDATE_GOLDENS: '0' }), 'any other value must not write').toBe(false)
    expect(goldensWritable({ UPDATE_GOLDENS: 'true' }), 'only the exact opt-in writes').toBe(false)
    expect(goldensWritable({ UPDATE_GOLDENS: '1' }), 'the explicit opt-in must write').toBe(true)

    const sections = personaD12Sections()
    expect(personaD12Sections(), 'the writer must be deterministic').toEqual(sections)
    expect(d12Source(specSource(import.meta.url)), 'regenerating with no change must be a zero diff').toBe(specSource(import.meta.url))
  })

  it('refuses a duplicated D12 anchor, so a parked copy cannot shadow the live rule', () => {
    // The U2 bypass, as an assertion: with the canonical text available twice —
    // once live and once inside an HTML comment — a keyword-based extraction
    // silently picked the copy and stayed green. The derivation must instead
    // refuse the file outright.
    const duplicated = `${readFileSync(join(pluginRoot, 'prompts', 'banbo-main.md'), 'utf8')}\n<!-- 默认复用 / 新建同角色 child 前 (canonical copy) -->\n`
    const anchors = ['默认复用', '新建同角色 child 前']
    for (const anchor of anchors) {
      expect(duplicated.split(anchor).length - 1, `the fixture must really duplicate ${anchor}`).toBe(2)
    }
    expect(() => personaD12SectionFrom(duplicated, 'prompts/banbo-main.md'), 'a duplicated anchor must throw, not pick one')
      .toThrow(/requires exactly one/)
  })

  it('tells every reviewer-delegating persona not to feed its own conclusions (§5.4)', () => {
    // The rubber stamp: the coordinator handed the reviewer its own findings
    // (a)–(f), and the report came back "no additional findings — beyond your
    // (a)–(f)". Feeding conclusions makes independent review impossible, so it
    // is forbidden exactly where `agent_review` is reachable.
    const { definitions } = loadBuiltin()
    let checked = 0
    for (const definition of definitions.values()) {
      if (!definition.allowedChildren.includes('review')) continue
      for (const profile of [definition.main, definition.child]) {
        if (profile === undefined) continue
        const text = readFileSync(join(pluginRoot, profile.persona), 'utf8')
        expect(text, `${definition.id} (${profile.persona}) must forbid feeding conclusions to review`)
          .toMatch(/不要把你自己的结论写进 prompt/)
        checked += 1
      }
    }
    // banbo(main) + planner(main+child) + executor(child)
    expect(checked, 'review-delegating personas must stay covered').toBe(4)
  })

  it('gives the one-shot agents no continuation vocabulary (§5.3)', () => {
    for (const name of ['research-child.md', 'explorer-child.md']) {
      const text = readFileSync(join(pluginRoot, 'prompts', name), 'utf8')
      for (const tool of ['send_message', 'list_agents', 'interrupt_agent']) {
        expect(text.includes(tool), `${name} mentions ${tool}`).toBe(false)
      }
    }
  })

  it('does not name a tool an agent cannot see (§5.3)', () => {
    const { definitions, personas } = loadBuiltin()
    const named = ['read', 'search', 'web', 'exec', 'write', 'edit', 'skill', 'todo', 'jobs', 'ask-user', 'goal', 'present']
    for (const definition of definitions.values()) {
      for (const [form, profile] of [['main', definition.main], ['child', definition.child]] as const) {
        if (profile === undefined) continue
        const text = personas.get(profile.persona)!
        for (const tool of named) {
          if (profile.tools.includes(tool)) continue
          // Word-boundary match so `read` inside `read-only` is not a hit.
          expect(new RegExp(`\\b${tool}\\b`).test(text), `${definition.id}.${form} persona mentions invisible tool "${tool}"`).toBe(false)
        }
      }
    }
  })

  it('documents agent-control only where visible, including all three operations', () => {
    const { definitions, personas } = loadBuiltin()
    const controlTools = ['list_agents', 'send_message', 'interrupt_agent']
    for (const definition of definitions.values()) {
      for (const [form, profile] of [['main', definition.main], ['child', definition.child]] as const) {
        if (profile === undefined) continue
        const text = personas.get(profile.persona)!
        for (const tool of controlTools) {
          expect(text.includes(tool), `${definition.id}.${form} ${tool} visibility`)
            .toBe(profile.tools.includes('agent-control'))
        }
      }
    }
  })

  it('gives every main persona the complete team protocol (§5.3)', () => {
    const { definitions, personas } = loadBuiltin()
    for (const definition of definitions.values()) {
      if (definition.main === undefined) continue
      const text = personas.get(definition.main.persona)!
      for (const term of ['list_agents', 'send_message', 'continuable', 'delegate_batch', 'one-shot', 'deadline', 'childId']) {
        expect(text.includes(term), `${definition.id}.main is missing ${term}`).toBe(true)
      }
      expect(text).toMatch(/并发.{0,12}(超限|额度)/s)
      expect(text).toMatch(/(cancel_requested|cleanup_deferred).{0,30}(不|不能).{0,10}(完成|completed)/s)
    }
  })

  it('keeps the shared child collaboration sentence byte-identical', () => {
    // Each continuable child persona opens `# Collaboration Protocol` with an
    // agent-specific lead-in, then repeats one shared mechanics sentence. The
    // duplication is deliberate (every persona stays self-contained and
    // independently overridable), so this test is what keeps it from drifting:
    // editing one file without the others fails here rather than silently
    // teaching one agent a different protocol.
    const continuableChildren = ['planner-child.md', 'executor-child.md', 'implement-child.md', 'review-child.md']
    const marker = '用 `list_agents`'

    const tails = continuableChildren.map((name) => {
      const section = sectionBody(readFileSync(join(pluginRoot, 'prompts', name), 'utf8'), '# Collaboration Protocol')
      const at = section.indexOf(marker)
      expect(at, `${name} must carry the shared mechanics sentence`).toBeGreaterThanOrEqual(0)
      return section.slice(at)
    })

    expect(new Set(tails).size, `the shared sentence drifted:\n${tails.join('\n---\n')}`).toBe(1)
    const shared = tails[0]!
    for (const tool of ['list_agents', 'send_message', 'interrupt_agent']) {
      expect(shared, `shared sentence must name ${tool}`).toContain(tool)
    }
    expect(shared).toContain('不把它当作硬杀')
    // Byte-identity alone would pass if the reuse rule were pasted into ONE
    // file's lead-in, so the rule's own keywords are pinned in the shared tail.
    for (const phrase of ['默认复用', '选上下文最接近这次任务的那个', '四种例外', '任务无关', '上下文拖累', '需要隔离', '上一轮没交出结论', '既不新建、也不干等']) {
      expect(shared, `shared sentence must carry the reuse rule: ${phrase}`).toContain(phrase)
    }
  })

  it('includes one short evidence-bearing output example per persona', () => {
    for (const name of personaFiles) {
      const text = readFileSync(join(pluginRoot, 'prompts', name), 'utf8')
      expect(text, `${name} output example`).toMatch(/示例：.{1,160}(依据|文件|来源|命令|风险|未找到)/s)
    }
  })

  it('mentions only allowed named children and never generic creation tools', () => {
    const { definitions, personas } = loadBuiltin()
    const allIds = [...definitions.keys()]
    for (const definition of definitions.values()) {
      for (const [form, profile] of [['main', definition.main], ['child', definition.child]] as const) {
        if (profile === undefined) continue
        const text = personas.get(profile.persona)!
        for (const id of allIds) {
          if (id === definition.id || definition.allowedChildren.includes(id)) continue
          expect(text.includes(`agent_${id}`), `${definition.id}.${form} names unauthorized child ${id}`).toBe(false)
        }
        for (const tool of ['subagent', 'subagent_fork', 'workflow', 'ralph']) {
          expect(new RegExp(`\\b${tool}\\b`).test(text), `${definition.id}.${form} names forbidden ${tool}`).toBe(false)
        }
      }
    }
  })
})

/**
 * Specification for `plugins/agents/prompt-loader.js` — persona loading
 * (docs/agents-plugin-plan.md §6.2).
 *
 * Persona files are user-authored input that becomes part of every system
 * prompt for the agents that reference them, so the loader owns a containment
 * boundary (nothing outside `prompts/` may be read, symlinks included), a
 * decoding boundary (strict UTF-8), two size ceilings (64 KiB per file, 1 MiB
 * total), and a normalisation rule (exactly one trailing newline).
 */

import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import {
  PERSONA_FILE_LIMIT,
  PromptError,
  loadPersona,
  loadPersonaSet,
} from '../prompt-loader.js'

const scratch: string[] = []
function scratchRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), 'banbo-prompts-'))
  scratch.push(dir)
  return dir
}
afterEach(() => {
  while (scratch.length > 0) rmSync(scratch.pop()!, { recursive: true, force: true })
})

/** A plugin data root with an empty `prompts/` directory. */
function rootWithPrompts(): string {
  const root = scratchRoot()
  mkdirSync(join(root, 'prompts'), { recursive: true })
  return root
}

function promptError(fn: () => unknown): PromptError {
  try {
    fn()
  } catch (error) {
    if (error instanceof PromptError) return error
    throw error
  }
  throw new Error('expected PromptError, but nothing was thrown')
}

describe('loadPersona — happy path', () => {
  it('reads a markdown file and reports its byte size', () => {
    const root = rootWithPrompts()
    writeFileSync(join(root, 'prompts', 'r.md'), '# Role\n\nprobe\n')
    const persona = loadPersona(root, 'prompts/r.md')
    expect(persona.ref).toBe('prompts/r.md')
    expect(persona.text).toBe('# Role\n\nprobe\n')
    expect(persona.bytes).toBe(Buffer.byteLength('# Role\n\nprobe\n'))
  })

  it('normalises the trailing newline to exactly one', () => {
    const root = rootWithPrompts()
    const cases: Array<[string, string]> = [
      ['no trailing newline', 'body'],
      ['one', 'body\n'],
      ['three', 'body\n\n\n'],
      ['crlf', 'body\r\n'],
    ]
    for (const [label, source] of cases) {
      writeFileSync(join(root, 'prompts', 'n.md'), source)
      expect(loadPersona(root, 'prompts/n.md').text, label).toBe('body\n')
    }
  })

  it('preserves interior blank lines and CRLF-free content verbatim', () => {
    const root = rootWithPrompts()
    writeFileSync(join(root, 'prompts', 'keep.md'), '# Role\n\n\n## Next\n')
    expect(loadPersona(root, 'prompts/keep.md').text).toBe('# Role\n\n\n## Next\n')
  })

  it('returns an immutable snapshot: later edits to the file are not observed', () => {
    const root = rootWithPrompts()
    const path = join(root, 'prompts', 'snap.md')
    writeFileSync(path, 'first\n')
    const persona = loadPersona(root, 'prompts/snap.md')
    writeFileSync(path, 'second\n')
    expect(persona.text).toBe('first\n')
    expect(Object.isFrozen(persona)).toBe(true)
  })
})

describe('loadPersona — containment boundary', () => {
  it('rejects an absolute path', () => {
    const root = rootWithPrompts()
    const error = promptError(() => loadPersona(root, '/etc/passwd'))
    expect(error.code).toBe('absolute-path')
  })

  it('rejects a relative escape out of prompts/', () => {
    const root = rootWithPrompts()
    writeFileSync(join(root, 'secret.md'), 'secret\n')
    const error = promptError(() => loadPersona(root, 'prompts/../secret.md'))
    expect(error.code).toBe('outside-prompts')
  })

  it('rejects a nested escape', () => {
    const root = rootWithPrompts()
    writeFileSync(join(root, 'secret.md'), 'secret\n')
    const error = promptError(() => loadPersona(root, 'prompts/a/../../secret.md'))
    expect(error.code).toBe('outside-prompts')
  })

  it('rejects a reference that is not under prompts/ at all', () => {
    const root = rootWithPrompts()
    writeFileSync(join(root, 'agents.md'), 'x\n')
    const error = promptError(() => loadPersona(root, 'agents.md'))
    expect(error.code).toBe('outside-prompts')
  })

  it('rejects a symlink whose final target escapes prompts/', () => {
    const root = rootWithPrompts()
    writeFileSync(join(root, 'secret.md'), 'secret\n')
    symlinkSync(join(root, 'secret.md'), join(root, 'prompts', 'link.md'))
    const error = promptError(() => loadPersona(root, 'prompts/link.md'))
    expect(error.code).toBe('outside-prompts')
  })

  it('accepts a symlink whose final target stays inside prompts/', () => {
    const root = rootWithPrompts()
    writeFileSync(join(root, 'prompts', 'real.md'), 'inside\n')
    symlinkSync(join(root, 'prompts', 'real.md'), join(root, 'prompts', 'link-ok.md'))
    expect(loadPersona(root, 'prompts/link-ok.md').text).toBe('inside\n')
  })

  it('rejects a directory', () => {
    const root = rootWithPrompts()
    mkdirSync(join(root, 'prompts', 'adir'))
    const error = promptError(() => loadPersona(root, 'prompts/adir'))
    expect(error.code).toBe('not-a-file')
  })

  it('rejects an empty or non-string reference', () => {
    const root = rootWithPrompts()
    for (const ref of ['', undefined, 42] as unknown[]) {
      expect(promptError(() => loadPersona(root, ref as string)).code).toBe('bad-ref')
    }
  })
})

describe('loadPersona — decoding and size', () => {
  it('rejects invalid UTF-8 instead of substituting replacement characters', () => {
    const root = rootWithPrompts()
    // A lone continuation byte: decodable with replacement, invalid strictly.
    writeFileSync(join(root, 'prompts', 'bad.md'), Buffer.from([0x23, 0x20, 0x80, 0x0a]))
    const error = promptError(() => loadPersona(root, 'prompts/bad.md'))
    expect(error.code).toBe('not-utf8')
  })

  it('accepts multi-byte UTF-8', () => {
    const root = rootWithPrompts()
    writeFileSync(join(root, 'prompts', 'cjk.md'), '# 角色\n\n内容\n')
    expect(loadPersona(root, 'prompts/cjk.md').text).toBe('# 角色\n\n内容\n')
  })

  it('rejects a file over the 64 KiB ceiling and names the limit', () => {
    const root = rootWithPrompts()
    writeFileSync(join(root, 'prompts', 'big.md'), 'x'.repeat(PERSONA_FILE_LIMIT + 1))
    const error = promptError(() => loadPersona(root, 'prompts/big.md'))
    expect(error.code).toBe('limit-exceeded')
    expect(error.field).toBe('personaFileBytes')
    expect(error.message).toContain(String(PERSONA_FILE_LIMIT))
  })

  it('accepts a file whose normalised text is exactly at the ceiling', () => {
    const root = rootWithPrompts()
    // The ceiling governs the text that reaches the prompt, so the fixture is
    // one byte short on disk and gains its newline during normalisation.
    writeFileSync(join(root, 'prompts', 'edge.md'), `${'x'.repeat(PERSONA_FILE_LIMIT - 1)}\n`)
    expect(loadPersona(root, 'prompts/edge.md').bytes).toBe(PERSONA_FILE_LIMIT)
  })

  it('rejects a file that only crosses the ceiling after normalisation', () => {
    const root = rootWithPrompts()
    // Exactly at the on-disk ceiling, but one byte over once the missing
    // trailing newline is added — the budget follows the text, not the file.
    writeFileSync(join(root, 'prompts', 'edge-over.md'), 'x'.repeat(PERSONA_FILE_LIMIT))
    const error = promptError(() => loadPersona(root, 'prompts/edge-over.md'))
    expect(error.code).toBe('limit-exceeded')
    expect(error.field).toBe('personaFileBytes')
  })

  it('measures the ceiling in UTF-8 bytes, not characters', () => {
    const root = rootWithPrompts()
    // 30 000 CJK characters = 90 000 bytes: under the character count, over the cap.
    writeFileSync(join(root, 'prompts', 'cjk-big.md'), '汉'.repeat(30_000))
    expect(promptError(() => loadPersona(root, 'prompts/cjk-big.md')).code).toBe('limit-exceeded')
  })

  it('rejects a missing file', () => {
    const root = rootWithPrompts()
    expect(promptError(() => loadPersona(root, 'prompts/absent.md')).code).toBe('unreadable-file')
  })
})

describe('loadPersonaSet — total budget', () => {
  const ref = (name: string) => `prompts/${name}.md`

  it('loads several personas and reports the total byte count', () => {
    const root = rootWithPrompts()
    writeFileSync(join(root, 'prompts', 'a.md'), 'aaaa\n')
    writeFileSync(join(root, 'prompts', 'b.md'), 'bbbbbb\n')
    const set = loadPersonaSet(root, [ref('a'), ref('b')])
    expect(set.totalBytes).toBe(5 + 7)
    expect(set.personas.get(ref('a'))).toBe('aaaa\n')
    expect(set.personas.size).toBe(2)
  })

  it('returns the same snapshot for a repeated ref and counts it once', () => {
    const root = rootWithPrompts()
    writeFileSync(join(root, 'prompts', 'a.md'), 'aaaa\n')
    const set = loadPersonaSet(root, [ref('a'), ref('a')])
    expect(set.personas.size).toBe(1)
    expect(set.totalBytes).toBe(5)
  })

  it('rejects a set over the 1 MiB total ceiling, naming the limit', () => {
    const root = rootWithPrompts()
    // 18 files of 60 KiB = 1.05 MiB, each individually well under 64 KiB.
    const refs: string[] = []
    for (let index = 0; index < 18; index += 1) {
      const name = `p${index}`
      writeFileSync(join(root, 'prompts', `${name}.md`), 'x'.repeat(60 * 1024))
      refs.push(ref(name))
    }
    const error = promptError(() => loadPersonaSet(root, refs))
    expect(error.code).toBe('limit-exceeded')
    expect(error.field).toBe('maxPersonaTotalBytes')
  })

  it('accepts a set exactly at the total ceiling', () => {
    const root = rootWithPrompts()
    // 16 files whose normalised text is 64 KiB each = exactly 1 MiB.
    const refs: string[] = []
    for (let index = 0; index < 16; index += 1) {
      const name = `e${index}`
      writeFileSync(join(root, 'prompts', `${name}.md`), `${'x'.repeat(PERSONA_FILE_LIMIT - 1)}\n`)
      refs.push(ref(name))
    }
    expect(loadPersonaSet(root, refs).totalBytes).toBe(1024 * 1024)
  })

  it('accepts an empty set', () => {
    expect(loadPersonaSet(rootWithPrompts(), []).totalBytes).toBe(0)
  })
})

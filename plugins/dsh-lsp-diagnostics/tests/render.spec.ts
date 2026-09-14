import { describe, expect, it } from 'vitest'
import { compareEligibleTargets, renderDiagnostics, sanitizeDisplayPath } from '../render.js'
import { DEFAULT_CONFIG } from './helpers.js'

// ---------------------------------------------------------------------------
// Todo 4 fixtures: renderer input is the strict post-eligibility union; the
// normalized diagnostics mirror the runtime's frozen consumed-field schema.
// ---------------------------------------------------------------------------

const A_TS_URI = 'file:///workspace/src/a.ts'
const B_TSX_URI = 'file:///workspace/src/b.tsx'
const C_GO_URI = 'file:///workspace/src/c.go'

interface Position {
  readonly line: number
  readonly character: number
}

interface Range {
  readonly start: Position
  readonly end: Position
}

interface NormalizedDiagnostic {
  readonly uri: string
  readonly range: Range
  readonly severity: 'error' | 'warning' | 'info' | 'hint' | 'unknown'
  readonly severityRank: 0 | 1 | 2 | 3 | 4
  readonly code: string
  readonly source: string
  readonly message: string
}

type UnavailableReason =
  | 'server not found'
  | 'server crashed'
  | 'timeout'
  | 'malformed response'
  | 'document too large'
  | 'diagnostics unavailable'

interface Entry {
  readonly renderPath: string
  readonly targetKey: string
  readonly canonicalUri: string
  readonly kind: 'diagnostics' | 'clean' | 'unavailable'
  readonly diagnostics?: readonly NormalizedDiagnostic[]
  readonly reason?: UnavailableReason
}

function position(line: number, character: number): Position {
  return { line, character }
}

function range(start: Position, end: Position): Range {
  return { start, end }
}

function diagnostic(overrides: Partial<NormalizedDiagnostic> = {}): NormalizedDiagnostic {
  return {
    uri: A_TS_URI,
    range: range(position(11, 4), position(11, 9)),
    severity: 'error',
    severityRank: 0,
    code: 'TS2322',
    source: 'typescript',
    message: "Type 'string' is not assignable to type 'number'.",
    ...overrides,
  }
}

function diagnosticsEntry(overrides: Partial<Entry> = {}): Entry {
  return {
    renderPath: 'src/a.ts',
    targetKey: 'a.ts',
    canonicalUri: A_TS_URI,
    kind: 'diagnostics',
    diagnostics: [diagnostic()],
    ...overrides,
  }
}

function cleanEntry(overrides: Partial<Entry> = {}): Entry {
  return {
    renderPath: 'src/b.tsx',
    targetKey: 'b.tsx',
    canonicalUri: B_TSX_URI,
    kind: 'clean',
    ...overrides,
  }
}

function unavailableEntry(overrides: Partial<Entry> = {}): Entry {
  return {
    renderPath: 'src/c.go',
    targetKey: 'c.go',
    canonicalUri: C_GO_URI,
    kind: 'unavailable',
    reason: 'server not found',
    ...overrides,
  }
}

function config(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { ...DEFAULT_CONFIG, ...overrides }
}

// ---------------------------------------------------------------------------
// Shared single-line display path sanitizer.
// ---------------------------------------------------------------------------

describe('@banbolee/dsh-lsp-diagnostics sanitizeDisplayPath', () => {
  it('keeps an ordinary single-line path byte for byte', () => {
    expect(sanitizeDisplayPath('src/deep/nested/file.ts')).toBe('src/deep/nested/file.ts')
  })

  it('keeps supplementary code points intact', () => {
    expect(sanitizeDisplayPath('src/😀/文件.ts')).toBe('src/😀/文件.ts')
  })

  it('collapses each CRLF sequence to exactly one space', () => {
    expect(sanitizeDisplayPath('a\r\nb\r\nc')).toBe('a b c')
  })

  it('collapses a lone CR to one space', () => {
    expect(sanitizeDisplayPath('a\rb')).toBe('a b')
  })

  it('collapses LF, U+2028, and U+2029 each to one space', () => {
    expect(sanitizeDisplayPath('a\nb\u2028c\u2029d')).toBe('a b c d')
  })

  it('replaces every other C0 control character with U+FFFD', () => {
    expect(sanitizeDisplayPath('a\u0000b\u0001c\u001fd')).toBe('a\uFFFDb\uFFFDc\uFFFDd')
  })

  it('replaces every C1 control character with U+FFFD', () => {
    expect(sanitizeDisplayPath('a\u007fb\u0085c\u009fd')).toBe('a\uFFFDb\uFFFDc\uFFFDd')
  })

  it('replaces lone surrogates with U+FFFD and preserves valid pairs', () => {
    expect(sanitizeDisplayPath('a\uD800b\uDC00c\uD83D\uDE00d')).toBe('a\uFFFDb\uFFFDc😀d')
  })

  it('never produces a newline from any input', () => {
    const hostile = 'x\r\n\r\ny\nz\u2028w\u2029v\u0001\u0085\uD800'
    expect(sanitizeDisplayPath(hostile)).not.toMatch(/[\r\n\u2028\u2029]/)
  })

  it('handles an empty path', () => {
    expect(sanitizeDisplayPath('')).toBe('')
  })

  it('fails loud on a non-string display path', () => {
    expect(() => sanitizeDisplayPath(undefined as unknown as string)).toThrow()
    expect(() => sanitizeDisplayPath(42 as unknown as string)).toThrow()
    expect(() => sanitizeDisplayPath(null as unknown as string)).toThrow()
  })
})

// ---------------------------------------------------------------------------
// Unique (renderPath, String(targetKey), canonicalUri) code-point comparator.
// ---------------------------------------------------------------------------

describe('@banbolee/dsh-lsp-diagnostics compareEligibleTargets', () => {
  const base = { renderPath: 'src/a.ts', targetKey: 'a.ts', canonicalUri: A_TS_URI }

  it('orders by renderPath code points and picks the first differing one', () => {
    const a = { ...base, renderPath: 'src/a.ts' }
    const b = { ...base, renderPath: 'src/b.ts' }
    const a2 = { ...base, renderPath: 'src/a2.ts' }
    expect(compareEligibleTargets(a, b)).toBeLessThan(0)
    expect(compareEligibleTargets(b, a)).toBeGreaterThan(0)
    // 'src/a.ts' vs 'src/a2.ts': first differing code point is '.' (U+002E)
    // vs '2' (U+0032), so the former sorts first.
    expect(compareEligibleTargets(a, a2)).toBeLessThan(0)
  })

  it('compares supplementary code points numerically, not by UTF-16 code units', () => {
    // U+10000 (surrogate pair D800 DC00) vs U+E000 (single BMP unit):
    // by code point U+E000 < U+10000, while by UTF-16 code units D800 < E000.
    const a = { ...base, renderPath: 'x\u{10000}' }
    const b = { ...base, renderPath: 'x\uE000' }
    expect(compareEligibleTargets(a, b)).toBeGreaterThan(0)
    expect(compareEligibleTargets(b, a)).toBeLessThan(0)
  })

  it('tie-breaks equal renderPath on String(targetKey)', () => {
    const a = { ...base, targetKey: 'a10' }
    const b = { ...base, targetKey: 'a2' }
    expect(compareEligibleTargets(a, b)).toBeLessThan(0)
  })

  it('tie-breaks equal renderPath and targetKey on canonicalUri', () => {
    const a = { ...base, canonicalUri: 'file:///workspace/src/a.ts' }
    const b = { ...base, canonicalUri: 'file:///workspace/src/b.ts' }
    expect(compareEligibleTargets(a, b)).toBeLessThan(0)
  })

  it('returns zero only for fully identical three columns', () => {
    const a = { renderPath: 'src/a.ts', targetKey: 'k1', canonicalUri: A_TS_URI }
    const b = { renderPath: 'src/a.ts', targetKey: 'k1', canonicalUri: A_TS_URI }
    const c = { renderPath: 'src/a.ts', targetKey: 'k1', canonicalUri: 'file:///other/a.ts' }
    expect(compareEligibleTargets(a, b)).toBe(0)
    expect(compareEligibleTargets(a, c)).not.toBe(0)
  })

  it('fails loud on entries missing any of the three sort columns', () => {
    expect(() => compareEligibleTargets({} as never, base)).toThrow()
    expect(() => compareEligibleTargets(base, { renderPath: 'x' } as never)).toThrow()
    expect(() => compareEligibleTargets(null as never, base)).toThrow()
  })
})

// ---------------------------------------------------------------------------
// Strict discriminated union validation: unknown field or shape mismatch is an
// implementation bug and must fail loud.
// ---------------------------------------------------------------------------

describe('@banbolee/dsh-lsp-diagnostics renderDiagnostics strict union validation', () => {
  it('fails loud on non-array entries', () => {
    expect(() => renderDiagnostics(null as never, config())).toThrow()
    expect(() => renderDiagnostics({} as never, config())).toThrow()
    expect(() => renderDiagnostics('x' as never, config())).toThrow()
  })

  it('fails loud on unknown entry fields', () => {
    expect(() => renderDiagnostics([{ ...diagnosticsEntry(), extra: 1 }], config())).toThrow()
    expect(() => renderDiagnostics([{ ...cleanEntry(), extra: 1 }], config())).toThrow()
    expect(() => renderDiagnostics([{ ...unavailableEntry(), extra: 1 }], config())).toThrow()
  })

  it('fails loud on an unknown kind', () => {
    expect(() => renderDiagnostics([{ ...diagnosticsEntry(), kind: 'other' }], config())).toThrow()
  })

  it('fails loud when renderPath, targetKey, or canonicalUri is missing or not a string', () => {
    expect(() => renderDiagnostics([{ ...diagnosticsEntry(), renderPath: undefined }], config())).toThrow()
    expect(() => renderDiagnostics([{ ...diagnosticsEntry(), renderPath: 42 }], config())).toThrow()
    expect(() => renderDiagnostics([{ ...diagnosticsEntry(), targetKey: undefined }], config())).toThrow()
    expect(() => renderDiagnostics([{ ...diagnosticsEntry(), canonicalUri: undefined }], config())).toThrow()
  })

  it('fails loud when a diagnostics entry lacks its diagnostics array', () => {
    expect(() => renderDiagnostics([{ ...diagnosticsEntry(), diagnostics: undefined }], config())).toThrow()
    expect(() => renderDiagnostics([{ ...diagnosticsEntry(), diagnostics: 'x' }], config())).toThrow()
  })

  it('fails loud when an unavailable entry lacks reason or uses a reason outside the closed union', () => {
    expect(() => renderDiagnostics([{ ...unavailableEntry(), reason: undefined }], config())).toThrow()
    for (const impossible of ['workspace unavailable', 'outside workspace', 'no workspace', 'unknown', '']) {
      expect(() => renderDiagnostics([{ ...unavailableEntry(), reason: impossible }], config())).toThrow()
    }
  })

  it('fails loud on diagnostics that are not strict normalized objects', () => {
    expect(() => renderDiagnostics([diagnosticsEntry({ diagnostics: [null as never] })], config())).toThrow()
    expect(() => renderDiagnostics([diagnosticsEntry({ diagnostics: ['x' as never] })], config())).toThrow()
    expect(() => renderDiagnostics([diagnosticsEntry({ diagnostics: [diagnostic({ extra: 1 } as never)] })], config())).toThrow()
  })

  it('fails loud when a normalized diagnostic misses a consumed field', () => {
    for (const missing of [
      { uri: undefined },
      { range: undefined },
      { severity: undefined },
      { severityRank: undefined },
      { code: undefined },
      { source: undefined },
      { message: undefined },
    ]) {
      expect(() => renderDiagnostics([diagnosticsEntry({ diagnostics: [diagnostic(missing as never)] })], config())).toThrow()
    }
  })

  it('fails loud when severityRank does not match the severity token', () => {
    expect(() =>
      renderDiagnostics([diagnosticsEntry({ diagnostics: [diagnostic({ severity: 'error', severityRank: 4 } as never)] })], config()),
    ).toThrow()
  })

  it('fails loud on invalid ranges and positions', () => {
    const badRange = { start: position(-1, 0), end: position(0, 0) }
    expect(() => renderDiagnostics([diagnosticsEntry({ diagnostics: [diagnostic({ range: badRange } as never)] })], config())).toThrow()
    const reversed = { start: position(2, 0), end: position(1, 0) }
    expect(() => renderDiagnostics([diagnosticsEntry({ diagnostics: [diagnostic({ range: reversed } as never)] })], config())).toThrow()
  })

  it('fails loud on a non-object config', () => {
    expect(() => renderDiagnostics([], null as never)).toThrow()
    expect(() => renderDiagnostics([], 'x' as never)).toThrow()
  })

  it('fails loud when maxDiagnostics or maxResultChars is not a positive safe integer', () => {
    expect(() => renderDiagnostics([cleanEntry()], config({ maxDiagnostics: 0 }))).toThrow()
    expect(() => renderDiagnostics([cleanEntry()], config({ maxDiagnostics: 1.5 }))).toThrow()
    expect(() => renderDiagnostics([cleanEntry()], config({ maxResultChars: 0 }))).toThrow()
    expect(() => renderDiagnostics([cleanEntry()], config({ maxResultChars: -1 }))).toThrow()
  })
})

// ---------------------------------------------------------------------------
// Unique canonical aggregate grammar: one title, one section per file, one
// blank line between sections, no leading/trailing LF, conditional global
// advisory, byte-exact output.
// ---------------------------------------------------------------------------

describe('@banbolee/dsh-lsp-diagnostics renderDiagnostics canonical grammar', () => {
  it('renders a single diagnostics section with the unique title, the global advisory, and no trailing newline', () => {
    const result = renderDiagnostics([diagnosticsEntry()], config())
    expect(result.text).toBe(
      '[LSP diagnostics after write]\n' +
        'File: src/a.ts\n' +
        '- error 12:5-12:10 source="typescript" code="TS2322" Type \'string\' is not assignable to type \'number\'.\n' +
        '\n' +
        'Fix these diagnostics before considering the change complete.',
    )
    expect(result.diagnosticCount).toBe(1)
    expect(result.fileCount).toBe(1)
  })

  it('converts 0-based UTF-16 coordinates to 1-based start-end', () => {
    const diag = diagnostic({
      range: range(position(0, 0), position(0, 0)),
      severity: 'warning',
      severityRank: 1,
      code: 'W1',
      source: 'go',
      message: 'm',
    })
    const result = renderDiagnostics([diagnosticsEntry({ diagnostics: [diag] })], config())
    expect(result.text).toContain('- warning 1:1-1:1 source="go" code="W1" m')
  })

  it('JSON-quotes source and code with defaults as empty strings', () => {
    const diag = diagnostic({ severity: 'hint', severityRank: 3, code: '', source: '', message: '' })
    const result = renderDiagnostics([diagnosticsEntry({ diagnostics: [diag] })], config())
    expect(result.text).toContain('- hint 12:5-12:10 source="" code="" ')
  })

  it('escapes quotes and backslashes in source and code via JSON string quoting', () => {
    const diag = diagnostic({ code: 'a"b\\c', source: 's"r\\c', message: 'm' })
    const result = renderDiagnostics([diagnosticsEntry({ diagnostics: [diag] })], config())
    expect(result.text).toContain('source="s\\"r\\\\c" code="a\\"b\\\\c" m')
  })

  it('single-lines control characters, newlines, and lone surrogates in every rendered string', () => {
    const diag = diagnostic({
      source: 'a\nb\r\nc\u2028d\u2029e\u0001f\u0085g\uD800h',
      code: 'i\rj',
      message: 'k\nl\u2028m\u0000n',
    })
    const result = renderDiagnostics([diagnosticsEntry({ renderPath: 'src/a\nb.ts', diagnostics: [diag] })], config())
    // The full aggregate byte-for-byte: every rendered string is single-line
    // and the grammar keeps exactly the title, section, and advisory lines.
    expect(result.text).toBe(
      '[LSP diagnostics after write]\n' +
        'File: src/a b.ts\n' +
        '- error 12:5-12:10 source="a b c d e\uFFFDf\uFFFDg\uFFFDh" code="i j" k l m\uFFFDn\n' +
        '\n' +
        'Fix these diagnostics before considering the change complete.',
    )
  })

  it('joins sections with exactly one blank line (two LFs) and adds exactly one global advisory', () => {
    const result = renderDiagnostics(
      [diagnosticsEntry(), cleanEntry(), unavailableEntry()],
      config(),
    )
    const lines = (result.text ?? '').split('\n')
    expect(lines[0]).toBe('[LSP diagnostics after write]')
    expect(lines[1]).toBe('File: src/a.ts')
    expect(lines[3]).toBe('')
    expect(lines[4]).toBe('File: src/b.tsx')
    expect(lines[6]).toBe('')
    expect(lines[7]).toBe('File: src/c.go')
    expect(lines[9]).toBe('')
    expect(lines[10]).toBe('Fix these diagnostics before considering the change complete.')
    expect(result.text).not.toMatch(/\n$/)
    expect(result.text?.startsWith('\n')).toBe(false)
  })

  it('renders the unique three-file diagnostics+clean+unavailable golden byte for byte', () => {
    const result = renderDiagnostics(
      [unavailableEntry(), diagnosticsEntry(), cleanEntry()],
      config(),
    )
    expect(result.text).toBe(
      '[LSP diagnostics after write]\n' +
        'File: src/a.ts\n' +
        '- error 12:5-12:10 source="typescript" code="TS2322" Type \'string\' is not assignable to type \'number\'.\n' +
        '\n' +
        'File: src/b.tsx\n' +
        'Status: clean\n' +
        '\n' +
        'File: src/c.go\n' +
        'Status: diagnostics unavailable (server not found)\n' +
        '\n' +
        'Fix these diagnostics before considering the change complete.',
    )
    expect(result.diagnosticCount).toBe(1)
    expect(result.fileCount).toBe(3)
  })

  it('omits the advisory when no diagnostics survive the global count cap', () => {
    const result = renderDiagnostics([cleanEntry(), unavailableEntry()], config())
    expect(result.text).toBe(
      '[LSP diagnostics after write]\n' +
        'File: src/b.tsx\n' +
        'Status: clean\n' +
        '\n' +
        'File: src/c.go\n' +
        'Status: diagnostics unavailable (server not found)',
    )
    expect(result.text).not.toContain('Fix these diagnostics')
    expect(result.diagnosticCount).toBe(0)
    expect(result.fileCount).toBe(2)
  })

  it('drops clean entries entirely when reportClean is false', () => {
    const result = renderDiagnostics(
      [diagnosticsEntry(), cleanEntry(), unavailableEntry()],
      config({ reportClean: false }),
    )
    expect(result.text).toBe(
      '[LSP diagnostics after write]\n' +
        'File: src/a.ts\n' +
        '- error 12:5-12:10 source="typescript" code="TS2322" Type \'string\' is not assignable to type \'number\'.\n' +
        '\n' +
        'File: src/c.go\n' +
        'Status: diagnostics unavailable (server not found)\n' +
        '\n' +
        'Fix these diagnostics before considering the change complete.',
    )
  })

  it('returns text null when no entries survive', () => {
    expect(renderDiagnostics([], config())).toEqual({ text: null, diagnosticCount: 0, fileCount: 0 })
  })
})

// ---------------------------------------------------------------------------
// Ordering: renderer re-sorts by the shared comparator and sorts each file's
// diagnostics by the unique per-file key.
// ---------------------------------------------------------------------------

describe('@banbolee/dsh-lsp-diagnostics renderDiagnostics ordering', () => {
  it('re-sorts unordered entries by (renderPath, String(targetKey), canonicalUri)', () => {
    const result = renderDiagnostics(
      [
        unavailableEntry(),
        cleanEntry(),
        diagnosticsEntry(),
        diagnosticsEntry({ renderPath: 'src/z.ts', targetKey: 'z', canonicalUri: 'file:///workspace/src/z.ts' }),
      ],
      config(),
    )
    const text = result.text ?? ''
    expect(text.indexOf('File: src/a.ts')).toBeLessThan(text.indexOf('File: src/b.tsx'))
    expect(text.indexOf('File: src/b.tsx')).toBeLessThan(text.indexOf('File: src/c.go'))
    expect(text.indexOf('File: src/c.go')).toBeLessThan(text.indexOf('File: src/z.ts'))
  })

  it('orders by sanitized renderPath, never by a raw displayPath-like value', () => {
    // The second path contains U+10000; by code points 'a\u{10000}' sorts
    // after 'a\uE000' even though its UTF-16 first code unit is smaller.
    const first = diagnosticsEntry({ renderPath: 'a\uE000.ts', targetKey: 'k', canonicalUri: 'file:///w/a1.ts' })
    const second = diagnosticsEntry({ renderPath: 'a\u{10000}.ts', targetKey: 'k', canonicalUri: 'file:///w/a2.ts' })
    const result = renderDiagnostics([second, first], config())
    const text = result.text ?? ''
    expect(text.indexOf('File: a\uE000.ts')).toBeLessThan(text.indexOf('File: a\u{10000}.ts'))
  })

  it('sorts each file\'s diagnostics by the unique per-file key', () => {
    const sameStart = [
      diagnostic({ severity: 'unknown', severityRank: 4, code: 'u', source: 's', message: 'm', range: range(position(1, 1), position(1, 9)) }),
      diagnostic({ severity: 'error', severityRank: 0, code: 'e', source: 's', message: 'm', range: range(position(1, 1), position(1, 9)) }),
      diagnostic({ severity: 'error', severityRank: 0, code: 'e', source: 's', message: 'm', range: range(position(0, 0), position(0, 1)) }),
    ]
    const result = renderDiagnostics([diagnosticsEntry({ diagnostics: sameStart })], config())
    const text = result.text ?? ''
    const first = text.indexOf('- error 1:1-1:2')
    const second = text.indexOf('- error 2:2-2:10')
    const third = text.indexOf('- unknown 2:2-2:10')
    expect(first).toBeGreaterThanOrEqual(0)
    expect(first).toBeLessThan(second)
    expect(second).toBeLessThan(third)
  })

  it('breaks per-file ties on severityRank, source, code, message, then end', () => {
    const base = { severity: 'error' as const, severityRank: 0 as const, uri: A_TS_URI }
    const diagnostics = [
      // (s, c, z, end 0:6)
      { ...base, source: 's', code: 'c', message: 'z', range: range(position(0, 0), position(0, 6)) },
      // (s, c, a, end 0:6)
      { ...base, source: 's', code: 'c', message: 'a', range: range(position(0, 0), position(0, 6)) },
      // (t, c, a, end 0:6)
      { ...base, source: 't', code: 'c', message: 'a', range: range(position(0, 0), position(0, 6)) },
      // (s, b, a, end 0:6)
      { ...base, source: 's', code: 'b', message: 'a', range: range(position(0, 0), position(0, 6)) },
      // (s, c, a, end 0:5) — earlier end sorts before the longer range
      { ...base, source: 's', code: 'c', message: 'a', range: range(position(0, 0), position(0, 5)) },
    ]
    const result = renderDiagnostics([diagnosticsEntry({ diagnostics })], config())
    const text = result.text ?? ''
    const order = [
      '- error 1:1-1:7 source="s" code="b" a',
      '- error 1:1-1:6 source="s" code="c" a',
      '- error 1:1-1:7 source="s" code="c" a',
      '- error 1:1-1:7 source="s" code="c" z',
      '- error 1:1-1:7 source="t" code="c" a',
    ]
    const indexes = order.map((line) => text.indexOf(line))
    for (const index of indexes) expect(index).toBeGreaterThanOrEqual(0)
    for (let i = 1; i < indexes.length; i += 1) {
      const prev = indexes[i - 1] as number
      const current = indexes[i] as number
      expect(current).toBeGreaterThan(prev)
    }
  })
})

// ---------------------------------------------------------------------------
// Global maxDiagnostics count cap: one budget across all files, clean and
// unavailable never consume it, empty sections are dropped entirely.
// ---------------------------------------------------------------------------

describe('@banbolee/dsh-lsp-diagnostics renderDiagnostics global count cap', () => {
  it('allocates one global budget across files in file order', () => {
    const second = diagnosticsEntry({
      renderPath: 'src/second.ts',
      targetKey: 'second',
      canonicalUri: 'file:///workspace/src/second.ts',
      diagnostics: [
        diagnostic({ code: 'S1', message: 'second one', range: range(position(0, 0), position(0, 1)) }),
        diagnostic({ code: 'S2', message: 'second two', range: range(position(0, 1), position(0, 2)) }),
      ],
    })
    const result = renderDiagnostics([second, diagnosticsEntry()], config({ maxDiagnostics: 2 }))
    const text = result.text ?? ''
    expect(text).toContain('File: src/a.ts')
    expect(text).toContain('code="TS2322"')
    expect(text).toContain('code="S1"')
    expect(text).not.toContain('code="S2"')
    expect(text).not.toContain('second two')
    expect(result.diagnosticCount).toBe(2)
    expect(result.fileCount).toBe(2)
  })

  it('clean and unavailable sections never consume the budget', () => {
    const result = renderDiagnostics([cleanEntry(), unavailableEntry(), diagnosticsEntry()], config({ maxDiagnostics: 1 }))
    expect(result.text).toContain('Status: clean')
    expect(result.text).toContain('Status: diagnostics unavailable (server not found)')
    expect(result.text).toContain('- error 12:5-12:10')
    expect(result.diagnosticCount).toBe(1)
    expect(result.fileCount).toBe(3)
  })

  it('omits the whole section of a diagnostics file that keeps zero lines after the cap', () => {
    const second = diagnosticsEntry({
      renderPath: 'src/second.ts',
      targetKey: 'second',
      canonicalUri: 'file:///workspace/src/second.ts',
    })
    const result = renderDiagnostics([diagnosticsEntry(), second], config({ maxDiagnostics: 1 }))
    const text = result.text ?? ''
    expect(text).toContain('File: src/a.ts')
    expect(text).not.toContain('File: src/second.ts')
    expect(text).not.toMatch(/File: src\/a\.ts\n\nFile: src\/a\.ts/)
    expect(result.diagnosticCount).toBe(1)
    expect(result.fileCount).toBe(1)
  })

  it('returns text null when the count cap empties every diagnostics section', () => {
    const result = renderDiagnostics(
      [diagnosticsEntry({ diagnostics: [] }), diagnosticsEntry({ renderPath: 'x.ts', targetKey: 'x', canonicalUri: 'file:///w/x.ts', diagnostics: [] })],
      config({ maxDiagnostics: 1 }),
    )
    expect(result).toEqual({ text: null, diagnosticCount: 0, fileCount: 0 })
  })
})

// ---------------------------------------------------------------------------
// maxResultChars: cap applies only after the full canonical aggregate is
// built; the fixed marker replaces the truncated suffix, never splits a
// surrogate pair, and never exceeds the cap.
// ---------------------------------------------------------------------------

describe('@banbolee/dsh-lsp-diagnostics renderDiagnostics char cap', () => {
  it('returns the full canonical aggregate verbatim when within the cap, without a marker', () => {
    const result = renderDiagnostics([diagnosticsEntry()], config({ maxResultChars: 1000 }))
    expect(result.text).toBe(
      '[LSP diagnostics after write]\nFile: src/a.ts\n- error 12:5-12:10 source="typescript" code="TS2322" Type \'string\' is not assignable to type \'number\'.\n\nFix these diagnostics before considering the change complete.',
    )
  })

  it('returns the aggregate verbatim when its code-point length equals the cap exactly', () => {
    const full = renderDiagnostics([diagnosticsEntry()], config({ maxResultChars: 10000 })).text ?? ''
    const exact = renderDiagnostics([diagnosticsEntry()], config({ maxResultChars: Array.from(full).length }))
    expect(exact.text).toBe(full)
    expect(exact.text).not.toContain('…(truncated)')
  })

  it('replaces the truncated suffix with the fixed marker when the cap is large enough', () => {
    const full = renderDiagnostics([diagnosticsEntry()], config({ maxResultChars: 10000 })).text ?? ''
    const cap = 50
    const expected = Array.from(full).slice(0, cap - '…(truncated)'.length).join('') + '…(truncated)'
    const result = renderDiagnostics([diagnosticsEntry()], config({ maxResultChars: cap }))
    expect(result.text).toBe(expected)
    expect(Array.from(result.text ?? '').length).toBe(cap)
  })

  it('truncates the marker itself when the cap is smaller than the marker', () => {
    const result = renderDiagnostics([diagnosticsEntry()], config({ maxResultChars: 5 }))
    expect(result.text).toBe('…(tru')
  })

  it('never exceeds the cap even at cap 1', () => {
    const result = renderDiagnostics([diagnosticsEntry()], config({ maxResultChars: 1 }))
    expect(result.text).toBe('…')
  })

  it('never splits a surrogate pair while truncating multibyte text', () => {
    const emoji = diagnostic({ message: 'a'.repeat(30) + '😀'.repeat(10) + 'b'.repeat(30), code: 'E', source: 's' })
    const full = renderDiagnostics([diagnosticsEntry({ diagnostics: [emoji] })], config({ maxResultChars: 100000 })).text ?? ''
    expect(full).toContain('😀')
    const cap = 60
    const result = renderDiagnostics([diagnosticsEntry({ diagnostics: [emoji] })], config({ maxResultChars: cap }))
    expect(Array.from(result.text ?? '').length).toBeLessThanOrEqual(cap)
    expect(result.text ?? '').not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/)
  })

  it('applies the cap only after the full grammar, including the advisory, is constructed', () => {
    const result = renderDiagnostics([diagnosticsEntry()], config({ maxResultChars: 40 }))
    const text = result.text ?? ''
    // The canonical aggregate starts with the 29-code-point title; the fixed
    // marker is 12 code points, so with cap 40 the prefix is the first 28
    // code points of the complete text (the title minus its final ']'),
    // followed by the marker. The marker replaces the suffix of the complete
    // text, not a pre-built section.
    expect(text).toBe('[LSP diagnostics after write' + '…(truncated)')
    expect(Array.from(text).length).toBe(40)
  })
})

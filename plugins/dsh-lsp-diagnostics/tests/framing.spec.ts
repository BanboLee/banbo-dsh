import { describe, expect, it } from 'vitest'
import { MAX_HEADER_BYTES, MessageDecoder, encodeMessage } from '../framing.js'

function frame(body: unknown, lengthOverride?: number): Buffer {
  const payload = Buffer.from(JSON.stringify(body), 'utf8')
  const length = lengthOverride === undefined ? payload.length : lengthOverride
  return Buffer.concat([Buffer.from(`Content-Length: ${length}\r\n\r\n`, 'ascii'), payload])
}

/** Build a header whose text (before the final terminator) is exactly `headerTextLength` bytes. */
function paddedHeader(contentLength: number, headerTextLength: number): Buffer {
  const terminator = Buffer.from('\r\n\r\n', 'ascii')
  const core = Buffer.from(`Content-Length: ${contentLength}\r\n`, 'ascii')
  const padding = Buffer.alloc(Math.max(0, headerTextLength - core.length), 0x58) // 'X'
  return Buffer.concat([core, padding, terminator])
}

/** A JSON body of exactly 64 bytes. */
function bodyOf64(): Buffer {
  return Buffer.from(JSON.stringify({ result: 'x'.repeat(51) }), 'utf8')
}

/** The CRLFCRLF header terminator length; the header cap includes it. */
const HEADER_TERMINATOR_BYTES = 4

describe('dsh-lsp-diagnostics framing encoder', () => {
  it('encodes an ascii message with an exact Content-Length byte count', () => {
    const message = { jsonrpc: '2.0', method: 'x', params: {} }
    const encoded = encodeMessage(message)
    const body = Buffer.from(JSON.stringify(message), 'utf8')
    expect(encoded.subarray(0, 16).toString('ascii')).toBe('Content-Length: ')
    const headerEnd = encoded.indexOf('\r\n\r\n')
    expect(Number(encoded.subarray(16, headerEnd).toString('ascii'))).toBe(body.length)
    expect(encoded.subarray(headerEnd + 4)).toEqual(body)
  })

  it('counts multibyte utf-8 bodies in bytes, not code points', () => {
    const message = { text: 'héllo—世界' }
    const encoded = encodeMessage(message)
    const headerEnd = encoded.indexOf('\r\n\r\n')
    const declared = Number(encoded.subarray(16, headerEnd).toString('ascii'))
    expect(declared).toBe(Buffer.byteLength(JSON.stringify(message), 'utf8'))
    expect(declared).toBeGreaterThan(JSON.stringify(message).length)
  })
})

describe('dsh-lsp-diagnostics MessageDecoder', () => {
  it('decodes one complete frame pushed at once', () => {
    const decoder = new MessageDecoder(1024)
    expect(decoder.push(frame({ jsonrpc: '2.0', result: 1 }))).toEqual([{ jsonrpc: '2.0', result: 1 }])
  })

  it('decodes a frame split across many chunks at every boundary', () => {
    const decoder = new MessageDecoder(1024)
    const bytes = frame({ jsonrpc: '2.0', method: 'split', params: { n: 42 } })
    const received: unknown[] = []
    for (const byte of bytes) {
      received.push(...decoder.push(Buffer.from([byte])))
    }
    expect(received).toEqual([{ jsonrpc: '2.0', method: 'split', params: { n: 42 } }])
  })

  it('decodes coalesced frames from a single chunk in arrival order', () => {
    const decoder = new MessageDecoder(1024)
    const a = frame({ jsonrpc: '2.0', id: 1 })
    const b = frame({ jsonrpc: '2.0', id: 2 })
    const c = frame({ jsonrpc: '2.0', id: 3 })
    expect(decoder.push(Buffer.concat([a, b, c]))).toEqual([
      { jsonrpc: '2.0', id: 1 },
      { jsonrpc: '2.0', id: 2 },
      { jsonrpc: '2.0', id: 3 },
    ])
  })

  it('decodes a coalesced chunk when a partial frame is already buffered', () => {
    const decoder = new MessageDecoder(1024)
    const a = frame({ jsonrpc: '2.0', id: 1 })
    const b = frame({ jsonrpc: '2.0', id: 2 })
    const half = a.subarray(0, 7)
    const rest = Buffer.concat([a.subarray(7), b])
    expect(decoder.push(half)).toEqual([])
    expect(decoder.push(rest)).toEqual([{ jsonrpc: '2.0', id: 1 }, { jsonrpc: '2.0', id: 2 }])
  })

  it('round-trips a multibyte utf-8 body split inside a multibyte sequence', () => {
    const decoder = new MessageDecoder(1024)
    const message = { jsonrpc: '2.0', message: 'héllo—世界 😀' }
    const bytes = frame(message)
    // Cut after "hé" (the é is a 2-byte sequence; split in the middle of it).
    const cut = bytes.indexOf(Buffer.from('llo', 'ascii'))
    const first = bytes.subarray(0, cut)
    const second = bytes.subarray(cut)
    expect(decoder.push(first)).toEqual([])
    expect(decoder.push(second)).toEqual([message])
  })

  it('ignores extra headers and is case-insensitive about Content-Length', () => {
    const decoder = new MessageDecoder(1024)
    const body = Buffer.from(JSON.stringify({ ok: true }), 'utf8')
    const header = Buffer.from(
      `Content-Type: application/vscode-jsonrpc; charset=utf-8\r\ncontent-length: ${body.length}\r\nX-Extra: 1\r\n\r\n`,
      'ascii',
    )
    expect(decoder.push(Buffer.concat([header, body]))).toEqual([{ ok: true }])
  })

  it('returns nothing for an empty chunk', () => {
    const decoder = new MessageDecoder(1024)
    expect(decoder.push(Buffer.alloc(0))).toEqual([])
  })

  it('accumulates a half frame within the header cap before the terminator arrives', () => {
    const decoder = new MessageDecoder(1024)
    const bytes = frame({ jsonrpc: '2.0', result: 7 })
    const half = bytes.subarray(0, Math.floor(bytes.length / 2))
    expect(decoder.push(half)).toEqual([])
    expect(decoder.push(bytes.subarray(half.length))).toEqual([{ jsonrpc: '2.0', result: 7 }])
  })

  it('accepts a body whose declared length is exactly maxMessageBytes', () => {
    const decoder = new MessageDecoder(64)
    const body = bodyOf64() // exactly 64 bytes
    expect(Buffer.byteLength(body)).toBe(64)
    const bytes = Buffer.concat([Buffer.from('Content-Length: 64\r\n\r\n', 'ascii'), body])
    expect(decoder.push(bytes)).toEqual([{ result: 'x'.repeat(51) }])
  })

  it('decodes a maximum-size frame (header block at MAX_HEADER_BYTES, body at the cap) split across chunks', () => {
    const maxMessageBytes = 64
    const decoder = new MessageDecoder(maxMessageBytes)
    const body = bodyOf64() // exactly 64 bytes
    expect(Buffer.byteLength(body)).toBe(64)
    // The cap includes the CRLFCRLF terminator: max header text is
    // MAX_HEADER_BYTES - 4, so the whole header block is exactly
    // MAX_HEADER_BYTES bytes.
    const bytes = Buffer.concat([paddedHeader(64, MAX_HEADER_BYTES - HEADER_TERMINATOR_BYTES), body])
    const messages: unknown[] = []
    for (let offset = 0; offset < bytes.length; offset += 7) {
      messages.push(...decoder.push(bytes.subarray(offset, offset + 7)))
    }
    expect(messages).toEqual([{ result: 'x'.repeat(51) }])
  })

  it('rejects a declared body length above maxMessageBytes before any body arrives', () => {
    const decoder = new MessageDecoder(64)
    const bytes = Buffer.concat([Buffer.from('Content-Length: 65\r\n\r\n', 'ascii'), Buffer.from('y', 'ascii')])
    expect(() => decoder.push(bytes)).toThrow(/exceeds/)
  })

  it('rejects a header that never finds its terminator within MAX_HEADER_BYTES', () => {
    const decoder = new MessageDecoder(1024)
    const junk = Buffer.alloc(MAX_HEADER_BYTES + 1, 0x41)
    expect(() => decoder.push(junk)).toThrow(/header/i)
  })

  it('rejects a header terminator positioned beyond MAX_HEADER_BYTES', () => {
    const decoder = new MessageDecoder(1024)
    const bytes = paddedHeader(10, MAX_HEADER_BYTES + 1)
    expect(() => decoder.push(bytes)).toThrow(/header/i)
  })

  it('rejects the same oversized header block whether whole or split across chunks', () => {
    const bytes = Buffer.concat([paddedHeader(4, MAX_HEADER_BYTES), Buffer.from('"ok"', 'ascii')])
    const whole = new MessageDecoder(1024)
    expect(() => whole.push(bytes)).toThrow(/header/i)

    const split = new MessageDecoder(1024)
    expect(split.push(bytes.subarray(0, MAX_HEADER_BYTES))).toEqual([])
    expect(() => split.push(bytes.subarray(MAX_HEADER_BYTES))).toThrow(/header/i)
  })

  it('rejects a missing Content-Length header', () => {
    const decoder = new MessageDecoder(1024)
    const bytes = Buffer.concat([Buffer.from('Content-Type: text/plain\r\n\r\n', 'ascii'), Buffer.from('{}', 'utf8')])
    expect(() => decoder.push(bytes)).toThrow(/Content-Length/i)
  })

  it('rejects a non-numeric Content-Length header', () => {
    const decoder = new MessageDecoder(1024)
    const bytes = Buffer.concat([Buffer.from('Content-Length: NaN\r\n\r\n', 'ascii'), Buffer.from('{}', 'utf8')])
    expect(() => decoder.push(bytes)).toThrow(/Content-Length/i)
  })

  it('rejects a negative Content-Length header', () => {
    const decoder = new MessageDecoder(1024)
    const bytes = Buffer.concat([Buffer.from('Content-Length: -5\r\n\r\n', 'ascii'), Buffer.from('{}', 'utf8')])
    expect(() => decoder.push(bytes)).toThrow(/Content-Length/i)
  })

  it.each(['1e2', '+2', '0x2', '9007199254740993'])(
    'rejects non-decimal or unsafe Content-Length %s',
    (value) => {
      const decoder = new MessageDecoder(Number.MAX_SAFE_INTEGER)
      const bytes = Buffer.from(`Content-Length: ${value}\r\n\r\n{}`, 'ascii')
      expect(() => decoder.push(bytes)).toThrow(/Content-Length/i)
    },
  )

  it('rejects a body that is not valid JSON', () => {
    const decoder = new MessageDecoder(1024)
    const bytes = Buffer.concat([Buffer.from('Content-Length: 7\r\n\r\n', 'ascii'), Buffer.from('{nope!!', 'ascii')])
    expect(() => decoder.push(bytes)).toThrow(/JSON/i)
  })

  it('rejects invalid utf-8 even when replacement decoding would form valid JSON', () => {
    const decoder = new MessageDecoder(1024)
    const body = Buffer.from([0x22, 0xff, 0x22])
    const bytes = Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, 'ascii'), body])
    expect(() => decoder.push(bytes)).toThrow(/UTF-8/i)
  })

  it('rejects an empty body (JSON parse failure)', () => {
    const decoder = new MessageDecoder(1024)
    const bytes = Buffer.concat([Buffer.from('Content-Length: 0\r\n\r\n', 'ascii')])
    expect(() => decoder.push(bytes)).toThrow(/JSON/i)
  })

  it('does not retain a huge backing buffer behind a small remaining tail', () => {
    const decoder = new MessageDecoder(1024)
    const count = 2_000
    const frames: Buffer[] = []
    for (let index = 0; index < count; index += 1) {
      frames.push(frame({ jsonrpc: '2.0', id: index }))
    }
    const tail = Buffer.from('partial-tail')
    const chunk = Buffer.concat([...frames, tail])
    const originalBacking = chunk.buffer
    const messages = decoder.push(chunk)
    expect(messages).toHaveLength(count)
    expect(decoder.buffer.length).toBe(tail.length)
    // The retained tail must not share the multi-megabyte chunk's ArrayBuffer:
    // the decoder's logical buffer is tiny and so is its physical backing.
    expect(decoder.buffer.buffer).not.toBe(originalBacking)
    // A fresh copy has a small backing store (the tail length rounded to a
    // pool allocation), nowhere near the coalesced chunk's size.
    expect(decoder.buffer.buffer.byteLength).toBeLessThan(originalBacking.byteLength / 2)
    expect(decoder.buffer.buffer.byteLength).toBeLessThanOrEqual(MAX_HEADER_BYTES + 1024)
  })
})

/**
 * Content-Length JSON-RPC framing for the diagnostics runtime.
 *
 * The encoder produces one framed buffer per message; the decoder buffers
 * incoming bytes and yields complete parsed message bodies. Bounds are fixed
 * protocol invariants: one header block (header text plus the CRLFCRLF
 * terminator) is capped at `MAX_HEADER_BYTES`, enforced identically whether
 * the block arrives whole or split across chunks; the declared body length is
 * capped at the decoder's `maxMessageBytes`; and the retained undecoded
 * buffer can never exceed the header cap plus the body cap because a full
 * separator and a bounded declared length are both required before any body
 * is buffered. Any violation — oversized header, oversized or missing
 * Content-Length, malformed JSON — throws and is a fatal transport failure for
 * the consuming session.
 *
 * @module dsh-lsp-diagnostics/framing
 */

/** The fixed cap on one header block (text plus CRLFCRLF), in bytes. */
export const MAX_HEADER_BYTES = 8192

/** The header/body separator of the LSP base protocol. */
const HEADER_SEPARATOR = '\r\n\r\n'

/**
 * Encode a JSON-RPC message into a Content-Length framed buffer.
 * @param {unknown} message - the JSON-RPC message to serialize.
 * @returns {Buffer} the framed bytes ready to write to the server's stdin.
 */
export function encodeMessage(message) {
  const body = Buffer.from(JSON.stringify(message), 'utf8')
  const header = Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, 'ascii')
  return Buffer.concat([header, body])
}

/**
 * A streaming decoder for `Content-Length`-framed JSON-RPC. Feed it stdout
 * chunks; it returns every whole message body that completed. It parses only
 * the `Content-Length` header (case-insensitive) and ignores other headers.
 */
export class MessageDecoder {
  /**
   * @param {number} maxMessageBytes - hard cap on a single declared body length.
   */
  constructor(maxMessageBytes) {
    /** @type {Buffer} */
    this.buffer = Buffer.alloc(0)
    /** @type {number} */
    this.maxMessageBytes = maxMessageBytes
  }

  /**
   * Append a chunk and return every message body that is now complete.
   * @param {Buffer} chunk - raw bytes from the server's stdout.
   * @returns {unknown[]} the parsed JSON bodies, in arrival order (possibly empty).
   * @throws {Error} when a header is malformed, oversized, or a body exceeds bounds.
   */
  push(chunk) {
    this.buffer = this.buffer.length === 0 ? chunk : Buffer.concat([this.buffer, chunk])
    /** @type {unknown[]} */
    const messages = []
    for (;;) {
      const step = this.next()
      if (!step.ready) break
      messages.push(step.message)
    }
    return messages
  }

  /**
   * Parse and consume the next complete message, or report that more bytes are needed.
   * @returns {{ ready: false } | { ready: true, message: unknown }}
   */
  next() {
    const separator = this.buffer.indexOf(HEADER_SEPARATOR)
    if (separator < 0) {
      if (this.buffer.length > MAX_HEADER_BYTES) {
        throw new Error(`LSP header exceeded ${MAX_HEADER_BYTES} bytes without a terminator`)
      }
      return { ready: false }
    }
    // The cap covers the whole header block: header text plus the CRLFCRLF
    // terminator. The separator offset points at the start of the terminator,
    // so the block is `separator + HEADER_SEPARATOR.length` bytes. Checking
    // the offset alone would accept a 8192-byte text plus a 4-byte terminator
    // when the frame arrives whole but reject the identical header when it is
    // split after the 8192 header bytes; comparing the full block keeps both
    // chunkings identical.
    if (separator + HEADER_SEPARATOR.length > MAX_HEADER_BYTES) {
      throw new Error(`LSP header block exceeded ${MAX_HEADER_BYTES} bytes`)
    }
    const headerText = this.buffer.toString('ascii', 0, separator)
    const contentLength = parseContentLength(headerText)
    if (contentLength > this.maxMessageBytes) {
      throw new Error(`LSP message length ${contentLength} exceeds the ${this.maxMessageBytes}-byte limit`)
    }
    const bodyStart = separator + HEADER_SEPARATOR.length
    const bodyEnd = bodyStart + contentLength
    if (this.buffer.length < bodyEnd) {
      return { ready: false }
    }
    const bodyBytes = this.buffer.subarray(bodyStart, bodyEnd)
    this.buffer = this.buffer.subarray(bodyEnd)
    let body
    try {
      body = new TextDecoder('utf-8', { fatal: true }).decode(bodyBytes)
    } catch (error) {
      throw new Error(
        `LSP message body was not valid UTF-8: ${error instanceof Error ? error.message : String(error)}`,
      )
    }
    try {
      return { ready: true, message: JSON.parse(body) }
    } catch (error) {
      throw new Error(
        `LSP message body was not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
      )
    }
  }
}

/**
 * Read the `Content-Length` header value (case-insensitive), rejecting a
 * missing or non-numeric one.
 * @param {string} headerText - the header block before the terminator.
 * @returns {number} the declared body length in bytes.
 */
function parseContentLength(headerText) {
  /** @type {number | undefined} */
  let contentLength
  for (const line of headerText.split('\r\n')) {
    const colon = line.indexOf(':')
    if (colon < 0) continue
    if (line.slice(0, colon).trim().toLowerCase() !== 'content-length') continue
    if (contentLength !== undefined) {
      throw new Error('LSP header block contains duplicate Content-Length fields')
    }
    const rawValue = line.slice(colon + 1).trim()
    if (!/^[0-9]+$/.test(rawValue)) {
      throw new Error(`invalid Content-Length header: ${JSON.stringify(line)}`)
    }
    const value = Number(rawValue)
    if (!Number.isSafeInteger(value)) {
      throw new Error(`invalid Content-Length header: ${JSON.stringify(line)}`)
    }
    contentLength = value
  }
  if (contentLength === undefined) {
    throw new Error(`LSP header block missing Content-Length: ${JSON.stringify(headerText)}`)
  }
  return contentLength
}

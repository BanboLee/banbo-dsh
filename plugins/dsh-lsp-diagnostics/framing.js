/**
 * Content-Length JSON-RPC framing for the diagnostics runtime.
 *
 * Todo 1 skeleton: the bounded `MessageDecoder` and `encodeMessage` framing
 * helpers are implemented in Todo 3.
 *
 * @module dsh-lsp-diagnostics/framing
 */

/**
 * Encode a JSON-RPC message into a Content-Length frame.
 * @param {unknown} _message - the message to encode.
 * @returns {never} - implemented in Todo 3.
 */
export function encodeMessage(_message) {
  throw new Error('dsh-lsp-diagnostics: framing is implemented in Todo 3')
}

/**
 * Bounded LSP message decoder.
 * @param {number} _maxMessageBytes - hard cap on a single message body.
 * @returns {never} - implemented in Todo 3.
 */
export function MessageDecoder(_maxMessageBytes) {
  throw new Error('dsh-lsp-diagnostics: framing is implemented in Todo 3')
}

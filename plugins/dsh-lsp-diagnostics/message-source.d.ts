/**
 * The plugin-owned `MessageSourceMap` entry this plugin's aggregate diagnostics
 * notice needs.
 *
 * `@deepseek-ai/dsh-llm` 0.1.7-rc.2 removed the shared catch-all
 * `MessageSourceMap['plugin']` kind: the map is merge-extensible, so every
 * producer declares its own `kind` in its own module (as `dsh-agent` does for
 * `model-selection` and `dsh-tools` for `tool-registry`). A `declare module`
 * augmentation cannot live in a checked JavaScript file (TS8006), so it lives
 * here and `coordinator.js` pulls it into the program with
 * `/// <reference path="./message-source.d.ts" />`.
 *
 * @module @banbolee/dsh-lsp-diagnostics/message-source
 */

import type { ContextFormed } from '@deepseek-ai/dsh-llm'

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    /** One aggregate post-write diagnostics notice produced by this plugin. */
    'lsp-diagnostics': { kind: 'lsp-diagnostics' } & ContextFormed
  }
}

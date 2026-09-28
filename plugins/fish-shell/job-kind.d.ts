/**
 * The plugin-owned `JobKindMap` entry this plugin's background `fish` jobs
 * register under.
 *
 * `@deepseek-ai/dsh-jobs`' `JobKind` is `JobKindMap[keyof JobKindMap]` over a
 * merge-extensible map that carries only the harness's own producers, so every
 * third-party producer declares its own kind in its own module. A
 * `declare module` augmentation cannot live in a checked JavaScript file
 * (TS8006), so it lives here and `tool.js` pulls it into the program with
 * `/// <reference path="./job-kind.d.ts" />`.
 *
 * @module @banbolee/dsh-fish-shell/job-kind
 */

declare module '@deepseek-ai/dsh-jobs/view' {
  interface JobKindMap {
    /** One background fish command registered by this plugin's `fish` tool. */
    fish: 'fish'
  }
}

// Makes this file a module, so the block above AUGMENTS the jobs declaration
// instead of declaring an ambient module of the same name.
export {}

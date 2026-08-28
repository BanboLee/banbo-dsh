/**
 * Unconfined fish executor for DeepSeek Harness: a `LocalBashExecutor`
 * subclass that runs every command through `fish -c` instead of `bash -c`,
 * with NO sandbox wrapper.
 *
 * This is the `local` row of the fish executor family, mirroring
 * `@deepseek-ai/dsh-bash-local`: it spawns a managed process group through
 * `ctx.subprocess` and reuses all of bash-local's mechanics (resolve and
 * defaulting, deadline and cause classification, the model-friendly terminal
 * environment, bounded output with spill files, background process groups).
 *
 * Prefer {@link FishSandboxExecutor} (this package's default export) in any
 * composition that mounts `dsh-permission-presets`, which requires the
 * mounted `ctx.shell` executor to confine (`sandboxMode`). Mount this module
 * (`dsh-fish-shell/local`) only in custom compositions that deliberately run
 * without a sandbox.
 *
 * `@deepseek-ai/dsh-bash-local` resolves through the launcher-maintained
 * `profiles/node_modules` symlink chain, so this subclass shares the exact
 * runtime instance the harness runs.
 *
 * @module dsh-fish-shell/local
 */

import { LocalBashExecutor } from '@deepseek-ai/dsh-bash-local'

/**
 * Local fish executor without sandbox confinement.
 */
export class FishLocalExecutor extends LocalBashExecutor {
  /**
   * Run a command in the foreground through `fish -c`.
   * @param spec - a resolved spec from `resolve()`.
   * @returns the settled foreground result.
   */
  run(spec) {
    return this.runArgv(spec, ['fish', '-c', spec.command])
  }

  /**
   * Start a background process through `fish -c`.
   * @param spec - a resolved spec from `resolve()`.
   * @returns the live background process handle.
   */
  start(spec) {
    return this.startArgv(spec, ['fish', '-c', spec.command])
  }
}

export default FishLocalExecutor

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
 * The shell swap happens at the `executeArgv()` injection point
 * `LocalBashExecutor.execute` documents for subclasses: this executor
 * replaces the public command's shell argv and keeps every other mechanic
 * (including the single `execute()` entry the host calls for foreground AND
 * background work).
 *
 * Prefer {@link FishSandboxExecutor} (this package's default export) in any
 * composition that mounts `dsh-permission-presets`, which requires the
 * mounted `ctx.shell` executor to confine (`sandboxMode`). Mount this module
 * (`@banbolee/dsh-fish-shell/local`) only in custom compositions that deliberately run
 * without a sandbox.
 *
 * `@deepseek-ai/dsh-bash-local` resolves through the launcher-maintained
 * `profiles/node_modules` symlink chain, so this subclass shares the exact
 * runtime instance the harness runs.
 *
 * @module @banbolee/dsh-fish-shell/local
 */

import { LocalBashExecutor } from '@deepseek-ai/dsh-bash-local'

/**
 * Local fish executor without sandbox confinement.
 */
export class FishLocalExecutor extends LocalBashExecutor {
  /**
   * Prepare and spawn the command through `fish -c`. Foreground and
   * background callers share this one entry: whoever awaits
   * `result()` ran it in the foreground, whoever keeps the handle ran it in
   * the background.
   * @param {import('@deepseek-ai/dsh-shell').ShellExecSpec} spec - a resolved spec from `resolve()`.
   * @returns {Promise<import('@deepseek-ai/dsh-shell').ShellExecution>} the live execution handle.
   */
  async execute(spec) {
    return this.executeArgv(spec, ['fish', '-c', spec.command])
  }
}

export default FishLocalExecutor

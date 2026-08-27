/**
 * Fish sandbox executor for DeepSeek Harness: a `SandboxBashExecutor`
 * subclass that confines `fish -c` commands instead of `bash -c`. Mounted as
 * the `ctx.shell` provider in place of the base `bash-sandbox` executor.
 *
 * `SandboxBashExecutor.run`/`start` call the polymorphic `confine()`, so this
 * subclass only swaps the shell argv; the sandbox backend, denial
 * classification, runner-failure facts, and the `sandboxMode` capability fact
 * (which `dsh-permission-presets` requires of the mounted executor) are all
 * inherited unchanged.
 *
 * `@deepseek-ai/dsh-bash-sandbox` resolves through the launcher-maintained
 * `profiles/node_modules` symlink chain, so this subclass shares the exact
 * runtime instance the harness runs — no duplicate Cordis or Service class
 * copies.
 *
 * @module dsh-fish-shell
 */

import { SandboxBashExecutor } from '@deepseek-ai/dsh-bash-sandbox'

/**
 * Local fish executor under the configured sandbox backend. Reuses every
 * bash-sandbox mechanic with the public command's shell swapped from bash to
 * fish.
 */
export class FishSandboxExecutor extends SandboxBashExecutor {
  /**
   * Confine a `fish -c <command>` argv through the configured sandbox backend.
   * @param command - the fish command text.
   * @param policy - the resolved execution policy for this call.
   * @returns the provider's confined argv and settlement-classification facts.
   */
  confine(command, policy) {
    return this.ctx.sandbox.confine(['fish', '-c', command], policy)
  }
}

export default FishSandboxExecutor

/**
 * Fish sandbox executor for DeepSeek Harness: a `SandboxBashExecutor`
 * subclass that confines `fish -c` commands instead of `bash -c`. Mounted as
 * the `ctx.shell` provider in place of the base `bash-sandbox` executor.
 *
 * `SandboxBashExecutor.execute` bypasses `confine()` in
 * `danger-full-access` mode and falls through to the hardcoded `bash -c`
 * argv, so this subclass overrides both execution boundaries:
 *
 *   - {@link FishSandboxExecutor.execute}: the full-access branch runs
 *     `fish -c` through the inherited `executeArgv()` hook (stamping the same
 *     `sandbox` fact the base class would); confined modes delegate to the
 *     base class, whose confined branch calls `confine()` polymorphically.
 *   - {@link FishSandboxExecutor.confine}: swaps the confined inner shell from
 *     `bash -c` to `fish -c` through the same `ctx.sandbox` provider — the
 *     ONLY hook that decides which argv the sandbox wraps.
 *
 * The sandbox backend, denial classification, runner-failure facts, and the
 * `sandboxMode` capability fact (which `dsh-permission-presets` requires of
 * the mounted executor) are all inherited.
 *
 * `@deepseek-ai/dsh-bash-sandbox` resolves through the launcher-maintained
 * `profiles/node_modules` symlink chain, so this subclass shares the exact
 * runtime instance the harness runs — no duplicate Cordis or Service class
 * copies.
 *
 * @module @banbolee/dsh-fish-shell
 */

import { SandboxBashExecutor } from '@deepseek-ai/dsh-bash-sandbox'

/**
 * Local fish executor under the configured sandbox backend. Reuses every
 * bash-sandbox mechanic with the public command's shell swapped from bash to
 * fish.
 *
 * The class body declares `confine()` as well, which TypeScript reports as
 * TS2415 at the heritage clause: `SandboxBashExecutor` declares that hook
 * `private` while still dispatching to it virtually, and a private member
 * cannot be extended, so this one directive is the only way to express the
 * override. The directive is deliberately on the class line (where TS2415 is
 * reported) and stays narrow: every other member of the class is checked.
 */
// @ts-expect-error - overriding the base class's TS-private `confine()` execution boundary (see above).
export class FishSandboxExecutor extends SandboxBashExecutor {
  /**
   * Prepare and spawn one resolved command. Full-access calls run `fish -c`
   * unconfined; other modes delegate to the base class, whose confinement
   * preparation calls the polymorphic {@link confine}.
   * @param {import('@deepseek-ai/dsh-shell').ShellExecSpec} spec - a resolved spec from `resolve()`.
   * @returns {Promise<import('@deepseek-ai/dsh-shell').ShellExecution>} the live execution handle.
   */
  async execute(spec) {
    const policy = spec.sandboxPolicy
    if (policy?.mode === 'danger-full-access') {
      return this.decorateFishResult(
        await this.executeArgv(spec, ['fish', '-c', spec.command]),
        policy.mode,
      )
    }
    return super.execute(spec)
  }

  /**
   * Attach the sandbox facts the base class stamps for a full-access run:
   * the handle keeps its identity and `result()` is memoized, exactly like
   * the base class's own decoration (which this branch cannot reach, because
   * it also swaps the shell argv).
   * @param {import('@deepseek-ai/dsh-shell').ShellExecution} execution - the live handle from `executeArgv()`.
   * @param {import('@deepseek-ai/dsh-sandbox').SandboxMode} mode - the mode the command ran under.
   * @returns {import('@deepseek-ai/dsh-shell').ShellExecution} the same handle, its `result()` decorated once.
   */
  decorateFishResult(execution, mode) {
    const base = execution.result.bind(execution)
    let decorated
    execution.result = () => {
      decorated ??= base().then((result) => ({
        ...result,
        sandbox: { mode, denied: false },
      }))
      return decorated
    }
    return execution
  }

  /**
   * Confine a `fish -c <command>` argv through the configured sandbox
   * backend. The base class's confined branch calls this method virtually
   * (`this.confine(...)`), so overriding it is what makes every confined fish
   * command run fish (see the heritage-clause note above for the TS2415
   * directive this override needs).
   * @param {string} command - the fish command text.
   * @param {import('@deepseek-ai/dsh-sandbox').SandboxPolicy} policy - the resolved execution policy for this call.
   * @param {AbortSignal} [signal] - cancellation of confinement preparation.
   * @returns {Promise<import('@deepseek-ai/dsh-sandbox').ConfinedArgv>} the provider's confined argv and settlement-classification facts.
   */
  confine(command, policy, signal) {
    return this.ctx.sandbox.confine(['fish', '-c', command], policy, signal)
  }
}

export default FishSandboxExecutor

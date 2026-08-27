/**
 * Fish sandbox executor for DeepSeek Harness: a `SandboxBashExecutor`
 * subclass that confines `fish -c` commands instead of `bash -c`. Mounted as
 * the `ctx.shell` provider in place of the base `bash-sandbox` executor.
 *
 * `SandboxBashExecutor.run`/`start` bypass `confine()` in
 * `danger-full-access` mode and fall through to the hardcoded `bash -c`
 * argv, so this subclass overrides both entry points: the full-access branch
 * runs `fish -c` through `runArgv`/`startArgv`, while confined modes delegate
 * to the base class (which calls the polymorphic `confine()`). The sandbox
 * backend, denial classification, runner-failure facts, and the
 * `sandboxMode` capability fact (which `dsh-permission-presets` requires of
 * the mounted executor) are all inherited.
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
   * Run a command in the foreground. Full-access calls run `fish -c`
   * unconfined (stamping the same sandbox fact the base class would); other
   * modes delegate to the base class, which confines through
   * {@link confine}.
   * @param spec - a resolved spec from `resolve()`.
   * @returns the settled foreground result.
   */
  run(spec) {
    const policy = spec.sandboxPolicy
    if (policy?.mode === 'danger-full-access') {
      return this.runArgv(spec, ['fish', '-c', spec.command]).then((result) => ({
        ...result,
        sandbox: { mode: policy.mode, denied: false },
      }))
    }
    return super.run(spec)
  }

  /**
   * Start a background process. Full-access calls spawn `fish -c`
   * unconfined; other modes delegate to the base class.
   * @param spec - a resolved spec from `resolve()`.
   * @returns the live background process handle.
   */
  start(spec) {
    const policy = spec.sandboxPolicy
    if (policy?.mode === 'danger-full-access') {
      return this.startArgv(spec, ['fish', '-c', spec.command])
    }
    return super.start(spec)
  }

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

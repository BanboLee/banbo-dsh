import { configDefaults, defineConfig } from 'vitest/config'

/**
 * Composition lane config.
 *
 * `tests/composition/**` boots REAL isolated DSH profiles and real subprocesses
 * through the `dsh` CLI. That makes it slow and resource-hungry enough that
 * running it beside the unit suite competes for the runner and buries its own
 * signal, so the default `pnpm test` config excludes it.
 *
 * The exclusion has to be lifted here, not merely overridden on the command
 * line: vitest applies `exclude` to explicitly named paths too, so
 * `vitest run tests/composition` under the default config matches nothing and
 * exits 1. That is the same reason this repository keeps a separate config for
 * the Gate lane. Invoke with `pnpm test:composition`.
 *
 * File parallelism is off: these specs each boot their own profile and spawn
 * their own processes, and running several at once is what made the failure
 * look like contention when it was not.
 */
export default defineConfig({
  test: {
    exclude: [...configDefaults.exclude, '**/.omo/**'],
    fileParallelism: false,
  },
})

import { configDefaults, defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    // Extend the framework-native default excludes (never replace them) so the
    // git-ignored `.omo` evidence tree can never be collected as product test
    // discovery during a full `vitest run`. The default include glob is left
    // untouched: every legitimate repository test is still discovered.
    //
    // The agents platform-Gate probes and the packed-artifact lane are excluded
    // on purpose (docs/agents-plugin-plan.md §15/§16): Gate green must be
    // observed on its own lane rather than inferred from an overall green run,
    // and the packed lane needs `node plugins/agents/scripts/build.mjs` first.
    // Run them with `pnpm test:agents:gates`.
    //
    // The composition suite is excluded for a different reason: it boots REAL
    // isolated DSH profiles and real subprocesses through the `dsh` CLI, which
    // makes it a slow, resource-hungry lane that competes with the unit suite
    // and buries its own signal. It runs on its own with `pnpm test:composition`
    // (and in its own CI job, with file parallelism off) — coverage is moved,
    // never dropped.
    exclude: [
      ...configDefaults.exclude,
      '**/.omo/**',
      'tests/composition/**',
      'plugins/agents/tests/gates/**',
      'plugins/agents/tests/packed.spec.ts',
    ],
  },
})

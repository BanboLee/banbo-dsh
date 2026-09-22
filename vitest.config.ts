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
    exclude: [
      ...configDefaults.exclude,
      '**/.omo/**',
      'plugins/agents/tests/gates/**',
      'plugins/agents/tests/packed.spec.ts',
    ],
  },
})

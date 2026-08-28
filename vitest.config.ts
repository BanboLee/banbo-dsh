import { configDefaults, defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    // Extend the framework-native default excludes (never replace them) so the
    // git-ignored `.omo` evidence tree can never be collected as product test
    // discovery during a full `vitest run`. The default include glob is left
    // untouched: every legitimate repository test is still discovered.
    exclude: [...configDefaults.exclude, '**/.omo/**'],
  },
})

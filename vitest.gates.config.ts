import { configDefaults, defineConfig } from 'vitest/config'

/**
 * Gate / packed-artifact lane config — docs/agents-plugin-plan.md §15.
 *
 * The default `pnpm test` config deliberately EXCLUDES the platform Gates and
 * the packed lane so an overall green run can never stand in for Gate green.
 * The ordinary lane still reads the built `lib/` artifacts (the generated Host
 * Remote and the classic client bundle), so CI runs `pnpm build:agents` before
 * it and this lane additionally packs the tarball. Invoke with
 * `pnpm test:agents:gates`.
 */
export default defineConfig({
  test: {
    exclude: [...configDefaults.exclude, '**/.omo/**'],
  },
})

# Third-party notices — `@banbolee/dsh-fish-shell`

This package distributes third-party code inside its tarball. The runtime
dependency listed under `bundledDependencies` in `package.json` — and its
transitive dependencies — are packed as real files under
`package/node_modules/**` by the release chain
(`pnpm install --prod --config.node-linker=hoisted` then
`pnpm pack --config.node-linker=hoisted`), so an offline profile can install
the bundle without fetching them separately.

This file records the origin, version and license of each bundled package. It
is a human-readable provenance note, **not** a replacement for the license
texts: every bundled package ships its own `LICENSE` file inside the tarball,
and that packaged file is the authoritative text. The license names below come
from the packaged `LICENSE` file and the package's own `package.json`; where
either was ambiguous this file would say "see the packaged LICENSE" instead of
naming one.

## Bundled inventory

| Package | Version | License | Location inside the tarball |
|---|---|---|---|
| `@deepseek-ai/dsh-tool-terminal` | `0.2.0-rc.1` | MIT | `package/node_modules/@deepseek-ai/dsh-tool-terminal/` |
| `@deepseek-ai/schemastery` | `3.18.4` | MIT | `package/node_modules/@deepseek-ai/schemastery/` |
| `@deepseek-ai/cosmokit` | `1.8.5` | MIT | `package/node_modules/@deepseek-ai/cosmokit/` |
| `@standard-schema/spec` | `1.1.0` | MIT | `package/node_modules/@standard-schema/spec/` |

Dependency edges, as declared by the packaged manifests:

- `@deepseek-ai/dsh-tool-terminal@0.2.0-rc.1` → `@deepseek-ai/schemastery ~3.18.4`
- `@deepseek-ai/schemastery@3.18.4` → `@standard-schema/spec ^1.1.0`, `@deepseek-ai/cosmokit ~1.8.5`
- `@standard-schema/spec@1.1.0` and `@deepseek-ai/cosmokit@1.8.5` → no runtime dependencies

Those four packages are the complete `node_modules/` inventory of the packed
tarball; each of them includes its `LICENSE` file.

## `@deepseek-ai/dsh-tool-terminal` 0.2.0-rc.1 — MIT

- Origin: `git+https://github.com/deepseek-ai/deepseek-harness.git`, directory
  `packages/terminal/tool-terminal` (from the packaged `package.json`
  `repository`).
- License: MIT (`package.json` `"license": "MIT"`), license text header
  "MIT License", copyright notice `Copyright (c) 2026 DeepSeek`.
- Role here: the six model-facing `terminal_*` tools mounted by the
  `terminal-tools` row of this bundle's `cordis.patch.yml`. It is declared as a
  `dependencies` + `bundledDependencies` entry of this package, not as a peer,
  so it resolves from inside this package.

## `@deepseek-ai/schemastery` 3.18.4 — MIT

- Origin: `git+https://github.com/deepseek-ai/deepseek-harness.git`, directory
  `vendor/schemastery` (from the packaged `package.json` `repository`).
- License: MIT (`package.json` `"license": "MIT"`), license text header
  "MIT License", copyright notice `Copyright (c) 2021-present Shigma`
  (packaged `author`: `Shigma <shigma10826@gmail.com>`).
- Role here: transitive runtime dependency of
  `@deepseek-ai/dsh-tool-terminal`.

## `@deepseek-ai/cosmokit` 1.8.5 — MIT

- Origin: `git+https://github.com/deepseek-ai/deepseek-harness.git`, directory
  `vendor/cosmokit` (from the packaged `package.json` `repository`).
- License: MIT (`package.json` `"license": "MIT"`), license text header
  "MIT License", copyright notice `Copyright (c) 2021-present Shigma`
  (packaged `author`: `Shigma <shigma10826@gmail.com>`).
- Role here: transitive runtime dependency of `@deepseek-ai/schemastery`.

## `@standard-schema/spec` 1.1.0 — MIT

- Origin: `https://github.com/standard-schema/standard-schema` (from the
  packaged `package.json` `repository`; packaged `homepage`:
  `https://standardschema.dev`).
- License: MIT (`package.json` `"license": "MIT"`), license text header
  "MIT License", copyright notice `Copyright (c) 2024 Colin McDonnell`
  (packaged `author`: `Colin McDonnell`).
- Role here: transitive runtime dependency of `@deepseek-ai/schemastery`.

## Re-verifying this inventory

After packing, list the tarball and check the four packages (and their
`LICENSE` files) are present:

```sh
pnpm install --prod --config.node-linker=hoisted
pnpm pack --config.node-linker=hoisted
tar tzf banbolee-dsh-fish-shell-*.tgz | grep '^package/node_modules/'
```

Version bumps of the bundled dependency must update this file together with
`dependencies` in `package.json` (the version pin is asserted by the
plugin's contract tests).

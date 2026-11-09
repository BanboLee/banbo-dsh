import { chmodSync, copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { runChild } from './process.mjs'

export const DSH_PACKAGE_NAME = '@deepseek-ai/dsh'
export const TUI_PACKAGE_NAME = '@deepseek-harness-tui/dsh-tui'

export const BUNDLES = [
  ['plugins/fish-shell', '@banbolee/dsh-fish-shell'],
  ['plugins/rtk', '@banbolee/dsh-rtk'],
  ['plugins/dsh-lsp-diagnostics', '@banbolee/dsh-lsp-diagnostics'],
  ['plugins/agents', '@banbolee/dsh-agents'],
]

export function writeToolWrappers(layout, tools) {
  const wrappers = {
    dsh: join(layout.bin, 'dsh'),
    pnpm: join(layout.bin, 'pnpm'),
  }
  // The dsh target is the candidate's REAL package entry (`lib/bin.js`), not
  // the prefix's `bin/dsh` symlink. dsh-tui 0.18's host entry locates the host
  // package by following the `.js` script token of the `dsh` launcher on PATH
  // (`findHostDsh`); a wrapper spelling the extension-less prefix link makes it
  // report "starts no @deepseek-ai/dsh script" and fall back to `dsh --profile`,
  // so the new host-entry path would never be exercised. Fake paths in tests are
  // kept verbatim (there is nothing to resolve).
  const dshTarget = existsSync(tools.dsh) ? realpathSync(tools.dsh) : tools.dsh
  writeFileSync(wrappers.dsh, `#!/bin/sh\nexec "${tools.node}" "${dshTarget}" "$@"\n`, { mode: 0o700 })
  writeFileSync(wrappers.pnpm, `#!/bin/sh\nexec "${tools.pnpm}" "$@"\n`, { mode: 0o700 })
  chmodSync(wrappers.dsh, 0o700)
  chmodSync(wrappers.pnpm, 0o700)
  return wrappers
}

export function readDshWrapperTarget(wrapper) {
  const match = /^exec "[^"]+" "([^"]+)" "\$@"$/m.exec(readFileSync(wrapper, 'utf8'))
  if (match === null) throw new Error(`invalid dsh wrapper: ${wrapper}`)
  return match[1]
}

export function resolveDshInstallationBin(candidate) {
  const content = readFileSync(candidate, 'utf8')
  return content.startsWith('#!/bin/sh\nexec "') ? readDshWrapperTarget(candidate) : realpathSync(candidate)
}

/**
 * The dsh-tui first-run wizard revision this QA lane pins complete.
 *
 * dsh-tui 0.18 always renders its onboarding wizard on a fresh `$HOME`; its
 * `❯` is a wizard cursor, not the chat prompt, so a lane that waits for `❯`
 * would accept the wizard as "ready" and its `/exit` would be swallowed. The
 * lane is a non-interactive QA machine, not a first-run user, so the fixture
 * state is seeded instead of walked through — and recorded in the report.
 */
export const ONBOARDING_FIXTURE = Object.freeze({ completed: true, version: 1 })

/** Write the onboarding fixture into a QA home and return its provenance record. */
export function seedOnboardingFixture(home) {
  const directory = join(home, '.dsh-tui')
  const path = join(directory, 'onboarding.json')
  mkdirSync(directory, { recursive: true })
  writeFileSync(path, `${JSON.stringify(ONBOARDING_FIXTURE, null, 2)}\n`)
  return { path, ...ONBOARDING_FIXTURE, preseeded: true, reason: 'deterministic QA home: dsh-tui 0.18 otherwise renders its first-run wizard, whose prompt is not the chat surface' }
}

/** The seeded onboarding record, or `undefined` when the fixture is absent. */
export function readOnboardingFixture(home) {
  const path = join(home, '.dsh-tui', 'onboarding.json')
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'))
    return { path, completed: parsed?.completed === true, version: typeof parsed?.version === 'number' ? parsed.version : 0 }
  } catch {
    return undefined
  }
}

/** Same target after symlink resolution; `false` when either path is missing. */
function sameFile(left, right) {
  try {
    return realpathSync(left) === realpathSync(right)
  } catch {
    return resolve(left) === resolve(right)
  }
}

/**
 * The package root a launcher belongs to: `realpath` the launcher, then walk up
 * until an ancestor `package.json` declares `expectedName`.
 *
 * The upgrade lane used to derive the dsh-tui package from the dsh binary with a
 * sibling assumption (`<dsh package>/../../../@deepseek-harness-tui/dsh-tui`),
 * which only holds for one global-install layout. A candidate installed with
 * `npm install --global --prefix /tmp/<prefix>` keeps the same launcher→package
 * relation, so the package root is derived from the injected `--dsh-tui-bin`
 * instead. A launcher that is not inside its own package fails loud rather than
 * silently falling back to some other install.
 */
export function packageRootFromBin(launcher, expectedName) {
  if (typeof expectedName !== 'string' || expectedName.length === 0) {
    throw new Error('packageRootFromBin requires the expected package name')
  }
  let realLauncher
  try {
    realLauncher = realpathSync(launcher)
  } catch {
    throw new Error(`the candidate launcher does not exist: ${launcher}`)
  }
  let directory = dirname(realLauncher)
  for (;;) {
    const manifestPath = join(directory, 'package.json')
    if (existsSync(manifestPath)) {
      const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
      if (manifest?.name === expectedName) return { root: directory, manifest }
    }
    const parent = dirname(directory)
    if (parent === directory) {
      throw new Error(`cannot derive the ${expectedName} package root from ${realLauncher}: no ancestor package.json declares that name`)
    }
    directory = parent
  }
}

/**
 * The TUI entry point the candidate profile actually installs.
 *
 * G5's PTY case and G6's TUI scenarios launch THIS path, never a global
 * installation: the profile root is the `dsh plugin add` target, and the version
 * is checked against the matrix by the callers so a profile that resolved some
 * other release cannot be exercised as the candidate.
 */
export function profileTuiEntry(dshHome, profileName = 'dsh-tui') {
  const profileRoot = join(dshHome, 'profiles', profileName)
  const packageRoot = join(profileRoot, 'node_modules', TUI_PACKAGE_NAME)
  const manifestPath = join(packageRoot, 'package.json')
  if (!existsSync(manifestPath)) {
    throw new Error(`the ${profileName} profile does not install ${TUI_PACKAGE_NAME}: ${manifestPath} is missing`)
  }
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  if (manifest?.name !== TUI_PACKAGE_NAME || typeof manifest.version !== 'string') {
    throw new Error(`the ${profileName} profile's ${TUI_PACKAGE_NAME} manifest is invalid: ${manifestPath}`)
  }
  const entryPath = join(packageRoot, 'bin', 'dsh-tui.js')
  if (!existsSync(entryPath)) {
    throw new Error(`the ${profileName} profile's ${TUI_PACKAGE_NAME} has no bin/dsh-tui.js: ${entryPath}`)
  }
  return {
    profileRoot,
    packageRoot,
    entryPath,
    entryRealpath: realpathSync(entryPath),
    packageName: manifest.name,
    packageVersion: manifest.version,
  }
}

/**
 * Stage the published `@deepseek-harness-tui/dsh-tui` package for `pnpm pack`
 * and return its rewritten manifest.
 *
 * The published manifest already carries a curated `bundledDependencies` list
 * (the vendored `@dsh-std/*`, `@dsh-tui-vendor/mathjax-tex-svg` and the bundled
 * `@deepseek-harness-tui/dsh-auth`). Replacing that list with
 * `Object.keys(dependencies)` — what this staging used to do — produced a
 * tarball whose `plugin-host`, `extensions` and `oauth` rows could not import
 * their vendored bundles: those rows recorded activation errors, the main
 * `dsh-tui` row stayed pending on the services they own, and the QA lanes kept
 * reporting green. The UNION of both lists is the only shape that works in
 * both directions: the published list keeps the vendored copies a real install
 * depends on, while the dependency list keeps the tarball self-contained (the
 * published list alone fails an install against a cold store with
 * ERR_PNPM_NO_OFFLINE_META).
 */
export function stageTuiPackage(targetTui, stagedTui) {
  cpSync(targetTui, stagedTui, { recursive: true })
  const tuiPackagePath = join(stagedTui, 'package.json')
  const tuiPackage = JSON.parse(readFileSync(tuiPackagePath))
  const publishedBundles = Array.isArray(tuiPackage.bundledDependencies) ? tuiPackage.bundledDependencies : []
  tuiPackage.bundledDependencies = [...new Set([...publishedBundles, ...Object.keys(tuiPackage.dependencies ?? {})])]
  delete tuiPackage.scripts.prepare
  writeFileSync(tuiPackagePath, `${JSON.stringify(tuiPackage, null, 2)}\n`)
  return tuiPackage
}

export async function packBundles(repoRoot, layout, pnpm, environment, targetTui) {
  const tarballs = []
  const stagedTui = join(layout.root, 'target-tui')
  const tuiPackage = stageTuiPackage(targetTui, stagedTui)
  await runChild(pnpm, [
    '--config.node-linker=hoisted',
    '--config.ignore-scripts=true',
    '--dir', stagedTui,
    'pack',
    '--pack-destination', layout.packs,
  ], {
    cwd: repoRoot,
    env: environment,
  })
  tarballs.push(join(layout.packs, `deepseek-harness-tui-dsh-tui-${tuiPackage.version}.tgz`))
  rmSync(stagedTui, { recursive: true, force: true })
  for (const [directory, name] of BUNDLES) {
    const source = join(repoRoot, directory)
    const manifest = JSON.parse(readFileSync(join(source, 'package.json')))
    if (directory === 'plugins/fish-shell') {
      // fish-shell bundles `@deepseek-ai/dsh-tool-terminal`, and pnpm refuses
      // to pack bundledDependencies when the tree was resolved with the
      // default linker (ERR_PNPM_BUNDLED_DEPENDENCIES_WITHOUT_HOISTED). The
      // install and the pack therefore both run with the hoisted linker, and
      // they run on a STAGED COPY: installing inside the checkout would
      // resolve against the repository's pnpm workspace, which would prune the
      // workspace devDependencies and rewrite the workspace node_modules
      // layout — and a symlinked (isolated) tree packs symlinks into the
      // tarball instead of the bundled files. `layout.root` is an isolated
      // temp directory outside the workspace, so the staged copy is its own
      // project. The copy drops `node_modules/` (its entries are symlinks
      // into the checkout); the install recreates them as real files.
      const staged = join(layout.root, 'target-fish-shell')
      rmSync(staged, { recursive: true, force: true })
      cpSync(source, staged, {
        recursive: true,
        filter: (entry) => basename(entry) !== 'node_modules',
      })
      try {
        await runChild(pnpm, [
          'install',
          '--prod',
          '--config.node-linker=hoisted',
          '--config.auto-install-peers=false',
        ], {
          cwd: staged,
          env: environment,
        })
        await runChild(pnpm, [
          '--config.node-linker=hoisted',
          '--dir', staged,
          'pack',
          '--pack-destination', layout.packs,
        ], {
          cwd: layout.root,
          env: environment,
        })
      } finally {
        rmSync(staged, { recursive: true, force: true })
      }
    } else {
      await runChild(pnpm, ['--dir', source, 'pack', '--pack-destination', layout.packs], {
        cwd: repoRoot,
        env: environment,
      })
    }
    // pnpm writes a scoped package's tarball as `<scope>-<name>-<version>.tgz`
    // (`@` stripped, `/` replaced by `-`) — the same shape the staged dsh-tui
    // tarball above uses. Keeping the `@`/`/` would hand installProfile a path
    // that does not exist.
    const tarballName = `${name.replace('@', '').replace('/', '-')}-${manifest.version}.tgz`
    tarballs.push(join(layout.packs, tarballName))
  }
  return tarballs
}

/**
 * Install the packed tarballs into the QA profile through the INJECTED dsh.
 *
 * `wrapper` is the QA `dsh` wrapper rendered from the caller's `--dsh-bin` and
 * `--node-bin`; `dshBin` is that same injected launcher. The wrapper target is
 * checked against it so the lane cannot fall back to a host-global dsh: before
 * this contract the profile was always built by whatever `dsh` the machine had.
 */
export async function installProfile({ wrapper, dshBin }, tarballs, repoRoot, environment) {
  const wrapperTarget = readDshWrapperTarget(wrapper)
  // The wrapper targets the candidate's realpath (`…/lib/bin.js`); the caller
  // may pass either that entry or the prefix's `bin/dsh` symlink, so the check
  // compares the files, not the spellings.
  if (!sameFile(wrapperTarget, dshBin)) {
    throw new Error(`the QA dsh wrapper delegates to ${wrapperTarget}, not the injected --dsh-bin ${dshBin}`)
  }
  // `--prefer-offline`, not `--offline`: an externally installed candidate lane
  // runs with an ISOLATED HOME, whose pnpm store starts empty, and a bundle may
  // legitimately declare unbundled runtime dependencies (agents: yaml, zod).
  // `--offline` then fails at `ERR_PNPM_NO_OFFLINE_TARBALL` before any gate can
  // run. The store is still consulted first, and every downloaded package lands
  // in the isolated QA home. Tarball self-containment keeps its own dedicated
  // assertions (see `stageTuiPackage` and `scripts/qa/fish-packed-offline.mjs`).
  await runChild(wrapper, [
    'plugin', '--profile', 'dsh-tui', 'add', '-w',
    ...tarballs,
    '--prefer-offline',
    '--config.auto-install-peers=false',
  ], { cwd: repoRoot, env: environment })
}

function render(template, values) {
  return template.replace(/\{\{([A-Z_]+)\}\}/g, (_match, name) => {
    const value = values[name]
    if (typeof value !== 'string') throw new Error(`missing template value ${name}`)
    return value
  })
}

export function renderProfileFiles(repoRoot, layout, environment) {
  const fixtures = join(repoRoot, 'scripts', 'qa', 'fixtures')
  const values = {
    QA_LOOPBACK_PORT: environment.QA_LOOPBACK_PORT,
    QA_TS_LSP: environment.QA_TS_LSP,
    QA_GOPLS: environment.QA_GOPLS,
    QA_RTK: environment.QA_RTK,
  }
  writeFileSync(
    join(layout.dshHome, 'settings.yaml'),
    render(readFileSync(join(fixtures, 'dsh-tui-qa-settings.yaml'), 'utf8'), values),
  )
  writeFileSync(
    join(layout.dshHome, 'profiles', 'dsh-tui', 'cordis.patch.yml'),
    render(readFileSync(join(fixtures, 'dsh-tui-qa.patch.yml'), 'utf8'), values),
  )
  cpSync(join(fixtures, 'workspace'), layout.workspace, { recursive: true })
  copyFileSync(join(fixtures, 'workspace', 'qa-symbol.ts'), join(layout.workspace, 'qa-symbol.ts'))
  // The QA home is a non-interactive machine: seed the first-run state so the
  // 0.18 TUI goes straight to the chat surface. Returned so the caller can put
  // the provenance into evidence.
  return { onboarding: seedOnboardingFixture(layout.home) }
}

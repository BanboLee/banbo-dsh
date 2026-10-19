#!/usr/bin/env node
/**
 * The six-package release lane — one CLI, four subcommands.
 *
 * Why a script and not raw `run:` blocks: the lane is a stateful sequence over
 * six packages with three properties a shell block makes hard to hold:
 *
 *   - **fail closed, per package.** Every package is validated (manifest, tar
 *     safety, its own special hazard) before ANY publish, and a published
 *     version is verified against the registry afterwards.
 *   - **resumable without re-publishing.** npm versions are immutable, so a
 *     partial failure must be diagnosable and resumable, never blindly retried.
 *     The journal carries each package's state and integrity across steps.
 *   - **the same artefact is packed once and published from the tarball**, so
 *     "what we tested" and "what reached the registry" cannot drift.
 *
 * Subcommands (the workflow runs them in this order):
 *
 *   preflight  verify the dispatch may proceed at all (sha, branch, clean tree)
 *              and classify every version against the registry.
 *   pack       pack all six, validate each tarball, write the journal.
 *   publish    publish the packed tarballs serially under a candidate dist-tag,
 *              verifying registry integrity per package.
 *   finalize   promote `latest`, drop the candidate tag, create the annotated
 *              tags and GitHub Releases.
 *
 * Every subcommand rewrites the journal, so an uploaded journal always describes
 * the furthest state the run reached.
 *
 * @module banbo-release
 */

import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  BUILT_PACKAGES,
  RELEASE_PACKAGES,
  STAGED_PACKAGES,
} from './lib/packages.mjs'
import { assertNpmCapability, MIN_NPM_VERSION } from './lib/npm-capability.mjs'
import { parsePackJson } from './lib/pack-result.mjs'
import {
  assertBuiltEntriesPresent,
  assertBundledDependencyPresent,
  assertManifestMatchesTarball,
  assertRelativeImportsShipped,
  assertSafeMembers,
  parseMemberListing,
} from './lib/tarball.mjs'
import {
  createJournal,
  isPublished,
  readJournal,
  resumability,
  setPackageState,
  setStep,
  summarise,
  writeJournal,
} from './lib/journal.mjs'
import {
  REGISTRY,
  assertRegistryIntegrity,
  classifyPublishedVersion,
  distTagVersion,
  publishedIntegrity,
} from './lib/registry.mjs'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')

/** Tarball members the agents bundle must ship (its build output + descriptors). */
const AGENTS_REQUIRED_ENTRIES = Object.freeze([
  'package/lib/catalog-remote.js',
  'package/lib/client.js',
  'package/lib/typert.host.js',
  'package/lib/typert.host.d.ts',
  'package/lib/typert.remote-client.js',
  'package/lib/typert.remote-client.d.ts',
  'package/lib/types/catalog-remote.d.ts',
  'package/lib/types/client/index.d.ts',
])

/* ------------------------------------------------------------------ shell --- */

/**
 * Run one command, returning stdout and failing loudly on a non-zero exit.
 *
 * @param {string} command executable.
 * @param {readonly string[]} args arguments.
 * @param {object} [options] `cwd` and `env` overrides.
 * @returns {string} trimmed stdout.
 */
function run(command, args, options = {}) {
  try {
    return execFileSync(command, [...args], {
      cwd: options.cwd ?? repoRoot,
      env: options.env ?? process.env,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      maxBuffer: 64 * 1024 * 1024,
    }).trim()
  } catch (error) {
    const stderr = String(error?.stderr ?? '').trim()
    const stdout = String(error?.stdout ?? '').trim()
    const detail = stderr === '' ? stdout : stderr
    throw new Error(`${command} ${args.join(' ')} failed${detail === '' ? '' : `:\n${detail}`}`)
  }
}

/** Run one command and return both streams, without throwing on a non-zero exit. */
function tryRun(command, args, options = {}) {
  try {
    const stdout = run(command, args, options)
    return { ok: true, stdout }
  } catch (error) {
    return { ok: false, stderr: String(error?.message ?? error) }
  }
}

/* -------------------------------------------------------------- arguments --- */

/**
 * Parse `--flag value` / `--flag=value` / `--switch` arguments.
 *
 * @param {readonly string[]} argv arguments after the subcommand.
 * @returns {Map<string, string | true>} the parsed flags.
 */
function parseFlags(argv) {
  const flags = new Map()
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]
    if (!token.startsWith('--')) throw new Error(`unexpected argument ${JSON.stringify(token)}`)
    const body = token.slice(2)
    const equals = body.indexOf('=')
    if (equals !== -1) {
      flags.set(body.slice(0, equals), body.slice(equals + 1))
      continue
    }
    const next = argv[index + 1]
    if (next !== undefined && !next.startsWith('--')) {
      flags.set(body, next)
      index += 1
    } else {
      flags.set(body, true)
    }
  }
  return flags
}

/** Read one required string flag. */
function requireFlag(flags, name) {
  const value = flags.get(name)
  if (typeof value !== 'string' || value === '') throw new Error(`--${name} is required`)
  return value
}

/** Read one optional string flag. */
function optionalFlag(flags, name) {
  const value = flags.get(name)
  return typeof value === 'string' && value !== '' ? value : undefined
}

/* ------------------------------------------------------------- manifests --- */

/** Read one package's declared manifest from the checkout. */
function readManifest(directory) {
  const path = join(repoRoot, directory, 'package.json')
  if (!existsSync(path)) throw new Error(`missing manifest ${path}`)
  return JSON.parse(readFileSync(path, 'utf8'))
}

/**
 * Read the six packages' versions from the checkout.
 *
 * The release list is authoritative: a package that disappeared from the
 * checkout is a hard error rather than a silent five-package release.
 *
 * @returns {Array<{ directory: string, package: string, version: string, manifest: object }>}
 */
function readReleasePlan() {
  return RELEASE_PACKAGES.map((entry) => {
    const manifest = readManifest(entry.directory)
    if (manifest.name !== entry.package) {
      throw new Error(`${entry.directory}/package.json declares "${manifest.name}", expected "${entry.package}"`)
    }
    const version = manifest.version
    if (typeof version !== 'string' || version === '') {
      throw new Error(`${entry.package} declares no version`)
    }
    return { ...entry, version, manifest }
  })
}

/* ------------------------------------------------------------- tarballs --- */

/** The directory holding packed tarballs and their extracted manifests. */
function artifactsDir(flags) {
  const dir = resolve(repoRoot, requireFlag(flags, 'artifacts'))
  mkdirSync(dir, { recursive: true })
  return dir
}

/**
 * Read the tarball listing through both `tar` modes.
 *
 * @param {string} tarball absolute tarball path.
 * @returns {import('./lib/tarball.mjs').MemberListing} the parsed listing.
 */
function listTarball(tarball) {
  const names = run('tar', ['-tzf', tarball])
  const verbose = run('tar', ['-tvzf', tarball])
  return parseMemberListing(names, verbose)
}

/**
 * Read one member's text out of a tarball without extracting the whole thing.
 *
 * @param {string} tarball absolute tarball path.
 * @param {string} member member path (including the `package/` prefix).
 * @returns {string} the member's text.
 */
function readMember(tarball, member) {
  return run('tar', ['-xzOf', tarball, member])
}

/**
 * Extract one tarball to a fresh directory under `destination`.
 *
 * @param {string} tarball absolute tarball path.
 * @param {string} destination extraction root.
 * @returns {string} the extracted `package/` directory.
 */
function extractTarball(tarball, destination) {
  mkdirSync(destination, { recursive: true })
  run('tar', ['-xzf', tarball, '-C', destination])
  return join(destination, 'package')
}

/**
 * Validate one packed tarball, failing closed.
 *
 * The order is deliberate: structural rules first (a tarball whose members
 * escape cannot be reasoned about), then identity (is this the package and
 * version we planned?), then the package's own hazard.
 *
 * @param {object} options `entry`, `packed`, `tarball`.
 * @returns {object} the validated facts recorded in the journal.
 */
function validateTarball(options) {
  const { entry, packed, tarball } = options
  const listing = listTarball(tarball)
  assertSafeMembers(listing)

  if (packed.name !== entry.package) {
    throw new Error(`${tarball} packs "${packed.name}", expected "${entry.package}"`)
  }
  if (packed.version !== entry.version) {
    throw new Error(`${tarball} packs version ${packed.version}, expected ${entry.version}`)
  }

  const packedManifest = JSON.parse(readMember(tarball, 'package/package.json'))
  assertManifestMatchesTarball(packedManifest, entry.manifest)

  if (STAGED_PACKAGES.has(entry.package)) {
    // fish-shell: the bundled terminal tool must have travelled inside.
    assertBundledDependencyPresent(listing, entry.manifest.bundledDependencies ?? [])
  }
  if (BUILT_PACKAGES.has(entry.package)) {
    // agents: the built Host/client surface must have travelled inside, and
    // every relative import of a shipped root module must resolve within it.
    assertBuiltEntriesPresent(listing, AGENTS_REQUIRED_ENTRIES)
    assertRelativeImportsShipped(listing, (relative) => readFileSync(join(repoRoot, entry.directory, relative), 'utf8'))
  }
  return { memberCount: listing.names.length }
}

/* -------------------------------------------------------------- journal --- */

/** Resolve the journal path for this dispatch. */
function journalPath(flags) {
  return resolve(repoRoot, requireFlag(flags, 'journal'))
}

/** Write the journal and echo a one-line summary (the workflow logs it). */
function persistJournal(path, journal) {
  const written = writeJournal(path, journal)
  process.stdout.write(`${summarise(written)}\n`)
  return written
}

/* ------------------------------------------------------------- preflight --- */

/**
 * Assert this checkout can create annotated tags and push them.
 *
 * Both facts are prerequisites of the LAST step of an irreversible sequence, so
 * discovering them there is the worst possible time: the six versions are already
 * on the registry, `latest` is already moved, and the release has no tag.
 *
 * What is checked, and why each one:
 *
 *   - `user.name` and `user.email` — `git tag -a` refuses to run without them. A
 *     CI checkout has no identity by default; the workflow sets one, and this
 *     check is what makes a mis-wired workflow fail BEFORE publishing.
 *   - a configured push remote URL — the tag push at the end needs one. The
 *     workflow provides credentials by rewriting the remote to a token URL, so a
 *     missing remote means that wiring is broken.
 *
 * The check deliberately does NOT perform a network write: a push probe would
 * create a ref as a side effect. Reading the configured identity and remote is the
 * strongest pre-publish statement available.
 *
 * @throws {Error} when the identity or the remote is missing.
 */
function assertGitIdentity() {
  const name = tryRun('git', ['config', '--get', 'user.name'])
  const email = tryRun('git', ['config', '--get', 'user.email'])
  if (!name.ok || name.stdout === '' || !email.ok || email.stdout === '') {
    throw new Error(
      'this checkout has no git identity, so the annotated release tags cannot be created.\n'
      + `user.name=${name.ok ? JSON.stringify(name.stdout) : 'unset'}, user.email=${email.ok ? JSON.stringify(email.stdout) : 'unset'}\n`
      + 'Set them (the workflow does this with `git config user.name/user.email`) and re-run. '
      + 'This is checked before publishing because the tags are created after six irreversible publishes.',
    )
  }
  const remote = tryRun('git', ['remote', 'get-url', 'origin'])
  if (!remote.ok || remote.stdout === '') {
    throw new Error(
      'this checkout has no "origin" remote, so the release tags could not be pushed after publishing.\n'
      + 'Restore the remote (or re-run actions/checkout with credentials) before dispatching.',
    )
  }
  process.stdout.write(`preflight: git identity ${name.stdout} <${email.stdout}>, origin ${redactRemote(remote.stdout)}\n`)
}

/**
 * Strip credentials from a remote URL before printing it.
 *
 * The workflow rewrites `origin` to an `https://x-access-token:<token>@…` URL, and
 * a release log is retained for 90 days — so the URL is redacted rather than
 * printed verbatim.
 *
 * @param {string} url the configured remote URL.
 * @returns {string} the URL with any userinfo replaced by `***`.
 */
export function redactRemote(url) {
  return url.replace(/^(https?:\/\/)[^@/]*@/u, '$1***@')
}

/**
 * Verify the dispatch's preconditions.
 *
 * A release dispatch names an exact commit. Three things must hold before
 * anything else runs:
 *   - that commit IS the checkout (a dispatch against a stale SHA would publish
 *     code nobody reviewed);
 *   - it is on `main` (the only branch the release lane accepts);
 *   - the working tree is clean (a dirty tree means the checkout is not the
 *     commit being released).
 *
 * @param {Map<string, string | true>} flags parsed flags.
 */
function preflight(flags) {
  const sha = requireFlag(flags, 'sha')
  const dryRun = flags.get('dry-run') !== 'false'
  const candidateTag = requireFlag(flags, 'candidate-tag')
  const path = journalPath(flags)

  // Toolchain first: everything below can only be judged against the CLI that
  // will actually publish. A too-old npm is the one failure that CANNOT be
  // recovered after the fact (six immutable versions, unpromotable), so it is
  // checked before a single tarball is built.
  const npmVersion = run('npm', ['--version'])
  assertNpmCapability(npmVersion)
  process.stdout.write(`preflight: npm ${npmVersion} satisfies the tokenless capability floor ${MIN_NPM_VERSION}\n`)

  // Git identity and push credentials are checked HERE, not when the first tag is
  // created: `git tag -a` fails without `user.email`/`user.name`, and that failure
  // would arrive after six irreversible publishes.
  assertGitIdentity()

  const head = run('git', ['rev-parse', 'HEAD'])
  if (head !== sha) throw new Error(`the checkout is ${head}, but this dispatch releases ${sha}`)

  // `git branch --contains` answers "which branches carry this commit", so a
  // dispatch of a main commit from a detached HEAD still passes, while a commit
  // that never landed on main does not.
  const branches = run('git', ['branch', '--remotes', '--contains', sha, '--format=%(refname:short)'])
    .split('\n')
    .filter((line) => line !== '')
  if (!branches.includes('origin/main') && !branches.includes('main')) {
    throw new Error(`${sha} is not on main (branches carrying it: ${branches.join(', ') || 'none'})`)
  }

  const dirty = run('git', ['status', '--porcelain'])
  if (dirty !== '') throw new Error(`the checkout is dirty; a release must run from a clean tree:\n${dirty}`)

  const plan = readReleasePlan()
  const journal = createJournal({
    sha,
    dryRun,
    candidateTag,
    packages: plan.map(({ package: packageName, directory, version }) => ({ package: packageName, directory, version })),
  })

  // FORWARD RECOVERY, before anything is packed.
  //
  // A previous dispatch of the SAME release may have published some (or all) of
  // these versions and then failed. That journal is the only trustworthy record
  // of what reached the registry, and a fresh preflight must not overwrite it:
  // doing so would erase the `published` states, and the next `pack` would either
  // re-publish (impossible — npm rejects it) or abort with a "different
  // integrity" error that looks like tampering.
  //
  // So a prior journal is loaded, verified, and ADOPTED when it describes the
  // same release. `--prior-journal` is how the workflow hands it over; when it is
  // absent the run starts fresh, which is correct for a first dispatch.
  const priorPath = optionalFlag(flags, 'prior-journal')
  if (priorPath !== undefined) {
    const adopted = adoptPriorJournal({ priorPath, sha, candidateTag, dryRun, plan })
    if (adopted !== undefined) {
      setStep(adopted, 'preflight')
      persistJournal(path, adopted)
      process.stdout.write(
        `preflight ok: resumed the journal from ${priorPath} (${summariseStateCounts(adopted)})\n`,
      )
      return
    }
  }

  // Report which versions already exist, BEFORE anything is packed. This is a
  // diagnosis, not a decision: whether an existing version is acceptable depends
  // on the integrity of the artefact this dispatch builds, which does not exist
  // yet. `pack` makes the real call (identical → skip, different → abort).
  for (const entry of plan) {
    const existing = classifyPublishedVersion({
      package: entry.package,
      version: entry.version,
      integrity: '',
    })
    if (existing.outcome === 'absent') continue
    setPackageState(journal, entry.package, 'planned', {
      registryIntegrity: existing.registryIntegrity,
      detail: `version ${entry.version} already exists on the registry; pack will compare integrity`,
    })
  }

  setStep(journal, 'preflight')
  persistJournal(path, journal)
  process.stdout.write(`preflight ok: ${plan.length} packages at ${sha}${dryRun ? ' (dry run)' : ''}\n`)
}

/**
 * Load and verify a prior dispatch's journal, returning it when it is resumable.
 *
 * Two outcomes, and the difference matters:
 *
 *   - the prior journal is NOT resumable (different SHA, tag, version, or a
 *     dry-run/real mismatch) AND records no published version → `undefined`, so
 *     the caller starts a fresh journal. Nothing irreversible happened, so
 *     starting over is safe.
 *   - the prior journal is not resumable but DOES record a published version →
 *     hard failure. A published version exists that this dispatch cannot account
 *     for, and silently starting a new journal would hide it.
 *
 * @param {object} options `priorPath`, `sha`, `candidateTag`, `dryRun`, `plan`.
 * @returns {object | undefined} the adopted journal, or `undefined` to start fresh.
 * @throws {Error} when a published version would be forgotten.
 */
function adoptPriorJournal(options) {
  const { priorPath, sha, candidateTag, dryRun, plan } = options
  // Reaching this function means a prior journal was NAMED, so a missing file is
  // a hard failure rather than "start fresh". That distinction is the whole
  // fail-closed rule: naming a journal asserts "this dispatch continues that
  // run", and a silent restart would discard the record of what already reached
  // an immutable registry. Only the absence of the flag means a fresh release.
  if (!existsSync(priorPath)) {
    throw new Error(
      `the prior journal was requested at ${priorPath}, but no such file exists.\n`
      + 'A resume must be able to read what the earlier dispatch already published. '
      + 'Omit --prior-journal only if this really is a NEW release.',
    )
  }
  const prior = readJournal(priorPath)
  const verdict = resumability(prior, {
    sha,
    candidateTag,
    dryRun,
    packages: plan.map(({ package: packageName, directory, version }) => ({ package: packageName, directory, version })),
  })
  if (verdict.resumable) {
    process.stdout.write(`preflight: resuming the journal for ${sha} from ${priorPath}\n`)
    return prior
  }
  const published = prior.packages.filter((entry) => isPublished(entry))
  if (published.length > 0) {
    throw new Error(
      `the prior journal at ${priorPath} cannot be resumed: ${verdict.reason}.\n`
      + `It records ${published.length} version(s) that already reached the registry: `
      + `${published.map((entry) => `${entry.package}@${entry.version} (${entry.state})`).join(', ')}.\n`
      + 'Those versions are immutable and must be accounted for. Restore the matching release commit, '
      + 'or bump the version and treat this as a new release — do NOT let a fresh journal hide them.',
    )
  }
  process.stdout.write(`preflight: the prior journal at ${priorPath} is not resumable (${verdict.reason}); starting fresh\n`)
  return undefined
}

/** One-line state histogram for the preflight log. */
function summariseStateCounts(journal) {
  const counts = new Map()
  for (const entry of journal.packages) counts.set(entry.state, (counts.get(entry.state) ?? 0) + 1)
  return [...counts].map(([state, count]) => `${count} ${state}`).join(', ')
}

/* ------------------------------------------------------------------ pack --- */

/**
 * Pack and validate all six packages.
 *
 * Packing happens ONCE per dispatch, before any publish, so the tarballs that
 * get uploaded are the ones the journal describes. fish-shell is packed from a
 * staged tree (bundled dependencies cannot be packed from the workspace's
 * symlinked `node_modules`), everything else from the checkout.
 *
 * @param {Map<string, string | true>} flags parsed flags.
 */
function pack(flags) {
  const path = journalPath(flags)
  const out = artifactsDir(flags)
  const journal = readJournal(path)
  const plan = readReleasePlan()

  for (const entry of plan) {
    const journalEntry = journal.packages.find((candidate) => candidate.package === entry.package)
    if (journalEntry === undefined) throw new Error(`${entry.package} is not part of this dispatch's journal`)
    if (journalEntry.version !== entry.version) {
      throw new Error(`${entry.package} version changed during the dispatch (${journalEntry.version} -> ${entry.version})`)
    }
  }

  for (const entry of plan) {
    const directory = STAGED_PACKAGES.has(entry.package) ? stageBundle(entry, out) : join(repoRoot, entry.directory)
    const packageDir = join(out, 'pack', entry.package.replace(/^@/, '').replace('/', '-'))
    rmSync(packageDir, { recursive: true, force: true })
    mkdirSync(packageDir, { recursive: true })
    const stdout = run('npm', ['pack', '--json', '--pack-destination', packageDir], { cwd: directory })
    const packed = parsePackJson(stdout)
    const tarball = join(packageDir, packed.filename)
    if (!existsSync(tarball)) throw new Error(`npm pack reported ${packed.filename} but it does not exist`)

    const facts = validateTarball({ entry, packed, tarball })
    const classification = classifyPublishedVersion({
      package: entry.package,
      version: entry.version,
      integrity: packed.integrity,
    })
    if (classification.outcome === 'conflict') {
      throw new Error(
        `${classification.detail}\n`
        + 'A published version is immutable: bump the version and dispatch again. '
        + 'Do NOT re-publish over it — the registry would reject the upload and the release would stay half-done.',
      )
    }
    const state = classification.outcome === 'identical' ? 'skipped' : 'packed'
    setPackageState(journal, entry.package, state, {
      integrity: packed.integrity,
      detail: classification.outcome === 'identical'
        ? `already published with identical integrity; this dispatch will not re-publish it`
        : `${facts.memberCount} members`,
    })
    process.stdout.write(`packed ${entry.package}@${entry.version} (${facts.memberCount} members)\n`)
  }

  setStep(journal, 'pack')
  persistJournal(path, journal)
}

/**
 * Stage fish-shell outside the workspace with the hoisted linker.
 *
 * The staged tree MUST live outside this repository, and that is not tidiness:
 * the checkout is a pnpm WORKSPACE (`pnpm-workspace.yaml` lists `plugins/*`), so
 * a directory created inside it that carries a `package.json` is treated as a
 * workspace project. `pnpm install` inside it then resolves the whole workspace
 * — it prints `Scope: all 7 workspace projects` and removes/rewrites the ROOT
 * `node_modules`, destroying the installed tree the gates just ran against
 * (verified: the run asked "The modules directories will be removed and
 * reinstalled from scratch. Proceed?" and left the checkout without its
 * dependencies). Staging under the OS temp dir keeps the install local to the
 * staged package and leaves the workspace untouched.
 *
 * Two linker flags are load-bearing and are NOT tuning:
 *   - `--config.node-linker=hoisted` — in the workspace's isolated layout the
 *     bundled dependency's transitive members resolve through `.pnpm`, which
 *     produces tarball members like `package/../../node_modules/.pnpm/...`;
 *   - `--config.package-import-method=copy` — pnpm's default import method
 *     hardlinks store files, and npmjs rejects a tarball carrying hardlink
 *     members with `415 Unsupported Media Type — Hard link is not allowed`.
 *
 * @param {object} entry release-list entry.
 * @param {string} out artifacts root (the staged tree is created beside it, outside the repository).
 * @returns {string} the staged package directory to pack.
 */
export function stageBundle(entry, out, options = {}) {
  const short = entry.package.replace(/^@/, '').replace('/', '-')
  // `out` is `<repo>/release-artifacts` in the workflow, so a sibling of `out`
  // is still inside the repository. The staging root is therefore the OS temp
  // dir, with the artifacts directory name folded in so two concurrent lanes
  // cannot collide.
  // Injectable so a test can drive the ordering without a real temp dir or a real
  // pnpm: the property under test is WHAT RUNS FIRST, not where it lands.
  const makeStage = options.makeStage ?? (() => join(mkdtempSync(join(tmpdir(), `banbo-stage-${short}-`)), short))
  const stage = makeStage()
  const execute = options.run ?? run
  // THE GUARD RUNS FIRST — before a single byte is copied and before `pnpm` is
  // invoked at all. Ordering is the whole point: `cp` and `pnpm install` are the
  // two operations that do damage, so a guard that runs after them would be a
  // report rather than a prevention. (This was a real ordering bug: the check sat
  // after `cp -R` and after `pnpm install`, so a stage that landed inside the
  // workspace had already rewritten the checkout's node_modules by the time the
  // guard spoke.)
  assertOutsideWorkspace(stage, entry.package, options.repoRoot)
  mkdirSync(stage, { recursive: true })
  execute('cp', ['-R', `${join(repoRoot, entry.directory)}/.`, stage])
  rmSync(join(stage, 'node_modules'), { recursive: true, force: true })
  // A staged copy must not carry the workspace markers either: `pnpm-workspace.yaml`
  // at or above the staged tree would re-create the workspace-scope problem this
  // whole function exists to avoid.
  rmSync(join(stage, 'pnpm-workspace.yaml'), { force: true })
  execute('pnpm', [
    'install',
    '--prod',
    '--config.node-linker=hoisted',
    '--config.package-import-method=copy',
    '--config.auto-install-peers=false',
  ], { cwd: stage })
  // The staged tree is a build input, not an artefact: record it so the journal
  // (and a human reading a failure) can name it, but keep it out of the upload.
  process.stdout.write(`staged ${entry.package} at ${stage} (outside the workspace)\n`)
  return stage
}

/**
 * Canonicalize a path that may not exist yet.
 *
 * `realpathSync` needs every component to exist, but a stage directory is created
 * moments after this check. So the nearest EXISTING ancestor is resolved (the
 * deepest component a symlink could have replaced) and the remaining segments are
 * appended verbatim. That is the same rule the write-scope policy uses, and for
 * the same reason: a symlinked TMPDIR is a real, observed way for an "outside"
 * path to point back inside the workspace.
 *
 * @param {string} target absolute path, possibly not existing.
 * @returns {string} the canonical absolute path.
 */
function canonicalPath(target) {
  const absolute = resolve(target)
  const suffix = []
  let current = absolute
  for (;;) {
    try {
      const real = realpathSync(current)
      return suffix.length === 0 ? real : join(real, ...suffix.reverse())
    } catch (error) {
      if (error?.code !== 'ENOENT' && error?.code !== 'ENOTDIR') throw error
      const parent = dirname(current)
      // Reached the filesystem root without resolving: use the path as given.
      if (parent === current) return absolute
      suffix.push(basename(current))
      current = parent
    }
  }
}

/**
 * Refuse to pack from a tree that pnpm would treat as part of this workspace.
 *
 * This is the fail-closed half of the staging rule: the reasoning above explains
 * why an in-repo stage is destructive, and this makes that reasoning a checked
 * precondition rather than a comment. A future refactor that moves the stage back
 * under `release-artifacts/` fails here, before `pnpm install` can touch the
 * checkout's `node_modules`.
 *
 * EVERYTHING IS CANONICALIZED FIRST, and that is not tidiness either. A lexical
 * `relative()` comparison is trivially defeated by a symlink: `/tmp` can point at
 * the repository, and a stage under it then looks "outside" while pnpm resolves it
 * inside. So the repository root, the stage, and each ancestor examined for a
 * workspace file are all resolved to their REAL paths, and the containment test
 * and the ancestor walk both run on those. A symlinked TMPDIR therefore fails
 * closed instead of silently rewriting the checkout.
 *
 * @param {string} stage absolute staged package directory.
 * @param {string} packageName the package being staged (for the error).
 * @param {string} [repoRootOverride] the repository root (tests inject it).
 * @throws {Error} when the stage is inside the repository or beside a workspace file.
 */
export function assertOutsideWorkspace(stage, packageName, repoRootOverride) {
  const root = canonicalPath(repoRootOverride ?? repoRoot)
  const realStage = canonicalPath(stage)
  const relativeToRepo = relative(root, realStage)
  const insideRepo = relativeToRepo === '' || (!relativeToRepo.startsWith('..') && !isAbsolute(relativeToRepo))
  if (insideRepo) {
    throw new Error(
      `refusing to stage ${packageName} inside the repository (${stage} -> ${realStage}, repo ${root}): `
      + 'this checkout is a pnpm workspace, so a nested package would make `pnpm install` rewrite the workspace root '
      + 'node_modules and destroy the tree the gates ran against. Stage it under a real directory outside the workspace '
      + '(note: a symlinked TMPDIR pointing back here is refused for the same reason).',
    )
  }
  // Walk the CANONICAL ancestors, so a workspace file reached through a symlink is
  // found too.
  for (let dir = realStage; ; dir = dirname(dir)) {
    if (existsSync(join(dir, 'pnpm-workspace.yaml'))) {
      throw new Error(
        `refusing to stage ${packageName} at ${stage} -> ${realStage}: ${join(dir, 'pnpm-workspace.yaml')} governs it, `
        + 'so `pnpm install` there would run in workspace scope instead of installing only this package.',
      )
    }
    if (dirname(dir) === dir) break
  }
}

/* --------------------------------------------------------------- publish --- */

/**
 * Publish the packed tarballs serially under the candidate dist-tag.
 *
 * Serial on purpose: npm publishes are individually atomic but the release is
 * not, and running them concurrently would make a partial failure much harder to
 * attribute. Each package is verified against the registry immediately after its
 * own publish, so the run stops at the first package whose artefact differs from
 * the one it built.
 *
 * @param {Map<string, string | true>} flags parsed flags.
 */
function publish(flags) {
  const path = journalPath(flags)
  const out = artifactsDir(flags)
  const journal = readJournal(path)
  if (journal.dryRun) throw new Error('this dispatch is a dry run; publish must not be called')

  const plan = readReleasePlan()
  for (const entry of plan) {
    const journalEntry = journal.packages.find((candidate) => candidate.package === entry.package)
    if (journalEntry === undefined) throw new Error(`${entry.package} is not part of this dispatch's journal`)
    if (journalEntry.state === 'published' || journalEntry.state === 'skipped') {
      process.stdout.write(`${entry.package}@${entry.version} is already accounted for (${journalEntry.state}); skipping\n`)
      continue
    }
    if (journalEntry.state !== 'packed') {
      throw new Error(`${entry.package} is "${journalEntry.state}"; pack must succeed before publish`)
    }
    const packageDir = join(out, 'pack', entry.package.replace(/^@/, '').replace('/', '-'))
    const tarballs = readdirSync(packageDir).filter((name) => name.endsWith('.tgz'))
    if (tarballs.length !== 1) {
      throw new Error(`expected exactly one tarball for ${entry.package} in ${packageDir}, found ${tarballs.length}`)
    }
    const tarball = join(packageDir, tarballs[0])

    run('npm', [
      'publish',
      tarball,
      '--tag', journal.candidateTag,
      '--provenance',
      '--access', 'public',
      '--registry', REGISTRY,
    ])
    const registryIntegrity = assertRegistryIntegrity({
      package: entry.package,
      version: entry.version,
      integrity: journalEntry.integrity,
    })
    setPackageState(journal, entry.package, 'published', { registryIntegrity })
    setStep(journal, `publish:${entry.package}`)
    persistJournal(path, journal)
    process.stdout.write(`published ${entry.package}@${entry.version} (${registryIntegrity})\n`)
  }
}

/* -------------------------------------------------------------- finalize --- */

/**
 * Promote `latest`, drop the candidate tag, and create tags + GitHub Releases.
 *
 * Ordering matters and is the reason this is one subcommand rather than several
 * workflow steps: `latest` is only promoted once ALL SIX versions are published
 * and verified, so a partial failure can never move the `latest` pointer to a
 * release the user cannot install.
 *
 * FORWARD RECOVERY is a first-class requirement, not an afterthought. A finalize
 * that dies on the Nth package (a registry hiccup on the 4th `dist-tag add`, a
 * tag already existing at another commit, a GitHub 502 on the 5th release) must
 * be re-runnable WITHOUT redoing — or worse, half-redoing — the earlier work:
 *
 *   - every per-package step is idempotent and verified by READING the state
 *     back, so "already promoted" and "promoted now" are the same outcome;
 *   - `promoted` is a real journal state, so a resumed finalize skips the
 *     packages that already moved and only touches the remainder;
 *   - the candidate tag is removed per package, tolerating ONLY an explicit
 *     "no such tag" and verifying each removal;
 *   - a tag that already points at the release commit is accepted, one that
 *     points elsewhere fails closed.
 *
 * @param {Map<string, string | true>} flags parsed flags.
 */
function finalize(flags) {
  const path = journalPath(flags)
  const journal = readJournal(path)
  const sha = requireFlag(flags, 'sha')
  const dryRun = flags.get('dry-run') !== 'false'
  if (journal.sha !== sha) throw new Error(`the journal belongs to ${journal.sha}, not ${sha}`)

  const plan = readReleasePlan()
  for (const entry of plan) {
    const journalEntry = journal.packages.find((candidate) => candidate.package === entry.package)
    if (journalEntry === undefined) throw new Error(`${entry.package} is not part of this dispatch's journal`)
    if (journalEntry.version !== entry.version) {
      throw new Error(`${entry.package} version changed during the dispatch (${journalEntry.version} -> ${entry.version})`)
    }
  }
  const unpublished = journal.packages.filter(
    (entry) => entry.state !== 'published' && entry.state !== 'skipped' && entry.state !== 'promoted',
  )
  if (unpublished.length > 0) {
    throw new Error(
      `cannot finalize: ${unpublished.map((entry) => `${entry.package} is ${entry.state}`).join(', ')}. `
      + 'A partial release stays on the candidate tag; fix the failure and re-dispatch the same version.',
    )
  }

  if (dryRun) {
    setStep(journal, 'finalize:dry-run')
    persistJournal(path, journal)
    process.stdout.write('dry run: nothing promoted, no tags created\n')
    return
  }

  // Re-verify the registry BEFORE promoting anything. The journal is the record
  // of what this lane did, not a claim about the registry's current state: a
  // candidate tag can be moved, a version can be deprecated, and a resumed run
  // may be hours later. Promotion is the step that makes a release installable,
  // so it re-reads the two facts it depends on rather than trusting the journal.
  for (const entry of plan) {
    const integrity = publishedIntegrity(entry.package, entry.version)
    const journalEntry = journal.packages.find((candidate) => candidate.package === entry.package)
    if (integrity === undefined) {
      throw new Error(
        `cannot promote ${entry.package}@${entry.version}: the registry no longer reports it. `
        + 'A version cannot be withdrawn, so this means the registry is unreachable or the name/version is wrong — '
        + 'do not continue, and do not re-publish.',
      )
    }
    if (journalEntry?.integrity !== undefined && journalEntry.integrity !== integrity) {
      throw new Error(
        `cannot promote ${entry.package}@${entry.version}: the registry now reports integrity ${integrity}, `
        + `but this dispatch published ${journalEntry.integrity}. Refusing to promote an artefact this run did not build.`,
      )
    }
    const candidate = distTagVersion(entry.package, journal.candidateTag)
    if (candidate !== undefined && candidate !== entry.version) {
      throw new Error(
        `cannot promote ${entry.package}: the candidate tag "${journal.candidateTag}" points at ${candidate}, `
        + `not ${entry.version}. Another release moved it; refuse to promote across releases.`,
      )
    }
  }
  setStep(journal, 'finalize:registry-verified')
  persistJournal(path, journal)

  // Promote `latest` per package. Idempotent: a package already at the target
  // version is left alone (and re-verified), so a resumed finalize continues from
  // the first package that still needs work.
  for (const entry of plan) {
    const journalEntry = journal.packages.find((candidate) => candidate.package === entry.package)
    if (journalEntry?.state === 'promoted') {
      const current = distTagVersion(entry.package, 'latest')
      if (current !== entry.version) {
        throw new Error(
          `${entry.package} is recorded as promoted, but latest is ${current ?? 'absent'}; `
          + 'the registry disagrees with the journal — investigate before re-running',
        )
      }
      process.stdout.write(`${entry.package}@${entry.version} is already promoted; skipping\n`)
      continue
    }
    run('npm', ['dist-tag', 'add', `${entry.package}@${entry.version}`, 'latest', '--registry', REGISTRY])
    const promoted = distTagVersion(entry.package, 'latest')
    if (promoted !== entry.version) {
      throw new Error(`latest for ${entry.package} is ${promoted ?? 'absent'}, expected ${entry.version}`)
    }
    setPackageState(journal, entry.package, 'promoted')
    persistJournal(path, journal)
  }

  // Drop the candidate tag, per package. Only an EXPLICIT "that tag does not
  // exist" is acceptable — a resumed run may have removed it already — and every
  // removal is verified by reading the tag back, so "the rm printed nothing" can
  // never stand in for "the tag is gone".
  for (const entry of plan) {
    removeCandidateTag(entry.package, journal.candidateTag)
  }
  setStep(journal, 'finalize:promoted')
  persistJournal(path, journal)

  // One annotated tag + one GitHub Release per package, all pointing at the SAME
  // commit. The tag list is written to the artifacts directory so the workflow
  // can push exactly these tags and create exactly these releases without
  // re-deriving names (two places computing a tag name is two places to drift).
  //
  // A resumed dispatch may find a tag it already created. That is only acceptable
  // when it points at the same commit — a tag at a different commit means the
  // release identity was reused, which must never be papered over.
  const tags = []
  const manifestLines = []
  for (const entry of plan) {
    const tag = tagName(entry)
    tags.push(tag)
    manifestLines.push([tag, entry.package, entry.version].join('\t'))
    const existing = tryRun('git', ['rev-parse', `refs/tags/${tag}^{commit}`])
    if (existing.ok) {
      if (existing.stdout !== sha) {
        throw new Error(`tag ${tag} already exists at ${existing.stdout}, not at ${sha}; refusing to move a release tag`)
      }
      continue
    }
    run('git', ['tag', '--annotate', tag, '--message', `${entry.package} ${entry.version}`, sha])
  }
  writeFileSync(join(artifactsDir(flags), 'release-tags.tsv'), `${manifestLines.join('\n')}\n`)
  setStep(journal, 'finalize:tagged')
  persistJournal(path, journal)
  process.stdout.write(`${tags.join('\n')}\n`)
}

/**
 * Remove one package's candidate dist-tag, tolerating only "it is already gone".
 *
 * `npm dist-tag rm` fails for several reasons and they are NOT interchangeable:
 *
 *   - the tag does not exist — acceptable, a resumed run removed it;
 *   - the package or version is unknown, the registry is unreachable, or the
 *     token lacks permission — each of those means the cleanup did not happen,
 *     and swallowing it would leave a published candidate tag pointing at a
 *     release nobody can install.
 *
 * So the failure is classified, not ignored, and the result is verified by
 * reading the tag back either way.
 *
 * @param {string} packageName published npm name.
 * @param {string} candidateTag the candidate dist-tag.
 * @throws {Error} when the tag still exists, or the removal failed for any reason other than absence.
 */
function removeCandidateTag(packageName, candidateTag) {
  const before = distTagVersion(packageName, candidateTag)
  if (before === undefined) {
    process.stdout.write(`${packageName}: candidate tag "${candidateTag}" is already gone\n`)
    return
  }
  try {
    run('npm', ['dist-tag', 'rm', packageName, candidateTag, '--registry', REGISTRY])
  } catch (error) {
    // `npm dist-tag rm` reports an absent tag as E404. Re-read the tag: if it is
    // gone now the removal was effective (the error was a race), otherwise this
    // is a real failure and it propagates.
    const after = distTagVersion(packageName, candidateTag)
    if (after === undefined) {
      process.stdout.write(`${packageName}: candidate tag "${candidateTag}" removed\n`)
      return
    }
    throw new Error(
      `cannot remove the candidate tag "${candidateTag}" from ${packageName}: ${String(error?.message ?? error)}. `
      + 'It still exists on the registry, so the release is not finished.',
    )
  }
  const after = distTagVersion(packageName, candidateTag)
  if (after !== undefined) {
    throw new Error(
      `the candidate tag "${candidateTag}" on ${packageName} still points at ${after} after removal; refusing to continue`,
    )
  }
  process.stdout.write(`${packageName}: candidate tag "${candidateTag}" removed\n`)
}

/**
 * The annotated tag name for one package.
 *
 * Scope-stripped and version-suffixed so the tag reads like the package, and
 * `dsh-` keeps every tag from this repository recognisable in a shared namespace.
 *
 * @param {object} entry release-list entry with `package` and `version`.
 * @returns {string} the tag name.
 */
export function tagName(entry) {
  const short = entry.package.replace(/^@banbolee\//, '')
  return `${short}-v${entry.version}`
}

/* ------------------------------------------------------- github releases --- */

/**
 * Create one GitHub Release per package, idempotently.
 *
 * `gh release create` fails when the release already exists, which is the right
 * default but the wrong behaviour for a RESUMED dispatch: a run that created the
 * first four releases and died on the fifth must be able to finish, not to
 * discover that four of its six targets are now "in the way".
 *
 * Idempotence here is verified, not assumed. A release that already exists is
 * accepted ONLY when it agrees with this dispatch on all three identity facts:
 *
 *   - `tagName` — the release is for the tag this lane computed;
 *   - `targetCommitish` — the release points at the commit being released;
 *   - `name` — the title is `<package> <version>`, so a release carrying another
 *     package's title means the tag was reused.
 *
 * Anything else is a hard failure: overwriting a release someone else published
 * is exactly the mistake this check exists to prevent.
 *
 * @param {Map<string, string | true>} flags parsed flags.
 */
function releases(flags) {
  const journal = readJournal(journalPath(flags))
  const sha = requireFlag(flags, 'sha')
  if (journal.sha !== sha) throw new Error(`the journal belongs to ${journal.sha}, not ${sha}`)
  const artifacts = artifactsDir(flags)
  const manifestPath = join(artifacts, 'release-tags.tsv')
  if (!existsSync(manifestPath)) {
    throw new Error(`missing ${manifestPath}; run finalize before creating releases`)
  }
  const rows = readFileSync(manifestPath, 'utf8')
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => {
      const [tag, packageName, version] = line.split('\t')
      if (tag === undefined || packageName === undefined || version === undefined) {
        throw new Error(`malformed release tag row ${JSON.stringify(line)} in ${manifestPath}`)
      }
      return { tag, package: packageName, version }
    })

  const created = []
  const present = []
  for (const row of rows) {
    const title = `${row.package} ${row.version}`
    const view = tryRun('gh', ['release', 'view', row.tag, '--json', 'tagName,targetCommitish,name'])
    if (view.ok) {
      let parsed
      try {
        parsed = JSON.parse(view.stdout)
      } catch (error) {
        throw new Error(`gh release view ${row.tag} printed non-JSON output: ${String(error?.message ?? error)}`)
      }
      // The COMMIT the existing release/tag really points at. `targetCommitish` is
      // only a label — it can be a branch name, and a branch moves — so it is
      // resolved to a commit before it is compared. Both the tag's commit and the
      // release target are resolved, and BOTH must equal the release SHA: a tag
      // that moved, or a release whose target branch has advanced, must not be
      // accepted as "this release".
      const tagCommit = resolveGitCommit(`refs/tags/${row.tag}^{commit}`)
      const targetCommit = resolveGitCommit(parsed?.targetCommitish)
      const mismatch = releaseMismatch(
        { ...parsed, tagCommit, targetCommit },
        { ...row, title, sha },
      )
      if (mismatch !== undefined) {
        throw new Error(
          `the GitHub Release for ${row.tag} already exists but does not describe this release: ${mismatch}. `
          + 'Refusing to reuse a release identity that belongs to something else.',
        )
      }
      present.push(row.tag)
      process.stdout.write(`release ${row.tag} already exists at ${sha}; skipping\n`)
      continue
    }
    run('gh', [
      'release', 'create', row.tag,
      '--target', sha,
      '--title', title,
      '--notes', `${row.package} \`${row.version}\`, published from \`${sha}\` with npm provenance.`,
    ])
    created.push(row.tag)
    process.stdout.write(`created release ${row.tag}\n`)
  }
  setStep(journal, `releases:${created.length} created, ${present.length} existing`)
  persistJournal(journalPath(flags), journal)
  process.stdout.write(`releases: ${created.length} created, ${present.length} already present\n`)
}

/**
 * Resolve a git revision (a tag, a branch, a SHA) to a full commit SHA.
 *
 * Returns `undefined` when it does not resolve locally — which is NOT treated as
 * a match. A checkout has the release tags (the workflow fetches tags with
 * `fetch-depth: 0`), so an unresolvable target means the local view cannot prove
 * the identity, and guessing is exactly what must not happen here.
 *
 * @param {string | undefined} revision the revision to resolve.
 * @returns {string | undefined} the full commit SHA, or `undefined`.
 */
function resolveGitCommit(revision) {
  if (typeof revision !== 'string' || revision.trim() === '') return undefined
  const resolved = tryRun('git', ['rev-parse', '--verify', '--quiet', `${revision}^{commit}`])
  if (!resolved.ok) return undefined
  const commit = resolved.stdout.trim()
  return /^[0-9a-f]{40}$/u.test(commit) ? commit : undefined
}

/**
 * Compare an existing GitHub Release against what this dispatch would create.
 *
 * All three identity facts must agree, and the COMMIT comparison is exact:
 *
 *   - `tagName` must be the tag this lane computed;
 *   - `name` must be `<package> <version>`, so a reused tag carrying another
 *     package's title fails closed;
 *   - the commit the TAG points at and the commit the RELEASE TARGET resolves to
 *     must both equal the release SHA.
 *
 * `targetCommitish` on its own is not evidence: GitHub stores whatever was passed
 * (`main`, a branch, or a SHA), and a branch name is a moving label. Accepting any
 * non-empty value — or even `main` specifically — would accept a release whose
 * branch has since advanced past the commit being released. Both values are
 * therefore resolved to commits by the caller and compared exactly; anything that
 * cannot be resolved is a mismatch, never a pass.
 *
 * @param {object} actual the resolved release facts: `tagName`, `name`,
 *   `targetCommitish`, `tagCommit`, `targetCommit`.
 * @param {object} expected `tag`, `title`, `sha`.
 * @returns {string | undefined} the mismatch description, or `undefined` when they agree.
 */
export function releaseMismatch(actual, expected) {
  if (actual?.tagName !== expected.tag) {
    return `tagName is ${JSON.stringify(actual?.tagName)}, expected ${JSON.stringify(expected.tag)}`
  }
  if (actual?.name !== expected.title) {
    return `name is ${JSON.stringify(actual?.name)}, expected ${JSON.stringify(expected.title)}`
  }
  if (actual?.tagCommit !== expected.sha) {
    return `the tag resolves to ${actual?.tagCommit ?? 'an unresolvable commit'}, expected ${expected.sha}`
  }
  if (actual?.targetCommit !== expected.sha) {
    return `the release target ${JSON.stringify(actual?.targetCommitish)} resolves to `
      + `${actual?.targetCommit ?? 'an unresolvable commit'}, expected ${expected.sha}`
  }
  return undefined
}

/* ---------------------------------------------------------------- journal --- */

/** Print the journal as markdown (the run summary step uses this). */
function report(flags) {
  const journal = readJournal(journalPath(flags))
  process.stdout.write(`${summarise(journal)}\n`)
}

/* ------------------------------------------------------------------- main --- */

const COMMANDS = { preflight, pack, publish, finalize, releases, report }

function main() {
  const [command, ...rest] = process.argv.slice(2)
  if (command === undefined || !(command in COMMANDS)) {
    throw new Error(`usage: node scripts/release/release.mjs <${Object.keys(COMMANDS).join('|')}> [flags]`)
  }
  COMMANDS[command](parseFlags(rest))
}

try {
  main()
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`)
  process.exitCode = 1
}

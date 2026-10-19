/**
 * The bundle's OWN handle on the terminal tool package it ships.
 *
 * Why this file exists at all
 * ---------------------------
 * `@deepseek-ai/dsh-tool-terminal` is a `dependencies` + `bundledDependencies`
 * entry of this package: the six `terminal_*` tools are meant to resolve from
 * the copy packed INSIDE the bundle tarball, never from the profile plane.
 *
 * Through dsh `0.2.0-rc.2` the bundle patch could simply name the package
 * (`name: '@deepseek-ai/dsh-tool-terminal'`) and get that copy, because nothing
 * in the dsh installation carried the name: the profile-scope resolution table
 * recorded every name a selected bundle supplies.
 *
 * `0.2.1-rc.2` changed that. The installation now ships the package itself
 * (`@deepseek-ai/dsh-experimental-terminal-bundle` declares it), and the runtime
 * resolution only records a profile-scope entry for a name the installation does
 * NOT already supply — so a bare package name resolves to the INSTALLATION copy
 * and the bundled copy is never consulted. That silently changes what this
 * bundle runs: the profile would execute a terminal tool implementation from the
 * harness install rather than the one the tarball pins and the offline lane
 * verifies.
 *
 * The fix stays on public seams. A patch row's `name` is a literal module
 * specifier, and a specifier that is a path is imported directly rather than
 * through the package-name resolution table. This module is that path: it is
 * part of THIS package, so it always lives beside the vendored copy, and it
 * resolves the vendored package relative to its own location.
 *
 * Resolution order, and why it is not simply a relative specifier
 * ---------------------------------------------------------------
 * A literal `export * from './node_modules/.../lib/index.js'` is the most direct
 * expression of "the copy beside me", but it hard-codes the installed layout: a
 * checkout-linked composition (this repository's own `test:composition` lane
 * stages the package and symlinks `node_modules` elsewhere) has no
 * `./node_modules/` inside the package directory, so the import would fail even
 * though the dependency IS resolvable from the package's own manifest.
 *
 * `createRequire(import.meta.url)` answers the actual question — "which copy does
 * this package resolve?" — and it resolves the dependency from this package's own
 * position first:
 *
 *   1. inside a packed/installed tarball, `./node_modules/@deepseek-ai/
 *      dsh-tool-terminal` exists and wins, which is the copy this bundle ships;
 *   2. in a workspace checkout the same specifier resolves through the
 *      repository's link to the pinned dependency — still the copy this
 *      package's manifest declares, never a copy chosen by the harness.
 *
 * The Cordis loader unwraps the imported namespace exactly as it would for a
 * bare name, so the plugin contract (`apply`, `inject`, `name`, `Config`) is
 * unchanged.
 *
 * @module @banbolee/dsh-fish-shell/tool-terminal
 */

import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'

const requireFromHere = createRequire(import.meta.url)

/** The vendored package's entry point, resolved from THIS package's position. */
const VENDORED_ENTRY = requireFromHere.resolve('@deepseek-ai/dsh-tool-terminal')

/** The vendored package's module namespace. */
const vendored = await import(pathToFileURL(VENDORED_ENTRY).href)

export const Config = vendored.Config
export const DEFAULT_MAX_RESULT_BYTES = vendored.DEFAULT_MAX_RESULT_BYTES
export const MIN_MAX_RESULT_BYTES = vendored.MIN_MAX_RESULT_BYTES
export const apply = vendored.apply
export const inject = vendored.inject
export const name = vendored.name

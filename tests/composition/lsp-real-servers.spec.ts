import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  bootLspDiagnosticsProfile,
  type LspDiagnosticsBooted,
} from './lsp-diagnostics-profile'
import {
  COMMAND_ENV,
  configuredServer,
  directToolValue,
  executeTool,
  noticeText,
  renderedToolText,
  parseRequestedProviders,
  PROVIDER_CASES,
  type RealLaneResult,
  toError,
  writeEvidence,
} from './lsp-real-server-helpers'
import type { LspProvider, LspServerOverride } from './lsp-diagnostics-profile-config'

const bootedProfiles: LspDiagnosticsBooted[] = []

afterEach(async () => {
  while (bootedProfiles.length > 0) {
    const booted = bootedProfiles.pop()
    if (booted !== undefined) await booted.cleanup()
  }
})

describe('dsh-lsp-diagnostics explicit real-server lane', () => {
  if (process.env.RUN_REAL_LSP_SERVERS !== '1') {
    it('stays explicitly disabled during the portable test suite', () => {
      expect(process.env.RUN_REAL_LSP_SERVERS).not.toBe('1')
    })
    return
  }

  it('runs bad to diagnostic to repair to clean for every requested provider', async () => {
    const requestedProviders = parseRequestedProviders(process.env.REAL_LSP_PROVIDERS)
    const evidencePath = process.env.REAL_LSP_EVIDENCE_PATH
    if (evidencePath === undefined || evidencePath.length === 0) {
      throw new Error('REAL_LSP_EVIDENCE_PATH must be set for machine-readable real-lane evidence')
    }
    const results: RealLaneResult[] = []
    const overrides: Partial<Record<LspProvider, LspServerOverride>> = {}
    const preflightErrors: Error[] = []
    for (const provider of requestedProviders) {
      try {
        overrides[provider] = configuredServer(provider)
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error)
        results.push({
          provider,
          executable: process.env[COMMAND_ENV[provider]] ?? '',
          status: 'blocked',
          diagnosticObserved: false,
          cleanObserved: false,
          directDiagnosticObserved: false,
          directNoDiagnosticsObserved: false,
          reason,
        })
        preflightErrors.push(toError(error))
      }
    }
    if (preflightErrors.length > 0) {
      writeEvidence(evidencePath, { enabled: true, requestedProviders, results })
      throw new AggregateError(preflightErrors, 'requested real LSP provider executable preflight blocked')
    }

    const failures: Error[] = []
    for (const provider of requestedProviders) {
      const executable = overrides[provider]?.command ?? ''
      let diagnosticObserved = false
      let cleanObserved = false
      let directDiagnosticObserved = false
      let directNoDiagnosticsObserved = false
      let booted: LspDiagnosticsBooted | undefined
      let providerError: Error | undefined
      try {
        booted = await bootLspDiagnosticsProfile({
          timeoutMs: 30_000,
          settleMs: 3_000,
          shutdownTimeoutMs: 5_000,
          killGraceMs: 2_000,
          serverOverrides: { [provider]: overrides[provider] },
        })
        bootedProfiles.push(booted)
        const providerCase = PROVIDER_CASES[provider]
        for (const setup of providerCase.setup ?? []) {
          await executeTool(booted, 'write', { file_path: setup.path, content: setup.content })
        }
        const bad = await executeTool(booted, 'write', {
          file_path: providerCase.path,
          content: providerCase.bad,
        })
        const badNotice = noticeText(bad)
        diagnosticObserved = badNotice !== undefined
          && badNotice.includes('Fix these diagnostics before considering the change complete.')
          && !badNotice.includes('Status: clean')
        expect(
          diagnosticObserved,
          `${provider} must publish at least one real diagnostic; notice=${JSON.stringify(badNotice)}`,
        ).toBe(true)

        const repaired = await executeTool(booted, 'edit', {
          file_path: providerCase.path,
          old_string: providerCase.oldText,
          new_string: providerCase.newText,
        })
        cleanObserved = noticeText(repaired)?.includes('Status: clean') === true
        expect(cleanObserved, `${provider} must publish a clean result after repair`).toBe(true)

        const directBadRoot = 'direct-bad'
        const directCleanRoot = 'direct-clean'
        const directBadPath = join(directBadRoot, providerCase.path)
        const directCleanPath = join(directCleanRoot, providerCase.path)
        const absoluteBadPath = join(booted.workspace, directBadPath)
        const absoluteCleanPath = join(booted.workspace, directCleanPath)
        for (const setup of providerCase.setup ?? []) {
          for (const root of [directBadRoot, directCleanRoot]) {
            const setupPath = join(booted.workspace, root, setup.path)
            mkdirSync(dirname(setupPath), { recursive: true })
            writeFileSync(setupPath, setup.content)
          }
        }
        mkdirSync(dirname(absoluteBadPath), { recursive: true })
        mkdirSync(dirname(absoluteCleanPath), { recursive: true })
        const directRepairedBytes = providerCase.bad.replace(providerCase.oldText, providerCase.newText)
        writeFileSync(absoluteBadPath, providerCase.bad)
        writeFileSync(absoluteCleanPath, directRepairedBytes)

        const directBad = await executeTool(booted, 'lsp_diagnostics', { file_path: directBadPath })
        const directBadValue = directToolValue(directBad)
        const directBadText = renderedToolText(directBad)
        directDiagnosticObserved = directBadValue.kind === 'diagnostics'
          && directBadText.includes('[LSP diagnostics]')
          && directBadText.includes(absoluteBadPath)
        expect(directDiagnosticObserved, `${provider} direct call must publish real diagnostics`).toBe(true)
        expect(readFileSync(absoluteBadPath, 'utf8')).toBe(providerCase.bad)

        const directRepaired = await executeTool(booted, 'lsp_diagnostics', { file_path: directCleanPath })
        const directRepairedValue = directToolValue(directRepaired)
        directNoDiagnosticsObserved = directRepairedValue.kind === 'no_diagnostics'
          && renderedToolText(directRepaired).includes('No diagnostics reported for this file snapshot.')
        expect(directNoDiagnosticsObserved, `${provider} direct call must report no_diagnostics after repair`).toBe(true)
        expect(readFileSync(absoluteCleanPath, 'utf8')).toBe(directRepairedBytes)
      } catch (error) {
        providerError = toError(error)
      } finally {
        if (booted !== undefined) {
          const index = bootedProfiles.lastIndexOf(booted)
          if (index !== -1) bootedProfiles.splice(index, 1)
          try {
            await booted.cleanup()
          } catch (error) {
            const cleanupError = toError(error)
            providerError = providerError === undefined
              ? cleanupError
              : new AggregateError([providerError, cleanupError], `${provider} verification and cleanup failed`)
          }
        }
      }
      results.push({
        provider,
        executable,
        status: providerError === undefined ? 'passed' : 'failed',
        diagnosticObserved,
        cleanObserved,
        directDiagnosticObserved,
        directNoDiagnosticsObserved,
        ...(providerError === undefined ? {} : { reason: providerError.message }),
      })
      if (providerError !== undefined) failures.push(providerError)
    }
    writeEvidence(evidencePath, { enabled: true, requestedProviders, results })
    if (failures.length > 0) throw new AggregateError(failures, 'real LSP provider verification failed')
  }, 180_000)
})

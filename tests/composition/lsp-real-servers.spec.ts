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
      try {
        const booted = await bootLspDiagnosticsProfile({
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

        const absolutePath = join(booted.workspace, providerCase.path)
        mkdirSync(dirname(absolutePath), { recursive: true })
        writeFileSync(absolutePath, providerCase.bad)
        const directBad = await executeTool(booted, 'lsp_diagnostics', { file_path: providerCase.path })
        const directBadValue = directToolValue(directBad)
        const directBadText = renderedToolText(directBad)
        directDiagnosticObserved = directBadValue.kind === 'diagnostics'
          && directBadText.includes('[LSP diagnostics]')
          && directBadText.includes(absolutePath)
        expect(directDiagnosticObserved, `${provider} direct call must publish real diagnostics`).toBe(true)
        expect(readFileSync(absolutePath, 'utf8')).toBe(providerCase.bad)

        const directRepairedBytes = providerCase.bad.replace(providerCase.oldText, providerCase.newText)
        writeFileSync(absolutePath, directRepairedBytes)
        const directRepaired = await executeTool(booted, 'lsp_diagnostics', { file_path: providerCase.path })
        const directRepairedValue = directToolValue(directRepaired)
        directNoDiagnosticsObserved = directRepairedValue.kind === 'no_diagnostics'
          && renderedToolText(directRepaired).includes('No diagnostics reported for this file snapshot.')
        expect(directNoDiagnosticsObserved, `${provider} direct call must report no_diagnostics after repair`).toBe(true)
        expect(readFileSync(absolutePath, 'utf8')).toBe(directRepairedBytes)

        results.push({
          provider,
          executable,
          status: 'passed',
          diagnosticObserved,
          cleanObserved,
          directDiagnosticObserved,
          directNoDiagnosticsObserved,
        })
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error)
        results.push({
          provider,
          executable,
          status: 'failed',
          diagnosticObserved,
          cleanObserved,
          directDiagnosticObserved,
          directNoDiagnosticsObserved,
          reason,
        })
        failures.push(toError(error))
      }
    }
    writeEvidence(evidencePath, { enabled: true, requestedProviders, results })
    if (failures.length > 0) throw new AggregateError(failures, 'real LSP provider verification failed')
  }, 180_000)
})

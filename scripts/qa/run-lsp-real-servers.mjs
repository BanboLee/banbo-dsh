#!/usr/bin/env node
import { accessSync, constants, mkdirSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseOptions, requireOption } from './lib/cli.mjs'
import { runChild } from './lib/process.mjs'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
const providers = ['typescript', 'go', 'clangd', 'rust', 'python']

function writeEvidence(path, requestedProviders, results) {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, `${JSON.stringify({ enabled: true, requestedProviders, results }, null, 2)}\n`, 'utf8')
}

async function main() {
  const options = parseOptions(process.argv.slice(2))
  const requestedProviders = requireOption(options, 'providers').split(',').map((provider) => provider.trim())
  const evidencePath = resolve(requireOption(options, 'evidence'))
  const results = []
  const commands = {}
  for (const provider of requestedProviders) {
    if (!providers.includes(provider)) throw new Error(`unknown requested real LSP provider: ${provider}`)
    const command = requireOption(options, `${provider}-command`)
    commands[provider] = command
    try {
      accessSync(command, constants.X_OK)
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      results.push({
        provider,
        executable: command,
        status: 'blocked',
        diagnosticObserved: false,
        cleanObserved: false,
        reason: `requested executable is unavailable: ${command}: ${reason}`,
      })
    }
  }
  if (results.length > 0) {
    writeEvidence(evidencePath, requestedProviders, results)
    throw new Error('requested real LSP provider executable preflight blocked')
  }

  const environment = {
    ...process.env,
    RUN_REAL_LSP_SERVERS: '1',
    REAL_LSP_PROVIDERS: requestedProviders.join(','),
    REAL_LSP_EVIDENCE_PATH: evidencePath,
  }
  for (const provider of requestedProviders) {
    environment[`REAL_LSP_${provider.toUpperCase()}_COMMAND`] = commands[provider]
  }
  const vitest = resolve(repoRoot, 'node_modules', 'vitest', 'vitest.mjs')
  await runChild(process.execPath, [vitest, 'run', 'tests/composition/lsp-real-servers.spec.ts'], {
    cwd: repoRoot,
    env: environment,
  })
  process.stdout.write(`${JSON.stringify({ evidencePath, requestedProviders, status: 'passed' })}\n`)
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`)
  process.exitCode = 1
})

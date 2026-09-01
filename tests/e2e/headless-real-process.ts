/// <reference types="node" />

import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

export const PROCESS_INSPECTION_AVAILABLE = existsSync('/proc')

export function markerOwnedPids(marker: string): number[] {
  if (!PROCESS_INSPECTION_AVAILABLE) return []
  return readdirSync('/proc').filter((entry) => /^\d+$/.test(entry)).flatMap((entry) => {
    const pid = Number(entry)
    try {
      const environment = readFileSync(join('/proc', entry, 'environ'), 'utf8')
      return environment.split('\0').includes(`REAL_HEADLESS_E2E_PROCESS_MARKER=${marker}`) ? [pid] : []
    } catch {
      return []
    }
  })
}

function signalProcess(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(pid, signal)
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ESRCH') return
    throw error
  }
}

async function waitForStableMarkerExit(marker: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  let emptyScans = 0
  while (Date.now() <= deadline) {
    if (markerOwnedPids(marker).length === 0) {
      emptyScans += 1
      if (emptyScans === 2) return true
    } else {
      emptyScans = 0
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 20))
  }
  return false
}

export async function terminateMarkerOwnedProcesses(marker: string): Promise<void> {
  if (!PROCESS_INSPECTION_AVAILABLE) return
  for (const pid of markerOwnedPids(marker)) signalProcess(pid, 'SIGTERM')
  if (await waitForStableMarkerExit(marker, 2_000)) return
  for (const pid of markerOwnedPids(marker)) signalProcess(pid, 'SIGKILL')
  if (!await waitForStableMarkerExit(marker, 2_000)) {
    throw new Error(`marker-owned CodeGraph processes survived teardown: ${markerOwnedPids(marker).join(', ')}`)
  }
}

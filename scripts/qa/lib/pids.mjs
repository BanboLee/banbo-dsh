import { existsSync, readFileSync, readdirSync } from 'node:fs'

function parentPid(pid) {
  try {
    const status = readFileSync(`/proc/${pid}/status`, 'utf8')
    const match = /^PPid:\s+(\d+)$/m.exec(status)
    return match === null ? undefined : Number(match[1])
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return undefined
    throw error
  }
}

export function descendantPids(rootPid) {
  if (!existsSync('/proc')) return []
  const parents = new Map()
  for (const entry of readdirSync('/proc')) {
    if (!/^\d+$/.test(entry)) continue
    const pid = Number(entry)
    const parent = parentPid(pid)
    if (parent !== undefined) parents.set(pid, parent)
  }
  const descendants = []
  const pending = [rootPid]
  while (pending.length > 0) {
    const parent = pending.shift()
    for (const [pid, candidateParent] of parents) {
      if (candidateParent !== parent || descendants.includes(pid)) continue
      descendants.push(pid)
      pending.push(pid)
    }
  }
  return descendants.sort((left, right) => left - right)
}

export function livingPids(pids) {
  return pids.filter((pid) => existsSync(`/proc/${pid}`))
}

export async function waitForPidsGone(pids, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (livingPids(pids).length === 0) return true
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  return livingPids(pids).length === 0
}

/** Packed-shape contract for the DSH classic-script client bundle (Gate E). */

import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'
import { createRequire } from 'node:module'
import { describe, expect, it } from 'vitest'

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const clientPath = join(packageRoot, 'lib', 'client.js')
const require = createRequire(import.meta.url)

interface Registration {
  id: string
  factory: (require: (specifier: string) => unknown) => Record<string, unknown>
}

function executeArtifact() {
  const registrations: Registration[] = []
  const styles: Array<{ dataset: Record<string, string>, textContent: string }> = []
  let documentReads = 0
  const document = {
    querySelector(selector: string) {
      return styles.find((style) => selector.includes(JSON.stringify(style.dataset.pluginCss))) ?? null
    },
    createElement(name: string) {
      if (name !== 'style') throw new Error(`unexpected element: ${name}`)
      return { dataset: {} as Record<string, string>, textContent: '' }
    },
    head: { appendChild(style: { dataset: Record<string, string>, textContent: string }) { styles.push(style) } },
  }
  const context = {
    window: { __ModuleLoader__: { load(registration: Registration) { registrations.push(registration) } } },
    get document() { documentReads += 1; return document },
    console,
    structuredClone,
    setTimeout,
    clearTimeout,
  }
  vm.runInNewContext(readFileSync(clientPath, 'utf8'), context, { filename: clientPath })
  return { registrations, styles, documentReads: () => documentReads }
}

describe('agents client artifact', () => {
  it('is one lazy classic-script ModuleLoader registration', () => {
    expect(existsSync(clientPath)).toBe(true)
    const source = readFileSync(clientPath, 'utf8')
    expect(source.trimStart().startsWith('window.__ModuleLoader__.load({')).toBe(true)
    expect(source).not.toMatch(/^\s*(?:import|export)\s/m)
    expect(readdirSync(join(packageRoot, 'lib')).filter((name) => /^client.+\.js$/.test(name))).toEqual([])

    const value = executeArtifact()
    expect(value.registrations).toHaveLength(1)
    expect(value.registrations[0]?.id).toBe('@banbolee/dsh-agents')
    expect(value.documentReads()).toBe(0)
    expect(value.styles).toHaveLength(0)
  })

  it('materializes exports and only requires platform singleton modules', () => {
    const value = executeArtifact()
    const required: string[] = []
    const exports = value.registrations[0]!.factory((specifier) => {
      required.push(specifier)
      if (specifier === 'react') return require('react')
      if (specifier === 'react/jsx-runtime') return require('react/jsx-runtime')
      throw new Error(`undeclared external: ${specifier}`)
    })

    expect(exports).toMatchObject({ apply: expect.any(Function), inject: ['slots', 'locale', 'remote', 'settingsScope'] })
    expect(new Set(required)).toEqual(new Set(['react', 'react/jsx-runtime']))
    expect(required).not.toContain('@banbolee/dsh-agents/remote')
    expect(required).not.toContain('zod')
    // Materialization alone has no UI side effect: the style belongs to the
    // mount, so `apply` installs it and `dispose` removes it (§12.4).
    expect(value.styles).toHaveLength(0)
  })

  it('materializes twice without stacking an owned style', () => {
    const value = executeArtifact()
    const platformRequire = (specifier: string) => {
      if (specifier === 'react') return require('react')
      if (specifier === 'react/jsx-runtime') return require('react/jsx-runtime')
      throw new Error(`undeclared external: ${specifier}`)
    }
    value.registrations[0]!.factory(platformRequire)
    value.registrations[0]!.factory(platformRequire)
    // Installing the stylesheet belongs to the mount, not to materialization,
    // so two materializations can never leave two copies behind.
    expect(value.styles).toHaveLength(0)
  })
})

import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'

import { WorkspaceTypertGenerator } from '@deepseek-ai/dsh-typert-generator'
import { build as buildClient } from 'tsdown'
import clientConfig from '../tsdown.client.mjs'

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const require = createRequire(join(packageRoot, 'package.json'))
const manifest = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8'))
const lib = join(packageRoot, 'lib')

rmSync(lib, { recursive: true, force: true })

const scratch = mkdtempSync(join(tmpdir(), 'banbo-agents-typert-'))
try {
  const staged = join(scratch, 'packages', 'agents')
  const stagedProtocol = join(scratch, 'packages', 'typert-protocol')
  mkdirSync(join(staged, 'src'), { recursive: true })
  mkdirSync(join(stagedProtocol, 'src'), { recursive: true })
  cpSync(join(packageRoot, 'src', 'catalog-remote.ts'), join(staged, 'src', 'catalog-remote.ts'))
  writeFileSync(join(stagedProtocol, 'src', 'index.ts'), `
import { Service, type Context } from '@deepseek-ai/cordis'
export interface TypertGatewayBindingOptions { readonly namespace?: string }
export declare abstract class TypertRemoteService<T = never> extends Service<T> {
  protected constructor(ctx: Context, serviceKey: string, options?: TypertGatewayBindingOptions)
}
type RemoteMethodDecorator = <This extends object, Args extends unknown[], Result>(
  method: (this: This, ...args: Args) => Result,
  context: ClassMethodDecoratorContext<This, (this: This, ...args: Args) => Result>,
) => void
export declare function Remote<This extends object, Args extends unknown[], Result>(
  method: (this: This, ...args: Args) => Result,
  context: ClassMethodDecoratorContext<This, (this: This, ...args: Args) => Result>,
): void
export declare function Remote(option: string | { readonly mode: 'stream' }): RemoteMethodDecorator
`)
  writeFileSync(join(stagedProtocol, 'package.json'), `${JSON.stringify({
    name: '@deepseek-ai/dsh-typert-protocol',
    type: 'module',
    exports: { '.': { types: './lib/types/index.d.ts', default: './lib/index.js' } },
    files: ['lib/index.js', 'lib/types/index.d.ts'],
  }, null, 2)}\n`)
  const stagedManifest = {
    name: manifest.name,
    type: 'module',
    exports: {
      './catalog-remote': manifest.exports['./catalog-remote'],
      './typert': manifest.exports['./typert'],
      './remote': manifest.exports['./remote'],
    },
    files: [
      'lib/catalog-remote.js',
      'lib/types/catalog-remote.d.ts',
      'lib/typert.host.js',
      'lib/typert.host.d.ts',
      'lib/typert.remote-client.js',
      'lib/typert.remote-client.d.ts',
    ],
  }
  writeFileSync(join(staged, 'package.json'), `${JSON.stringify(stagedManifest, null, 2)}\n`)
  const packageConfig = {
    compilerOptions: {
      target: 'ES2024', module: 'NodeNext', moduleResolution: 'NodeNext', strict: true,
      skipLibCheck: true, composite: true, declaration: true, rootDir: 'src', outDir: 'lib/types',
    },
    include: ['src/**/*.ts'],
  }
  writeFileSync(join(staged, 'tsconfig.json'), `${JSON.stringify(packageConfig, null, 2)}\n`)
  writeFileSync(join(stagedProtocol, 'tsconfig.json'), `${JSON.stringify(packageConfig, null, 2)}\n`)
  writeFileSync(join(scratch, 'tsconfig.host.json'), `${JSON.stringify({
    files: [],
    references: [
      { path: './packages/agents/tsconfig.json' },
      { path: './packages/typert-protocol/tsconfig.json' },
    ],
    compilerOptions: {
      target: 'ES2024', module: 'NodeNext', moduleResolution: 'NodeNext', strict: true, skipLibCheck: true,
      baseUrl: '.',
      paths: { '@deepseek-ai/dsh-typert-protocol': ['./packages/typert-protocol/src/index.ts'] },
    },
  }, null, 2)}\n`)

  // Resolve all other staged imports through this real workspace; only generated
  // artifacts are copied back, never these staging links.
  symlinkSync(join(packageRoot, 'node_modules'), join(scratch, 'node_modules'), 'dir')
  symlinkSync(join(packageRoot, 'node_modules'), join(staged, 'node_modules'), 'dir')

  const [artifact] = new WorkspaceTypertGenerator(scratch).generate([manifest.name], ['host'])
  if (artifact === undefined || artifact.remote === undefined) {
    throw new Error('Typert generator did not emit the banboAgentsCatalog Remote')
  }
  mkdirSync(lib, { recursive: true })
  writeFileSync(join(lib, 'typert.host.js'), artifact.js)
  writeFileSync(join(lib, 'typert.host.d.ts'), artifact.dts)
  writeFileSync(join(lib, 'typert.remote-client.js'), artifact.remote.js)
  writeFileSync(join(lib, 'typert.remote-client.d.ts'), artifact.remote.dts)
} finally {
  rmSync(scratch, { recursive: true, force: true })
}

for (const config of ['tsconfig.host.json', 'tsconfig.client.json']) {
  execFileSync(process.execPath, [require.resolve('typescript/bin/tsc'), '-p', join(packageRoot, config)], {
    cwd: packageRoot,
    stdio: 'inherit',
  })
}

await buildClient({ ...clientConfig, config: false })

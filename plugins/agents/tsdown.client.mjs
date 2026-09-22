import { fileURLToPath } from 'node:url'
import { defineConfig } from 'tsdown'

const PACKAGE_ID = '@banbolee/dsh-agents'

// These are Web-shell singleton module-table identities. Every other runtime
// import, especially this package's generated ./remote contribution and zod,
// must be bundled into the one classic-script artifact.
const PLATFORM_MODULES = new Set([
  'react',
  'react/jsx-runtime',
  'react-dom',
  'react-dom/client',
  '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-client-store',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-ui-primitives',
  '@deepseek-ai/dsh-client-ui-dockkit',
])

export default defineConfig({
  name: `${PACKAGE_ID}/client`,
  entry: { client: 'src/client/index.tsx' },
  cwd: fileURLToPath(new URL('.', import.meta.url)),
  outDir: 'lib',
  format: 'cjs',
  platform: 'browser',
  target: 'es2022',
  tsconfig: 'tsconfig.client.json',
  sourcemap: true,
  clean: false,
  dts: false,
  deps: {
    neverBundle: (specifier) => PLATFORM_MODULES.has(specifier),
    alwaysBundle: (specifier) => !PLATFORM_MODULES.has(specifier),
  },
  define: {
    'process.env.NODE_ENV': JSON.stringify(process.env.NODE_ENV ?? 'production'),
    'import.meta.env.MODE': JSON.stringify(process.env.NODE_ENV ?? 'production'),
    'import.meta.env': JSON.stringify({ MODE: process.env.NODE_ENV ?? 'production' }),
  },
  outputOptions: {
    entryFileNames: 'client.js',
    codeSplitting: false,
    banner: `window.__ModuleLoader__.load({\n  id: ${JSON.stringify(PACKAGE_ID)},\n  factory: (require) => {`,
    intro: 'var module = { exports: {} }; var exports = module.exports;',
    footer: 'return module.exports;\n  }\n});',
  },
})

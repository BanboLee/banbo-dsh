export class QaCliError extends Error {
  name = 'QaCliError'

  constructor(message) {
    super(message)
  }
}

export function parseOptions(argv) {
  const options = new Map()
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]
    if (!token.startsWith('--')) throw new QaCliError(`unexpected argument: ${token}`)
    const name = token.slice(2)
    const value = argv[index + 1]
    if (value === undefined || value.startsWith('--')) {
      options.set(name, true)
      continue
    }
    options.set(name, value)
    index += 1
  }
  return options
}

export function requireOption(options, name) {
  const value = options.get(name)
  if (typeof value !== 'string' || value.length === 0) {
    throw new QaCliError(`missing required option --${name}`)
  }
  return value
}

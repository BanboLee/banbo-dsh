/**
 * Task-7 test-support parsers for the CodeGraph MCP README docs-shape
 * contract. These helpers turn the README's markdown structure (sections,
 * the Config table, the profile-override YAML block, and prose sentences)
 * into typed values the contract validator can bind. They are intentionally
 * small and README-specific; there is no generic parser framework.
 */

/** Raw (newline-preserving) body of a `## <heading>` section. */
export function rawSection(readme: string, heading: string, nextHeading: string): string {
  const start = readme.indexOf(`## ${heading}`)
  if (start === -1) return ''
  const bodyStart = start + `## ${heading}`.length
  const end = nextHeading !== '' ? readme.indexOf(`## ${nextHeading}`, bodyStart) : -1
  return end === -1 ? readme.slice(bodyStart) : readme.slice(bodyStart, end)
}

/** Normalized prose body of a `## <heading>` section (single-spaced). */
export function section(readme: string, heading: string, nextHeading: string): string {
  return rawSection(readme, heading, nextHeading).replace(/\s+/g, ' ').trim()
}

/** Split normalized prose into sentences on '. ' (period-space). */
export function sentences(text: string): string[] {
  return text
    .split('. ')
    .map((part) => part.trim())
    .filter((part) => part !== '')
}

/**
 * Parse the Config section's Markdown table into exact field/value pairs
 * (backticks stripped). The `args` cell keeps its bracketed literal and the
 * env cell keeps its quoted literal, so values are compared verbatim.
 */
export function parseConfigTable(readme: string): Map<string, string> {
  const table = new Map<string, string>()
  const raw = rawSection(readme, 'Config', 'Profile override for project path')
  for (const line of raw.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed.startsWith('|') || !trimmed.endsWith('|')) continue
    const cells = trimmed
      .split('|')
      .slice(1, -1)
      .map((cell) => cell.trim().replace(/`/g, ''))
    if (cells.length < 2) continue
    const [field, value] = cells
    if (field === 'Field' || field === '---' || /^-+$/.test(field)) continue
    table.set(field, value)
  }
  return table
}

/** Extract the body of the first ```yaml code block in a raw section. */
export function extractYamlBlock(raw: string): string {
  const match = /```yaml\n([\s\S]*?)```/.exec(raw)
  return match === null ? '' : match[1]
}

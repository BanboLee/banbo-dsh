/**
 * Docs-shape contract test for `plugins/fish-shell/README.{md,zh.md}`.
 *
 * The L2 (interactive terminal) surface ships with obligations that live in
 * prose, and prose has no compiler: the support envelope, the security model,
 * the Known Limitations list and the troubleshooting entries are the only place
 * a user learns what is promised and what is explicitly not. This spec pins the
 * load-bearing parts of that prose, in BOTH languages (AGENTS.md「文档语言约定
 * （强制）」), so a rewrite cannot quietly drop the four sections, the six tool
 * names, the "no secret on the command line" boundary, the "stty -echo is not a
 * mitigation" finding, the best-effort audit scope, either troubleshooting
 * error code, or any one of the seven claims the `Unverified` bullet still owes
 * the user.
 *
 * Structural equality between the two files is `tests/docs-bilingual.spec.ts`'s
 * job; this spec asserts the content that only the fish-shell READMEs carry.
 * Every check is semantic — a sentence window around a token has to bind the
 * tokens together — so a heading that survives with no content behind it still
 * fails.
 */

import { existsSync, readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const EN = readFileSync(new URL('../plugins/fish-shell/README.md', import.meta.url), 'utf8')
const ZH = readFileSync(new URL('../plugins/fish-shell/README.zh.md', import.meta.url), 'utf8')
const ROOT_EN = readFileSync(new URL('../README.md', import.meta.url), 'utf8')
const ROOT_ZH = readFileSync(new URL('../README.zh.md', import.meta.url), 'utf8')

/** The four sections the L2 surface promises, per language. */
const SECTIONS = [
  { en: '## Support matrix', zh: '## 支持矩阵' },
  { en: '## Security model', zh: '## 安全模型' },
  { en: '## Known Limitations', zh: '## 已知限制' },
  { en: '## Troubleshooting', zh: '## 排障' },
] as const

/** The six tools the interactive surface mounts, enumerated one by one. */
const TERMINAL_TOOL_NAMES = [
  'terminal_open',
  'terminal_send',
  'terminal_read',
  'terminal_signal',
  'terminal_close',
  'terminal_list',
] as const

/** The `fish-terminal-group` rows and the packages they mount. */
const GROUP_ROWS = [
  'fish-terminal-group',
  'pty',
  'terminal-fish-pty',
  'terminal-tools',
  'fish-terminal-tools',
  'cordis:group',
  'isolate: { terminals: true }',
  '@deepseek-ai/dsh-terminal',
  '@deepseek-ai/dsh-terminal-bash',
  '@deepseek-ai/dsh-tool-terminal',
  '@banbolee/dsh-fish-shell/terminal-tools',
] as const

/** Collapse whitespace runs so checks never depend on the wrap width. */
const flat = (text: string): string => text.replace(/\s+/gu, ' ')

/**
 * A window of flattened text around `needle`, long enough to hold the sentence
 * that carries it. Empty when the needle is absent (the `toContain` assertions
 * then fail with the window, which is the point).
 */
function window(text: string, needle: string, before = 160, after = 420): string {
  const at = flat(text).indexOf(needle)
  return at === -1 ? '' : flat(text).slice(Math.max(0, at - before), at + after)
}

/**
 * One list item — from the line carrying `marker` to the next bullet, heading
 * or blank line — flattened. Scoping a claim to its own bullet is what stops a
 * rewrite from keeping the tokens while reclassifying the item as supported
 * somewhere else in the file.
 */
function listItem(text: string, marker: string): string {
  const lines = text.split('\n')
  const start = lines.findIndex((line) => line.includes(marker))
  if (start === -1) return ''
  const collected: string[] = []
  for (let index = start; index < lines.length; index += 1) {
    const line = lines[index]!
    if (index > start && (line === '' || /^- |^#{1,6} /u.test(line))) break
    collected.push(line)
  }
  return flat(collected.join('\n'))
}

/**
 * `tokens[0]` and every later token within `span` characters of it, else ''.
 *
 * The window is what makes a claim semantic rather than a spelling check: the
 * anchors of one item have to sit in the same sentence, so a rewrite cannot
 * satisfy the assertion with tokens scattered across unrelated prose.
 */
function near(text: string, tokens: readonly [string, ...string[]], span = 200): string {
  const at = text.indexOf(tokens[0])
  if (at === -1) return ''
  const slice = text.slice(at, at + span)
  return tokens.every((token) => slice.includes(token)) ? slice : ''
}

/**
 * Every claim the `Unverified (do not read as supported)` bullet still owes the
 * user — `.omo/plans/fish-shell-tty-v3.md` §9 minus the running-job kill, which
 * the real PTY lane now covers and the Behavior section documents as verified.
 * Each entry carries the semantic anchors of exactly one item, matched through
 * `near` inside the bullet: deleting an item, or quietly promoting it to
 * "supported" outside the bullet, drops the anchors and fails.
 */
const UNVERIFIED_CLAIMS = [
  {
    label: 'the same group shape under `minimal` or a dsh-tui combination',
    en: ['group shape', '`minimal`', 'dsh-tui'],
    zh: ['minimal', 'dsh-tui', '同形态 group'],
  },
  {
    label: 'a mode switch being fenced while a PTY session is active',
    en: ['mode switch', 'fenced', 'PTY'],
    zh: ['PTY', '切 mode', 'fence'],
  },
  {
    label: 'PTY spawn under the read-only mode',
    en: ['PTY spawn', 'read-only'],
    zh: ['read-only', 'PTY spawn'],
  },
  {
    label: 'the FishTerminalBackend submitted-setup path on fish 3.7.1',
    en: ['FishTerminalBackend', 'fish 3.7.1'],
    zh: ['FishTerminalBackend', 'fish 3.7.1'],
  },
  {
    label: 'cross-agent owner isolation',
    en: ['cross-agent', 'owner isolation'],
    zh: ['跨 agent', 'owner 隔离'],
  },
  {
    label: 'a first install in a fully offline, cold-store environment',
    en: ['offline', 'cold-store'],
    zh: ['无网', '冷环境首装'],
  },
  {
    label: 'a profile cordis.patch.yml referencing the bundled package name',
    en: ['cordis.patch.yml', 'bundled package name'],
    zh: ['cordis.patch.yml', 'bundled 包名'],
  },
] as const

describe('@banbolee/dsh-fish-shell README shape — the four L2 sections', () => {
  it('carries every required section heading, per language', () => {
    for (const section of SECTIONS) {
      expect(EN, `README.md is missing ${section.en}`).toContain(section.en)
      expect(ZH, `README.zh.md is missing ${section.zh}`).toContain(section.zh)
    }
  })

  it('keeps the sections in the same order in both files', () => {
    let previous = -1
    for (const section of SECTIONS) {
      const at = EN.indexOf(section.en)
      expect(at, `${section.en} is out of order`).toBeGreaterThan(previous)
      previous = at
    }
    previous = -1
    for (const section of SECTIONS) {
      const at = ZH.indexOf(section.zh)
      expect(at, `${section.zh} is out of order`).toBeGreaterThan(previous)
      previous = at
    }
  })
})

describe('@banbolee/dsh-fish-shell README shape — the L2 surface is documented', () => {
  it('names the six terminal tools explicitly in both languages', () => {
    for (const name of TERMINAL_TOOL_NAMES) {
      expect(EN, `README.md never names ${name}`).toContain(name)
      expect(ZH, `README.zh.md never names ${name}`).toContain(name)
    }
  })

  it('documents the group shape, the isolate boundary and the mounted packages', () => {
    for (const token of GROUP_ROWS) {
      expect(EN, `README.md is missing ${token}`).toContain(token)
      expect(ZH, `README.zh.md is missing ${token}`).toContain(token)
    }
    // The reason `isolate.terminals` is needed is the load-bearing explanation.
    expect(window(EN, 'isolate: { terminals: true }')).toMatch(/pending/u)
    expect(window(ZH, 'isolate: { terminals: true }')).toMatch(/pending/u)
  })

  it('documents the terminalTools switch and its default', () => {
    expect(EN).toContain("terminalTools: 'allow'")
    expect(ZH).toContain("terminalTools: 'allow'")
    expect(EN).toContain('terminalTools: deny')
    expect(ZH).toContain('terminalTools: deny')
    expect(window(EN, 'terminalTools: deny')).toMatch(/restrict/u)
    expect(window(ZH, 'terminalTools: deny')).toMatch(/restrict/u)
  })

  it('links the third-party notices file, and the file exists', () => {
    expect(EN).toContain('./THIRD-PARTY-NOTICES.md')
    expect(ZH).toContain('./THIRD-PARTY-NOTICES.md')
    expect(existsSync(new URL('../plugins/fish-shell/THIRD-PARTY-NOTICES.md', import.meta.url))).toBe(true)
  })
})

describe('@banbolee/dsh-fish-shell README shape — the safety boundaries are stated', () => {
  it('warns against secrets on the command line or in terminal_send', () => {
    expect(flat(EN), 'README.md must forbid secrets through terminal_send').toMatch(/Never pass a secret[^.]*terminal_send/u)
    expect(flat(ZH), 'README.zh.md must forbid secrets through terminal_send').toMatch(/不要[^。]*secret[^。]*terminal_send/u)
    // Only a real hidden read is hidden.
    expect(window(EN, 'read -s')).toMatch(/only/u)
    expect(window(ZH, 'read -s')).toMatch(/唯一/u)
  })

  it('states that stty -echo is NOT a mitigation, because the scrollback keeps it', () => {
    expect(EN, 'README.md must record the measured stty -echo finding').toMatch(
      /stty -echo[^.]*not[^.]*scrollback[^.]*measured/u,
    )
    expect(ZH, 'README.zh.md must record the measured stty -echo finding').toMatch(
      /stty -echo[^。]*不是[^。]*scrollback[^。]*实测/u,
    )
  })

  it('lists the unsupported interaction surface and the platform boundary', () => {
    for (const token of ['resize', 'TERM=dumb', 'vim', 'htop', 'POSIX']) {
      expect(EN, `README.md is missing ${token}`).toContain(token)
      expect(ZH, `README.zh.md is missing ${token}`).toContain(token)
    }
    expect(window(EN, 'resize')).toMatch(/not supported/u)
    expect(window(ZH, 'resize')).toMatch(/不支持/u)
  })

  it('scopes the audit to best-effort and refuses a lifecycle promise', () => {
    for (const [label, text, notPromise] of [
      ['README.md', EN, /no full-lifecycle promise|not a lifecycle guarantee/u],
      ['README.zh.md', ZH, /没有完整生命周期承诺/u],
    ] as const) {
      const audit = window(text, 'TerminalSessionService', 700, 420)
      expect(audit, `${label}: audit scope must name the official service`).toContain('TerminalSessionService')
      expect(audit, `${label}: audit scope must be best-effort`).toMatch(/best-effort/u)
      expect(audit, `${label}: audit scope must refuse a lifecycle promise`).toMatch(notPromise)
    }
  })

  it('marks the unverified items as unverified, not as supported', () => {
    expect(EN).toContain('**Unverified (do not read as supported)**')
    expect(ZH).toContain('**未验证（不要当成已支持）**')
    // Every remaining item is asserted INSIDE the bullet: an item that was
    // deleted, or moved out to the "supported" prose, is no longer there.
    const en = listItem(EN, '**Unverified (do not read as supported)**')
    const zh = listItem(ZH, '**未验证（不要当成已支持）**')
    expect(en, 'README.md: the Unverified bullet lost its content').not.toBe('')
    expect(zh, 'README.zh.md: the Unverified bullet lost its content').not.toBe('')
    for (const claim of UNVERIFIED_CLAIMS) {
      expect(near(en, claim.en), `README.md no longer marks "${claim.label}" unverified`).not.toBe('')
      expect(near(zh, claim.zh), `README.zh.md no longer marks "${claim.label}" unverified`).not.toBe('')
    }
  })

  it('narrows the verified envelope to dsh-base profiles and points at the limits', () => {
    for (const [label, text, limits] of [
      ['README.md', EN, 'Known Limitations'],
      ['README.zh.md', ZH, '已知限制'],
    ] as const) {
      expect(text, `${label} must state which profile class is verified`).toContain('dsh-base')
      // The narrowing has to send the reader to the authoritative section; a
      // bare mention of the profile class would let the claim float free.
      expect(window(text, 'dsh-base', 0, 520), `${label}: the verified envelope must point at ${limits}`).toContain(limits)
    }
  })

  it('claims the running-job kill path as verified, with the real lane as evidence', () => {
    const evidence = 'plugins/fish-shell/tests/terminal-session-real.spec.ts'
    for (const [label, text] of [['README.md', EN], ['README.zh.md', ZH]] as const) {
      expect(text, `${label} must cite the real lane for the verified kill claim`).toContain(evidence)
    }
    expect(window(EN, 'Killing a job while it is still running'), 'the verified kill claim must name job_kill').toContain(
      'job_kill',
    )
    expect(window(ZH, '运行中的 job 被 kill/cancel'), 'the verified kill claim must name job_kill').toContain('job_kill')
  })
})

describe('@banbolee/dsh-fish-shell README shape — troubleshooting and the sync story', () => {
  it('documents both error codes with a cause and an action', () => {
    for (const token of [
      'ERR_MODULE_NOT_FOUND',
      'ERR_PNPM_NO_OFFLINE_TARBALL',
      'ERR_PNPM_BUNDLED_DEPENDENCIES_WITHOUT_HOISTED',
    ]) {
      expect(EN, `README.md is missing ${token}`).toContain(token)
      expect(ZH, `README.zh.md is missing ${token}`).toContain(token)
    }
    expect(EN).toContain('node-linker=hoisted')
    expect(ZH).toContain('node-linker=hoisted')
    // The cold-store cause is what makes the offline error actionable.
    expect(window(EN, 'ERR_PNPM_NO_OFFLINE_TARBALL')).toMatch(/cold pnpm store/u)
    expect(window(ZH, 'ERR_PNPM_NO_OFFLINE_TARBALL')).toMatch(/冷 pnpm store/u)
  })

  it('points the deployment story at the packed tarball, not a hand-written copy', () => {
    expect(EN).toContain('scripts/sync-to-profile.sh <profile>')
    expect(ZH).toContain('scripts/sync-to-profile.sh <profile>')
    expect(EN).toContain('pnpm pack --config.node-linker=hoisted')
    expect(ZH).toContain('pnpm pack --config.node-linker=hoisted')
    // The root READMEs document the same new usage in both languages.
    expect(ROOT_EN).toContain('scripts/sync-to-profile.sh <profile>')
    expect(ROOT_ZH).toContain('scripts/sync-to-profile.sh <profile>')
  })
})

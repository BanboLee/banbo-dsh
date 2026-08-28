#!/usr/bin/env node
// Fake `rtk` CLI for deterministic tests. Never invokes the real `rtk`.
//
// Usage: node fake-rtk.mjs <subcommand> <command...>
//   <subcommand>  mirrors `rtk rewrite`; only `rewrite` is supported.
//   <command...>  the shell command being rewritten.
//
// Behavior is driven by the FAKE_RTK_MODE environment variable:
//   rewrite      print "rtk <command>" on stdout, exit 0   (rewrite and allow)
//   passthrough  print the original command on stdout, exit 1 (no RTK equivalent)
//   deny         print a denial reason on stderr, exit 2    (deny rule hit)
//   ask          print "rtk <command>" on stdout, exit 3    (rewrite-with-note)
//   timeout      hang forever (simulates a hung rtk invocation)
//   malformed    print garbage that is not a usable command, exit 0
//
// Exit codes follow the real `rtk rewrite` contract (0/1/2/3) so later
// plugin tasks can assert on the same protocol.

const MODES = new Set(['rewrite', 'passthrough', 'deny', 'ask', 'timeout', 'malformed'])

function main() {
  const mode = process.env.FAKE_RTK_MODE
  if (mode === undefined || !MODES.has(mode)) {
    process.stderr.write(
      `fake-rtk: FAKE_RTK_MODE must be one of ${[...MODES].join(', ')} (got: ${mode ?? 'unset'})\n`,
    )
    process.exit(1)
  }

  const subcommand = process.argv[2] ?? ''
  if (subcommand !== 'rewrite') {
    process.stderr.write(`fake-rtk: unsupported subcommand "${subcommand}" (only "rewrite")\n`)
    process.exit(1)
  }

  const command = process.argv.slice(3).join(' ')

  switch (mode) {
    case 'rewrite':
      process.stdout.write(`rtk ${command}\n`)
      process.exit(0)
      break
    case 'passthrough':
      process.stdout.write(`${command}\n`)
      process.exit(1)
      break
    case 'deny':
      process.stderr.write(`fake-rtk: denied by rule: ${command}\n`)
      process.exit(2)
      break
    case 'ask':
      process.stdout.write(`rtk ${command}\n`)
      process.exit(3)
      break
    case 'timeout':
      // Keep the event loop alive indefinitely; the caller must kill us.
      setInterval(() => {}, 1 << 30)
      break
    case 'malformed':
      process.stdout.write(`not-a-command {{{ ${command}\n`)
      process.exit(0)
      break
    // No default: MODES validation above guarantees exhaustiveness.
  }
}

main()

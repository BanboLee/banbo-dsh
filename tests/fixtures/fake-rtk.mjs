#!/usr/bin/env node
// Fake `rtk` CLI for deterministic tests. Never invokes the real `rtk`.
//
// Usage: node fake-rtk.mjs <subcommand> <command...>
//   <subcommand>  mirrors `rtk rewrite` and `rtk pipe`.
//   <command...>  the shell command being rewritten, or `-f <filter>` for pipe.
//
// Behavior is driven by environment variables:
//   FAKE_RTK_MODE       (rewrite subcommand) one of:
//     rewrite      print "rtk <command>" on stdout, exit 0   (rewrite and allow)
//     passthrough  print the original command on stdout, exit 1 (no RTK equivalent)
//     deny         print a denial reason on stderr, exit 2    (deny rule hit)
//     ask          print "rtk <command>" on stdout, exit 3    (rewrite-with-note)
//     timeout      hang forever (simulates a hung rtk invocation)
//     malformed    print garbage that is not a usable command, exit 0
//   FAKE_RTK_PIPE_MODE  (pipe subcommand) one of:
//     compress     print "[fake-rtk pipe -f <filter>] compressed <N> lines" on
//                  stdout, where <N> is the number of non-empty stdin lines, exit 0
//     passthrough  echo stdin back to stdout byte-for-byte, exit 0
//     deny         print "fake-rtk pipe: denied by rule: <filter>" on stderr, exit 2
//     timeout      hang forever (simulates a hung rtk invocation)
//
// Exit codes follow the real `rtk` contract (0/1/2/3) so later plugin tasks
// can assert on the same protocol.

const MODES = new Set(['rewrite', 'passthrough', 'deny', 'ask', 'timeout', 'malformed'])
const PIPE_MODES = new Set(['compress', 'passthrough', 'deny', 'timeout'])

// Read ALL of stdin, then invoke the callback with the raw bytes.
function readStdin(callback) {
  const chunks = []
  process.stdin.on('data', (chunk) => {
    chunks.push(chunk)
  })
  process.stdin.on('end', () => {
    callback(Buffer.concat(chunks))
  })
}

function mainPipe() {
  const mode = process.env.FAKE_RTK_PIPE_MODE
  if (mode === undefined || !PIPE_MODES.has(mode)) {
    process.stderr.write(
      `fake-rtk: FAKE_RTK_PIPE_MODE must be one of ${[...PIPE_MODES].join(', ')} (got: ${mode ?? 'unset'})\n`,
    )
    process.exit(1)
  }

  // Optional `-f <filter>` pair; anything else is ignored. Default filter: grep.
  let filter = 'grep'
  if (process.argv[3] === '-f' && process.argv[4] !== undefined) {
    filter = process.argv[4]
  }

  readStdin((input) => {
    switch (mode) {
      case 'compress': {
        const nonEmptyLines = input.toString().split('\n').filter((line) => line !== '')
        process.stdout.write(`[fake-rtk pipe -f ${filter}] compressed ${nonEmptyLines.length} lines\n`)
        process.exit(0)
        break
      }
      case 'passthrough':
        process.stdout.write(input)
        process.exit(0)
        break
      case 'deny':
        process.stderr.write(`fake-rtk pipe: denied by rule: ${filter}\n`)
        process.exit(2)
        break
      case 'timeout':
        // Keep the event loop alive indefinitely; the caller must kill us.
        setInterval(() => {}, 1 << 30)
        break
      // No default: PIPE_MODES validation above guarantees exhaustiveness.
    }
  })
}

function main() {
  const subcommand = process.argv[2] ?? ''

  if (subcommand === 'pipe') {
    mainPipe()
    return
  }

  const mode = process.env.FAKE_RTK_MODE
  if (mode === undefined || !MODES.has(mode)) {
    process.stderr.write(
      `fake-rtk: FAKE_RTK_MODE must be one of ${[...MODES].join(', ')} (got: ${mode ?? 'unset'})\n`,
    )
    process.exit(1)
  }

  if (subcommand !== 'rewrite') {
    process.stderr.write(`fake-rtk: unsupported subcommand "${subcommand}" (only "rewrite" and "pipe")\n`)
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

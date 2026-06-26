#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const BIN_DIR = path.dirname(fileURLToPath(import.meta.url));

const COMMANDS = Object.freeze({
  init: {
    script: 'setup.js',
    help: 'initialize settings and the statusLine bridge'
  },
  status: {
    script: 'report.js',
    help: 'show the current guard report'
  },
  doctor: {
    script: 'verify.js',
    help: 'verify the install without spending Claude quota'
  }
});

function usage() {
  return [
    'Usage: subagent-cap <command> [options]',
    '',
    'Commands:',
    ...Object.entries(COMMANDS).map(([name, info]) => `  ${name.padEnd(8)} ${info.help}`),
    '',
    'Examples:',
    '  subagent-cap init',
    '  subagent-cap init --defaults',
    '  subagent-cap status',
    '  subagent-cap doctor --offline'
  ].join('\n');
}

function main() {
  const [command, ...args] = process.argv.slice(2);

  if (!command || command === '--help' || command === '-h') {
    process.stdout.write(`${usage()}\n`);
    return;
  }

  const target = COMMANDS[command];
  if (!target) {
    process.stderr.write(`Unknown command "${command}".\n\n${usage()}\n`);
    process.exitCode = 1;
    return;
  }

  const child = spawnSync(process.execPath, [path.join(BIN_DIR, target.script), ...args], {
    stdio: 'inherit',
    env: process.env,
    cwd: process.cwd(),
    windowsHide: true
  });

  if (child.error) {
    process.stderr.write(`${child.error.message}\n`);
    process.exitCode = 1;
    return;
  }

  process.exitCode = child.status ?? 1;
}

main();

#!/usr/bin/env node
import { renderStatusLine } from '../lib/guard.js';

function argValue(name) {
  const index = process.argv.indexOf(name);
  if (index === -1) return null;
  return process.argv[index + 1] || null;
}

async function readStdin() {
  let input = '';
  process.stdin.setEncoding('utf8');
  for await (const chunk of process.stdin) {
    input += chunk;
  }
  return input ? JSON.parse(input) : {};
}

async function main() {
  const pluginData = argValue('--data') || process.env.CLAUDE_PLUGIN_DATA;
  const input = await readStdin();
  const output = await renderStatusLine(input, { pluginData, env: process.env });
  process.stdout.write(`${output}\n`);
}

main().catch((error) => {
  process.stdout.write(`SBG error: ${error.message}\n`);
});

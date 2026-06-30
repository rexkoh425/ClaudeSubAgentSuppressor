#!/usr/bin/env node
import { buildReport, formatSubagentView } from '../lib/guard.js';

function argValue(name) {
  const index = process.argv.indexOf(name);
  if (index === -1) return null;
  return process.argv[index + 1] || null;
}

async function main() {
  const sessionId = argValue('--session');
  const report = await buildReport(sessionId, process.env);

  process.stdout.write(`${formatSubagentView(report)}\n`);
}

main().catch((error) => {
  process.stderr.write(`sub-agent-view failed: ${error.message || String(error)}\n`);
  process.exitCode = 1;
});

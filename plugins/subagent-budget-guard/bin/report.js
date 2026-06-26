#!/usr/bin/env node
import { buildReport, formatReport } from '../lib/guard.js';

function argValue(name) {
  const index = process.argv.indexOf(name);
  if (index === -1) return null;
  return process.argv[index + 1] || null;
}

async function main() {
  const asJson = process.argv.includes('--json');
  const sessionId = argValue('--session');
  const report = await buildReport(sessionId, process.env);

  process.stdout.write(
    asJson ? `${JSON.stringify(report, null, 2)}\n` : `${formatReport(report)}\n`
  );
}

main().catch((error) => {
  process.stderr.write(`report failed: ${error.stack || error.message}\n`);
  process.exitCode = 1;
});

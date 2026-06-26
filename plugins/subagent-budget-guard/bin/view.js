#!/usr/bin/env node
import { buildReport, formatSubagentView } from '../lib/guard.js';

function argValue(name) {
  const index = process.argv.indexOf(name);
  if (index === -1) return null;
  return process.argv[index + 1] || null;
}

async function main() {
  const asJson = process.argv.includes('--json');
  const sessionId = argValue('--session');
  const report = await buildReport(sessionId, process.env);
  const view = {
    plugin: report.plugin,
    sessionId: report.sessionId,
    spawnedSubagents: report.state.subagents.runs.length,
    verifiedTokens: report.state.subagents.verifiedTokens,
    totalDurationMs: report.state.subagents.totalDurationMs,
    subagents: report.state.subagents.runs
  };

  process.stdout.write(
    asJson ? `${JSON.stringify(view, null, 2)}\n` : `${formatSubagentView(report)}\n`
  );
}

main().catch((error) => {
  process.stderr.write(`sub-agent-view failed: ${error.stack || error.message}\n`);
  process.exitCode = 1;
});

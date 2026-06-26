#!/usr/bin/env node
import {
  formatVerificationResult,
  runLiveVerification,
  runOfflineVerification
} from '../lib/verifier.js';

function modeFromArgs() {
  if (process.argv.includes('--live')) return 'live';
  return 'offline';
}

async function main() {
  const mode = modeFromArgs();
  const result =
    mode === 'live'
      ? await runLiveVerification({ repoRoot: process.cwd(), env: process.env })
      : await runOfflineVerification({ repoRoot: process.cwd(), env: process.env });

  process.stdout.write(`${formatVerificationResult(result)}\n`);
  process.exitCode = result.ok ? 0 : 1;
}

main().catch((error) => {
  process.stderr.write(`verification failed: ${error.stack || error.message}\n`);
  process.exitCode = 1;
});

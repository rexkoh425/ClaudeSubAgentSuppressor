#!/usr/bin/env node
import {
  formatVerificationResult,
  runLiveVerification,
  runOfflineVerification
} from '../lib/verifier.js';
import { pathExists } from '../lib/guard.js';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

function modeFromArgs() {
  if (process.argv.includes('--live')) return 'live';
  return 'offline';
}

async function main() {
  const mode = modeFromArgs();
  const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const cwd = process.cwd();
  const cwdLooksLikeMarketplace =
    (await pathExists(path.join(cwd, '.claude-plugin', 'marketplace.json'))) ||
    (await pathExists(path.join(cwd, 'plugins', 'subagent-budget-guard', '.claude-plugin', 'plugin.json')));
  const repoRoot = cwdLooksLikeMarketplace ? cwd : packageRoot;
  const result =
    mode === 'live'
      ? await runLiveVerification({ repoRoot, env: process.env })
      : await runOfflineVerification({ repoRoot, env: process.env });

  process.stdout.write(`${formatVerificationResult(result)}\n`);
  process.exitCode = result.ok ? 0 : 1;
}

main().catch((error) => {
  process.stderr.write(`verification failed: ${error.stack || error.message}\n`);
  process.exitCode = 1;
});

#!/usr/bin/env node
import { getDataDir, getHomeDir, getPluginRoot, installStatusLineBridge } from '../lib/guard.js';

async function main() {
  const result = await installStatusLineBridge({
    homeDir: getHomeDir(process.env),
    pluginRoot: getPluginRoot(process.env),
    pluginData: getDataDir(process.env)
  });

  process.stdout.write(
    [
      'Subagent Budget Guard statusLine bridge installed.',
      `Settings: ${result.settingsPath}`,
      `Bridge state: ${result.bridgePath}`,
      result.previousStatusLine
        ? 'Existing statusLine command preserved and wrapped.'
        : 'No previous statusLine command was configured.'
    ].join('\n') + '\n'
  );
}

main().catch((error) => {
  process.stderr.write(`setup failed: ${error.stack || error.message}\n`);
  process.exitCode = 1;
});

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
      'Recommended plugin config applied:',
      `  max_concurrent_subagents=${result.pluginConfigOptions.max_concurrent_subagents}`,
      `  max_subagent_tokens_per_session=${result.pluginConfigOptions.max_subagent_tokens_per_session}`,
      `  subagent_token_warning_threshold_percent=${result.pluginConfigOptions.subagent_token_warning_threshold_percent}`,
      `  session_five_hour_budget_percent=${result.pluginConfigOptions.session_five_hour_budget_percent}`,
      `  absolute_five_hour_ceiling_percent=${result.pluginConfigOptions.absolute_five_hour_ceiling_percent}`,
      `  enforcement_enabled=${result.pluginConfigOptions.enforcement_enabled}`,
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

#!/usr/bin/env node
import { createInterface } from 'node:readline/promises';

import {
  CONFIG_KEYS,
  SETUP_CONFIG,
  buildSetupConfig,
  getDataDir,
  getHomeDir,
  getPluginRoot,
  installStatusLineBridge
} from '../lib/guard.js';

const CONFIG_KEY_SET = new Set(CONFIG_KEYS);

function usage() {
  return [
    'Usage: subagent-budget-guard-setup [--interactive] [--config key=value ...]',
    '',
    'Config keys:',
    ...CONFIG_KEYS.map((key) => `  ${key} (default ${SETUP_CONFIG[key]})`)
  ].join('\n');
}

function parseConfigPair(pair) {
  const index = pair.indexOf('=');
  if (index <= 0) {
    throw new Error(`Invalid --config value "${pair}". Expected key=value.`);
  }

  const key = pair.slice(0, index);
  const value = pair.slice(index + 1);
  if (!CONFIG_KEY_SET.has(key)) {
    throw new Error(`Unknown config key "${key}". Valid keys: ${CONFIG_KEYS.join(', ')}`);
  }
  return [key, value];
}

function parseArgs(args) {
  const options = {
    interactive: false,
    overrides: {}
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--help' || arg === '-h') {
      process.stdout.write(`${usage()}\n`);
      process.exit(0);
    }
    if (arg === '--interactive') {
      options.interactive = true;
      continue;
    }
    if (arg === '--config') {
      const pair = args[index + 1];
      if (!pair) throw new Error('--config requires key=value');
      const [key, value] = parseConfigPair(pair);
      options.overrides[key] = value;
      index += 1;
      continue;
    }
    if (arg.startsWith('--config=')) {
      const [key, value] = parseConfigPair(arg.slice('--config='.length));
      options.overrides[key] = value;
      continue;
    }
    throw new Error(`Unknown argument "${arg}".\n${usage()}`);
  }

  return options;
}

async function promptForConfig(defaults) {
  const rl = createInterface({
    input: process.stdin,
    output: process.stderr
  });
  const answers = {};

  try {
    for (const key of CONFIG_KEYS) {
      const answer = await rl.question(`${key} [${defaults[key]}]: `);
      if (answer.trim()) {
        answers[key] = answer.trim();
      }
    }
  } finally {
    rl.close();
  }

  return buildSetupConfig({ ...defaults, ...answers });
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const setupConfig = options.interactive
    ? await promptForConfig(buildSetupConfig(options.overrides))
    : buildSetupConfig(options.overrides);
  const result = await installStatusLineBridge({
    homeDir: getHomeDir(process.env),
    pluginRoot: getPluginRoot(process.env),
    pluginData: getDataDir(process.env),
    setupConfig
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

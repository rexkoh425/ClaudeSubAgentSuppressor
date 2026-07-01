#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { createInterface } from 'node:readline/promises';

import {
  CONFIG_KEYS,
  PLUGIN_ID,
  SETUP_CONFIG,
  buildSetupConfig,
  getDataDir,
  getHomeDir,
  getPluginRoot,
  installStatusLineBridge,
  loadConfig
} from '../lib/guard.js';

const CONFIG_KEY_SET = new Set(CONFIG_KEYS);
const PRIMARY_SETTING_NAMES = Object.freeze([
  'agents',
  'session-token-cap',
  'warn-at',
  'five-hour-warning',
  'five-hour-budget',
  'five-hour-ceiling',
  'mode',
  'enabled'
]);
const SETTING_ALIASES = Object.freeze({
  agents: 'max_concurrent_subagents',
  subagents: 'max_concurrent_subagents',
  'subagents-at-once': 'max_concurrent_subagents',
  'agent-limit': 'max_concurrent_subagents',
  'session-token-cap': 'max_subagent_tokens_per_session',
  'verified-session-token-cap': 'max_subagent_tokens_per_session',
  'warn-at': 'subagent_token_warning_threshold_percent',
  warning: 'subagent_token_warning_threshold_percent',
  'warning-threshold': 'subagent_token_warning_threshold_percent',
  'five-hour-warning': 'five_hour_warning_threshold_percent',
  'warning-gate': 'five_hour_warning_threshold_percent',
  'budget-warning': 'five_hour_warning_threshold_percent',
  'five-hour-budget': 'session_five_hour_budget_percent',
  budget: 'session_five_hour_budget_percent',
  'five-hour-ceiling': 'absolute_five_hour_ceiling_percent',
  ceiling: 'absolute_five_hour_ceiling_percent',
  mode: 'enforcement_mode',
  'budget-mode': 'enforcement_mode',
  'enforcement-mode': 'enforcement_mode',
  enabled: 'enforcement_enabled',
  enforcement: 'enforcement_enabled'
});

const PRESETS = Object.freeze({
  balanced: {
    label: 'Balanced',
    config: SETUP_CONFIG
  },
  strict: {
    label: 'Strict',
    config: {
      ...SETUP_CONFIG,
      max_concurrent_subagents: 1,
      max_subagent_tokens_per_session: 250000,
      subagent_token_warning_threshold_percent: 70,
      five_hour_warning_threshold_percent: 70,
      session_five_hour_budget_percent: 5,
      absolute_five_hour_ceiling_percent: 85,
      enforcement_mode: 'subagent_only',
      enforcement_enabled: true
    }
  },
  observe: {
    label: 'Observe Only',
    config: {
      ...SETUP_CONFIG,
      enforcement_mode: 'observe',
      enforcement_enabled: true
    }
  }
});

function usage() {
  return [
    'Usage: setup [--defaults] [--preset balanced|strict|observe] [--set name=value ...] [--interactive]',
    '',
    'Friendly settings (internal keys also accepted):',
    '  agents              subagents at once',
    '  session-token-cap   verified completed-subagent token cap for the session',
    '  warn-at             warning threshold percent',
    '  five-hour-warning   5-hour usage percent that blocks new subagents until extended',
    '  five-hour-budget    5-hour budget points for this session',
    '  five-hour-ceiling   absolute 5-hour percentage ceiling',
    '  mode                subagent_only or observe',
    '  enabled             true or false',
    '',
    'Examples:',
    '  setup --preset balanced',
    '  setup --set agents=3 --set warn-at=75',
    '  setup --extend-five-hour 2',
    '  setup --preset balanced --set session-token-cap=750000'
  ].join('\n');
}

function normalizeSettingName(name) {
  return String(name || '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '-')
    .replace(/_/g, '-');
}

function configKeyForSetting(name) {
  if (CONFIG_KEY_SET.has(name)) return name;
  const alias = SETTING_ALIASES[normalizeSettingName(name)];
  if (alias) return alias;
  throw new Error(
    `Unknown setting "${name}". Valid settings: ${PRIMARY_SETTING_NAMES.join(', ')}`
  );
}

function parseSettingPair(pair) {
  const index = pair.indexOf('=');
  if (index <= 0) {
    throw new Error(`Invalid --set value "${pair}". Expected name=value.`);
  }

  return [configKeyForSetting(pair.slice(0, index)), pair.slice(index + 1)];
}

function parseArgs(args) {
  const options = {
    interactive: false,
    defaults: false,
    preset: null,
    setOverrides: {},
    extendFiveHour: null
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
    if (arg === '--defaults' || arg === '--yes' || arg === '-y') {
      options.defaults = true;
      continue;
    }
    if (arg === '--preset') {
      const preset = args[index + 1];
      if (!preset) throw new Error('--preset requires balanced, strict, or observe');
      options.preset = normalizeSettingName(preset);
      index += 1;
      continue;
    }
    if (arg.startsWith('--preset=')) {
      options.preset = normalizeSettingName(arg.slice('--preset='.length));
      continue;
    }
    if (arg === '--set') {
      const pair = args[index + 1];
      if (!pair) throw new Error('--set requires name=value');
      const [key, value] = parseSettingPair(pair);
      options.setOverrides[key] = value;
      index += 1;
      continue;
    }
    if (arg === '--extend-five-hour') {
      const next = args[index + 1];
      const value = next && !next.startsWith('--') ? next : '2';
      options.extendFiveHour = value;
      if (next && !next.startsWith('--')) index += 1;
      continue;
    }
    if (arg.startsWith('--extend-five-hour=')) {
      options.extendFiveHour = arg.slice('--extend-five-hour='.length) || '2';
      continue;
    }
    if (arg.startsWith('--set=')) {
      const [key, value] = parseSettingPair(arg.slice('--set='.length));
      options.setOverrides[key] = value;
      continue;
    }
    if (arg.startsWith('--') && Object.hasOwn(SETTING_ALIASES, normalizeSettingName(arg.slice(2)))) {
      const key = configKeyForSetting(arg.slice(2));
      const value = args[index + 1];
      if (!value) throw new Error(`${arg} requires a value`);
      options.setOverrides[key] = value;
      index += 1;
      continue;
    }
    throw new Error(`Unknown argument "${arg}".\n${usage()}`);
  }

  return options;
}

function hasExistingPluginConfig(homeDir) {
  try {
    const settingsPath = `${homeDir}/.claude/settings.json`;
    const settings = JSON.parse(readFileSync(settingsPath, 'utf8').replace(/^\uFEFF/, ''));
    return Boolean(settings?.pluginConfigs?.[PLUGIN_ID]?.options);
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    if (error instanceof SyntaxError) return false;
    throw error;
  }
}

function presetForName(name) {
  const presetName = name || 'balanced';
  const preset = PRESETS[presetName];
  if (!preset) {
    throw new Error(`Unknown preset "${name}". Valid presets: ${Object.keys(PRESETS).join(', ')}`);
  }
  return preset;
}

function formatNumber(value) {
  return Number(value || 0).toLocaleString('en-US');
}

function modeLabel(mode) {
  if (mode === 'subagent_only') return 'Only limit subagents';
  if (mode === 'observe') return 'Observe only';
  return mode;
}

function friendlyConfigLines(config, presetLabel) {
  return [
    `Preset: ${presetLabel}`,
    'Settings applied:',
    `  Subagents at once: ${formatNumber(config.max_concurrent_subagents)}`,
    `  Verified session token cap: ${formatNumber(config.max_subagent_tokens_per_session)}`,
    `  Warning at: ${formatNumber(config.subagent_token_warning_threshold_percent)}%`,
    `  5-hour warning gate: ${formatNumber(config.five_hour_warning_threshold_percent)}%`,
    `  5-hour budget: ${formatNumber(config.session_five_hour_budget_percent)} percentage points`,
    `  5-hour ceiling: ${formatNumber(config.absolute_five_hour_ceiling_percent)}%`,
    `  Mode: ${modeLabel(config.enforcement_mode)}`,
    `  Enforcement: ${config.enforcement_enabled ? 'enabled' : 'disabled'}`
  ];
}

async function promptForConfig(defaults, { askMode = true } = {}) {
  const rl = createInterface({
    input: process.stdin,
    output: process.stderr
  });
  const answers = {};

  try {
    if (askMode) {
      const presetAnswer = await rl.question(
        'Choose setup: Balanced, Strict, Observe Only, or Custom [Balanced]: '
      );
      const normalized = normalizeSettingName(presetAnswer || 'balanced').replace(/-only$/, '');
      if (['balanced', 'strict', 'observe'].includes(normalized)) {
        return {
          config: buildSetupConfig({ ...presetForName(normalized).config, ...defaults }),
          label: presetForName(normalized).label
        };
      }
    }

    const prompts = [
      ['agents', 'Subagents at once'],
      ['session-token-cap', 'Verified session token cap'],
      ['warn-at', 'Warning threshold percent'],
      ['five-hour-warning', '5-hour warning gate percent'],
      ['five-hour-budget', '5-hour budget percentage points'],
      ['five-hour-ceiling', '5-hour ceiling percent'],
      ['mode', 'Budget mode'],
      ['enabled', 'Enforcement enabled']
    ];
    for (const [name, label] of prompts) {
      const key = configKeyForSetting(name);
      const answer = await rl.question(`${label} [${defaults[key]}]: `);
      if (answer.trim()) {
        answers[key] = answer.trim();
      }
    }
  } finally {
    rl.close();
  }

  return {
    config: buildSetupConfig({ ...defaults, ...answers }),
    label: 'Custom'
  };
}

function buildNonInteractiveSetup(options, env = process.env) {
  let base;
  let label;

  if (options.extendFiveHour !== null) {
    base = loadConfig(env);
    const extension = Math.max(0, Number(options.extendFiveHour || 2));
    const nextWarning = Math.min(100, base.five_hour_warning_threshold_percent + extension);
    const nextBudget = Math.min(100, base.session_five_hour_budget_percent + extension);
    const nextCeiling = Math.min(100, base.absolute_five_hour_ceiling_percent + extension);
    options.setOverrides.five_hour_warning_threshold_percent = String(nextWarning);
    options.setOverrides.session_five_hour_budget_percent = String(nextBudget);
    options.setOverrides.absolute_five_hour_ceiling_percent = String(nextCeiling);
    label = `Extended Current (+${formatNumber(extension)}%)`;
  } else if (options.preset) {
    const preset = presetForName(options.preset);
    base = preset.config;
    label = preset.label;
  } else if (options.defaults) {
    base = PRESETS.balanced.config;
    label = PRESETS.balanced.label;
  } else if (Object.keys(options.setOverrides).length > 0) {
    const homeDir = getHomeDir(env);
    const hasExisting = hasExistingPluginConfig(homeDir);
    base = hasExisting ? loadConfig(env) : SETUP_CONFIG;
    label = hasExisting ? 'Current settings' : 'Balanced';
  } else {
    base = SETUP_CONFIG;
    label = PRESETS.balanced.label;
  }

  return {
    config: buildSetupConfig({
      ...base,
      ...options.setOverrides
    }),
    label
  };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const nonInteractive = buildNonInteractiveSetup(options);
  const setup = options.interactive
    ? await promptForConfig(nonInteractive.config, { askMode: false })
    : !options.defaults &&
        !options.preset &&
        Object.keys(options.setOverrides).length === 0 &&
        process.stdin.isTTY
      ? await promptForConfig(nonInteractive.config)
      : nonInteractive;
  const result = await installStatusLineBridge({
    homeDir: getHomeDir(process.env),
    pluginRoot: getPluginRoot(process.env),
    pluginData: getDataDir(process.env),
    setupConfig: setup.config
  });

  process.stdout.write(
    [
      'Subagent Cap statusLine bridge installed.',
      ...friendlyConfigLines(result.pluginConfigOptions, setup.label),
      `Settings: ${result.settingsPath}`,
      `Bridge state: ${result.bridgePath}`,
      `Bridge runner: ${result.runnerPath}`,
      'RESTART REQUIRED: fully exit and reopen Claude Code so hooks and statusLine reload.',
      'Then send one normal message before relying on /sub-agent-view for current-session telemetry.',
      result.bridgeRefreshed
        ? 'Existing Subagent Cap statusLine bridge refreshed for this plugin version.'
        : result.previousStatusLine
        ? 'Existing statusLine command preserved and wrapped.'
        : 'No previous statusLine command was configured.'
    ].join('\n') + '\n'
  );
}

main().catch((error) => {
  process.stderr.write(`setup failed: ${error.message}\n`);
  process.exitCode = 1;
});

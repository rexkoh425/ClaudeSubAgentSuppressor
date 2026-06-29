import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  CONFIG_KEYS,
  PLUGIN_ID,
  REMOVED_CONFIG_KEYS,
  SETUP_CONFIG,
  buildReport,
  handlePostToolUseAgent,
  handlePreToolUseAgent,
  handleUserPromptSubmit,
  installStatusLineBridge,
  pathExists,
  updateRateLimitFromStatusLine
} from './guard.js';

async function readJson(filePath) {
  const { readFile } = await import('node:fs/promises');
  const text = await readFile(filePath, 'utf8');
  return JSON.parse(text.replace(/^\uFEFF/, ''));
}

async function resolveLayout(repoRoot) {
  const packagePluginRoot = repoRoot;
  const marketplacePluginRoot = path.join(repoRoot, 'plugins', 'subagent-budget-guard');

  if (await pathExists(path.join(repoRoot, '.claude-plugin', 'marketplace.json'))) {
    return {
      repoRoot,
      pluginRoot: marketplacePluginRoot,
      hasMarketplace: true
    };
  }

  if (await pathExists(path.join(packagePluginRoot, '.claude-plugin', 'plugin.json'))) {
    return {
      repoRoot,
      pluginRoot: packagePluginRoot,
      hasMarketplace: false
    };
  }

  return {
    repoRoot,
    pluginRoot: marketplacePluginRoot,
    hasMarketplace: false
  };
}

async function withCheck(result, name, fn) {
  try {
    const detail = await fn();
    result.checks.push({ name, ok: true, detail: detail || 'ok' });
  } catch (error) {
    result.checks.push({ name, ok: false, detail: error.message });
    result.failures.push(`${name}: ${error.message}`);
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function withIsolatedPluginEnv(env, root, fn) {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'sbg-verify-data-'));
  const homeDir = await mkdtemp(path.join(os.tmpdir(), 'sbg-verify-home-'));
  const checkEnv = {
    PATH: env.PATH,
    Path: env.Path,
    SystemRoot: env.SystemRoot,
    USERPROFILE: homeDir,
    HOME: homeDir,
    CLAUDE_PLUGIN_DATA: dataDir,
    CLAUDE_PLUGIN_ROOT: root
  };

  try {
    return await fn(checkEnv, { dataDir, homeDir });
  } finally {
    await rm(dataDir, { recursive: true, force: true });
    await rm(homeDir, { recursive: true, force: true });
  }
}

export async function runOfflineVerification({
  repoRoot = process.cwd(),
  env = process.env
} = {}) {
  const result = {
    mode: 'offline',
    ok: false,
    checks: [],
    failures: []
  };
  const layout = await resolveLayout(repoRoot);
  const root = layout.pluginRoot;

  if (layout.hasMarketplace) {
    await withCheck(result, 'marketplace-manifest', async () => {
      const marketplacePath = path.join(repoRoot, '.claude-plugin', 'marketplace.json');
      const marketplace = await readJson(marketplacePath);
      assert(marketplace.name === 'subagent-tools', 'marketplace name mismatch');
      assert(Array.isArray(marketplace.plugins), 'marketplace.plugins must be an array');
      const entry = marketplace.plugins.find((plugin) => plugin.name === 'subagent-cap');
      assert(entry, 'subagent-cap entry missing');
      assert(entry.source?.source === 'npm', 'marketplace source must use npm');
      assert(
        entry.source?.package === '@rex_koh/subagent-budget-guard',
        'marketplace npm package mismatch'
      );
      assert(entry.source?.version === '0.5.5', 'marketplace npm version mismatch');
      return marketplacePath;
    });
  } else {
    await withCheck(result, 'package-root', async () => {
      const packageJsonPath = path.join(root, 'package.json');
      const packageJson = await readJson(packageJsonPath);
      assert(
        packageJson.name === '@rex_koh/subagent-budget-guard',
        'package root name mismatch'
      );
      return packageJsonPath;
    });
  }

  await withCheck(result, 'plugin-manifest-no-install-config', async () => {
    const manifestPath = path.join(root, '.claude-plugin', 'plugin.json');
    const manifest = await readJson(manifestPath);
    assert(manifest.name === 'subagent-cap', 'plugin name mismatch');
    assert(
      manifest.hooks === undefined,
      'manifest.hooks must be omitted for default hooks/hooks.json to avoid duplicate loading'
    );
    assert(
      manifest.skills === undefined,
      'manifest.skills must be omitted for default skills/ scanning to avoid duplicate loading'
    );
    assert(
      manifest.userConfig === undefined,
      'manifest.userConfig must be omitted so installs do not ask for --config flags'
    );
    return manifestPath;
  });

  await withCheck(result, 'hooks-config', async () => {
    const hooksPath = path.join(root, 'hooks', 'hooks.json');
    const hooks = await readJson(hooksPath);
    const requiredEvents = [
      'PreToolUse',
      'PostToolUse',
      'PostToolBatch',
      'SubagentStart',
      'SubagentStop',
      'TaskCreated',
      'TaskCompleted',
      'UserPromptSubmit'
    ];
    for (const event of requiredEvents) {
      assert(Array.isArray(hooks.hooks?.[event]), `missing hooks.${event}`);
    }
    assert(hooks.hooks.PreToolUse[0].matcher === 'Agent', 'PreToolUse must match Agent');
    assert(hooks.hooks.PostToolUse[0].matcher === 'Agent', 'PostToolUse must match Agent');
    return hooksPath;
  });

  await withCheck(result, 'script-paths', async () => {
    const scripts = [
      'bin/hook.js',
      'bin/subagent-cap.js',
      'bin/statusline.js',
      'bin/setup.js',
      'bin/report.js',
      'bin/view.js',
      'bin/verify.js',
      'lib/guard.js',
      'lib/verifier.js',
      'commands/sub-agent-view.md',
      'skills/init/SKILL.md'
    ];
    for (const script of scripts) {
      assert(await pathExists(path.join(root, script)), `missing ${script}`);
    }
    return `${scripts.length} files present`;
  });

  await withCheck(result, 'pretool-agent-denies-default', async () => {
    return withIsolatedPluginEnv(env, root, async (checkEnv) => {
      const output = await handlePreToolUseAgent(
        {
          session_id: 'offline-pretool',
          hook_event_name: 'PreToolUse',
          tool_name: 'Agent',
          tool_input: { description: 'verify', subagent_type: 'Explore' }
        },
        checkEnv
      );
      assert(
        output.stdout?.hookSpecificOutput?.permissionDecision === 'deny',
        'Agent launch was not denied by default'
      );
      return output.stdout.hookSpecificOutput.permissionDecisionReason;
    });
  });

  await withCheck(result, 'posttool-agent-records-verified-tokens', async () => {
    return withIsolatedPluginEnv(env, root, async (checkEnv) => {
      await handlePostToolUseAgent(
        {
          session_id: 'offline-posttool',
          hook_event_name: 'PostToolUse',
          tool_name: 'Agent',
          tool_input: { description: 'verify', subagent_type: 'Explore' },
          tool_response: {
            status: 'completed',
            agentId: 'agent-verify',
            totalTokens: 101,
            totalToolUseCount: 2,
            totalDurationMs: 300
          }
        },
        checkEnv
      );
      const report = await buildReport('offline-posttool', checkEnv);
      assert(report.state.subagents.verifiedTokens === 101, 'verified token count mismatch');
      return report.summary.verifiedTokenLabel;
    });
  });

  await withCheck(result, 'statusline-budget-blocks', async () => {
    return withIsolatedPluginEnv(env, root, async (baseEnv) => {
      const checkEnv = {
        ...baseEnv,
        CLAUDE_PLUGIN_OPTION_session_five_hour_budget_percent: '3'
      };
      await updateRateLimitFromStatusLine(
        {
          session_id: 'offline-budget',
          rate_limits: { five_hour: { used_percentage: 10, resets_at: 1 } }
        },
        checkEnv
      );
      await updateRateLimitFromStatusLine(
        {
          session_id: 'offline-budget',
          rate_limits: { five_hour: { used_percentage: 13.5, resets_at: 1 } }
        },
        checkEnv
      );
      const output = await handleUserPromptSubmit(
        {
          session_id: 'offline-budget',
          hook_event_name: 'UserPromptSubmit',
          prompt: 'continue'
        },
        checkEnv
      );
      assert(output.stdout?.decision === 'block', 'prompt was not blocked');
      return output.stdout.reason;
    });
  });

  await withCheck(result, 'statusline-setup-wraps-existing-command', async () => {
    const dataDir = await mkdtemp(path.join(os.tmpdir(), 'sbg-verify-data-'));
    const homeDir = await mkdtemp(path.join(os.tmpdir(), 'sbg-verify-home-'));
    try {
      const { mkdir, writeFile, readFile } = await import('node:fs/promises');
      const claudeDir = path.join(homeDir, '.claude');
      await mkdir(claudeDir, { recursive: true });
      await writeFile(
        path.join(claudeDir, 'settings.json'),
        JSON.stringify({
          statusLine: {
            type: 'command',
            command: 'node old-statusline.js'
          }
        })
      );
      const setup = await installStatusLineBridge({
        homeDir,
        pluginRoot: root,
        pluginData: dataDir
      });
      const settings = JSON.parse(await readFile(path.join(claudeDir, 'settings.json'), 'utf8'));
      assert(settings.statusLine.command.includes('statusline.js'), 'bridge command missing');
      assert(settings.statusLine.command.includes('--data'), 'bridge data arg missing');
      return setup.bridgePath;
    } finally {
      await rm(dataDir, { recursive: true, force: true });
      await rm(homeDir, { recursive: true, force: true });
    }
  });

  await withCheck(result, 'setup-applies-plugin-config', async () => {
    const dataDir = await mkdtemp(path.join(os.tmpdir(), 'sbg-verify-data-'));
    const homeDir = await mkdtemp(path.join(os.tmpdir(), 'sbg-verify-home-'));
    try {
      const { mkdir, writeFile } = await import('node:fs/promises');
      const claudeDir = path.join(homeDir, '.claude');
      const settingsPath = path.join(claudeDir, 'settings.json');
      await mkdir(claudeDir, { recursive: true });
      await writeFile(
        settingsPath,
        JSON.stringify({
          pluginConfigs: {
            [PLUGIN_ID]: {
              options: {
                max_subagents_per_session: 9,
                max_concurrent_subagents: 0,
                max_agent_team_tasks_per_session: 4,
                max_subagent_tokens_per_session: 0,
                enforcement_enabled: false
              }
            }
          }
        })
      );

      await installStatusLineBridge({
        homeDir,
        pluginRoot: root,
        pluginData: dataDir
      });

      const settings = await readJson(settingsPath);
      const options = settings.pluginConfigs?.[PLUGIN_ID]?.options;
      assert(options, `missing pluginConfigs.${PLUGIN_ID}.options`);
      for (const key of CONFIG_KEYS) {
        assert(options[key] === SETUP_CONFIG[key], `setup config ${key} mismatch`);
      }
      for (const key of REMOVED_CONFIG_KEYS) {
        assert(!(key in options), `obsolete option ${key} was not removed`);
      }
      return `${PLUGIN_ID} recommended setup config applied`;
    } finally {
      await rm(dataDir, { recursive: true, force: true });
      await rm(homeDir, { recursive: true, force: true });
    }
  });

  result.ok = result.failures.length === 0;
  return result;
}

function commandExists(command) {
  return new Promise((resolve) => {
    const child = spawn(process.platform === 'win32' ? 'where.exe' : 'which', [command], {
      stdio: 'ignore',
      windowsHide: true
    });
    child.on('exit', (code) => resolve(code === 0));
    child.on('error', () => resolve(false));
  });
}

function runCommand(command, args, options = {}) {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      shell: false,
      windowsHide: true
    });
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr?.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('exit', (code) => resolve({ code, stdout, stderr }));
    child.on('error', (error) =>
      resolve({ code: 1, stdout, stderr: `${stderr}\n${error.message}` })
    );
  });
}

export async function runLiveVerification({
  repoRoot = process.cwd(),
  env = process.env
} = {}) {
  const result = {
    mode: 'live',
    ok: false,
    checks: [],
    failures: [],
    warnings: []
  };
  const offline = await runOfflineVerification({ repoRoot, env });
  result.checks.push(...offline.checks);
  result.failures.push(...offline.failures);

  const layout = await resolveLayout(repoRoot);
  const root = layout.pluginRoot;
  const hasClaude = await commandExists('claude');
  if (!hasClaude) {
    result.warnings.push('claude executable was not found on PATH; skipped claude plugin validate and install-state checks.');
  } else {
    await withCheck(result, 'claude-plugin-validate', async () => {
      const validate = await runCommand('claude', ['plugin', 'validate', root], {
        cwd: repoRoot
      });
      assert(validate.code === 0, validate.stderr || validate.stdout || 'claude plugin validate failed');
      return validate.stdout.trim() || 'claude plugin validate passed';
    });

    await withCheck(result, 'claude-plugin-list', async () => {
      const list = await runCommand('claude', ['plugin', 'list'], { cwd: repoRoot });
      assert(list.code === 0, list.stderr || list.stdout || 'claude plugin list failed');
      assert(
        list.stdout.includes('subagent-cap'),
        'subagent-cap is not installed'
      );
      assert(
        !/subagent-cap@subagent-tools[\s\S]*failed to load/i.test(list.stdout),
        'subagent-cap is installed but failed to load'
      );
      return 'claude plugin list returned output';
    });
  }

  await withCheck(result, 'statusline-bridge-configured', async () => {
    const home = env.USERPROFILE || env.HOME || os.homedir();
    const settingsPath = path.join(home, '.claude', 'settings.json');
    const settings = await readJson(settingsPath);
    assert(
      typeof settings.statusLine?.command === 'string' &&
        settings.statusLine.command.includes('statusline.js') &&
        settings.statusLine.command.includes('--data'),
      'statusLine bridge is not installed; run /subagent-cap:init'
    );
    return settings.statusLine.command;
  });

  result.ok = result.failures.length === 0;
  return result;
}

export function formatVerificationResult(result) {
  const lines = [
    `Subagent Cap ${result.mode} verification`,
    result.ok ? 'PASS' : 'FAIL'
  ];

  for (const check of result.checks) {
    lines.push(`${check.ok ? 'PASS' : 'FAIL'} ${check.name}: ${check.detail}`);
  }

  for (const warning of result.warnings || []) {
    lines.push(`WARN ${warning}`);
  }

  if (result.failures.length > 0) {
    lines.push('Failures:');
    for (const failure of result.failures) {
      lines.push(`- ${failure}`);
    }
  }

  return lines.join('\n');
}

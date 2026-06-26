import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import {
  DEFAULT_CONFIG,
  buildReport,
  getPluginRoot,
  handlePostToolUseAgent,
  handlePreToolUseAgent,
  handleSubagentStart,
  handleSubagentStop,
  handleTaskCompleted,
  handleTaskCreated,
  handleUserPromptSubmit,
  installStatusLineBridge,
  loadConfig,
  updateRateLimitFromStatusLine
} from '../lib/guard.js';

import { runOfflineVerification } from '../lib/verifier.js';

const execFileAsync = promisify(execFile);

async function withTempEnv(fn) {
  const dir = await mkdtemp(path.join(tmpdir(), 'sbg-test-'));
  const env = {
    CLAUDE_PLUGIN_DATA: dir,
    CLAUDE_PLUGIN_ROOT: path.resolve('plugins/subagent-budget-guard')
  };

  try {
    return await fn(env, dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function agentInput(sessionId = 'session-a') {
  return {
    session_id: sessionId,
    transcript_path: '/tmp/transcript.jsonl',
    cwd: '/workspace',
    hook_event_name: 'PreToolUse',
    tool_name: 'Agent',
    tool_input: {
      description: 'Explore repo',
      prompt: 'Find risky code paths',
      subagent_type: 'Explore'
    },
    tool_use_id: 'toolu_123'
  };
}

test('getPluginRoot falls back to the installed package root', () => {
  const expectedRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

  assert.equal(getPluginRoot({}), expectedRoot);
});

test('loadConfig uses strict deny-by-default limits', () => {
  const config = loadConfig({});

  assert.deepEqual(config, DEFAULT_CONFIG);
  assert.equal('max_subagents_per_session' in config, false);
  assert.equal('max_agent_team_tasks_per_session' in config, false);
  assert.equal(config.max_concurrent_subagents, 0);
  assert.equal(config.enforcement_enabled, true);
});

test('plugin manifest omits userConfig so install does not ask for config flags', async () => {
  const manifestPath = path.resolve('plugins/subagent-budget-guard/.claude-plugin/plugin.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));

  assert.equal(manifest.userConfig, undefined);
});

test('loadConfig reads setup options from Claude settings', async () => {
  const homeDir = await mkdtemp(path.join(tmpdir(), 'sbg-home-'));
  try {
    const claudeDir = path.join(homeDir, '.claude');
    await mkdir(claudeDir, { recursive: true });
    await writeFile(
      path.join(claudeDir, 'settings.json'),
      JSON.stringify({
        pluginConfigs: {
          'subagent-budget-guard@subagent-budget-tools': {
            options: {
              max_concurrent_subagents: 2,
              max_subagent_tokens_per_session: 50000,
              subagent_token_warning_threshold_percent: 90,
              session_five_hour_budget_percent: 15,
              absolute_five_hour_ceiling_percent: 88,
              enforcement_enabled: false
            }
          }
        }
      })
    );

    const config = loadConfig({ USERPROFILE: homeDir });

    assert.equal(config.max_concurrent_subagents, 2);
    assert.equal(config.max_subagent_tokens_per_session, 50000);
    assert.equal(config.subagent_token_warning_threshold_percent, 90);
    assert.equal(config.session_five_hour_budget_percent, 15);
    assert.equal(config.absolute_five_hour_ceiling_percent, 88);
    assert.equal(config.enforcement_enabled, false);
  } finally {
    await rm(homeDir, { recursive: true, force: true });
  }
});

test('PreToolUse Agent denies subagent launches by default', async () => {
  await withTempEnv(async (env) => {
    const result = await handlePreToolUseAgent(agentInput(), env);

    assert.equal(result.stdout.hookSpecificOutput.hookEventName, 'PreToolUse');
    assert.equal(result.stdout.hookSpecificOutput.permissionDecision, 'deny');
    assert.match(
      result.stdout.hookSpecificOutput.permissionDecisionReason,
      /max_concurrent_subagents is 0/
    );
  });
});

test('PreToolUse Agent allows when configured concurrent limit remains', async () => {
  await withTempEnv(async (env) => {
    env.CLAUDE_PLUGIN_OPTION_max_concurrent_subagents = '1';

    const result = await handlePreToolUseAgent(agentInput(), env);

    assert.equal(result.stdout, null);
    assert.equal(result.exitCode, 0);
    const report = await buildReport('session-a', env);
    assert.equal(report.state.subagents.requested, 1);
    assert.equal(report.state.subagents.denied, 0);
  });
});

test('SubagentStart and SubagentStop cross-check active lifecycle counts', async () => {
  await withTempEnv(async (env) => {
    await handleSubagentStart(
      {
        session_id: 'session-life',
        hook_event_name: 'SubagentStart',
        agent_id: 'agent-1',
        agent_type: 'Explore'
      },
      env
    );

    let report = await buildReport('session-life', env);
    assert.equal(report.state.subagents.active, 1);
    assert.equal(report.state.subagents.lifecycleStarted, 1);

    await handleSubagentStop(
      {
        session_id: 'session-life',
        hook_event_name: 'SubagentStop',
        agent_id: 'agent-1',
        agent_type: 'Explore',
        last_assistant_message: 'Done'
      },
      env
    );

    report = await buildReport('session-life', env);
    assert.equal(report.state.subagents.active, 0);
    assert.equal(report.state.subagents.lifecycleStopped, 1);
  });
});

test('PostToolUse Agent records verified subagent tokens and metadata', async () => {
  await withTempEnv(async (env) => {
    await handlePostToolUseAgent(
      {
        session_id: 'session-tokens',
        hook_event_name: 'PostToolUse',
        tool_name: 'Agent',
        tool_input: { description: 'Analyze auth', subagent_type: 'Explore' },
        tool_response: {
          status: 'completed',
          agentId: 'agent-token',
          resolvedModel: 'claude-sonnet-4-5',
          totalTokens: 12450,
          totalDurationMs: 48211,
          totalToolUseCount: 7,
          usage: {
            input_tokens: 8000,
            output_tokens: 1000,
            cache_creation_input_tokens: 2000,
            cache_read_input_tokens: 1450
          }
        }
      },
      env
    );

    const report = await buildReport('session-tokens', env);
    assert.equal(report.state.subagents.completed, 1);
    assert.equal(report.state.subagents.verifiedTokens, 12450);
    assert.equal(report.state.subagents.totalToolUseCount, 7);
    assert.equal(report.state.subagents.runs[0].verified, true);
    assert.equal(report.summary.verifiedTokenLabel, '12,450 verified tokens');
  });
});

test('PostToolUse Agent asks Claude to stop when subagent token usage reaches warning threshold', async () => {
  await withTempEnv(async (env) => {
    env.CLAUDE_PLUGIN_OPTION_max_subagent_tokens_per_session = '1000';
    env.CLAUDE_PLUGIN_OPTION_max_concurrent_subagents = '1';

    const result = await handlePostToolUseAgent(
      {
        session_id: 'session-token-warning',
        hook_event_name: 'PostToolUse',
        tool_name: 'Agent',
        tool_input: { description: 'Large analysis', subagent_type: 'Explore' },
        tool_response: {
          status: 'completed',
          agentId: 'agent-warning',
          resolvedModel: 'claude-sonnet-4-5',
          totalTokens: 950,
          totalDurationMs: 1200,
          totalToolUseCount: 2
        }
      },
      env
    );

    assert.equal(result.exitCode, 2);
    assert.match(result.stderr, /95\.0%/);
    assert.match(result.stderr, /stop using subagents/i);

    const report = await buildReport('session-token-warning', env);
    assert.equal(report.state.subagents.verifiedTokens, 950);
    assert.equal(report.state.subagents.tokenBudgetWarnings, 1);
    assert.equal(report.summary.subagentTokenBudget, '950/1,000 verified tokens (95.0%)');
  });
});

test('PreToolUse Agent blocks new subagents after token warning threshold is reached', async () => {
  await withTempEnv(async (env) => {
    env.CLAUDE_PLUGIN_OPTION_max_subagent_tokens_per_session = '1000';
    env.CLAUDE_PLUGIN_OPTION_max_concurrent_subagents = '1';

    await handlePostToolUseAgent(
      {
        session_id: 'session-token-pretool',
        hook_event_name: 'PostToolUse',
        tool_name: 'Agent',
        tool_input: { description: 'Large analysis', subagent_type: 'Explore' },
        tool_response: {
          status: 'completed',
          agentId: 'agent-warning',
          totalTokens: 950
        }
      },
      env
    );

    const result = await handlePreToolUseAgent(agentInput('session-token-pretool'), env);

    assert.equal(result.stdout.hookSpecificOutput.permissionDecision, 'deny');
    assert.match(
      result.stdout.hookSpecificOutput.permissionDecisionReason,
      /95\.0%.*warning threshold/i
    );
  });
});

test('UserPromptSubmit blocks when subagent token cap is reached', async () => {
  await withTempEnv(async (env) => {
    env.CLAUDE_PLUGIN_OPTION_max_subagent_tokens_per_session = '1000';

    await handlePostToolUseAgent(
      {
        session_id: 'session-token-cap',
        hook_event_name: 'PostToolUse',
        tool_name: 'Agent',
        tool_input: { description: 'Huge analysis', subagent_type: 'Explore' },
        tool_response: {
          status: 'completed',
          agentId: 'agent-cap',
          totalTokens: 1001
        }
      },
      env
    );

    const result = await handleUserPromptSubmit(
      {
        session_id: 'session-token-cap',
        hook_event_name: 'UserPromptSubmit',
        prompt: 'continue'
      },
      env
    );

    assert.equal(result.stdout.decision, 'block');
    assert.match(result.stdout.reason, /verified subagent token cap reached/i);
  });
});

test('PostToolUse Agent marks background launches as lifecycle-counted but not token-verified', async () => {
  await withTempEnv(async (env) => {
    await handlePostToolUseAgent(
      {
        session_id: 'session-bg',
        hook_event_name: 'PostToolUse',
        tool_name: 'Agent',
        tool_input: { description: 'Background review', subagent_type: 'Explore' },
        tool_response: {
          status: 'async_launched',
          agentId: 'agent-bg',
          outputFile: '/tmp/bg.txt',
          resolvedModel: 'claude-sonnet-4-5'
        }
      },
      env
    );

    const report = await buildReport('session-bg', env);
    assert.equal(report.state.subagents.backgroundLaunched, 1);
    assert.equal(report.state.subagents.verifiedTokens, 0);
    assert.equal(report.state.subagents.runs[0].verified, false);
  });
});

test('UserPromptSubmit blocks when five-hour session budget delta is exhausted', async () => {
  await withTempEnv(async (env) => {
    env.CLAUDE_PLUGIN_OPTION_session_five_hour_budget_percent = '5';

    await updateRateLimitFromStatusLine(
      {
        session_id: 'session-budget',
        rate_limits: { five_hour: { used_percentage: 40, resets_at: 2000 } }
      },
      env
    );
    await updateRateLimitFromStatusLine(
      {
        session_id: 'session-budget',
        rate_limits: { five_hour: { used_percentage: 46.5, resets_at: 2000 } }
      },
      env
    );

    const result = await handleUserPromptSubmit(
      {
        session_id: 'session-budget',
        hook_event_name: 'UserPromptSubmit',
        prompt: 'continue'
      },
      env
    );

    assert.equal(result.stdout.decision, 'block');
    assert.equal(result.stdout.suppressOriginalPrompt, true);
    assert.match(result.stdout.reason, /5-hour budget exhausted/);
  });
});

test('rate-limit baseline resets when the five-hour window rolls over', async () => {
  await withTempEnv(async (env) => {
    await updateRateLimitFromStatusLine(
      {
        session_id: 'session-reset',
        rate_limits: { five_hour: { used_percentage: 80, resets_at: 2000 } }
      },
      env
    );
    await updateRateLimitFromStatusLine(
      {
        session_id: 'session-reset',
        rate_limits: { five_hour: { used_percentage: 8, resets_at: 3000 } }
      },
      env
    );

    const report = await buildReport('session-reset', env);
    assert.equal(report.state.rateLimits.fiveHour.baselineUsedPercentage, 8);
    assert.equal(report.state.rateLimits.fiveHour.latestUsedPercentage, 8);
    assert.equal(report.state.rateLimits.fiveHour.resetsAt, 3000);
  });
});

test('TaskCreated records agent-team tasks without count-based suppression', async () => {
  await withTempEnv(async (env) => {
    const result = await handleTaskCreated(
      {
        session_id: 'session-task',
        hook_event_name: 'TaskCreated',
        task_id: 'task-1',
        task_subject: 'Implement auth'
      },
      env
    );

    assert.equal(result.exitCode, 0);
    assert.equal(result.stderr, '');
    const report = await buildReport('session-task', env);
    assert.equal(report.state.agentTeam.created, 1);
    assert.equal(report.state.agentTeam.denied, 0);
  });
});

test('TaskCompleted records task completions when completion hook fires', async () => {
  await withTempEnv(async (env) => {
    await handleTaskCreated(
      {
        session_id: 'session-task-complete',
        hook_event_name: 'TaskCreated',
        task_id: 'task-1',
        task_subject: 'Implement auth'
      },
      env
    );

    await handleTaskCompleted(
      {
        session_id: 'session-task-complete',
        hook_event_name: 'TaskCompleted',
        task_id: 'task-1',
        task_subject: 'Implement auth'
      },
      env
    );

    const report = await buildReport('session-task-complete', env);
    assert.equal(report.state.agentTeam.created, 1);
    assert.equal(report.state.agentTeam.completed, 1);
  });
});

test('installStatusLineBridge preserves an existing statusLine command', async () => {
  await withTempEnv(async (env, dataDir) => {
    const homeDir = await mkdtemp(path.join(tmpdir(), 'sbg-home-'));
    try {
      const claudeDir = path.join(homeDir, '.claude');
      await writeFile(
        path.join(claudeDir, 'settings.json'),
        JSON.stringify({
          statusLine: {
            type: 'command',
            command: 'node old-statusline.js',
            padding: 2
          }
        }),
        { recursive: true }
      ).catch(async (error) => {
        if (error.code !== 'ENOENT') throw error;
        await import('node:fs/promises').then(({ mkdir }) =>
          mkdir(claudeDir, { recursive: true })
        );
        await writeFile(
          path.join(claudeDir, 'settings.json'),
          JSON.stringify({
            statusLine: {
              type: 'command',
              command: 'node old-statusline.js',
              padding: 2
            }
          })
        );
      });

      const result = await installStatusLineBridge({
        homeDir,
        pluginRoot: env.CLAUDE_PLUGIN_ROOT,
        pluginData: dataDir
      });

      assert.equal(result.installed, true);
      const settings = JSON.parse(await readFile(path.join(claudeDir, 'settings.json'), 'utf8'));
      assert.match(settings.statusLine.command, /statusline\.js/);
      assert.match(settings.statusLine.command, /--data/);

      const bridge = JSON.parse(
        await readFile(path.join(dataDir, 'statusline-bridge.json'), 'utf8')
      );
      assert.equal(bridge.previousStatusLine.command, 'node old-statusline.js');
      assert.equal(bridge.previousStatusLine.padding, 2);
    } finally {
      await rm(homeDir, { recursive: true, force: true });
    }
  });
});

test('installStatusLineBridge applies setup config and removes obsolete options', async () => {
  await withTempEnv(async (env, dataDir) => {
    const homeDir = await mkdtemp(path.join(tmpdir(), 'sbg-home-'));
    try {
      const claudeDir = path.join(homeDir, '.claude');
      await mkdir(claudeDir, { recursive: true });
      await writeFile(
        path.join(claudeDir, 'settings.json'),
        JSON.stringify({
          pluginConfigs: {
            'subagent-budget-guard@subagent-budget-tools': {
              options: {
                max_subagents_per_session: 3,
                max_concurrent_subagents: 0,
                max_agent_team_tasks_per_session: 2,
                max_subagent_tokens_per_session: 0,
                enforcement_enabled: false
              }
            }
          }
        })
      );

      const result = await installStatusLineBridge({
        homeDir,
        pluginRoot: env.CLAUDE_PLUGIN_ROOT,
        pluginData: dataDir
      });

      const settings = JSON.parse(await readFile(path.join(claudeDir, 'settings.json'), 'utf8'));
      const options =
        settings.pluginConfigs['subagent-budget-guard@subagent-budget-tools'].options;

      assert.deepEqual(options, {
        max_concurrent_subagents: 1,
        max_subagent_tokens_per_session: 100000,
        subagent_token_warning_threshold_percent: 95,
        session_five_hour_budget_percent: 25,
        absolute_five_hour_ceiling_percent: 95,
        enforcement_enabled: true
      });
      assert.equal(result.pluginConfigApplied, true);
      assert.deepEqual(result.pluginConfigOptions, options);
      assert.equal('max_subagents_per_session' in options, false);
      assert.equal('max_agent_team_tasks_per_session' in options, false);
    } finally {
      await rm(homeDir, { recursive: true, force: true });
    }
  });
});

test('offline verifier validates plugin shape and simulated enforcement', async () => {
  await withTempEnv(async (env) => {
    const result = await runOfflineVerification({
      repoRoot: path.resolve('.'),
      env
    });

    assert.equal(result.ok, true, result.failures.join('\n'));
    assert.equal(result.failures.length, 0);
    assert.ok(result.checks.some((check) => check.name === 'pretool-agent-denies-default'));
    assert.ok(result.checks.some((check) => check.name === 'statusline-budget-blocks'));
    assert.ok(result.checks.some((check) => check.name === 'setup-applies-plugin-config'));
  });
});

test('offline verifier ignores real Claude settings from caller environment', async () => {
  const homeDir = await mkdtemp(path.join(tmpdir(), 'sbg-real-home-'));
  try {
    const claudeDir = path.join(homeDir, '.claude');
    await mkdir(claudeDir, { recursive: true });
    await writeFile(
      path.join(claudeDir, 'settings.json'),
      JSON.stringify({
        pluginConfigs: {
          'subagent-budget-guard@subagent-budget-tools': {
            options: {
              max_concurrent_subagents: 1,
              max_subagent_tokens_per_session: 100000,
              enforcement_enabled: true
            }
          }
        }
      })
    );

    const result = await runOfflineVerification({
      repoRoot: path.resolve('.'),
      env: {
        ...process.env,
        USERPROFILE: homeDir,
        HOME: homeDir
      }
    });

    assert.equal(result.ok, true, result.failures.join('\n'));
    assert.equal(result.failures.length, 0);
  } finally {
    await rm(homeDir, { recursive: true, force: true });
  }
});

test('setup CLI applies custom config values over recommended defaults', async () => {
  const homeDir = await mkdtemp(path.join(tmpdir(), 'sbg-home-'));
  const dataDir = await mkdtemp(path.join(tmpdir(), 'sbg-data-'));
  try {
    await execFileAsync(
      process.execPath,
      [
        path.resolve('plugins/subagent-budget-guard/bin/setup.js'),
        '--config',
        'max_concurrent_subagents=3',
        '--config',
        'max_subagent_tokens_per_session=250000',
        '--config',
        'subagent_token_warning_threshold_percent=80',
        '--config',
        'session_five_hour_budget_percent=10',
        '--config',
        'absolute_five_hour_ceiling_percent=90',
        '--config',
        'enforcement_enabled=false'
      ],
      {
        cwd: path.resolve('.'),
        env: {
          ...process.env,
          USERPROFILE: homeDir,
          HOME: homeDir,
          CLAUDE_PLUGIN_ROOT: path.resolve('plugins/subagent-budget-guard'),
          CLAUDE_PLUGIN_DATA: dataDir
        }
      }
    );

    const settings = JSON.parse(
      await readFile(path.join(homeDir, '.claude', 'settings.json'), 'utf8')
    );
    const options =
      settings.pluginConfigs['subagent-budget-guard@subagent-budget-tools'].options;

    assert.equal(options.max_concurrent_subagents, 3);
    assert.equal(options.max_subagent_tokens_per_session, 250000);
    assert.equal(options.subagent_token_warning_threshold_percent, 80);
    assert.equal(options.session_five_hour_budget_percent, 10);
    assert.equal(options.absolute_five_hour_ceiling_percent, 90);
    assert.equal(options.enforcement_enabled, false);
  } finally {
    await rm(homeDir, { recursive: true, force: true });
    await rm(dataDir, { recursive: true, force: true });
  }
});

import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import {
  DEFAULT_CONFIG,
  buildReport,
  formatSubagentView,
  getPluginRoot,
  handlePostToolBatch,
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

function execNodeWithInput(args, input, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, {
      cwd: path.resolve('.'),
      env: {
        ...process.env,
        ...(options.env || {})
      },
      windowsHide: true
    });
    let stdout = '';
    let stderr = '';

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('error', reject);
    child.on('close', (code) => {
      resolve({ code, stdout, stderr });
    });
    child.stdin.end(input);
  });
}

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

  assert.equal(manifest.name, 'subagent-cap');
  assert.equal(manifest.userConfig, undefined);
});

test('marketplace exposes the subagent-cap install name', async () => {
  const marketplace = JSON.parse(
    await readFile(path.resolve('.claude-plugin/marketplace.json'), 'utf8')
  );
  const entry = marketplace.plugins.find((plugin) => plugin.name === 'subagent-cap');

  assert.ok(entry, 'missing subagent-cap marketplace entry');
  assert.equal(entry.displayName, 'Subagent Cap');
  assert.equal(entry.source.package, '@rex_koh/subagent-budget-guard');
});

test('release metadata is bumped for sub-agent-view slash command', async () => {
  const expectedVersion = '0.5.6';
  const rootPackage = JSON.parse(await readFile(path.resolve('package.json'), 'utf8'));
  const pluginPackage = JSON.parse(
    await readFile(path.resolve('plugins/subagent-budget-guard/package.json'), 'utf8')
  );
  const manifest = JSON.parse(
    await readFile(
      path.resolve('plugins/subagent-budget-guard/.claude-plugin/plugin.json'),
      'utf8'
    )
  );
  const marketplace = JSON.parse(
    await readFile(path.resolve('.claude-plugin/marketplace.json'), 'utf8')
  );
  const entry = marketplace.plugins.find((plugin) => plugin.name === 'subagent-cap');

  assert.equal(rootPackage.version, expectedVersion);
  assert.equal(pluginPackage.version, expectedVersion);
  assert.equal(manifest.version, expectedVersion);
  assert.equal(marketplace.version, expectedVersion);
  assert.equal(entry.version, expectedVersion);
  assert.equal(entry.source.version, expectedVersion);
});

test('plugin exposes init skill plus sub-agent-view command', async () => {
  const skillsDir = path.resolve('plugins/subagent-budget-guard/skills');
  const entries = await readdir(skillsDir, { withFileTypes: true });
  const names = entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();

  assert.deepEqual(names, ['init']);

  const text = await readFile(path.join(skillsDir, 'init', 'SKILL.md'), 'utf8');
  assert.match(text, /# Init Subagent Cap/i);

  const commandPath = path.resolve('plugins/subagent-budget-guard/commands/sub-agent-view.md');
  const command = await readFile(commandPath, 'utf8');

  assert.match(command, /allowed-tools: Bash\(node:\*\)/);
  assert.match(command, /node "\$\{CLAUDE_PLUGIN_ROOT\}\/bin\/view\.js"/);
  assert.match(command, /!\`node "\$\{CLAUDE_PLUGIN_ROOT\}\/bin\/view\.js" \$ARGUMENTS\`/);
});

test('npm package ships Claude command files', async () => {
  const packageJson = JSON.parse(
    await readFile(path.resolve('plugins/subagent-budget-guard/package.json'), 'utf8')
  );

  assert.ok(packageJson.files.includes('commands/'));
});

test('hook CLI accepts BOM-prefixed JSON from stdin', async () => {
  await withTempEnv(async (env) => {
    const result = await execNodeWithInput(
      [path.resolve('plugins/subagent-budget-guard/bin/hook.js'), 'pretool-agent'],
      `\uFEFF${JSON.stringify(agentInput('session-hook-bom'))}`,
      { env }
    );

    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.stderr, '');

    const output = JSON.parse(result.stdout);
    assert.equal(output.hookSpecificOutput.hookEventName, 'PreToolUse');
    assert.equal(output.hookSpecificOutput.permissionDecision, 'deny');

    const report = await buildReport('session-hook-bom', env);
    assert.equal(report.state.subagents.requested, 1);
    assert.equal(report.state.subagents.denied, 1);
  });
});

test('statusline CLI accepts BOM-prefixed JSON from stdin', async () => {
  await withTempEnv(async (env) => {
    const result = await execNodeWithInput(
      [
        path.resolve('plugins/subagent-budget-guard/bin/statusline.js'),
        '--data',
        env.CLAUDE_PLUGIN_DATA
      ],
      `\uFEFF${JSON.stringify({
        session_id: 'session-statusline-bom',
        rate_limits: {
          five_hour: {
            used_percentage: 12.5,
            resets_at: 123456
          }
        }
      })}`,
      { env }
    );

    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.stderr, '');
    assert.match(result.stdout, /SBG agents 0\/0/);
    assert.match(result.stdout, /5h 12\.5%/);
    assert.doesNotMatch(result.stdout, /SBG error/);

    const report = await buildReport('session-statusline-bom', env);
    assert.equal(report.state.rateLimits.fiveHour.latestUsedPercentage, 12.5);
  });
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
          'subagent-cap@subagent-tools': {
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

test('PreToolUse Agent queues concurrency-denied subagents with full prompt and de-duplicates retries', async () => {
  await withTempEnv(async (env) => {
    env.CLAUDE_PLUGIN_OPTION_max_concurrent_subagents = '1';
    await handleSubagentStart(
      {
        session_id: 'session-queue',
        hook_event_name: 'SubagentStart',
        agent_id: 'agent-active',
        agent_type: 'Explore'
      },
      env
    );

    const queuedInput = agentInput('session-queue');
    queuedInput.tool_input.description = 'Urgent auth follow-up';
    queuedInput.tool_input.prompt = 'Investigate the auth failure and preserve this exact queued prompt.';

    const first = await handlePreToolUseAgent(queuedInput, env);
    const second = await handlePreToolUseAgent(queuedInput, env);

    assert.equal(first.stdout.hookSpecificOutput.permissionDecision, 'deny');
    assert.match(first.stdout.hookSpecificOutput.permissionDecisionReason, /queued/i);
    assert.equal(second.stdout.hookSpecificOutput.permissionDecision, 'deny');

    const report = await buildReport('session-queue', env);
    assert.equal(report.state.subagents.denied, 2);
    assert.equal(report.state.subagents.queued, 2);
    assert.equal(report.state.subagents.queue.length, 1);
    assert.equal(report.state.subagents.queue[0].attempts, 2);
    assert.equal(report.state.subagents.queue[0].prompt, queuedInput.tool_input.prompt);
    assert.equal(report.state.subagents.queue[0].description, 'Urgent auth follow-up');
    assert.equal(report.state.subagents.queue[0].priority, 100);
  });
});

test('PreToolUse Agent launches and removes a matching queued subagent when capacity is free', async () => {
  await withTempEnv(async (env) => {
    env.CLAUDE_PLUGIN_OPTION_max_concurrent_subagents = '1';
    await handleSubagentStart(
      {
        session_id: 'session-queue-launch',
        hook_event_name: 'SubagentStart',
        agent_id: 'agent-active',
        agent_type: 'Explore'
      },
      env
    );

    const queuedInput = agentInput('session-queue-launch');
    queuedInput.tool_input.description = 'Queued repo analysis';
    queuedInput.tool_input.prompt = 'Analyze the repository after capacity is free.';
    await handlePreToolUseAgent(queuedInput, env);
    await handleSubagentStop(
      {
        session_id: 'session-queue-launch',
        hook_event_name: 'SubagentStop',
        agent_id: 'agent-active',
        agent_type: 'Explore'
      },
      env
    );

    const result = await handlePreToolUseAgent(queuedInput, env);
    const report = await buildReport('session-queue-launch', env);

    assert.equal(result.stdout, null);
    assert.equal(report.state.subagents.allowed, 1);
    assert.equal(report.state.subagents.queue.length, 0);
    assert.equal(report.state.subagents.queueLaunched, 1);
  });
});

test('PostToolBatch injects highest-priority queued subagent when capacity is available', async () => {
  await withTempEnv(async (env) => {
    env.CLAUDE_PLUGIN_OPTION_max_concurrent_subagents = '1';
    await handleSubagentStart(
      {
        session_id: 'session-queue-context',
        hook_event_name: 'SubagentStart',
        agent_id: 'agent-active',
        agent_type: 'Explore'
      },
      env
    );

    const normalInput = agentInput('session-queue-context');
    normalInput.tool_input.description = 'Routine docs scan';
    normalInput.tool_input.prompt = 'Scan docs later.';
    await handlePreToolUseAgent(normalInput, env);

    const urgentInput = agentInput('session-queue-context');
    urgentInput.tool_input.description = 'Urgent production failure';
    urgentInput.tool_input.prompt = 'Use this full urgent prompt when capacity is available.';
    await handlePreToolUseAgent(urgentInput, env);

    await handleSubagentStop(
      {
        session_id: 'session-queue-context',
        hook_event_name: 'SubagentStop',
        agent_id: 'agent-active',
        agent_type: 'Explore'
      },
      env
    );

    const result = await handlePostToolBatch(
      {
        session_id: 'session-queue-context',
        hook_event_name: 'PostToolBatch'
      },
      env
    );

    assert.equal(result.exitCode, 0);
    assert.match(result.stdout.hookSpecificOutput.additionalContext, /Queued subagent ready to retry/);
    assert.match(result.stdout.hookSpecificOutput.additionalContext, /Urgent production failure/);
    assert.match(result.stdout.hookSpecificOutput.additionalContext, /Use this full urgent prompt/);
    assert.doesNotMatch(result.stdout.hookSpecificOutput.additionalContext, /Routine docs scan/);

    const report = await buildReport('session-queue-context', env);
    assert.equal(report.state.subagents.queue[0].notifyCount, 2);
  });
});

test('SubagentStop immediately surfaces queued work when capacity opens', async () => {
  await withTempEnv(async (env) => {
    env.CLAUDE_PLUGIN_OPTION_max_concurrent_subagents = '1';
    await handleSubagentStart(
      {
        session_id: 'session-queue-stop-notice',
        hook_event_name: 'SubagentStart',
        agent_id: 'agent-active',
        agent_type: 'Explore'
      },
      env
    );

    const queuedInput = agentInput('session-queue-stop-notice');
    queuedInput.tool_input.description = 'Queued reliability review';
    queuedInput.tool_input.prompt = 'Run this reliability review once capacity opens.';
    await handlePreToolUseAgent(queuedInput, env);

    const result = await handleSubagentStop(
      {
        session_id: 'session-queue-stop-notice',
        hook_event_name: 'SubagentStop',
        agent_id: 'agent-active',
        agent_type: 'Explore'
      },
      env
    );

    assert.equal(result.exitCode, 0);
    assert.match(result.stdout.hookSpecificOutput.additionalContext, /Queued subagent ready to retry/);
    assert.match(result.stdout.hookSpecificOutput.additionalContext, /Queued reliability review/);
    assert.match(result.stdout.hookSpecificOutput.additionalContext, /Run this reliability review/);

    const report = await buildReport('session-queue-stop-notice', env);
    assert.equal(report.state.subagents.queue[0].notifyCount, 1);
  });
});

test('PreToolUse Agent preserves queued order when capacity is available', async () => {
  await withTempEnv(async (env) => {
    env.CLAUDE_PLUGIN_OPTION_max_concurrent_subagents = '1';
    await handleSubagentStart(
      {
        session_id: 'session-queue-order',
        hook_event_name: 'SubagentStart',
        agent_id: 'agent-active',
        agent_type: 'Explore'
      },
      env
    );

    const firstQueued = agentInput('session-queue-order');
    firstQueued.tool_input.description = 'Queued database review';
    firstQueued.tool_input.prompt = 'Run queued database review first.';
    await handlePreToolUseAgent(firstQueued, env);

    await handleSubagentStop(
      {
        session_id: 'session-queue-order',
        hook_event_name: 'SubagentStop',
        agent_id: 'agent-active',
        agent_type: 'Explore'
      },
      env
    );

    const laterInput = agentInput('session-queue-order');
    laterInput.tool_use_id = 'toolu_later';
    laterInput.tool_input.description = 'Later docs review';
    laterInput.tool_input.prompt = 'Do not run before queued database review.';

    const result = await handlePreToolUseAgent(laterInput, env);

    assert.equal(result.exitCode, 0);
    assert.equal(result.stdout.hookSpecificOutput.permissionDecision, 'deny');
    assert.match(
      result.stdout.hookSpecificOutput.permissionDecisionReason,
      /Queued subagent pending/
    );
    assert.match(result.stdout.hookSpecificOutput.permissionDecisionReason, /Queued database review/);
    assert.match(result.stdout.hookSpecificOutput.permissionDecisionReason, /Run queued database review first/);
    assert.doesNotMatch(result.stdout.hookSpecificOutput.permissionDecisionReason, /Later docs review/);

    const report = await buildReport('session-queue-order', env);
    assert.equal(report.state.subagents.allowed, 0);
    assert.equal(report.state.subagents.queue.length, 2);
    assert.equal(report.state.subagents.queue[0].description, 'Queued database review');
    assert.equal(report.state.subagents.queue[1].description, 'Later docs review');
  });
});

test('PreToolUse Agent does not enforce queued order when enforcement is disabled', async () => {
  await withTempEnv(async (env) => {
    env.CLAUDE_PLUGIN_OPTION_max_concurrent_subagents = '1';
    await handleSubagentStart(
      {
        session_id: 'session-queue-disabled',
        hook_event_name: 'SubagentStart',
        agent_id: 'agent-active',
        agent_type: 'Explore'
      },
      env
    );

    const queuedInput = agentInput('session-queue-disabled');
    queuedInput.tool_input.description = 'Queued review before disable';
    queuedInput.tool_input.prompt = 'This queue entry should not enforce after disable.';
    await handlePreToolUseAgent(queuedInput, env);

    await handleSubagentStop(
      {
        session_id: 'session-queue-disabled',
        hook_event_name: 'SubagentStop',
        agent_id: 'agent-active',
        agent_type: 'Explore'
      },
      env
    );

    env.CLAUDE_PLUGIN_OPTION_enforcement_enabled = 'false';
    const laterInput = agentInput('session-queue-disabled');
    laterInput.tool_use_id = 'toolu_disabled';
    laterInput.tool_input.description = 'Allowed after disable';
    laterInput.tool_input.prompt = 'Run because enforcement is disabled.';

    const result = await handlePreToolUseAgent(laterInput, env);

    assert.equal(result.exitCode, 0);
    assert.equal(result.stdout, null);

    const report = await buildReport('session-queue-disabled', env);
    assert.equal(report.state.subagents.allowed, 1);
    assert.equal(report.state.subagents.denied, 1);
    assert.equal(report.state.subagents.queue.length, 1);
  });
});

test('PostToolUse Agent clears a matching queued item if completion arrives first', async () => {
  await withTempEnv(async (env) => {
    env.CLAUDE_PLUGIN_OPTION_max_concurrent_subagents = '1';
    await handleSubagentStart(
      {
        session_id: 'session-queue-posttool-clear',
        hook_event_name: 'SubagentStart',
        agent_id: 'agent-active',
        agent_type: 'Explore'
      },
      env
    );

    const queuedInput = agentInput('session-queue-posttool-clear');
    queuedInput.tool_input.description = 'Subagent 2 greeting';
    queuedInput.tool_input.prompt = 'Say exactly: "hello, how are you? I am subagent 2"';
    await handlePreToolUseAgent(queuedInput, env);

    await handlePostToolUseAgent(
      {
        ...queuedInput,
        hook_event_name: 'PostToolUse',
        tool_response: {
          status: 'completed',
          agentId: 'agent-subagent-2',
          totalTokens: 42,
          totalDurationMs: 1000,
          totalToolUseCount: 0
        }
      },
      env
    );

    const report = await buildReport('session-queue-posttool-clear', env);
    assert.equal(report.state.subagents.queue.length, 0);
    assert.equal(report.state.subagents.queueLaunched, 1);
    assert.equal(report.state.subagents.completed, 1);
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

test('formatSubagentView lists spawned subagents with tokens and duration', async () => {
  await withTempEnv(async (env) => {
    await handlePostToolUseAgent(
      {
        session_id: 'session-view',
        hook_event_name: 'PostToolUse',
        tool_name: 'Agent',
        tool_input: { description: 'Alpha analysis', subagent_type: 'Explore' },
        tool_response: {
          status: 'completed',
          agentId: 'agent-alpha',
          resolvedModel: 'claude-sonnet',
          totalTokens: 1234,
          totalToolUseCount: 2,
          totalDurationMs: 1500
        }
      },
      env
    );
    await handlePostToolUseAgent(
      {
        session_id: 'session-view',
        hook_event_name: 'PostToolUse',
        tool_name: 'Agent',
        tool_input: { description: 'Background scrape', subagent_type: 'Research' },
        tool_response: {
          status: 'async_launched',
          agentId: 'agent-bg',
          totalDurationMs: 0
        }
      },
      env
    );

    const report = await buildReport('session-view', env);
    const output = formatSubagentView(report);

    assert.match(output, /Sub-agent view for session-view/);
    assert.match(output, /Spawned subagents: 2/);
    assert.match(output, /Verified tokens: 1,234/);
    assert.match(output, /#1 completed Explore "Alpha analysis"/);
    assert.match(output, /tokens: 1,234 verified/);
    assert.match(output, /duration: 1\.5s/);
    assert.match(output, /model: claude-sonnet/);
    assert.match(output, /#2 async_launched Research "Background scrape"/);
    assert.match(output, /tokens: pending/);
  });
});

test('formatSubagentView lists queued subagents without printing full prompts by default', async () => {
  await withTempEnv(async (env) => {
    env.CLAUDE_PLUGIN_OPTION_max_concurrent_subagents = '1';
    await handleSubagentStart(
      {
        session_id: 'session-view-queue',
        hook_event_name: 'SubagentStart',
        agent_id: 'agent-active',
        agent_type: 'Explore'
      },
      env
    );
    const queuedInput = agentInput('session-view-queue');
    queuedInput.tool_input.description = 'Queued security review';
    queuedInput.tool_input.prompt = 'SECRET FULL PROMPT SHOULD NOT PRINT IN TEXT VIEW';
    await handlePreToolUseAgent(queuedInput, env);

    const output = formatSubagentView(await buildReport('session-view-queue', env));

    assert.match(output, /Queued subagents: 1/);
    assert.match(output, /Queued security review/);
    assert.match(output, /priority: 50/);
    assert.doesNotMatch(output, /SECRET FULL PROMPT/);
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

test('UserPromptSubmit allows normal prompts when subagent token cap is reached', async () => {
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

    assert.equal(result.exitCode, 0);
    assert.equal(result.stdout, null);
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
            'subagent-cap@subagent-tools': {
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
        settings.pluginConfigs['subagent-cap@subagent-tools'].options;

      assert.deepEqual(options, {
        max_concurrent_subagents: 1,
        max_subagent_tokens_per_session: 500000,
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
    assert.ok(
      result.checks.some(
        (check) =>
          check.name === 'simulated-statusline-budget-blocks' &&
          check.detail.startsWith('simulated check only:')
      )
    );
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
          'subagent-cap@subagent-tools': {
            options: {
              max_concurrent_subagents: 1,
              max_subagent_tokens_per_session: 500000,
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
      settings.pluginConfigs['subagent-cap@subagent-tools'].options;

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

test('subagent-cap init writes short plugin config id', async () => {
  const homeDir = await mkdtemp(path.join(tmpdir(), 'sbg-home-'));
  const dataDir = await mkdtemp(path.join(tmpdir(), 'sbg-data-'));
  try {
    const claudeDir = path.join(homeDir, '.claude');
    await mkdir(claudeDir, { recursive: true });
    await writeFile(
      path.join(claudeDir, 'settings.json'),
      JSON.stringify({
        pluginConfigs: {}
      })
    );

    await execFileAsync(
      process.execPath,
      [
        path.resolve('plugins/subagent-budget-guard/bin/subagent-cap.js'),
        'init',
        '--defaults'
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
    assert.ok(settings.pluginConfigs['subagent-cap@subagent-tools']);
    assert.equal(
      settings.pluginConfigs['subagent-cap@subagent-tools'].options.max_concurrent_subagents,
      1
    );
    assert.equal(
      settings.pluginConfigs['subagent-cap@subagent-tools'].options
        .max_subagent_tokens_per_session,
      500000
    );
  } finally {
    await rm(homeDir, { recursive: true, force: true });
    await rm(dataDir, { recursive: true, force: true });
  }
});

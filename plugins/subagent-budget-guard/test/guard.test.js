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
  SETUP_CONFIG,
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
  assert.equal(config.enforcement_mode, 'subagent_only');
  assert.equal(config.enforcement_enabled, true);
});

test('recommended setup defaults use two subagents and tighter budget thresholds', () => {
  assert.equal(SETUP_CONFIG.max_concurrent_subagents, 2);
  assert.equal(SETUP_CONFIG.max_subagent_tokens_per_session, 500000);
  assert.equal(SETUP_CONFIG.subagent_token_warning_threshold_percent, 80);
  assert.equal(SETUP_CONFIG.session_five_hour_budget_percent, 10);
  assert.equal(SETUP_CONFIG.absolute_five_hour_ceiling_percent, 90);
  assert.equal(SETUP_CONFIG.enforcement_mode, 'subagent_only');
  assert.equal(SETUP_CONFIG.enforcement_enabled, true);
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

test('release metadata is bumped for scoped enforcement mode', async () => {
  const expectedVersion = '0.5.13';
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
  assert.match(text, /Balanced/);
  assert.match(text, /Strict/);
  assert.match(text, /Observe Only/);
  assert.match(text, /Verified session token cap/);
  assert.match(text, /not an individual running subagent limit/i);
  assert.match(text, /Do not add more slash commands/i);

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
              enforcement_mode: 'session-budget',
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
    assert.equal(config.enforcement_mode, 'session_budget');
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

test('PreToolUse Agent blocks on five-hour budget in subagent-only mode', async () => {
  await withTempEnv(async (env) => {
    env.CLAUDE_PLUGIN_OPTION_max_concurrent_subagents = '1';
    env.CLAUDE_PLUGIN_OPTION_session_five_hour_budget_percent = '5';

    await updateRateLimitFromStatusLine(
      {
        session_id: 'session-agent-budget-default',
        rate_limits: { five_hour: { used_percentage: 40, resets_at: 2000 } }
      },
      env
    );
    await updateRateLimitFromStatusLine(
      {
        session_id: 'session-agent-budget-default',
        rate_limits: { five_hour: { used_percentage: 46.5, resets_at: 2000 } }
      },
      env
    );

    const result = await handlePreToolUseAgent(
      agentInput('session-agent-budget-default'),
      env
    );

    assert.equal(result.stdout.hookSpecificOutput.permissionDecision, 'deny');
    assert.match(
      result.stdout.hookSpecificOutput.permissionDecisionReason,
      /5-hour budget exhausted/
    );
  });
});

test('PreToolUse Agent records without blocking in observe mode', async () => {
  await withTempEnv(async (env) => {
    env.CLAUDE_PLUGIN_OPTION_enforcement_mode = 'observe';

    const result = await handlePreToolUseAgent(agentInput('session-observe'), env);
    const report = await buildReport('session-observe', env);

    assert.equal(result.exitCode, 0);
    assert.equal(result.stdout, null);
    assert.equal(report.state.subagents.requested, 1);
    assert.equal(report.state.subagents.allowed, 1);
    assert.equal(report.state.subagents.denied, 0);
    assert.equal(report.state.subagents.launching, 0);
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
    assert.match(first.stdout.hookSpecificOutput.permissionDecisionReason, /saved to queue/i);
    assert.match(first.stdout.hookSpecificOutput.permissionDecisionReason, /queue notice/i);
    assert.doesNotMatch(
      first.stdout.hookSpecificOutput.permissionDecisionReason,
      /retry|automatically/i
    );
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

test('PreToolUse Agent reserves capacity until SubagentStart records lifecycle', async () => {
  await withTempEnv(async (env) => {
    env.CLAUDE_PLUGIN_OPTION_max_concurrent_subagents = '1';

    const firstInput = agentInput('session-launch-reservation');
    firstInput.tool_input.description = 'Subagent 1 greeting';
    firstInput.tool_input.prompt = 'Say exactly: "hello, i am subagent 1"';

    const accepted = await handlePreToolUseAgent(firstInput, env);
    const duplicate = await handlePreToolUseAgent(firstInput, env);

    const secondInput = agentInput('session-launch-reservation');
    secondInput.tool_use_id = 'toolu_second';
    secondInput.tool_input.description = 'Subagent 2 greeting';
    secondInput.tool_input.prompt = 'Say exactly: "hello, i am subagent 2"';
    const queued = await handlePreToolUseAgent(secondInput, env);

    assert.equal(accepted.exitCode, 0);
    assert.equal(accepted.stdout, null);
    assert.equal(duplicate.stdout.hookSpecificOutput.permissionDecision, 'deny');
    assert.match(
      duplicate.stdout.hookSpecificOutput.permissionDecisionReason,
      /already accepted/i
    );
    assert.doesNotMatch(
      duplicate.stdout.hookSpecificOutput.permissionDecisionReason,
      /retry|automatically|queue id/i
    );
    assert.equal(queued.stdout.hookSpecificOutput.permissionDecision, 'deny');
    assert.match(queued.stdout.hookSpecificOutput.permissionDecisionReason, /saved to queue/i);
    assert.match(queued.stdout.hookSpecificOutput.permissionDecisionReason, /queue notice/i);
    assert.doesNotMatch(
      queued.stdout.hookSpecificOutput.permissionDecisionReason,
      /retry|automatically/i
    );

    let report = await buildReport('session-launch-reservation', env);
    assert.equal(report.state.subagents.allowed, 1);
    assert.equal(report.state.subagents.denied, 2);
    assert.equal(report.state.subagents.active, 0);
    assert.equal(report.state.subagents.launching, 1);
    assert.equal(report.state.subagents.launchReservations.length, 1);
    assert.equal(report.state.subagents.queue.length, 1);
    assert.equal(report.state.subagents.queue[0].description, 'Subagent 2 greeting');

    await handleSubagentStart(
      {
        session_id: 'session-launch-reservation',
        hook_event_name: 'SubagentStart',
        agent_id: 'agent-subagent-1',
        agent_type: 'Explore'
      },
      env
    );

    report = await buildReport('session-launch-reservation', env);
    assert.equal(report.state.subagents.launching, 0);
    assert.equal(report.state.subagents.launchReservations.length, 0);
    assert.equal(report.state.subagents.active, 1);
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

    const statePath = path.join(
      env.CLAUDE_PLUGIN_DATA,
      'sessions',
      'session-queue-context.json'
    );
    const state = JSON.parse(await readFile(statePath, 'utf8'));
    for (const item of state.subagents.queue) {
      item.status = 'queued';
      item.notifyCount = 0;
      item.lastNotifiedAt = null;
      item.lastNotifiedWindow = null;
      item.dispatchLeaseId = null;
      item.dispatchLeaseAt = null;
      item.dispatchHookEventName = null;
    }
    state.subagents.queueNotices = 0;
    await writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`);

    const result = await handlePostToolBatch(
      {
        session_id: 'session-queue-context',
        hook_event_name: 'PostToolBatch'
      },
      env
    );

    assert.equal(result.exitCode, 0);
    assert.match(result.stdout.hookSpecificOutput.additionalContext, /Queued subagent ready to launch/);
    assert.match(result.stdout.hookSpecificOutput.additionalContext, /Urgent production failure/);
    assert.match(result.stdout.hookSpecificOutput.additionalContext, /Use this full urgent prompt/);
    assert.match(result.stdout.hookSpecificOutput.additionalContext, /Call the Agent tool/i);
    assert.match(result.stdout.hookSpecificOutput.additionalContext, /Do not answer/i);
    assert.doesNotMatch(result.stdout.hookSpecificOutput.additionalContext, /retry|automatically/i);
    assert.doesNotMatch(result.stdout.hookSpecificOutput.additionalContext, /Routine docs scan/);

    const report = await buildReport('session-queue-context', env);
    assert.equal(report.state.subagents.queue[0].notifyCount, 1);
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
    assert.match(result.stdout.hookSpecificOutput.additionalContext, /Queued subagent ready to launch/);
    assert.match(result.stdout.hookSpecificOutput.additionalContext, /Queued reliability review/);
    assert.match(result.stdout.hookSpecificOutput.additionalContext, /Run this reliability review/);
    assert.match(result.stdout.hookSpecificOutput.additionalContext, /Call the Agent tool/i);
    assert.match(result.stdout.hookSpecificOutput.additionalContext, /Do not answer/i);
    assert.doesNotMatch(result.stdout.hookSpecificOutput.additionalContext, /retry|automatically/i);

    const report = await buildReport('session-queue-stop-notice', env);
    assert.equal(report.state.subagents.queue[0].notifyCount, 1);
  });
});

test('PostToolBatch does not repeat a queued prompt after SubagentStop already suggested it', async () => {
  await withTempEnv(async (env) => {
    env.CLAUDE_PLUGIN_OPTION_max_concurrent_subagents = '1';
    await handleSubagentStart(
      {
        session_id: 'session-queue-single-notice',
        hook_event_name: 'SubagentStart',
        agent_id: 'agent-active',
        agent_type: 'Explore'
      },
      env
    );

    const queuedInput = agentInput('session-queue-single-notice');
    queuedInput.tool_input.description = 'Subagent 2 greeting';
    queuedInput.tool_input.prompt = 'Say exactly: "hello, how are you? I am subagent 2"';
    await handlePreToolUseAgent(queuedInput, env);

    const firstNotice = await handleSubagentStop(
      {
        session_id: 'session-queue-single-notice',
        hook_event_name: 'SubagentStop',
        agent_id: 'agent-active',
        agent_type: 'Explore'
      },
      env
    );
    const duplicateNotice = await handlePostToolBatch(
      {
        session_id: 'session-queue-single-notice',
        hook_event_name: 'PostToolBatch'
      },
      env
    );

    assert.match(firstNotice.stdout.hookSpecificOutput.additionalContext, /Subagent 2 greeting/);
    assert.equal(duplicateNotice.exitCode, 0);
    assert.equal(duplicateNotice.stdout, null);

    const report = await buildReport('session-queue-single-notice', env);
    assert.equal(report.state.subagents.queue[0].notifyCount, 1);
  });
});

test('Queue notice leases exactly one queued agent until that agent launches', async () => {
  await withTempEnv(async (env) => {
    env.CLAUDE_PLUGIN_OPTION_max_concurrent_subagents = '1';
    await handleSubagentStart(
      {
        session_id: 'session-queue-dispatch-lease',
        hook_event_name: 'SubagentStart',
        agent_id: 'agent-active',
        agent_type: 'Explore'
      },
      env
    );

    const firstQueued = agentInput('session-queue-dispatch-lease');
    firstQueued.tool_input.description = 'Subagent 3 greeting';
    firstQueued.tool_input.prompt = 'Say exactly: "hello, i am subagent 3"';
    await handlePreToolUseAgent(firstQueued, env);

    const secondQueued = agentInput('session-queue-dispatch-lease');
    secondQueued.tool_use_id = 'toolu_second_queued';
    secondQueued.tool_input.description = 'Subagent 4 greeting';
    secondQueued.tool_input.prompt = 'Say exactly: "hello, i am subagent 4"';
    await handlePreToolUseAgent(secondQueued, env);

    const firstNotice = await handleSubagentStop(
      {
        session_id: 'session-queue-dispatch-lease',
        hook_event_name: 'SubagentStop',
        agent_id: 'agent-active',
        agent_type: 'Explore'
      },
      env
    );
    const repeatedPromptNotice = await handleUserPromptSubmit(
      {
        session_id: 'session-queue-dispatch-lease',
        hook_event_name: 'UserPromptSubmit',
        prompt: 'continue'
      },
      env
    );
    const repeatedBatchNotice = await handlePostToolBatch(
      {
        session_id: 'session-queue-dispatch-lease',
        hook_event_name: 'PostToolBatch'
      },
      env
    );
    const wrongQueuedLaunch = await handlePreToolUseAgent(secondQueued, env);

    assert.match(
      firstNotice.stdout.hookSpecificOutput.additionalContext,
      /^SUBAGENT_QUEUE_DISPATCH/m
    );
    assert.doesNotMatch(
      firstNotice.stdout.hookSpecificOutput.additionalContext,
      /\b(retry|automatically|background|I will|I'll|share the result)\b/i
    );
    assert.equal(repeatedPromptNotice.stdout, null);
    assert.equal(repeatedBatchNotice.stdout, null);
    assert.equal(wrongQueuedLaunch.stdout.hookSpecificOutput.permissionDecision, 'deny');
    assert.match(
      wrongQueuedLaunch.stdout.hookSpecificOutput.permissionDecisionReason,
      /queued dispatch in progress/i
    );
    assert.doesNotMatch(
      wrongQueuedLaunch.stdout.hookSpecificOutput.permissionDecisionReason,
      /hello, i am subagent 3|hello, i am subagent 4|retry|automatically/i
    );

    let report = await buildReport('session-queue-dispatch-lease', env);
    assert.equal(report.state.subagents.queue.length, 2);
    assert.equal(report.state.subagents.queue[0].description, 'Subagent 3 greeting');
    assert.equal(report.state.subagents.queue[0].status, 'dispatching');
    assert.ok(report.state.subagents.queue[0].dispatchLeaseId);
    assert.equal(report.state.subagents.queue[0].notifyCount, 1);
    assert.equal(report.state.subagents.queue[1].status, 'queued');

    const correctQueuedLaunch = await handlePreToolUseAgent(firstQueued, env);
    report = await buildReport('session-queue-dispatch-lease', env);

    assert.equal(correctQueuedLaunch.stdout, null);
    assert.equal(report.state.subagents.queue.length, 1);
    assert.equal(report.state.subagents.queue[0].description, 'Subagent 4 greeting');
    assert.equal(report.state.subagents.queue[0].status, 'queued');
    assert.equal(report.state.subagents.queueLaunched, 1);
    assert.equal(report.state.subagents.launching, 1);
  });
});

test('Five queued subagents dispatch one at a time without repeated queue prompts', async () => {
  await withTempEnv(async (env) => {
    env.CLAUDE_PLUGIN_OPTION_max_concurrent_subagents = '1';
    const sessionId = 'session-five-subagent-queue';
    const inputs = Array.from({ length: 5 }, (_, index) => {
      const number = index + 1;
      const input = agentInput(sessionId);
      input.tool_use_id = `toolu_subagent_${number}`;
      input.tool_input.description = `Subagent ${number}`;
      input.tool_input.prompt = `Say exactly: "hello, i am subagent ${number}"`;
      return input;
    });

    const firstLaunch = await handlePreToolUseAgent(inputs[0], env);
    await handleSubagentStart(
      {
        session_id: sessionId,
        hook_event_name: 'SubagentStart',
        agent_id: 'agent-1',
        agent_type: 'Explore'
      },
      env
    );
    for (const input of inputs.slice(1)) {
      const queued = await handlePreToolUseAgent(input, env);
      assert.equal(queued.stdout.hookSpecificOutput.permissionDecision, 'deny');
      assert.match(queued.stdout.hookSpecificOutput.permissionDecisionReason, /saved to queue/i);
      assert.doesNotMatch(
        queued.stdout.hookSpecificOutput.permissionDecisionReason,
        /retry|automatically|hello, i am subagent/i
      );
    }

    assert.equal(firstLaunch.stdout, null);

    for (let nextIndex = 1; nextIndex < inputs.length; nextIndex += 1) {
      const nextNumber = nextIndex + 1;
      const notice = await handleSubagentStop(
        {
          session_id: sessionId,
          hook_event_name: 'SubagentStop',
          agent_id: `agent-${nextIndex}`,
          agent_type: 'Explore'
        },
        env
      );
      const context = notice.stdout.hookSpecificOutput.additionalContext;

      assert.match(context, /^SUBAGENT_QUEUE_DISPATCH/m);
      assert.match(context, new RegExp(`Subagent ${nextNumber}`));
      assert.match(context, new RegExp(`hello, i am subagent ${nextNumber}`));
      assert.doesNotMatch(context, /\b(retry|automatically|background|I will|I'll)\b/i);

      const repeatedByPrompt = await handleUserPromptSubmit(
        {
          session_id: sessionId,
          hook_event_name: 'UserPromptSubmit',
          prompt: 'continue'
        },
        env
      );
      const repeatedByBatch = await handlePostToolBatch(
        {
          session_id: sessionId,
          hook_event_name: 'PostToolBatch'
        },
        env
      );
      assert.equal(repeatedByPrompt.stdout, null);
      assert.equal(repeatedByBatch.stdout, null);

      if (nextIndex + 1 < inputs.length) {
        const wrongLaunch = await handlePreToolUseAgent(inputs[nextIndex + 1], env);
        assert.equal(wrongLaunch.stdout.hookSpecificOutput.permissionDecision, 'deny');
        assert.match(
          wrongLaunch.stdout.hookSpecificOutput.permissionDecisionReason,
          /queued dispatch in progress/i
        );
      }

      const accepted = await handlePreToolUseAgent(inputs[nextIndex], env);
      assert.equal(accepted.stdout, null);
      await handleSubagentStart(
        {
          session_id: sessionId,
          hook_event_name: 'SubagentStart',
          agent_id: `agent-${nextNumber}`,
          agent_type: 'Explore'
        },
        env
      );
    }

    const report = await buildReport(sessionId, env);
    assert.equal(report.state.subagents.allowed, 5);
    assert.equal(report.state.subagents.queue.length, 0);
    assert.equal(report.state.subagents.queueLaunched, 4);
    assert.equal(report.state.subagents.queueNotices, 4);
    assert.equal(report.state.subagents.active, 1);
    assert.equal(report.state.subagents.launching, 0);
  });
});

test('UserPromptSubmit does not repeat leased queued work on normal or continue prompts', async () => {
  await withTempEnv(async (env) => {
    env.CLAUDE_PLUGIN_OPTION_max_concurrent_subagents = '1';
    await handleSubagentStart(
      {
        session_id: 'session-queue-user-repeat',
        hook_event_name: 'SubagentStart',
        agent_id: 'agent-active',
        agent_type: 'Explore'
      },
      env
    );

    const queuedInput = agentInput('session-queue-user-repeat');
    queuedInput.tool_input.description = 'Subagent 3 greeting';
    queuedInput.tool_input.prompt = 'Say exactly: "hello, how are you? I am subagent 3"';
    await handlePreToolUseAgent(queuedInput, env);
    await handleSubagentStop(
      {
        session_id: 'session-queue-user-repeat',
        hook_event_name: 'SubagentStop',
        agent_id: 'agent-active',
        agent_type: 'Explore'
      },
      env
    );

    const unrelatedPrompt = await handleUserPromptSubmit(
      {
        session_id: 'session-queue-user-repeat',
        hook_event_name: 'UserPromptSubmit',
        prompt: 'what is going on?'
      },
      env
    );
    const continuePrompt = await handleUserPromptSubmit(
      {
        session_id: 'session-queue-user-repeat',
        hook_event_name: 'UserPromptSubmit',
        prompt: 'continue'
      },
      env
    );

    assert.equal(unrelatedPrompt.exitCode, 0);
    assert.equal(unrelatedPrompt.stdout, null);
    assert.equal(continuePrompt.exitCode, 0);
    assert.equal(continuePrompt.stdout, null);

    const report = await buildReport('session-queue-user-repeat', env);
    assert.equal(report.state.subagents.queue[0].notifyCount, 1);
    assert.equal(report.state.subagents.queue[0].status, 'dispatching');
  });
});

test('UserPromptSubmit does not initiate queued work when capacity is available', async () => {
  await withTempEnv(async (env) => {
    env.CLAUDE_PLUGIN_OPTION_max_concurrent_subagents = '1';
    const sessionId = 'session-queue-user-no-init';
    const firstInput = agentInput(sessionId);
    firstInput.tool_use_id = 'toolu_first_user_no_init';
    firstInput.tool_input.description = 'Subagent 1 greeting';
    const queuedInput = agentInput(sessionId);
    queuedInput.tool_use_id = 'toolu_queued_user_no_init';
    queuedInput.tool_input.description = 'Subagent 2 greeting';
    queuedInput.tool_input.prompt = 'Say exactly: "hello, i am subagent 2"';

    const firstLaunch = await handlePreToolUseAgent(firstInput, env);
    const queued = await handlePreToolUseAgent(queuedInput, env);
    await handlePostToolUseAgent(
      {
        session_id: sessionId,
        hook_event_name: 'PostToolUse',
        tool_name: 'Agent',
        tool_input: firstInput.tool_input,
        tool_response: {
          status: 'completed',
          agentId: 'agent-user-no-init-1',
          totalTokens: 10,
          totalDurationMs: 100
        }
      },
      env
    );

    const promptResult = await handleUserPromptSubmit(
      {
        session_id: sessionId,
        hook_event_name: 'UserPromptSubmit',
        prompt: 'continue'
      },
      env
    );
    const batchResult = await handlePostToolBatch(
      {
        session_id: sessionId,
        hook_event_name: 'PostToolBatch'
      },
      env
    );

    assert.equal(firstLaunch.stdout, null);
    assert.equal(queued.stdout.hookSpecificOutput.permissionDecision, 'deny');
    assert.equal(promptResult.exitCode, 0);
    assert.equal(promptResult.stdout, null);
    assert.match(
      batchResult.stdout.hookSpecificOutput.additionalContext,
      /^SUBAGENT_QUEUE_DISPATCH/m
    );
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
      /Queued dispatch in progress/
    );
    assert.match(result.stdout.hookSpecificOutput.permissionDecisionReason, /Queued database review/);
    assert.doesNotMatch(
      result.stdout.hookSpecificOutput.permissionDecisionReason,
      /Run queued database review first/
    );
    assert.doesNotMatch(
      result.stdout.hookSpecificOutput.permissionDecisionReason,
      /retry|automatically/i
    );
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

test('formatSubagentView explains when no tracked session files exist yet', async () => {
  await withTempEnv(async (env) => {
    const report = await buildReport(null, env);
    const output = formatSubagentView(report);

    assert.match(output, /Tracking status: no saved session files found/i);
    assert.match(output, /Subagent run data comes from Agent hooks/i);
    assert.match(output, /If you just ran init or updated the plugin in this Claude Code session, restart Claude Code/i);
    assert.match(output, /Configured concurrency: 0/i);
    assert.match(output, /5-hour bridge: not observed yet/i);
    assert.doesNotMatch(output, /status line bridge wasn't initialized with a fresh session/i);
    assert.doesNotMatch(output, /This is expected since/i);
  });
});

test('formatSubagentView explains empty tracked session without blaming statusLine setup', async () => {
  await withTempEnv(async (env) => {
    await updateRateLimitFromStatusLine(
      {
        session_id: 'session-empty-view',
        rate_limits: { five_hour: { used_percentage: 12, resets_at: 2000 } }
      },
      env
    );

    const report = await buildReport('session-empty-view', env);
    const output = formatSubagentView(report);

    assert.match(output, /Tracking status: session file exists, but no Agent hook events were recorded/i);
    assert.match(output, /5-hour bridge: observed/i);
    assert.match(output, /Run at least one subagent after the plugin is loaded/i);
    assert.doesNotMatch(output, /status line bridge wasn't initialized with a fresh session/i);
    assert.doesNotMatch(output, /fully exit and reopen.*send one message/i);
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

test('UserPromptSubmit allows normal prompts by default when five-hour budget is exhausted', async () => {
  await withTempEnv(async (env) => {
    env.CLAUDE_PLUGIN_OPTION_session_five_hour_budget_percent = '5';

    await updateRateLimitFromStatusLine(
      {
        session_id: 'session-budget-default-pass',
        rate_limits: { five_hour: { used_percentage: 40, resets_at: 2000 } }
      },
      env
    );
    await updateRateLimitFromStatusLine(
      {
        session_id: 'session-budget-default-pass',
        rate_limits: { five_hour: { used_percentage: 46.5, resets_at: 2000 } }
      },
      env
    );

    const result = await handleUserPromptSubmit(
      {
        session_id: 'session-budget-default-pass',
        hook_event_name: 'UserPromptSubmit',
        prompt: 'continue with normal work'
      },
      env
    );

    assert.equal(result.exitCode, 0);
    assert.equal(result.stdout, null);
    assert.equal(result.stderr, '');
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

test('UserPromptSubmit blocks when five-hour session budget mode is opted in and exhausted', async () => {
  await withTempEnv(async (env) => {
    env.CLAUDE_PLUGIN_OPTION_enforcement_mode = 'session_budget';
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

test('TaskCreated records tasks by default when five-hour budget is exhausted', async () => {
  await withTempEnv(async (env) => {
    env.CLAUDE_PLUGIN_OPTION_session_five_hour_budget_percent = '5';

    await updateRateLimitFromStatusLine(
      {
        session_id: 'session-task-budget-default-pass',
        rate_limits: { five_hour: { used_percentage: 40, resets_at: 2000 } }
      },
      env
    );
    await updateRateLimitFromStatusLine(
      {
        session_id: 'session-task-budget-default-pass',
        rate_limits: { five_hour: { used_percentage: 46.5, resets_at: 2000 } }
      },
      env
    );

    const result = await handleTaskCreated(
      {
        session_id: 'session-task-budget-default-pass',
        hook_event_name: 'TaskCreated',
        task_id: 'task-budget-default',
        task_subject: 'Normal work'
      },
      env
    );

    assert.equal(result.exitCode, 0);
    assert.equal(result.stderr, '');
    const report = await buildReport('session-task-budget-default-pass', env);
    assert.equal(report.state.agentTeam.created, 1);
    assert.equal(report.state.agentTeam.denied, 0);
  });
});

test('TaskCreated blocks when five-hour session budget mode is opted in and exhausted', async () => {
  await withTempEnv(async (env) => {
    env.CLAUDE_PLUGIN_OPTION_enforcement_mode = 'session_budget';
    env.CLAUDE_PLUGIN_OPTION_session_five_hour_budget_percent = '5';

    await updateRateLimitFromStatusLine(
      {
        session_id: 'session-task-budget-session-block',
        rate_limits: { five_hour: { used_percentage: 40, resets_at: 2000 } }
      },
      env
    );
    await updateRateLimitFromStatusLine(
      {
        session_id: 'session-task-budget-session-block',
        rate_limits: { five_hour: { used_percentage: 46.5, resets_at: 2000 } }
      },
      env
    );

    const result = await handleTaskCreated(
      {
        session_id: 'session-task-budget-session-block',
        hook_event_name: 'TaskCreated',
        task_id: 'task-budget-session',
        task_subject: 'Session-budget work'
      },
      env
    );

    assert.equal(result.exitCode, 2);
    assert.match(result.stderr, /5-hour budget exhausted/);
    const report = await buildReport('session-task-budget-session-block', env);
    assert.equal(report.state.agentTeam.created, 0);
    assert.equal(report.state.agentTeam.denied, 1);
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
        max_concurrent_subagents: 2,
        max_subagent_tokens_per_session: 500000,
        subagent_token_warning_threshold_percent: 80,
        session_five_hour_budget_percent: 10,
        absolute_five_hour_ceiling_percent: 90,
        enforcement_mode: 'subagent_only',
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
          check.name === 'simulated-statusline-budget-default-passthrough' &&
          check.detail.startsWith('default mode allowed prompt:')
      )
    );
    assert.ok(
      result.checks.some(
        (check) =>
          check.name === 'simulated-statusline-budget-session-mode-blocks' &&
          check.detail.startsWith('session_budget check only:')
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
        'enforcement_mode=session_budget',
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
    assert.equal(options.enforcement_mode, 'session_budget');
    assert.equal(options.enforcement_enabled, false);
  } finally {
    await rm(homeDir, { recursive: true, force: true });
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('setup CLI applies friendly preset choices', async () => {
  const homeDir = await mkdtemp(path.join(tmpdir(), 'sbg-home-'));
  const dataDir = await mkdtemp(path.join(tmpdir(), 'sbg-data-'));
  try {
    const { stdout } = await execFileAsync(
      process.execPath,
      [
        path.resolve('plugins/subagent-budget-guard/bin/setup.js'),
        '--preset',
        'strict'
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

    assert.equal(options.max_concurrent_subagents, 1);
    assert.equal(options.max_subagent_tokens_per_session, 250000);
    assert.equal(options.subagent_token_warning_threshold_percent, 70);
    assert.equal(options.session_five_hour_budget_percent, 5);
    assert.equal(options.absolute_five_hour_ceiling_percent, 85);
    assert.equal(options.enforcement_mode, 'subagent_only');
    assert.equal(options.enforcement_enabled, true);
    assert.match(stdout, /Preset: Strict/);
    assert.match(stdout, /Subagents at once: 1/);
    assert.match(stdout, /Verified session token cap: 250,000/);
  } finally {
    await rm(homeDir, { recursive: true, force: true });
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('setup CLI friendly set aliases preserve existing settings', async () => {
  const homeDir = await mkdtemp(path.join(tmpdir(), 'sbg-home-'));
  const dataDir = await mkdtemp(path.join(tmpdir(), 'sbg-data-'));
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
              max_subagent_tokens_per_session: 750000,
              subagent_token_warning_threshold_percent: 80,
              session_five_hour_budget_percent: 10,
              absolute_five_hour_ceiling_percent: 90,
              enforcement_mode: 'subagent_only',
              enforcement_enabled: true
            }
          }
        }
      })
    );

    const { stdout } = await execFileAsync(
      process.execPath,
      [
        path.resolve('plugins/subagent-budget-guard/bin/setup.js'),
        '--set',
        'agents=3',
        '--set',
        'session-token-cap=800000',
        '--set',
        'warn-at=75',
        '--set',
        'mode=observe'
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
    assert.equal(options.max_subagent_tokens_per_session, 800000);
    assert.equal(options.subagent_token_warning_threshold_percent, 75);
    assert.equal(options.session_five_hour_budget_percent, 10);
    assert.equal(options.absolute_five_hour_ceiling_percent, 90);
    assert.equal(options.enforcement_mode, 'observe');
    assert.equal(options.enforcement_enabled, true);
    assert.match(stdout, /Preset: Current settings/);
    assert.match(stdout, /Subagents at once: 3/);
    assert.match(stdout, /Verified session token cap: 800,000/);
    assert.match(stdout, /Warning at: 75%/);
    assert.doesNotMatch(stdout, /max_concurrent_subagents=/);
  } finally {
    await rm(homeDir, { recursive: true, force: true });
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('setup CLI rejects individual token-limit alias', async () => {
  const homeDir = await mkdtemp(path.join(tmpdir(), 'sbg-home-'));
  const dataDir = await mkdtemp(path.join(tmpdir(), 'sbg-data-'));
  try {
    await assert.rejects(
      execFileAsync(
        process.execPath,
        [
          path.resolve('plugins/subagent-budget-guard/bin/setup.js'),
          '--set',
          'token-limit=500000'
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
      ),
      /Unknown setting "token-limit"/
    );
  } finally {
    await rm(homeDir, { recursive: true, force: true });
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('setup CLI rejects unknown friendly setting names', async () => {
  const homeDir = await mkdtemp(path.join(tmpdir(), 'sbg-home-'));
  const dataDir = await mkdtemp(path.join(tmpdir(), 'sbg-data-'));
  try {
    await assert.rejects(
      execFileAsync(
        process.execPath,
        [
          path.resolve('plugins/subagent-budget-guard/bin/setup.js'),
          '--set',
          'subagent-speed=fast'
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
      ),
      /Unknown setting "subagent-speed"/
    );
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
      2
    );
    assert.equal(
      settings.pluginConfigs['subagent-cap@subagent-tools'].options
        .max_subagent_tokens_per_session,
      500000
    );
    assert.equal(
      settings.pluginConfigs['subagent-cap@subagent-tools'].options
        .subagent_token_warning_threshold_percent,
      80
    );
    assert.equal(
      settings.pluginConfigs['subagent-cap@subagent-tools'].options
        .session_five_hour_budget_percent,
      10
    );
    assert.equal(
      settings.pluginConfigs['subagent-cap@subagent-tools'].options
        .absolute_five_hour_ceiling_percent,
      90
    );
  } finally {
    await rm(homeDir, { recursive: true, force: true });
    await rm(dataDir, { recursive: true, force: true });
  }
});

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
  handlePostToolUseFailureAgent,
  handlePostToolUseAgent,
  handlePreToolUseAgent,
  handleStop,
  handleSubagentStart,
  handleSubagentStop,
  handleUserPromptSubmit,
  installStatusLineBridge,
  loadConfig,
  renderStatusLine,
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
  const homeDir = await mkdtemp(path.join(tmpdir(), 'sbg-home-'));
  const env = {
    USERPROFILE: homeDir,
    HOME: homeDir,
    CLAUDE_PLUGIN_DATA: dir,
    CLAUDE_PLUGIN_ROOT: path.resolve('plugins/subagent-budget-guard')
  };

  try {
    return await fn(env, dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
    await rm(homeDir, { recursive: true, force: true });
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
  assert.equal(SETUP_CONFIG.five_hour_warning_threshold_percent, 75);
  assert.equal(SETUP_CONFIG.session_five_hour_budget_percent, 10);
  assert.equal(SETUP_CONFIG.absolute_five_hour_ceiling_percent, 85);
  assert.equal(SETUP_CONFIG.enforcement_mode, 'subagent_only');
  assert.equal(SETUP_CONFIG.enforcement_enabled, true);
});

test('plugin manifest omits userConfig so install does not ask for config flags', async () => {
  const manifestPath = path.resolve('plugins/subagent-budget-guard/.claude-plugin/plugin.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));

  assert.equal(manifest.name, 'subagent-cap');
  assert.equal(manifest.userConfig, undefined);
});

test('hooks match both Agent and Task subagent tool events', async () => {
  const hooksPath = path.resolve('plugins/subagent-budget-guard/hooks/hooks.json');
  const hooks = JSON.parse(await readFile(hooksPath, 'utf8')).hooks;
  const hookEvents = Object.keys(hooks).sort();
  const preToolMatchers = hooks.PreToolUse.map((entry) => entry.matcher).sort();
  const postToolMatchers = hooks.PostToolUse.map((entry) => entry.matcher).sort();
  const failureMatchers = hooks.PostToolUseFailure.map((entry) => entry.matcher).sort();

  assert.deepEqual(hookEvents, [
    'PostToolBatch',
    'PostToolUse',
    'PostToolUseFailure',
    'PreToolUse',
    'Stop',
    'SubagentStart',
    'SubagentStop',
    'UserPromptSubmit'
  ]);
  assert.deepEqual(preToolMatchers, ['Agent', 'Task']);
  assert.deepEqual(postToolMatchers, ['Agent', 'Task']);
  assert.deepEqual(failureMatchers, ['Agent', 'Task']);

  for (const entries of Object.values(hooks)) {
    for (const entry of entries) {
      for (const hook of entry.hooks) {
        assert.equal('statusMessage' in hook, false);
      }
    }
  }
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

test('release metadata is bumped consistently', async () => {
  const expectedVersion = '0.5.27';
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
  assert.match(text, /Only offer settings that map to behavior the hooks can actually enforce/i);
  assert.match(text, /post-completion reporting or omit it/i);
  assert.match(text, /node "\$\{CLAUDE_PLUGIN_ROOT\}\/bin\/setup\.js"/);
  assert.doesNotMatch(text, /bin\/subagent-cap\.js/);

  const commandPath = path.resolve('plugins/subagent-budget-guard/commands/sub-agent-view.md');
  const command = await readFile(commandPath, 'utf8');

  assert.match(command, /allowed-tools: Bash\(node:\*\)/);
  assert.match(command, /node "\$\{CLAUDE_PLUGIN_ROOT\}\/bin\/view\.js"/);
  assert.match(command, /!\`node "\$\{CLAUDE_PLUGIN_ROOT\}\/bin\/view\.js" \$ARGUMENTS\`/);
  assert.doesNotMatch(command, /--json/);
});

test('npm package ships Claude command files', async () => {
  const packageJson = JSON.parse(
    await readFile(path.resolve('plugins/subagent-budget-guard/package.json'), 'utf8')
  );
  const binFiles = await readdir(path.resolve('plugins/subagent-budget-guard/bin'));

  assert.ok(packageJson.files.includes('commands/'));
  assert.equal('bin' in packageJson, false);
  assert.equal(binFiles.includes('subagent-cap.js'), false);
  assert.equal(binFiles.includes('report.js'), false);
});

test('setup help and docs avoid unsupported individual token limit controls', async () => {
  const { stdout } = await execFileAsync(process.execPath, [
    path.resolve('plugins/subagent-budget-guard/bin/setup.js'),
    '--help'
  ]);
  const rootReadme = await readFile(path.resolve('README.md'), 'utf8');
  const packageReadme = await readFile(
    path.resolve('plugins/subagent-budget-guard/README.md'),
    'utf8'
  );

  assert.match(stdout, /session-token-cap/);
  assert.doesNotMatch(stdout, /token-limit/);
  assert.doesNotMatch(stdout, /subagent-tokens/);
  assert.doesNotMatch(stdout, /verified-token-cap/);
  assert.doesNotMatch(stdout, /--config/);
  assert.doesNotMatch(stdout, /Internal config keys/);
  assert.doesNotMatch(stdout, /max_concurrent_subagents/);
  assert.doesNotMatch(stdout, /session_five_hour_budget_percent/);
  assert.match(rootReadme, /User-facing controls should stay useful and verifiable/);
  assert.match(packageReadme, /User-facing controls should stay useful and verifiable/);
  assert.match(rootReadme, /do not present the feature as\s+a mid-run limit/i);
  assert.match(packageReadme, /do not present the feature as\s+a mid-run limit/i);
  assert.doesNotMatch(stdout, /\bsubagent-cap\s+(init|status|view|doctor)\b/);
  assert.doesNotMatch(rootReadme, /\bsubagent-cap\s+(init|status|view|doctor)\b/);
  assert.doesNotMatch(packageReadme, /\bsubagent-cap\s+(init|status|view|doctor)\b/);
  assert.doesNotMatch(rootReadme, /agent-team/i);
  assert.doesNotMatch(packageReadme, /agent-team/i);
  assert.doesNotMatch(stdout, /session_budget/);
  assert.doesNotMatch(rootReadme, /session_budget/);
  assert.doesNotMatch(packageReadme, /session_budget/);
  assert.match(rootReadme, /\/plugin update subagent-cap@subagent-tools/);
  assert.match(packageReadme, /\/plugin update subagent-cap@subagent-tools/);
  assert.doesNotMatch(rootReadme, /\bclaude plugin (marketplace add|install|update) subagent-cap@subagent-tools/);
  assert.doesNotMatch(packageReadme, /\bclaude plugin (marketplace add|install|update) subagent-cap@subagent-tools/);
  assert.doesNotMatch(rootReadme, /\bclaude plugin marketplace add rexkoh425\/ClaudeSubAgentSuppressor/);
  assert.doesNotMatch(packageReadme, /\bclaude plugin marketplace add rexkoh425\/ClaudeSubAgentSuppressor/);
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
    assert.equal(config.enforcement_mode, 'subagent_only');
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

test('PreToolUse Agent queues and blocks at the five-hour warning gate', async () => {
  await withTempEnv(async (env) => {
    env.CLAUDE_PLUGIN_OPTION_max_concurrent_subagents = '1';
    env.CLAUDE_PLUGIN_OPTION_session_five_hour_budget_percent = '100';

    await updateRateLimitFromStatusLine(
      {
        session_id: 'session-agent-five-hour-warning',
        rate_limits: { five_hour: { used_percentage: 70, resets_at: 2000 } }
      },
      env
    );
    await updateRateLimitFromStatusLine(
      {
        session_id: 'session-agent-five-hour-warning',
        rate_limits: { five_hour: { used_percentage: 75.2, resets_at: 2000 } }
      },
      env
    );

    const result = await handlePreToolUseAgent(
      agentInput('session-agent-five-hour-warning'),
      env
    );

    assert.equal(result.stdout.hookSpecificOutput.permissionDecision, 'deny');
    assert.match(
      result.stdout.hookSpecificOutput.permissionDecisionReason,
      /5-hour usage 75\.2% reached the warning threshold 75%/
    );
    assert.match(result.stdout.hookSpecificOutput.permissionDecisionReason, /ask the user to extend/i);
    assert.match(result.stdout.hookSpecificOutput.permissionDecisionReason, /Queue id: queue-/);

    const report = await buildReport('session-agent-five-hour-warning', env);
    assert.equal(report.state.subagents.queue.length, 1);
    assert.equal(report.state.subagents.queue[0].status, 'budget_blocked');
    assert.match(report.state.subagents.queue[0].reason, /warning threshold/);
  });
});

test('budget-blocked queued subagent dispatches after five-hour extension', async () => {
  await withTempEnv(async (env) => {
    env.CLAUDE_PLUGIN_OPTION_max_concurrent_subagents = '1';
    env.CLAUDE_PLUGIN_OPTION_session_five_hour_budget_percent = '100';

    await updateRateLimitFromStatusLine(
      {
        session_id: 'session-agent-budget-extension',
        rate_limits: { five_hour: { used_percentage: 70, resets_at: 2000 } }
      },
      env
    );
    await updateRateLimitFromStatusLine(
      {
        session_id: 'session-agent-budget-extension',
        rate_limits: { five_hour: { used_percentage: 75.2, resets_at: 2000 } }
      },
      env
    );

    await handlePreToolUseAgent(agentInput('session-agent-budget-extension'), env);

    env.CLAUDE_PLUGIN_OPTION_five_hour_warning_threshold_percent = '82';
    const notice = await handlePostToolBatch(
      {
        session_id: 'session-agent-budget-extension',
        hook_event_name: 'PostToolBatch'
      },
      env
    );

    assert.match(
      notice.stdout.hookSpecificOutput.additionalContext,
      /SUBAGENT_QUEUE_DISPATCH/
    );
    assert.match(
      notice.stdout.hookSpecificOutput.additionalContext,
      /Queued subagent ready to launch/
    );

    const report = await buildReport('session-agent-budget-extension', env);
    assert.equal(report.state.subagents.queue[0].status, 'dispatching');
  });
});

test('PreToolUse Agent hard-stops at the five-hour ceiling without queueing', async () => {
  await withTempEnv(async (env) => {
    env.CLAUDE_PLUGIN_OPTION_max_concurrent_subagents = '1';
    env.CLAUDE_PLUGIN_OPTION_session_five_hour_budget_percent = '100';

    await updateRateLimitFromStatusLine(
      {
        session_id: 'session-agent-five-hour-ceiling',
        rate_limits: { five_hour: { used_percentage: 80, resets_at: 2000 } }
      },
      env
    );
    await updateRateLimitFromStatusLine(
      {
        session_id: 'session-agent-five-hour-ceiling',
        rate_limits: { five_hour: { used_percentage: 85, resets_at: 2000 } }
      },
      env
    );

    const result = await handlePreToolUseAgent(
      agentInput('session-agent-five-hour-ceiling'),
      env
    );

    assert.equal(result.stdout.hookSpecificOutput.permissionDecision, 'deny');
    assert.match(
      result.stdout.hookSpecificOutput.permissionDecisionReason,
      /5-hour usage 85\.0% reached the absolute ceiling 85%/
    );

    const report = await buildReport('session-agent-five-hour-ceiling', env);
    assert.equal(report.state.subagents.queue.length, 0);
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

test('SubagentStop leaves queued work for parent-visible PostToolBatch', async () => {
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

    const stopResult = await handleSubagentStop(
      {
        session_id: 'session-queue-stop-notice',
        hook_event_name: 'SubagentStop',
        agent_id: 'agent-active',
        agent_type: 'Explore'
      },
      env
    );

    assert.equal(stopResult.exitCode, 0);
    assert.equal(stopResult.stdout, null);

    let report = await buildReport('session-queue-stop-notice', env);
    assert.equal(report.state.subagents.queue[0].status, 'queued');
    assert.equal(report.state.subagents.queue[0].notifyCount, 0);

    const batchResult = await handlePostToolBatch(
      {
        session_id: 'session-queue-stop-notice',
        hook_event_name: 'PostToolBatch'
      },
      env
    );

    assert.equal(batchResult.exitCode, 0);
    assert.match(batchResult.stdout.hookSpecificOutput.additionalContext, /Queued subagent ready to launch/);
    assert.match(batchResult.stdout.hookSpecificOutput.additionalContext, /Queued reliability review/);
    assert.match(batchResult.stdout.hookSpecificOutput.additionalContext, /Run this reliability review/);
    assert.match(batchResult.stdout.hookSpecificOutput.additionalContext, /Call the Agent tool/i);
    assert.match(batchResult.stdout.hookSpecificOutput.additionalContext, /Do not answer/i);
    assert.doesNotMatch(batchResult.stdout.hookSpecificOutput.additionalContext, /retry|automatically/i);

    report = await buildReport('session-queue-stop-notice', env);
    assert.equal(report.state.subagents.queue[0].notifyCount, 1);
  });
});

test('PostToolBatch emits a single queued prompt after SubagentStop opens capacity', async () => {
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

    const stopResult = await handleSubagentStop(
      {
        session_id: 'session-queue-single-notice',
        hook_event_name: 'SubagentStop',
        agent_id: 'agent-active',
        agent_type: 'Explore'
      },
      env
    );
    const firstNotice = await handlePostToolBatch(
      {
        session_id: 'session-queue-single-notice',
        hook_event_name: 'PostToolBatch'
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

    assert.equal(stopResult.stdout, null);
    assert.match(firstNotice.stdout.hookSpecificOutput.additionalContext, /Subagent 2 greeting/);
    assert.equal(duplicateNotice.exitCode, 0);
    assert.equal(duplicateNotice.stdout, null);

    const report = await buildReport('session-queue-single-notice', env);
    assert.equal(report.state.subagents.queue[0].notifyCount, 1);
  });
});

test('UserPromptSubmit emits queued prompt after task notification opens capacity', async () => {
  await withTempEnv(async (env) => {
    env.CLAUDE_PLUGIN_OPTION_max_concurrent_subagents = '1';
    await handleSubagentStart(
      {
        session_id: 'session-queue-user-prompt-submit',
        hook_event_name: 'SubagentStart',
        agent_id: 'agent-active',
        agent_type: 'Explore'
      },
      env
    );

    const queuedInput = agentInput('session-queue-user-prompt-submit');
    queuedInput.tool_input.description = 'Queued notification review';
    queuedInput.tool_input.prompt = 'Run this from the parent notification turn.';
    await handlePreToolUseAgent(queuedInput, env);

    const stopResult = await handleSubagentStop(
      {
        session_id: 'session-queue-user-prompt-submit',
        hook_event_name: 'SubagentStop',
        agent_id: 'agent-active',
        agent_type: 'Explore'
      },
      env
    );
    const userPromptNotice = await handleUserPromptSubmit(
      {
        session_id: 'session-queue-user-prompt-submit',
        hook_event_name: 'UserPromptSubmit'
      },
      env
    );
    const duplicateBatchNotice = await handlePostToolBatch(
      {
        session_id: 'session-queue-user-prompt-submit',
        hook_event_name: 'PostToolBatch'
      },
      env
    );

    assert.equal(stopResult.stdout, null);
    assert.match(userPromptNotice.stdout.hookSpecificOutput.additionalContext, /^SUBAGENT_QUEUE_DISPATCH/m);
    assert.match(userPromptNotice.stdout.hookSpecificOutput.additionalContext, /Queued notification review/);
    assert.match(userPromptNotice.stdout.hookSpecificOutput.additionalContext, /Run this from the parent notification turn/);
    assert.equal(duplicateBatchNotice.stdout, null);

    const report = await buildReport('session-queue-user-prompt-submit', env);
    assert.equal(report.state.subagents.queue[0].status, 'dispatching');
    assert.equal(report.state.subagents.queue[0].dispatchHookEventName, 'UserPromptSubmit');
  });
});

test('Stop hook emits one queued dispatch before the parent turn ends', async () => {
  await withTempEnv(async (env) => {
    env.CLAUDE_PLUGIN_OPTION_max_concurrent_subagents = '1';
    await handleSubagentStart(
      {
        session_id: 'session-stop-queue-drain',
        hook_event_name: 'SubagentStart',
        agent_id: 'agent-active',
        agent_type: 'Explore'
      },
      env
    );

    const queuedInput = agentInput('session-stop-queue-drain');
    queuedInput.tool_input.description = 'Queued stop-gate review';
    queuedInput.tool_input.prompt = 'Run this queued review before the parent turn finishes.';
    await handlePreToolUseAgent(queuedInput, env);
    await handleSubagentStop(
      {
        session_id: 'session-stop-queue-drain',
        hook_event_name: 'SubagentStop',
        agent_id: 'agent-active',
        agent_type: 'Explore'
      },
      env
    );

    const stopNotice = await handleStop(
      {
        session_id: 'session-stop-queue-drain',
        hook_event_name: 'Stop',
        stop_hook_active: false
      },
      env
    );
    const duplicateStopNotice = await handleStop(
      {
        session_id: 'session-stop-queue-drain',
        hook_event_name: 'Stop',
        stop_hook_active: false
      },
      env
    );

    assert.equal(stopNotice.exitCode, 0);
    assert.match(stopNotice.stdout.hookSpecificOutput.additionalContext, /^SUBAGENT_QUEUE_DISPATCH/m);
    assert.match(stopNotice.stdout.hookSpecificOutput.additionalContext, /Queued stop-gate review/);
    assert.match(stopNotice.stdout.hookSpecificOutput.additionalContext, /Run this queued review/);
    assert.equal(stopNotice.stdout.hookSpecificOutput.hookEventName, 'Stop');
    assert.equal(duplicateStopNotice.stdout, null);

    const report = await buildReport('session-stop-queue-drain', env);
    assert.equal(report.state.subagents.queue[0].status, 'dispatching');
    assert.equal(report.state.subagents.queue[0].dispatchHookEventName, 'Stop');
  });
});

test('Stop hook does not loop when Claude is already handling a Stop hook continuation', async () => {
  await withTempEnv(async (env) => {
    env.CLAUDE_PLUGIN_OPTION_max_concurrent_subagents = '1';
    await handleSubagentStart(
      {
        session_id: 'session-stop-loop-guard',
        hook_event_name: 'SubagentStart',
        agent_id: 'agent-active',
        agent_type: 'Explore'
      },
      env
    );

    const queuedInput = agentInput('session-stop-loop-guard');
    queuedInput.tool_input.description = 'Queued loop guard review';
    await handlePreToolUseAgent(queuedInput, env);
    await handleSubagentStop(
      {
        session_id: 'session-stop-loop-guard',
        hook_event_name: 'SubagentStop',
        agent_id: 'agent-active',
        agent_type: 'Explore'
      },
      env
    );

    const stopNotice = await handleStop(
      {
        session_id: 'session-stop-loop-guard',
        hook_event_name: 'Stop',
        stop_hook_active: true
      },
      env
    );

    assert.equal(stopNotice.exitCode, 0);
    assert.equal(stopNotice.stdout, null);

    const report = await buildReport('session-stop-loop-guard', env);
    assert.equal(report.state.subagents.queue[0].status, 'queued');
    assert.equal(report.state.subagents.queue[0].notifyCount, 0);
  });
});

test('PostToolUseFailure returns a failed queued dispatch to retryable state', async () => {
  await withTempEnv(async (env) => {
    env.CLAUDE_PLUGIN_OPTION_max_concurrent_subagents = '1';
    await handleSubagentStart(
      {
        session_id: 'session-queue-failure-retry',
        hook_event_name: 'SubagentStart',
        agent_id: 'agent-active',
        agent_type: 'Explore'
      },
      env
    );

    const queuedInput = agentInput('session-queue-failure-retry');
    queuedInput.tool_input.description = 'Queued failure retry';
    queuedInput.tool_input.prompt = 'Retry this queued launch if the first dispatch fails.';
    await handlePreToolUseAgent(queuedInput, env);
    await handleSubagentStop(
      {
        session_id: 'session-queue-failure-retry',
        hook_event_name: 'SubagentStop',
        agent_id: 'agent-active',
        agent_type: 'Explore'
      },
      env
    );
    await handlePostToolBatch(
      {
        session_id: 'session-queue-failure-retry',
        hook_event_name: 'PostToolBatch'
      },
      env
    );
    const acceptedQueuedLaunch = await handlePreToolUseAgent(queuedInput, env);
    assert.equal(acceptedQueuedLaunch.stdout, null);

    const failureNotice = await handlePostToolUseFailureAgent(
      {
        ...queuedInput,
        hook_event_name: 'PostToolUseFailure',
        tool_response: {
          status: 'failed',
          error: 'simulated launch failure'
        }
      },
      env
    );

    assert.equal(failureNotice.exitCode, 0);
    assert.match(
      failureNotice.stdout.hookSpecificOutput.additionalContext,
      /returned to the queue/i
    );
    assert.equal(failureNotice.stdout.hookSpecificOutput.hookEventName, 'PostToolUseFailure');

    let report = await buildReport('session-queue-failure-retry', env);
    assert.equal(report.state.subagents.queue.length, 1);
    assert.equal(report.state.subagents.queue[0].status, 'queued');
    assert.equal(report.state.subagents.queue[0].dispatchLeaseId, null);
    assert.equal(report.state.subagents.queue[0].dispatchHookEventName, null);
    assert.equal(report.state.subagents.queue[0].attempts, 2);

    const retryNotice = await handleStop(
      {
        session_id: 'session-queue-failure-retry',
        hook_event_name: 'Stop',
        stop_hook_active: false
      },
      env
    );
    assert.match(retryNotice.stdout.hookSpecificOutput.additionalContext, /Queued failure retry/);

    report = await buildReport('session-queue-failure-retry', env);
    assert.equal(report.state.subagents.queue[0].status, 'dispatching');
    assert.equal(report.state.subagents.queue[0].notifyCount, 2);
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

    const stopResult = await handleSubagentStop(
      {
        session_id: 'session-queue-dispatch-lease',
        hook_event_name: 'SubagentStop',
        agent_id: 'agent-active',
        agent_type: 'Explore'
      },
      env
    );
    const firstNotice = await handlePostToolBatch(
      {
        session_id: 'session-queue-dispatch-lease',
        hook_event_name: 'PostToolBatch'
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

    assert.equal(stopResult.stdout, null);
    assert.match(
      firstNotice.stdout.hookSpecificOutput.additionalContext,
      /^SUBAGENT_QUEUE_DISPATCH/m
    );
    assert.doesNotMatch(
      firstNotice.stdout.hookSpecificOutput.additionalContext,
      /\b(retry|automatically|background|I will|I'll|share the result)\b/i
    );
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

test('Queue dispatch accepts same described subagent when prompt text drifts', async () => {
  await withTempEnv(async (env) => {
    env.CLAUDE_PLUGIN_OPTION_max_concurrent_subagents = '1';
    await handleSubagentStart(
      {
        session_id: 'session-queue-dispatch-prompt-drift',
        hook_event_name: 'SubagentStart',
        agent_id: 'agent-active',
        agent_type: 'Explore'
      },
      env
    );

    const queuedInput = agentInput('session-queue-dispatch-prompt-drift');
    queuedInput.tool_input.description = 'Subagent 3 greeting';
    queuedInput.tool_input.prompt = 'Say exactly: "hello, i am subagent 3"';
    await handlePreToolUseAgent(queuedInput, env);

    await handleSubagentStop(
      {
        session_id: 'session-queue-dispatch-prompt-drift',
        hook_event_name: 'SubagentStop',
        agent_id: 'agent-active',
        agent_type: 'Explore'
      },
      env
    );
    await handlePostToolBatch(
      {
        session_id: 'session-queue-dispatch-prompt-drift',
        hook_event_name: 'PostToolBatch'
      },
      env
    );

    const driftedLaunch = agentInput('session-queue-dispatch-prompt-drift');
    driftedLaunch.tool_use_id = 'toolu_drifted_subagent_3';
    driftedLaunch.tool_input.description = 'Subagent 3 greeting';
    driftedLaunch.tool_input.prompt = 'Say hello as subagent 3.';

    const result = await handlePreToolUseAgent(driftedLaunch, env);
    const report = await buildReport('session-queue-dispatch-prompt-drift', env);

    assert.equal(result.stdout, null);
    assert.equal(report.state.subagents.allowed, 1);
    assert.equal(report.state.subagents.queue.length, 0);
    assert.equal(report.state.subagents.queueLaunched, 1);
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
      const stopResult = await handleSubagentStop(
        {
          session_id: sessionId,
          hook_event_name: 'SubagentStop',
          agent_id: `agent-${nextIndex}`,
          agent_type: 'Explore'
        },
        env
      );
      assert.equal(stopResult.stdout, null);

      const notice = await handlePostToolBatch(
        {
          session_id: sessionId,
          hook_event_name: 'PostToolBatch'
        },
        env
      );
      const context = notice.stdout.hookSpecificOutput.additionalContext;

      assert.match(context, /^SUBAGENT_QUEUE_DISPATCH/m);
      assert.match(context, new RegExp(`Subagent ${nextNumber}`));
      assert.match(context, new RegExp(`hello, i am subagent ${nextNumber}`));
      assert.doesNotMatch(context, /\b(retry|automatically|background|I will|I'll)\b/i);

      const repeatedByBatch = await handlePostToolBatch(
        {
          session_id: sessionId,
          hook_event_name: 'PostToolBatch'
        },
        env
      );
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
    await handlePostToolBatch(
      {
        session_id: 'session-queue-order',
        hook_event_name: 'PostToolBatch'
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
    await updateRateLimitFromStatusLine(
      {
        session_id: 'session-view',
        rate_limits: { five_hour: { used_percentage: 76, resets_at: 2000 } }
      },
      env
    );
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
    assert.match(output, /Tokens are verified after subagents complete/i);
    assert.match(output, /5-hour usage: 76\.0% \(warning 75%, ceiling 85%\)/);
    assert.doesNotMatch(output, /Thinking level:/);
    assert.match(output, /duration: 1\.5s/);
    assert.match(output, /model: claude-sonnet/);
    assert.match(output, /#2 async_launched Research "Background scrape"/);
    assert.match(output, /tokens: pending/);
  });
});

test('formatSubagentView shows thinking metadata only when Claude exposes it', async () => {
  await withTempEnv(async (env) => {
    await handlePostToolUseAgent(
      {
        session_id: 'session-view-thinking',
        hook_event_name: 'PostToolUse',
        runtime: { effortLevel: 'low', thinkingEnabled: true },
        tool_name: 'Agent',
        tool_input: { description: 'Thinking metadata task', subagent_type: 'Explore' },
        tool_response: {
          status: 'completed',
          agentId: 'agent-thinking',
          totalTokens: 111,
          totalDurationMs: 300
        }
      },
      env
    );

    const report = await buildReport('session-view-thinking', env);
    const output = formatSubagentView(report);

    assert.match(output, /Thinking level: low, thinking enabled/);
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

test('formatSubagentView counts budget-blocked queued subagents separately', async () => {
  await withTempEnv(async (env) => {
    env.CLAUDE_PLUGIN_OPTION_max_concurrent_subagents = '1';
    env.CLAUDE_PLUGIN_OPTION_session_five_hour_budget_percent = '100';

    await updateRateLimitFromStatusLine(
      {
        session_id: 'session-view-budget-blocked',
        rate_limits: { five_hour: { used_percentage: 70, resets_at: 2000 } }
      },
      env
    );
    await updateRateLimitFromStatusLine(
      {
        session_id: 'session-view-budget-blocked',
        rate_limits: { five_hour: { used_percentage: 75.1, resets_at: 2000 } }
      },
      env
    );

    const queuedInput = agentInput('session-view-budget-blocked');
    queuedInput.tool_input.description = 'Budget blocked review';
    await handlePreToolUseAgent(queuedInput, env);

    const output = formatSubagentView(await buildReport('session-view-budget-blocked', env));

    assert.match(output, /Queued subagents: 1/);
    assert.match(output, /Budget-blocked subagents: 1/);
    assert.match(output, /Budget blocked review/);
    assert.match(output, /status: budget_blocked/);
  });
});

test('Task tool launches are tracked and queued as subagents', async () => {
  await withTempEnv(async (env) => {
    env.CLAUDE_PLUGIN_OPTION_max_concurrent_subagents = '1';
    await handleSubagentStart(
      {
        session_id: 'session-task-tool',
        hook_event_name: 'SubagentStart',
        agent_id: 'agent-active',
        agent_type: 'Explore'
      },
      env
    );

    const taskInput = agentInput('session-task-tool');
    taskInput.tool_name = 'Task';
    taskInput.tool_input.description = 'Queued task subagent';
    const queued = await handlePreToolUseAgent(taskInput, env);

    assert.match(
      queued.stdout.hookSpecificOutput.permissionDecisionReason,
      /Subagent launch saved to queue/
    );

    const report = await buildReport('session-task-tool', env);
    assert.equal(report.state.subagents.queue.length, 1);
    assert.equal(report.state.subagents.queue[0].toolName, 'Task');

    const stopResult = await handleSubagentStop(
      {
        session_id: 'session-task-tool',
        hook_event_name: 'SubagentStop',
        agent_id: 'agent-active',
        agent_type: 'Explore'
      },
      env
    );
    const notice = await handlePostToolBatch(
      {
        session_id: 'session-task-tool',
        hook_event_name: 'PostToolBatch'
      },
      env
    );

    assert.equal(stopResult.stdout, null);
    assert.match(
      notice.stdout.hookSpecificOutput.additionalContext,
      /Call the Task tool exactly once/
    );
  });
});

test('buildReport discovers saved sessions from sibling plugin data directories', async () => {
  const homeDir = await mkdtemp(path.join(tmpdir(), 'sbg-home-'));
  const altDataDir = path.join(homeDir, '.claude', 'plugins', 'data', 'subagent-cap-runtime');
  try {
    await handlePostToolUseAgent(
      {
        session_id: 'session-discovered-view',
        hook_event_name: 'PostToolUse',
        tool_name: 'Task',
        tool_input: { description: 'Discovered task', subagent_type: 'Explore' },
        tool_response: {
          status: 'completed',
          agentId: 'agent-discovered',
          resolvedModel: 'claude-sonnet',
          totalTokens: 321,
          totalToolUseCount: 1,
          totalDurationMs: 500
        }
      },
      {
        USERPROFILE: homeDir,
        HOME: homeDir,
        CLAUDE_PLUGIN_ROOT: path.resolve('plugins/subagent-budget-guard'),
        CLAUDE_PLUGIN_DATA: altDataDir
      }
    );

    const report = await buildReport(null, {
      USERPROFILE: homeDir,
      HOME: homeDir,
      CLAUDE_PLUGIN_ROOT: path.resolve('plugins/subagent-budget-guard')
    });

    assert.equal(report.sessionId, 'session-discovered-view');
    assert.equal(report.dataDir, path.resolve(altDataDir));
    assert.equal(report.state.subagents.runs.length, 1);
    assert.equal(report.state.subagents.verifiedTokens, 321);
  } finally {
    await rm(homeDir, { recursive: true, force: true });
  }
});

test('buildReport discovers saved sessions from configured statusLine data path', async () => {
  const homeDir = await mkdtemp(path.join(tmpdir(), 'sbg-home-'));
  const dataDir = await mkdtemp(path.join(tmpdir(), 'sbg-runtime-data-'));
  try {
    await installStatusLineBridge({
      homeDir,
      pluginRoot: path.resolve('plugins/subagent-budget-guard'),
      pluginData: dataDir,
      setupConfig: SETUP_CONFIG
    });
    await handlePostToolUseAgent(
      {
        session_id: 'session-statusline-data-view',
        hook_event_name: 'PostToolUse',
        tool_name: 'Task',
        tool_input: { description: 'StatusLine data path task', subagent_type: 'Explore' },
        tool_response: {
          status: 'completed',
          agentId: 'agent-statusline-data',
          totalTokens: 654,
          totalDurationMs: 700,
          totalToolUseCount: 1
        }
      },
      {
        USERPROFILE: homeDir,
        HOME: homeDir,
        CLAUDE_PLUGIN_ROOT: path.resolve('plugins/subagent-budget-guard'),
        CLAUDE_PLUGIN_DATA: dataDir
      }
    );

    const report = await buildReport(null, {
      USERPROFILE: homeDir,
      HOME: homeDir,
      CLAUDE_PLUGIN_ROOT: path.resolve('plugins/subagent-budget-guard')
    });

    assert.equal(report.sessionId, 'session-statusline-data-view');
    assert.equal(report.dataDir, path.resolve(dataDir));
    assert.equal(report.state.subagents.verifiedTokens, 654);
  } finally {
    await rm(homeDir, { recursive: true, force: true });
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('buildReport hydrates async subagent usage from Claude transcript notifications', async () => {
  const homeDir = await mkdtemp(path.join(tmpdir(), 'sbg-home-'));
  const dataDir = await mkdtemp(path.join(tmpdir(), 'sbg-data-'));
  const transcriptPath = path.join(homeDir, '.claude', 'projects', 'repo-a', 'session-async-view.jsonl');
  try {
    await mkdir(path.dirname(transcriptPath), { recursive: true });
    await handlePostToolUseAgent(
      {
        session_id: 'session-async-view',
        transcript_path: transcriptPath,
        cwd: '/workspace/repo-a',
        hook_event_name: 'PostToolUse',
        tool_name: 'Agent',
        tool_use_id: 'toolu_async_123',
        tool_input: { description: 'Async task', subagent_type: 'general-purpose' },
        tool_response: {
          status: 'async_launched',
          agentId: 'agent-async-123',
          resolvedModel: 'claude-haiku',
          outputFile: '/tmp/agent-async-123.output'
        }
      },
      {
        USERPROFILE: homeDir,
        HOME: homeDir,
        CLAUDE_PLUGIN_ROOT: path.resolve('plugins/subagent-budget-guard'),
        CLAUDE_PLUGIN_DATA: dataDir
      }
    );

    await writeFile(
      transcriptPath,
      `${JSON.stringify({
        type: 'queue-operation',
        operation: 'enqueue',
        sessionId: 'session-async-view',
        content:
          '<task-notification>\n' +
          '<task-id>agent-async-123</task-id>\n' +
          '<tool-use-id>toolu_async_123</tool-use-id>\n' +
          '<output-file>/tmp/agent-async-123.output</output-file>\n' +
          '<status>completed</status>\n' +
          '<usage><subagent_tokens>18044</subagent_tokens><tool_uses>0</tool_uses><duration_ms>4930</duration_ms></usage>\n' +
          '</task-notification>'
      })}\n`,
      'utf8'
    );

    const report = await buildReport('session-async-view', {
      USERPROFILE: homeDir,
      HOME: homeDir,
      CLAUDE_PLUGIN_ROOT: path.resolve('plugins/subagent-budget-guard'),
      CLAUDE_PLUGIN_DATA: dataDir
    });
    const output = formatSubagentView(report);

    assert.equal(report.state.subagents.runs[0].status, 'completed');
    assert.equal(report.state.subagents.runs[0].verified, true);
    assert.equal(report.state.subagents.verifiedTokens, 18044);
    assert.equal(report.state.subagents.totalDurationMs, 4930);
    assert.match(output, /Verified tokens: 18,044/);
    assert.match(output, /duration: 4\.9s/);
  } finally {
    await rm(homeDir, { recursive: true, force: true });
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('sub-agent-view stays text-only even when legacy --json argument is passed', async () => {
  await withTempEnv(async (env) => {
    await handlePostToolUseAgent(
      {
        session_id: 'session-view-cli-text',
        hook_event_name: 'PostToolUse',
        tool_name: 'Agent',
        tool_input: { description: 'Text view task', subagent_type: 'Explore' },
        tool_response: {
          status: 'completed',
          agentId: 'agent-view-cli-text',
          totalTokens: 321,
          totalDurationMs: 400,
          totalToolUseCount: 1
        }
      },
      env
    );

    const { stdout } = await execFileAsync(
      process.execPath,
      [
        path.resolve('plugins/subagent-budget-guard/bin/view.js'),
        '--session',
        'session-view-cli-text',
        '--json'
      ],
      {
        cwd: path.resolve('.'),
        env: {
          ...process.env,
          ...env
        }
      }
    );

    assert.match(stdout, /Sub-agent view for session-view-cli-text/);
    assert.match(stdout, /Verified tokens: 321/);
    assert.doesNotMatch(stdout.trimStart(), /^\{/);
    assert.doesNotMatch(stdout, /"subagents"/);
  });
});

test('sub-agent-view reports setup errors without stack traces', async () => {
  const homeDir = await mkdtemp(path.join(tmpdir(), 'sbg-home-'));
  const dataDir = await mkdtemp(path.join(tmpdir(), 'sbg-data-'));
  try {
    await mkdir(path.join(homeDir, '.claude', 'settings.json'), { recursive: true });

    const result = await execNodeWithInput(
      [path.resolve('plugins/subagent-budget-guard/bin/view.js')],
      '',
      {
        env: {
          USERPROFILE: homeDir,
          HOME: homeDir,
          CLAUDE_PLUGIN_ROOT: path.resolve('plugins/subagent-budget-guard'),
          CLAUDE_PLUGIN_DATA: dataDir
        }
      }
    );

    assert.equal(result.code, 1);
    assert.equal(result.stdout, '');
    assert.match(result.stderr, /sub-agent-view failed:/);
    assert.doesNotMatch(result.stderr, /\n\s+at /);
    assert.doesNotMatch(result.stderr, /file:\/\//);
  } finally {
    await rm(homeDir, { recursive: true, force: true });
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('formatSubagentView explains when no tracked session files exist yet', async () => {
  await withTempEnv(async (env) => {
    const report = await buildReport(null, env);
    const output = formatSubagentView(report);

    assert.match(output, /Tracking status: no saved session files found/i);
    assert.match(output, /Subagent run data comes from Agent\/Task hooks/i);
    assert.match(output, /run \/subagent-cap:init again to re-apply setup/i);
    assert.match(output, /Data directory checked:/i);
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

    assert.match(output, /Tracking status: session file exists, but no Agent\/Task hook events were recorded/i);
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
      assert.match(settings.statusLine.command, /statusline-runner\.js/);
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

test('installStatusLineBridge keeps statusLine command stable across plugin updates', async () => {
  await withTempEnv(async (_env, dataDir) => {
    const homeDir = await mkdtemp(path.join(tmpdir(), 'sbg-home-'));
    try {
      const firstRoot = path.join(homeDir, '.claude', 'plugins', 'cache', 'subagent-tools', 'subagent-cap', '1.0.0');
      const secondRoot = path.join(homeDir, '.claude', 'plugins', 'cache', 'subagent-tools', 'subagent-cap', '1.0.1');

      await installStatusLineBridge({
        homeDir,
        pluginRoot: firstRoot,
        pluginData: dataDir
      });

      const settingsPath = path.join(homeDir, '.claude', 'settings.json');
      const firstSettings = JSON.parse(await readFile(settingsPath, 'utf8'));
      const firstCommand = firstSettings.statusLine.command;
      assert.match(firstCommand, /statusline-runner\.js/);
      assert.doesNotMatch(firstCommand, /1\.0\.0/);

      const result = await installStatusLineBridge({
        homeDir,
        pluginRoot: secondRoot,
        pluginData: dataDir
      });

      const secondSettings = JSON.parse(await readFile(settingsPath, 'utf8'));
      assert.equal(secondSettings.statusLine.command, firstCommand);
      assert.equal(result.bridgeRefreshed, true);

      const bridge = JSON.parse(
        await readFile(path.join(dataDir, 'statusline-bridge.json'), 'utf8')
      );
      assert.equal(bridge.pluginRoot, secondRoot);
      assert.equal(bridge.previousStatusLine, null);
    } finally {
      await rm(homeDir, { recursive: true, force: true });
    }
  });
});

test('statusLine runner uses latest installed cache version without rerunning setup', async () => {
  const homeDir = await mkdtemp(path.join(tmpdir(), 'sbg-home-'));
  try {
    const dataDir = path.join(homeDir, '.claude', 'plugins', 'data', 'subagent-cap');
    const cacheRoot = path.join(homeDir, '.claude', 'plugins', 'cache', 'subagent-tools', 'subagent-cap');
    const firstRoot = path.join(cacheRoot, '1.0.0');
    const secondRoot = path.join(cacheRoot, '1.0.1');

    await mkdir(path.join(firstRoot, 'bin'), { recursive: true });
    await mkdir(path.join(secondRoot, 'bin'), { recursive: true });
    await writeFile(
      path.join(firstRoot, 'bin', 'statusline.js'),
      "process.stdout.write('old-version\\n');\n"
    );
    await writeFile(
      path.join(secondRoot, 'bin', 'statusline.js'),
      "process.stdout.write('new-version\\n');\n"
    );

    await installStatusLineBridge({
      homeDir,
      pluginRoot: firstRoot,
      pluginData: dataDir
    });

    const output = await execNodeWithInput(
      [path.join(dataDir, 'statusline-runner.js'), '--data', dataDir],
      JSON.stringify({ session_id: 'runner-session' })
    );

    assert.equal(output.code, 0);
    assert.equal(output.stdout.trim(), 'new-version');
  } finally {
    await rm(homeDir, { recursive: true, force: true });
  }
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
        five_hour_warning_threshold_percent: 75,
        session_five_hour_budget_percent: 10,
        absolute_five_hour_ceiling_percent: 85,
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
    assert.equal(
      result.checks.some((check) => check.name === 'simulated-statusline-budget-default-passthrough'),
      false
    );
    assert.equal(
      result.checks.some((check) => check.name === 'simulated-statusline-budget-session-mode-blocks'),
      false
    );
    assert.ok(result.checks.some((check) => check.name === 'two-command-surface'));
    assert.ok(
      result.checks.some((check) => check.name === 'five-hour-warning-gate-blocks-subagent')
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

test('setup CLI applies internal config keys via --set over recommended defaults', async () => {
  const homeDir = await mkdtemp(path.join(tmpdir(), 'sbg-home-'));
  const dataDir = await mkdtemp(path.join(tmpdir(), 'sbg-data-'));
  try {
    await execFileAsync(
      process.execPath,
      [
        path.resolve('plugins/subagent-budget-guard/bin/setup.js'),
        '--set',
        'max_concurrent_subagents=3',
        '--set',
        'max_subagent_tokens_per_session=250000',
        '--set',
        'subagent_token_warning_threshold_percent=80',
        '--set',
        'five_hour_warning_threshold_percent=75',
        '--set',
        'session_five_hour_budget_percent=10',
        '--set',
        'absolute_five_hour_ceiling_percent=90',
        '--set',
        'enforcement_mode=observe',
        '--set',
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
    assert.equal(options.five_hour_warning_threshold_percent, 75);
    assert.equal(options.session_five_hour_budget_percent, 10);
    assert.equal(options.absolute_five_hour_ceiling_percent, 90);
    assert.equal(options.enforcement_mode, 'observe');
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
    assert.equal(options.five_hour_warning_threshold_percent, 70);
    assert.equal(options.session_five_hour_budget_percent, 5);
    assert.equal(options.absolute_five_hour_ceiling_percent, 85);
    assert.equal(options.enforcement_mode, 'subagent_only');
    assert.equal(options.enforcement_enabled, true);
    assert.match(stdout, /Preset: Strict/);
    assert.match(stdout, /Subagents at once: 1/);
    assert.match(stdout, /Verified session token cap: 250,000/);
    assert.match(stdout, /Bridge runner: .*statusline-runner\.js/);
    assert.match(stdout, /RESTART REQUIRED: fully exit and reopen Claude Code/i);
    assert.match(stdout, /Then send one normal message before relying on \/sub-agent-view/i);
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

test('setup CLI extend-five-hour raises warning, session budget, and ceiling', async () => {
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
              max_subagent_tokens_per_session: 500000,
              subagent_token_warning_threshold_percent: 80,
              five_hour_warning_threshold_percent: 75,
              session_five_hour_budget_percent: 10,
              absolute_five_hour_ceiling_percent: 85,
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
        '--extend-five-hour',
        '2'
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

    assert.equal(options.five_hour_warning_threshold_percent, 77);
    assert.equal(options.session_five_hour_budget_percent, 12);
    assert.equal(options.absolute_five_hour_ceiling_percent, 87);
    assert.match(stdout, /Preset: Extended Current \(\+2%\)/);
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
    let error = null;
    try {
      await execFileAsync(
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
      );
    } catch (caught) {
      error = caught;
    }

    assert.ok(error, 'setup should reject unknown setting names');
    const message = `${error.stderr || ''}${error.stdout || ''}${error.message || ''}`;
    assert.match(message, /Unknown setting "subagent-speed"/);
    assert.match(message, /Valid settings: agents, session-token-cap, warn-at, five-hour-warning, five-hour-budget, five-hour-ceiling, mode, enabled/);
    assert.doesNotMatch(message, /subagents-at-once/);
    assert.doesNotMatch(message, /agent-limit/);
    assert.doesNotMatch(message, /budget-mode/);
    assert.doesNotMatch(message, /enforcement-mode/);
    assert.doesNotMatch(message, /\bat configKeyForSetting\b/);
  } finally {
    await rm(homeDir, { recursive: true, force: true });
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('setup script writes short plugin config id', async () => {
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
        path.resolve('plugins/subagent-budget-guard/bin/setup.js'),
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
        .five_hour_warning_threshold_percent,
      75
    );
    assert.equal(
      settings.pluginConfigs['subagent-cap@subagent-tools'].options
        .session_five_hour_budget_percent,
      10
    );
    assert.equal(
      settings.pluginConfigs['subagent-cap@subagent-tools'].options
        .absolute_five_hour_ceiling_percent,
      85
    );
  } finally {
    await rm(homeDir, { recursive: true, force: true });
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('renderStatusLine emits the SBG guard segment for known and unknown 5-hour usage', async () => {
  await withTempEnv(async (env, dataDir) => {
    const statusEnv = { ...env, CLAUDE_PLUGIN_OPTION_max_concurrent_subagents: '2' };

    const unknown = await renderStatusLine(
      { session_id: 'sl-unknown' },
      { pluginData: dataDir, env: statusEnv }
    );
    assert.match(unknown, /SBG agents 0\/2 \| tokens no verified-token cap \| 5h unknown/);

    const known = await renderStatusLine(
      {
        session_id: 'sl-known',
        rate_limits: { five_hour: { used_percentage: 42.5, resets_at: 1 } }
      },
      { pluginData: dataDir, env: statusEnv }
    );
    assert.match(known, /SBG agents 0\/2/);
    assert.match(known, /5h 42\.5%/);
  });
});

test('concurrent PreToolUse Agent calls are all recorded under the state lock', async () => {
  await withTempEnv(async (env) => {
    const attempts = Array.from({ length: 6 }, (_unused, index) =>
      handlePreToolUseAgent(
        {
          session_id: 'session-concurrent',
          hook_event_name: 'PreToolUse',
          tool_name: 'Agent',
          tool_input: {
            description: `concurrent task ${index}`,
            subagent_type: 'Explore',
            prompt: `prompt ${index}`
          }
        },
        env
      )
    );
    const results = await Promise.all(attempts);

    for (const result of results) {
      assert.equal(result.stdout?.hookSpecificOutput?.permissionDecision, 'deny');
    }

    const report = await buildReport('session-concurrent', env);
    assert.equal(report.state.subagents.requested, 6);
    assert.equal(report.state.subagents.denied, 6);
  });
});

test('setup CLI extend-five-hour clamps raised thresholds at 100%', async () => {
  const homeDir = await mkdtemp(path.join(tmpdir(), 'sbg-home-'));
  const dataDir = await mkdtemp(path.join(tmpdir(), 'sbg-data-'));
  const env = {
    ...process.env,
    USERPROFILE: homeDir,
    HOME: homeDir,
    CLAUDE_PLUGIN_ROOT: path.resolve('plugins/subagent-budget-guard'),
    CLAUDE_PLUGIN_DATA: dataDir
  };
  const setupPath = path.resolve('plugins/subagent-budget-guard/bin/setup.js');
  try {
    await execFileAsync(process.execPath, [setupPath, '--preset', 'balanced'], {
      cwd: path.resolve('.'),
      env
    });
    await execFileAsync(process.execPath, [setupPath, '--extend-five-hour', '50'], {
      cwd: path.resolve('.'),
      env
    });

    const settings = JSON.parse(
      await readFile(path.join(homeDir, '.claude', 'settings.json'), 'utf8')
    );
    const options = settings.pluginConfigs['subagent-cap@subagent-tools'].options;

    assert.equal(options.five_hour_warning_threshold_percent, 100);
    assert.equal(options.absolute_five_hour_ceiling_percent, 100);
    assert.equal(options.session_five_hour_budget_percent, 60);
  } finally {
    await rm(homeDir, { recursive: true, force: true });
    await rm(dataDir, { recursive: true, force: true });
  }
});

import { spawn } from 'node:child_process';
import { constants as fsConstants } from 'node:fs';
import {
  access,
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
export const PLUGIN_NAME = 'subagent-budget-guard';

export const DEFAULT_CONFIG = Object.freeze({
  max_subagents_per_session: 0,
  max_concurrent_subagents: 0,
  max_agent_team_tasks_per_session: 0,
  max_subagent_tokens_per_session: 0,
  session_five_hour_budget_percent: 25,
  absolute_five_hour_ceiling_percent: 95,
  enforcement_enabled: true
});

export const CONFIG_KEYS = Object.freeze(Object.keys(DEFAULT_CONFIG));

const NUMBER_KEYS = new Set(
  CONFIG_KEYS.filter((key) => typeof DEFAULT_CONFIG[key] === 'number')
);

function nowIso() {
  return new Date().toISOString();
}

function sanitizeId(value) {
  return String(value || 'unknown-session').replace(/[^a-zA-Z0-9._-]/g, '-');
}

function asNumber(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function asBoolean(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  if (typeof value === 'boolean') return value;
  const normalized = String(value).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
  return fallback;
}

function envValue(env, key) {
  const exact = `CLAUDE_PLUGIN_OPTION_${key}`;
  const upper = `CLAUDE_PLUGIN_OPTION_${key.toUpperCase()}`;
  return env[exact] ?? env[upper];
}

export function loadConfig(env = process.env) {
  const config = { ...DEFAULT_CONFIG };

  for (const key of CONFIG_KEYS) {
    const value = envValue(env, key);
    if (NUMBER_KEYS.has(key)) {
      config[key] = Math.max(0, asNumber(value, DEFAULT_CONFIG[key]));
    } else if (typeof DEFAULT_CONFIG[key] === 'boolean') {
      config[key] = asBoolean(value, DEFAULT_CONFIG[key]);
    }
  }

  config.session_five_hour_budget_percent = Math.min(
    100,
    config.session_five_hour_budget_percent
  );
  config.absolute_five_hour_ceiling_percent = Math.min(
    100,
    config.absolute_five_hour_ceiling_percent
  );

  return config;
}

export function getHomeDir(env = process.env) {
  return env.USERPROFILE || env.HOME || os.homedir();
}

export function getPluginRoot(env = process.env) {
  return env.CLAUDE_PLUGIN_ROOT || path.resolve('.');
}

export function getDataDir(env = process.env) {
  if (env.CLAUDE_PLUGIN_DATA) return env.CLAUDE_PLUGIN_DATA;
  return path.join(getHomeDir(env), '.claude', 'plugins', 'data', PLUGIN_NAME);
}

function stateDir(env) {
  return path.join(getDataDir(env), 'sessions');
}

function stateFile(sessionId, env) {
  return path.join(stateDir(env), `${sanitizeId(sessionId)}.json`);
}

function lockFile(sessionId, env) {
  return `${stateFile(sessionId, env)}.lock`;
}

function initialState(sessionId) {
  return {
    schemaVersion: 1,
    sessionId,
    createdAt: nowIso(),
    updatedAt: nowIso(),
    subagents: {
      requested: 0,
      allowed: 0,
      denied: 0,
      active: 0,
      completed: 0,
      backgroundLaunched: 0,
      lifecycleStarted: 0,
      lifecycleStopped: 0,
      verifiedTokens: 0,
      totalDurationMs: 0,
      totalToolUseCount: 0,
      runs: []
    },
    agentTeam: {
      created: 0,
      completed: 0,
      denied: 0,
      active: 0,
      tasks: []
    },
    rateLimits: {
      fiveHour: {
        baselineUsedPercentage: null,
        latestUsedPercentage: null,
        latestObservedAt: null,
        resetsAt: null,
        bridgeSeen: false
      }
    },
    events: []
  };
}

async function readJson(filePath, fallback = null) {
  try {
    const text = await readFile(filePath, 'utf8');
    return JSON.parse(text.replace(/^\uFEFF/, ''));
  } catch (error) {
    if (error.code === 'ENOENT') return fallback;
    throw error;
  }
}

async function writeJsonAtomic(filePath, value) {
  await mkdir(path.dirname(filePath), { recursive: true });
  const tmpPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tmpPath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  await rename(tmpPath, filePath);
}

async function sleep(ms) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function acquireLock(sessionId, env, timeoutMs = 3000) {
  await mkdir(stateDir(env), { recursive: true });
  const filePath = lockFile(sessionId, env);
  const start = Date.now();

  while (true) {
    try {
      const handle = await open(filePath, 'wx');
      return async () => {
        await handle.close();
        await rm(filePath, { force: true });
      };
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      if (Date.now() - start > timeoutMs) {
        throw new Error(`Timed out waiting for state lock: ${filePath}`);
      }
      await sleep(25);
    }
  }
}

async function readState(sessionId, env) {
  return readJson(stateFile(sessionId, env), initialState(sessionId));
}

async function updateState(sessionId, env, updater) {
  const release = await acquireLock(sessionId, env);
  try {
    const current = await readState(sessionId, env);
    const next = await updater(current) || current;
    next.updatedAt = nowIso();
    await writeJsonAtomic(stateFile(sessionId, env), next);
    return next;
  } finally {
    await release();
  }
}

function pushEvent(state, event) {
  state.events.push({
    at: nowIso(),
    ...event
  });
  if (state.events.length > 200) {
    state.events = state.events.slice(-200);
  }
}

function numberOrNull(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function fiveHourUsage(input) {
  const fiveHour = input?.rate_limits?.five_hour;
  if (!fiveHour) return null;

  const used = numberOrNull(fiveHour.used_percentage);
  if (used === null) return null;

  return {
    usedPercentage: Math.max(0, Math.min(100, used)),
    resetsAt: numberOrNull(fiveHour.resets_at)
  };
}

export async function updateRateLimitFromStatusLine(input, env = process.env) {
  const sessionId = input?.session_id || input?.sessionId || 'unknown-session';
  const usage = fiveHourUsage(input);

  if (!usage) {
    return updateState(sessionId, env, (state) => {
      state.rateLimits.fiveHour.bridgeSeen = true;
      pushEvent(state, { type: 'statusline-no-five-hour-rate-limit' });
      return state;
    });
  }

  return updateState(sessionId, env, (state) => {
    const fiveHour = state.rateLimits.fiveHour;
    const resetChanged =
      fiveHour.resetsAt !== null &&
      usage.resetsAt !== null &&
      usage.resetsAt !== fiveHour.resetsAt;
    const usageRolledOver =
      fiveHour.baselineUsedPercentage !== null &&
      usage.usedPercentage < fiveHour.baselineUsedPercentage - 0.1;

    if (
      fiveHour.baselineUsedPercentage === null ||
      resetChanged ||
      usageRolledOver
    ) {
      fiveHour.baselineUsedPercentage = usage.usedPercentage;
    }

    fiveHour.latestUsedPercentage = usage.usedPercentage;
    fiveHour.resetsAt = usage.resetsAt;
    fiveHour.latestObservedAt = nowIso();
    fiveHour.bridgeSeen = true;
    pushEvent(state, {
      type: 'statusline-rate-limit',
      usedPercentage: usage.usedPercentage,
      resetsAt: usage.resetsAt
    });
    return state;
  });
}

function fiveHourBudgetDecision(state, config) {
  const fiveHour = state.rateLimits.fiveHour;
  const latest = fiveHour.latestUsedPercentage;
  const baseline = fiveHour.baselineUsedPercentage;

  if (!config.enforcement_enabled) return null;
  if (latest === null || baseline === null) return null;

  if (latest >= config.absolute_five_hour_ceiling_percent) {
    return `5-hour usage ${latest.toFixed(1)}% reached the absolute ceiling ${config.absolute_five_hour_ceiling_percent}%.`;
  }

  const consumed = latest - baseline;
  if (consumed >= config.session_five_hour_budget_percent) {
    return `5-hour budget exhausted: this session used ${consumed.toFixed(1)} percentage points since baseline ${baseline.toFixed(1)}%, limit ${config.session_five_hour_budget_percent}%.`;
  }

  return null;
}

function agentDenyReason(state, config) {
  if (!config.enforcement_enabled) return null;

  const budgetReason = fiveHourBudgetDecision(state, config);
  if (budgetReason) return budgetReason;

  if (config.max_subagents_per_session === 0) {
    return 'Subagent launch denied: max_subagents_per_session is 0.';
  }

  if (state.subagents.allowed >= config.max_subagents_per_session) {
    return `Subagent launch denied: max_subagents_per_session ${config.max_subagents_per_session} already reached.`;
  }

  if (config.max_concurrent_subagents === 0) {
    return 'Subagent launch denied: max_concurrent_subagents is 0.';
  }

  if (state.subagents.active >= config.max_concurrent_subagents) {
    return `Subagent launch denied: max_concurrent_subagents ${config.max_concurrent_subagents} already reached.`;
  }

  if (
    config.max_subagent_tokens_per_session > 0 &&
    state.subagents.verifiedTokens >= config.max_subagent_tokens_per_session
  ) {
    return `Subagent launch denied: verified subagent tokens ${state.subagents.verifiedTokens} reached max_subagent_tokens_per_session ${config.max_subagent_tokens_per_session}.`;
  }

  return null;
}

export async function handlePreToolUseAgent(input, env = process.env) {
  const sessionId = input?.session_id || 'unknown-session';
  const config = loadConfig(env);
  let reason = null;

  await updateState(sessionId, env, (state) => {
    state.subagents.requested += 1;
    reason = agentDenyReason(state, config);
    if (reason) {
      state.subagents.denied += 1;
      pushEvent(state, {
        type: 'agent-denied',
        reason,
        description: input?.tool_input?.description || null,
        subagentType: input?.tool_input?.subagent_type || null
      });
    } else {
      state.subagents.allowed += 1;
      pushEvent(state, {
        type: 'agent-allowed',
        description: input?.tool_input?.description || null,
        subagentType: input?.tool_input?.subagent_type || null
      });
    }
    return state;
  });

  if (!reason) {
    return { exitCode: 0, stdout: null, stderr: '' };
  }

  return {
    exitCode: 0,
    stdout: {
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: reason
      }
    },
    stderr: ''
  };
}

function usageTotal(usage = {}) {
  return (
    asNumber(usage.input_tokens, 0) +
    asNumber(usage.output_tokens, 0) +
    asNumber(usage.cache_creation_input_tokens, 0) +
    asNumber(usage.cache_read_input_tokens, 0)
  );
}

export async function handlePostToolUseAgent(input, env = process.env) {
  const sessionId = input?.session_id || 'unknown-session';
  const response = input?.tool_response || {};
  const status = response.status || 'unknown';
  const totalTokens =
    numberOrNull(response.totalTokens) ?? usageTotal(response.usage || {});
  const verified = status === 'completed' && totalTokens > 0;

  await updateState(sessionId, env, (state) => {
    const run = {
      at: nowIso(),
      agentId: response.agentId || null,
      status,
      description: input?.tool_input?.description || null,
      subagentType: input?.tool_input?.subagent_type || null,
      resolvedModel: response.resolvedModel || null,
      totalTokens: verified ? totalTokens : 0,
      totalDurationMs: asNumber(response.totalDurationMs, 0),
      totalToolUseCount: asNumber(response.totalToolUseCount, 0),
      verified,
      usage: response.usage || null,
      outputFile: response.outputFile || null
    };

    state.subagents.runs.push(run);
    if (state.subagents.runs.length > 100) {
      state.subagents.runs = state.subagents.runs.slice(-100);
    }

    if (verified) {
      state.subagents.completed += 1;
      state.subagents.verifiedTokens += totalTokens;
      state.subagents.totalDurationMs += run.totalDurationMs;
      state.subagents.totalToolUseCount += run.totalToolUseCount;
    } else if (status === 'async_launched') {
      state.subagents.backgroundLaunched += 1;
    }

    pushEvent(state, {
      type: 'agent-result',
      status,
      agentId: run.agentId,
      verified,
      totalTokens: run.totalTokens
    });
    return state;
  });

  return { exitCode: 0, stdout: null, stderr: '' };
}

export async function handleSubagentStart(input, env = process.env) {
  const sessionId = input?.session_id || 'unknown-session';
  await updateState(sessionId, env, (state) => {
    state.subagents.lifecycleStarted += 1;
    state.subagents.active += 1;
    pushEvent(state, {
      type: 'subagent-start',
      agentId: input?.agent_id || null,
      agentType: input?.agent_type || null
    });
    return state;
  });

  return { exitCode: 0, stdout: null, stderr: '' };
}

export async function handleSubagentStop(input, env = process.env) {
  const sessionId = input?.session_id || 'unknown-session';
  await updateState(sessionId, env, (state) => {
    state.subagents.lifecycleStopped += 1;
    state.subagents.active = Math.max(0, state.subagents.active - 1);
    pushEvent(state, {
      type: 'subagent-stop',
      agentId: input?.agent_id || null,
      agentType: input?.agent_type || null
    });
    return state;
  });

  return { exitCode: 0, stdout: null, stderr: '' };
}

function taskDenyReason(state, config) {
  if (!config.enforcement_enabled) return null;

  const budgetReason = fiveHourBudgetDecision(state, config);
  if (budgetReason) return budgetReason;

  if (config.max_agent_team_tasks_per_session === 0) {
    return 'Agent-team task denied: max_agent_team_tasks_per_session is 0.';
  }

  if (state.agentTeam.created >= config.max_agent_team_tasks_per_session) {
    return `Agent-team task denied: max_agent_team_tasks_per_session ${config.max_agent_team_tasks_per_session} already reached.`;
  }

  return null;
}

export async function handleTaskCreated(input, env = process.env) {
  const sessionId = input?.session_id || 'unknown-session';
  const config = loadConfig(env);
  let reason = null;

  await updateState(sessionId, env, (state) => {
    reason = taskDenyReason(state, config);
    if (reason) {
      state.agentTeam.denied += 1;
      pushEvent(state, {
        type: 'task-denied',
        taskId: input?.task_id || null,
        reason
      });
    } else {
      state.agentTeam.created += 1;
      state.agentTeam.active += 1;
      state.agentTeam.tasks.push({
        taskId: input?.task_id || null,
        subject: input?.task_subject || null,
        description: input?.task_description || null,
        createdAt: nowIso(),
        completedAt: null
      });
      pushEvent(state, {
        type: 'task-created',
        taskId: input?.task_id || null,
        subject: input?.task_subject || null
      });
    }
    return state;
  });

  if (reason) {
    return { exitCode: 2, stdout: null, stderr: reason };
  }

  return { exitCode: 0, stdout: null, stderr: '' };
}

export async function handleTaskCompleted(input, env = process.env) {
  const sessionId = input?.session_id || 'unknown-session';

  await updateState(sessionId, env, (state) => {
    state.agentTeam.completed += 1;
    state.agentTeam.active = Math.max(0, state.agentTeam.active - 1);
    const task = state.agentTeam.tasks.find((item) => item.taskId === input?.task_id);
    if (task) task.completedAt = nowIso();
    pushEvent(state, {
      type: 'task-completed',
      taskId: input?.task_id || null,
      subject: input?.task_subject || null
    });
    return state;
  });

  return { exitCode: 0, stdout: null, stderr: '' };
}

export async function handleUserPromptSubmit(input, env = process.env) {
  const sessionId = input?.session_id || 'unknown-session';
  const config = loadConfig(env);
  const state = await readState(sessionId, env);
  const reason = fiveHourBudgetDecision(state, config);

  if (!reason) {
    return { exitCode: 0, stdout: null, stderr: '' };
  }

  await updateState(sessionId, env, (nextState) => {
    pushEvent(nextState, { type: 'prompt-denied', reason });
    return nextState;
  });

  return {
    exitCode: 0,
    stdout: {
      decision: 'block',
      reason,
      suppressOriginalPrompt: true
    },
    stderr: ''
  };
}

async function listSessionIds(env = process.env) {
  try {
    const entries = await readdir(stateDir(env));
    const jsonEntries = await Promise.all(
      entries
        .filter((entry) => entry.endsWith('.json'))
        .map(async (entry) => {
          const filePath = path.join(stateDir(env), entry);
          const fileStat = await stat(filePath);
          return {
            sessionId: entry.slice(0, -'.json'.length),
            mtimeMs: fileStat.mtimeMs
          };
        })
    );
    return jsonEntries.sort((a, b) => b.mtimeMs - a.mtimeMs);
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
}

export async function latestSessionId(env = process.env) {
  const sessions = await listSessionIds(env);
  return sessions[0]?.sessionId || null;
}

export async function buildReport(sessionId, env = process.env) {
  const resolvedSessionId = sessionId || (await latestSessionId(env)) || 'unknown-session';
  const state = await readState(resolvedSessionId, env);
  const config = loadConfig(env);
  const fiveHour = state.rateLimits.fiveHour;
  const consumed =
    fiveHour.latestUsedPercentage !== null && fiveHour.baselineUsedPercentage !== null
      ? Math.max(0, fiveHour.latestUsedPercentage - fiveHour.baselineUsedPercentage)
      : null;

  return {
    plugin: PLUGIN_NAME,
    sessionId: resolvedSessionId,
    config,
    state,
    summary: {
      verifiedTokenLabel: `${state.subagents.verifiedTokens.toLocaleString('en-US')} verified tokens`,
      subagentLaunches: `${state.subagents.allowed}/${config.max_subagents_per_session}`,
      activeSubagents: `${state.subagents.active}/${config.max_concurrent_subagents}`,
      agentTeamTasks: `${state.agentTeam.created}/${config.max_agent_team_tasks_per_session}`,
      fiveHourBudget:
        consumed === null
          ? '5-hour usage unavailable'
          : `${consumed.toFixed(1)}/${config.session_five_hour_budget_percent}% points used since baseline`,
      bridgeSeen: fiveHour.bridgeSeen
    }
  };
}

export function formatReport(report) {
  const { state, config, summary } = report;
  const fiveHour = state.rateLimits.fiveHour;
  const lines = [
    `Subagent Budget Guard report for ${report.sessionId}`,
    `Enforcement: ${config.enforcement_enabled ? 'enabled' : 'disabled'}`,
    `Subagents: allowed ${state.subagents.allowed}, denied ${state.subagents.denied}, active ${state.subagents.active}, lifecycle starts ${state.subagents.lifecycleStarted}, lifecycle stops ${state.subagents.lifecycleStopped}`,
    `Verified usage: ${summary.verifiedTokenLabel}, ${state.subagents.totalToolUseCount} subagent tool calls, ${state.subagents.totalDurationMs} ms`,
    `Background launches: ${state.subagents.backgroundLaunched} lifecycle-counted, token totals pending`,
    `Agent-team tasks: created ${state.agentTeam.created}, denied ${state.agentTeam.denied}, completed ${state.agentTeam.completed}`,
    `5-hour budget: ${summary.fiveHourBudget}`
  ];

  if (fiveHour.latestUsedPercentage !== null) {
    lines.push(
      `5-hour latest: ${fiveHour.latestUsedPercentage.toFixed(1)}%, baseline ${fiveHour.baselineUsedPercentage.toFixed(1)}%, resets_at ${fiveHour.resetsAt ?? 'unknown'}`
    );
  } else {
    lines.push(
      '5-hour latest: unavailable. Run /subagent-budget-guard:setup so the statusLine bridge can capture rate_limits.five_hour.used_percentage.'
    );
  }

  return lines.join('\n');
}

function quoteShellArg(value) {
  const normalized = String(value).replace(/\\/g, '/').replace(/"/g, '\\"');
  return `"${normalized}"`;
}

function bridgeCommand(pluginRoot, pluginData) {
  const statuslinePath = path.join(pluginRoot, 'bin', 'statusline.js');
  return `node ${quoteShellArg(statuslinePath)} --data ${quoteShellArg(pluginData)}`;
}

async function ensureSettings(homeDir) {
  const claudeDir = path.join(homeDir, '.claude');
  const settingsPath = path.join(claudeDir, 'settings.json');
  await mkdir(claudeDir, { recursive: true });
  const settings = await readJson(settingsPath, {});
  return { settingsPath, settings };
}

function isBridgeStatusLine(statusLine) {
  return (
    statusLine &&
    typeof statusLine.command === 'string' &&
    statusLine.command.includes('statusline.js') &&
    statusLine.command.includes('--data')
  );
}

export async function installStatusLineBridge({
  homeDir = getHomeDir(),
  pluginRoot = getPluginRoot(),
  pluginData = getDataDir()
} = {}) {
  await mkdir(pluginData, { recursive: true });
  const { settingsPath, settings } = await ensureSettings(homeDir);
  const bridgePath = path.join(pluginData, 'statusline-bridge.json');
  const previousBridge = await readJson(bridgePath, {});
  const existing = settings.statusLine || null;
  const previousStatusLine = isBridgeStatusLine(existing)
    ? previousBridge.previousStatusLine || null
    : existing;

  const command = bridgeCommand(pluginRoot, pluginData);
  const nextStatusLine = {
    type: 'command',
    command,
    padding: existing?.padding ?? previousStatusLine?.padding ?? 0,
    refreshInterval: existing?.refreshInterval ?? 5
  };

  settings.statusLine = nextStatusLine;
  await writeJsonAtomic(settingsPath, settings);
  await writeJsonAtomic(bridgePath, {
    installedAt: nowIso(),
    pluginRoot,
    pluginData,
    previousStatusLine,
    bridgeStatusLine: nextStatusLine
  });

  return {
    installed: true,
    settingsPath,
    bridgePath,
    command,
    previousStatusLine
  };
}

export async function loadBridgeConfig(pluginData) {
  return readJson(path.join(pluginData, 'statusline-bridge.json'), {});
}

async function runPreviousStatusLine(previousStatusLine, input) {
  if (!previousStatusLine || previousStatusLine.type !== 'command') return '';
  if (!previousStatusLine.command) return '';

  return new Promise((resolve) => {
    const child = spawn(previousStatusLine.command, {
      shell: true,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'ignore']
    });
    let stdout = '';
    const timer = setTimeout(() => {
      child.kill();
      resolve('');
    }, 2500);

    child.stdout.on('data', (chunk) => {
      stdout += chunk;
      if (stdout.length > 1024 * 1024) {
        child.kill();
      }
    });
    child.on('exit', () => {
      clearTimeout(timer);
      resolve(stdout.trim());
    });
    child.on('error', () => {
      clearTimeout(timer);
      resolve('');
    });
    child.stdin.end(JSON.stringify(input));
  });
}

export async function renderStatusLine(input, {
  pluginData = getDataDir(),
  env = process.env
} = {}) {
  const nextEnv = { ...env, CLAUDE_PLUGIN_DATA: pluginData };
  await updateRateLimitFromStatusLine(input, nextEnv);
  const bridge = await loadBridgeConfig(pluginData);
  const previous = await runPreviousStatusLine(bridge.previousStatusLine, input);
  const report = await buildReport(input?.session_id, nextEnv);
  const fiveHour = report.state.rateLimits.fiveHour;

  const guardSegment =
    fiveHour.latestUsedPercentage === null
      ? `SBG agents ${report.state.subagents.active}/${report.config.max_concurrent_subagents} | 5h unknown`
      : `SBG agents ${report.state.subagents.active}/${report.config.max_concurrent_subagents} | 5h ${fiveHour.latestUsedPercentage.toFixed(1)}%`;

  return previous ? `${previous} | ${guardSegment}` : guardSegment;
}

export async function pathExists(filePath) {
  try {
    await access(filePath, fsConstants.F_OK);
    return true;
  } catch {
    return false;
  }
}

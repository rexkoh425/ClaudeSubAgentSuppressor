import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { constants as fsConstants, readFileSync } from 'node:fs';
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
import { fileURLToPath } from 'node:url';

const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export const PLUGIN_NAME = 'subagent-cap';
export const PLUGIN_ID = 'subagent-cap@subagent-tools';

export const DEFAULT_CONFIG = Object.freeze({
  max_concurrent_subagents: 0,
  max_subagent_tokens_per_session: 0,
  subagent_token_warning_threshold_percent: 95,
  session_five_hour_budget_percent: 25,
  absolute_five_hour_ceiling_percent: 95,
  enforcement_enabled: true
});

export const SETUP_CONFIG = Object.freeze({
  ...DEFAULT_CONFIG,
  max_concurrent_subagents: 1,
  max_subagent_tokens_per_session: 500000
});

export const CONFIG_KEYS = Object.freeze(Object.keys(DEFAULT_CONFIG));
export const REMOVED_CONFIG_KEYS = Object.freeze([
  'max_subagents_per_session',
  'max_agent_team_tasks_per_session'
]);

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

function settingsPathForEnv(env) {
  const homeDir = env.USERPROFILE || env.HOME;
  if (!homeDir && env !== process.env) return null;
  return path.join(homeDir || os.homedir(), '.claude', 'settings.json');
}

function readSettingsOptions(env) {
  const settingsPath = settingsPathForEnv(env);
  if (!settingsPath) return {};

  try {
    const text = readFileSync(settingsPath, 'utf8');
    const settings = JSON.parse(text.replace(/^\uFEFF/, ''));
    const options = settings?.pluginConfigs?.[PLUGIN_ID]?.options;
    return isPlainObject(options) ? options : {};
  } catch (error) {
    if (error.code === 'ENOENT') return {};
    if (error instanceof SyntaxError) return {};
    throw error;
  }
}

function applyConfigValues(config, valueForKey) {
  for (const key of CONFIG_KEYS) {
    const value = valueForKey(key);
    if (NUMBER_KEYS.has(key)) {
      config[key] = Math.max(0, asNumber(value, config[key]));
    } else if (typeof DEFAULT_CONFIG[key] === 'boolean') {
      config[key] = asBoolean(value, config[key]);
    }
  }
}

function normalizeConfig(config) {
  config.session_five_hour_budget_percent = Math.min(
    100,
    config.session_five_hour_budget_percent
  );
  config.absolute_five_hour_ceiling_percent = Math.min(
    100,
    config.absolute_five_hour_ceiling_percent
  );
  config.subagent_token_warning_threshold_percent = Math.min(
    100,
    Math.max(1, config.subagent_token_warning_threshold_percent)
  );

  return config;
}

export function loadConfig(env = process.env) {
  const config = { ...DEFAULT_CONFIG };
  const settingsOptions = readSettingsOptions(env);

  applyConfigValues(config, (key) => settingsOptions[key]);
  applyConfigValues(config, (key) => envValue(env, key));

  return normalizeConfig(config);
}

export function buildSetupConfig(overrides = {}) {
  const config = { ...SETUP_CONFIG };
  applyConfigValues(config, (key) => overrides[key]);
  return normalizeConfig(config);
}

export function getHomeDir(env = process.env) {
  return env.USERPROFILE || env.HOME || os.homedir();
}

export function getPluginRoot(env = process.env) {
  return env.CLAUDE_PLUGIN_ROOT || PACKAGE_ROOT;
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
      tokenBudgetWarnings: 0,
      tokenBudgetExceeded: false,
      lastTokenBudgetNoticeAt: null,
      queued: 0,
      queueLaunched: 0,
      queueNotices: 0,
      queue: [],
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
  return normalizeState(await readJson(stateFile(sessionId, env), initialState(sessionId)), sessionId);
}

function normalizeState(state, sessionId) {
  const fresh = initialState(sessionId);
  state.subagents = { ...fresh.subagents, ...(state.subagents || {}) };
  state.agentTeam = { ...fresh.agentTeam, ...(state.agentTeam || {}) };
  state.rateLimits = {
    ...fresh.rateLimits,
    ...(state.rateLimits || {}),
    fiveHour: {
      ...fresh.rateLimits.fiveHour,
      ...(state.rateLimits?.fiveHour || {})
    }
  };
  state.events = Array.isArray(state.events) ? state.events : [];
  return state;
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

function formatCount(value) {
  return Number(value || 0).toLocaleString('en-US');
}

function normalizeText(value) {
  return String(value || '').trim();
}

function agentIdentity(input) {
  const toolInput = input?.tool_input || {};
  return {
    description: normalizeText(toolInput.description),
    subagentType: normalizeText(toolInput.subagent_type),
    prompt: normalizeText(toolInput.prompt)
  };
}

function agentFingerprint(input) {
  const identity = agentIdentity(input);
  return createHash('sha256')
    .update(JSON.stringify(identity))
    .digest('hex');
}

function agentQueuePriority(input) {
  const identity = agentIdentity(input);
  const text = `${identity.description} ${identity.subagentType} ${identity.prompt}`.toLowerCase();

  if (/(urgent|critical|blocker|high[- ]priority|priority|asap|production)/.test(text)) {
    return 100;
  }

  if (/(security|auth|bug|failure|failing|fix|test|review)/.test(text)) {
    return 50;
  }

  return 0;
}

function queuedAgentSummary(item) {
  const type = item.subagentType || 'unknown';
  const description = item.description || 'no description';
  return `${type} "${description}"`;
}

function findQueuedAgentIndex(state, fingerprint) {
  return state.subagents.queue.findIndex((item) => item.fingerprint === fingerprint);
}

function compareQueuedAgents(a, b) {
  const priorityDiff = Number(b.priority || 0) - Number(a.priority || 0);
  if (priorityDiff !== 0) return priorityDiff;
  return String(a.queuedAt || '').localeCompare(String(b.queuedAt || ''));
}

function sortQueuedAgents(state) {
  state.subagents.queue.sort(compareQueuedAgents);
}

function queueConcurrencyDeniedAgent(state, input, reason) {
  const fingerprint = agentFingerprint(input);
  const existingIndex = findQueuedAgentIndex(state, fingerprint);
  const identity = agentIdentity(input);

  state.subagents.queued += 1;

  if (existingIndex !== -1) {
    const existing = state.subagents.queue[existingIndex];
    existing.attempts += 1;
    existing.lastQueuedAt = nowIso();
    existing.priority = Math.max(existing.priority || 0, agentQueuePriority(input));
    existing.reason = reason;
    sortQueuedAgents(state);
    pushEvent(state, {
      type: 'agent-queue-duplicate',
      queueId: existing.queueId,
      attempts: existing.attempts,
      reason
    });
    return existing;
  }

  const queueId = `queue-${fingerprint.slice(0, 12)}`;
  const item = {
    queueId,
    fingerprint,
    status: 'queued',
    priority: agentQueuePriority(input),
    attempts: 1,
    queuedAt: nowIso(),
    lastQueuedAt: nowIso(),
    lastNotifiedAt: null,
    notifyCount: 0,
    reason,
    description: identity.description || null,
    subagentType: identity.subagentType || null,
    prompt: identity.prompt || null
  };

  state.subagents.queue.push(item);
  sortQueuedAgents(state);
  pushEvent(state, {
    type: 'agent-queued',
    queueId,
    priority: item.priority,
    reason,
    description: item.description,
    subagentType: item.subagentType
  });
  return item;
}

function removeMatchingQueuedAgent(state, input) {
  const index = findQueuedAgentIndex(state, agentFingerprint(input));
  if (index === -1) return null;

  const [item] = state.subagents.queue.splice(index, 1);
  state.subagents.queueLaunched += 1;
  pushEvent(state, {
    type: 'agent-queue-launched',
    queueId: item.queueId,
    description: item.description,
    subagentType: item.subagentType
  });
  return item;
}

function nextQueuedAgent(state) {
  const queued = [...state.subagents.queue].filter((item) => item.status === 'queued');
  queued.sort(compareQueuedAgents);
  return queued[0] || null;
}

function canRetryQueuedAgent(state, config) {
  return (
    config.enforcement_enabled &&
    config.max_concurrent_subagents > 0 &&
    state.subagents.active < config.max_concurrent_subagents &&
    state.subagents.queue.length > 0
  );
}

function formatQueuedAgentContext(item, state, config) {
  const available = Math.max(0, config.max_concurrent_subagents - state.subagents.active);
  return [
    'Queued subagent ready to retry.',
    `Queue id: ${item.queueId}`,
    `Priority: ${Number(item.priority || 0)}`,
    `Attempts: ${Number(item.attempts || 0)}`,
    `Concurrency available: ${available}/${config.max_concurrent_subagents}`,
    `Subagent type: ${item.subagentType || 'unknown'}`,
    `Description: ${item.description || 'no description'}`,
    'Retry this queued Agent task before starting new lower-priority subagent work.',
    'Use the full original prompt below when retrying:',
    item.prompt || '(empty prompt)'
  ].join('\n');
}

function formatQueuedAgentPendingReason(item, state, config) {
  return [
    'Queued subagent pending. Do not start this Agent yet; retry the queued Agent task first.',
    formatQueuedAgentContext(item, state, config)
  ].join('\n\n');
}

async function buildQueuedAgentNotice(sessionId, env, hookEventName) {
  const config = loadConfig(env);
  let context = null;

  await updateState(sessionId, env, (state) => {
    if (!canRetryQueuedAgent(state, config)) return state;

    const item = nextQueuedAgent(state);
    if (!item) return state;

    item.notifyCount = Number(item.notifyCount || 0) + 1;
    item.lastNotifiedAt = nowIso();
    state.subagents.queueNotices += 1;
    context = formatQueuedAgentContext(item, state, config);
    pushEvent(state, {
      type: 'agent-queue-notice',
      queueId: item.queueId,
      hookEventName,
      notifyCount: item.notifyCount
    });
    return state;
  });

  if (!context) return null;
  return {
    exitCode: 0,
    stdout: {
      hookSpecificOutput: {
        hookEventName,
        additionalContext: context
      }
    },
    stderr: ''
  };
}

function subagentTokenBudgetStatus(state, config) {
  const limit = config.max_subagent_tokens_per_session;
  if (!limit || limit <= 0) return null;

  const used = Number(state.subagents.verifiedTokens || 0);
  const percent = limit > 0 ? (used / limit) * 100 : 0;
  const warningThreshold = config.subagent_token_warning_threshold_percent;

  return {
    used,
    limit,
    percent,
    warningThreshold,
    warningTokens: Math.ceil((limit * warningThreshold) / 100),
    atWarning: percent >= warningThreshold,
    atCap: used >= limit
  };
}

function subagentTokenBudgetDecision(state, config, { includeWarning = true } = {}) {
  if (!config.enforcement_enabled) return null;
  const status = subagentTokenBudgetStatus(state, config);
  if (!status) return null;

  if (status.atCap) {
    return {
      severity: 'cap',
      status,
      reason: `Verified subagent token cap reached: ${formatCount(status.used)}/${formatCount(status.limit)} tokens (${status.percent.toFixed(1)}%). Stop using subagents and ask the user before continuing.`
    };
  }

  if (includeWarning && status.atWarning) {
    return {
      severity: 'warning',
      status,
      reason: `Verified subagent token usage reached ${status.percent.toFixed(1)}% of the configured cap (${formatCount(status.used)}/${formatCount(status.limit)} tokens; warning threshold ${status.warningThreshold}%). Stop using subagents and ask the user before continuing.`
    };
  }

  return null;
}

function agentDenyDecision(state, config) {
  if (!config.enforcement_enabled) return null;

  const budgetReason = fiveHourBudgetDecision(state, config);
  if (budgetReason) {
    return { reason: budgetReason, queueable: false };
  }

  const tokenBudgetReason = subagentTokenBudgetDecision(state, config);
  if (tokenBudgetReason) {
    return { reason: tokenBudgetReason.reason, queueable: false };
  }

  if (config.max_concurrent_subagents === 0) {
    return {
      reason: 'Subagent launch denied: max_concurrent_subagents is 0.',
      queueable: false
    };
  }

  if (state.subagents.active >= config.max_concurrent_subagents) {
    return {
      reason: `Subagent launch queued: max_concurrent_subagents ${config.max_concurrent_subagents} already reached. Retry this queued agent when active subagents drop below the cap.`,
      queueable: true
    };
  }

  return null;
}

export async function handlePreToolUseAgent(input, env = process.env) {
  const sessionId = input?.session_id || 'unknown-session';
  const config = loadConfig(env);
  let reason = null;
  let queuedItem = null;

  await updateState(sessionId, env, (state) => {
    state.subagents.requested += 1;
    const decision = agentDenyDecision(state, config);
    reason = decision?.reason || null;
    if (decision) {
      state.subagents.denied += 1;
      if (decision.queueable) {
        queuedItem = queueConcurrencyDeniedAgent(state, input, reason);
        reason = `${reason} Queue id: ${queuedItem.queueId}.`;
      }
      pushEvent(state, {
        type: 'agent-denied',
        reason,
        description: input?.tool_input?.description || null,
        subagentType: input?.tool_input?.subagent_type || null
      });
    } else {
      const queuedBeforeLaunch = nextQueuedAgent(state);
      if (
        config.enforcement_enabled &&
        queuedBeforeLaunch &&
        queuedBeforeLaunch.fingerprint !== agentFingerprint(input)
      ) {
        queuedItem = queueConcurrencyDeniedAgent(
          state,
          input,
          'Queued subagent pending; this Agent must wait for queued work to drain.'
        );
        const nextItem = nextQueuedAgent(state) || queuedBeforeLaunch;
        reason = formatQueuedAgentPendingReason(nextItem, state, config);
        state.subagents.denied += 1;
        pushEvent(state, {
          type: 'agent-denied',
          reason,
          queueId: queuedItem.queueId,
          description: input?.tool_input?.description || null,
          subagentType: input?.tool_input?.subagent_type || null
        });
        return state;
      }

      const launchedQueuedItem = removeMatchingQueuedAgent(state, input);
      state.subagents.allowed += 1;
      pushEvent(state, {
        type: 'agent-allowed',
        queueId: launchedQueuedItem?.queueId || null,
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
  const config = loadConfig(env);
  const response = input?.tool_response || {};
  const status = response.status || 'unknown';
  const totalTokens =
    numberOrNull(response.totalTokens) ?? usageTotal(response.usage || {});
  const verified = status === 'completed' && totalTokens > 0;
  let tokenBudgetNotice = null;

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
    const resolvedQueuedItem = removeMatchingQueuedAgent(state, input);

    state.subagents.runs.push(run);
    if (state.subagents.runs.length > 100) {
      state.subagents.runs = state.subagents.runs.slice(-100);
    }

    if (verified) {
      state.subagents.completed += 1;
      state.subagents.verifiedTokens += totalTokens;
      state.subagents.totalDurationMs += run.totalDurationMs;
      state.subagents.totalToolUseCount += run.totalToolUseCount;
      tokenBudgetNotice = subagentTokenBudgetDecision(state, config);
      if (tokenBudgetNotice) {
        state.subagents.tokenBudgetWarnings += 1;
        state.subagents.lastTokenBudgetNoticeAt = nowIso();
        if (tokenBudgetNotice.severity === 'cap') {
          state.subagents.tokenBudgetExceeded = true;
        }
      }
    } else if (status === 'async_launched') {
      state.subagents.backgroundLaunched += 1;
    }

    pushEvent(state, {
      type: 'agent-result',
      status,
      agentId: run.agentId,
      queueId: resolvedQueuedItem?.queueId || null,
      verified,
      totalTokens: run.totalTokens
    });
    if (tokenBudgetNotice) {
      pushEvent(state, {
        type: 'subagent-token-budget-notice',
        severity: tokenBudgetNotice.severity,
        used: tokenBudgetNotice.status.used,
        limit: tokenBudgetNotice.status.limit,
        percent: tokenBudgetNotice.status.percent
      });
    }
    return state;
  });

  if (tokenBudgetNotice) {
    return { exitCode: 2, stdout: null, stderr: tokenBudgetNotice.reason };
  }

  return { exitCode: 0, stdout: null, stderr: '' };
}

export async function handlePostToolBatch(input, env = process.env) {
  const sessionId = input?.session_id || 'unknown-session';
  const notice = await buildQueuedAgentNotice(sessionId, env, 'PostToolBatch');

  return notice || { exitCode: 0, stdout: null, stderr: '' };
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

  const notice = await buildQueuedAgentNotice(sessionId, env, 'SubagentStop');
  return notice || { exitCode: 0, stdout: null, stderr: '' };
}

function taskDenyReason(state, config) {
  if (!config.enforcement_enabled) return null;

  const budgetReason = fiveHourBudgetDecision(state, config);
  if (budgetReason) return budgetReason;

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
    const notice = await buildQueuedAgentNotice(sessionId, env, 'UserPromptSubmit');
    return notice || { exitCode: 0, stdout: null, stderr: '' };
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
  const tokenBudget = subagentTokenBudgetStatus(state, config);

  return {
    plugin: PLUGIN_NAME,
    sessionId: resolvedSessionId,
    config,
    state,
    summary: {
      verifiedTokenLabel: `${state.subagents.verifiedTokens.toLocaleString('en-US')} verified tokens`,
      subagentTokenBudget: tokenBudget
        ? `${formatCount(tokenBudget.used)}/${formatCount(tokenBudget.limit)} verified tokens (${tokenBudget.percent.toFixed(1)}%)`
        : 'no verified-token cap',
      activeSubagents: `${state.subagents.active}/${config.max_concurrent_subagents}`,
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
    `Subagent Cap report for ${report.sessionId}`,
    `Enforcement: ${config.enforcement_enabled ? 'enabled' : 'disabled'}`,
    `Subagents: allowed ${state.subagents.allowed}, denied ${state.subagents.denied}, active ${state.subagents.active}, lifecycle starts ${state.subagents.lifecycleStarted}, lifecycle stops ${state.subagents.lifecycleStopped}`,
    `Verified usage: ${summary.verifiedTokenLabel}, ${state.subagents.totalToolUseCount} subagent tool calls, ${state.subagents.totalDurationMs} ms`,
    `Subagent token budget: ${summary.subagentTokenBudget}`,
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
      '5-hour latest: unavailable. Run /subagent-cap:init so the statusLine bridge can capture rate_limits.five_hour.used_percentage.'
    );
  }

  return lines.join('\n');
}

function formatDuration(ms) {
  const value = Number(ms || 0);
  if (value >= 1000) return `${(value / 1000).toFixed(value % 1000 === 0 ? 0 : 1)}s`;
  return `${value}ms`;
}

export function formatSubagentView(report) {
  const runs = report.state.subagents.runs;
  const queued = report.state.subagents.queue || [];
  const lines = [
    `Sub-agent view for ${report.sessionId}`,
    `Spawned subagents: ${runs.length}`,
    `Queued subagents: ${queued.length}`,
    `Verified tokens: ${formatCount(report.state.subagents.verifiedTokens)}`,
    `Total duration: ${formatDuration(report.state.subagents.totalDurationMs)}`
  ];

  if (runs.length === 0 && queued.length === 0) {
    lines.push('No subagents recorded for this session.');
    return lines.join('\n');
  }

  for (const [index, run] of runs.entries()) {
    const type = run.subagentType || 'unknown';
    const description = run.description ? ` "${run.description}"` : '';
    lines.push(`#${index + 1} ${run.status} ${type}${description}`);
    lines.push(`  tokens: ${run.verified ? `${formatCount(run.totalTokens)} verified` : 'pending'}`);
    lines.push(`  duration: ${formatDuration(run.totalDurationMs)}`);
    lines.push(`  model: ${run.resolvedModel || 'unknown'}`);
    lines.push(`  tools: ${Number(run.totalToolUseCount || 0)}`);
  }

  if (queued.length > 0) {
    lines.push('Queued:');
    for (const item of queued) {
      lines.push(`- ${item.queueId} ${queuedAgentSummary(item)}`);
      lines.push(`  priority: ${Number(item.priority || 0)}, attempts: ${Number(item.attempts || 0)}`);
      lines.push(`  queued_at: ${item.queuedAt || 'unknown'}`);
    }
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

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function applySetupPluginConfig(
  settings,
  { pluginId = PLUGIN_ID, setupConfig = SETUP_CONFIG } = {}
) {
  if (!isPlainObject(settings.pluginConfigs)) {
    settings.pluginConfigs = {};
  }

  const currentEntry = isPlainObject(settings.pluginConfigs[pluginId])
    ? settings.pluginConfigs[pluginId]
    : {};
  const currentOptions = isPlainObject(currentEntry.options)
    ? currentEntry.options
    : {};
  const nextOptions = { ...currentOptions };
  const normalizedSetupConfig = buildSetupConfig(setupConfig);

  for (const key of REMOVED_CONFIG_KEYS) {
    delete nextOptions[key];
  }

  for (const key of CONFIG_KEYS) {
    nextOptions[key] = normalizedSetupConfig[key];
  }

  settings.pluginConfigs[pluginId] = {
    ...currentEntry,
    options: nextOptions
  };
  return nextOptions;
}

export async function installStatusLineBridge({
  homeDir = getHomeDir(),
  pluginRoot = getPluginRoot(),
  pluginData = getDataDir(),
  setupConfig = SETUP_CONFIG
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
  const pluginConfigOptions = applySetupPluginConfig(settings, { setupConfig });

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
    previousStatusLine,
    pluginConfigApplied: true,
    pluginConfigOptions
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
      ? `SBG agents ${report.state.subagents.active}/${report.config.max_concurrent_subagents} | tokens ${report.summary.subagentTokenBudget} | 5h unknown`
      : `SBG agents ${report.state.subagents.active}/${report.config.max_concurrent_subagents} | tokens ${report.summary.subagentTokenBudget} | 5h ${fiveHour.latestUsedPercentage.toFixed(1)}%`;

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

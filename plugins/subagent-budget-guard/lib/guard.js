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
  subagent_token_warning_threshold_percent: 80,
  session_five_hour_budget_percent: 10,
  absolute_five_hour_ceiling_percent: 90,
  enforcement_mode: 'subagent_only',
  enforcement_enabled: true
});

export const SETUP_CONFIG = Object.freeze({
  ...DEFAULT_CONFIG,
  max_concurrent_subagents: 2,
  max_subagent_tokens_per_session: 500000
});

export const CONFIG_KEYS = Object.freeze(Object.keys(DEFAULT_CONFIG));
export const ENFORCEMENT_MODES = Object.freeze([
  'subagent_only',
  'session_budget',
  'observe'
]);
export const REMOVED_CONFIG_KEYS = Object.freeze([
  'max_subagents_per_session',
  'max_agent_team_tasks_per_session'
]);

const LAUNCH_RESERVATION_TTL_MS = 120000;
const QUEUE_DISPATCH_LEASE_TTL_MS = 300000;

const NUMBER_KEYS = new Set(
  CONFIG_KEYS.filter((key) => typeof DEFAULT_CONFIG[key] === 'number')
);
const ENFORCEMENT_MODE_SET = new Set(ENFORCEMENT_MODES);

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

function asString(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  return String(value).trim();
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

function readSettings(env) {
  const settingsPath = settingsPathForEnv(env);
  if (!settingsPath) return {};

  try {
    const text = readFileSync(settingsPath, 'utf8');
    return JSON.parse(text.replace(/^\uFEFF/, ''));
  } catch (error) {
    if (error.code === 'ENOENT') return {};
    if (error instanceof SyntaxError) return {};
    throw error;
  }
}

function readSettingsOptions(env) {
  const options = readSettings(env)?.pluginConfigs?.[PLUGIN_ID]?.options;
  return isPlainObject(options) ? options : {};
}

function statusLineDataDirFromSettings(env) {
  const command = readSettings(env)?.statusLine?.command;
  if (typeof command !== 'string') return null;
  const match = command.match(/(?:^|\s)--data\s+(?:"([^"]+)"|'([^']+)'|(\S+))/);
  return match?.[1] || match?.[2] || match?.[3] || null;
}

function applyConfigValues(config, valueForKey) {
  for (const key of CONFIG_KEYS) {
    const value = valueForKey(key);
    if (NUMBER_KEYS.has(key)) {
      config[key] = Math.max(0, asNumber(value, config[key]));
    } else if (typeof DEFAULT_CONFIG[key] === 'boolean') {
      config[key] = asBoolean(value, config[key]);
    } else if (typeof DEFAULT_CONFIG[key] === 'string') {
      config[key] = asString(value, config[key]);
    }
  }
}

function normalizeConfig(config) {
  const enforcementMode = String(config.enforcement_mode || '')
    .trim()
    .toLowerCase()
    .replace(/-/g, '_');
  config.enforcement_mode = ENFORCEMENT_MODE_SET.has(enforcementMode)
    ? enforcementMode
    : DEFAULT_CONFIG.enforcement_mode;

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

function subagentEnforcementEnabled(config) {
  return config.enforcement_enabled && config.enforcement_mode !== 'observe';
}

function sessionBudgetEnforcementEnabled(config) {
  return config.enforcement_enabled && config.enforcement_mode === 'session_budget';
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

function dataRootDir(env = process.env) {
  return path.join(getHomeDir(env), '.claude', 'plugins', 'data');
}

function stateDirForDataDir(dataDir) {
  return path.join(dataDir, 'sessions');
}

function stateDir(env) {
  return stateDirForDataDir(getDataDir(env));
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
    transcriptPath: null,
    cwd: null,
    subagents: {
      requested: 0,
      allowed: 0,
      denied: 0,
      active: 0,
      completed: 0,
      backgroundLaunched: 0,
      launching: 0,
      launchReservations: [],
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
  state.transcriptPath = state.transcriptPath || fresh.transcriptPath;
  state.cwd = state.cwd || fresh.cwd;
  state.subagents = { ...fresh.subagents, ...(state.subagents || {}) };
  state.subagents.launchReservations = Array.isArray(state.subagents.launchReservations)
    ? state.subagents.launchReservations
    : [];
  state.subagents.launching = state.subagents.launchReservations.length;
  syncQueueItems(state);
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

function rememberSessionContext(state, input = {}) {
  if (input.transcript_path) state.transcriptPath = input.transcript_path;
  if (input.cwd) state.cwd = input.cwd;
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

function fiveHourBudgetDecision(state, config, { scope = 'subagent' } = {}) {
  const fiveHour = state.rateLimits.fiveHour;
  const latest = fiveHour.latestUsedPercentage;
  const baseline = fiveHour.baselineUsedPercentage;
  const enabled =
    scope === 'session'
      ? sessionBudgetEnforcementEnabled(config)
      : subagentEnforcementEnabled(config);

  if (!enabled) return null;
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

function subagentToolName(input) {
  const toolName = normalizeText(input?.tool_name);
  return toolName || 'Agent';
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

function syncQueueItems(state) {
  state.subagents.queue = Array.isArray(state.subagents.queue) ? state.subagents.queue : [];
  for (const item of state.subagents.queue) {
    item.status = item.status || 'queued';
    item.toolName = item.toolName || 'Agent';
    item.dispatchLeaseId = item.dispatchLeaseId || null;
    item.dispatchLeaseAt = item.dispatchLeaseAt || null;
    item.dispatchHookEventName = item.dispatchHookEventName || null;
  }
}

function syncLaunchReservationCount(state) {
  state.subagents.launchReservations = Array.isArray(state.subagents.launchReservations)
    ? state.subagents.launchReservations
    : [];
  state.subagents.launching = state.subagents.launchReservations.length;
}

function pruneStaleLaunchReservations(state) {
  syncLaunchReservationCount(state);
  const now = Date.now();
  const before = state.subagents.launchReservations.length;
  state.subagents.launchReservations = state.subagents.launchReservations.filter((item) => {
    const reservedAtMs = Date.parse(item.reservedAt || '');
    if (!Number.isFinite(reservedAtMs)) return false;
    return now - reservedAtMs < LAUNCH_RESERVATION_TTL_MS;
  });
  syncLaunchReservationCount(state);

  if (state.subagents.launchReservations.length !== before) {
    pushEvent(state, {
      type: 'agent-launch-reservation-expired',
      expired: before - state.subagents.launchReservations.length
    });
  }
}

function occupiedSubagentSlots(state) {
  syncLaunchReservationCount(state);
  return Number(state.subagents.active || 0) + Number(state.subagents.launching || 0);
}

function findLaunchReservationIndex(state, input) {
  const fingerprint = agentFingerprint(input);
  return state.subagents.launchReservations.findIndex((item) => item.fingerprint === fingerprint);
}

function matchingLaunchReservation(state, input) {
  const index = findLaunchReservationIndex(state, input);
  return index === -1 ? null : state.subagents.launchReservations[index];
}

function reserveLaunchSlot(state, input, queueId = null) {
  pruneStaleLaunchReservations(state);
  if (matchingLaunchReservation(state, input)) return null;

  const identity = agentIdentity(input);
  const reservation = {
    fingerprint: agentFingerprint(input),
    reservedAt: nowIso(),
    queueId,
    toolName: subagentToolName(input),
    toolUseId: input?.tool_use_id || null,
    description: identity.description || null,
    subagentType: identity.subagentType || null
  };

  state.subagents.launchReservations.push(reservation);
  syncLaunchReservationCount(state);
  pushEvent(state, {
    type: 'agent-launch-reserved',
    queueId,
    description: reservation.description,
    subagentType: reservation.subagentType
  });
  return reservation;
}

function releaseLaunchReservation(state, input = {}, { fallbackToOldest = true } = {}) {
  pruneStaleLaunchReservations(state);
  let index = -1;

  if (input?.tool_input) {
    index = findLaunchReservationIndex(state, input);
  }

  if (index === -1 && input?.agent_type) {
    const agentType = normalizeText(input.agent_type);
    index = state.subagents.launchReservations.findIndex(
      (item) => normalizeText(item.subagentType) === agentType
    );
  }

  if (index === -1 && fallbackToOldest && state.subagents.launchReservations.length > 0) {
    index = 0;
  }

  if (index === -1) return null;

  const [reservation] = state.subagents.launchReservations.splice(index, 1);
  syncLaunchReservationCount(state);
  pushEvent(state, {
    type: 'agent-launch-reservation-cleared',
    queueId: reservation.queueId || null,
    description: reservation.description,
    subagentType: reservation.subagentType
  });
  return reservation;
}

function queueConcurrencyDeniedAgent(state, input, reason) {
  syncQueueItems(state);
  const fingerprint = agentFingerprint(input);
  const existingIndex = findQueuedAgentIndex(state, fingerprint);
  const identity = agentIdentity(input);

  state.subagents.queued += 1;

  if (existingIndex !== -1) {
    const existing = state.subagents.queue[existingIndex];
    existing.attempts += 1;
    existing.lastQueuedAt = nowIso();
    if (existing.status !== 'dispatching') {
      existing.status = 'queued';
    }
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
    toolName: subagentToolName(input),
    status: 'queued',
    priority: agentQueuePriority(input),
    attempts: 1,
    queuedAt: nowIso(),
    lastQueuedAt: nowIso(),
    lastNotifiedAt: null,
    notifyCount: 0,
    lastNotifiedWindow: null,
    dispatchLeaseId: null,
    dispatchLeaseAt: null,
    dispatchHookEventName: null,
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
  syncQueueItems(state);
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
  pruneExpiredQueueDispatches(state);
  const queued = [...state.subagents.queue].filter((item) => item.status === 'queued');
  queued.sort(compareQueuedAgents);
  return queued[0] || null;
}

function pruneExpiredQueueDispatches(state) {
  syncQueueItems(state);
  const now = Date.now();
  for (const item of state.subagents.queue) {
    if (item.status !== 'dispatching') continue;

    const leaseAtMs = Date.parse(item.dispatchLeaseAt || '');
    if (Number.isFinite(leaseAtMs) && now - leaseAtMs < QUEUE_DISPATCH_LEASE_TTL_MS) {
      continue;
    }

    item.status = 'queued';
    item.dispatchLeaseId = null;
    item.dispatchLeaseAt = null;
    item.dispatchHookEventName = null;
    pushEvent(state, {
      type: 'agent-queue-dispatch-lease-expired',
      queueId: item.queueId
    });
  }
  sortQueuedAgents(state);
}

function activeDispatchQueuedAgent(state) {
  pruneExpiredQueueDispatches(state);
  const dispatching = state.subagents.queue.filter((item) => item.status === 'dispatching');
  dispatching.sort(compareQueuedAgents);
  return dispatching[0] || null;
}

function canRetryQueuedAgent(state, config) {
  return (
    subagentEnforcementEnabled(config) &&
    config.max_concurrent_subagents > 0 &&
    occupiedSubagentSlots(state) < config.max_concurrent_subagents &&
    !activeDispatchQueuedAgent(state) &&
    state.subagents.queue.some((item) => item.status === 'queued')
  );
}

function formatQueuedAgentContext(item, state, config) {
  const available = Math.max(0, config.max_concurrent_subagents - occupiedSubagentSlots(state));
  const toolName = item.toolName || 'Agent';
  return [
    'SUBAGENT_QUEUE_DISPATCH',
    'Queued subagent ready to launch.',
    `Queue id: ${item.queueId}`,
    `Dispatch lease: ${item.dispatchLeaseId || 'none'}`,
    `Priority: ${Number(item.priority || 0)}`,
    `Attempts: ${Number(item.attempts || 0)}`,
    `Concurrency available: ${available}/${config.max_concurrent_subagents}`,
    `Subagent type: ${item.subagentType || 'unknown'}`,
    `Description: ${item.description || 'no description'}`,
    `Action: Call the ${toolName} tool exactly once now; no prose before the tool call.`,
    'Do not answer the queued prompt directly in chat.',
    'Do not launch any other queued item until another SUBAGENT_QUEUE_DISPATCH block appears.',
    `Queued subagent prompt to pass to the ${toolName} tool:`,
    item.prompt || '(empty prompt)'
  ].join('\n');
}

function formatQueuedAgentPendingReason(item, state, config) {
  const toolName = item?.toolName || 'Agent';
  return [
    `Queued subagent pending. Do not start this ${toolName} yet.`,
    `Next queued task: ${queuedAgentSummary(item)} (${item.queueId}).`,
    `Concurrency available: ${Math.max(0, config.max_concurrent_subagents - occupiedSubagentSlots(state))}/${config.max_concurrent_subagents}`,
    'Do not launch this attempted subagent call again now; wait for a queue notice for the queued task.'
  ].join('\n\n');
}

function queuedNoticeWindow(state) {
  return Number(state.subagents.lifecycleStopped || 0);
}

function leaseQueuedAgentForDispatch(state, item, hookEventName) {
  const leaseId = `dispatch-${item.fingerprint.slice(0, 12)}-${Date.now().toString(36)}`;
  item.status = 'dispatching';
  item.dispatchLeaseId = leaseId;
  item.dispatchLeaseAt = nowIso();
  item.dispatchHookEventName = hookEventName;
  item.notifyCount = Number(item.notifyCount || 0) + 1;
  item.lastNotifiedAt = nowIso();
  item.lastNotifiedWindow = queuedNoticeWindow(state);
  state.subagents.queueNotices += 1;
  pushEvent(state, {
    type: 'agent-queue-dispatch-lease',
    queueId: item.queueId,
    leaseId,
    hookEventName,
    notifyCount: item.notifyCount
  });
  return item;
}

function canNotifyQueuedAgent(item, state, { force = false, allowInitial = true } = {}) {
  if (force) return true;
  if (!allowInitial) return false;
  return item.lastNotifiedWindow !== queuedNoticeWindow(state);
}

async function buildQueuedAgentNotice(sessionId, env, hookEventName, options = {}) {
  const config = loadConfig(env);
  let context = null;

  await updateState(sessionId, env, (state) => {
    pruneStaleLaunchReservations(state);
    pruneExpiredQueueDispatches(state);
    if (!canRetryQueuedAgent(state, config)) return state;

    const item = nextQueuedAgent(state);
    if (!item) return state;
    if (!canNotifyQueuedAgent(item, state, options)) return state;

    leaseQueuedAgentForDispatch(state, item, hookEventName);
    context = formatQueuedAgentContext(item, state, config);
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
  if (!subagentEnforcementEnabled(config)) return null;
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
  if (!subagentEnforcementEnabled(config)) return null;

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

  if (occupiedSubagentSlots(state) >= config.max_concurrent_subagents) {
    const active = Number(state.subagents.active || 0);
    const launching = Number(state.subagents.launching || 0);
    return {
      reason: `Subagent launch saved to queue: max_concurrent_subagents ${config.max_concurrent_subagents} is occupied (${active} active, ${launching} starting). Do not launch this Agent call again now; wait for a queue notice after capacity opens.`,
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
    pruneStaleLaunchReservations(state);
    pruneExpiredQueueDispatches(state);
    state.subagents.requested += 1;

    const existingLaunch = matchingLaunchReservation(state, input);
    if (
      subagentEnforcementEnabled(config) &&
      config.max_concurrent_subagents > 0 &&
      existingLaunch
    ) {
      reason = `Subagent launch already accepted and is starting: ${queuedAgentSummary(existingLaunch)}. Do not launch this Agent call again now.`;
      state.subagents.denied += 1;
      pushEvent(state, {
        type: 'agent-duplicate-launch-denied',
        reason,
        description: input?.tool_input?.description || null,
        subagentType: input?.tool_input?.subagent_type || null
      });
      return state;
    }

    const dispatchItem = activeDispatchQueuedAgent(state);
    const inputFingerprint = agentFingerprint(input);
    const matchesDispatch = dispatchItem?.fingerprint === inputFingerprint;
    if (
      subagentEnforcementEnabled(config) &&
      dispatchItem &&
      !matchesDispatch
    ) {
      queuedItem = queueConcurrencyDeniedAgent(
        state,
        input,
        'Queued dispatch in progress; this Agent must wait.'
      );
      reason = [
        `Queued dispatch in progress: ${queuedAgentSummary(dispatchItem)} (${dispatchItem.queueId}).`,
        'Do not launch this Agent call now.',
        `This attempted Agent was saved to queue as ${queuedItem.queueId}.`
      ].join(' ');
      state.subagents.denied += 1;
      pushEvent(state, {
        type: 'agent-denied',
        reason,
        queueId: queuedItem.queueId,
        dispatchQueueId: dispatchItem.queueId,
        description: input?.tool_input?.description || null,
        subagentType: input?.tool_input?.subagent_type || null
      });
      return state;
    }

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
        subagentEnforcementEnabled(config) &&
        !matchesDispatch &&
        queuedBeforeLaunch &&
        queuedBeforeLaunch.fingerprint !== inputFingerprint
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
      if (subagentEnforcementEnabled(config) && config.max_concurrent_subagents > 0) {
        reserveLaunchSlot(state, input, launchedQueuedItem?.queueId || null);
      }
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
    rememberSessionContext(state, input);
    releaseLaunchReservation(state, input, { fallbackToOldest: false });
    const run = {
      at: nowIso(),
      agentId: response.agentId || null,
      toolUseId: input?.tool_use_id || null,
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
    rememberSessionContext(state, input);
    releaseLaunchReservation(state, input);
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
    rememberSessionContext(state, input);
    pruneStaleLaunchReservations(state);
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
  if (!sessionBudgetEnforcementEnabled(config)) return null;

  const budgetReason = fiveHourBudgetDecision(state, config, { scope: 'session' });
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
  const reason = fiveHourBudgetDecision(state, config, { scope: 'session' });

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

function xmlValue(text, tag) {
  const match = String(text || '').match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`));
  return match ? match[1].trim() : null;
}

function parseTaskNotification(content) {
  if (!String(content || '').includes('<task-notification>')) return null;
  const tokens = asNumber(xmlValue(content, 'subagent_tokens'), 0);
  return {
    taskId: xmlValue(content, 'task-id'),
    toolUseId: xmlValue(content, 'tool-use-id'),
    outputFile: xmlValue(content, 'output-file'),
    status: xmlValue(content, 'status') || 'unknown',
    totalTokens: tokens,
    totalToolUseCount: asNumber(xmlValue(content, 'tool_uses'), 0),
    totalDurationMs: asNumber(xmlValue(content, 'duration_ms'), 0)
  };
}

function notificationMatchesRun(notification, run) {
  if (!notification || !run) return false;
  return (
    (notification.taskId && run.agentId === notification.taskId) ||
    (notification.toolUseId && run.toolUseId === notification.toolUseId) ||
    (notification.outputFile && run.outputFile === notification.outputFile)
  );
}

async function transcriptCandidates(state, env = process.env) {
  const candidates = [];
  addUniquePath(candidates, state.transcriptPath);

  try {
    const projectsDir = path.join(getHomeDir(env), '.claude', 'projects');
    const projectDirs = await readdir(projectsDir, { withFileTypes: true });
    for (const entry of projectDirs) {
      if (!entry.isDirectory()) continue;
      addUniquePath(candidates, path.join(projectsDir, entry.name, `${sanitizeId(state.sessionId)}.jsonl`));
    }
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }

  return candidates;
}

function recomputeSubagentUsage(state) {
  const verifiedRuns = state.subagents.runs.filter((run) => run.verified);
  state.subagents.completed = verifiedRuns.length;
  state.subagents.verifiedTokens = verifiedRuns.reduce(
    (total, run) => total + asNumber(run.totalTokens, 0),
    0
  );
  state.subagents.totalDurationMs = verifiedRuns.reduce(
    (total, run) => total + asNumber(run.totalDurationMs, 0),
    0
  );
  state.subagents.totalToolUseCount = verifiedRuns.reduce(
    (total, run) => total + asNumber(run.totalToolUseCount, 0),
    0
  );
}

async function hydrateAsyncRunsFromTranscript(state, env = process.env) {
  const pendingRuns = state.subagents.runs.filter(
    (run) => !run.verified && run.status === 'async_launched'
  );
  if (pendingRuns.length === 0) return state;

  const candidates = await transcriptCandidates(state, env);
  for (const transcriptPath of candidates) {
    if (!(await pathExists(transcriptPath))) continue;
    const fileStat = await stat(transcriptPath);
    if (fileStat.size > 20 * 1024 * 1024) continue;

    const lines = (await readFile(transcriptPath, 'utf8')).split(/\r?\n/).filter(Boolean);
    for (const line of lines) {
      let entry;
      try {
        entry = JSON.parse(line);
      } catch {
        continue;
      }

      const content =
        entry.type === 'queue-operation'
          ? entry.content
          : typeof entry.message?.content === 'string'
            ? entry.message.content
            : null;
      const notification = parseTaskNotification(content);
      if (!notification || notification.status !== 'completed' || notification.totalTokens <= 0) {
        continue;
      }

      const run = pendingRuns.find((item) => notificationMatchesRun(notification, item));
      if (!run) continue;
      run.status = notification.status;
      run.totalTokens = notification.totalTokens;
      run.totalDurationMs = notification.totalDurationMs;
      run.totalToolUseCount = notification.totalToolUseCount;
      run.verified = true;
      run.usage = {
        subagent_tokens: notification.totalTokens,
        tool_uses: notification.totalToolUseCount,
        duration_ms: notification.totalDurationMs
      };
    }
  }

  recomputeSubagentUsage(state);
  return state;
}

async function listSessionIdsFromDataDir(dataDir) {
  try {
    const sessionsPath = stateDirForDataDir(dataDir);
    const entries = await readdir(sessionsPath);
    const jsonEntries = await Promise.all(
      entries
        .filter((entry) => entry.endsWith('.json'))
        .map(async (entry) => {
          const filePath = path.join(sessionsPath, entry);
          const fileStat = await stat(filePath);
          return {
            sessionId: entry.slice(0, -'.json'.length),
            mtimeMs: fileStat.mtimeMs,
            dataDir
          };
        })
    );
    return jsonEntries.sort((a, b) => b.mtimeMs - a.mtimeMs);
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
}

async function listSessionIds(env = process.env) {
  return listSessionIdsFromDataDir(getDataDir(env));
}

function addUniquePath(paths, value) {
  if (!value) return;
  const normalized = path.resolve(value);
  if (!paths.includes(normalized)) paths.push(normalized);
}

async function candidateDataDirs(env = process.env) {
  const candidates = [];
  addUniquePath(candidates, env.CLAUDE_PLUGIN_DATA);
  addUniquePath(candidates, statusLineDataDirFromSettings(env));
  addUniquePath(candidates, path.join(dataRootDir(env), PLUGIN_NAME));
  addUniquePath(candidates, path.join(dataRootDir(env), PLUGIN_ID));
  addUniquePath(candidates, path.join(dataRootDir(env), 'subagent-budget-guard'));

  try {
    const entries = await readdir(dataRootDir(env), { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory() && /subagent/i.test(entry.name)) {
        addUniquePath(candidates, path.join(dataRootDir(env), entry.name));
      }
    }
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }

  return candidates;
}

async function resolveReportSource(sessionId, env = process.env) {
  const dataDirs = await candidateDataDirs(env);
  const sources = [];

  for (const dataDir of dataDirs) {
    const sessions = await listSessionIdsFromDataDir(dataDir);
    sources.push({ dataDir, sessions });
  }

  const nonEmpty = sources.filter((source) => source.sessions.length > 0);
  if (sessionId) {
    const exact = nonEmpty.find((source) =>
      source.sessions.some((item) => item.sessionId === sessionId)
    );
    if (exact) return exact;
  }

  const latest = nonEmpty
    .map((source) => ({ ...source, latestMtimeMs: source.sessions[0]?.mtimeMs || 0 }))
    .sort((a, b) => b.latestMtimeMs - a.latestMtimeMs)[0];
  if (latest) return latest;

  return {
    dataDir: getDataDir(env),
    sessions: []
  };
}

export async function latestSessionId(env = process.env) {
  const source = await resolveReportSource(null, env);
  return source.sessions[0]?.sessionId || null;
}

export async function buildReport(sessionId, env = process.env) {
  const source = await resolveReportSource(sessionId, env);
  const reportEnv = { ...env, CLAUDE_PLUGIN_DATA: source.dataDir };
  const sessions = source.sessions;
  const resolvedSessionId = sessionId || sessions[0]?.sessionId || 'unknown-session';
  const sessionFound = sessions.some((item) => item.sessionId === resolvedSessionId);
  const state = await readState(resolvedSessionId, reportEnv);
  await hydrateAsyncRunsFromTranscript(state, reportEnv);
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
    sessionFound,
    recentSessions: sessions.slice(0, 5),
    dataDir: source.dataDir,
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
    `Enforcement: ${config.enforcement_enabled ? 'enabled' : 'disabled'} (${config.enforcement_mode})`,
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
  const fiveHour = report.state.rateLimits.fiveHour;
  const lines = [
    `Sub-agent view for ${report.sessionId}`,
    `Spawned subagents: ${runs.length}`,
    `Queued subagents: ${queued.length}`,
    `Verified tokens: ${formatCount(report.state.subagents.verifiedTokens)}`,
    `Total duration: ${formatDuration(report.state.subagents.totalDurationMs)}`,
    `Configured concurrency: ${report.config.max_concurrent_subagents}`,
    `5-hour bridge: ${fiveHour.bridgeSeen ? 'observed' : 'not observed yet'}`
  ];

  if (runs.length === 0 && queued.length === 0) {
    if (!report.sessionFound) {
      lines.push('Tracking status: no saved session files found.');
    } else {
      lines.push('Tracking status: session file exists, but no Agent/Task hook events were recorded.');
    }
    lines.push(
      'Subagent run data comes from Agent/Task hooks; the statusLine bridge only provides 5-hour budget data.'
    );
    lines.push(`Data directory checked: ${report.dataDir || getDataDir()}`);
    lines.push(
      'Run at least one subagent after the plugin is loaded, or pass --session <session-id> to inspect a specific saved session.'
    );
    lines.push(
      'If this still happens after restart and after running subagents, run subagent-cap doctor --live because Claude Code is not sending matching hook events to the plugin.'
    );
    if (report.recentSessions?.length) {
      lines.push(
        `Recent sessions: ${report.recentSessions.map((item) => item.sessionId).join(', ')}`
      );
    } else {
      lines.push('Recent sessions: none');
    }
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

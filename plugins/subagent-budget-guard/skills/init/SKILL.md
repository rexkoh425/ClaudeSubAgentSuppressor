---
description: Configure Subagent Cap with guided choices and initialize the statusLine bridge.
---

# Init Subagent Cap

Keep the Claude-facing surface small. This plugin should expose only:

- `/subagent-cap:init` for setup and configuration.
- `/sub-agent-view` for reporting saved subagent usage.

Do not add more slash commands or suggest a separate slash command for each setting.

Only offer settings that map to behavior the hooks can actually enforce, or to
saved data the reporting command can verify. If Claude Code does not expose a
mid-run signal, describe the feature as post-completion reporting or omit it.

## Guided Setup

Ask the user to choose one setup path:

1. Balanced - recommended for most users.
2. Strict - lower concurrency and earlier warnings.
3. Observe Only - record usage without blocking subagents.
4. Custom - choose each setting with plain-English labels.
5. Adjust Current - change only selected settings and preserve the rest.

Preset values:

```text
Balanced
  Subagents at once: 2
  Verified session token cap: 500000
  Warning at: 80%
  5-hour budget: 10 percentage points
  5-hour ceiling: 90%
  Mode: Only limit subagents

Strict
  Subagents at once: 1
  Verified session token cap: 250000
  Warning at: 70%
  5-hour budget: 5 percentage points
  5-hour ceiling: 85%
  Mode: Only limit subagents

Observe Only
  Subagents at once: 2
  Verified session token cap: 500000
  Warning at: 80%
  5-hour budget: 10 percentage points
  5-hour ceiling: 90%
  Mode: Record only, do not block
```

## Commands To Run

If they choose Balanced, run:

```bash
node "${CLAUDE_PLUGIN_ROOT}/bin/subagent-cap.js" init --preset balanced
```

If they choose Strict, run:

```bash
node "${CLAUDE_PLUGIN_ROOT}/bin/subagent-cap.js" init --preset strict
```

If they choose Observe Only, run:

```bash
node "${CLAUDE_PLUGIN_ROOT}/bin/subagent-cap.js" init --preset observe
```

If they choose Custom, ask for these plain-English values. A blank answer means
use the Balanced value:

- Subagents at once.
- Verified session token cap.
- Warning at percent.
- 5-hour budget percentage points.
- 5-hour ceiling percent.
- Mode: `subagent_only`, `session_budget`, or `observe`.
- Enforcement enabled: `true` or `false`.

Then run one command using `--preset balanced` plus `--set` for values they changed:

```bash
node "${CLAUDE_PLUGIN_ROOT}/bin/subagent-cap.js" init \
  --preset balanced \
  --set agents=<value> \
  --set session-token-cap=<value> \
  --set warn-at=<value> \
  --set five-hour-budget=<value> \
  --set five-hour-ceiling=<value> \
  --set mode=<value> \
  --set enabled=<true-or-false>
```

If they choose Adjust Current, ask which fields to change. Do not ask for every
setting. Then run one command using only the changed values:

```bash
node "${CLAUDE_PLUGIN_ROOT}/bin/subagent-cap.js" init \
  --set agents=<value> \
  --set session-token-cap=<value> \
  --set warn-at=<value> \
  --set five-hour-budget=<value> \
  --set five-hour-ceiling=<value> \
  --set mode=<value> \
  --set enabled=<true-or-false>
```

Omit unchanged `--set` entries.

The verified session token cap is checked from completed `Agent.totalTokens`
after each subagent finishes. It is not an individual running subagent limit and
cannot stop a subagent mid-run.

## After Setup

Tell the user to fully exit and reopen Claude Code so the updated hooks and
statusLine bridge load for future messages.

For optional terminal verification, run:

```bash
node "${CLAUDE_PLUGIN_ROOT}/bin/subagent-cap.js" doctor --live
```

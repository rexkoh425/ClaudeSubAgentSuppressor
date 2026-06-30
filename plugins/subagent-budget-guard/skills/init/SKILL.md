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
6. Extend Current Session - raise the five-hour warning gate, session budget, and ceiling.

Preset values:

```text
Balanced
  Subagents at once: 2
  Verified session token cap: 500000
  Token warning at: 80%
  5-hour warning gate: 75%
  5-hour budget: 10 percentage points
  5-hour ceiling: 85%
  Mode: Only limit subagents

Strict
  Subagents at once: 1
  Verified session token cap: 250000
  Token warning at: 70%
  5-hour warning gate: 70%
  5-hour budget: 5 percentage points
  5-hour ceiling: 85%
  Mode: Only limit subagents

Observe Only
  Subagents at once: 2
  Verified session token cap: 500000
  Token warning at: 80%
  5-hour warning gate: 75%
  5-hour budget: 10 percentage points
  5-hour ceiling: 85%
  Mode: Record only, do not block
```

## Commands To Run

If they choose Balanced, run:

```bash
node "${CLAUDE_PLUGIN_ROOT}/bin/setup.js" --preset balanced
```

If they choose Strict, run:

```bash
node "${CLAUDE_PLUGIN_ROOT}/bin/setup.js" --preset strict
```

If they choose Observe Only, run:

```bash
node "${CLAUDE_PLUGIN_ROOT}/bin/setup.js" --preset observe
```

If they choose Custom, ask for these plain-English values. A blank answer means
use the Balanced value:

- Subagents at once.
- Verified session token cap.
- Token warning at percent.
- 5-hour warning gate percent.
- 5-hour budget percentage points.
- 5-hour ceiling percent.
- Mode: `subagent_only` or `observe`.
- Enforcement enabled: `true` or `false`.

Then run one command using `--preset balanced` plus `--set` for values they changed:

```bash
node "${CLAUDE_PLUGIN_ROOT}/bin/setup.js" \
  --preset balanced \
  --set agents=<value> \
  --set session-token-cap=<value> \
  --set warn-at=<value> \
  --set five-hour-warning=<value> \
  --set five-hour-budget=<value> \
  --set five-hour-ceiling=<value> \
  --set mode=<value> \
  --set enabled=<true-or-false>
```

If they choose Adjust Current, ask which fields to change. Do not ask for every
setting. Then run one command using only the changed values:

```bash
node "${CLAUDE_PLUGIN_ROOT}/bin/setup.js" \
  --set agents=<value> \
  --set session-token-cap=<value> \
  --set warn-at=<value> \
  --set five-hour-warning=<value> \
  --set five-hour-budget=<value> \
  --set five-hour-ceiling=<value> \
  --set mode=<value> \
  --set enabled=<true-or-false>
```

Omit unchanged `--set` entries.

If they choose Extend Current Session, explain that this only affects future
subagent launches. Already-running subagents can only report verified token
usage after they complete. Offer:

1. Default extension: `+2%`.
2. Recommended extension: choose the smaller of `+5%` or the remaining room
   before `100%`.
3. Custom extension: user-provided percentage points.

Then run:

```bash
node "${CLAUDE_PLUGIN_ROOT}/bin/setup.js" --extend-five-hour <percentage-points>
```

If the user does not choose a value, use `2`.

The verified session token cap is checked from completed subagent tool event token
totals after each subagent finishes. It is not an individual running subagent limit
and cannot stop a subagent mid-run.

Claude Code may allow model or effort changes outside this plugin, but current
hooks do not reliably expose per-subagent thinking level. Do not claim this
plugin can control or verify thinking level per subagent. `/sub-agent-view`
shows effort or thinking only if Claude Code exposes it in hook/statusLine data.

## After Setup

Tell the user to fully exit and reopen Claude Code after first setup or after a
plugin update so updated plugin hooks load for future messages. The statusLine
runner is installed at a stable plugin-data path, so normal plugin updates should
not leave Claude settings pinned to an old versioned cache path after setup has
been run once on this version.
Do not try to restart Claude Code automatically; restarting can interrupt the
active conversation and discard context.
After restart, tell them to send one normal message and then use `/sub-agent-view`.
Do not suggest terminal verification unless the user explicitly asks for it.

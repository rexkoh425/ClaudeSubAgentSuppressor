# Subagent Cap

Subagent Cap is a Claude Code plugin that limits subagent concurrency, records
verified subagent usage, and provides a post-session view of how many subagents
ran, how many tokens they used, and how long they took.

The default mode is intentionally narrow: it only controls Claude Code subagent
tool launches reported as `Agent` or `Task` hook events. Normal prompts, shell
commands, file edits, and other Claude Code tools continue normally.

## Quick Install

Inside Claude Code:

```text
/plugin marketplace add rexkoh425/ClaudeSubAgentSuppressor
/plugin install subagent-cap@subagent-tools
/subagent-cap:init
```

After init, fully exit and reopen Claude Code. The restart lets Claude Code load
the updated hooks and statusLine bridge from `settings.json`.
The plugin does not automatically restart Claude Code because that would
interrupt the active conversation and could discard unsaved context.

Then send one normal message in the new session so the statusLine bridge can see
fresh session JSON. After that, use:

```text
/sub-agent-view
```

For an existing install:

```bash
claude plugin update subagent-cap@subagent-tools
```

Then restart Claude Code.

## Slash Commands

The plugin intentionally keeps the Claude Code surface to two slash entries:

- `/subagent-cap:init` configures setup, presets, and selected setting changes.
- `/sub-agent-view` shows saved subagent usage after or during a session.

There is no separate slash command per setting. When you need to change one
setting, run `/subagent-cap:init`, choose `Adjust Current`, and change only that
field.

## Feature Bar

User-facing controls should stay useful and verifiable:

- Add a setup option only when the hook can enforce it or the report can show it
  from saved, verified data.
- If Claude Code does not expose a mid-run signal, do not present the feature as
  a mid-run limit.
- Prefer one clear setup path over extra slash commands or overlapping aliases.

## Recommended Defaults

`/subagent-cap:init` writes these values into `~/.claude/settings.json` under
`pluginConfigs.subagent-cap@subagent-tools.options`:

```text
max_concurrent_subagents=2
max_subagent_tokens_per_session=500000
subagent_token_warning_threshold_percent=80
five_hour_warning_threshold_percent=75
session_five_hour_budget_percent=10
absolute_five_hour_ceiling_percent=85
enforcement_mode=subagent_only
enforcement_enabled=true
```

Before init, the plugin is fail-closed for subagents:
`max_concurrent_subagents=0`. That prevents surprise subagent launches before
the user chooses a working configuration.

## Guided Setup Choices

`/subagent-cap:init` asks for one of these paths:

- Balanced: recommended, two subagents, 500,000 session token cap, 80% token warning, 75% five-hour warning gate, 85% five-hour ceiling.
- Strict: one subagent, 250,000 session token cap, 70% token warning, 70% five-hour warning gate, 85% five-hour ceiling.
- Observe Only: record usage without blocking subagents.
- Custom: start from Balanced and choose each value with plain-English labels.
- Adjust Current: change selected settings while preserving everything else.
- Extend Current Session: raise the current five-hour warning gate, session budget, and ceiling, with a default `+2%` option plus custom values.

`/subagent-cap:init` uses friendly setting names such as `agents`,
`session-token-cap`, `warn-at`, `five-hour-warning`, `five-hour-budget`,
`five-hour-ceiling`, `mode`, and `enabled`. Friendly names map to the stable
internal config keys, so existing installs and saved settings remain compatible.

The session token cap is verified only after each subagent completes and reports
completed subagent tool event total tokens. It is not an individual running
subagent limit and cannot stop a subagent mid-run.

## Configuration

| Key | Before init | Recommended | Meaning |
| --- | ---: | ---: | --- |
| `max_concurrent_subagents` | `0` | `2` | Maximum active or starting subagents at once. `0` blocks all subagent launches. |
| `max_subagent_tokens_per_session` | `0` | `500000` | Verified session token cap for completed subagents. `0` means no token cap. |
| `subagent_token_warning_threshold_percent` | `80` | `80` | At this percentage of the token cap, Claude is told to stop using subagents and later subagent launches are blocked. |
| `five_hour_warning_threshold_percent` | `75` | `75` | Absolute 5-hour usage warning gate. In default mode this blocks and queues new subagents until the user extends the budget. |
| `session_five_hour_budget_percent` | `10` | `10` | Percentage points the session may consume after the statusLine bridge records a baseline. In default mode this only blocks new subagents. |
| `absolute_five_hour_ceiling_percent` | `85` | `85` | Absolute 5-hour usage ceiling. In default mode this blocks new subagents without dispatching budget-blocked queue items. |
| `enforcement_mode` | `subagent_only` | `subagent_only` | Scope of blocking behavior. |
| `enforcement_enabled` | `true` | `true` | Set `false` to record activity without blocking. |

`subagent_only` is the default. It can block or queue only subagent tool launches
reported as `Agent` or `Task`. Normal user prompts are not hooked or blocked.

`observe` records usage but does not block subagent launches.

## How It Works

Claude Code exposes plugin hook events. Subagent Cap is just a set of local hook
scripts plus a statusLine bridge. It does not run a background service, install
an MCP server, or change the Claude model.

The important flow is:

```text
Claude tries Agent/Task subagent tool
  -> PreToolUse Agent/Task hook checks local state and config
  -> allowed, denied, or saved to queue

Subagent starts/stops
  -> SubagentStart/SubagentStop update active counts
  -> when capacity opens, queued work can be surfaced once

Agent/Task tool completes
  -> PostToolUse Agent/Task records verified totalTokens, duration, model, tools
  -> token warning/cap can block later subagent launches

5-hour usage reaches warning gate
  -> PreToolUse Agent/Task blocks the new subagent and saves it as budget_blocked
  -> /subagent-cap:init can extend the gate; queued work dispatches only after extension

Tool batch ends
  -> PostToolBatch may surface one queued subagent if a slot is free

User submits prompt
  -> no plugin hook runs
```

The queue is not an autonomous worker. Hooks cannot secretly spawn a subagent.
When a queued item is ready, the plugin returns a compact
`SUBAGENT_QUEUE_DISPATCH` context block telling Claude to call the matching
subagent tool exactly once for that queued item. A dispatch lease prevents
repeated reminders for the same queued work.

## Trust And Safety Model

The hard gate is scoped to `PreToolUse` for the subagent tool (`Agent` or
`Task`). That is the only place where normal default enforcement denies work.

The plugin has no runtime npm dependencies and no runtime network calls. It
writes local state under `CLAUDE_PLUGIN_DATA` and setup updates only this
plugin's config plus the Claude Code `statusLine` command.

## StatusLine Bridge

Claude Code reports 5-hour usage percentage through statusLine JSON. Subagent
Cap wraps the user's existing statusLine command, if any, and records:

```text
rate_limits.five_hour.used_percentage
rate_limits.five_hour.resets_at
```

The first observed percentage becomes the session baseline. Later values are
compared against that baseline. In default `subagent_only` mode, this budget can
deny new subagent launches but does not suppress normal prompts.

Setup points Claude Code at a stable runner in the plugin data directory:

```text
CLAUDE_PLUGIN_DATA/statusline-runner.js
```

That runner calls the latest installed Subagent Cap `statusline.js` from Claude's
plugin cache, so a normal plugin update no longer leaves `settings.json` pinned
to an older versioned cache path. If an existing statusLine command is present,
setup stores it in the plugin data directory and calls it through the bridge
instead of deleting it.

## Viewing Subagent Usage

Inside Claude Code:

```text
/sub-agent-view
```

The view reads saved local state. It can be used after a session; it does not
need live subagents to still be running.

It shows spawned count, queued and budget-blocked count, verified tokens, total
duration, 5-hour warning/ceiling state, and per-subagent status, type,
description, model, tokens, duration, and tool-call count. Token totals are
verified after completion; running subagents show pending until Claude emits
completion usage. Thinking/effort is shown only if Claude Code exposes it to
hooks.

The default text view does not print full queued prompts.

## Verification

From a cloned repo:

```bash
npm test
npm run verify:offline
claude plugin validate plugins/subagent-budget-guard --strict
```

Maintainers can also run:

```bash
cd plugins/subagent-budget-guard
npm pack --dry-run
```

The verifier does not submit Claude prompts. It validates the manifest, the
two-entry slash surface, hook shape, setup behavior, and simulated hook
decisions locally.

## Troubleshooting

If `/sub-agent-view` has no data, fully exit and reopen Claude Code after
running `/subagent-cap:init`, then send one normal message and run a new
subagent. Claude Code loads plugin hooks and the statusLine bridge when the
process starts, so setup can write the files immediately but the current Claude
Code process may not attach those hooks until restart. The plugin does not
restart Claude Code automatically because that would interrupt the active
conversation.

If `claude plugin update subagent-cap@subagent-tools` says the plugin is not
found, add the marketplace first:

```bash
claude plugin marketplace add rexkoh425/ClaudeSubAgentSuppressor
claude plugin install subagent-cap@subagent-tools
```

If subagents are all blocked, check `max_concurrent_subagents`. A value of `0`
means the plugin is still in fail-closed mode or was configured to block all
subagents.

If you want the plugin to stop blocking entirely but keep reports:

Run `/subagent-cap:init`, choose `Adjust Current`, and set `mode` to `observe`.

Restart Claude Code after changing plugin config.

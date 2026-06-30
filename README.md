# Subagent Cap

Subagent Cap is a Claude Code plugin that limits subagent concurrency, records
verified subagent usage, and provides a post-session view of how many subagents
ran, how many tokens they used, and how long they took.

The default mode is intentionally narrow: it only controls Claude Code `Agent`
tool launches. Normal prompts, shell commands, file edits, and other Claude Code
tools continue normally.

## Why This Exists

Claude Code can spawn subagents through the `Agent` tool. That is useful for
parallel work, but it can also consume a lot of usage quickly or become noisy
when too many agents are started at once.

Subagent Cap adds a small guardrail around that one capability:

- Limit how many subagents can run at the same time.
- Queue subagent attempts that were blocked only because the concurrency cap was full.
- Retry queued work through Claude-visible context when capacity opens.
- Track completed subagent token totals and duration.
- Show saved subagent history with `/sub-agent-view`.
- Optionally enforce a broader 5-hour session budget if the user explicitly enables it.

## Quick Install

Inside Claude Code:

```text
/plugin marketplace add rexkoh425/ClaudeSubAgentSuppressor
/plugin install subagent-cap@subagent-tools
/subagent-cap:init
```

After init, fully exit and reopen Claude Code. The restart lets Claude Code load
the updated hooks and statusLine bridge from `settings.json`.

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

`/subagent-cap:init` writes these recommended values into
`~/.claude/settings.json` under
`pluginConfigs.subagent-cap@subagent-tools.options`:

```text
max_concurrent_subagents=2
max_subagent_tokens_per_session=500000
subagent_token_warning_threshold_percent=80
session_five_hour_budget_percent=10
absolute_five_hour_ceiling_percent=90
enforcement_mode=subagent_only
enforcement_enabled=true
```

Before init, the plugin is fail-closed for subagents:
`max_concurrent_subagents=0`. That prevents surprise subagent launches before
the user chooses a working configuration.

## Guided Setup Choices

`/subagent-cap:init` asks for one of these paths:

- Balanced: recommended, two subagents, 500,000 session token cap, 80% warning.
- Strict: one subagent, 250,000 session token cap, 70% warning.
- Observe Only: record usage without blocking subagents.
- Custom: start from Balanced and choose each value with plain-English labels.
- Adjust Current: change selected settings while preserving everything else.

The setup command uses friendly setting names:

```bash
subagent-cap init --preset balanced
subagent-cap init --preset strict
subagent-cap init --preset observe
subagent-cap init --set agents=3 --set warn-at=75
subagent-cap init --preset balanced --set session-token-cap=750000
```

Friendly names map to the stable internal config keys, so existing installs and
saved settings remain compatible.

The session token cap is verified only after each subagent completes and reports
`Agent.totalTokens`. It is not an individual running subagent limit and cannot
stop a subagent mid-run.

## Configuration

| Key | Before init | Recommended | Meaning |
| --- | ---: | ---: | --- |
| `max_concurrent_subagents` | `0` | `2` | Maximum active or starting subagents at once. `0` blocks all subagent launches. |
| `max_subagent_tokens_per_session` | `0` | `500000` | Verified session token cap for completed subagents. `0` means no token cap. |
| `subagent_token_warning_threshold_percent` | `80` | `80` | At this percentage of the token cap, Claude is told to stop using subagents and later subagent launches are blocked. |
| `session_five_hour_budget_percent` | `10` | `10` | Percentage points the session may consume after the statusLine bridge records a baseline. In default mode this only blocks new subagents. |
| `absolute_five_hour_ceiling_percent` | `90` | `90` | Absolute 5-hour usage ceiling. In default mode this only blocks new subagents. |
| `enforcement_mode` | `subagent_only` | `subagent_only` | Scope of blocking behavior. See below. |
| `enforcement_enabled` | `true` | `true` | Set `false` to record activity without blocking. |

### Enforcement Modes

`subagent_only` is the default. It can block or queue only `Agent` tool launches.
Normal user prompts and task creation are allowed even when the tracked 5-hour
budget is exhausted.

`session_budget` is stricter. It keeps the subagent limits and also allows the
plugin to suppress broader prompt/task activity after the configured 5-hour
budget is exhausted.

`observe` records usage but does not block subagent launches.

## How It Works

Claude Code exposes plugin hook events. Subagent Cap is just a set of local hook
scripts plus a statusLine bridge. It does not run a background service, install
an MCP server, or change the Claude model.

The important flow is:

```text
Claude tries Agent tool
  -> PreToolUse Agent hook checks local state and config
  -> allowed, denied, or saved to queue

Subagent starts/stops
  -> SubagentStart/SubagentStop update active counts
  -> when capacity opens, queued work can be surfaced once

Agent tool completes
  -> PostToolUse Agent records verified totalTokens, duration, model, tools
  -> token warning/cap can block later Agent launches

Tool batch ends
  -> PostToolBatch may surface one queued subagent if a slot is free

User submits prompt
  -> in default subagent_only mode this passes through without queue dispatch
  -> in session_budget mode it may block only if the 5-hour budget is exhausted
```

The queue is not an autonomous worker. Hooks cannot secretly spawn a subagent.
When a queued item is ready, the plugin returns a compact
`SUBAGENT_QUEUE_DISPATCH` context block telling Claude to call the `Agent` tool
exactly once for that queued item. A dispatch lease prevents repeated reminders
for the same queued work.

## Why It Should Not Disrupt Normal Claude Code Work

The hard gate is scoped to `PreToolUse` for the `Agent` tool. That is the only
place where normal default enforcement denies work.

Default `UserPromptSubmit` behavior is pass-through. This is important because
normal prompts should not become queue polling, repeated retries, or verbose
"thinking around" the queue.

The global hooks are used only for lightweight bookkeeping:

- `SubagentStart` and `SubagentStop` track active lifecycle counts.
- `PostToolBatch` can surface one queued subagent after tool activity completes.
- `TaskCreated` and `TaskCompleted` record task events; they do not block in default mode.
- `UserPromptSubmit` only blocks when `enforcement_mode=session_budget`.

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

If an existing statusLine command is present, setup stores it in the plugin data
directory and calls it through the bridge instead of deleting it.

## Viewing Subagent Usage

Inside Claude Code:

```text
/sub-agent-view
```

The view reads saved local state. It can be used after a session; it does not
need live subagents to still be running.

It shows:

- Spawned subagent count.
- Verified subagent token total.
- Total recorded duration.
- Queued subagents waiting for retry.
- Per-subagent status, type, description, model, tokens, duration, and tool-call count.

If you install the helper CLI from npm:

```bash
npm install -g @rex_koh/subagent-budget-guard
subagent-cap view
sub-agent-view --session <session-id>
sub-agent-view --json
```

The default text view does not print full queued prompts. JSON output includes
the full saved queue payload for debugging.

## Verification

For the npm helper CLI:

```bash
npm install -g @rex_koh/subagent-budget-guard
subagent-cap doctor --offline
```

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

The verifier does not submit Claude prompts. It validates the manifest, hook
shape, setup behavior, and simulated hook decisions locally.

## Development And Publishing

Repository layout:

```text
.claude-plugin/marketplace.json
plugins/subagent-budget-guard/
  .claude-plugin/plugin.json
  commands/sub-agent-view.md
  hooks/hooks.json
  skills/init/SKILL.md
  bin/
  lib/
  test/
```

Local development:

```bash
claude --plugin-dir ./plugins/subagent-budget-guard
```

Publish:

```bash
cd plugins/subagent-budget-guard
npm publish --access public
```

## Troubleshooting

If `/sub-agent-view` has no data, restart Claude Code after running
`/subagent-cap:init`, then send one normal message. The statusLine bridge needs a
fresh session event before the saved-state view has current session data.

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

```bash
subagent-cap init --set mode=observe
```

If you want broad session-budget blocking, opt in explicitly:

```bash
subagent-cap init --set mode=session_budget
```

Restart Claude Code after changing plugin config.

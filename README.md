# Claude Code Subagent Cap

Marketplace-ready Claude Code plugin that guards subagent usage, records verified subagent tokens, and enforces a per-session 5-hour usage budget through a statusLine bridge.

## What It Does

- Blocks new `Agent` tool subagents before they run.
- Records agent-team task creation and completion events.
- Records verified subagent token totals from completed `Agent` tool responses.
- Queues subagent launches that fail only because the concurrency cap is already full, then reminds Claude to retry the highest-priority queued item when capacity is available.
- Warns Claude to stop using subagents when verified subagent token usage reaches the configured warning threshold.
- Cross-checks actual subagent lifecycle events with `SubagentStart` and `SubagentStop`.
- Captures Claude Code `rate_limits.five_hour.used_percentage` through a one-time statusLine bridge.
- Blocks new prompts once the configured session budget or absolute 5-hour ceiling is reached.

## Install From This Marketplace

From Claude Code, add this repository as a marketplace:

```text
/plugin marketplace add rexkoh425/ClaudeSubAgentSuppressor
/plugin install subagent-cap@subagent-tools
/subagent-cap:init
/subagent-cap:doctor
/sub-agent-view
```

After `/subagent-cap:init`, fully exit and reopen Claude Code before verification so the statusLine bridge from `settings.json` is active. Some Claude Code builds do not provide an in-session plugin reload command.

Equivalent CLI commands:

```powershell
claude plugin marketplace add rexkoh425/ClaudeSubAgentSuppressor
claude plugin install subagent-cap@subagent-tools
claude
```

This is the install path anyone can use today because the repository is public.

## NPM Availability

The plugin package is npm-ready under `plugins/subagent-budget-guard` with package name `@rex_koh/subagent-budget-guard`.

Claude Code installs plugins from marketplaces. Npm can be used as a plugin source inside a marketplace entry, or users can install the helper CLIs directly after the package is published:

```powershell
npm install -g @rex_koh/subagent-budget-guard
subagent-cap doctor --offline
sub-agent-view
```

Maintainer publish command:

```powershell
cd plugins\subagent-budget-guard
npm publish --access public
```

For local development without publishing:

```powershell
claude --plugin-dir .\plugins\subagent-budget-guard
```

If `claude` is not on `PATH`, install or expose the Claude Code CLI first.

## Required Setup

Run the setup skill once after installing the plugin:

```text
/subagent-cap:init
/subagent-cap:doctor
```

The setup script updates `~/.claude/settings.json` so Claude Code runs:

```text
node <plugin-root>/bin/statusline.js --data <plugin-data>
```

If you already had a statusLine command, it is preserved in `<plugin-data>/statusline-bridge.json` and wrapped. Interact with Claude Code once after setup so the bridge receives fresh statusLine JSON.

After setup, fully exit and reopen Claude Code, then run `/subagent-cap:doctor`. This restart replaces the old in-session reload instruction.

Setup also writes the recommended plugin config into `pluginConfigs.subagent-cap@subagent-tools.options`, replacing the long `--config ...` install command:

```text
max_concurrent_subagents=1
max_subagent_tokens_per_session=100000
subagent_token_warning_threshold_percent=95
session_five_hour_budget_percent=25
absolute_five_hour_ceiling_percent=95
enforcement_enabled=true
```

For existing installs, setup removes obsolete `max_subagents_per_session` and `max_agent_team_tasks_per_session` options from this plugin's config.

The setup skill can also ask for custom values. Choose custom setup when prompted, or run the helper CLI directly:

```powershell
subagent-cap init
```

Non-interactive custom setup is also supported:

```powershell
subagent-cap init `
  --config max_concurrent_subagents=2 `
  --config max_subagent_tokens_per_session=250000 `
  --config subagent_token_warning_threshold_percent=90 `
  --config session_five_hour_budget_percent=15 `
  --config absolute_five_hour_ceiling_percent=95 `
  --config enforcement_enabled=true
```

## Configuration

The plugin reads these settings from `~/.claude/settings.json` under `pluginConfigs.subagent-cap@subagent-tools.options`. Runtime defaults remain strict until `/subagent-cap:init` applies the recommended working preset.

| Key | Manifest default | Setup value | Meaning |
| --- | ---: | ---: | --- |
| `max_concurrent_subagents` | `0` | `1` | Maximum active subagents at the same time. `0` blocks all subagents. |
| `max_subagent_tokens_per_session` | `0` | `100000` | No verified-token cap when `0`; otherwise caps verified subagent tokens after each completed subagent. |
| `subagent_token_warning_threshold_percent` | `95` | `95` | At this percentage of `max_subagent_tokens_per_session`, the plugin tells Claude to stop using subagents and blocks future subagent launches. |
| `session_five_hour_budget_percent` | `25` | `25` | Max percentage points this session may consume after the bridge records a baseline. |
| `absolute_five_hour_ceiling_percent` | `95` | `95` | Hard ceiling against Claude Code's reported 5-hour usage. |
| `enforcement_enabled` | `true` | `true` | Set false to record without blocking. |

Claude Code reports `Agent.totalTokens` after an `Agent` call completes, so token enforcement is based on verified completed subagent runs. The plugin cannot interrupt a still-running subagent mid-token because Claude Code does not expose a live per-token subagent stream to hooks. Queue retry reminders are advisory context injected after tool batches or on the next user prompt; hooks cannot autonomously launch a subagent after `SubagentStop`.

## Usage

Show the current session report:

```text
/subagent-cap:status
```

View saved subagent activity after a session:

```text
/sub-agent-view
```

`/sub-agent-view` shows how many subagents were recorded, queued subagents waiting for retry, the verified token total, total duration, and each saved subagent run with its token count, duration, model, and tool-call count.

Use the npm helper directly when you need a specific saved session or JSON output:

```powershell
sub-agent-view --session <session-id>
sub-agent-view --json
```

The queue stores the original full subagent prompt locally so Claude can retry the same work later, but the default text view shows only queue id, type, description, priority, attempts, and queued time. Use JSON output only when you need the full stored queue payload.

Run offline verification:

```text
/subagent-cap:doctor
```

Direct commands:

```powershell
npm test
npm run verify:offline
node .\plugins\subagent-budget-guard\bin\subagent-cap.js doctor --live
```

The live verifier does not submit Claude prompts. It runs local validation, checks the statusLine bridge, and runs `claude plugin validate` only when `claude` is on `PATH`.

## Distribution Shape

```text
.claude-plugin/marketplace.json
plugins/subagent-budget-guard/
  .claude-plugin/plugin.json
  hooks/hooks.json
  skills/
  bin/
  lib/
  test/
```

## Security Notes

Claude Code hooks run with the user's normal OS permissions. This plugin does not use network access and has no runtime npm dependencies. It writes session state under `CLAUDE_PLUGIN_DATA`, and setup modifies only this plugin's config plus the user's Claude Code `settings.json` statusLine field.

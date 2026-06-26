# Claude Code Agent Guard

Marketplace-ready Claude Code plugin that guards subagent usage, records verified subagent tokens, and enforces a per-session 5-hour usage budget through a statusLine bridge.

## What It Does

- Blocks new `Agent` tool subagents before they run.
- Records agent-team task creation and completion events.
- Records verified subagent token totals from completed `Agent` tool responses.
- Warns Claude to stop using subagents when verified subagent token usage reaches the configured warning threshold.
- Cross-checks actual subagent lifecycle events with `SubagentStart` and `SubagentStop`.
- Captures Claude Code `rate_limits.five_hour.used_percentage` through a one-time statusLine bridge.
- Blocks new prompts once the configured session budget or absolute 5-hour ceiling is reached.

## Install From This Marketplace

From Claude Code, add this repository as a marketplace:

```text
/plugin marketplace add rexkoh425/ClaudeSubAgentSuppressor
/plugin install agent-guard@subagent-budget-tools
/agent-guard:init
/agent-guard:doctor
```

After `/agent-guard:init`, fully exit and reopen Claude Code before verification so the statusLine bridge from `settings.json` is active. Some Claude Code builds do not provide an in-session plugin reload command.

Equivalent CLI commands:

```powershell
claude plugin marketplace add rexkoh425/ClaudeSubAgentSuppressor
claude plugin install agent-guard@subagent-budget-tools
claude
```

This is the install path anyone can use today because the repository is public.

## NPM Availability

The plugin package is npm-ready under `plugins/subagent-budget-guard` with package name `@rex_koh/subagent-budget-guard`.

Claude Code installs plugins from marketplaces. Npm can be used as a plugin source inside a marketplace entry, or users can install the helper CLIs directly after the package is published:

```powershell
npm install -g @rex_koh/subagent-budget-guard
agent-guard doctor --offline
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
/agent-guard:init
/agent-guard:doctor
```

The setup script updates `~/.claude/settings.json` so Claude Code runs:

```text
node <plugin-root>/bin/statusline.js --data <plugin-data>
```

If you already had a statusLine command, it is preserved in `<plugin-data>/statusline-bridge.json` and wrapped. Interact with Claude Code once after setup so the bridge receives fresh statusLine JSON.

After setup, fully exit and reopen Claude Code, then run `/agent-guard:doctor`. This restart replaces the old in-session reload instruction.

Setup also writes the recommended plugin config into `pluginConfigs.agent-guard@subagent-budget-tools.options`, replacing the long `--config ...` install command:

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
agent-guard init
```

Non-interactive custom setup is also supported:

```powershell
agent-guard init `
  --config max_concurrent_subagents=2 `
  --config max_subagent_tokens_per_session=250000 `
  --config subagent_token_warning_threshold_percent=90 `
  --config session_five_hour_budget_percent=15 `
  --config absolute_five_hour_ceiling_percent=95 `
  --config enforcement_enabled=true
```

## Configuration

The plugin reads these settings from `~/.claude/settings.json` under `pluginConfigs.agent-guard@subagent-budget-tools.options`. Runtime defaults remain strict until `/agent-guard:init` applies the recommended working preset.

| Key | Manifest default | Setup value | Meaning |
| --- | ---: | ---: | --- |
| `max_concurrent_subagents` | `0` | `1` | Maximum active subagents at the same time. `0` blocks all subagents. |
| `max_subagent_tokens_per_session` | `0` | `100000` | No verified-token cap when `0`; otherwise caps verified subagent tokens after each completed subagent. |
| `subagent_token_warning_threshold_percent` | `95` | `95` | At this percentage of `max_subagent_tokens_per_session`, the plugin tells Claude to stop using subagents and blocks future subagent launches. |
| `session_five_hour_budget_percent` | `25` | `25` | Max percentage points this session may consume after the bridge records a baseline. |
| `absolute_five_hour_ceiling_percent` | `95` | `95` | Hard ceiling against Claude Code's reported 5-hour usage. |
| `enforcement_enabled` | `true` | `true` | Set false to record without blocking. |

Claude Code reports `Agent.totalTokens` after an `Agent` call completes, so token enforcement is based on verified completed subagent runs. The plugin cannot interrupt a still-running subagent mid-token because Claude Code does not expose a live per-token subagent stream to hooks.

## Usage

Show the current session report:

```text
/agent-guard:status
```

Run offline verification:

```text
/agent-guard:doctor
```

Direct commands:

```powershell
npm test
npm run verify:offline
node .\plugins\subagent-budget-guard\bin\agent-guard.js doctor --live
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

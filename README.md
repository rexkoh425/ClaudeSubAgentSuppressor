# Claude Code Subagent Budget Guard

Marketplace-ready Claude Code plugin that hard-denies subagents by default, records verified subagent usage, and enforces a per-session 5-hour usage budget through a statusLine bridge.

## What It Does

- Blocks new `Agent` tool subagents before they run.
- Suppresses agent-team task creation by default.
- Records verified subagent token totals from completed `Agent` tool responses.
- Cross-checks actual subagent lifecycle events with `SubagentStart` and `SubagentStop`.
- Captures Claude Code `rate_limits.five_hour.used_percentage` through a one-time statusLine bridge.
- Blocks new prompts once the configured session budget or absolute 5-hour ceiling is reached.

## Install From This Marketplace

From Claude Code, add this repository as a marketplace:

```text
/plugin marketplace add rexkoh425/ClaudeSubAgentSuppressor
/plugin install subagent-budget-guard@subagent-budget-tools
/reload-plugins
```

Equivalent CLI commands:

```powershell
claude plugin marketplace add rexkoh425/ClaudeSubAgentSuppressor
claude plugin install subagent-budget-guard@subagent-budget-tools
```

This is the install path anyone can use today because the repository is public.

## NPM Availability

The plugin package is npm-ready under `plugins/subagent-budget-guard` with package name `subagent-budget-guard`.

Claude Code installs plugins from marketplaces. Npm can be used as a plugin source inside a marketplace entry, or users can install the helper CLIs directly after the package is published:

```powershell
npm install -g subagent-budget-guard
subagent-budget-guard-verify --offline
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

Run the setup skill once:

```text
/subagent-budget-guard:setup
```

The setup script updates `~/.claude/settings.json` so Claude Code runs:

```text
node <plugin-root>/bin/statusline.js --data <plugin-data>
```

If you already had a statusLine command, it is preserved in `<plugin-data>/statusline-bridge.json` and wrapped. Interact with Claude Code once after setup so the bridge receives fresh statusLine JSON.

## Configuration

Claude Code prompts for these `userConfig` values when the plugin is enabled. Defaults are intentionally strict:

| Key | Default | Meaning |
| --- | ---: | --- |
| `max_subagents_per_session` | `0` | Blocks all normal subagents unless raised. |
| `max_concurrent_subagents` | `0` | Blocks all concurrent subagents unless raised. |
| `max_agent_team_tasks_per_session` | `0` | Suppresses agent-team task creation unless raised. |
| `max_subagent_tokens_per_session` | `0` | No verified-token cap when set to `0`; otherwise caps verified subagent tokens. |
| `session_five_hour_budget_percent` | `25` | Max percentage points this session may consume after the bridge records a baseline. |
| `absolute_five_hour_ceiling_percent` | `95` | Hard ceiling against Claude Code's reported 5-hour usage. |
| `enforcement_enabled` | `true` | Set false to record without blocking. |

## Usage

Show the current session report:

```text
/subagent-budget-guard:report
```

Run offline verification:

```text
/subagent-budget-guard:verify
```

Direct commands:

```powershell
npm test
npm run verify:offline
node .\plugins\subagent-budget-guard\bin\verify.js --live
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

Claude Code hooks run with the user's normal OS permissions. This plugin does not use network access and has no runtime npm dependencies. It writes session state under `CLAUDE_PLUGIN_DATA`, and setup modifies only the user's Claude Code `settings.json` statusLine field.

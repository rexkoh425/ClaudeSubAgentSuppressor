# Subagent Budget Guard

Claude Code plugin that blocks subagents before setup, records verified subagent usage, and enforces a session budget against Claude Code's 5-hour usage percentage.

## Install

Recommended Claude Code install:

```text
/plugin marketplace add rexkoh425/ClaudeSubAgentSuppressor
/plugin install subagent-budget-guard@subagent-budget-tools
/subagent-budget-guard:setup
/subagent-budget-guard:verify
```

After `/subagent-budget-guard:setup`, fully exit and reopen Claude Code before verification so the statusLine bridge from `settings.json` is active. Some Claude Code builds do not provide an in-session plugin reload command.

Useful after install:

```text
/subagent-budget-guard:report
```

## NPM Package

This package is npm-ready as `@rex_koh/subagent-budget-guard`.

Claude Code plugin discovery is marketplace-based, so npm is mainly useful as a plugin source in a marketplace entry or for installing the helper CLIs:

```bash
npm install -g @rex_koh/subagent-budget-guard
subagent-budget-guard-verify --offline
```

Maintainer publish command:

```bash
npm publish --access public
```

Offline verification:

```bash
node bin/verify.js --offline
```

The plugin is strict before setup: `max_concurrent_subagents` defaults to `0`, so normal subagent launches are blocked unless raised. Run `/subagent-budget-guard:setup` to replace the long `--config ...` install command with the recommended config:

```text
max_concurrent_subagents=1
max_subagent_tokens_per_session=100000
subagent_token_warning_threshold_percent=95
session_five_hour_budget_percent=25
absolute_five_hour_ceiling_percent=95
enforcement_enabled=true
```

For existing installs, setup also removes obsolete `max_subagents_per_session` and `max_agent_team_tasks_per_session` options from this plugin's Claude settings.

`max_subagent_tokens_per_session` is enforced from verified `Agent.totalTokens` values after each completed subagent. `subagent_token_warning_threshold_percent` defaults to `95`; once verified subagent usage reaches that percentage, the plugin tells Claude to stop using subagents and blocks future subagent launches. Claude Code does not expose mid-run per-token subagent streaming to hooks, so a single running subagent can only be evaluated when it reports its final token total.

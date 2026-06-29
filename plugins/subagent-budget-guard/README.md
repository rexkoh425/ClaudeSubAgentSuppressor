# Subagent Cap

Claude Code plugin that guards subagent usage, records verified subagent tokens, and enforces a session budget against Claude Code's 5-hour usage percentage.

## Install

Recommended Claude Code install:

```text
/plugin marketplace add rexkoh425/ClaudeSubAgentSuppressor
/plugin install subagent-cap@subagent-tools
/subagent-cap:init
/sub-agent-view
```

After `/subagent-cap:init`, fully exit and reopen Claude Code so the statusLine bridge from `settings.json` is active. Some Claude Code builds do not provide an in-session plugin reload command.

`/sub-agent-view` can be run after a session to display how many subagents were spawned, queued subagents waiting for retry, the verified token total, total duration, and each saved subagent run with its token count, duration, model, and tool-call count.

## NPM Package

This package is npm-ready as `@rex_koh/subagent-budget-guard`.

Claude Code plugin discovery is marketplace-based, so npm is mainly useful as a plugin source in a marketplace entry or for installing the helper CLIs:

```bash
npm install -g @rex_koh/subagent-budget-guard
subagent-cap doctor --offline
subagent-cap status
sub-agent-view
```

`sub-agent-view` prints the latest session's recorded subagents with per-subagent status, type, description, verified token count, duration, model, tool-call count, and queued retry items. Use `sub-agent-view --session <session-id>` for a specific saved session, or `sub-agent-view --json` for machine-readable output. The same view is also available as the Claude command `/sub-agent-view` and the npm alias `subagent-cap view`.

When an `Agent` launch fails only because `max_concurrent_subagents` is already reached, the plugin stores that subagent in a local retry queue with the full original prompt. The default text view does not print full queued prompts. Once active subagents drop below the cap, the plugin injects a reminder for the highest-priority queued item after a tool batch or on the next user prompt so Claude can retry it before lower-priority new work. Hooks cannot autonomously launch a subagent after `SubagentStop`; the queue is surfaced as context for Claude's next action.

Maintainer publish command:

```bash
npm publish --access public
```

Offline verification:

```bash
node bin/verify.js --offline
```

The plugin is strict before setup: `max_concurrent_subagents` defaults to `0`, so normal subagent launches are blocked unless raised. Run `/subagent-cap:init` to choose defaults or custom values:

```text
max_concurrent_subagents=1
max_subagent_tokens_per_session=500000
subagent_token_warning_threshold_percent=95
session_five_hour_budget_percent=25
absolute_five_hour_ceiling_percent=95
enforcement_enabled=true
```

For existing installs, setup also removes obsolete `max_subagents_per_session` and `max_agent_team_tasks_per_session` options from this plugin's Claude settings.

The setup skill can ask for custom values. For direct terminal setup, use:

```bash
subagent-cap init
```

Or pass explicit values:

```bash
subagent-cap init \
  --config max_concurrent_subagents=2 \
  --config max_subagent_tokens_per_session=250000 \
  --config subagent_token_warning_threshold_percent=90 \
  --config session_five_hour_budget_percent=15 \
  --config absolute_five_hour_ceiling_percent=95 \
  --config enforcement_enabled=true
```

`max_subagent_tokens_per_session` is enforced from verified `Agent.totalTokens` values after each completed subagent. `subagent_token_warning_threshold_percent` defaults to `95`; once verified subagent usage reaches that percentage, the plugin tells Claude to stop using subagents and blocks future subagent launches. Claude Code does not expose mid-run per-token subagent streaming to hooks, so a single running subagent can only be evaluated when it reports its final token total.

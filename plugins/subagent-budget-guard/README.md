# Subagent Budget Guard

Claude Code plugin that blocks subagents by default, records verified subagent usage, and enforces a session budget against Claude Code's 5-hour usage percentage.

## Install

Recommended Claude Code install:

```text
/plugin marketplace add rexkoh425/ClaudeSubAgentSuppressor
/plugin install subagent-budget-guard@subagent-budget-tools
/reload-plugins
```

Run after install:

```text
/subagent-budget-guard:setup
/subagent-budget-guard:verify
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

The plugin is strict by default: `max_subagents_per_session`, `max_concurrent_subagents`, and `max_agent_team_tasks_per_session` all default to `0`.

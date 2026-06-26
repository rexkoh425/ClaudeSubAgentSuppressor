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

The plugin is strict by default: `max_concurrent_subagents` defaults to `0`, so normal subagent launches are blocked unless raised.

`max_subagent_tokens_per_session` is enforced from verified `Agent.totalTokens` values after each completed subagent. `subagent_token_warning_threshold_percent` defaults to `95`; once verified subagent usage reaches that percentage, the plugin tells Claude to stop using subagents and blocks future subagent launches. Claude Code does not expose mid-run per-token subagent streaming to hooks, so a single running subagent can only be evaluated when it reports its final token total.

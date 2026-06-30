---
description: Show recorded subagent count, verified tokens, and duration for saved sessions.
argument-hint: "[--session <session-id>]"
allowed-tools: Bash(node:*)
disable-model-invocation: true
---

# View Recorded Subagents

The saved subagent view is:

!`node "${CLAUDE_PLUGIN_ROOT}/bin/view.js" $ARGUMENTS`

If the command fails, show the error output and say that `/subagent-cap:init` should be used for setup or configuration. Do not suggest separate slash commands for settings.

When explaining output, be clear that token totals are verified after a subagent
completes. Thinking/effort is shown only when Claude Code exposes that metadata
to plugin hooks; otherwise it is not available to verify per subagent.

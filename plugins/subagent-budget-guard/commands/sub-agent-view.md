---
description: Show recorded subagent count, verified tokens, and duration for saved sessions.
argument-hint: "[--session <session-id>] [--json]"
allowed-tools: Bash(node:*)
disable-model-invocation: true
---

# View Recorded Subagents

The saved subagent view is:

!`node "${CLAUDE_PLUGIN_ROOT}/bin/view.js" $ARGUMENTS`

If the command fails, show the error output and say that `/subagent-cap:init` must be run before saved session data is available.

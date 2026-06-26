---
description: Install or refresh the Subagent Budget Guard statusLine bridge and apply the recommended plugin config.
disable-model-invocation: true
---

# Setup Subagent Budget Guard

Run this command:

```bash
node "${CLAUDE_PLUGIN_ROOT}/bin/setup.js"
```

This applies the recommended config in Claude settings:

```text
max_concurrent_subagents=1
max_subagent_tokens_per_session=100000
subagent_token_warning_threshold_percent=95
session_five_hour_budget_percent=25
absolute_five_hour_ceiling_percent=95
enforcement_enabled=true
```

Then tell the user to run `/reload-plugins`, interact with Claude Code once so the statusLine bridge receives fresh session JSON, and run:

```bash
node "${CLAUDE_PLUGIN_ROOT}/bin/verify.js" --live
```

The live verifier does not submit Claude prompts. It checks local plugin shape, Claude plugin validation when `claude` is on `PATH`, and whether the statusLine bridge is configured.

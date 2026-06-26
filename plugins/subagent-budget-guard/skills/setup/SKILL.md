---
description: Install or refresh the Subagent Budget Guard statusLine bridge and apply the recommended plugin config.
---

# Setup Subagent Budget Guard

Ask the user whether to use the recommended defaults or customize the values. If they choose defaults, run:

```bash
node "${CLAUDE_PLUGIN_ROOT}/bin/setup.js"
```

If they choose custom values, ask for each value below. The value in parentheses is the default; accept a blank answer as the default.

```text
max_concurrent_subagents=1
max_subagent_tokens_per_session=100000
subagent_token_warning_threshold_percent=95
session_five_hour_budget_percent=25
absolute_five_hour_ceiling_percent=95
enforcement_enabled=true
```

Then run setup with the chosen values:

```bash
node "${CLAUDE_PLUGIN_ROOT}/bin/setup.js" \
  --config max_concurrent_subagents=<value> \
  --config max_subagent_tokens_per_session=<value> \
  --config subagent_token_warning_threshold_percent=<value> \
  --config session_five_hour_budget_percent=<value> \
  --config absolute_five_hour_ceiling_percent=<value> \
  --config enforcement_enabled=<true-or-false>
```

Then tell the user to fully exit and reopen Claude Code, interact once so the statusLine bridge receives fresh session JSON, and run:

```bash
node "${CLAUDE_PLUGIN_ROOT}/bin/verify.js" --live
```

The live verifier does not submit Claude prompts. It checks local plugin shape, Claude plugin validation when `claude` is on `PATH`, and whether the statusLine bridge is configured.

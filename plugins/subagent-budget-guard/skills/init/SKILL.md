---
description: Initialize Subagent Cap settings and the statusLine bridge.
---

# Init Subagent Cap

Ask the user whether to use recommended defaults or custom values.

Recommended defaults:

```text
max_concurrent_subagents=1
max_subagent_tokens_per_session=500000
subagent_token_warning_threshold_percent=95
session_five_hour_budget_percent=25
absolute_five_hour_ceiling_percent=95
enforcement_enabled=true
```

If they choose defaults, run:

```bash
node "${CLAUDE_PLUGIN_ROOT}/bin/subagent-cap.js" init --defaults
```

If they choose custom values, ask for each value. Accept a blank answer as the default, then run:

```bash
node "${CLAUDE_PLUGIN_ROOT}/bin/subagent-cap.js" init \
  --config max_concurrent_subagents=<value> \
  --config max_subagent_tokens_per_session=<value> \
  --config subagent_token_warning_threshold_percent=<value> \
  --config session_five_hour_budget_percent=<value> \
  --config absolute_five_hour_ceiling_percent=<value> \
  --config enforcement_enabled=<true-or-false>
```

Then tell the user to fully exit and reopen Claude Code, then interact once so the statusLine bridge receives fresh session JSON.

For optional terminal verification, run:

```bash
node "${CLAUDE_PLUGIN_ROOT}/bin/subagent-cap.js" doctor --live
```

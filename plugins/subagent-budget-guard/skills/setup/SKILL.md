---
description: Install or refresh the Subagent Budget Guard statusLine bridge so 5-hour rate-limit percentages can be captured for enforcement.
disable-model-invocation: true
---

# Setup Subagent Budget Guard

Run this command:

```bash
node "${CLAUDE_PLUGIN_ROOT}/bin/setup.js"
```

Then tell the user to interact with Claude Code once so the statusLine bridge receives fresh session JSON. After that, run:

```bash
node "${CLAUDE_PLUGIN_ROOT}/bin/verify.js" --live
```

The live verifier does not submit Claude prompts. It checks local plugin shape, Claude plugin validation when `claude` is on `PATH`, and whether the statusLine bridge is configured.

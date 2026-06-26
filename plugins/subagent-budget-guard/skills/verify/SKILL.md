---
description: Verify the Subagent Budget Guard plugin without spending Claude quota, or run live local installation checks.
disable-model-invocation: true
---

# Verify Subagent Budget Guard

For default offline verification, run:

```bash
node "${CLAUDE_PLUGIN_ROOT}/bin/verify.js" --offline
```

For live local installation checks, run:

```bash
node "${CLAUDE_PLUGIN_ROOT}/bin/verify.js" --live
```

The live verifier does not submit Claude prompts. It checks local plugin shape, `claude plugin validate` when available, plugin listing shape, and statusLine bridge setup.

---
description: Verify Agent Guard installation and offline behavior.
disable-model-invocation: true
---

# Doctor Agent Guard

For default offline verification, run:

```bash
node "${CLAUDE_PLUGIN_ROOT}/bin/agent-guard.js" doctor --offline
```

For live local installation checks, run:

```bash
node "${CLAUDE_PLUGIN_ROOT}/bin/agent-guard.js" doctor --live
```

The live verifier does not submit Claude prompts. It checks local plugin shape, `claude plugin validate` when available, plugin listing shape, and statusLine bridge setup.

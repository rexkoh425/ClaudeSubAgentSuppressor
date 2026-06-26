# Subagent Budget Guard

Claude Code plugin that blocks subagents by default, records verified subagent usage, and enforces a session budget against Claude Code's 5-hour usage percentage.

Run after install:

```text
/subagent-budget-guard:setup
/subagent-budget-guard:verify
/subagent-budget-guard:report
```

Offline verification:

```bash
node bin/verify.js --offline
```

The plugin is strict by default: `max_subagents_per_session`, `max_concurrent_subagents`, and `max_agent_team_tasks_per_session` all default to `0`.

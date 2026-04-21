---
name: wsl-chrome-bridge-log-analysis
description: Analyze `wsl-chrome-bridge` debug logs for `chrome-devtools-mcp` or Playwright failures across full bridge lifecycle, including launch, path/arg normalization, version polling, pipe relay, cleanup, and CDP forwarding. Use when users report timeout, stuck sessions, process startup issues, protocol errors, or unclear bridge behavior and can provide (or derive) debug log paths.
---

# WSL Chrome Bridge Log Analysis

## Collect Inputs

Collect these three inputs before any log reading:
- `MCP actions`: Record what the user did (navigation, click, evaluate, screenshot, etc.).
- `Failure symptom`: Record exact error text and when it happened.
- `Log path`: Use user-provided path first. If missing, derive from MCP config env vars:
  - `WSL_CHROME_BRIDGE_DEBUG_FILE`
  - `WSL_CHROME_BRIDGE_DEBUG_RAW_DIR`

If one input is missing, ask only for the missing item and continue.

## Delegate Log Reading

Always use a sub-agent to read and analyze large logs. Avoid reading the full log in the main thread.

Send one message only to the sub-agent with:
- MCP actions
- failure symptom
- log path(s)
- instruction to read and follow:
  - `references/subagent-log-analysis-spec.md`

Do not inline full analysis rules in the handoff message. Keep handoff short and point to the reference file.

## Handoff Template

Use this template:

```text
Analyze wsl-chrome-bridge debug logs.
Actions: <what user did in MCP>
Problem: <exact symptom/error and timing>
Logs: <path list>

Read this spec first and follow it exactly:
<skill-root>/references/subagent-log-analysis-spec.md

Return the final report in the required format with line-number evidence.
```

## Output Requirements

Require the sub-agent result to include:
- `Summary`
- `Likely Causes (ranked)` with `path:line` evidence
- `Flow Breakpoint`
- `Missing Data`
- `Next Action`

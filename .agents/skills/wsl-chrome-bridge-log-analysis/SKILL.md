---
name: wsl-chrome-bridge-log-analysis
description: Analyze `wsl-chrome-bridge` debug logs for `chrome-devtools-mcp` or Playwright failures across full bridge lifecycle, including launch, path/arg normalization, version polling, pipe relay, cleanup, and CDP forwarding. Use when users report timeout, stuck sessions, process startup issues, protocol errors, or unclear bridge behavior and can provide (or derive) debug log paths.
---

# WSL Chrome Bridge Log Analysis

## Collect Inputs

Collect the following three inputs before reading logs:
- `MCP actions`: Note what the user did (navigate, click, evaluate, screenshot, and so on).
- `Failure symptom`: Capture the exact error text and when it occurred.
- `Log path`: Prefer the user-provided path. If it is missing, derive it from MCP config environment variables:
  - `WSL_CHROME_BRIDGE_DEBUG_FILE`
  - `WSL_CHROME_BRIDGE_DEBUG_RAW_DIR`

If any input is missing, ask only for that missing item, then continue.

## Delegate Log Reading

**Always** spawn the `wsl_chrome_bridge_log_analyst` sub-agent for this task:

Do not read full logs in the main thread.

Send a single handoff message to the sub-agent that includes:
- MCP actions
- failure symptom
- log path(s)
- an instruction to read and follow:
  - `references/subagent-log-analysis-spec.md`
- explicit delegation limits:
  - this is a delegated sub-agent task (`depth=1`)
  - do not start skill `wsl-chrome-bridge-log-analysis` in this delegated task
  - do not call `spawn_agent` or delegate further
  - analyze directly from the referenced spec and available logs only

Do not inline the full analysis rules in the handoff message. Keep the handoff concise and point to the reference file.

When spawning the sub-agent, explicitly set `agent_type` to `wsl_chrome_bridge_log_analyst`.

## Handoff Template

Use this template:

```text
Analyze wsl-chrome-bridge debug logs.
Actions: <what the user did in MCP>
Problem: <exact symptom/error and timing>
Logs: <list of log paths>

Read this spec first and follow it exactly:
<skill-root>/references/subagent-log-analysis-spec.md

Delegation limits:
- You are a delegated sub-agent (depth=1).
- Do NOT start skill `wsl-chrome-bridge-log-analysis` in this delegated task.
- Do NOT call spawn_agent or delegate further.
- Analyze directly using only the referenced spec and the provided logs.

Return the final report in the required format with line-number evidence.
```

## Output Requirements

Require the sub-agent report to include:
- `Summary`
- `Likely Causes (ranked)` with `path:line` evidence
- `Flow Breakpoint`
- `Missing Data`
- `Next Action`

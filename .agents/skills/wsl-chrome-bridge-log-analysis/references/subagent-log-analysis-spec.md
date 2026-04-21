# Sub-Agent Log Analysis Spec

Follow this spec exactly when analyzing `wsl-chrome-bridge` debug logs.

## Inputs

Read and use:
- MCP actions performed by the user
- observed failure symptom and timing
- log path(s)

If any of the three is missing, state what is missing and stop guessing.

## Log Structure

### CDP records

Parse CDP records using:
- Header line:
  - `[timestamp] CDP(<from> -> <to>) <Request|Response|Event> <method>`
- Next line:
  - JSON payload
- Optional blank separator line

Interpret directions strictly:
- `CDP(upstream -> relay)`: MCP side to bridge
- `CDP(relay -> chrome)`: bridge to Chrome
- `CDP(chrome -> relay)`: Chrome back to bridge
- `CDP(relay -> upstream)`: bridge back to MCP side

### Non-CDP lifecycle lines

Analyze these too:
- launch plan generation
- arg/path normalization decisions
- PowerShell script creation and launch command
- Chrome process start or early exit
- `/json/version` polling and `webSocketDebuggerUrl`
- relay connect/disconnect
- pipe open/close and relay termination
- cleanup results (temp script/profile)

## Required Analysis Steps

1. Verify startup integrity.
- Check launch plan, path conversion, launch, version polling, and relay connect sequence.

2. Verify direction symmetry.
- Compare `upstream -> relay` with `relay -> chrome`.
- Compare `chrome -> relay` with `relay -> upstream`.
- Flag dropped, duplicated, or reordered suspicious legs.

3. Pair request and response.
- Match by `id`.
- Flag missing response, late response, and mismatched response.

4. Trace sessions and targets.
- Track `sessionId`, `targetId`, and `method`.
- Detect conflicting, duplicated, or detached session timelines.

5. Detect explicit failure signals.
- JSON `error` fields
- timeout keywords: `timeout`, `timed out`, `deadline`, `cancelled`
- suspicious time gaps near failure time

6. Check non-CDP failure points.
- Chrome path or launch failures
- version endpoint unavailable or missing `webSocketDebuggerUrl`
- relay/pipe boundary and disconnection issues
- cleanup anomalies affecting next runs

## Output Format

Return exactly:

1. `Summary`
- Short diagnosis paragraph.

2. `Likely Causes (ranked)`
- `Cause -> Evidence (path:line, path:line) -> Confidence`

3. `Flow Breakpoint`
- First failing leg:
  - `upstream->relay`
  - `relay->chrome`
  - `chrome->relay`
  - `relay->upstream`
  - `launch/version-poll/pipe-cleanup`

4. `Missing Data`
- Minimal additional data needed to confirm root cause.

5. `Next Action`
- One highest-impact next debug action first.

## Guardrails

- Do not paste large raw log blocks.
- Include line-number evidence for every factual claim.
- If no definitive error exists, state `No clear error observed` and list suspicious patterns.
- Do not invent causes without evidence.

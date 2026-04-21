# AGENTS.md

## Project Overview

- Project name: `wsl-chrome-bridge`
- Project type: CLI bridge (not an MCP server)
- Core purpose: Allow `chrome-devtools-mcp`/`playwright-mcp` running in WSL to directly control Windows Chrome without system-level setup.
- Architecture summary:
  - Upstream: `chrome-devtools-mcp` communicates with this tool through OS pipes `fd3/fd4` (`\0`-delimited).
  - Upstream: `playwright-mcp` communicates with this tool through `remote-debugging-port`.
  - Downstream: This tool forwards traffic to Windows Chrome's CDP WebSocket via PowerShell scripts plus an embedded C# `ClientWebSocket`.

- Main runtime flow:
  1. `src/main.ts` / `src/cli.ts` collect all Chrome arguments.
  2. `src/bridge-options.ts` parses arguments and produces `BridgeLaunchPlan`.
  3. `src/bridge-runner.ts` creates temporary PowerShell scripts and launches Windows Chrome.
  4. For detailed lifecycle behavior, see [docs/BRIDGE_CONNECTION_LIFECYCLE.md](docs/BRIDGE_CONNECTION_LIFECYCLE.md)

- Key files:
  - `src/bridge-runner.ts`: main orchestrator, most critical.
  - `src/bridge-options.ts`: argument rules and rewrite logic.
  - `src/chrome-command.ts`: Chrome executable path decision logic.
  - `src/path-utils.ts` / `src/arg-normalizer.ts`: Linux-to-Windows path conversion.
  - `src/powershell.ts`: PowerShell script lifecycle management.
  - `agent-config-sample/.codex/config.toml`: sample configuration.

## Code Style Rules

- Language and style:
  - TypeScript (ESM, strict mode).
  - Prefer small functions, single responsibility, and clear naming.
  - Do not introduce abstraction layers that conflict with the existing style.
  - Every exported function must include JSDoc.
  - Every field in exported interfaces must include a comment describing its purpose.
  - Complex logic must include comments that explain why, not what.
  - Hardcoded absolute paths in code are prohibited.

- Parameters and compatibility:
  - When adding bridge-private parameters, they must be parsed in `planBridgeLaunch` and removed from passthrough.
  - Both `--flag=value` and `--flag value` formats must be supported when that parameter allows it.

- Documentation sync:
  - When parameter semantics change, update both `README.md` and `README-zh.md`.

## Security Rules

- Sensitive data handling:
  - Never include sensitive data in commits, README files, or issue replies (tokens, cookies, sessions, credentials, private URLs, internal network paths).
  - Sample configuration files must always use placeholders; never include real credentials or personal host information.
  - If debug output contains sensitive data, mask or remove it before submission.
  - Do not copy sensitive content from local temp files or logs directly into the repository.

- Temporary file handling:
  - Temporary files must only be placed in project-approved temp locations (for example `.temp/`).
  - Remove temporary files that can be safely deleted at the end of the task to avoid long-term accumulation.
  - Temporary files and debug outputs must not be tracked by Git (update `.gitignore` when needed).

## Testing Rules

- Local standard workflow:
  1. `CI=true npm test`
  2. `npm run lint:types`

- Test requirements by change type:
  - When modifying `bridge-options.ts`: you must add/update `test/unit/bridge-options.test.ts`.
  - When modifying path conversion: you must add/update `test/unit/path-utils.test.ts` or `test/unit/arg-normalizer.test.ts`.
  - When modifying CLI argument forwarding: at minimum verify `test/scenario/cli-scenario.test.ts`.

- Testing principles:
  - For rule changes, write tests before changing logic (or at least include them in the same commit).
  - If `bridge-runner.ts` is changed, clearly state uncovered e2e risks in your report.

## Special Rules And Prohibitions

- Git commit rules:
  - Follow Conventional Commits:
  - `feat:` new features
  - `fix:` bug fixes
  - `refactor:` refactoring
  - `test:` test-related changes
  - `docs:` documentation updates
  - Recommended format: `type(scope): short summary` (scope optional)
  - Keep one main topic per commit; avoid mixing unrelated changes.
  - Whether to run `git push` depends on explicit user instruction.

- Fixed npm install flow (standardized; do not change casually):
  - Default install command: `npm ci --cache .npm-cache --prefer-offline`
  - Use `npm install --cache .npm-cache --prefer-offline` only when dependency or lockfile updates are required.
  - If cache issues occur, follow this fixed order:
  1. `rm -rf .npm-cache/_cacache`
  2. Re-run the same install command (prefer `npm ci --cache .npm-cache --prefer-offline`)

- Prohibitions:
  - Do not use destructive Git operations (such as `git reset --hard` or force overwrite) unless the user explicitly requests them.
  - Do not use `git commit --amend` or rewrite history unless explicitly requested by the user.
  - Do not mix unrelated refactors or large formatting changes into the same task.
  - For documentation updates, do not update only one language version; both `README.md` and `README-zh.md` must be checked together.
  - It is strictly prohibited to use system commands such as `cat`/`perl` to create or modify file content; you must use the built-in ApplyPatch tool.

# v0.1.18 Agent Runtime Audit and Optimization Plan

## Scope

v0.1.18 should harden OpenHorse as a coding-agent runtime rather than add another surface feature. This audit covers the CLI agent loop, tool-call execution, Context Harness, session persistence/restore, and the `~/.openhorse` state directory. Existing `docs/roadmap/v0.1.18.md` focuses on MCP/plugin expansion; this plan narrows the release to runtime correctness, recoverability, and context discipline.

## Current Runtime Flow

1. `src/cli.ts` starts the REPL, loads config, memory, skills, tools, and creates a session immediately.
2. User input enters `executeChat()` through slash-command parsing.
3. `handleChat()` records the user message, creates a `ContextHarness`, builds the system prompt, and calls `query()`.
4. `query()` streams an LLM response, records assistant tool calls, executes tools, appends tool results, and repeats until no tool calls remain.
5. `handleChat()` writes session transcript messages, updates harness state, and updates session summary.
6. `/resume` loads transcript messages into `Store.conversationHistory` and restores `harnessState`.

The intended shape is good: the durable transcript contains assistant `tool_calls` followed by matching `tool` messages, while the harness injects a compact task contract and evidence into the next request.

## Key Findings

### P0: Session Lifecycle Is Split

`CommandContext` supports `ensureSession`, `setSession`, and `getSession`, but `src/cli.ts` currently passes only `sessionId`. As a result, `/resume` can restore history in the store without reliably switching the active session used by later writes. Startup also creates a session immediately, producing empty sessions and a legacy global meta file in `~/.openhorse/sessions/`.

Fix: make session creation lazy, wire the session accessors into every command context, and treat `/resume` as active-session switching.

### P0: `/resume` Semantics Need to Be Deterministic

Current `/resume` shows a picker when multiple sessions exist. The desired behavior is simpler: `/resume` always restores the latest non-empty session for the current project. Selection should be explicit via `/sessions` plus `/resume <number|id|name>`, with an optional `/resume --picker` if an interactive list is still wanted.

### P0: Transcript Integrity Must Be Validated

Tool restore correctness depends on exact ordering: assistant message with `tool_calls` first, then one `tool` message for each `tool_call_id`. Current recording is close, but there is no validator before saving or before replay. `LLMService.chatStream()` also only processes `delta.tool_calls?.[0]`, which can drop multiple streaming tool calls in a single chunk.

Fix: add transcript validation and normalize all streamed tool-call deltas by index.

### P0: Harness State Restores but Is Not a Single Source of Truth

Harness state is serialized into session meta and restored into `Store`, but the lifecycle is turn-local. Todo state, current plan, compacted history, verification evidence, and changed files are not consistently promoted into the harness capsule. Completion gating can warn/block, but the session resume path does not verify that the restored harness matches transcript state.

Fix: persist a runtime snapshot per session: transcript head/tail, harness state, current plan/todos, token usage, active model, and latest compaction capsule.

### P1: Tool Runtime Needs a Stable Result Envelope

Tools return `{ success, output, error }`, but MCP tools may return plain text, and `handleChat()` assumes `JSON.parse(event.result)` succeeds. Permission mode `ask` currently becomes a tool error instead of an actual user confirmation flow. Abort and timeout handling exists for shell commands, but MCP heartbeat timers and request timeout timers are not centrally disposed.

Fix: introduce `ToolExecutionRecord` with normalized fields, raw output, rendered summary, permission decision, duration, and abort/timeout status.

### P1: Project Identity Is Inconsistent

Sessions use `encodeProjectPath(resolveProjectPath(project))`, while memory uses a SHA256 hash of the raw project path. `~/.openhorse/projects/` therefore contains both readable session directories and hashed memory directories for the same conceptual project.

Fix: create one `ProjectIdentity` service used by session, memory, vector index, config, and MCP trust policy.

## `~/.openhorse` State Audit

Observed local state on 2026-06-13:

- `openhorse.json`: contains model settings, API base URL, fallback model, total session count, token/cost stats, and first-start timestamp. API key is present and must always be redacted in diagnostics.
- `input-history.json`: 63 input-history entries.
- `vector.db`: semantic memory database.
- `sessions/`: one legacy global session meta file remains. This likely came from a code path still creating sessions at startup or from an older build.
- `projects/`: 21 project directories. Most are memory hash directories; the current OpenHorse session directory uses a readable path key.
- `cache/` and `cost/`: currently empty.

Required cleanup: stop writing new global session files, migrate or delete legacy files through an explicit maintenance command, and avoid mixing memory/session project keys.

## v0.1.18 Implementation Plan

1. Session lifecycle hardening
   - Done: remove eager `createSession()` from startup.
   - Done: add `ensureActiveSession()`, `setActiveSession()`, and `getActiveSession()` in `cli.ts`.
   - Done: pass these functions into `CommandContext`.
   - Done: finalize only the active session on `/exit` and Ctrl-C.

2. Resume UX
   - Done: `/resume` restores the latest non-empty session for the current project.
   - Done: `/sessions` lists restorable sessions with stable numbering.
   - Done: `/resume <number|id|name>` restores an explicit target.
   - Done: `/resume --all <id|name>` does cross-project lookup only when requested.
   - Done: `/resume --picker` provides optional picker/list mode.

3. Transcript and restore validation
   - Done: add `validateSessionTranscript(sessionId)` with checks for role order, orphan tool messages, invalid JSON tool args, and missing meta.
   - Done: run validation before replay; refuse invalid history instead of sending it to the LLM.
   - Done: add tests for valid multi-tool-call turns and corrupted transcripts.

4. Harness snapshot persistence
   - Done: add a `SessionRuntimeSnapshot` JSON file beside session transcript.
   - Done: persist harness state, current plan, todos, active model, permission mode, and token usage.
   - Done: restore snapshot before the next turn and reconcile it with transcript metadata.
   - Follow-up: promote compact capsule and verification command extraction into the snapshot.

5. Tool execution envelope
   - Done: make `handleChat()` render from a tolerant result envelope instead of assuming raw JSON.
   - Done: treat plain text tool results as successful tool output.
   - Done: support all streaming `tool_calls` deltas, not only the first one.
   - Follow-up: add an interactive user-confirmation flow for `ask` permission decisions.

6. Config directory unification
   - Done: add `/doctor` to report stale global sessions, invalid transcripts, project session counts, and config-home health.
   - Done: move new memory writes to the same readable project key used by sessions.
   - Done: keep legacy hash-based memory directories as read fallback so existing memory remains available.
   - Follow-up: formalize `ProjectIdentity` as a dedicated service with schema version and migration metadata.
   - Follow-up: move vector namespaces and project config to the same project key.

7. MCP and background cleanup
   - Done: track heartbeat/reconnect/request timers and clear them on shutdown.
   - Done: clear per-request timeout handles after successful MCP responses.
   - Store MCP server health in diagnostics, not in session transcript.
   - Add tests for disconnect cleanup and pending request timeout cleanup.

## Acceptance Criteria

- Starting OpenHorse and exiting without chatting creates no session.
- After `/resume`, the next chat appends to the restored session.
- `/resume` always restores the latest current-project session unless a target is provided.
- A restored transcript with tool calls can be sent to the LLM without provider validation errors.
- Harness state, plan/todo state, and verification evidence survive restart.
- New sessions write only under `~/.openhorse/projects/<project-key>/sessions/`.
- `~/.openhorse` diagnostics redact secrets and report legacy state clearly.

## Test Plan

- `npx tsc --noEmit`
- `npx jest tests/session-storage.test.ts tests/query.test.ts tests/harness.test.ts tests/command-panel.test.ts --no-coverage --runInBand`
- `npm test -- --no-coverage`
- Manual smoke:
  - Start, exit without chat, verify no session file.
  - Chat once, exit, start again, run `/resume`, chat again, verify same session transcript grows.
  - Run a tool-calling task, restart, resume, and ask a follow-up that depends on tool history.
  - Run `/sessions`, `/resume 1`, `/session-rename 1 <name>`, and ambiguous-name conflict cases.

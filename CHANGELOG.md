# Changelog

## [0.6.0] - 2026-09-28

### Fixed
- **Enabling a skill in Paperclip's Skills panel did nothing.** `listSkills`
  hardcoded `desiredSkills: []` and only ever scanned a fixed local
  directory — it never read `config.paperclipRuntimeSkills` (the company-
  managed skill catalog) or `config.paperclipSkillSync` (the persisted
  desired-skill preference) at all. `syncSkills` was literally just an
  alias for `listSkills`, so toggling a skill in the UI never materialized
  anything and the very next listing looked identical to before — Paperclip
  itself was persisting the choice into `adapterConfig`, but nothing on the
  adapter side ever acted on it.

### Added
- Real `listSkills`/`syncSkills` in `src/server/skills.ts`, built on
  `@paperclipai/adapter-utils/server-utils` helpers
  (`readPaperclipRuntimeSkillEntries`, `resolvePaperclipDesiredSkillNames`,
  `buildPersistentSkillSnapshot`, `ensurePaperclipSkillSymlink`,
  `readInstalledSkillTargets`) — the same helpers the built-in `cursor`
  adapter uses, which has the same shape as this one (a runtime that scans
  a skills directory, no native skills API of its own). `syncSkills`
  symlinks each desired company-managed skill into the directory
  `loadSkills()` already reads from, and removes a Paperclip-managed
  symlink once it's no longer desired — without ever touching a skill the
  operator dropped in manually.
- `execute()` now also self-reconciles at the start of every run (mirroring
  the built-in `hermes` adapter's pattern, gated on
  `config.paperclipRuntimeSkills` being present so direct/test calls never
  touch a real skills directory), so a desired-skill change takes effect on
  the next run even if the Skills panel's sync endpoint was never
  re-invoked since.
- 11 new tests across `tests/skills.test.ts` and `tests/execute.test.ts`
  covering listing, syncing, required-skill defaults, and the
  execute()-time reconciliation, using real temp directories and real
  symlinks (not mocks) since this is filesystem-level behavior.

## [0.5.0] - 2026-09-28

### Fixed (behavior change)
- **The adapter no longer guesses "done."** Observed live: the CEO agent's
  final response explicitly said it was waiting on another agent's
  response, and the issue was marked `done` anyway — because the old logic
  treated "the model's turn ended with no tool call" as synonymous with
  "the work is finished" and defaulted `nextStatus` to `"done"`
  unconditionally in that case, regardless of what the text actually said.
- A plain-text final turn now leaves issue status **untouched**. The model
  already has `update_issue_status` and is already instructed (both
  `DEFAULT_SYSTEM_PROMPT` here and Paperclip's own
  `DEFAULT_PAPERCLIP_AGENT_PROMPT_TEMPLATE`) to call it explicitly with a
  real disposition before ending a heartbeat. When it doesn't, the correct
  owner of that gap is Paperclip's own `missing_disposition` recovery
  (which re-wakes the same agent and asks it to pick a real disposition),
  not a guess made in this adapter. This is a generalization of v0.4.2's
  `ask_user_questions` fix (leave status untouched, let Paperclip's own
  recovery own it) — that fix's special-case branch is no longer needed
  since the new default already does the right thing.
- `update_issue_status` calls the model makes explicitly are completely
  unaffected — this only removes the *automatic* fallback to `"done"`.
- Strengthened `DEFAULT_SYSTEM_PROMPT`: every run must end with an
  explicit disposition; if the model is blocked/waiting on something, it
  must call `update_issue_status` (status `blocked`, or leave
  `in_progress`) and explain why — not just describe that in text and stop.

## [0.4.5] - 2026-09-28

### Added
- `supportsInstructionsBundle: true` on `createServerAdapter()` — same class
  of fix as v0.4.1's `supportsLocalAgentJwt`. Without it, Paperclip's agent
  UI showed "Instructions bundles are only available for local adapters"
  for this adapter, even though `LlmConfig.instructionsFilePath` already
  existed and was already read at runtime in `execute.ts`. Paperclip's
  `resolveInstructionsPathKey()` (host's `server/src/routes/agents.ts`)
  defaults to the config key `"instructionsFilePath"` when this flag is
  true and no explicit `instructionsPathKey` is set — which is exactly this
  adapter's existing field, so no other code change was needed. The bundle
  editor writes its content to a file on the Paperclip server's own
  filesystem and points `adapterConfig.instructionsFilePath` at it; since
  `execute()` runs in-process inside that same server, this just works.
  Confirmed against the host repo: the built-in `hermes` adapter (a
  remote-API-calling adapter, same shape as this one) sets this flag too.
- Documented `maxTurns`, `autoApprove`, `skillsDir`, and
  `instructionsFilePath` in `agentConfigurationDoc` (they existed on
  `LlmConfig` and in the config schema but were missing from the adapter's
  own reference doc).

## [0.4.4] - 2026-09-28

### Fixed (unconfirmed — likely, not certain)
- Observed live: every `ask_user_questions` question rendered with exactly
  one answer choice, "Your answer" as free text — the model never supplied
  `options`, even for questions with an obvious short answer set (e.g.
  which environment to deploy to).
- Leading explanation: the model in use (`llm/gpt-oss-20b`, a small
  open-weight model) likely isn't reliably populating an *optional*,
  two-levels-nested array-of-objects field (`questions[].options[].label`)
  in a tool call, even when one would make sense — a known weak spot for
  smaller function-calling models. Nothing in the adapter's own parsing
  was silently dropping non-empty options (verified: a non-empty
  `options` array, even malformed, would have produced generic "Option N"
  labels, not zero options — the observed symptom is consistent with the
  model omitting the field entirely, not a parsing bug).
- Mitigations: the tool description is now explicit that `options` should
  be set whenever there's a nameable short list of likely answers (with a
  worked example in the description), and `options` now accepts plain
  strings (`["Staging", "Production"]`) as well as `{label, description}`
  objects — a flatter shape a weaker model is more likely to produce
  correctly. Neither is a guaranteed fix for a model that just doesn't
  attend to optional schema fields; if it persists, the more reliable fix
  is a stronger model, not more prompt engineering.

## [0.4.3] - 2026-09-28

### Fixed (unconfirmed — instrumented for diagnosis, not a verified root cause)
- Observed live: after a human answers an `ask_user_questions` interaction,
  the agent's next wake sometimes asks a similarly-worded question again
  instead of using the answer.
- Paperclip's own `renderPaperclipWakePrompt` (in
  `@paperclipai/adapter-utils/server-utils`) explicitly renders an
  "Interaction {id} is answered. The answer below is authoritative; do not
  re-ask the resolved questions." section with the human's answer when it
  recognizes a resolved-interaction wake. Our `execute.ts` called this
  inside a `try/catch` that silently swallowed any exception and fell back
  to a generic 3-line prompt containing none of that — if
  `renderPaperclipWakePrompt` throws (or returns empty) on this particular
  wake shape, the model never sees the answer at all and re-derives a
  similar question from scratch. This was unverifiable from the run log
  because the failure was silent.
- The catch block now logs the actual error via `writeRawStderr` instead of
  swallowing it, so the next occurrence will show in the run log whether
  this is really what's happening. Also added a defensive instruction (both
  in `DEFAULT_SYSTEM_PROMPT` and the generic fallback prompt) telling the
  model to treat an "Interaction ... is answered" section as authoritative
  and to check `get_issue`/`list_comments` for a prior answer before asking
  again — cheap insurance regardless of whether the render is actually
  failing.
- If the run log shows this stderr line next time, the real bug is
  upstream (in `renderPaperclipWakePrompt` or in the wake payload shape
  Paperclip sends this adapter) — bring that log line back for the next
  round of diagnosis.

## [0.4.2] - 2026-09-28

### Fixed
- Two bugs in `ask_user_questions` found live against a real Paperclip
  instance, both stemming from v0.4.0's assumption that forcing the issue
  to `in_review` after creating an interaction was correct:
  1. Paperclip's own `in_review` review-path validator
     (`assertInReviewReviewPath` in the host's issues route) rejects an
     agent-authored `in_review` transition unless it recognizes a specific
     linked review path (`reviewInteractionId`, `assigneeUserId`, an
     execution-state participant, a monitor, or a linked approval) — a bare
     `PATCH {status: "in_review"}` doesn't satisfy it even with a pending
     `ask_user_questions` interaction sitting right there. The run hard-failed
     with `invalid_issue_disposition` / `issue_status_update_failed`.
  2. Nothing stopped the model from calling `ask_user_questions` again on
     the next turn — observed in production asking the same question three
     times in a row, each creating a separate pending interaction.
- Fix: the tool loop now stops immediately once `ask_user_questions`
  successfully creates an interaction (the model cannot get a real answer
  within the same run regardless), and the post-loop disposition logic no
  longer attempts any status transition when that happens — it leaves the
  issue exactly as it was. This is sufficient: Paperclip's
  `missing_disposition` recovery (`decideSuccessfulRunHandoff` in the host
  repo) already skips any issue with a pending interaction or approval
  (`hasPendingInteractionOrApproval`), so there was never a need to move it
  to `in_review` in the first place.

## [0.4.1] - 2026-09-28

### Fixed
- **Root cause found for a run of "missing disposition" / garbled
  `ask_user_questions` incidents traced back to this adapter**:
  `createServerAdapter()` never set `supportsLocalAgentJwt: true`.
  Paperclip's heartbeat dispatcher (`server/src/services/heartbeat.ts` in
  the host repo) only mints and injects `authToken` — the agent's scoped
  Paperclip API JWT — into `execute()`'s context when the adapter declares
  this flag. Without it, `authToken` was `undefined` on every single run,
  which silently disabled every Paperclip API write the adapter makes
  (comments, status updates, issue checkout, and the new
  `ask_user_questions` tool) — while `execute()` still returned `exitCode:
  0`, because none of these degraded paths are treated as fatal (by
  design, for genuinely offline/degraded scenarios). Confirmed the built-in
  `process` adapter and the remote-API-calling `hermes` adapter (same
  shape as this one — no local execution either) both set this flag.
- Added `supportsLocalAgentJwt: true` to `createServerAdapter()`'s return
  value, plus a regression test asserting it's set.
- This was very likely the actual root cause of the `missing_disposition`
  incident diagnosed in v0.3.2 too — that fix only covers the case where an
  `authToken`/API client *exists* but a specific write call fails; it does
  nothing when there's no client at all, which is what "No authToken on
  context" in the run log means. Both fixes are complementary and both
  matter, but this one is the bigger gap.
- Note: Paperclip's server also needs `PAPERCLIP_AGENT_JWT_SECRET` (or a
  fallback `BETTER_AUTH_SECRET`) set for JWT minting to succeed at all
  (`server/src/agent-auth-jwt.ts`'s `jwtConfig()`). If `authToken` is still
  missing after upgrading to this version, that's the next thing to check
  on the Paperclip server itself — most self-hosted instances already have
  `BETTER_AUTH_SECRET` set for their own login/session auth, so this is
  unlikely to be the blocker, but it's the fallback explanation if the flag
  alone doesn't fix it.

## [0.4.0] - 2026-09-28

### Added
- New `ask_user_questions` tool, wired to Paperclip's real issue-thread
  interactions API (`POST /api/issues/:id/interactions`, `kind:
  "ask_user_questions"`). Fixes a real bug we observed in production: the
  model already knew this Paperclip capability exists (it's a public,
  documented API used by native adapters like Claude Code/Codex) but had no
  tool to call it, so it fell back to writing the JSON it would have sent as
  plain assistant text — which then got posted verbatim as a garbled raw-JSON
  issue comment instead of a real interactive question card.
- The tool exposes a simplified schema (`title`, `questions[].prompt` /
  `.required` / `.multi_select` / `.options[].label` / `.description`) and
  translates it into Paperclip's stricter storage payload (generated
  `q{n}`/`q{n}_o{n}` ids, `selectionMode`, and a single `freeText` option for
  prompt-only/no-options questions) — deliberately omitting the payload's
  optional dual-representation `questionSet` field, which is unnecessary on
  creation per its own validator.
- `execute.ts` now tracks whether an interaction was created during the run
  and routes the final disposition to `in_review` instead of `done` when it
  was — asking a question isn't "done," and Paperclip's own valid-disposition
  list treats a pending issue-thread interaction as the correct `in_review`
  path.
- `DEFAULT_SYSTEM_PROMPT` now tells the model about the tool explicitly
  rather than relying on it to infer the tool exists.
- Not yet verified end-to-end against a live Paperclip server — the payload
  shape was built by reading `packages/shared/src/validators/issue.ts` in
  the Paperclip host repo directly, not from a working example. If the real
  server rejects it, the likely culprits are the `resolverPolicy` default or
  something in the `continuationPolicy` enum.

## [0.3.2] - 2026-09-28

### Fixed
- Runs could report success (`exitCode: 0`) while leaving their issue stuck
  at `in_progress` with no terminal status, triggering Paperclip's
  `missing_disposition` recovery flow (`server/src/services/recovery/
  successful-run-handoff.ts` in the Paperclip host — fires whenever
  `run.status === "succeeded"` but the issue never left `in_progress`).
  Root cause: the final `api.updateIssue(currentIssueId, { status:
  nextStatus, ... })` call in `execute.ts` (the one that marks an issue
  `done`/`blocked` at the end of a run) was wrapped in a try/catch that only
  logged to stderr on failure — most commonly a `sameRunLock` 409 ("Issue
  run ownership conflict", see `checkoutIssue`'s doc comment in
  `paperclip-api.ts`) racing the heartbeat dispatcher's own lock. The run
  would still return `exitCode: 0` even though the disposition was never
  recorded.
- The final status update now retries once after a short delay, and if it
  still fails, the run now reports failure (`exitCode: 1`, `errorCode:
  "issue_status_update_failed"`) instead of silently succeeding — so
  Paperclip's normal run-failure handling takes over rather than its
  ambiguous-success recovery nagging the agent for a disposition it already
  tried to give.

## [0.3.1] - 2026-09-28

### Fixed
- Agent creation/edit UI showed no per-agent config fields (apiKey, baseUrl,
  systemPrompt, temperature, maxTokens, stream, reasoning, route, etc.) —
  only the generic "Adapter type" / "Model" / "Thinking effort" fields that
  Paperclip renders for every adapter type. Root cause: `createServerAdapter()`
  didn't implement the optional `getConfigSchema()` hook, so Paperclip's
  `GET /api/adapters/llm/config-schema` 404s and the UI's `SchemaConfigFields`
  component (the default `ConfigFields` renderer for non-builtin/external
  adapters) has nothing to render into the "Configuration" section.
- Added `src/server/config-schema.ts` implementing `getConfigSchema()`,
  wired into `createServerAdapter()`. Covers every `LlmConfig` field except
  `model` (intentionally excluded — Paperclip's built-in model picker in the
  "Adapter" section already owns it via `models`/`listModels`/`detectModel`).
  `apiKey` is marked `meta: { secret: true }` so Paperclip stores it as a
  managed secret reference rather than a plaintext adapterConfig value,
  matching the convention used by the built-in `hermes-gateway` adapter.
  This also surfaces `maxTurns`, `autoApprove`, `skillsDir`, and
  `instructionsFilePath` — fields `LlmConfig` already supported but that had
  no UI at all before this fix — plus `transforms`/`httpReferer`/`xTitle`,
  which existed in `buildConfig()` but were missing from the old
  `src/ui/build-config.ts` `configFields` array.
- `execute.ts`'s `transforms` handling now accepts either a `string[]` (the
  legacy path) or a comma-separated `string` (what the new config-schema
  text field produces) and normalizes to an array before sending it to the
  chat/completions request body.

## [0.3.0] - 2026-09-28

### Changed (security)
- `execute()` no longer spawns a CLI subprocess. The wired implementation
  (`src/server/execute.ts`) previously shelled out to `cli/dist/index.js`,
  which gave the model five unrestricted tools: `read_file`/`write_file`/
  `edit_file`/`list_files` (arbitrary path resolution, no sandbox root) and
  `run_command` (raw `child_process.exec`, no allowlist). Any hired agent on
  any configured endpoint had shell exec and full filesystem access on the
  host running Paperclip.
- `execute()` is now an in-process, multi-turn tool-calling loop (previously
  dead code at `src/server/execute.ts.backup`, now promoted to the live
  implementation) that only exposes scoped Paperclip-API tools from
  `src/server/tools.ts`: `get_issue`, `update_issue_status`, `add_comment`,
  `list_comments`, `create_sub_issue`, `list_issues`, `list_agents`,
  `hire_agent` (approval-gated unless `autoApprove` is set), and
  `request_approval`. It also adds an issue run-lock checkout before any
  write and a repeat-tool-call loop breaker, neither of which the CLI-proxy
  implementation had.
- The promoted implementation was reconciled with the current `baseUrl`
  generalization: it now calls `resolveEndpoints(config.baseUrl)` (from
  `src/index.ts`) for the chat and cost endpoints instead of the hardcoded
  `OPENROUTER_CHAT_ENDPOINT`/`OPENROUTER_GENERATION_ENDPOINT` constants it
  originally used, so per-agent `baseUrl` (NIM/Ollama/vLLM/DeepSeek/etc.)
  continues to work exactly as it did under the CLI-proxy implementation.
  The `/generation` cost lookup is now skipped entirely on non-OpenRouter
  endpoints rather than relying on a 404 fallback.
- The entire `cli/` subpackage (the subprocess, its unsandboxed tools, and
  its own build) has been deleted from the repo.

## [0.2.6] - 2026-05-07

### Fixed
- Server-side `execute.ts` was not reading `adapterConfig.apiKey` when
  spawning the CLI subprocess. It only forwarded `authToken` (the legacy
  OpenRouter platform-key path) into `LLM_API_KEY` / `OPENROUTER_API_KEY`,
  so even after 0.2.5 added the field to `paperclip.plugin.json` and the
  form schema, agents whose key arrives via the form (or via direct API
  `PATCH adapterConfig.apiKey`) still got `""` and the CLI exited with
  `LLM_API_KEY (or OPENROUTER_API_KEY) is required for non-localhost
  endpoints`. Now `LLM_API_KEY = config.apiKey || authToken || ""`,
  preferring the per-agent persisted key. Empirically reproduced and
  verified end-to-end against NVIDIA NIM (`integrate.api.nvidia.com/v1`,
  `moonshotai/kimi-k2.6`) — Run Heartbeat returned `succeeded` with a
  streamed assistant response and a tool call.

## [0.2.5] - 2026-05-07

### Fixed
- Restore `apiKey` and `baseUrl` fields on the `llm` adapter Configuration form
  (closes #4). The 0.2.0 rebrand dropped both fields from the form schema; the
  server-side adapter still read `config.apiKey` and `config.baseUrl` but the
  saved `adapterConfig` only contained `{ "model": "..." }`, so the spawned CLI
  exited with `LLM_API_KEY (or OPENROUTER_API_KEY) is required for non-localhost
  endpoints` on every Run Heartbeat.
  - `apiKey` is declared in `paperclip.plugin.json#configSchema.properties` as
    a password-format string and surfaced in `src/ui/build-config.ts` as a
    masked input. Persists to `adapterConfig.apiKey`.
  - `baseUrl` is a plain text input with placeholder
    `https://integrate.api.nvidia.com/v1`. Persists to `adapterConfig.baseUrl`.

### Notes
- No CLI changes. `cli/dist/index.js` already consumes `LLM_API_KEY` from env
  and `--base-url` from argv; that path is verified working.
- Prior fixes from 0.2.0 → 0.2.4 remain in place.

## [0.2.4] - 2026-05-07

### Fixed
- Adapter: heartbeats with no structured wake payload (manual "Run Heartbeat"
  with no scoped issue, or a wake context the current Paperclip schema does
  not fill in) sent an empty prompt to the CLI. The CLI then exited 1 with
  `Error: No prompt provided`, the run failed, and the transcript was empty.
  Reproduced on Paperclip v2026.428.0 with run ids
  `2e76cead-a080-4f63-8469-afe377418b9d` and
  `4eaf1afd-bd84-4da6-8380-d7024cd5fd60`.
- `src/server/execute.ts` now substitutes a concise three-line fallback
  prompt when the rendered prompt is empty so the model always has
  something to act on. The CLI's "No prompt provided" guard is unchanged
  — the fix is on the adapter side. Tools/skills are still added
  separately when present; the fallback itself contains no tool list or
  skill instructions.

### Added
- `tests/execute.test.ts` regression spec: stub CLI now optionally captures
  its stdin to a temp file; new spec asserts that a heartbeat with empty
  `ctx.context` produces a non-empty prompt of exactly 3 non-empty lines
  containing the word "heartbeat".

## [0.2.3] - 2026-05-07

### Fixed
- CLI: chat completions against NIM/vLLM/Ollama/DeepSeek-direct exited 0 with
  an empty transcript even though the upstream API returned a valid response.
  `@openrouter/ai-sdk-provider`'s Zod schema requires
  `delta.role === 'assistant'` on every continuation chunk; non-OpenRouter
  providers send `delta.role: null` on continuations (which is valid per the
  OpenAI streaming spec — `role` is required only on the first delta). Each
  continuation became an `AI_TypeValidationError` that the previous
  `streamResponse` swallowed silently. Closes #3.
- `streamResponse` now re-throws on `part.type === 'error'` instead of
  dropping it, so future schema-mismatch surprises surface immediately
  instead of disappearing into a zero-event run.

### Changed
- `cli/src/openrouter.ts` selects the underlying ai-sdk provider based on
  `LLM_BASE_URL` host: `*.openrouter.ai` (or unset) → `createOpenRouter`;
  any other host → `createOpenAICompatible` from
  `@ai-sdk/openai-compatible`, which does not enforce OpenRouter-specific
  framing.

### Added
- `@ai-sdk/openai-compatible@^0.2.16` as a CLI dependency. (Note: the
  `^2.0.46` line referenced in the issue requires `ai@5` and
  `@ai-sdk/provider@3`; the CLI ships `ai@4.3.19` / `@ai-sdk/provider@1.1.3`.
  The `0.2.16` line is the latest version of `@ai-sdk/openai-compatible`
  that targets `@ai-sdk/provider@1.1.3`, so it slots into the existing
  ecosystem with zero breaking changes. Upgrading to `2.x` would require a
  full `ai@5` migration, which is out of scope for a streaming-shape fix.)
- `tests/cli-streaming-non-openrouter.test.ts` — boots a local
  `http.createServer` that emits the OpenAI SSE chat-completions dialect
  with `delta.role: null` on continuations (the exact NIM wire shape from
  the issue). Asserts `streamResponse` yields at least one text chunk with
  the expected content and surfaces upstream error frames as thrown
  exceptions instead of swallowing them.

## [0.2.2] - 2026-05-07

### Fixed
- CLI: chat completions against non-OpenRouter providers (NVIDIA NIM, vLLM,
  Ollama, DeepSeek direct) crashed at `cli/dist/agent.js:32` with
  `TypeError: Cannot read properties of undefined (reading 'content')` because
  the `ai` SDK's `response.messages[0]` is only populated when the request
  goes through OpenRouter's framing. The CLI now reads tool calls and text
  from `result.fullStream` and reconstructs the assistant message from those
  chunks, so it no longer touches `response.messages`. Reported in #2.
- `cli/src/openrouter.ts` switched from `result.textStream` to
  `result.fullStream` and now yields `tool-call` chunks during the stream.

### Added
- `tests/cli-agent.test.ts` — regression specs that mock `streamResponse` to
  return text deltas with no `messages[0]` (NIM/vLLM shape) and assert
  `runAgent` does not throw and emits `assistant` + `done` events.
- `tests/entry-point.test.ts` — smoke specs that import `dist/index.js`
  and assert `createServerAdapter()` exists, returns the
  `ServerAdapterModule` shape (`type` / `label` / `models` /
  `agentConfigurationDoc` / `execute` / `testEnvironment`), and that
  `resolveEndpoints()` is exported. Guards against future entry-point
  refactors silently regressing 0.2.1's fix.

## [0.2.1] - 2026-05-07

### Fixed
- Restore `createServerAdapter` re-export on the package main entry
  (`src/index.ts` → `dist/index.js`). The 0.2.0 refactor regressed the
  fix from commit `6fb8f95`, causing the Paperclip plugin loader to
  reject the package at runtime with: *"Package does not export
  createServerAdapter()"*. Empirically reproduced on Paperclip
  v2026.428.0 (Contabo VPS). After this patch, server startup logs
  `Loaded external adapters from plugin store {"count":1,"adapters":["llm"]}`.

All notable changes to this project are documented here.

## 0.2.0 — 2026-05-07

Fix API drift against `@paperclipai/adapter-utils` 2026.428.0; add fallback for `skillsDir`; integration test for prompt-build path.

### Fixed
- `src/server/execute.ts`: replaced calls to `api.updateIssueState` and `api.addComment` (removed in adapter-utils 2026.x) with the current `api.updateIssue(id, { status })` and `api.addIssueComment(id, { body })` methods.
- `AdapterExecutionResult` shape: removed `status` field; populate the required `exitCode` / `signal` / `timedOut` keys; moved `costUsd` to top level.
- `UsageSummary` shape: dropped `totalTokens` and `costUsd` (current shape is `inputTokens` / `outputTokens` / `cachedInputTokens?`).
- `renderPaperclipWakePrompt` is no longer called with `skillsPrompt` / `supportsImages` (removed); skills are now prepended manually to the wake prompt.
- `emitInit` now passes `sessionId` (was missing); `emitToolCall` uses `{ name, input, toolUseId }` (was `{ id, name, arguments }`); `emitToolResult` drops `durationMs`.
- `AdapterExecutionContext` is no longer treated as generic; the wake payload and `issueId` are extracted from `ctx.context` defensively.
- `PaperclipApi` constructor now receives `{ authToken }` (was the entire ctx, which silently shadowed the real shape).
- `src/server/skills.ts`: `loadSkills` guards against an undefined `agentConfig`; default skills directory is now `~/.paperclip-llm-adapter/skills` (was `~/.openrouter-adapter/skills`); exports `defaultSkillsDir()` plus `DEFAULT_SKILLS_DIR` for callers needing the literal path.

### Added
- `PAPERCLIP_LLM_CLI_PATH` environment variable to override the bundled CLI path (used by integration tests).
- `tests/execute.test.ts` integration test covering: prompt build with no `skillsDir`, `updateIssue` / `addIssueComment` invocation, current `AdapterExecutionResult` schema (no removed fields), CLI failure marks the issue `blocked`, non-OpenRouter `baseUrl` does not throw on `/generation` 404.
- `npm test` script powered by vitest 3.

### Changed
- Bumped to `0.2.0`. Backwards-compat exports preserved: `OpenRouterConfig` (alias for `LlmConfig`), `OpenRouterFormValues`, `DEFAULT_BASE_URL`, `OPENROUTER_BASE_URL`/`_MODELS_ENDPOINT`/`_CHAT_ENDPOINT`/`_GENERATION_ENDPOINT`, `listOpenRouterModels`, `openrouter-cli` bin.

## 0.1.0 — 2026-05-06

- Forked from `talhamahmood666/paperclip-adapter-openrouter`.
- Generalized OpenRouter base URL into `adapterConfig.baseUrl` so the adapter targets any OpenAI-compatible endpoint (OpenRouter, NVIDIA NIM, Ollama, vLLM, DeepSeek direct).
- Added `resolveEndpoints()`, `isOpenRouter()`, `isLocalEndpoint()`, `LlmConfig`, `LlmFormValues`.
- CLI: `--base-url` flag, `LLM_BASE_URL` env var, `LLM_API_KEY` env var; `createOpenRouter({ apiKey, baseURL })` wires the configured endpoint into chat completions.
- UI: `Base URL` text field with multi-provider help text.
- README rewritten with concrete config blocks for OpenRouter, NIM, Ollama, vLLM, DeepSeek.

# AGENTS.md

A Paperclip adapter that runs an agent's heartbeat as an in-process tool-calling loop against any
OpenAI-compatible `/chat/completions` endpoint. It has no shell and no filesystem: the model only gets
the tools defined in `src/server/tools.ts`. The model is often a weak open model (e.g.
`openai/gpt-oss-120b`), so a lot of this code is about steering a model that misreads tools.

## Claude guidelines

### Subagents v1.0

Spawn subagents to isolate context, parallelize independent work, or offload bulk mechanical tasks. Don't spawn when the parent needs the reasoning, when synthesis requires holding things together, or when spawn overhead dominates.

Pick the cheapest model that can do the subtask well:

- Haiku: bulk mechanical work, no judgment
- Sonnet: scoped research, code exploration, in-scope synthesis
- Opus: subtasks needing real planning or tradeoffs

If a subagent realizes it needs a higher tier than itself, return to the parent.

Parent owns final output and cross-spawn synthesis. User instructions override.

## Always rebuild and commit `dist/`

`dist/` is committed to git, and deployments run it directly. The deploy machine clones this repo and
runs `npm install` **without devDependencies**, so it cannot compile TypeScript: `tsc` isn't installed
and a `prepare`/`postinstall` build script fails the install. Changes to `src/` reach production only
through a rebuilt `dist/`.

Whenever a commit touches `src/`:

1. `npm run build`
2. Stage `dist/` along with the source changes, in the same commit.

Don't add a `prepare` or `postinstall` script that runs `tsc`, and don't move `dist/` into
`.gitignore`.

## Map

| File | Owns |
| --- | --- |
| `src/server/execute.ts` | The run loop: wake prompt, `DEFAULT_SYSTEM_PROMPT`, tool dispatch, repeat-loop guard, disposition nudge, post-loop status/comment |
| `src/server/tools.ts` | Every tool (`xxxTool(ctx)` builders, registered in `buildTools`), the shared helpers, and `detectPaperclipFeatures` (the per-run Cases / Status Cards probe) |
| `src/server/paperclip-api.ts` | The only client for Paperclip's REST API (`PaperclipApi`, `PaperclipApiError`) |
| `src/server/http-request.ts` | Secrets (`SecretStore`), `{{secret:NAME}}` substitution, redaction, Google service-account tokens, host allowlist |
| `src/server/library.ts` | Company Library issue resolution and the one-time `memory_fs` migration |
| `src/server/transcript.ts` | Run-log entries (`emitToolCall`, `emitResult`, …). This is the JSON-lines log users paste |
| `src/server/test.ts` | Environment test and `listModels` |
| `src/index.ts` | Adapter metadata, `agentConfigurationDoc`, endpoint resolution (`resolveEndpoints`, `isOpenRouter`) |

`paperclip.plugin.json` has a stale version number. `package.json` is the real one.

## Debugging a run log

Users paste the run's JSON-lines transcript. To read one:

- Trust the `tool_call` inputs over the `thinking` text. Models often say they'll call one tool and
  then call another.
- If a `tool_result` error doesn't match any string in the current `src/`, the deployment is running
  old code (usually an outdated `dist/`, or an unpushed commit). Check that before changing any code.
- `result.subtype` is `completed`, `max_turns`, `repeat_loop` (3 identical calls in a row) or `error`.
  Everything except `completed` sets the issue to `blocked` with a "Run stopped: …" comment.

## Writing tools for weak models

- When the model's intent is unambiguous, do what it asked rather than reject the call. Example:
  `update_issue` accepts a `status` because models mix it up with `update_issue_status`.
- Every tool error must say what to do next: the right tool, the missing field, the valid values.
  A bare "invalid input" makes the model retry the same call until the repeat-loop guard kills the
  run.
- When a call is missing a field and only one value is valid (e.g. the issue's only document), use
  that value instead of returning an error.
- A field a call can't work without goes in the schema's `required`. Providers drop optional fields,
  deliver fields in schema order (an optional field before the first one the model sends is lost),
  and can't deliver fields that aren't in the schema, so aliases only help when they're schema fields.
- A dropped field doesn't need its own fix in each tool. On the 2nd identical failing call,
  `restateFailingCall` in `execute.ts` asks for the arguments as JSON in a tool-free request and runs
  them. If a run log still dies in `repeat_loop`, read its "Model served by" and "restate" system
  lines first: they name the provider and what the restate reply contained.
- Changing what a tool does means updating all of these in the same commit: the tool's `description`,
  `DEFAULT_SYSTEM_PROMPT` if it mentions that tool, the README "Tools" section, `CHANGELOG.md` under
  `[Unreleased]`, and the tests.

## Reuse before writing

- Paperclip calls go through a `PaperclipApi` method. If none fits, add a method there; don't call
  `fetch` from a tool.
- Tool results: `ok`, `fail`, `safeCall` (wraps an API call and formats `PaperclipApiError`).
  Arguments: `asString`. "Is this the current issue": `targetsCurrentIssue`, which also accepts the
  human identifier (e.g. `DEBA-47`). Status changes: `buildStatusPatch` + `sendStatusPatch`.
  Documents (issue, library, or case): `writeDocument` / `appendDocument` over a `DocumentStore`,
  which handle `baseRevisionId` and the 409 retry.
- Validation that two tools need belongs in one helper they both call. Don't copy it.
- Tests reuse the existing fakes. In `tests/tools.test.ts`: `makeApi`, `jsonResponse`,
  `fakeLibraryServer`. In `tests/execute.test.ts`: `setupFetchMock`, `toolCallResponse`,
  `assistantResponse`, `makeContext`. A real run-log failure gets a regression test that replays it.

## Comments

- Comment only the *why* the code can't show: a Paperclip API quirk, a model failure mode, an
  ordering constraint. Keep it to 1–3 lines.
- The story of an incident goes in the commit message and the CHANGELOG, not in a code comment.
- Don't write comments that restate the code, label the next line, or say "added/changed/fixed X".
  When you edit code that has one of those, cut it down.

## Checks and commits

- `npm run typecheck`, `npm test`, then `npm run build` (see above).
- Conventional commits, usually scoped `server`: `fix(server): …`, `feat(server)!: …` for breaking
  changes, `build: …` for dist/tooling. Commit straight to `main`, which is how this repo works.

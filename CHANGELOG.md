# Changelog

## [Unreleased]

### Changed — model picker
- **The Model dropdown now lists real models from the provider.** Paperclip
  calls `listModels()` with no agent config, so it reads the provider from
  `LLM_BASE_URL` in the server env (default OpenRouter) and fetches
  `GET <base>/models`. `LLM_API_KEY` is sent when it's set, but no longer
  required: before, a missing key meant an empty result, and the picker
  fell back to the static list. Non-OpenRouter providers sort by id.
- **The hardcoded `models` list is gone** (now `[]`). It was stale and
  OpenRouter-centric.
- **`detectModel()` returns `null` unless `LLM_MODEL`/`OPENROUTER_MODEL` is
  set.** It used to report `openrouter/auto` as "detected" for everyone.

### Fixed
- **Hiring an `llm` agent is no longer blocked by a missing API key.**
  Paperclip's new "Configure your agent" wizard shows no adapter config
  fields (only a built-in list of adapters gets a key input), and it
  disables "Finish setup" when the environment test fails. The test failed
  whenever no key was set, so hiring was impossible without `LLM_API_KEY`
  on the server. A missing key, or a `/models` 401/403 with no key, is now
  a warning; add the key under the agent's Configuration after hiring. A
  key that's set but rejected still fails.
- **`update_issue` with a `status` no longer ends in a repeat loop.** Models
  confuse it with `update_issue_status`: gpt-oss-120b sent
  `update_issue({status: "done", comment})` over and over, got back "No
  fields supplied to update.", and the repeat-loop guard set the finished
  issue to `blocked`. `update_issue` now accepts a `status` (plus `comment`
  and the blocker/reviewer fields), checks it the same way
  `update_issue_status` does, and the call counts as the run's
  disposition. When nothing usable is passed, the error names the ignored
  fields and points to `update_issue_status` / `add_comment`.
- **A disposition-recovery wake now gets a second, firmer nudge.** Real
  incident (`DEBA-53`): a `missing_disposition` recovery run deliberated
  across several individually-valid disposition paths (create a sub-issue
  vs. a self-owned blocker vs. more evidence-gathering), burned ~9.5k
  reasoning tokens, and ended a turn with no tool call at all. Since that
  run was already Paperclip's one corrective handoff wake, the old one-shot
  nudge left no further automatic recovery and the issue escalated straight
  to "Missing disposition recovery blocked" on the board. An ordinary run
  still gets one nudge; a disposition-recovery wake now gets two, and the
  second tells the model to stop weighing alternatives and call
  `update_issue_status` with `blocked`/`unblock_action` naming itself as
  owner — the option that's always valid regardless of which path is "more
  correct."
- **The disposition-recovery note is now an ordered checklist, not a menu
  of options to weigh.** The nudge above is a safety net for when a model
  already failed to decide; this targets the deliberation itself. A sibling
  run on the same incident (`DEBA-54`, a different reviewer agent on the
  same draft) burned ~10.3k reasoning tokens across three turns comparing
  `done`/`in_review`/`blocked`/`ask_user_questions`/create-a-sub-issue
  against each other before finally complying with the second nudge.
  `renderDispositionHandoffNote` now presents those as a "stop at the first
  step that applies" sequence, names `blocked` with a self-owned
  `unblock_action` as the explicit safe default for unclear evidence, and
  drops `create_sub_issue` from the offered paths entirely — it was the
  biggest fork in the observed deliberation.
- **The recovery note no longer flatly bans finishing the task — only
  re-fetching data, multi-step work, and external side effects.** A later
  run on the same `DEBA-54` issue hit a worse failure than the deliberation
  above: a human retry woke the agent on an ordinary heartbeat, it read the
  review's draft and brief (already fully in hand) and got most of the way
  through a real compliance verdict, then caught itself — "this is
  disposition-only, don't redo the task" — and threw the analysis away to
  self-block on itself instead ("owner: me, action: try again later").
  Nothing was actually blocked on anything external, so every following
  "try again" repeated the identical no-op cycle: ordinary wake fails to
  finish → `missing_disposition` fires → recovery run self-blocks again.
  Step 1 of the checklist now explicitly covers this case: if durable
  evidence is already fully in hand and finishing means one write with no
  external side effects, record the real verdict now instead of deferring
  it again.
- **The recovery note's "already in hand" fix (above) caused a third
  recurrence of the same `DEBA-54` failure** on the very next recovery run.
  Every run starts from an empty message list, so nothing is ever literally
  "already in hand" at turn 1 of a fresh run — the model reasoned exactly
  that ("I don't have the draft or brief content in context... reading them
  would be re-fetching data") and self-blocked again instead of making the
  two cheap reads the task already pointed it to. `renderDispositionHandoffNote`
  now says explicitly that reading the small number of documents a task
  already references is evidence-gathering, not redoing the task, even
  though it takes tool calls in a fresh run — the ban is on regenerating a
  deliverable or causing external side effects, not on the reads needed to
  decide.
- **`library`/`issue_document`'s `action='list'` no longer returns full
  document bodies.** Paperclip's underlying endpoint returns every
  document's complete text; `list`'s job is just "what keys exist," and
  contributed directly to the DEBA-54 incidents above — one `library(list)`
  call in a company library with a dozen multi-KB drafts and briefs put all
  of them in context (133k input tokens on one run), crowding out the
  model's budget to actually finish the task it was mid-generating. `list`
  now returns `key`/`title`/`format`/`latestRevisionNumber`/`updatedAt`/a
  200-character `preview` per document; `action='read'` is unchanged and
  still returns the full body.
- **`DEFAULT_SYSTEM_PROMPT` no longer contradicts the disposition-recovery
  note.** The always-on system prompt carried its own stale one-liner —
  "only record the disposition — do not redo the task" — left over from
  before `renderDispositionHandoffNote` was rewritten to allow reads. On
  every recovery wake the model was handed two different rules for the same
  situation in the same context. The system prompt now defers entirely to
  whatever the recovery note itself says.
- **Added `action='append'` to `library` and `issue_document`, and trimmed
  `list_issues` the same way `library`'s `list` was trimmed.** The run that
  got furthest into actually finishing the `DEBA-54` review — it read the
  draft and brief, performed the real 7-point compliance check — still ran
  out of its turn's token budget (133k input tokens) before ever emitting
  the write, mid-way through retyping the entire multi-KB draft verbatim
  just to add one review-log paragraph (`action='write'` requires the full
  body; Paperclip has no diff/patch endpoint). `append` sends only the new
  text and does the read-modify-write here. Separately, that same run burned
  tens of thousands of tokens on `list_issues(limit=50)` just to check
  whether a follow-up task already existed; `list_issues` now returns
  `id`/`identifier`/`title`/`status`/`priority`/`assigneeAgentId`/
  `parentId`/`updatedAt` instead of Paperclip's full issue objects
  (`get_issue` already covers one issue's full detail).

### Changed — reasoning effort
- **Reasoning effort is now a config field (`reasoningEffort`: low/medium/
  high, default `medium`)** instead of hardcoded `high` whenever `reasoning`
  was on. (An earlier version of this entry called this the root cause of
  the `DEBA-53`/`DEBA-54` incidents. It wasn't — see the truncation entry
  below. The per-run token totals cited there were sums across turns, not
  single responses.)

### Fixed — responses cut off at max_tokens (root cause of DEBA-53/DEBA-54)
- **`max_tokens` is no longer sent unless configured** (it defaulted to
  4096), and **the loop now handles `finish_reason: "length"`**. Every
  failed run in the `DEBA-53`/`DEBA-54` chain had thinking that stopped
  mid-sentence, and its run total was a multiple of roughly 4096 output
  tokens. The model wrote about 4K tokens of analysis, got cut off before it
  reached a tool call, and the loop read that as "the model chose to stop."
  It then threw away the partial output and nudged, so the next turn redid
  the same analysis from scratch and got cut off at the same point. That is
  where the "indecision" and "rumination" came from. The prompt fixes above
  addressed real problems, but not this one. Now:
  - A cut-off turn with a configured `maxTokens` is retried once at double
    the value.
  - Otherwise the partial output stays in the conversation and the model is
    told to continue from it. This doesn't spend a disposition nudge.
  - The run log shows a `Response cut off…` line whenever this happens.
- **Tool calls with unparseable arguments are no longer run as `{}`.** One
  `DEBA-54` run reached its `library` write, but the full-document body was
  cut off mid-JSON. It ran as `library({})` and came back with "action must
  be one of: read, write, append, list". It's now skipped, with an error
  that names the cut-off and points to `action='append'`.
- **The model's own text and reasoning are kept when it's nudged.** Before,
  a no-tool-call turn was dropped from the conversation before the nudge.
- **Recovery-note conflicts removed.** "Do not create a sub-issue in this
  run" collided with agents' own handoff steps (Toby's SEO task for Ryan).
  The note now says those follow-ups are part of finishing. It also says how
  to read Paperclip's generic "don't repeat the task" text, and that a
  human's request to finish wins. The second recovery nudge no longer pushes
  `blocked`; it pushes recording the decision the model has reached.

## [0.13.0] - 2026-09-30

### Removed — hidden storage
- **The `memory_fs` tool is gone.** It stored plain files in a server
  directory (`~/.paperclip-llm-adapter/homes`) that no human could see in
  the Paperclip UI. Agents had come to rely on its `shared` scope as "org
  storage" for the content log, research briefs, and article drafts. Every
  kind of agent storage is now a visible Paperclip document. The helper
  module is read-only and exists only for the migration below.

### Added
- **`library` tool and the Company Library.** Shared, long-lived documents
  live on one unassigned issue titled "Company Library". It's created on
  first use, or pinned with the new `libraryIssue` config field. It's
  visible on the issue and in the company Artifacts view, with revision
  history. It stays unassigned because Paperclip lets any agent write
  documents on an unassigned issue, and because it never triggers
  heartbeats or disposition recovery. If agents race to create it, everyone
  converges on the oldest one.
- **`find_documents` tool.** Keyword search across every document in the
  company (`GET /api/companies/:id/artifacts?kind=document`), returning
  issue and key for each hit.
- **Automatic migration.** At the start of every run, any files left in the
  old storage (the company's shared scope plus the running agent's private
  scope) are copied into Library documents. `briefs/x.md` becomes
  `briefs-x`, and private notes become `notes-<agent>-...`. A marker file
  makes it one-time per file, source files are never deleted, existing keys
  aren't overwritten, and a failure never fails the run. The run log says
  what moved.
- The system prompt now says all storage is visible documents, maps "org
  storage" / shared memory / file paths to the Library, and says an empty
  listing really is empty. In a real run the model listed `shared/...`
  paths that didn't exist over and over until the repeat-loop breaker
  stopped it.

## [0.12.1] - 2026-09-30

### Fixed
- **Secrets bound with "API access" were invisible.** Paperclip has two
  secret binding modes, and 0.12.0 only read env-var bindings from
  `adapterConfig.env`. API-access bindings never touch the env. They're
  listed via `GET /api/agents/me/secrets` and each value is resolved via
  `POST /api/agents/me/secrets/:key/value` with the run-bound agent token.
  Oscar's `GSC_SERVICE_ACCOUNT` / `UMAMI_API_KEY` were bound this way, so
  `http_request` answered "Unknown secret". A new `SecretStore` merges both
  modes. API-access names are listed at run start, and a value is fetched
  only when a request references it, then cached for the run and redacted
  from everything the model sees (Paperclip also registers it for run-log
  redaction).
- **`list_secrets` listed things that aren't secrets.** It showed `TEMP`,
  `TMP`, `TMPDIR`, `GH_CONFIG_DIR` (plain runtime vars in `config.env`) and
  the adapter's own `llm.apikey.<id>` LLM key. The `/agents/me/secrets`
  listing covers every secret bound to the agent, env-var and API-access
  alike, so when it's available it's now the only source of names.
  `config.env` is used only as a fallback for servers without the endpoint.
  The adapter's own LLM key is always excluded. Names are the secrets' keys
  (e.g. `umami_api_key`), not binding aliases, because that's what the value
  endpoint resolves.
- `{{secret:NAME}}` now accepts dots and hyphens in `NAME`.
- A 4xx from `http_request` now carries a hint: don't resend the request
  unchanged, and header names use hyphens, not underscores. In a real run
  the model retried a guessed, 404ing endpoint until the repeat-loop breaker
  stopped the run.

## [0.12.0] - 2026-09-30

### Fixed — "missing disposition" errors
Traced against the Paperclip server source (`@paperclipai/server@2026.916.1`:
`decideSuccessfulRunHandoff`, the issue-update route) rather than guessed.
A successful run that leaves its issue `in_progress` gets one corrective
"handoff" wake. If that run also fails to record a disposition, the issue
escalates to the board. The adapter was feeding that loop in several ways:

- **A bare `blocked` always failed.** Paperclip 422s entering `blocked`
  without blockers, a pending interaction/approval, or an
  `unblockDescriptor`. `update_issue_status` couldn't send any of those, yet
  the system prompt told the model to use `blocked` when waiting. The model's
  write failed, the run exited 0, and the issue stayed `in_progress`. The
  tool now takes `blocked_by_issue_ids` / `unblock_action` (sent as an
  `unblockDescriptor` owned by the agent itself, the only owner Paperclip
  allows an agent to name) and refuses a bare `blocked` locally, with the fix
  in the error. The adapter's own post-loop `blocked` (max_turns, repeat
  loop, LLM error) now sends a descriptor too. That write is the "Entering
  blocked requires…" error in DEBA-39's run log.
- **Every "reason" was silently dropped.** `statusReason` isn't in
  Paperclip's issue-update schema, and zod strips unknown keys. Explanations
  now go in `comment`, which Paperclip writes in the same transaction as the
  status change.
- **The system prompt said "leave it in_progress if you will resume it
  yourself"**, which is exactly what counts as a missing disposition.
  Rewritten to list only the endings Paperclip accepts, with the arguments
  each one needs.
- **The in-run nudge could be skipped.** It only fired if no
  `update_issue_status` call had succeeded at all, so marking a sub-issue
  done, or setting `in_progress`, suppressed it. It now asks Paperclip for
  the issue's real status first.
- **`in_review` without a reviewer failed with 422.** The tool now takes
  `reviewer_user_id`.
- **Corrective handoff wakes weren't recognizable.** Paperclip puts the
  "record a disposition only, don't redo the work" instructions at the top
  level of the run context, not in the wake payload, so the model treated
  DEBA-39's corrective run as a fresh task. The adapter now renders those
  instructions at the top of the prompt, with each option mapped to a tool
  call.
- **The final-text comment is skipped when the model already commented** on
  its issue. It was a duplicate, and it made otherwise idle runs look
  "productive" to the handoff check.
- **A status-write failure no longer hides the real error.** When the
  repeat-loop breaker (or another failure) is followed by a failed `blocked`
  write, the original failure stays primary and the reason is still posted
  to the issue as a comment.

### Added
- **Bound secrets and outbound HTTP.** Paperclip resolves bound secrets into
  `adapterConfig.env`, and this adapter used to ignore it. So an agent told
  to use `GSC_SERVICE_ACCOUNT` / `UMAMI_API_KEY` had no way to reach them,
  and improvised `bash` + `curl` against a made-up endpoint
  (`/api/agents/me/secrets`). New tools:
  - `list_secrets` returns names only.
  - `http_request` supports `{{secret:NAME}}` substitution, Google
    service-account auth (RS256 JWT → access token, cached per run),
    redaction of secret values and tokens from all output, a 32 KB response
    cap, and a 30 s timeout.

  Both tools are registered only when secrets are bound; `httpToolEnabled`
  and `httpAllowedHosts` are new config fields.
- Calling an unknown tool now returns the available tool names, plus an
  `http_request` hint for shell-like names like `bash`/`curl`.
- The wake prompt now uses adapter-utils' execution contract, and shows the
  server's task markdown (`paperclipTaskMarkdown`) when present.

### Changed
- `@paperclipai/adapter-utils` and `@paperclipai/shared` upgraded from
  2026.428.0 to 2026.916.1. Skill reconciliation now uses
  `resolveLegacyPaperclipDesiredSkillNames`, which always mounts the
  operational `paperclip` skill; upstream removed the per-entry `required`
  flag.

## [0.11.1] - 2026-09-29

### Fixed
- **`issue_document`'s `write` action could never actually update an
  existing document.** Reported directly by an agent: "The document tool
  can't carry the required baseRevisionId for an existing key, so I'll
  publish the promised deliverable under a fresh document key" — i.e. it
  had already found and worked around the bug itself rather than fixing
  the real document.
  Confirmed in the host repo's `documents.ts`: Paperclip enforces strict
  optimistic concurrency on document updates. `baseRevisionId` must be
  omitted when creating a new key (a value 409s with "Document does not
  exist yet") and must exactly equal the document's current
  `latestRevisionId` when updating an existing one — omitting it always
  409s with "Document update requires baseRevisionId", and a stale value
  409s with "Document was updated by someone else". v0.8.0's `write` never
  sent `baseRevisionId` at all, so every update to an existing key failed
  every time; only first-time creates ever worked. The tool's own
  description even claimed "Writing to an existing key adds a new
  revision" — never actually true.
- `write` now resolves `baseRevisionId` automatically: a `GET` on the key
  before the `PUT` (absent doc → correctly omitted, i.e. create path), and
  one retry with a freshly re-fetched revision id if the write still 409s
  (a concurrent write raced between the read and the write). The model
  never sees or manages revision ids — same "resolve it in the tool, not
  the model" approach as `ask_user_questions`' generated option ids.
- 3 new tests, including the exact 409-then-retry sequence.

## [0.11.0] - 2026-09-29

### Added
- **In-run disposition nudge.** Diagnosed from a real, multi-run transcript
  on a single issue (`DEBA-35`): a run's final comment confidently claimed
  "Ready. DEBA-35 closed **done**... verified in the API response" — but
  `update_issue_status` was never actually called, and the issue stayed
  `in_progress`. Paperclip's own `missing_disposition` recovery correctly
  re-triggered on the next heartbeat (that's the "blocked disposition
  again" the user reported) — but the same pattern recurred *again* several
  runs later on the same issue, showing the cross-run recovery loop alone
  wasn't reliably fixing the underlying habit, only costing an extra full
  run each time it happened.
- `execute()` now tracks whether `update_issue_status` was called
  successfully during the run. If the model stops calling tools without
  having called it (and without a pending `ask_user_questions`
  interaction, which already has its own valid no-status-change path), it
  gets exactly **one** corrective nudge — a plain user-role message
  pointing out that no disposition was recorded and asking it to call the
  tool now — before the run is allowed to end. If it still doesn't comply,
  behavior is unchanged from v0.5.0: status is left untouched and
  Paperclip's own recovery owns it from there.
- 2 new tests: the nudge firing and going unanswered (status still stays
  untouched), and the nudge successfully recovering a disposition on the
  model's second attempt.

## [0.10.0] - 2026-09-29

### Added
- **New `list_interactions` tool** — the real root cause behind a multi-round
  `ask_user_questions` interview (e.g. a "interview the board" style task)
  appearing to repeat questions across rounds. Traced from an actual run
  transcript: the model itself correctly diagnosed a *different*, already-
  self-corrected problem (a prior run's comment claimed to have "posted the
  questions as a card" without actually calling `ask_user_questions` — pure
  narration, no tool call), but that investigation surfaced the real
  structural gap: **this adapter had no tool that shows interaction
  history.** `get_issue` and `list_comments` don't surface past
  `ask_user_questions`/`request_confirmation`/`suggest_tasks` cards or their
  answers at all, and the wake prompt's "this interaction is answered" note
  only ever covers the single most recent card. Since every run
  reconstructs its entire context from scratch with no memory of earlier
  runs, by round 3+ of a multi-round Q&A the model had no reliable way to
  recall what it already asked — only what happened to survive in the
  latest wake's rendering.
  - Wraps a new `PaperclipApi.listIssueInteractions()` against
    `GET /api/issues/:id/interactions` (lists every interaction on the
    issue, any kind, any status, oldest first — the full history, not just
    the latest one).
- `DEFAULT_SYSTEM_PROMPT` updated: replaced now-inaccurate advice to check
  `get_issue`/`list_comments` for prior answers (they never showed
  interaction history) with an instruction to call `list_interactions`
  before starting a new round on a multi-round task. Also added an explicit
  warning against narrating an action ("I've posted the questions as a
  card...") without actually calling the corresponding tool in the same
  turn — the specific failure mode observed in the source transcript.
- 2 new tests.

### Note
The transcript this was diagnosed from was running an adapter build from
before `issue_document`/`update_issue`/several other fixes in this
changelog — a reminder that these fixes only take effect once the deployed
instance is rebuilt and the Paperclip server is restarted.

## [0.9.0] - 2026-09-29

### Fixed
- **`update_issue_status`'s status enum was wrong.** It offered
  `["open", "in_progress", "blocked", "done", "cancelled"]` — "open" isn't
  a real Paperclip status at all (the real set, `ISSUE_STATUSES` in the
  host's `packages/shared/src/constants.ts`, is `backlog`, `todo`,
  `in_progress`, `in_review`, `done`, `blocked`, `cancelled`), and
  `in_review` — a status this project's whole disposition-handling effort
  leans on — was missing entirely, silently unreachable via this tool
  since the model was never offered it as an option.
- **`create_sub_issue`'s priority enum was wrong too**: it offered
  `["low", "normal", "high", "urgent"]` against the real set
  (`ISSUE_PRIORITIES`) of `critical`, `high`, `medium`, `low`.
- Both now match Paperclip's real enums exactly, with regression tests
  asserting the schema's enum values directly (not just that a call
  succeeds) so a future edit can't silently drift again.

### Added
- **New `update_issue` tool**, requested directly by a running agent: its
  blocker set (`blockedByIssueIds`) pointed at a cancelled issue and it had
  no tool to fix that itself, having to route the change through the issue
  owner instead. `update_issue_status` only ever sent `{status,
  statusReason}` — `PaperclipApi.updateIssue()` underneath it already
  accepted an arbitrary patch object, so this is a new tool wrapping the
  same client method with a safely-scoped field set: `title`,
  `description`, `priority`, `blocked_by_issue_ids` (full replacement, not
  a diff — pass every id that should still block, omit ones that
  shouldn't), `assignee_agent_id`, `assignee_user_id` (empty string
  unassigns either). Deliberately excludes riskier/policy fields from
  Paperclip's real update schema (`executionPolicy`,
  `executionWorkspaceSettings`, `reviewInteractionId`,
  `onBehalfOfUserId`, etc.) that aren't safe for a generic agent tool to
  expose. Status changes stay on `update_issue_status`, not duplicated
  here.
- `DEFAULT_SYSTEM_PROMPT` now tells the model about `update_issue`
  specifically for fixing a stale blocker set.
- 6 new tests.

## [0.8.0] - 2026-09-29

### Added
- **New `issue_document` tool.** The user wanted agents to put write-ups
  somewhere visible in the Paperclip web UI; the previous session's
  `memory_fs` (v0.7.0) was the wrong tool for that — it's private/shared
  *notes*, invisible in the UI by design. Paperclip has a real, separate
  "documents" concept: `PUT /api/issues/:id/documents/:key` creates or
  revises a markdown document attached to an issue, with full revision
  history, rendered in the issue's Documents panel. `issue_document` wraps
  `list`/`read`/`write` against the real API
  (`PaperclipApi.listIssueDocuments` / `.getIssueDocument` /
  `.upsertIssueDocument`, new in `src/server/paperclip-api.ts`). Document
  keys are auto-slugified to Paperclip's required `[a-z0-9_-]` format so a
  natural-language key like "Design Doc!!" still works.
- `DEFAULT_SYSTEM_PROMPT` now distinguishes the three "write something"
  tools for the model: `add_comment` (chat-style timeline entry),
  `issue_document` (a real, human-reviewable document with history,
  visible in the UI), and `memory_fs` (private/shared notes nobody in the
  UI ever sees) — added after `memory_fs` alone left the model with no
  tool actually aimed at the user's real request.
- 5 new tests in `tests/tools.test.ts`.

## [0.7.0] - 2026-09-29

### Added
- **New `memory_fs` tool**, so `llm`-type agents can actually use file-based
  memory skills like Paperclip's bundled `para-memory-files` — which
  otherwise expects real filesystem read/write under `$AGENT_HOME` plus a
  `qmd` shell command for semantic recall, neither of which this adapter
  provides (and `qmd` isn't something Paperclip installs or guarantees
  anywhere — it's assumed present in whatever environment a native CLI
  adapter happens to run in).
- `memory_fs` is **not** a restoration of the unsandboxed CLI tools removed
  in the 0.3.0 security fix. It has two isolated scopes, each confined to
  one resolved root directory:
  - `scope: "private"` — one directory per agent (`$AGENT_HOME` in the
    skill's own terms); only that agent's own tool calls can reach it.
  - `scope: "shared"` — one directory per **company**, readable and
    writable by every `llm`-adapter agent in it. `para-memory-files`
    explicitly wants some content (its `plans/` convention) kept "outside
    personal memory so other agents can access them" — this is that.
  - Every path is resolved and containment-checked
    (`resolveSafePath` in `src/server/memory-fs.ts`) before any read or
    write; `../` traversal and absolute-path overrides are both rejected.
    There is no shell execution anywhere in this feature — `action:
    "search"` does a plain case-insensitive keyword search across the
    scope's files instead of shelling out to `qmd`.
  - New optional `agentHomeDir` config field overrides the base directory
    (default `~/.paperclip-llm-adapter/homes/<companyId>/...`).
- `DEFAULT_SYSTEM_PROMPT` now explains the `$AGENT_HOME` → `scope:
  "private"`, shared-plans → `scope: "shared"`, and `qmd` →
  `action: "search"` mappings so file-based-memory skills' own instructions
  translate correctly onto this adapter's real tool surface.
- 23 new tests (`tests/memory-fs.test.ts`, plus additions to
  `tests/tools.test.ts`) — heavy on the security boundary specifically:
  path-traversal rejection, absolute-path-override rejection, and
  confirming two agents in the same company get isolated private roots but
  the *same* shared root.

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

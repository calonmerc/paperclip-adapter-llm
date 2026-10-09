# paperclip-adapter-llm

**Generic OpenAI-compatible adapter for Paperclip.** One adapter, any provider that speaks the OpenAI `/chat/completions` schema — OpenRouter (default), NVIDIA NIM, Ollama, vLLM, DeepSeek direct, and more.

[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)]()
[![Built for Paperclip](https://img.shields.io/badge/built%20for-Paperclip-8b5cf6)]()

---

## What this is

A fork of [`talhamahmood666/paperclip-adapter-openrouter`](https://github.com/talhamahmood666/paperclip-adapter-openrouter) with the OpenRouter base URL extracted into a configurable `baseUrl` field. `execute()` runs an in-process, multi-turn tool-calling loop against the configured chat/completions endpoint. If `baseUrl` is unset, the LLM endpoint defaults to OpenRouter.

### Tools

18 scoped tools (plus `list_secrets` / `http_request` and the Paperclip feature tools when enabled — see below), no shell access, no arbitrary filesystem access:

- `get_issue`, `update_issue_status`, `update_issue`, `add_comment`, `list_comments`, `create_sub_issue`, `list_issues`, `list_agents` — standard Paperclip issue/company operations. `update_issue_status` records a disposition and carries what Paperclip requires for it to be accepted: `blocked` needs `blocked_by_issue_ids` and/or `unblock_action` (sent as an `unblockDescriptor` owned by the agent), `in_review` needs `reviewer_user_id`, and the explanation goes in `comment` (posted with the status change). `backlog`/`todo`/`in_progress` are refused on the agent's own issue, since they'd leave it without a disposition; `update_issue` covers everything else (title, description, priority, assignee, and — its original motivating use case — replacing a stale `blockedByIssueIds` set, e.g. blockers pointing at an issue that's since been cancelled). `update_issue` also accepts a `status`, checked the same way, because models mix the two tools up. `list_issues` returns a lightweight scan (id/identifier/title/status/priority/assignee/parent/updatedAt) rather than Paperclip's full issue objects (full description text plus blocker/review/handoff bookkeeping) — `get_issue` is for one issue's full detail.
- `hire_agent`, `request_approval` — route through Paperclip's approval flow unless `autoApprove` is set. `hire_agent` takes a free-text `title`, a `role` from Paperclip's fixed list (a free-text `role` is treated as the title), `reports_to` (manager id or name), `model`, and optional `instructions` that become the new agent's `AGENTS.md`.
- `get_agent`, `update_agent`, `agent_instructions` — manage existing agents, which a CEO under Claude Code would do by curling `/api/agents/...`. `update_agent` changes name, title, role, manager (`reports_to`), capabilities, adapter type, model, other `adapterConfig` keys (merged), heartbeat (merged into `runtimeConfig`), and pauses/resumes. `agent_instructions` lists, reads, writes, or appends to the agent's managed instruction files (default: the entry file, usually `AGENTS.md`), so this edits the agent's prompt from its next run. Every agent argument accepts an id, name, or title. Paperclip enforces permission: editing another agent, or any agent's instructions, needs the `agents:configure` grant (which the CEO has by default). A 403 tells the model to ask a human instead.
- `ask_user_questions` — creates a real Paperclip issue-thread interaction (`continuationPolicy: wake_assignee`) and ends the run immediately after (the model cannot get a real answer within the same run).
- `list_interactions` — lists every interaction ever created on an issue, oldest first, with answers. Each run reconstructs its context from scratch with no memory of earlier runs, and the wake prompt's "this interaction is answered" note only ever covers the single most recent card — this is the only reliable way for the model to recall a multi-round Q&A (e.g. a multi-part interview) across several heartbeats instead of losing track and re-asking.
- `issue_document` — reads/writes/appends to/lists real Paperclip documents on an issue (`PUT /api/issues/:id/documents/:key`), with revision history, visible in the Documents panel in the web UI. Use this for anything a human should actually see and review. Paperclip enforces strict optimistic concurrency on updates to an existing key — `baseRevisionId` must exactly match the document's current revision or the write 409s — so `write`/`append` resolve it automatically (a `GET` before the `PUT`, with one retry if the write 409s anyway) instead of requiring the model to track revision ids itself.
- `library` — reads/writes/appends to/lists documents on the company **Library**: one long-lived, unassigned issue titled "Company Library" (created on first use, or pinned with `libraryIssue`). It's the home for anything shared across tasks and agents: running logs, brief backlogs, drafts, reference notes, and whatever instructions or skills call "org storage", shared memory, or `$AGENT_HOME`. It stays unassigned because Paperclip lets any agent write documents on an unassigned issue, and because it never triggers heartbeats or disposition recovery. `action='list'` (shared with `issue_document`) returns only `key`/`title`/`format`/`latestRevisionNumber`/`updatedAt`/a short `preview` — never the full `body` — since Paperclip's underlying endpoint returns every document's complete text; a company library with a dozen multi-KB drafts and briefs would otherwise dump all of them into context on a single "see what keys exist" call. `action='read'` still returns the full body. `action='append'` (also shared with `issue_document`) adds text to the end of an existing document — a read-modify-write done here, not by the model — so adding one review-log entry or sign-off doesn't require resending the entire document the way `action='write'` does. A `write`/`append` missing `key` or `body` holds the half that arrived for the next document call, so the model can finish it by sending only the missing field. glm-5.3-flash's calls with a long `body` kept arriving without `key`, and resending the whole call didn't fix it. A read needs only `{key}`: `action` can be left out, and the key is also taken from `action` itself (`"read content-log"`, or just the key) or from `name`/`document`/`path`/`file`/`id`, since glm-5.3-flash's `library({action:'read'})` calls kept arriving without `key`. A read without a key (including a bare `{issue_id}`) on an issue that has exactly one document reads that document.
- `find_documents` — keyword search over every document in the company, via the same data as the web UI's Artifacts view. It returns the issue and key for each hit, so the model can open one with `issue_document {issue_id, key}`.

### Cases and Status Cards

Paperclip's experimental **Cases** and **Status Cards** features get their own tools. Paperclip doesn't tell adapters which experimental features are on, so each run starts with one cheap read per feature (`GET /api/companies/:id/cases?limit=1` and `GET /api/companies/:id/status-cards`). A tool is registered only when its read succeeds; the 403/404 a disabled feature returns just leaves it out. The run log lists the feature tools that were enabled, and the system prompt gets a short note mapping these features to the tools, since the `paperclip` skill describes them as HTTP endpoints this adapter can't call.

- `case` — list, get, save, and update cases, plus `read_document` / `write_document` / `append_document` on a case's markdown documents (key `body` by default) and `link_issue`. `save` upserts on `case_type` + `key`, so a retry with the same key updates instead of duplicating. Paperclip replaces a case's `fields` wholesale on every write; `update` merges the model's `fields` into the existing ones instead (`replace_fields: true` opts out), because models send only the keys they're changing. Case documents use the same revision handling and one-time 409 retry as `issue_document`. `list` and `get` return only document keys and titles, not bodies. A parent case identifier (e.g. `PAP-C42`) and a project name are resolved to the UUIDs Paperclip requires.
- `status_card` — list, get, create, update, and refresh status-board cards. `create` takes an `interest_prompt` (checked against Paperclip's 4000-character agent limit) and an optional `refresh_mode`; `interval` without `interval_minutes` defaults to 60, and `reactive` without `debounce_seconds` defaults to 300, rather than being rejected. Agents can only change cards they created.
- `publish_status_card` — only registered when the current issue is a status card's generation task. Paperclip assigns that hidden "Compile status card" / "Update status card" issue to the card's summarizer agent, and its description carries a JSON payload naming the card. The tool reads the card id and `generationIssueId` from that payload, so the model never handles them: `save_query` (compile tasks only; project and label names are resolved to ids), `preview` (what the compiled queries match), and `save_summary` (sends the run's model id). Paperclip doesn't close the task after the summary, but it marks the card failed if the task closes *before* one is saved, so `update_issue_status`/`update_issue` refuse `done` on that issue until `save_summary` has succeeded.

### No hidden storage

Every piece of agent storage is a Paperclip document, visible in the web UI (on its issue and in the company Artifacts view) with revision history. The old `memory_fs` tool, which kept plain files in a server directory nobody could see, has been removed. On each run the adapter moves any files still left there (the company's shared scope plus the running agent's private scope) into Library documents: `briefs/x.md` becomes key `briefs-x`, and private notes become `notes-<agent>-...`. A marker file makes this a one-time move per file; source files are never deleted, and a failed migration never fails the run.

### Secrets and outbound HTTP

Paperclip has two ways to bind a secret to an agent, and both work:

- **Env-var bindings** are resolved into `adapterConfig.env` before each run (built-in adapters put that map in a child process's environment).
- **API-access bindings** never touch the environment. They're listed via `GET /api/agents/me/secrets` and each value is fetched on demand via `POST /api/agents/me/secrets/:key/value`, using the run-bound agent token. The adapter fetches a value only when a request references it, then caches it for the run.

This adapter has no child process and no shell, so instead:

- `list_secrets` returns the bound secret **names** (never values): the secrets' keys as `GET /api/agents/me/secrets` reports them, covering both kinds. `adapterConfig.env` is consulted only when that endpoint is unavailable, since it also carries non-secret runtime variables. The adapter's own `llm.apikey.*` key is always excluded.
- `http_request` makes an HTTP(S) call. A JSON request body goes in `json` (an object, sent with `Content-Type: application/json`); `body` is a raw string sent as-is (an object `body` is still sent as JSON). A 4xx on a POST/PUT/PATCH that carried no body says so in its `hint`, listing the fields that did arrive. Weak models lose fields from calls with many arguments, so a call works with as few as possible: `method` defaults to POST when there's a payload, `auth` is remembered per host for the run once it has worked (anything but a 401/403), and a `json` sent alone, without `url`, is held and attached to the next call. A GSC query can be just `{url, json}`. The model writes `{{secret:NAME}}` anywhere in the url, headers, query, `json` or `body`, and the value is substituted in-process. A secret name that matches exactly one bound name ignoring case resolves to it (models write `UMAMI_API_KEY` for `umami_api_key`). For Google APIs, `auth: {type: "google_service_account", secret, scopes}` turns a service-account key secret into an access token (signed RS256 JWT → `oauth2.googleapis.com/token`, cached for the run). Every secret value and minted token is redacted to `***` from responses and errors before the model sees them. Responses are capped at ~32 KB; requests time out after 30 s.

Both tools are registered only when at least one secret is bound; set `httpToolEnabled: true` to get `http_request` without secrets. `httpAllowedHosts` (comma-separated, `*.example.com` wildcards) restricts which hosts it may call.

Calling a tool that doesn't exist (e.g. `bash`) returns the list of available tools, plus a pointer to `http_request` for shell-like names, so the model can correct itself instead of retrying.

Every failing tool result carries `received_fields`, the argument names that actually arrived, because weak models drop a field and then insist they sent it. The repeat-loop guard stops a run after 3 identical calls in a row; the 2nd identical failing call gets a `warning` first. It also gets one more chance through a different channel: the adapter asks the model, outside the kept history and with `tool_choice: "none"`, to write that call's arguments as plain JSON text, merges them over the fields that arrived, and runs the tool itself. glm-5.3-flash's tool calls lose fields its reasoning says it sent, but its text keeps them. The run log shows the model's restated text in a system line, and the call appears as `<id>-restated`. If the reply has no arguments or changes nothing, the guard applies as before. Each failing call is restated at most once. Identical calls batched into one response run once and count once, since the model can't read the warning between them. Every tool parameter has a single JSON-schema `type` (a test enforces it): untyped and union-typed parameters get dropped by some providers' tool-call grammars.

### Disposition handling

The adapter never guesses an issue's final disposition: a run only changes issue status when the model explicitly calls `update_issue_status`, or on `max_turns`/an unrecoverable error (both `blocked`, with an `unblockDescriptor` naming the agent so Paperclip accepts it). A retryable LLM provider failure is the exception: a quota or rate limit (402, 429, or OpenRouter's 403 "Key limit exceeded") or a 5xx/network error is reported to Paperclip as `errorFamily: provider_quota` / `transient_upstream` (with `retryNotBefore` from `Retry-After` when sent). 5xx, 429 and network errors are first retried inside the run (twice, with backoff, honouring `Retry-After` up to 30s). If the run still fails, the issue is left `in_progress` with a "Run paused" comment. The result also carries recovery evidence: `executionRecovery: bootstrap` if no tool had run yet, otherwise `conversationContinuation`. Without it, Paperclip holds the task ("Automatic recovery of this task stopped") until a board user reconciles it through the API. The tradeoff is that the retried run starts fresh and could repeat an action the failed run already completed. A plain-text turn with no such call leaves status untouched, and Paperclip's own `missing_disposition` recovery owns prompting the agent for a real disposition.

When Paperclip wakes the agent for that recovery (a "successful run handoff"), its instructions arrive at the top level of the run context rather than in the wake payload, so the adapter renders them itself at the top of the prompt. Otherwise the corrective run looks like an ordinary wake, the model redoes the task, and Paperclip's single corrective attempt is spent.

That note is an ordered checklist, not a list of options to weigh: stop at the first step that applies (done, then ask_user_questions, then in_review), with `blocked` + a self-owned `unblock_action` as the fallback when the model truly can't finish. It also settles the conflicts a model would otherwise argue over: Paperclip's generic "don't repeat the task" text means only "don't regenerate a deliverable or cause external side effects"; follow-up tasks the agent's own instructions require (like a handoff to the next agent) are part of finishing; and a human's latest request to finish wins.

The note bans regenerating a deliverable, repeating a multi-step pipeline, and calling external systems with side effects — but it does **not** ban finishing a judgment call. A flat "do NOT redo the work" rule caused a failure on `DEBA-54`: a human retry woke the agent on an ordinary heartbeat, it read the review's draft and brief and got most of the way to a real verdict, then caught itself mid-review ("this is disposition-only, don't redo the task") and threw the analysis away to self-block instead — "owner: me, action: try again later." Nothing was actually blocked on anything external, so every subsequent retry repeated the identical no-op cycle.

The fix for that ("finish it if the evidence is already in hand") then caused a second, subtler failure on the very next recovery run on the same issue: every run starts from an empty message list, so nothing is *ever* literally "already in hand" at turn 1 — and the model reasoned exactly that ("I don't have the draft or brief content in context... reading them would be re-fetching data") and self-blocked a third time rather than make the two cheap reads the task already pointed it to. The note now says explicitly that reading the small number of documents a task already references is evidence-gathering, not redoing the task, even though it takes tool calls in a fresh run — the ban is on regenerating a deliverable or causing external side effects, not on the reads needed to decide.

`DEFAULT_SYSTEM_PROMPT` — present on every run, recovery or not — used to carry its own one-line summary of the recovery rule ("only record the disposition — do not redo the task"), stale and directly contradicting the fuller note above once that note stopped banning reads. The same model was reading two conflicting instructions on the same recovery wake. The system prompt now just says the recovery note's own instructions win; the specific rule lives in exactly one place.

A fourth pass on the same `DEBA-54` incident traced into the tools themselves, not just the prompt: the one run that got furthest into actually finishing the review ran out of its turn's token budget mid-generation, with 133k input tokens already spent. Two tool-level contributors, both now fixed: `library`/`issue_document`'s `action='list'` was returning every document's full body (Paperclip's endpoint always includes it) instead of just enough to decide what to `read`; and the biggest single cost was that recording a one-paragraph sign-off required `action='write'`'s "replace, don't diff" contract — retyping an entire multi-KB draft verbatim just to append a sentence. A new `action='append'` (on both `library` and `issue_document`) does the read-modify-write here instead, so the model only ever sends the new text. `list_issues` got the same treatment as `library`'s list — a lightweight id/title/status/priority/assignee/parent/updatedAt scan instead of Paperclip's full issue objects (`get_issue` already exists for one issue's full detail).

Before accepting a plain-text "I'm done" as the end of a run, `execute()` asks Paperclip for the issue's current status and gives the model an in-run nudge if it's still `in_progress` (and no `ask_user_questions` interaction is pending): a corrective message pointing out that no disposition was recorded and asking it to call the tool now. This exists because of a real, observed failure mode — a model confidently writing "closed done, verified in the API response" without ever having called the tool — that kept re-triggering Paperclip's cross-run `missing_disposition` recovery run after run on the same issue without fixing the underlying habit. One in-run nudge is cheaper and more effective than waiting on that slower loop.

An ordinary run gets exactly one nudge. A disposition-recovery wake (the "successful run handoff" above) gets **two**, since it's Paperclip's one corrective attempt before a board escalation. The second tells the model to stop re-analyzing and record the decision it has reached (`done` with its verdict), with `blocked` only if it truly can't decide. The model's own text and reasoning from the unanswered turn stay in the conversation, so a nudge never wipes out work it already did. A response cut off at the token limit isn't treated as the model stopping at all and doesn't spend a nudge (see "Max tokens and truncated responses"). If the model still doesn't comply after its nudges, status is left untouched as before.

### Capability flags

`createServerAdapter()` declares `supportsLocalAgentJwt` (required for Paperclip to inject the agent's scoped API `authToken` at all — without it every Paperclip API write is silently skipped) and `supportsInstructionsBundle` (unlocks Paperclip's managed "Instructions" editor for `adapterConfig.instructionsFilePath`, which is already read at runtime).

### Skills

Company-managed skills toggled in Paperclip's Skills panel are symlinked into the skills directory `loadSkills()` reads from (`src/server/skills.ts`, via `@paperclipai/adapter-utils/server-utils`'s persistent-skill helpers) — operator-dropped skills in the same directory are left untouched. Stream-json transcripts are unchanged from upstream.

## Configuration

### Max tokens and truncated responses

`maxTokens` caps everything the model generates in one response — reasoning, visible text, and tool-call arguments together. It isn't sent unless you set it, so the model's own maximum applies. It used to default to 4096, which cut reasoning models off mid-thought before they reached a tool call.

When a response is cut off anyway (`finish_reason: "length"`), the run log shows a `Response cut off…` line, and:
- With a configured `maxTokens`, the turn is retried once at double the value.
- Otherwise the model's partial output is kept in the conversation and it's told to continue from it with the tool call it was building toward. This doesn't count as a missed disposition.
- Tool calls whose arguments were cut off mid-JSON are never run. The model gets an error saying so, and suggesting `action='append'` instead of resending a whole document.

If an agent's runs end with empty text, no tool call, and thinking that stops mid-sentence, look for that `Response cut off` line first.

### Reasoning effort

`reasoning` (toggle) turns on extended thinking for models that support it; `reasoningEffort` (`low`/`medium`/`high`, default `medium`) controls how much. It used to be hardcoded to `high`.

### OpenRouter (default — no `baseUrl` needed)

```jsonc
{
  "model": "anthropic/claude-sonnet-4-6",
  "apiKey": "sk-or-v1-..."
}
```

Get a key at https://openrouter.ai/keys. Use `"openrouter/auto"` for auto-routing or append `:free` to any model id for free-tier routing.

### NVIDIA NIM

```jsonc
{
  "baseUrl": "https://integrate.api.nvidia.com/v1",
  "model": "moonshotai/kimi-k2.6",
  "apiKey": "nvapi-..."
}
```

NIM keys start with `nvapi-`. Models use `provider/model-name` format. Other examples: `deepseek-ai/deepseek-v4-pro`, `qwen/qwen3-coder-480b-a35b-instruct`, `nvidia/nemotron-3-super-120b-a12b`.

### Ollama (local)

```jsonc
{
  "baseUrl": "http://localhost:11434/v1",
  "model": "llama3.1"
}
```

No API key required for unauthenticated localhost. Run `ollama pull llama3.1` first.

### vLLM (self-hosted)

```jsonc
{
  "baseUrl": "http://your-vllm-host:8000/v1",
  "model": "meta-llama/Llama-3.1-70B-Instruct",
  "apiKey": "EMPTY"
}
```

vLLM follows the OpenAI schema natively. Set `apiKey` to whatever your vLLM server expects (often `"EMPTY"` for unauthenticated).

### DeepSeek (direct API)

```jsonc
{
  "baseUrl": "https://api.deepseek.com/v1",
  "model": "deepseek-chat",
  "apiKey": "sk-..."
}
```

Get a key at https://platform.deepseek.com.

## Environment variables

Paperclip's hire wizard has no field for this adapter's API key. Finish the wizard
(the test warns about the missing key), then set **API key** in the new agent's
Configuration, or set `LLM_API_KEY` on the server before hiring.

| Variable | Purpose |
| --- | --- |
| `LLM_API_KEY` | Primary auth env var, used as a fallback when `adapterConfig.apiKey` is unset. |
| `LLM_BASE_URL` | Provider whose `/models` fills the agent Model dropdown (default OpenRouter). Paperclip gives the picker no agent config, so set this to match the `baseUrl` your agents use. It doesn't change where runs go. |
| `LLM_MODEL` | Default model when no adapter config supplies one; also shown as the "detected" model in the picker. |
| `OPENROUTER_API_KEY` | Backwards-compat alias for `LLM_API_KEY`. |
| `OPENROUTER_MODEL` | Backwards-compat alias for `LLM_MODEL`. |
| `PAPERCLIP_SKILLS_DIR` | Override the skills root (default `~/.paperclip-llm-adapter/skills`). |

## Installation

This adapter is installed via Paperclip's **Local Path** option pointing at this repo's built `dist/` directory. The `dist/` directory is committed to git, so no build step is required at install time — but `node_modules/` is gitignored, so its runtime dependencies (`@paperclipai/adapter-utils`, `@paperclipai/shared`) still need to be installed once after cloning.

```bash
git clone https://github.com/calonmerc/paperclip-adapter-llm.git
cd paperclip-adapter-llm
npm install --omit=dev
# In Paperclip UI → Adapters → Add → Local Path
# Path: /absolute/path/to/paperclip-adapter-llm
```

## Building from source

```bash
npm install
npm run build
```

Emits to `dist/`.

## What's configurable end-to-end

| Layer | Status |
| --- | --- |
| `/models` env-test | ✅ Uses `baseUrl` |
| `/chat/completions` (the actual agent loop) | ✅ Uses `baseUrl` directly via `resolveEndpoints(baseUrl)` — no subprocess |
| Cost reporting | ✅ OpenRouter: each call's `usage.cost` (usage accounting), summed over the run. Other providers: `hourlyRateUsd` × model time if set, otherwise no cost. |
| Backwards compatibility | ✅ Existing OpenRouter installs need zero config changes. |

## Programmatic API

```ts
import { resolveEndpoints, isOpenRouter, isLocalEndpoint } from "paperclip-adapter-llm";

resolveEndpoints();
// → { base: "https://openrouter.ai/api/v1", models, chat, generation }

resolveEndpoints("https://integrate.api.nvidia.com/v1/");
// → { base: "https://integrate.api.nvidia.com/v1", ... }  (trailing slash stripped)

isOpenRouter();                                       // true
isOpenRouter("https://api.deepseek.com/v1");          // false
isLocalEndpoint("http://localhost:11434/v1");         // true
```

The full `LlmConfig` type and `createServerAdapter()` factory are exported from `./server`.

## Backwards compatibility

- `OpenRouterConfig` → type alias for `LlmConfig`.
- `OpenRouterFormValues` → type alias for `LlmFormValues`.
- `OPENROUTER_BASE_URL` / `_MODELS_ENDPOINT` / `_CHAT_ENDPOINT` / `_GENERATION_ENDPOINT` re-exported pointing at OpenRouter defaults.
- `listOpenRouterModels` re-exported as alias for `listModels`.
- `OPENROUTER_API_KEY` / `OPENROUTER_MODEL` env vars still honored.

## Credits

This adapter is forked from [`talhamahmood666/paperclip-adapter-openrouter`](https://github.com/talhamahmood666/paperclip-adapter-openrouter). The in-process tool-loop design, Paperclip API integration, skill loading, and transcript handling originate from the upstream project. This fork generalizes the LLM endpoint layer via `resolveEndpoints(baseUrl)` and removes a CLI-subprocess execution path (with unrestricted filesystem/shell tools) that an earlier revision of this fork had introduced, restoring the scoped, Paperclip-API-only tool set as the sole execution path.

## License

MIT (inherited from upstream).

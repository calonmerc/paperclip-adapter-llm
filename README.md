# paperclip-adapter-llm

**Generic OpenAI-compatible adapter for Paperclip.** One adapter, any provider that speaks the OpenAI `/chat/completions` schema — OpenRouter (default), NVIDIA NIM, Ollama, vLLM, DeepSeek direct, and more.

[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)]()
[![Built for Paperclip](https://img.shields.io/badge/built%20for-Paperclip-8b5cf6)]()

---

## What this is

A fork of [`talhamahmood666/paperclip-adapter-openrouter`](https://github.com/talhamahmood666/paperclip-adapter-openrouter) with the OpenRouter base URL extracted into a configurable `baseUrl` field. `execute()` runs an in-process, multi-turn tool-calling loop against the configured chat/completions endpoint. If `baseUrl` is unset, the LLM endpoint defaults to OpenRouter.

### Tools

14 scoped tools, no shell access, no arbitrary filesystem access:

- `get_issue`, `update_issue_status`, `update_issue`, `add_comment`, `list_comments`, `create_sub_issue`, `list_issues`, `list_agents` — standard Paperclip issue/company operations. `update_issue_status` is status only; `update_issue` covers everything else (title, description, priority, assignee, and — its original motivating use case — replacing a stale `blockedByIssueIds` set, e.g. blockers pointing at an issue that's since been cancelled).
- `hire_agent`, `request_approval` — route through Paperclip's approval flow unless `autoApprove` is set.
- `ask_user_questions` — creates a real Paperclip issue-thread interaction (`continuationPolicy: wake_assignee`) and ends the run immediately after (the model cannot get a real answer within the same run).
- `list_interactions` — lists every interaction ever created on an issue, oldest first, with answers. Each run reconstructs its context from scratch with no memory of earlier runs, and the wake prompt's "this interaction is answered" note only ever covers the single most recent card — this is the only reliable way for the model to recall a multi-round Q&A (e.g. a multi-part interview) across several heartbeats instead of losing track and re-asking.
- `issue_document` — reads/writes/lists real Paperclip documents on an issue (`PUT /api/issues/:id/documents/:key`), with revision history, visible in the Documents panel in the web UI. Use this for anything a human should actually see and review.
- `memory_fs` — scoped file-based memory for skills like `para-memory-files` that expect real file read/write. Two isolated roots: `scope: "private"` (one directory per agent — what such skills call `$AGENT_HOME`) and `scope: "shared"` (one directory every agent in the company can read/write — for things a skill says to keep outside personal memory, e.g. its `plans/` convention). Every path is resolved and containment-checked against the chosen scope's root — there is no way to escape it, and no shell execution (a plain keyword search stands in for a skill's `qmd` command, if it references one). Not visible in the web UI — for that, use `issue_document` instead.

### Disposition handling

The adapter never guesses an issue's final disposition: a run only changes issue status when the model explicitly calls `update_issue_status`, or on `max_turns`/an unrecoverable error (both `blocked`). A plain-text turn with no such call leaves status untouched, and Paperclip's own `missing_disposition` recovery owns prompting the agent for a real disposition.

Before accepting a plain-text "I'm done" as the end of a run, `execute()` gives the model exactly one in-run nudge if it never called `update_issue_status` or created an `ask_user_questions` interaction: a corrective message pointing out that no disposition was recorded and asking it to call the tool now. This exists because of a real, observed failure mode — a model confidently writing "closed done, verified in the API response" without ever having called the tool — that kept re-triggering Paperclip's cross-run `missing_disposition` recovery run after run on the same issue without fixing the underlying habit. One in-run nudge is cheaper and more effective than waiting on that slower loop. If the model still doesn't comply after the nudge, status is left untouched as before.

### Capability flags

`createServerAdapter()` declares `supportsLocalAgentJwt` (required for Paperclip to inject the agent's scoped API `authToken` at all — without it every Paperclip API write is silently skipped) and `supportsInstructionsBundle` (unlocks Paperclip's managed "Instructions" editor for `adapterConfig.instructionsFilePath`, which is already read at runtime).

### Skills

Company-managed skills toggled in Paperclip's Skills panel are symlinked into the skills directory `loadSkills()` reads from (`src/server/skills.ts`, via `@paperclipai/adapter-utils/server-utils`'s persistent-skill helpers) — operator-dropped skills in the same directory are left untouched. Stream-json transcripts are unchanged from upstream.

## Configuration

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

| Variable | Purpose |
| --- | --- |
| `LLM_API_KEY` | Primary auth env var, used as a fallback when `adapterConfig.apiKey` is unset. |
| `LLM_BASE_URL` | Optional override for `baseUrl`. |
| `LLM_MODEL` | Default model when no adapter config supplies one. |
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
| `/generation` cost reporting | ⚠️ OpenRouter-specific endpoint — only attempted when `baseUrl` resolves to OpenRouter; cost shows `$0`/`null` for other providers. |
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

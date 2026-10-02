// ─────────────────────────────────────────────────────────────────
// paperclip-adapter-llm — Root Metadata (src/index.ts)
// Generic OpenAI-compatible adapter (OpenRouter is the default base URL).
// Shared across server · ui · cli — keep dependency-free.
// ─────────────────────────────────────────────────────────────────
export const type = "llm";
export const label = "LLM (OpenAI-compatible)";
// ── Static models ───────────────────────────────────────────────
// Intentionally empty: the picker is populated live by listModels() from
// the provider at LLM_BASE_URL (server env). A hardcoded list goes stale
// and only ever matched one provider.
export const models = [];
// ── Endpoint resolution ─────────────────────────────────────────
export const DEFAULT_BASE_URL = "https://openrouter.ai/api/v1";
export function resolveEndpoints(baseUrl) {
    const base = (baseUrl || DEFAULT_BASE_URL).replace(/\/+$/, "");
    return {
        base,
        models: `${base}/models`,
        chat: `${base}/chat/completions`,
        generation: `${base}/generation`,
    };
}
/** True when the resolved base URL is OpenRouter (or unset). */
export function isOpenRouter(baseUrl) {
    const b = (baseUrl || DEFAULT_BASE_URL).replace(/\/+$/, "");
    return b === DEFAULT_BASE_URL;
}
/** True when the base URL points at a localhost host (Ollama / vLLM). */
export function isLocalEndpoint(baseUrl) {
    if (!baseUrl)
        return false;
    try {
        const url = new URL(baseUrl);
        return ["localhost", "127.0.0.1", "0.0.0.0", "::1"].includes(url.hostname);
    }
    catch {
        return false;
    }
}
// ── Deprecated re-exports (backwards compat) ────────────────────
/** @deprecated Use resolveEndpoints() */
export const OPENROUTER_BASE_URL = DEFAULT_BASE_URL;
/** @deprecated Use resolveEndpoints(baseUrl).models */
export const OPENROUTER_MODELS_ENDPOINT = `${DEFAULT_BASE_URL}/models`;
/** @deprecated Use resolveEndpoints(baseUrl).chat */
export const OPENROUTER_CHAT_ENDPOINT = `${DEFAULT_BASE_URL}/chat/completions`;
/** @deprecated Use resolveEndpoints(baseUrl).generation */
export const OPENROUTER_GENERATION_ENDPOINT = `${DEFAULT_BASE_URL}/generation`;
// ── Adapter documentation ───────────────────────────────────────
export const agentConfigurationDoc = `# llm adapter configuration

## Use when
- You want a single Paperclip adapter that can talk to any OpenAI-compatible endpoint.
- You're using OpenRouter (default), NVIDIA NIM, Ollama, vLLM, DeepSeek direct, or any
  other provider that speaks the OpenAI \`/chat/completions\` schema.

## Core fields
- \`baseUrl\` (string, optional) — OpenAI-compatible base URL. Default: OpenRouter.
- \`model\` (string) — Model ID. Format depends on the provider.
- \`apiKey\` (string) — Provider API key. Optional for unauthenticated localhost
  endpoints (Ollama, vLLM). Can also be set via \`LLM_API_KEY\` (or
  \`OPENROUTER_API_KEY\` for backwards compat).
- Model picker: Paperclip calls \`listModels()\` without any agent config, so the
  dropdown is filled from the server env — \`GET $LLM_BASE_URL/models\` (default:
  OpenRouter), authenticated with \`LLM_API_KEY\` when set. An agent's own
  \`baseUrl\` doesn't change the picker; type a model id to use one not listed.
- \`systemPrompt\` (string, optional) — System prompt prepended to all messages.
- \`temperature\` (number, optional) — 0–2. Default: 0.7
- \`maxTokens\` (number, optional) — Cap on everything the model generates in one response
  (reasoning, text, tool-call arguments). Default: not sent, so the model's own maximum
  applies. A low value cuts responses off mid-thought; if that happens with a configured
  cap, the turn is retried once at double, then continued from the partial output.
- \`topP\` (number, optional) — Nucleus sampling. Default: 1
- \`stream\` (boolean, optional) — SSE streaming. Default: true
- \`reasoning\` (boolean, optional) — Extended thinking for supported models.
- \`reasoningEffort\` ("low" | "medium" | "high", optional) — Only used when \`reasoning\`
  is on. Default: "medium".
- \`maxTurns\` (number, optional) — Max tool-loop turns per run. Default: 25
- \`autoApprove\` (boolean, optional) — Skip approval gates for hire_agent and similar mutating tools.
- \`skillsDir\` (string, optional) — Override path to the skills directory.
- \`instructionsFilePath\` (string, optional) — Absolute path to a markdown file read at
  runtime and prepended to the system prompt (takes precedence over \`systemPrompt\` if
  both are set). Manageable through Paperclip's own "Instructions" bundle editor in the
  agent UI — this adapter declares \`supportsInstructionsBundle\`.
- \`libraryIssue\` (string, optional) — Issue id or identifier (e.g. \`DEBA-50\`) to use as
  the company Library, where the \`library\` tool keeps shared documents. Defaults to the
  oldest unassigned issue titled "Company Library", created on first use.
- \`agentHomeDir\` (string, optional) — Legacy. Where the retired \`memory_fs\` tool kept
  hidden files (default \`~/.paperclip-llm-adapter/homes\`). Only read, once, to migrate
  leftover files into Library documents; nothing writes there anymore.
- \`hourlyRateUsd\` (number, optional) — Cost per hour of model time, for self-hosted
  endpoints with no real price (llama-swap, Ollama, vLLM). Only the time spent waiting on
  the model counts, not tool calls. Used only when the provider doesn't report a cost.

Cost: OpenRouter's own per-call cost (usage accounting) is summed over the run. Other
providers report \`hourlyRateUsd\` × model time if set, and no cost otherwise.

OpenRouter-specific fields (ignored by other providers):
- \`transforms\` (string[]) — e.g. ["middle-out"]
- \`route\` ("fallback" | "no-fallback")
- \`httpReferer\`, \`xTitle\` — leaderboard attribution

## Provider examples

### OpenRouter (default)
\`\`\`json
{
  "model": "anthropic/claude-sonnet-4-6",
  "apiKey": "sk-or-v1-..."
}
\`\`\`

### NVIDIA NIM
Use the \`provider/model-name\` format and an \`nvapi-...\` key.
\`\`\`json
{
  "baseUrl": "https://integrate.api.nvidia.com/v1",
  "model": "moonshotai/kimi-k2.6",
  "apiKey": "nvapi-..."
}
\`\`\`

### Ollama (local)
\`\`\`json
{
  "baseUrl": "http://localhost:11434/v1",
  "model": "llama3.1",
  "hourlyRateUsd": 0.05
}
\`\`\`

### vLLM (self-hosted)
\`\`\`json
{
  "baseUrl": "http://your-vllm-host:8000/v1",
  "model": "meta-llama/Llama-3.1-70B-Instruct"
}
\`\`\`

### DeepSeek (direct API)
\`\`\`json
{
  "baseUrl": "https://api.deepseek.com/v1",
  "model": "deepseek-chat",
  "apiKey": "sk-..."
}
\`\`\`

## Don't use when
- You need a feature that requires native, non-OpenAI-compatible APIs (file
  upload, vision-only providers, etc.). Use a provider-specific adapter.
`;
// Re-export createServerAdapter so the Paperclip plugin loader can find it on the package main entry.
export { createServerAdapter } from "./server/index.js";
//# sourceMappingURL=index.js.map
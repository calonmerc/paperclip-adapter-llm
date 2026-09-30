// ─────────────────────────────────────────────────────────────────
// paperclip-adapter-llm — Root Metadata (src/index.ts)
// Generic OpenAI-compatible adapter (OpenRouter is the default base URL).
// Shared across server · ui · cli — keep dependency-free.
// ─────────────────────────────────────────────────────────────────
export const type = "llm";
export const label = "LLM (OpenAI-compatible)";
// ── Static fallback models (shown when API is unreachable) ──────
export const models = [
    // OpenRouter — free tier
    { id: "openrouter/auto", label: "Auto (best free route, OpenRouter)" },
    { id: "meta-llama/llama-4-maverick:free", label: "Llama 4 Maverick (free, OpenRouter)" },
    { id: "meta-llama/llama-4-scout:free", label: "Llama 4 Scout (free, OpenRouter)" },
    { id: "google/gemma-3-27b-it:free", label: "Gemma 3 27B (free, OpenRouter)" },
    { id: "deepseek/deepseek-chat-v3-0324:free", label: "DeepSeek V3 0324 (free, OpenRouter)" },
    { id: "qwen/qwen3-235b-a22b:free", label: "Qwen3 235B (free, OpenRouter)" },
    { id: "mistralai/mistral-small-3.2-24b-instruct:free", label: "Mistral Small 3.2 (free, OpenRouter)" },
    // OpenRouter — paid frontier
    { id: "anthropic/claude-sonnet-4-6", label: "Claude Sonnet 4.6 (OpenRouter)" },
    { id: "anthropic/claude-opus-4-6", label: "Claude Opus 4.6 (OpenRouter)" },
    { id: "openai/gpt-4.1", label: "GPT-4.1 (OpenRouter)" },
    { id: "openai/o4-mini", label: "o4-mini (OpenRouter)" },
    { id: "google/gemini-2.5-pro-preview", label: "Gemini 2.5 Pro (OpenRouter)" },
    { id: "google/gemini-2.5-flash-preview", label: "Gemini 2.5 Flash (OpenRouter)" },
    { id: "deepseek/deepseek-r1", label: "DeepSeek R1 (OpenRouter)" },
    { id: "meta-llama/llama-4-maverick", label: "Llama 4 Maverick (OpenRouter)" },
    // OpenRouter — paid mid-tier
    { id: "anthropic/claude-haiku-4-5", label: "Claude Haiku 4.5 (OpenRouter)" },
    { id: "openai/gpt-4.1-mini", label: "GPT-4.1 Mini (OpenRouter)" },
    { id: "mistralai/mistral-medium-3", label: "Mistral Medium 3 (OpenRouter)" },
    { id: "qwen/qwen3-235b-a22b", label: "Qwen3 235B (OpenRouter)" },
    // NVIDIA NIM (set baseUrl: https://integrate.api.nvidia.com/v1)
    { id: "moonshotai/kimi-k2.6", label: "Kimi K2.6 (NIM)" },
    { id: "deepseek-ai/deepseek-v4-pro", label: "DeepSeek V4 Pro (NIM)" },
    { id: "qwen/qwen3-coder-480b-a35b-instruct", label: "Qwen3 Coder 480B (NIM)" },
    { id: "nvidia/nemotron-3-super-120b-a12b", label: "Nemotron 3 Super 120B (NIM)" },
];
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
- \`systemPrompt\` (string, optional) — System prompt prepended to all messages.
- \`temperature\` (number, optional) — 0–2. Default: 0.7
- \`maxTokens\` (number, optional) — Max completion tokens. Default: 4096
- \`topP\` (number, optional) — Nucleus sampling. Default: 1
- \`stream\` (boolean, optional) — SSE streaming. Default: true
- \`reasoning\` (boolean, optional) — Extended thinking for supported models.
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
  "model": "llama3.1"
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
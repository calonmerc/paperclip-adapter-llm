// ─────────────────────────────────────────────────────────────────
// paperclip-adapter-llm — Root Metadata (src/index.ts)
// Generic OpenAI-compatible adapter (OpenRouter is the default base URL).
// Shared across server · ui · cli — keep dependency-free.
// ─────────────────────────────────────────────────────────────────

export const type = "llm" as const;
export const label = "LLM (OpenAI-compatible)";

// ── Static models ───────────────────────────────────────────────
// Intentionally empty: the picker is populated live by listModels() from
// the provider at LLM_BASE_URL (server env). A hardcoded list goes stale
// and only ever matched one provider.
export const models: { id: string; label: string }[] = [];

// ── Endpoint resolution ─────────────────────────────────────────
export const DEFAULT_BASE_URL = "https://openrouter.ai/api/v1";

export interface ResolvedEndpoints {
  base: string;
  models: string;
  chat: string;
  /** OpenRouter-specific cost endpoint; gracefully 404s on other providers. */
  generation: string;
}

export function resolveEndpoints(baseUrl?: string): ResolvedEndpoints {
  const base = (baseUrl || DEFAULT_BASE_URL).replace(/\/+$/, "");
  return {
    base,
    models: `${base}/models`,
    chat: `${base}/chat/completions`,
    generation: `${base}/generation`,
  };
}

/** True when the resolved base URL is OpenRouter (or unset). */
export function isOpenRouter(baseUrl?: string): boolean {
  const b = (baseUrl || DEFAULT_BASE_URL).replace(/\/+$/, "");
  return b === DEFAULT_BASE_URL;
}

/** True when the base URL points at a localhost host (Ollama / vLLM). */
export function isLocalEndpoint(baseUrl?: string): boolean {
  if (!baseUrl) return false;
  try {
    const url = new URL(baseUrl);
    return ["localhost", "127.0.0.1", "0.0.0.0", "::1"].includes(url.hostname);
  } catch {
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

// ── Types ───────────────────────────────────────────────────────
export interface OpenRouterModel {
  id: string;
  name: string;
  pricing: {
    prompt: string;
    completion: string;
    request?: string;
    image?: string;
  };
  context_length: number;
  top_provider?: {
    max_completion_tokens?: number;
    is_moderated?: boolean;
  };
  per_request_limits?: Record<string, string> | null;
  architecture?: {
    modality: string;
    tokenizer: string;
    instruct_type: string | null;
  };
}

export interface LlmConfig {
  /** OpenAI-compatible base URL. Defaults to OpenRouter. */
  baseUrl?: string;
  model: string;
  apiKey?: string;
  systemPrompt?: string;
  temperature?: number;
  maxTokens?: number;
  topP?: number;
  stream?: boolean;
  reasoning?: boolean;
  /** Only used when reasoning is on. Default "medium" — see getConfigSchema's hint. */
  reasoningEffort?: "low" | "medium" | "high";
  /** OpenRouter-specific. Comma-separated string when set via the config-schema form field. */
  transforms?: string[] | string;
  /** OpenRouter-specific. */
  route?: "fallback" | "no-fallback";
  /** OpenRouter-specific. */
  httpReferer?: string;
  /** OpenRouter-specific. */
  xTitle?: string;
  /** Max tool-loop turns per run. Default 25. */
  maxTurns?: number;
  /** Skip approval gates for hire_agent and similar mutating tools. Default false. */
  autoApprove?: boolean;
  /** Override path to skills directory. Defaults to ~/.paperclip-llm-adapter/skills. */
  skillsDir?: string;
  /** Absolute path to a markdown file that will be read at runtime and
   * prepended to the system prompt. Takes precedence over systemPrompt
   * if both are set. */
  instructionsFilePath?: string;
  /** Issue id/identifier pinned as the company Library. See library.ts. */
  libraryIssue?: string;
  /** Legacy memory_fs location, read only by the one-time migration. See memory-fs.ts. */
  agentHomeDir?: string;
}

/** @deprecated Use LlmConfig. */
export type OpenRouterConfig = LlmConfig;

// Re-export createServerAdapter so the Paperclip plugin loader can find it on the package main entry.
export { createServerAdapter } from "./server/index.js";

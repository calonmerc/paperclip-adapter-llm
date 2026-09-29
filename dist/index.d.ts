export declare const type: "llm";
export declare const label = "LLM (OpenAI-compatible)";
export declare const models: {
    id: string;
    label: string;
}[];
export declare const DEFAULT_BASE_URL = "https://openrouter.ai/api/v1";
export interface ResolvedEndpoints {
    base: string;
    models: string;
    chat: string;
    /** OpenRouter-specific cost endpoint; gracefully 404s on other providers. */
    generation: string;
}
export declare function resolveEndpoints(baseUrl?: string): ResolvedEndpoints;
/** True when the resolved base URL is OpenRouter (or unset). */
export declare function isOpenRouter(baseUrl?: string): boolean;
/** True when the base URL points at a localhost host (Ollama / vLLM). */
export declare function isLocalEndpoint(baseUrl?: string): boolean;
/** @deprecated Use resolveEndpoints() */
export declare const OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";
/** @deprecated Use resolveEndpoints(baseUrl).models */
export declare const OPENROUTER_MODELS_ENDPOINT = "https://openrouter.ai/api/v1/models";
/** @deprecated Use resolveEndpoints(baseUrl).chat */
export declare const OPENROUTER_CHAT_ENDPOINT = "https://openrouter.ai/api/v1/chat/completions";
/** @deprecated Use resolveEndpoints(baseUrl).generation */
export declare const OPENROUTER_GENERATION_ENDPOINT = "https://openrouter.ai/api/v1/generation";
export declare const agentConfigurationDoc = "# llm adapter configuration\n\n## Use when\n- You want a single Paperclip adapter that can talk to any OpenAI-compatible endpoint.\n- You're using OpenRouter (default), NVIDIA NIM, Ollama, vLLM, DeepSeek direct, or any\n  other provider that speaks the OpenAI `/chat/completions` schema.\n\n## Core fields\n- `baseUrl` (string, optional) \u2014 OpenAI-compatible base URL. Default: OpenRouter.\n- `model` (string) \u2014 Model ID. Format depends on the provider.\n- `apiKey` (string) \u2014 Provider API key. Optional for unauthenticated localhost\n  endpoints (Ollama, vLLM). Can also be set via `LLM_API_KEY` (or\n  `OPENROUTER_API_KEY` for backwards compat).\n- `systemPrompt` (string, optional) \u2014 System prompt prepended to all messages.\n- `temperature` (number, optional) \u2014 0\u20132. Default: 0.7\n- `maxTokens` (number, optional) \u2014 Max completion tokens. Default: 4096\n- `topP` (number, optional) \u2014 Nucleus sampling. Default: 1\n- `stream` (boolean, optional) \u2014 SSE streaming. Default: true\n- `reasoning` (boolean, optional) \u2014 Extended thinking for supported models.\n- `maxTurns` (number, optional) \u2014 Max tool-loop turns per run. Default: 25\n- `autoApprove` (boolean, optional) \u2014 Skip approval gates for hire_agent and similar mutating tools.\n- `skillsDir` (string, optional) \u2014 Override path to the skills directory.\n- `instructionsFilePath` (string, optional) \u2014 Absolute path to a markdown file read at\n  runtime and prepended to the system prompt (takes precedence over `systemPrompt` if\n  both are set). Manageable through Paperclip's own \"Instructions\" bundle editor in the\n  agent UI \u2014 this adapter declares `supportsInstructionsBundle`.\n\nOpenRouter-specific fields (ignored by other providers):\n- `transforms` (string[]) \u2014 e.g. [\"middle-out\"]\n- `route` (\"fallback\" | \"no-fallback\")\n- `httpReferer`, `xTitle` \u2014 leaderboard attribution\n\n## Provider examples\n\n### OpenRouter (default)\n```json\n{\n  \"model\": \"anthropic/claude-sonnet-4-6\",\n  \"apiKey\": \"sk-or-v1-...\"\n}\n```\n\n### NVIDIA NIM\nUse the `provider/model-name` format and an `nvapi-...` key.\n```json\n{\n  \"baseUrl\": \"https://integrate.api.nvidia.com/v1\",\n  \"model\": \"moonshotai/kimi-k2.6\",\n  \"apiKey\": \"nvapi-...\"\n}\n```\n\n### Ollama (local)\n```json\n{\n  \"baseUrl\": \"http://localhost:11434/v1\",\n  \"model\": \"llama3.1\"\n}\n```\n\n### vLLM (self-hosted)\n```json\n{\n  \"baseUrl\": \"http://your-vllm-host:8000/v1\",\n  \"model\": \"meta-llama/Llama-3.1-70B-Instruct\"\n}\n```\n\n### DeepSeek (direct API)\n```json\n{\n  \"baseUrl\": \"https://api.deepseek.com/v1\",\n  \"model\": \"deepseek-chat\",\n  \"apiKey\": \"sk-...\"\n}\n```\n\n## Don't use when\n- You need a feature that requires native, non-OpenAI-compatible APIs (file\n  upload, vision-only providers, etc.). Use a provider-specific adapter.\n";
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
}
/** @deprecated Use LlmConfig. */
export type OpenRouterConfig = LlmConfig;
export { createServerAdapter } from "./server/index.js";
//# sourceMappingURL=index.d.ts.map
/**
 * Declarative config schema served from GET /api/adapters/llm/config-schema.
 * Paperclip's agent-config UI (SchemaConfigFields) renders this into the
 * "Configuration" section for any adapter that implements getConfigSchema —
 * without it, external adapters get no per-agent config fields at all.
 *
 * `model` is intentionally omitted: Paperclip's model picker in the
 * "Adapter" section already reads `models`/`listModels`/`detectModel` from
 * the server barrel and writes `adapterConfig.model` directly.
 */
export function getConfigSchema() {
    return {
        fields: [
            {
                key: "apiKey",
                label: "API key",
                type: "text",
                hint: "NIM keys start with `nvapi-`. OpenRouter keys with `sk-or-`. Leave empty for localhost endpoints (Ollama, vLLM unauthenticated).",
                meta: { secret: true },
            },
            {
                key: "baseUrl",
                label: "Base URL",
                type: "text",
                hint: "Optional override for the OpenAI-compatible endpoint. Leave empty for OpenRouter default.",
            },
            {
                key: "systemPrompt",
                label: "System prompt",
                type: "textarea",
                hint: "System prompt prepended to all messages.",
            },
            {
                key: "temperature",
                label: "Temperature",
                type: "number",
                default: 0.7,
                hint: "0–2. Default: 0.7",
            },
            {
                key: "maxTokens",
                label: "Max tokens",
                type: "number",
                default: 4096,
                hint: "Max completion tokens.",
            },
            {
                key: "topP",
                label: "Top P",
                type: "number",
                hint: "Nucleus sampling. Default: 1",
            },
            {
                key: "stream",
                label: "Enable streaming",
                type: "toggle",
                default: true,
            },
            {
                key: "reasoning",
                label: "Enable reasoning (extended thinking)",
                type: "toggle",
                default: false,
                hint: "Only works with models that support reasoning (DeepSeek R1, QwQ, etc.)",
            },
            {
                key: "maxTurns",
                label: "Max tool-loop turns",
                type: "number",
                default: 25,
                hint: "Max tool-calling turns per run before the loop is cut off.",
            },
            {
                key: "autoApprove",
                label: "Auto-approve mutating tools",
                type: "toggle",
                default: false,
                hint: "Skip approval gates for hire_agent and similar mutating tools.",
            },
            {
                key: "skillsDir",
                label: "Skills directory",
                type: "text",
                hint: "Override path to the skills directory. Defaults to ~/.paperclip-llm-adapter/skills.",
            },
            {
                key: "agentHomeDir",
                label: "Agent memory directory",
                type: "text",
                hint: "Override the base directory for the memory_fs tool (file-based memory for skills like " +
                    "para-memory-files). Defaults to ~/.paperclip-llm-adapter/homes. Private notes live under " +
                    "<dir>/<companyId>/agents/<agentId>/; notes shared with every agent in the company live under " +
                    "<dir>/<companyId>/shared/.",
            },
            {
                key: "instructionsFilePath",
                label: "Instructions file path",
                type: "text",
                hint: "Absolute path to a markdown file read at runtime and prepended to the system prompt. Takes precedence over System prompt if both are set.",
            },
            {
                key: "route",
                label: "Routing strategy (OpenRouter only)",
                type: "select",
                default: "fallback",
                options: [
                    { value: "fallback", label: "Fallback (auto-retry with other providers)" },
                    { value: "no-fallback", label: "No fallback (single provider only)" },
                ],
            },
            {
                key: "transforms",
                label: "Transforms (OpenRouter only)",
                type: "text",
                hint: "Comma-separated, e.g. middle-out",
            },
            {
                key: "httpReferer",
                label: "HTTP-Referer (OpenRouter only)",
                type: "text",
                hint: "Leaderboard attribution header.",
            },
            {
                key: "xTitle",
                label: "X-Title (OpenRouter only)",
                type: "text",
                hint: "Leaderboard attribution header.",
            },
        ],
    };
}
//# sourceMappingURL=config-schema.js.map
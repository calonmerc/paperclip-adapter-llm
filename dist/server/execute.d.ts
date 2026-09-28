/**
 * LLM adapter execute() — in-process, multi-turn tool-calling loop.
 *
 * Responsibilities:
 *   - Build messages from Paperclip wake context + skills
 *   - Run a tool-calling loop against the configured OpenAI-compatible
 *     chat/completions endpoint (OpenRouter, NVIDIA NIM, Ollama, vLLM,
 *     DeepSeek, or any other provider that speaks the same schema)
 *   - Expose only scoped Paperclip-API tools (src/server/tools.ts) — no
 *     filesystem or shell access
 *   - Manage issue state (checkout lock, in_progress at start, done/blocked
 *     at end)
 *   - Post the final assistant output as an issue comment
 *   - Emit typed TranscriptEntry lines so the run viewer renders properly
 *   - Track usage and cost via OpenRouter's /generation endpoint (OpenRouter
 *     only — other providers don't have an equivalent, so cost stays null)
 *
 * Aligned with @paperclipai/adapter-utils 2026.428.0 API surface:
 *   - PaperclipApi exposes updateIssue / addIssueComment (not updateIssueState / addComment)
 *   - UsageSummary has only inputTokens / outputTokens / cachedInputTokens
 *   - AdapterExecutionResult requires exitCode / signal / timedOut; costUsd is top-level
 *   - renderPaperclipWakePrompt takes { resumedSession? } only
 *   - emitInit requires sessionId; emitToolCall uses { name, input, toolUseId }
 *   - ctx.config (not ctx.agent.adapterConfig) is the resolved adapterConfig
 *
 * Out of scope for v1 (deferred):
 *   - Token streaming inside the tool loop (non-streaming is more reliable
 *     for tool calls on free/small models)
 *   - Pause-and-resume runs on async approval callbacks (hire_agent is
 *     routed through approvals, but the run doesn't wait on the outcome)
 *   - Attachment / multimodal handling
 */
import type { AdapterExecutionContext, AdapterExecutionResult } from "@paperclipai/adapter-utils";
export declare function execute(ctx: AdapterExecutionContext): Promise<AdapterExecutionResult>;
//# sourceMappingURL=execute.d.ts.map
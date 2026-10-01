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
 * Aligned with @paperclipai/adapter-utils 2026.916.1 API surface:
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
/**
 * Paperclip's missing-disposition recovery (a "successful run handoff") puts
 * its instructions at the top level of the run context — `handoffRequired`
 * plus a ready-made `instruction` — not in paperclipWake, so the wake
 * renderer never shows them. Without this, the corrective run looks like an
 * ordinary wake: the model redoes the whole task (and can fail it again),
 * spends Paperclip's single corrective attempt, and the issue escalates to
 * the board with "Missing disposition recovery blocked".
 */
export declare function isDispositionRecoveryWake(context: Record<string, unknown>): boolean;
/**
 * This used to list 5 "valid" options for the model to weigh against each
 * other (done / in_review / blocked / ask_user_questions / create a
 * sub-issue). Two real recovery runs (DEBA-53, DEBA-54) got stuck comparing
 * them — tens of thousands of reasoning tokens spent on "which path is more
 * correct" with no tool call to show for it. An ordered checklist with a
 * named safe default removes the comparison itself instead of just capping
 * how long the model gets to make it (see the two-nudge fallback below,
 * which still exists for when a model ignores even this).
 *
 * Step 1 used to flatly forbid finishing the task ("do NOT redo the work").
 * On DEBA-54 that produced a worse failure: a human retry woke the agent on
 * an ordinary heartbeat, it read the draft + brief (already fully in hand)
 * and got most of the way through a real compliance verdict, then caught
 * itself ("this is disposition-only, don't redo the task") and threw the
 * analysis away to self-block instead — "owner: me, action: try again
 * later." The next retry repeated the identical cycle: nothing was actually
 * blocked on anything external, so "blocked" never resolved. Step 1 was
 * rewritten to let the model finish a judgment call it already has the
 * inputs for, phrased as "already in hand" / "already see below" — which
 * then caused a THIRD failure on the very next recovery run: every run of
 * this adapter starts from a fresh message list (see the comment on that
 * below in execute()), so nothing is ever literally "already in hand" at
 * turn 1 of a recovery run, and the model reasoned exactly that: "I don't
 * have the draft or brief content in context... reading them would be
 * re-fetching data" — and blocked itself again rather than make the two
 * cheap reads the task already pointed it to. Step 1 now says explicitly
 * that reading the small number of documents a task already references is
 * evidence-gathering, not redoing the task, even though it takes tool calls
 * in a fresh run. The ban is on regenerating a deliverable or repeating
 * work with external side effects — not on the reads needed to decide.
 */
export declare function renderDispositionHandoffNote(context: Record<string, unknown>): string;
export declare function execute(ctx: AdapterExecutionContext): Promise<AdapterExecutionResult>;
//# sourceMappingURL=execute.d.ts.map
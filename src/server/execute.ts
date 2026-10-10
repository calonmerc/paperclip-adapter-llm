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
 *   - Sum usage and cost across every call: OpenRouter's per-response
 *     usage.cost, else model time × the configured hourlyRateUsd
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

import type {
  AdapterExecutionContext,
  AdapterExecutionResult,
  UsageSummary,
} from "@paperclipai/adapter-utils";
import fs from "node:fs/promises";
import {
  isPaperclipRuntimeEnvKey,
  joinPromptSections,
  renderPaperclipWakePrompt,
  selectPaperclipTaskMarkdown,
} from "@paperclipai/adapter-utils/server-utils";

import {
  DEFAULT_BASE_URL,
  resolveEndpoints,
  isOpenRouter,
  type LlmConfig,
  type ResolvedEndpoints,
} from "../index.js";
import { PaperclipApi } from "./paperclip-api.js";
import {
  buildTools,
  detectPaperclipFeatures,
  toolSchemas,
  findTool,
  targetsCurrentIssue,
  type PaperclipFeatures,
  type Tool,
} from "./tools.js";
import { collectBoundSecrets, SecretStore } from "./http-request.js";
import { LibraryResolver, migrateMemoryToLibrary } from "./library.js";
import { loadSkills, renderSkillsForPrompt, reconcilePaperclipSkills } from "./skills.js";
import {
  emitInit,
  emitAssistant,
  emitThinking,
  emitToolCall,
  emitToolResult,
  emitResult,
  emitSystem,
  writeRawStderr,
} from "./transcript.js";

// ----- types matching OpenAI-compatible chat completions -----

interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  name?: string;
  tool_calls?: Array<{
    id: string;
    type: "function";
    function: { name: string; arguments: string };
  }>;
  tool_call_id?: string;
}

interface ChatCompletionResponse {
  id: string;
  /** OpenRouter: the upstream provider that served this response. */
  provider?: string;
  choices: Array<{
    finish_reason: string | null;
    message: {
      role: "assistant";
      content: string | null;
      reasoning?: string | null;
      tool_calls?: Array<{
        id: string;
        type: "function";
        function: { name: string; arguments: string };
      }>;
    };
  }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
    prompt_tokens_details?: { cached_tokens?: number };
    /** OpenRouter usage accounting, in USD. Under BYOK it is only OpenRouter's fee. */
    cost?: number;
    is_byok?: boolean;
    cost_details?: { upstream_inference_cost?: number };
  };
}

// ----- helpers -----

const DEFAULT_MAX_TURNS = 25;
const DEFAULT_SYSTEM_PROMPT =
  "You are an AI agent working inside Paperclip, an autonomous company orchestration system. " +
  "When you receive a wake payload, your job is to EXECUTE the assigned task — not describe it. " +
  "Use the tools available to you to read context, post comments, update status, and delegate work. " +
  "If you need information only a human can provide before continuing, call the ask_user_questions tool " +
  "instead of guessing, stalling, or writing out a question as plain text — it pauses the issue and wakes " +
  "you again once someone answers. Never say you've posted a question, a card, or anything else unless " +
  "you actually called the tool that does it in this same turn — narrating an action you didn't take " +
  "leaves the issue with no real interaction and wastes an entire round-trip. If this wake includes an " +
  "'Interaction ... is answered' section, that covers only the single most recent card — it is " +
  "authoritative for that one, but says nothing about earlier rounds. On any multi-round task (e.g. a " +
  "multi-part interview), call list_interactions first to see everything already asked and answered " +
  "before asking a new round — get_issue and list_comments do not show interaction history, and you " +
  "have no memory of earlier runs otherwise. " +
  "Every run must end with an explicit disposition on your issue — there is no default, and an issue " +
  "left in_progress counts as a missing disposition. The only valid endings are: " +
  "update_issue_status status='done' (finished) or 'cancelled'; status='blocked' WITH blocked_by_issue_ids " +
  "(e.g. a sub-issue you delegated) and/or unblock_action (the concrete next step) — Paperclip rejects a " +
  "bare 'blocked'; status='in_review' WITH reviewer_user_id; or ask_user_questions when a human must " +
  "answer or act. Put your summary or explanation in update_issue_status's `comment`. Describing the " +
  "state in a comment or a plain-text reply is not a disposition. If a status change is rejected, read " +
  "the error — it says what's missing — and fix the call rather than giving up. " +
  "If the wake says this is a disposition recovery, follow its instructions for exactly what that means " +
  "on this run — they're more specific than any general rule here. " +
  "You have no shell, no bash, and no curl. To call an external API use http_request; reference bound " +
  "credentials as {{secret:NAME}} (list_secrets shows the names) and never ask for, print, or store a " +
  "secret's value. Put a JSON request body in http_request's `json` argument; keep calls short ({url, json} " +
  "is a complete POST once auth has worked for that host). " +
  "Where a skill says to call the Paperclip agent API (PATCH /api/agents/..., instructions-bundle), use " +
  "the tools instead: get_agent to inspect an agent, update_agent to change its title, role, manager " +
  "(reports_to), adapter, model, or heartbeat, and agent_instructions to read or edit its prompt " +
  "(AGENTS.md). Call list_agents first. " +
  "All storage is Paperclip documents that humans can see — there is no hidden, private, or file " +
  "storage, no filesystem, and no shell. A task's own deliverables (a report, plan, spec, write-up) go " +
  "on its issue via issue_document. Anything shared across tasks or agents — running logs, brief " +
  "backlogs, drafts, reference notes, and whatever your instructions or skills call 'org storage', " +
  "'shared memory', $AGENT_HOME, or a file path like briefs/... — goes in the company Library via the " +
  "library tool (call action='list' first; a path like 'briefs/2026-09-30-topic.md' becomes key " +
  "'briefs-2026-09-30-topic'; to read one document, {key} alone is enough). Use find_documents to search every document in the company. If a list " +
  "or search comes back empty, it really is empty — do not repeat it with a slightly different path. " +
  "add_comment is for short chat-style updates only. " +
  "Use update_issue to fix an issue's other fields yourself — title, description, priority, " +
  "assignee, or a stale blocker set (e.g. blockers pointing at an issue that's since been cancelled " +
  "or done) — instead of routing the change through the issue owner. update_issue_status stays the " +
  "tool for status changes specifically.";

function resolveApiKey(config: LlmConfig, authToken: string | undefined): string {
  const key =
    (config.apiKey && config.apiKey.length > 0 ? config.apiKey : undefined) ||
    authToken ||
    process.env.LLM_API_KEY ||
    process.env.OPENROUTER_API_KEY ||
    "";
  if (!key) {
    throw new Error(
      "LLM API key not found. Set adapterConfig.apiKey, LLM_API_KEY, or OPENROUTER_API_KEY.",
    );
  }
  return key;
}

function resolveBillingType(costSource: CostSource = "none"): "api" | "fixed" {
  return costSource === "hourly_rate" ? "fixed" : "api";
}

type CostSource = "provider" | "hourly_rate" | "none";

/**
 * Provider-reported cost wins. Self-hosted endpoints have no price, so they
 * can be billed per hour of model time instead.
 */
export function resolveRunCost(opts: {
  reportedCostUsd: number;
  sawReportedCost: boolean;
  modelMs: number;
  hourlyRateUsd?: number;
}): { costUsd: number | null; source: CostSource } {
  if (opts.sawReportedCost) return { costUsd: opts.reportedCostUsd, source: "provider" };
  const rate = Number(opts.hourlyRateUsd);
  if (Number.isFinite(rate) && rate > 0) {
    return { costUsd: (opts.modelMs / 3_600_000) * rate, source: "hourly_rate" };
  }
  return { costUsd: null, source: "none" };
}

function buildHeaders(apiKey: string, config: LlmConfig): Record<string, string> {
  return {
    Authorization: `Bearer ${apiKey}`,
    "Content-Type": "application/json",
    "HTTP-Referer": config.httpReferer || "https://paperclip.ing",
    "X-Title": config.xTitle || "Paperclip",
  };
}

/**
 * Best-effort extraction of the wake payload from ctx.context.
 * renderPaperclipWakePrompt() expects the wake payload itself (an object
 * with .issue/.reason/.comments/...), not the outer context wrapper —
 * different Paperclip server versions have placed it under different keys,
 * so we try the most-specific first and fall back to the whole context
 * object so the adapter is resilient to schema drift.
 */
function extractWakePayload(context: Record<string, unknown> | undefined): unknown {
  if (!context || typeof context !== "object") return null;
  const candidates = ["wake", "wakePayload", "paperclipWake"];
  for (const key of candidates) {
    const value = (context as Record<string, unknown>)[key];
    if (value && typeof value === "object") return value;
  }
  return context;
}

function extractCurrentIssueId(wake: unknown, context: Record<string, unknown>): string | null {
  if (wake && typeof wake === "object") {
    const issue = (wake as Record<string, unknown>).issue;
    if (issue && typeof issue === "object") {
      const id = (issue as Record<string, unknown>).id;
      if (typeof id === "string" && id.length > 0) return id;
    }
  }
  const candidates = [
    context.taskId,
    context.issueId,
    context.wakeTaskId,
    (context.paperclipWake as Record<string, unknown> | undefined)?.taskId,
    (context.paperclipWake as Record<string, unknown> | undefined)?.issueId,
  ];
  for (const c of candidates) {
    if (typeof c === "string" && c.trim().length > 0) return c.trim();
  }
  return null;
}

function extractCurrentIssueIdentifier(wake: unknown, context: Record<string, unknown>): string | null {
  for (const source of [wake, context.paperclipWake, context]) {
    if (!source || typeof source !== "object") continue;
    const issue = (source as Record<string, unknown>).issue;
    if (issue && typeof issue === "object") {
      const identifier = (issue as Record<string, unknown>).identifier;
      if (typeof identifier === "string" && identifier.length > 0) return identifier;
    }
  }
  return null;
}

/**
 * Paperclip's missing-disposition recovery (a "successful run handoff") puts
 * its instructions at the top level of the run context — `handoffRequired`
 * plus a ready-made `instruction` — not in paperclipWake, so the wake
 * renderer never shows them. Without this, the corrective run looks like an
 * ordinary wake: the model redoes the whole task (and can fail it again),
 * spends Paperclip's single corrective attempt, and the issue escalates to
 * the board with "Missing disposition recovery blocked".
 */
export function isDispositionRecoveryWake(context: Record<string, unknown>): boolean {
  return (
    context.handoffRequired === true ||
    context.wakeReason === "finish_successful_run_handoff" ||
    context.handoffReason === "successful_run_missing_state"
  );
}

/**
 * Every rule here is resolved against the others explicitly: the model will
 * otherwise spend its turn arbitrating between Paperclip's generic "don't
 * repeat the task" text, its own role instructions (e.g. a handoff task after
 * sign-off), and a human comment asking it to finish. Reads are framed as
 * evidence-gathering because every run starts from an empty context — a
 * "use what's already in hand" rule is never satisfied at turn 1.
 */
/**
 * The paperclip skill documents cases as HTTP endpoints this adapter can't
 * call, so map them to the tools. Only for features that are enabled.
 */
export function renderPaperclipFeatureNote(features: PaperclipFeatures | null): string {
  if (!features) return "";
  const lines: string[] = [];
  if (features.cases) {
    lines.push(
      "- Cases: anything your skills describe as the cases API (POST /api/companies/:companyId/cases, " +
        "PUT /api/cases/.../documents/...) is the `case` tool. Don't use http_request for Paperclip's own API.",
    );
  }
  if (features.statusCards) {
    lines.push("- Status cards: use the `status_card` tool to list, create, update, or refresh status-board cards.");
  }
  if (features.statusCardTask) {
    lines.push(
      "- THIS ISSUE IS A STATUS-CARD TASK: you are the card's summarizer. Ignore the PUT endpoints in the task " +
        "description and use publish_status_card instead: " +
        (features.statusCardTask.operation === "compile" ? "save_query, then preview, then " : "optionally preview, then ") +
        "save_summary, then update_issue_status status='done'.",
    );
  }
  return lines.length ? `# Paperclip features\n${lines.join("\n")}` : "";
}

export function renderDispositionHandoffNote(context: Record<string, unknown>): string {
  if (!isDispositionRecoveryWake(context)) return "";
  const instruction = typeof context.instruction === "string" ? context.instruction.trim() : "";
  return [
    "# DISPOSITION RECOVERY — record a disposition this run",
    "Your previous run on this issue ended without a valid disposition. This is a fresh run with an " +
      "empty context, so nothing from a prior run is visible yet — reading the small number of existing " +
      "documents or comments this task already points you to (a draft, a brief, a prior sign-off) is " +
      "evidence-gathering, not redoing the task, even though it takes tool calls here. What's actually " +
      "banned: regenerating a deliverable from scratch, repeating a multi-step pipeline, or calling an " +
      "external system with side effects. Once you can see what you need, make the call — deferring again " +
      "is not safer than deciding.",
    "",
    ...(instruction
      ? [
          "Paperclip's generic text below may say not to inspect the workspace or repeat the task. Read it as " +
            "only: don't regenerate a deliverable and don't cause external side effects. Reading the referenced " +
            "documents and recording your verdict are both allowed. If a human's latest comment asks you to " +
            "finish the task, finish it.",
          "",
          instruction,
          "",
        ]
      : []),
    "## Decide using this order — stop at the first step that applies, do not weigh it against the others",
    "1. The deliverable is already finished (a comment/document shows it), OR you can make the call " +
      "yourself after reading what this task already references — that's evidence-gathering, go read it " +
      "now if you haven't. Once you have it and finishing means one verdict write with no external side " +
      "effects → update_issue_status status='done' (or 'cancelled'), citing the evidence in `comment`.",
    "2. A human must answer or act before you can continue → ask_user_questions.",
    "3. Someone else must review the result → update_issue_status status='in_review' with reviewer_user_id.",
    "4. Otherwise — evidence is genuinely missing even after reading what's referenced, or finishing would " +
      "need external side effects or regenerating a deliverable → update_issue_status status='blocked' " +
      "with unblock_action naming yourself as owner and a concrete next step. This is always valid and is " +
      "the safe default when you truly can't finish right now.",
    "Follow-up tasks your own instructions require once the work is finished (e.g. a handoff task to the " +
      "next agent) are part of finishing — create them. Don't create sub-issues instead of deciding, and " +
      "don't call external APIs with side effects.",
  ].join("\n");
}

const SHELL_LIKE_TOOL_NAMES = new Set([
  "bash", "sh", "shell", "zsh", "exec", "run", "run_command", "execute_command", "terminal",
  "curl", "wget", "python", "python3", "node",
]);

/**
 * Error body for a call to a tool that doesn't exist. Lists what does exist
 * so the model can correct itself — a bare "Unknown tool: bash" gave it
 * nothing to go on, and it retried the identical call until the
 * repeat-loop breaker killed the run.
 */
function unknownToolError(toolName: string, tools: Tool[]): Record<string, unknown> {
  const available = tools.map((t) => t.schema.function.name);
  const hasHttp = available.includes("http_request");
  const hint = SHELL_LIKE_TOOL_NAMES.has(toolName.toLowerCase())
    ? hasHttp
      ? "There is no shell here. To call an external API use http_request, referencing bound credentials as {{secret:NAME}}."
      : "There is no shell here, and no outbound HTTP tool is enabled for this agent."
    : "Call one of the available tools instead — do not retry this one.";
  return { error: `Unknown tool: ${toolName}`, hint, availableTools: available };
}

/**
 * An issue patch for `blocked` that Paperclip will accept from an agent: it
 * requires a blocker, a pending interaction/approval, or an unblockDescriptor,
 * and only lets an agent name itself as the unblock owner.
 */
function blockedPatch(agentId: string, reason: string): Record<string, unknown> {
  return {
    status: "blocked",
    comment: `Run stopped: ${reason}`,
    unblockDescriptor: {
      owner: { agentId },
      action: `Investigate and retry. The previous run stopped because: ${reason}`.slice(0, 2000),
    },
  };
}

/**
 * Empty arguments are a valid call ({}); unparseable ones are not. A
 * response cut off at max_tokens mid-call leaves truncated JSON, and this
 * used to return {} for it — so a half-written library write ran as
 * library({}) and came back "action must be one of…", which told the model
 * nothing about what actually went wrong.
 */
function parseToolArgs(raw: unknown): { ok: true; args: Record<string, unknown> } | { ok: false } {
  if (raw == null || (typeof raw === "string" && raw.trim() === "")) return { ok: true, args: {} };
  if (typeof raw !== "string") return { ok: false };
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? { ok: true, args: parsed } : { ok: false };
  } catch {
    return { ok: false };
  }
}

function configuredMaxTokens(config: LlmConfig): number | undefined {
  const n = Number(config.maxTokens);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : undefined;
}

async function callChatCompletions(
  apiKey: string,
  config: LlmConfig,
  endpoints: ResolvedEndpoints,
  messages: ChatMessage[],
  tools: Tool[],
  maxTokensOverride?: number,
  responseFormat?: { type: "json_object" },
): Promise<ChatCompletionResponse> {
  const body: Record<string, unknown> = {
    model: config.model || "openrouter/auto",
    messages,
    temperature: config.temperature ?? 0.7,
    top_p: config.topP ?? 1,
    stream: false,
  };
  // Not sent unless configured, so the provider uses the model's own output
  // maximum. A hardcoded 4096 default cut reasoning models off mid-thought
  // before they ever reached a tool call (reasoning counts against it).
  const maxTokens = maxTokensOverride ?? configuredMaxTokens(config);
  if (maxTokens) body.max_tokens = maxTokens;
  if (tools.length > 0) {
    body.tools = toolSchemas(tools);
    body.tool_choice = "auto";
  }
  if (responseFormat) body.response_format = responseFormat;
  if (config.reasoning) body.reasoning = { effort: config.reasoningEffort ?? "medium" };
  const transforms = Array.isArray(config.transforms)
    ? config.transforms
    : typeof config.transforms === "string"
      ? config.transforms.split(",").map((t) => t.trim()).filter(Boolean)
      : undefined;
  if (transforms?.length) body.transforms = transforms;
  if (config.route) body.route = config.route;
  if (isOpenRouter(config.baseUrl)) body.usage = { include: true };

  const response = await fetch(endpoints.chat, {
    method: "POST",
    headers: buildHeaders(apiKey, config),
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const errText = await response.text().catch(() => "");
    throw new LlmHttpError(response.status, errText, response.headers.get("retry-after"));
  }

  const json = (await response.json()) as ChatCompletionResponse;
  return json;
}

type AdapterExecutionErrorFamily = NonNullable<AdapterExecutionResult["errorFamily"]>;

class LlmHttpError extends Error {
  constructor(
    readonly status: number,
    readonly body: string,
    readonly retryAfter: string | null,
  ) {
    super(`LLM API error (${status}): ${body}`);
  }
}

interface LlmErrorClass {
  code: string;
  errorFamily?: AdapterExecutionErrorFamily;
  retryNotBefore?: string;
}

const QUOTA_BODY = /limit|quota|credit|insufficient|exceeded/i;

/**
 * Tells Paperclip which LLM failures are worth retrying. A run that reports
 * `provider_quota` / `transient_upstream` gets Paperclip's bounded retry; any
 * other error needs a human, so it still ends with the issue blocked.
 */
export function classifyLlmError(err: unknown, now = Date.now()): LlmErrorClass {
  if (err instanceof LlmHttpError) {
    const retryNotBefore = parseRetryAfter(err.retryAfter, now);
    const withRetry = retryNotBefore ? { retryNotBefore } : {};
    // OpenRouter reports an exhausted key limit as a 403, not a 429.
    if (err.status === 402 || err.status === 429 || (err.status === 403 && QUOTA_BODY.test(err.body))) {
      return { code: "llm_provider_quota", errorFamily: "provider_quota", ...withRetry };
    }
    if (err.status >= 500) {
      return { code: "llm_transient_upstream", errorFamily: "transient_upstream", ...withRetry };
    }
    return { code: "llm_request_failed" };
  }
  // fetch() rejects with a TypeError on network failure (DNS, reset, refused).
  if (err instanceof TypeError) {
    return { code: "llm_transient_upstream", errorFamily: "transient_upstream" };
  }
  return { code: "llm_request_failed" };
}

/** In-run retry timing for transient model-call failures. Tests shorten it. */
export const llmRetry = { delaysMs: [2_000, 8_000], maxRetryAfterMs: 30_000 };

/**
 * Retries a 5xx, 429 or network failure inside the run, so a brief outage
 * doesn't end the run and leave the issue behind Paperclip's recovery hold.
 * Quota errors (402/403) are not retried here: waiting won't fix them.
 */
async function withTransientRetry<T>(call: () => Promise<T>, onRetry: (msg: string) => Promise<void>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await call();
    } catch (err) {
      const retryable =
        err instanceof TypeError ||
        (err instanceof LlmHttpError && (err.status >= 500 || err.status === 429));
      if (!retryable || attempt >= llmRetry.delaysMs.length) throw err;
      const retryAt = err instanceof LlmHttpError ? parseRetryAfter(err.retryAfter, Date.now()) : undefined;
      const delay = retryAt
        ? Math.min(Math.max(Date.parse(retryAt) - Date.now(), 0), llmRetry.maxRetryAfterMs)
        : llmRetry.delaysMs[attempt];
      await onRetry(`Model call failed (${err instanceof Error ? err.message : String(err)}); retrying in ${Math.round(delay / 1000)}s.`);
      await new Promise((r) => setTimeout(r, delay));
    }
  }
}

function parseRetryAfter(value: string | null, now: number): string | undefined {
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return new Date(now + seconds * 1000).toISOString();
  const date = Date.parse(value);
  return Number.isNaN(date) ? undefined : new Date(date).toISOString();
}

// Paperclip's conversation-continuation policy (see legacyExecutionNeedsReconciliation).
const CONVERSATION_CONTINUATION_POLICY = "continue_conversation_v1";

/**
 * Without evidence, Paperclip holds any run that failed mid-work until a board
 * user reconciles its actions by API (there's no UI for it). A model-call
 * failure can only land between tool calls, so nothing is ever half-done:
 * before any tool ran it's a bootstrap failure; after, the next run continues
 * from the issue's current state. Either lets Paperclip's bounded retry run.
 */
function retryableFailureEvidence(
  runError: { errorFamily?: AdapterExecutionErrorFamily },
  toolCallsExecuted: number,
): Pick<AdapterExecutionResult, "executionRecovery" | "resultJson"> {
  if (!runError.errorFamily) return {};
  if (toolCallsExecuted === 0) {
    return { executionRecovery: { kind: "bootstrap", providerWorkStarted: false } };
  }
  return { resultJson: { conversationContinuation: CONVERSATION_CONTINUATION_POLICY } };
}

const REPEAT_WARNING =
  "You sent this exact call last time and got the same error. Change the arguments as the error says — " +
  "one more identical call stops the run.";

/** Merge `extra` into a JSON-object tool result; a non-JSON result gets the values appended as text. */
function annotateResult(resultContent: string, extra: Record<string, unknown>): string {
  try {
    const parsed = JSON.parse(resultContent);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return JSON.stringify({ ...parsed, ...extra });
    }
  } catch {
    // Not JSON: append as text.
  }
  const lines = Object.entries(extra).map(([k, v]) => `${k}: ${typeof v === "string" ? v : JSON.stringify(v)}`);
  return `${resultContent}\n\n${lines.join("\n")}`;
}

/** A 2nd identical failing call, to be restated as plain-text arguments. */
interface RestateCandidate {
  toolName: string;
  args: Record<string, unknown>;
  toolUseId: string;
  callSig: string;
  /** The failing response's reasoning and text: the model's own record of what it meant to send. */
  notes: string;
  /** The failing call's result. */
  error: string;
}

const ELIDE_OVER = 300;

/** Stands in for a long arrived value in the restate request; the value itself is kept. */
function elisionMarker(value: string): string {
  return `<${value.length} chars, kept>`;
}

/**
 * Weak models' tool calls lose fields their reasoning says they sent, so no
 * error text can fix the call. This asks for the arguments as JSON text in a
 * standalone request with no tools or history: with them, glm-5.3-flash still
 * reached for a tool call and replied with nothing (DEBA-112).
 */
function restateMessages(failing: RestateCandidate, tool: Tool): ChatMessage[] {
  const arrived = Object.fromEntries(
    Object.entries(failing.args).map(([k, v]) => [
      k,
      typeof v === "string" && v.length > ELIDE_OVER ? elisionMarker(v) : v,
    ]),
  );
  const notes = failing.notes.length > 4000 ? `…${failing.notes.slice(-4000)}` : failing.notes;
  const error = failing.error.length > 3000 ? `${failing.error.slice(0, 3000)}…` : failing.error;
  const { description, parameters } = tool.schema.function;
  const user = [
    `A call to the tool \`${failing.toolName}\` failed twice with the same arguments: fields were lost before ` +
      `they reached the tool. Only these arrived: ${JSON.stringify(arrived)}`,
    `The tool replied: ${error}`,
    `The tool: ${description}`,
    `Its parameters (JSON schema): ${JSON.stringify(parameters)}`,
    notes ? `What you were doing when you made the call (your own notes from that turn):\n${notes}` : "",
    "Reply with the arguments for the call you meant to make, as one JSON object. Fields that arrived are " +
      "kept, so you can send only the missing or wrong ones. If the tool's reply says the call can't work as " +
      "written, change the arguments the way it says.",
  ].filter(Boolean);
  return [
    {
      role: "system",
      content: "You repair a tool call. Reply with one JSON object, the call's complete arguments, and nothing else.",
    },
    { role: "user", content: user.join("\n\n") },
  ];
}

/** Restated arguments over the ones that arrived, keeping any long value shown as its marker. */
function mergeRestated(arrived: Record<string, unknown>, restated: Record<string, unknown>): Record<string, unknown> {
  const merged = { ...arrived };
  for (const [k, v] of Object.entries(restated)) {
    const prev = arrived[k];
    if (typeof prev === "string" && prev.length > ELIDE_OVER && v === elisionMarker(prev)) continue;
    merged[k] = v;
  }
  return merged;
}

function asArgsObject(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

/**
 * The arguments a model wrote as text when asked to restate a failing call:
 * a JSON object (fenced or in prose, or wrapped as {name, arguments}), or
 * GLM's raw <arg_key>/<arg_value> markup when the provider leaves it unparsed.
 */
export function parseRestatedArgs(text: string, toolName: string): Record<string, unknown> | null {
  // Markup first: its values can hold JSON objects of their own.
  const pairs = [...text.matchAll(/<arg_key>([\s\S]*?)<\/arg_key>\s*<arg_value>([\s\S]*?)<\/arg_value>/g)];
  if (pairs.length > 0) {
    return Object.fromEntries(
      pairs.map(([, key, value]) => {
        const trimmed = value!.trim();
        if (/^[[{]/.test(trimmed)) {
          try {
            return [key!.trim(), JSON.parse(trimmed)];
          } catch {
            // Keep it as text.
          }
        }
        return [key!.trim(), trimmed];
      }),
    );
  }
  const end = text.lastIndexOf("}");
  for (let start = text.indexOf("{"); start !== -1 && start < end; start = text.indexOf("{", start + 1)) {
    let parsed: Record<string, unknown> | null;
    try {
      parsed = asArgsObject(JSON.parse(text.slice(start, end + 1)));
    } catch {
      continue;
    }
    if (!parsed) continue;
    if (parsed.name === toolName && "arguments" in parsed) {
      const inner = parsed.arguments;
      if (typeof inner !== "string") return asArgsObject(inner);
      const unwrapped = parseToolArgs(inner);
      return unwrapped.ok ? unwrapped.args : null;
    }
    return parsed;
  }
  return null;
}

// ----- main -----

export async function execute(ctx: AdapterExecutionContext): Promise<AdapterExecutionResult> {
  const config = (ctx.config ?? {}) as unknown as LlmConfig & {
    maxTurns?: number;
    autoApprove?: boolean;
  };
  const { context, onLog, agent, authToken } = ctx;

  const endpoints = resolveEndpoints(config.baseUrl);
  const provider = isOpenRouter(config.baseUrl) ? "openrouter" : "llm";
  if (config.baseUrl && endpoints.base !== DEFAULT_BASE_URL) {
    await emitSystem(onLog, `Using LLM endpoint: ${endpoints.base}`);
  }

  const model = config.model || "openrouter/auto";
  const maxTurns = typeof config.maxTurns === "number" && config.maxTurns > 0 ? config.maxTurns : DEFAULT_MAX_TURNS;
  const autoApprove = config.autoApprove === true;

  // Tool handlers need a Paperclip API client. If we have no authToken,
  // tools are disabled (model can still respond, just can't act).
  let api: PaperclipApi | null = null;
  let tools: Tool[] = [];
  const wake = extractWakePayload(context);
  const currentIssueId = extractCurrentIssueId(wake, context);
  const companyId = agent.companyId;
  // Set by ask_user_questions when it successfully creates an interaction —
  // the issue is now waiting on a human reply, so the post-loop disposition
  // logic below must not mark it "done".
  const interactionCreated = { value: false };

  const currentIssueIdentifier = extractCurrentIssueIdentifier(wake, context);
  // Paperclip has two secret binding modes. Env-var bindings arrive already
  // resolved in adapterConfig.env — the same map built-in adapters inject
  // into their child process environment (PAPERCLIP_* keys are Paperclip's
  // own runtime namespace, not agent secrets). API-access bindings never
  // touch the env: they're listed and fetched on demand through the
  // run-bound agent API. This adapter has no child process, so both are
  // exposed only through http_request's {{secret:NAME}} substitution.
  const envSecrets = collectBoundSecrets((config as unknown as Record<string, unknown>).env, isPaperclipRuntimeEnvKey);
  let secretStore = new SecretStore(envSecrets);
  // Logged right after emitInit so the run viewer's header comes first.
  const startupNotes: string[] = [];
  const startupErrors: string[] = [];
  let features: PaperclipFeatures | null = null;

  if (authToken) {
    api = new PaperclipApi({ authToken });
    secretStore = new SecretStore(envSecrets, api);
    await secretStore.init((reason) =>
      writeRawStderr(onLog, `[llm] could not list API-access secrets (continuing without them): ${reason}`),
    );
    const libraryOverride = (config as unknown as Record<string, unknown>).libraryIssue;
    const library = new LibraryResolver(
      api,
      companyId,
      typeof libraryOverride === "string" && libraryOverride.trim() ? libraryOverride.trim() : null,
    );
    // One-time move of anything left in the retired memory_fs storage (plain
    // files nobody could see in the UI) into Library documents. Idempotent
    // via a marker file; never deletes the source files; never fails the run.
    try {
      const migration = await migrateMemoryToLibrary({
        api,
        library,
        config: config as unknown as Record<string, unknown>,
        companyId,
        agentId: agent.id,
        agentName: agent.name || agent.id,
      });
      if (migration.migrated.length > 0 && migration.library) {
        startupNotes.push(
          `Migrated ${migration.migrated.length} hidden memory file(s) into ${migration.library.identifier ?? "the Company Library"} documents: ` +
            migration.migrated.map((m) => `${m.scope}:${m.path} → ${m.key}`).join(", "),
        );
      }
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      startupErrors.push(`[llm] memory → Library migration failed (will retry next run): ${reason}`);
    }
    features = await detectPaperclipFeatures(api, companyId, currentIssueId);
    for (const error of features.errors) {
      startupErrors.push(`[llm] could not check Paperclip features (their tools are off this run): ${error}`);
    }
    const featureTools = [
      features.cases && "case",
      features.statusCards && "status_card",
      features.statusCardTask && "publish_status_card",
    ].filter(Boolean);
    if (featureTools.length > 0) startupNotes.push(`Paperclip feature tools enabled: ${featureTools.join(", ")}`);
    tools = buildTools({
      features,
      statusCardTask: features.statusCardTask,
      model,
      library,
      api,
      agentId: agent.id,
      companyId,
      currentIssueId,
      currentIssueIdentifier,
      autoApprove,
      interactionCreated,
      config: config as unknown as Record<string, unknown>,
      secretStore,
    });
  } else {
    await writeRawStderr(
      onLog,
      "[llm] No authToken on context — tool calls disabled. Agent can only generate text.",
    );
  }

  // Emit init early so the run viewer renders the header.
  await emitInit(onLog, { model, sessionId: ctx.runId });
  for (const note of startupNotes) await emitSystem(onLog, note);
  for (const error of startupErrors) await writeRawStderr(onLog, error);
  const secretNames = secretStore.names();
  if (secretNames.length > 0 && tools.length > 0) {
    await emitSystem(onLog, `Bound secrets available via http_request: ${secretNames.join(", ")}`);
  }

  // ----- build messages -----

  const messages: ChatMessage[] = [];

  // System prompt = base + skills + optional instructions file
  let systemContent = config.systemPrompt || DEFAULT_SYSTEM_PROMPT;

  // If instructionsFilePath is set, read the file and use it as the base.
  // This mirrors the behavior of claude-local / codex-local / etc., letting
  // operators version-control long agent instructions in a markdown file
  // instead of pasting them into the inline systemPrompt field.
  const instructionsFilePath = (config as unknown as Record<string, unknown>).instructionsFilePath;
  if (typeof instructionsFilePath === "string" && instructionsFilePath.trim().length > 0) {
    try {
      const fileContent = await fs.readFile(instructionsFilePath.trim(), "utf8");
      if (fileContent.trim().length > 0) {
        systemContent = fileContent.trim();
      }
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      await writeRawStderr(
        onLog,
        `[llm] could not read instructionsFilePath ${instructionsFilePath}: ${reason}. Falling back to systemPrompt.`,
      );
    }
  }
  // Materialize any desired company-managed skills (config.paperclipRuntimeSkills)
  // into the skills directory before loadSkills() scans it, so a toggle made
  // in the Skills panel takes effect on the very next run even if syncSkills
  // was never re-invoked since. The marker check mirrors the built-in hermes
  // adapter's same pattern — it avoids touching a real skills directory
  // during direct unit/library calls that never went through Paperclip's
  // real runtime (which is what actually sets paperclipRuntimeSkills).
  const rawConfig = config as unknown as Record<string, unknown>;
  if (Object.prototype.hasOwnProperty.call(rawConfig, "paperclipRuntimeSkills")) {
    try {
      const selected = await reconcilePaperclipSkills(rawConfig);
      if (selected.length > 0) {
        await emitSystem(onLog, `Reconciled ${selected.length} Paperclip-managed skill(s) into the skills directory.`);
      }
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      await writeRawStderr(onLog, `[llm] could not reconcile Paperclip-managed skills (continuing): ${reason}`);
    }
  }
  try {
    const skills = await loadSkills({ agentConfig: config as unknown as Record<string, unknown>, onLog });
    if (skills.length > 0) {
      systemContent = `${systemContent}\n\n${renderSkillsForPrompt(skills)}`;
      await emitSystem(onLog, `Loaded ${skills.length} skill(s): ${skills.map((s) => s.name).join(", ")}`);
    }
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    await writeRawStderr(onLog, `[llm] skill loading error (continuing): ${reason}`);
  }
  // After the skills, which describe these features as raw HTTP endpoints.
  const featureNote = tools.length > 0 ? renderPaperclipFeatureNote(features) : "";
  if (featureNote) systemContent = `${systemContent}\n\n${featureNote}`;
  messages.push({ role: "system", content: systemContent });

  // User prompt = Paperclip wake payload rendered as text. Some heartbeats
  // arrive without a structured wake payload (manual "Run Heartbeat" with no
  // scoped issue, or a wake context the current server schema doesn't fill
  // in) — renderPaperclipWakePrompt returns an empty string in those cases,
  // so fall back to a concise three-line instruction so the model always has
  // something to act on.
  const resumedSession = !!ctx.runtime.sessionId;
  // The server's task brief (issue description, acceptance criteria, ...),
  // when it sends one. The wake prompt then omits its own copy of the
  // description so the prompt carries it once — same as claude-local.
  const taskContextNote = selectPaperclipTaskMarkdown(context, { resumedSession });
  let wakePrompt = "";
  try {
    wakePrompt =
      renderPaperclipWakePrompt(wake, {
        resumedSession,
        // Every run of this adapter starts from a fresh message list, so the
        // disposition contract (what counts as a valid way to end the run)
        // is always relevant — not only on resumed sessions, which is all
        // the renderer includes it for by default.
        includeExecutionContract: true,
        suppressIssueDescription: taskContextNote.length > 0,
      }) || "";
  } catch (err) {
    // Do not swallow this silently: renderPaperclipWakePrompt is what renders
    // an answered ask_user_questions interaction's resolution ("Interaction
    // {id} is answered. The answer below is authoritative; do not re-ask the
    // resolved questions.") — if this throws on that wake shape, the model
    // never sees the human's answer at all and re-derives a similar question
    // from scratch instead of using it. Falling back silently made a real
    // incident (the same question asked repeatedly across separate runs)
    // undiagnosable from the run log alone.
    const reason = err instanceof Error ? err.message : String(err);
    await writeRawStderr(onLog, `[llm] renderPaperclipWakePrompt threw, falling back to a generic prompt: ${reason}`);
    wakePrompt = "";
  }
  const handoffNote = renderDispositionHandoffNote(context);
  wakePrompt = joinPromptSections([handoffNote, wakePrompt, taskContextNote]);
  if (wakePrompt.trim().length === 0) {
    const issueLine = currentIssueId ? ` (issue ${currentIssueId})` : "";
    wakePrompt = [
      `You have just received a heartbeat from Paperclip${issueLine}.`,
      "No structured wake context was provided — proceed using the tools available to you.",
      "Before asking a new ask_user_questions question, call get_issue and list_comments first: " +
        "a human may have already answered a question you asked in an earlier run. Use their answer " +
        "instead of re-asking the same or a similarly-worded question.",
      "Take the next useful action toward your current responsibilities, then end the run.",
    ].join("\n");
  }
  messages.push({ role: "user", content: wakePrompt });

  // ----- check out issue (acquire run lock) -----
  //
  // Paperclip's sameRunLock check rejects any write to an issue (comments,
  // status changes, etc.) unless the issue's checkoutRunId matches the
  // calling run id. Adapters that go through Paperclip's wake handler get
  // this for free (it pre-checks-out the issue for them); pure-HTTP
  // adapters don't, so we have to do it ourselves before any tool can
  // mutate state.
  //
  // If checkout fails (issue locked by another live run, project paused,
  // etc.), we log and proceed without tools — same graceful degradation
  // we apply when authToken is missing.

  // If Paperclip's heartbeat dispatcher already stamped this run as the
  // issue's executionRunId, the lock is effectively held by us already and
  // an explicit checkout call would be redundant (and on some Paperclip
  // versions, return a validation error). Detect that and skip.
  const preLocked = (() => {
    const wakeIssue = (wake as Record<string, unknown> | null)?.issue as
      | Record<string, unknown>
      | undefined;
    const ctxIssue = (context.issue as Record<string, unknown> | undefined) ?? wakeIssue;
    const execRunId =
      typeof ctxIssue?.executionRunId === "string" ? ctxIssue.executionRunId : null;
    return !!execRunId && execRunId === ctx.runId;
  })();

  let issueLocked = preLocked;
  if (api && currentIssueId && !preLocked) {
    try {
      await api.checkoutIssue(currentIssueId, agent.id);
      issueLocked = true;
    } catch (err) {
      // Best-effort: many runs are dispatched by the heartbeat which already
      // holds the lock for us, so a checkout failure is not necessarily
      // fatal. We try the writes anyway and let Paperclip enforce the real
      // ownership check at write time.
      const reason = err instanceof Error ? err.message : String(err);
      await writeRawStderr(
        onLog,
        `[llm] checkout call failed for ${currentIssueId}: ${reason}. Continuing — Paperclip may still accept writes if the heartbeat pre-locked the issue.`,
      );
      issueLocked = true;
    }
  }

  // ----- mark issue in_progress -----

  if (api && currentIssueId && issueLocked) {
    try {
      await api.updateIssue(currentIssueId, { status: "in_progress" });
    } catch (err) {
      // Don't fail the run for status updates.
      const reason = err instanceof Error ? err.message : String(err);
      await writeRawStderr(onLog, `[llm] could not set issue in_progress: ${reason}`);
    }
  }

  // ----- tool loop -----

  let apiKey: string;
  try {
    apiKey = resolveApiKey(config, authToken);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    await writeRawStderr(onLog, `[llm] ${reason}\n`);
    if (api && currentIssueId) {
      await api
        .updateIssue(currentIssueId, blockedPatch(agent.id, reason))
        .catch(() => undefined);
    }
    return {
      exitCode: 1,
      signal: null,
      timedOut: false,
      errorMessage: reason,
      errorCode: "missing_api_key",
      usage: { inputTokens: 0, outputTokens: 0 },
      usageBasis: "per_run",
      model,
      provider,
      biller: provider,
      billingType: resolveBillingType(),
    };
  }

  let lastGenerationId: string | undefined;
  let totalUsage: UsageSummary = { inputTokens: 0, outputTokens: 0 };
  let reportedCostUsd = 0;
  let sawReportedCost = false;
  let modelMs = 0;
  const addUsage = (response: ChatCompletionResponse): void => {
    lastGenerationId = response.id || lastGenerationId;
    const usage = response.usage;
    if (!usage) return;
    const cached = (totalUsage.cachedInputTokens ?? 0) + (usage.prompt_tokens_details?.cached_tokens ?? 0);
    totalUsage = {
      inputTokens: totalUsage.inputTokens + (usage.prompt_tokens ?? 0),
      outputTokens: totalUsage.outputTokens + (usage.completion_tokens ?? 0),
      ...(cached > 0 ? { cachedInputTokens: cached } : {}),
    };
    if (typeof usage.cost === "number") {
      sawReportedCost = true;
      reportedCostUsd += usage.cost;
      if (usage.is_byok) reportedCostUsd += usage.cost_details?.upstream_inference_cost ?? 0;
    }
  };
  const timedChatCall = async (
    maxTokensOverride?: number,
    request: { messages?: ChatMessage[]; tools?: Tool[]; responseFormat?: { type: "json_object" } } = {},
  ): Promise<ChatCompletionResponse> => {
    const started = performance.now();
    try {
      return await withTransientRetry(
        () =>
          callChatCompletions(
            apiKey,
            config,
            endpoints,
            request.messages ?? messages,
            request.tools ?? tools,
            maxTokensOverride,
            request.responseFormat,
          ),
        (msg) => emitSystem(onLog, msg),
      );
    } finally {
      modelMs += performance.now() - started;
    }
  };
  let finalAssistantText = "";
  let toolCallsExecuted = 0;
  let turn = 0;
  let stoppedReason: "completed" | "max_turns" | "error" | "repeat_loop" = "completed";
  let runError: {
    message: string;
    code: string;
    errorFamily?: AdapterExecutionErrorFamily;
    retryNotBefore?: string;
  } | null = null;
  // Set when update_issue_status records a disposition on the CURRENT issue
  // — see the disposition-nudge block below, which exists because of a real,
  // observed failure mode: models confidently write "Done — closed as
  // done, verified in the API response" without ever having called the
  // tool. Left unfixed, that just re-triggers Paperclip's own
  // missing_disposition recovery on the next heartbeat, which costs a
  // whole extra run and, per production evidence, doesn't reliably fix
  // the underlying habit either — it can recur run after run on the same
  // issue. One in-run corrective nudge is cheaper and more effective than
  // waiting on the cross-run recovery loop. This is only the fallback: the
  // nudge decision asks Paperclip for the issue's real status first (see
  // currentIssueNeedsDisposition), because "some update_issue_status call
  // succeeded" also covered calls on a sub-issue.
  //
  // A disposition-recovery wake gets a second nudge: it's Paperclip's one
  // corrective attempt before a board escalation, so it's worth one more turn.
  let dispositionRecorded = false;
  let dispositionNudgesGiven = 0;
  const maxDispositionNudges = isDispositionRecoveryWake(context) ? 2 : 1;
  // Set when the model already put its own words on the current issue, so
  // the post-loop final-text comment would only be a duplicate.
  let commentedOnCurrentIssue = false;
  const currentIssueNeedsDisposition = async (): Promise<boolean> => {
    if (!api || !currentIssueId || interactionCreated.value) return false;
    try {
      const issue = await api.getIssue(currentIssueId);
      if (typeof issue.status === "string") return issue.status === "in_progress";
    } catch {
      // Fall back to what this run's own tool calls recorded.
    }
    return !dispositionRecorded;
  };
  // Repeat-call detection: if the model calls the same tool with the same args
  // three times in a row, break the loop. Prevents 20+ retries when the model
  // misreads an error message and keeps "fixing" it the same wrong way.
  const recentCalls: string[] = [];
  const REPEAT_THRESHOLD = 3;
  const rememberCall = (callSig: string): void => {
    recentCalls.push(callSig);
    if (recentCalls.length > REPEAT_THRESHOLD) recentCalls.shift();
  };
  // OpenRouter routes one model to several providers, and they differ in
  // which tool-call fields they deliver; the log says which one answered.
  let servedBy: string | undefined;
  const noteProvider = async (response: ChatCompletionResponse): Promise<void> => {
    if (!response.provider || response.provider === servedBy) return;
    servedBy = response.provider;
    await emitSystem(onLog, `Model served by ${servedBy}`);
  };
  // Failing calls already restated once; a second restate of the same call
  // wouldn't learn anything new, so the repeat guard takes it from there.
  const restatedSigs = new Set<string>();

  /** Runs a call whose arguments parsed and records any disposition it makes. */
  const runParsedCall = async (
    toolName: string,
    args: Record<string, unknown>,
  ): Promise<{ content: string; isError: boolean }> => {
    const tool = findTool(tools, toolName);
    let content: string;
    let isError: boolean;
    if (!tool) {
      content = JSON.stringify(unknownToolError(toolName, tools));
      isError = true;
    } else {
      toolCallsExecuted += 1;
      try {
        ({ content, isError } = await tool.execute(args));
      } catch (err) {
        content = JSON.stringify({ error: err instanceof Error ? err.message : String(err) });
        isError = true;
      }
    }
    if (isError) {
      // Weak models drop fields they believe they sent (DEBA-66/69/77) and
      // then resend the "same" call; show them which fields actually arrived.
      return { content: annotateResult(content, { received_fields: Object.keys(args) }), isError };
    }
    if (targetsCurrentIssue({ currentIssueId, currentIssueIdentifier }, args.issue_id)) {
      // update_issue_status refuses non-disposition statuses on the
      // current issue, so any success here is a real disposition.
      // update_issue accepts a status too (models mix the two up).
      if (
        toolName === "update_issue_status" ||
        (toolName === "update_issue" && typeof args.status === "string" && args.status)
      ) {
        dispositionRecorded = true;
        if (typeof args.comment === "string" && args.comment.trim()) commentedOnCurrentIssue = true;
      }
      if (toolName === "add_comment") commentedOnCurrentIssue = true;
    }
    return { content, isError };
  };

  /**
   * After a 2nd identical failing call, asks the model for the arguments as
   * plain text and runs the tool with them. Any failure here leaves the run
   * as it was: the model has the repeat warning, and the guard still applies.
   */
  const restateFailingCall = async (failing: RestateCandidate): Promise<void> => {
    restatedSigs.add(failing.callSig);
    const { toolName } = failing;
    const tool = findTool(tools, toolName);
    if (!tool) return;
    const request = { messages: restateMessages(failing, tool), tools: [] };
    let response: ChatCompletionResponse;
    try {
      try {
        response = await timedChatCall(undefined, { ...request, responseFormat: { type: "json_object" } });
      } catch (err) {
        // Some endpoints reject response_format; the prompt asks for JSON anyway.
        if (!(err instanceof LlmHttpError && err.status === 400)) throw err;
        response = await timedChatCall(undefined, request);
      }
      addUsage(response);
      await noteProvider(response);
    } catch (err) {
      await emitSystem(
        onLog,
        `Asking the model to restate its ${toolName} arguments failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      return;
    }
    const choice = response.choices?.[0];
    const reply = choice?.message;
    const reasoning = typeof reply?.reasoning === "string" ? reply.reasoning : "";
    if (reasoning) await emitThinking(onLog, reasoning);
    // The request has no tools, but some providers answer with a tool call anyway.
    const asToolCall = reply?.tool_calls?.find((tc) => tc.function.name === toolName);
    const replyText = asToolCall ? asToolCall.function.arguments : typeof reply?.content === "string" ? reply.content : "";
    const parsedToolCall = asToolCall ? parseToolArgs(asToolCall.function.arguments) : null;
    const restated = parsedToolCall ? (parsedToolCall.ok ? parsedToolCall.args : null) : parseRestatedArgs(replyText, toolName);
    const shown = replyText.length > 1000 ? `${replyText.slice(0, 1000)}…` : replyText;
    const merged = restated ? mergeRestated(failing.args, restated) : null;
    const mergedSig = merged ? `${toolName}::${JSON.stringify(merged)}` : null;
    if (!merged || mergedSig === failing.callSig) {
      const toolCallNames = (reply?.tool_calls ?? []).map((tc) => tc.function.name);
      await emitSystem(
        onLog,
        `${toolName} failed twice with identical arguments; asked the model to restate them as text, but its ` +
          `reply ${merged ? "changed nothing" : "had no JSON arguments"} (finish_reason=${choice?.finish_reason ?? "none"}, ` +
          `content ${typeof reply?.content === "string" ? reply.content.length : 0} chars, reasoning ${reasoning.length} chars` +
          `${toolCallNames.length > 0 ? `, tool calls: ${toolCallNames.join(", ")}` : ""}): ${shown || "(empty)"}`,
      );
      return;
    }
    await emitSystem(onLog, `${toolName} failed twice with identical arguments; the model restated them as text: ${shown}`);
    const toolUseId = `${failing.toolUseId}-restated`;
    messages.push({
      role: "assistant",
      content: "",
      tool_calls: [{ id: toolUseId, type: "function", function: { name: toolName, arguments: JSON.stringify(merged) } }],
    });
    await emitToolCall(onLog, { name: toolName, input: merged, toolUseId });
    const { content, isError } = await runParsedCall(toolName, merged);
    await emitToolResult(onLog, { toolUseId, toolName, content, isError });
    messages.push({ role: "tool", tool_call_id: toolUseId, content });
    rememberCall(mergedSig!);
  };

  try {
    while (turn < maxTurns) {
      turn += 1;

      let response: ChatCompletionResponse;
      try {
        response = await timedChatCall();
        addUsage(response);
        // An operator-set cap that cuts the turn off gets one retry at double
        // before we fall back to continuing from the partial output.
        const capped = configuredMaxTokens(config);
        if (capped && response.choices?.[0]?.finish_reason === "length") {
          await emitSystem(onLog, `Response cut off at max_tokens (${capped}); retrying this turn with ${capped * 2}.`);
          response = await timedChatCall(capped * 2);
          addUsage(response);
        }
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        runError = { message: reason, ...classifyLlmError(err) };
        stoppedReason = "error";
        break;
      }

      await noteProvider(response);
      const choice = response.choices?.[0];
      if (!choice) {
        runError = { message: "LLM API returned no choices", code: "llm_empty_response" };
        stoppedReason = "error";
        break;
      }

      const msg = choice.message;
      const reasoning = typeof msg.reasoning === "string" ? msg.reasoning : "";
      const text = typeof msg.content === "string" ? msg.content : "";
      const toolCalls = msg.tool_calls ?? [];
      const truncated = choice.finish_reason === "length";

      if (reasoning) {
        await emitThinking(onLog, reasoning);
      }
      if (text) {
        await emitAssistant(onLog, text);
        finalAssistantText = text;
      }
      if (truncated) {
        await emitSystem(onLog, "Response cut off at the output token limit — continuing from where it stopped.");
      }

      if (toolCalls.length === 0) {
        // Keep the model's own output in the conversation. Without this, the
        // next turn starts from scratch and re-derives the same analysis —
        // and, if that's what got cut off, gets cut off again in the same place.
        const ownOutput = text || (reasoning ? `(My working notes so far:)\n${reasoning}` : "");
        if (ownOutput) messages.push({ role: "assistant", content: ownOutput });

        // A truncated turn didn't choose to stop, so it isn't a missed
        // disposition and doesn't spend a nudge.
        if (truncated && turn < maxTurns) {
          messages.push({
            role: "user",
            content:
              "Your last response was cut off at the output limit before you called a tool. Your analysis " +
              "is above — don't redo it. Make the tool call it leads to now. To add to an existing document, " +
              "use action='append' with only the new text rather than resending the whole document.",
          });
          continue;
        }

        // No tool calls => model believes it's done. Before accepting that,
        // give it a chance (two on a disposition-recovery wake) to actually
        // record a disposition if it hasn't.
        if (dispositionNudgesGiven < maxDispositionNudges && turn < maxTurns && (await currentIssueNeedsDisposition())) {
          dispositionNudgesGiven += 1;
          const nudgeContent =
            dispositionNudgesGiven === 1
              ? "Your issue is still in_progress: you did not record a disposition for it (a status change on " +
                "a different issue doesn't count). Every run must end with one — Paperclip cannot infer it " +
                "from text, no matter how clearly it states the work is finished. Call exactly one now: " +
                "update_issue_status status='done' (or 'cancelled') if the work is complete; status='blocked' " +
                "with blocked_by_issue_ids and/or unblock_action if you can't continue; status='in_review' " +
                "with reviewer_user_id if someone must review it; or ask_user_questions if a human must " +
                "answer. Do not just restate that you're finished — call the tool."
              : "Still no disposition recorded. Stop re-analyzing — you already have what you need. Record " +
                "the decision you've reached now: write any record your instructions require, then " +
                "update_issue_status status='done' with your verdict in `comment`. Only if you truly can't " +
                "decide: status='blocked' with unblock_action.";
          messages.push({ role: "user", content: nudgeContent });
          continue;
        }
        stoppedReason = "completed";
        break;
      }

      const parsedCalls = toolCalls.map((tc) => ({ tc, parsed: parseToolArgs(tc.function.arguments) }));

      // Add the assistant message (with tool_calls) so the model sees its own
      // request. Unparseable arguments are replaced with {} so the next request
      // doesn't carry invalid JSON; the tool result explains what happened.
      messages.push({
        role: "assistant",
        content: text,
        tool_calls: parsedCalls.map(({ tc, parsed }) => ({
          id: tc.id,
          type: "function",
          function: { name: tc.function.name, arguments: parsed.ok ? tc.function.arguments || "{}" : "{}" },
        })),
      });

      // Identical calls batched into one response are one attempt: the model
      // can't see the first one's result (or the repeat warning) before
      // sending the others, so they must not count toward the repeat guard.
      const ranThisResponse = new Map<string, boolean>();
      let restateCandidate: RestateCandidate | undefined;

      // Execute each tool call and append the results.
      for (const { tc, parsed } of parsedCalls) {
        const toolName = tc.function.name;
        const args = parsed.ok ? parsed.args : {};
        const rawLength = typeof tc.function.arguments === "string" ? tc.function.arguments.length : 0;
        await emitToolCall(onLog, {
          name: toolName,
          input: parsed.ok ? args : { unparseableArguments: `${rawLength} chars of invalid JSON` },
          toolUseId: tc.id,
        });

        const callSig = `${toolName}::${JSON.stringify(args)}`;
        const earlierIsError = ranThisResponse.get(callSig);
        if (earlierIsError !== undefined) {
          const duplicateContent = JSON.stringify({
            [earlierIsError ? "error" : "note"]:
              "Not run: identical to an earlier call in this same response. See that call's result" +
              (earlierIsError ? " and change the arguments before trying again." : "."),
          });
          await emitToolResult(onLog, { toolUseId: tc.id, toolName, content: duplicateContent, isError: earlierIsError });
          messages.push({ role: "tool", tool_call_id: tc.id, content: duplicateContent });
          continue;
        }

        let resultContent: string;
        let isError: boolean;
        if (!parsed.ok) {
          resultContent = JSON.stringify({
            error:
              `Your arguments for ${toolName} weren't valid JSON${truncated ? " — your response was cut off at the output limit mid-call" : ""}. ` +
              "Nothing was run. Resend the call. To add to an existing document, use action='append' with just " +
              "the new text instead of resending the whole document.",
          });
          isError = true;
        } else {
          ({ content: resultContent, isError } = await runParsedCall(toolName, args));
        }

        ranThisResponse.set(callSig, isError);
        if (isError && recentCalls[recentCalls.length - 1] === callSig) {
          // The model gets no other signal that the guard below is about to end
          // the run; weak models resend a failing call verbatim.
          resultContent = annotateResult(resultContent, { warning: REPEAT_WARNING });
          if (!restateCandidate && !restatedSigs.has(callSig) && findTool(tools, toolName)) {
            restateCandidate = {
              toolName,
              args,
              toolUseId: tc.id,
              callSig,
              notes: [reasoning, text].filter(Boolean).join("\n\n"),
              error: resultContent,
            };
          }
        }

        await emitToolResult(onLog, {
          toolUseId: tc.id,
          toolName,
          content: resultContent,
          isError,
        });

        messages.push({
          role: "tool",
          tool_call_id: tc.id,
          content: resultContent,
        });

        rememberCall(callSig);
        if (
          recentCalls.length === REPEAT_THRESHOLD &&
          recentCalls.every((s) => s === callSig)
        ) {
          await writeRawStderr(
            onLog,
            `[llm] Tool "${toolName}" called ${REPEAT_THRESHOLD}x with identical args — breaking loop.`,
          );
          runError = {
            message: `Tool "${toolName}" was called ${REPEAT_THRESHOLD} times in a row with identical arguments. The model is stuck in a retry loop.`,
            code: "tool_repeat_loop",
          };
          stoppedReason = "repeat_loop";
          break;
        }

        // Once an interaction is pending, stop — the model cannot get a real
        // answer within this run, and letting it keep calling the tool (seen
        // in practice: the same question asked 2-3x with slightly different
        // wording each time) just creates duplicate pending interactions.
        if (toolName === "ask_user_questions" && interactionCreated.value) {
          await writeRawStderr(
            onLog,
            "[llm] ask_user_questions created an interaction — ending the turn now instead of continuing.",
          );
          stoppedReason = "completed";
          break;
        }
      }
      // Only once every call in the response has its result, so the
      // restate request's history is valid.
      if (restateCandidate && stoppedReason !== "repeat_loop" && !interactionCreated.value) {
        await restateFailingCall(restateCandidate);
      }
      if (stoppedReason === "repeat_loop") break;
      if (stoppedReason === "completed" && interactionCreated.value) break;
    }

    if (turn >= maxTurns && stoppedReason !== "error") {
      stoppedReason = "max_turns";
      await writeRawStderr(onLog, `[llm] hit max_turns (${maxTurns}), stopping`);
    }
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    runError = { message: reason, code: "llm_loop_failed" };
    stoppedReason = "error";
  }

  // ----- post-loop: cost, comment, status -----

  const { costUsd, source: costSource } = resolveRunCost({
    reportedCostUsd,
    sawReportedCost,
    modelMs,
    hourlyRateUsd: config.hourlyRateUsd,
  });

  // Post the final assistant text as a comment so other agents can see it.
  // Skip it when the model already commented on the issue itself: the text
  // would be a duplicate, and an extra comment also makes an otherwise idle
  // run look "productive" to Paperclip's missing-disposition check.
  if (api && currentIssueId && finalAssistantText.trim().length > 0 && !commentedOnCurrentIssue) {
    try {
      await api.addIssueComment(currentIssueId, { body: finalAssistantText });
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      await writeRawStderr(onLog, `[llm] could not post final comment: ${reason}`);
    }
  }

  // Update issue status based on outcome.
  const secondaryErrors: string[] = [];
  if (api && currentIssueId) {
    let nextStatus: "blocked" | null = null;
    let statusReason: string | null = null;
    if (stoppedReason === "completed") {
      // Do NOT guess "done" here. "The model stopped calling tools" only
      // means the turn ended — it says nothing about whether the work is
      // actually finished. A real incident: the model's final text
      // explicitly said it was waiting on another agent's response, and
      // this code marked the issue "done" anyway because that text wasn't
      // a tool call. The model already has update_issue_status and is
      // already told (DEFAULT_SYSTEM_PROMPT, and Paperclip's own
      // DEFAULT_PAPERCLIP_AGENT_PROMPT_TEMPLATE) to call it with an
      // explicit disposition before ending the heartbeat — if it didn't,
      // that's a real gap, and the correct owner of that gap is
      // Paperclip's own missing_disposition recovery (which re-wakes this
      // same agent asking it to pick a real disposition), not a guess made
      // here. This also covers the ask_user_questions case (a pending
      // interaction already exempts the issue from that recovery via
      // hasPendingInteractionOrApproval), so no separate branch is needed
      // for it anymore.
      nextStatus = null;
    } else if (stoppedReason === "max_turns") {
      nextStatus = "blocked";
      statusReason = `Hit max_turns (${maxTurns}) without completing`;
    } else if (stoppedReason === "repeat_loop" && runError) {
      nextStatus = "blocked";
      statusReason = runError.message;
    } else if (stoppedReason === "error" && runError?.errorFamily) {
      // Retryable provider failure: leave the issue in_progress so Paperclip's
      // bounded retry can re-run it. Blocking it here stranded the issue.
      await api
        .addIssueComment(currentIssueId, {
          body: `Run paused: ${runError.message}\n\nPaperclip will retry this run automatically.`,
        })
        .catch(() => undefined);
    } else if (stoppedReason === "error" && runError) {
      nextStatus = "blocked";
      statusReason = runError.message;
    }
    if (nextStatus && statusReason) {
      // Paperclip rejects entering `blocked` without blockers, a pending
      // interaction/approval, or an unblockDescriptor — so a bare
      // {status: "blocked"} (what this used to send) always failed with a
      // 422. The reason goes in `comment`, written in the same transaction;
      // `statusReason` isn't part of Paperclip's issue-update schema and
      // was silently dropped.
      const patch = blockedPatch(agent.id, statusReason);
      try {
        await api.updateIssue(currentIssueId, patch);
      } catch (firstErr) {
        // One retry: the most common cause is a transient sameRunLock 409
        // (see checkoutIssue's doc comment) racing the heartbeat dispatcher's
        // own lock, which often clears within a second.
        await new Promise((r) => setTimeout(r, 750));
        try {
          await api.updateIssue(currentIssueId, patch);
        } catch (err) {
          const reason = err instanceof Error ? err.message : String(err);
          await writeRawStderr(onLog, `[llm] could not update final status: ${reason}`);
          // The comment rode on the failed update — post it on its own so
          // the issue still says why the run stopped.
          await api
            .addIssueComment(currentIssueId, { body: `Run stopped: ${statusReason}` })
            .catch(() => undefined);
          // A run that fails to record its own disposition must not report
          // success. Paperclip's "successful run, issue still in_progress"
          // recovery flow (missing_disposition) only fires when the run
          // itself reports success — swallowing this failure here would
          // produce exactly that failure mode instead of Paperclip's normal,
          // honest run-failure handling. The original failure (e.g. the
          // repeat loop) stays the primary error: replacing it with the
          // status-write failure hid why the run actually stopped.
          const statusFailure = `Failed to record final issue status (${nextStatus}): ${reason}`;
          stoppedReason = "error";
          if (runError) {
            secondaryErrors.push(statusFailure);
          } else {
            runError = { message: statusFailure, code: "issue_status_update_failed" };
          }
        }
      }
    }
  }

  // Emit the final result transcript entry.
  await emitResult(onLog, {
    text: finalAssistantText,
    inputTokens: totalUsage.inputTokens,
    outputTokens: totalUsage.outputTokens,
    cachedTokens: totalUsage.cachedInputTokens,
    costUsd: costUsd ?? 0,
    subtype: stoppedReason,
    isError: stoppedReason === "error",
    errors: runError ? [runError.message, ...secondaryErrors] : secondaryErrors,
  });

  if (stoppedReason === "error" && runError) {
    return {
      exitCode: 1,
      signal: null,
      timedOut: false,
      errorMessage: [runError.message, ...secondaryErrors].join(" — also: "),
      errorCode: runError.code,
      ...(runError.errorFamily ? { errorFamily: runError.errorFamily } : {}),
      ...(runError.retryNotBefore ? { retryNotBefore: runError.retryNotBefore } : {}),
      ...retryableFailureEvidence(runError, toolCallsExecuted),
      usage: totalUsage,
      usageBasis: "per_run",
      model,
      provider,
      biller: provider,
      billingType: resolveBillingType(costSource),
      costUsd,
      sessionId: lastGenerationId ?? null,
      sessionDisplayId: lastGenerationId ?? null,
      sessionParams: lastGenerationId ? { lastGenerationId } : null,
    };
  }

  return {
    exitCode: 0,
    signal: null,
    timedOut: false,
    usage: totalUsage,
    usageBasis: "per_run",
    model,
    provider,
    biller: provider,
    billingType: resolveBillingType(costSource),
    costUsd,
    sessionId: lastGenerationId ?? null,
    sessionDisplayId: lastGenerationId ?? null,
    sessionParams: lastGenerationId ? { lastGenerationId } : null,
    summary: finalAssistantText.slice(0, 500),
  };
}

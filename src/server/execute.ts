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
import { buildTools, toolSchemas, findTool, targetsCurrentIssue, type Tool } from "./tools.js";
import { collectBoundSecrets, SecretStore } from "./http-request.js";
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
  "If the wake says this is a disposition recovery, only record the disposition — do not redo the task. " +
  "You have no shell, no bash, and no curl. To call an external API use http_request; reference bound " +
  "credentials as {{secret:NAME}} (list_secrets shows the names) and never ask for, print, or store a " +
  "secret's value. " +
  "For file-based memory skills (e.g. para-memory-files): use the memory_fs tool, not real filesystem " +
  "paths or shell commands — you have neither. Its scope='private' is what such skills call $AGENT_HOME " +
  "(only you can see it); scope='shared' is one directory every agent in this company can read and write " +
  "(use it for anything a skill says to keep outside personal memory, like plans/). There is no `qmd` " +
  "command — use memory_fs with action='search' instead, in either scope. " +
  "When you produce a document a human should actually read and review (a report, plan, spec, or " +
  "write-up), use the issue_document tool, not add_comment or memory_fs — it's a real document with " +
  "revision history, visible in the Documents panel in the Paperclip web UI. add_comment is for short " +
  "chat-style updates; memory_fs is private/shared notes nobody in the UI ever sees. " +
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

function resolveBillingType(): "api" | "subscription" {
  // Every supported provider today is API-key based.
  return "api";
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
export function renderDispositionHandoffNote(context: Record<string, unknown>): string {
  const isHandoff =
    context.handoffRequired === true ||
    context.wakeReason === "finish_successful_run_handoff" ||
    context.handoffReason === "successful_run_missing_state";
  if (!isHandoff) return "";
  const instruction = typeof context.instruction === "string" ? context.instruction.trim() : "";
  return [
    "# DISPOSITION RECOVERY — record a disposition, do NOT redo the work",
    "Your previous run on this issue ended without a valid disposition. This run exists only to record one.",
    "",
    ...(instruction ? [instruction, ""] : []),
    "## How to record each option with your tools",
    "- Finished → update_issue_status status='done' (or 'cancelled'), with a short `comment`.",
    "- Someone else must review → update_issue_status status='in_review' with reviewer_user_id, or ask_user_questions.",
    "- Can't continue → update_issue_status status='blocked' with blocked_by_issue_ids and/or unblock_action.",
    "- A human must answer or act → ask_user_questions.",
    "- More work remains → create_sub_issue for it, then update_issue_status status='blocked' with blocked_by_issue_ids set to that sub-issue.",
    "Do not call external APIs or repeat the task in this run.",
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

function safeParseToolArgs(raw: string): Record<string, unknown> {
  if (!raw || typeof raw !== "string") return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

async function callChatCompletions(
  apiKey: string,
  config: LlmConfig,
  endpoints: ResolvedEndpoints,
  messages: ChatMessage[],
  tools: Tool[],
): Promise<ChatCompletionResponse> {
  const body: Record<string, unknown> = {
    model: config.model || "openrouter/auto",
    messages,
    max_tokens: config.maxTokens ?? 4096,
    temperature: config.temperature ?? 0.7,
    top_p: config.topP ?? 1,
    stream: false,
  };
  if (tools.length > 0) {
    body.tools = toolSchemas(tools);
    body.tool_choice = "auto";
  }
  if (config.reasoning) body.reasoning = { effort: "high" };
  const transforms = Array.isArray(config.transforms)
    ? config.transforms
    : typeof config.transforms === "string"
      ? config.transforms.split(",").map((t) => t.trim()).filter(Boolean)
      : undefined;
  if (transforms?.length) body.transforms = transforms;
  if (config.route) body.route = config.route;

  const response = await fetch(endpoints.chat, {
    method: "POST",
    headers: buildHeaders(apiKey, config),
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const errText = await response.text().catch(() => "");
    throw new Error(`LLM API error (${response.status}): ${errText}`);
  }

  const json = (await response.json()) as ChatCompletionResponse;
  return json;
}

async function fetchGenerationCost(
  generationId: string,
  apiKey: string,
  endpoints: ResolvedEndpoints,
): Promise<{ costUsd: number | null; inputTokens: number; outputTokens: number }> {
  const fallback = { costUsd: null as number | null, inputTokens: 0, outputTokens: 0 };
  try {
    // OpenRouter's /generation endpoint takes a moment to populate.
    await new Promise((r) => setTimeout(r, 1500));
    const res = await fetch(`${endpoints.generation}?id=${encodeURIComponent(generationId)}`, {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    if (!res.ok) return fallback;
    const data = (await res.json()) as { data?: Record<string, unknown> };
    const d = data.data ?? {};
    return {
      costUsd: typeof d.total_cost === "number" ? d.total_cost : null,
      inputTokens: typeof d.tokens_prompt === "number" ? d.tokens_prompt : 0,
      outputTokens: typeof d.tokens_completion === "number" ? d.tokens_completion : 0,
    };
  } catch {
    return fallback;
  }
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

  if (authToken) {
    api = new PaperclipApi({ authToken });
    secretStore = new SecretStore(envSecrets, api);
    await secretStore.init((reason) =>
      writeRawStderr(onLog, `[llm] could not list API-access secrets (continuing without them): ${reason}`),
    );
    tools = buildTools({
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
      model,
      provider,
      biller: provider,
      billingType: resolveBillingType(),
    };
  }

  let lastGenerationId: string | undefined;
  let totalUsage: UsageSummary = { inputTokens: 0, outputTokens: 0 };
  let finalAssistantText = "";
  let turn = 0;
  let stoppedReason: "completed" | "max_turns" | "error" | "repeat_loop" = "completed";
  let runError: { message: string; code: string } | null = null;
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
  let dispositionRecorded = false;
  let dispositionNudgeGiven = false;
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

  try {
    while (turn < maxTurns) {
      turn += 1;

      let response: ChatCompletionResponse;
      try {
        response = await callChatCompletions(apiKey, config, endpoints, messages, tools);
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        runError = { message: reason, code: "llm_request_failed" };
        stoppedReason = "error";
        break;
      }

      lastGenerationId = response.id || lastGenerationId;
      if (response.usage) {
        totalUsage = {
          inputTokens: totalUsage.inputTokens + (response.usage.prompt_tokens ?? 0),
          outputTokens: totalUsage.outputTokens + (response.usage.completion_tokens ?? 0),
        };
      }

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

      if (reasoning) {
        await emitThinking(onLog, reasoning);
      }
      if (text) {
        await emitAssistant(onLog, text);
        finalAssistantText = text;
      }

      // No tool calls => model believes it's done. Before accepting that,
      // give it exactly one chance to actually record a disposition if it
      // hasn't — see the dispositionNudgeGiven comment above.
      if (toolCalls.length === 0) {
        if (!dispositionNudgeGiven && turn < maxTurns && (await currentIssueNeedsDisposition())) {
          dispositionNudgeGiven = true;
          messages.push({
            role: "user",
            content:
              "Your issue is still in_progress: you did not record a disposition for it (a status change on " +
              "a different issue doesn't count). Every run must end with one — Paperclip cannot infer it " +
              "from text, no matter how clearly it states the work is finished. Call exactly one now: " +
              "update_issue_status status='done' (or 'cancelled') if the work is complete; status='blocked' " +
              "with blocked_by_issue_ids and/or unblock_action if you can't continue; status='in_review' " +
              "with reviewer_user_id if someone must review it; or ask_user_questions if a human must " +
              "answer. Do not just restate that you're finished — call the tool.",
          });
          continue;
        }
        stoppedReason = "completed";
        break;
      }

      // Add the assistant message (with tool_calls) so the model sees its own request.
      messages.push({
        role: "assistant",
        content: text,
        tool_calls: toolCalls.map((tc) => ({
          id: tc.id,
          type: "function",
          function: { name: tc.function.name, arguments: tc.function.arguments },
        })),
      });

      // Execute each tool call and append the results.
      for (const tc of toolCalls) {
        const toolName = tc.function.name;
        const args = safeParseToolArgs(tc.function.arguments);
        await emitToolCall(onLog, { name: toolName, input: args, toolUseId: tc.id });

        const tool = findTool(tools, toolName);
        let resultContent: string;
        let isError: boolean;
        if (!tool) {
          resultContent = JSON.stringify(unknownToolError(toolName, tools));
          isError = true;
        } else {
          try {
            const out = await tool.execute(args);
            resultContent = out.content;
            isError = out.isError;
          } catch (err) {
            resultContent = JSON.stringify({
              error: err instanceof Error ? err.message : String(err),
            });
            isError = true;
          }
        }

        await emitToolResult(onLog, {
          toolUseId: tc.id,
          toolName,
          content: resultContent,
          isError,
        });

        if (!isError && targetsCurrentIssue({ currentIssueId, currentIssueIdentifier }, args.issue_id)) {
          // update_issue_status refuses non-disposition statuses on the
          // current issue, so any success here is a real disposition.
          if (toolName === "update_issue_status") {
            dispositionRecorded = true;
            if (typeof args.comment === "string" && args.comment.trim()) commentedOnCurrentIssue = true;
          }
          if (toolName === "add_comment") commentedOnCurrentIssue = true;
        }

        messages.push({
          role: "tool",
          tool_call_id: tc.id,
          content: resultContent,
        });

        // Track repeat calls
        const callSig = `${toolName}::${JSON.stringify(args)}`;
        recentCalls.push(callSig);
        if (recentCalls.length > REPEAT_THRESHOLD) recentCalls.shift();
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

  let costUsd: number | null = null;
  if (lastGenerationId && isOpenRouter(config.baseUrl)) {
    const cost = await fetchGenerationCost(lastGenerationId, apiKey, endpoints);
    costUsd = cost.costUsd;
    // Prefer the generation endpoint's token counts when present (more accurate).
    if (cost.inputTokens > 0 || cost.outputTokens > 0) {
      totalUsage = { inputTokens: cost.inputTokens, outputTokens: cost.outputTokens };
    }
  }

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
      usage: totalUsage,
      model,
      provider,
      biller: provider,
      billingType: resolveBillingType(),
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
    model,
    provider,
    biller: provider,
    billingType: resolveBillingType(),
    costUsd,
    sessionId: lastGenerationId ?? null,
    sessionDisplayId: lastGenerationId ?? null,
    sessionParams: lastGenerationId ? { lastGenerationId } : null,
    summary: finalAssistantText.slice(0, 500),
  };
}

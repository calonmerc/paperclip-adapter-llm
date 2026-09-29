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
import fs from "node:fs/promises";
import { renderPaperclipWakePrompt } from "@paperclipai/adapter-utils/server-utils";
import { DEFAULT_BASE_URL, resolveEndpoints, isOpenRouter, } from "../index.js";
import { PaperclipApi } from "./paperclip-api.js";
import { buildTools, toolSchemas, findTool } from "./tools.js";
import { loadSkills, renderSkillsForPrompt, reconcilePaperclipSkills } from "./skills.js";
import { emitInit, emitAssistant, emitThinking, emitToolCall, emitToolResult, emitResult, emitSystem, writeRawStderr, } from "./transcript.js";
// ----- helpers -----
const DEFAULT_MAX_TURNS = 25;
const DEFAULT_SYSTEM_PROMPT = "You are an AI agent working inside Paperclip, an autonomous company orchestration system. " +
    "When you receive a wake payload, your job is to EXECUTE the assigned task — not describe it. " +
    "Use the tools available to you to read context, post comments, update status, and delegate work. " +
    "If you need information only a human can provide before continuing, call the ask_user_questions tool " +
    "instead of guessing, stalling, or writing out a question as plain text — it pauses the issue and wakes " +
    "you again once someone answers. If this wake includes an 'Interaction ... is answered' section, that " +
    "answer is authoritative and current — use it and do not re-ask the same or a similarly-worded question. " +
    "If you're unsure whether a prior question of yours was already answered, call get_issue and " +
    "list_comments before asking another one. " +
    "Every run must end with an explicit disposition via update_issue_status — there is no default. " +
    "If the work is complete, call update_issue_status with status='done' and post a summary comment. " +
    "If you're waiting on another agent, a delegated sub-issue, or anything else before you can continue, " +
    "call update_issue_status with status='blocked' (or leave it in_progress if you will resume it yourself) " +
    "and explain what you're waiting on — do not just describe that in a comment or plain text reply and " +
    "stop, since nothing then marks the issue as unfinished. " +
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
function resolveApiKey(config, authToken) {
    const key = (config.apiKey && config.apiKey.length > 0 ? config.apiKey : undefined) ||
        authToken ||
        process.env.LLM_API_KEY ||
        process.env.OPENROUTER_API_KEY ||
        "";
    if (!key) {
        throw new Error("LLM API key not found. Set adapterConfig.apiKey, LLM_API_KEY, or OPENROUTER_API_KEY.");
    }
    return key;
}
function resolveBillingType() {
    // Every supported provider today is API-key based.
    return "api";
}
function buildHeaders(apiKey, config) {
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
function extractWakePayload(context) {
    if (!context || typeof context !== "object")
        return null;
    const candidates = ["wake", "wakePayload", "paperclipWake"];
    for (const key of candidates) {
        const value = context[key];
        if (value && typeof value === "object")
            return value;
    }
    return context;
}
function extractCurrentIssueId(wake, context) {
    if (wake && typeof wake === "object") {
        const issue = wake.issue;
        if (issue && typeof issue === "object") {
            const id = issue.id;
            if (typeof id === "string" && id.length > 0)
                return id;
        }
    }
    const candidates = [
        context.taskId,
        context.issueId,
        context.wakeTaskId,
        context.paperclipWake?.taskId,
        context.paperclipWake?.issueId,
    ];
    for (const c of candidates) {
        if (typeof c === "string" && c.trim().length > 0)
            return c.trim();
    }
    return null;
}
function safeParseToolArgs(raw) {
    if (!raw || typeof raw !== "string")
        return {};
    try {
        const parsed = JSON.parse(raw);
        return parsed && typeof parsed === "object" ? parsed : {};
    }
    catch {
        return {};
    }
}
async function callChatCompletions(apiKey, config, endpoints, messages, tools) {
    const body = {
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
    if (config.reasoning)
        body.reasoning = { effort: "high" };
    const transforms = Array.isArray(config.transforms)
        ? config.transforms
        : typeof config.transforms === "string"
            ? config.transforms.split(",").map((t) => t.trim()).filter(Boolean)
            : undefined;
    if (transforms?.length)
        body.transforms = transforms;
    if (config.route)
        body.route = config.route;
    const response = await fetch(endpoints.chat, {
        method: "POST",
        headers: buildHeaders(apiKey, config),
        body: JSON.stringify(body),
    });
    if (!response.ok) {
        const errText = await response.text().catch(() => "");
        throw new Error(`LLM API error (${response.status}): ${errText}`);
    }
    const json = (await response.json());
    return json;
}
async function fetchGenerationCost(generationId, apiKey, endpoints) {
    const fallback = { costUsd: null, inputTokens: 0, outputTokens: 0 };
    try {
        // OpenRouter's /generation endpoint takes a moment to populate.
        await new Promise((r) => setTimeout(r, 1500));
        const res = await fetch(`${endpoints.generation}?id=${encodeURIComponent(generationId)}`, {
            headers: { Authorization: `Bearer ${apiKey}` },
        });
        if (!res.ok)
            return fallback;
        const data = (await res.json());
        const d = data.data ?? {};
        return {
            costUsd: typeof d.total_cost === "number" ? d.total_cost : null,
            inputTokens: typeof d.tokens_prompt === "number" ? d.tokens_prompt : 0,
            outputTokens: typeof d.tokens_completion === "number" ? d.tokens_completion : 0,
        };
    }
    catch {
        return fallback;
    }
}
// ----- main -----
export async function execute(ctx) {
    const config = (ctx.config ?? {});
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
    let api = null;
    let tools = [];
    const wake = extractWakePayload(context);
    const currentIssueId = extractCurrentIssueId(wake, context);
    const companyId = agent.companyId;
    // Set by ask_user_questions when it successfully creates an interaction —
    // the issue is now waiting on a human reply, so the post-loop disposition
    // logic below must not mark it "done".
    const interactionCreated = { value: false };
    if (authToken) {
        api = new PaperclipApi({ authToken });
        tools = buildTools({
            api,
            agentId: agent.id,
            companyId,
            currentIssueId,
            autoApprove,
            interactionCreated,
            config: config,
        });
    }
    else {
        await writeRawStderr(onLog, "[llm] No authToken on context — tool calls disabled. Agent can only generate text.");
    }
    // Emit init early so the run viewer renders the header.
    await emitInit(onLog, { model, sessionId: ctx.runId });
    // ----- build messages -----
    const messages = [];
    // System prompt = base + skills + optional instructions file
    let systemContent = config.systemPrompt || DEFAULT_SYSTEM_PROMPT;
    // If instructionsFilePath is set, read the file and use it as the base.
    // This mirrors the behavior of claude-local / codex-local / etc., letting
    // operators version-control long agent instructions in a markdown file
    // instead of pasting them into the inline systemPrompt field.
    const instructionsFilePath = config.instructionsFilePath;
    if (typeof instructionsFilePath === "string" && instructionsFilePath.trim().length > 0) {
        try {
            const fileContent = await fs.readFile(instructionsFilePath.trim(), "utf8");
            if (fileContent.trim().length > 0) {
                systemContent = fileContent.trim();
            }
        }
        catch (err) {
            const reason = err instanceof Error ? err.message : String(err);
            await writeRawStderr(onLog, `[llm] could not read instructionsFilePath ${instructionsFilePath}: ${reason}. Falling back to systemPrompt.`);
        }
    }
    // Materialize any desired company-managed skills (config.paperclipRuntimeSkills)
    // into the skills directory before loadSkills() scans it, so a toggle made
    // in the Skills panel takes effect on the very next run even if syncSkills
    // was never re-invoked since. The marker check mirrors the built-in hermes
    // adapter's same pattern — it avoids touching a real skills directory
    // during direct unit/library calls that never went through Paperclip's
    // real runtime (which is what actually sets paperclipRuntimeSkills).
    const rawConfig = config;
    if (Object.prototype.hasOwnProperty.call(rawConfig, "paperclipRuntimeSkills")) {
        try {
            const selected = await reconcilePaperclipSkills(rawConfig);
            if (selected.length > 0) {
                await emitSystem(onLog, `Reconciled ${selected.length} Paperclip-managed skill(s) into the skills directory.`);
            }
        }
        catch (err) {
            const reason = err instanceof Error ? err.message : String(err);
            await writeRawStderr(onLog, `[llm] could not reconcile Paperclip-managed skills (continuing): ${reason}`);
        }
    }
    try {
        const skills = await loadSkills({ agentConfig: config, onLog });
        if (skills.length > 0) {
            systemContent = `${systemContent}\n\n${renderSkillsForPrompt(skills)}`;
            await emitSystem(onLog, `Loaded ${skills.length} skill(s): ${skills.map((s) => s.name).join(", ")}`);
        }
    }
    catch (err) {
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
    let wakePrompt = "";
    try {
        wakePrompt = renderPaperclipWakePrompt(wake, { resumedSession }) || "";
    }
    catch (err) {
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
        const wakeIssue = wake?.issue;
        const ctxIssue = context.issue ?? wakeIssue;
        const execRunId = typeof ctxIssue?.executionRunId === "string" ? ctxIssue.executionRunId : null;
        return !!execRunId && execRunId === ctx.runId;
    })();
    let issueLocked = preLocked;
    if (api && currentIssueId && !preLocked) {
        try {
            await api.checkoutIssue(currentIssueId, agent.id);
            issueLocked = true;
        }
        catch (err) {
            // Best-effort: many runs are dispatched by the heartbeat which already
            // holds the lock for us, so a checkout failure is not necessarily
            // fatal. We try the writes anyway and let Paperclip enforce the real
            // ownership check at write time.
            const reason = err instanceof Error ? err.message : String(err);
            await writeRawStderr(onLog, `[llm] checkout call failed for ${currentIssueId}: ${reason}. Continuing — Paperclip may still accept writes if the heartbeat pre-locked the issue.`);
            issueLocked = true;
        }
    }
    // ----- mark issue in_progress -----
    if (api && currentIssueId && issueLocked) {
        try {
            await api.updateIssue(currentIssueId, { status: "in_progress" });
        }
        catch (err) {
            // Don't fail the run for status updates.
            const reason = err instanceof Error ? err.message : String(err);
            await writeRawStderr(onLog, `[llm] could not set issue in_progress: ${reason}`);
        }
    }
    // ----- tool loop -----
    let apiKey;
    try {
        apiKey = resolveApiKey(config, authToken);
    }
    catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        await writeRawStderr(onLog, `[llm] ${reason}\n`);
        if (api && currentIssueId) {
            await api
                .updateIssue(currentIssueId, { status: "blocked", statusReason: reason })
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
    let lastGenerationId;
    let totalUsage = { inputTokens: 0, outputTokens: 0 };
    let finalAssistantText = "";
    let turn = 0;
    let stoppedReason = "completed";
    let runError = null;
    // Repeat-call detection: if the model calls the same tool with the same args
    // three times in a row, break the loop. Prevents 20+ retries when the model
    // misreads an error message and keeps "fixing" it the same wrong way.
    const recentCalls = [];
    const REPEAT_THRESHOLD = 3;
    try {
        while (turn < maxTurns) {
            turn += 1;
            let response;
            try {
                response = await callChatCompletions(apiKey, config, endpoints, messages, tools);
            }
            catch (err) {
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
            // No tool calls => model is done.
            if (toolCalls.length === 0) {
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
                let resultContent;
                let isError;
                if (!tool) {
                    resultContent = JSON.stringify({ error: `Unknown tool: ${toolName}` });
                    isError = true;
                }
                else {
                    try {
                        const out = await tool.execute(args);
                        resultContent = out.content;
                        isError = out.isError;
                    }
                    catch (err) {
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
                messages.push({
                    role: "tool",
                    tool_call_id: tc.id,
                    content: resultContent,
                });
                // Track repeat calls
                const callSig = `${toolName}::${JSON.stringify(args)}`;
                recentCalls.push(callSig);
                if (recentCalls.length > REPEAT_THRESHOLD)
                    recentCalls.shift();
                if (recentCalls.length === REPEAT_THRESHOLD &&
                    recentCalls.every((s) => s === callSig)) {
                    await writeRawStderr(onLog, `[llm] Tool "${toolName}" called ${REPEAT_THRESHOLD}x with identical args — breaking loop.`);
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
                    await writeRawStderr(onLog, "[llm] ask_user_questions created an interaction — ending the turn now instead of continuing.");
                    stoppedReason = "completed";
                    break;
                }
            }
            if (stoppedReason === "repeat_loop")
                break;
            if (stoppedReason === "completed" && interactionCreated.value)
                break;
        }
        if (turn >= maxTurns && stoppedReason !== "error") {
            stoppedReason = "max_turns";
            await writeRawStderr(onLog, `[llm] hit max_turns (${maxTurns}), stopping`);
        }
    }
    catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        runError = { message: reason, code: "llm_loop_failed" };
        stoppedReason = "error";
    }
    // ----- post-loop: cost, comment, status -----
    let costUsd = null;
    if (lastGenerationId && isOpenRouter(config.baseUrl)) {
        const cost = await fetchGenerationCost(lastGenerationId, apiKey, endpoints);
        costUsd = cost.costUsd;
        // Prefer the generation endpoint's token counts when present (more accurate).
        if (cost.inputTokens > 0 || cost.outputTokens > 0) {
            totalUsage = { inputTokens: cost.inputTokens, outputTokens: cost.outputTokens };
        }
    }
    // Post the final assistant text as a comment so other agents can see it.
    if (api && currentIssueId && finalAssistantText.trim().length > 0) {
        try {
            await api.addIssueComment(currentIssueId, { body: finalAssistantText });
        }
        catch (err) {
            const reason = err instanceof Error ? err.message : String(err);
            await writeRawStderr(onLog, `[llm] could not post final comment: ${reason}`);
        }
    }
    // Update issue status based on outcome.
    if (api && currentIssueId) {
        let nextStatus = null;
        let statusReason = null;
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
        }
        else if (stoppedReason === "max_turns") {
            nextStatus = "blocked";
            statusReason = `Hit max_turns (${maxTurns}) without completing`;
        }
        else if (stoppedReason === "repeat_loop" && runError) {
            nextStatus = "blocked";
            statusReason = runError.message;
        }
        else if (stoppedReason === "error" && runError) {
            nextStatus = "blocked";
            statusReason = runError.message;
        }
        if (nextStatus) {
            try {
                await api.updateIssue(currentIssueId, { status: nextStatus, statusReason });
            }
            catch (firstErr) {
                // One retry: the most common cause is a transient sameRunLock 409
                // (see checkoutIssue's doc comment) racing the heartbeat dispatcher's
                // own lock, which often clears within a second.
                await new Promise((r) => setTimeout(r, 750));
                try {
                    await api.updateIssue(currentIssueId, { status: nextStatus, statusReason });
                }
                catch (err) {
                    const reason = err instanceof Error ? err.message : String(err);
                    await writeRawStderr(onLog, `[llm] could not update final status: ${reason}`);
                    // A run that fails to record its own disposition must not report
                    // success. Paperclip's "successful run, issue still in_progress"
                    // recovery flow (missing_disposition) only fires when the run
                    // itself reports success — swallowing this failure here would
                    // produce exactly that failure mode instead of Paperclip's normal,
                    // honest run-failure handling.
                    if (stoppedReason !== "error") {
                        stoppedReason = "error";
                        runError = {
                            message: `Failed to record final issue status (${nextStatus}): ${reason}`,
                            code: "issue_status_update_failed",
                        };
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
        errors: runError ? [runError.message] : [],
    });
    if (stoppedReason === "error" && runError) {
        return {
            exitCode: 1,
            signal: null,
            timedOut: false,
            errorMessage: runError.message,
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
//# sourceMappingURL=execute.js.map
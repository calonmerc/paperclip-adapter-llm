/**
 * Tool definitions and handlers for the OpenRouter adapter.
 *
 * Architecture:
 *   - Each tool = { schema (sent to the model), execute (called by the loop) }
 *   - buildTools(ctx) closes over agent/company/issue identity so the model
 *     cannot spoof IDs by passing them as arguments
 *   - Errors during execute() are caught and returned as { isError: true }
 *     tool results so the model can recover; only programmer errors throw
 *
 * The schema format matches OpenAI function-calling, which OpenRouter
 * normalizes for any provider that supports tools.
 */
import { PaperclipApiError } from "./paperclip-api.js";
import { LIBRARY_ISSUE_TITLE, LibraryResolver, slugifyDocumentKey } from "./library.js";
import { MAX_RESPONSE_CHARS, REQUEST_TIMEOUT_MS, SecretReferenceError, SecretStore, fetchGoogleAccessToken, hostAllowed, parseAllowedHosts, redactSecrets, referencedSecretNames, resolveSecrets, substituteSecrets, substituteSecretsDeep, } from "./http-request.js";
// ----- helpers -----
function ok(content) {
    return {
        content: typeof content === "string" ? content : JSON.stringify(content),
        isError: false,
    };
}
function fail(message, detail) {
    const body = { error: message };
    if (detail !== undefined)
        body.detail = detail;
    return { content: JSON.stringify(body), isError: true };
}
async function safeCall(label, fn) {
    try {
        const result = await fn();
        return ok(result);
    }
    catch (err) {
        if (err instanceof PaperclipApiError) {
            return fail(`${label} failed: ${err.message}`, { status: err.status, body: err.body });
        }
        const reason = err instanceof Error ? err.message : String(err);
        return fail(`${label} failed: ${reason}`);
    }
}
function asString(v, fallback = "") {
    return typeof v === "string" && v.length > 0 ? v : fallback;
}
// ----- tool builders -----
function getIssueTool(ctx) {
    return {
        schema: {
            type: "function",
            function: {
                name: "get_issue",
                description: "Fetch the full details of an issue (title, description, status, comments, attachments). " +
                    "Defaults to the current issue if no id is supplied.",
                parameters: {
                    type: "object",
                    properties: {
                        issue_id: {
                            type: "string",
                            description: "Issue id. Omit to use the current issue.",
                        },
                    },
                },
            },
        },
        execute: async (args) => {
            const id = asString(args.issue_id, ctx.currentIssueId ?? "");
            if (!id)
                return fail("No issue_id supplied and no current issue.");
            return safeCall("get_issue", () => ctx.api.getIssue(id));
        },
    };
}
/** True when `issueId` (absent, the current issue's id, or its identifier) targets the current issue. */
export function targetsCurrentIssue(ctx, issueId) {
    if (typeof issueId !== "string" || issueId.length === 0)
        return true;
    return issueId === ctx.currentIssueId || (!!ctx.currentIssueIdentifier && issueId === ctx.currentIssueIdentifier);
}
// Statuses that leave the current issue without a disposition Paperclip will
// accept at the end of a run: a successful run that leaves its issue
// in_progress triggers Paperclip's missing-disposition recovery, and
// backlog/todo on your own issue just hands it back to the queue unexplained.
const NON_DISPOSITION_STATUSES = new Set(["backlog", "todo", "in_progress"]);
// Appended to 422 errors so the model can fix the call instead of retrying it.
function statusRejectionHint(status) {
    if (status === "blocked") {
        return ("To block, pass blocked_by_issue_ids (unresolved issues this waits on) and/or unblock_action " +
            "(the concrete next step). If a human must act or answer, call ask_user_questions instead.");
    }
    if (status === "in_review") {
        return "To send for review, pass reviewer_user_id (a human reviewer), or call ask_user_questions instead.";
    }
    return null;
}
function updateIssueStatusTool(ctx) {
    return {
        schema: {
            type: "function",
            function: {
                name: "update_issue_status",
                description: "Record an issue's disposition. For the issue you're working on, end every run with one of: " +
                    "'done' (finished), 'cancelled' (intentionally stopped), 'blocked' (needs blocked_by_issue_ids " +
                    "and/or unblock_action — Paperclip rejects a bare 'blocked'), or 'in_review' (needs " +
                    "reviewer_user_id). If a human must answer something, use ask_user_questions instead. " +
                    "backlog/todo/in_progress are only allowed for OTHER issues (e.g. sub-issues). Put your " +
                    "explanation in `comment` — it's posted together with the status change. Defaults to the current issue.",
                parameters: {
                    type: "object",
                    properties: {
                        issue_id: { type: "string", description: "Issue id. Omit to use the current issue." },
                        status: {
                            type: "string",
                            enum: ["done", "cancelled", "blocked", "in_review", "backlog", "todo", "in_progress"],
                        },
                        comment: {
                            type: "string",
                            description: "Explanation posted as an issue comment together with the status change.",
                        },
                        blocked_by_issue_ids: {
                            type: "array",
                            items: { type: "string" },
                            description: "status='blocked' only: ids of unresolved issues this one waits on.",
                        },
                        unblock_action: {
                            type: "string",
                            description: "status='blocked' only: the concrete action that unblocks this issue, e.g. 'Retry once the " +
                                "GSC service account has been granted access'. You are recorded as the unblock owner.",
                        },
                        reviewer_user_id: {
                            type: "string",
                            description: "status='in_review' only: the human user who should review it.",
                        },
                    },
                    required: ["status"],
                },
            },
        },
        execute: async (args) => {
            const id = asString(args.issue_id, ctx.currentIssueId ?? "");
            if (!id)
                return fail("No issue_id supplied and no current issue.");
            const status = asString(args.status);
            if (!status)
                return fail("status is required.");
            const built = buildStatusPatch(ctx, args, status);
            if ("error" in built)
                return built.error;
            return sendStatusPatch(ctx, "update_issue_status", id, status, built.patch);
        },
    };
}
/**
 * Validates a status change and builds its issue patch (status, comment,
 * blocker path, reviewer). Shared by update_issue_status and by update_issue,
 * which accepts a `status` too because models confuse the two tools.
 */
function buildStatusPatch(ctx, args, status) {
    const isCurrent = targetsCurrentIssue(ctx, args.issue_id);
    if (isCurrent && NON_DISPOSITION_STATUSES.has(status)) {
        return {
            error: fail(`'${status}' is not a valid way to end a run on your own issue — Paperclip treats it as a missing ` +
                "disposition. Use done, cancelled, blocked (with blocked_by_issue_ids or unblock_action), " +
                "in_review (with reviewer_user_id), or call ask_user_questions if you need a human's input."),
        };
    }
    const patch = { status };
    if (typeof args.comment === "string" && args.comment.trim())
        patch.comment = args.comment.trim();
    if (status === "blocked") {
        const blockerIds = Array.isArray(args.blocked_by_issue_ids)
            ? args.blocked_by_issue_ids.filter((v) => typeof v === "string" && v.length > 0)
            : [];
        const unblockAction = asString(args.unblock_action).trim();
        if (blockerIds.length === 0 && !unblockAction) {
            return { error: fail(`status='blocked' needs a real blocker path. ${statusRejectionHint("blocked")}`) };
        }
        if (blockerIds.length > 0)
            patch.blockedByIssueIds = blockerIds;
        if (unblockAction) {
            // Paperclip only lets an agent name itself as the unblock owner.
            patch.unblockDescriptor = { owner: { agentId: ctx.agentId }, action: unblockAction.slice(0, 2000) };
        }
    }
    if (status === "in_review") {
        const reviewer = asString(args.reviewer_user_id).trim();
        if (!reviewer && isCurrent) {
            return { error: fail(`status='in_review' needs a reviewer. ${statusRejectionHint("in_review")}`) };
        }
        if (reviewer)
            patch.assigneeUserId = reviewer;
    }
    return { patch };
}
async function sendStatusPatch(ctx, toolName, id, status, patch) {
    try {
        return ok(await ctx.api.updateIssue(id, patch));
    }
    catch (err) {
        if (err instanceof PaperclipApiError) {
            const hint = err.status === 422 ? statusRejectionHint(status) : null;
            return fail(`${toolName} failed: ${err.message}${hint ? ` — ${hint}` : ""}`, {
                status: err.status,
                body: err.body,
            });
        }
        return fail(`${toolName} failed: ${err instanceof Error ? err.message : String(err)}`);
    }
}
const UPDATE_ISSUE_FIELDS = [
    "issue_id",
    "title",
    "description",
    "priority",
    "blocked_by_issue_ids",
    "assignee_agent_id",
    "assignee_user_id",
];
function updateIssueTool(ctx) {
    return {
        schema: {
            type: "function",
            function: {
                name: "update_issue",
                description: "Update an issue's fields other than status (use update_issue_status for status changes). " +
                    "Use this to fix a stale blocker set (e.g. blockers that point at a cancelled or done issue), " +
                    "reassign, retitle, or edit the description — instead of routing those changes through the " +
                    "issue owner. Only fields you supply are changed; omit anything you don't want to touch.",
                parameters: {
                    type: "object",
                    properties: {
                        issue_id: { type: "string", description: "Issue id. Omit to use the current issue." },
                        title: { type: "string" },
                        description: { type: "string" },
                        priority: { type: "string", enum: ["critical", "high", "medium", "low"] },
                        blocked_by_issue_ids: {
                            type: "array",
                            items: { type: "string" },
                            description: "Full replacement for the issue's blocker set — not a diff. Pass every issue id that " +
                                "should still block this one; omit any that no longer should (e.g. cancelled/done " +
                                "issues). Pass an empty array to clear all blockers.",
                        },
                        assignee_agent_id: {
                            type: "string",
                            description: "Agent id to assign to. Pass an empty string to unassign.",
                        },
                        assignee_user_id: {
                            type: "string",
                            description: "User id to assign to. Pass an empty string to unassign.",
                        },
                    },
                },
            },
        },
        execute: async (args) => {
            const id = asString(args.issue_id, ctx.currentIssueId ?? "");
            if (!id)
                return fail("No issue_id supplied and no current issue.");
            const patch = {};
            if (typeof args.title === "string" && args.title.trim())
                patch.title = args.title.trim();
            if (typeof args.description === "string")
                patch.description = args.description;
            if (typeof args.priority === "string" && args.priority)
                patch.priority = args.priority;
            if (Array.isArray(args.blocked_by_issue_ids)) {
                patch.blockedByIssueIds = args.blocked_by_issue_ids.filter((v) => typeof v === "string");
            }
            if (typeof args.assignee_agent_id === "string")
                patch.assigneeAgentId = args.assignee_agent_id || null;
            if (typeof args.assignee_user_id === "string")
                patch.assigneeUserId = args.assignee_user_id || null;
            // Not advertised in the schema, but models regularly send a status (and
            // comment) here instead of to update_issue_status. The intent is
            // unambiguous, so honor it with the same validation rather than
            // rejecting it and watching the model retry the identical call.
            const status = asString(args.status);
            if (status) {
                const built = buildStatusPatch(ctx, args, status);
                if ("error" in built)
                    return built.error;
                return sendStatusPatch(ctx, "update_issue", id, status, { ...patch, ...built.patch });
            }
            if (Object.keys(patch).length === 0) {
                const ignored = Object.keys(args).filter((k) => !UPDATE_ISSUE_FIELDS.includes(k));
                const commentHint = "comment" in args ? " To post a comment, use add_comment." : "";
                return fail(`No updatable fields supplied${ignored.length ? ` (ignored: ${ignored.join(", ")})` : ""}. ` +
                    `update_issue accepts ${UPDATE_ISSUE_FIELDS.slice(1).join(", ")}. ` +
                    `To change status, use update_issue_status.${commentHint}`);
            }
            return safeCall("update_issue", () => ctx.api.updateIssue(id, patch));
        },
    };
}
function addCommentTool(ctx) {
    return {
        schema: {
            type: "function",
            function: {
                name: "add_comment",
                description: "Post a comment on an issue. Use this to share progress, results, or questions with " +
                    "other agents and humans. Defaults to the current issue.",
                parameters: {
                    type: "object",
                    properties: {
                        issue_id: { type: "string", description: "Issue id. Omit to use the current issue." },
                        body: { type: "string", description: "Comment body in Markdown." },
                    },
                    required: ["body"],
                },
            },
        },
        execute: async (args) => {
            const id = asString(args.issue_id, ctx.currentIssueId ?? "");
            if (!id)
                return fail("No issue_id supplied and no current issue.");
            const body = asString(args.body);
            if (!body)
                return fail("body is required.");
            return safeCall("add_comment", () => ctx.api.addIssueComment(id, { body }));
        },
    };
}
function listCommentsTool(ctx) {
    return {
        schema: {
            type: "function",
            function: {
                name: "list_comments",
                description: "List all comments on an issue. Defaults to the current issue.",
                parameters: {
                    type: "object",
                    properties: {
                        issue_id: { type: "string", description: "Issue id. Omit to use the current issue." },
                    },
                },
            },
        },
        execute: async (args) => {
            const id = asString(args.issue_id, ctx.currentIssueId ?? "");
            if (!id)
                return fail("No issue_id supplied and no current issue.");
            return safeCall("list_comments", () => ctx.api.listIssueComments(id));
        },
    };
}
function createSubIssueTool(ctx) {
    return {
        schema: {
            type: "function",
            function: {
                name: "create_sub_issue",
                description: "Create a child issue under a parent (defaults to the current issue). Use this to break work " +
                    "into smaller pieces or delegate to a teammate by setting assigneeId.",
                parameters: {
                    type: "object",
                    properties: {
                        parent_issue_id: { type: "string", description: "Parent issue id. Omit to use current issue." },
                        title: { type: "string" },
                        description: { type: "string" },
                        assignee_agent_id: { type: "string", description: "Optional agent id to assign to." },
                        priority: { type: "string", enum: ["critical", "high", "medium", "low"] },
                    },
                    required: ["title"],
                },
            },
        },
        execute: async (args) => {
            const parentId = asString(args.parent_issue_id, ctx.currentIssueId ?? "");
            const title = asString(args.title);
            if (!title)
                return fail("title is required.");
            const payload = {
                title,
                description: args.description ?? "",
                parentId: parentId || undefined,
                assigneeAgentId: args.assignee_agent_id ?? undefined,
                priority: args.priority ?? undefined,
            };
            return safeCall("create_sub_issue", () => ctx.api.createIssue(ctx.companyId, payload));
        },
    };
}
function listIssuesTool(ctx) {
    return {
        schema: {
            type: "function",
            function: {
                name: "list_issues",
                description: "List issues in the current company, optionally filtered by status or assignee.",
                parameters: {
                    type: "object",
                    properties: {
                        status: { type: "string" },
                        assignee_agent_id: { type: "string" },
                        limit: { type: "number", description: "Max results, default 20." },
                    },
                },
            },
        },
        execute: async (args) => {
            const query = {};
            if (typeof args.status === "string")
                query.status = args.status;
            if (typeof args.assignee_agent_id === "string")
                query.assigneeAgentId = args.assignee_agent_id;
            query.limit = String(typeof args.limit === "number" ? args.limit : 20);
            return safeCall("list_issues", () => ctx.api.listCompanyIssues(ctx.companyId, query));
        },
    };
}
function hireAgentTool(ctx) {
    return {
        schema: {
            type: "function",
            function: {
                name: "hire_agent",
                description: "Hire a new agent into the company. By default this creates an approval request that a human " +
                    "must approve before the agent is created. Use this when you need a new role on your team.",
                parameters: {
                    type: "object",
                    properties: {
                        name: { type: "string" },
                        role: { type: "string", description: "Job title, e.g. 'Senior Engineer'." },
                        mission: { type: "string", description: "What this agent is responsible for." },
                        adapter_type: {
                            type: "string",
                            description: "Adapter to use, e.g. 'openrouter', 'claude_local'.",
                            default: "openrouter",
                        },
                        model: { type: "string", description: "Model id, e.g. 'stepfun/step-3.5-flash:free'." },
                        reports_to_agent_id: { type: "string", description: "Manager agent id." },
                    },
                    required: ["name", "role", "mission"],
                },
            },
        },
        execute: async (args) => {
            const payload = {
                name: args.name,
                role: args.role,
                mission: args.mission,
                adapterType: args.adapter_type ?? "openrouter",
                model: args.model,
                reportsToAgentId: args.reports_to_agent_id,
                requestedByAgentId: ctx.agentId,
            };
            if (ctx.autoApprove) {
                return safeCall("hire_agent", () => ctx.api.hireAgent(ctx.companyId, payload));
            }
            // Default path: route through approvals so a human signs off.
            return safeCall("hire_agent (approval)", () => ctx.api.createApproval(ctx.companyId, {
                type: "hire_agent",
                requestedByAgentId: ctx.agentId,
                payload: { ...payload, summary: `Hire ${args.name} as ${args.role}` },
            }));
        },
    };
}
function listAgentsTool(ctx) {
    return {
        schema: {
            type: "function",
            function: {
                name: "list_agents",
                description: "List all agents (teammates) in the current company. Returns each agent's id, name, " +
                    "role, title, adapter type, model, and status. Use this BEFORE delegating work with " +
                    "create_sub_issue or hire_agent so you can reference real agent ids instead of guessing.",
                parameters: {
                    type: "object",
                    properties: {},
                },
            },
        },
        execute: async () => {
            return safeCall("list_agents", async () => {
                const agents = await ctx.api.listCompanyAgents(ctx.companyId);
                // Trim to fields the model actually needs — full agent objects can be huge
                // and waste context window on hundreds of irrelevant runtime config keys.
                return agents.map((a) => ({
                    id: a.id,
                    name: a.name,
                    role: a.role,
                    title: a.title,
                    adapterType: a.adapterType,
                    model: a.adapterConfig?.model ?? null,
                    status: a.status,
                    reportsToAgentId: a.reportsToAgentId ?? null,
                }));
            });
        },
    };
}
function requestApprovalTool(ctx) {
    return {
        schema: {
            type: "function",
            function: {
                name: "request_approval",
                description: "Open an approval request for an action that requires human sign-off. " +
                    "Only three types are currently supported by Paperclip: hire_agent, " +
                    "approve_ceo_strategy, budget_override_required. For hiring, prefer the " +
                    "dedicated hire_agent tool instead.",
                parameters: {
                    type: "object",
                    properties: {
                        type: {
                            type: "string",
                            enum: ["hire_agent", "approve_ceo_strategy", "budget_override_required"],
                            description: "Approval type — must be one of the three supported values.",
                        },
                        summary: { type: "string", description: "One-line summary for the operator." },
                        payload: { type: "object", description: "Structured payload describing the action." },
                    },
                    required: ["type", "summary"],
                },
            },
        },
        execute: async (args) => {
            const type = asString(args.type);
            const summary = asString(args.summary);
            if (!type)
                return fail("type is required and must be hire_agent / approve_ceo_strategy / budget_override_required.");
            if (!summary)
                return fail("summary is required.");
            const payload = (args.payload && typeof args.payload === "object" ? args.payload : {});
            return safeCall("request_approval", () => ctx.api.createApproval(ctx.companyId, {
                type,
                requestedByAgentId: ctx.agentId,
                payload: { ...payload, summary },
            }));
        },
    };
}
function askUserQuestionsTool(ctx) {
    return {
        schema: {
            type: "function",
            function: {
                name: "ask_user_questions",
                description: "Ask a human a structured question and pause this issue for their reply — use this instead of " +
                    "guessing or stalling when you need information only a human can provide. Creates a Paperclip " +
                    "issue-thread interaction (continuationPolicy=wake_assignee): you will be woken again once someone " +
                    "answers. End your turn right after calling this — do not keep working on the issue in the same run. " +
                    "IMPORTANT: whenever the answer could reasonably be one of a short list of choices (yes/no, " +
                    "approve/reject, a named environment, a person, a small set of options you can name), set `options` " +
                    "so the human can tap an answer instead of typing one — do not leave `options` empty just because " +
                    "it's easier. Only skip `options` for a genuinely open-ended question (e.g. 'what should the title " +
                    'be?"). Example call: {"questions": [{"prompt": "Which environment should this deploy to?", ' +
                    '"options": [{"label": "Staging"}, {"label": "Production"}]}]}.',
                parameters: {
                    type: "object",
                    properties: {
                        title: { type: "string", description: "Short title shown on the question card." },
                        questions: {
                            type: "array",
                            minItems: 1,
                            items: {
                                type: "object",
                                properties: {
                                    prompt: { type: "string", description: "The question text." },
                                    required: { type: "boolean", description: "Default true." },
                                    multi_select: {
                                        type: "boolean",
                                        description: "Allow selecting more than one option. Default false.",
                                    },
                                    options: {
                                        type: "array",
                                        description: "Answer choices — set this whenever there's a nameable short list of likely answers " +
                                            "(see the tool description). Each item is either a plain string or {label, description}. " +
                                            "Only omit/leave empty for a genuinely open-ended free-text question.",
                                        items: {
                                            anyOf: [
                                                { type: "string" },
                                                {
                                                    type: "object",
                                                    properties: {
                                                        label: { type: "string" },
                                                        description: { type: "string" },
                                                    },
                                                    required: ["label"],
                                                },
                                            ],
                                        },
                                    },
                                },
                                required: ["prompt"],
                            },
                        },
                    },
                    required: ["questions"],
                },
            },
        },
        execute: async (args) => {
            const id = asString(args.issue_id, ctx.currentIssueId ?? "");
            if (!id)
                return fail("No current issue to attach the question to.");
            const rawQuestions = Array.isArray(args.questions) ? args.questions : [];
            if (rawQuestions.length === 0)
                return fail("At least one question is required.");
            const questions = rawQuestions.map((raw, qi) => {
                const q = (raw && typeof raw === "object" ? raw : {});
                const rawOptions = Array.isArray(q.options) ? q.options : [];
                const options = rawOptions.length > 0
                    ? rawOptions.map((raw2, oi) => {
                        if (typeof raw2 === "string") {
                            return { id: `q${qi + 1}_o${oi + 1}`, label: raw2 || `Option ${oi + 1}` };
                        }
                        const o = raw2 && typeof raw2 === "object" ? raw2 : {};
                        const option = {
                            id: `q${qi + 1}_o${oi + 1}`,
                            label: asString(o.label, `Option ${oi + 1}`),
                        };
                        if (typeof o.description === "string" && o.description)
                            option.description = o.description;
                        return option;
                    })
                    : [{ id: `q${qi + 1}_answer`, label: "Your answer", freeText: true }];
                return {
                    id: `q${qi + 1}`,
                    prompt: asString(q.prompt),
                    selectionMode: q.multi_select === true ? "multi" : "single",
                    required: q.required !== false,
                    options,
                };
            });
            if (questions.some((q) => !q.prompt))
                return fail("Every question needs a non-empty prompt.");
            const title = typeof args.title === "string" && args.title.trim() ? args.title.trim() : null;
            return safeCall("ask_user_questions", async () => {
                const result = await ctx.api.createIssueInteraction(id, {
                    kind: "ask_user_questions",
                    continuationPolicy: "wake_assignee",
                    title,
                    payload: { version: 1, title, questions },
                });
                if (ctx.interactionCreated)
                    ctx.interactionCreated.value = true;
                return result;
            });
        },
    };
}
function listInteractionsTool(ctx) {
    return {
        schema: {
            type: "function",
            function: {
                name: "list_interactions",
                description: "List every ask_user_questions / request_confirmation / suggest_tasks card ever created on an " +
                    "issue, oldest first, including their answers — pending, answered, accepted, rejected, or " +
                    "expired. Call this whenever you're not certain what's already been asked or answered on a " +
                    "multi-round task (e.g. a multi-part interview): each run starts with no memory of earlier " +
                    "runs, get_issue and list_comments do not show interaction history, and the wake prompt's " +
                    "'this interaction is answered' note only ever covers the single most recent card — not " +
                    "earlier ones. Check this before asking another round of questions.",
                parameters: {
                    type: "object",
                    properties: {
                        issue_id: { type: "string", description: "Issue id. Omit to use the current issue." },
                    },
                },
            },
        },
        execute: async (args) => {
            const id = asString(args.issue_id, ctx.currentIssueId ?? "");
            if (!id)
                return fail("No issue_id supplied and no current issue.");
            return safeCall("list_interactions", () => ctx.api.listIssueInteractions(id));
        },
    };
}
const DOCUMENT_ACTION_PROPERTIES = {
    action: { type: "string", enum: ["read", "write", "list"] },
    key: {
        type: "string",
        description: "Short id for the document, e.g. 'content-log' or 'weekly-report'. Lowercase letters, " +
            "numbers, - and _ only — anything else is auto-slugified. Required for read/write.",
    },
    title: { type: "string", description: "Display title. Optional for write." },
    body: { type: "string", description: "Full markdown content. Required for write — replace, don't diff." },
    change_summary: { type: "string", description: "One-line note on what changed this revision. Optional." },
};
/**
 * Paperclip's GET .../documents returns each document's full body (plus
 * revision/lock/author bookkeeping) — fine for one `read`, but a company
 * library can hold dozens of multi-KB drafts and briefs, and `list` is the
 * cheap "see what keys exist" call the tool description tells the model to
 * reach for first. A real incident: a single `library(action='list')`
 * dumped every document's full text into context, and that bloat was a
 * direct contributor to the model running out of its turn's budget before
 * ever emitting the write it was building toward. `list` now returns only
 * what's needed to decide what to `read` next.
 */
function summarizeDocumentList(docs) {
    return docs.map((d) => {
        const body = typeof d.body === "string" ? d.body : "";
        const preview = body.length > 200 ? `${body.slice(0, 200)}…` : body;
        return {
            key: d.key ?? null,
            title: d.title ?? null,
            format: d.format ?? null,
            latestRevisionNumber: d.latestRevisionNumber ?? null,
            updatedAt: d.updatedAt ?? null,
            preview,
        };
    });
}
/** read / write / list documents on one issue — shared by issue_document and library. */
async function runDocumentAction(ctx, label, issueId, args) {
    const action = asString(args.action);
    switch (action) {
        case "list":
            return safeCall(`${label}(list)`, async () => summarizeDocumentList(await ctx.api.listIssueDocuments(issueId)));
        case "read": {
            const rawKey = asString(args.key);
            if (!rawKey)
                return fail("key is required for action='read'.");
            return safeCall(`${label}(read)`, () => ctx.api.getIssueDocument(issueId, slugifyDocumentKey(rawKey)));
        }
        case "write": {
            const rawKey = asString(args.key);
            if (!rawKey)
                return fail("key is required for action='write'.");
            if (typeof args.body !== "string" || !args.body)
                return fail("body is required for action='write'.");
            const key = slugifyDocumentKey(rawKey);
            const title = typeof args.title === "string" && args.title.trim() ? args.title.trim() : null;
            const changeSummary = typeof args.change_summary === "string" && args.change_summary.trim() ? args.change_summary.trim() : null;
            const body = args.body;
            return safeCall(`${label}(write)`, async () => {
                // Paperclip requires baseRevisionId to exactly match the
                // document's current latestRevisionId on every update to an
                // existing key (optimistic concurrency) — omitting it always
                // 409s. Resolve it here instead of pushing revision tracking
                // onto the model: fetch the current doc (undefined if it
                // doesn't exist yet, which is correct for a create).
                const currentDoc = await ctx.api.getIssueDocument(issueId, key).catch(() => null);
                const baseRevisionId = typeof currentDoc?.latestRevisionId === "string" ? currentDoc.latestRevisionId : undefined;
                try {
                    return await ctx.api.upsertIssueDocument(issueId, key, { title, format: "markdown", body, changeSummary, baseRevisionId });
                }
                catch (err) {
                    // One retry: if baseRevisionId went stale because of a
                    // concurrent write between our read and this write, re-fetch
                    // and try exactly once more before giving up.
                    if (err instanceof PaperclipApiError && err.status === 409) {
                        const retryDoc = await ctx.api.getIssueDocument(issueId, key).catch(() => null);
                        const retryRevisionId = typeof retryDoc?.latestRevisionId === "string" ? retryDoc.latestRevisionId : undefined;
                        return await ctx.api.upsertIssueDocument(issueId, key, {
                            title,
                            format: "markdown",
                            body,
                            changeSummary,
                            baseRevisionId: retryRevisionId,
                        });
                    }
                    throw err;
                }
            });
        }
        default:
            return fail("action must be one of: read, write, list.");
    }
}
function issueDocumentTool(ctx) {
    return {
        schema: {
            type: "function",
            function: {
                name: "issue_document",
                description: "Read, write, or list durable markdown documents attached to an issue — visible in the " +
                    "Documents panel in the Paperclip web UI and the company Artifacts view, with full revision " +
                    "history. Use this for a task's own deliverables (reports, plans, specs, write-ups). For " +
                    "shared material other agents and future runs rely on, use `library`. Writing to an existing " +
                    "key adds a new revision; it does not delete history.",
                parameters: {
                    type: "object",
                    properties: {
                        ...DOCUMENT_ACTION_PROPERTIES,
                        issue_id: { type: "string", description: "Issue id or identifier. Omit to use the current issue." },
                    },
                    required: ["action"],
                },
            },
        },
        execute: async (args) => {
            const id = asString(args.issue_id, ctx.currentIssueId ?? "");
            if (!id)
                return fail("No issue_id supplied and no current issue.");
            return runDocumentAction(ctx, "issue_document", id, args);
        },
    };
}
const defaultLibraries = new WeakMap();
export function libraryFor(ctx) {
    if (ctx.library)
        return ctx.library;
    let library = defaultLibraries.get(ctx);
    if (!library) {
        const override = typeof ctx.config?.libraryIssue === "string" && ctx.config.libraryIssue.trim()
            ? ctx.config.libraryIssue.trim()
            : null;
        library = new LibraryResolver(ctx.api, ctx.companyId, override);
        defaultLibraries.set(ctx, library);
    }
    return library;
}
function libraryTool(ctx) {
    return {
        schema: {
            type: "function",
            function: {
                name: "library",
                description: `Read, write, or list the company's shared documents — the '${LIBRARY_ISSUE_TITLE}' issue that every ` +
                    "agent shares and humans can see in the web UI. This is the ONLY place for durable shared " +
                    "material: running logs (e.g. key 'content-log'), brief backlogs, drafts, reference notes, and " +
                    "anything a skill or your instructions call 'org storage', 'shared memory', or a file path like " +
                    "briefs/... — map a path to a key, e.g. 'briefs/2026-09-30-topic.md' → 'briefs-2026-09-30-topic'. " +
                    "Always action='list' first to see existing keys; update an existing key instead of creating a " +
                    "near-duplicate. There is no private or hidden storage.",
                parameters: {
                    type: "object",
                    properties: DOCUMENT_ACTION_PROPERTIES,
                    required: ["action"],
                },
            },
        },
        execute: async (args) => {
            let libraryIssue;
            try {
                libraryIssue = await libraryFor(ctx).get();
            }
            catch (err) {
                const reason = err instanceof PaperclipApiError ? `${err.message} (${err.status})` : err instanceof Error ? err.message : String(err);
                return fail(`Could not open the ${LIBRARY_ISSUE_TITLE}: ${reason}`);
            }
            const result = await runDocumentAction(ctx, "library", libraryIssue.id, args);
            if (asString(args.action) === "list" && !result.isError) {
                // Say where this lives so the model can cite it for humans.
                return ok({ libraryIssue: libraryIssue.identifier ?? libraryIssue.id, documents: JSON.parse(result.content) });
            }
            return result;
        },
    };
}
function findDocumentsTool(ctx) {
    return {
        schema: {
            type: "function",
            function: {
                name: "find_documents",
                description: "Search every document in the company (the web UI's Artifacts view) by keyword in title, body, " +
                    "or issue. Use it to find other agents' work — briefs, drafts, reports — before redoing it. Each " +
                    "result gives the issue and key to open with issue_document (action='read', issue_id, key).",
                parameters: {
                    type: "object",
                    properties: {
                        query: { type: "string", description: "Keyword(s). Omit to list the most recently updated documents." },
                        limit: { type: "number", description: "Max results, default 20." },
                    },
                },
            },
        },
        execute: async (args) => {
            const query = {
                kind: "document",
                limit: String(typeof args.limit === "number" && args.limit > 0 ? Math.min(args.limit, 50) : 20),
            };
            const q = asString(args.query).trim();
            if (q)
                query.q = q;
            return safeCall("find_documents", async () => {
                const res = await ctx.api.listCompanyArtifacts(ctx.companyId, query);
                const artifacts = Array.isArray(res.artifacts) ? res.artifacts : [];
                return {
                    documents: artifacts.map((a) => {
                        const issue = (a.issue ?? {});
                        const href = typeof a.href === "string" ? a.href : "";
                        const key = href.includes("#document-") ? decodeURIComponent(href.split("#document-")[1]) : null;
                        return {
                            title: a.title ?? null,
                            key,
                            issueId: issue.id ?? null,
                            issue: issue.identifier ?? null,
                            issueTitle: issue.title ?? null,
                            author: a.createdByAgent?.name ?? null,
                            updatedAt: a.updatedAt ?? null,
                            preview: a.previewText ?? null,
                        };
                    }),
                };
            });
        },
    };
}
const defaultStores = new WeakMap();
function secretStoreFor(ctx) {
    if (ctx.secretStore)
        return ctx.secretStore;
    let store = defaultStores.get(ctx);
    if (!store) {
        store = new SecretStore(ctx.secrets ?? {});
        defaultStores.set(ctx, store);
    }
    return store;
}
function listSecretsTool(ctx) {
    return {
        schema: {
            type: "function",
            function: {
                name: "list_secrets",
                description: "List the NAMES of the secrets/credentials bound to you (e.g. API keys, service-account keys). " +
                    "Values are never shown — reference one in http_request as {{secret:NAME}}, or via its `auth` option.",
                parameters: { type: "object", properties: {} },
            },
        },
        execute: async () => ok({ secrets: secretStoreFor(ctx).names() }),
    };
}
const HTTP_METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD"];
function httpRequestTool(ctx) {
    const store = secretStoreFor(ctx);
    const allowedHosts = parseAllowedHosts(ctx.config?.httpAllowedHosts);
    // Access tokens minted from a secret are as sensitive as the secret itself:
    // cache them for the run and redact them alongside the raw values.
    const tokenCache = new Map();
    const sensitive = () => [...store.sensitiveValues(), ...tokenCache.values()];
    return {
        schema: {
            type: "function",
            function: {
                name: "http_request",
                description: "Make an HTTP request to an external API. There is no shell or curl — this is the only way to " +
                    "call an outside service. Reference a bound secret anywhere in url/headers/query/body as " +
                    "{{secret:NAME}} (see list_secrets); it is substituted server-side and redacted from the " +
                    "response. For Google APIs authenticated by a service-account key secret, set " +
                    'auth={"type":"google_service_account","secret":"NAME","scopes":["https://www.googleapis.com/auth/webmasters.readonly"]} ' +
                    "instead of an Authorization header. Responses are truncated to ~32KB.",
                parameters: {
                    type: "object",
                    properties: {
                        method: { type: "string", enum: HTTP_METHODS, description: "Default GET." },
                        url: { type: "string", description: "Absolute http(s) URL." },
                        headers: {
                            type: "object",
                            additionalProperties: { type: "string" },
                            description: 'e.g. {"x-umami-api-key": "{{secret:UMAMI_API_KEY}}"}',
                        },
                        query: {
                            type: "object",
                            additionalProperties: { type: "string" },
                            description: "Query-string parameters appended to the url.",
                        },
                        body: {
                            description: "Request body. An object/array is sent as JSON; a string is sent as-is.",
                        },
                        auth: {
                            type: "object",
                            properties: {
                                type: { type: "string", enum: ["google_service_account"] },
                                secret: { type: "string", description: "Name of the secret holding the service-account JSON key." },
                                scopes: { type: "array", items: { type: "string" } },
                            },
                            required: ["type", "secret", "scopes"],
                        },
                    },
                    required: ["url"],
                },
            },
        },
        execute: async (args) => {
            const redact = (text) => redactSecrets(text, sensitive());
            const method = asString(args.method, "GET").toUpperCase();
            if (!HTTP_METHODS.includes(method))
                return fail(`method must be one of: ${HTTP_METHODS.join(", ")}.`);
            let url;
            const headers = {};
            let body;
            let secrets;
            try {
                // API-access secrets are fetched from Paperclip on demand, so resolve
                // everything this request references before substituting.
                secrets = await resolveSecrets(referencedSecretNames([args.url, args.headers, args.query, args.body]), store);
            }
            catch (err) {
                if (err instanceof SecretReferenceError)
                    return fail(err.message);
                return fail(`Could not load secret: ${redact(err instanceof Error ? err.message : String(err))}`);
            }
            try {
                const rawUrl = asString(args.url);
                if (!rawUrl)
                    return fail("url is required.");
                url = new URL(substituteSecrets(rawUrl, secrets));
                if (url.protocol !== "http:" && url.protocol !== "https:") {
                    return fail("Only http:// and https:// URLs are allowed.");
                }
                if (!hostAllowed(url, allowedHosts)) {
                    return fail(`Host '${url.hostname}' is not in this agent's httpAllowedHosts list.`);
                }
                if (args.query && typeof args.query === "object" && !Array.isArray(args.query)) {
                    for (const [k, v] of Object.entries(args.query)) {
                        if (v === undefined || v === null)
                            continue;
                        url.searchParams.set(k, substituteSecrets(String(v), secrets));
                    }
                }
                if (args.headers && typeof args.headers === "object" && !Array.isArray(args.headers)) {
                    for (const [k, v] of Object.entries(args.headers)) {
                        if (v === undefined || v === null)
                            continue;
                        headers[k] = substituteSecrets(String(v), secrets);
                    }
                }
                if (args.body !== undefined && args.body !== null && method !== "GET" && method !== "HEAD") {
                    if (typeof args.body === "string") {
                        body = substituteSecrets(args.body, secrets);
                    }
                    else {
                        body = JSON.stringify(substituteSecretsDeep(args.body, secrets));
                        if (!Object.keys(headers).some((h) => h.toLowerCase() === "content-type")) {
                            headers["Content-Type"] = "application/json";
                        }
                    }
                }
            }
            catch (err) {
                if (err instanceof SecretReferenceError)
                    return fail(err.message);
                return fail(`Invalid request: ${redact(err instanceof Error ? err.message : String(err))}`);
            }
            const auth = args.auth && typeof args.auth === "object" ? args.auth : null;
            if (auth) {
                if (auth.type !== "google_service_account")
                    return fail("auth.type must be 'google_service_account'.");
                const secretName = asString(auth.secret);
                if (!store.has(secretName))
                    return fail(store.unknownMessage(secretName));
                const scopes = Array.isArray(auth.scopes)
                    ? auth.scopes.filter((s) => typeof s === "string" && s.length > 0)
                    : [];
                if (scopes.length === 0)
                    return fail("auth.scopes must list at least one OAuth scope.");
                const cacheKey = `${secretName}|${[...scopes].sort().join(" ")}`;
                try {
                    let token = tokenCache.get(cacheKey);
                    if (!token) {
                        token = await fetchGoogleAccessToken(await store.get(secretName), scopes);
                        tokenCache.set(cacheKey, token);
                    }
                    headers.Authorization = `Bearer ${token}`;
                }
                catch (err) {
                    return fail(redact(err instanceof Error ? err.message : String(err)));
                }
            }
            let response;
            try {
                response = await fetch(url, {
                    method,
                    headers,
                    body,
                    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
                });
            }
            catch (err) {
                return fail(`Request failed: ${redact(err instanceof Error ? err.message : String(err))}`);
            }
            let text = method === "HEAD" ? "" : await response.text().catch(() => "");
            const truncated = text.length > MAX_RESPONSE_CHARS;
            if (truncated)
                text = text.slice(0, MAX_RESPONSE_CHARS);
            const result = {
                status: response.status,
                ok: response.ok,
                contentType: response.headers.get("content-type"),
                body: redact(text),
            };
            if (truncated)
                result.truncated = `Response truncated to ${MAX_RESPONSE_CHARS} characters.`;
            if (response.status >= 400 && response.status < 500) {
                // A 4xx means this exact request is wrong — resending it can't help,
                // and models otherwise tend to retry it until the repeat-loop breaker
                // kills the run.
                const underscored = Object.keys(headers).filter((h) => h.includes("_"));
                result.hint =
                    "Do not resend this request unchanged — a 4xx means the URL, method, headers, or credentials are wrong. " +
                        (underscored.length > 0
                            ? `Header names normally use hyphens, not underscores (got: ${underscored.join(", ")}). `
                            : "") +
                        "If you don't know the correct endpoint, say so in your disposition or ask via ask_user_questions instead of guessing.";
            }
            return { content: JSON.stringify(result), isError: !response.ok };
        },
    };
}
// ----- public API -----
export function buildTools(ctx) {
    // http_request is opt-in: agents with no bound secrets keep a no-network
    // toolset unless an operator explicitly enables it.
    const hasSecrets = secretStoreFor(ctx).names().length > 0;
    const httpEnabled = hasSecrets || ctx.config?.httpToolEnabled === true;
    return [
        getIssueTool(ctx),
        updateIssueStatusTool(ctx),
        updateIssueTool(ctx),
        addCommentTool(ctx),
        listCommentsTool(ctx),
        createSubIssueTool(ctx),
        listIssuesTool(ctx),
        listAgentsTool(ctx),
        hireAgentTool(ctx),
        requestApprovalTool(ctx),
        askUserQuestionsTool(ctx),
        listInteractionsTool(ctx),
        issueDocumentTool(ctx),
        libraryTool(ctx),
        findDocumentsTool(ctx),
        ...(hasSecrets ? [listSecretsTool(ctx)] : []),
        ...(httpEnabled ? [httpRequestTool(ctx)] : []),
    ];
}
/** Get the schemas to send to the model. */
export function toolSchemas(tools) {
    return tools.map((t) => t.schema);
}
/** Look up a tool by name. Returns null if not found. */
export function findTool(tools, name) {
    return tools.find((t) => t.schema.function.name === name) ?? null;
}
//# sourceMappingURL=tools.js.map
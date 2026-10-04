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
/** Issue UUID for an id or human identifier (DEBA-59). Paperclip rejects identifiers in id fields like parentId. */
export async function resolveIssueUuid(ctx, value) {
    if (ctx.currentIssueId && targetsCurrentIssue(ctx, value))
        return ctx.currentIssueId;
    if (isUuid(value))
        return value;
    return String((await ctx.api.getIssue(value)).id);
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
    // Paperclip marks the card failed when its generation task closes without a
    // summary, so "done" here would report success for a failed card.
    if (isCurrent && status === "done" && ctx.statusCardTask && !ctx.statusCardTask.summaryWritten) {
        return {
            error: fail("This is a status-card task and no summary has been saved yet — closing it now marks the card as " +
                "failed. Call publish_status_card action='save_summary' first, then mark this issue done. If you " +
                "can't produce a summary, use status='blocked' with unblock_action instead."),
        };
    }
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
                        parent_issue_id: { type: "string", description: "Parent issue id or identifier (e.g. ABC-12). Omit to use current issue." },
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
            const rawParent = asString(args.parent_issue_id, ctx.currentIssueId ?? "").trim();
            const title = asString(args.title);
            if (!title)
                return fail("title is required.");
            return safeCall("create_sub_issue", async () => {
                const payload = {
                    title,
                    description: args.description ?? "",
                    parentId: rawParent ? await resolveIssueUuid(ctx, rawParent) : undefined,
                    assigneeAgentId: args.assignee_agent_id ?? undefined,
                    priority: args.priority ?? undefined,
                };
                return ctx.api.createIssue(ctx.companyId, payload);
            });
        },
    };
}
/**
 * Paperclip's issue objects carry heavy bookkeeping (full description text,
 * blockerAttention/reviewAttention/successfulRunHandoff/relatedWork, a
 * couple dozen null fields) — fine for one issue via get_issue, but a real
 * incident had the model call list_issues(limit=50) just to check "does a
 * follow-up task already exist" and get back every field of 50 issues,
 * contributing tens of thousands of tokens on top of the same run's bloated
 * library(list) call. list_issues is for scanning/filtering; get_issue
 * already exists for full detail on one issue.
 */
function summarizeIssueList(issues) {
    return issues.map((i) => ({
        id: i.id ?? null,
        identifier: i.identifier ?? null,
        title: i.title ?? null,
        status: i.status ?? null,
        priority: i.priority ?? null,
        assigneeAgentId: i.assigneeAgentId ?? null,
        parentId: i.parentId ?? null,
        updatedAt: i.updatedAt ?? null,
    }));
}
function listIssuesTool(ctx) {
    return {
        schema: {
            type: "function",
            function: {
                name: "list_issues",
                description: "List issues in the current company, optionally filtered by status or assignee — a lightweight " +
                    "scan (id/identifier/title/status/priority/assignee/parent/updatedAt only). Use get_issue for " +
                    "an issue's full detail (description, comments, attachments).",
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
            return safeCall("list_issues", async () => {
                const issues = await ctx.api.listCompanyIssues(ctx.companyId, query);
                return Array.isArray(issues) ? summarizeIssueList(issues) : issues;
            });
        },
    };
}
// Source of truth: AGENT_ROLES in @paperclipai/shared/constants.
const AGENT_ROLES = [
    "ceo", "cto", "cmo", "cfo", "security", "engineer", "designer", "pm", "qa", "devops", "researcher", "general",
];
const ROLE_DESCRIPTION = `Role category, one of: ${AGENT_ROLES.join(", ")}. A free-text job title goes in 'title'.`;
/** A free-text role ("Head of Sales") is a job title; models routinely put it in `role`. */
function splitRoleAndTitle(args) {
    const role = optionalTrimmed(args.role);
    const title = optionalTrimmed(args.title) ?? undefined;
    if (!role)
        return { title };
    const normalized = role.toLowerCase();
    if (AGENT_ROLES.includes(normalized))
        return { role: normalized, title };
    return { title: title ?? role };
}
/**
 * Resolve an agent by id, name, or title (case-insensitive). Models usually
 * pass a name ("Dwight") rather than the id list_agents returned.
 */
async function resolveAgentRef(ctx, ref, field = "agent") {
    const wanted = asString(ref).trim();
    if (!wanted)
        return { error: fail(`'${field}' is required: an agent id or name from list_agents.`) };
    let agents;
    try {
        agents = await ctx.api.listCompanyAgents(ctx.companyId);
    }
    catch (err) {
        const reason = err instanceof PaperclipApiError ? `${err.message} (${err.status})` : err instanceof Error ? err.message : String(err);
        return { error: fail(`Could not list agents to resolve '${wanted}': ${reason}`) };
    }
    const byId = agents.find((a) => a.id === wanted);
    if (byId)
        return { agent: byId };
    const lower = wanted.toLowerCase();
    for (const key of ["name", "title"]) {
        const matches = agents.filter((a) => typeof a[key] === "string" && a[key].toLowerCase() === lower);
        if (matches.length === 1)
            return { agent: matches[0] };
        if (matches.length > 1) {
            return { error: fail(`'${wanted}' matches ${matches.length} agents; pass the id instead.`, { matches: agentChoices(matches) }) };
        }
    }
    return { error: fail(`No agent matches '${wanted}'. Pass one of these ids or names.`, { agents: agentChoices(agents) }) };
}
function agentChoices(agents) {
    return agents.map((a) => ({ id: a.id, name: a.name, title: a.title ?? null }));
}
/** Clearing words for `reports_to`; null clears it too. */
function isClearValue(v) {
    return v === null || (typeof v === "string" && ["", "none", "null", "nobody"].includes(v.trim().toLowerCase()));
}
/** The server decides who may edit agents; on a 403, tell the model how to get the change made. */
async function agentConfigCall(label, fn) {
    const result = await safeCall(label, fn);
    if (!result.isError)
        return result;
    const body = JSON.parse(result.content);
    if (body.detail?.status !== 403)
        return result;
    body.next_step =
        "You lack permission for this change (it needs the agents:configure grant). Ask a human: use " +
            "request_approval describing the exact change, or update_issue_status blocked with an unblock_action.";
    return { content: JSON.stringify(body), isError: true };
}
function hireAgentTool(ctx) {
    return {
        schema: {
            type: "function",
            function: {
                name: "hire_agent",
                description: "Hire a new agent into the company. By default this creates an approval request that a human " +
                    "must approve before the agent is created. Use this when you need a new role on your team. " +
                    "Call list_agents first to pick the manager for reports_to.",
                parameters: {
                    type: "object",
                    properties: {
                        name: { type: "string" },
                        title: { type: "string", description: "Job title, e.g. 'Senior Engineer'." },
                        role: { type: "string", enum: [...AGENT_ROLES], description: ROLE_DESCRIPTION },
                        capabilities: { type: "string", description: "What this agent is responsible for." },
                        reports_to: { type: "string", description: "Manager's agent id or name." },
                        adapter_type: {
                            type: "string",
                            description: "Adapter to use, e.g. 'llm' (this adapter) or 'claude_local'.",
                            default: "llm",
                        },
                        model: { type: "string", description: "Model id, e.g. 'openai/gpt-oss-120b'." },
                        instructions: {
                            type: "string",
                            description: "The new agent's AGENTS.md: its full prompt (who it is, what it owns, how it works).",
                        },
                    },
                    required: ["name", "title"],
                },
            },
        },
        execute: async (args) => {
            const name = optionalTrimmed(args.name);
            if (!name)
                return fail("hire_agent needs 'name'.");
            const { role, title } = splitRoleAndTitle(args);
            const payload = {
                name,
                role: role ?? "general",
                adapterType: asString(args.adapter_type, "llm"),
            };
            if (title)
                payload.title = title;
            // `mission` was this tool's old name for capabilities; models still send it.
            const capabilities = optionalTrimmed(args.capabilities) ?? optionalTrimmed(args.mission);
            if (capabilities)
                payload.capabilities = capabilities;
            const model = optionalTrimmed(args.model);
            if (model)
                payload.adapterConfig = { model };
            const instructions = optionalTrimmed(args.instructions);
            if (instructions)
                payload.instructionsBundle = { files: { "AGENTS.md": instructions } };
            const managerRef = args.reports_to ?? args.reports_to_agent_id;
            if (!isClearValue(managerRef) && managerRef !== undefined) {
                const manager = await resolveAgentRef(ctx, managerRef, "reports_to");
                if ("error" in manager)
                    return manager.error;
                payload.reportsTo = manager.agent.id;
            }
            if (ctx.autoApprove) {
                return safeCall("hire_agent", () => ctx.api.hireAgent(ctx.companyId, payload));
            }
            // Default path: route through approvals so a human signs off.
            return safeCall("hire_agent (approval)", () => ctx.api.createApproval(ctx.companyId, {
                type: "hire_agent",
                requestedByAgentId: ctx.agentId,
                payload: { ...payload, summary: `Hire ${name} as ${title ?? role ?? "general"}` },
            }));
        },
    };
}
/** Adapter config keys that are secrets or instruction-bundle plumbing, not useful to the model. */
const HIDDEN_ADAPTER_CONFIG_KEYS = new Set([
    "env", "apiKey", "instructionsFilePath", "instructionsRootPath", "instructionsEntryFile",
    "instructionsBundleMode", "promptTemplate", "bootstrapPromptTemplate", "systemPrompt",
]);
function getAgentTool(ctx) {
    return {
        schema: {
            type: "function",
            function: {
                name: "get_agent",
                description: "Show one agent's setup: name, title, role, manager, status, adapter and model, other adapter " +
                    "settings, heartbeat, and its instruction files. Read this before changing an agent with " +
                    "update_agent or agent_instructions.",
                parameters: {
                    type: "object",
                    properties: { agent: { type: "string", description: "Agent id or name." } },
                    required: ["agent"],
                },
            },
        },
        execute: async (args) => {
            const ref = await resolveAgentRef(ctx, args.agent);
            if ("error" in ref)
                return ref.error;
            const id = ref.agent.id;
            return safeCall("get_agent", async () => {
                const agent = await ctx.api.getAgent(id);
                const adapterConfig = (agent.adapterConfig ?? {});
                const runtimeConfig = (agent.runtimeConfig ?? {});
                let manager = null;
                if (typeof agent.reportsTo === "string") {
                    const all = await ctx.api.listCompanyAgents(ctx.companyId).catch(() => []);
                    const m = all.find((a) => a.id === agent.reportsTo);
                    manager = { id: agent.reportsTo, name: m?.name ?? null };
                }
                let instructionFiles = null;
                try {
                    const bundle = await ctx.api.getAgentInstructionsBundle(id);
                    instructionFiles = {
                        entryFile: bundle.entryFile ?? null,
                        files: Array.isArray(bundle.files) ? bundle.files.map((f) => f.path) : [],
                    };
                }
                catch (err) {
                    instructionFiles = { unavailable: err instanceof Error ? err.message : String(err) };
                }
                return {
                    id: agent.id,
                    name: agent.name,
                    title: agent.title ?? null,
                    role: agent.role,
                    status: agent.status,
                    reportsTo: manager,
                    capabilities: agent.capabilities ?? null,
                    adapterType: agent.adapterType,
                    model: adapterConfig.model ?? null,
                    adapterConfig: Object.fromEntries(Object.entries(adapterConfig).filter(([k]) => !HIDDEN_ADAPTER_CONFIG_KEYS.has(k) && k !== "model")),
                    heartbeat: runtimeConfig.heartbeat ?? null,
                    instructions: instructionFiles,
                };
            });
        },
    };
}
const UPDATE_AGENT_FIELDS = [
    "name", "title", "role", "reports_to", "capabilities", "adapter_type", "model", "adapter_config",
    "heartbeat_enabled", "heartbeat_interval_sec", "status",
];
function updateAgentTool(ctx) {
    return {
        schema: {
            type: "function",
            function: {
                name: "update_agent",
                description: "Change an existing agent: name, job title, role, who it reports to, its responsibilities, its " +
                    "adapter (harness) and model, other adapter settings, its heartbeat schedule, or pause/resume it. " +
                    "Send only the fields to change. To change what the agent is told to do (its prompt), use " +
                    "agent_instructions instead.",
                parameters: {
                    type: "object",
                    properties: {
                        agent: { type: "string", description: "Agent id or name to change." },
                        name: { type: "string" },
                        title: { type: "string", description: "Job title, e.g. 'VP of Sales'." },
                        role: { type: "string", enum: [...AGENT_ROLES], description: ROLE_DESCRIPTION },
                        reports_to: {
                            type: "string",
                            description: "New manager's agent id or name. 'none' removes the manager.",
                        },
                        capabilities: { type: "string", description: "What this agent is responsible for." },
                        adapter_type: { type: "string", description: "Adapter (harness), e.g. 'llm' or 'claude_local'." },
                        model: { type: "string", description: "Model id, e.g. 'openai/gpt-oss-120b'." },
                        adapter_config: {
                            type: "object",
                            description: "Other adapter settings to set, merged into the existing ones (e.g. {\"maxTurns\": 30}).",
                        },
                        heartbeat_enabled: { type: "boolean", description: "Whether the agent wakes on a timer." },
                        heartbeat_interval_sec: { type: "number", description: "Seconds between timer wakes." },
                        status: { type: "string", enum: ["paused", "active"], description: "Pause or resume the agent." },
                    },
                    required: ["agent"],
                },
            },
        },
        execute: async (args) => {
            const ref = await resolveAgentRef(ctx, args.agent);
            if ("error" in ref)
                return ref.error;
            const id = ref.agent.id;
            const patch = {};
            const name = optionalTrimmed(args.name);
            if (name)
                patch.name = name;
            const { role, title } = splitRoleAndTitle(args);
            if (role)
                patch.role = role;
            if (title)
                patch.title = title;
            const capabilities = optionalTrimmed(args.capabilities);
            if (capabilities)
                patch.capabilities = capabilities;
            const adapterType = optionalTrimmed(args.adapter_type);
            if (adapterType)
                patch.adapterType = adapterType;
            if ("reports_to" in args) {
                if (isClearValue(args.reports_to)) {
                    patch.reportsTo = null;
                }
                else {
                    const manager = await resolveAgentRef(ctx, args.reports_to, "reports_to");
                    if ("error" in manager)
                        return manager.error;
                    if (manager.agent.id === id)
                        return fail("An agent cannot report to itself. Pick a different reports_to.");
                    patch.reportsTo = manager.agent.id;
                }
            }
            const adapterConfig = {};
            if (args.adapter_config !== undefined) {
                if (!args.adapter_config || typeof args.adapter_config !== "object" || Array.isArray(args.adapter_config)) {
                    return fail("adapter_config must be an object of settings, e.g. {\"maxTurns\": 30}.");
                }
                Object.assign(adapterConfig, args.adapter_config);
            }
            const model = optionalTrimmed(args.model);
            if (model)
                adapterConfig.model = model;
            // Paperclip merges adapterConfig into the existing one unless replaceAdapterConfig is set.
            if (Object.keys(adapterConfig).length > 0)
                patch.adapterConfig = adapterConfig;
            const wantsHeartbeat = typeof args.heartbeat_enabled === "boolean" || args.heartbeat_interval_sec !== undefined;
            const interval = Number(args.heartbeat_interval_sec);
            if (args.heartbeat_interval_sec !== undefined && !(Number.isFinite(interval) && interval > 0)) {
                return fail("heartbeat_interval_sec must be a positive number of seconds.");
            }
            const status = optionalTrimmed(args.status)?.toLowerCase();
            if (status && status !== "paused" && status !== "active") {
                return fail("status must be 'paused' or 'active'. Agents cannot be terminated with this tool.");
            }
            if (Object.keys(patch).length === 0 && !wantsHeartbeat && !status) {
                return fail(`Nothing to change. Pass at least one of: ${UPDATE_AGENT_FIELDS.join(", ")}.`);
            }
            return agentConfigCall("update_agent", async () => {
                if (wantsHeartbeat) {
                    // runtimeConfig is replaced wholesale, so merge over the current one.
                    const current = ((await ctx.api.getAgent(id)).runtimeConfig ?? {});
                    const heartbeat = { ...(current.heartbeat ?? {}) };
                    if (typeof args.heartbeat_enabled === "boolean")
                        heartbeat.enabled = args.heartbeat_enabled;
                    if (args.heartbeat_interval_sec !== undefined)
                        heartbeat.intervalSec = Math.round(interval);
                    patch.runtimeConfig = { ...current, heartbeat };
                }
                let updated = null;
                if (Object.keys(patch).length > 0)
                    updated = await ctx.api.updateAgent(id, patch);
                if (status === "paused")
                    updated = await ctx.api.pauseAgent(id);
                if (status === "active")
                    updated = await ctx.api.resumeAgent(id);
                const u = updated ?? {};
                return {
                    updated: Object.keys(patch).concat(status ? ["status"] : []),
                    agent: {
                        id: u.id ?? id,
                        name: u.name ?? null,
                        title: u.title ?? null,
                        role: u.role ?? null,
                        status: u.status ?? null,
                        reportsTo: u.reportsTo ?? null,
                        adapterType: u.adapterType ?? null,
                        model: (u.adapterConfig ?? {}).model ?? null,
                    },
                };
            });
        },
    };
}
function agentInstructionsTool(ctx) {
    return {
        schema: {
            type: "function",
            function: {
                name: "agent_instructions",
                description: "Read or change an agent's instruction files: its prompt (usually AGENTS.md), which it reads " +
                    "at the start of every run. action='list' shows the files; 'read' returns one; 'write' REPLACES " +
                    "the whole file with 'content' (read it first and send the complete new text); 'append' adds " +
                    "'content' to the end. Changes take effect on the agent's next run.",
                parameters: {
                    type: "object",
                    properties: {
                        agent: { type: "string", description: "Agent id or name." },
                        action: { type: "string", enum: ["list", "read", "write", "append"] },
                        path: { type: "string", description: "File path in the bundle. Omit for the main file (AGENTS.md)." },
                        content: { type: "string", description: "For write: the full new file. For append: the text to add." },
                    },
                    required: ["agent", "action"],
                },
            },
        },
        execute: async (args) => {
            const action = asString(args.action);
            if (!["list", "read", "write", "append"].includes(action)) {
                return fail("action must be one of: list, read, write, append.");
            }
            const content = typeof args.content === "string" ? args.content : "";
            if ((action === "write" || action === "append") && !content.trim()) {
                return fail(`action='${action}' needs 'content'.`);
            }
            const ref = await resolveAgentRef(ctx, args.agent);
            if ("error" in ref)
                return ref.error;
            const id = ref.agent.id;
            const label = `agent_instructions ${action}`;
            if (action === "list") {
                return agentConfigCall(label, async () => {
                    const bundle = await ctx.api.getAgentInstructionsBundle(id);
                    return {
                        agent: ref.agent.name,
                        entryFile: bundle.entryFile ?? null,
                        files: Array.isArray(bundle.files)
                            ? bundle.files.map((f) => ({ path: f.path, size: f.size }))
                            : [],
                    };
                });
            }
            return agentConfigCall(label, async () => {
                let path = optionalTrimmed(args.path);
                if (!path) {
                    const bundle = await ctx.api.getAgentInstructionsBundle(id).catch(() => null);
                    path = typeof bundle?.entryFile === "string" ? bundle.entryFile : "AGENTS.md";
                }
                if (action === "read") {
                    const file = await ctx.api.readAgentInstructionsFile(id, path);
                    return { agent: ref.agent.name, path: file.path ?? path, content: file.content ?? "" };
                }
                let body = content;
                if (action === "append") {
                    const existing = await ctx.api.readAgentInstructionsFile(id, path).catch((err) => {
                        if (err instanceof PaperclipApiError && err.status === 404)
                            return { content: "" };
                        throw err;
                    });
                    const current = typeof existing.content === "string" ? existing.content.replace(/\s+$/, "") : "";
                    body = current ? `${current}\n\n${content}` : content;
                }
                const file = await ctx.api.writeAgentInstructionsFile(id, path, body);
                return { agent: ref.agent.name, path: file.path ?? path, size: file.size ?? body.length, action };
            });
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
                    "create_sub_issue or hire_agent so you can reference real agent ids instead of guessing. To change " +
                    "an agent, use get_agent, update_agent, and agent_instructions.",
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
                                            "(see the tool description). Each item is {label, description}. " +
                                            "Only omit/leave empty for a genuinely open-ended free-text question.",
                                        items: {
                                            type: "object",
                                            properties: {
                                                label: { type: "string" },
                                                description: { type: "string" },
                                            },
                                            required: ["label"],
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
    action: { type: "string", enum: ["read", "write", "append", "list"] },
    key: {
        type: "string",
        description: "Short id for the document, e.g. 'content-log' or 'weekly-report'. Lowercase letters, " +
            "numbers, - and _ only — anything else is auto-slugified. Required for read/write/append.",
    },
    title: { type: "string", description: "Display title. Optional for write/append." },
    body: {
        type: "string",
        description: "For write: the full markdown content — replace, don't diff; required, and must include " +
            "everything you want kept, not just what changed. For append: just the new text to add " +
            "(e.g. one review-log entry) — the existing document is kept and this is added after it, " +
            "with no need to resend content you aren't changing.",
    },
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
/**
 * Weak models resend a call that's missing `key` unchanged until the repeat
 * guard kills the run, so name the keys they can pick from.
 */
async function missingKeyError(ctx, issueId, action, bodyHeld = false) {
    const what = action === "append" ? "the document to add to" : action === "read" ? "the document to read" : "the document to write";
    const head = `key is required for action='${action}' — ${what}.`;
    const resend = bodyHeld
        ? `Your body was received and is held: resend action='${action}' with just key set — you don't need to resend body`
        : "Resend the same call with key set";
    let keys;
    try {
        keys = (await ctx.api.listIssueDocuments(issueId))
            .map((d) => d.key)
            .filter((k) => typeof k === "string" && k.length > 0);
    }
    catch {
        return fail(`${head} Use action='list' to see the existing keys. ${resend}.`);
    }
    const newKey = action === "write" ? " (or a new key to create a document)" : "";
    if (keys.length === 0) {
        return fail(`${head} There are no documents yet${action === "write" ? "" : "; use action='write' to create one"}. ${resend}${newKey}.`);
    }
    const shown = keys.slice(0, 30).join(", ") + (keys.length > 30 ? `, … (${keys.length - 30} more)` : "");
    return fail(`${head} Existing keys: ${shown}. ${resend}, using one of them${newKey}.`);
}
const partialDocumentCalls = new WeakMap();
const DOCUMENT_CALL_FIELDS = ["key", "body", "title", "change_summary"];
/**
 * glm-5.3-flash calls carrying a long `body` repeatedly arrived without `key`
 * (even when the model said it was sending it), while key-only calls came
 * through. Holding the half that arrived lets the next call supply the rest.
 */
function mergePartialDocumentCall(partial, label, issueId, action, args) {
    if (!partial || partial.label !== label || partial.issueId !== issueId || partial.action !== action)
        return args;
    const merged = { ...args };
    for (const field of DOCUMENT_CALL_FIELDS) {
        const current = merged[field];
        if ((current === undefined || current === "") && partial.args[field] !== undefined)
            merged[field] = partial.args[field];
    }
    return merged;
}
/** read / write / list documents on one issue — shared by issue_document and library. */
async function runDocumentAction(ctx, label, issueId, rawArgs) {
    const action = asString(rawArgs.action);
    // A held half is only good for the very next document call.
    const partial = partialDocumentCalls.get(ctx);
    partialDocumentCalls.delete(ctx);
    switch (action) {
        case "list":
            return safeCall(`${label}(list)`, async () => summarizeDocumentList(await ctx.api.listIssueDocuments(issueId)));
        case "read": {
            const rawKey = asString(rawArgs.key);
            if (!rawKey)
                return missingKeyError(ctx, issueId, "read");
            return safeCall(`${label}(read)`, () => ctx.api.getIssueDocument(issueId, slugifyDocumentKey(rawKey)));
        }
        case "write":
        case "append": {
            const args = mergePartialDocumentCall(partial, label, issueId, action, rawArgs);
            const rawKey = asString(args.key);
            const hasBody = typeof args.body === "string" && args.body.length > 0;
            if (!rawKey || !hasBody) {
                partialDocumentCalls.set(ctx, { label, issueId, action, args });
            }
            if (!rawKey)
                return missingKeyError(ctx, issueId, action, hasBody);
            if (!hasBody) {
                const what = action === "append" ? " — the new text to add, not the whole document" : "";
                return fail(`body is required for action='${action}'${what}. key='${rawKey}' is held: resend action='${action}' ` +
                    "with body set — you don't need to resend key.");
            }
            const key = slugifyDocumentKey(rawKey);
            if (action === "write") {
                return safeCall(`${label}(write)`, () => writeDocument(issueDocumentStore(ctx, issueId), key, args));
            }
            return safeCall(`${label}(append)`, () => appendDocument(issueDocumentStore(ctx, issueId), key, args, "action='write'"));
        }
        default:
            return fail("action must be one of: read, write, append, list.");
    }
}
function issueDocumentStore(ctx, issueId) {
    return {
        get: (key) => ctx.api.getIssueDocument(issueId, key),
        put: (key, body) => ctx.api.upsertIssueDocument(issueId, key, body),
    };
}
function caseDocumentStore(ctx, caseId) {
    return {
        get: (key) => ctx.api.getCaseDocument(caseId, key),
        put: (key, body) => ctx.api.upsertCaseDocument(caseId, key, body),
    };
}
function optionalTrimmed(v) {
    return typeof v === "string" && v.trim() ? v.trim() : null;
}
/** Full replace. args: body (required), title, change_summary. */
async function writeDocument(store, key, args) {
    // Paperclip requires baseRevisionId to match the current revision on every
    // update (and to be absent on create); resolve it here so the model never
    // has to track revision ids.
    const currentDoc = await store.get(key).catch(() => null);
    const baseRevisionId = typeof currentDoc?.latestRevisionId === "string" ? currentDoc.latestRevisionId : undefined;
    return upsertDocumentWithRetry(store, key, {
        title: optionalTrimmed(args.title),
        body: args.body,
        changeSummary: optionalTrimmed(args.change_summary),
        baseRevisionId,
    });
}
/**
 * Read-modify-write so the model sends only the new text. A real incident:
 * a model ran out of its turn's token budget retyping a multi-KB draft via
 * a full write just to add one review-log paragraph, so the review was never
 * recorded. `writeHint` names the create action in the calling tool.
 */
async function appendDocument(store, key, args, writeHint) {
    const currentDoc = await store.get(key).catch(() => null);
    if (!currentDoc || typeof currentDoc.body !== "string") {
        throw new Error(`No document at key '${key}' to append to — use ${writeHint} to create it first.`);
    }
    return upsertDocumentWithRetry(store, key, {
        title: optionalTrimmed(args.title) ?? (typeof currentDoc.title === "string" ? currentDoc.title : null),
        body: `${currentDoc.body.replace(/\s+$/, "")}\n\n${args.body}`,
        changeSummary: optionalTrimmed(args.change_summary),
        baseRevisionId: typeof currentDoc.latestRevisionId === "string" ? currentDoc.latestRevisionId : undefined,
    });
}
/**
 * Paperclip 409s if baseRevisionId doesn't exactly match the document's
 * current latestRevisionId. One retry covers a concurrent write landing
 * between our read and this write.
 */
async function upsertDocumentWithRetry(store, key, opts) {
    const send = (baseRevisionId) => store.put(key, { title: opts.title, format: "markdown", body: opts.body, changeSummary: opts.changeSummary, baseRevisionId });
    try {
        return await send(opts.baseRevisionId);
    }
    catch (err) {
        if (err instanceof PaperclipApiError && err.status === 409) {
            const retryDoc = await store.get(key).catch(() => null);
            return await send(typeof retryDoc?.latestRevisionId === "string" ? retryDoc.latestRevisionId : undefined);
        }
        throw err;
    }
}
function issueDocumentTool(ctx) {
    return {
        schema: {
            type: "function",
            function: {
                name: "issue_document",
                description: "Read, write, append to, or list durable markdown documents attached to an issue — visible in " +
                    "the Documents panel in the Paperclip web UI and the company Artifacts view, with full revision " +
                    "history. Use this for a task's own deliverables (reports, plans, specs, write-ups). For " +
                    "shared material other agents and future runs rely on, use `library`. Writing to an existing " +
                    "key adds a new revision; it does not delete history. To add one entry to an existing document " +
                    "instead of changing it, use action='append' with just the new text — much cheaper than " +
                    "action='write', which requires resending the whole document every time.",
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
                description: `Read, write, append to, or list the company's shared documents — the '${LIBRARY_ISSUE_TITLE}' issue ` +
                    "that every agent shares and humans can see in the web UI. This is the ONLY place for durable " +
                    "shared material: running logs (e.g. key 'content-log'), brief backlogs, drafts, reference " +
                    "notes, and anything a skill or your instructions call 'org storage', 'shared memory', or a " +
                    "file path like briefs/... — map a path to a key, e.g. 'briefs/2026-09-30-topic.md' → " +
                    "'briefs-2026-09-30-topic'. Always action='list' first to see existing keys; update an existing " +
                    "key instead of creating a near-duplicate. To add one more entry to an existing document — a " +
                    "review-log line, a sign-off, a status update — use action='append' and send only the new text; " +
                    "it's far cheaper than action='write', which requires resending the entire document every time. " +
                    "Reserve 'write' for creating a new document or changing content earlier in an existing one. " +
                    "There is no private or hidden storage.",
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
                    "response. Send a JSON request body in `json` (an object); `body` is only for raw string bodies. " +
                    "For Google APIs authenticated by a service-account key secret, set " +
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
                            description: 'e.g. {"x-umami-api-key": "{{secret:NAME}}"}',
                        },
                        query: {
                            type: "object",
                            additionalProperties: { type: "string" },
                            description: "Query-string parameters appended to the url.",
                        },
                        json: {
                            type: "object",
                            description: "JSON request body, sent with Content-Type: application/json. Use this for JSON APIs, e.g. " +
                                '{"startDate":"2026-01-01","endDate":"2026-01-07","dimensions":["query"]}.',
                        },
                        body: {
                            type: "string",
                            description: "Raw request body, sent as-is (e.g. form-encoded). For JSON use `json` instead.",
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
                secrets = await resolveSecrets(referencedSecretNames([args.url, args.headers, args.query, args.json, args.body]), store);
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
                // An object `body` is the same intent as `json`; send it as JSON rather than reject it.
                const payload = args.json ?? args.body;
                if (payload !== undefined && payload !== null && method !== "GET" && method !== "HEAD") {
                    if (typeof payload === "string") {
                        body = substituteSecrets(payload, secrets);
                    }
                    else {
                        body = JSON.stringify(substituteSecretsDeep(payload, secrets));
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
                // glm-5.3-flash planned a JSON body but its POSTs arrived without one (DEBA-77).
                const noBody = body === undefined && ["POST", "PUT", "PATCH"].includes(method);
                result.hint =
                    (noBody
                        ? "This request was sent with NO body — no `json` or `body` field arrived. If the API needs a " +
                            "request body, resend with `json` set to the request object. "
                        : "") +
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
// ----- Paperclip experimental features: cases and status cards -----
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function isUuid(v) {
    return UUID_RE.test(v);
}
function errorReason(err) {
    if (err instanceof PaperclipApiError)
        return `${err.status} ${err.message}`;
    return err instanceof Error ? err.message : String(err);
}
/** Status-card generation issues carry their target in a ```json block in the description. */
export function parseStatusCardTask(issue) {
    const description = typeof issue.description === "string" ? issue.description : "";
    const match = description.match(/```json\n([\s\S]*?)\n```/);
    if (!match)
        return null;
    let payload;
    try {
        payload = JSON.parse(match[1]);
    }
    catch {
        return null;
    }
    const operation = payload.operation;
    if (operation !== "compile" && operation !== "update")
        return null;
    if (typeof payload.statusCardId !== "string" || payload.generationIssueId !== issue.id)
        return null;
    return {
        operation,
        statusCardId: payload.statusCardId,
        generationIssueId: payload.generationIssueId,
        summaryWritten: false,
    };
}
/**
 * Neither feature is advertised to adapters, so probe each with a cheap read:
 * disabled cases answer 403 and disabled status cards 404. Any failure leaves
 * the feature's tools out of this run.
 */
export async function detectPaperclipFeatures(api, companyId, currentIssueId) {
    const errors = [];
    const probe = (name, fn) => fn().then(() => true, (err) => {
        const disabled = err instanceof PaperclipApiError && (err.status === 403 || err.status === 404);
        if (!disabled)
            errors.push(`${name}: ${errorReason(err)}`);
        return false;
    });
    const [cases, statusCards] = await Promise.all([
        probe("cases", () => api.listCases(companyId, { limit: "1" })),
        probe("status cards", () => api.listStatusCards(companyId)),
    ]);
    let statusCardTask = null;
    if (statusCards && currentIssueId) {
        try {
            statusCardTask = parseStatusCardTask(await api.getIssue(currentIssueId));
        }
        catch (err) {
            errors.push(`status-card task lookup: ${errorReason(err)}`);
        }
    }
    return { cases, statusCards, statusCardTask, errors };
}
/** Accepts an id or a name for a project/label; status-card queries and cases need the id. */
async function resolveNamedId(ctx, kind, value) {
    if (isUuid(value))
        return value;
    const rows = kind === "project"
        ? await ctx.api.listCompanyProjects(ctx.companyId)
        : await ctx.api.listCompanyLabels(ctx.companyId);
    const list = Array.isArray(rows) ? rows : [];
    const wanted = value.trim().toLowerCase();
    const hit = list.find((r) => typeof r.name === "string" && r.name.trim().toLowerCase() === wanted);
    if (hit && typeof hit.id === "string")
        return hit.id;
    const names = list.map((r) => r.name).filter((n) => typeof n === "string");
    throw new Error(`No ${kind} named '${value}'. Available ${kind}s: ${names.length ? names.join(", ") : "(none)"}. ` +
        `Use one of these names, or leave ${kind} out.`);
}
const CASE_STATUSES = ["draft", "in_progress", "in_review", "approved", "done", "cancelled"];
const CASE_LINK_ROLES = ["origin", "work", "reference"];
function caseStatusError(status) {
    if (CASE_STATUSES.includes(status))
        return null;
    return fail(`'${status}' is not a case status. Use one of: ${CASE_STATUSES.join(", ")}. ` +
        "(todo/backlog/blocked are issue statuses, not case statuses.)");
}
function summarizeCaseList(rows) {
    return rows.map((c) => ({
        id: c.id ?? null,
        identifier: c.identifier ?? null,
        caseType: c.caseType ?? null,
        key: c.key ?? null,
        title: c.title ?? null,
        status: c.status ?? null,
        parentCaseId: c.parentCaseId ?? null,
        updatedAt: c.updatedAt ?? null,
    }));
}
/** Case detail embeds every document's full body; keep only what's needed to pick one to read. */
function summarizeCaseDetail(detail) {
    const documents = Array.isArray(detail.documents) ? detail.documents : [];
    return {
        ...detail,
        documents: documents.map((d) => {
            const doc = (d.document ?? {});
            return {
                key: d.key ?? null,
                title: doc.title ?? null,
                latestRevisionNumber: doc.latestRevisionNumber ?? null,
                updatedAt: doc.updatedAt ?? null,
            };
        }),
    };
}
/** parent_case_id may be an identifier (PAP-C42); the API wants the UUID. */
async function resolveCaseUuid(ctx, idOrIdentifier) {
    if (isUuid(idOrIdentifier))
        return idOrIdentifier;
    const found = await ctx.api.getCase(idOrIdentifier);
    if (typeof found.id !== "string")
        throw new Error(`Case '${idOrIdentifier}' not found.`);
    return found.id;
}
/** title/summary/status/parent/project, shared by save and update. */
async function buildCaseBody(ctx, args) {
    const body = {};
    const title = optionalTrimmed(args.title);
    if (title)
        body.title = title;
    if (typeof args.summary === "string")
        body.summary = args.summary;
    const status = asString(args.status);
    if (status)
        body.status = status;
    const parent = asString(args.parent_case_id).trim();
    if (parent)
        body.parentCaseId = await resolveCaseUuid(ctx, parent);
    const project = asString(args.project).trim();
    if (project)
        body.projectId = await resolveNamedId(ctx, "project", project);
    return body;
}
function asFields(v) {
    return v && typeof v === "object" && !Array.isArray(v) ? v : null;
}
function caseTool(ctx) {
    return {
        schema: {
            type: "function",
            function: {
                name: "case",
                description: "Paperclip Cases: durable records of what an agent is producing (a blog post, research packet, " +
                    "release notes, incident, asset set), shown in the Cases tab. Issues coordinate the work; a case " +
                    "holds the output. Actions: 'list' / 'get' to find cases; 'save' creates a case, or updates the " +
                    "one with the same case_type + key — always pass a stable key (e.g. a slug) so a retry updates " +
                    "instead of duplicating; 'update' changes an existing case by case_id; 'write_document' / " +
                    "'append_document' / 'read_document' manage its markdown documents (key 'body' for the main " +
                    "draft); 'link_issue' links an issue (the current issue is linked automatically on any write). " +
                    `Statuses: ${CASE_STATUSES.join(", ")}.`,
                parameters: {
                    type: "object",
                    properties: {
                        action: {
                            type: "string",
                            enum: ["list", "get", "save", "update", "read_document", "write_document", "append_document", "link_issue"],
                        },
                        case_id: { type: "string", description: "Case id or identifier, e.g. 'PAP-C42'. Required except for list/save." },
                        case_type: {
                            type: "string",
                            description: "save (required) / list filter: the kind of case, e.g. 'blog_post', 'incident'.",
                        },
                        key: {
                            type: "string",
                            description: "save: stable unique key within case_type, e.g. 'launch-announcement'. Documents: the " +
                                "document key, default 'body'.",
                        },
                        title: { type: "string", description: "save (required) / update: case title. Documents: document title." },
                        summary: { type: "string", description: "save/update: one-paragraph summary." },
                        status: { type: "string", enum: CASE_STATUSES, description: "save/update; list also accepts 'active'." },
                        fields: {
                            type: "object",
                            description: "save/update: small structured data owned by your skill, e.g. {\"slug\": \"...\", " +
                                "\"publish_url\": null}. On update, these are merged into the existing fields.",
                        },
                        replace_fields: {
                            type: "boolean",
                            description: "update only: replace all fields instead of merging. Default false.",
                        },
                        parent_case_id: { type: "string", description: "save/update: parent case id or identifier, for child cases." },
                        project: { type: "string", description: "save/update: project name or id." },
                        body: {
                            type: "string",
                            description: "write_document: the full markdown (replaces the document). append_document: only the new text to add.",
                        },
                        change_summary: { type: "string", description: "Documents: one-line note on what changed." },
                        issue_id: { type: "string", description: "link_issue: issue id or identifier. Omit for the current issue." },
                        role: { type: "string", enum: CASE_LINK_ROLES, description: "link_issue: default 'reference'." },
                        query: { type: "string", description: "list: search identifier, title, summary, or key." },
                        limit: { type: "number", description: "list: max results, default 50." },
                    },
                    required: ["action"],
                },
            },
        },
        execute: async (args) => {
            const action = asString(args.action);
            const caseId = asString(args.case_id).trim();
            const needsCase = action !== "list" && action !== "save";
            if (needsCase && !caseId) {
                return fail(`case_id is required for action='${action}'. Use action='list' to find it, or 'save' to create a case.`);
            }
            const status = asString(args.status);
            if (status && !(action === "list" && status === "active")) {
                const err = caseStatusError(status);
                if (err)
                    return err;
            }
            const docKey = slugifyDocumentKey(asString(args.key, "body"));
            switch (action) {
                case "list": {
                    const query = {
                        limit: String(typeof args.limit === "number" && args.limit > 0 ? Math.min(args.limit, 200) : 50),
                    };
                    if (asString(args.case_type))
                        query.type = asString(args.case_type);
                    if (status)
                        query.status = status;
                    if (asString(args.query).trim())
                        query.q = asString(args.query).trim();
                    return safeCall("case(list)", async () => {
                        const rows = await ctx.api.listCases(ctx.companyId, query);
                        return Array.isArray(rows) ? summarizeCaseList(rows) : rows;
                    });
                }
                case "get":
                    return safeCall("case(get)", async () => summarizeCaseDetail(await ctx.api.getCase(caseId)));
                case "save": {
                    const caseType = asString(args.case_type).trim();
                    if (!caseType)
                        return fail("case_type is required for action='save', e.g. 'blog_post'.");
                    if (!optionalTrimmed(args.title))
                        return fail("title is required for action='save'.");
                    return safeCall("case(save)", async () => {
                        const body = await buildCaseBody(ctx, args);
                        body.caseType = caseType;
                        const key = asString(args.key).trim();
                        if (key)
                            body.key = key;
                        const fields = asFields(args.fields);
                        if (fields)
                            body.fields = fields;
                        return summarizeCaseDetail(await ctx.api.upsertCase(ctx.companyId, body));
                    });
                }
                case "update":
                    return safeCall("case(update)", async () => {
                        const patch = await buildCaseBody(ctx, args);
                        const fields = asFields(args.fields);
                        if (fields) {
                            // Paperclip replaces `fields` wholesale; models send only the
                            // keys they're changing, which would wipe the rest.
                            if (args.replace_fields === true) {
                                patch.fields = fields;
                            }
                            else {
                                const current = await ctx.api.getCase(caseId);
                                patch.fields = { ...(asFields(current.fields) ?? {}), ...fields };
                            }
                        }
                        if (Object.keys(patch).length === 0) {
                            throw new Error("Nothing to update. Pass title, summary, status, fields, parent_case_id, or project. " +
                                "To change a document, use action='write_document' or 'append_document'.");
                        }
                        return summarizeCaseDetail(await ctx.api.patchCase(caseId, patch));
                    });
                case "read_document":
                    return safeCall("case(read_document)", () => ctx.api.getCaseDocument(caseId, docKey));
                case "write_document":
                    if (typeof args.body !== "string" || !args.body)
                        return fail("body is required for action='write_document'.");
                    return safeCall("case(write_document)", () => writeDocument(caseDocumentStore(ctx, caseId), docKey, args));
                case "append_document":
                    if (typeof args.body !== "string" || !args.body) {
                        return fail("body is required for action='append_document' — the new text to add, not the whole document.");
                    }
                    return safeCall("case(append_document)", () => appendDocument(caseDocumentStore(ctx, caseId), docKey, args, "action='write_document'"));
                case "link_issue": {
                    const role = asString(args.role, "reference");
                    if (!CASE_LINK_ROLES.includes(role))
                        return fail(`role must be one of: ${CASE_LINK_ROLES.join(", ")}.`);
                    const rawIssue = asString(args.issue_id, ctx.currentIssueId ?? "").trim();
                    if (!rawIssue)
                        return fail("issue_id is required — there is no current issue.");
                    return safeCall("case(link_issue)", async () => {
                        const issueId = await resolveIssueUuid(ctx, rawIssue);
                        return ctx.api.linkCaseIssue(caseId, { issueId, role });
                    });
                }
                default:
                    return fail("action must be one of: list, get, save, update, read_document, write_document, append_document, link_issue.");
            }
        },
    };
}
const STATUS_CARD_MAX_PROMPT = 4000;
const REFRESH_MODES = ["manual", "interval", "reactive"];
/** Builds refreshPolicy, filling the field Paperclip requires for the mode rather than rejecting the call. */
function buildRefreshPolicy(args) {
    const mode = asString(args.refresh_mode);
    if (!mode)
        return { defaults: [] };
    if (!REFRESH_MODES.includes(mode))
        return { error: fail(`refresh_mode must be one of: ${REFRESH_MODES.join(", ")}.`) };
    const policy = { mode };
    const defaults = [];
    const positiveInt = (v) => (typeof v === "number" && v > 0 ? Math.round(v) : undefined);
    if (mode === "interval") {
        policy.intervalMinutes = positiveInt(args.interval_minutes);
        if (!policy.intervalMinutes) {
            policy.intervalMinutes = 60;
            defaults.push("interval_minutes=60");
        }
    }
    if (mode === "reactive") {
        policy.debounceSeconds = positiveInt(args.debounce_seconds);
        if (!policy.debounceSeconds) {
            policy.debounceSeconds = 300;
            defaults.push("debounce_seconds=300");
        }
    }
    return { policy, defaults };
}
function summarizeStatusCard(card) {
    const policy = (card.refreshPolicy ?? {});
    return {
        id: card.id ?? null,
        title: card.title ?? null,
        state: card.state ?? null,
        refreshMode: policy.mode ?? null,
        agentId: card.agentId ?? null,
        createdByAgentId: card.createdByAgentId ?? null,
        archived: Boolean(card.archivedAt),
        updatedAt: card.updatedAt ?? null,
    };
}
/** Paperclip only lets an agent manage cards it created; say so instead of leaving a bare 403. */
async function manageStatusCard(label, fn) {
    const result = await safeCall(label, fn);
    if (result.isError && result.content.includes("only manage status cards they authored")) {
        return fail(`${label} failed: you can only change status cards you created. Use action='list' to see who created ` +
            "each card; to get a different card, create your own with action='create'.");
    }
    return result;
}
function statusCardTool(ctx) {
    return {
        schema: {
            type: "function",
            function: {
                name: "status_card",
                description: "Paperclip Status Cards: live summary tiles on the company's status board. You describe what to " +
                    "watch in interest_prompt (e.g. 'Launch blockers in the Website project, newest first'); Paperclip " +
                    "then assigns a hidden task to the card's summarizer agent, which writes and refreshes the summary " +
                    "— you don't write it yourself. Actions: 'list', 'get' (includes the current summary), 'create', " +
                    "'update' (only cards you created; archived=true removes it from the board), 'refresh' (ask the " +
                    "summarizer to update it now).",
                parameters: {
                    type: "object",
                    properties: {
                        action: { type: "string", enum: ["list", "get", "create", "update", "refresh"] },
                        card_id: { type: "string", description: "Required for get/update/refresh." },
                        interest_prompt: {
                            type: "string",
                            description: `create (required) / update: what the card watches and how to write it, max ${STATUS_CARD_MAX_PROMPT} characters.`,
                        },
                        title: { type: "string", description: "create/update: fixed title. Omit to let the summarizer name it." },
                        agent_id: {
                            type: "string",
                            description: "create/update: agent that writes the summary. Omit for the built-in Summarizer.",
                        },
                        refresh_mode: {
                            type: "string",
                            enum: REFRESH_MODES,
                            description: "create/update: 'manual' (default), 'interval', or 'reactive' (when watched issues change).",
                        },
                        interval_minutes: { type: "number", description: "refresh_mode='interval': minutes between updates. Default 60." },
                        debounce_seconds: {
                            type: "number",
                            description: "refresh_mode='reactive': wait this long after a change before updating. Default 300.",
                        },
                        archived: { type: "boolean", description: "update: true archives the card, false restores it." },
                        full: { type: "boolean", description: "refresh: rebuild from scratch instead of patching. Default false." },
                        include_archived: { type: "boolean", description: "list: list archived cards instead. Default false." },
                    },
                    required: ["action"],
                },
            },
        },
        execute: async (args) => {
            const action = asString(args.action);
            const cardId = asString(args.card_id).trim();
            if ((action === "get" || action === "update" || action === "refresh") && !cardId) {
                return fail(`card_id is required for action='${action}'. Use action='list' to find it.`);
            }
            const prompt = typeof args.interest_prompt === "string" ? args.interest_prompt.trim() : "";
            if (prompt.length > STATUS_CARD_MAX_PROMPT) {
                return fail(`interest_prompt is ${prompt.length} characters; the limit is ${STATUS_CARD_MAX_PROMPT}. Shorten it.`);
            }
            switch (action) {
                case "list":
                    return safeCall("status_card(list)", async () => {
                        const rows = await ctx.api.listStatusCards(ctx.companyId, args.include_archived === true);
                        return Array.isArray(rows) ? rows.map(summarizeStatusCard) : rows;
                    });
                case "get":
                    return safeCall("status_card(get)", async () => {
                        // fingerprint is Paperclip's per-issue change-tracking snapshot — large and not useful to the model.
                        const { fingerprint: _fingerprint, ...card } = await ctx.api.getStatusCard(cardId);
                        return card;
                    });
                case "create":
                case "update": {
                    const refresh = buildRefreshPolicy(args);
                    if ("error" in refresh)
                        return refresh.error;
                    const body = {};
                    if (prompt)
                        body.interestPrompt = prompt;
                    const title = optionalTrimmed(args.title);
                    if (title)
                        body.title = title;
                    if (typeof args.agent_id === "string")
                        body.agentId = args.agent_id.trim() || null;
                    if (refresh.policy)
                        body.refreshPolicy = refresh.policy;
                    const note = refresh.defaults.length ? { defaultsApplied: refresh.defaults.join(", ") } : {};
                    if (action === "create") {
                        if (!prompt)
                            return fail("interest_prompt is required for action='create' — describe what the card should watch.");
                        return safeCall("status_card(create)", async () => ({
                            ...summarizeStatusCard(await ctx.api.createStatusCard(ctx.companyId, body)),
                            ...note,
                        }));
                    }
                    if (typeof args.archived === "boolean")
                        body.archived = args.archived;
                    if (Object.keys(body).length === 0) {
                        return fail("Nothing to update. Pass interest_prompt, title, agent_id, refresh_mode, or archived. " +
                            "To regenerate the summary, use action='refresh'.");
                    }
                    return manageStatusCard("status_card(update)", async () => ({
                        ...summarizeStatusCard(await ctx.api.patchStatusCard(cardId, body)),
                        ...note,
                    }));
                }
                case "refresh":
                    return manageStatusCard("status_card(refresh)", () => ctx.api.refreshStatusCard(cardId, args.full === true));
                default:
                    return fail("action must be one of: list, get, create, update, refresh.");
            }
        },
    };
}
/** Maps a model-written query to Paperclip's company-search query shape. */
async function normalizeStatusCardQuery(ctx, raw) {
    const query = {};
    const str = (...keys) => {
        for (const k of keys)
            if (typeof raw[k] === "string" && raw[k].trim())
                return raw[k].trim();
        return "";
    };
    const list = (...keys) => {
        for (const k of keys) {
            const v = raw[k];
            if (Array.isArray(v))
                return v.filter((x) => typeof x === "string");
            if (typeof v === "string" && v.trim())
                return v.split(",").map((s) => s.trim()).filter(Boolean);
        }
        return [];
    };
    if (str("q", "query", "text"))
        query.q = str("q", "query", "text");
    if (str("scope"))
        query.scope = str("scope");
    if (typeof raw.limit === "number" && raw.limit > 0)
        query.limit = Math.min(Math.round(raw.limit), 50);
    const status = list("status", "statuses");
    if (status.length)
        query.status = status;
    const priority = list("priority", "priorities");
    if (priority.length)
        query.priority = priority;
    if (str("assignee_agent_id", "assigneeAgentId"))
        query.assigneeAgentId = str("assignee_agent_id", "assigneeAgentId");
    const project = str("project", "project_id", "projectId");
    if (project)
        query.projectId = await resolveNamedId(ctx, "project", project);
    const label = str("label", "label_id", "labelId");
    if (label)
        query.labelId = await resolveNamedId(ctx, "label", label);
    if (str("updated_within", "updatedWithin"))
        query.updatedWithin = str("updated_within", "updatedWithin");
    if (str("sort"))
        query.sort = str("sort");
    return query;
}
function publishStatusCardTool(ctx, task) {
    const label = (action) => `publish_status_card(${action})`;
    return {
        schema: {
            type: "function",
            function: {
                name: "publish_status_card",
                description: "Your current issue is a status-card task: you are this card's summarizer. The card and task ids are " +
                    "filled in for you. " +
                    (task.operation === "compile"
                        ? "Steps: 1) 'save_query' — turn the interest prompt into search queries plus a short card title; " +
                            "2) 'preview' — see which issues those queries match; 3) 'save_summary' — write the markdown " +
                            "summary of those issues the way the interest prompt asks; 4) update_issue_status status='done'."
                        : "Queries are already compiled. Steps: 1) optionally 'preview' to see the issues the card watches; " +
                            "2) 'save_summary' — write the updated markdown summary from the previous summary and the changed " +
                            "issues in your task description; 3) update_issue_status status='done'.") +
                    " Mentioning an issue by identifier (e.g. ABC-123) in the summary adds it to the card's watched set.",
                parameters: {
                    type: "object",
                    properties: {
                        action: { type: "string", enum: ["save_query", "preview", "save_summary"] },
                        queries: {
                            type: "array",
                            description: "save_query: one or more searches; the card watches the union. Keep each narrow.",
                            items: {
                                type: "object",
                                properties: {
                                    q: { type: "string", description: "Search text. Omit to match everything in the filters." },
                                    scope: { type: "string", enum: ["issues", "all", "comments", "documents", "artifacts", "agents", "projects"] },
                                    status: {
                                        type: "array",
                                        items: { type: "string", enum: ["backlog", "todo", "in_progress", "in_review", "blocked", "done", "cancelled"] },
                                    },
                                    priority: { type: "array", items: { type: "string", enum: ["critical", "high", "medium", "low"] } },
                                    project: { type: "string", description: "Project name or id." },
                                    label: { type: "string", description: "Label name or id." },
                                    assignee_agent_id: { type: "string" },
                                    updated_within: { type: "string", description: "e.g. '24h', '7d', '4w'." },
                                    sort: { type: "string", enum: ["relevance", "updated", "created", "priority"] },
                                    limit: { type: "number", description: "Max matches, 1-50. Default 20." },
                                },
                            },
                        },
                        title: { type: "string", description: "save_query (required): short card title. save_summary: optional new title." },
                        markdown: { type: "string", description: "save_summary (required): the full summary in markdown." },
                        change_summary: { type: "string", description: "One line on what changed." },
                    },
                    required: ["action"],
                },
            },
        },
        execute: async (args) => {
            const action = asString(args.action);
            switch (action) {
                case "save_query": {
                    if (task.operation !== "compile") {
                        return fail("This is an update task — the card's queries are already compiled. Call action='save_summary'.");
                    }
                    const queries = Array.isArray(args.queries) ? args.queries.filter((q) => asFields(q)) : [];
                    if (queries.length === 0) {
                        return fail("queries is required: an array of searches, e.g. [{\"q\": \"launch\", \"status\": [\"in_progress\", \"blocked\"]}].");
                    }
                    const title = optionalTrimmed(args.title);
                    if (!title)
                        return fail("title is required for action='save_query' — a short name for the card.");
                    return safeCall(label(action), async () => {
                        const normalized = await Promise.all(queries.map((q) => normalizeStatusCardQuery(ctx, q)));
                        const card = await ctx.api.writeStatusCardQuery(task.statusCardId, {
                            queries: normalized,
                            title,
                            changeSummary: optionalTrimmed(args.change_summary) ?? "Compiled the interest prompt into queries.",
                            generationIssueId: task.generationIssueId,
                        });
                        return { saved: true, queryVersion: card.queryVersion ?? null, next: "Call action='preview' to see the matching issues." };
                    });
                }
                case "preview":
                    return safeCall(label(action), () => ctx.api.dryRunStatusCard(task.statusCardId));
                case "save_summary": {
                    const markdown = typeof args.markdown === "string" ? args.markdown.trim() : "";
                    if (!markdown)
                        return fail("markdown is required for action='save_summary' — the full summary text.");
                    const result = await safeCall(label(action), async () => {
                        const body = {
                            markdown,
                            changeSummary: optionalTrimmed(args.change_summary) ?? "Updated the summary.",
                            generationIssueId: task.generationIssueId,
                        };
                        const title = optionalTrimmed(args.title);
                        if (title)
                            body.title = title;
                        if (ctx.model)
                            body.model = ctx.model;
                        await ctx.api.writeStatusCardSummary(task.statusCardId, body);
                        task.summaryWritten = true;
                        return { saved: true, next: "Now call update_issue_status status='done' to finish this task." };
                    });
                    if (result.isError && result.content.includes("Compile the status-card query")) {
                        return fail("The card has no queries yet. Call action='save_query' first, then save_summary.");
                    }
                    return result;
                }
                default:
                    return fail("action must be one of: save_query, preview, save_summary.");
            }
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
        getAgentTool(ctx),
        updateAgentTool(ctx),
        agentInstructionsTool(ctx),
        requestApprovalTool(ctx),
        askUserQuestionsTool(ctx),
        listInteractionsTool(ctx),
        issueDocumentTool(ctx),
        libraryTool(ctx),
        findDocumentsTool(ctx),
        ...(hasSecrets ? [listSecretsTool(ctx)] : []),
        ...(httpEnabled ? [httpRequestTool(ctx)] : []),
        ...(ctx.features?.cases ? [caseTool(ctx)] : []),
        ...(ctx.features?.statusCards ? [statusCardTool(ctx)] : []),
        ...(ctx.statusCardTask ? [publishStatusCardTool(ctx, ctx.statusCardTask)] : []),
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
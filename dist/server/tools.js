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
import { resolveMemoryRoot, readMemoryFile, writeMemoryFile, listMemoryFiles, searchMemoryFiles, } from "./memory-fs.js";
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
function updateIssueStatusTool(ctx) {
    return {
        schema: {
            type: "function",
            function: {
                name: "update_issue_status",
                description: "Move an issue to a new status. Valid statuses: open, in_progress, blocked, done, cancelled. " +
                    "Defaults to the current issue.",
                parameters: {
                    type: "object",
                    properties: {
                        issue_id: { type: "string", description: "Issue id. Omit to use the current issue." },
                        status: {
                            type: "string",
                            enum: ["open", "in_progress", "blocked", "done", "cancelled"],
                        },
                        reason: { type: "string", description: "Optional explanation." },
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
            return safeCall("update_issue_status", () => ctx.api.updateIssue(id, { status, statusReason: args.reason ?? null }));
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
                        priority: { type: "string", enum: ["low", "normal", "high", "urgent"] },
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
function memoryFsTool(ctx) {
    return {
        schema: {
            type: "function",
            function: {
                name: "memory_fs",
                description: "Read, write, list, or search small text/markdown files for durable memory across runs " +
                    "(e.g. the para-memory-files skill's PARA notes). Two isolated scopes: 'private' is a " +
                    "directory only you can see (this is what that skill calls $AGENT_HOME); 'shared' is one " +
                    "directory every agent in this company can read and write — use it for anything meant to be " +
                    "seen by other agents, such as the skill's plans/ files. There is no shell access and no `qmd` " +
                    "command here — use action='search' instead, which does a plain keyword search across the " +
                    "scope's files (not semantic search, but finds the same notes). Paths are always relative to " +
                    "the chosen scope's root and cannot escape it.",
                parameters: {
                    type: "object",
                    properties: {
                        action: { type: "string", enum: ["read", "write", "list", "search"] },
                        scope: { type: "string", enum: ["private", "shared"], description: "Default: private." },
                        path: {
                            type: "string",
                            description: "Relative path within the scope. Required for read/write. Optional for list (default: root).",
                        },
                        content: { type: "string", description: "File content. Required for action='write'." },
                        query: { type: "string", description: "Keyword to search for. Required for action='search'." },
                    },
                    required: ["action"],
                },
            },
        },
        execute: async (args) => {
            const action = asString(args.action);
            const scope = args.scope === "shared" ? "shared" : "private";
            const root = resolveMemoryRoot(ctx.config ?? {}, scope, { agentId: ctx.agentId, companyId: ctx.companyId });
            try {
                switch (action) {
                    case "read": {
                        const p = asString(args.path);
                        if (!p)
                            return fail("path is required for action='read'.");
                        return ok({ path: p, scope, content: await readMemoryFile(root, p) });
                    }
                    case "write": {
                        const p = asString(args.path);
                        if (!p)
                            return fail("path is required for action='write'.");
                        if (typeof args.content !== "string")
                            return fail("content is required for action='write'.");
                        await writeMemoryFile(root, p, args.content);
                        return ok({ path: p, scope, written: true });
                    }
                    case "list": {
                        const entries = await listMemoryFiles(root, asString(args.path, "."));
                        return ok({ scope, entries });
                    }
                    case "search": {
                        const query = asString(args.query);
                        if (!query)
                            return fail("query is required for action='search'.");
                        const matches = await searchMemoryFiles(root, query);
                        return ok({ scope, query, matches });
                    }
                    default:
                        return fail("action must be one of: read, write, list, search.");
                }
            }
            catch (err) {
                return fail(err instanceof Error ? err.message : String(err));
            }
        },
    };
}
// ----- public API -----
export function buildTools(ctx) {
    return [
        getIssueTool(ctx),
        updateIssueStatusTool(ctx),
        addCommentTool(ctx),
        listCommentsTool(ctx),
        createSubIssueTool(ctx),
        listIssuesTool(ctx),
        listAgentsTool(ctx),
        hireAgentTool(ctx),
        requestApprovalTool(ctx),
        askUserQuestionsTool(ctx),
        memoryFsTool(ctx),
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
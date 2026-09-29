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

import { PaperclipApi, PaperclipApiError } from "./paperclip-api.js";

export interface ToolSchema {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

export interface ToolExecutionResult {
  content: string;
  isError: boolean;
}

export interface Tool {
  schema: ToolSchema;
  execute: (args: Record<string, unknown>) => Promise<ToolExecutionResult>;
}

export interface BuildToolsContext {
  api: PaperclipApi;
  agentId: string;
  companyId: string;
  /** The issue this run is working on, if any. Tools default to this when no id is supplied. */
  currentIssueId: string | null;
  /** When false, hire_agent and similar mutating actions go through request_approval first. */
  autoApprove: boolean;
  /**
   * Mutable out-param: ask_user_questions sets .value = true after it
   * successfully creates an interaction, so execute() knows the issue is
   * now waiting on a human reply and must not mark it "done".
   */
  interactionCreated?: { value: boolean };
}

// ----- helpers -----

function ok(content: string | Record<string, unknown>): ToolExecutionResult {
  return {
    content: typeof content === "string" ? content : JSON.stringify(content),
    isError: false,
  };
}

function fail(message: string, detail?: unknown): ToolExecutionResult {
  const body: Record<string, unknown> = { error: message };
  if (detail !== undefined) body.detail = detail;
  return { content: JSON.stringify(body), isError: true };
}

async function safeCall<T>(label: string, fn: () => Promise<T>): Promise<ToolExecutionResult> {
  try {
    const result = await fn();
    return ok(result as Record<string, unknown>);
  } catch (err) {
    if (err instanceof PaperclipApiError) {
      return fail(`${label} failed: ${err.message}`, { status: err.status, body: err.body });
    }
    const reason = err instanceof Error ? err.message : String(err);
    return fail(`${label} failed: ${reason}`);
  }
}

function asString(v: unknown, fallback = ""): string {
  return typeof v === "string" && v.length > 0 ? v : fallback;
}

// ----- tool builders -----

function getIssueTool(ctx: BuildToolsContext): Tool {
  return {
    schema: {
      type: "function",
      function: {
        name: "get_issue",
        description:
          "Fetch the full details of an issue (title, description, status, comments, attachments). " +
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
      if (!id) return fail("No issue_id supplied and no current issue.");
      return safeCall("get_issue", () => ctx.api.getIssue(id));
    },
  };
}

function updateIssueStatusTool(ctx: BuildToolsContext): Tool {
  return {
    schema: {
      type: "function",
      function: {
        name: "update_issue_status",
        description:
          "Move an issue to a new status. Valid statuses: open, in_progress, blocked, done, cancelled. " +
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
      if (!id) return fail("No issue_id supplied and no current issue.");
      const status = asString(args.status);
      if (!status) return fail("status is required.");
      return safeCall("update_issue_status", () =>
        ctx.api.updateIssue(id, { status, statusReason: args.reason ?? null }),
      );
    },
  };
}

function addCommentTool(ctx: BuildToolsContext): Tool {
  return {
    schema: {
      type: "function",
      function: {
        name: "add_comment",
        description:
          "Post a comment on an issue. Use this to share progress, results, or questions with " +
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
      if (!id) return fail("No issue_id supplied and no current issue.");
      const body = asString(args.body);
      if (!body) return fail("body is required.");
      return safeCall("add_comment", () => ctx.api.addIssueComment(id, { body }));
    },
  };
}

function listCommentsTool(ctx: BuildToolsContext): Tool {
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
      if (!id) return fail("No issue_id supplied and no current issue.");
      return safeCall("list_comments", () => ctx.api.listIssueComments(id));
    },
  };
}

function createSubIssueTool(ctx: BuildToolsContext): Tool {
  return {
    schema: {
      type: "function",
      function: {
        name: "create_sub_issue",
        description:
          "Create a child issue under a parent (defaults to the current issue). Use this to break work " +
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
      if (!title) return fail("title is required.");
      const payload: Record<string, unknown> = {
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

function listIssuesTool(ctx: BuildToolsContext): Tool {
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
      const query: Record<string, string> = {};
      if (typeof args.status === "string") query.status = args.status;
      if (typeof args.assignee_agent_id === "string") query.assigneeAgentId = args.assignee_agent_id;
      query.limit = String(typeof args.limit === "number" ? args.limit : 20);
      return safeCall("list_issues", () => ctx.api.listCompanyIssues(ctx.companyId, query));
    },
  };
}

function hireAgentTool(ctx: BuildToolsContext): Tool {
  return {
    schema: {
      type: "function",
      function: {
        name: "hire_agent",
        description:
          "Hire a new agent into the company. By default this creates an approval request that a human " +
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
      const payload: Record<string, unknown> = {
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
      return safeCall("hire_agent (approval)", () =>
        ctx.api.createApproval(ctx.companyId, {
          type: "hire_agent",
          requestedByAgentId: ctx.agentId,
          payload: { ...payload, summary: `Hire ${args.name} as ${args.role}` },
        }),
      );
    },
  };
}

function listAgentsTool(ctx: BuildToolsContext): Tool {
  return {
    schema: {
      type: "function",
      function: {
        name: "list_agents",
        description:
          "List all agents (teammates) in the current company. Returns each agent's id, name, " +
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
          model: (a.adapterConfig as Record<string, unknown> | undefined)?.model ?? null,
          status: a.status,
          reportsToAgentId: a.reportsToAgentId ?? null,
        }));
      });
    },
  };
}

function requestApprovalTool(ctx: BuildToolsContext): Tool {
  return {
    schema: {
      type: "function",
      function: {
        name: "request_approval",
        description:
          "Open an approval request for an action that requires human sign-off. " +
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
      if (!type) return fail("type is required and must be hire_agent / approve_ceo_strategy / budget_override_required.");
      if (!summary) return fail("summary is required.");
      const payload = (args.payload && typeof args.payload === "object" ? args.payload : {}) as Record<string, unknown>;
      return safeCall("request_approval", () =>
        ctx.api.createApproval(ctx.companyId, {
          type,
          requestedByAgentId: ctx.agentId,
          payload: { ...payload, summary },
        }),
      );
    },
  };
}

type AskUserQuestionsOptionInput =
  | string
  | {
      label?: unknown;
      description?: unknown;
    };

interface AskUserQuestionsQuestionInput {
  prompt?: unknown;
  required?: unknown;
  multi_select?: unknown;
  options?: unknown;
}

function askUserQuestionsTool(ctx: BuildToolsContext): Tool {
  return {
    schema: {
      type: "function",
      function: {
        name: "ask_user_questions",
        description:
          "Ask a human a structured question and pause this issue for their reply — use this instead of " +
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
                    description:
                      "Answer choices — set this whenever there's a nameable short list of likely answers " +
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
      if (!id) return fail("No current issue to attach the question to.");

      const rawQuestions = Array.isArray(args.questions) ? args.questions : [];
      if (rawQuestions.length === 0) return fail("At least one question is required.");

      const questions = rawQuestions.map((raw, qi) => {
        const q = (raw && typeof raw === "object" ? raw : {}) as AskUserQuestionsQuestionInput;
        const rawOptions = Array.isArray(q.options) ? q.options : [];
        const options =
          rawOptions.length > 0
            ? rawOptions.map((raw2: AskUserQuestionsOptionInput, oi) => {
                if (typeof raw2 === "string") {
                  return { id: `q${qi + 1}_o${oi + 1}`, label: raw2 || `Option ${oi + 1}` };
                }
                const o = raw2 && typeof raw2 === "object" ? raw2 : {};
                const option: Record<string, unknown> = {
                  id: `q${qi + 1}_o${oi + 1}`,
                  label: asString(o.label, `Option ${oi + 1}`),
                };
                if (typeof o.description === "string" && o.description) option.description = o.description;
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
      if (questions.some((q) => !q.prompt)) return fail("Every question needs a non-empty prompt.");

      const title = typeof args.title === "string" && args.title.trim() ? args.title.trim() : null;

      return safeCall("ask_user_questions", async () => {
        const result = await ctx.api.createIssueInteraction(id, {
          kind: "ask_user_questions",
          continuationPolicy: "wake_assignee",
          title,
          payload: { version: 1, title, questions },
        });
        if (ctx.interactionCreated) ctx.interactionCreated.value = true;
        return result;
      });
    },
  };
}

// ----- public API -----

export function buildTools(ctx: BuildToolsContext): Tool[] {
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
  ];
}

/** Get the schemas to send to the model. */
export function toolSchemas(tools: Tool[]): ToolSchema[] {
  return tools.map((t) => t.schema);
}

/** Look up a tool by name. Returns null if not found. */
export function findTool(tools: Tool[], name: string): Tool | null {
  return tools.find((t) => t.schema.function.name === name) ?? null;
}

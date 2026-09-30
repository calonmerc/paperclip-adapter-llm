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
import {
  resolveMemoryRoot,
  readMemoryFile,
  writeMemoryFile,
  listMemoryFiles,
  searchMemoryFiles,
  type MemoryScope,
} from "./memory-fs.js";
import {
  MAX_RESPONSE_CHARS,
  REQUEST_TIMEOUT_MS,
  SecretReferenceError,
  SecretStore,
  fetchGoogleAccessToken,
  hostAllowed,
  parseAllowedHosts,
  redactSecrets,
  referencedSecretNames,
  resolveSecrets,
  substituteSecrets,
  substituteSecretsDeep,
} from "./http-request.js";

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
  /** Human identifier of the current issue (e.g. "DEBA-39"), which models often pass instead of the id. */
  currentIssueIdentifier?: string | null;
  /** When false, hire_agent and similar mutating actions go through request_approval first. */
  autoApprove: boolean;
  /**
   * Mutable out-param: ask_user_questions sets .value = true after it
   * successfully creates an interaction, so execute() knows the issue is
   * now waiting on a human reply and must not mark it "done".
   */
  interactionCreated?: { value: boolean };
  /** Raw adapterConfig, needed by memory_fs to resolve agentHomeDir. */
  config?: Record<string, unknown>;
  /**
   * Every secret bound to this agent — env-var bindings and API-access
   * bindings. Only ever substituted into http_request calls; values are
   * never returned to the model.
   */
  secretStore?: SecretStore;
  /** Shorthand for a store holding only these env-var secrets (tests, direct calls). */
  secrets?: Record<string, string>;
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

/** True when `issueId` (absent, the current issue's id, or its identifier) targets the current issue. */
export function targetsCurrentIssue(ctx: Pick<BuildToolsContext, "currentIssueId" | "currentIssueIdentifier">, issueId: unknown): boolean {
  if (typeof issueId !== "string" || issueId.length === 0) return true;
  return issueId === ctx.currentIssueId || (!!ctx.currentIssueIdentifier && issueId === ctx.currentIssueIdentifier);
}

// Statuses that leave the current issue without a disposition Paperclip will
// accept at the end of a run: a successful run that leaves its issue
// in_progress triggers Paperclip's missing-disposition recovery, and
// backlog/todo on your own issue just hands it back to the queue unexplained.
const NON_DISPOSITION_STATUSES = new Set(["backlog", "todo", "in_progress"]);

// Appended to 422 errors so the model can fix the call instead of retrying it.
function statusRejectionHint(status: string): string | null {
  if (status === "blocked") {
    return (
      "To block, pass blocked_by_issue_ids (unresolved issues this waits on) and/or unblock_action " +
      "(the concrete next step). If a human must act or answer, call ask_user_questions instead."
    );
  }
  if (status === "in_review") {
    return "To send for review, pass reviewer_user_id (a human reviewer), or call ask_user_questions instead.";
  }
  return null;
}

function updateIssueStatusTool(ctx: BuildToolsContext): Tool {
  return {
    schema: {
      type: "function",
      function: {
        name: "update_issue_status",
        description:
          "Record an issue's disposition. For the issue you're working on, end every run with one of: " +
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
              description:
                "status='blocked' only: the concrete action that unblocks this issue, e.g. 'Retry once the " +
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
      if (!id) return fail("No issue_id supplied and no current issue.");
      const status = asString(args.status);
      if (!status) return fail("status is required.");
      const isCurrent = targetsCurrentIssue(ctx, args.issue_id);
      if (isCurrent && NON_DISPOSITION_STATUSES.has(status)) {
        return fail(
          `'${status}' is not a valid way to end a run on your own issue — Paperclip treats it as a missing ` +
            "disposition. Use done, cancelled, blocked (with blocked_by_issue_ids or unblock_action), " +
            "in_review (with reviewer_user_id), or call ask_user_questions if you need a human's input.",
        );
      }

      const patch: Record<string, unknown> = { status };
      if (typeof args.comment === "string" && args.comment.trim()) patch.comment = args.comment.trim();

      if (status === "blocked") {
        const blockerIds = Array.isArray(args.blocked_by_issue_ids)
          ? args.blocked_by_issue_ids.filter((v): v is string => typeof v === "string" && v.length > 0)
          : [];
        const unblockAction = asString(args.unblock_action).trim();
        if (blockerIds.length === 0 && !unblockAction) {
          return fail(`status='blocked' needs a real blocker path. ${statusRejectionHint("blocked")}`);
        }
        if (blockerIds.length > 0) patch.blockedByIssueIds = blockerIds;
        if (unblockAction) {
          // Paperclip only lets an agent name itself as the unblock owner.
          patch.unblockDescriptor = { owner: { agentId: ctx.agentId }, action: unblockAction.slice(0, 2000) };
        }
      }

      if (status === "in_review") {
        const reviewer = asString(args.reviewer_user_id).trim();
        if (!reviewer && isCurrent) {
          return fail(`status='in_review' needs a reviewer. ${statusRejectionHint("in_review")}`);
        }
        if (reviewer) patch.assigneeUserId = reviewer;
      }

      try {
        return ok(await ctx.api.updateIssue(id, patch));
      } catch (err) {
        if (err instanceof PaperclipApiError) {
          const hint = err.status === 422 ? statusRejectionHint(status) : null;
          return fail(`update_issue_status failed: ${err.message}${hint ? ` — ${hint}` : ""}`, {
            status: err.status,
            body: err.body,
          });
        }
        return fail(`update_issue_status failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    },
  };
}

function updateIssueTool(ctx: BuildToolsContext): Tool {
  return {
    schema: {
      type: "function",
      function: {
        name: "update_issue",
        description:
          "Update an issue's fields other than status (use update_issue_status for status changes). " +
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
              description:
                "Full replacement for the issue's blocker set — not a diff. Pass every issue id that " +
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
      if (!id) return fail("No issue_id supplied and no current issue.");

      const patch: Record<string, unknown> = {};
      if (typeof args.title === "string" && args.title.trim()) patch.title = args.title.trim();
      if (typeof args.description === "string") patch.description = args.description;
      if (typeof args.priority === "string" && args.priority) patch.priority = args.priority;
      if (Array.isArray(args.blocked_by_issue_ids)) {
        patch.blockedByIssueIds = args.blocked_by_issue_ids.filter((v): v is string => typeof v === "string");
      }
      if (typeof args.assignee_agent_id === "string") patch.assigneeAgentId = args.assignee_agent_id || null;
      if (typeof args.assignee_user_id === "string") patch.assigneeUserId = args.assignee_user_id || null;

      if (Object.keys(patch).length === 0) return fail("No fields supplied to update.");

      return safeCall("update_issue", () => ctx.api.updateIssue(id, patch));
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
            priority: { type: "string", enum: ["critical", "high", "medium", "low"] },
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

function listInteractionsTool(ctx: BuildToolsContext): Tool {
  return {
    schema: {
      type: "function",
      function: {
        name: "list_interactions",
        description:
          "List every ask_user_questions / request_confirmation / suggest_tasks card ever created on an " +
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
      if (!id) return fail("No issue_id supplied and no current issue.");
      return safeCall("list_interactions", () => ctx.api.listIssueInteractions(id));
    },
  };
}

function memoryFsTool(ctx: BuildToolsContext): Tool {
  return {
    schema: {
      type: "function",
      function: {
        name: "memory_fs",
        description:
          "Read, write, list, or search small text/markdown files for durable memory across runs " +
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
      const scope: MemoryScope = args.scope === "shared" ? "shared" : "private";
      const root = resolveMemoryRoot(ctx.config ?? {}, scope, { agentId: ctx.agentId, companyId: ctx.companyId });

      try {
        switch (action) {
          case "read": {
            const p = asString(args.path);
            if (!p) return fail("path is required for action='read'.");
            return ok({ path: p, scope, content: await readMemoryFile(root, p) });
          }
          case "write": {
            const p = asString(args.path);
            if (!p) return fail("path is required for action='write'.");
            if (typeof args.content !== "string") return fail("content is required for action='write'.");
            await writeMemoryFile(root, p, args.content);
            return ok({ path: p, scope, written: true });
          }
          case "list": {
            const entries = await listMemoryFiles(root, asString(args.path, "."));
            return ok({ scope, entries });
          }
          case "search": {
            const query = asString(args.query);
            if (!query) return fail("query is required for action='search'.");
            const matches = await searchMemoryFiles(root, query);
            return ok({ scope, query, matches });
          }
          default:
            return fail("action must be one of: read, write, list, search.");
        }
      } catch (err) {
        return fail(err instanceof Error ? err.message : String(err));
      }
    },
  };
}

/** Documents require a lowercase [a-z0-9_-] key — slugify whatever the model gives us. */
function slugifyDocumentKey(raw: string): string {
  const slug = raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
  return slug || "document";
}

function issueDocumentTool(ctx: BuildToolsContext): Tool {
  return {
    schema: {
      type: "function",
      function: {
        name: "issue_document",
        description:
          "Read, write, or list durable markdown documents attached to an issue — visible in the " +
          "Documents panel in the Paperclip web UI, with full revision history. Use this for anything " +
          "you want a human to actually see and review (reports, plans, specs, write-ups) — not " +
          "add_comment (which is a chat-style timeline entry) and not memory_fs (which is private/shared " +
          "notes nobody sees in the UI). Writing to an existing key adds a new revision; it does not " +
          "delete history.",
        parameters: {
          type: "object",
          properties: {
            action: { type: "string", enum: ["read", "write", "list"] },
            issue_id: { type: "string", description: "Issue id. Omit to use the current issue." },
            key: {
              type: "string",
              description:
                "Short id for the document, e.g. 'design-doc' or 'weekly-report'. Lowercase letters, " +
                "numbers, - and _ only — anything else is auto-slugified. Required for read/write.",
            },
            title: { type: "string", description: "Display title. Optional for write." },
            body: { type: "string", description: "Full markdown content. Required for write — replace, don't diff." },
            change_summary: { type: "string", description: "One-line note on what changed this revision. Optional." },
          },
          required: ["action"],
        },
      },
    },
    execute: async (args) => {
      const id = asString(args.issue_id, ctx.currentIssueId ?? "");
      if (!id) return fail("No issue_id supplied and no current issue.");
      const action = asString(args.action);

      switch (action) {
        case "list":
          return safeCall("issue_document(list)", () => ctx.api.listIssueDocuments(id));
        case "read": {
          const rawKey = asString(args.key);
          if (!rawKey) return fail("key is required for action='read'.");
          return safeCall("issue_document(read)", () => ctx.api.getIssueDocument(id, slugifyDocumentKey(rawKey)));
        }
        case "write": {
          const rawKey = asString(args.key);
          if (!rawKey) return fail("key is required for action='write'.");
          if (typeof args.body !== "string" || !args.body) return fail("body is required for action='write'.");
          const key = slugifyDocumentKey(rawKey);
          const title = typeof args.title === "string" && args.title.trim() ? args.title.trim() : null;
          const changeSummary =
            typeof args.change_summary === "string" && args.change_summary.trim() ? args.change_summary.trim() : null;
          const body = args.body as string;

          return safeCall("issue_document(write)", async () => {
            // Paperclip requires baseRevisionId to exactly match the
            // document's current latestRevisionId on every update to an
            // existing key (optimistic concurrency) — omitting it always
            // 409s. Resolve it here instead of pushing revision tracking
            // onto the model: fetch the current doc (undefined if it
            // doesn't exist yet, which is correct for a create).
            const currentDoc = await ctx.api.getIssueDocument(id, key).catch(() => null);
            const baseRevisionId =
              typeof currentDoc?.latestRevisionId === "string" ? currentDoc.latestRevisionId : undefined;
            try {
              return await ctx.api.upsertIssueDocument(id, key, { title, format: "markdown", body, changeSummary, baseRevisionId });
            } catch (err) {
              // One retry: if baseRevisionId went stale because of a
              // concurrent write between our read and this write, re-fetch
              // and try exactly once more before giving up.
              if (err instanceof PaperclipApiError && err.status === 409) {
                const retryDoc = await ctx.api.getIssueDocument(id, key).catch(() => null);
                const retryRevisionId =
                  typeof retryDoc?.latestRevisionId === "string" ? retryDoc.latestRevisionId : undefined;
                return await ctx.api.upsertIssueDocument(id, key, {
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
    },
  };
}

const defaultStores = new WeakMap<BuildToolsContext, SecretStore>();
function secretStoreFor(ctx: BuildToolsContext): SecretStore {
  if (ctx.secretStore) return ctx.secretStore;
  let store = defaultStores.get(ctx);
  if (!store) {
    store = new SecretStore(ctx.secrets ?? {});
    defaultStores.set(ctx, store);
  }
  return store;
}

function listSecretsTool(ctx: BuildToolsContext): Tool {
  return {
    schema: {
      type: "function",
      function: {
        name: "list_secrets",
        description:
          "List the NAMES of the secrets/credentials bound to you (e.g. API keys, service-account keys). " +
          "Values are never shown — reference one in http_request as {{secret:NAME}}, or via its `auth` option.",
        parameters: { type: "object", properties: {} },
      },
    },
    execute: async () => ok({ secrets: secretStoreFor(ctx).names() }),
  };
}

const HTTP_METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD"];

function httpRequestTool(ctx: BuildToolsContext): Tool {
  const store = secretStoreFor(ctx);
  const allowedHosts = parseAllowedHosts(ctx.config?.httpAllowedHosts);
  // Access tokens minted from a secret are as sensitive as the secret itself:
  // cache them for the run and redact them alongside the raw values.
  const tokenCache = new Map<string, string>();
  const sensitive = () => [...store.sensitiveValues(), ...tokenCache.values()];

  return {
    schema: {
      type: "function",
      function: {
        name: "http_request",
        description:
          "Make an HTTP request to an external API. There is no shell or curl — this is the only way to " +
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
      const redact = (text: string) => redactSecrets(text, sensitive());
      const method = asString(args.method, "GET").toUpperCase();
      if (!HTTP_METHODS.includes(method)) return fail(`method must be one of: ${HTTP_METHODS.join(", ")}.`);

      let url: URL;
      const headers: Record<string, string> = {};
      let body: string | undefined;
      let secrets: Record<string, string>;
      try {
        // API-access secrets are fetched from Paperclip on demand, so resolve
        // everything this request references before substituting.
        secrets = await resolveSecrets(referencedSecretNames([args.url, args.headers, args.query, args.body]), store);
      } catch (err) {
        if (err instanceof SecretReferenceError) return fail(err.message);
        return fail(`Could not load secret: ${redact(err instanceof Error ? err.message : String(err))}`);
      }
      try {
        const rawUrl = asString(args.url);
        if (!rawUrl) return fail("url is required.");
        url = new URL(substituteSecrets(rawUrl, secrets));
        if (url.protocol !== "http:" && url.protocol !== "https:") {
          return fail("Only http:// and https:// URLs are allowed.");
        }
        if (!hostAllowed(url, allowedHosts)) {
          return fail(`Host '${url.hostname}' is not in this agent's httpAllowedHosts list.`);
        }
        if (args.query && typeof args.query === "object" && !Array.isArray(args.query)) {
          for (const [k, v] of Object.entries(args.query as Record<string, unknown>)) {
            if (v === undefined || v === null) continue;
            url.searchParams.set(k, substituteSecrets(String(v), secrets));
          }
        }
        if (args.headers && typeof args.headers === "object" && !Array.isArray(args.headers)) {
          for (const [k, v] of Object.entries(args.headers as Record<string, unknown>)) {
            if (v === undefined || v === null) continue;
            headers[k] = substituteSecrets(String(v), secrets);
          }
        }
        if (args.body !== undefined && args.body !== null && method !== "GET" && method !== "HEAD") {
          if (typeof args.body === "string") {
            body = substituteSecrets(args.body, secrets);
          } else {
            body = JSON.stringify(substituteSecretsDeep(args.body, secrets));
            if (!Object.keys(headers).some((h) => h.toLowerCase() === "content-type")) {
              headers["Content-Type"] = "application/json";
            }
          }
        }
      } catch (err) {
        if (err instanceof SecretReferenceError) return fail(err.message);
        return fail(`Invalid request: ${redact(err instanceof Error ? err.message : String(err))}`);
      }

      const auth = args.auth && typeof args.auth === "object" ? (args.auth as Record<string, unknown>) : null;
      if (auth) {
        if (auth.type !== "google_service_account") return fail("auth.type must be 'google_service_account'.");
        const secretName = asString(auth.secret);
        if (!store.has(secretName)) return fail(store.unknownMessage(secretName));
        const scopes = Array.isArray(auth.scopes)
          ? auth.scopes.filter((s): s is string => typeof s === "string" && s.length > 0)
          : [];
        if (scopes.length === 0) return fail("auth.scopes must list at least one OAuth scope.");
        const cacheKey = `${secretName}|${[...scopes].sort().join(" ")}`;
        try {
          let token = tokenCache.get(cacheKey);
          if (!token) {
            token = await fetchGoogleAccessToken(await store.get(secretName), scopes);
            tokenCache.set(cacheKey, token);
          }
          headers.Authorization = `Bearer ${token}`;
        } catch (err) {
          return fail(redact(err instanceof Error ? err.message : String(err)));
        }
      }

      let response: Response;
      try {
        response = await fetch(url, {
          method,
          headers,
          body,
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });
      } catch (err) {
        return fail(`Request failed: ${redact(err instanceof Error ? err.message : String(err))}`);
      }

      let text = method === "HEAD" ? "" : await response.text().catch(() => "");
      const truncated = text.length > MAX_RESPONSE_CHARS;
      if (truncated) text = text.slice(0, MAX_RESPONSE_CHARS);
      const result: Record<string, unknown> = {
        status: response.status,
        ok: response.ok,
        contentType: response.headers.get("content-type"),
        body: redact(text),
      };
      if (truncated) result.truncated = `Response truncated to ${MAX_RESPONSE_CHARS} characters.`;
      return { content: JSON.stringify(result), isError: !response.ok };
    },
  };
}

// ----- public API -----

export function buildTools(ctx: BuildToolsContext): Tool[] {
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
    memoryFsTool(ctx),
    issueDocumentTool(ctx),
    ...(hasSecrets ? [listSecretsTool(ctx)] : []),
    ...(httpEnabled ? [httpRequestTool(ctx)] : []),
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

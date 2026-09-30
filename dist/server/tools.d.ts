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
import { PaperclipApi } from "./paperclip-api.js";
import { SecretStore } from "./http-request.js";
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
    interactionCreated?: {
        value: boolean;
    };
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
/** True when `issueId` (absent, the current issue's id, or its identifier) targets the current issue. */
export declare function targetsCurrentIssue(ctx: Pick<BuildToolsContext, "currentIssueId" | "currentIssueIdentifier">, issueId: unknown): boolean;
export declare function buildTools(ctx: BuildToolsContext): Tool[];
/** Get the schemas to send to the model. */
export declare function toolSchemas(tools: Tool[]): ToolSchema[];
/** Look up a tool by name. Returns null if not found. */
export declare function findTool(tools: Tool[], name: string): Tool | null;
//# sourceMappingURL=tools.d.ts.map
/**
 * Thin HTTP client for the Paperclip API.
 *
 * Used by tool handlers to call Paperclip as the agent (not the server).
 * Auth is per-call: pass the agent's authToken from AdapterExecutionContext.
 *
 * Base URL resolution order:
 *   1. explicit baseUrl arg
 *   2. PAPERCLIP_API_URL env var
 *   3. http://localhost:3100 (default Paperclip dev port)
 */
export interface PaperclipApiOptions {
    baseUrl?: string;
    authToken: string;
    /** Optional fetch impl override for tests. */
    fetchImpl?: typeof fetch;
}
export interface DocumentUpsertBody {
    title?: string | null;
    format: "markdown";
    body: string;
    changeSummary?: string | null;
    baseRevisionId?: string | null;
}
export declare class PaperclipApiError extends Error {
    readonly status: number;
    readonly body: unknown;
    readonly endpoint: string;
    constructor(message: string, status: number, body: unknown, endpoint: string);
}
export declare class PaperclipApi {
    private readonly baseUrl;
    private readonly authToken;
    private readonly fetchImpl;
    constructor(opts: PaperclipApiOptions);
    private request;
    getIssue(issueId: string): Promise<Record<string, unknown>>;
    updateIssue(issueId: string, patch: Record<string, unknown>): Promise<Record<string, unknown>>;
    listCompanyIssues(companyId: string, query?: Record<string, string>): Promise<Record<string, unknown>>;
    createIssue(companyId: string, issue: Record<string, unknown>): Promise<Record<string, unknown>>;
    getHeartbeatContext(issueId: string): Promise<Record<string, unknown>>;
    /** The company-wide Artifacts view (issue documents, work products, attachments), searchable. */
    listCompanyArtifacts(companyId: string, query: Record<string, string>): Promise<Record<string, unknown>>;
    listIssueDocuments(issueId: string): Promise<Record<string, unknown>[]>;
    getIssueDocument(issueId: string, key: string): Promise<Record<string, unknown>>;
    /**
     * Creates the document if `key` doesn't exist yet, otherwise adds a new
     * revision. Paperclip enforces strict optimistic concurrency on updates:
     * `baseRevisionId` must be omitted when creating (an existing value 409s
     * with "Document does not exist yet") and must exactly match the
     * document's current `latestRevisionId` when updating (omitting it 409s
     * with "Document update requires baseRevisionId"; a stale value 409s with
     * "Document was updated by someone else"). Callers must resolve it via
     * getIssueDocument() first — see issueDocumentTool in tools.ts, which does
     * this automatically so the model never has to manage revision ids.
     */
    upsertIssueDocument(issueId: string, key: string, body: DocumentUpsertBody): Promise<Record<string, unknown>>;
    /**
     * Acquire the issue lock for the current run. Required before any
     * write operation (add_comment, update status) on an issue, otherwise
     * Paperclip's sameRunLock check rejects with 409 "Issue run ownership
     * conflict". The run id is read by Paperclip from the JWT claims, so
     * we only need to send agentId + expectedStatuses in the body.
     */
    /**
     * Default checkout statuses: every pre-terminal status an issue can
     * be in when a run picks it up. Excludes "done" and "cancelled" since
     * a finished issue should not be re-checked-out by a new run.
     *
     * Source of truth: ISSUE_STATUSES in @paperclipai/shared/constants.
     * Keep this list in sync if Paperclip ever adds new statuses.
     */
    checkoutIssue(issueId: string, agentId: string, expectedStatuses?: string[]): Promise<Record<string, unknown>>;
    /**
     * Create an issue-thread interaction — a structured question, confirmation,
     * or task suggestion that pauses the issue for a human/board response.
     * Targets Paperclip's `createIssueThreadInteractionSchema` (see
     * packages/shared/src/validators/issue.ts in the Paperclip host repo).
     */
    createIssueInteraction(issueId: string, body: Record<string, unknown>): Promise<Record<string, unknown>>;
    /**
     * List every interaction ever created on an issue (any kind, any status —
     * pending, answered, accepted, rejected, expired), oldest first. This is
     * the only reliable way for the model to recall what it already asked and
     * what was answered across multiple heartbeats: each run reconstructs its
     * context from scratch, and the wake prompt's "this interaction is
     * answered" section only ever covers the single most recent one.
     */
    listIssueInteractions(issueId: string): Promise<Record<string, unknown>[]>;
    listIssueComments(issueId: string): Promise<Record<string, unknown>>;
    addIssueComment(issueId: string, body: {
        body: string;
        [k: string]: unknown;
    }): Promise<Record<string, unknown>>;
    /**
     * List all agents in a company. Returns the array directly (no envelope).
     * Used by the list_agents tool so a CEO can discover teammate IDs before
     * delegating work via create_sub_issue or update_issue_status.
     */
    listCompanyAgents(companyId: string): Promise<Record<string, unknown>[]>;
    hireAgent(companyId: string, hire: Record<string, unknown>): Promise<Record<string, unknown>>;
    getAgent(agentId: string): Promise<Record<string, unknown>>;
    updateAgent(agentId: string, patch: Record<string, unknown>): Promise<Record<string, unknown>>;
    pauseAgent(agentId: string): Promise<Record<string, unknown>>;
    resumeAgent(agentId: string): Promise<Record<string, unknown>>;
    /** The agent's managed instruction files (AGENTS.md etc.): entryFile plus file summaries, no content. */
    getAgentInstructionsBundle(agentId: string): Promise<Record<string, unknown>>;
    readAgentInstructionsFile(agentId: string, path: string): Promise<Record<string, unknown>>;
    writeAgentInstructionsFile(agentId: string, path: string, content: string): Promise<Record<string, unknown>>;
    wakeAgent(agentId: string, body: Record<string, unknown>): Promise<Record<string, unknown>>;
    /** Secrets bound to this agent with "API access" — metadata only, never values. */
    listAgentSecretAccess(): Promise<{
        secrets: Array<{
            key: string;
            [k: string]: unknown;
        }>;
    }>;
    /** Resolve one API-access secret's value by its alias. Paperclip registers it for run-log redaction. */
    getAgentSecretValue(key: string): Promise<{
        key: string;
        value: string;
    }>;
    createApproval(companyId: string, approval: Record<string, unknown>): Promise<Record<string, unknown>>;
    listCompanyProjects(companyId: string): Promise<Record<string, unknown>[]>;
    listCompanyLabels(companyId: string): Promise<Record<string, unknown>[]>;
    listCases(companyId: string, query?: Record<string, string>): Promise<Record<string, unknown>[]>;
    /** Creates the case, or updates the existing one with the same (caseType, key). */
    upsertCase(companyId: string, body: Record<string, unknown>): Promise<Record<string, unknown>>;
    /** Accepts the case UUID or its identifier (e.g. PAP-C42). */
    getCase(caseId: string): Promise<Record<string, unknown>>;
    patchCase(caseId: string, patch: Record<string, unknown>): Promise<Record<string, unknown>>;
    getCaseDocument(caseId: string, key: string): Promise<Record<string, unknown>>;
    /** Same baseRevisionId rules as upsertIssueDocument. */
    upsertCaseDocument(caseId: string, key: string, body: DocumentUpsertBody): Promise<Record<string, unknown>>;
    linkCaseIssue(caseId: string, body: {
        issueId: string;
        role: string;
    }): Promise<Record<string, unknown>>;
    listStatusCards(companyId: string, archived?: boolean): Promise<Record<string, unknown>[]>;
    getStatusCard(cardId: string): Promise<Record<string, unknown>>;
    createStatusCard(companyId: string, body: Record<string, unknown>): Promise<Record<string, unknown>>;
    patchStatusCard(cardId: string, patch: Record<string, unknown>): Promise<Record<string, unknown>>;
    refreshStatusCard(cardId: string, full: boolean): Promise<Record<string, unknown>>;
    /** Runs the card's compiled queries and returns what they match. */
    dryRunStatusCard(cardId: string): Promise<Record<string, unknown>>;
    /** Summarizer-only: must come from the run that owns the card's generation issue. */
    writeStatusCardQuery(cardId: string, body: Record<string, unknown>): Promise<Record<string, unknown>>;
    /** Summarizer-only: must come from the run that owns the card's generation issue. */
    writeStatusCardSummary(cardId: string, body: Record<string, unknown>): Promise<Record<string, unknown>>;
}
//# sourceMappingURL=paperclip-api.d.ts.map
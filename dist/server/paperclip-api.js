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
export class PaperclipApiError extends Error {
    status;
    body;
    endpoint;
    constructor(message, status, body, endpoint) {
        super(message);
        this.status = status;
        this.body = body;
        this.endpoint = endpoint;
        this.name = "PaperclipApiError";
    }
}
function resolveBaseUrl(explicit) {
    if (explicit && explicit.trim().length > 0)
        return explicit.replace(/\/+$/, "");
    const fromEnv = process.env.PAPERCLIP_API_URL;
    if (fromEnv && fromEnv.trim().length > 0)
        return fromEnv.replace(/\/+$/, "");
    return "http://localhost:3100";
}
export class PaperclipApi {
    baseUrl;
    authToken;
    fetchImpl;
    constructor(opts) {
        this.baseUrl = resolveBaseUrl(opts.baseUrl);
        this.authToken = opts.authToken;
        this.fetchImpl = opts.fetchImpl ?? fetch;
    }
    async request(method, path, body) {
        const url = `${this.baseUrl}${path.startsWith("/") ? path : `/${path}`}`;
        const headers = {
            Authorization: `Bearer ${this.authToken}`,
            Accept: "application/json",
        };
        if (body !== undefined)
            headers["Content-Type"] = "application/json";
        let response;
        try {
            response = await this.fetchImpl(url, {
                method,
                headers,
                body: body !== undefined ? JSON.stringify(body) : undefined,
            });
        }
        catch (err) {
            const reason = err instanceof Error ? err.message : String(err);
            throw new PaperclipApiError(`Network error calling Paperclip API: ${reason}`, 0, null, `${method} ${path}`);
        }
        const contentType = response.headers.get("content-type") ?? "";
        let parsed = null;
        if (contentType.includes("application/json")) {
            try {
                parsed = await response.json();
            }
            catch {
                parsed = null;
            }
        }
        else {
            try {
                parsed = await response.text();
            }
            catch {
                parsed = null;
            }
        }
        if (!response.ok) {
            const message = (parsed && typeof parsed === "object" && "error" in parsed && typeof parsed.error === "string"
                ? parsed.error
                : null) ?? `Paperclip API ${response.status} ${response.statusText}`;
            throw new PaperclipApiError(message, response.status, parsed, `${method} ${path}`);
        }
        return parsed;
    }
    // ----- Issues -----
    getIssue(issueId) {
        return this.request("GET", `/api/issues/${encodeURIComponent(issueId)}`);
    }
    updateIssue(issueId, patch) {
        return this.request("PATCH", `/api/issues/${encodeURIComponent(issueId)}`, patch);
    }
    listCompanyIssues(companyId, query) {
        const qs = query && Object.keys(query).length > 0 ? `?${new URLSearchParams(query).toString()}` : "";
        return this.request("GET", `/api/companies/${encodeURIComponent(companyId)}/issues${qs}`);
    }
    createIssue(companyId, issue) {
        return this.request("POST", `/api/companies/${encodeURIComponent(companyId)}/issues`, issue);
    }
    getHeartbeatContext(issueId) {
        return this.request("GET", `/api/issues/${encodeURIComponent(issueId)}/heartbeat-context`);
    }
    // ----- Documents (viewable in the issue's Documents panel in the web UI) -----
    listIssueDocuments(issueId) {
        return this.request("GET", `/api/issues/${encodeURIComponent(issueId)}/documents`);
    }
    getIssueDocument(issueId, key) {
        return this.request("GET", `/api/issues/${encodeURIComponent(issueId)}/documents/${encodeURIComponent(key)}`);
    }
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
    upsertIssueDocument(issueId, key, body) {
        return this.request("PUT", `/api/issues/${encodeURIComponent(issueId)}/documents/${encodeURIComponent(key)}`, body);
    }
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
    checkoutIssue(issueId, agentId, expectedStatuses = [
        "backlog",
        "todo",
        "in_progress",
        "in_review",
        "blocked",
    ]) {
        return this.request("POST", `/api/issues/${encodeURIComponent(issueId)}/checkout`, {
            agentId,
            expectedStatuses,
        });
    }
    /**
     * Create an issue-thread interaction — a structured question, confirmation,
     * or task suggestion that pauses the issue for a human/board response.
     * Targets Paperclip's `createIssueThreadInteractionSchema` (see
     * packages/shared/src/validators/issue.ts in the Paperclip host repo).
     */
    createIssueInteraction(issueId, body) {
        return this.request("POST", `/api/issues/${encodeURIComponent(issueId)}/interactions`, body);
    }
    /**
     * List every interaction ever created on an issue (any kind, any status —
     * pending, answered, accepted, rejected, expired), oldest first. This is
     * the only reliable way for the model to recall what it already asked and
     * what was answered across multiple heartbeats: each run reconstructs its
     * context from scratch, and the wake prompt's "this interaction is
     * answered" section only ever covers the single most recent one.
     */
    listIssueInteractions(issueId) {
        return this.request("GET", `/api/issues/${encodeURIComponent(issueId)}/interactions`);
    }
    // ----- Comments -----
    listIssueComments(issueId) {
        return this.request("GET", `/api/issues/${encodeURIComponent(issueId)}/comments`);
    }
    addIssueComment(issueId, body) {
        return this.request("POST", `/api/issues/${encodeURIComponent(issueId)}/comments`, body);
    }
    // ----- Agents -----
    /**
     * List all agents in a company. Returns the array directly (no envelope).
     * Used by the list_agents tool so a CEO can discover teammate IDs before
     * delegating work via create_sub_issue or update_issue_status.
     */
    listCompanyAgents(companyId) {
        return this.request("GET", `/api/companies/${encodeURIComponent(companyId)}/agents`);
    }
    hireAgent(companyId, hire) {
        return this.request("POST", `/api/companies/${encodeURIComponent(companyId)}/agent-hires`, hire);
    }
    wakeAgent(agentId, body) {
        return this.request("POST", `/api/agents/${encodeURIComponent(agentId)}/wakeup`, body);
    }
    // ----- Approvals -----
    createApproval(companyId, approval) {
        return this.request("POST", `/api/companies/${encodeURIComponent(companyId)}/approvals`, approval);
    }
}
//# sourceMappingURL=paperclip-api.js.map
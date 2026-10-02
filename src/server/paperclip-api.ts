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

export class PaperclipApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly body: unknown,
    public readonly endpoint: string,
  ) {
    super(message);
    this.name = "PaperclipApiError";
  }
}

function resolveBaseUrl(explicit?: string): string {
  if (explicit && explicit.trim().length > 0) return explicit.replace(/\/+$/, "");
  const fromEnv = process.env.PAPERCLIP_API_URL;
  if (fromEnv && fromEnv.trim().length > 0) return fromEnv.replace(/\/+$/, "");
  return "http://localhost:3100";
}

export class PaperclipApi {
  private readonly baseUrl: string;
  private readonly authToken: string;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: PaperclipApiOptions) {
    this.baseUrl = resolveBaseUrl(opts.baseUrl);
    this.authToken = opts.authToken;
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  private async request<T = unknown>(
    method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE",
    path: string,
    body?: unknown,
  ): Promise<T> {
    const url = `${this.baseUrl}${path.startsWith("/") ? path : `/${path}`}`;
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.authToken}`,
      Accept: "application/json",
    };
    if (body !== undefined) headers["Content-Type"] = "application/json";

    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        method,
        headers,
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      throw new PaperclipApiError(
        `Network error calling Paperclip API: ${reason}`,
        0,
        null,
        `${method} ${path}`,
      );
    }

    const contentType = response.headers.get("content-type") ?? "";
    let parsed: unknown = null;
    if (contentType.includes("application/json")) {
      try {
        parsed = await response.json();
      } catch {
        parsed = null;
      }
    } else {
      try {
        parsed = await response.text();
      } catch {
        parsed = null;
      }
    }

    if (!response.ok) {
      const message =
        (parsed && typeof parsed === "object" && "error" in parsed && typeof (parsed as any).error === "string"
          ? (parsed as any).error
          : null) ?? `Paperclip API ${response.status} ${response.statusText}`;
      throw new PaperclipApiError(message, response.status, parsed, `${method} ${path}`);
    }

    return parsed as T;
  }

  // ----- Issues -----

  getIssue(issueId: string): Promise<Record<string, unknown>> {
    return this.request("GET", `/api/issues/${encodeURIComponent(issueId)}`);
  }

  updateIssue(issueId: string, patch: Record<string, unknown>): Promise<Record<string, unknown>> {
    return this.request("PATCH", `/api/issues/${encodeURIComponent(issueId)}`, patch);
  }

  listCompanyIssues(companyId: string, query?: Record<string, string>): Promise<Record<string, unknown>> {
    const qs = query && Object.keys(query).length > 0 ? `?${new URLSearchParams(query).toString()}` : "";
    return this.request("GET", `/api/companies/${encodeURIComponent(companyId)}/issues${qs}`);
  }

  createIssue(companyId: string, issue: Record<string, unknown>): Promise<Record<string, unknown>> {
    return this.request("POST", `/api/companies/${encodeURIComponent(companyId)}/issues`, issue);
  }

  getHeartbeatContext(issueId: string): Promise<Record<string, unknown>> {
    return this.request("GET", `/api/issues/${encodeURIComponent(issueId)}/heartbeat-context`);
  }

  /** The company-wide Artifacts view (issue documents, work products, attachments), searchable. */
  listCompanyArtifacts(companyId: string, query: Record<string, string>): Promise<Record<string, unknown>> {
    const qs = new URLSearchParams(query).toString();
    return this.request("GET", `/api/companies/${encodeURIComponent(companyId)}/artifacts${qs ? `?${qs}` : ""}`);
  }

  // ----- Documents (viewable in the issue's Documents panel in the web UI) -----

  listIssueDocuments(issueId: string): Promise<Record<string, unknown>[]> {
    return this.request("GET", `/api/issues/${encodeURIComponent(issueId)}/documents`);
  }

  getIssueDocument(issueId: string, key: string): Promise<Record<string, unknown>> {
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
  upsertIssueDocument(issueId: string, key: string, body: DocumentUpsertBody): Promise<Record<string, unknown>> {
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
  checkoutIssue(
    issueId: string,
    agentId: string,
    expectedStatuses: string[] = [
      "backlog",
      "todo",
      "in_progress",
      "in_review",
      "blocked",
    ],
  ): Promise<Record<string, unknown>> {
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
  createIssueInteraction(issueId: string, body: Record<string, unknown>): Promise<Record<string, unknown>> {
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
  listIssueInteractions(issueId: string): Promise<Record<string, unknown>[]> {
    return this.request("GET", `/api/issues/${encodeURIComponent(issueId)}/interactions`);
  }

  // ----- Comments -----

  listIssueComments(issueId: string): Promise<Record<string, unknown>> {
    return this.request("GET", `/api/issues/${encodeURIComponent(issueId)}/comments`);
  }

  addIssueComment(issueId: string, body: { body: string; [k: string]: unknown }): Promise<Record<string, unknown>> {
    return this.request("POST", `/api/issues/${encodeURIComponent(issueId)}/comments`, body);
  }

  // ----- Agents -----

  /**
   * List all agents in a company. Returns the array directly (no envelope).
   * Used by the list_agents tool so a CEO can discover teammate IDs before
   * delegating work via create_sub_issue or update_issue_status.
   */
  listCompanyAgents(companyId: string): Promise<Record<string, unknown>[]> {
    return this.request("GET", `/api/companies/${encodeURIComponent(companyId)}/agents`);
  }

  hireAgent(companyId: string, hire: Record<string, unknown>): Promise<Record<string, unknown>> {
    return this.request("POST", `/api/companies/${encodeURIComponent(companyId)}/agent-hires`, hire);
  }

  getAgent(agentId: string): Promise<Record<string, unknown>> {
    return this.request("GET", `/api/agents/${encodeURIComponent(agentId)}`);
  }

  updateAgent(agentId: string, patch: Record<string, unknown>): Promise<Record<string, unknown>> {
    return this.request("PATCH", `/api/agents/${encodeURIComponent(agentId)}`, patch);
  }

  pauseAgent(agentId: string): Promise<Record<string, unknown>> {
    return this.request("POST", `/api/agents/${encodeURIComponent(agentId)}/pause`, {});
  }

  resumeAgent(agentId: string): Promise<Record<string, unknown>> {
    return this.request("POST", `/api/agents/${encodeURIComponent(agentId)}/resume`, {});
  }

  /** The agent's managed instruction files (AGENTS.md etc.): entryFile plus file summaries, no content. */
  getAgentInstructionsBundle(agentId: string): Promise<Record<string, unknown>> {
    return this.request("GET", `/api/agents/${encodeURIComponent(agentId)}/instructions-bundle`);
  }

  readAgentInstructionsFile(agentId: string, path: string): Promise<Record<string, unknown>> {
    return this.request(
      "GET",
      `/api/agents/${encodeURIComponent(agentId)}/instructions-bundle/file?path=${encodeURIComponent(path)}`,
    );
  }

  writeAgentInstructionsFile(agentId: string, path: string, content: string): Promise<Record<string, unknown>> {
    return this.request("PUT", `/api/agents/${encodeURIComponent(agentId)}/instructions-bundle/file`, {
      path,
      content,
    });
  }

  wakeAgent(agentId: string, body: Record<string, unknown>): Promise<Record<string, unknown>> {
    return this.request("POST", `/api/agents/${encodeURIComponent(agentId)}/wakeup`, body);
  }

  // ----- Secrets (API-access bindings; requires the run-bound agent JWT) -----

  /** Secrets bound to this agent with "API access" — metadata only, never values. */
  listAgentSecretAccess(): Promise<{ secrets: Array<{ key: string; [k: string]: unknown }> }> {
    return this.request("GET", "/api/agents/me/secrets");
  }

  /** Resolve one API-access secret's value by its alias. Paperclip registers it for run-log redaction. */
  getAgentSecretValue(key: string): Promise<{ key: string; value: string }> {
    return this.request("POST", `/api/agents/me/secrets/${encodeURIComponent(key)}/value`);
  }

  // ----- Approvals -----

  createApproval(companyId: string, approval: Record<string, unknown>): Promise<Record<string, unknown>> {
    return this.request("POST", `/api/companies/${encodeURIComponent(companyId)}/approvals`, approval);
  }

  // ----- Projects and labels (name → id lookups) -----

  listCompanyProjects(companyId: string): Promise<Record<string, unknown>[]> {
    return this.request("GET", `/api/companies/${encodeURIComponent(companyId)}/projects`);
  }

  listCompanyLabels(companyId: string): Promise<Record<string, unknown>[]> {
    return this.request("GET", `/api/companies/${encodeURIComponent(companyId)}/labels`);
  }

  // ----- Cases (experimental.enableCases; 403 "Cases are disabled" when off) -----

  listCases(companyId: string, query: Record<string, string> = {}): Promise<Record<string, unknown>[]> {
    const qs = new URLSearchParams(query).toString();
    return this.request("GET", `/api/companies/${encodeURIComponent(companyId)}/cases${qs ? `?${qs}` : ""}`);
  }

  /** Creates the case, or updates the existing one with the same (caseType, key). */
  upsertCase(companyId: string, body: Record<string, unknown>): Promise<Record<string, unknown>> {
    return this.request("POST", `/api/companies/${encodeURIComponent(companyId)}/cases`, body);
  }

  /** Accepts the case UUID or its identifier (e.g. PAP-C42). */
  getCase(caseId: string): Promise<Record<string, unknown>> {
    return this.request("GET", `/api/cases/${encodeURIComponent(caseId)}`);
  }

  patchCase(caseId: string, patch: Record<string, unknown>): Promise<Record<string, unknown>> {
    return this.request("PATCH", `/api/cases/${encodeURIComponent(caseId)}`, patch);
  }

  getCaseDocument(caseId: string, key: string): Promise<Record<string, unknown>> {
    return this.request("GET", `/api/cases/${encodeURIComponent(caseId)}/documents/${encodeURIComponent(key)}`);
  }

  /** Same baseRevisionId rules as upsertIssueDocument. */
  upsertCaseDocument(caseId: string, key: string, body: DocumentUpsertBody): Promise<Record<string, unknown>> {
    return this.request("PUT", `/api/cases/${encodeURIComponent(caseId)}/documents/${encodeURIComponent(key)}`, body);
  }

  linkCaseIssue(caseId: string, body: { issueId: string; role: string }): Promise<Record<string, unknown>> {
    return this.request("POST", `/api/cases/${encodeURIComponent(caseId)}/links`, body);
  }

  // ----- Status cards (experimental.enableStatusCards; 404 when off) -----

  listStatusCards(companyId: string, archived = false): Promise<Record<string, unknown>[]> {
    return this.request(
      "GET",
      `/api/companies/${encodeURIComponent(companyId)}/status-cards${archived ? "?archived=true" : ""}`,
    );
  }

  getStatusCard(cardId: string): Promise<Record<string, unknown>> {
    return this.request("GET", `/api/status-cards/${encodeURIComponent(cardId)}`);
  }

  createStatusCard(companyId: string, body: Record<string, unknown>): Promise<Record<string, unknown>> {
    return this.request("POST", `/api/companies/${encodeURIComponent(companyId)}/status-cards`, body);
  }

  patchStatusCard(cardId: string, patch: Record<string, unknown>): Promise<Record<string, unknown>> {
    return this.request("PATCH", `/api/status-cards/${encodeURIComponent(cardId)}`, patch);
  }

  refreshStatusCard(cardId: string, full: boolean): Promise<Record<string, unknown>> {
    return this.request("POST", `/api/status-cards/${encodeURIComponent(cardId)}/refresh`, { full });
  }

  /** Runs the card's compiled queries and returns what they match. */
  dryRunStatusCard(cardId: string): Promise<Record<string, unknown>> {
    return this.request("GET", `/api/status-cards/${encodeURIComponent(cardId)}/dry-run`);
  }

  /** Summarizer-only: must come from the run that owns the card's generation issue. */
  writeStatusCardQuery(cardId: string, body: Record<string, unknown>): Promise<Record<string, unknown>> {
    return this.request("PUT", `/api/status-cards/${encodeURIComponent(cardId)}/query`, body);
  }

  /** Summarizer-only: must come from the run that owns the card's generation issue. */
  writeStatusCardSummary(cardId: string, body: Record<string, unknown>): Promise<Record<string, unknown>> {
    return this.request("PUT", `/api/status-cards/${encodeURIComponent(cardId)}/summary`, body);
  }
}

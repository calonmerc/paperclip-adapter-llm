/**
 * Unit tests for src/server/tools.ts — the scoped Paperclip-API tool set
 * that execute()'s tool loop calls into. Previously dead code (only used by
 * the now-deleted execute.ts.backup), so this file had zero coverage before.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { PaperclipApi } from "../src/server/paperclip-api.js";
import { buildTools, findTool, toolSchemas } from "../src/server/tools.js";
import { SecretStore } from "../src/server/http-request.js";

function makeApi(fetchImpl: typeof fetch): PaperclipApi {
  return new PaperclipApi({ authToken: "test-token", baseUrl: "http://localhost:9999", fetchImpl });
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("tools.ts", () => {
  it("toolSchemas() returns one schema per tool, matching buildTools()'s output", () => {
    const api = makeApi(async () => jsonResponse({}));
    const tools = buildTools({ api, agentId: "agent-1", companyId: "company-1", currentIssueId: null, autoApprove: false });

    expect(tools.length).toBe(14);
    const names = toolSchemas(tools).map((s) => s.function.name);
    expect(names).toEqual([
      "get_issue",
      "update_issue_status",
      "update_issue",
      "add_comment",
      "list_comments",
      "create_sub_issue",
      "list_issues",
      "list_agents",
      "hire_agent",
      "request_approval",
      "ask_user_questions",
      "list_interactions",
      "memory_fs",
      "issue_document",
    ]);
  });

  it("findTool() finds a tool by name and returns null for unknown names", () => {
    const api = makeApi(async () => jsonResponse({}));
    const tools = buildTools({ api, agentId: "agent-1", companyId: "company-1", currentIssueId: null, autoApprove: false });

    expect(findTool(tools, "add_comment")).not.toBeNull();
    expect(findTool(tools, "read_file")).toBeNull();
  });

  it("get_issue defaults to currentIssueId when no issue_id is supplied", async () => {
    const calls: string[] = [];
    const api = makeApi(async (input: any) => {
      calls.push(typeof input === "string" ? input : input.url);
      return jsonResponse({ id: "issue-42" });
    });
    const tools = buildTools({ api, agentId: "agent-1", companyId: "company-1", currentIssueId: "issue-42", autoApprove: false });

    const result = await findTool(tools, "get_issue")!.execute({});
    expect(result.isError).toBe(false);
    expect(calls[0]).toContain("/api/issues/issue-42");
  });

  it("get_issue fails gracefully when no issue_id is supplied and there is no current issue", async () => {
    const api = makeApi(async () => jsonResponse({}));
    const tools = buildTools({ api, agentId: "agent-1", companyId: "company-1", currentIssueId: null, autoApprove: false });

    const result = await findTool(tools, "get_issue")!.execute({});
    expect(result.isError).toBe(true);
    expect(result.content).toContain("No issue_id supplied");
  });

  it("safeCall wraps a PaperclipApiError as an isError tool result instead of throwing", async () => {
    const api = makeApi(async () => jsonResponse({ error: "not found" }, 404));
    const tools = buildTools({ api, agentId: "agent-1", companyId: "company-1", currentIssueId: "issue-1", autoApprove: false });

    const result = await findTool(tools, "update_issue_status")!.execute({ status: "done" });
    expect(result.isError).toBe(true);
    expect(JSON.parse(result.content).error).toContain("update_issue_status failed");
  });

  it("update_issue_status offers the real Paperclip status values, including in_review (regression guard)", () => {
    // Past bug: the enum here was ["open", "in_progress", "blocked", "done", "cancelled"] — "open"
    // isn't a real Paperclip status at all, and "in_review" (a status this whole project's disposition
    // work leans on heavily) was missing entirely, silently making it unreachable via this tool.
    const api = makeApi(async () => jsonResponse({}));
    const tools = buildTools({ api, agentId: "agent-1", companyId: "company-1", currentIssueId: "issue-1", autoApprove: false });
    const schema = findTool(tools, "update_issue_status")!.schema;
    const statusEnum = (schema.function.parameters as any).properties.status.enum;
    expect([...statusEnum].sort()).toEqual(["backlog", "blocked", "cancelled", "done", "in_progress", "in_review", "todo"]);
  });

  it("update_issue replaces the blocker set and other fields, defaulting to the current issue", async () => {
    const calls: Array<{ method: string; path: string; body: any }> = [];
    const api = makeApi(async (input: any, init: any) => {
      calls.push({
        method: (init?.method || "GET").toUpperCase(),
        path: new URL(typeof input === "string" ? input : input.url).pathname,
        body: init?.body ? JSON.parse(init.body) : undefined,
      });
      return jsonResponse({ id: "issue-1" });
    });
    const tools = buildTools({ api, agentId: "agent-1", companyId: "company-1", currentIssueId: "issue-1", autoApprove: false });

    const result = await findTool(tools, "update_issue")!.execute({
      blocked_by_issue_ids: ["issue-32"],
      priority: "high",
    });

    expect(result.isError).toBe(false);
    expect(calls[0]).toMatchObject({
      method: "PATCH",
      path: "/api/issues/issue-1",
      body: { blockedByIssueIds: ["issue-32"], priority: "high" },
    });
  });

  it("update_issue can clear all blockers with an empty array and unassign with an empty string", async () => {
    const calls: Array<{ body: any }> = [];
    const api = makeApi(async (_input: any, init: any) => {
      calls.push({ body: init?.body ? JSON.parse(init.body) : undefined });
      return jsonResponse({ id: "issue-1" });
    });
    const tools = buildTools({ api, agentId: "agent-1", companyId: "company-1", currentIssueId: "issue-1", autoApprove: false });

    await findTool(tools, "update_issue")!.execute({ blocked_by_issue_ids: [], assignee_agent_id: "" });

    expect(calls.at(-1)!.body).toMatchObject({ blockedByIssueIds: [], assigneeAgentId: null });
  });

  it("update_issue fails when no fields are supplied", async () => {
    const api = makeApi(async () => jsonResponse({}));
    const tools = buildTools({ api, agentId: "agent-1", companyId: "company-1", currentIssueId: "issue-1", autoApprove: false });

    const result = await findTool(tools, "update_issue")!.execute({});
    expect(result.isError).toBe(true);
    expect(result.content).toContain("No fields supplied");
  });

  it("update_issue fails gracefully with no current issue and no issue_id", async () => {
    const api = makeApi(async () => jsonResponse({}));
    const tools = buildTools({ api, agentId: "agent-1", companyId: "company-1", currentIssueId: null, autoApprove: false });

    const result = await findTool(tools, "update_issue")!.execute({ title: "New title" });
    expect(result.isError).toBe(true);
    expect(result.content).toContain("No issue_id supplied");
  });

  it("hire_agent routes through createApproval when autoApprove is false", async () => {
    const paths: string[] = [];
    const api = makeApi(async (input: any) => {
      paths.push(new URL(typeof input === "string" ? input : input.url).pathname);
      return jsonResponse({ ok: true });
    });
    const tools = buildTools({ api, agentId: "agent-1", companyId: "company-1", currentIssueId: null, autoApprove: false });

    await findTool(tools, "hire_agent")!.execute({ name: "Sam", role: "Engineer", mission: "Ship things" });

    expect(paths).toContain("/api/companies/company-1/approvals");
    expect(paths).not.toContain("/api/companies/company-1/agent-hires");
  });

  it("hire_agent calls hireAgent directly when autoApprove is true", async () => {
    const paths: string[] = [];
    const api = makeApi(async (input: any) => {
      paths.push(new URL(typeof input === "string" ? input : input.url).pathname);
      return jsonResponse({ ok: true });
    });
    const tools = buildTools({ api, agentId: "agent-1", companyId: "company-1", currentIssueId: null, autoApprove: true });

    await findTool(tools, "hire_agent")!.execute({ name: "Sam", role: "Engineer", mission: "Ship things" });

    expect(paths).toContain("/api/companies/company-1/agent-hires");
    expect(paths).not.toContain("/api/companies/company-1/approvals");
  });

  it("add_comment posts to the current issue and requires a body", async () => {
    const calls: Array<{ path: string; body: any }> = [];
    const api = makeApi(async (input: any, init: any) => {
      calls.push({ path: new URL(typeof input === "string" ? input : input.url).pathname, body: init?.body ? JSON.parse(init.body) : undefined });
      return jsonResponse({ ok: true });
    });
    const tools = buildTools({ api, agentId: "agent-1", companyId: "company-1", currentIssueId: "issue-7", autoApprove: false });

    const missingBody = await findTool(tools, "add_comment")!.execute({});
    expect(missingBody.isError).toBe(true);
    expect(missingBody.content).toContain("body is required");

    const ok = await findTool(tools, "add_comment")!.execute({ body: "hello" });
    expect(ok.isError).toBe(false);
    expect(calls.at(-1)).toMatchObject({ path: "/api/issues/issue-7/comments", body: { body: "hello" } });
  });

  it("list_comments defaults to the current issue", async () => {
    const paths: string[] = [];
    const api = makeApi(async (input: any) => {
      paths.push(new URL(typeof input === "string" ? input : input.url).pathname);
      return jsonResponse([]);
    });
    const tools = buildTools({ api, agentId: "agent-1", companyId: "company-1", currentIssueId: "issue-7", autoApprove: false });

    const result = await findTool(tools, "list_comments")!.execute({});
    expect(result.isError).toBe(false);
    expect(paths).toContain("/api/issues/issue-7/comments");
  });

  it("create_sub_issue offers the real Paperclip priority values (regression guard)", () => {
    // Past bug: the enum here was ["low", "normal", "high", "urgent"] — none of those except
    // "high"/"low" are real Paperclip priorities (the real set is critical/high/medium/low).
    const api = makeApi(async () => jsonResponse({}));
    const tools = buildTools({ api, agentId: "agent-1", companyId: "company-1", currentIssueId: "issue-1", autoApprove: false });
    const schema = findTool(tools, "create_sub_issue")!.schema;
    const priorityEnum = (schema.function.parameters as any).properties.priority.enum;
    expect(priorityEnum).toEqual(["critical", "high", "medium", "low"]);
  });

  it("create_sub_issue requires a title and defaults parentId to the current issue", async () => {
    const calls: Array<{ path: string; body: any }> = [];
    const api = makeApi(async (input: any, init: any) => {
      calls.push({ path: new URL(typeof input === "string" ? input : input.url).pathname, body: init?.body ? JSON.parse(init.body) : undefined });
      return jsonResponse({ id: "issue-child" });
    });
    const tools = buildTools({ api, agentId: "agent-1", companyId: "company-1", currentIssueId: "issue-parent", autoApprove: false });

    const missingTitle = await findTool(tools, "create_sub_issue")!.execute({});
    expect(missingTitle.isError).toBe(true);
    expect(missingTitle.content).toContain("title is required");

    const ok = await findTool(tools, "create_sub_issue")!.execute({ title: "Do the thing", assignee_agent_id: "agent-2" });
    expect(ok.isError).toBe(false);
    expect(calls.at(-1)).toMatchObject({
      path: "/api/companies/company-1/issues",
      body: { title: "Do the thing", parentId: "issue-parent", assigneeAgentId: "agent-2" },
    });
  });

  it("list_issues builds a query string with a default limit", async () => {
    const paths: string[] = [];
    const api = makeApi(async (input: any) => {
      paths.push(new URL(typeof input === "string" ? input : input.url).search);
      return jsonResponse([]);
    });
    const tools = buildTools({ api, agentId: "agent-1", companyId: "company-1", currentIssueId: null, autoApprove: false });

    await findTool(tools, "list_issues")!.execute({ status: "open" });
    expect(paths.at(-1)).toContain("status=open");
    expect(paths.at(-1)).toContain("limit=20");
  });

  it("list_agents trims each agent down to a fixed set of fields", async () => {
    const api = makeApi(async () =>
      jsonResponse([
        {
          id: "agent-2",
          name: "Teammate",
          role: "Engineer",
          title: "Senior Engineer",
          adapterType: "llm",
          adapterConfig: { model: "gpt-5", secretToken: "should-not-leak" },
          status: "active",
          reportsToAgentId: "agent-1",
          somethingHuge: "x".repeat(10000),
        },
      ]),
    );
    const tools = buildTools({ api, agentId: "agent-1", companyId: "company-1", currentIssueId: null, autoApprove: false });

    const result = await findTool(tools, "list_agents")!.execute({});
    expect(result.isError).toBe(false);
    const [agent] = JSON.parse(result.content);
    expect(agent).toEqual({
      id: "agent-2",
      name: "Teammate",
      role: "Engineer",
      title: "Senior Engineer",
      adapterType: "llm",
      model: "gpt-5",
      status: "active",
      reportsToAgentId: "agent-1",
    });
    expect(agent.secretToken).toBeUndefined();
    expect(agent.somethingHuge).toBeUndefined();
  });

  it("request_approval requires type and summary, and posts the payload merged with summary", async () => {
    const calls: Array<{ path: string; body: any }> = [];
    const api = makeApi(async (input: any, init: any) => {
      calls.push({ path: new URL(typeof input === "string" ? input : input.url).pathname, body: init?.body ? JSON.parse(init.body) : undefined });
      return jsonResponse({ ok: true });
    });
    const tools = buildTools({ api, agentId: "agent-1", companyId: "company-1", currentIssueId: null, autoApprove: false });

    const missing = await findTool(tools, "request_approval")!.execute({ type: "budget_override_required" });
    expect(missing.isError).toBe(true);
    expect(missing.content).toContain("summary is required");

    const ok = await findTool(tools, "request_approval")!.execute({
      type: "budget_override_required",
      summary: "Need more budget",
      payload: { amount: 500 },
    });
    expect(ok.isError).toBe(false);
    expect(calls.at(-1)).toMatchObject({
      path: "/api/companies/company-1/approvals",
      body: {
        type: "budget_override_required",
        requestedByAgentId: "agent-1",
        payload: { amount: 500, summary: "Need more budget" },
      },
    });
  });

  it("ask_user_questions posts a select question with generated ids and marks interactionCreated", async () => {
    const calls: Array<{ path: string; body: any }> = [];
    const api = makeApi(async (input: any, init: any) => {
      calls.push({ path: new URL(typeof input === "string" ? input : input.url).pathname, body: init?.body ? JSON.parse(init.body) : undefined });
      return jsonResponse({ id: "interaction-1" });
    });
    const interactionCreated = { value: false };
    const tools = buildTools({
      api,
      agentId: "agent-1",
      companyId: "company-1",
      currentIssueId: "issue-7",
      autoApprove: false,
      interactionCreated,
    });

    const result = await findTool(tools, "ask_user_questions")!.execute({
      title: "Deploy target",
      questions: [
        {
          prompt: "Which environment?",
          multi_select: false,
          options: [{ label: "Staging" }, { label: "Production", description: "Live traffic" }],
        },
      ],
    });

    expect(result.isError).toBe(false);
    expect(interactionCreated.value).toBe(true);
    expect(calls.at(-1)).toMatchObject({
      path: "/api/issues/issue-7/interactions",
      body: {
        kind: "ask_user_questions",
        continuationPolicy: "wake_assignee",
        title: "Deploy target",
        payload: {
          version: 1,
          title: "Deploy target",
          questions: [
            {
              id: "q1",
              prompt: "Which environment?",
              selectionMode: "single",
              required: true,
              options: [
                { id: "q1_o1", label: "Staging" },
                { id: "q1_o2", label: "Production", description: "Live traffic" },
              ],
            },
          ],
        },
      },
    });
  });

  it("ask_user_questions represents an options-less question as a single free-text option", async () => {
    const calls: Array<{ body: any }> = [];
    const api = makeApi(async (_input: any, init: any) => {
      calls.push({ body: init?.body ? JSON.parse(init.body) : undefined });
      return jsonResponse({ id: "interaction-1" });
    });
    const tools = buildTools({ api, agentId: "agent-1", companyId: "company-1", currentIssueId: "issue-7", autoApprove: false });

    const result = await findTool(tools, "ask_user_questions")!.execute({
      questions: [{ prompt: "What's the deploy tag?" }],
    });

    expect(result.isError).toBe(false);
    expect(calls.at(-1)!.body.payload.questions[0]).toMatchObject({
      id: "q1",
      selectionMode: "single",
      options: [{ id: "q1_answer", label: "Your answer", freeText: true }],
    });
  });

  it("ask_user_questions accepts plain strings as options, not just {label} objects", async () => {
    // Weaker function-calling models are more likely to pass a flat string
    // array (["Staging", "Production"]) than an array of {label} objects —
    // accept both instead of silently dropping to the free-text fallback.
    const calls: Array<{ body: any }> = [];
    const api = makeApi(async (_input: any, init: any) => {
      calls.push({ body: init?.body ? JSON.parse(init.body) : undefined });
      return jsonResponse({ id: "interaction-1" });
    });
    const tools = buildTools({ api, agentId: "agent-1", companyId: "company-1", currentIssueId: "issue-7", autoApprove: false });

    const result = await findTool(tools, "ask_user_questions")!.execute({
      questions: [{ prompt: "Which environment?", options: ["Staging", "Production"] }],
    });

    expect(result.isError).toBe(false);
    expect(calls.at(-1)!.body.payload.questions[0].options).toEqual([
      { id: "q1_o1", label: "Staging" },
      { id: "q1_o2", label: "Production" },
    ]);
  });

  it("ask_user_questions requires at least one question with a non-empty prompt", async () => {
    const api = makeApi(async () => jsonResponse({}));
    const tools = buildTools({ api, agentId: "agent-1", companyId: "company-1", currentIssueId: "issue-7", autoApprove: false });

    const noQuestions = await findTool(tools, "ask_user_questions")!.execute({ questions: [] });
    expect(noQuestions.isError).toBe(true);
    expect(noQuestions.content).toContain("At least one question is required");

    const emptyPrompt = await findTool(tools, "ask_user_questions")!.execute({ questions: [{ prompt: "" }] });
    expect(emptyPrompt.isError).toBe(true);
    expect(emptyPrompt.content).toContain("non-empty prompt");
  });

  it("ask_user_questions fails gracefully with no current issue and no issue_id", async () => {
    const api = makeApi(async () => jsonResponse({}));
    const tools = buildTools({ api, agentId: "agent-1", companyId: "company-1", currentIssueId: null, autoApprove: false });

    const result = await findTool(tools, "ask_user_questions")!.execute({ questions: [{ prompt: "Which one?" }] });
    expect(result.isError).toBe(true);
    expect(result.content).toContain("No current issue");
  });
});

describe("list_interactions", () => {
  it("lists interactions on the current issue via GET /api/issues/:id/interactions", async () => {
    const paths: string[] = [];
    const api = makeApi(async (input: any) => {
      paths.push(new URL(typeof input === "string" ? input : input.url).pathname);
      return jsonResponse([
        { id: "int-1", kind: "ask_user_questions", status: "answered", title: "Round 1" },
      ]);
    });
    const tools = buildTools({ api, agentId: "agent-1", companyId: "company-1", currentIssueId: "issue-34", autoApprove: false });

    const result = await findTool(tools, "list_interactions")!.execute({});

    expect(result.isError).toBe(false);
    expect(paths).toContain("/api/issues/issue-34/interactions");
    expect(JSON.parse(result.content)).toEqual([
      { id: "int-1", kind: "ask_user_questions", status: "answered", title: "Round 1" },
    ]);
  });

  it("fails gracefully with no current issue and no issue_id", async () => {
    const api = makeApi(async () => jsonResponse({}));
    const tools = buildTools({ api, agentId: "agent-1", companyId: "company-1", currentIssueId: null, autoApprove: false });

    const result = await findTool(tools, "list_interactions")!.execute({});
    expect(result.isError).toBe(true);
    expect(result.content).toContain("No issue_id supplied");
  });
});

describe("memory_fs", () => {
  let agentHomeDir: string;

  beforeEach(() => {
    agentHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), "llm-adapter-tool-homes-"));
  });

  afterEach(() => {
    fs.rmSync(agentHomeDir, { recursive: true, force: true });
  });

  function toolsFor(agentId: string) {
    const api = makeApi(async () => jsonResponse({}));
    return buildTools({
      api,
      agentId,
      companyId: "company-1",
      currentIssueId: null,
      autoApprove: false,
      config: { agentHomeDir },
    });
  }

  it("writes then reads back a private note", async () => {
    const tools = toolsFor("agent-a");
    const write = await findTool(tools, "memory_fs")!.execute({
      action: "write",
      scope: "private",
      path: "memory/2026-09-29.md",
      content: "Talked to Kyle about org storage.",
    });
    expect(write.isError).toBe(false);

    const read = await findTool(tools, "memory_fs")!.execute({
      action: "read",
      scope: "private",
      path: "memory/2026-09-29.md",
    });
    expect(read.isError).toBe(false);
    expect(JSON.parse(read.content).content).toBe("Talked to Kyle about org storage.");
  });

  it("keeps private notes isolated between two agents in the same company", async () => {
    const agentA = toolsFor("agent-a");
    const agentB = toolsFor("agent-b");

    await findTool(agentA, "memory_fs")!.execute({
      action: "write",
      scope: "private",
      path: "secret.md",
      content: "agent-a's private note",
    });

    const bReadsA = await findTool(agentB, "memory_fs")!.execute({
      action: "read",
      scope: "private",
      path: "secret.md",
    });
    expect(bReadsA.isError).toBe(true);
  });

  it("lets two agents in the same company share notes via scope='shared'", async () => {
    const agentA = toolsFor("agent-a");
    const agentB = toolsFor("agent-b");

    await findTool(agentA, "memory_fs")!.execute({
      action: "write",
      scope: "shared",
      path: "plans/2026-09-29-launch.md",
      content: "Launch plan drafted by agent-a.",
    });

    const bReadsShared = await findTool(agentB, "memory_fs")!.execute({
      action: "read",
      scope: "shared",
      path: "plans/2026-09-29-launch.md",
    });
    expect(bReadsShared.isError).toBe(false);
    expect(JSON.parse(bReadsShared.content).content).toBe("Launch plan drafted by agent-a.");
  });

  it("rejects a path that tries to escape the scope root", async () => {
    const tools = toolsFor("agent-a");
    const result = await findTool(tools, "memory_fs")!.execute({
      action: "read",
      scope: "private",
      path: "../../../etc/passwd",
    });
    expect(result.isError).toBe(true);
    expect(result.content).toContain("outside the allowed directory");
  });

  it("search finds a keyword across files in the chosen scope", async () => {
    const tools = toolsFor("agent-a");
    await findTool(tools, "memory_fs")!.execute({
      action: "write",
      scope: "private",
      path: "life/areas/people/kyle/summary.md",
      content: "Kyle prefers async updates.",
    });

    const result = await findTool(tools, "memory_fs")!.execute({ action: "search", scope: "private", query: "async" });
    expect(result.isError).toBe(false);
    const { matches } = JSON.parse(result.content);
    expect(matches).toHaveLength(1);
    expect(matches[0].path).toBe("life/areas/people/kyle/summary.md");
  });

  it("defaults to scope='private' when scope is omitted", async () => {
    const tools = toolsFor("agent-a");
    await findTool(tools, "memory_fs")!.execute({ action: "write", path: "note.md", content: "default scope" });
    const result = await findTool(tools, "memory_fs")!.execute({ action: "read", path: "note.md" });
    expect(JSON.parse(result.content).scope).toBe("private");
  });
});

describe("issue_document", () => {
  it("writes a document via PUT /api/issues/:id/documents/:key with a slugified key", async () => {
    const calls: Array<{ method: string; path: string; body: any }> = [];
    const api = makeApi(async (input: any, init: any) => {
      calls.push({
        method: (init?.method || "GET").toUpperCase(),
        path: new URL(typeof input === "string" ? input : input.url).pathname,
        body: init?.body ? JSON.parse(init.body) : undefined,
      });
      if ((init?.method || "GET").toUpperCase() === "GET") return jsonResponse({ error: "not found" }, 404);
      return jsonResponse({ document: { key: "design-doc" } });
    });
    const tools = buildTools({ api, agentId: "agent-1", companyId: "company-1", currentIssueId: "issue-7", autoApprove: false });

    const result = await findTool(tools, "issue_document")!.execute({
      action: "write",
      key: "Design Doc!!",
      title: "Design Doc",
      body: "# Design\n\nDetails here.",
      change_summary: "Initial draft",
    });

    expect(result.isError).toBe(false);
    const putCall = calls.find((c) => c.method === "PUT");
    expect(putCall).toMatchObject({
      path: "/api/issues/issue-7/documents/design-doc",
      body: { title: "Design Doc", format: "markdown", body: "# Design\n\nDetails here.", changeSummary: "Initial draft" },
    });
  });

  it("auto-resolves baseRevisionId from the existing document before writing (regression guard)", async () => {
    // Real incident: an agent reported "The document tool can't carry the
    // required baseRevisionId for an existing key" and worked around it by
    // publishing under a fresh key instead — because the tool never sent
    // baseRevisionId at all, and Paperclip 409s any update to an existing
    // key without it (packages/shared upsertIssueDocumentSchema +
    // documents.ts's optimistic-concurrency check in the host repo). The
    // fix resolves it automatically so the model never has to manage
    // revision ids itself.
    const calls: Array<{ method: string; path: string; body: any }> = [];
    const api = makeApi(async (input: any, init: any) => {
      const method = (init?.method || "GET").toUpperCase();
      calls.push({ method, path: new URL(typeof input === "string" ? input : input.url).pathname, body: init?.body ? JSON.parse(init.body) : undefined });
      if (method === "GET") return jsonResponse({ key: "design-doc", latestRevisionId: "rev-abc" });
      return jsonResponse({ document: { key: "design-doc", latestRevisionId: "rev-def" } });
    });
    const tools = buildTools({ api, agentId: "agent-1", companyId: "company-1", currentIssueId: "issue-7", autoApprove: false });

    const result = await findTool(tools, "issue_document")!.execute({
      action: "write",
      key: "design-doc",
      body: "Updated content",
    });

    expect(result.isError).toBe(false);
    expect(calls[0]!.method).toBe("GET");
    const putCall = calls.find((c) => c.method === "PUT");
    expect(putCall!.body).toMatchObject({ baseRevisionId: "rev-abc" });
  });

  it("retries once with a freshly-resolved baseRevisionId when the first write 409s", async () => {
    const calls: Array<{ method: string; body: any }> = [];
    let getCount = 0;
    const api = makeApi(async (input: any, init: any) => {
      const method = (init?.method || "GET").toUpperCase();
      calls.push({ method, body: init?.body ? JSON.parse(init.body) : undefined });
      if (method === "GET") {
        getCount += 1;
        return jsonResponse({ key: "design-doc", latestRevisionId: getCount === 1 ? "rev-stale" : "rev-fresh" });
      }
      if (method === "PUT" && calls.filter((c) => c.method === "PUT").length === 1) {
        return jsonResponse({ error: "Document was updated by someone else" }, 409);
      }
      return jsonResponse({ document: { key: "design-doc" } });
    });
    const tools = buildTools({ api, agentId: "agent-1", companyId: "company-1", currentIssueId: "issue-7", autoApprove: false });

    const result = await findTool(tools, "issue_document")!.execute({ action: "write", key: "design-doc", body: "New content" });

    expect(result.isError).toBe(false);
    const putCalls = calls.filter((c) => c.method === "PUT");
    expect(putCalls.length).toBe(2);
    expect(putCalls[0]!.body).toMatchObject({ baseRevisionId: "rev-stale" });
    expect(putCalls[1]!.body).toMatchObject({ baseRevisionId: "rev-fresh" });
  });

  it("requires body for action='write'", async () => {
    const api = makeApi(async () => jsonResponse({}));
    const tools = buildTools({ api, agentId: "agent-1", companyId: "company-1", currentIssueId: "issue-7", autoApprove: false });

    const result = await findTool(tools, "issue_document")!.execute({ action: "write", key: "design-doc" });
    expect(result.isError).toBe(true);
    expect(result.content).toContain("body is required");
  });

  it("reads a document by key", async () => {
    const paths: string[] = [];
    const api = makeApi(async (input: any) => {
      paths.push(new URL(typeof input === "string" ? input : input.url).pathname);
      return jsonResponse({ key: "design-doc", body: "# Design" });
    });
    const tools = buildTools({ api, agentId: "agent-1", companyId: "company-1", currentIssueId: "issue-7", autoApprove: false });

    const result = await findTool(tools, "issue_document")!.execute({ action: "read", key: "design-doc" });
    expect(result.isError).toBe(false);
    expect(paths).toContain("/api/issues/issue-7/documents/design-doc");
  });

  it("lists documents on the current issue", async () => {
    const paths: string[] = [];
    const api = makeApi(async (input: any) => {
      paths.push(new URL(typeof input === "string" ? input : input.url).pathname);
      return jsonResponse([{ key: "design-doc" }]);
    });
    const tools = buildTools({ api, agentId: "agent-1", companyId: "company-1", currentIssueId: "issue-7", autoApprove: false });

    const result = await findTool(tools, "issue_document")!.execute({ action: "list" });
    expect(result.isError).toBe(false);
    expect(paths).toContain("/api/issues/issue-7/documents");
  });

  it("fails gracefully with no current issue and no issue_id", async () => {
    const api = makeApi(async () => jsonResponse({}));
    const tools = buildTools({ api, agentId: "agent-1", companyId: "company-1", currentIssueId: null, autoApprove: false });

    const result = await findTool(tools, "issue_document")!.execute({ action: "list" });
    expect(result.isError).toBe(true);
    expect(result.content).toContain("No issue_id supplied");
  });
});

describe("update_issue_status dispositions", () => {
  function recordingApi(respond: (call: { method: string; path: string; body: any }) => Response = () => jsonResponse({ id: "issue-1" })) {
    const calls: Array<{ method: string; path: string; body: any }> = [];
    const api = makeApi(async (input: any, init: any) => {
      const call = {
        method: (init?.method || "GET").toUpperCase(),
        path: new URL(typeof input === "string" ? input : input.url).pathname,
        body: init?.body ? JSON.parse(init.body) : undefined,
      };
      calls.push(call);
      return respond(call);
    });
    return { api, calls };
  }

  function statusTool(api: PaperclipApi) {
    const tools = buildTools({
      api,
      agentId: "agent-1",
      companyId: "company-1",
      currentIssueId: "issue-1",
      currentIssueIdentifier: "DEBA-39",
      autoApprove: false,
    });
    return findTool(tools, "update_issue_status")!;
  }

  it("rejects a bare 'blocked' locally instead of sending a patch Paperclip will 422", async () => {
    const { api, calls } = recordingApi();
    const result = await statusTool(api).execute({ status: "blocked" });
    expect(result.isError).toBe(true);
    expect(result.content).toContain("blocked_by_issue_ids");
    expect(result.content).toContain("ask_user_questions");
    expect(calls.length).toBe(0);
  });

  it("turns unblock_action into an unblockDescriptor owned by this agent, and sends comment (not statusReason)", async () => {
    const { api, calls } = recordingApi();
    const result = await statusTool(api).execute({
      status: "blocked",
      unblock_action: "Retry once GSC access is granted",
      comment: "GSC returned 403.",
    });
    expect(result.isError).toBe(false);
    expect(calls[0]).toMatchObject({
      method: "PATCH",
      path: "/api/issues/issue-1",
      body: {
        status: "blocked",
        comment: "GSC returned 403.",
        unblockDescriptor: { owner: { agentId: "agent-1" }, action: "Retry once GSC access is granted" },
      },
    });
    expect(calls[0]!.body.statusReason).toBeUndefined();
  });

  it("sends blocked_by_issue_ids as blockedByIssueIds", async () => {
    const { api, calls } = recordingApi();
    await statusTool(api).execute({ status: "blocked", blocked_by_issue_ids: ["issue-2"] });
    expect(calls[0]!.body).toEqual({ status: "blocked", blockedByIssueIds: ["issue-2"] });
  });

  it("requires a reviewer for in_review on the current issue and sends it as assigneeUserId", async () => {
    const { api, calls } = recordingApi();
    const tool = statusTool(api);
    const rejected = await tool.execute({ status: "in_review" });
    expect(rejected.isError).toBe(true);
    expect(calls.length).toBe(0);

    await tool.execute({ status: "in_review", reviewer_user_id: "user-9" });
    expect(calls[0]!.body).toEqual({ status: "in_review", assigneeUserId: "user-9" });
  });

  it("refuses non-disposition statuses on the current issue (by id or identifier) but allows them on other issues", async () => {
    const { api, calls } = recordingApi();
    const tool = statusTool(api);
    for (const issue_id of [undefined, "issue-1", "DEBA-39"]) {
      const result = await tool.execute({ status: "in_progress", issue_id });
      expect(result.isError).toBe(true);
      expect(result.content).toContain("missing");
    }
    expect(calls.length).toBe(0);

    const other = await tool.execute({ status: "todo", issue_id: "issue-2" });
    expect(other.isError).toBe(false);
    expect(calls[0]).toMatchObject({ path: "/api/issues/issue-2", body: { status: "todo" } });
  });

  it("adds a how-to-fix hint to a 422 from Paperclip", async () => {
    const { api } = recordingApi(() =>
      jsonResponse({ error: "Entering blocked requires unresolved blockers, a pending interaction/approval, or unblockDescriptor" }, 422),
    );
    const result = await statusTool(api).execute({ status: "blocked", blocked_by_issue_ids: ["issue-done"] });
    expect(result.isError).toBe(true);
    expect(result.content).toContain("Entering blocked requires");
    expect(result.content).toContain("unblock_action");
  });
});

describe("secrets & http_request", () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  function toolsWith(secrets: Record<string, string>, config: Record<string, unknown> = {}) {
    const api = makeApi(async () => jsonResponse({}));
    return buildTools({ api, agentId: "agent-1", companyId: "company-1", currentIssueId: "issue-1", autoApprove: false, secrets, config });
  }

  it("registers neither tool when no secrets are bound (and http_request only with httpToolEnabled)", () => {
    expect(findTool(toolsWith({}), "http_request")).toBeNull();
    expect(findTool(toolsWith({}), "list_secrets")).toBeNull();
    expect(findTool(toolsWith({}, { httpToolEnabled: true }), "http_request")).not.toBeNull();
  });

  it("list_secrets returns names only, never values", async () => {
    const result = await findTool(toolsWith({ UMAMI_API_KEY: "umami-secret-value", B_KEY: "bbbb-value" }), "list_secrets")!.execute({});
    expect(JSON.parse(result.content)).toEqual({ secrets: ["B_KEY", "UMAMI_API_KEY"] });
    expect(result.content).not.toContain("secret-value");
  });

  it("substitutes {{secret:NAME}} into headers/query and redacts the value from the response", async () => {
    let seen: { url: string; headers: Record<string, string> } | null = null;
    globalThis.fetch = (async (input: any, init: any) => {
      seen = { url: String(input), headers: init.headers };
      // A misbehaving API that echoes the key back.
      return jsonResponse({ echoed: init.headers["x-umami-api-key"], pageviews: 42 });
    }) as typeof fetch;

    const result = await findTool(toolsWith({ UMAMI_API_KEY: "umami-secret-value" }), "http_request")!.execute({
      url: "https://umami.example.com/api/websites/abc/stats",
      headers: { "x-umami-api-key": "{{secret:UMAMI_API_KEY}}" },
      query: { startAt: "1", endAt: "2" },
    });

    expect(seen!.headers["x-umami-api-key"]).toBe("umami-secret-value");
    expect(seen!.url).toContain("startAt=1");
    expect(result.isError).toBe(false);
    const parsed = JSON.parse(result.content);
    expect(parsed.status).toBe(200);
    expect(parsed.body).toContain('"pageviews":42');
    expect(result.content).not.toContain("umami-secret-value");
  });

  it("redacts secrets from error responses too, and marks non-2xx as an error", async () => {
    globalThis.fetch = (async () => new Response("bad key: umami-secret-value", { status: 401 })) as typeof fetch;
    const result = await findTool(toolsWith({ UMAMI_API_KEY: "umami-secret-value" }), "http_request")!.execute({
      url: "https://umami.example.com/api",
      headers: { "x-umami-api-key": "{{secret:UMAMI_API_KEY}}" },
    });
    expect(result.isError).toBe(true);
    expect(result.content).not.toContain("umami-secret-value");
    expect(result.content).toContain("***");
  });

  it("fails with the list of bound names on an unknown secret, without making a request", async () => {
    let called = false;
    globalThis.fetch = (async () => {
      called = true;
      return jsonResponse({});
    }) as typeof fetch;
    const result = await findTool(toolsWith({ UMAMI_API_KEY: "v-value" }), "http_request")!.execute({
      url: "https://x.example.com/?k={{secret:NOPE}}",
    });
    expect(result.isError).toBe(true);
    expect(result.content).toContain("Unknown secret 'NOPE'");
    expect(result.content).toContain("UMAMI_API_KEY");
    expect(called).toBe(false);
  });

  it("enforces httpAllowedHosts and rejects non-http schemes", async () => {
    globalThis.fetch = (async () => jsonResponse({})) as typeof fetch;
    const tool = findTool(toolsWith({ K: "v-value" }, { httpAllowedHosts: "*.googleapis.com, analytics.example.com" }), "http_request")!;
    expect((await tool.execute({ url: "https://evil.example.net/" })).content).toContain("not in this agent's httpAllowedHosts");
    expect((await tool.execute({ url: "https://searchconsole.googleapis.com/x" })).isError).toBe(false);
    expect((await tool.execute({ url: "https://analytics.example.com/x" })).isError).toBe(false);
    expect((await tool.execute({ url: "file:///etc/passwd" })).content).toContain("Only http");
  });

  it("mints a Google access token from a service-account secret, signs a valid RS256 JWT, and redacts the token", async () => {
    const crypto = await import("node:crypto");
    const { privateKey, publicKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
    const serviceAccount = JSON.stringify({
      type: "service_account",
      client_email: "gsc@proj.iam.gserviceaccount.com",
      private_key: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
      token_uri: "https://oauth2.googleapis.com/token",
    });

    let tokenRequests = 0;
    let apiAuth: string | undefined;
    globalThis.fetch = (async (input: any, init: any) => {
      const url = String(input);
      if (url === "https://oauth2.googleapis.com/token") {
        tokenRequests += 1;
        const params = new URLSearchParams(String(init.body));
        expect(params.get("grant_type")).toBe("urn:ietf:params:oauth:grant-type:jwt-bearer");
        const [h, c, sig] = params.get("assertion")!.split(".");
        const valid = crypto
          .createVerify("RSA-SHA256")
          .update(`${h}.${c}`)
          .verify(publicKey, Buffer.from(sig!, "base64url"));
        expect(valid).toBe(true);
        const claims = JSON.parse(Buffer.from(c!, "base64url").toString());
        expect(claims).toMatchObject({
          iss: "gsc@proj.iam.gserviceaccount.com",
          scope: "https://www.googleapis.com/auth/webmasters.readonly",
          aud: "https://oauth2.googleapis.com/token",
        });
        return jsonResponse({ access_token: "ya29.minted-token", expires_in: 3600 });
      }
      apiAuth = init.headers.Authorization;
      return jsonResponse({ rows: [{ clicks: 10, impressions: 200 }], debug: init.headers.Authorization });
    }) as typeof fetch;

    const tool = findTool(toolsWith({ GSC_SERVICE_ACCOUNT: serviceAccount }), "http_request")!;
    const call = () =>
      tool.execute({
        method: "POST",
        url: "https://searchconsole.googleapis.com/webmasters/v3/sites/sc-domain%3Adebtrelief.win/searchAnalytics/query",
        body: { startDate: "2026-09-23", endDate: "2026-09-29" },
        auth: {
          type: "google_service_account",
          secret: "GSC_SERVICE_ACCOUNT",
          scopes: ["https://www.googleapis.com/auth/webmasters.readonly"],
        },
      });

    const result = await call();
    expect(result.isError).toBe(false);
    expect(apiAuth).toBe("Bearer ya29.minted-token");
    expect(result.content).toContain('\\"clicks\\":10');
    expect(result.content).not.toContain("ya29.minted-token");
    expect(result.content).not.toContain("PRIVATE KEY");

    await call();
    expect(tokenRequests).toBe(1); // cached for the run
  });

  it("reports a bad service-account secret without leaking it", async () => {
    globalThis.fetch = (async () => jsonResponse({})) as typeof fetch;
    const result = await findTool(toolsWith({ GSC: "not-json-at-all" }), "http_request")!.execute({
      url: "https://searchconsole.googleapis.com/x",
      auth: { type: "google_service_account", secret: "GSC", scopes: ["s"] },
    });
    expect(result.isError).toBe(true);
    expect(result.content).toContain("not valid JSON");
    expect(result.content).not.toContain("not-json-at-all");
  });
});

describe("API-access secrets (GET /agents/me/secrets, fetched on demand)", () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  function fakeSecretApi(values: Record<string, string>) {
    const valueFetches: string[] = [];
    return {
      valueFetches,
      api: {
        listAgentSecretAccess: async () => ({ secrets: Object.keys(values).map((key) => ({ key })) }),
        getAgentSecretValue: async (key: string) => {
          valueFetches.push(key);
          return { key, value: values[key]! };
        },
      },
    };
  }

  async function toolsWithStore(env: Record<string, string>, apiValues: Record<string, string>) {
    const fake = fakeSecretApi(apiValues);
    const secretStore = new SecretStore(env, fake.api);
    await secretStore.init();
    const api = makeApi(async () => jsonResponse({}));
    const tools = buildTools({ api, agentId: "agent-1", companyId: "company-1", currentIssueId: "issue-1", autoApprove: false, secretStore });
    return { tools, ...fake };
  }

  it("lists API-access and env-var secret names together, and registers http_request for API-access-only agents", async () => {
    const { tools, valueFetches } = await toolsWithStore({ ENV_KEY: "env-value" }, { UMAMI_API_KEY: "umami-value-123" });
    const result = await findTool(tools, "list_secrets")!.execute({});
    expect(JSON.parse(result.content)).toEqual({ secrets: ["ENV_KEY", "UMAMI_API_KEY"] });
    expect(valueFetches).toEqual([]); // listing never fetches values
    expect(findTool((await toolsWithStore({}, { K: "vvvv" })).tools, "http_request")).not.toBeNull();
  });

  it("fetches an API-access value only when referenced, caches it, and redacts it", async () => {
    const { tools, valueFetches } = await toolsWithStore({}, { UMAMI_API_KEY: "umami-value-123", UNUSED: "unused-value" });
    let sentHeader: string | undefined;
    globalThis.fetch = (async (_input: any, init: any) => {
      sentHeader = init.headers["x-umami-api-key"];
      return jsonResponse({ echoed: sentHeader, pageviews: 7 });
    }) as typeof fetch;

    const tool = findTool(tools, "http_request")!;
    const args = { url: "https://umami.example.com/api", headers: { "x-umami-api-key": "{{secret:UMAMI_API_KEY}}" } };
    const first = await tool.execute(args);
    await tool.execute(args);

    expect(sentHeader).toBe("umami-value-123");
    expect(valueFetches).toEqual(["UMAMI_API_KEY"]);
    expect(first.content).not.toContain("umami-value-123");
    expect(first.content).toContain('\\"pageviews\\":7');
  });

  it("resolves a Google service-account key from an API-access binding for auth", async () => {
    const { tools, valueFetches } = await toolsWithStore({}, { GSC_SERVICE_ACCOUNT: "not-json-key" });
    globalThis.fetch = (async () => jsonResponse({})) as typeof fetch;
    const result = await findTool(tools, "http_request")!.execute({
      url: "https://searchconsole.googleapis.com/x",
      auth: { type: "google_service_account", secret: "GSC_SERVICE_ACCOUNT", scopes: ["s"] },
    });
    expect(valueFetches).toEqual(["GSC_SERVICE_ACCOUNT"]);
    expect(result.content).toContain("not valid JSON"); // got the value, then parsed it
    expect(result.content).not.toContain("not-json-key");
  });
});

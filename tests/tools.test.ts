/**
 * Unit tests for src/server/tools.ts — the scoped Paperclip-API tool set
 * that execute()'s tool loop calls into. Previously dead code (only used by
 * the now-deleted execute.ts.backup), so this file had zero coverage before.
 */

import { describe, expect, it } from "vitest";

import { PaperclipApi } from "../src/server/paperclip-api.js";
import { buildTools, findTool, toolSchemas } from "../src/server/tools.js";

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

    expect(tools.length).toBe(9);
    const names = toolSchemas(tools).map((s) => s.function.name);
    expect(names).toEqual([
      "get_issue",
      "update_issue_status",
      "add_comment",
      "list_comments",
      "create_sub_issue",
      "list_issues",
      "list_agents",
      "hire_agent",
      "request_approval",
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
});

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
import {
  buildTools,
  detectPaperclipFeatures,
  findTool,
  parseStatusCardTask,
  toolSchemas,
  type BuildToolsContext,
  type StatusCardTask,
} from "../src/server/tools.js";
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

const AGENTS = [
  { id: "agent-ceo", name: "Michael", title: "CEO", role: "ceo", adapterType: "llm", status: "idle" },
  { id: "agent-dwight", name: "Dwight", title: "Sales Lead", role: "general", adapterType: "llm", status: "idle", reportsTo: "agent-ceo" },
  { id: "agent-jim", name: "Jim", title: "Sales", role: "general", adapterType: "llm", status: "idle" },
  { id: "agent-jim2", name: "Jim", title: "Intern", role: "general", adapterType: "llm", status: "idle" },
];

describe("tools.ts", () => {
  it("toolSchemas() returns one schema per tool, matching buildTools()'s output", () => {
    const api = makeApi(async () => jsonResponse({}));
    const tools = buildTools({ api, agentId: "agent-1", companyId: "company-1", currentIssueId: null, autoApprove: false });

    expect(tools.length).toBe(18);
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
      "get_agent",
      "update_agent",
      "agent_instructions",
      "request_approval",
      "ask_user_questions",
      "list_interactions",
      "issue_document",
      "library",
      "find_documents",
    ]);
    // Every storage path must be visible in the Paperclip UI — no hidden file storage.
    expect(names).not.toContain("memory_fs");
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
    expect(result.content).toContain("No updatable fields supplied");
  });

  it("update_issue names ignored keys and points at the right tools", async () => {
    const api = makeApi(async () => jsonResponse({}));
    const tools = buildTools({ api, agentId: "agent-1", companyId: "company-1", currentIssueId: "issue-1", autoApprove: false });

    const result = await findTool(tools, "update_issue")!.execute({ foo: 1, comment: "hi" });
    expect(result.isError).toBe(true);
    expect(result.content).toContain("ignored: foo, comment");
    expect(result.content).toContain("update_issue_status");
    expect(result.content).toContain("add_comment");
  });

  it("update_issue accepts a status (models confuse it with update_issue_status) in one PATCH", async () => {
    const calls: Array<{ body: any }> = [];
    const api = makeApi(async (_input: any, init: any) => {
      calls.push({ body: init?.body ? JSON.parse(init.body) : undefined });
      return jsonResponse({ id: "issue-1" });
    });
    const tools = buildTools({ api, agentId: "agent-1", companyId: "company-1", currentIssueId: "issue-1", autoApprove: false });

    const result = await findTool(tools, "update_issue")!.execute({ status: "done", comment: "Verified.", priority: "low" });

    expect(result.isError).toBe(false);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.body).toMatchObject({ status: "done", comment: "Verified.", priority: "low" });
  });

  it("update_issue applies update_issue_status validation to a supplied status", async () => {
    const calls: unknown[] = [];
    const api = makeApi(async () => {
      calls.push(1);
      return jsonResponse({});
    });
    const tools = buildTools({ api, agentId: "agent-1", companyId: "company-1", currentIssueId: "issue-1", autoApprove: false });
    const tool = findTool(tools, "update_issue")!;

    const inProgress = await tool.execute({ status: "in_progress" });
    expect(inProgress.isError).toBe(true);
    expect(inProgress.content).toContain("not a valid way to end a run");

    const bareBlocked = await tool.execute({ status: "blocked" });
    expect(bareBlocked.isError).toBe(true);
    expect(bareBlocked.content).toContain("needs a real blocker path");

    expect(calls).toHaveLength(0);
  });

  it("update_issue fails gracefully with no current issue and no issue_id", async () => {
    const api = makeApi(async () => jsonResponse({}));
    const tools = buildTools({ api, agentId: "agent-1", companyId: "company-1", currentIssueId: null, autoApprove: false });

    const result = await findTool(tools, "update_issue")!.execute({ title: "New title" });
    expect(result.isError).toBe(true);
    expect(result.content).toContain("No issue_id supplied");
  });

  it("hire_agent routes through createApproval with Paperclip's field names when autoApprove is false", async () => {
    const calls: Array<{ path: string; body: any }> = [];
    const api = makeApi(async (input: any, init: any) => {
      const url = new URL(typeof input === "string" ? input : input.url);
      calls.push({ path: url.pathname, body: init?.body ? JSON.parse(init.body) : null });
      if (url.pathname === "/api/companies/company-1/agents") return jsonResponse(AGENTS);
      return jsonResponse({ ok: true });
    });
    const tools = buildTools({ api, agentId: "agent-1", companyId: "company-1", currentIssueId: null, autoApprove: false });

    await findTool(tools, "hire_agent")!.execute({
      name: "Sam", role: "Senior Engineer", mission: "Ship things", reports_to: "michael", model: "openai/gpt-oss-120b",
    });

    const approval = calls.find((c) => c.path === "/api/companies/company-1/approvals");
    expect(approval?.body.payload).toMatchObject({
      name: "Sam",
      role: "general",
      title: "Senior Engineer",
      capabilities: "Ship things",
      reportsTo: "agent-ceo",
      adapterType: "llm",
      adapterConfig: { model: "openai/gpt-oss-120b" },
    });
    expect(calls.map((c) => c.path)).not.toContain("/api/companies/company-1/agent-hires");
  });

  it("hire_agent calls hireAgent directly when autoApprove is true, with instructions as AGENTS.md", async () => {
    const calls: Array<{ path: string; body: any }> = [];
    const api = makeApi(async (input: any, init: any) => {
      const url = new URL(typeof input === "string" ? input : input.url);
      calls.push({ path: url.pathname, body: init?.body ? JSON.parse(init.body) : null });
      return jsonResponse({ ok: true });
    });
    const tools = buildTools({ api, agentId: "agent-1", companyId: "company-1", currentIssueId: null, autoApprove: true });

    await findTool(tools, "hire_agent")!.execute({ name: "Sam", title: "Engineer", role: "engineer", instructions: "You are Sam." });

    const hire = calls.find((c) => c.path === "/api/companies/company-1/agent-hires");
    expect(hire?.body).toMatchObject({
      role: "engineer",
      title: "Engineer",
      instructionsBundle: { files: { "AGENTS.md": "You are Sam." } },
    });
    expect(hire?.body).not.toHaveProperty("reportsTo");
    expect(calls.map((c) => c.path)).not.toContain("/api/companies/company-1/approvals");
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

  it("create_sub_issue resolves an identifier parent to its UUID (run-log regression: 'parentId Invalid GUID')", async () => {
    const parentUuid = "99a6e396-1d8a-456c-aa07-ef9a1360e7f6";
    const otherUuid = "11111111-2222-3333-4444-555555555555";
    const calls: Array<{ method: string; path: string; body: any }> = [];
    const api = makeApi(async (input: any, init: any) => {
      const path = new URL(typeof input === "string" ? input : input.url).pathname;
      calls.push({ method: init?.method ?? "GET", path, body: init?.body ? JSON.parse(init.body) : undefined });
      if (path === "/api/issues/DEBA-12") return jsonResponse({ id: otherUuid, identifier: "DEBA-12" });
      return jsonResponse({ id: "issue-child" });
    });
    const tools = buildTools({
      api,
      agentId: "agent-1",
      companyId: "company-1",
      currentIssueId: parentUuid,
      currentIssueIdentifier: "DEBA-59",
      autoApprove: false,
    });
    const create = findTool(tools, "create_sub_issue")!;

    await create.execute({ parent_issue_id: "DEBA-59", title: "Child of current" });
    expect(calls.at(-1)?.body.parentId).toBe(parentUuid);

    await create.execute({ parent_issue_id: "DEBA-12", title: "Child of other" });
    expect(calls.some((c) => c.method === "GET" && c.path === "/api/issues/DEBA-12")).toBe(true);
    expect(calls.at(-1)?.body.parentId).toBe(otherUuid);
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

  it("list_issues trims each issue down to a fixed set of fields", async () => {
    // Real incident: a model called list_issues(limit=50) just to check
    // whether a follow-up task already existed, and got back every field
    // (full description text, blockerAttention/reviewAttention/
    // successfulRunHandoff/relatedWork) of 50 issues — tens of thousands of
    // tokens for what should have been a cheap scan. get_issue already
    // covers "I need this one issue's full detail."
    const api = makeApi(async () =>
      jsonResponse([
        {
          id: "issue-9",
          identifier: "DEBA-9",
          title: "Some task",
          status: "in_progress",
          priority: "medium",
          assigneeAgentId: "agent-2",
          parentId: "issue-parent",
          updatedAt: "2026-10-01T00:00:00.000Z",
          description: "x".repeat(10000),
          blockerAttention: { state: "none" },
          reviewAttention: { state: "none" },
          successfulRunHandoff: null,
          relatedWork: { outbound: [], inbound: [] },
          labels: [],
          watchdog: null,
        },
      ]),
    );
    const tools = buildTools({ api, agentId: "agent-1", companyId: "company-1", currentIssueId: null, autoApprove: false });

    const result = await findTool(tools, "list_issues")!.execute({});
    expect(result.isError).toBe(false);
    const [issue] = JSON.parse(result.content);
    expect(issue).toEqual({
      id: "issue-9",
      identifier: "DEBA-9",
      title: "Some task",
      status: "in_progress",
      priority: "medium",
      assigneeAgentId: "agent-2",
      parentId: "issue-parent",
      updatedAt: "2026-10-01T00:00:00.000Z",
    });
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

/** Fake Paperclip agent API: list, get, patch, pause/resume, and an in-memory instructions bundle. */
function fakeAgentServer(opts: { files?: Record<string, string>; forbidWrites?: boolean } = {}) {
  const files: Record<string, string> = { ...(opts.files ?? { "AGENTS.md": "You are Dwight." }) };
  const calls: Array<{ method: string; path: string; body: any }> = [];
  const dwight = {
    ...AGENTS[1],
    adapterConfig: { model: "old-model", env: { SECRET: "x" }, instructionsFilePath: "/x/AGENTS.md", maxTurns: 20 },
    runtimeConfig: { heartbeat: { enabled: false, intervalSec: 3600 }, other: 1 },
  };
  const api = makeApi(async (input: any, init: any) => {
    const url = new URL(typeof input === "string" ? input : input.url);
    const method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(init.body) : null;
    calls.push({ method, path: url.pathname, body });
    const forbidden = () => jsonResponse({ error: "Missing permission agents:configure" }, 403);
    if (url.pathname === "/api/companies/company-1/agents") return jsonResponse(AGENTS);
    if (url.pathname === "/api/agents/agent-dwight" && method === "GET") return jsonResponse(dwight);
    if (url.pathname === "/api/agents/agent-dwight" && method === "PATCH") {
      if (opts.forbidWrites) return forbidden();
      return jsonResponse({ ...dwight, ...body, adapterConfig: { ...dwight.adapterConfig, ...(body.adapterConfig ?? {}) } });
    }
    if (url.pathname === "/api/agents/agent-dwight/pause") return jsonResponse({ ...dwight, status: "paused" });
    if (url.pathname === "/api/agents/agent-dwight/instructions-bundle") {
      return jsonResponse({ entryFile: "AGENTS.md", files: Object.keys(files).map((p) => ({ path: p, size: files[p].length })) });
    }
    if (url.pathname === "/api/agents/agent-dwight/instructions-bundle/file") {
      if (method === "GET") {
        const p = url.searchParams.get("path")!;
        return p in files ? jsonResponse({ path: p, content: files[p] }) : jsonResponse({ error: "Instructions file not found" }, 404);
      }
      if (opts.forbidWrites) return forbidden();
      files[body.path] = body.content;
      return jsonResponse({ path: body.path, size: body.content.length });
    }
    return jsonResponse({ error: `unexpected ${method} ${url.pathname}` }, 500);
  });
  const tools = buildTools({ api, agentId: "agent-ceo", companyId: "company-1", currentIssueId: null, autoApprove: false });
  return { tools, calls, files };
}

describe("agent management", () => {
  it("resolves an agent by id, by name case-insensitively, and by title", async () => {
    for (const ref of ["agent-dwight", "dwight", "SALES LEAD"]) {
      const { tools } = fakeAgentServer();
      const result = await findTool(tools, "get_agent")!.execute({ agent: ref });
      expect(result.isError).toBe(false);
      expect(JSON.parse(result.content).id).toBe("agent-dwight");
    }
  });

  it("lists the candidates when an agent ref is ambiguous or unknown", async () => {
    const { tools } = fakeAgentServer();
    const ambiguous = JSON.parse((await findTool(tools, "get_agent")!.execute({ agent: "Jim" })).content);
    expect(ambiguous.error).toContain("matches 2 agents");
    expect(ambiguous.detail.matches.map((m: any) => m.id)).toEqual(["agent-jim", "agent-jim2"]);

    const unknown = JSON.parse((await findTool(tools, "update_agent")!.execute({ agent: "Pam", title: "x" })).content);
    expect(unknown.error).toContain("No agent matches 'Pam'");
    expect(unknown.detail.agents).toHaveLength(AGENTS.length);
  });

  it("get_agent hides secrets and instruction plumbing, and names the manager", async () => {
    const { tools } = fakeAgentServer();
    const agent = JSON.parse((await findTool(tools, "get_agent")!.execute({ agent: "Dwight" })).content);
    expect(agent.reportsTo).toEqual({ id: "agent-ceo", name: "Michael" });
    expect(agent.model).toBe("old-model");
    expect(agent.adapterConfig).toEqual({ maxTurns: 20 });
    expect(agent.instructions).toEqual({ entryFile: "AGENTS.md", files: ["AGENTS.md"] });
  });

  it("update_agent maps reports_to, model, and a free-text role into Paperclip's fields", async () => {
    const { tools, calls } = fakeAgentServer();
    const result = await findTool(tools, "update_agent")!.execute({
      agent: "Dwight", role: "VP of Sales", reports_to: "Sales", model: "new-model",
    });
    expect(result.isError).toBe(false);
    const patch = calls.find((c) => c.method === "PATCH")!.body;
    expect(patch).toEqual({ title: "VP of Sales", reportsTo: "agent-jim", adapterConfig: { model: "new-model" } });
  });

  it("update_agent clears the manager with reports_to 'none' and refuses self-reporting", async () => {
    const { tools, calls } = fakeAgentServer();
    await findTool(tools, "update_agent")!.execute({ agent: "Dwight", reports_to: "none" });
    expect(calls.find((c) => c.method === "PATCH")!.body).toEqual({ reportsTo: null });

    const self = await findTool(tools, "update_agent")!.execute({ agent: "Dwight", reports_to: "Dwight" });
    expect(self.isError).toBe(true);
    expect(self.content).toContain("cannot report to itself");
  });

  it("update_agent merges heartbeat changes over the existing runtimeConfig", async () => {
    const { tools, calls } = fakeAgentServer();
    await findTool(tools, "update_agent")!.execute({ agent: "Dwight", heartbeat_enabled: true });
    expect(calls.find((c) => c.method === "PATCH")!.body.runtimeConfig).toEqual({
      heartbeat: { enabled: true, intervalSec: 3600 },
      other: 1,
    });
  });

  it("update_agent pauses through the pause endpoint", async () => {
    const { tools, calls } = fakeAgentServer();
    const result = JSON.parse((await findTool(tools, "update_agent")!.execute({ agent: "Dwight", status: "paused" })).content);
    expect(calls.some((c) => c.path === "/api/agents/agent-dwight/pause")).toBe(true);
    expect(calls.some((c) => c.method === "PATCH")).toBe(false);
    expect(result.agent.status).toBe("paused");
  });

  it("update_agent with nothing to change lists the editable fields", async () => {
    const { tools } = fakeAgentServer();
    const result = await findTool(tools, "update_agent")!.execute({ agent: "Dwight" });
    expect(result.isError).toBe(true);
    expect(result.content).toContain("reports_to");
    expect(result.content).toContain("heartbeat_enabled");
  });

  it("update_agent turns a 403 into a next step instead of a bare failure", async () => {
    const { tools } = fakeAgentServer({ forbidWrites: true });
    const result = await findTool(tools, "update_agent")!.execute({ agent: "Dwight", title: "VP" });
    expect(result.isError).toBe(true);
    const body = JSON.parse(result.content);
    expect(body.error).toContain("Missing permission agents:configure");
    expect(body.next_step).toContain("request_approval");
  });

  it("agent_instructions lists, reads the entry file by default, writes, and appends", async () => {
    const { tools, files } = fakeAgentServer();
    const tool = findTool(tools, "agent_instructions")!;

    const list = JSON.parse((await tool.execute({ agent: "Dwight", action: "list" })).content);
    expect(list.files).toEqual([{ path: "AGENTS.md", size: 15 }]);

    const read = JSON.parse((await tool.execute({ agent: "Dwight", action: "read" })).content);
    expect(read).toMatchObject({ path: "AGENTS.md", content: "You are Dwight." });

    await tool.execute({ agent: "Dwight", action: "append", content: "Report weekly." });
    expect(files["AGENTS.md"]).toBe("You are Dwight.\n\nReport weekly.");

    await tool.execute({ agent: "Dwight", action: "write", path: "TOOLS.md", content: "Use the CRM." });
    expect(files["TOOLS.md"]).toBe("Use the CRM.");
  });

  it("agent_instructions append creates a missing file, and write requires content", async () => {
    const { tools, files } = fakeAgentServer({ files: {} });
    const tool = findTool(tools, "agent_instructions")!;
    await tool.execute({ agent: "Dwight", action: "append", path: "NOTES.md", content: "First." });
    expect(files["NOTES.md"]).toBe("First.");

    const empty = await tool.execute({ agent: "Dwight", action: "write" });
    expect(empty.isError).toBe(true);
    expect(empty.content).toContain("needs 'content'");
  });

  it("agent_instructions surfaces a 403 with a next step", async () => {
    const { tools } = fakeAgentServer({ forbidWrites: true });
    const result = await findTool(tools, "agent_instructions")!.execute({ agent: "Dwight", action: "write", content: "x" });
    expect(result.isError).toBe(true);
    expect(JSON.parse(result.content).next_step).toContain("agents:configure");
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

/**
 * In-memory stand-in for the slice of the Paperclip API the Library uses:
 * issue listing/creation plus issue documents.
 */
function fakeLibraryServer(initialIssues: Array<Record<string, unknown>> = []) {
  const issues = [...initialIssues];
  const docs = new Map<string, Map<string, { title: string | null; body: string; latestRevisionId: string }>>();
  const calls: Array<{ method: string; path: string; body: any }> = [];
  let rev = 0;
  const fetchImpl = (async (input: any, init: any) => {
    const url = new URL(typeof input === "string" ? input : input.url);
    const method = (init?.method || "GET").toUpperCase();
    const body = init?.body ? JSON.parse(init.body) : undefined;
    calls.push({ method, path: url.pathname, body });
    let m;
    if (url.pathname === "/api/companies/company-1/issues" && method === "GET") {
      return jsonResponse(issues.filter((i) => i.assigneeAgentId == null));
    }
    if (url.pathname === "/api/companies/company-1/issues" && method === "POST") {
      const issue = { id: `lib-${issues.length + 1}`, identifier: `DEBA-${50 + issues.length}`, issueNumber: 50 + issues.length, assigneeAgentId: null, ...body };
      issues.push(issue);
      return jsonResponse(issue);
    }
    if ((m = url.pathname.match(/^\/api\/issues\/([^/]+)\/documents$/))) {
      const byKey = docs.get(m[1]!) ?? new Map();
      return jsonResponse([...byKey.entries()].map(([key, d]) => ({ key, title: d.title })));
    }
    if ((m = url.pathname.match(/^\/api\/issues\/([^/]+)\/documents\/([^/]+)$/))) {
      const byKey = docs.get(m[1]!) ?? new Map();
      docs.set(m[1]!, byKey);
      const key = decodeURIComponent(m[2]!);
      if (method === "GET") {
        const d = byKey.get(key);
        return d ? jsonResponse({ key, ...d }) : jsonResponse({ error: "Document not found" }, 404);
      }
      const d = { title: body.title ?? null, body: body.body, latestRevisionId: `rev-${++rev}` };
      byKey.set(key, d);
      return jsonResponse({ key, ...d });
    }
    if ((m = url.pathname.match(/^\/api\/issues\/([^/]+)$/))) {
      const issue = issues.find((i) => i.id === m![1] || i.identifier === m![1]);
      return issue ? jsonResponse(issue) : jsonResponse({ error: "Issue not found" }, 404);
    }
    return jsonResponse({ error: "unexpected" }, 500);
  }) as typeof fetch;
  return { issues, docs, calls, api: makeApi(fetchImpl) };
}

describe("library", () => {
  function libraryTool(api: PaperclipApi, config: Record<string, unknown> = {}) {
    return findTool(
      buildTools({ api, agentId: "agent-1", companyId: "company-1", currentIssueId: "issue-1", autoApprove: false, config }),
      "library",
    )!;
  }

  it("creates the unassigned 'Company Library' issue on first use, then writes/reads documents on it", async () => {
    const server = fakeLibraryServer();
    const tool = libraryTool(server.api);

    const write = await tool.execute({ action: "write", key: "Content Log", body: "# Log\n| 1 | topic |" });
    expect(write.isError).toBe(false);
    expect(server.issues).toHaveLength(1);
    expect(server.issues[0]).toMatchObject({ title: "Company Library", status: "backlog", assigneeAgentId: null });
    expect(server.docs.get("lib-1")!.get("content-log")!.body).toContain("| 1 | topic |");

    const read = await tool.execute({ action: "read", key: "content-log" });
    expect(read.content).toContain("| 1 | topic |");

    const list = JSON.parse((await tool.execute({ action: "list" })).content);
    expect(list.libraryIssue).toBe("DEBA-50");
    expect(list.documents).toEqual([
      { key: "content-log", title: null, format: null, latestRevisionNumber: null, updatedAt: null, preview: "" },
    ]);
    // Only one issue creation across all three calls (resolved once per run).
    expect(server.calls.filter((c) => c.method === "POST").length).toBe(1);
  });

  it("strips full document bodies out of action='list' — a real incident had one list call dump every library document's full text into context", async () => {
    const server = fakeLibraryServer();
    const tool = libraryTool(server.api);
    const longBody = "x".repeat(5000);
    await tool.execute({ action: "write", key: "big-draft", title: "Big Draft", body: longBody });

    const list = JSON.parse((await tool.execute({ action: "list" })).content);
    expect(list.documents).toHaveLength(1);
    const doc = list.documents[0]!;
    expect(doc.key).toBe("big-draft");
    expect(doc).not.toHaveProperty("body");
    expect(doc.preview.length).toBeLessThan(longBody.length);

    // action='read' still returns the full body — only 'list' is trimmed.
    const read = await tool.execute({ action: "read", key: "big-draft" });
    expect(read.content).toContain(longBody);
  });

  it("action='append' adds to an existing document without the caller resending its full body", async () => {
    // Real incident: a model correctly finished a real compliance review,
    // then had to retype the entire multi-KB draft verbatim (write requires
    // the full body — Paperclip has no diff/patch endpoint) just to add one
    // review-log paragraph, and ran out of its turn's token budget before
    // ever finishing the call. append lets the caller send only the new text.
    const server = fakeLibraryServer();
    const tool = libraryTool(server.api);
    await tool.execute({ action: "write", key: "draft", title: "Draft", body: "# Draft\n\nOriginal content." });

    const addition = "## Review log\n\n- Toby Flenderson: APPROVED.";
    const append = await tool.execute({ action: "append", key: "draft", body: addition });
    expect(append.isError).toBe(false);

    const stored = server.docs.get("lib-1")!.get("draft")!;
    expect(stored.body).toContain("Original content.");
    expect(stored.body).toContain("Toby Flenderson: APPROVED");
    // The PUT this tool made carried only the new text plus what already
    // existed server-side — never something larger than caller-sent + original.
    expect(stored.body.length).toBeLessThan("# Draft\n\nOriginal content.".length + addition.length + 10);
  });

  it("action='append' on a key with no document fails with a pointer to action='write'", async () => {
    const server = fakeLibraryServer();
    const tool = libraryTool(server.api);

    const result = await tool.execute({ action: "append", key: "missing", body: "some text" });
    expect(result.isError).toBe(true);
    expect(result.content).toContain("use action='write' to create it first");
  });

  it("a call missing key lists the existing keys so the model can resend it", async () => {
    const server = fakeLibraryServer();
    const tool = libraryTool(server.api);
    await tool.execute({ action: "write", key: "analytics-latest", body: "a" });
    await tool.execute({ action: "write", key: "content-log", body: "# Log" });

    const result = await tool.execute({ action: "append", body: "## Cleanup\n\nNo removals." });
    expect(result.isError).toBe(true);
    const error = JSON.parse(result.content).error;
    expect(error).toContain("key is required for action='append'");
    expect(error).toContain("Existing keys: analytics-latest, content-log");
    expect(error).toContain("Your body was received and is held");
    expect(server.docs.get("lib-1")!.get("content-log")!.body).toBe("# Log");

    // The model sends just the key; the held body is appended.
    const finish = await tool.execute({ action: "append", key: "content-log" });
    expect(finish.isError).toBe(false);
    expect(server.docs.get("lib-1")!.get("content-log")!.body).toContain("No removals.");
  });

  it("merges a write split across two calls — key in one, body in the next", async () => {
    // DEBA-69: glm-5.3-flash sent write(key, title) with no body, then
    // write(body) with no key, three times, until the repeat guard fired.
    const server = fakeLibraryServer();
    const tool = libraryTool(server.api);

    const first = await tool.execute({ action: "write", key: "publish-2026-10-04-dmp", title: "publish/2026-10-04-dmp.md" });
    expect(first.isError).toBe(true);
    expect(JSON.parse(first.content).error).toContain("key='publish-2026-10-04-dmp' is held");

    const second = await tool.execute({ action: "write", body: "---\ntitle: x\n---\n\n## Body", change_summary: "SEO pass" });
    expect(second.isError).toBe(false);
    const stored = server.docs.get("lib-1")!.get("publish-2026-10-04-dmp")!;
    expect(stored.body).toContain("## Body");
    expect(stored.title).toBe("publish/2026-10-04-dmp.md");
  });

  it("only holds a partial call for the very next document call", async () => {
    const server = fakeLibraryServer();
    const tool = libraryTool(server.api);
    await tool.execute({ action: "write", key: "draft", body: "x" });

    await tool.execute({ action: "write", key: "other" });
    await tool.execute({ action: "list" });
    const result = await tool.execute({ action: "write", body: "y" });
    expect(result.isError).toBe(true);
    expect(server.docs.get("lib-1")!.has("other")).toBe(false);
  });

  it("reuses the oldest existing Library issue instead of creating another", async () => {
    const server = fakeLibraryServer([
      { id: "newer", identifier: "DEBA-60", issueNumber: 60, title: "Company Library", status: "backlog", assigneeAgentId: null },
      { id: "older", identifier: "DEBA-51", issueNumber: 51, title: "Company Library", status: "backlog", assigneeAgentId: null },
      { id: "gone", identifier: "DEBA-40", issueNumber: 40, title: "Company Library", status: "cancelled", assigneeAgentId: null },
    ]);
    await libraryTool(server.api).execute({ action: "write", key: "x", body: "y" });
    expect(server.docs.has("older")).toBe(true);
    expect(server.calls.some((c) => c.method === "POST")).toBe(false);
  });

  it("honors config.libraryIssue as an explicit pin", async () => {
    const server = fakeLibraryServer([
      { id: "pinned", identifier: "DEBA-7", issueNumber: 7, title: "Shared docs", status: "backlog", assigneeAgentId: null },
    ]);
    await libraryTool(server.api, { libraryIssue: "DEBA-7" }).execute({ action: "write", key: "x", body: "y" });
    expect(server.docs.has("pinned")).toBe(true);
  });
});

describe("find_documents", () => {
  it("searches the company Artifacts view and returns issue + key for each document", async () => {
    const calls: string[] = [];
    const api = makeApi(async (input: any) => {
      calls.push(String(input));
      return jsonResponse({
        artifacts: [
          {
            title: "Brief 03: FDCPA",
            href: "/DEBA/issues/DEBA-50#document-briefs-2026-09-30-research-brief-03",
            issue: { id: "lib-1", identifier: "DEBA-50", title: "Company Library" },
            createdByAgent: { id: "a", name: "Dwight Schrute" },
            updatedAt: "2026-09-30T00:00:00.000Z",
            previewText: "Debt collector conduct rules...",
          },
        ],
        nextCursor: null,
      });
    });
    const tool = findTool(buildTools({ api, agentId: "agent-1", companyId: "company-1", currentIssueId: null, autoApprove: false }), "find_documents")!;

    const result = JSON.parse((await tool.execute({ query: "FDCPA" })).content);

    expect(calls[0]).toContain("/api/companies/company-1/artifacts?");
    expect(calls[0]).toContain("kind=document");
    expect(calls[0]).toContain("q=FDCPA");
    expect(result.documents[0]).toMatchObject({
      key: "briefs-2026-09-30-research-brief-03",
      issue: "DEBA-50",
      issueId: "lib-1",
      author: "Dwight Schrute",
    });
  });
});

describe("memory_fs → Library migration", () => {
  let agentHomeDir: string;
  beforeEach(() => {
    agentHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), "llm-adapter-migrate-"));
  });
  afterEach(() => {
    fs.rmSync(agentHomeDir, { recursive: true, force: true });
  });

  function seed(rel: string, content: string) {
    const target = path.join(agentHomeDir, rel);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content);
  }

  it("copies shared and private files into Library documents once, keeps the source files, and skips existing keys", async () => {
    const { migrateMemoryToLibrary, LibraryResolver } = await import("../src/server/library.js");
    seed("company-1/shared/content-log.md", "# Content Log");
    seed("company-1/shared/briefs/2026-09-30-research-brief-03-fdcpa-collector-rights.md", "brief body");
    seed("company-1/shared/empty.md", "   ");
    seed("company-1/agents/agent-1/notes/todo.md", "private note");
    seed("company-1/agents/agent-2/notes/other.md", "someone else's");

    const server = fakeLibraryServer();
    const run = () =>
      migrateMemoryToLibrary({
        api: server.api,
        library: new LibraryResolver(server.api, "company-1"),
        config: { agentHomeDir },
        companyId: "company-1",
        agentId: "agent-1",
        agentName: "Oscar Martinez",
      });

    const first = await run();
    const lib = server.docs.get("lib-1")!;
    expect([...lib.keys()].sort()).toEqual([
      "briefs-2026-09-30-research-brief-03-fdcpa-collector-rights",
      "content-log",
      "notes-oscar-martinez-notes-todo",
    ]);
    expect(lib.get("content-log")!.title).toBe("content-log.md");
    expect(lib.get("notes-oscar-martinez-notes-todo")!.title).toBe("Oscar Martinez notes: notes/todo.md");
    expect(first.migrated).toHaveLength(3);
    // Another agent's private notes are theirs to migrate, not ours.
    expect([...lib.values()].some((d) => d.body.includes("someone else's"))).toBe(false);
    // Source files are never deleted.
    expect(fs.existsSync(path.join(agentHomeDir, "company-1/shared/content-log.md"))).toBe(true);

    const writesBefore = server.calls.filter((c) => c.method === "PUT").length;
    const second = await run();
    expect(second.migrated).toHaveLength(0);
    expect(server.calls.filter((c) => c.method === "PUT").length).toBe(writesBefore);
  });

  it("does nothing (and never creates a Library) when there's no memory directory", async () => {
    const { migrateMemoryToLibrary, LibraryResolver } = await import("../src/server/library.js");
    const server = fakeLibraryServer();
    const result = await migrateMemoryToLibrary({
      api: server.api,
      library: new LibraryResolver(server.api, "company-1"),
      config: { agentHomeDir },
      companyId: "company-1",
      agentId: "agent-1",
      agentName: "Oscar",
    });
    expect(result.migrated).toEqual([]);
    expect(server.calls).toEqual([]);
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

  it("uses the API listing as the only source of names, dropping runtime env noise and the adapter's own LLM key", async () => {
    // Real run: config.env carried TEMP/TMP/TMPDIR/GH_CONFIG_DIR, and the
    // listing included the adapter's own "llm.apikey.<id>" binding.
    const { tools, valueFetches } = await toolsWithStore(
      { TEMP: "/tmp", TMPDIR: "/tmp", GH_CONFIG_DIR: "/x/gh" },
      { umami_api_key: "umami-value-123", google_search_console_key: "{}", "llm.apikey.c99734b7": "sk-llm" },
    );
    const result = await findTool(tools, "list_secrets")!.execute({});
    expect(JSON.parse(result.content)).toEqual({ secrets: ["google_search_console_key", "umami_api_key"] });
    expect(valueFetches).toEqual([]); // listing never fetches values
    expect(findTool((await toolsWithStore({}, { K: "vvvv" })).tools, "http_request")).not.toBeNull();
  });

  it("falls back to config.env names when the listing endpoint fails", async () => {
    const store = new SecretStore({ ENV_KEY: "env-value" }, {
      listAgentSecretAccess: async () => {
        throw new Error("404");
      },
      getAgentSecretValue: async () => ({ key: "", value: "" }),
    });
    const errors: string[] = [];
    await store.init((e) => errors.push(e));
    expect(store.names()).toEqual(["ENV_KEY"]);
    expect(errors).toEqual(["404"]);
  });

  it("accepts dotted/hyphenated secret keys in placeholders", async () => {
    const { tools } = await toolsWithStore({}, { "umami.api-key": "dotted-value" });
    let sent: string | undefined;
    globalThis.fetch = (async (_i: any, init: any) => {
      sent = init.headers["x-umami-api-key"];
      return jsonResponse({});
    }) as typeof fetch;
    await findTool(tools, "http_request")!.execute({
      url: "https://api.umami.is/v1/me",
      headers: { "x-umami-api-key": "{{secret:umami.api-key}}" },
    });
    expect(sent).toBe("dotted-value");
  });

  it("tells the model not to resend a request that got a 4xx, and flags underscore header names", async () => {
    const { tools } = await toolsWithStore({}, { umami_api_key: "umami-value-123" });
    globalThis.fetch = (async () => new Response("", { status: 404 })) as typeof fetch;
    const result = await findTool(tools, "http_request")!.execute({
      url: "https://debtrelief.win/api/stats/summary",
      headers: { x_umami_api_key: "{{secret:umami_api_key}}" },
    });
    const parsed = JSON.parse(result.content);
    expect(result.isError).toBe(true);
    expect(parsed.hint).toContain("Do not resend this request unchanged");
    expect(parsed.hint).toContain("x_umami_api_key");
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

// ----- Cases and status cards -----

type Route = [method: string, path: RegExp, handler: (body: any, match: RegExpMatchArray) => Response];

/** Routes Paperclip calls by method + path regex; anything unmatched is a 500 so a stray call fails loudly. */
function routedApi(routes: Route[]) {
  const calls: Array<{ method: string; path: string; body: any }> = [];
  const fetchImpl = (async (input: any, init: any) => {
    const url = new URL(typeof input === "string" ? input : input.url);
    const method = (init?.method || "GET").toUpperCase();
    const body = init?.body ? JSON.parse(init.body) : undefined;
    calls.push({ method, path: `${url.pathname}${url.search}`, body });
    for (const [m, re, handler] of routes) {
      const match = url.pathname.match(re);
      if (m === method && match) return handler(body, match);
    }
    return jsonResponse({ error: `unexpected ${method} ${url.pathname}` }, 500);
  }) as typeof fetch;
  return { calls, api: makeApi(fetchImpl) };
}

const CASE_UUID = "11111111-1111-4111-8111-111111111111";
const PARENT_UUID = "22222222-2222-4222-8222-222222222222";
const PROJECT_UUID = "33333333-3333-4333-8333-333333333333";
const LABEL_UUID = "44444444-4444-4444-8444-444444444444";
const ISSUE_UUID = "55555555-5555-4555-8555-555555555555";

function featureTools(
  api: PaperclipApi,
  extra: Partial<BuildToolsContext> = {},
) {
  return buildTools({
    api,
    agentId: "agent-1",
    companyId: "company-1",
    currentIssueId: "issue-1",
    currentIssueIdentifier: "PAP-1",
    autoApprove: false,
    features: { cases: true, statusCards: true },
    ...extra,
  });
}

function generationDescription(payload: Record<string, unknown>): string {
  return `Compile this status-card interest prompt...\n\n\`\`\`json\n${JSON.stringify(payload, null, 2)}\n\`\`\``;
}

describe("detectPaperclipFeatures", () => {
  it("enables both features and finds the status-card task on the current issue", async () => {
    const { api } = routedApi([
      ["GET", /\/cases$/, () => jsonResponse([])],
      ["GET", /\/status-cards$/, () => jsonResponse([])],
      [
        "GET",
        /^\/api\/issues\/issue-1$/,
        () =>
          jsonResponse({
            id: "issue-1",
            description: generationDescription({
              operation: "compile",
              statusCardId: "card-1",
              companyId: "company-1",
              generationIssueId: "issue-1",
            }),
          }),
      ],
    ]);
    const features = await detectPaperclipFeatures(api, "company-1", "issue-1");
    expect(features).toEqual({
      cases: true,
      statusCards: true,
      statusCardTask: { operation: "compile", statusCardId: "card-1", generationIssueId: "issue-1", summaryWritten: false },
      errors: [],
    });
  });

  it("treats 403 'Cases are disabled' and 404 'Status cards are not enabled' as off, quietly", async () => {
    const { api, calls } = routedApi([
      ["GET", /\/cases$/, () => jsonResponse({ error: "Cases are disabled" }, 403)],
      ["GET", /\/status-cards$/, () => jsonResponse({ error: "Status cards are not enabled" }, 404)],
    ]);
    const features = await detectPaperclipFeatures(api, "company-1", "issue-1");
    expect(features).toEqual({ cases: false, statusCards: false, statusCardTask: null, errors: [] });
    // No issue lookup when status cards are off.
    expect(calls.map((c) => c.path)).not.toContain("/api/issues/issue-1");
  });

  it("reports unexpected probe failures", async () => {
    const { api } = routedApi([
      ["GET", /\/cases$/, () => jsonResponse({ error: "boom" }, 500)],
      ["GET", /\/status-cards$/, () => jsonResponse({ error: "Status cards are not enabled" }, 404)],
    ]);
    const features = await detectPaperclipFeatures(api, "company-1", null);
    expect(features.cases).toBe(false);
    expect(features.errors).toEqual(["cases: 500 boom"]);
  });

  it("parseStatusCardTask ignores ordinary issues and payloads for a different issue", () => {
    expect(parseStatusCardTask({ id: "issue-1", description: "Write the launch post." })).toBeNull();
    expect(
      parseStatusCardTask({
        id: "issue-1",
        description: generationDescription({ operation: "update", statusCardId: "card-1", generationIssueId: "issue-9" }),
      }),
    ).toBeNull();
    expect(
      parseStatusCardTask({
        id: "issue-1",
        description: generationDescription({ operation: "update", statusCardId: "card-1", generationIssueId: "issue-1" }),
      }),
    ).toMatchObject({ operation: "update", statusCardId: "card-1" });
  });

  it("buildTools registers the feature tools only when enabled", () => {
    const api = makeApi(async () => jsonResponse({}));
    const names = (extra: Partial<BuildToolsContext>) => toolSchemas(featureTools(api, extra)).map((s) => s.function.name);
    const off = names({ features: { cases: false, statusCards: false } });
    expect(off).not.toContain("case");
    expect(off).not.toContain("status_card");
    expect(names({})).toEqual(expect.arrayContaining(["case", "status_card"]));
    expect(names({})).not.toContain("publish_status_card");
    const task: StatusCardTask = { operation: "compile", statusCardId: "card-1", generationIssueId: "issue-1", summaryWritten: false };
    expect(names({ statusCardTask: task })).toContain("publish_status_card");
  });
});

describe("case tool", () => {
  it("save sends Paperclip's strict body, resolving a parent identifier and a project name", async () => {
    const { api, calls } = routedApi([
      ["GET", /^\/api\/cases\/PAP-C1$/, () => jsonResponse({ id: PARENT_UUID })],
      ["GET", /\/projects$/, () => jsonResponse([{ id: PROJECT_UUID, name: "Website" }])],
      ["POST", /\/companies\/company-1\/cases$/, (body) => jsonResponse({ id: CASE_UUID, ...body, documents: [] }, 201)],
    ]);
    const result = await findTool(featureTools(api), "case")!.execute({
      action: "save",
      case_type: "blog_post",
      key: "launch-announcement",
      title: "Launch announcement",
      status: "draft",
      fields: { slug: "launch-announcement" },
      parent_case_id: "PAP-C1",
      project: "website",
    });
    expect(result.isError).toBe(false);
    expect(calls.at(-1)!.body).toEqual({
      caseType: "blog_post",
      key: "launch-announcement",
      title: "Launch announcement",
      status: "draft",
      fields: { slug: "launch-announcement" },
      parentCaseId: PARENT_UUID,
      projectId: PROJECT_UUID,
    });
  });

  it("save names the missing field, and a bad status lists the case statuses", async () => {
    const { api, calls } = routedApi([]);
    const tool = findTool(featureTools(api), "case")!;
    const noType = await tool.execute({ action: "save", title: "X" });
    expect(noType.content).toContain("case_type is required");
    const badStatus = await tool.execute({ action: "update", case_id: "PAP-C1", status: "todo" });
    expect(badStatus.isError).toBe(true);
    expect(badStatus.content).toContain("draft, in_progress, in_review, approved, done, cancelled");
    expect(calls).toHaveLength(0);
  });

  it("update merges fields into the existing ones unless replace_fields is set", async () => {
    const { api, calls } = routedApi([
      ["GET", /^\/api\/cases\/PAP-C1$/, () => jsonResponse({ id: CASE_UUID, fields: { slug: "a", publish_url: null } })],
      ["PATCH", /^\/api\/cases\/PAP-C1$/, (body) => jsonResponse({ id: CASE_UUID, ...body, documents: [] })],
    ]);
    const tool = findTool(featureTools(api), "case")!;
    await tool.execute({ action: "update", case_id: "PAP-C1", status: "in_review", fields: { publish_url: "https://x" } });
    expect(calls.at(-1)!.body).toEqual({ status: "in_review", fields: { slug: "a", publish_url: "https://x" } });

    await tool.execute({ action: "update", case_id: "PAP-C1", fields: { only: 1 }, replace_fields: true });
    expect(calls.at(-1)!.body).toEqual({ fields: { only: 1 } });
  });

  it("list returns only summary fields", async () => {
    const { api, calls } = routedApi([
      [
        "GET",
        /\/companies\/company-1\/cases$/,
        () =>
          jsonResponse([
            { id: CASE_UUID, identifier: "PAP-C1", caseType: "blog_post", key: "k", title: "T", status: "draft", fields: { big: "x".repeat(5000) } },
          ]),
      ],
    ]);
    const result = await findTool(featureTools(api), "case")!.execute({ action: "list", case_type: "blog_post", status: "active" });
    expect(calls[0]!.path).toBe("/api/companies/company-1/cases?limit=50&type=blog_post&status=active");
    expect(JSON.parse(result.content)).toEqual([
      { id: CASE_UUID, identifier: "PAP-C1", caseType: "blog_post", key: "k", title: "T", status: "draft", parentCaseId: null, updatedAt: null },
    ]);
  });

  it("write_document creates, then updates with the current revision, and append_document keeps the body", async () => {
    const docs = new Map<string, { title: string | null; body: string; latestRevisionId: string }>();
    let rev = 0;
    const { api, calls } = routedApi([
      [
        "GET",
        /^\/api\/cases\/PAP-C1\/documents\/([^/]+)$/,
        (_b, m) => {
          const d = docs.get(m[1]!);
          return d ? jsonResponse({ key: m[1], ...d }) : jsonResponse({ error: "Case document not found" }, 404);
        },
      ],
      [
        "PUT",
        /^\/api\/cases\/PAP-C1\/documents\/([^/]+)$/,
        (body, m) => {
          const d = { title: body.title ?? null, body: body.body, latestRevisionId: `rev-${++rev}` };
          docs.set(m[1]!, d);
          return jsonResponse({ key: m[1], ...d });
        },
      ],
    ]);
    const tool = findTool(featureTools(api), "case")!;
    await tool.execute({ action: "write_document", case_id: "PAP-C1", title: "Draft", body: "# Draft" });
    expect(calls.at(-1)!.body).toEqual({ title: "Draft", body: "# Draft", format: "markdown", changeSummary: null });
    expect(calls.at(-1)!.path).toBe("/api/cases/PAP-C1/documents/body");

    await tool.execute({ action: "append_document", case_id: "PAP-C1", body: "Reviewed." });
    expect(calls.at(-1)!.body).toMatchObject({ body: "# Draft\n\nReviewed.", title: "Draft", baseRevisionId: "rev-1" });

    const missing = await tool.execute({ action: "append_document", case_id: "PAP-C1", key: "notes", body: "x" });
    expect(missing.isError).toBe(true);
    expect(missing.content).toContain("action='write_document'");
  });

  it("write_document retries once when the revision went stale", async () => {
    let puts = 0;
    const { api, calls } = routedApi([
      ["GET", /\/documents\/body$/, () => jsonResponse({ key: "body", body: "old", latestRevisionId: `rev-${puts + 1}` })],
      [
        "PUT",
        /\/documents\/body$/,
        (body) =>
          ++puts === 1
            ? jsonResponse({ error: "Case document was updated by someone else" }, 409)
            : jsonResponse({ key: "body", ...body }),
      ],
    ]);
    const result = await findTool(featureTools(api), "case")!.execute({ action: "write_document", case_id: "PAP-C1", body: "new" });
    expect(result.isError).toBe(false);
    expect(calls.filter((c) => c.method === "PUT").map((c) => c.body.baseRevisionId)).toEqual(["rev-1", "rev-2"]);
  });

  it("link_issue resolves an issue identifier to its UUID", async () => {
    const { api, calls } = routedApi([
      ["GET", /^\/api\/issues\/PAP-7$/, () => jsonResponse({ id: ISSUE_UUID })],
      ["POST", /^\/api\/cases\/PAP-C1\/links$/, (body) => jsonResponse({ id: "link-1", ...body })],
    ]);
    await findTool(featureTools(api), "case")!.execute({ action: "link_issue", case_id: "PAP-C1", issue_id: "PAP-7" });
    expect(calls.at(-1)!.body).toEqual({ issueId: ISSUE_UUID, role: "reference" });
  });
});

describe("status_card tool", () => {
  it("create builds the refresh policy, filling the field the mode requires", async () => {
    const { api, calls } = routedApi([
      ["POST", /\/companies\/company-1\/status-cards$/, (body) => jsonResponse({ id: "card-1", state: "compiling", ...body }, 201)],
    ]);
    const result = await findTool(featureTools(api), "status_card")!.execute({
      action: "create",
      interest_prompt: "Launch blockers in Website",
      refresh_mode: "reactive",
    });
    expect(calls[0]!.body).toEqual({
      interestPrompt: "Launch blockers in Website",
      refreshPolicy: { mode: "reactive", debounceSeconds: 300 },
    });
    expect(JSON.parse(result.content)).toMatchObject({ id: "card-1", state: "compiling", defaultsApplied: "debounce_seconds=300" });
  });

  it("rejects an interest_prompt over Paperclip's agent limit without calling the API", async () => {
    const { api, calls } = routedApi([]);
    const result = await findTool(featureTools(api), "status_card")!.execute({ action: "create", interest_prompt: "x".repeat(4001) });
    expect(result.content).toContain("limit is 4000");
    expect(calls).toHaveLength(0);
  });

  it("explains the authored-cards-only 403", async () => {
    const { api } = routedApi([
      ["PATCH", /^\/api\/status-cards\/card-1$/, () => jsonResponse({ error: "Agents can only manage status cards they authored" }, 403)],
    ]);
    const result = await findTool(featureTools(api), "status_card")!.execute({ action: "update", card_id: "card-1", archived: true });
    expect(result.isError).toBe(true);
    expect(result.content).toContain("only change status cards you created");
  });
});

describe("publish_status_card tool", () => {
  function task(operation: "compile" | "update"): StatusCardTask {
    return { operation, statusCardId: "card-1", generationIssueId: "issue-1", summaryWritten: false };
  }

  it("save_query resolves project and label names and fills the generation ids", async () => {
    const { api, calls } = routedApi([
      ["GET", /\/projects$/, () => jsonResponse([{ id: PROJECT_UUID, name: "Website" }])],
      ["GET", /\/labels$/, () => jsonResponse([{ id: LABEL_UUID, name: "launch" }])],
      ["PUT", /^\/api\/status-cards\/card-1\/query$/, (body) => jsonResponse({ id: "card-1", queryVersion: 1, ...body })],
    ]);
    const tool = findTool(featureTools(api, { statusCardTask: task("compile") }), "publish_status_card")!;
    const result = await tool.execute({
      action: "save_query",
      title: "Launch blockers",
      queries: [{ q: "launch", status: ["blocked", "in_progress"], project: "Website", label: "launch", updated_within: "7d" }],
    });
    expect(result.isError).toBe(false);
    expect(calls.at(-1)!.body).toEqual({
      queries: [{ q: "launch", status: ["blocked", "in_progress"], projectId: PROJECT_UUID, labelId: LABEL_UUID, updatedWithin: "7d" }],
      title: "Launch blockers",
      changeSummary: "Compiled the interest prompt into queries.",
      generationIssueId: "issue-1",
    });
  });

  it("save_query lists the available projects when the name doesn't match", async () => {
    const { api } = routedApi([["GET", /\/projects$/, () => jsonResponse([{ id: PROJECT_UUID, name: "Website" }])]]);
    const tool = findTool(featureTools(api, { statusCardTask: task("compile") }), "publish_status_card")!;
    const result = await tool.execute({ action: "save_query", title: "T", queries: [{ project: "Mobile" }] });
    expect(result.isError).toBe(true);
    expect(result.content).toContain("No project named 'Mobile'. Available projects: Website");
  });

  it("save_query is refused on an update task", async () => {
    const { api, calls } = routedApi([]);
    const tool = findTool(featureTools(api, { statusCardTask: task("update") }), "publish_status_card")!;
    const result = await tool.execute({ action: "save_query", title: "T", queries: [{ q: "x" }] });
    expect(result.content).toContain("already compiled");
    expect(calls).toHaveLength(0);
  });

  it("save_summary sends the generation id and model, and unlocks marking the task done", async () => {
    const { api, calls } = routedApi([
      ["PUT", /^\/api\/status-cards\/card-1\/summary$/, () => jsonResponse({ card: {}, document: { id: "doc-1" } })],
      ["PATCH", /^\/api\/issues\/issue-1$/, (body) => jsonResponse({ id: "issue-1", ...body })],
    ]);
    const statusCardTask = task("compile");
    const tools = featureTools(api, { statusCardTask, model: "openai/gpt-oss-120b" });

    const early = await findTool(tools, "update_issue_status")!.execute({ status: "done" });
    expect(early.isError).toBe(true);
    expect(early.content).toContain("save_summary");
    const earlyViaUpdateIssue = await findTool(tools, "update_issue")!.execute({ status: "done" });
    expect(earlyViaUpdateIssue.isError).toBe(true);
    expect(calls).toHaveLength(0);

    const saved = await findTool(tools, "publish_status_card")!.execute({ action: "save_summary", markdown: "## Launch\n- PAP-3 blocked" });
    expect(saved.isError).toBe(false);
    expect(calls[0]!.body).toEqual({
      markdown: "## Launch\n- PAP-3 blocked",
      changeSummary: "Updated the summary.",
      generationIssueId: "issue-1",
      model: "openai/gpt-oss-120b",
    });
    expect(statusCardTask.summaryWritten).toBe(true);

    const done = await findTool(tools, "update_issue_status")!.execute({ status: "done" });
    expect(done.isError).toBe(false);
  });

  it("save_summary before the query is compiled points to save_query", async () => {
    const { api } = routedApi([
      ["PUT", /\/summary$/, () => jsonResponse({ error: "Compile the status-card query before writing its summary" }, 409)],
    ]);
    const tool = findTool(featureTools(api, { statusCardTask: task("compile") }), "publish_status_card")!;
    const result = await tool.execute({ action: "save_summary", markdown: "x" });
    expect(result.content).toContain("Call action='save_query' first");
  });
});

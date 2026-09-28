/**
 * Integration test for the LLM adapter execute() function.
 *
 * execute() now runs an in-process, multi-turn tool-calling loop against an
 * OpenAI-compatible chat/completions endpoint (no CLI subprocess). global
 * fetch is replaced with an in-memory recorder that serves:
 *   - POST .../chat/completions — a queue of canned ChatCompletionResponses
 *   - GET  .../generation       — 404 (OpenRouter cost lookup, best-effort)
 *   - /api/*                    — Paperclip API calls, recorded and asserted
 *
 * Goals:
 *   1. Prompt build succeeds when config.skillsDir is omitted (regression
 *      guard for the "Cannot read properties of undefined (reading 'skillsDir')"
 *      crash from <0.2.0).
 *   2. Issue lifecycle calls go through PaperclipApi.updateIssue and
 *      PaperclipApi.addIssueComment — the methods that exist on
 *      adapter-utils 2026.428.0 — and not the legacy
 *      updateIssueState / addComment names that triggered runtime TypeErrors.
 *   3. The returned AdapterExecutionResult conforms to the current schema
 *      (exitCode / signal / timedOut required; no `status` or `totalTokens`).
 *   4. The tool loop actually dispatches to src/server/tools.ts's scoped
 *      Paperclip-API tools — not shell/filesystem — including the hire_agent
 *      approval gate and the repeat-call / max-turns loop breakers.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { execute } from "../src/server/execute.js";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "llm-adapter-test-"));

// --- Chat-completion response builders -------------------------------------

interface ToolCallSpec {
  id: string;
  name: string;
  args: Record<string, unknown>;
}

function assistantResponse(text: string, opts: { id?: string } = {}) {
  return {
    id: opts.id ?? "gen-1",
    choices: [
      {
        finish_reason: "stop",
        message: { role: "assistant", content: text },
      },
    ],
  };
}

function toolCallResponse(calls: ToolCallSpec[], opts: { id?: string } = {}) {
  return {
    id: opts.id ?? "gen-1",
    choices: [
      {
        finish_reason: "tool_calls",
        message: {
          role: "assistant",
          content: null,
          tool_calls: calls.map((c) => ({
            id: c.id,
            type: "function",
            function: { name: c.name, arguments: JSON.stringify(c.args) },
          })),
        },
      },
    ],
  };
}

// --- Fetch recorder ----------------------------------------------------------

interface CallLog {
  method: string;
  path: string;
  body?: unknown;
}

function setupFetchMock(
  chatResponses: unknown[] = [],
  opts: { chatFailureStatus?: number } = {},
): { calls: CallLog[]; restore: () => void } {
  const calls: CallLog[] = [];
  const queue = [...chatResponses];
  const original = globalThis.fetch;

  globalThis.fetch = (async (input: any, init?: any) => {
    const url = typeof input === "string" ? input : input.url;
    const method = (init?.method || "GET").toUpperCase();
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    const parsed = new URL(url);
    const reqPath = parsed.pathname;

    calls.push({ method, path: reqPath, body });

    if (reqPath.endsWith("/chat/completions")) {
      if (opts.chatFailureStatus) {
        return new Response("boom", { status: opts.chatFailureStatus });
      }
      const next = queue.shift() ?? assistantResponse("done");
      return new Response(JSON.stringify(next), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }

    if (reqPath.endsWith("/generation")) {
      return new Response("not found", { status: 404 });
    }

    if (reqPath.startsWith("/api/")) {
      return new Response(JSON.stringify({ ok: true, id: "issue-1" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    return new Response("not found", { status: 404 });
  }) as typeof fetch;

  return {
    calls,
    restore: () => {
      globalThis.fetch = original;
    },
  };
}

// --- Context factory ---------------------------------------------------------

function makeContext(overrides: Partial<Parameters<typeof execute>[0]> = {}): Parameters<typeof execute>[0] {
  const onLog = vi.fn(async () => {});
  return {
    runId: "run-1",
    agent: {
      id: "agent-1",
      companyId: "company-1",
      name: "Test Agent",
      adapterType: "llm",
      adapterConfig: {},
    },
    runtime: {
      sessionId: null,
      sessionParams: null,
      sessionDisplayId: null,
      taskKey: null,
    },
    config: { model: "moonshotai/kimi-k2.6", apiKey: "test-key" },
    context: {
      wake: {
        reason: "issue_assigned",
        issue: {
          id: "issue-1",
          identifier: "PAP-1",
          title: "Test issue",
          status: "todo",
          priority: "normal",
        },
      },
    },
    onLog,
    authToken: "test-paperclip-jwt",
    ...overrides,
  } as Parameters<typeof execute>[0];
}

function findTranscriptResultEntry(ctx: Parameters<typeof execute>[0]): { subtype: string } | undefined {
  const onLog = ctx.onLog as unknown as { mock: { calls: Array<[string, string]> } };
  for (const [, chunk] of onLog.mock.calls) {
    try {
      const entry = JSON.parse(chunk.trim());
      if (entry.kind === "result") return entry;
    } catch {
      // not JSON, ignore
    }
  }
  return undefined;
}

// --- Tests --------------------------------------------------------------------

describe("execute()", () => {
  let fetchMock: ReturnType<typeof setupFetchMock>;
  let originalEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    originalEnv = { ...process.env };
    process.env.PAPERCLIP_API_URL = "http://localhost:9999";
    delete process.env.LLM_API_KEY;
    delete process.env.OPENROUTER_API_KEY;
  });

  afterEach(() => {
    fetchMock.restore();
    process.env = originalEnv;
  });

  it("builds the prompt when config.skillsDir is omitted", async () => {
    fetchMock = setupFetchMock([assistantResponse("done")]);

    const ctx = makeContext();
    expect((ctx.config as Record<string, unknown>).skillsDir).toBeUndefined();

    const result = await execute(ctx);
    expect(result.exitCode).toBe(0);
  });

  it("splits a comma-separated transforms string (as sent by the config-schema text field) into an array", async () => {
    fetchMock = setupFetchMock([assistantResponse("done")]);

    await execute(
      makeContext({
        config: { model: "x", apiKey: "k", transforms: "middle-out, foo" } as any,
      }),
    );

    const chatCall = fetchMock.calls.find((c) => c.path.endsWith("/chat/completions"));
    expect((chatCall!.body as any).transforms).toEqual(["middle-out", "foo"]);
  });

  it("returns errorCode missing_api_key when no apiKey/authToken/env var is available", async () => {
    fetchMock = setupFetchMock([assistantResponse("done")]);

    // No authToken means no PaperclipApi client either (tools disabled), so
    // there's nothing to mark the issue blocked with — the run just fails
    // cleanly with a missing_api_key error and never calls the model.
    const result = await execute(
      makeContext({ config: { model: "moonshotai/kimi-k2.6" } as any, authToken: undefined }),
    );

    expect(result.exitCode).toBe(1);
    expect(result.errorCode).toBe("missing_api_key");
    expect(result.errorMessage).toContain("LLM API key not found");
    expect(fetchMock.calls.some((c) => c.path.endsWith("/chat/completions"))).toBe(false);
    expect(fetchMock.calls.some((c) => c.path.startsWith("/api/issues"))).toBe(false);
  });

  it("disables tools and skips all issue writes when authToken is missing", async () => {
    fetchMock = setupFetchMock([assistantResponse("no tools available")]);

    const result = await execute(makeContext({ authToken: undefined }));

    expect(result.exitCode).toBe(0);
    // No PaperclipApi client is constructed without an authToken, so no
    // issue reads/writes should happen at all.
    expect(fetchMock.calls.some((c) => c.path.startsWith("/api/issues"))).toBe(false);
    // The chat/completions request should carry no tools.
    const chatCall = fetchMock.calls.find((c) => c.path.endsWith("/chat/completions"));
    expect((chatCall!.body as any).tools).toBeUndefined();
  });

  it("calls api.updateIssue and api.addIssueComment via the current adapter-utils API", async () => {
    fetchMock = setupFetchMock([assistantResponse("hello")]);

    await execute(makeContext());

    const issuePatchCalls = fetchMock.calls.filter(
      (c) => c.method === "PATCH" && c.path === "/api/issues/issue-1",
    );
    expect(issuePatchCalls.length).toBeGreaterThanOrEqual(1);
    expect(issuePatchCalls[0]!.body).toMatchObject({ status: "in_progress" });
    expect(issuePatchCalls.at(-1)!.body).toMatchObject({ status: "done" });

    const commentCalls = fetchMock.calls.filter(
      (c) => c.method === "POST" && c.path === "/api/issues/issue-1/comments",
    );
    expect(commentCalls.length).toBeGreaterThanOrEqual(1);
    expect(commentCalls[0]!.body).toMatchObject({ body: expect.stringContaining("hello") });
  });

  it("fails the run (does not silently report success) when the final disposition write can't be recorded, after one retry", async () => {
    // Regression guard for Paperclip's "missing_disposition" recovery flow:
    // it fires whenever a run reports success (exitCode 0 / run.status
    // "succeeded") but the issue never left in_progress — e.g. because the
    // final status PATCH lost a sameRunLock race (see checkoutIssue's doc
    // comment in paperclip-api.ts) and was silently swallowed. A run that
    // can't record its own disposition must report failure instead, so
    // Paperclip's normal run-failure handling takes over rather than its
    // ambiguous-success recovery nagging.
    fetchMock = setupFetchMock([assistantResponse("all done")]);
    const recordingFetch = globalThis.fetch;
    let finalStatusPatchAttempts = 0;
    globalThis.fetch = (async (input: any, init?: any) => {
      const url = typeof input === "string" ? input : input.url;
      const method = (init?.method || "GET").toUpperCase();
      if (method === "PATCH" && new URL(url).pathname === "/api/issues/issue-1") {
        const body = init?.body ? JSON.parse(String(init.body)) : undefined;
        if (body?.status === "done") {
          finalStatusPatchAttempts += 1;
          return new Response(JSON.stringify({ error: "Issue run ownership conflict" }), { status: 409 });
        }
      }
      return recordingFetch(input, init);
    }) as typeof fetch;

    const result = await execute(makeContext());

    expect(finalStatusPatchAttempts).toBe(2); // one retry after the first failure
    expect(result.exitCode).toBe(1);
    expect(result.errorCode).toBe("issue_status_update_failed");
    expect(result.errorMessage).toContain("Failed to record final issue status (done)");
  });

  it("returns an AdapterExecutionResult with the current schema (no removed fields)", async () => {
    fetchMock = setupFetchMock([assistantResponse("done")]);

    const result = await execute(makeContext());

    expect(result).toMatchObject({
      exitCode: 0,
      signal: null,
      timedOut: false,
    });
    // Removed legacy fields must not be set.
    expect((result as Record<string, unknown>).status).toBeUndefined();
    expect((result.usage as Record<string, unknown> | undefined)?.totalTokens).toBeUndefined();
    // costUsd lives on the result, not on usage.
    expect((result.usage as Record<string, unknown> | undefined)?.costUsd).toBeUndefined();
  });

  it("reports exitCode and marks the issue blocked when the model call fails", async () => {
    fetchMock = setupFetchMock([], { chatFailureStatus: 500 });

    const result = await execute(makeContext());

    expect(result.exitCode).toBe(1);
    const blocked = fetchMock.calls.find(
      (c) =>
        c.method === "PATCH" &&
        c.path === "/api/issues/issue-1" &&
        (c.body as any)?.status === "blocked",
    );
    expect(blocked).toBeDefined();
  });

  it("does not throw when baseUrl points at a non-OpenRouter endpoint, and skips the /generation cost fetch", async () => {
    fetchMock = setupFetchMock([assistantResponse("done")]);

    const result = await execute(
      makeContext({
        config: {
          model: "moonshotai/kimi-k2.6",
          baseUrl: "https://integrate.api.nvidia.com/v1",
          apiKey: "nvapi-test",
        } as any,
      }),
    );

    expect(result.exitCode).toBe(0);
    expect(result.provider).toBe("llm");
    expect(fetchMock.calls.some((c) => c.path.endsWith("/generation"))).toBe(false);
  });

  it("attempts the /generation cost lookup on OpenRouter and tolerates a 404", async () => {
    fetchMock = setupFetchMock([assistantResponse("done", { id: "gen-123" })]);

    const result = await execute(makeContext());

    expect(result.exitCode).toBe(0);
    expect(fetchMock.calls.some((c) => c.path.endsWith("/generation"))).toBe(true);
    expect(result.costUsd ?? null).toBeNull();
  }, 10000);

  it("falls back to a concise default prompt when the wake context is empty", async () => {
    fetchMock = setupFetchMock([assistantResponse("done")]);

    const result = await execute(makeContext({ context: {} }));

    expect(result.exitCode).toBe(0);
    const chatCall = fetchMock.calls.find((c) => c.path.endsWith("/chat/completions"));
    const messages = (chatCall!.body as any).messages as Array<{ role: string; content: string }>;
    const userMessage = messages.find((m) => m.role === "user")!;
    // 3-line fallback per the issue suggestion.
    expect(userMessage.content.split("\n").filter((l) => l.trim().length > 0).length).toBe(3);
    expect(userMessage.content).toContain("heartbeat");
  });

  it("dispatches tool calls to the scoped Paperclip-API tools (not shell/filesystem)", async () => {
    fetchMock = setupFetchMock([
      toolCallResponse([{ id: "call-1", name: "add_comment", args: { body: "progress update" } }]),
      assistantResponse("done"),
    ]);

    await execute(makeContext());

    const commentCalls = fetchMock.calls.filter(
      (c) => c.method === "POST" && c.path === "/api/issues/issue-1/comments",
    );
    // One from the tool call itself, one from the final-answer comment.
    expect(commentCalls.some((c) => (c.body as any)?.body === "progress update")).toBe(true);

    const secondChatCall = fetchMock.calls.filter((c) => c.path.endsWith("/chat/completions"))[1];
    const toolMessage = (secondChatCall!.body as any).messages.find((m: any) => m.role === "tool");
    expect(toolMessage).toBeDefined();
    expect(toolMessage.tool_call_id).toBe("call-1");
  });

  it("routes hire_agent through createApproval (not hireAgent) when autoApprove is unset", async () => {
    fetchMock = setupFetchMock([
      toolCallResponse([
        { id: "call-1", name: "hire_agent", args: { name: "Sam", role: "Engineer", mission: "Ship things" } },
      ]),
      assistantResponse("done"),
    ]);

    await execute(makeContext());

    const approvalCalls = fetchMock.calls.filter(
      (c) => c.method === "POST" && c.path === "/api/companies/company-1/approvals",
    );
    expect(approvalCalls.length).toBe(1);
    const hireCalls = fetchMock.calls.filter(
      (c) => c.method === "POST" && c.path === "/api/companies/company-1/agent-hires",
    );
    expect(hireCalls.length).toBe(0);
  });

  it("breaks the loop and blocks the issue after 3 identical repeat tool calls", async () => {
    const repeatedCall = toolCallResponse([{ id: "call-x", name: "list_agents", args: {} }]);
    fetchMock = setupFetchMock([repeatedCall, repeatedCall, repeatedCall]);

    const ctx = makeContext();
    const result = await execute(ctx);

    // The repeat-loop breaker is a soft stop (like max_turns): the run itself
    // didn't error, so exitCode stays 0, but the issue is blocked and the
    // transcript's "result" entry records the real outcome.
    expect(result.exitCode).toBe(0);
    const blocked = fetchMock.calls.find(
      (c) =>
        c.method === "PATCH" &&
        c.path === "/api/issues/issue-1" &&
        (c.body as any)?.status === "blocked",
    );
    expect(blocked).toBeDefined();
    expect((blocked!.body as any).statusReason).toContain("stuck in a retry loop");

    const resultEntry = findTranscriptResultEntry(ctx);
    expect(resultEntry?.subtype).toBe("repeat_loop");
  });

  it("stops at max_turns and blocks the issue with a reason", async () => {
    fetchMock = setupFetchMock([toolCallResponse([{ id: "call-1", name: "list_agents", args: {} }])]);

    const ctx = makeContext({ config: { model: "x", apiKey: "k", maxTurns: 1 } as any });
    const result = await execute(ctx);

    expect(result.exitCode).toBe(0);
    const blocked = fetchMock.calls.find(
      (c) =>
        c.method === "PATCH" &&
        c.path === "/api/issues/issue-1" &&
        (c.body as any)?.status === "blocked",
    );
    expect(blocked).toBeDefined();
    expect((blocked!.body as any).statusReason).toContain("max_turns");

    const resultEntry = findTranscriptResultEntry(ctx);
    expect(resultEntry?.subtype).toBe("max_turns");
  });
});

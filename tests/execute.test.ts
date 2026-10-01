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

  it("reconciles company-managed skills into the skills directory when config.paperclipRuntimeSkills is present", async () => {
    // Regression guard: enabling a skill in Paperclip's Skills panel appeared
    // to do nothing, because nothing in execute() ever materialized a
    // desired company-managed skill into the directory loadSkills() reads
    // from. The marker check (paperclipRuntimeSkills present at all) mirrors
    // the built-in hermes adapter's pattern and must not fire for calls that
    // never went through Paperclip's real runtime.
    fetchMock = setupFetchMock([assistantResponse("done")]);
    const skillsDir = fs.mkdtempSync(path.join(tmpDir, "skills-"));
    const sourceDir = fs.mkdtempSync(path.join(tmpDir, "skill-source-"));
    fs.writeFileSync(path.join(sourceDir, "SKILL.md"), "# Onboarding\n\nDo the thing.");

    const ctx = makeContext({
      config: {
        model: "x",
        apiKey: "k",
        skillsDir,
        paperclipRuntimeSkills: [{ key: "acme/onboarding", runtimeName: "onboarding", source: sourceDir }],
        paperclipSkillSync: { desiredSkills: ["acme/onboarding"] },
      } as any,
    });

    const result = await execute(ctx);

    expect(result.exitCode).toBe(0);
    expect(fs.existsSync(path.join(skillsDir, "onboarding"))).toBe(true);
    expect(fs.lstatSync(path.join(skillsDir, "onboarding")).isSymbolicLink()).toBe(true);
  });

  it("does not touch the filesystem for skills when config.paperclipRuntimeSkills is absent (direct/test calls)", async () => {
    fetchMock = setupFetchMock([assistantResponse("done")]);
    const skillsDir = fs.mkdtempSync(path.join(tmpDir, "skills-absent-"));

    await execute(makeContext({ config: { model: "x", apiKey: "k", skillsDir } as any }));

    expect(fs.readdirSync(skillsDir)).toEqual([]);
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

  it("posts the final assistant text as a comment but does NOT auto-mark the issue done, even after a disposition nudge goes unanswered", async () => {
    // Regression guard for a real incident: an agent's final text
    // explicitly said it was waiting on another agent's response, and the
    // old code marked the issue "done" anyway just because that turn had
    // no tool call. "The model stopped calling tools" is not a disposition
    // — only an explicit update_issue_status call (or Paperclip's own
    // missing_disposition recovery nagging the agent to make one) may set
    // a final status. A plain text reply must leave status untouched, even
    // once the in-run disposition nudge (see the next test) has fired and
    // the model still doesn't call the tool.
    fetchMock = setupFetchMock([
      assistantResponse("Waiting on a response from the Engineering agent before I can continue."),
      assistantResponse("Still waiting — nothing has changed since my last update."),
    ]);

    await execute(makeContext());

    const chatCalls = fetchMock.calls.filter((c) => c.path.endsWith("/chat/completions"));
    expect(chatCalls.length).toBe(2); // confirms the nudge actually fired and consumed a second turn

    const issuePatchCalls = fetchMock.calls.filter(
      (c) => c.method === "PATCH" && c.path === "/api/issues/issue-1",
    );
    // Only the initial "in_progress" checkout patch — nothing after.
    expect(issuePatchCalls.length).toBe(1);
    expect(issuePatchCalls[0]!.body).toMatchObject({ status: "in_progress" });
    expect(issuePatchCalls.some((c) => (c.body as any)?.status === "done")).toBe(false);

    const commentCalls = fetchMock.calls.filter(
      (c) => c.method === "POST" && c.path === "/api/issues/issue-1/comments",
    );
    expect(commentCalls.length).toBeGreaterThanOrEqual(1);
    expect(commentCalls[0]!.body).toMatchObject({ body: expect.stringContaining("Still waiting") });
  });

  it("still respects an explicit update_issue_status('done') call from the model", async () => {
    fetchMock = setupFetchMock([
      toolCallResponse([{ id: "call-1", name: "update_issue_status", args: { status: "done" } }]),
      assistantResponse("Shipped."),
    ]);

    await execute(makeContext());

    const issuePatchCalls = fetchMock.calls.filter(
      (c) => c.method === "PATCH" && c.path === "/api/issues/issue-1",
    );
    expect(issuePatchCalls.some((c) => (c.body as any)?.status === "done")).toBe(true);
  });

  it("treats update_issue with a status as the disposition (models confuse it with update_issue_status)", async () => {
    // Real incident: gpt-oss-120b sent update_issue({status:"done", comment})
    // eight times while its own reasoning said "use update_issue_status";
    // the repeat-loop guard then marked the finished issue blocked.
    fetchMock = setupFetchMock([
      toolCallResponse([{ id: "call-1", name: "update_issue", args: { status: "done", comment: "Verified." } }]),
      assistantResponse("Done."),
    ]);

    const result = await execute(makeContext());

    expect(result.exitCode).toBe(0);
    const chatCalls = fetchMock.calls.filter((c) => c.path.endsWith("/chat/completions"));
    expect(chatCalls.length).toBe(2); // no disposition nudge
    const issuePatchCalls = fetchMock.calls.filter(
      (c) => c.method === "PATCH" && c.path === "/api/issues/issue-1",
    );
    expect(issuePatchCalls.some((c) => (c.body as any)?.status === "done")).toBe(true);
    expect(issuePatchCalls.some((c) => (c.body as any)?.status === "blocked")).toBe(false);
  });

  it("nudges the model for a disposition when it stops without calling update_issue_status, and accepts one if given", async () => {
    // Real incident: a model's final comment confidently claimed "closed
    // done, verified in the API response" — but had never actually called
    // update_issue_status, leaving the issue in_progress. Paperclip's own
    // cross-run missing_disposition recovery kept re-triggering on the same
    // issue run after run without fixing the underlying habit. This nudge
    // gives the model one in-run chance to actually call the tool before
    // the run ends, instead of only relying on that slower, evidently
    // unreliable cross-run loop.
    fetchMock = setupFetchMock([
      assistantResponse("Closed out — everything's filed and done."), // no tool call: triggers the nudge
      toolCallResponse([{ id: "call-1", name: "update_issue_status", args: { status: "done" } }]),
      assistantResponse("Confirmed done."),
    ]);

    const result = await execute(makeContext());

    const chatCalls = fetchMock.calls.filter((c) => c.path.endsWith("/chat/completions"));
    expect(chatCalls.length).toBe(3);
    // The nudge is a plain user-role message, not a tool result — confirm it reached the model.
    const nudgedCallMessages = (chatCalls[1]!.body as any).messages as Array<{ role: string; content: string }>;
    expect(nudgedCallMessages.some((m) => m.role === "user" && m.content.includes("did not record a disposition"))).toBe(true);

    expect(result.exitCode).toBe(0);
    const issuePatchCalls = fetchMock.calls.filter(
      (c) => c.method === "PATCH" && c.path === "/api/issues/issue-1",
    );
    expect(issuePatchCalls.some((c) => (c.body as any)?.status === "done")).toBe(true);
  });

  it("fails the run (does not silently report success) when the final disposition write can't be recorded, after one retry", async () => {
    // Regression guard for Paperclip's "missing_disposition" recovery flow:
    // it fires whenever a run reports success (exitCode 0 / run.status
    // "succeeded") but the issue never left in_progress — e.g. because the
    // final status PATCH lost a sameRunLock race (see checkoutIssue's doc
    // comment in paperclip-api.ts) and was silently swallowed. A run that
    // can't record its own disposition must report failure instead, so
    // Paperclip's normal run-failure handling takes over rather than its
    // ambiguous-success recovery nagging. Uses the max_turns path (a
    // "blocked" disposition) since a plain completed run no longer writes
    // any status itself — see the "does NOT auto-mark the issue done" test.
    fetchMock = setupFetchMock([toolCallResponse([{ id: "call-1", name: "list_agents", args: {} }])]);
    const recordingFetch = globalThis.fetch;
    let finalStatusPatchAttempts = 0;
    globalThis.fetch = (async (input: any, init?: any) => {
      const url = typeof input === "string" ? input : input.url;
      const method = (init?.method || "GET").toUpperCase();
      if (method === "PATCH" && new URL(url).pathname === "/api/issues/issue-1") {
        const body = init?.body ? JSON.parse(String(init.body)) : undefined;
        if (body?.status === "blocked") {
          finalStatusPatchAttempts += 1;
          return new Response(JSON.stringify({ error: "Issue run ownership conflict" }), { status: 409 });
        }
      }
      return recordingFetch(input, init);
    }) as typeof fetch;

    const result = await execute(makeContext({ config: { model: "x", apiKey: "k", maxTurns: 1 } as any }));

    expect(finalStatusPatchAttempts).toBe(2); // one retry after the first failure
    expect(result.exitCode).toBe(1);
    expect(result.errorCode).toBe("issue_status_update_failed");
    expect(result.errorMessage).toContain("Failed to record final issue status (blocked)");
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
    // 4-line fallback: heartbeat notice, no-structured-context notice, the
    // check-for-a-prior-answer nudge (added alongside ask_user_questions so
    // a degraded/fallback wake doesn't blindly re-ask), and "take action".
    expect(userMessage.content.split("\n").filter((l) => l.trim().length > 0).length).toBe(4);
    expect(userMessage.content).toContain("heartbeat");
    expect(userMessage.content).toContain("list_comments");
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

  it("stops the turn right after ask_user_questions succeeds and leaves issue status untouched", async () => {
    // Regression guard, two bugs found live against a real Paperclip
    // instance:
    //  1. Before ask_user_questions existed, a model that wanted to ask a
    //     human a question had no tool for it, so it dumped the JSON as
    //     plain text, which got posted as a raw comment and the issue was
    //     wrongly marked "done".
    //  2. The first fix for #1 forced the issue to in_review, which
    //     Paperclip's own in_review review-path validator
    //     (assertInReviewReviewPath) rejected outright ("Agent-authored
    //     updates that move an issue to in_review must include a real
    //     review path"), hard-failing the run. It also let the model keep
    //     calling ask_user_questions again on the next turn — observed
    //     asking the same question three times in a row in production.
    // The fix: stop the tool loop the instant an interaction is created
    // (never let the model call it again in this run), and don't touch
    // issue status at all — Paperclip's missing_disposition recovery
    // already exempts any issue with a pending interaction
    // (hasPendingInteractionOrApproval in decideSuccessfulRunHandoff), so
    // there's nothing for the adapter to do.
    fetchMock = setupFetchMock([
      toolCallResponse([
        {
          id: "call-1",
          name: "ask_user_questions",
          args: { questions: [{ prompt: "Which environment should I deploy to?" }] },
        },
      ]),
      // Never consumed — the loop must stop before requesting another turn.
      assistantResponse("Asked the user which environment to deploy to."),
    ]);

    const result = await execute(makeContext());
    expect(result.exitCode).toBe(0);

    const chatCalls = fetchMock.calls.filter((c) => c.path.endsWith("/chat/completions"));
    expect(chatCalls.length).toBe(1); // no second round-trip after the tool call

    const interactionCalls = fetchMock.calls.filter(
      (c) => c.method === "POST" && c.path === "/api/issues/issue-1/interactions",
    );
    expect(interactionCalls.length).toBe(1);
    expect(interactionCalls[0]!.body).toMatchObject({ kind: "ask_user_questions" });

    const statusPatches = fetchMock.calls.filter(
      (c) => c.method === "PATCH" && c.path === "/api/issues/issue-1" && (c.body as any)?.status !== "in_progress",
    );
    expect(statusPatches.length).toBe(0);
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
    // A bare {status: "blocked"} is rejected by Paperclip (422) — it needs an
    // unblockDescriptor naming this agent, and the reason goes in `comment`
    // (statusReason isn't part of the issue-update schema).
    expect((blocked!.body as any).comment).toContain("stuck in a retry loop");
    expect((blocked!.body as any).unblockDescriptor).toEqual({
      owner: { agentId: "agent-1" },
      action: expect.stringContaining("stuck in a retry loop"),
    });
    expect((blocked!.body as any).statusReason).toBeUndefined();

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
    expect((blocked!.body as any).comment).toContain("max_turns");
    expect((blocked!.body as any).unblockDescriptor?.owner).toEqual({ agentId: "agent-1" });

    const resultEntry = findTranscriptResultEntry(ctx);
    expect(resultEntry?.subtype).toBe("max_turns");
  });

  // Wraps the recording mock so GET /api/issues/issue-1 reports a real status.
  function withIssueStatus(status: string) {
    const recordingFetch = globalThis.fetch;
    globalThis.fetch = (async (input: any, init?: any) => {
      const url = typeof input === "string" ? input : input.url;
      const method = (init?.method || "GET").toUpperCase();
      if (method === "GET" && new URL(url).pathname === "/api/issues/issue-1") {
        return new Response(JSON.stringify({ id: "issue-1", status }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return recordingFetch(input, init);
    }) as typeof fetch;
  }

  it("still nudges when the model marked a SUB-issue done but its own issue is still in_progress", async () => {
    // Regression guard: the nudge used to be skipped after ANY successful
    // update_issue_status call — including one on a different issue — so the
    // run ended with its own issue in_progress and Paperclip's
    // missing-disposition recovery fired.
    fetchMock = setupFetchMock([
      toolCallResponse([{ id: "c1", name: "update_issue_status", args: { issue_id: "issue-2", status: "done" } }]),
      assistantResponse("All wrapped up."),
      toolCallResponse([{ id: "c2", name: "update_issue_status", args: { status: "done" } }]),
      assistantResponse("Done."),
    ]);
    withIssueStatus("in_progress");

    await execute(makeContext());

    const chatCalls = fetchMock.calls.filter((c) => c.path.endsWith("/chat/completions"));
    const nudged = (chatCalls[2]!.body as any).messages as Array<{ role: string; content: string }>;
    expect(nudged.some((m) => m.role === "user" && m.content.includes("did not record a disposition"))).toBe(true);
  });

  it("does not nudge when Paperclip already reports the issue out of in_progress", async () => {
    fetchMock = setupFetchMock([assistantResponse("Done.")]);
    withIssueStatus("done");

    await execute(makeContext());

    expect(fetchMock.calls.filter((c) => c.path.endsWith("/chat/completions")).length).toBe(1);
  });

  it("renders Paperclip's disposition-recovery instruction on a successful-run handoff wake", async () => {
    // DEBA-39: the corrective handoff run looked like an ordinary wake, so the
    // model redid the whole task instead of recording a disposition.
    fetchMock = setupFetchMock([assistantResponse("ok")]);

    await execute(
      makeContext({
        context: {
          issueId: "issue-1",
          handoffRequired: true,
          wakeReason: "finish_successful_run_handoff",
          instruction: "## What happened\nYour last run on this issue ended successfully, but the issue is still `in_progress`.",
        },
      }),
    );

    const firstChat = fetchMock.calls.find((c) => c.path.endsWith("/chat/completions"))!;
    const userMsg = ((firstChat.body as any).messages as Array<{ role: string; content: string }>).find((m) => m.role === "user")!;
    expect(userMsg.content).toContain("DISPOSITION RECOVERY");
    expect(userMsg.content).toContain("Your last run on this issue ended successfully");
    expect(userMsg.content).toContain("unblock_action");
  });

  it("keeps the repeat-loop failure as the primary error when the blocked write also fails", async () => {
    const repeatedCall = toolCallResponse([{ id: "call-x", name: "list_agents", args: {} }]);
    fetchMock = setupFetchMock([repeatedCall, repeatedCall, repeatedCall]);
    const recordingFetch = globalThis.fetch;
    globalThis.fetch = (async (input: any, init?: any) => {
      const url = typeof input === "string" ? input : input.url;
      const method = (init?.method || "GET").toUpperCase();
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      if (method === "PATCH" && new URL(url).pathname === "/api/issues/issue-1" && body?.status === "blocked") {
        return new Response(JSON.stringify({ error: "Issue run ownership conflict" }), {
          status: 409,
          headers: { "content-type": "application/json" },
        });
      }
      return recordingFetch(input, init);
    }) as typeof fetch;

    const result = await execute(makeContext());

    expect(result.exitCode).toBe(1);
    expect(result.errorCode).toBe("tool_repeat_loop");
    expect(result.errorMessage).toMatch(/^Tool "list_agents" was called 3 times/);
    expect(result.errorMessage).toContain("Failed to record final issue status (blocked)");
    // The reason still lands on the issue as a standalone comment.
    const comments = fetchMock.calls.filter((c) => c.method === "POST" && c.path === "/api/issues/issue-1/comments");
    expect(comments.some((c) => String((c.body as any)?.body).includes("stuck in a retry loop"))).toBe(true);
  });

  it("skips the final-text comment when the model already commented on its issue", async () => {
    fetchMock = setupFetchMock([
      toolCallResponse([
        { id: "c1", name: "add_comment", args: { body: "Totals: 10 clicks." } },
        { id: "c2", name: "update_issue_status", args: { status: "done" } },
      ]),
      assistantResponse("Posted the totals and closed it."),
    ]);

    await execute(makeContext());

    const comments = fetchMock.calls.filter((c) => c.method === "POST" && c.path === "/api/issues/issue-1/comments");
    expect(comments.length).toBe(1);
    expect((comments[0]!.body as any).body).toBe("Totals: 10 clicks.");
  });

  it("exposes bound secrets from config.env via list_secrets/http_request, never PAPERCLIP_* keys or values", async () => {
    fetchMock = setupFetchMock([
      toolCallResponse([{ id: "c1", name: "list_secrets", args: {} }]),
      toolCallResponse([{ id: "c2", name: "update_issue_status", args: { status: "done" } }]),
      assistantResponse("ok"),
    ]);

    const ctx = makeContext({
      config: {
        model: "x",
        apiKey: "k",
        env: { UMAMI_API_KEY: "umami-secret-value", PAPERCLIP_API_KEY: "nope", PAPERCLIP_RUN_ID: "r" },
      } as any,
    });
    await execute(ctx);

    const firstChat = fetchMock.calls.find((c) => c.path.endsWith("/chat/completions"))!;
    const toolNames = ((firstChat.body as any).tools as Array<{ function: { name: string } }>).map((t) => t.function.name);
    expect(toolNames).toEqual(expect.arrayContaining(["list_secrets", "http_request"]));

    const secondChat = fetchMock.calls.filter((c) => c.path.endsWith("/chat/completions"))[1]!;
    const toolResult = ((secondChat.body as any).messages as Array<{ role: string; content: string }>).find((m) => m.role === "tool")!;
    expect(JSON.parse(toolResult.content)).toEqual({ secrets: ["UMAMI_API_KEY"] });

    const logged = (ctx.onLog as any).mock.calls.map((c: [string, string]) => c[1]).join("\n");
    expect(logged).toContain("UMAMI_API_KEY");
    expect(logged).not.toContain("umami-secret-value");
    for (const call of fetchMock.calls.filter((c) => c.path.endsWith("/chat/completions"))) {
      expect(JSON.stringify(call.body)).not.toContain("umami-secret-value");
    }
  });

  it("answers a call to a nonexistent shell tool with the available tools and an http_request hint", async () => {
    fetchMock = setupFetchMock([
      toolCallResponse([{ id: "c1", name: "bash", args: { command: "curl https://x" } }]),
      toolCallResponse([{ id: "c2", name: "update_issue_status", args: { status: "done" } }]),
      assistantResponse("ok"),
    ]);

    await execute(makeContext({ config: { model: "x", apiKey: "k", env: { K: "value-1234" } } as any }));

    const secondChat = fetchMock.calls.filter((c) => c.path.endsWith("/chat/completions"))[1]!;
    const toolResult = JSON.parse(
      ((secondChat.body as any).messages as Array<{ role: string; content: string }>).find((m) => m.role === "tool")!.content,
    );
    expect(toolResult.error).toBe("Unknown tool: bash");
    expect(toolResult.hint).toContain("http_request");
    expect(toolResult.availableTools).toEqual(expect.arrayContaining(["update_issue_status", "http_request"]));
  });

  it("picks up API-access secret bindings from GET /agents/me/secrets and fetches values on demand", async () => {
    // Oscar's GSC/Umami credentials are bound with "API access", which never
    // touches config.env — the adapter used to report them as unknown.
    fetchMock = setupFetchMock([
      toolCallResponse([
        {
          id: "c1",
          name: "http_request",
          args: { url: "https://umami.example.com/api/stats", headers: { "x-umami-api-key": "{{secret:UMAMI_API_KEY}}" } },
        },
      ]),
      toolCallResponse([{ id: "c2", name: "update_issue_status", args: { status: "done" } }]),
      assistantResponse("ok"),
    ]);
    const recordingFetch = globalThis.fetch;
    let umamiHeader: string | undefined;
    globalThis.fetch = (async (input: any, init?: any) => {
      const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
      const json = (body: unknown) =>
        new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
      if (url.pathname === "/api/agents/me/secrets") return json({ secrets: [{ key: "UMAMI_API_KEY" }] });
      if (url.pathname === "/api/agents/me/secrets/UMAMI_API_KEY/value") return json({ key: "UMAMI_API_KEY", value: "umami-live-value" });
      if (url.hostname === "umami.example.com") {
        umamiHeader = init?.headers?.["x-umami-api-key"];
        return json({ pageviews: 5, echoed: umamiHeader });
      }
      return recordingFetch(input, init);
    }) as typeof fetch;

    await execute(makeContext());

    expect(umamiHeader).toBe("umami-live-value");
    for (const call of fetchMock.calls.filter((c) => c.path.endsWith("/chat/completions"))) {
      expect(JSON.stringify(call.body)).not.toContain("umami-live-value");
    }
  });
});

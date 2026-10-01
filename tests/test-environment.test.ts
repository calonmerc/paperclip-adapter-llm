/**
 * testEnvironment() — Paperclip's hire wizard blocks "Finish setup" on a
 * `fail` result and has no field for our apiKey, so a missing key must warn.
 */

import { afterEach, describe, expect, it, vi } from "vitest";

import { testEnvironment } from "../src/server/test.js";

function stubModelsFetch(status: number, body: unknown = { data: [] }) {
  const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  }));
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function clearEnv() {
  for (const k of ["LLM_BASE_URL", "LLM_API_KEY", "OPENROUTER_API_KEY"]) vi.stubEnv(k, "");
}

function run(config: Record<string, unknown>) {
  return testEnvironment({ config } as never);
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("testEnvironment", () => {
  it("warns instead of failing when no key is set, and still checks the model", async () => {
    clearEnv();
    const fetchMock = stubModelsFetch(200, { data: [{ id: "z-ai/glm-5.3-flash", context_length: 128000 }] });

    const result = await run({ model: "z-ai/glm-5.3-flash" });

    expect(result.status).toBe("warn");
    expect(result.checks).toContainEqual(expect.objectContaining({ code: "llm_api_key_missing", level: "warn" }));
    expect(result.checks).toContainEqual(expect.objectContaining({ code: "llm_model_found" }));
    expect((fetchMock.mock.calls[0][1]?.headers as Record<string, string>).Authorization).toBeUndefined();
  });

  it("warns when the endpoint needs a key and none is set", async () => {
    clearEnv();
    stubModelsFetch(401, { error: "unauthorized" });

    const result = await run({ model: "m", baseUrl: "https://api.example.com/v1" });

    expect(result.status).toBe("warn");
    expect(result.checks).toContainEqual(expect.objectContaining({ code: "llm_api_key_required", level: "warn" }));
  });

  it("still fails when a key is set but rejected", async () => {
    clearEnv();
    stubModelsFetch(401, { error: "unauthorized" });

    const result = await run({ model: "m", apiKey: "sk-or-bad-key-1234" });

    expect(result.status).toBe("fail");
    expect(result.checks).toContainEqual(expect.objectContaining({ code: "llm_api_error", level: "error" }));
  });

  it("treats a missing key on localhost as informational", async () => {
    clearEnv();
    stubModelsFetch(200, { data: [{ id: "llama3" }] });

    const result = await run({ model: "llama3", baseUrl: "http://localhost:11434/v1" });

    expect(result.status).toBe("pass");
    expect(result.checks).toContainEqual(expect.objectContaining({ code: "llm_api_key_optional", level: "info" }));
  });
});

/**
 * listModels() / detectModel() — the model picker's data sources.
 *
 * Paperclip calls listModels() with no arguments, so the provider comes
 * from LLM_BASE_URL in the server env; the API key is optional.
 */

import { afterEach, describe, expect, it, vi } from "vitest";

import { listModels } from "../src/server/test.js";
import { detectModel } from "../src/server/index.js";

function stubModelsFetch(body: unknown, ok = true) {
  const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => ({
    ok,
    json: async () => body,
  }));
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function clearEnv() {
  for (const k of ["LLM_BASE_URL", "LLM_API_KEY", "OPENROUTER_API_KEY", "LLM_MODEL", "OPENROUTER_MODEL"]) {
    vi.stubEnv(k, "");
  }
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("listModels", () => {
  it("fetches /models from LLM_BASE_URL and sorts non-OpenRouter models by id", async () => {
    clearEnv();
    vi.stubEnv("LLM_BASE_URL", "https://integrate.api.nvidia.com/v1/");
    const fetchMock = stubModelsFetch({
      data: [{ id: "qwen/qwen3-coder" }, { id: "openai/gpt-oss-120b" }, { id: "" }],
    });

    const models = await listModels();

    expect(fetchMock.mock.calls[0][0]).toBe("https://integrate.api.nvidia.com/v1/models");
    expect(models).toEqual([
      { id: "openai/gpt-oss-120b", label: "openai/gpt-oss-120b" },
      { id: "qwen/qwen3-coder", label: "qwen/qwen3-coder" },
    ]);
  });

  it("works without an API key and sends no Authorization header", async () => {
    clearEnv();
    const fetchMock = stubModelsFetch({ data: [{ id: "a/b", name: "A B" }] });

    const models = await listModels();

    expect(fetchMock.mock.calls[0][0]).toBe("https://openrouter.ai/api/v1/models");
    const headers = fetchMock.mock.calls[0][1]?.headers as Record<string, string>;
    expect(headers.Authorization).toBeUndefined();
    expect(models).toEqual([{ id: "a/b", label: "A B" }]);
  });

  it("sends the Bearer key when LLM_API_KEY is set", async () => {
    clearEnv();
    vi.stubEnv("LLM_API_KEY", "nvapi-test");
    const fetchMock = stubModelsFetch({ data: [] });

    await listModels();

    const headers = fetchMock.mock.calls[0][1]?.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer nvapi-test");
  });

  it("an explicit baseUrl overrides LLM_BASE_URL", async () => {
    clearEnv();
    vi.stubEnv("LLM_BASE_URL", "https://integrate.api.nvidia.com/v1");
    const fetchMock = stubModelsFetch({ data: [] });

    await listModels("http://localhost:11434/v1");

    expect(fetchMock.mock.calls[0][0]).toBe("http://localhost:11434/v1/models");
  });

  it("returns [] on a non-OK response", async () => {
    clearEnv();
    stubModelsFetch({ error: "nope" }, false);
    expect(await listModels()).toEqual([]);
  });
});

describe("detectModel", () => {
  it("returns null when no model env var is set", async () => {
    clearEnv();
    expect(await detectModel()).toBeNull();
  });

  it("reports LLM_MODEL when set", async () => {
    clearEnv();
    vi.stubEnv("LLM_MODEL", "openai/gpt-oss-120b");
    expect(await detectModel()).toEqual({
      model: "openai/gpt-oss-120b",
      provider: "llm",
      source: "env:LLM_MODEL",
    });
  });
});

/**
 * Smoke tests for the package main entry. Without these, future entry-point
 * refactors silently regress fixes shipped in 0.2.1 (createServerAdapter
 * re-export) and earlier (type/label/models/agentConfigurationDoc on the
 * createServerAdapter() return).
 *
 * Per Paperclip's plugin loader contract, the package's main export must
 * provide createServerAdapter() and the result must satisfy
 * ServerAdapterModule (type + execute + testEnvironment, plus the optional
 * fields the UI relies on: models, agentConfigurationDoc, label).
 */

import { describe, expect, it } from "vitest";

describe("package main entry", () => {
  it("exports createServerAdapter() from dist/index.js", async () => {
    const mod: Record<string, unknown> = await import("../dist/index.js");
    expect(typeof mod.createServerAdapter).toBe("function");
  });

  it("createServerAdapter() returns a ServerAdapterModule with the expected fields", async () => {
    const mod: any = await import("../dist/index.js");
    const adapter = mod.createServerAdapter();
    expect(adapter.type).toBe("llm");
    expect(typeof adapter.label).toBe("string");
    expect(Array.isArray(adapter.models)).toBe(true);
    expect(typeof adapter.agentConfigurationDoc).toBe("string");
    expect(typeof adapter.execute).toBe("function");
    expect(typeof adapter.testEnvironment).toBe("function");
    expect(typeof adapter.getConfigSchema).toBe("function");
  });

  it("getConfigSchema() returns per-agent config fields (regression guard for GET .../config-schema 404ing)", async () => {
    // Paperclip's agent-config UI only renders per-agent config fields (API
    // key, base URL, system prompt, etc.) for adapters that implement
    // getConfigSchema — without it, GET /api/adapters/llm/config-schema 404s
    // and the "Configuration" section of the agent form stays empty.
    const mod: any = await import("../dist/index.js");
    const adapter = mod.createServerAdapter();
    const schema = await adapter.getConfigSchema();

    expect(Array.isArray(schema.fields)).toBe(true);
    const keys = schema.fields.map((f: { key: string }) => f.key);
    expect(keys).toEqual(expect.arrayContaining(["apiKey", "baseUrl", "maxTurns", "autoApprove", "skillsDir", "instructionsFilePath"]));
    // model is intentionally excluded — Paperclip's built-in model picker owns it.
    expect(keys).not.toContain("model");

    const apiKeyField = schema.fields.find((f: { key: string }) => f.key === "apiKey");
    expect(apiKeyField?.meta?.secret).toBe(true);
  });

  it("re-exports the resolveEndpoints helper", async () => {
    const mod: any = await import("../dist/index.js");
    expect(typeof mod.resolveEndpoints).toBe("function");
    expect(mod.resolveEndpoints().base).toBe("https://openrouter.ai/api/v1");
  });
});

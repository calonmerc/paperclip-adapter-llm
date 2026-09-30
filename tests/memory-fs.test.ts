/**
 * Unit tests for src/server/memory-fs.ts — now read-only access to the
 * retired memory_fs storage, used only to migrate it into Library
 * documents. Every read is confined to one resolved root via
 * resolveSafePath(), so these tests still check that boundary holds.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  resolveMemoryRoot,
  resolveSafePath,
  readMemoryFile,
  listMemoryFiles,
} from "../src/server/memory-fs.js";

let homesRoot: string;

beforeEach(() => {
  homesRoot = fs.mkdtempSync(path.join(os.tmpdir(), "llm-adapter-homes-"));
});

afterEach(() => {
  fs.rmSync(homesRoot, { recursive: true, force: true });
});

function seed(rel: string, content: string) {
  const target = path.join(homesRoot, rel);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content);
}

describe("resolveMemoryRoot", () => {
  it("gives two different agents in the same company different private roots", () => {
    const config = { agentHomeDir: homesRoot };
    const a = resolveMemoryRoot(config, "private", { agentId: "agent-a", companyId: "company-1" });
    const b = resolveMemoryRoot(config, "private", { agentId: "agent-b", companyId: "company-1" });
    expect(a).not.toBe(b);
  });

  it("gives two different agents in the same company the SAME shared root", () => {
    const config = { agentHomeDir: homesRoot };
    const a = resolveMemoryRoot(config, "shared", { agentId: "agent-a", companyId: "company-1" });
    const b = resolveMemoryRoot(config, "shared", { agentId: "agent-b", companyId: "company-1" });
    expect(a).toBe(b);
  });

  it("gives two different companies different shared roots", () => {
    const config = { agentHomeDir: homesRoot };
    const a = resolveMemoryRoot(config, "shared", { agentId: "agent-a", companyId: "company-1" });
    const b = resolveMemoryRoot(config, "shared", { agentId: "agent-a", companyId: "company-2" });
    expect(a).not.toBe(b);
  });
});

describe("resolveSafePath", () => {
  const root = "/tmp/example-root";

  it("resolves an ordinary relative path under the root", () => {
    expect(resolveSafePath(root, "notes/today.md")).toBe(path.join(root, "notes/today.md"));
  });

  it("rejects ../ traversal out of the root", () => {
    expect(() => resolveSafePath(root, "../../etc/passwd")).toThrow(/outside the allowed directory/);
  });

  it("rejects an absolute path override attempt", () => {
    expect(() => resolveSafePath(root, "/etc/passwd")).toThrow(/outside the allowed directory/);
  });

  it("rejects a deeply nested ../ that still escapes", () => {
    expect(() => resolveSafePath(root, "a/b/../../../c")).toThrow(/outside the allowed directory/);
  });

  it("allows resolving the root itself", () => {
    expect(resolveSafePath(root, ".")).toBe(root);
  });

  it("rejects an empty path", () => {
    expect(() => resolveSafePath(root, "")).toThrow(/path is required/);
  });
});

describe("readMemoryFile", () => {
  it("reads a nested file", async () => {
    seed("life/projects/acme/summary.md", "# Acme\n\nStatus: active");
    expect(await readMemoryFile(homesRoot, "life/projects/acme/summary.md")).toBe("# Acme\n\nStatus: active");
  });

  it("rejects reads that would escape the root", async () => {
    await expect(readMemoryFile(homesRoot, "../outside.md")).rejects.toThrow(/outside the allowed directory/);
  });

  it("rejects reading a file that doesn't exist", async () => {
    await expect(readMemoryFile(homesRoot, "missing.md")).rejects.toThrow(/not found/i);
  });
});

describe("listMemoryFiles", () => {
  it("lists nested files and directories with correct types", async () => {
    seed("memory/2026-09-29.md", "notes");
    seed("life/areas/people/kyle/summary.md", "kyle notes");

    const entries = await listMemoryFiles(homesRoot, ".");
    const paths = entries.map((e) => e.path).sort();
    expect(paths).toContain("memory/2026-09-29.md");
    expect(paths).toContain("life/areas/people/kyle/summary.md");
    expect(paths).toContain("life");
    const file = entries.find((e) => e.path === "memory/2026-09-29.md");
    expect(file?.type).toBe("file");
    const dir = entries.find((e) => e.path === "life");
    expect(dir?.type).toBe("directory");
  });

  it("returns an empty list for a directory that doesn't exist yet", async () => {
    const entries = await listMemoryFiles(homesRoot, "nope");
    expect(entries).toEqual([]);
  });
});

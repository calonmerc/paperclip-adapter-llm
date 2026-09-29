/**
 * Unit tests for src/server/memory-fs.ts — scoped file-based memory added so
 * llm-adapter agents can actually use skills like para-memory-files, which
 * expect real file read/write (private "$AGENT_HOME" notes) plus a shared
 * area other agents can read (e.g. its plans/ convention). This is NOT the
 * unsandboxed filesystem access removed in the 0.3.0 security fix — every
 * path is confined to one resolved root via resolveSafePath(), so these
 * tests focus heavily on that boundary actually holding.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  resolveMemoryRoot,
  resolveSafePath,
  readMemoryFile,
  writeMemoryFile,
  listMemoryFiles,
  searchMemoryFiles,
} from "../src/server/memory-fs.js";

let homesRoot: string;

beforeEach(() => {
  homesRoot = fs.mkdtempSync(path.join(os.tmpdir(), "llm-adapter-homes-"));
});

afterEach(() => {
  fs.rmSync(homesRoot, { recursive: true, force: true });
});

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

describe("read/writeMemoryFile", () => {
  it("round-trips content and creates parent directories as needed", async () => {
    await writeMemoryFile(homesRoot, "life/projects/acme/summary.md", "# Acme\n\nStatus: active");
    const content = await readMemoryFile(homesRoot, "life/projects/acme/summary.md");
    expect(content).toBe("# Acme\n\nStatus: active");
  });

  it("rejects writes that would escape the root", async () => {
    await expect(writeMemoryFile(homesRoot, "../outside.md", "nope")).rejects.toThrow(/outside the allowed directory/);
  });

  it("rejects reading a file that doesn't exist", async () => {
    await expect(readMemoryFile(homesRoot, "missing.md")).rejects.toThrow(/not found/i);
  });

  it("rejects a write over the size cap", async () => {
    const big = "x".repeat(1_000_001);
    await expect(writeMemoryFile(homesRoot, "big.md", big)).rejects.toThrow(/too large/i);
  });
});

describe("listMemoryFiles", () => {
  it("lists nested files and directories with correct types", async () => {
    await writeMemoryFile(homesRoot, "memory/2026-09-29.md", "notes");
    await writeMemoryFile(homesRoot, "life/areas/people/kyle/summary.md", "kyle notes");

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

describe("searchMemoryFiles", () => {
  it("finds a case-insensitive keyword match with line context across files", async () => {
    await writeMemoryFile(homesRoot, "memory/2026-09-29.md", "Talked to Kyle about the Q4 roadmap.");
    await writeMemoryFile(homesRoot, "life/areas/people/kyle/summary.md", "Kyle prefers async updates.");

    const matches = await searchMemoryFiles(homesRoot, "kyle");

    expect(matches.length).toBe(2);
    expect(matches.some((m) => m.path === "memory/2026-09-29.md")).toBe(true);
    expect(matches.some((m) => m.path === "life/areas/people/kyle/summary.md")).toBe(true);
  });

  it("returns no matches for a keyword that isn't present", async () => {
    await writeMemoryFile(homesRoot, "memory/2026-09-29.md", "Nothing relevant here.");
    const matches = await searchMemoryFiles(homesRoot, "unicorn");
    expect(matches).toEqual([]);
  });
});

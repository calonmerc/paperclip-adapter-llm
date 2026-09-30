/**
 * READ-ONLY access to the retired memory_fs storage, used solely by the
 * one-time migration into Company Library documents (see library.ts).
 *
 * memory_fs used to be a tool: plain files under a server directory
 * (private per agent, shared per company) that no human could see in the
 * Paperclip UI. It was removed so that every piece of agent storage is a
 * visible, revisioned Paperclip document. Nothing in this adapter writes
 * here anymore; this module only locates and reads what's left.
 *
 * Every read is confined to one resolved root via resolveSafePath().
 */

import fs from "node:fs/promises";
import path from "node:path";

export type MemoryScope = "private" | "shared";

const MAX_FILE_BYTES = 1_000_000; // 1MB per file — generous for markdown/yaml notes, not a data dump target
const MAX_LIST_ENTRIES = 500;

function sanitizeId(id: string): string {
  // companyId/agentId are UUIDs in practice, but never trust that blindly
  // when building a filesystem path from them.
  return id.replace(/[^a-zA-Z0-9_-]/g, "_") || "unknown";
}

function resolveHomesRoot(config: Record<string, unknown>): string {
  const configured = typeof config.agentHomeDir === "string" && config.agentHomeDir.trim() ? config.agentHomeDir.trim() : null;
  if (configured) return configured;
  const envDir = process.env.PAPERCLIP_AGENT_HOME_DIR?.trim();
  if (envDir) return envDir;
  const home = process.env.HOME || process.env.USERPROFILE || ".";
  return path.join(home, ".paperclip-llm-adapter", "homes");
}

export function resolveMemoryRoot(
  config: Record<string, unknown>,
  scope: MemoryScope,
  input: { agentId: string; companyId: string },
): string {
  const homesRoot = resolveHomesRoot(config);
  const companyDir = path.join(homesRoot, sanitizeId(input.companyId));
  return scope === "private"
    ? path.join(companyDir, "agents", sanitizeId(input.agentId))
    : path.join(companyDir, "shared");
}

/**
 * Resolve a model-supplied relative path against `root`, rejecting any
 * result that would land outside it. This is the sole security boundary
 * for every function below — every one of them routes through this first.
 */
export function resolveSafePath(root: string, relPath: string): string {
  const trimmed = (relPath ?? "").trim();
  if (!trimmed) throw new Error("path is required.");
  const resolved = path.resolve(root, trimmed);
  const rel = path.relative(root, resolved);
  if (rel === "" ) return resolved; // root itself
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new Error(`Path "${relPath}" is outside the allowed directory.`);
  }
  return resolved;
}

export async function readMemoryFile(root: string, relPath: string): Promise<string> {
  const target = resolveSafePath(root, relPath);
  const stat = await fs.stat(target).catch(() => null);
  if (!stat) throw new Error(`File not found: ${relPath}`);
  if (!stat.isFile()) throw new Error(`Not a file: ${relPath}`);
  if (stat.size > MAX_FILE_BYTES) {
    throw new Error(`File too large to read (${stat.size} bytes, limit ${MAX_FILE_BYTES}): ${relPath}`);
  }
  return fs.readFile(target, "utf8");
}

export interface MemoryListEntry {
  path: string;
  type: "file" | "directory";
  bytes?: number;
}

export async function listMemoryFiles(root: string, relPath: string): Promise<MemoryListEntry[]> {
  const target = resolveSafePath(root, relPath || ".");
  const results: MemoryListEntry[] = [];

  async function walk(dir: string, prefix: string): Promise<void> {
    if (results.length >= MAX_LIST_ENTRIES) return;
    let entries: import("node:fs").Dirent[];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (results.length >= MAX_LIST_ENTRIES) return;
      const entryPath = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        results.push({ path: entryPath, type: "directory" });
        await walk(path.join(dir, entry.name), entryPath);
      } else if (entry.isFile()) {
        const stat = await fs.stat(path.join(dir, entry.name)).catch(() => null);
        results.push({ path: entryPath, type: "file", bytes: stat?.size });
      }
    }
  }

  const stat = await fs.stat(target).catch(() => null);
  if (!stat) return [];
  if (stat.isFile()) {
    return [{ path: relPath, type: "file", bytes: stat.size }];
  }
  await walk(target, relPath === "." || !relPath ? "" : relPath);
  return results;
}

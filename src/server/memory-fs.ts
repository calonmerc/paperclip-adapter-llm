/**
 * Scoped file-based memory for skills like para-memory-files that expect
 * real file read/write (and, in that skill's case, a `qmd` shell command
 * for semantic search — which we do not provide; see search()).
 *
 * Two isolated roots per company:
 *   - private: one directory per agent, e.g. $AGENT_HOME in the skill's own
 *     terms — only that agent's tool calls can read/write it.
 *   - shared: one directory per company, shared by every llm-adapter agent
 *     in it — for things para-memory-files explicitly wants agents to
 *     share, like plans/.
 *
 * This is NOT a restoration of the unsandboxed CLI tools removed in the
 * 0.3.0 security fix (arbitrary path read/write/exec, no root). Every
 * operation here is confined to one resolved root directory — private or
 * shared — via resolveSafePath(), which rejects any relative path that
 * would resolve outside that root (../ traversal, absolute-path override,
 * symlink components are not specially followed since we only ever
 * fs.mkdir/writeFile/readFile the resolved path itself). There is no shell
 * execution anywhere in this file.
 */

import fs from "node:fs/promises";
import path from "node:path";

export type MemoryScope = "private" | "shared";

const MAX_FILE_BYTES = 1_000_000; // 1MB per file — generous for markdown/yaml notes, not a data dump target
const MAX_LIST_ENTRIES = 500;
const MAX_SEARCH_MATCHES = 50;

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

export async function writeMemoryFile(root: string, relPath: string, content: string): Promise<void> {
  const target = resolveSafePath(root, relPath);
  const bytes = Buffer.byteLength(content, "utf8");
  if (bytes > MAX_FILE_BYTES) {
    throw new Error(`Content too large to write (${bytes} bytes, limit ${MAX_FILE_BYTES}): ${relPath}`);
  }
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, content, "utf8");
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

export interface MemorySearchMatch {
  path: string;
  line: number;
  text: string;
}

/**
 * Plain substring/keyword search across every file in the tree — the
 * closest safe equivalent to para-memory-files' `qmd` recall commands
 * without shelling out to an external binary. Not semantic search: no
 * embeddings, no reranking, just case-insensitive substring matching with
 * line context. Good enough to find "what did I write about X" in a
 * personal notes tree; a real qmd install is still strictly better if the
 * operator has one and wires it in themselves.
 */
export async function searchMemoryFiles(root: string, query: string): Promise<MemorySearchMatch[]> {
  const needle = query.trim().toLowerCase();
  if (!needle) throw new Error("query is required.");
  const files = await listMemoryFiles(root, ".");
  const matches: MemorySearchMatch[] = [];

  for (const entry of files) {
    if (entry.type !== "file") continue;
    if (matches.length >= MAX_SEARCH_MATCHES) break;
    let content: string;
    try {
      content = await readMemoryFile(root, entry.path);
    } catch {
      continue;
    }
    const lines = content.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      if (matches.length >= MAX_SEARCH_MATCHES) break;
      if (lines[i].toLowerCase().includes(needle)) {
        matches.push({ path: entry.path, line: i + 1, text: lines[i].trim().slice(0, 300) });
      }
    }
  }

  return matches;
}

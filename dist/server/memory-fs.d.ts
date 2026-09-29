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
export type MemoryScope = "private" | "shared";
export declare function resolveMemoryRoot(config: Record<string, unknown>, scope: MemoryScope, input: {
    agentId: string;
    companyId: string;
}): string;
/**
 * Resolve a model-supplied relative path against `root`, rejecting any
 * result that would land outside it. This is the sole security boundary
 * for every function below — every one of them routes through this first.
 */
export declare function resolveSafePath(root: string, relPath: string): string;
export declare function readMemoryFile(root: string, relPath: string): Promise<string>;
export declare function writeMemoryFile(root: string, relPath: string, content: string): Promise<void>;
export interface MemoryListEntry {
    path: string;
    type: "file" | "directory";
    bytes?: number;
}
export declare function listMemoryFiles(root: string, relPath: string): Promise<MemoryListEntry[]>;
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
export declare function searchMemoryFiles(root: string, query: string): Promise<MemorySearchMatch[]>;
//# sourceMappingURL=memory-fs.d.ts.map
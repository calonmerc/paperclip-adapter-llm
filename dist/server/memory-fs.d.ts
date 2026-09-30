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
export interface MemoryListEntry {
    path: string;
    type: "file" | "directory";
    bytes?: number;
}
export declare function listMemoryFiles(root: string, relPath: string): Promise<MemoryListEntry[]>;
//# sourceMappingURL=memory-fs.d.ts.map
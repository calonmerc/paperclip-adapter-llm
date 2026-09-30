/**
 * The company Library: one long-lived, unassigned Paperclip issue whose
 * documents hold everything agents share across tasks (running logs like a
 * content log, brief backlogs, drafts, reference notes).
 *
 * Why an issue: every issue document is visible in the web UI — on the issue
 * and in the company-wide Artifacts view — with full revision history. The
 * old memory_fs tool wrote plain files to a server directory nobody could
 * see; this replaces it so there is no agent storage a human can't inspect.
 *
 * Why unassigned: Paperclip lets any agent write documents on an unassigned
 * issue (an assigned one is owned by its assignee), and an unassigned
 * backlog issue never triggers heartbeats or disposition recovery.
 */
import type { PaperclipApi } from "./paperclip-api.js";
import { type MemoryScope } from "./memory-fs.js";
export declare const LIBRARY_ISSUE_TITLE = "Company Library";
export declare const LIBRARY_ISSUE_DESCRIPTION: string;
export declare const MIGRATION_MARKER = ".migrated-to-paperclip-documents.json";
export interface LibraryIssue {
    id: string;
    identifier: string | null;
}
type LibraryApi = Pick<PaperclipApi, "getIssue" | "listCompanyIssues" | "createIssue" | "listIssueDocuments" | "upsertIssueDocument">;
/** Documents require a lowercase [a-z0-9_-] key of at most 64 chars. */
export declare function slugifyDocumentKey(raw: string): string;
/**
 * Stable document key for a migrated memory file. Long paths are truncated
 * with a short hash suffix so two different paths can't collapse to one key.
 */
export declare function migratedDocumentKey(relPath: string, prefix?: string): string;
/**
 * Resolves (and on first use creates) the Library issue, once per run.
 * `override` (adapterConfig.libraryIssue — an id or identifier like
 * "DEBA-50") pins it explicitly and skips discovery.
 */
export declare class LibraryResolver {
    private readonly api;
    private readonly companyId;
    private readonly override;
    private pending;
    constructor(api: LibraryApi, companyId: string, override?: string | null);
    get(): Promise<LibraryIssue>;
    private resolve;
}
export interface MigrationResult {
    migrated: Array<{
        scope: MemoryScope;
        path: string;
        key: string;
    }>;
    skipped: number;
    library: LibraryIssue | null;
}
/**
 * Copy any memory_fs files (the company's shared scope plus this agent's
 * private scope) that haven't been migrated yet into Library documents.
 * Source files are never deleted; a marker file in each scope root records
 * what was copied so later runs skip it. Keys that already exist on the
 * Library (another agent migrated the shared scope first) are recorded as
 * done without being overwritten.
 */
export declare function migrateMemoryToLibrary(input: {
    api: LibraryApi;
    library: LibraryResolver;
    config: Record<string, unknown>;
    companyId: string;
    agentId: string;
    agentName: string;
}): Promise<MigrationResult>;
export {};
//# sourceMappingURL=library.d.ts.map
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
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { listMemoryFiles, readMemoryFile, resolveMemoryRoot } from "./memory-fs.js";
export const LIBRARY_ISSUE_TITLE = "Company Library";
export const LIBRARY_ISSUE_DESCRIPTION = "Shared documents every agent reads and writes: running logs, brief backlogs, drafts, reference notes. " +
    "Kept unassigned on purpose — it is storage, not a task. Managed by the LLM adapter's `library` tool.";
export const MIGRATION_MARKER = ".migrated-to-paperclip-documents.json";
const MAX_KEY_LENGTH = 64;
const LIST_PAGE_SIZE = 100;
const LIST_MAX_PAGES = 20;
/** Documents require a lowercase [a-z0-9_-] key of at most 64 chars. */
export function slugifyDocumentKey(raw) {
    const slug = raw
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9_-]+/g, "-")
        .replace(/^-+|-+$/g, "");
    return (slug || "document").slice(0, MAX_KEY_LENGTH).replace(/-+$/, "") || "document";
}
/**
 * Stable document key for a migrated memory file. Long paths are truncated
 * with a short hash suffix so two different paths can't collapse to one key.
 */
export function migratedDocumentKey(relPath, prefix = "") {
    const base = `${prefix ? `${prefix}-` : ""}${relPath.replace(/\.md$/i, "")}`;
    const slug = base
        .toLowerCase()
        .replace(/[^a-z0-9_-]+/g, "-")
        .replace(/^-+|-+$/g, "");
    if (slug.length <= MAX_KEY_LENGTH)
        return slug || "document";
    const hash = crypto.createHash("sha1").update(relPath).digest("hex").slice(0, 8);
    return `${slug.slice(0, MAX_KEY_LENGTH - 9).replace(/-+$/, "")}-${hash}`;
}
function asIssueList(value) {
    if (Array.isArray(value))
        return value;
    const items = value?.items ?? value?.issues;
    return Array.isArray(items) ? items : [];
}
function toLibraryIssue(issue) {
    return {
        id: String(issue.id),
        identifier: typeof issue.identifier === "string" ? issue.identifier : null,
    };
}
/** Oldest non-cancelled unassigned issue titled exactly LIBRARY_ISSUE_TITLE. */
async function findLibraryIssue(api, companyId) {
    const matches = [];
    for (let page = 0; page < LIST_MAX_PAGES; page++) {
        const rows = asIssueList(await api.listCompanyIssues(companyId, {
            assigneeAgentId: "null",
            limit: String(LIST_PAGE_SIZE),
            offset: String(page * LIST_PAGE_SIZE),
        }));
        for (const row of rows) {
            if (row.title === LIBRARY_ISSUE_TITLE && row.status !== "cancelled" && typeof row.id === "string") {
                matches.push(row);
            }
        }
        if (rows.length < LIST_PAGE_SIZE)
            break;
    }
    if (matches.length === 0)
        return null;
    // Two agents racing on first use can each create one; everyone converges
    // on the oldest so the duplicate simply stays empty.
    matches.sort((a, b) => Number(a.issueNumber ?? Infinity) - Number(b.issueNumber ?? Infinity));
    return toLibraryIssue(matches[0]);
}
/**
 * Resolves (and on first use creates) the Library issue, once per run.
 * `override` (adapterConfig.libraryIssue — an id or identifier like
 * "DEBA-50") pins it explicitly and skips discovery.
 */
export class LibraryResolver {
    api;
    companyId;
    override;
    pending = null;
    constructor(api, companyId, override = null) {
        this.api = api;
        this.companyId = companyId;
        this.override = override;
    }
    get() {
        if (!this.pending) {
            this.pending = this.resolve().catch((err) => {
                this.pending = null; // allow a later retry in the same run
                throw err;
            });
        }
        return this.pending;
    }
    async resolve() {
        if (this.override)
            return toLibraryIssue(await this.api.getIssue(this.override));
        const existing = await findLibraryIssue(this.api, this.companyId);
        if (existing)
            return existing;
        await this.api.createIssue(this.companyId, {
            title: LIBRARY_ISSUE_TITLE,
            description: LIBRARY_ISSUE_DESCRIPTION,
            status: "backlog",
        });
        const created = await findLibraryIssue(this.api, this.companyId);
        if (!created)
            throw new Error("Created the Company Library issue but could not find it afterwards.");
        return created;
    }
}
function documentKeys(value) {
    const list = Array.isArray(value)
        ? value
        : Array.isArray(value?.documents)
            ? value.documents
            : [];
    const keys = new Set();
    for (const doc of list) {
        const key = doc?.key;
        if (typeof key === "string")
            keys.add(key);
    }
    return keys;
}
async function readMarker(root) {
    try {
        const parsed = JSON.parse(await fs.readFile(path.join(root, MIGRATION_MARKER), "utf8"));
        return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
    }
    catch {
        return {};
    }
}
/**
 * Copy any memory_fs files (the company's shared scope plus this agent's
 * private scope) that haven't been migrated yet into Library documents.
 * Source files are never deleted; a marker file in each scope root records
 * what was copied so later runs skip it. Keys that already exist on the
 * Library (another agent migrated the shared scope first) are recorded as
 * done without being overwritten.
 */
export async function migrateMemoryToLibrary(input) {
    const result = { migrated: [], skipped: 0, library: null };
    let existingKeys = null;
    for (const scope of ["shared", "private"]) {
        const root = resolveMemoryRoot(input.config, scope, { agentId: input.agentId, companyId: input.companyId });
        const stat = await fs.stat(root).catch(() => null);
        if (!stat?.isDirectory())
            continue;
        const files = (await listMemoryFiles(root, ".")).filter((e) => e.type === "file" && path.basename(e.path) !== MIGRATION_MARKER);
        const marker = await readMarker(root);
        const pending = files.filter((f) => !(f.path in marker));
        if (pending.length === 0)
            continue;
        const library = await input.library.get();
        result.library = library;
        existingKeys ??= documentKeys(await input.api.listIssueDocuments(library.id));
        const prefix = scope === "private" ? `notes-${slugifyDocumentKey(input.agentName)}` : "";
        for (const file of pending) {
            const key = migratedDocumentKey(file.path, prefix);
            if (!existingKeys.has(key)) {
                const body = await readMemoryFile(root, file.path);
                if (!body.trim()) {
                    result.skipped += 1;
                    marker[file.path] = { skipped: "empty" };
                    continue;
                }
                await input.api.upsertIssueDocument(library.id, key, {
                    title: scope === "private" ? `${input.agentName} notes: ${file.path}` : file.path,
                    format: "markdown",
                    body,
                    changeSummary: `Migrated from hidden memory_fs storage (${scope}: ${file.path})`,
                });
                existingKeys.add(key);
                result.migrated.push({ scope, path: file.path, key });
            }
            else {
                result.skipped += 1;
            }
            marker[file.path] = { key, issue: library.identifier ?? library.id, at: new Date().toISOString() };
        }
        await fs.writeFile(path.join(root, MIGRATION_MARKER), JSON.stringify(marker, null, 2), "utf8");
    }
    return result;
}
//# sourceMappingURL=library.js.map
/**
 * Server barrel for the OpenRouter adapter.
 *
 * Exposes everything Paperclip's server-side registry expects from a
 * fully-featured adapter:
 *   - execute             — the agent run loop (tool-calling)
 *   - testEnvironment     — env diagnostics + model fetch
 *   - sessionCodec        — persist/restore lastGenerationId across heartbeats
 *   - detectModel         — read OPENROUTER_MODEL env if present
 *   - listSkills          — minimal stub (filesystem scan)
 *   - syncSkills          — no-op (skills are managed externally)
 *
 * Optional hooks not implemented (deferred to v3):
 *   - getQuotaWindows     — OpenRouter exposes /key endpoint, can be added
 *   - onHireApproved      — only used by cloud adapters
 */
import path from "node:path";
import fs from "node:fs/promises";
import { execute } from "./execute.js";
import { testEnvironment, listModels, listOpenRouterModels } from "./test.js";
import { getConfigSchema } from "./config-schema.js";
import { type, label, models, agentConfigurationDoc } from "../index.js";
export { execute, testEnvironment, listModels, listOpenRouterModels, getConfigSchema };
// ----- sessionCodec -----
/**
 * OpenRouter doesn't have first-class server-side sessions; we persist the
 * last generation id so the run viewer can show a stable display id and
 * future versions can chain conversations across heartbeats.
 */
export const sessionCodec = {
    deserialize(raw) {
        if (!raw || typeof raw !== "object")
            return null;
        const obj = raw;
        const id = typeof obj.lastGenerationId === "string" ? obj.lastGenerationId : null;
        if (!id)
            return null;
        return { lastGenerationId: id };
    },
    serialize(params) {
        if (!params || typeof params !== "object")
            return null;
        const id = typeof params.lastGenerationId === "string" ? params.lastGenerationId : null;
        if (!id)
            return null;
        return { lastGenerationId: id };
    },
    getDisplayId(params) {
        if (!params || typeof params !== "object")
            return null;
        const id = params.lastGenerationId;
        return typeof id === "string" ? id : null;
    },
};
// ----- detectModel -----
/**
 * Best-effort detection: read OPENROUTER_MODEL or fall back to "openrouter/auto".
 * Other adapters read from on-disk CLI configs; OpenRouter has none, so env
 * is the only meaningful source.
 */
export async function detectModel() {
    const fromLlm = process.env.LLM_MODEL;
    if (fromLlm && fromLlm.trim().length > 0) {
        return { model: fromLlm.trim(), provider: "llm", source: "env:LLM_MODEL" };
    }
    const fromEnv = process.env.OPENROUTER_MODEL;
    if (fromEnv && fromEnv.trim().length > 0) {
        return { model: fromEnv.trim(), provider: "llm", source: "env:OPENROUTER_MODEL" };
    }
    return { model: "openrouter/auto", provider: "llm", source: "default" };
}
// ----- listSkills / syncSkills -----
/**
 * Minimal skill listing. We scan the same root our skill loader uses
 * (~/.openrouter-adapter/skills by default) and report each subdirectory
 * containing a SKILL.md as an external skill.
 *
 * v1 doesn't track desired-vs-installed because we don't sync from
 * Paperclip's managed skill store yet — that's a v3 feature.
 */
function defaultSkillsRoot() {
    const home = process.env.HOME || process.env.USERPROFILE || ".";
    return path.join(home, ".paperclip-llm-adapter", "skills");
}
export async function listSkills(_ctx) {
    const root = process.env.PAPERCLIP_SKILLS_DIR?.trim() || defaultSkillsRoot();
    const snapshot = {
        adapterType: "llm",
        supported: true,
        mode: "ephemeral",
        desiredSkills: [],
        entries: [],
        warnings: [],
    };
    let entries = [];
    try {
        entries = await fs.readdir(root, { withFileTypes: true });
    }
    catch {
        snapshot.warnings.push(`Skills root ${root} not present.`);
        return snapshot;
    }
    for (const entry of entries) {
        if (!entry.isDirectory() && !entry.isSymbolicLink())
            continue;
        const skillDir = path.join(root, entry.name);
        const skillMd = path.join(skillDir, "SKILL.md");
        let hasSkillMd = true;
        try {
            await fs.access(skillMd);
        }
        catch {
            hasSkillMd = false;
        }
        if (!hasSkillMd)
            continue;
        snapshot.entries.push({
            key: entry.name,
            runtimeName: entry.name,
            desired: true,
            managed: false,
            state: "external",
            origin: "external_unknown",
            sourcePath: skillDir,
            targetPath: skillDir,
        });
    }
    return snapshot;
}
export async function syncSkills(ctx, _desiredSkills) {
    // v1: skills are managed externally (operator drops them in skillsRoot).
    // We just return the current listing — no copy/sync work.
    return listSkills(ctx);
}
// ----- createServerAdapter factory -----
/**
 * Paperclip plugin-loader convention: returns the full server-side adapter
 * surface as a single object.
 */
export function createServerAdapter() {
    return {
        type,
        label,
        models,
        agentConfigurationDoc,
        execute,
        testEnvironment,
        sessionCodec,
        detectModel,
        listSkills,
        syncSkills,
        listModels,
        getConfigSchema,
        // Paperclip's heartbeat dispatcher (server/src/services/heartbeat.ts)
        // only mints and injects `authToken` (the agent's scoped Paperclip API
        // JWT) when this is true. Without it, every run executes with
        // authToken undefined — execute() still returns exitCode 0, but every
        // Paperclip API write it makes (comments, status updates, checkout,
        // ask_user_questions) is silently skipped. Set for both purely-remote
        // adapters (see the built-in hermes adapter) and local ones (see the
        // built-in process adapter) — it gates the JWT, not local execution.
        supportsLocalAgentJwt: true,
        // Unlocks Paperclip's managed "Instructions" bundle editor in the agent
        // UI (previously showed "Instructions bundles are only available for
        // local adapters" for this adapter). Paperclip resolves the config key
        // that holds the instructions file path via
        // resolveInstructionsPathKey() (server/src/routes/agents.ts in the host
        // repo): when supportsInstructionsBundle is true and no explicit
        // instructionsPathKey is set, it defaults to "instructionsFilePath" —
        // which already exists on LlmConfig and is already read at runtime in
        // execute.ts (fs.readFile(config.instructionsFilePath)). The bundle
        // editor writes its content to a file on the Paperclip server's own
        // filesystem and points adapterConfig.instructionsFilePath at it;
        // since execute() runs in-process inside that same server (per the
        // plugin-loader contract), no other change is needed. The built-in
        // hermes adapter — remote-API-calling, same shape as this one, no
        // local execution either — sets this too.
        supportsInstructionsBundle: true,
    };
}
//# sourceMappingURL=index.js.map
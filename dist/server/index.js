/**
 * Server barrel for the OpenRouter adapter.
 *
 * Exposes everything Paperclip's server-side registry expects from a
 * fully-featured adapter:
 *   - execute             — the agent run loop (tool-calling)
 *   - testEnvironment     — env diagnostics + model fetch
 *   - sessionCodec        — persist/restore lastGenerationId across heartbeats
 *   - detectModel         — read LLM_MODEL / OPENROUTER_MODEL env if present
 *   - listSkills          — company-managed skills (config.paperclipRuntimeSkills)
 *                            plus whatever the operator drops in manually
 *   - syncSkills          — symlinks desired company-managed skills into the
 *                            skills directory loadSkills() reads from
 *
 * Optional hooks not implemented (deferred to v3):
 *   - getQuotaWindows     — OpenRouter exposes /key endpoint, can be added
 *   - onHireApproved      — only used by cloud adapters
 */
import { execute } from "./execute.js";
import { testEnvironment, listModels, listOpenRouterModels } from "./test.js";
import { getConfigSchema } from "./config-schema.js";
import { listSkills, syncSkills } from "./skills.js";
import { type, label, models, agentConfigurationDoc } from "../index.js";
export { execute, testEnvironment, listModels, listOpenRouterModels, getConfigSchema, listSkills, syncSkills };
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
 * Best-effort detection: read LLM_MODEL / OPENROUTER_MODEL, else null (no
 * guessed default — it showed up as a misleading "detected" entry).
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
    return null;
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
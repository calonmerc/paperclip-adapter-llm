/**
 * Server barrel for the OpenRouter adapter.
 *
 * Exposes everything Paperclip's server-side registry expects from a
 * fully-featured adapter:
 *   - execute             — the agent run loop (tool-calling)
 *   - testEnvironment     — env diagnostics + model fetch
 *   - sessionCodec        — persist/restore lastGenerationId across heartbeats
 *   - detectModel         — read OPENROUTER_MODEL env if present
 *   - listSkills          — company-managed skills (config.paperclipRuntimeSkills)
 *                            plus whatever the operator drops in manually
 *   - syncSkills          — symlinks desired company-managed skills into the
 *                            skills directory loadSkills() reads from
 *
 * Optional hooks not implemented (deferred to v3):
 *   - getQuotaWindows     — OpenRouter exposes /key endpoint, can be added
 *   - onHireApproved      — only used by cloud adapters
 */
import type { AdapterSessionCodec } from "@paperclipai/adapter-utils";
import { execute } from "./execute.js";
import { testEnvironment, listModels, listOpenRouterModels } from "./test.js";
import { getConfigSchema } from "./config-schema.js";
import { listSkills, syncSkills } from "./skills.js";
export { execute, testEnvironment, listModels, listOpenRouterModels, getConfigSchema, listSkills, syncSkills };
/**
 * OpenRouter doesn't have first-class server-side sessions; we persist the
 * last generation id so the run viewer can show a stable display id and
 * future versions can chain conversations across heartbeats.
 */
export declare const sessionCodec: AdapterSessionCodec;
/**
 * Best-effort detection: read OPENROUTER_MODEL or fall back to "openrouter/auto".
 * Other adapters read from on-disk CLI configs; OpenRouter has none, so env
 * is the only meaningful source.
 */
export declare function detectModel(): Promise<{
    model: string;
    provider: string;
    source: string;
} | null>;
/**
 * Paperclip plugin-loader convention: returns the full server-side adapter
 * surface as a single object.
 */
export declare function createServerAdapter(): {
    type: "llm";
    label: string;
    models: {
        id: string;
        label: string;
    }[];
    agentConfigurationDoc: string;
    execute: typeof execute;
    testEnvironment: typeof testEnvironment;
    sessionCodec: AdapterSessionCodec;
    detectModel: typeof detectModel;
    listSkills: typeof listSkills;
    syncSkills: typeof syncSkills;
    listModels: typeof listModels;
    getConfigSchema: typeof getConfigSchema;
    supportsLocalAgentJwt: boolean;
    supportsInstructionsBundle: boolean;
};
//# sourceMappingURL=index.d.ts.map
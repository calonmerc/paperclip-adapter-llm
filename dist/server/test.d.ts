import type { AdapterEnvironmentTestContext, AdapterEnvironmentTestResult } from "@paperclipai/adapter-utils";
export declare function testEnvironment(ctx: AdapterEnvironmentTestContext): Promise<AdapterEnvironmentTestResult>;
/**
 * Fetch all models from the provider's /models endpoint — used by the
 * dynamic model picker. Paperclip calls this with no arguments (no agent
 * config), so the provider comes from LLM_BASE_URL in the server env.
 * The key is optional: /models is public on OpenRouter and NIM.
 */
export declare function listModels(baseUrl?: string | undefined): Promise<{
    id: string;
    label: string;
}[]>;
/** @deprecated Use listModels(baseUrl). */
export declare const listOpenRouterModels: typeof listModels;
//# sourceMappingURL=test.d.ts.map
// ─────────────────────────────────────────────────────────────────
// paperclip-adapter-llm — Server Test (Environment Check)
// Validates the configured base URL + API key.
// ─────────────────────────────────────────────────────────────────
import { resolveEndpoints, isOpenRouter, isLocalEndpoint, } from "../index.js";
export async function testEnvironment(ctx) {
    const checks = [];
    const config = ctx.config;
    const endpoints = resolveEndpoints(config.baseUrl);
    const onOpenRouter = isOpenRouter(config.baseUrl);
    const onLocal = isLocalEndpoint(config.baseUrl);
    // ── 1. Check API key ──────────────────────────────────────────
    const apiKey = config.apiKey ||
        process.env.LLM_API_KEY ||
        process.env.OPENROUTER_API_KEY;
    if (!apiKey) {
        if (onLocal) {
            checks.push({
                code: "llm_api_key_optional",
                level: "info",
                message: `No API key set — assuming unauthenticated localhost endpoint (${endpoints.base}).`,
            });
        }
        else {
            checks.push({
                code: "llm_api_key_missing",
                level: "error",
                message: "No LLM API key found",
                detail: "Set adapterConfig.apiKey or LLM_API_KEY (or OPENROUTER_API_KEY) environment variable.",
                hint: onOpenRouter
                    ? "Get a key at https://openrouter.ai/keys"
                    : "Provide the API key for your configured baseUrl.",
            });
            return {
                adapterType: "llm",
                status: "fail",
                checks,
                testedAt: new Date().toISOString(),
            };
        }
    }
    else {
        if (onOpenRouter && !apiKey.startsWith("sk-or-")) {
            checks.push({
                code: "llm_api_key_format",
                level: "warn",
                message: "API key does not start with \"sk-or-\"",
                hint: "OpenRouter keys typically start with sk-or-. Check the key or set baseUrl for a different provider.",
            });
        }
        checks.push({
            code: "llm_api_key_found",
            level: "info",
            message: `API key found: ${apiKey.slice(0, 12)}...${apiKey.slice(-4)}`,
        });
    }
    checks.push({
        code: "llm_endpoint",
        level: "info",
        message: `Endpoint: ${endpoints.base}`,
    });
    // ── 2. Test API connectivity & fetch models ───────────────────
    try {
        const headers = {};
        if (apiKey)
            headers.Authorization = `Bearer ${apiKey}`;
        const res = await fetch(endpoints.models, {
            headers,
            signal: AbortSignal.timeout(15000),
        });
        if (!res.ok) {
            const errText = await res.text();
            checks.push({
                code: "llm_api_error",
                level: "error",
                message: `${endpoints.base} returned ${res.status}`,
                detail: errText.slice(0, 200),
            });
            return {
                adapterType: "llm",
                status: "fail",
                checks,
                testedAt: new Date().toISOString(),
            };
        }
        const data = (await res.json());
        const allModels = data.data || [];
        const freeModels = allModels.filter((m) => m.id?.endsWith?.(":free") ||
            (m.pricing?.prompt === "0" && m.pricing?.completion === "0"));
        checks.push({
            code: "llm_connected",
            level: "info",
            message: onOpenRouter
                ? `Connected — ${allModels.length} models available (${freeModels.length} free)`
                : `Connected — ${allModels.length} models available`,
        });
        // ── 3. Validate selected model ──────────────────────────────
        const selectedModel = config.model || (onOpenRouter ? "openrouter/auto" : "");
        if (selectedModel === "openrouter/auto") {
            checks.push({
                code: "llm_model_auto",
                level: "info",
                message: "Using auto-routing — OpenRouter selects the best model per request",
            });
        }
        else if (!selectedModel) {
            checks.push({
                code: "llm_model_missing",
                level: "warn",
                message: "No model selected — set adapterConfig.model.",
            });
        }
        else {
            const model = allModels.find((m) => m.id === selectedModel);
            if (model) {
                const promptCost = parseFloat(model.pricing?.prompt || "0") * 1_000_000;
                const completionCost = parseFloat(model.pricing?.completion || "0") * 1_000_000;
                const ctxLen = model.context_length?.toLocaleString?.() || "?";
                const pricingNote = onOpenRouter
                    ? ` — $${promptCost.toFixed(2)}/$${completionCost.toFixed(2)} per 1M tokens, ${ctxLen} ctx`
                    : ` (${ctxLen} ctx)`;
                checks.push({
                    code: "llm_model_found",
                    level: "info",
                    message: `Model "${selectedModel}"${pricingNote}`,
                });
            }
            else {
                checks.push({
                    code: "llm_model_not_found",
                    level: "warn",
                    message: `Model "${selectedModel}" not found in /models — may be deprecated, misspelled, or not listed by this provider`,
                });
            }
        }
        const hasErrors = checks.some((c) => c.level === "error");
        const hasWarnings = checks.some((c) => c.level === "warn");
        return {
            adapterType: "llm",
            status: hasErrors ? "fail" : hasWarnings ? "warn" : "pass",
            checks,
            testedAt: new Date().toISOString(),
        };
    }
    catch (err) {
        checks.push({
            code: "llm_connection_failed",
            level: "error",
            message: `Failed to connect to ${endpoints.base}: ${err.message || err}`,
        });
        return {
            adapterType: "llm",
            status: "fail",
            checks,
            testedAt: new Date().toISOString(),
        };
    }
}
/**
 * Fetch all models from the provider's /models endpoint — used by the
 * dynamic model picker. Paperclip calls this with no arguments (no agent
 * config), so the provider comes from LLM_BASE_URL in the server env.
 * The key is optional: /models is public on OpenRouter and NIM.
 */
export async function listModels(baseUrl = process.env.LLM_BASE_URL || undefined) {
    const endpoints = resolveEndpoints(baseUrl);
    const onOpenRouter = isOpenRouter(baseUrl);
    const apiKey = process.env.LLM_API_KEY || process.env.OPENROUTER_API_KEY;
    try {
        const headers = {};
        if (apiKey)
            headers.Authorization = `Bearer ${apiKey}`;
        const res = await fetch(endpoints.models, {
            headers,
            signal: AbortSignal.timeout(15000),
        });
        if (!res.ok)
            return [];
        const data = (await res.json());
        const isFree = (m) => m.id?.endsWith?.(":free") || (m.pricing?.prompt === "0" && m.pricing?.completion === "0");
        return (data.data || [])
            .filter((m) => typeof m.id === "string" && m.id.length > 0)
            .sort((a, b) => {
            if (onOpenRouter) {
                // Free models first on OpenRouter; other providers don't report pricing.
                const aFree = isFree(a);
                const bFree = isFree(b);
                if (aFree && !bFree)
                    return -1;
                if (!aFree && bFree)
                    return 1;
                return (a.name || a.id).localeCompare(b.name || b.id);
            }
            return a.id.localeCompare(b.id);
        })
            .map((m) => ({
            id: m.id,
            label: m.name || m.id,
        }));
    }
    catch {
        return [];
    }
}
/** @deprecated Use listModels(baseUrl). */
export const listOpenRouterModels = listModels;
//# sourceMappingURL=test.js.map
import type { AdapterConfigSchema } from "@paperclipai/adapter-utils";
/**
 * Declarative config schema served from GET /api/adapters/llm/config-schema.
 * Paperclip's agent-config UI (SchemaConfigFields) renders this into the
 * "Configuration" section for any adapter that implements getConfigSchema —
 * without it, external adapters get no per-agent config fields at all.
 *
 * `model` is intentionally omitted: Paperclip's model picker in the
 * "Adapter" section already reads `models`/`listModels`/`detectModel` from
 * the server barrel and writes `adapterConfig.model` directly.
 */
export declare function getConfigSchema(): AdapterConfigSchema;
//# sourceMappingURL=config-schema.d.ts.map
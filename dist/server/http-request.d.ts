/**
 * Outbound HTTP for the http_request tool, with bound-secret handling.
 *
 * Paperclip resolves an agent's bound secrets into adapterConfig.env before
 * execute() runs (the same map built-in adapters inject into their child
 * process environment). This adapter has no child process and no shell, so
 * instead the model references a secret by name — `{{secret:NAME}}` — and
 * the value is substituted here, in-process, at request time. The model
 * never sees a raw secret value: every value (and any access token minted
 * from one) is redacted out of whatever goes back to it.
 */
export declare const SECRET_PLACEHOLDER: RegExp;
export declare const REDACTED = "***";
export declare const MAX_RESPONSE_CHARS = 32000;
export declare const REQUEST_TIMEOUT_MS = 30000;
export declare class SecretReferenceError extends Error {
}
/**
 * Keep only string values from adapterConfig.env that are real bound
 * secrets/env vars — not Paperclip's own runtime keys, which this adapter
 * already handles through its own authToken.
 */
export declare function collectBoundSecrets(env: unknown, isExcludedKey: (key: string) => boolean): Record<string, string>;
/** Replace every `{{secret:NAME}}` in `text`. Throws SecretReferenceError on an unknown name. */
export declare function substituteSecrets(text: string, secrets: Record<string, string>): string;
/** Recursively substitute placeholders in every string inside a JSON-like value. */
export declare function substituteSecretsDeep(value: unknown, secrets: Record<string, string>): unknown;
/**
 * Redact every sensitive value from `text`, including the JSON-escaped form
 * (a service-account key contains newlines that appear as `\n` in JSON).
 * Values shorter than 4 chars are skipped — redacting them would mangle
 * ordinary output without protecting anything meaningful.
 */
export declare function redactSecrets(text: string, sensitiveValues: Iterable<string>): string;
interface ServiceAccountKey {
    client_email: string;
    private_key: string;
    token_uri?: string;
}
export declare function parseServiceAccountKey(raw: string): ServiceAccountKey;
/** Build the signed RS256 JWT assertion for Google's OAuth2 JWT-bearer grant. */
export declare function buildServiceAccountAssertion(key: ServiceAccountKey, scopes: string[], nowSec?: number): string;
/** Exchange a service-account key for a short-lived access token. */
export declare function fetchGoogleAccessToken(rawKey: string, scopes: string[], fetchImpl?: typeof fetch): Promise<string>;
export declare function hostAllowed(url: URL, allowedHosts: string[] | null): boolean;
export declare function parseAllowedHosts(raw: unknown): string[] | null;
export {};
//# sourceMappingURL=http-request.d.ts.map
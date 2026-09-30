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
import crypto from "node:crypto";
// Secret keys can contain dots and hyphens (e.g. "umami.api-key"), not just env-var characters.
export const SECRET_PLACEHOLDER = /\{\{\s*secret:([A-Za-z_][A-Za-z0-9_.-]*)\s*\}\}/g;
// This adapter's own LLM provider key is stored as a Paperclip secret bound to
// the agent (key "llm.apikey.<id>"), so the listing includes it. It's the
// adapter's credential, not one the model has any business sending anywhere.
const OWN_ADAPTER_SECRET_PREFIX = "llm.apikey.";
export const REDACTED = "***";
export const MAX_RESPONSE_CHARS = 32_000;
export const REQUEST_TIMEOUT_MS = 30_000;
const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
export class SecretReferenceError extends Error {
}
/**
 * Keep only string values from adapterConfig.env that are real bound
 * secrets/env vars — not Paperclip's own runtime keys, which this adapter
 * already handles through its own authToken.
 */
export function collectBoundSecrets(env, isExcludedKey) {
    const secrets = {};
    if (!env || typeof env !== "object" || Array.isArray(env))
        return secrets;
    for (const [key, value] of Object.entries(env)) {
        if (typeof value !== "string" || value.length === 0)
            continue;
        if (isExcludedKey(key))
            continue;
        secrets[key] = value;
    }
    return secrets;
}
/**
 * Every secret this run can use. GET /agents/me/secrets lists every secret
 * bound to the agent — env-var bindings and API-access bindings alike —
 * under its secret key, and POST /agents/me/secrets/:key/value resolves any
 * of them, so when that listing is available it is the single source of
 * names. adapterConfig.env is only the fallback for servers without it: it
 * also carries plain runtime variables (TEMP, TMPDIR, GH_CONFIG_DIR, ...)
 * that aren't secrets at all, and nothing there distinguishes the two.
 * Values are fetched only when a request references them, then cached for
 * the run. Every value ever resolved is tracked so it can be redacted from
 * anything shown to the model.
 */
export class SecretStore {
    env;
    api;
    apiKeys = new Set();
    fetched = new Map();
    constructor(env = {}, api = null) {
        this.env = env;
        this.api = api;
    }
    /** Load the API-access binding names. Failure just means none are available. */
    async init(onError) {
        if (!this.api)
            return;
        try {
            const listing = await this.api.listAgentSecretAccess();
            if (!Array.isArray(listing?.secrets))
                return;
            const keys = listing.secrets.map((s) => s?.key);
            this.apiKeys = new Set(keys.filter((k) => typeof k === "string" && k.length > 0 && !k.startsWith(OWN_ADAPTER_SECRET_PREFIX)));
            this.env = {};
        }
        catch (err) {
            onError?.(err instanceof Error ? err.message : String(err));
        }
    }
    names() {
        return [...new Set([...Object.keys(this.env), ...this.apiKeys])].sort();
    }
    has(name) {
        return Object.prototype.hasOwnProperty.call(this.env, name) || this.apiKeys.has(name);
    }
    async get(name) {
        if (Object.prototype.hasOwnProperty.call(this.env, name))
            return this.env[name];
        if (!this.apiKeys.has(name) || !this.api)
            throw new SecretReferenceError(this.unknownMessage(name));
        const cached = this.fetched.get(name);
        if (cached !== undefined)
            return cached;
        const { value } = await this.api.getAgentSecretValue(name);
        if (typeof value !== "string")
            throw new Error(`Paperclip returned no value for secret '${name}'.`);
        this.fetched.set(name, value);
        return value;
    }
    /** Values that must never reach the model: all env secrets plus every API value fetched so far. */
    sensitiveValues() {
        return [...Object.values(this.env), ...this.fetched.values()];
    }
    unknownMessage(name) {
        const known = this.names();
        return `Unknown secret '${name}'. Bound secrets: ${known.length > 0 ? known.join(", ") : "(none)"}.`;
    }
}
/** Collect every `{{secret:NAME}}` name referenced anywhere inside a JSON-like value. */
export function referencedSecretNames(value, out = new Set()) {
    if (typeof value === "string") {
        for (const m of value.matchAll(SECRET_PLACEHOLDER))
            out.add(m[1]);
    }
    else if (Array.isArray(value)) {
        for (const v of value)
            referencedSecretNames(v, out);
    }
    else if (value && typeof value === "object") {
        for (const v of Object.values(value))
            referencedSecretNames(v, out);
    }
    return out;
}
/** Resolve the named secrets up front, so substitution itself can stay synchronous. */
export async function resolveSecrets(names, store) {
    const resolved = {};
    for (const name of names) {
        if (!store.has(name))
            throw new SecretReferenceError(store.unknownMessage(name));
        resolved[name] = await store.get(name);
    }
    return resolved;
}
/** Replace every `{{secret:NAME}}` in `text`. Throws SecretReferenceError on an unknown name. */
export function substituteSecrets(text, secrets) {
    return text.replace(SECRET_PLACEHOLDER, (_match, name) => {
        if (!Object.prototype.hasOwnProperty.call(secrets, name)) {
            const known = Object.keys(secrets);
            throw new SecretReferenceError(`Unknown secret '${name}'. Bound secrets: ${known.length > 0 ? known.join(", ") : "(none)"}.`);
        }
        return secrets[name];
    });
}
/** Recursively substitute placeholders in every string inside a JSON-like value. */
export function substituteSecretsDeep(value, secrets) {
    if (typeof value === "string")
        return substituteSecrets(value, secrets);
    if (Array.isArray(value))
        return value.map((v) => substituteSecretsDeep(v, secrets));
    if (value && typeof value === "object") {
        const out = {};
        for (const [k, v] of Object.entries(value))
            out[k] = substituteSecretsDeep(v, secrets);
        return out;
    }
    return value;
}
/**
 * Redact every sensitive value from `text`, including the JSON-escaped form
 * (a service-account key contains newlines that appear as `\n` in JSON).
 * Values shorter than 4 chars are skipped — redacting them would mangle
 * ordinary output without protecting anything meaningful.
 */
export function redactSecrets(text, sensitiveValues) {
    const needles = new Set();
    for (const value of sensitiveValues) {
        if (typeof value !== "string" || value.length < 4)
            continue;
        needles.add(value);
        const escaped = JSON.stringify(value).slice(1, -1);
        if (escaped !== value)
            needles.add(escaped);
    }
    // Longest first, so a secret that contains another secret is redacted whole.
    let out = text;
    for (const needle of [...needles].sort((a, b) => b.length - a.length)) {
        out = out.split(needle).join(REDACTED);
    }
    return out;
}
function base64url(input) {
    return Buffer.from(input).toString("base64").replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");
}
export function parseServiceAccountKey(raw) {
    let parsed;
    try {
        parsed = JSON.parse(raw);
    }
    catch {
        throw new Error("Secret is not valid JSON — expected a Google service-account key file.");
    }
    const key = parsed;
    if (typeof key.client_email !== "string" || typeof key.private_key !== "string") {
        throw new Error("Secret is missing client_email/private_key — expected a Google service-account key file.");
    }
    return {
        client_email: key.client_email,
        private_key: key.private_key,
        token_uri: typeof key.token_uri === "string" ? key.token_uri : undefined,
    };
}
/** Build the signed RS256 JWT assertion for Google's OAuth2 JWT-bearer grant. */
export function buildServiceAccountAssertion(key, scopes, nowSec = Math.floor(Date.now() / 1000)) {
    const header = { alg: "RS256", typ: "JWT" };
    const claims = {
        iss: key.client_email,
        scope: scopes.join(" "),
        aud: key.token_uri ?? GOOGLE_TOKEN_URL,
        iat: nowSec,
        exp: nowSec + 3600,
    };
    const signingInput = `${base64url(JSON.stringify(header))}.${base64url(JSON.stringify(claims))}`;
    const signature = crypto.createSign("RSA-SHA256").update(signingInput).sign(key.private_key);
    return `${signingInput}.${base64url(signature)}`;
}
/** Exchange a service-account key for a short-lived access token. */
export async function fetchGoogleAccessToken(rawKey, scopes, fetchImpl = fetch) {
    const key = parseServiceAccountKey(rawKey);
    const assertion = buildServiceAccountAssertion(key, scopes);
    const response = await fetchImpl(key.token_uri ?? GOOGLE_TOKEN_URL, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
            grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
            assertion,
        }).toString(),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    const text = await response.text();
    if (!response.ok) {
        throw new Error(`Google token exchange failed (${response.status}): ${text.slice(0, 500)}`);
    }
    let token;
    try {
        token = JSON.parse(text).access_token;
    }
    catch {
        token = null;
    }
    if (typeof token !== "string" || token.length === 0) {
        throw new Error("Google token exchange returned no access_token.");
    }
    return token;
}
export function hostAllowed(url, allowedHosts) {
    if (!allowedHosts || allowedHosts.length === 0)
        return true;
    const host = url.hostname.toLowerCase();
    return allowedHosts.some((raw) => {
        const allowed = raw.trim().toLowerCase();
        if (!allowed)
            return false;
        if (allowed.startsWith("*."))
            return host.endsWith(allowed.slice(1));
        return host === allowed;
    });
}
export function parseAllowedHosts(raw) {
    if (Array.isArray(raw)) {
        const hosts = raw.filter((h) => typeof h === "string" && h.trim().length > 0);
        return hosts.length > 0 ? hosts : null;
    }
    if (typeof raw === "string" && raw.trim()) {
        return raw.split(",").map((h) => h.trim()).filter(Boolean);
    }
    return null;
}
//# sourceMappingURL=http-request.js.map
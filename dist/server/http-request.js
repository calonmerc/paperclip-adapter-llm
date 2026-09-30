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
export const SECRET_PLACEHOLDER = /\{\{\s*secret:([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g;
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
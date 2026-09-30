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

export class SecretReferenceError extends Error {}

/**
 * Keep only string values from adapterConfig.env that are real bound
 * secrets/env vars — not Paperclip's own runtime keys, which this adapter
 * already handles through its own authToken.
 */
export function collectBoundSecrets(
  env: unknown,
  isExcludedKey: (key: string) => boolean,
): Record<string, string> {
  const secrets: Record<string, string> = {};
  if (!env || typeof env !== "object" || Array.isArray(env)) return secrets;
  for (const [key, value] of Object.entries(env as Record<string, unknown>)) {
    if (typeof value !== "string" || value.length === 0) continue;
    if (isExcludedKey(key)) continue;
    secrets[key] = value;
  }
  return secrets;
}

/** The slice of PaperclipApi the store needs (kept narrow for tests). */
export interface AgentSecretAccessApi {
  listAgentSecretAccess(): Promise<{ secrets: Array<{ key: string }> }>;
  getAgentSecretValue(key: string): Promise<{ key: string; value: string }>;
}

/**
 * Every secret this run can use, from both of Paperclip's binding modes:
 *   - env-var bindings: resolved into adapterConfig.env before the run
 *   - API-access bindings: never in the env; listed via GET /agents/me/secrets
 *     and each value fetched on demand via POST /agents/me/secrets/:key/value
 * API-access values are fetched only when a request actually references
 * them, then cached for the run. Every value ever resolved is tracked so it
 * can be redacted from anything shown to the model.
 */
export class SecretStore {
  private readonly env: Record<string, string>;
  private readonly api: AgentSecretAccessApi | null;
  private apiKeys: Set<string> = new Set();
  private readonly fetched = new Map<string, string>();

  constructor(env: Record<string, string> = {}, api: AgentSecretAccessApi | null = null) {
    this.env = env;
    this.api = api;
  }

  /** Load the API-access binding names. Failure just means none are available. */
  async init(onError?: (reason: string) => void): Promise<void> {
    if (!this.api) return;
    try {
      const listing = await this.api.listAgentSecretAccess();
      const keys = Array.isArray(listing?.secrets) ? listing.secrets.map((s) => s?.key) : [];
      this.apiKeys = new Set(keys.filter((k): k is string => typeof k === "string" && k.length > 0));
    } catch (err) {
      onError?.(err instanceof Error ? err.message : String(err));
    }
  }

  names(): string[] {
    return [...new Set([...Object.keys(this.env), ...this.apiKeys])].sort();
  }

  has(name: string): boolean {
    return Object.prototype.hasOwnProperty.call(this.env, name) || this.apiKeys.has(name);
  }

  async get(name: string): Promise<string> {
    if (Object.prototype.hasOwnProperty.call(this.env, name)) return this.env[name]!;
    if (!this.apiKeys.has(name) || !this.api) throw new SecretReferenceError(this.unknownMessage(name));
    const cached = this.fetched.get(name);
    if (cached !== undefined) return cached;
    const { value } = await this.api.getAgentSecretValue(name);
    if (typeof value !== "string") throw new Error(`Paperclip returned no value for secret '${name}'.`);
    this.fetched.set(name, value);
    return value;
  }

  /** Values that must never reach the model: all env secrets plus every API value fetched so far. */
  sensitiveValues(): string[] {
    return [...Object.values(this.env), ...this.fetched.values()];
  }

  unknownMessage(name: string): string {
    const known = this.names();
    return `Unknown secret '${name}'. Bound secrets: ${known.length > 0 ? known.join(", ") : "(none)"}.`;
  }
}

/** Collect every `{{secret:NAME}}` name referenced anywhere inside a JSON-like value. */
export function referencedSecretNames(value: unknown, out: Set<string> = new Set()): Set<string> {
  if (typeof value === "string") {
    for (const m of value.matchAll(SECRET_PLACEHOLDER)) out.add(m[1]!);
  } else if (Array.isArray(value)) {
    for (const v of value) referencedSecretNames(v, out);
  } else if (value && typeof value === "object") {
    for (const v of Object.values(value as Record<string, unknown>)) referencedSecretNames(v, out);
  }
  return out;
}

/** Resolve the named secrets up front, so substitution itself can stay synchronous. */
export async function resolveSecrets(names: Iterable<string>, store: SecretStore): Promise<Record<string, string>> {
  const resolved: Record<string, string> = {};
  for (const name of names) {
    if (!store.has(name)) throw new SecretReferenceError(store.unknownMessage(name));
    resolved[name] = await store.get(name);
  }
  return resolved;
}

/** Replace every `{{secret:NAME}}` in `text`. Throws SecretReferenceError on an unknown name. */
export function substituteSecrets(text: string, secrets: Record<string, string>): string {
  return text.replace(SECRET_PLACEHOLDER, (_match, name: string) => {
    if (!Object.prototype.hasOwnProperty.call(secrets, name)) {
      const known = Object.keys(secrets);
      throw new SecretReferenceError(
        `Unknown secret '${name}'. Bound secrets: ${known.length > 0 ? known.join(", ") : "(none)"}.`,
      );
    }
    return secrets[name]!;
  });
}

/** Recursively substitute placeholders in every string inside a JSON-like value. */
export function substituteSecretsDeep(value: unknown, secrets: Record<string, string>): unknown {
  if (typeof value === "string") return substituteSecrets(value, secrets);
  if (Array.isArray(value)) return value.map((v) => substituteSecretsDeep(v, secrets));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = substituteSecretsDeep(v, secrets);
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
export function redactSecrets(text: string, sensitiveValues: Iterable<string>): string {
  const needles = new Set<string>();
  for (const value of sensitiveValues) {
    if (typeof value !== "string" || value.length < 4) continue;
    needles.add(value);
    const escaped = JSON.stringify(value).slice(1, -1);
    if (escaped !== value) needles.add(escaped);
  }
  // Longest first, so a secret that contains another secret is redacted whole.
  let out = text;
  for (const needle of [...needles].sort((a, b) => b.length - a.length)) {
    out = out.split(needle).join(REDACTED);
  }
  return out;
}

// ----- Google service-account auth -----

interface ServiceAccountKey {
  client_email: string;
  private_key: string;
  token_uri?: string;
}

function base64url(input: Buffer | string): string {
  return Buffer.from(input).toString("base64").replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");
}

export function parseServiceAccountKey(raw: string): ServiceAccountKey {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("Secret is not valid JSON — expected a Google service-account key file.");
  }
  const key = parsed as Record<string, unknown>;
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
export function buildServiceAccountAssertion(
  key: ServiceAccountKey,
  scopes: string[],
  nowSec = Math.floor(Date.now() / 1000),
): string {
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
export async function fetchGoogleAccessToken(
  rawKey: string,
  scopes: string[],
  fetchImpl: typeof fetch = fetch,
): Promise<string> {
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
  let token: unknown;
  try {
    token = (JSON.parse(text) as Record<string, unknown>).access_token;
  } catch {
    token = null;
  }
  if (typeof token !== "string" || token.length === 0) {
    throw new Error("Google token exchange returned no access_token.");
  }
  return token;
}

export function hostAllowed(url: URL, allowedHosts: string[] | null): boolean {
  if (!allowedHosts || allowedHosts.length === 0) return true;
  const host = url.hostname.toLowerCase();
  return allowedHosts.some((raw) => {
    const allowed = raw.trim().toLowerCase();
    if (!allowed) return false;
    if (allowed.startsWith("*.")) return host.endsWith(allowed.slice(1));
    return host === allowed;
  });
}

export function parseAllowedHosts(raw: unknown): string[] | null {
  if (Array.isArray(raw)) {
    const hosts = raw.filter((h): h is string => typeof h === "string" && h.trim().length > 0);
    return hosts.length > 0 ? hosts : null;
  }
  if (typeof raw === "string" && raw.trim()) {
    return raw.split(",").map((h) => h.trim()).filter(Boolean);
  }
  return null;
}

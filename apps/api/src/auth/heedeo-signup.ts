import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";

import type { Settings } from "@opengeni/config";
import {
  type Database,
  type HeedeoSignupMethod,
  type HeedeoSignupMode,
  type SignupHeedeoEvaluationRecord,
  readHeedeoSignupMode,
  recordSignupHeedeoEvaluation,
} from "@opengeni/db";

import { TRUSTED_CLIENT_ADDRESS_HEADER } from "../http/request-source";
import type { ManagedAuthProviderId } from "./managed-auth-attempt-context";

/**
 * Heedeo signup scoring (docs/signup-abuse-protection.md, "Heedeo shadow
 * scoring"). One evaluation per signup, in the user-create hook, bounded by
 * OPENGENI_HEEDEO_TIMEOUT_MS. Every Heedeo failure fails open. Shadow records
 * the verdict only; enforce refuses a flagged signup.
 */

export const HEEDEO_API_VERSION = "2026-11-08";
/** The end user's request headers Heedeo reads, as its own package sends them. */
const FORWARDED_HEADERS = [
  "user-agent",
  "accept",
  "accept-language",
  "sec-fetch-site",
  "sec-fetch-mode",
  "sec-fetch-dest",
  "upgrade",
  "signature",
  "signature-input",
  "signature-agent",
  "content-digest",
  "sec-ch-ua",
  "sec-ch-ua-platform",
  "sec-ch-ua-mobile",
  "cf-ipcountry",
  "x-vercel-ip-country",
] as const;
const TOKEN_MAX_LENGTH = 4096;
/** How long a Google or GitHub start's token rides in OAuth state (Heedeo tokens live 5 minutes). */
export const HEEDEO_OAUTH_TOKEN_TTL_MS = 300_000;

/** What the browser and the request give one signup attempt. */
export type HeedeoSignupRequest = {
  token: string | null;
  clientIp: string | null;
  headers: Record<string, string>;
};

type HeedeoSignupContext = {
  request: HeedeoSignupRequest;
  /** The hook's verdict, recorded once the user row exists. */
  pending: SignupHeedeoEvaluationRecord | null;
};

const storage = new AsyncLocalStorage<HeedeoSignupContext>();

export function heedeoToken(value: unknown): string | null {
  return typeof value === "string" && value.trim() && value.length <= TOKEN_MAX_LENGTH
    ? value.trim()
    : null;
}

/** The Heedeo request for a signup attempt from the API's inbound request. */
export function heedeoSignupRequestFrom(request: Request, token: unknown): HeedeoSignupRequest {
  const url = URL.canParse(request.url) ? new URL(request.url) : null;
  const headers: Record<string, string> = {
    ...(request.headers.get("host") || url?.host
      ? { host: (request.headers.get("host") || url?.host)! }
      : {}),
    ":method": request.method,
    ":path": url?.pathname ?? "/",
    ":forwarded": FORWARDED_HEADERS.join(","),
  };
  for (const name of FORWARDED_HEADERS) {
    const value = request.headers.get(name);
    if (value !== null) headers[name] = value;
  }
  return {
    token: heedeoToken(token),
    clientIp: request.headers.get(TRUSTED_CLIENT_ADDRESS_HEADER)?.trim() || null,
    headers,
  };
}

/** Runs one signup attempt with its Heedeo request, for the user-create hook. */
export function runWithHeedeoSignup<T>(request: HeedeoSignupRequest, operation: () => T): T {
  return storage.run({ request, pending: null }, operation);
}

/** The Heedeo token a Google or GitHub start keeps in server-owned OAuth state. */
export function heedeoOAuthState(
  provider: string,
  token: unknown,
  now = Date.now(),
): { provider: string; token: string; expiresAt: number } | undefined {
  const value = heedeoToken(token);
  return value ? { provider, token: value, expiresAt: now + HEEDEO_OAUTH_TOKEN_TTL_MS } : undefined;
}

/** The token a callback's stored OAuth state carries for this provider, if still live. */
export function heedeoTokenFromOAuthState(
  value: string | null | undefined,
  provider: string,
  now = Date.now(),
): string | null {
  if (!value) return null;
  try {
    const stored = JSON.parse(value)?.opengeniHeedeo;
    if (
      stored?.provider !== provider ||
      typeof stored.expiresAt !== "number" ||
      stored.expiresAt <= now ||
      stored.expiresAt > now + HEEDEO_OAUTH_TOKEN_TTL_MS + 60_000
    ) {
      return null;
    }
    return heedeoToken(stored.token);
  } catch {
    return null;
  }
}

export type HeedeoSettings = Pick<
  Settings,
  | "heedeoPublishableKey"
  | "heedeoSecretKey"
  | "heedeoApiUrl"
  | "heedeoScriptUrl"
  | "heedeoTimeoutMs"
>;

export function heedeoKeysConfigured(settings: Partial<HeedeoSettings>): boolean {
  return Boolean(settings.heedeoPublishableKey && settings.heedeoSecretKey);
}

/** What the browser needs, only when scoring is on and configured. */
export function heedeoClientConfig(
  settings: Partial<HeedeoSettings>,
  mode: HeedeoSignupMode,
): { publishableKey: string; scriptUrl: string } | undefined {
  if (mode === "off" || !heedeoKeysConfigured(settings)) return undefined;
  return {
    publishableKey: settings.heedeoPublishableKey!,
    scriptUrl: settings.heedeoScriptUrl ?? "https://heedeo.dev/i.js",
  };
}

export type HeedeoEvaluation = {
  outcome: "evaluated" | "error";
  errorCode: string | null;
  httpStatus: number | null;
  latencyMs: number;
  noToken: boolean | null;
  evaluationId: string | null;
  score: number | null;
  band: string | null;
  flagged: boolean | null;
  reasonCodes: string[];
  visitorId: string | null;
};

export type HeedeoEvaluationInput = {
  token: string | null;
  email: string | null;
  clientIp: string | null;
  headers: Record<string, string>;
  oauth?: { provider: "google" | "github"; emailVerified: boolean };
};

const asObject = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

/**
 * Sends one `signup` event to Heedeo. Never throws: a timeout, network error,
 * any 4xx (401/403 invalid_key, 429 rate_limited) or 5xx after one retry, or a
 * malformed answer is an `error` with its code. The whole call, retry included,
 * stays within the configured timeout.
 */
export async function evaluateHeedeoSignup(
  settings: HeedeoSettings,
  input: HeedeoEvaluationInput,
  fetcher: typeof fetch = fetch,
): Promise<HeedeoEvaluation> {
  const started = performance.now();
  const failed = (errorCode: string, httpStatus: number | null = null): HeedeoEvaluation => ({
    outcome: "error",
    errorCode,
    httpStatus,
    latencyMs: Math.round(performance.now() - started),
    noToken: null,
    evaluationId: null,
    score: null,
    band: null,
    flagged: null,
    reasonCodes: [],
    visitorId: null,
  });
  const body = JSON.stringify({
    action: "signup",
    ...(input.token ? { token: input.token } : {}),
    ...(input.email ? { email: input.email } : {}),
    ...(input.clientIp ? { client_ip: input.clientIp } : {}),
    headers: input.headers,
    // One per attempt, reused by the retry so Heedeo answers it once.
    request_id: randomUUID(),
    ...(input.oauth
      ? {
          evidence: {
            oauth: { provider: input.oauth.provider, email_verified: input.oauth.emailVerified },
          },
        }
      : {}),
  });
  const signal = AbortSignal.timeout(settings.heedeoTimeoutMs);
  let url: string;
  try {
    url = new URL("/v1/evaluations", settings.heedeoApiUrl).toString();
  } catch {
    return failed("configuration_error");
  }
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    let response: Response;
    try {
      response = await fetcher(url, {
        method: "POST",
        headers: {
          authorization: `Bearer ${settings.heedeoSecretKey}`,
          "content-type": "application/json",
          "heedeo-version": HEEDEO_API_VERSION,
        },
        body,
        signal,
      });
    } catch {
      return failed(signal.aborted ? "timeout" : "network_error");
    }
    if (response.ok) {
      let parsed: Record<string, unknown> | null;
      try {
        parsed = asObject(await response.json());
      } catch {
        return failed(signal.aborted ? "timeout" : "malformed_response", response.status);
      }
      if (!parsed || typeof parsed.flagged !== "boolean") {
        return failed("malformed_response", response.status);
      }
      const reasons = Array.isArray(parsed.reasons) ? parsed.reasons : [];
      return {
        outcome: "evaluated",
        errorCode: null,
        httpStatus: response.status,
        latencyMs: Math.round(performance.now() - started),
        noToken: typeof parsed.no_token === "boolean" ? parsed.no_token : null,
        evaluationId: typeof parsed.event_id === "string" ? parsed.event_id : null,
        score: typeof parsed.score === "number" ? parsed.score : null,
        band: typeof parsed.suggested === "string" ? parsed.suggested : null,
        flagged: parsed.flagged,
        reasonCodes: reasons.flatMap((reason) => {
          const code = asObject(reason)?.code;
          return typeof code === "string" ? [code] : [];
        }),
        visitorId:
          typeof asObject(parsed.visitor)?.id === "string"
            ? (asObject(parsed.visitor)!.id as string)
            : null,
      };
    }
    // Release the connection; the body is not needed.
    void response.body?.cancel().catch(() => undefined);
    if (response.status === 401 || response.status === 403) {
      return failed("invalid_key", response.status);
    }
    if (response.status === 429) return failed("rate_limited", response.status);
    if (response.status < 500 || attempt === 2 || signal.aborted) {
      return failed("api_error", response.status);
    }
  }
  return failed("api_error");
}

export function heedeoSignupMethod(providerId: ManagedAuthProviderId | string): HeedeoSignupMethod {
  if (providerId === "credential") return "email";
  if (providerId === "google" || providerId === "github" || providerId === "passkey") {
    return providerId;
  }
  return "other";
}

type Warn = (message: string, attributes: Record<string, string | number | boolean>) => void;
type WriteVerdict = (db: Database, value: SignupHeedeoEvaluationRecord) => Promise<void>;

async function store(
  db: Database,
  value: SignupHeedeoEvaluationRecord,
  warn: Warn | undefined,
  write: WriteVerdict = recordSignupHeedeoEvaluation,
) {
  try {
    await write(db, value);
  } catch (error) {
    warn?.("Heedeo signup verdict was not stored", {
      reason: error instanceof Error ? error.name : "unknown",
    });
  }
}

/**
 * The user-create hook's Heedeo step, after Opengeni's own refusals. Returns
 * "refuse" only in enforce mode for an answer Heedeo flagged (recorded as
 * `refused` with no user); every other answer and every failure is "allow".
 * The verdict waits in the attempt's context for `recordHeedeoSignupAfterCreate`.
 */
export async function heedeoSignupAdmission(options: {
  settings: HeedeoSettings;
  db: Database;
  user: { email?: unknown; emailVerified?: unknown };
  providerId: ManagedAuthProviderId | string;
  fetcher?: typeof fetch;
  readMode?: (db: Database) => Promise<HeedeoSignupMode>;
  /** The verdict write; recordSignupHeedeoEvaluation unless a test replaces it. */
  record?: WriteVerdict;
  warn?: Warn;
}): Promise<"allow" | "refuse"> {
  let mode: HeedeoSignupMode;
  try {
    mode = await (options.readMode ?? readHeedeoSignupMode)(options.db);
  } catch {
    return "allow";
  }
  if (mode === "off") return "allow";
  const context = storage.getStore();
  const request = context?.request ?? { token: null, clientIp: null, headers: {} };
  const signupMethod = heedeoSignupMethod(options.providerId);
  const base = { userId: null, signupMethod, mode, tokenPresent: request.token !== null };
  if (!heedeoKeysConfigured(options.settings)) {
    const skipped = { ...base, outcome: "skipped", errorCode: "missing_keys" } as const;
    if (context) context.pending = skipped;
    return "allow";
  }
  let evaluation: HeedeoEvaluation;
  try {
    const email =
      typeof options.user.email === "string" &&
      options.user.email.includes("@") &&
      !options.user.email.trim().toLowerCase().endsWith(".invalid")
        ? options.user.email.trim()
        : null;
    evaluation = await evaluateHeedeoSignup(
      options.settings,
      {
        token: request.token,
        email,
        clientIp: request.clientIp,
        headers: request.headers,
        ...(signupMethod === "google" || signupMethod === "github"
          ? {
              oauth: { provider: signupMethod, emailVerified: options.user.emailVerified === true },
            }
          : {}),
      },
      options.fetcher,
    );
  } catch {
    evaluation = {
      outcome: "error",
      errorCode: "internal_error",
      httpStatus: null,
      latencyMs: 0,
      noToken: null,
      evaluationId: null,
      score: null,
      band: null,
      flagged: null,
      reasonCodes: [],
      visitorId: null,
    };
  }
  if (evaluation.outcome === "error") {
    options.warn?.("Heedeo signup evaluation failed open", {
      code: evaluation.errorCode ?? "unknown",
      status: evaluation.httpStatus ?? 0,
    });
  }
  const verdict: SignupHeedeoEvaluationRecord = { ...base, ...evaluation };
  if (mode === "enforce" && evaluation.outcome === "evaluated" && evaluation.flagged === true) {
    await store(options.db, { ...verdict, outcome: "refused" }, options.warn, options.record);
    return "refuse";
  }
  if (context) context.pending = verdict;
  else await store(options.db, verdict, options.warn, options.record);
  return "allow";
}

/** Stores the attempt's verdict against the new user; best-effort, never throws. */
export async function recordHeedeoSignupAfterCreate(
  db: Database,
  userId: string,
  warn?: Warn,
  record?: WriteVerdict,
): Promise<void> {
  const context = storage.getStore();
  const pending = context?.pending;
  if (!context || !pending) return;
  context.pending = null;
  await store(db, { ...pending, userId }, warn, record);
}

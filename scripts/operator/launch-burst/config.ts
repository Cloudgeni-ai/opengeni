import { createHash, timingSafeEqual } from "node:crypto";
import { z } from "zod";

export const STAGING_ORIGIN = "https://staging.app.opengeni.ai";
// packages/config/src/index.ts: creditsDefaultModel / creditsDefaultReasoningEffort.
export const LUNA_MODEL = "gpt-6-luna";
export const Mode = z.enum(["plain", "sandbox", "fresh"]);
export type Mode = z.infer<typeof Mode>;
const Label = z.string().regex(/^[a-zA-Z0-9_-]{1,80}$/u);
const EnvName = z.string().regex(/^[A-Z][A-Z0-9_]{1,100}$/u);
const Digest = z.string().regex(/^[a-f0-9]{64}$/u);
export const Intent = z
  .object({
    schemaVersion: z.literal(1),
    runId: Label,
    origin: z.literal(STAGING_ORIGIN),
    mode: Mode,
    count: z.union([z.literal(50), z.literal(100)]),
    requestTimeoutMs: z.number().int().min(1_000).max(60_000),
    turnTimeoutMs: z.number().int().min(10_000).max(600_000),
    signupTimeoutMs: z.number().int().min(10_000).max(600_000),
    // Admission reservation, NOT a provider hard cap (see README).
    costCapUsd: z.number().positive().max(100),
    reservedUsdPerSession: z.number().positive().max(10),
    cleanup: z.literal("request-after-terminal"),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.mode !== "fresh" && value.count !== 100)
      ctx.addIssue({ code: "custom", message: "cheap waves require 100 sessions" });
    if (value.count * value.reservedUsdPerSession > value.costCapUsd)
      ctx.addIssue({ code: "custom", message: "wave exceeds admission cost reservation" });
  });
export type Intent = z.infer<typeof Intent>;
const Existing = z
  .object({
    kind: z.literal("existing"),
    label: Label,
    workspaceId: z.string().uuid(),
    cookieEnv: EnvName,
    // Session-set cookies require the exact selected actor fence as well.
    actorEpoch: z
      .string()
      .regex(/^[1-9][0-9]*$/u)
      .optional(),
  })
  .strict();
const Fresh = z
  .object({
    kind: z.literal("fresh"),
    label: Label,
    email: z.string().email(),
    passwordEnv: EnvName,
    organizationName: z.string().min(1).max(120),
  })
  .strict();
export const Cohort = z
  .object({
    schemaVersion: z.literal(1),
    // Explicit local allowlist. The harness never changes a server allowlist.
    identities: z
      .array(z.discriminatedUnion("kind", [Existing, Fresh]))
      .min(1)
      .max(100),
  })
  .strict();
export type Cohort = z.infer<typeof Cohort>;
export type Identity = Cohort["identities"][number];
export const Authorization = z
  .object({
    schemaVersion: z.literal(1),
    parentSessionId: z.string().uuid(),
    sourceSha: z.string().regex(/^[a-f0-9]{40}$/u),
    intentDigest: Digest,
    cohortDigest: Digest,
    gateTokenDigest: Digest,
    reliability: z
      .object({
        confirmationRef: z.string().min(1).max(512),
        confirmedAt: z.string().datetime(),
        apiMemoryOomFixed: z.literal(true),
        workerCleanupSelfTerminationFixed: z.literal(true),
        emptyOutputFixed: z.literal(true),
        stuckWakesFixed: z.literal(true),
      })
      .strict(),
    monitoring: z
      .object({
        confirmationRef: z.string().min(1).max(512),
        confirmedAt: z.string().datetime(),
        launchDashboardLiveOnStaging: z.literal(true),
      })
      .strict(),
    authorizationRef: z.string().min(1).max(512),
    issuedAt: z.string().datetime(),
    expiresAt: z.string().datetime(),
  })
  .strict();
export type Authorization = z.infer<typeof Authorization>;
export const digest = (value: string): string => createHash("sha256").update(value).digest("hex");
export const intentDigest = (intent: Intent): string => digest(JSON.stringify(intent));

export function validateCohort(intent: Intent, cohort: Cohort): void {
  if (cohort.identities.length !== intent.count)
    throw new Error("cohort count differs from intent");
  const labels = new Set<string>();
  const emails = new Set<string>();
  for (const identity of cohort.identities) {
    if (labels.has(identity.label)) throw new Error("duplicate identity label");
    labels.add(identity.label);
    if ((intent.mode === "fresh") !== (identity.kind === "fresh"))
      throw new Error("fresh and existing identities cannot be substituted or mixed");
    if (identity.kind === "fresh") {
      const email = identity.email.toLowerCase();
      if (emails.has(email)) throw new Error("duplicate fresh identity email");
      emails.add(email);
    }
  }
}

export function validateAuthorization(input: {
  intent: Intent;
  cohort: Cohort;
  cohortText: string;
  authorization: Authorization;
  sourceSha: string;
  confirm: boolean;
  env: Record<string, string | undefined>;
  nowMs: number;
}): void {
  const { intent, cohort, authorization: gate, env } = input;
  validateCohort(intent, cohort);
  if (!input.confirm) throw new Error("live execution requires --confirm-parent-authorized");
  if (
    !env.OPENGENI_BURST_PARENT_SESSION_ID ||
    gate.parentSessionId !== env.OPENGENI_BURST_PARENT_SESSION_ID
  )
    throw new Error("authorization must name the capacity parent");
  const token = env.OPENGENI_BURST_GATE_TOKEN;
  if (!token || token.length < 32) throw new Error("parent gate token missing");
  if (!timingSafeEqual(Buffer.from(digest(token)), Buffer.from(gate.gateTokenDigest)))
    throw new Error("parent gate token does not match");
  if (
    gate.sourceSha !== input.sourceSha ||
    gate.intentDigest !== intentDigest(intent) ||
    gate.cohortDigest !== digest(input.cohortText)
  )
    throw new Error("authorization is not bound to this exact source/intent/cohort");
  const issued = Date.parse(gate.issuedAt);
  const expires = Date.parse(gate.expiresAt);
  if (
    issued > input.nowMs ||
    expires <= input.nowMs ||
    expires <= issued ||
    expires - issued > 30 * 60_000 ||
    Date.parse(gate.reliability.confirmedAt) > issued ||
    Date.parse(gate.monitoring.confirmedAt) > issued
  )
    throw new Error("authorization expired, premature, or not issued after both gates");
  for (const identity of cohort.identities) {
    const secret = env[identity.kind === "fresh" ? identity.passwordEnv : identity.cookieEnv];
    if (!secret || /[\r\n]/u.test(secret)) throw new Error("cohort credential missing or invalid");
    if (identity.kind === "fresh" && secret.length < 12) throw new Error("test password too short");
  }
}

export function publicPlan(intent: Intent) {
  return {
    ...intent,
    intentDigest: intentDigest(intent),
    dryRun: true,
    remoteRequests: 0,
    model: intent.mode === "fresh" ? "server default; assert credits gpt-6-luna xhigh" : LUNA_MODEL,
    reasoningEffort: intent.mode === "fresh" ? "omitted; assert xhigh" : "low",
    prompt: promptFor(intent.mode),
    hardProviderCostCap: false,
    gates: [
      "reliability four fixes confirmed on staging",
      "Launch dashboard LIVE on staging",
      "new exact-wave capacity-parent authorization and token",
    ],
  };
}
export function promptFor(mode: Mode): string {
  return mode === "plain"
    ? "Reply with just OK. Do not call any tools."
    : "Run exactly one exec_command with cmd /bin/true, login false, tty false, yield_time_ms 10000. " +
        "Wait for its terminal exit code, then reply with just OK. Do not run any other commands or tools.";
}

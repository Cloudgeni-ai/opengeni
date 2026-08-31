import {
  BillingMode,
  CAPABILITY_DESCRIPTORS,
  DEFAULT_FIRST_PARTY_MCP_TOOLS,
  Entitlements,
  EntitlementsMode,
  KnowledgeSourceSyncLimits,
  LatencyMode,
  MAX_NESTED_AGENT_DEPTH,
  ProductAccessMode,
  ReasoningEffort,
  FIRST_PARTY_MCP_TOOL_NAMES,
  FirstPartyMcpToolName,
  OpenGeniSlackBotDisplayName,
  SandboxBackend,
  SessionMcpApprovalPolicy,
  SEEDANCE_2_5_MODEL_ID,
  StaticUsageLimits,
  TurnExecutionPolicyV1,
  UsageLimitsMode,
  type TurnExecutionLatencyModeSourceV1,
  type TurnExecutionModelSourceV1,
  type TurnExecutionReasoningSourceV1,
  type VideoGenerationResolution,
  type FirstPartyMcpToolName as FirstPartyMcpToolNameType,
} from "@opengeni/contracts";
import { CODEX_MODEL_TOOL_OUTPUT_TRUNCATION_TOKENS } from "@opengeni/codex";
import {
  CODEX_FALLBACK_MODEL_SLUGS,
  CODEX_MODEL_AUTO_COMPACT_TOKEN_LIMIT,
  CODEX_MODEL_CONTEXT_WINDOW_TOKENS,
  CODEX_MODEL_EFFECTIVE_CONTEXT_WINDOW_TOKENS,
  CODEX_MODEL_ID_PREFIX,
  CODEX_PROVIDER_BASE_URL,
  CODEX_PROVIDER_ID,
} from "@opengeni/codex/constants";
import {
  XAI_SUBSCRIPTION_MODEL_SLUGS,
  XAI_SUBSCRIPTION_MODEL_AUTO_COMPACT_TOKEN_LIMIT,
  XAI_SUBSCRIPTION_MODEL_CONTEXT_WINDOW_TOKENS,
  XAI_SUBSCRIPTION_MODEL_EFFECTIVE_CONTEXT_WINDOW_TOKENS,
  XAI_SUBSCRIPTION_MODEL_ID_PREFIX,
  XAI_SUBSCRIPTION_PROVIDER_ID,
  XAI_SUBSCRIPTION_PROXY_BASE_URL,
  XAI_RESPONSE_STREAM_IDLE_TIMEOUT_MS,
} from "@opengeni/xai-subscription";
export { XAI_SUBSCRIPTION_MODEL_ID_PREFIX } from "@opengeni/xai-subscription";
import { createHash } from "node:crypto";
import { z } from "zod";

const envName = /^[A-Za-z_][A-Za-z0-9_]*$/;
const registryId = /^[A-Za-z0-9_-]+$/;
export const DEFAULT_OPENROUTER_MODEL_ID =
  "openrouter/nvidia/nemotron-3-super-120b-a12b:free" as const;
export const DEFAULT_MODEL_COST_POLICY_JSON = JSON.stringify({
  [DEFAULT_OPENROUTER_MODEL_ID]: "free",
});

// Archive capture claims are also the admission/teardown fence around a
// provider snapshot. Keep a real settlement window after the provider request;
// a configured request timeout may never consume the entire durable claim.
export const SANDBOX_ARCHIVE_CAPTURE_MAX_TIMEOUT_MS = 60 * 60_000;
export const SANDBOX_ARCHIVE_CAPTURE_SETTLEMENT_GRACE_MS = 10_000;
export const SANDBOX_SNAPSHOT_MAX_TIMEOUT_MS =
  SANDBOX_ARCHIVE_CAPTURE_MAX_TIMEOUT_MS - SANDBOX_ARCHIVE_CAPTURE_SETTLEMENT_GRACE_MS;
export const GOOGLE_DRIVE_PROVIDER_REQUEST_TIMEOUT_MAX_MS = 60_000;
export const GOOGLE_DRIVE_PROVIDER_RETRY_DELAY_MAX_MS = 60_000;
// Admission waits are observational: successful capture/teardown returns as
// soon as the DB fence clears. This ceiling only covers the unhealthy path. It
// allows one scheduled inventory and one complete successor claim without
// turning a recoverable lifecycle transition into a visible caller error. A
// dead holder's TTL is deliberately NOT included: admission cannot accelerate
// that proof, and the turn moves to durable recovery if holder quiescence takes
// longer than this observational wait. The outer cap remains an explicit
// request-resource boundary; successful transitions return immediately.
export const SANDBOX_LIFECYCLE_TRANSITION_MAX_WAIT_MS = 60 * 60_000;
export const SANDBOX_LIFECYCLE_RETRY_HANDOFF_GRACE_MS = 10_000;
const EnvBoolean = z.preprocess((value) => {
  if (typeof value !== "string") {
    return value;
  }
  const normalized = value.trim().toLowerCase();
  if (["true", "1", "yes", "y", "on"].includes(normalized)) {
    return true;
  }
  if (["false", "0", "no", "n", "off"].includes(normalized)) {
    return false;
  }
  return value;
}, z.boolean());

/** Default pacing between consecutive no-input goal continuations. */
export const DEFAULT_GOAL_IDLE_BACKOFF_MS: readonly number[] = [3_000, 30_000, 120_000, 300_000];
export const DEFAULT_GOAL_IDLE_BACKOFF_MAX_MS = 600_000;

const EnvGoalIdleBackoffMs = z.preprocess((value) => {
  if (typeof value !== "string") return value;
  const source = value.trim();
  if (!source) return undefined;
  return source.split(",").map((entry) => {
    const trimmed = entry.trim();
    return trimmed === "" ? Number.NaN : Number(trimmed);
  });
}, z.array(z.number().int().nonnegative()).min(1, "OPENGENI_GOAL_IDLE_BACKOFF_MS must list at least one delay in milliseconds").readonly());

const EnvFirstPartyMcpTools = z.preprocess(
  (value) => {
    if (typeof value !== "string") return value;
    const source = value.trim();
    if (!source) return undefined;
    if (source.startsWith("[")) {
      try {
        return JSON.parse(source);
      } catch {
        return value;
      }
    }
    return source.split(",").map((entry) => entry.trim());
  },
  z
    .array(FirstPartyMcpToolName)
    .superRefine((tools, context) => {
      const seen = new Set<FirstPartyMcpToolNameType>();
      for (const [index, tool] of tools.entries()) {
        if (seen.has(tool)) {
          context.addIssue({
            code: "custom",
            message: "first-party MCP tool lists must not contain duplicates",
            path: [index],
          });
        }
        seen.add(tool);
      }
    })
    .optional(),
);

export const sandboxPreparationProfiles: Record<string, { env: string[]; hooks: string[] }> = {
  none: {
    env: [],
    hooks: [],
  },
  azure: {
    env: [
      "ARM_CLIENT_ID",
      "ARM_CLIENT_SECRET",
      "ARM_TENANT_ID",
      "ARM_SUBSCRIPTION_ID",
      "AZURE_CLIENT_ID",
      "AZURE_CLIENT_SECRET",
      "AZURE_TENANT_ID",
      "AZURE_SUBSCRIPTION_ID",
      "AZURE_AUTHORITY_HOST",
    ],
    hooks: ["azure-cli-login"],
  },
  github: {
    env: [
      "GH_TOKEN",
      "GITHUB_TOKEN",
      "GIT_AUTHOR_NAME",
      "GIT_AUTHOR_EMAIL",
      "GIT_COMMITTER_NAME",
      "GIT_COMMITTER_EMAIL",
    ],
    hooks: [],
  },
};

/**
 * Placeholder token inside an agent-instructions persona template. The runtime
 * substitutes the non-bypassable CORE (goal-loop ownership + the dynamic
 * workspace-environment block) at this marker. A template that omits the
 * marker still gets the CORE appended after it (a non-bypassable fail-safe),
 * so a white-labelled persona can never drop the goal-loop contract or the
 * environment metadata the agent depends on.
 */
export const AGENT_INSTRUCTIONS_CORE_PLACEHOLDER = "{{core}}";

/**
 * Default per-workspace agent persona template. This is the BRAND + tool-usage
 * opinion (the white-labellable surface): the "You are an OpenGeni workspace
 * agent." identity line, the framing/opinion lines, and the mount-path facts.
 *
 * The CORE that MUST survive any override — the goal-loop ownership line (which
 * names the opengeni__goal_* tools) and the dynamic workspace-environment block
 * — is injected at AGENT_INSTRUCTIONS_CORE_PLACEHOLDER by the runtime, never
 * baked into this overridable string.
 *
 * INVARIANT: with no per-workspace override and an empty environment, the
 * runtime's composed instructions are byte-for-byte pinned by a runtime test.
 * The template below is joined by " ", followed by " " + the placeholder.
 * Changing a single character here changes that default; update the pin
 * intentionally.
 */
export const DEFAULT_AGENT_INSTRUCTIONS = [
  "You are an OpenGeni workspace agent.",
  "Follow the user's task and any enabled pack or skill instructions for the current role.",
  "Work inside the sandbox workspace and use filesystem and shell tools when useful.",
  "Repository resources are mounted under repos/<host>/<owner>/<repo> unless the session specifies another collision-free mount path.",
  "File resources are mounted under .opengeni/files/<file-id>/ unless the session specifies another mount path.",
  "Attached files are mounted read-only; copy them before modifying.",
  "Installed and selected Skills are indexed under .agents/ and may include role-specific guidance.",
  "Use Checkov, Terraform, Azure CLI, git provider CLIs, and repository tools when relevant; gh, glab, and az repos are pre-authenticated when the host brokers matching git credentials.",
  "When the Azure sandbox preparation profile is enabled and service-principal variables are present, the sandbox is pre-authenticated with normal Azure CLI before work starts.",
  "Treat code-changing work as GitOps work: create a focused branch/commit/PR when git provider credentials are available; otherwise report exact commands and blockers.",
  "Return concise, factual summaries with files changed, commands run, and remaining blockers.",
  AGENT_INSTRUCTIONS_CORE_PLACEHOLDER,
].join(" ");

export const McpServerConnectionRefSchema = z
  .object({
    // Standalone ids are UUIDs; embedded hosts may use any stable opaque id.
    connectionId: z.string().min(1).optional(),
    provider: z.string().min(1).max(128).optional(),
    providerDomain: z.string().min(1),
    kind: z.enum(["oauth2", "api_key", "app_install", "delegated"]).optional(),
    scopes: z.array(z.string().min(1)).optional(),
    resource: z.string().min(1).optional(),
    selectedResources: z
      .array(
        z
          .object({
            id: z.string().min(1).max(512),
            kind: z.literal("repository"),
          })
          .strict(),
      )
      .min(1)
      .max(256)
      .superRefine((resources, context) => {
        const seen = new Set<string>();
        for (const [index, resource] of resources.entries()) {
          const key = `${resource.kind}\0${resource.id}`;
          if (seen.has(key)) {
            context.addIssue({
              code: "custom",
              message: "selectedResources must not contain duplicates",
              path: [index],
            });
          }
          seen.add(key);
        }
      })
      .optional(),
    subjectScope: z.enum(["workspace", "subject"]).optional(),
  })
  .strict()
  .superRefine((reference, context) => {
    if (!reference.selectedResources) return;
    if (!reference.connectionId) {
      context.addIssue({
        code: "custom",
        message: "selectedResources requires connectionId",
        path: ["connectionId"],
      });
    }
    if (!reference.provider) {
      context.addIssue({
        code: "custom",
        message: "selectedResources requires provider",
        path: ["provider"],
      });
    }
  });
export type McpServerConnectionRef = z.infer<typeof McpServerConnectionRefSchema>;

const SettingsSchema = z.object({
  serviceName: z.string().default("opengeni"),
  environment: z.string().default("local"),
  deploymentRevision: z.string().default("dev"),
  // The release-train version baked into official images (OPENGENI_SERVER_VERSION).
  // Absent on dev/source builds — consumers must treat it as optional.
  serverVersion: z.string().optional(),
  databaseUrl: z.string().default("postgres://opengeni:opengeni@127.0.0.1:5432/opengeni"),
  // Step I (§7.8 runtime half). Dedicated Postgres schema for the EMBEDDED
  // topology. Default "" → standalone: no search_path scoping, server default
  // (`public`). When set (e.g. "opengeni"), the db handle + the managed-auth
  // pool send `search_path = "<dbSchema>","opengeni_private","public"` so every
  // query resolves into the dedicated schema with NO query rewrite (schema-isolation contract F1).
  dbSchema: z.string().default(""),
  // Step I (§7.7). RLS posture. "force" (default) = today's FORCE-RLS via the
  // non-owner `opengeni_app` role. "scoped" = the embedded owner-role path (the
  // GUC is still emitted defensively, so the query path is identical).
  rlsStrategy: z.enum(["force", "scoped"]).default("force"),
  // Exact PostgreSQL login identity required by the standalone FORCE-RLS
  // startup/readiness assertion. Embedded `scoped` hosts own their role model
  // and are deliberately not constrained to this name.
  runtimeDatabaseRole: z.string().min(1).default("opengeni_app"),
  natsUrl: z.string().default("nats://127.0.0.1:4222"),
  temporalHost: z.string().default("127.0.0.1:7233"),
  temporalNamespace: z.string().default("default"),
  temporalTaskQueue: z.string().default("opengeni-runs-ts"),
  temporalTlsEnabled: EnvBoolean.default(false),
  temporalApiKey: z.string().optional(),
  temporalTlsServerName: z.string().optional(),
  temporalTlsRootCaCertificateBase64: z.string().optional(),
  temporalTlsClientCertificateBase64: z.string().optional(),
  temporalTlsClientPrivateKeyBase64: z.string().optional(),
  startupDependencyRetryAttempts: z.coerce.number().int().positive().default(30),
  startupDependencyRetryInitialDelayMs: z.coerce.number().int().positive().default(1000),
  startupDependencyRetryMaxDelayMs: z.coerce.number().int().positive().default(5000),
  turnWorkerConcurrencyMode: z.enum(["fixed", "resource-based"]).default("fixed"),
  turnWorkerMaxConcurrentTurns: z.coerce.number().int().positive().max(2_000).default(16),
  turnWorkerTargetCpuUsage: z.coerce.number().positive().max(1).default(0.8),
  turnWorkerTargetMemoryUsage: z.coerce.number().positive().max(0.8).default(0.75),
  // Admission and emergency recovery are deliberately separate control loops.
  // The Temporal tuner stops polling at the lower target; only genuine danger
  // may invoke the disruptive graceful-drain fallback.
  turnWorkerEmergencyMemoryUsage: z.coerce.number().min(0.85).max(0.95).default(0.9),
  turnWorkerMemoryGuardIntervalMs: z.coerce.number().int().min(1_000).max(60_000).default(5_000),
  turnWorkerMemoryGuardSustainMs: z.coerce.number().int().min(5_000).max(300_000).default(30_000),
  observabilityStructuredLogs: EnvBoolean.default(false),
  observabilityMetricsEnabled: EnvBoolean.default(true),
  observabilityOtlpEndpoint: z.string().url().optional(),
  observabilityOtlpHeaders: z.string().default(""),
  analyticsEnabled: EnvBoolean.default(false),
  analyticsConsentRequired: EnvBoolean.default(true),
  analyticsReoClientId: z
    .string()
    .max(128)
    .regex(/^[A-Za-z0-9_-]+$/u)
    .optional(),
  analyticsPosthogProjectKey: z.string().min(1).max(256).optional(),
  analyticsPosthogHost: z.string().url().max(2_048).optional(),
  analyticsGa4MeasurementId: z
    .string()
    .max(32)
    .regex(/^G-[A-Z0-9]+$/u)
    .optional(),
  publicBaseUrl: z.string().url().optional(),
  // Browser origin when the web app and API use separate origins in local
  // development. Production normally leaves this unset and uses publicBaseUrl.
  webBaseUrl: z.string().url().optional(),
  // Base URL for the bring-your-own-compute agent release assets the get.<domain>
  // install routes redirect to. Defaults to this repo's GitHub Releases. The route
  // appends `/download/agent-v<ver>/<asset>`.
  agentReleasesBaseUrl: z
    .string()
    .url()
    .default("https://github.com/Cloudgeni-ai/opengeni/releases"),
  // Explicit operator-controlled promotion pointer for `/agent/latest/*`.
  // Versioned agent releases are immutable; changing this setting promotes or
  // rolls back the stable channel without moving or deleting a provider tag.
  agentStableVersion: z
    .string()
    .regex(/^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/u)
    .default("0.1.16"),
  // Optional independent beta-channel pointer. When unset, the beta update
  // manifest route is unavailable rather than silently serving stable.
  agentBetaVersion: z
    .string()
    .regex(/^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/u)
    .optional(),
  productAccessMode: ProductAccessMode.default("local"),
  // --- canonical organization-tenancy authority activation, default OFF ---
  // The named PRE-ACTIVATION opt-out for the organization-tenancy program. FALSE (the
  // default, and the value an operator leaves in place to decline or defer) means
  // this deployment stays on the reversible legacy workspace-owned lane: no phase-F
  // subsystem may switch its access decision to organization/membership authority
  // ids. TRUE is an operator's explicit statement that the activation preconditions
  // in docs/organization-tenancy.md have been proven for this deployment and that
  // the one-way boundary is accepted.
  //
  // This is NOT a kill switch and NOT a rollback: once an activation migration has
  // committed, setting it back to false does not restore the legacy authority - only
  // forward recovery is available. It also grants and revokes nothing by itself;
  // every individual authorization decision keeps its own fences.
  //
  // No runtime path reads it yet: canonical activation (phase F) is unshipped, so
  // the flag exists to reserve the name, pin the safe default, and give every future
  // activation slice one gate to consult. EnvBoolean (NOT z.coerce.boolean(), which
  // coerces "false" -> true and would activate the moment an operator wrote the
  // variable out to disable it).
  organizationTenancyCanonicalActivationEnabled: EnvBoolean.default(false),
  billingMode: BillingMode.default("disabled"),
  entitlementsMode: EntitlementsMode.default("none"),
  usageLimitsMode: UsageLimitsMode.default("none"),
  staticEntitlementsJson: z.string().default("{}"),
  staticUsageLimitsJson: z.string().default("{}"),
  delegationSecret: z.string().optional(),
  defaultFirstPartyMcpTools: EnvFirstPartyMcpTools,
  allowedFirstPartyMcpTools: EnvFirstPartyMcpTools,
  // sandbox workspace scoped stream-token HMAC secret (sandbox contract §C.3 / stream-token availability contract).
  // When unset, the API falls back to `delegationSecret` (the same HMAC envelope
  // family, `ogs_` vs `ogd_` prefix). REQUIRED-WHEN-DESKTOP, but the absence of
  // BOTH while sandboxDesktopEnabled=true is a GRACEFUL DEGRADE (DesktopStream
  // transport:null + a loud boot warning), NOT a hard boot-fail (stream-token availability contract).
  streamTokenSecret: z.string().optional(),
  // The desktop input plane (raw stream:control writes) is OFF in v1: even a
  // holder of stream:control gets 403 until this flips. Keeps stream:control a
  // declared-but-inert permission so later hardening is a flag flip.
  streamControlEnabled: EnvBoolean.default(false),
  // Provider-neutral advisory work discovery rollout. Disabling this keeps
  // ordinary session listings available while rejecting relevance discovery
  // and omitting claim evidence from their compact projections.
  workDiscoveryEnabled: EnvBoolean.default(true),
  // Exact-attempt claim mutations are independently reversible. Turning this
  // off removes the first-party mutation tools; durable claims and lifecycle
  // settlement evidence remain readable.
  workClaimMutationsEnabled: EnvBoolean.default(true),
  // Human presentation is a separate rollout stage from the read API. The
  // topology response carries this decision so clients can hide advisory UI
  // without inventing authorization or ownership semantics.
  workDiscoveryHumanAdvisoriesEnabled: EnvBoolean.default(true),
  // Automatic overlap nudges are deliberately unshipped and default OFF until
  // an evaluated precision threshold and operator runbook approve them.
  workDiscoveryAutomaticNudgesEnabled: EnvBoolean.default(false),
  // Optional release-coherent bootstrap hint for custom rigs/connected machines
  // that do not carry the stock-image ogtool binary. Exact stable versions only:
  // the agent must never guess a tag or silently install `latest`.
  ogtoolPackageSpec: z
    .string()
    .regex(/^@opengeni\/ogtool@(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/u)
    .optional(),
  environmentsEncryptionKey: z.string().optional(),
  integrationsEnabled: EnvBoolean.default(false),
  integrationsStateSecret: z.string().optional(),
  integrationsAllowPrivateNetworkTargets: EnvBoolean.default(false),
  integrationsOauthClientsJson: z.string().default("{}"),
  slackClientId: z.string().optional(),
  slackClientSecret: z.string().optional(),
  slackSigningSecret: z.string().optional(),
  slackBotDisplayName: OpenGeniSlackBotDisplayName.default("OpenGeni"),
  slackCommand: z
    .string()
    .trim()
    .regex(/^\/[a-z0-9_-]{1,31}$/u)
    .default("/opengeni"),
  googleDriveClientId: z.string().optional(),
  googleDriveClientSecret: z.string().optional(),
  googleDriveSyncMaxItems: z.coerce.number().int().positive().max(10_000).default(500),
  googleDriveSyncMaxBytes: z.coerce
    .number()
    .int()
    .positive()
    .max(5_000_000_000)
    .default(500_000_000),
  googleDriveSyncMaxFileBytes: z.coerce
    .number()
    .int()
    .positive()
    .max(5_000_000_000)
    .default(100_000_000),
  googleDriveSyncMaxProviderRequests: z.coerce.number().int().positive().max(10_000).default(1_000),
  googleDriveSyncMaxElapsedSeconds: z.coerce.number().int().positive().max(3_600).default(300),
  googleDriveSyncMaxFailureDetails: z.coerce.number().int().positive().max(100).default(25),
  googleDriveProviderRequestTimeoutMs: z.coerce
    .number()
    .int()
    .min(1_000)
    .max(GOOGLE_DRIVE_PROVIDER_REQUEST_TIMEOUT_MAX_MS)
    .default(30_000),
  googleDriveProviderRetryAttempts: z.coerce.number().int().min(1).max(5).default(3),
  googleDriveProviderRetryInitialDelayMs: z.coerce
    .number()
    .int()
    .positive()
    .max(30_000)
    .default(250),
  googleDriveProviderRetryMaxDelayMs: z.coerce
    .number()
    .int()
    .positive()
    .max(GOOGLE_DRIVE_PROVIDER_RETRY_DELAY_MAX_MS)
    .default(5_000),
  googleDriveProviderRetryBudgetMs: z.coerce.number().int().positive().max(120_000).default(15_000),
  fikenClientId: z.string().optional(),
  fikenClientSecret: z.string().optional(),
  googleDriveWorkspaceEventsEnabled: EnvBoolean.optional(),
  atlassianClientId: z.string().optional(),
  atlassianClientSecret: z.string().optional(),
  // Undefined is meaningful: the migration boundary persists the product
  // default of 3 when no deployment override is supplied.
  maxNestedAgentDepth: z.coerce.number().int().nonnegative().max(MAX_NESTED_AGENT_DEPTH).optional(),
  // Operator OAuth apps for first-party social connectors, keyed by provider
  // id ("x", "reddit"): {"x":{"clientId":"...","clientSecret":"..."}}.
  socialOauthClientsJson: z.string().default("{}"),
  // Session goal guard rails. Goals are designed for runs that legitimately
  // span days, so length is bounded by explicit completion/pause and budget
  // exhaustion, never by count. goalMaxAutoContinuations is therefore UNSET
  // by default (no cap); deployments may configure one, and it then acts as a
  // hard ceiling that per-goal overrides can only lower.
  goalMaxAutoContinuations: z.coerce.number().int().positive().optional(),
  // Idle backoff between CONSECUTIVE no-input goal continuations. This is
  // pacing, not a cap: the first continuation after a turn that consumed any
  // external input is immediate, the n-th consecutive no-input continuation
  // waits schedule[min(n - 1, last)] ms after the previous one finished, and
  // any new input (machine input, human/API prompt, Steer) wakes the session
  // immediately. The delay never exceeds goalIdleBackoffMaxMs.
  goalIdleBackoffMs: EnvGoalIdleBackoffMs.default(DEFAULT_GOAL_IDLE_BACKOFF_MS),
  goalIdleBackoffMaxMs: z.coerce
    .number()
    .int()
    .positive()
    .default(DEFAULT_GOAL_IDLE_BACKOFF_MAX_MS),
  // Child lifecycle notices: a child session's requires_action freeze, its
  // resolution, a direct Pause, a provider-capacity wait, and goal progress
  // become typed `session_system_updates` rows for the parent (in addition to
  // `child_terminal_result`). Rolling hazard: a pre-notice worker throws on an
  // unknown update kind, so enable only once the whole fleet runs an image
  // that understands the new kinds. Once the flag has produced rows, a
  // pre-notice image must never restart while any new-kind row is still
  // pending (session_system_updates or session_system_update_outbox); turning
  // the flag back off stops production but does not drain already committed
  // rows. Default off. The API and both workers install the validated value
  // into @opengeni/db once at boot.
  // Env: OPENGENI_CHILD_LIFECYCLE_NOTICES_ENABLED.
  childLifecycleNoticesEnabled: EnvBoolean.default(false),
  // Per-channel and per-DM Slack workspace routing. Default ON. A channel does
  // not count a personal workspace as a candidate, so an organization with one
  // shared workspace resolves it as the sole candidate and never asks; the
  // visible change is confined to organizations that genuinely have more than
  // one - plus one case worth knowing before an upgrade: a person who has lost
  // live authority now receives a posted refusal where the pre-routing code
  // failed silently. Set the env var to `false` to restore the short-circuit
  // to the installation's own workspace.
  // Env: OPENGENI_SLACK_WORKSPACE_ROUTING_ENABLED.
  slackWorkspaceRoutingEnabled: EnvBoolean.default(true),
  // Per-segment ceiling on agent loop turns (model calls) within a single
  // session turn. Effectively unbounded by default for the same reason as
  // above; the graceful max-turns valve (idle + goal continuation, never a
  // session failure) remains as inert safety should a deployment set a cap.
  agentMaxModelCallsPerTurn: z.coerce.number().int().positive().default(1_000_000),
  // Deployment fallback for models that do not declare their own window.
  // Built-in billed GPT-5.6 Sol/Terra/Luna pin Codex's 272k catalog instead.
  // OpenGeni always performs one durable, portable plaintext compaction
  // transition; there is no provider/server/off mode ladder.
  contextWindowTokens: z.coerce.number().int().positive().default(1_050_000),
  // Optional model-catalog effective input ceiling. Codex and billed GPT-5.6
  // models expose this as raw context_window * effective_context_window_percent;
  // when absent, retain the deployment-level window-minus-reserved-output
  // behavior.
  contextEffectiveWindowTokens: z.coerce.number().int().positive().optional(),
  // Proactive compaction threshold as a ratio of the model context window.
  // Defaults to 90%: compact as late as possible — retained context beats early
  // headroom now that per-model windows are declared honestly (input-effective,
  // empirically measured), and the fail-closed reactive compact-on-reject path
  // absorbs any overshoot as one retried call rather than a dead session.
  // Clamped to [0.3, 0.9] so deployments can tune the trigger without
  // accidentally disabling compaction.
  contextCompactionThresholdRatio: z.coerce
    .number()
    .default(0.9)
    .transform((value) => {
      if (!Number.isFinite(value)) {
        return 0.9;
      }
      return Math.min(0.9, Math.max(0.3, value));
    }),
  // Tokens reserved for model output; subtracted from the window to get the
  // usable input budget B = contextWindowTokens - contextReservedOutputTokens.
  contextReservedOutputTokens: z.coerce.number().int().nonnegative().default(128_000),
  // Model-catalog auto-compact limit. When present it is clamped to
  // 90% of the raw window, matching Codex core's auto_compact_token_limit().
  contextAutoCompactThresholdTokens: z.coerce.number().int().positive().optional(),
  // Provider-neutral fallback for canonical model-facing tool-result text.
  // The current stable Codex catalog policy is 10k tokens; the truncator adds
  // Codex's 1.2x JSON serialization allowance when applying it.
  modelToolOutputTruncationTokens: z.coerce.number().int().positive().default(10_000),
  authRequired: EnvBoolean.default(false),
  accessKey: z.string().optional(),
  authAllowHealth: EnvBoolean.default(true),
  authAllowMetrics: EnvBoolean.default(false),
  apiHost: z.string().default("0.0.0.0"),
  apiPort: z.coerce.number().int().positive().default(8000),
  workerHttpPort: z.coerce.number().int().positive().default(8001),
  // Worker-side first-party MCP traffic stays on the deployment's internal
  // network. OPENGENI_MCP_URL remains the sandbox/external route used by
  // Codemode and remote placements.
  opengeniMcpInternalUrl: z.string().url().optional(),
  opengeniMcpUrl: z.string().url().optional(),
  // Origins allowed to send browser cookies cross-origin. Other origins may
  // call the public API with bearer credentials, but never receive credentialed
  // CORS responses.
  corsAllowOriginRegex: z.string().default(String.raw`^https?://(localhost|127\.0\.0\.1)(:\d+)?$`),
  openaiProvider: z.enum(["openai", "azure"]).default("openai"),
  openaiApiKey: z.string().optional(),
  openaiBaseUrl: z.string().optional(),
  openaiModel: z.string().default("gpt-5.6-sol"),
  openaiAllowedModels: z.string().default("gpt-5.6-sol,gpt-5.6-terra,gpt-5.6-luna"),
  // OpenGeni-managed Vercel AI Gateway. When configured, the two reviewed
  // Gateway models below are added to the managed-credit catalog. Workspace
  // Gateway keys use the encrypted connection broker and never this secret.
  vercelAiGatewayApiKey: z.string().optional(),
  /** Image adapter route; native hosted providers ignore this model. */
  imageGenerationModel: z.string().trim().min(1).max(256).default("openai/gpt-image-2"),
  /** Durable video generation uses the workspace-owned Gateway credential. */
  videoGenerationPollIntervalMs: z.coerce.number().int().min(1_000).max(60_000).default(5_000),
  videoGenerationRecoveryDeadlineMs: z.coerce
    .number()
    .int()
    .min(60_000)
    .max(24 * 60 * 60_000)
    .default(2 * 60 * 60_000),
  videoGenerationReferenceUrlTtlSeconds: z.coerce
    .number()
    .int()
    .min(300)
    .max(6 * 60 * 60)
    .default(60 * 60),
  videoGenerationMaxConcurrentPerWorkspace: z.coerce.number().int().min(1).max(16).default(2),
  videoGenerationWorkspaceQuotaBytes: z.coerce
    .number()
    .int()
    .positive()
    .max(Number.MAX_SAFE_INTEGER)
    .default(20 * 1024 * 1024 * 1024),
  videoGenerationTempDirectory: z.string().trim().min(1).max(1_024).default("/tmp/opengeni-video"),
  videoGenerationFfprobePath: z.string().trim().min(1).max(1_024).default("ffprobe"),
  // OpenGeni's customer price, not a claim about the provider's delayed cost report.
  // The durable operation freezes the exact resulting price before provider submit.
  videoGenerationCredit480pMicrosPerSecond: z.coerce
    .number()
    .int()
    .positive()
    .max(10_000_000)
    .default(155_000),
  videoGenerationCredit720pMicrosPerSecond: z.coerce
    .number()
    .int()
    .positive()
    .max(10_000_000)
    .default(350_000),
  // Native composer voice input (browser MediaRecorder → API transcription).
  // Provider credentials stay server-side; ClientConfig only projects availability
  // and hard ceilings. Selection happens once before audio is sent — never retry
  // the same clip across vendors after an upstream request may have started.
  voiceInputMaxDurationSeconds: z.coerce.number().int().positive().max(600).default(60),
  voiceInputMaxSizeBytes: z.coerce
    .number()
    .int()
    .positive()
    .max(25 * 1024 * 1024)
    .default(25 * 1024 * 1024),
  // Durable long-form capture uploads bounded chunks to object storage, then
  // normalizes them into provider-safe segments. It is advertised only when
  // object storage and the configured ffmpeg executable are both available.
  voiceInputResumableEnabled: EnvBoolean.default(true),
  voiceInputResumableMaxDurationSeconds: z.coerce
    .number()
    .int()
    .positive()
    .max(8 * 60 * 60)
    .default(2 * 60 * 60),
  voiceInputResumableMaxSizeBytes: z.coerce
    .number()
    .int()
    .positive()
    .max(512 * 1024 * 1024)
    .default(512 * 1024 * 1024),
  voiceInputResumableMaxChunkSizeBytes: z.coerce
    .number()
    .int()
    .positive()
    .max(25 * 1024 * 1024)
    .default(8 * 1024 * 1024),
  voiceInputResumableRetentionSeconds: z.coerce
    .number()
    .int()
    .positive()
    .max(7 * 24 * 60 * 60)
    .default(24 * 60 * 60),
  voiceInputFfmpegPath: z.string().trim().min(1).max(1024).default("ffmpeg"),
  // Preferred provider order (comma-separated ids). First configured+ready wins.
  // Connected subscription STT is preferred by default; operators can put
  // openai/azure-openai first explicitly.
  // Supported: supergrok-subscription, codex-subscription, openai, azure-openai.
  voiceInputProviderOrder: z
    .string()
    .default("supergrok-subscription,codex-subscription,openai,azure-openai"),
  // OpenAI public /v1/audio/transcriptions path. Reuses OPENGENI_OPENAI_API_KEY
  // when voiceInputOpenaiApiKey is unset. Default model is gpt-transcribe.
  voiceInputOpenaiEnabled: EnvBoolean.default(true),
  voiceInputOpenaiApiKey: z.string().optional(),
  voiceInputOpenaiBaseUrl: z.string().optional(),
  voiceInputOpenaiModel: z.string().default("gpt-transcribe"),
  // Azure OpenAI deployment-scoped audio transcriptions. Reuses the turn-model
  // Azure endpoint/key/AD token when voice-specific overrides are unset.
  voiceInputAzureEnabled: EnvBoolean.default(true),
  voiceInputAzureEndpoint: z.string().optional(),
  voiceInputAzureDeployment: z.string().optional(),
  voiceInputAzureApiVersion: z.string().optional(),
  voiceInputAzureApiKey: z.string().optional(),
  voiceInputAzureAdToken: z.string().optional(),
  // Legacy opt-in for undocumented ChatGPT /backend-api/transcribe. When
  // OPENGENI_CODEX_SUBSCRIPTION_ENABLED is true, Codex STT is included without
  // this flag. Set false and omit codex-subscription from PROVIDER_ORDER to
  // keep subscription model routing while disabling Codex voice input.
  voiceInputCodexExperimentalEnabled: EnvBoolean.default(false),
  modelPricingJson: z.string().default("{}"),
  // Supported-model membership source. Database mode is resolved by the async
  // core overlay; getSettings remains synchronous and env-only.
  modelCatalogSource: z.enum(["code", "database"]).default("code"),
  // Deployment-owned workspace-facing price policy. This is deliberately
  // separate from catalog membership and upstream credential ownership.
  // Shape: { "product/model-id": "free" | "credits" }.
  modelCostPolicyJson: z.string().default("{}"),
  // Optional per-product agent guidance. Database mode replaces this with the
  // singleton document's validated modelNotes map.
  modelNotesJson: z.string().default("{}"),
  // Managed OpenRouter credential. The curated model table is injected in
  // code/catalog-document resolution and never read from host provider JSON.
  openrouterApiKey: z.string().optional(),
  // Internal, secret-free catalog overlays populated only by
  // applyModelCatalogDocument. They intentionally have no OPENGENI_* env
  // binding so database mode cannot be bypassed with a second source.
  resolvedGatewayModelsJson: z.string().optional(),
  resolvedOpenRouterModelsJson: z.string().optional(),
  // Extra (non-built-in) model providers, declared by the host as a JSON
  // provider registry. Each entry carries its own base URL, API key, wire API
  // ("responses" | "chat") and the models it exposes. The models a client may
  // use are the UNION of the built-in provider's allowed models and every
  // registry provider's models. validateSettings parses this at boot so a
  // malformed registry / unresolvable key / id collision fails fast.
  modelProvidersJson: z.string().default("[]"),
  // Codex (ChatGPT) subscription: when enabled, a per-workspace connected
  // subscription is injected as a synthetic "codex-subscription" registry
  // provider whose models route through the ChatGPT backend (@opengeni/codex).
  codexSubscriptionEnabled: EnvBoolean.default(false), // OPENGENI_CODEX_SUBSCRIPTION_ENABLED
  // SuperGrok/xAI connected subscription. This is a workspace-scoped OAuth
  // account pool and a distinct rail from the existing xai/* API-key provider.
  supergrokSubscriptionEnabled: EnvBoolean.default(false), // OPENGENI_SUPERGROK_SUBSCRIPTION_ENABLED
  // Maximum silence between complete, valid SuperGrok SSE data events. This is
  // not a request/run duration cap; every valid event resets the timer.
  supergrokResponseStreamIdleTimeoutMs: z.coerce
    .number()
    .int()
    .positive()
    .max(24 * 60 * 60_000)
    .default(XAI_RESPONSE_STREAM_IDLE_TIMEOUT_MS),
  // Expose the connected apps attached to a Codex subscription through the
  // synthetic codex_apps MCP server. Independent from subscription routing so
  // operators can use Codex models without exposing ChatGPT connectors.
  codexConnectedAppsEnabled: EnvBoolean.default(false), // OPENGENI_CODEX_CONNECTED_APPS_ENABLED
  codexProductSku: z.string().optional(), // OPENGENI_CODEX_PRODUCT_SKU (X-OpenAI-Product-Sku, apps only)
  // Progressive MCP disclosure (Codex-CLI-style tool_search): on a codex turn,
  // flag non-eager selected MCP tools `defer_loading:true` (dropping their
  // schemas from model context) and add one client-executed tool_search tool
  // that BM25-discloses bounded matches. Only an exact session tool ref with
  // `eager:true` stays on the startup path; mandatory selection alone does not
  // imply eagerness. Default ON so selected connector catalogues do not consume
  // every Codex turn's context. Operators may explicitly disable it for
  // emergency compatibility diagnosis.
  // OPENGENI_CODEX_TOOL_SEARCH_ENABLED
  codexToolSearchEnabled: EnvBoolean.default(true),
  // Provider-neutral progressive disclosure for direct OpenAI/Azure native
  // client search and ordinary-function generic dispatch. Kept separate from
  // the Codex rollout so an emergency Codex opt-out cannot disable every model.
  // OPENGENI_LAZY_TOOL_SEARCH_ENABLED
  lazyToolSearchEnabled: EnvBoolean.default(true),
  // credential allocator atomic, workspace-local credential allocation. Default OFF is a
  // deliberate rolling-deploy fence: migrate + roll every worker first, then
  // enable. Turning it off restores the legacy sticky selector without a schema
  // rollback; the additive lease table/cursor columns become inert.
  codexCredentialLeasingEnabled: EnvBoolean.default(false),
  // Decision-observability fence. When enabled, the worker emits one
  // bounded, metadata-only adaptive-policy replay record alongside the unchanged
  // sticky-sharded decision. It never changes placement/admission/failover.
  codexFleetPolicyShadowEnabled: EnvBoolean.default(false),
  // Multi-account P3 (auto-rotation): an account is "near exhaustion" — ineligible to be
  // rotated TO — when EITHER usage window (5h/weekly) is at/over this percent. Default 90 to
  // match the UI danger flip (UsageBar danger at pct >= 90). OPENGENI_CODEX_ROTATION_NEAR_EXHAUSTION_PCT.
  codexRotationNearExhaustionPct: z.coerce.number().int().min(1).max(100).default(90),
  openaiReasoningEffort: ReasoningEffort.default("low"),
  openaiAllowedReasoningEfforts: z.string().default("low,medium,high,xhigh,max"),
  openaiResponsesTransport: z.enum(["http", "websocket"]).default("http"),
  // Provider-assigned item ids (rs_/msg_/fc_…) in Responses API input are
  // resolved against the provider's server-side response store. That store is
  // not durable enough to anchor long runs on: a response that streamed fine
  // can be missing from the store on the very next model call, which then
  // fails with 400 "Item with id ... not found". "strip" removes the ids from
  // every model-call input so requests are self-contained — conversation
  // truth already lives client-side in session_history_items. "preserve"
  // keeps the SDK's pass-through behavior.
  openaiProviderItemIds: z.enum(["strip", "preserve"]).default("strip"),
  // With ids stripped the provider cannot resolve prior reasoning server-side,
  // so request reasoning.encrypted_content and send it back with each call:
  // reasoning continuity without depending on provider-side storage.
  openaiReasoningEncryptedContent: EnvBoolean.default(true),
  // Model-call retry budget for transient provider failures (429s and friends).
  // The openai client default of 2 retries is too small for sustained TPM
  // backpressure during long autonomous runs.
  openaiMaxRetries: z.coerce.number().int().nonnegative().default(5),
  // Native hosted web search. The live Azure Responses path executes the
  // hosted web_search tool, so this is provider-unconditional: ON by default
  // on every provider, exposed only so operators can disable it. When true,
  // buildOpenGeniAgent attaches webSearchTool() to the agent's tools — it is
  // merged with the MCP-server tools (getAllTools = [...mcpTools, ...tools])
  // and the sandbox capability tools, never replacing them.
  webSearchEnabled: EnvBoolean.default(true),
  // Deployment-default agent persona template (the white-label surface). The
  // runtime resolves the effective template per turn as
  // per-session-override > per-workspace override > this default, substitutes
  // the non-bypassable CORE at AGENT_INSTRUCTIONS_CORE_PLACEHOLDER (or appends
  // it when the template omits the marker), and uses the result as the agent's
  // instructions. Defaulting to DEFAULT_AGENT_INSTRUCTIONS keeps the composed
  // default pinned by runtime tests.
  agentInstructionsTemplate: z.string().default(DEFAULT_AGENT_INSTRUCTIONS),
  azureOpenaiBaseUrl: z.string().optional(),
  azureOpenaiEndpoint: z.string().optional(),
  azureOpenaiDeployment: z.string().optional(),
  azureOpenaiApiVersion: z.string().optional(),
  azureOpenaiApiKey: z.string().optional(),
  azureOpenaiAdToken: z.string().optional(),
  disableOpenaiTracing: EnvBoolean.default(false),
  sandboxBackend: SandboxBackend.default("docker"),
  dockerImage: z.string().default("opengeni-sandbox:local"),
  // Explicit deployment contract: the configured base sandbox image contains
  // the verified, self-contained native artifact runtime at its fixed image
  // paths. Disabled by default so arbitrary/custom provider images never make
  // document/spreadsheet/presentation skills appear when their runtime is
  // absent. Per-pack/per-rig image overrides fail closed in the worker even
  // when this base-image contract is enabled.
  sandboxArtifactRuntimeEnabled: EnvBoolean.default(false),
  dockerExposedPorts: z.string().default(""),
  dockerNetwork: z.string().optional(),
  // When the worker itself runs in a container and talks to a host Docker daemon,
  // this directory must be bind-mounted at the exact same absolute path on both
  // sides. The Agents SDK materializes the workspace here before bind-mounting it
  // into the sandbox container.
  dockerWorkspaceBaseDir: z.string().min(1).optional(),
  modalAppName: z.string().default("opengeni-sandbox"),
  modalImageRef: z.string().optional(),
  // Provider-native immutable Modal image ID for the exact logical
  // `modalImageRef`. When set, the runtime uses ModalImageSelector.fromId and
  // never asks Modal to parse or import the registry ref. The logical ref is
  // still persisted on the sandbox lease for provenance and conflict fencing;
  // the Modal session envelope persists the actual image ID.
  modalImageId: z
    .string()
    // Modal image IDs are provider-opaque. Older builds use a 22-character
    // random suffix while current filesystem snapshots use a 26-character
    // ULID suffix. Validate the stable namespace/safe alphabet and let Modal
    // remain authoritative over current/future suffix lengths.
    .min(4)
    .max(128)
    .regex(/^im-[A-Za-z0-9]+$/)
    .optional(),
  // Name of a Modal Secret (containing REGISTRY_USERNAME + REGISTRY_PASSWORD) used
  // to authenticate the pull of `modalImageRef` from a PRIVATE registry. When UNSET
  // (the default), the sandbox image is pulled UNAUTHENTICATED — i.e. it must be a
  // PUBLIC registry tag, which is the only shape the Agents-extension Modal backend
  // supports out of the box (`Image.fromRegistry(tag)` with no secret). Set this to
  // run a private image (e.g. a cloud-hosted ACR/ECR/GCR digest): the runtime resolves
  // the named Secret and builds the image via `fromRegistry(tag, secret)` before the
  // first sandbox is created. Knob: OPENGENI_MODAL_IMAGE_REGISTRY_SECRET.
  modalImageRegistrySecret: z.string().optional(),
  // Modal's hard sandbox lifetime (timeoutMs = this * 1000), counted from box
  // creation. A resume-by-id does NOT reset that provider clock. It is the
  // BACKSTOP that reclaims a box if the reaper/worker is down, NOT the warm-window
  // controller (that's sandboxIdleGraceMs). It must comfortably exceed
  // reaperPeriod + idleGrace so the reaper terminates a genuinely-idle box FIRST;
  // the boot invariant below enforces that. Default 24h, Modal's documented
  // maximum, to reduce premature active-box loss and leave headroom for the
  // deadline-aware snapshot/rematerialization transition. The transition—not a
  // larger timeout—is what lets a session outlive one finite provider box.
  // Knob: OPENGENI_MODAL_TIMEOUT_SECONDS.
  modalTimeoutSeconds: z.coerce.number().int().positive().max(86_400).default(86_400),
  // Optional provider reservations for every new Modal sandbox. CPU is measured
  // in physical cores and may be fractional; memory is measured in MiB. Leave
  // both unset to preserve Modal's provider defaults. The Agents adapter stores
  // the resolved values in its session state so snapshot replacement and exact
  // resume cannot silently change the reservation.
  modalSandboxCpu: z.coerce.number().positive().optional(),
  modalSandboxMemoryMiB: z.coerce.number().int().positive().optional(),
  modalTokenId: z.string().optional(),
  modalTokenSecret: z.string().optional(),
  modalEnvironment: z.string().optional(),
  // modal gap-fill: idleTimeoutMs + workspacePersistence were unmapped (module 03 §4.1).
  //
  // CRITICAL (sandbox-file-persistence): when this is UNSET the Modal SDK sends
  // idleTimeoutSecs=undefined, so Modal applies its OWN short server-default idle
  // timeout (~minutes) — and a box between turns sits with NO active connection,
  // so that idle clock runs and Modal idle-reaps the box LONG before OpenGeni's
  // own reaper waits out sandboxIdleGraceMs (15min) to resume+persist+terminate
  // it. The observed failure: every drain logs "drainable box already gone
  // (NotFound on resume)", persistWorkspace() never fires, /workspace is lost.
  // Modal's idle-reap is a SECOND reaper racing OpenGeni's — and it wins. The fix:
  // OpenGeni OWNS box lifecycle via its reaper + the hard modalTimeoutSeconds
  // backstop, so the Modal idle-reap must NOT fire first. We default the effective
  // idle timeout to the hard lifetime (effectiveModalIdleTimeoutSeconds), making
  // the box survive its full warm window so the reaper can snapshot it. Set this
  // explicitly (OPENGENI_MODAL_IDLE_TIMEOUT_SECONDS) only to deliberately idle-reap
  // SOONER than the hard lifetime; the boot invariant forbids a value that would
  // reap before reaperPeriod + idleGrace elapses.
  modalIdleTimeoutSeconds: z.coerce.number().int().positive().optional(),
  // /workspace FILE PERSISTENCE across warm/cold cycles. Directory snapshots
  // preserve only the durable user workspace, so provider recovery does not
  // restore an entire machine image or replace the selected rig/base image.
  // Cold restore derives the mode from its verified native artifact, so existing
  // serialized sessions remain recoverable; this default governs archive-free
  // Modal creations only.
  // `snapshot_filesystem` remains available for explicit compatibility and
  // immutable rig-image materialization. `tar` is the portable fallback.
  modalWorkspacePersistence: z
    .enum(["tar", "snapshot_filesystem", "snapshot_directory"])
    .default("snapshot_directory"),
  // Shared desktop toggle: this module reads it for the 6080 port-merge; the
  // owner module (P4.x) acts on it to launch the display stack.
  sandboxDesktopEnabled: EnvBoolean.default(false),
  // Human take-control toggle: when ON (default) the negotiated DesktopStream
  // cell advertises mode "interactive" — the noVNC viewer can drive mouse+keyboard
  // into :0 (x11vnc runs without -viewonly). Turn it OFF for a genuinely read-only
  // deployment: the cell reports mode "read-only" and the client disables the
  // "Take control" affordance. This gates the HUMAN viewer plane; agent
  // interaction is authorized through managed ComputerSession tools.
  sandboxDesktopInteractive: EnvBoolean.default(true),
  // REAL PTY terminal toggle (P5.t): gates the ttyd pty-ws plane (7681) the API
  // mints over the SAME tunnel as the desktop. Defaults ON — the interactive
  // terminal is a baseline structured-service surface (unlike the heavier desktop
  // pixel plane); a deployment can turn it off to fall back to the read-only
  // sse-events command firehose. The 7681 port-merge tracks sandboxDesktopEnabled
  // (a desktop-capable image is the one that bakes ttyd).
  sandboxTerminalEnabled: EnvBoolean.default(true),
  // The desktop framebuffer geometry the pixel plane advertises + launches the
  // display stack with (P4.2). v1 has no live RANDR resize; a change is a full
  // down→up restart. Defaults match the proven spike geometry (1280x800).
  streamResolutionWidth: z.coerce.number().int().positive().default(1280),
  streamResolutionHeight: z.coerce.number().int().positive().default(800),
  // Recording loop: ffmpeg x11grab of :0 → mp4/webm → @opengeni/storage.
  // recordingMaxBytes caps the in-memory finalize buffer (≤ storage single-PUT);
  // recordingMaxSeconds is the ffmpeg -t hard ceiling (bounds a multi-day turn).
  recordingEnabled: EnvBoolean.default(true),
  recordingDefaultCodec: z.enum(["h264-mp4", "vp9-webm"]).default("h264-mp4"),
  // Workbench v2 turn-end workspace capture. When on, the turn
  // activity probes the box's changed files off the live box at turn end and
  // persists a capture revision (blobs in @opengeni/storage) so the workbench
  // paints cold/offline sessions with zero machine round-trips. Best-effort and
  // fully behind this flag: off ⇒ capture is skipped and reads fall back to the
  // live/wake path (status-quo behavior). Default on; explicit per environment.
  workspaceCaptureEnabled: EnvBoolean.default(true),
  recordingFramerate: z.coerce.number().int().positive().default(15),
  recordingMaxSeconds: z.coerce.number().int().positive().default(600),
  recordingMaxBytes: z.coerce.number().int().positive().default(268_435_456), // 256 MB
  // --- daytona ---
  daytonaApiKey: z.string().optional(),
  daytonaApiUrl: z.string().url().optional(),
  daytonaTarget: z.string().optional(),
  daytonaImage: z.string().optional(),
  daytonaSnapshotName: z.string().optional(),
  daytonaAutoStopInterval: z.coerce.number().int().nonnegative().optional(), // 0 disables idle-kill
  daytonaTimeoutSeconds: z.coerce.number().int().positive().optional(),
  daytonaExposedPortUrlTtlSeconds: z.coerce.number().int().positive().optional(),
  // --- runloop ---
  runloopApiKey: z.string().optional(),
  runloopBaseUrl: z.string().url().optional(),
  runloopBlueprintName: z.string().optional(),
  runloopBlueprintId: z.string().optional(),
  runloopTunnel: EnvBoolean.default(true),
  runloopKeepAliveSeconds: z.coerce.number().int().positive().optional(),
  // --- e2b (SDK reads E2B_API_KEY from env; mirrored for validation + forwarding) ---
  e2bApiKey: z.string().optional(),
  e2bTemplate: z.string().optional(),
  e2bTimeoutSeconds: z.coerce.number().int().positive().optional(),
  e2bTimeoutAction: z.enum(["pause", "kill"]).optional(),
  e2bAllowInternetAccess: EnvBoolean.optional(),
  e2bAutoResume: EnvBoolean.optional(),
  e2bWorkspacePersistence: z.enum(["tar", "snapshot"]).optional(),
  // --- blaxel ---
  blaxelApiKey: z.string().optional(),
  blaxelImage: z.string().optional(),
  blaxelRegion: z.string().optional(),
  blaxelExposedPortPublic: EnvBoolean.optional(), // public vs bl_preview_token
  blaxelExposedPortUrlTtlSeconds: z.coerce.number().int().positive().optional(),
  blaxelMemoryMb: z.coerce.number().int().positive().optional(),
  blaxelTtl: z.string().optional(),
  // --- cloudflare (headless) ---
  cloudflareWorkerUrl: z.string().url().optional(),
  cloudflareApiKey: z.string().optional(),
  // --- remote browser placements ---
  // Provider credentials are injected only into the placement-resident
  // browserd launch. They never enter session contracts, journals, or sandboxes.
  browserbaseApiKey: z.string().min(1).max(8192).optional(),
  kernelApiKey: z.string().min(1).max(8192).optional(),
  kernelEndpoint: z.string().url().optional(),
  kernelBrowserTimeoutSeconds: z.coerce.number().int().positive().max(86_400).default(3_600),
  kernelBrowserStealth: EnvBoolean.default(false),
  // --- vercel (headless) ---
  vercelToken: z.string().optional(),
  vercelProjectId: z.string().optional(),
  vercelTeamId: z.string().optional(),
  vercelRuntime: z.string().optional(),
  // --- OpenSandbox (optional Kubernetes-native provisioned sandbox) ---
  openSandboxBaseUrl: z.string().url().optional(),
  openSandboxApiKey: z.string().min(1).optional(),
  // Release and preview profiles must provide an immutable OCI digest. The
  // adapter refuses tag-only references when this backend is active.
  openSandboxImage: z.string().min(1).optional(),
  // Renewable provider TTL is a leak/backstop clock, not OpenGeni's idle
  // policy. The pinned server accepts a one-minute minimum; ordinary
  // deployments default to one hour.
  openSandboxTtlSeconds: z.coerce.number().int().min(60).max(86_400).default(3_600),
  openSandboxUseServerProxy: EnvBoolean.default(true),
  // Channel B (browserd / noVNC / ttyd) uses OSEP-0011 signed URI-mode ingress.
  // Exec/files stay on the private lifecycle server-proxy regardless of this flag.
  openSandboxSignedEndpoints: EnvBoolean.default(false),
  openSandboxSignedEndpointTtlSeconds: z.coerce.number().int().min(60).max(3_600).default(600),
  openSandboxChannelBPublicBaseUrl: z.string().url().optional(),
  // Emergency hatch only: force JPEG/RFB through the API frame-proxy even when
  // signed endpoints are on (M2 subprotocol failure). Unset means OpenSandbox
  // uses the frame-proxy unless signed endpoints are on.
  openSandboxInteractionFrameProxy: EnvBoolean.optional(),
  openSandboxPoolRef: z
    .string()
    .regex(/^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/)
    .optional(),
  // Optional same-cluster, read-only observability projection. The application
  // chart sets this only on the control worker and mounts a dedicated projected
  // service-account token; non-Kubernetes and remote-provider deployments omit it.
  openSandboxKubernetesInventoryNamespace: z
    .string()
    .min(1)
    .max(63)
    .regex(/^[a-z0-9](?:[-a-z0-9]*[a-z0-9])?$/)
    .optional(),
  // --- sandbox ownership inversion (P1.2 rollout flag, default OFF) ---
  // The keystone flag for the stateless resume-by-id model. When FALSE the
  // agent-turn path is BYTE-FOR-BYTE today's build-and-discard behavior (no
  // lease acquire, no resume-by-id, no non-owned injection). When TRUE the turn
  // activity acquires the group lease, resumes the one box by id from the lease
  // envelope, injects it as a NON-OWNED RunConfig session (the SDK never reaps
  // it — the proven keystone), and releases the holder in finally. Uses
  // EnvBoolean (NOT z.coerce.boolean(), which would coerce "false" -> true and
  // turn the flag ON the moment anyone set the env var to disable it).
  sandboxOwnershipEnabled: EnvBoolean.default(false),
  // --- standalone rig-verifier ownership rollout flag, default OFF ---
  // Rig verification creates a throwaway provider sandbox outside the normal
  // session-turn path. When enabled, that sandbox must first acquire the same
  // durable lease lifecycle used by session boxes so the global orphan sweep
  // recognizes its exact provider instance. Keep this separate from the general
  // sandboxOwnershipEnabled rollout: every reaper worker must understand verifier
  // leases before dispatch is enabled. When false the verifier fails closed before
  // provider create; it never falls back to the legacy unowned path.
  rigVerificationLeaseOwnershipEnabled: EnvBoolean.default(false),
  // --- lazy sandbox provisioning rollout flag, default OFF ---
  // Only effective when sandboxOwnershipEnabled is ALSO on (lazy provisioning is a
  // property of the owned path — the SDK never creates/resumes an injected session,
  // so we control when the box is established). When TRUE, a turn does NOT provision
  // its box at turn start: the lease acquire + resume-by-id + hooks + downloads +
  // heartbeat + recording are deferred to an in-process single-flight provisioner
  // that runs the FIRST time a sandbox op is dispatched (via the routing proxy's
  // resolveActiveBackend). A turn whose model never calls a sandbox-backed tool ends
  // with NO lease row and ZERO warm-seconds. When FALSE (or ownership off) the turn
  // provisions eagerly exactly as today — byte-for-byte. EnvBoolean (NOT
  // z.coerce.boolean(), which coerces "false" -> true and would turn the flag ON the
  // moment anyone set the env var to disable it).
  sandboxLazyProvisionEnabled: EnvBoolean.default(false),
  // --- bring-your-own-compute (selfhosted 11th backend) rollout flag, default OFF ---
  // The keystone flag for the whole selfhosted feature (the enrollment device-flow,
  // the NATS control plane, the relay stream tier). When FALSE the enrollment routes
  // 404 (invisible — the surface does not exist for this deployment) and the
  // selfhosted backend is inert; boot is unaffected. EnvBoolean (NOT
  // z.coerce.boolean(), which coerces "false" -> true). Flipped per-environment via
  // the deploy-staging IaC secret/configmap pattern.
  sandboxSelfhostedEnabled: EnvBoolean.default(false),
  // Gates the op-stream (streaming exec) transport to Connected Machines. The
  // runner must ALSO advertise Capabilities.op_stream. Streaming is the default
  // because it is the only transport that can keep a command alive without an
  // arbitrary request/reply wall while still supporting replay and cancellation.
  // Exec fails closed when the deployment or runner does not provide op-stream.
  // EnvBoolean (NOT
  // z.coerce.boolean(), which coerces "false" -> true).
  agentOpStreamEnabled: EnvBoolean.default(true),
  // The HMAC secret the control plane signs the enrollment bearer credential with
  // (the `oge_` envelope the agent presents back to the control plane). Optional:
  // when ABSENT and sandboxSelfhostedEnabled is on, the poll route reports the
  // credential plane disabled (graceful degrade, mirrors streamTokenSecret). NEVER
  // logged. Lives in the opengeni-runtime secret (Helm-clobbered configmap avoided).
  enrollmentSigningSecret: z.string().optional(),
  // Connect-info the EnrollmentCredentials hand the agent: the NATS server URL(s)
  // the agent dials for the control plane, and the relay edge base URL for streams.
  // The per-workspace NATS Account creds binding is infra-deferred (M4/relay
  // milestone) — the poll returns these endpoints + a placeholder creds field.
  selfhostedNatsUrl: z.string().optional(),
  selfhostedRelayUrl: z.string().optional(),
  // The HMAC secret the control plane signs the agent's relay PRODUCER token with
  // (the `ogr_` envelope threaded into EnrollmentCredentials.relayToken; M8b/design
  // §10.5). The relay verifies the producer token with the SAME secret. Optional:
  // when ABSENT the poll returns an empty relayToken (graceful degrade — the stream
  // plane is simply unavailable until configured). Falls back to streamTokenSecret /
  // delegationSecret (same HMAC family) so a deployment with a stream-token secret
  // needs no second one. NEVER logged. Lives in the opengeni-runtime secret.
  selfhostedRelayTokenSecret: z.string().optional(),
  // The minisign PUBLIC key the agent pins for self-update verification (handed to
  // the agent in EnrollmentCredentials; the SECRET key lives only in CI).
  agentUpdatePublicKey: z.string().optional(),
  // --- NATS auth-callout tenancy boundary (bring-your-own-compute M-AUTH; design
  //     §10.1 NATS Accounts per workspace + §17 the isolation smoke) -------------
  // nats-server is configured with AUTH CALLOUT: an external agent connects
  // presenting its `oge_` enrollment bearer as the connect auth-token; the server
  // issues an authorization request on $SYS.REQ.USER.AUTH to our responder, which
  // validates the bearer, claims one daemon generation, and returns a SIGNED NATS
  // user JWT scoped to that exact process subtree (+ `_INBOX.>`). The exact scope
  // provides both workspace isolation and single-daemon routing authority. These
  // are deployment-level secrets in the opengeni-runtime secret
  // (Helm-clobbered configmap avoided), all OPTIONAL: when the callout plane is not
  // configured the responder simply does not start (selfhosted agents cannot
  // connect — graceful, never a boot-fail).
  //
  // The callout account SIGNING SEED (`SA...`). Both the user JWT and the
  // authorization-response JWT are signed by this account key; its public key
  // (`A...`) is the `auth_callout.issuer` in the server config. NEVER logged.
  selfhostedNatsCalloutAccountSeed: z.string().optional(),
  // The TARGET ACCOUNT NAME the minted user is placed into (the server-config-mode
  // `auth_callout.account`, e.g. "APP"). The responder writes it as the minted user
  // JWT `aud` so nats-server binds the agent to this account — the SAME account the
  // privileged control plane connects into, so exact process request/reply
  // routes. Optional; resolveNatsCalloutConfig defaults it to "APP".
  selfhostedNatsCalloutAccountName: z.string().optional(),
  // The callout RESPONDER's own NATS login (one of the `auth_callout.auth_users`
  // in the AUTH account) — the responder connects with this to subscribe
  // $SYS.REQ.USER.AUTH. Username/password.
  selfhostedNatsCalloutUser: z.string().optional(),
  selfhostedNatsCalloutPassword: z.string().optional(),
  // The PRIVILEGED control-plane login (api/worker): a static account user that may
  // request exact process RPC subjects + receive their inbox replies. The event bus + the
  // selfhosted control RPC ride THIS connection. Username/password; when unset the
  // bus connects anonymously (local dev / a NATS with no auth_callout).
  selfhostedNatsControlUser: z.string().optional(),
  selfhostedNatsControlPassword: z.string().optional(),
  // --- selfhosted (Connected Machine) control/exec op deadlines ---------------
  // CONTROL ops (ping / fs / git / desktop / pty) keep a short request timeout so
  // liveness failures surface promptly. EXEC duration is a different concern: by
  // default it is unbounded (0), exactly like a command launched by an unrestricted
  // local agent. The op-stream transport keeps control liveness, replay, and explicit
  // cancellation independent of command duration. A deployment may opt into a hard
  // process deadline by setting a positive value; 0 never schedules a process kill.
  // Knobs: OPENGENI_SANDBOX_SELFHOSTED_EXEC_TIMEOUT_MS (default 0 = none) and
  // OPENGENI_SANDBOX_SELFHOSTED_CONTROL_TIMEOUT_MS (default 30s).
  sandboxSelfhostedExecTimeoutMs: z.coerce.number().int().nonnegative().default(0),
  sandboxSelfhostedControlTimeoutMs: z.coerce.number().int().positive().default(30_000),
  // --- sandbox lease cadences (cadence invariant validated at boot below) ---
  // reaperPeriod < viewerHolderTTL, and reaperPeriod + idleGrace < the EFFECTIVE
  // box idle timeout (effectiveModalIdleTimeoutSeconds, which defaults to the hard
  // modalTimeoutSeconds). No keep-alive loop: between turns the box survives on its
  // idle timeout — which we pin high enough (via the idle-timeout default) that
  // OpenGeni's reaper, not Modal's idle-reap, governs teardown so /workspace is
  // snapshotted before the box dies (sandbox-file-persistence).
  sandboxLeaseReaperPeriodMs: z.coerce.number().int().positive().default(30_000),
  sandboxViewerHolderTtlMs: z.coerce.number().int().positive().default(90_000),
  // A BrowserSession controller refreshes its durable resource and exact
  // interaction lease holder together. This longer crash horizon tolerates API
  // replacement while still releasing a placement whose controller died.
  sandboxInteractionHolderTtlMs: z.coerce.number().int().positive().default(180_000),
  // The DRAIN grace: how long a refcount-0 (draining) lease stays WARM before the
  // reaper resume-by-ids the box and terminates it. This is the cost-vs-snappiness
  // dial — when the user navigates away the box keeps refcount 0, but it survives
  // this whole window so a "glanced away then came back" re-arms the SAME warm box
  // (acquireLease re-arms draining->warm; the reaper's BEFORE-terminate re-read
  // skips a re-armed box). Default 15min so a brief detour never cold-creates a
  // fresh EMPTY box; lower it to trade warm cost for a snappier reclaim.
  // getSettings caps the default at half a shorter configured Modal lifetime so
  // the entire reaper window always fits. Knob: OPENGENI_SANDBOX_IDLE_GRACE_MS.
  sandboxIdleGraceMs: z.coerce.number().int().positive().default(900_000),
  // MID-SESSION /workspace snapshot cadence (sandbox-file-persistence). The
  // reaper's drain-persist only protects boxes the reaper itself kills; a box
  // that dies any other way (Modal's hard creation-time timeout on a session
  // busy past it, provider OOM/infra death) loses everything since the last
  // clean drain. While a turn holds the box, the turn heartbeat and turn-end
  // both take a snapshot when at least this interval has passed since the last
  // one (same epoch-fenced fold-onto-lease seam as the drain), bounding the
  // worst-case loss of ANY unclean box death to this window. 0 disables.
  // Knob: OPENGENI_SANDBOX_SNAPSHOT_INTERVAL_MS. Default 15min.
  sandboxSnapshotIntervalMs: z.coerce.number().int().min(0).default(900_000),
  // Maximum time a best-effort /workspace snapshot capture may hold turn/reaper
  // cleanup. A hung provider snapshot must never pin a lease holder, block
  // graceful shutdown, or become permission to GC an older archive. Timeout is
  // treated exactly like a failed best-effort snapshot. Knob:
  // OPENGENI_SANDBOX_SNAPSHOT_TIMEOUT_MS. Default 60s.
  sandboxSnapshotTimeoutMs: z.coerce
    .number()
    .int()
    .positive()
    .max(SANDBOX_SNAPSHOT_MAX_TIMEOUT_MS)
    .default(60_000),
  // Begin a controlled snapshot/quiesce/drain/rematerialize transition this far
  // ahead of a finite provider deadline. Modal's 24h creation clock cannot be
  // extended; the logical sandbox outlives it by moving to one successor box.
  // getSettings derives the actual default as min(1h, half the configured
  // provider lifetime) so short-lived test/canary boxes remain bootable without
  // an extra coupled environment override. An explicit value may be larger when
  // an operator deliberately wants more rotation headroom; the boot invariant
  // still requires it to remain below the provider lifetime.
  sandboxRotationLeadMs: z.coerce.number().int().positive().default(3_600_000),
  // Bound provider-deadline rotation admission independently of execution.
  // Every admitted box receives its own durable drain child; the control worker
  // limits provider I/O to 32 concurrent activities. Matching that bound avoids
  // both the old one-box-per-tick deadline backlog and an unbounded provider/API
  // burst. Operators may tune this for a differently-sized worker pool.
  sandboxRotationBatchSize: z.coerce.number().int().positive().max(500).default(32),
  // expires_at refresh window for a held lease (>> the turn 10s heartbeat so a
  // single missed heartbeat never TTL-reaps a live turn). The warming TTL is the
  // window a cold->warming spawner has to commit warm before a reaper resets it.
  sandboxLeaseTtlMs: z.coerce.number().int().positive().default(90_000),
  sandboxLeaseWarmingTtlMs: z.coerce.number().int().positive().default(120_000),
  // Overall user-facing budget for warming a sandbox lease. Unlike the lease TTL
  // (a liveness/reaper cadence), this bounds how long one turn waits for capacity
  // or provider creation before surfacing a clear turn.failed error.
  sandboxWarmingTimeoutMs: z.coerce.number().int().positive().default(600_000),
  // Request-scoped workspace control-prefix budget: how long one HTTP-originated
  // session/workspace mutation (Send, Steer, Pause/Resume/Cancel, queue
  // move/edit/delete, composer draft, settings narrowing, quiescent tree
  // deletion) may wait to enter the fair `workspace_inference_controls` prefix
  // before failing with the retryable 503 `WORKSPACE_CONTROL_BUSY`. Worker
  // settlement and claims never use it. The API installs the validated value
  // into @opengeni/db once at app construction; nothing reads the env per
  // request. Env: OPENGENI_WORKSPACE_CONTROL_LOCK_TIMEOUT_MS. Default 20 s.
  workspaceControlLockTimeoutMs: z.coerce
    .number({
      message: "OPENGENI_WORKSPACE_CONTROL_LOCK_TIMEOUT_MS must be a positive integer (ms)",
    })
    .int("OPENGENI_WORKSPACE_CONTROL_LOCK_TIMEOUT_MS must be a positive integer (ms)")
    .positive("OPENGENI_WORKSPACE_CONTROL_LOCK_TIMEOUT_MS must be a positive integer (ms)")
    .default(20_000),
  // Rig setup-script budget (M3): the wall-clock timeout the rig-setup lifecycle
  // hook runs its script under, distinct from the 120s per-command lifecycle
  // default (a rig may compile/install heavy tooling on first cold create).
  // Env: OPENGENI_RIG_SETUP_TIMEOUT_MS. Default 10min.
  rigSetupTimeoutMs: z.coerce.number().int().positive().default(600_000),
  // --- sandbox warm-time billing (P2.1) ---
  // Per-backend warm rate (usd_micros/sec), like modelPricingJson: an empty {}
  // means warm-cost is not debited (warm-seconds are still metered for audit).
  // Shape: { "modal": 5, "runloop": 4, ... }. Backends absent here meter
  // warm-seconds but accrue NO warm_cost / debit (rate 0).
  sandboxWarmRateMicrosPerSecondJson: z.string().default("{}"),
  // Per-workspace warm cap (cumulative warm-seconds since the start of the UTC
  // month, summed over sandbox.warm_seconds). 0 = unbounded. A workspace over the
  // cap force-drains its VIEWER-ONLY boxes (guarded AND turn_holders=0 — a paying
  // turn is never killed); the reaper then stop()s at refcount 0.
  sandboxMaxWarmSecondsPerWorkspace: z.coerce.number().int().nonnegative().default(0),
  sandboxPreparationProfiles: z.string().default("none"),
  sandboxEnvAllowlist: z.string().default(""),
  objectStorageEndpoint: z.string().url().optional(),
  objectStorageInternalEndpoint: z.string().url().optional(),
  objectStorageSandboxEndpoint: z.string().url().optional(),
  objectStorageBackend: z
    .enum(["s3-compatible", "aws-s3", "azure-blob", "gcs"])
    .default("s3-compatible"),
  objectStorageBucket: z.string().min(1).default("opengeni-files"),
  objectStorageRegion: z.string().min(1).default("us-east-1"),
  objectStorageS3Provider: z.string().min(1).default("Minio"),
  objectStorageAccessKeyId: z.string().optional(),
  objectStorageSecretAccessKey: z.string().optional(),
  objectStorageForcePathStyle: EnvBoolean.default(true),
  objectStorageAzureConnectionString: z.string().optional(),
  objectStorageAzureAccountName: z.string().optional(),
  objectStorageAzureAccountKey: z.string().optional(),
  objectStorageAzureEndpoint: z.string().url().optional(),
  objectStorageGcsProjectId: z.string().optional(),
  objectStorageGcsCredentialsJson: z.string().optional(),
  objectStorageGcsKeyFilename: z.string().optional(),
  objectStorageGcsApiEndpoint: z.string().url().optional(),
  documentParser: z.string().min(1).default("liteparse"),
  documentChunkSize: z.coerce.number().int().positive().default(1200),
  documentChunkOverlap: z.coerce.number().int().nonnegative().default(160),
  documentEmbeddingProvider: z.enum(["openai", "deterministic"]).default("openai"),
  documentEmbeddingModel: z.string().min(1).default("text-embedding-3-large"),
  documentEmbeddingDimensions: z.coerce.number().int().positive().default(3072),
  documentEmbeddingApiKey: z.string().optional(),
  documentEmbeddingBaseUrl: z.string().url().optional(),
  documentCurationProvider: z.enum(["openai", "heuristic", "none"]).default("openai"),
  documentCurationModel: z.string().min(1).default("gpt-4o-mini"),
  documentCurationApiKey: z.string().optional(),
  documentCurationBaseUrl: z.string().url().optional(),
  gitAuthorName: z.string().optional(),
  gitAuthorEmail: z.string().optional(),
  gitCommitterName: z.string().optional(),
  gitCommitterEmail: z.string().optional(),
  githubAppManifestBaseUrl: z.string().optional(),
  githubAppManifestStateSecret: z.string().optional(),
  githubAppId: z.string().optional(),
  githubClientId: z.string().optional(),
  githubClientSecret: z.string().optional(),
  /** Default-off rollout for the in-process GitHub repository API tool surface. */
  githubRestMcpEnabled: EnvBoolean.default(false),
  githubPersonalOauthEnabled: EnvBoolean.default(false),
  githubPersonalOauthClientId: z.string().optional(),
  githubPersonalOauthClientSecret: z.string().optional(),
  githubAppSlug: z.string().optional(),
  githubWebhookSecret: z.string().optional(),
  githubAppPrivateKey: z.string().optional(),
  prReviewGithubAppId: z.string().optional(),
  prReviewGithubClientId: z.string().optional(),
  prReviewGithubClientSecret: z.string().optional(),
  prReviewGithubAppSlug: z.string().optional(),
  prReviewGithubWebhookSecret: z.string().optional(),
  prReviewGithubAppPrivateKey: z.string().optional(),
  betterAuthSecret: z.string().optional(),
  betterAuthAllowedHosts: z.string().default(""),
  betterAuthCookieDomain: z.string().optional(),
  betterAuthTrustedOrigins: z.string().default(""),
  managedAuthGoogleClientId: z.string().optional(),
  managedAuthGoogleClientSecret: z.string().optional(),
  managedAuthGithubClientId: z.string().optional(),
  managedAuthGithubClientSecret: z.string().optional(),
  // Rolling browser login-slot compatibility. Repository/deployment default is
  // deliberately legacy; changing to broker is an operator-authorized rollout.
  managedAuthSessionSetMode: z.enum(["legacy", "dual", "broker"]).default("legacy"),
  resendApiKey: z.string().optional(),
  emailFrom: z.string().default("OpenGeni <auth@mail.opengeni.ai>"),
  stripeSecretKey: z.string().optional(),
  stripePublishableKey: z.string().optional(),
  stripeWebhookSecret: z.string().optional(),
  stripeCreditsProductId: z.string().optional(),
  mcpServers: z
    .array(
      z.object({
        id: z.string().min(1).regex(registryId),
        name: z.string().min(1).optional(),
        url: z.string().url(),
        allowedTools: z.array(z.string().min(1)).optional(),
        timeoutMs: z.number().int().positive().optional(),
        cacheToolsList: z.boolean().default(false),
        /** Runtime approval policy, overlaid from an attempt-frozen session snapshot. */
        requireApproval: SessionMcpApprovalPolicy.optional(),
        /**
         * Extra request headers sent to this MCP server (credential injection
         * for workspace-enabled capability MCPs). Populated at runtime from
         * encrypted capability-installation credentials; do not put secrets in
         * OPENGENI_MCP_SERVERS.
         */
        headers: z.record(z.string(), z.string()).optional(),
        connectionRef: McpServerConnectionRefSchema.optional(),
      }),
    )
    .default([]),
});

export type Settings = z.infer<typeof SettingsSchema>;
export type McpServerConfig = Settings["mcpServers"][number];

export type GoogleDriveProviderRetryOptions = {
  requestTimeoutMs: number;
  attempts: number;
  initialDelayMs: number;
  maxDelayMs: number;
  budgetMs: number;
};

/** Freeze one validated provider-neutral budget into every newly created or
 * updated Google Drive knowledge-source schedule. Existing schedules retain
 * their persisted limits until an authorized source save updates them. */
export function configuredGoogleDriveSyncLimits(settings: Settings) {
  return KnowledgeSourceSyncLimits.parse({
    maxItems: settings.googleDriveSyncMaxItems,
    maxBytes: settings.googleDriveSyncMaxBytes,
    maxFileBytes: settings.googleDriveSyncMaxFileBytes,
    maxProviderRequests: settings.googleDriveSyncMaxProviderRequests,
    maxElapsedSeconds: settings.googleDriveSyncMaxElapsedSeconds,
    maxFailureDetails: settings.googleDriveSyncMaxFailureDetails,
  });
}

/** Bounded in-activity retry policy for individual Google Drive requests. The
 * durable sync workflow remains authoritative after this local budget ends. */
export function googleDriveProviderRetryOptions(
  settings: Settings,
): GoogleDriveProviderRetryOptions {
  return {
    requestTimeoutMs: settings.googleDriveProviderRequestTimeoutMs,
    attempts: settings.googleDriveProviderRetryAttempts,
    initialDelayMs: settings.googleDriveProviderRetryInitialDelayMs,
    maxDelayMs: settings.googleDriveProviderRetryMaxDelayMs,
    budgetMs: settings.googleDriveProviderRetryBudgetMs,
  };
}

/** Return only a credential-free HTTP(S) origin. Reject path, user-info, query,
 * and fragment input instead of reflecting it into callbacks or evidence. */
export function canonicalPublicOrigin(publicBaseUrl: string | undefined): string | null {
  if (!publicBaseUrl) return null;
  let parsed: URL;
  try {
    parsed = new URL(publicBaseUrl);
  } catch {
    return null;
  }
  if (
    !["http:", "https:"].includes(parsed.protocol) ||
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash ||
    (parsed.pathname !== "" && parsed.pathname !== "/")
  ) {
    return null;
  }
  return parsed.origin;
}

export function googleDriveOAuthCallbackUrl(publicBaseUrl: string | undefined): string | null {
  const origin = canonicalPublicOrigin(publicBaseUrl);
  return origin ? `${origin}/v1/integrations/google-drive/callback` : null;
}

/** Exact callback registered on the environment-specific personal GitHub OAuth App. */
export function personalGitHubOAuthCallbackUrl(publicBaseUrl: string | undefined): string | null {
  const origin = canonicalPublicOrigin(publicBaseUrl);
  return origin ? `${origin}/v1/integrations/github-personal/oauth/callback` : null;
}

/** Declarative voice-input transcription provider ids. */
export type VoiceInputProviderId =
  | "openai"
  | "azure-openai"
  | "codex-subscription"
  | "supergrok-subscription";

export type VoiceInputProviderConfig =
  | {
      id: "openai";
      kind: "openai";
      apiKey: string;
      baseUrl: string;
      model: string;
    }
  | {
      id: "azure-openai";
      kind: "azure-openai";
      endpoint: string;
      deployment: string;
      apiVersion: string;
      apiKey: string | null;
      adToken: string | null;
    }
  | {
      id: "codex-subscription";
      kind: "codex-subscription";
      experimental: true;
    }
  | {
      id: "supergrok-subscription";
      kind: "supergrok-subscription";
      experimental: true;
    };

/**
 * Reject empty / template secrets so `.env.example` placeholders like
 * `your-key` cannot advertise voice input as available and then 401 upstream.
 */
export function isUsableVoiceInputSecret(value: string | null | undefined): value is string {
  if (value == null) return false;
  const trimmed = value.trim();
  if (!trimmed) return false;
  const normalized = trimmed.toLowerCase();
  if (
    normalized === "your-key" ||
    normalized === "your_key" ||
    normalized === "changeme" ||
    normalized === "replace-me" ||
    normalized === "xxx" ||
    normalized.startsWith("your-") ||
    normalized.startsWith("your_")
  ) {
    return false;
  }
  return true;
}

/**
 * Resolve the configured voice-input provider registry in selection order.
 * Credentials stay in this server-side structure; ClientConfig only projects
 * whether at least one non-experimental (or probed experimental) provider exists.
 */
export function resolveVoiceInputProviderRegistry(settings: Settings): VoiceInputProviderConfig[] {
  const order = settings.voiceInputProviderOrder
    .split(",")
    .map((part) => part.trim())
    .filter(
      (part): part is VoiceInputProviderId =>
        part === "openai" ||
        part === "azure-openai" ||
        part === "codex-subscription" ||
        part === "supergrok-subscription",
    );
  const seen = new Set<VoiceInputProviderId>();
  const providers: VoiceInputProviderConfig[] = [];
  for (const id of order) {
    if (seen.has(id)) continue;
    seen.add(id);
    if (id === "openai") {
      if (!settings.voiceInputOpenaiEnabled) continue;
      const apiKey = settings.voiceInputOpenaiApiKey ?? settings.openaiApiKey;
      if (!isUsableVoiceInputSecret(apiKey)) continue;
      // When the turn provider is Azure-only and no voice-specific OpenAI key/URL
      // was set, do not silently reuse a leftover OPENAI_API_KEY for voice.
      if (
        settings.openaiProvider === "azure" &&
        !settings.voiceInputOpenaiApiKey &&
        !settings.voiceInputOpenaiBaseUrl
      ) {
        continue;
      }
      providers.push({
        id: "openai",
        kind: "openai",
        apiKey,
        baseUrl: (
          settings.voiceInputOpenaiBaseUrl ??
          settings.openaiBaseUrl ??
          "https://api.openai.com/v1"
        ).replace(/\/+$/, ""),
        model: settings.voiceInputOpenaiModel,
      });
      continue;
    }
    if (id === "azure-openai") {
      if (!settings.voiceInputAzureEnabled) continue;
      const endpoint = (
        settings.voiceInputAzureEndpoint ??
        settings.azureOpenaiEndpoint ??
        ""
      ).replace(/\/+$/, "");
      const deployment = settings.voiceInputAzureDeployment ?? settings.azureOpenaiDeployment ?? "";
      const apiVersion =
        settings.voiceInputAzureApiVersion ??
        settings.azureOpenaiApiVersion ??
        "2025-04-01-preview";
      const apiKey = settings.voiceInputAzureApiKey ?? settings.azureOpenaiApiKey ?? null;
      const adToken = settings.voiceInputAzureAdToken ?? settings.azureOpenaiAdToken ?? null;
      if (
        !endpoint ||
        !deployment ||
        (!isUsableVoiceInputSecret(apiKey) && !isUsableVoiceInputSecret(adToken))
      ) {
        continue;
      }
      // When turn provider is OpenAI-only and no voice-specific Azure settings
      // were provided, skip ambient Azure leftovers.
      if (
        settings.openaiProvider !== "azure" &&
        !settings.voiceInputAzureEndpoint &&
        !settings.voiceInputAzureDeployment &&
        !settings.voiceInputAzureApiKey &&
        !settings.voiceInputAzureAdToken
      ) {
        continue;
      }
      providers.push({
        id: "azure-openai",
        kind: "azure-openai",
        endpoint,
        deployment,
        apiVersion,
        apiKey: isUsableVoiceInputSecret(apiKey) ? apiKey : null,
        adToken: isUsableVoiceInputSecret(adToken) ? adToken : null,
      });
      continue;
    }
    if (id === "codex-subscription") {
      // Prefer Codex STT whenever subscription model routing is enabled.
      // Operators who want OpenAI/Azure first should set PROVIDER_ORDER; omit
      // `codex-subscription` from the order to disable Codex voice while keeping
      // subscription turns. VOICE_INPUT_CODEX_EXPERIMENTAL is retained for
      // back-compat docs/env but no longer gates inclusion.
      if (!settings.codexSubscriptionEnabled) continue;
      providers.push({
        id: "codex-subscription",
        kind: "codex-subscription",
        experimental: true,
      });
      continue;
    }
    if (id === "supergrok-subscription") {
      if (!settings.supergrokSubscriptionEnabled) continue;
      providers.push({
        id: "supergrok-subscription",
        kind: "supergrok-subscription",
        experimental: true,
      });
    }
  }
  return providers;
}

/** True when the deployment has at least one supported (non-experimental) provider. */
export function voiceInputDeploymentConfigured(settings: Settings): boolean {
  return resolveVoiceInputProviderRegistry(settings).some(
    (provider) =>
      provider.kind !== "codex-subscription" && provider.kind !== "supergrok-subscription",
  );
}

export type TemporalTlsConnectionConfig = {
  serverNameOverride?: string;
  serverRootCACertificate?: Uint8Array;
  clientCertPair?: {
    crt: Uint8Array;
    key: Uint8Array;
  };
};
export type TemporalConnectionOptions = {
  address: string;
  tls?: true | TemporalTlsConnectionConfig;
  apiKey?: string;
};
export type ModelPricing = {
  inputMicrosPerMillionTokens: number;
  cachedInputMicrosPerMillionTokens?: number | undefined;
  outputMicrosPerMillionTokens: number;
  marginBps?: number | undefined;
};
export type ModelPricingScheduleV1 = {
  default: ModelPricing;
  inputTokenTiers?:
    | Array<{
        minimumInputTokens: number;
        pricing: ModelPricing;
      }>
    | undefined;
};
export type ModelUsageInput = {
  inputTokens?: number | undefined;
  outputTokens?: number | undefined;
  totalTokens?: number | undefined;
  inputTokensDetails?: Record<string, number> | Array<Record<string, number>> | undefined;
  requestUsageEntries?: ModelUsageInput[] | undefined;
};

export type ModelUsageCostBreakdown = {
  /** Provider-rate cost basis for the exact usage, before OpenGeni margin. */
  providerCostMicros: number;
  /** OpenGeni credit price after configured margin and latency-mode multiplier. */
  creditCostMicros: number;
};

export type StaticUsageLimitsConfig = StaticUsageLimits;
export type EntitlementsConfig = Entitlements;

const ModelPricingSchema = z.object({
  inputMicrosPerMillionTokens: z.number().int().nonnegative(),
  cachedInputMicrosPerMillionTokens: z.number().int().nonnegative().optional(),
  outputMicrosPerMillionTokens: z.number().int().nonnegative(),
  marginBps: z.number().int().min(0).max(100_000).optional(),
});

const ModelPricingScheduleSchema = z
  .object({
    default: ModelPricingSchema,
    inputTokenTiers: z
      .array(
        z.object({
          minimumInputTokens: z.number().int().nonnegative(),
          pricing: ModelPricingSchema,
        }),
      )
      .optional(),
  })
  .superRefine((schedule, ctx) => {
    let previous = -1;
    for (const [index, tier] of (schedule.inputTokenTiers ?? []).entries()) {
      if (tier.minimumInputTokens <= previous) {
        ctx.addIssue({
          code: "custom",
          path: ["inputTokenTiers", index, "minimumInputTokens"],
          message: "input-token tier thresholds must be strictly increasing",
        });
      }
      previous = tier.minimumInputTokens;
    }
  });

export const CapabilitySupportV1 = z.enum(["supported", "unsupported", "unknown"]);
export type CapabilitySupportV1 = z.infer<typeof CapabilitySupportV1>;

export const CapabilityStateV1Schema = z
  .object({
    upstream: CapabilitySupportV1,
    runnable: z.boolean(),
  })
  .superRefine((state, ctx) => {
    if (state.upstream === "unsupported" && state.runnable) {
      ctx.addIssue({
        code: "custom",
        path: ["runnable"],
        message: "an upstream-unsupported capability cannot be runnable",
      });
    }
  });
export type CapabilityStateV1 = z.infer<typeof CapabilityStateV1Schema>;

const ModelModalityV1 = z.enum(["text", "image", "audio"]);
const ModelLatencyModeV1 = z.enum(["standard", "priority", "fast"]);

export const ModelCapabilitiesV1Schema = z
  .object({
    reasoning: CapabilityStateV1Schema.extend({
      efforts: z.array(ReasoningEffort),
      defaultEffort: ReasoningEffort.nullable(),
      required: z.boolean(),
    }),
    functionCalling: CapabilityStateV1Schema,
    structuredOutput: CapabilityStateV1Schema,
    hostedTools: z.object({
      webSearch: CapabilityStateV1Schema,
      xSearch: CapabilityStateV1Schema,
      codeExecution: CapabilityStateV1Schema,
      imageGeneration: CapabilityStateV1Schema.default({
        upstream: "unknown",
        runnable: false,
      }),
    }),
    inputModalities: z.array(ModelModalityV1).min(1),
    /** Exact MIME types accepted as typed `input_file`; `text/*` is allowed. */
    inputFileMediaTypes: z.array(z.string()).default([]),
    outputModalities: z.array(ModelModalityV1).min(1),
    transports: z.object({
      sse: CapabilityStateV1Schema,
      responsesWebSocket: CapabilityStateV1Schema,
      realtimeAudio: CapabilityStateV1Schema,
    }),
    promptCaching: CapabilityStateV1Schema.extend({
      mode: z.enum(["implicit", "automatic", "none"]),
    }).optional(),
    latencyModes: z
      .array(
        z.object({
          id: ModelLatencyModeV1,
          upstream: CapabilitySupportV1,
          runnable: z.boolean(),
          billingMultiplierBps: z.number().int().positive().optional(),
        }),
      )
      .min(1),
  })
  .superRefine((capabilities, ctx) => {
    const efforts = new Set(capabilities.reasoning.efforts);
    if (efforts.size !== capabilities.reasoning.efforts.length) {
      ctx.addIssue({
        code: "custom",
        path: ["reasoning", "efforts"],
        message: "reasoning efforts must be unique",
      });
    }
    if (
      capabilities.reasoning.defaultEffort !== null &&
      !efforts.has(capabilities.reasoning.defaultEffort)
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["reasoning", "defaultEffort"],
        message: "the default reasoning effort must be one of the supported efforts",
      });
    }
    if (capabilities.reasoning.runnable && capabilities.reasoning.efforts.length === 0) {
      ctx.addIssue({
        code: "custom",
        path: ["reasoning", "efforts"],
        message: "a runnable reasoning capability must declare at least one effort",
      });
    }
    for (const field of ["inputModalities", "outputModalities"] as const) {
      if (new Set(capabilities[field]).size !== capabilities[field].length) {
        ctx.addIssue({
          code: "custom",
          path: [field],
          message: `${field} must be unique`,
        });
      }
    }
    const latencyIds = new Set<string>();
    for (const [index, mode] of capabilities.latencyModes.entries()) {
      if (latencyIds.has(mode.id)) {
        ctx.addIssue({
          code: "custom",
          path: ["latencyModes", index, "id"],
          message: "latency mode ids must be unique",
        });
      }
      latencyIds.add(mode.id);
      if (mode.upstream === "unsupported" && mode.runnable) {
        ctx.addIssue({
          code: "custom",
          path: ["latencyModes", index, "runnable"],
          message: "an upstream-unsupported latency mode cannot be runnable",
        });
      }
    }
  });
export type ModelCapabilitiesV1 = z.infer<typeof ModelCapabilitiesV1Schema>;

export type ModelDeploymentV1 = {
  upstreamModelId: string;
  wireApi: ModelProviderApi;
};

export type ModelExecutionLimitsV1 = {
  contextWindowTokens: number | null;
  effectiveContextWindowTokens: number | null;
  autoCompactTokenLimit: number | null;
  toolOutputTruncationTokens: number | null;
};

export type CredentialSourceV1 =
  | { kind: "deployment"; mechanism: "api_key" | "azure_ad_bearer" | "none" }
  | { kind: "connected_subscription"; provider: "codex" | "xai" }
  | { kind: "workspace_connection"; mechanism: "api_key" };

export type BillingAttributionV1 = {
  upstreamPayer: "deployment" | "workspace" | "connected_subscription";
  metering: "opengeni_credits" | "external";
};

/**
 * Wire API a provider speaks. The built-in OpenAI/Azure provider always uses
 * "responses" (the OpenAI Responses API). Extra registry providers default to
 * "chat" (the broadly compatible /v1/chat/completions surface); Fireworks is
 * wired as "chat" because its beta Responses endpoint echoes input back and
 * silently no-ops hosted tools (see docs/model-providers.md).
 */
export const ModelProviderApi = z.enum(["responses", "chat"]);
export type ModelProviderApi = z.infer<typeof ModelProviderApi>;

/**
 * Provider-specific request semantics that are independent of the endpoint's
 * OpenAI-compatible wire API. Secondary Azure resources still speak the
 * Responses API, but need Azure's stricter computer-call normalization.
 */
export const ModelProviderWireProfile = z.enum(["openai", "azure-openai"]);
export type ModelProviderWireProfile = z.infer<typeof ModelProviderWireProfile>;

/**
 * Registry provider kind. "api-key" providers carry their own static key/headers;
 * "anonymous" providers intentionally send no credential and are externally
 * metered; connected-subscription providers resolve a workspace account token
 * at call time and never carry a static key in the registry definition.
 */
export const RegistryProviderKind = z.enum([
  "api-key",
  "anonymous",
  "codex-subscription",
  "xai-subscription",
  "vercel-gateway-managed",
  "vercel-gateway-workspace",
]);
export type RegistryProviderKind = z.infer<typeof RegistryProviderKind>;

/** A single model exposed by a registry provider. */
const RegistryModelSchema = z
  .object({
    id: z.string().min(1), // canonical OpenGeni product id
    upstreamModelId: z.string().min(1).optional(), // exact provider slug; defaults to id
    aliases: z.array(z.string().min(1)).optional(), // accepted input only; never sent upstream
    label: z.string().min(1).optional(), // display name; defaults to id
    shortLabel: z.string().min(1).max(64).optional(), // compact UI label; optional
    contextWindowTokens: z.number().int().positive().optional(),
    effectiveContextWindowTokens: z.number().int().positive().optional(),
    autoCompactTokenLimit: z.number().int().positive().optional(),
    // Canonical model-facing function/tool-result policy. The runtime applies
    // the same 1.2x serialization allowance as Codex when materializing output.
    toolOutputTruncationTokens: z.number().int().positive().optional(),
    reasoningEffort: z.boolean().optional(), // legacy compatibility input/projection
    hostedWebSearch: z.boolean().optional(), // legacy compatibility input/projection
    capabilities: ModelCapabilitiesV1Schema.optional(),
    pricing: z.union([ModelPricingSchema, ModelPricingScheduleSchema]).optional(),
    // Reserved normalized contracts are derived by OpenGeni in V1. Generic
    // registry JSON must not opt itself into workspace BYOK or reattribute cost.
    credentialSource: z.never().optional(),
    billing: z.never().optional(),
  })
  .superRefine((model, ctx) => {
    if (
      model.capabilities &&
      model.reasoningEffort !== undefined &&
      model.reasoningEffort !== model.capabilities.reasoning.runnable
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["reasoningEffort"],
        message: "legacy reasoningEffort must agree with capabilities.reasoning.runnable",
      });
    }
    if (
      model.capabilities &&
      model.hostedWebSearch !== undefined &&
      model.hostedWebSearch !== model.capabilities.hostedTools.webSearch.runnable
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["hostedWebSearch"],
        message:
          "legacy hostedWebSearch must agree with capabilities.hostedTools.webSearch.runnable",
      });
    }
  });

/** A non-built-in provider declared by the host via OPENGENI_MODEL_PROVIDERS_JSON. */
const RegistryProviderSchema = z
  .object({
    kind: RegistryProviderKind.default("api-key"),
    id: z.string().min(1).regex(registryId), // stable provider id, e.g. "fireworks"
    label: z.string().min(1).optional(),
    api: ModelProviderApi.default("chat"),
    wireProfile: ModelProviderWireProfile.default("openai"),
    baseUrl: z.string().url(),
    apiKey: z.string().optional(), // inline key (pragmatic) ...
    apiKeyEnv: z.string().optional(), // ... OR name of the env var holding the key (preferred)
    defaultQuery: z.record(z.string(), z.string()).optional(),
    defaultHeaders: z.record(z.string(), z.string()).optional(),
    publicDefaultQueryNames: z.array(z.string().min(1)).optional(),
    publicDefaultHeaderNames: z.array(z.string().min(1)).optional(),
    // V1 derives these from provider kind. Workspace BYOK is deliberately not a
    // registry switch and requires a separately reviewed encrypted broker.
    credentialSource: z.never().optional(),
    billing: z.never().optional(),
    models: z.array(RegistryModelSchema).min(1),
  })
  .superRefine((provider, ctx) => {
    if (provider.kind !== "anonymous") {
      return;
    }
    if (provider.apiKey !== undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["apiKey"],
        message: "anonymous providers must not declare apiKey",
      });
    }
    if (provider.apiKeyEnv !== undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["apiKeyEnv"],
        message: "anonymous providers must not declare apiKeyEnv",
      });
    }
    if (provider.defaultHeaders !== undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["defaultHeaders"],
        message: "anonymous providers must not declare defaultHeaders",
      });
    }
    if (provider.defaultQuery !== undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["defaultQuery"],
        message: "anonymous providers must not declare defaultQuery",
      });
    }
    if (provider.publicDefaultHeaderNames !== undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["publicDefaultHeaderNames"],
        message: "anonymous providers must not declare publicDefaultHeaderNames",
      });
    }
    if (provider.publicDefaultQueryNames !== undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["publicDefaultQueryNames"],
        message: "anonymous providers must not declare publicDefaultQueryNames",
      });
    }
  });
export type RegistryProvider = z.infer<typeof RegistryProviderSchema>;

export const OPENGENI_GATEWAY_PROVIDER_ID = "opengeni-gateway" as const;
export const WORKSPACE_GATEWAY_PROVIDER_ID = "workspace-gateway" as const;
export const WORKSPACE_GATEWAY_MODEL_ID_PREFIX = "workspace-gateway/" as const;
export const OPENROUTER_PROVIDER_ID = "openrouter" as const;
export const OPENROUTER_MODEL_ID_PREFIX = "openrouter/" as const;
export const OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1" as const;

const RESERVED_MODEL_PROVIDER_IDS = new Set<string>([
  "openai",
  "azure",
  CODEX_PROVIDER_ID,
  XAI_SUBSCRIPTION_PROVIDER_ID,
  OPENGENI_GATEWAY_PROVIDER_ID,
  WORKSPACE_GATEWAY_PROVIDER_ID,
  OPENROUTER_PROVIDER_ID,
]);

export const ModelCostClass = z.enum(["free", "credits"]);
export type ModelCostClass = z.infer<typeof ModelCostClass>;

export const ConfiguredModelCostClass = z.enum(["free", "credits", "subscription", "workspace"]);
export type ConfiguredModelCostClass = z.infer<typeof ConfiguredModelCostClass>;

const ModelNote = z
  .string()
  .max(500)
  .refine((value) => !/[\r\n|]/u.test(value), {
    message: "model notes must not contain newlines or the | field separator",
  });

export function parseModelCostPolicyJson(raw: string): Record<string, ModelCostClass> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(
      `OPENGENI_MODEL_COST_POLICY_JSON must be valid JSON: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
  return z.record(z.string().min(1), ModelCostClass).parse(parsed);
}

export function parseModelNotesJson(raw: string): Record<string, string> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(
      `OPENGENI_MODEL_NOTES_JSON must be valid JSON: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
  return z.record(z.string().min(1), ModelNote).parse(parsed);
}

export function configuredModelNotes(
  settings: Pick<Settings, "modelNotesJson">,
): Record<string, string> {
  return parseModelNotesJson(settings.modelNotesJson);
}

export const GatewayCatalogModel = z
  .object({
    productId: z.string().min(1),
    workspaceProductId: z.string().min(1).startsWith(WORKSPACE_GATEWAY_MODEL_ID_PREFIX),
    upstreamModelId: z.string().min(1),
    label: z.string().min(1),
    shortLabel: z.string().min(1).max(64).optional(),
    providers: z.array(z.string().min(1)).min(1),
    implicitCaching: z.boolean().default(false),
    vision: z.boolean().default(false),
    inputFileMediaTypes: z.array(z.string().min(1)).default([]),
    contextWindowTokens: z.number().int().positive().default(1_000_000),
    effectiveContextWindowTokens: z.number().int().positive().default(900_000),
    autoCompactTokenLimit: z.number().int().positive().default(850_000),
    pricing: z.union([ModelPricingSchema, ModelPricingScheduleSchema]).optional(),
    credentialSource: z.never().optional(),
    billing: z.never().optional(),
    apiKey: z.never().optional(),
  })
  .strict();
export type GatewayCatalogModel = z.infer<typeof GatewayCatalogModel>;

export const OpenRouterCatalogModel = z
  .object({
    upstreamModelId: z.string().min(1).endsWith(":free"),
    label: z.string().min(1),
    shortLabel: z.string().min(1).max(64).optional(),
    aliases: z.array(z.string().min(1)).default([]),
    capabilities: ModelCapabilitiesV1Schema,
    contextWindowTokens: z.number().int().positive().optional(),
    effectiveContextWindowTokens: z.number().int().positive().optional(),
    autoCompactTokenLimit: z.number().int().positive().optional(),
    toolOutputTruncationTokens: z.number().int().positive().optional(),
    credentialSource: z.never().optional(),
    billing: z.never().optional(),
    pricing: z.never().optional(),
    apiKey: z.never().optional(),
  })
  .strict();
export type OpenRouterCatalogModel = z.infer<typeof OpenRouterCatalogModel>;

const DeploymentRegistryBaseUrl = z
  .string()
  .url()
  .superRefine((value, context) => {
    const url = new URL(value);
    if (url.username || url.password) {
      context.addIssue({
        code: "custom",
        message: "database catalog provider baseUrl must not contain userinfo",
      });
    }
    if (url.search) {
      context.addIssue({
        code: "custom",
        message: "database catalog provider baseUrl must not contain a query",
      });
    }
    if (url.hash) {
      context.addIssue({
        code: "custom",
        message: "database catalog provider baseUrl must not contain a fragment",
      });
    }
  });

const DeploymentRegistryProviderKind = z.enum(["api-key", "anonymous"]);

const DeploymentRegistryModelSchema = RegistryModelSchema.safeExtend({
  pricing: z.never().optional(),
}).strict();

const DeploymentRegistryProviderSchema = RegistryProviderSchema.safeExtend({
  kind: DeploymentRegistryProviderKind.default("api-key"),
  baseUrl: DeploymentRegistryBaseUrl,
  models: z.array(DeploymentRegistryModelSchema).min(1),
  apiKey: z.never().optional(),
  apiKeyEnv: z.never().optional(),
  defaultHeaders: z.never().optional(),
  defaultQuery: z.never().optional(),
  publicDefaultHeaderNames: z.never().optional(),
  publicDefaultQueryNames: z.never().optional(),
}).strict();

const DeploymentGatewayCatalogModelSchema = GatewayCatalogModel.safeExtend({
  pricing: z.never().optional(),
}).strict();

export const ModelCatalogDocument = z
  .object({
    schemaVersion: z.literal(1),
    /** Canonical deployment default. Omission preserves the V1 first-built-in
     * fallback for existing documents; operators should set this explicitly
     * when cutting over a registry or connected-subscription default. */
    defaultModel: z.string().min(1).optional(),
    builtInModels: z.array(z.string().min(1)).min(1),
    registryProviders: z.array(DeploymentRegistryProviderSchema).default([]),
    gatewayModels: z.array(DeploymentGatewayCatalogModelSchema).default([]),
    openrouterModels: z.array(OpenRouterCatalogModel).default([]),
    modelNotes: z.record(z.string().min(1), ModelNote).default({}),
    billing: z.never().optional(),
    enabled: z.never().optional(),
    apiKey: z.never().optional(),
    bands: z.never().optional(),
  })
  .strict()
  .superRefine((document, context) => {
    const productIds = new Set<string>();
    const providerIds = new Set<string>();
    const gatewayUpstreamIds = new Set<string>();
    const add = (id: string, path: Array<string | number>): void => {
      if (/[\u000A\u000D|]/u.test(id)) {
        context.addIssue({
          code: "custom",
          path,
          message: "catalog product ids must not contain newlines or the | field separator",
        });
      }
      if (productIds.has(id)) {
        context.addIssue({ code: "custom", path, message: `duplicate product id ${id}` });
      }
      productIds.add(id);
    };
    document.builtInModels.forEach((id, index) => add(id, ["builtInModels", index]));
    document.registryProviders.forEach((provider, providerIndex) => {
      if (RESERVED_MODEL_PROVIDER_IDS.has(provider.id)) {
        context.addIssue({
          code: "custom",
          path: ["registryProviders", providerIndex, "id"],
          message: `provider id ${provider.id} is reserved for a reviewed OpenGeni provider`,
        });
      }
      if (providerIds.has(provider.id)) {
        context.addIssue({
          code: "custom",
          path: ["registryProviders", providerIndex, "id"],
          message: `duplicate provider id ${provider.id}`,
        });
      }
      providerIds.add(provider.id);
      provider.models.forEach((model, modelIndex) =>
        add(model.id, ["registryProviders", providerIndex, "models", modelIndex, "id"]),
      );
    });
    document.gatewayModels.forEach((model, index) => {
      if (gatewayUpstreamIds.has(model.upstreamModelId)) {
        context.addIssue({
          code: "custom",
          path: ["gatewayModels", index, "upstreamModelId"],
          message: `duplicate Gateway upstream model id ${model.upstreamModelId}`,
        });
      }
      gatewayUpstreamIds.add(model.upstreamModelId);
      add(model.productId, ["gatewayModels", index, "productId"]);
      add(model.workspaceProductId, ["gatewayModels", index, "workspaceProductId"]);
    });
    document.openrouterModels.forEach((model, index) =>
      add(`${OPENROUTER_MODEL_ID_PREFIX}${model.upstreamModelId}`, [
        "openrouterModels",
        index,
        "upstreamModelId",
      ]),
    );
    if (document.defaultModel && /[\u000A\u000D|]/u.test(document.defaultModel)) {
      context.addIssue({
        code: "custom",
        path: ["defaultModel"],
        message: "catalog default model must not contain newlines or the | field separator",
      });
    }
    if (
      document.defaultModel &&
      !productIds.has(document.defaultModel) &&
      !document.defaultModel.startsWith(CODEX_MODEL_ID_PREFIX) &&
      !document.defaultModel.startsWith(XAI_SUBSCRIPTION_MODEL_ID_PREFIX)
    ) {
      context.addIssue({
        code: "custom",
        path: ["defaultModel"],
        message:
          "catalog default model must reference deployment catalog membership or a connected-subscription product",
      });
    }
    for (const productId of Object.keys(document.modelNotes)) {
      if (!productIds.has(productId)) {
        context.addIssue({
          code: "custom",
          path: ["modelNotes", productId],
          message: "model note references a product id outside the deployment catalog",
        });
      }
    }
  });
export type ModelCatalogDocument = z.infer<typeof ModelCatalogDocument>;

export function parseModelCatalogDocument(value: unknown): ModelCatalogDocument {
  return ModelCatalogDocument.parse(value);
}

function deploymentRegistryProvidersWithHostCredentials(
  settings: Settings,
  providers: readonly z.infer<typeof DeploymentRegistryProviderSchema>[],
): RegistryProvider[] {
  const hostProviders = new Map(
    parseModelProvidersJson(settings.modelProvidersJson).map((provider) => [provider.id, provider]),
  );
  return providers.map((provider) => {
    if (provider.kind !== "api-key") return provider;
    const host = hostProviders.get(provider.id);
    if (!host || host.kind !== "api-key") {
      throw new Error(
        `database model catalog provider ${provider.id} has no matching host-authorized api-key transport`,
      );
    }
    const transportIdentity = (candidate: typeof provider | RegistryProvider) => ({
      kind: candidate.kind,
      baseUrl: candidate.baseUrl,
      api: candidate.api,
      wireProfile: candidate.wireProfile,
    });
    if (canonicalJson(transportIdentity(provider)) !== canonicalJson(transportIdentity(host))) {
      throw new Error(
        `database model catalog provider ${provider.id} does not match its host-authorized transport`,
      );
    }
    return {
      ...provider,
      ...(host.defaultHeaders === undefined ? {} : { defaultHeaders: host.defaultHeaders }),
      ...(host.defaultQuery === undefined ? {} : { defaultQuery: host.defaultQuery }),
      ...(host.publicDefaultHeaderNames === undefined
        ? {}
        : { publicDefaultHeaderNames: host.publicDefaultHeaderNames }),
      ...(host.publicDefaultQueryNames === undefined
        ? {}
        : { publicDefaultQueryNames: host.publicDefaultQueryNames }),
      ...(host.apiKey === undefined ? {} : { apiKey: host.apiKey }),
      ...(host.apiKeyEnv === undefined ? {} : { apiKeyEnv: host.apiKeyEnv }),
    };
  });
}

/** Pure secret-free database catalog overlay. getSettings remains env-only. */
export function applyModelCatalogDocument(settings: Settings, rawDocument: unknown): Settings {
  const document = parseModelCatalogDocument(rawDocument);
  const defaultModel = document.defaultModel ?? document.builtInModels[0]!;
  const resolved = {
    ...settings,
    openaiModel: defaultModel,
    openaiAllowedModels: document.builtInModels
      .filter((modelId) => modelId !== defaultModel)
      .join(","),
    modelProvidersJson: JSON.stringify(
      deploymentRegistryProvidersWithHostCredentials(settings, document.registryProviders),
    ),
    resolvedGatewayModelsJson: JSON.stringify(document.gatewayModels),
    resolvedOpenRouterModelsJson: JSON.stringify(document.openrouterModels),
    modelNotesJson: JSON.stringify(document.modelNotes),
  };
  return resolved;
}

export const IntegrationOAuthClientConfigSchema = z.object({
  clientId: z.string().min(1),
  clientSecret: z.string().min(1).optional(),
  tokenEndpointAuthMethod: z
    .enum(["none", "client_secret_post", "client_secret_basic"])
    .default("none"),
});
export type IntegrationOAuthClientConfig = z.infer<typeof IntegrationOAuthClientConfigSchema>;

/**
 * Runtime-resolved provider (built-in or registry), client-construction-ready.
 * The built-in OpenAI/Azure provider is always present and always "responses";
 * registry providers carry their own base URL / key / wire API. Compaction is
 * not a provider capability: all providers use the same durable plaintext
 * replacement.
 */
export interface ResolvedModelProvider {
  id: string; // "openai" | "azure" | registry id
  label: string;
  kind: RegistryProviderKind | "openrouter-managed";
  api: ModelProviderApi;
  wireProfile: ModelProviderWireProfile;
  builtin: boolean;
  baseUrl?: string | undefined;
  apiKey?: string | undefined;
  defaultQuery?: Record<string, string> | undefined;
  defaultHeaders?: Record<string, string> | undefined;
  publicDefaultQueryNames?: string[] | undefined;
  publicDefaultHeaderNames?: string[] | undefined;
  credentialSource: CredentialSourceV1;
  billing: BillingAttributionV1;
}

type InternalRegistryProvider = Omit<RegistryProvider, "kind"> & {
  kind: RegistryProviderKind | "openrouter-managed";
};

/** A single exposed model + the provider that serves it. */
export interface ConfiguredModel {
  schemaVersion: 1;
  id: string;
  aliases: string[];
  label: string;
  /** Optional curated compact label for dense UI (e.g. mobile composer). */
  shortLabel?: string | undefined;
  providerId: string;
  providerLabel: string;
  api: ModelProviderApi;
  upstreamModelId: string;
  deployment: ModelDeploymentV1;
  executionLimits: ModelExecutionLimitsV1;
  credentialSource: CredentialSourceV1;
  billing: BillingAttributionV1;
  /** Workspace-facing funding policy, independent of upstream settlement. */
  cost: ConfiguredModelCostClass;
  capabilities: ModelCapabilitiesV1;
  requestPolicy?: {
    gateway: {
      only: [string, ...string[]];
      caching: "auto" | "none";
    };
  };
  pricing?: ModelPricingScheduleV1 | undefined;
  definitionVersion: string;
  contextWindowTokens?: number | undefined;
  effectiveContextWindowTokens?: number | undefined;
  autoCompactTokenLimit?: number | undefined;
  toolOutputTruncationTokens?: number | undefined;
  reasoningEffort: boolean;
  hostedWebSearch: boolean;
}

export const VERCEL_AI_GATEWAY_BASE_URL = "https://ai-gateway.vercel.sh/v1" as const;
export const VERCEL_AI_GATEWAY_AI_SDK_BASE_URL = "https://ai-gateway.vercel.sh/v4/ai" as const;
export const VERCEL_AI_GATEWAY_CONNECTION_DOMAIN = "ai-gateway.vercel.sh" as const;
export const VERCEL_AI_GATEWAY_CONNECTION_ROLE = "vercel_ai_gateway" as const;

export const CODEX_REALTIME_MODEL_ID = "gpt-live-1-boulder-alpha" as const;
export const SUPERGROK_REALTIME_MODEL_ID = "supergrok/grok-voice-think-fast-2.0" as const;
export const OPENGENI_REALTIME_MODEL_ID_PREFIX = "opengeni-gateway/" as const;
export const WORKSPACE_REALTIME_MODEL_ID_PREFIX = "workspace-gateway/" as const;

/** Curated voice models exposed through AI Gateway's normalized realtime API. */
export const AI_GATEWAY_REALTIME_MODELS = {
  openaiRealtime21: {
    upstreamModelId: "openai/gpt-realtime-2.1",
    managedModelId: `${OPENGENI_REALTIME_MODEL_ID_PREFIX}openai/gpt-realtime-2.1`,
    workspaceModelId: `${WORKSPACE_REALTIME_MODEL_ID_PREFIX}openai/gpt-realtime-2.1`,
    label: "GPT Realtime 2.1",
    description: "Best overall voice intelligence",
  },
  openaiRealtimeMini: {
    upstreamModelId: "openai/gpt-realtime-mini",
    managedModelId: `${OPENGENI_REALTIME_MODEL_ID_PREFIX}openai/gpt-realtime-mini`,
    workspaceModelId: `${WORKSPACE_REALTIME_MODEL_ID_PREFIX}openai/gpt-realtime-mini`,
    label: "GPT Realtime Mini",
    description: "Faster, lighter live voice",
  },
  grokVoiceThinkFast20: {
    upstreamModelId: "xai/grok-voice-think-fast-2.0",
    managedModelId: `${OPENGENI_REALTIME_MODEL_ID_PREFIX}xai/grok-voice-think-fast-2.0`,
    workspaceModelId: `${WORKSPACE_REALTIME_MODEL_ID_PREFIX}xai/grok-voice-think-fast-2.0`,
    label: "Grok Voice Think Fast 2.0",
    description: "Fast, natural xAI voice",
  },
} as const;

export type AiGatewayRealtimeModel =
  (typeof AI_GATEWAY_REALTIME_MODELS)[keyof typeof AI_GATEWAY_REALTIME_MODELS];

export function resolveAiGatewayRealtimeModel(
  modelId: string,
): { source: "managed" | "workspace"; upstreamModelId: string } | null {
  for (const model of Object.values(AI_GATEWAY_REALTIME_MODELS)) {
    if (model.managedModelId === modelId) {
      return { source: "managed", upstreamModelId: model.upstreamModelId };
    }
    if (model.workspaceModelId === modelId) {
      return { source: "workspace", upstreamModelId: model.upstreamModelId };
    }
  }
  return null;
}

export const OPENGENI_GATEWAY_MODELS = {
  deepseek: {
    productId: "deepseek-v4-flash-0731",
    workspaceProductId: `${WORKSPACE_GATEWAY_MODEL_ID_PREFIX}deepseek-v4-flash-0731`,
    upstreamModelId: "deepseek/deepseek-v4-flash-0731",
    label: "DeepSeek V4 Flash 0731",
    shortLabel: "V4 Flash",
    providers: ["baseten", "novita", "deepinfra"],
    implicitCaching: true,
  },
  kimi: {
    productId: "kimi-k3",
    workspaceProductId: `${WORKSPACE_GATEWAY_MODEL_ID_PREFIX}kimi-k3`,
    upstreamModelId: "moonshotai/kimi-k3",
    label: "Kimi K3",
    shortLabel: "Kimi K3",
    providers: ["baseten", "fireworks"],
    implicitCaching: true,
  },
} as const;

export const OPENGENI_OPENROUTER_MODELS: readonly OpenRouterCatalogModel[] = [
  OpenRouterCatalogModel.parse({
    upstreamModelId: "nvidia/nemotron-3-super-120b-a12b:free",
    label: "Nemotron 3 Super 120B",
    shortLabel: "Nemotron 3 Super",
    aliases: [],
    capabilities: {
      reasoning: {
        upstream: "supported",
        // OpenRouter advertises the reasoning controls, but the catalogue does
        // not publish this model's accepted effort vocabulary. Preserve that
        // upstream fact without exposing an unverified runnable selector.
        runnable: false,
        efforts: [],
        defaultEffort: null,
        required: false,
      },
      functionCalling: { upstream: "supported", runnable: true },
      structuredOutput: { upstream: "supported", runnable: true },
      hostedTools: {
        webSearch: { upstream: "unknown", runnable: false },
        xSearch: { upstream: "unknown", runnable: false },
        codeExecution: { upstream: "unknown", runnable: false },
        imageGeneration: { upstream: "unknown", runnable: false },
      },
      inputModalities: ["text"],
      inputFileMediaTypes: [],
      outputModalities: ["text"],
      transports: {
        sse: { upstream: "supported", runnable: true },
        responsesWebSocket: { upstream: "unknown", runnable: false },
        realtimeAudio: { upstream: "unsupported", runnable: false },
      },
      latencyModes: [{ id: "standard", upstream: "unknown", runnable: true }],
    },
    contextWindowTokens: 262_144,
    effectiveContextWindowTokens: 235_929,
    autoCompactTokenLimit: 220_000,
  }),
];

function defaultGatewayCatalogModels(): GatewayCatalogModel[] {
  return [
    {
      ...OPENGENI_GATEWAY_MODELS.deepseek,
      vision: false,
      inputFileMediaTypes: [],
      contextWindowTokens: 1_000_000,
      effectiveContextWindowTokens: 900_000,
      autoCompactTokenLimit: 850_000,
    },
    {
      ...OPENGENI_GATEWAY_MODELS.kimi,
      vision: true,
      inputFileMediaTypes: ["application/pdf"],
      contextWindowTokens: 1_000_000,
      effectiveContextWindowTokens: 900_000,
      autoCompactTokenLimit: 850_000,
    },
  ].map((model) => GatewayCatalogModel.parse(model));
}

function configuredGatewayCatalogModels(settings: Settings): GatewayCatalogModel[] {
  if (settings.resolvedGatewayModelsJson === undefined) {
    return defaultGatewayCatalogModels();
  }
  return z.array(GatewayCatalogModel).parse(JSON.parse(settings.resolvedGatewayModelsJson));
}

export function configuredGatewayUpstreamModelIds(settings: Settings): string[] {
  return configuredGatewayCatalogModels(settings).map((model) => model.upstreamModelId);
}

export function configuredGatewayWorkspaceProductModelIds(settings: Settings): string[] {
  return configuredGatewayCatalogModels(settings).map((model) => model.workspaceProductId);
}

export function configuredModelInputIdentities(settings: Settings): string[] {
  return configuredModels(settings).flatMap((model) => [model.id, ...model.aliases]);
}

function configuredOpenRouterCatalogModels(settings: Settings): OpenRouterCatalogModel[] {
  if (settings.resolvedOpenRouterModelsJson === undefined) {
    return [...OPENGENI_OPENROUTER_MODELS];
  }
  return z.array(OpenRouterCatalogModel).parse(JSON.parse(settings.resolvedOpenRouterModelsJson));
}

/**
 * Built-in OpenGeni credit pricing schedules.
 *
 * Rates are provider list prices in USD micros per 1M tokens. Debit applies
 * `marginBps` (2_500 = +25%) on top. Long-context tiers follow OpenAI's
 * ">272K input tokens" rule (threshold exclusive of 272_000).
 *
 * GPT-5.4 and older families are intentionally omitted — they are no longer
 * offered. Codex / connected-subscription turns use `metering: external` and
 * never consult this map.
 *
 * When adding or changing a billed model, run `bun run check:model-pricing`
 * (see docs/model-providers.md § Price audit). That compares this map to
 * llm-prices.com as a ground-truth canary; it does not generate this table.
 */
export const defaultModelPricing: Record<string, ModelPricingScheduleV1> = {
  "gpt-5.6-sol": {
    default: {
      inputMicrosPerMillionTokens: 5_000_000,
      cachedInputMicrosPerMillionTokens: 500_000,
      outputMicrosPerMillionTokens: 30_000_000,
      marginBps: 2_500,
    },
    inputTokenTiers: [
      {
        // OpenAI: prompts with >272K input tokens use the long-context rate.
        minimumInputTokens: 272_001,
        pricing: {
          inputMicrosPerMillionTokens: 10_000_000,
          cachedInputMicrosPerMillionTokens: 1_000_000,
          outputMicrosPerMillionTokens: 45_000_000,
          marginBps: 2_500,
        },
      },
    ],
  },
  "gpt-5.6-terra": {
    default: {
      inputMicrosPerMillionTokens: 2_000_000,
      cachedInputMicrosPerMillionTokens: 200_000,
      outputMicrosPerMillionTokens: 12_000_000,
      marginBps: 2_500,
    },
    inputTokenTiers: [
      {
        minimumInputTokens: 272_001,
        pricing: {
          inputMicrosPerMillionTokens: 4_000_000,
          cachedInputMicrosPerMillionTokens: 400_000,
          outputMicrosPerMillionTokens: 18_000_000,
          marginBps: 2_500,
        },
      },
    ],
  },
  "gpt-5.6-luna": {
    default: {
      inputMicrosPerMillionTokens: 200_000,
      cachedInputMicrosPerMillionTokens: 20_000,
      outputMicrosPerMillionTokens: 1_200_000,
      marginBps: 2_500,
    },
    inputTokenTiers: [
      {
        minimumInputTokens: 272_001,
        pricing: {
          inputMicrosPerMillionTokens: 400_000,
          cachedInputMicrosPerMillionTokens: 40_000,
          outputMicrosPerMillionTokens: 1_800_000,
          marginBps: 2_500,
        },
      },
    ],
  },
  // Conservative Vercel AI Gateway fallback prices. Normal managed Gateway
  // billing uses the exact response Gateway `cost` / `inferenceCost` and applies
  // the same margin. These token rates are used only if that
  // metadata is absent. DeepSeek therefore carries the highest approved route
  // (Novita); both approved Kimi routes have the same list price.
  [OPENGENI_GATEWAY_MODELS.deepseek.productId]: {
    default: {
      inputMicrosPerMillionTokens: 140_000,
      cachedInputMicrosPerMillionTokens: 28_000,
      outputMicrosPerMillionTokens: 280_000,
      marginBps: 2_500,
    },
  },
  [OPENGENI_GATEWAY_MODELS.kimi.productId]: {
    default: {
      inputMicrosPerMillionTokens: 3_000_000,
      cachedInputMicrosPerMillionTokens: 300_000,
      outputMicrosPerMillionTokens: 15_000_000,
      marginBps: 2_500,
    },
  },
  // Fireworks AI / GLM 5.2 — the first shipped non-OpenAI registry model. A
  // built-in default pricing entry makes managed billing work out of the box
  // for hosts that expose this model via OPENGENI_MODEL_PROVIDERS_JSON without
  // also setting OPENGENI_MODEL_PRICING_JSON.
  "accounts/fireworks/models/glm-5p2": {
    default: {
      inputMicrosPerMillionTokens: 1_400_000,
      cachedInputMicrosPerMillionTokens: 140_000,
      outputMicrosPerMillionTokens: 4_400_000,
      marginBps: 2_500,
    },
  },
};

// --- backend-gated required-credential table (the single source of truth) ---
// Each sandbox backend declares ONLY its own required credentials: a deployment
// configured for `sandboxBackend=modal` must carry the Modal token, but a
// daytona/e2b/local/none deployment must NOT be forced to set Modal creds (and
// vice versa). validateSettings() iterates this table for the *active* backend
// only — so the cred a backend doesn't use is never a boot blocker — and the
// deployment package mirrors the same table to drive its env-render + the
// required-env manifest (one table, two consumers).
//
// `field` is the parsed Settings key (boot validation reads the typed value);
// `env` is the OPENGENI_* variable name (deployment renders/requires it). The
// modal token is a both-or-neither pair handled by an extra refine in
// validateSettings — this table holds the hard "must be present when active"
// requirements.
export type SandboxRequiredEnv = {
  field: keyof Settings;
  env: string;
};

export const SANDBOX_REQUIRED_ENV: Record<
  z.infer<typeof SandboxBackend>,
  readonly SandboxRequiredEnv[]
> = {
  // docker/local/none need no credentials (local dev container / in-process / off).
  docker: [],
  local: [],
  none: [],
  modal: [
    { field: "modalAppName", env: "OPENGENI_MODAL_APP_NAME" },
    { field: "modalTokenId", env: "OPENGENI_MODAL_TOKEN_ID" },
    { field: "modalTokenSecret", env: "OPENGENI_MODAL_TOKEN_SECRET" },
  ],
  daytona: [{ field: "daytonaApiKey", env: "OPENGENI_DAYTONA_API_KEY" }],
  runloop: [{ field: "runloopApiKey", env: "OPENGENI_RUNLOOP_API_KEY" }],
  e2b: [{ field: "e2bApiKey", env: "OPENGENI_E2B_API_KEY" }],
  blaxel: [{ field: "blaxelApiKey", env: "OPENGENI_BLAXEL_API_KEY" }],
  cloudflare: [{ field: "cloudflareWorkerUrl", env: "OPENGENI_CLOUDFLARE_WORKER_URL" }],
  vercel: [
    { field: "vercelToken", env: "OPENGENI_VERCEL_TOKEN" },
    { field: "vercelProjectId", env: "OPENGENI_VERCEL_PROJECT_ID" },
  ],
  opensandbox: [
    { field: "openSandboxBaseUrl", env: "OPENGENI_OPENSANDBOX_BASE_URL" },
    { field: "openSandboxApiKey", env: "OPENGENI_OPENSANDBOX_API_KEY" },
    { field: "openSandboxImage", env: "OPENGENI_OPENSANDBOX_IMAGE" },
  ],
  // selfhosted needs NO per-box credentials: it is the user's own machine reached
  // over the agent's own enrollment. The enrollment-signing + relay-token secrets
  // are deployment-level (a single runtime secret, not per-active-backend creds),
  // wired in the connectivity/enrollment milestones (M4/M5), not here.
  selfhosted: [],
};

/** The required OPENGENI_* env var names for a backend (for the deployment manifest). */
export function requiredSandboxEnvForBackend(backend: z.infer<typeof SandboxBackend>): string[] {
  return (SANDBOX_REQUIRED_ENV[backend] ?? []).map((entry) => entry.env);
}

function objectStorageConfiguredForWorkspaceArchives(settings: Settings): boolean {
  switch (settings.objectStorageBackend) {
    case "azure-blob":
      return Boolean(
        settings.objectStorageAzureConnectionString ||
        (settings.objectStorageAzureAccountName && settings.objectStorageAzureAccountKey),
      );
    case "gcs":
      return Boolean(
        settings.objectStorageGcsCredentialsJson ||
        settings.objectStorageGcsKeyFilename ||
        settings.objectStorageGcsProjectId,
      );
    case "aws-s3":
      return true;
    case "s3-compatible":
      return Boolean(
        settings.objectStorageEndpoint &&
        settings.objectStorageAccessKeyId &&
        settings.objectStorageSecretAccessKey,
      );
    default: {
      const _exhaustive: never = settings.objectStorageBackend;
      return _exhaustive;
    }
  }
}

function optionalEnvironmentValue(name: string, source: NodeJS.ProcessEnv): string | undefined {
  const value = source[name];
  return value && value.trim().length > 0 ? value : undefined;
}

export function getSettings(source: NodeJS.ProcessEnv = process.env): Settings {
  const optional = (name: string): string | undefined => optionalEnvironmentValue(name, source);
  const modelCatalogSource = optional("OPENGENI_MODEL_CATALOG_SOURCE");
  const modelCostPolicyJson =
    optional("OPENGENI_MODEL_COST_POLICY_JSON") ??
    (modelCatalogSource === "database" ? "{}" : DEFAULT_MODEL_COST_POLICY_JSON);
  const raw = {
    serviceName: optional("OPENGENI_SERVICE_NAME"),
    environment: optional("OPENGENI_ENVIRONMENT"),
    deploymentRevision:
      optional("OPENGENI_DEPLOYMENT_REVISION") ??
      optional("SOURCE_VERSION") ??
      optional("GITHUB_SHA"),
    serverVersion: optional("OPENGENI_SERVER_VERSION"),
    databaseUrl: optional("OPENGENI_DATABASE_URL"),
    dbSchema: optional("OPENGENI_DB_SCHEMA"),
    rlsStrategy: optional("OPENGENI_RLS_STRATEGY"),
    runtimeDatabaseRole: optional("OPENGENI_RUNTIME_DATABASE_ROLE"),
    natsUrl: optional("OPENGENI_NATS_URL"),
    temporalHost: optional("OPENGENI_TEMPORAL_HOST"),
    temporalNamespace: optional("OPENGENI_TEMPORAL_NAMESPACE"),
    temporalTaskQueue: optional("OPENGENI_TEMPORAL_TASK_QUEUE"),
    temporalTlsEnabled: optional("OPENGENI_TEMPORAL_TLS_ENABLED"),
    temporalApiKey: optional("OPENGENI_TEMPORAL_API_KEY"),
    temporalTlsServerName: optional("OPENGENI_TEMPORAL_TLS_SERVER_NAME"),
    temporalTlsRootCaCertificateBase64: optional(
      "OPENGENI_TEMPORAL_TLS_ROOT_CA_CERTIFICATE_BASE64",
    ),
    temporalTlsClientCertificateBase64: optional("OPENGENI_TEMPORAL_TLS_CLIENT_CERTIFICATE_BASE64"),
    temporalTlsClientPrivateKeyBase64: optional("OPENGENI_TEMPORAL_TLS_CLIENT_PRIVATE_KEY_BASE64"),
    startupDependencyRetryAttempts: optional("OPENGENI_STARTUP_DEPENDENCY_RETRY_ATTEMPTS"),
    startupDependencyRetryInitialDelayMs: optional(
      "OPENGENI_STARTUP_DEPENDENCY_RETRY_INITIAL_DELAY_MS",
    ),
    startupDependencyRetryMaxDelayMs: optional("OPENGENI_STARTUP_DEPENDENCY_RETRY_MAX_DELAY_MS"),
    turnWorkerConcurrencyMode: optional("OPENGENI_TURN_WORKER_CONCURRENCY_MODE"),
    turnWorkerMaxConcurrentTurns: optional("OPENGENI_TURN_WORKER_MAX_CONCURRENT_TURNS"),
    turnWorkerTargetCpuUsage: optional("OPENGENI_TURN_WORKER_TARGET_CPU_USAGE"),
    turnWorkerTargetMemoryUsage: optional("OPENGENI_TURN_WORKER_TARGET_MEMORY_USAGE"),
    turnWorkerEmergencyMemoryUsage: optional("OPENGENI_TURN_WORKER_EMERGENCY_MEMORY_USAGE"),
    turnWorkerMemoryGuardIntervalMs: optional("OPENGENI_TURN_WORKER_MEMORY_GUARD_INTERVAL_MS"),
    turnWorkerMemoryGuardSustainMs: optional("OPENGENI_TURN_WORKER_MEMORY_GUARD_SUSTAIN_MS"),
    observabilityStructuredLogs: optional("OPENGENI_OBSERVABILITY_STRUCTURED_LOGS"),
    observabilityMetricsEnabled: optional("OPENGENI_OBSERVABILITY_METRICS_ENABLED"),
    observabilityOtlpEndpoint:
      optional("OPENGENI_OTEL_EXPORTER_OTLP_ENDPOINT") ?? optional("OTEL_EXPORTER_OTLP_ENDPOINT"),
    observabilityOtlpHeaders:
      optional("OPENGENI_OTEL_EXPORTER_OTLP_HEADERS") ?? optional("OTEL_EXPORTER_OTLP_HEADERS"),
    analyticsEnabled: optional("OPENGENI_ANALYTICS_ENABLED"),
    analyticsConsentRequired: optional("OPENGENI_ANALYTICS_CONSENT_REQUIRED"),
    analyticsReoClientId: optional("OPENGENI_ANALYTICS_REO_CLIENT_ID"),
    analyticsPosthogProjectKey: optional("OPENGENI_ANALYTICS_POSTHOG_PROJECT_KEY"),
    analyticsPosthogHost: optional("OPENGENI_ANALYTICS_POSTHOG_HOST"),
    analyticsGa4MeasurementId: optional("OPENGENI_ANALYTICS_GA4_MEASUREMENT_ID"),
    publicBaseUrl: optional("OPENGENI_PUBLIC_BASE_URL"),
    webBaseUrl: optional("OPENGENI_WEB_BASE_URL"),
    agentReleasesBaseUrl: optional("OPENGENI_AGENT_RELEASES_BASE_URL"),
    agentStableVersion: optional("OPENGENI_AGENT_STABLE_VERSION"),
    agentBetaVersion: optional("OPENGENI_AGENT_BETA_VERSION"),
    productAccessMode: optional("OPENGENI_PRODUCT_ACCESS_MODE"),
    organizationTenancyCanonicalActivationEnabled: optional(
      "OPENGENI_ORGANIZATION_TENANCY_CANONICAL_ACTIVATION_ENABLED",
    ),
    billingMode: optional("OPENGENI_BILLING_MODE"),
    entitlementsMode: optional("OPENGENI_ENTITLEMENTS_MODE"),
    usageLimitsMode: optional("OPENGENI_USAGE_LIMITS_MODE"),
    staticEntitlementsJson: optional("OPENGENI_STATIC_ENTITLEMENTS_JSON"),
    staticUsageLimitsJson: optional("OPENGENI_STATIC_USAGE_LIMITS_JSON"),
    delegationSecret: optional("OPENGENI_DELEGATION_SECRET"),
    defaultFirstPartyMcpTools: optional("OPENGENI_DEFAULT_FIRST_PARTY_MCP_TOOLS"),
    allowedFirstPartyMcpTools: optional("OPENGENI_ALLOWED_FIRST_PARTY_MCP_TOOLS"),
    streamTokenSecret: optional("OPENGENI_STREAM_TOKEN_SECRET"),
    streamControlEnabled: optional("OPENGENI_STREAM_CONTROL_ENABLED"),
    workDiscoveryEnabled: optional("OPENGENI_WORK_DISCOVERY_ENABLED"),
    workClaimMutationsEnabled: optional("OPENGENI_WORK_CLAIM_MUTATIONS_ENABLED"),
    workDiscoveryHumanAdvisoriesEnabled: optional(
      "OPENGENI_WORK_DISCOVERY_HUMAN_ADVISORIES_ENABLED",
    ),
    workDiscoveryAutomaticNudgesEnabled: optional(
      "OPENGENI_WORK_DISCOVERY_AUTOMATIC_NUDGES_ENABLED",
    ),
    ogtoolPackageSpec: optional("OPENGENI_OGTOOL_PACKAGE_SPEC"),
    environmentsEncryptionKey: optional("OPENGENI_ENVIRONMENTS_ENCRYPTION_KEY"),
    integrationsEnabled: optional("OPENGENI_INTEGRATIONS_ENABLED"),
    integrationsStateSecret: optional("OPENGENI_INTEGRATIONS_STATE_SECRET"),
    integrationsAllowPrivateNetworkTargets: optional(
      "OPENGENI_INTEGRATIONS_ALLOW_PRIVATE_NETWORK_TARGETS",
    ),
    integrationsOauthClientsJson: optional("OPENGENI_INTEGRATIONS_OAUTH_CLIENTS_JSON"),
    slackClientId: optional("OPENGENI_SLACK_CLIENT_ID"),
    slackClientSecret: optional("OPENGENI_SLACK_CLIENT_SECRET"),
    slackSigningSecret: optional("OPENGENI_SLACK_SIGNING_SECRET"),
    slackBotDisplayName: optional("OPENGENI_SLACK_BOT_DISPLAY_NAME"),
    slackCommand: optional("OPENGENI_SLACK_COMMAND"),
    googleDriveClientId: optional("OPENGENI_GOOGLE_DRIVE_CLIENT_ID"),
    googleDriveClientSecret: optional("OPENGENI_GOOGLE_DRIVE_CLIENT_SECRET"),
    googleDriveSyncMaxItems: optional("OPENGENI_GOOGLE_DRIVE_SYNC_MAX_ITEMS"),
    googleDriveSyncMaxBytes: optional("OPENGENI_GOOGLE_DRIVE_SYNC_MAX_BYTES"),
    googleDriveSyncMaxFileBytes: optional("OPENGENI_GOOGLE_DRIVE_SYNC_MAX_FILE_BYTES"),
    googleDriveSyncMaxProviderRequests: optional(
      "OPENGENI_GOOGLE_DRIVE_SYNC_MAX_PROVIDER_REQUESTS",
    ),
    googleDriveSyncMaxElapsedSeconds: optional("OPENGENI_GOOGLE_DRIVE_SYNC_MAX_ELAPSED_SECONDS"),
    googleDriveSyncMaxFailureDetails: optional("OPENGENI_GOOGLE_DRIVE_SYNC_MAX_FAILURE_DETAILS"),
    googleDriveProviderRequestTimeoutMs: optional(
      "OPENGENI_GOOGLE_DRIVE_PROVIDER_REQUEST_TIMEOUT_MS",
    ),
    googleDriveProviderRetryAttempts: optional("OPENGENI_GOOGLE_DRIVE_PROVIDER_RETRY_ATTEMPTS"),
    googleDriveProviderRetryInitialDelayMs: optional(
      "OPENGENI_GOOGLE_DRIVE_PROVIDER_RETRY_INITIAL_DELAY_MS",
    ),
    googleDriveProviderRetryMaxDelayMs: optional(
      "OPENGENI_GOOGLE_DRIVE_PROVIDER_RETRY_MAX_DELAY_MS",
    ),
    googleDriveProviderRetryBudgetMs: optional("OPENGENI_GOOGLE_DRIVE_PROVIDER_RETRY_BUDGET_MS"),
    fikenClientId: optional("OPENGENI_FIKEN_OAUTH_CLIENT_ID"),
    fikenClientSecret: optional("OPENGENI_FIKEN_OAUTH_CLIENT_SECRET"),
    googleDriveWorkspaceEventsEnabled: optional("OPENGENI_GOOGLE_DRIVE_WORKSPACE_EVENTS_ENABLED"),
    atlassianClientId: optional("OPENGENI_ATLASSIAN_CLIENT_ID"),
    atlassianClientSecret: optional("OPENGENI_ATLASSIAN_CLIENT_SECRET"),
    maxNestedAgentDepth: optional("OPENGENI_MAX_NESTED_AGENT_DEPTH"),
    socialOauthClientsJson: optional("OPENGENI_SOCIAL_OAUTH_CLIENTS_JSON"),
    goalMaxAutoContinuations: optional("OPENGENI_GOAL_MAX_AUTO_CONTINUATIONS"),
    goalIdleBackoffMs: optional("OPENGENI_GOAL_IDLE_BACKOFF_MS"),
    goalIdleBackoffMaxMs: optional("OPENGENI_GOAL_IDLE_BACKOFF_MAX_MS"),
    childLifecycleNoticesEnabled: optional("OPENGENI_CHILD_LIFECYCLE_NOTICES_ENABLED"),
    slackWorkspaceRoutingEnabled: optional("OPENGENI_SLACK_WORKSPACE_ROUTING_ENABLED"),
    agentMaxModelCallsPerTurn: optional("OPENGENI_AGENT_MAX_MODEL_CALLS_PER_TURN"),
    contextWindowTokens: optional("OPENGENI_CONTEXT_WINDOW_TOKENS"),
    contextEffectiveWindowTokens: optional("OPENGENI_CONTEXT_EFFECTIVE_WINDOW_TOKENS"),
    contextCompactionThresholdRatio: optional("OPENGENI_COMPACTION_THRESHOLD_RATIO"),
    contextReservedOutputTokens: optional("OPENGENI_CONTEXT_RESERVED_OUTPUT_TOKENS"),
    contextAutoCompactThresholdTokens: optional("OPENGENI_CONTEXT_AUTO_COMPACT_THRESHOLD_TOKENS"),
    modelToolOutputTruncationTokens: optional("OPENGENI_MODEL_TOOL_OUTPUT_TRUNCATION_TOKENS"),
    authRequired: optional("OPENGENI_AUTH_REQUIRED"),
    accessKey: optional("OPENGENI_ACCESS_KEY"),
    authAllowHealth: optional("OPENGENI_AUTH_ALLOW_HEALTH"),
    authAllowMetrics: optional("OPENGENI_AUTH_ALLOW_METRICS"),
    apiHost: optional("OPENGENI_API_HOST"),
    apiPort: optional("OPENGENI_API_PORT"),
    workerHttpPort: optional("OPENGENI_WORKER_HTTP_PORT"),
    opengeniMcpInternalUrl: optional("OPENGENI_MCP_INTERNAL_URL"),
    opengeniMcpUrl: optional("OPENGENI_MCP_URL"),
    corsAllowOriginRegex: optional("OPENGENI_CORS_ALLOW_ORIGIN_REGEX"),
    openaiProvider: optional("OPENGENI_OPENAI_PROVIDER"),
    openaiApiKey: optional("OPENGENI_OPENAI_API_KEY") ?? optional("OPENAI_API_KEY"),
    openaiBaseUrl: optional("OPENGENI_OPENAI_BASE_URL") ?? optional("OPENAI_BASE_URL"),
    openaiModel: optional("OPENGENI_OPENAI_MODEL"),
    openaiAllowedModels: optional("OPENGENI_OPENAI_ALLOWED_MODELS"),
    vercelAiGatewayApiKey: optional("OPENGENI_VERCEL_AI_GATEWAY_API_KEY"),
    imageGenerationModel: optional("OPENGENI_IMAGE_GENERATION_MODEL"),
    videoGenerationPollIntervalMs: optional("OPENGENI_VIDEO_GENERATION_POLL_INTERVAL_MS"),
    videoGenerationRecoveryDeadlineMs: optional("OPENGENI_VIDEO_GENERATION_RECOVERY_DEADLINE_MS"),
    videoGenerationReferenceUrlTtlSeconds: optional(
      "OPENGENI_VIDEO_GENERATION_REFERENCE_URL_TTL_SECONDS",
    ),
    videoGenerationMaxConcurrentPerWorkspace: optional(
      "OPENGENI_VIDEO_GENERATION_MAX_CONCURRENT_PER_WORKSPACE",
    ),
    videoGenerationWorkspaceQuotaBytes: optional("OPENGENI_VIDEO_GENERATION_WORKSPACE_QUOTA_BYTES"),
    videoGenerationTempDirectory: optional("OPENGENI_VIDEO_GENERATION_TEMP_DIRECTORY"),
    videoGenerationFfprobePath: optional("OPENGENI_VIDEO_GENERATION_FFPROBE_PATH"),
    videoGenerationCredit480pMicrosPerSecond: optional(
      "OPENGENI_VIDEO_GENERATION_CREDIT_480P_MICROS_PER_SECOND",
    ),
    videoGenerationCredit720pMicrosPerSecond: optional(
      "OPENGENI_VIDEO_GENERATION_CREDIT_720P_MICROS_PER_SECOND",
    ),
    voiceInputMaxDurationSeconds: optional("OPENGENI_VOICE_INPUT_MAX_DURATION_SECONDS"),
    voiceInputMaxSizeBytes: optional("OPENGENI_VOICE_INPUT_MAX_SIZE_BYTES"),
    voiceInputResumableEnabled: optional("OPENGENI_VOICE_INPUT_RESUMABLE_ENABLED"),
    voiceInputResumableMaxDurationSeconds: optional(
      "OPENGENI_VOICE_INPUT_RESUMABLE_MAX_DURATION_SECONDS",
    ),
    voiceInputResumableMaxSizeBytes: optional("OPENGENI_VOICE_INPUT_RESUMABLE_MAX_SIZE_BYTES"),
    voiceInputResumableMaxChunkSizeBytes: optional(
      "OPENGENI_VOICE_INPUT_RESUMABLE_MAX_CHUNK_SIZE_BYTES",
    ),
    voiceInputResumableRetentionSeconds: optional(
      "OPENGENI_VOICE_INPUT_RESUMABLE_RETENTION_SECONDS",
    ),
    voiceInputFfmpegPath: optional("OPENGENI_VOICE_INPUT_FFMPEG_PATH"),
    voiceInputProviderOrder: optional("OPENGENI_VOICE_INPUT_PROVIDER_ORDER"),
    voiceInputOpenaiEnabled: optional("OPENGENI_VOICE_INPUT_OPENAI_ENABLED"),
    voiceInputOpenaiApiKey: optional("OPENGENI_VOICE_INPUT_OPENAI_API_KEY"),
    voiceInputOpenaiBaseUrl: optional("OPENGENI_VOICE_INPUT_OPENAI_BASE_URL"),
    voiceInputOpenaiModel: optional("OPENGENI_VOICE_INPUT_OPENAI_MODEL"),
    voiceInputAzureEnabled: optional("OPENGENI_VOICE_INPUT_AZURE_ENABLED"),
    voiceInputAzureEndpoint: optional("OPENGENI_VOICE_INPUT_AZURE_ENDPOINT"),
    voiceInputAzureDeployment: optional("OPENGENI_VOICE_INPUT_AZURE_DEPLOYMENT"),
    voiceInputAzureApiVersion: optional("OPENGENI_VOICE_INPUT_AZURE_API_VERSION"),
    voiceInputAzureApiKey: optional("OPENGENI_VOICE_INPUT_AZURE_API_KEY"),
    voiceInputAzureAdToken: optional("OPENGENI_VOICE_INPUT_AZURE_AD_TOKEN"),
    voiceInputCodexExperimentalEnabled: optional("OPENGENI_VOICE_INPUT_CODEX_EXPERIMENTAL"),
    modelPricingJson: optional("OPENGENI_MODEL_PRICING_JSON"),
    modelCatalogSource,
    modelCostPolicyJson,
    modelNotesJson: optional("OPENGENI_MODEL_NOTES_JSON"),
    openrouterApiKey: optional("OPENGENI_OPENROUTER_API_KEY"),
    modelProvidersJson: optional("OPENGENI_MODEL_PROVIDERS_JSON"),
    codexSubscriptionEnabled: optional("OPENGENI_CODEX_SUBSCRIPTION_ENABLED"),
    supergrokSubscriptionEnabled: optional("OPENGENI_SUPERGROK_SUBSCRIPTION_ENABLED"),
    supergrokResponseStreamIdleTimeoutMs: optional(
      "OPENGENI_SUPERGROK_RESPONSE_STREAM_IDLE_TIMEOUT_MS",
    ),
    codexConnectedAppsEnabled: optional("OPENGENI_CODEX_CONNECTED_APPS_ENABLED"),
    codexToolSearchEnabled: optional("OPENGENI_CODEX_TOOL_SEARCH_ENABLED"),
    lazyToolSearchEnabled: optional("OPENGENI_LAZY_TOOL_SEARCH_ENABLED"),
    codexCredentialLeasingEnabled: optional("OPENGENI_CODEX_CREDENTIAL_LEASING_ENABLED"),
    codexFleetPolicyShadowEnabled: optional("OPENGENI_CODEX_FLEET_POLICY_SHADOW_ENABLED"),
    codexProductSku: optional("OPENGENI_CODEX_PRODUCT_SKU"),
    openaiReasoningEffort: optional("OPENGENI_OPENAI_REASONING_EFFORT"),
    openaiAllowedReasoningEfforts: optional("OPENGENI_OPENAI_ALLOWED_REASONING_EFFORTS"),
    openaiResponsesTransport: optional("OPENGENI_OPENAI_RESPONSES_TRANSPORT"),
    openaiProviderItemIds: optional("OPENGENI_OPENAI_PROVIDER_ITEM_IDS"),
    openaiReasoningEncryptedContent: optional("OPENGENI_OPENAI_REASONING_ENCRYPTED_CONTENT"),
    openaiMaxRetries: optional("OPENGENI_OPENAI_MAX_RETRIES"),
    webSearchEnabled: optional("OPENGENI_WEB_SEARCH_ENABLED"),
    agentInstructionsTemplate: optional("OPENGENI_AGENT_INSTRUCTIONS_TEMPLATE"),
    azureOpenaiBaseUrl: optional("OPENGENI_AZURE_OPENAI_BASE_URL"),
    azureOpenaiEndpoint: optional("OPENGENI_AZURE_OPENAI_ENDPOINT"),
    azureOpenaiDeployment: optional("OPENGENI_AZURE_OPENAI_DEPLOYMENT"),
    azureOpenaiApiVersion: optional("OPENGENI_AZURE_OPENAI_API_VERSION"),
    azureOpenaiApiKey: optional("OPENGENI_AZURE_OPENAI_API_KEY"),
    azureOpenaiAdToken: optional("OPENGENI_AZURE_OPENAI_AD_TOKEN"),
    disableOpenaiTracing: optional("OPENGENI_DISABLE_OPENAI_TRACING"),
    sandboxBackend: optional("OPENGENI_SANDBOX_BACKEND"),
    dockerImage: optional("OPENGENI_DOCKER_IMAGE"),
    sandboxArtifactRuntimeEnabled: optional("OPENGENI_SANDBOX_ARTIFACT_RUNTIME_ENABLED"),
    dockerExposedPorts: optional("OPENGENI_DOCKER_EXPOSED_PORTS"),
    dockerNetwork: optional("OPENGENI_DOCKER_NETWORK"),
    dockerWorkspaceBaseDir: optional("OPENGENI_DOCKER_WORKSPACE_BASE_DIR"),
    modalAppName: optional("OPENGENI_MODAL_APP_NAME"),
    modalImageRef: optional("OPENGENI_MODAL_IMAGE_REF"),
    modalImageId: optional("OPENGENI_MODAL_IMAGE_ID"),
    modalImageRegistrySecret: optional("OPENGENI_MODAL_IMAGE_REGISTRY_SECRET"),
    modalTimeoutSeconds: optional("OPENGENI_MODAL_TIMEOUT_SECONDS"),
    modalSandboxCpu: optional("OPENGENI_MODAL_SANDBOX_CPU"),
    modalSandboxMemoryMiB: optional("OPENGENI_MODAL_SANDBOX_MEMORY_MIB"),
    modalTokenId: optional("OPENGENI_MODAL_TOKEN_ID"),
    modalTokenSecret: optional("OPENGENI_MODAL_TOKEN_SECRET"),
    modalEnvironment: optional("OPENGENI_MODAL_ENVIRONMENT"),
    modalIdleTimeoutSeconds: optional("OPENGENI_MODAL_IDLE_TIMEOUT_SECONDS"),
    modalWorkspacePersistence: optional("OPENGENI_MODAL_WORKSPACE_PERSISTENCE"),
    sandboxDesktopEnabled: optional("OPENGENI_SANDBOX_DESKTOP_ENABLED"),
    sandboxDesktopInteractive: optional("OPENGENI_SANDBOX_DESKTOP_INTERACTIVE"),
    sandboxTerminalEnabled: optional("OPENGENI_SANDBOX_TERMINAL_ENABLED"),
    streamResolutionWidth: optional("OPENGENI_STREAM_RESOLUTION_WIDTH"),
    streamResolutionHeight: optional("OPENGENI_STREAM_RESOLUTION_HEIGHT"),
    recordingEnabled: optional("OPENGENI_RECORDING_ENABLED"),
    workspaceCaptureEnabled: optional("OPENGENI_WORKSPACE_CAPTURE"),
    recordingDefaultCodec: optional("OPENGENI_RECORDING_DEFAULT_CODEC"),
    recordingFramerate: optional("OPENGENI_RECORDING_FRAMERATE"),
    recordingMaxSeconds: optional("OPENGENI_RECORDING_MAX_SECONDS"),
    recordingMaxBytes: optional("OPENGENI_RECORDING_MAX_BYTES"),
    daytonaApiKey: optional("OPENGENI_DAYTONA_API_KEY"),
    daytonaApiUrl: optional("OPENGENI_DAYTONA_API_URL"),
    daytonaTarget: optional("OPENGENI_DAYTONA_TARGET"),
    daytonaImage: optional("OPENGENI_DAYTONA_IMAGE"),
    daytonaSnapshotName: optional("OPENGENI_DAYTONA_SNAPSHOT_NAME"),
    daytonaAutoStopInterval: optional("OPENGENI_DAYTONA_AUTO_STOP_INTERVAL"),
    daytonaTimeoutSeconds: optional("OPENGENI_DAYTONA_TIMEOUT_SECONDS"),
    daytonaExposedPortUrlTtlSeconds: optional("OPENGENI_DAYTONA_EXPOSED_PORT_URL_TTL_SECONDS"),
    runloopApiKey: optional("OPENGENI_RUNLOOP_API_KEY"),
    runloopBaseUrl: optional("OPENGENI_RUNLOOP_BASE_URL"),
    runloopBlueprintName: optional("OPENGENI_RUNLOOP_BLUEPRINT_NAME"),
    runloopBlueprintId: optional("OPENGENI_RUNLOOP_BLUEPRINT_ID"),
    runloopTunnel: optional("OPENGENI_RUNLOOP_TUNNEL"),
    runloopKeepAliveSeconds: optional("OPENGENI_RUNLOOP_KEEP_ALIVE_SECONDS"),
    e2bApiKey: optional("OPENGENI_E2B_API_KEY"),
    e2bTemplate: optional("OPENGENI_E2B_TEMPLATE"),
    e2bTimeoutSeconds: optional("OPENGENI_E2B_TIMEOUT_SECONDS"),
    e2bTimeoutAction: optional("OPENGENI_E2B_TIMEOUT_ACTION"),
    e2bAllowInternetAccess: optional("OPENGENI_E2B_ALLOW_INTERNET_ACCESS"),
    e2bAutoResume: optional("OPENGENI_E2B_AUTO_RESUME"),
    e2bWorkspacePersistence: optional("OPENGENI_E2B_WORKSPACE_PERSISTENCE"),
    blaxelApiKey: optional("OPENGENI_BLAXEL_API_KEY"),
    blaxelImage: optional("OPENGENI_BLAXEL_IMAGE"),
    blaxelRegion: optional("OPENGENI_BLAXEL_REGION"),
    blaxelExposedPortPublic: optional("OPENGENI_BLAXEL_EXPOSED_PORT_PUBLIC"),
    blaxelExposedPortUrlTtlSeconds: optional("OPENGENI_BLAXEL_EXPOSED_PORT_URL_TTL_SECONDS"),
    blaxelMemoryMb: optional("OPENGENI_BLAXEL_MEMORY_MB"),
    blaxelTtl: optional("OPENGENI_BLAXEL_TTL"),
    cloudflareWorkerUrl: optional("OPENGENI_CLOUDFLARE_WORKER_URL"),
    cloudflareApiKey: optional("OPENGENI_CLOUDFLARE_API_KEY"),
    browserbaseApiKey: optional("OPENGENI_BROWSERBASE_API_KEY"),
    kernelApiKey: optional("OPENGENI_KERNEL_API_KEY"),
    kernelEndpoint: optional("OPENGENI_KERNEL_ENDPOINT"),
    kernelBrowserTimeoutSeconds: optional("OPENGENI_KERNEL_BROWSER_TIMEOUT_SECONDS"),
    kernelBrowserStealth: optional("OPENGENI_KERNEL_BROWSER_STEALTH"),
    vercelToken: optional("OPENGENI_VERCEL_TOKEN"),
    vercelProjectId: optional("OPENGENI_VERCEL_PROJECT_ID"),
    vercelTeamId: optional("OPENGENI_VERCEL_TEAM_ID"),
    vercelRuntime: optional("OPENGENI_VERCEL_RUNTIME"),
    openSandboxBaseUrl: optional("OPENGENI_OPENSANDBOX_BASE_URL"),
    openSandboxApiKey: optional("OPENGENI_OPENSANDBOX_API_KEY"),
    openSandboxImage: optional("OPENGENI_OPENSANDBOX_IMAGE"),
    openSandboxTtlSeconds: optional("OPENGENI_OPENSANDBOX_TTL_SECONDS"),
    openSandboxUseServerProxy: optional("OPENGENI_OPENSANDBOX_USE_SERVER_PROXY"),
    openSandboxSignedEndpoints: optional("OPENGENI_OPENSANDBOX_SIGNED_ENDPOINTS"),
    openSandboxSignedEndpointTtlSeconds: optional(
      "OPENGENI_OPENSANDBOX_SIGNED_ENDPOINT_TTL_SECONDS",
    ),
    openSandboxChannelBPublicBaseUrl: optional("OPENGENI_OPENSANDBOX_CHANNEL_B_PUBLIC_BASE_URL"),
    openSandboxInteractionFrameProxy: optional("OPENGENI_OPENSANDBOX_INTERACTION_FRAME_PROXY"),
    openSandboxPoolRef: optional("OPENGENI_OPENSANDBOX_POOL_REF"),
    openSandboxKubernetesInventoryNamespace: optional(
      "OPENGENI_OPENSANDBOX_KUBERNETES_INVENTORY_NAMESPACE",
    ),
    sandboxOwnershipEnabled: optional("OPENGENI_SANDBOX_OWNERSHIP_ENABLED"),
    rigVerificationLeaseOwnershipEnabled: optional(
      "OPENGENI_RIG_VERIFICATION_LEASE_OWNERSHIP_ENABLED",
    ),
    sandboxLazyProvisionEnabled: optional("OPENGENI_SANDBOX_LAZY_PROVISION"),
    sandboxSelfhostedEnabled: optional("OPENGENI_SANDBOX_SELFHOSTED_ENABLED"),
    agentOpStreamEnabled: optional("OPENGENI_AGENT_OP_STREAM_ENABLED"),
    enrollmentSigningSecret: optional("OPENGENI_ENROLLMENT_SIGNING_SECRET"),
    selfhostedNatsUrl: optional("OPENGENI_SELFHOSTED_NATS_URL"),
    selfhostedRelayUrl: optional("OPENGENI_SELFHOSTED_RELAY_URL"),
    selfhostedRelayTokenSecret: optional("OPENGENI_SELFHOSTED_RELAY_TOKEN_SECRET"),
    agentUpdatePublicKey: optional("OPENGENI_AGENT_UPDATE_PUBLIC_KEY"),
    selfhostedNatsCalloutAccountSeed: optional("OPENGENI_SELFHOSTED_NATS_CALLOUT_ACCOUNT_SEED"),
    selfhostedNatsCalloutAccountName: optional("OPENGENI_SELFHOSTED_NATS_CALLOUT_ACCOUNT_NAME"),
    selfhostedNatsCalloutUser: optional("OPENGENI_SELFHOSTED_NATS_CALLOUT_USER"),
    selfhostedNatsCalloutPassword: optional("OPENGENI_SELFHOSTED_NATS_CALLOUT_PASSWORD"),
    selfhostedNatsControlUser: optional("OPENGENI_SELFHOSTED_NATS_CONTROL_USER"),
    selfhostedNatsControlPassword: optional("OPENGENI_SELFHOSTED_NATS_CONTROL_PASSWORD"),
    sandboxSelfhostedExecTimeoutMs: optional("OPENGENI_SANDBOX_SELFHOSTED_EXEC_TIMEOUT_MS"),
    sandboxSelfhostedControlTimeoutMs: optional("OPENGENI_SANDBOX_SELFHOSTED_CONTROL_TIMEOUT_MS"),
    sandboxLeaseReaperPeriodMs: optional("OPENGENI_SANDBOX_LEASE_REAPER_PERIOD_MS"),
    sandboxViewerHolderTtlMs: optional("OPENGENI_SANDBOX_VIEWER_HOLDER_TTL_MS"),
    sandboxInteractionHolderTtlMs: optional("OPENGENI_SANDBOX_INTERACTION_HOLDER_TTL_MS"),
    sandboxIdleGraceMs: optional("OPENGENI_SANDBOX_IDLE_GRACE_MS"),
    sandboxSnapshotIntervalMs: optional("OPENGENI_SANDBOX_SNAPSHOT_INTERVAL_MS"),
    sandboxSnapshotTimeoutMs: optional("OPENGENI_SANDBOX_SNAPSHOT_TIMEOUT_MS"),
    sandboxRotationLeadMs: optional("OPENGENI_SANDBOX_ROTATION_LEAD_MS"),
    sandboxRotationBatchSize: optional("OPENGENI_SANDBOX_ROTATION_BATCH_SIZE"),
    sandboxLeaseTtlMs: optional("OPENGENI_SANDBOX_LEASE_TTL_MS"),
    sandboxLeaseWarmingTtlMs: optional("OPENGENI_SANDBOX_LEASE_WARMING_TTL_MS"),
    sandboxWarmingTimeoutMs: optional("OPENGENI_SANDBOX_WARMING_TIMEOUT_MS"),
    workspaceControlLockTimeoutMs: optional("OPENGENI_WORKSPACE_CONTROL_LOCK_TIMEOUT_MS"),
    rigSetupTimeoutMs: optional("OPENGENI_RIG_SETUP_TIMEOUT_MS"),
    sandboxWarmRateMicrosPerSecondJson: optional(
      "OPENGENI_SANDBOX_WARM_RATE_MICROS_PER_SECOND_JSON",
    ),
    sandboxMaxWarmSecondsPerWorkspace: optional("OPENGENI_SANDBOX_MAX_WARM_SECONDS_PER_WORKSPACE"),
    sandboxPreparationProfiles: optional("OPENGENI_SANDBOX_PREPARATION_PROFILES"),
    sandboxEnvAllowlist: optional("OPENGENI_SANDBOX_ENV_ALLOWLIST"),
    objectStorageEndpoint: optional("OPENGENI_OBJECT_STORAGE_ENDPOINT"),
    objectStorageInternalEndpoint: optional("OPENGENI_OBJECT_STORAGE_INTERNAL_ENDPOINT"),
    objectStorageSandboxEndpoint: optional("OPENGENI_OBJECT_STORAGE_SANDBOX_ENDPOINT"),
    objectStorageBackend: optional("OPENGENI_OBJECT_STORAGE_BACKEND"),
    objectStorageBucket: optional("OPENGENI_OBJECT_STORAGE_BUCKET"),
    objectStorageRegion: optional("OPENGENI_OBJECT_STORAGE_REGION"),
    objectStorageS3Provider: optional("OPENGENI_OBJECT_STORAGE_S3_PROVIDER"),
    objectStorageAccessKeyId: optional("OPENGENI_OBJECT_STORAGE_ACCESS_KEY_ID"),
    objectStorageSecretAccessKey: optional("OPENGENI_OBJECT_STORAGE_SECRET_ACCESS_KEY"),
    objectStorageForcePathStyle: optional("OPENGENI_OBJECT_STORAGE_FORCE_PATH_STYLE"),
    objectStorageAzureConnectionString: optional("OPENGENI_OBJECT_STORAGE_AZURE_CONNECTION_STRING"),
    objectStorageAzureAccountName: optional("OPENGENI_OBJECT_STORAGE_AZURE_ACCOUNT_NAME"),
    objectStorageAzureAccountKey: optional("OPENGENI_OBJECT_STORAGE_AZURE_ACCOUNT_KEY"),
    objectStorageAzureEndpoint: optional("OPENGENI_OBJECT_STORAGE_AZURE_ENDPOINT"),
    objectStorageGcsProjectId: optional("OPENGENI_OBJECT_STORAGE_GCS_PROJECT_ID"),
    objectStorageGcsCredentialsJson: optional("OPENGENI_OBJECT_STORAGE_GCS_CREDENTIALS_JSON"),
    objectStorageGcsKeyFilename: optional("OPENGENI_OBJECT_STORAGE_GCS_KEY_FILENAME"),
    objectStorageGcsApiEndpoint: optional("OPENGENI_OBJECT_STORAGE_GCS_API_ENDPOINT"),
    documentParser: optional("OPENGENI_DOCUMENT_PARSER"),
    documentChunkSize: optional("OPENGENI_DOCUMENT_CHUNK_SIZE"),
    documentChunkOverlap: optional("OPENGENI_DOCUMENT_CHUNK_OVERLAP"),
    documentEmbeddingProvider: optional("OPENGENI_DOCUMENT_EMBEDDING_PROVIDER"),
    documentEmbeddingModel: optional("OPENGENI_DOCUMENT_EMBEDDING_MODEL"),
    documentEmbeddingDimensions: optional("OPENGENI_DOCUMENT_EMBEDDING_DIMENSIONS"),
    documentEmbeddingApiKey: optional("OPENGENI_DOCUMENT_EMBEDDING_API_KEY"),
    documentEmbeddingBaseUrl: optional("OPENGENI_DOCUMENT_EMBEDDING_BASE_URL"),
    documentCurationProvider: optional("OPENGENI_DOCUMENT_CURATION_PROVIDER"),
    documentCurationModel: optional("OPENGENI_DOCUMENT_CURATION_MODEL"),
    documentCurationApiKey: optional("OPENGENI_DOCUMENT_CURATION_API_KEY"),
    documentCurationBaseUrl: optional("OPENGENI_DOCUMENT_CURATION_BASE_URL"),
    gitAuthorName: optional("OPENGENI_GIT_AUTHOR_NAME"),
    gitAuthorEmail: optional("OPENGENI_GIT_AUTHOR_EMAIL"),
    gitCommitterName: optional("OPENGENI_GIT_COMMITTER_NAME"),
    gitCommitterEmail: optional("OPENGENI_GIT_COMMITTER_EMAIL"),
    githubAppManifestBaseUrl: optional("OPENGENI_GITHUB_APP_MANIFEST_BASE_URL"),
    githubAppManifestStateSecret: optional("OPENGENI_GITHUB_APP_MANIFEST_STATE_SECRET"),
    githubAppId: optional("OPENGENI_GITHUB_APP_ID"),
    githubClientId: optional("OPENGENI_GITHUB_CLIENT_ID"),
    githubClientSecret: optional("OPENGENI_GITHUB_CLIENT_SECRET"),
    githubRestMcpEnabled: optional("OPENGENI_GITHUB_REST_MCP_ENABLED"),
    githubPersonalOauthEnabled: optional("OPENGENI_GITHUB_PERSONAL_OAUTH_ENABLED"),
    githubPersonalOauthClientId: optional("OPENGENI_GITHUB_PERSONAL_OAUTH_CLIENT_ID"),
    githubPersonalOauthClientSecret: optional("OPENGENI_GITHUB_PERSONAL_OAUTH_CLIENT_SECRET"),
    githubAppSlug: optional("OPENGENI_GITHUB_APP_SLUG"),
    githubWebhookSecret: optional("OPENGENI_GITHUB_WEBHOOK_SECRET"),
    githubAppPrivateKey: optional("OPENGENI_GITHUB_APP_PRIVATE_KEY"),
    prReviewGithubAppId: optional("OPENGENI_PR_REVIEW_GITHUB_APP_ID"),
    prReviewGithubClientId: optional("OPENGENI_PR_REVIEW_GITHUB_CLIENT_ID"),
    prReviewGithubClientSecret: optional("OPENGENI_PR_REVIEW_GITHUB_CLIENT_SECRET"),
    prReviewGithubAppSlug: optional("OPENGENI_PR_REVIEW_GITHUB_APP_SLUG"),
    prReviewGithubWebhookSecret: optional("OPENGENI_PR_REVIEW_GITHUB_WEBHOOK_SECRET"),
    prReviewGithubAppPrivateKey: optional("OPENGENI_PR_REVIEW_GITHUB_APP_PRIVATE_KEY"),
    betterAuthSecret: optional("OPENGENI_BETTER_AUTH_SECRET"),
    betterAuthAllowedHosts: optional("OPENGENI_BETTER_AUTH_ALLOWED_HOSTS"),
    betterAuthCookieDomain: optional("OPENGENI_BETTER_AUTH_COOKIE_DOMAIN"),
    betterAuthTrustedOrigins: optional("OPENGENI_BETTER_AUTH_TRUSTED_ORIGINS"),
    managedAuthGoogleClientId: optional("OPENGENI_MANAGED_AUTH_GOOGLE_CLIENT_ID"),
    managedAuthGoogleClientSecret: optional("OPENGENI_MANAGED_AUTH_GOOGLE_CLIENT_SECRET"),
    managedAuthGithubClientId: optional("OPENGENI_MANAGED_AUTH_GITHUB_CLIENT_ID"),
    managedAuthGithubClientSecret: optional("OPENGENI_MANAGED_AUTH_GITHUB_CLIENT_SECRET"),
    managedAuthSessionSetMode: optional("OPENGENI_MANAGED_AUTH_SESSION_SET_MODE"),
    resendApiKey: optional("OPENGENI_RESEND_API_KEY"),
    emailFrom: optional("OPENGENI_EMAIL_FROM"),
    stripeSecretKey: optional("OPENGENI_STRIPE_SECRET_KEY"),
    stripePublishableKey: optional("OPENGENI_STRIPE_PUBLISHABLE_KEY"),
    stripeWebhookSecret: optional("OPENGENI_STRIPE_WEBHOOK_SECRET"),
    stripeCreditsProductId: optional("OPENGENI_STRIPE_CREDITS_PRODUCT_ID"),
    mcpServers: parseMcpServers(optional("OPENGENI_MCP_SERVERS")),
  };
  const parsed = SettingsSchema.parse(raw);
  const settings = {
    ...parsed,
    sandboxIdleGraceMs:
      raw.sandboxIdleGraceMs === undefined && parsed.sandboxBackend === "modal"
        ? Math.min(900_000, Math.floor((parsed.modalTimeoutSeconds * 1000) / 2))
        : parsed.sandboxIdleGraceMs,
    sandboxRotationLeadMs:
      raw.sandboxRotationLeadMs === undefined && parsed.sandboxBackend === "modal"
        ? Math.min(3_600_000, Math.floor((parsed.modalTimeoutSeconds * 1000) / 2))
        : parsed.sandboxRotationLeadMs,
    mcpServers: ensureBuiltInMcpServers(parsed),
  };
  validateSettings(settings, source);
  return settings;
}

const LOCAL_FIRST_PARTY_DELEGATION_SECRET = "opengeni-local-first-party-delegation-secret-v1";

/**
 * First-party session tools need a shared HMAC identity even in the unauthenticated
 * local product mode. A fixed local-only value is no broader than that mode's
 * existing access boundary, while configured and managed deployments continue to
 * require an operator-provided secret.
 */
export function resolveFirstPartyDelegationSecret(settings: Settings): string | undefined {
  const explicit = settings.delegationSecret?.trim();
  if (explicit) return explicit;
  const configuredAccessKey = settings.accessKey?.trim();
  if (settings.productAccessMode === "configured" && settings.authRequired && configuredAccessKey) {
    return configuredAccessKey;
  }
  return settings.productAccessMode === "local" &&
    (settings.environment === "local" || settings.environment === "test")
    ? LOCAL_FIRST_PARTY_DELEGATION_SECRET
    : undefined;
}

export type FirstPartyMcpToolPolicy = {
  default: FirstPartyMcpToolNameType[];
  allowed: FirstPartyMcpToolNameType[];
};

/** Resolve the deployment's session-tool defaults and hard execution ceiling. */
export function resolveFirstPartyMcpToolPolicy(
  settings: Pick<Settings, "defaultFirstPartyMcpTools" | "allowedFirstPartyMcpTools">,
): FirstPartyMcpToolPolicy {
  const allowed = settings.allowedFirstPartyMcpTools ?? [...FIRST_PARTY_MCP_TOOL_NAMES];
  const allowedSet = new Set(allowed);
  const defaults = settings.defaultFirstPartyMcpTools ?? [...DEFAULT_FIRST_PARTY_MCP_TOOLS];
  return {
    default: defaults.filter((tool) => allowedSet.has(tool)),
    allowed: [...allowed],
  };
}

/** Apply the deployment ceiling to an existing durable session selection. */
export function allowedFirstPartyMcpToolsForSession(
  settings: Pick<Settings, "defaultFirstPartyMcpTools" | "allowedFirstPartyMcpTools">,
  selected: readonly FirstPartyMcpToolNameType[] | null | undefined,
): FirstPartyMcpToolNameType[] {
  const policy = resolveFirstPartyMcpToolPolicy(settings);
  const allowed = new Set(policy.allowed);
  return [...(selected ?? policy.default)].filter((tool) => allowed.has(tool));
}

/**
 * The Modal sandbox idle timeout (seconds) the provider actually passes as
 * idleTimeoutMs (sandbox-file-persistence). When the operator did not pin
 * OPENGENI_MODAL_IDLE_TIMEOUT_SECONDS we DEFAULT it to the hard lifetime
 * (modalTimeoutSeconds): OpenGeni's reaper owns box lifecycle, so Modal's
 * built-in idle-reap (which would otherwise fire on its short server default and
 * kill the box BEFORE the reaper can snapshot /workspace) is pushed out to the
 * hard backstop. An explicit smaller value is honoured (the boot invariant keeps
 * it above reaperPeriod + idleGrace so a drained box still survives long enough
 * to be persisted).
 */
export function effectiveModalIdleTimeoutSeconds(settings: Settings): number {
  return settings.modalIdleTimeoutSeconds ?? settings.modalTimeoutSeconds;
}

export type EffectiveSandboxLifecycle = {
  hardLifetimeMs: number | null;
  renewableTtlSeconds: number | null;
  providerIdleTimeoutMs: number | null;
  rotationLeadMs: number | null;
};

/** Resolve provider lifecycle clocks without teaching generic callers Modal or
 * OpenSandbox field names. Modal's returned values are exactly the pre-existing
 * hard/idle/rotation values; OpenSandbox instead exposes a renewable TTL and no
 * finite-deadline rotation. */
export function effectiveSandboxLifecycle(
  settings: Settings,
  backend: z.infer<typeof SandboxBackend> = settings.sandboxBackend,
): EffectiveSandboxLifecycle {
  if (backend === "modal") {
    return {
      hardLifetimeMs: settings.modalTimeoutSeconds * 1000,
      renewableTtlSeconds: null,
      providerIdleTimeoutMs: effectiveModalIdleTimeoutSeconds(settings) * 1000,
      rotationLeadMs: settings.sandboxRotationLeadMs,
    };
  }
  if (backend === "opensandbox") {
    return {
      hardLifetimeMs: null,
      renewableTtlSeconds: settings.openSandboxTtlSeconds,
      providerIdleTimeoutMs: null,
      rotationLeadMs: null,
    };
  }
  return {
    hardLifetimeMs: CAPABILITY_DESCRIPTORS[backend].lifetime.hardLifetimeMs ?? null,
    renewableTtlSeconds: null,
    providerIdleTimeoutMs: null,
    rotationLeadMs: null,
  };
}

/**
 * One shared upper bound for the durable provider-capture claim and for command
 * admission waiting behind it. The SDK request itself is bounded by
 * sandboxSnapshotTimeoutMs; the extra window lets a non-cancellable provider
 * response settle and release its exact claim without turning a normal
 * checkpoint into a visible command failure. Database validation caps both
 * consumers at one hour.
 */
export function sandboxArchiveCaptureTimeoutMs(
  settings: Pick<Settings, "sandboxSnapshotTimeoutMs">,
): number {
  return Math.min(
    SANDBOX_ARCHIVE_CAPTURE_MAX_TIMEOUT_MS,
    settings.sandboxSnapshotTimeoutMs + SANDBOX_ARCHIVE_CAPTURE_SETTLEMENT_GRACE_MS,
  );
}

export function sandboxLifecycleTransitionWaitMs(
  settings: Pick<Settings, "sandboxSnapshotTimeoutMs" | "sandboxLeaseReaperPeriodMs">,
): number {
  const captureTimeoutMs = sandboxArchiveCaptureTimeoutMs(settings);
  return Math.min(
    SANDBOX_LIFECYCLE_TRANSITION_MAX_WAIT_MS,
    settings.sandboxLeaseReaperPeriodMs +
      captureTimeoutMs +
      SANDBOX_LIFECYCLE_RETRY_HANDOFF_GRACE_MS,
  );
}

export function collectSandboxEnvironment(
  settings: Settings,
  source: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of sandboxEnvironmentVariableNames(settings)) {
    const value = source[name];
    if (value) {
      out[name] = value;
    }
  }
  return out;
}

/**
 * Resolved API key for a registry provider: the inline `apiKey` when present,
 * else the value of the env var named by `apiKeyEnv`. The preferred form is
 * `apiKeyEnv` (the secret stays out of OPENGENI_MODEL_PROVIDERS_JSON). Reads
 * from `source` (defaults to process.env) so callers can resolve against an
 * explicit environment in tests.
 */
export function resolveProviderApiKey(
  provider: Pick<RegistryProvider, "apiKey" | "apiKeyEnv">,
  source: NodeJS.ProcessEnv = process.env,
): string | undefined {
  if (provider.apiKey) {
    return provider.apiKey;
  }
  if (provider.apiKeyEnv) {
    const value = source[provider.apiKeyEnv];
    return value && value.trim().length > 0 ? value : undefined;
  }
  return undefined;
}

const HTTP_FIELD_NAME = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
const CREDENTIAL_LIKE_NAME_PARTS = new Set([
  "apikey",
  "auth",
  "authorization",
  "bearer",
  "credential",
  "cookie",
  "key",
  "password",
  "secret",
  "session",
  "signature",
  "token",
]);
const REASONING_EFFORT_ORDER = new Map(
  ReasoningEffort.options.map((effort, index) => [effort, index]),
);
const MODALITY_ORDER = new Map(["text", "image", "audio"].map((value, index) => [value, index]));
const LATENCY_MODE_ORDER = new Map(
  ["standard", "priority", "fast"].map((value, index) => [value, index]),
);

function normalizeRegistryBaseUrl(value: string, providerId: string): string {
  const url = new URL(value);
  if (url.username || url.password) {
    throw new Error(`provider ${providerId} baseUrl must not contain userinfo`);
  }
  if (url.search) {
    throw new Error(
      `provider ${providerId} baseUrl must not contain a query; move query entries to defaultQuery`,
    );
  }
  if (url.hash) {
    throw new Error(`provider ${providerId} baseUrl must not contain a fragment`);
  }
  return url.toString();
}

function isCredentialLikeMetadataName(name: string): boolean {
  return name
    .toLowerCase()
    .split(/[-_.]/u)
    .some((part) => CREDENTIAL_LIKE_NAME_PARTS.has(part));
}

function normalizeHeaderMap(
  providerId: string,
  headers: Record<string, string> | undefined,
): Record<string, string> | undefined {
  if (!headers) {
    return undefined;
  }
  const normalized: Record<string, string> = {};
  const rawByNormalized = new Map<string, string>();
  for (const [rawName, value] of Object.entries(headers)) {
    if (!HTTP_FIELD_NAME.test(rawName)) {
      throw new Error(
        `provider ${providerId} defaultHeaders contains invalid HTTP field name ${JSON.stringify(rawName)}`,
      );
    }
    const name = rawName.toLowerCase();
    const previous = rawByNormalized.get(name);
    if (previous !== undefined) {
      throw new Error(
        `provider ${providerId} defaultHeaders names ${JSON.stringify(previous)} and ${JSON.stringify(rawName)} collide after lowercase normalization`,
      );
    }
    if (name === "authorization") {
      throw new Error(
        `provider ${providerId} defaultHeaders must not override SDK-managed Authorization`,
      );
    }
    rawByNormalized.set(name, rawName);
    normalized[name] = value;
  }
  return normalized;
}

function normalizePublicHeaderNames(
  providerId: string,
  names: string[] | undefined,
  headers: Record<string, string> | undefined,
): string[] | undefined {
  if (!names) {
    return undefined;
  }
  const normalized: string[] = [];
  const seen = new Set<string>();
  for (const rawName of names) {
    if (!HTTP_FIELD_NAME.test(rawName)) {
      throw new Error(
        `provider ${providerId} publicDefaultHeaderNames contains invalid HTTP field name ${JSON.stringify(rawName)}`,
      );
    }
    const name = rawName.toLowerCase();
    if (seen.has(name)) {
      throw new Error(
        `provider ${providerId} publicDefaultHeaderNames contains duplicate normalized name ${JSON.stringify(name)}`,
      );
    }
    if (!(name in (headers ?? {}))) {
      throw new Error(
        `provider ${providerId} publicDefaultHeaderNames declares absent defaultHeaders entry ${JSON.stringify(name)}`,
      );
    }
    if (isCredentialLikeMetadataName(name)) {
      throw new Error(
        `provider ${providerId} publicDefaultHeaderNames cannot classify credential-like name ${JSON.stringify(name)} as public`,
      );
    }
    seen.add(name);
    normalized.push(name);
  }
  return normalized;
}

function normalizeQueryMap(
  providerId: string,
  query: Record<string, string> | undefined,
): Record<string, string> | undefined {
  if (!query) {
    return undefined;
  }
  for (const name of Object.keys(query)) {
    if (!name) {
      throw new Error(`provider ${providerId} defaultQuery contains an empty name`);
    }
  }
  return { ...query };
}

function normalizePublicQueryNames(
  providerId: string,
  names: string[] | undefined,
  query: Record<string, string> | undefined,
): string[] | undefined {
  if (!names) {
    return undefined;
  }
  const seen = new Set<string>();
  for (const name of names) {
    if (seen.has(name)) {
      throw new Error(
        `provider ${providerId} publicDefaultQueryNames contains duplicate name ${JSON.stringify(name)}`,
      );
    }
    if (!(name in (query ?? {}))) {
      throw new Error(
        `provider ${providerId} publicDefaultQueryNames declares absent defaultQuery entry ${JSON.stringify(name)}`,
      );
    }
    if (isCredentialLikeMetadataName(name)) {
      throw new Error(
        `provider ${providerId} publicDefaultQueryNames cannot classify credential-like name ${JSON.stringify(name)} as public`,
      );
    }
    seen.add(name);
  }
  return [...names];
}

function normalizeRegistryProvider(provider: RegistryProvider): RegistryProvider {
  const defaultHeaders = normalizeHeaderMap(provider.id, provider.defaultHeaders);
  const defaultQuery = normalizeQueryMap(provider.id, provider.defaultQuery);
  return {
    ...provider,
    baseUrl: normalizeRegistryBaseUrl(provider.baseUrl, provider.id),
    ...(defaultHeaders === undefined ? {} : { defaultHeaders }),
    ...(defaultQuery === undefined ? {} : { defaultQuery }),
    ...(provider.publicDefaultHeaderNames === undefined
      ? {}
      : {
          publicDefaultHeaderNames: normalizePublicHeaderNames(
            provider.id,
            provider.publicDefaultHeaderNames,
            defaultHeaders,
          ),
        }),
    ...(provider.publicDefaultQueryNames === undefined
      ? {}
      : {
          publicDefaultQueryNames: normalizePublicQueryNames(
            provider.id,
            provider.publicDefaultQueryNames,
            defaultQuery,
          ),
        }),
  };
}

function normalizeModelPricingSchedule(
  pricing: ModelPricing | ModelPricingScheduleV1,
): ModelPricingScheduleV1 {
  return "default" in pricing ? pricing : { default: pricing };
}

function normalizeCapabilities(capabilities: ModelCapabilitiesV1): ModelCapabilitiesV1 {
  const parsed = ModelCapabilitiesV1Schema.parse(capabilities);
  return {
    ...parsed,
    reasoning: {
      ...parsed.reasoning,
      efforts: [...parsed.reasoning.efforts].sort(
        (left, right) =>
          (REASONING_EFFORT_ORDER.get(left) ?? 0) - (REASONING_EFFORT_ORDER.get(right) ?? 0),
      ),
    },
    inputModalities: [...parsed.inputModalities].sort(
      (left, right) => (MODALITY_ORDER.get(left) ?? 0) - (MODALITY_ORDER.get(right) ?? 0),
    ),
    inputFileMediaTypes: [...new Set(parsed.inputFileMediaTypes)].sort(),
    outputModalities: [...parsed.outputModalities].sort(
      (left, right) => (MODALITY_ORDER.get(left) ?? 0) - (MODALITY_ORDER.get(right) ?? 0),
    ),
    latencyModes: [...parsed.latencyModes].sort(
      (left, right) =>
        (LATENCY_MODE_ORDER.get(left.id) ?? 0) - (LATENCY_MODE_ORDER.get(right.id) ?? 0),
    ),
  };
}

function legacyModelCapabilities(
  settings: Settings,
  input: {
    reasoningEffort: boolean;
    hostedWebSearch: boolean;
    hostedImageGeneration?: boolean;
    vision?: boolean;
  },
): ModelCapabilitiesV1 {
  const reasoningEfforts = input.reasoningEffort ? configuredAllowedReasoningEfforts(settings) : [];
  return normalizeCapabilities({
    reasoning: {
      upstream: input.reasoningEffort ? "supported" : "unknown",
      runnable: input.reasoningEffort,
      efforts: reasoningEfforts,
      defaultEffort: input.reasoningEffort ? settings.openaiReasoningEffort : null,
      required: false,
    },
    functionCalling: { upstream: "unknown", runnable: true },
    structuredOutput: { upstream: "unknown", runnable: false },
    hostedTools: {
      webSearch: {
        upstream: input.hostedWebSearch ? "supported" : "unknown",
        runnable: input.hostedWebSearch,
      },
      xSearch: { upstream: "unknown", runnable: false },
      codeExecution: { upstream: "unknown", runnable: false },
      imageGeneration: {
        upstream: input.hostedImageGeneration ? "supported" : "unknown",
        runnable: input.hostedImageGeneration ?? false,
      },
    },
    inputModalities: input.vision ? ["text", "image"] : ["text"],
    inputFileMediaTypes: [
      "application/json",
      "application/pdf",
      "application/x-yaml",
      "application/yaml",
      "text/*",
    ],
    outputModalities: ["text"],
    transports: {
      sse: { upstream: "unknown", runnable: true },
      responsesWebSocket: { upstream: "unknown", runnable: false },
      realtimeAudio: { upstream: "unknown", runnable: false },
    },
    latencyModes: [{ id: "standard", upstream: "unknown", runnable: true }],
  });
}

export function gatewayRequestPolicyForUpstreamModel(
  upstreamModelId: string,
  models: readonly GatewayCatalogModel[] = defaultGatewayCatalogModels(),
): ConfiguredModel["requestPolicy"] {
  const model = models.find((candidate) => candidate.upstreamModelId === upstreamModelId);
  if (!model) {
    return undefined;
  }
  return {
    gateway: {
      only: [...model.providers] as [string, ...string[]],
      caching: model.implicitCaching ? "auto" : "none",
    },
  };
}

function gatewayModelCapabilities(
  settings: Settings,
  input: { implicitCaching: boolean; vision: boolean; inputFileMediaTypes?: string[] },
): ModelCapabilitiesV1 {
  const legacy = legacyModelCapabilities(settings, {
    reasoningEffort: true,
    hostedWebSearch: false,
  });
  return normalizeCapabilities({
    ...legacy,
    functionCalling: { upstream: "supported", runnable: true },
    inputModalities: input.vision ? ["text", "image"] : ["text"],
    inputFileMediaTypes: input.inputFileMediaTypes ?? [],
    transports: {
      ...legacy.transports,
      sse: { upstream: "supported", runnable: true },
    },
    promptCaching: input.implicitCaching
      ? { upstream: "supported", runnable: true, mode: "implicit" }
      : { upstream: "unsupported", runnable: false, mode: "none" },
    // Both Gateway products expose one reviewed route policy and no separately
    // billed latency mode.
    latencyModes: [{ id: "standard", upstream: "supported", runnable: true }],
  });
}

function gatewayRegistryProvider(
  settings: Settings,
  input:
    | { kind: "vercel-gateway-managed"; apiKey: string }
    | {
        kind: "vercel-gateway-workspace";
        apiKey?: string;
        customModels?: readonly { upstreamModelId: string; label?: string | null }[];
      },
): InternalRegistryProvider {
  const workspace = input.kind === "vercel-gateway-workspace";
  const curated = configuredGatewayCatalogModels(settings);
  const upstreamIds = new Set(curated.map((model) => model.upstreamModelId));
  const productIds = new Set(
    parseModelProvidersJson(settings.modelProvidersJson)
      .filter((provider) => provider.id !== WORKSPACE_GATEWAY_PROVIDER_ID)
      .flatMap((provider) =>
        provider.models.flatMap((model) => [model.id, ...(model.aliases ?? [])]),
      ),
  );
  const models = curated.map((model) => {
    productIds.add(workspace ? model.workspaceProductId : model.productId);
    return {
      id: workspace ? model.workspaceProductId : model.productId,
      upstreamModelId: model.upstreamModelId,
      label: model.label,
      ...(model.shortLabel ? { shortLabel: model.shortLabel } : {}),
      capabilities: gatewayModelCapabilities(settings, {
        implicitCaching: model.implicitCaching,
        vision: model.vision,
        inputFileMediaTypes: model.inputFileMediaTypes,
      }),
      contextWindowTokens: model.contextWindowTokens,
      effectiveContextWindowTokens: model.effectiveContextWindowTokens,
      autoCompactTokenLimit: model.autoCompactTokenLimit,
      toolOutputTruncationTokens: settings.modelToolOutputTruncationTokens,
      ...(model.pricing === undefined ? {} : { pricing: model.pricing }),
    };
  });
  if (workspace) {
    for (const custom of input.customModels ?? []) {
      const productId = `${WORKSPACE_GATEWAY_MODEL_ID_PREFIX}${custom.upstreamModelId}`;
      // Deployment membership wins over an older or concurrently-created
      // workspace row with the same upstream identity or generated product id.
      // This keeps runtime routing deterministic and prevents a legacy/admin
      // row from making the entire workspace catalog fail uniqueness checks.
      if (upstreamIds.has(custom.upstreamModelId) || productIds.has(productId)) continue;
      upstreamIds.add(custom.upstreamModelId);
      productIds.add(productId);
      models.push({
        id: productId,
        upstreamModelId: custom.upstreamModelId,
        label: custom.label?.trim() || custom.upstreamModelId,
        capabilities: gatewayModelCapabilities(settings, {
          implicitCaching: false,
          vision: false,
          inputFileMediaTypes: [],
        }),
        contextWindowTokens: 1_000_000,
        effectiveContextWindowTokens: 900_000,
        autoCompactTokenLimit: 850_000,
        toolOutputTruncationTokens: settings.modelToolOutputTruncationTokens,
      });
    }
  }
  return {
    kind: input.kind,
    id: workspace ? WORKSPACE_GATEWAY_PROVIDER_ID : OPENGENI_GATEWAY_PROVIDER_ID,
    label: workspace ? "Your Gateway" : "OpenGeni",
    // Responses preserves vision, reasoning items, and provider-native usage.
    // Model-specific compatibility stays at the reviewed request fence rather
    // than downgrading the whole provider wire.
    api: "responses",
    wireProfile: "openai",
    baseUrl: VERCEL_AI_GATEWAY_BASE_URL,
    ...(input.apiKey ? { apiKey: input.apiKey } : {}),
    models,
  };
}

function openRouterRegistryProvider(settings: Settings): InternalRegistryProvider | null {
  if (!settings.openrouterApiKey) return null;
  const models = configuredOpenRouterCatalogModels(settings).map((model) => ({
    id: `${OPENROUTER_MODEL_ID_PREFIX}${model.upstreamModelId}`,
    upstreamModelId: model.upstreamModelId,
    aliases: model.aliases,
    label: model.label,
    ...(model.shortLabel ? { shortLabel: model.shortLabel } : {}),
    capabilities: model.capabilities,
    ...(model.contextWindowTokens === undefined
      ? {}
      : { contextWindowTokens: model.contextWindowTokens }),
    ...(model.effectiveContextWindowTokens === undefined
      ? {}
      : { effectiveContextWindowTokens: model.effectiveContextWindowTokens }),
    ...(model.autoCompactTokenLimit === undefined
      ? {}
      : { autoCompactTokenLimit: model.autoCompactTokenLimit }),
    toolOutputTruncationTokens:
      model.toolOutputTruncationTokens ?? settings.modelToolOutputTruncationTokens,
  }));
  if (models.length === 0) return null;
  const defaultHeaders: Record<string, string> = {
    "x-title": "OpenGeni",
    ...(settings.publicBaseUrl ? { "http-referer": settings.publicBaseUrl } : {}),
  };
  return {
    kind: "openrouter-managed",
    id: OPENROUTER_PROVIDER_ID,
    label: "OpenRouter",
    api: "chat",
    wireProfile: "openai",
    baseUrl: OPENROUTER_BASE_URL,
    apiKey: settings.openrouterApiKey,
    defaultHeaders,
    publicDefaultHeaderNames: Object.keys(defaultHeaders),
    models,
  };
}

function configuredRegistryProviders(settings: Settings): InternalRegistryProvider[] {
  const providers = parseModelProvidersJson(settings.modelProvidersJson);
  const injected: InternalRegistryProvider[] = [...providers];
  if (settings.vercelAiGatewayApiKey && configuredGatewayCatalogModels(settings).length > 0) {
    injected.push(
      gatewayRegistryProvider(settings, {
        kind: "vercel-gateway-managed",
        apiKey: settings.vercelAiGatewayApiKey,
      }),
    );
  }
  const openrouter = openRouterRegistryProvider(settings);
  if (openrouter) injected.push(openrouter);
  return injected;
}

/** Static catalog overlay; it contains no concrete workspace credential. */
export function withWorkspaceGatewayCatalogProvider(
  settings: Settings,
  customModels: readonly { upstreamModelId: string; label?: string | null }[] = [],
): Settings {
  const providers = parseModelProvidersJson(settings.modelProvidersJson);
  const withoutWorkspace = providers.filter(
    (provider) => provider.id !== WORKSPACE_GATEWAY_PROVIDER_ID,
  );
  const curatedCount = configuredGatewayCatalogModels(settings).length;
  if (curatedCount === 0 && customModels.length === 0) return settings;
  return {
    ...settings,
    modelProvidersJson: JSON.stringify([
      ...withoutWorkspace,
      gatewayRegistryProvider(settings, { kind: "vercel-gateway-workspace", customModels }),
    ]),
  };
}

/** Runtime overlay after the worker resolves the workspace's encrypted key. */
export function withWorkspaceGatewayCredential(
  settings: Settings,
  apiKey: string,
  customModels: readonly { upstreamModelId: string; label?: string | null }[] = [],
): Settings {
  if (!apiKey.trim()) {
    throw new Error("workspace AI Gateway credential is empty");
  }
  const catalogSettings = withWorkspaceGatewayCatalogProvider(settings, customModels);
  const providers = parseModelProvidersJson(catalogSettings.modelProvidersJson).map((provider) =>
    provider.id === WORKSPACE_GATEWAY_PROVIDER_ID ? { ...provider, apiKey } : provider,
  );
  return { ...catalogSettings, modelProvidersJson: JSON.stringify(providers) };
}

/** OpenAI GPT-5.6 Fast mode is 2× Standard list rates (service_tier fast/priority). */
const GPT56_FAST_BILLING_MULTIPLIER_BPS = 20_000;

/**
 * Product display label for catalog/picker UI.
 * Same string for OpenAI and Codex copies of a slug (`gpt-5.6-luna` and
 * `codex/gpt-5.6-luna` → `GPT-5.6 Luna`). Curated Grok slugs receive the same
 * product casing; other ids pass through unchanged.
 */
export function productLabelForModelId(modelId: string): string {
  const slug = modelId.startsWith(CODEX_MODEL_ID_PREFIX)
    ? modelId.slice(CODEX_MODEL_ID_PREFIX.length)
    : modelId;
  const grokMatch = /^grok-(\d+(?:\.\d+)?)$/i.exec(slug);
  if (grokMatch) {
    return `Grok ${grokMatch[1]}`;
  }
  const match = /^(gpt-\d+(?:\.\d+)?)(?:-(.+))?$/i.exec(slug);
  if (!match) {
    return slug;
  }
  const family = match[1]!.replace(/^gpt/i, "GPT");
  const rest = match[2];
  if (!rest) {
    return family;
  }
  const suffix = rest
    .split("-")
    .filter((part) => part.length > 0)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1).toLowerCase())
    .join(" ");
  return suffix.length > 0 ? `${family} ${suffix}` : family;
}

/**
 * Curated compact product labels for dense UI. Unknown model slugs return null
 * so callers fall back to the full `label`.
 */
export function productShortLabelForModelId(modelId: string): string | null {
  const slug = modelId.startsWith(CODEX_MODEL_ID_PREFIX)
    ? modelId.slice(CODEX_MODEL_ID_PREFIX.length)
    : modelId;
  switch (slug) {
    case "grok-4.6":
      return "4.6";
    case "gpt-5.6-sol":
      return "5.6 Sol";
    case "gpt-5.6-terra":
      return "5.6 Terra";
    case "gpt-5.6-luna":
      return "5.6 Luna";
    default:
      return null;
  }
}

const BUILTIN_GPT56_MODEL_IDS = ["gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna"] as const;

function isBuiltinGpt56ModelId(modelId: string): boolean {
  return (BUILTIN_GPT56_MODEL_IDS as readonly string[]).includes(modelId);
}

/** Billed GPT-5.6 uses the same raw/effective/auto-compact catalog as Codex. */
function builtinContextLimitsForModel(
  settings: Settings,
  modelId: string,
): Pick<
  ConfiguredModel,
  "contextWindowTokens" | "effectiveContextWindowTokens" | "autoCompactTokenLimit"
> {
  if (isBuiltinGpt56ModelId(modelId)) {
    return {
      contextWindowTokens: CODEX_MODEL_CONTEXT_WINDOW_TOKENS,
      effectiveContextWindowTokens: CODEX_MODEL_EFFECTIVE_CONTEXT_WINDOW_TOKENS,
      autoCompactTokenLimit: CODEX_MODEL_AUTO_COMPACT_TOKEN_LIMIT,
    };
  }
  return { contextWindowTokens: settings.contextWindowTokens };
}

function builtinLatencyModesForModel(modelId: string): Array<{
  id: z.infer<typeof ModelLatencyModeV1>;
  upstream: "supported" | "unsupported" | "unknown";
  runnable: boolean;
  billingMultiplierBps?: number;
}> {
  if (isBuiltinGpt56ModelId(modelId) || modelId.startsWith("codex/gpt-5.6-")) {
    return [
      { id: "standard", upstream: "supported", runnable: true },
      {
        id: "fast",
        upstream: "supported",
        runnable: true,
        billingMultiplierBps: GPT56_FAST_BILLING_MULTIPLIER_BPS,
      },
    ];
  }
  return [{ id: "standard", upstream: "unknown", runnable: true }];
}

function builtinPromptCachingForModel(
  modelId: string,
): NonNullable<ModelCapabilitiesV1["promptCaching"]> | undefined {
  const slug = modelId.startsWith(CODEX_MODEL_ID_PREFIX)
    ? modelId.slice(CODEX_MODEL_ID_PREFIX.length)
    : modelId;
  return slug.startsWith("gpt-5.6-")
    ? { upstream: "supported", runnable: true, mode: "implicit" }
    : undefined;
}

/** Reviewed direct-OpenAI text models that accept the hosted image tool. */
function builtinHostedImageGenerationForModel(settings: Settings, modelId: string): boolean {
  return (
    settings.openaiProvider === "openai" &&
    isDirectOpenAiApiBaseUrl(settings.openaiBaseUrl) &&
    isBuiltinGpt56ModelId(modelId)
  );
}

/** Undefined and the exact public OpenAI v1 endpoint are the same direct route. */
export function isDirectOpenAiApiBaseUrl(baseUrl: string | undefined): boolean {
  if (baseUrl === undefined) return true;
  try {
    const parsed = new URL(baseUrl);
    return (
      parsed.protocol === "https:" &&
      parsed.hostname === "api.openai.com" &&
      parsed.port === "" &&
      parsed.username === "" &&
      parsed.password === "" &&
      parsed.search === "" &&
      parsed.hash === "" &&
      parsed.pathname.replace(/\/+$/, "") === "/v1"
    );
  } catch {
    return false;
  }
}

/**
 * Map OpenGeni latency mode to the provider `service_tier` wire value.
 * Azure, Codex ChatGPT, and xAI accept `priority`; OpenAI API accepts `fast`.
 * Standard omits the field.
 */
export function serviceTierForLatencyMode(
  providerId: string,
  latencyMode: LatencyMode,
): "fast" | "priority" | undefined {
  if (latencyMode === "standard") {
    return undefined;
  }
  if (
    providerId === "azure" ||
    providerId === CODEX_PROVIDER_ID ||
    providerId === XAI_SUBSCRIPTION_PROVIDER_ID
  ) {
    return "priority";
  }
  return "fast";
}

/** True when the response tier fulfills a non-standard Fast/priority request. */
export function responseSatisfiesLatencyMode(
  requested: LatencyMode,
  responseServiceTier: string | null | undefined,
): boolean {
  if (requested === "standard") {
    return true;
  }
  return responseServiceTier === "priority" || responseServiceTier === "fast";
}

export function runnableLatencyModesForModel(settings: Settings, modelId: string): LatencyMode[] {
  const resolved = resolveModelProvider(
    settingsForTurnExecutionPolicy(settings, modelId),
    canonicalizeConfiguredModelId(settings, modelId),
  );
  if (!resolved) {
    return ["standard"];
  }
  return resolved.model.capabilities.latencyModes
    .filter((mode) => mode.runnable)
    .map((mode) => LatencyMode.parse(mode.id));
}

function assertLatencyModeRunnable(
  settings: Settings,
  modelId: string,
  latencyMode: LatencyMode,
): void {
  const runnable = runnableLatencyModesForModel(settings, modelId);
  if (!runnable.includes(latencyMode)) {
    throw new Error(
      `latency mode ${latencyMode} is not runnable for model ${modelId} (allowed: ${runnable.join(", ")})`,
    );
  }
}

function registryCredentialSource(provider: InternalRegistryProvider): CredentialSourceV1 {
  switch (provider.kind) {
    case "anonymous":
      return { kind: "deployment", mechanism: "none" };
    case "codex-subscription":
      return { kind: "connected_subscription", provider: "codex" };
    case "xai-subscription":
      return { kind: "connected_subscription", provider: "xai" };
    case "vercel-gateway-workspace":
      return { kind: "workspace_connection", mechanism: "api_key" };
    case "api-key":
    case "vercel-gateway-managed":
    case "openrouter-managed":
      return { kind: "deployment", mechanism: "api_key" };
    default: {
      const _exhaustive: never = provider.kind;
      return _exhaustive;
    }
  }
}

function registryBilling(provider: InternalRegistryProvider): BillingAttributionV1 {
  switch (provider.kind) {
    case "anonymous":
    case "openrouter-managed":
      return { upstreamPayer: "deployment", metering: "external" };
    case "codex-subscription":
    case "xai-subscription":
      return { upstreamPayer: "connected_subscription", metering: "external" };
    case "vercel-gateway-workspace":
      return { upstreamPayer: "workspace", metering: "external" };
    case "api-key":
    case "vercel-gateway-managed":
      return { upstreamPayer: "deployment", metering: "opengeni_credits" };
    default: {
      const _exhaustive: never = provider.kind;
      return _exhaustive;
    }
  }
}

function configuredCostForModel(
  settings: Settings,
  productModelId: string,
  credentialSource: CredentialSourceV1,
): ConfiguredModelCostClass {
  if (credentialSource.kind === "workspace_connection") return "workspace";
  if (credentialSource.kind === "connected_subscription") return "subscription";
  return parseModelCostPolicyJson(settings.modelCostPolicyJson)[productModelId] ?? "credits";
}

export function modelCostClassForConfiguredModel(
  _settings: Settings,
  model: Pick<ConfiguredModel, "cost">,
): ConfiguredModelCostClass {
  return model.cost;
}

function builtinCredentialSource(settings: Settings): CredentialSourceV1 {
  if (settings.openaiProvider === "azure" && !settings.azureOpenaiApiKey) {
    return { kind: "deployment", mechanism: "azure_ad_bearer" };
  }
  return { kind: "deployment", mechanism: "api_key" };
}

function staticRequestMetadataForDigest(provider: ResolvedModelProvider): {
  headers: Array<{
    name: string;
    classification: "public" | "secret";
    value?: string;
  }>;
  query: Array<{
    name: string;
    classification: "public" | "secret";
    value?: string;
  }>;
} {
  const publicHeaders = new Set(provider.publicDefaultHeaderNames ?? []);
  const publicQuery = new Set(provider.publicDefaultQueryNames ?? []);
  return {
    headers: Object.entries(provider.defaultHeaders ?? {})
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([name, value]) =>
        publicHeaders.has(name)
          ? { name, classification: "public" as const, value }
          : { name, classification: "secret" as const },
      ),
    query: Object.entries(provider.defaultQuery ?? {})
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([name, value]) =>
        publicQuery.has(name)
          ? { name, classification: "public" as const, value }
          : { name, classification: "secret" as const },
      ),
  };
}

function canonicalJson(value: unknown): string {
  const normalize = (input: unknown): unknown => {
    if (Array.isArray(input)) {
      return input.map((entry) => normalize(entry));
    }
    if (input && typeof input === "object") {
      const out: Record<string, unknown> = {};
      for (const key of Object.keys(input).sort()) {
        const child = (input as Record<string, unknown>)[key];
        if (child !== undefined) {
          out[key] = normalize(child);
        }
      }
      return out;
    }
    return input;
  };
  return JSON.stringify(normalize(value));
}

function definitionVersionFor(
  model: Omit<ConfiguredModel, "definitionVersion">,
  provider: ResolvedModelProvider,
  options: { includeWireProfile?: boolean } = {},
): string {
  const requestMetadata = staticRequestMetadataForDigest(provider);
  const includeWireProfile = options.includeWireProfile ?? true;
  const digestInput = canonicalJson({
    schemaVersion: model.schemaVersion,
    id: model.id,
    providerId: model.providerId,
    deployment: model.deployment,
    provider: {
      adapterKind: provider.kind,
      wireApi: provider.api,
      ...(includeWireProfile ? { wireProfile: provider.wireProfile } : {}),
      baseUrl: provider.baseUrl ?? null,
      defaultHeaders: requestMetadata.headers,
      defaultQuery: requestMetadata.query,
    },
    credentialSource: model.credentialSource,
    billing: model.billing,
    executionLimits: model.executionLimits,
    capabilities: model.capabilities,
    // Workspace-facing free/credits classification is a separate live
    // deployment policy. Operators must drain/fence accepted turns before
    // changing it; it is intentionally not a second executable-definition
    // freeze inside TurnExecutionPolicyV1.
    ...(model.requestPolicy ? { requestPolicy: model.requestPolicy } : {}),
    pricing: model.pricing ?? null,
  });
  return `sha256:${createHash("sha256")
    .update("opengeni:model-definition:v1\n", "utf8")
    .update(digestInput, "utf8")
    .digest("hex")}`;
}

function legacyImplicitOpenAiDefinitionVersionFor(
  model: ConfiguredModel,
  provider: ResolvedModelProvider,
): string | null {
  if (provider.wireProfile !== "openai") return null;
  const { definitionVersion: _definitionVersion, ...modelWithoutVersion } = model;
  return definitionVersionFor(modelWithoutVersion, provider, { includeWireProfile: false });
}

/**
 * The built-in provider's stable id: "openai" on the OpenAI platform, "azure"
 * on Azure. Exported because the workspace model-policy gate must attribute
 * the legacy resolveTurnModel-null fallback (which routes to this built-in
 * client) to the SAME identity the router uses — otherwise a policy blocking
 * the built-in could be bypassed through the null-resolution path.
 */
export function builtinProviderId(settings: Pick<Settings, "openaiProvider">): string {
  return settings.openaiProvider === "azure" ? "azure" : "openai";
}

function builtinProviderLabel(settings: Pick<Settings, "openaiProvider">): string {
  return settings.openaiProvider === "azure" ? "Azure OpenAI" : "OpenAI";
}

/**
 * Every provider a client may route to: the built-in OpenAI/Azure provider
 * first (id "openai"/"azure", always "responses"), then each registry provider
 * in declaration order. Client-construction inputs are filled from
 * the existing flat openai/azure settings for the built-in, and from the
 * registry entry for the rest. Registry ids may not collide with the built-in
 * id — validateSettings rejects that at boot.
 */
export function configuredProviders(
  settings: Settings,
  source: NodeJS.ProcessEnv = process.env,
): ResolvedModelProvider[] {
  const credentialSource = builtinCredentialSource(settings);
  const builtin: ResolvedModelProvider = {
    id: builtinProviderId(settings),
    label: builtinProviderLabel(settings),
    kind: "api-key",
    api: "responses",
    wireProfile: settings.openaiProvider === "azure" ? "azure-openai" : "openai",
    builtin: true,
    credentialSource,
    billing: { upstreamPayer: "deployment", metering: "opengeni_credits" },
  };
  if (settings.openaiProvider === "azure") {
    const baseUrl = settings.azureOpenaiBaseUrl ?? settings.azureOpenaiEndpoint;
    builtin.baseUrl = baseUrl ? normalizeRegistryBaseUrl(baseUrl, builtin.id) : undefined;
    builtin.apiKey = settings.azureOpenaiApiKey ?? settings.azureOpenaiAdToken;
  } else {
    builtin.baseUrl = settings.openaiBaseUrl
      ? normalizeRegistryBaseUrl(settings.openaiBaseUrl, builtin.id)
      : undefined;
    builtin.apiKey = settings.openaiApiKey;
  }
  const registry = configuredRegistryProviders(settings).map(
    (provider): ResolvedModelProvider => ({
      id: provider.id,
      label: provider.label ?? provider.id,
      kind: provider.kind,
      api: provider.api,
      wireProfile: provider.wireProfile,
      builtin: false,
      baseUrl: provider.baseUrl,
      apiKey: resolveProviderApiKey(provider, source),
      defaultQuery: provider.defaultQuery,
      defaultHeaders: provider.defaultHeaders,
      publicDefaultQueryNames: provider.publicDefaultQueryNames,
      publicDefaultHeaderNames: provider.publicDefaultHeaderNames,
      credentialSource: registryCredentialSource(provider),
      billing: registryBilling(provider),
    }),
  );
  return [builtin, ...registry];
}

/**
 * Pure catalog overlay for a workspace whose existing Codex connection seam
 * reports ready. This describes product/provider identity only; it does not
 * select, lease, refresh, or expose a concrete credential; those runtime
 * operations remain owned by the credential allocator.
 */
export function withCodexCatalogProvider(settings: Settings): Settings {
  const providers = parseModelProvidersJson(settings.modelProvidersJson);
  if (providers.some((provider) => provider.id === CODEX_PROVIDER_ID)) {
    return settings;
  }
  const provider: RegistryProvider = {
    kind: "codex-subscription",
    id: CODEX_PROVIDER_ID,
    label: "Codex (ChatGPT subscription)",
    api: "responses",
    wireProfile: "openai",
    baseUrl: CODEX_PROVIDER_BASE_URL,
    models: CODEX_FALLBACK_MODEL_SLUGS.map((slug) => {
      const capabilities = {
        ...legacyModelCapabilities(settings, {
          reasoningEffort: true,
          hostedWebSearch: true,
          vision: slug.startsWith("gpt-5.6-"),
        }),
        ...(builtinPromptCachingForModel(`${CODEX_MODEL_ID_PREFIX}${slug}`)
          ? {
              promptCaching: builtinPromptCachingForModel(`${CODEX_MODEL_ID_PREFIX}${slug}`)!,
            }
          : {}),
        latencyModes: builtinLatencyModesForModel(`${CODEX_MODEL_ID_PREFIX}${slug}`),
      };
      return {
        id: `${CODEX_MODEL_ID_PREFIX}${slug}`,
        upstreamModelId: slug,
        label: productLabelForModelId(slug),
        ...(productShortLabelForModelId(slug)
          ? { shortLabel: productShortLabelForModelId(slug)! }
          : {}),
        reasoningEffort: true,
        // The ChatGPT/Codex Responses backend accepts the native web_search
        // hosted tool (unlike hosted apply_patch/computer transports). Declaring
        // this here makes provider resolution truthful; the worker still applies
        // the durable session/turn policy gate before attaching it.
        hostedWebSearch: true,
        capabilities,
        contextWindowTokens: CODEX_MODEL_CONTEXT_WINDOW_TOKENS,
        effectiveContextWindowTokens: CODEX_MODEL_EFFECTIVE_CONTEXT_WINDOW_TOKENS,
        autoCompactTokenLimit: CODEX_MODEL_AUTO_COMPACT_TOKEN_LIMIT,
        toolOutputTruncationTokens: CODEX_MODEL_TOOL_OUTPUT_TRUNCATION_TOKENS,
      };
    }),
  };
  return {
    ...settings,
    modelProvidersJson: JSON.stringify([...providers, provider]),
  };
}

/**
 * Static SuperGrok product catalogue, matching the Codex subscription seam.
 * The overlay never contains a concrete account id or bearer; selection and
 * per-turn credential freeze remain worker/DB responsibilities.
 */
export function withXaiSubscriptionCatalogProvider(settings: Settings): Settings {
  const providers = parseModelProvidersJson(settings.modelProvidersJson);
  if (providers.some((provider) => provider.id === XAI_SUBSCRIPTION_PROVIDER_ID)) {
    return settings;
  }
  const provider: RegistryProvider = {
    kind: "xai-subscription",
    id: XAI_SUBSCRIPTION_PROVIDER_ID,
    label: "SuperGrok (xAI subscription)",
    api: "responses",
    wireProfile: "openai",
    baseUrl: XAI_SUBSCRIPTION_PROXY_BASE_URL,
    models: XAI_SUBSCRIPTION_MODEL_SLUGS.map((slug) => {
      const capabilities = legacyModelCapabilities(settings, {
        reasoningEffort: true,
        hostedWebSearch: true,
        vision: true,
      });
      capabilities.reasoning.efforts = ["low", "medium", "high", "xhigh"];
      capabilities.reasoning.defaultEffort = "high";
      capabilities.latencyModes = [
        { id: "standard", upstream: "supported", runnable: true },
        { id: "fast", upstream: "supported", runnable: true },
      ];
      capabilities.hostedTools.xSearch = { upstream: "supported", runnable: true };
      capabilities.hostedTools.imageGeneration = { upstream: "supported", runnable: true };
      return {
        id: `${XAI_SUBSCRIPTION_MODEL_ID_PREFIX}${slug}`,
        upstreamModelId: slug,
        label: productLabelForModelId(slug),
        ...(productShortLabelForModelId(slug)
          ? { shortLabel: productShortLabelForModelId(slug)! }
          : {}),
        reasoningEffort: true,
        hostedWebSearch: true,
        capabilities,
        contextWindowTokens: XAI_SUBSCRIPTION_MODEL_CONTEXT_WINDOW_TOKENS,
        effectiveContextWindowTokens: XAI_SUBSCRIPTION_MODEL_EFFECTIVE_CONTEXT_WINDOW_TOKENS,
        autoCompactTokenLimit: XAI_SUBSCRIPTION_MODEL_AUTO_COMPACT_TOKEN_LIMIT,
        toolOutputTruncationTokens: settings.modelToolOutputTruncationTokens,
      };
    }),
  };
  return { ...settings, modelProvidersJson: JSON.stringify([...providers, provider]) };
}

/**
 * The provider identity a model id resolves to, for workspace model-policy
 * evaluation — MUST agree with the real router (resolveTurnModel /
 * MultiProviderModelProvider) on every case:
 *   - `codex/<slug>` → the codex-subscription provider id, ALWAYS. With no
 *     active subscription the router fails loud (CodexSubscriptionUnavailableError),
 *     never the built-in — so attributing by prefix is exact even against BASE
 *     settings where the overlay provider is not injected.
 *   - a configured model id → its configuredModels providerId (registry or built-in).
 *   - anything else → the built-in id: an unknown id is the legacy
 *     resolveTurnModel-null fallback, which the built-in OpenAI/Azure client
 *     serves. A policy blocking the built-in must block this path too.
 */
export function policyProviderIdForModel(settings: Settings, modelId: string): string {
  const canonicalModelId = canonicalizeConfiguredModelId(settings, modelId);
  if (canonicalModelId.startsWith(CODEX_MODEL_ID_PREFIX)) {
    return CODEX_PROVIDER_ID;
  }
  if (canonicalModelId.startsWith(XAI_SUBSCRIPTION_MODEL_ID_PREFIX)) {
    return XAI_SUBSCRIPTION_PROVIDER_ID;
  }
  if (canonicalModelId.startsWith(WORKSPACE_GATEWAY_MODEL_ID_PREFIX)) {
    return WORKSPACE_GATEWAY_PROVIDER_ID;
  }
  const configured = configuredModels(settings).find((model) => model.id === canonicalModelId);
  return configured?.providerId ?? builtinProviderId(settings);
}

function resolvedExecutionLimits(
  settings: Settings,
  model: {
    contextWindowTokens?: number | undefined;
    effectiveContextWindowTokens?: number | undefined;
    autoCompactTokenLimit?: number | undefined;
    toolOutputTruncationTokens?: number | undefined;
  },
): ModelExecutionLimitsV1 {
  return {
    contextWindowTokens: model.contextWindowTokens ?? settings.contextWindowTokens,
    effectiveContextWindowTokens:
      model.effectiveContextWindowTokens ?? settings.contextEffectiveWindowTokens ?? null,
    autoCompactTokenLimit:
      model.autoCompactTokenLimit ?? settings.contextAutoCompactThresholdTokens ?? null,
    toolOutputTruncationTokens:
      model.toolOutputTruncationTokens ?? settings.modelToolOutputTruncationTokens ?? null,
  };
}

function finalizeConfiguredModel(
  settings: Settings,
  provider: ResolvedModelProvider,
  input: Omit<ConfiguredModel, "schemaVersion" | "definitionVersion" | "executionLimits" | "cost">,
): ConfiguredModel {
  const requestPolicy =
    provider.kind === "vercel-gateway-managed" || provider.kind === "vercel-gateway-workspace"
      ? gatewayRequestPolicyForUpstreamModel(
          input.upstreamModelId,
          configuredGatewayCatalogModels(settings),
        )
      : undefined;
  const modelWithoutVersion: Omit<ConfiguredModel, "definitionVersion"> = {
    schemaVersion: 1,
    ...input,
    cost: configuredCostForModel(settings, input.id, input.credentialSource),
    ...(requestPolicy ? { requestPolicy } : {}),
    executionLimits: resolvedExecutionLimits(settings, input),
  };
  return {
    ...modelWithoutVersion,
    definitionVersion: definitionVersionFor(modelWithoutVersion, provider),
  };
}

function assertUniqueModelIdentities(models: ConfiguredModel[]): void {
  const canonicalOwners = new Map<string, string>();
  for (const model of models) {
    const previous = canonicalOwners.get(model.id);
    if (previous !== undefined) {
      throw new Error(
        `OPENGENI_MODEL_PROVIDERS_JSON model id ${JSON.stringify(model.id)} is declared by both ${previous} and ${model.providerId}`,
      );
    }
    canonicalOwners.set(model.id, model.providerId);
  }

  const acceptedInputs = new Map(canonicalOwners);
  for (const model of models) {
    const ownAliases = new Set<string>();
    for (const alias of model.aliases) {
      if (ownAliases.has(alias)) {
        throw new Error(
          `OPENGENI_MODEL_PROVIDERS_JSON model ${JSON.stringify(model.id)} contains duplicate alias ${JSON.stringify(alias)}`,
        );
      }
      ownAliases.add(alias);
      const previous = acceptedInputs.get(alias);
      if (previous !== undefined) {
        throw new Error(
          `OPENGENI_MODEL_PROVIDERS_JSON alias ${JSON.stringify(alias)} for model ${JSON.stringify(model.id)} collides with model/provider ${previous}`,
        );
      }
      acceptedInputs.set(alias, model.id);
    }
  }
}

/**
 * Every model a client may use, the built-in provider's models first
 * (configuredAllowedModels-from-openai, mapped to "responses" with
 * hostedWebSearch/contextWindow/reasoningEffort from the flat settings), then
 * each registry provider's models (label→id, hostedWebSearch/reasoningEffort
 * default false). De-duplicated by id (first wins) so the default model stays
 * first and the built-in allow-list takes precedence over registry entries.
 */
export function configuredModels(
  settings: Settings,
  source: NodeJS.ProcessEnv = process.env,
): ConfiguredModel[] {
  const builtinId = builtinProviderId(settings);
  const builtinLabel = builtinProviderLabel(settings);
  const providers = configuredProviders(settings, source);
  const providerById = new Map(providers.map((provider) => [provider.id, provider]));
  const pricingSchedules = configuredModelPricingSchedules(settings);
  // The built-in (OpenAI/Azure) provider must NEVER claim a registry-namespaced
  // model id. The worker overwrites settings.openaiModel with the turn's model
  // (apps/worker agent-turn runSettings) — including a `codex/<slug>` id, or a
  // registry id like "accounts/fireworks/models/glm-5p2" — so without this
  // filter the built-in allow-list would emit a `{ id, providerId: <azure> }`
  // entry that, by the first-wins de-dup below, shadows the real registry /
  // codex-subscription provider and ships the id to Azure as a deployment name
  // (opaque DeploymentNotFound 404). A `<provider>/<model>`-namespaced id (it
  // contains "/") that a registry actually owns is never a valid Azure/OpenAI
  // deployment name, and a `codex/`-prefixed id never is either — exclude both
  // from the built-in list. A BARE id a registry merely redeclares (e.g.
  // "gpt-5.6-sol") is left in place so the built-in still wins it via the first-wins
  // de-dup below (preserving the documented built-in-precedence contract). When
  // a codex/ id has NO codex provider injected (no active subscription) it then
  // resolves to nothing and getModel fails loud with
  // CodexSubscriptionUnavailableError instead of mis-routing to Azure.
  const parsedRegistry = configuredRegistryProviders(settings);
  const registryOwnedIds = new Set(
    parsedRegistry.flatMap((provider) => provider.models.map((model) => model.id)),
  );
  const registryAliases = new Set(
    parsedRegistry.flatMap((provider) => provider.models.flatMap((model) => model.aliases ?? [])),
  );
  const isRegistryNamespaced = (id: string): boolean =>
    id.startsWith(CODEX_MODEL_ID_PREFIX) ||
    id.startsWith(XAI_SUBSCRIPTION_MODEL_ID_PREFIX) ||
    registryAliases.has(id) ||
    (id.includes("/") && registryOwnedIds.has(id));
  const builtinProvider = providerById.get(builtinId);
  if (!builtinProvider) {
    throw new Error(`Built-in model provider ${builtinId} is not configured`);
  }
  const out: ConfiguredModel[] = uniqueValues([
    settings.openaiModel,
    ...splitCsv(settings.openaiAllowedModels),
  ])
    .filter((id) => !isRegistryNamespaced(id))
    .map((id) => {
      const capabilities = {
        ...legacyModelCapabilities(settings, {
          reasoningEffort: true,
          hostedWebSearch: settings.webSearchEnabled,
          hostedImageGeneration: builtinHostedImageGenerationForModel(settings, id),
          vision: id.startsWith("gpt-5.6-"),
        }),
        ...(builtinPromptCachingForModel(id)
          ? { promptCaching: builtinPromptCachingForModel(id)! }
          : {}),
        latencyModes: builtinLatencyModesForModel(id),
      };
      return finalizeConfiguredModel(settings, builtinProvider, {
        id,
        aliases: [],
        label: productLabelForModelId(id),
        ...(productShortLabelForModelId(id)
          ? { shortLabel: productShortLabelForModelId(id)! }
          : {}),
        providerId: builtinId,
        providerLabel: builtinLabel,
        api: "responses" as const,
        upstreamModelId: id,
        deployment: { upstreamModelId: id, wireApi: "responses" },
        credentialSource: builtinProvider.credentialSource,
        billing: builtinProvider.billing,
        capabilities,
        ...(pricingSchedules[id] === undefined ? {} : { pricing: pricingSchedules[id] }),
        ...builtinContextLimitsForModel(settings, id),
        toolOutputTruncationTokens: settings.modelToolOutputTruncationTokens,
        reasoningEffort: capabilities.reasoning.runnable,
        hostedWebSearch: capabilities.hostedTools.webSearch.runnable,
      });
    });
  for (const provider of parsedRegistry) {
    const providerLabel = provider.label ?? provider.id;
    const resolvedProvider = providerById.get(provider.id);
    if (!resolvedProvider) {
      throw new Error(`Registry model provider ${provider.id} is not configured`);
    }
    for (const model of provider.models) {
      const capabilities = model.capabilities
        ? normalizeCapabilities(model.capabilities)
        : legacyModelCapabilities(settings, {
            reasoningEffort: model.reasoningEffort ?? false,
            hostedWebSearch: model.hostedWebSearch ?? false,
          });
      const upstreamModelId = model.upstreamModelId ?? model.id;
      out.push(
        finalizeConfiguredModel(settings, resolvedProvider, {
          id: model.id,
          aliases: [...(model.aliases ?? [])],
          label: model.label ?? productLabelForModelId(model.id),
          ...(model.shortLabel
            ? { shortLabel: model.shortLabel }
            : productShortLabelForModelId(model.id)
              ? { shortLabel: productShortLabelForModelId(model.id)! }
              : {}),
          providerId: provider.id,
          providerLabel,
          api: provider.api,
          upstreamModelId,
          deployment: { upstreamModelId, wireApi: provider.api },
          credentialSource: resolvedProvider.credentialSource,
          billing: resolvedProvider.billing,
          capabilities,
          ...(pricingSchedules[model.id] === undefined
            ? {}
            : { pricing: pricingSchedules[model.id] }),
          ...(model.contextWindowTokens === undefined
            ? {}
            : { contextWindowTokens: model.contextWindowTokens }),
          ...(model.effectiveContextWindowTokens === undefined
            ? {}
            : {
                effectiveContextWindowTokens: model.effectiveContextWindowTokens,
              }),
          ...(model.autoCompactTokenLimit === undefined
            ? {}
            : { autoCompactTokenLimit: model.autoCompactTokenLimit }),
          ...(model.toolOutputTruncationTokens === undefined
            ? {}
            : { toolOutputTruncationTokens: model.toolOutputTruncationTokens }),
          reasoningEffort: capabilities.reasoning.runnable,
          hostedWebSearch: capabilities.hostedTools.webSearch.runnable,
        }),
      );
    }
  }
  assertUniqueModelIdentities(out);
  const defaultIndex = out.findIndex(
    (model) => model.id === settings.openaiModel || model.aliases.includes(settings.openaiModel),
  );
  return defaultIndex > 0
    ? [out[defaultIndex]!, ...out.slice(0, defaultIndex), ...out.slice(defaultIndex + 1)]
    : out;
}

/** Resolve a known canonical id or alias. Unknown strings are returned unchanged. */
export function canonicalizeConfiguredModelId(settings: Settings, modelId: string): string {
  const models = configuredModels(settings);
  const canonical = models.find((model) => model.id === modelId);
  if (canonical) {
    return canonical.id;
  }
  return models.find((model) => model.aliases.includes(modelId))?.id ?? modelId;
}

/**
 * Allowed model ids in selection order. Reimplemented on top of
 * configuredModels so it is the union of the built-in allow-list and every
 * registry provider's ids, de-duplicated. INVARIANT (existing callers + tests
 * depend on it): settings.openaiModel is always first, then the rest of the
 * openai allow-list, then registry ids.
 */
export function configuredAllowedModels(settings: Settings): string[] {
  return configuredModels(settings).map((model) => model.id);
}

/**
 * Resolve a model string to the provider that serves it and its configured
 * shape. Returns undefined when the id is not exposed (built-in allow-list nor
 * any registry provider), so the runtime can fall back to the legacy global
 * client path.
 */
export function resolveModelProvider(
  settings: Settings,
  modelId: string,
): { provider: ResolvedModelProvider; model: ConfiguredModel } | undefined {
  const canonicalModelId = canonicalizeConfiguredModelId(settings, modelId);
  const model = configuredModels(settings).find((candidate) => candidate.id === canonicalModelId);
  if (!model) {
    return undefined;
  }
  const provider = configuredProviders(settings).find(
    (candidate) => candidate.id === model.providerId,
  );
  if (!provider) {
    return undefined;
  }
  return { provider, model };
}

export type ResolveTurnExecutionPolicyV1Input = {
  /** Effective persisted turn model. Aliases are accepted and canonicalized. */
  modelId: string;
  /** Exact caller-supplied input before canonicalization, only for explicit switches. */
  requestedModelId: string | null;
  modelSource: TurnExecutionModelSourceV1;
  reasoningEffort: Settings["openaiReasoningEffort"];
  reasoningSource: TurnExecutionReasoningSourceV1;
  latencyMode?: LatencyMode;
  latencyModeSource?: TurnExecutionLatencyModeSourceV1;
};

function settingsForTurnExecutionPolicy(settings: Settings, modelId: string): Settings {
  if (settings.codexSubscriptionEnabled && modelId.startsWith(CODEX_MODEL_ID_PREFIX)) {
    return withCodexCatalogProvider(settings);
  }
  if (
    settings.supergrokSubscriptionEnabled &&
    modelId.startsWith(XAI_SUBSCRIPTION_MODEL_ID_PREFIX)
  ) {
    return withXaiSubscriptionCatalogProvider(settings);
  }
  if (modelId.startsWith(WORKSPACE_GATEWAY_MODEL_ID_PREFIX)) {
    // API/worker workspace boundaries may already have overlaid durable custom
    // rows and, at execution time, the decrypted workspace key. Re-applying an
    // empty static overlay would silently discard both. Only synthesize the
    // curated fallback when this exact model is not already executable.
    if (resolveModelProvider(settings, modelId)) {
      return settings;
    }
    return withWorkspaceGatewayCatalogProvider(settings);
  }
  return settings;
}

/**
 * Resolve the static catalog identity used by an accepted turn. Subscription
 * overlays contain no account or bearer and do not prove connection readiness;
 * callers must keep their live credential/readiness gate authoritative.
 */
export function resolveModelProviderForTurn(
  settings: Settings,
  modelId: string,
): ReturnType<typeof resolveModelProvider> {
  const catalogSettings = settingsForTurnExecutionPolicy(settings, modelId);
  return resolveModelProvider(
    catalogSettings,
    canonicalizeConfiguredModelId(catalogSettings, modelId),
  );
}

/**
 * Build a trusted, secret-safe execution policy from the normalized catalog.
 * The Codex overlay here contains static product/provider identity only; it
 * neither proves readiness nor chooses, decrypts, leases, or exposes an account.
 */
export function resolveTurnExecutionPolicyV1(
  settings: Settings,
  input: ResolveTurnExecutionPolicyV1Input,
): TurnExecutionPolicyV1 {
  const catalogSettings = settingsForTurnExecutionPolicy(settings, input.modelId);
  const productModelId = canonicalizeConfiguredModelId(catalogSettings, input.modelId);
  const resolved = resolveModelProvider(catalogSettings, productModelId);
  if (!resolved) {
    throw new Error("Turn execution policy model is not present in the configured catalog");
  }
  if (
    input.requestedModelId !== null &&
    canonicalizeConfiguredModelId(catalogSettings, input.requestedModelId) !== productModelId
  ) {
    throw new Error("Turn execution policy requested model does not canonicalize to its product");
  }
  const latencyMode = LatencyMode.parse(input.latencyMode ?? "standard");
  const latencyModeSource = input.latencyModeSource ?? "deployment";
  assertLatencyModeRunnable(catalogSettings, productModelId, latencyMode);
  return TurnExecutionPolicyV1.parse({
    schemaVersion: 1,
    productModelId,
    requestedModelId: input.requestedModelId,
    modelSource: input.modelSource,
    reasoningEffort: input.reasoningEffort,
    reasoningSource: input.reasoningSource,
    latencyMode,
    latencyModeSource,
    providerId: resolved.provider.id,
    upstreamModelId: resolved.model.upstreamModelId,
    wireApi: resolved.model.api,
    credentialSource: resolved.model.credentialSource,
    billing: resolved.model.billing,
    definitionVersion: resolved.model.definitionVersion,
  });
}

/**
 * Parse-time validation lives in @opengeni/contracts; this verifier binds a
 * present snapshot to the current executable definition and exact turn row.
 * Any deployment/provider drift fails before a provider or compaction call.
 */
export function assertTurnExecutionPolicyMatchesConfigV1(
  settings: Settings,
  policy: TurnExecutionPolicyV1,
  expected: {
    modelId: string;
    reasoningEffort: Settings["openaiReasoningEffort"];
    latencyMode?: LatencyMode;
  },
): {
  policy: TurnExecutionPolicyV1;
  provider: ResolvedModelProvider;
  model: ConfiguredModel;
} {
  const parsed = TurnExecutionPolicyV1.parse(policy);
  const catalogSettings = settingsForTurnExecutionPolicy(settings, parsed.productModelId);
  const canonicalExpectedModel = canonicalizeConfiguredModelId(catalogSettings, expected.modelId);
  const expectedLatencyMode = expected.latencyMode ?? parsed.latencyMode;
  if (
    parsed.productModelId !== canonicalExpectedModel ||
    parsed.reasoningEffort !== expected.reasoningEffort ||
    parsed.latencyMode !== expectedLatencyMode
  ) {
    throw new Error(
      "Turn execution policy does not match the accepted turn model/reasoning/latency",
    );
  }
  assertLatencyModeRunnable(catalogSettings, parsed.productModelId, parsed.latencyMode);
  if (
    parsed.requestedModelId !== null &&
    canonicalizeConfiguredModelId(catalogSettings, parsed.requestedModelId) !==
      parsed.productModelId
  ) {
    throw new Error("Turn execution policy requested model does not match its product model");
  }
  const resolved = resolveModelProvider(catalogSettings, parsed.productModelId);
  if (!resolved) {
    throw new Error("Turn execution policy model is no longer configured");
  }
  // wireProfile was added to the definition digest after policies already
  // existed in durable in-flight turns. An omitted profile meant exactly
  // "openai", so accept that one legacy digest only; Azure and every other
  // executable-definition change remain fail-closed.
  const legacyImplicitOpenAiDefinitionVersion = legacyImplicitOpenAiDefinitionVersionFor(
    resolved.model,
    resolved.provider,
  );
  const definitionVersionMatches =
    parsed.definitionVersion === resolved.model.definitionVersion ||
    parsed.definitionVersion === legacyImplicitOpenAiDefinitionVersion;
  const mismatched =
    parsed.providerId !== resolved.provider.id ||
    parsed.upstreamModelId !== resolved.model.upstreamModelId ||
    parsed.wireApi !== resolved.model.api ||
    !definitionVersionMatches ||
    canonicalJson(parsed.credentialSource) !== canonicalJson(resolved.model.credentialSource) ||
    canonicalJson(parsed.billing) !== canonicalJson(resolved.model.billing);
  if (mismatched) {
    throw new Error("Turn execution policy does not match the current provider definition");
  }
  return { policy: parsed, provider: resolved.provider, model: resolved.model };
}

/**
 * Effective per-model pricing schedules. Merge order (later wins): built-in
 * flat defaults → registry model flat/scheduled pricing → explicit legacy flat
 * OPENGENI_MODEL_PRICING_JSON. The explicit legacy map intentionally replaces
 * a registry schedule with one flat default so its historical precedence stays
 * exact.
 */
export function configuredModelPricingSchedules(
  settings: Settings,
): Record<string, ModelPricingScheduleV1> {
  const defaults = Object.fromEntries(
    Object.entries(defaultModelPricing).map(([model, pricing]) => [
      model,
      normalizeModelPricingSchedule(pricing),
    ]),
  );
  const registry: Record<string, ModelPricingScheduleV1> = {};
  for (const provider of configuredRegistryProviders(settings)) {
    for (const model of provider.models) {
      if (model.pricing) {
        registry[model.id] = normalizeModelPricingSchedule(model.pricing);
      }
    }
  }
  const configured = Object.fromEntries(
    Object.entries(parseModelPricingJson(settings.modelPricingJson)).map(([model, pricing]) => [
      model,
      { default: pricing },
    ]),
  );
  return {
    ...defaults,
    ...registry,
    ...configured,
  };
}

/** Legacy flat projection: returns the default/below-threshold price. */
export function configuredModelPricing(settings: Settings): Record<string, ModelPricing> {
  return Object.fromEntries(
    Object.entries(configuredModelPricingSchedules(settings)).map(([model, schedule]) => [
      model,
      schedule.default,
    ]),
  );
}

/** Select the per-provider-request price at an exact input-token threshold. */
export function selectModelPricing(
  schedule: ModelPricingScheduleV1,
  inputTokens: number,
): ModelPricing {
  const normalizedInputTokens = Math.max(0, Math.floor(inputTokens));
  let selected = schedule.default;
  for (const tier of schedule.inputTokenTiers ?? []) {
    if (normalizedInputTokens < tier.minimumInputTokens) {
      break;
    }
    selected = tier.pricing;
  }
  return selected;
}

/**
 * Usable input-token budget: an explicit model-catalog effective window when
 * available, otherwise the deployment window minus its output reserve.
 */
export function contextInputBudgetTokens(
  settings: Pick<
    Settings,
    "contextWindowTokens" | "contextEffectiveWindowTokens" | "contextReservedOutputTokens"
  >,
): number {
  if (settings.contextEffectiveWindowTokens !== undefined) {
    return Math.min(settings.contextWindowTokens, settings.contextEffectiveWindowTokens);
  }
  return Math.max(0, settings.contextWindowTokens - settings.contextReservedOutputTokens);
}

/**
 * Apply the resolved provider/model's context policy to one turn. Registry
 * metadata is authoritative when present; deployment defaults remain the
 * fallback for models that do not declare their own limits.
 */
export function settingsWithResolvedModelContext(
  settings: Settings,
  model: Pick<
    ConfiguredModel,
    | "contextWindowTokens"
    | "effectiveContextWindowTokens"
    | "autoCompactTokenLimit"
    | "toolOutputTruncationTokens"
  >,
): Settings {
  const contextWindowTokens = model.contextWindowTokens ?? settings.contextWindowTokens;
  return {
    ...settings,
    contextWindowTokens,
    ...(model.effectiveContextWindowTokens === undefined
      ? {}
      : {
          contextEffectiveWindowTokens: Math.min(
            contextWindowTokens,
            model.effectiveContextWindowTokens,
          ),
        }),
    ...(model.autoCompactTokenLimit === undefined
      ? {}
      : { contextAutoCompactThresholdTokens: model.autoCompactTokenLimit }),
    ...(model.toolOutputTruncationTokens === undefined
      ? {}
      : { modelToolOutputTruncationTokens: model.toolOutputTruncationTokens }),
  };
}

export function configuredStaticUsageLimits(settings: Settings): StaticUsageLimitsConfig {
  return parseStaticUsageLimitsJson(settings.staticUsageLimitsJson);
}

export function configuredEntitlements(settings: Settings): EntitlementsConfig {
  if (settings.entitlementsMode === "none") {
    return {};
  }
  const configured = parseStaticEntitlementsJson(settings.staticEntitlementsJson);
  if (settings.entitlementsMode === "static") {
    return configured;
  }
  return {
    "managed.auth.email_password": true,
    "managed.billing.prepaid_credits": settings.billingMode === "stripe",
    "managed.api_keys": true,
    "managed.workspaces": true,
    "managed.github_app": Boolean(settings.githubAppId && settings.githubAppPrivateKey),
    ...configured,
  };
}

export function calculateModelUsageCostMicros(
  settings: Settings,
  model: string,
  usage: ModelUsageInput,
  options?: { latencyMode?: LatencyMode },
): number {
  return calculateModelUsageCostBreakdown(settings, model, usage, options).creditCostMicros;
}

export function calculateModelUsageCostBreakdown(
  settings: Settings,
  model: string,
  usage: ModelUsageInput,
  options?: { latencyMode?: LatencyMode },
): ModelUsageCostBreakdown {
  const schedule = configuredModelPricingSchedules(settings)[model];
  if (!schedule) {
    throw new Error(`Missing model pricing for ${model}`);
  }
  const entries =
    usage.requestUsageEntries && usage.requestUsageEntries.length > 0
      ? usage.requestUsageEntries
      : [usage];
  const rawCostByPricing = new Map<ModelPricing, number>();
  for (const entry of entries) {
    const pricing = selectModelPricing(schedule, positiveInt(entry.inputTokens));
    rawCostByPricing.set(
      pricing,
      (rawCostByPricing.get(pricing) ?? 0) + calculateEntryCostMicros(pricing, entry),
    );
  }
  let providerCostMicros = 0;
  let creditCostMicros = 0;
  for (const [pricing, rawCost] of rawCostByPricing) {
    const marginBps = pricing.marginBps ?? 0;
    providerCostMicros += rawCost;
    creditCostMicros += Math.ceil((rawCost * (10_000 + marginBps)) / 10_000);
  }
  const latencyMode = options?.latencyMode ?? "standard";
  if (latencyMode !== "standard") {
    const catalogSettings = settingsForTurnExecutionPolicy(settings, model);
    const resolved = resolveModelProvider(
      catalogSettings,
      canonicalizeConfiguredModelId(catalogSettings, model),
    );
    const multiplierBps = resolved?.model.capabilities.latencyModes.find(
      (mode) => mode.id === latencyMode && mode.runnable,
    )?.billingMultiplierBps;
    if (multiplierBps && multiplierBps > 0) {
      providerCostMicros = Math.ceil((providerCostMicros * multiplierBps) / 10_000);
      creditCostMicros = Math.ceil((creditCostMicros * multiplierBps) / 10_000);
    }
  }
  return { providerCostMicros, creditCostMicros };
}

/**
 * Convert AI Gateway's exact USD inference cost to OpenGeni credit micros and
 * apply the configured model margin. Decimal arithmetic is integer-only so a
 * sub-micro provider charge cannot be lost to floating-point rounding.
 */
export function calculateGatewayReportedCostMicros(
  settings: Settings,
  model: string,
  inferenceCostUsd: string,
  options?: { inputTokens?: number },
): number {
  return calculateGatewayReportedCostBreakdown(settings, model, inferenceCostUsd, options)
    .creditCostMicros;
}

type GatewayReportedCostDecimal = {
  providerNumerator: bigint;
  decimalScale: bigint;
  providerCostMicros: number;
};

function parseGatewayReportedCostDecimal(inferenceCostUsd: string): GatewayReportedCostDecimal {
  const match = /^(0|[1-9]\d*)(?:\.(\d{1,18}))?$/.exec(inferenceCostUsd);
  if (!match) {
    throw new Error("Invalid AI Gateway inference cost");
  }
  const fraction = match[2] ?? "";
  const decimalDigits = BigInt(`${match[1]}${fraction}`);
  const decimalScale = 10n ** BigInt(fraction.length);
  const providerNumerator = decimalDigits * 1_000_000n;
  const providerCostMicros = (providerNumerator + decimalScale - 1n) / decimalScale;
  if (providerCostMicros > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error("AI Gateway inference cost exceeds the supported billing range");
  }
  return {
    providerNumerator,
    decimalScale,
    providerCostMicros: Number(providerCostMicros),
  };
}

/** Exact provider-reported Gateway cost without requiring an OpenGeni price schedule. */
export function calculateGatewayReportedProviderCostMicros(inferenceCostUsd: string): number {
  return parseGatewayReportedCostDecimal(inferenceCostUsd).providerCostMicros;
}

export function calculateGatewayReportedCostBreakdown(
  settings: Settings,
  model: string,
  inferenceCostUsd: string,
  options?: { inputTokens?: number },
): ModelUsageCostBreakdown {
  const schedule = configuredModelPricingSchedules(settings)[model];
  if (!schedule) {
    throw new Error(`Missing model pricing for ${model}`);
  }
  const pricing = selectModelPricing(schedule, positiveInt(options?.inputTokens));
  const { providerNumerator, decimalScale, providerCostMicros } =
    parseGatewayReportedCostDecimal(inferenceCostUsd);
  const marginBps = BigInt(10_000 + (pricing.marginBps ?? 0));
  const numerator = providerNumerator * marginBps;
  const denominator = decimalScale * 10_000n;
  const creditMicros = (numerator + denominator - 1n) / denominator;
  if (creditMicros > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error("AI Gateway inference cost exceeds the supported billing range");
  }
  return {
    providerCostMicros,
    creditCostMicros: Number(creditMicros),
  };
}

/**
 * Exact OpenGeni product price frozen before a managed video request starts.
 * Gateway reporting is delayed for asynchronous video, so this deliberately
 * does not masquerade as provider-reported cost.
 */
export function calculateVideoGenerationCreditCostMicros(
  settings: Settings,
  input: {
    modelId: string;
    resolution: VideoGenerationResolution;
    durationSeconds: number;
  },
): number {
  if (input.modelId !== SEEDANCE_2_5_MODEL_ID) {
    throw new Error(`Missing video generation credit pricing for ${input.modelId}`);
  }
  if (!Number.isSafeInteger(input.durationSeconds) || input.durationSeconds < 1) {
    throw new Error("Video generation duration is invalid for credit pricing");
  }
  const rate =
    input.resolution === "480p"
      ? settings.videoGenerationCredit480pMicrosPerSecond
      : settings.videoGenerationCredit720pMicrosPerSecond;
  const cost = rate * input.durationSeconds;
  if (!Number.isSafeInteger(cost) || cost <= 0 || cost > 1_000_000_000) {
    throw new Error("Video generation credit price exceeds the supported range");
  }
  return cost;
}

export function configuredAllowedReasoningEfforts(
  settings: Settings,
): Array<z.infer<typeof ReasoningEffort>> {
  return uniqueValues([
    settings.openaiReasoningEffort,
    ...splitCsv(settings.openaiAllowedReasoningEfforts),
  ]).map((value) => ReasoningEffort.parse(value));
}

/**
 * Decodes OPENGENI_ENVIRONMENTS_ENCRYPTION_KEY (base64, exactly 32 bytes) for
 * AES-256-GCM workspace environment value encryption. Returns null when unset.
 * Throws naming only the env var, never echoing its value.
 */
export function environmentsEncryptionKeyBytes(settings: Settings): Uint8Array | null {
  if (!settings.environmentsEncryptionKey) {
    return null;
  }
  const decoded = Buffer.from(settings.environmentsEncryptionKey, "base64");
  if (decoded.length !== 32) {
    throw new Error(
      "OPENGENI_ENVIRONMENTS_ENCRYPTION_KEY must be base64 for exactly 32 bytes (generate with: openssl rand -base64 32)",
    );
  }
  return new Uint8Array(decoded);
}

/**
 * Build one structurally compatible connection policy for both
 * `@temporalio/client` and `@temporalio/worker`. An API key or any custom TLS
 * material enables TLS automatically; the explicit flag covers server-auth TLS
 * without credentials. Secret values are never included in validation errors.
 */
export function temporalConnectionOptions(settings: Settings): TemporalConnectionOptions {
  const apiKey = settings.temporalApiKey?.trim() || undefined;
  const serverNameOverride = settings.temporalTlsServerName?.trim() || undefined;
  const rootCa = decodeTemporalTlsMaterial(
    settings.temporalTlsRootCaCertificateBase64,
    "OPENGENI_TEMPORAL_TLS_ROOT_CA_CERTIFICATE_BASE64",
  );
  const clientCertificate = decodeTemporalTlsMaterial(
    settings.temporalTlsClientCertificateBase64,
    "OPENGENI_TEMPORAL_TLS_CLIENT_CERTIFICATE_BASE64",
  );
  const clientPrivateKey = decodeTemporalTlsMaterial(
    settings.temporalTlsClientPrivateKeyBase64,
    "OPENGENI_TEMPORAL_TLS_CLIENT_PRIVATE_KEY_BASE64",
  );

  if (Boolean(clientCertificate) !== Boolean(clientPrivateKey)) {
    throw new Error(
      "OPENGENI_TEMPORAL_TLS_CLIENT_CERTIFICATE_BASE64 and " +
        "OPENGENI_TEMPORAL_TLS_CLIENT_PRIVATE_KEY_BASE64 must both be set or both omitted",
    );
  }

  const tls: TemporalTlsConnectionConfig = {};
  if (serverNameOverride) {
    tls.serverNameOverride = serverNameOverride;
  }
  if (rootCa) {
    tls.serverRootCACertificate = rootCa;
  }
  if (clientCertificate && clientPrivateKey) {
    tls.clientCertPair = { crt: clientCertificate, key: clientPrivateKey };
  }
  const hasCustomTls = Object.keys(tls).length > 0;
  const tlsEnabled = settings.temporalTlsEnabled || Boolean(apiKey) || hasCustomTls;

  return {
    address: settings.temporalHost,
    ...(tlsEnabled ? { tls: hasCustomTls ? tls : true } : {}),
    ...(apiKey ? { apiKey } : {}),
  };
}

function decodeTemporalTlsMaterial(
  value: string | undefined,
  settingName: string,
): Uint8Array | undefined {
  // RFC 2045 base64 commonly arrives wrapped at 76 columns. Kubernetes
  // stringData and external secret stores preserve those line breaks, so
  // normalize whitespace before applying the strict alphabet/canonical check.
  const encoded = value?.replace(/\s/g, "");
  if (!encoded) {
    return undefined;
  }
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(encoded) || encoded.length % 4 === 1) {
    throw new Error(`${settingName} must contain valid base64`);
  }
  const decoded = Buffer.from(encoded, "base64");
  const canonical = decoded.toString("base64").replace(/=+$/, "");
  if (decoded.length === 0 || canonical !== encoded.replace(/=+$/, "")) {
    throw new Error(`${settingName} must contain valid base64`);
  }
  return new Uint8Array(decoded);
}

/**
 * The connection `search_path` for OpenGeni's db handles + the managed-auth pool
 * (Step I, §7.8 runtime half). Returns `undefined` when `dbSchema` is unset
 * (standalone) so no `search_path` startup parameter is sent and the server
 * default (`public`) applies — byte-for-byte today's behavior. When `dbSchema`
 * is set (embedded), returns `"<schema>,opengeni_private,public"` — `public`
 * stays LAST so `gen_random_uuid()` (pgcrypto) and the `vector` type still
 * resolve (the schema-isolation contract live footgun). `opengeni_private` is on the path so the
 * RLS GUC-reader helpers resolve when referenced unqualified.
 */
export function dbSearchPath(settings: Pick<Settings, "dbSchema">): string | undefined {
  const schema = settings.dbSchema?.trim();
  if (!schema) {
    return undefined;
  }
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(schema)) {
    throw new Error(`OPENGENI_DB_SCHEMA is not a valid Postgres identifier: ${schema}`);
  }
  return `${schema},opengeni_private,public`;
}

export function collectGitIdentityEnvironment(settings: Settings): Record<string, string> {
  return Object.fromEntries(
    Object.entries({
      GIT_AUTHOR_NAME: settings.gitAuthorName,
      GIT_AUTHOR_EMAIL: settings.gitAuthorEmail,
      GIT_COMMITTER_NAME: settings.gitCommitterName ?? settings.gitAuthorName,
      GIT_COMMITTER_EMAIL: settings.gitCommitterEmail ?? settings.gitAuthorEmail,
    }).filter(
      (entry): entry is [string, string] =>
        typeof entry[1] === "string" && entry[1].trim().length > 0,
    ),
  );
}

const DEFAULT_SANDBOX_PATH = "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin";

function prependPathEntry(pathValue: string | undefined, entry: string): string {
  const parts = (pathValue ?? DEFAULT_SANDBOX_PATH).split(":").filter(Boolean);
  return [entry, ...parts.filter((part) => part !== entry)].join(":");
}

/**
 * The STABLE run-scoped sandbox environment: the subset of a run's box-manifest
 * environment that is IDENTICAL whether the box is first warmed by the worker
 * TURN or by an API-direct ATTACH (viewer / Channel-A / desktop / terminal). It
 * is the layered base every cold box must be created with so a later turn's
 * agent-manifest apply finds an EMPTY environment delta in the SDK's
 * `validateNoEnvironmentDelta` (which throws "Live sandbox sessions cannot change
 * manifest environment variables" on ANY key the agent declares that the box's
 * manifest lacks or carries a different value for).
 *
 * Precedence (lowest → highest): deployment allowlist (`collectSandboxEnvironment`)
 * < git identity (`collectGitIdentityEnvironment`) < the session's attached
 * workspace environment < the backend-aware HOME default. Reserved-name validation
 * at write time keeps workspace values from colliding with platform entries.
 *
 * DELIBERATELY EXCLUDES the per-run, ROTATING git provider token VALUES that
 * `sandboxEnvironmentForRun` mints when a repository resource is
 * attached: that token is minted FRESH per call, so it is not a stable, attach-
 * reproducible value and must not be part of the shared base. Under the token-
 * broker (B1) token VALUES never ride the manifest at all — they are seeded to
 * FILES inside the box and git/provider CLI auth reads those files. What IS stable
 * and lives here for provisioned boxes are the token directory / GitHub alias
 * FILE PATH and wrapper PATH entries: constants derived from HOME, so they
 * appear IDENTICALLY on BOTH the turn AND every attach manifest (the SDK's
 * per-turn provided-session env delta stays empty even as tokens rotate). These
 * helper pointers are deliberately not added for selfhosted/local/none because
 * the platform never mints or seeds git provider tokens there. The attach
 * surfaces have only the `Session` (no repo resources) and so never seed a token,
 * but unwritten files simply yield no auth; the BLOCKING attach-vs-turn error
 * this helper fixes is for the common (no-repo) and workspace-environment-attached
 * provisioned-box cases.
 */
export function stableSandboxEnvironmentForRun(
  settings: Settings,
  workspaceEnvironment: Record<string, string> = {},
  options: { workspaceId?: string } = {},
): Record<string, string> {
  const environment: Record<string, string> = {
    ...collectSandboxEnvironment(settings),
    ...collectGitIdentityEnvironment(settings),
    ...workspaceEnvironment,
  };
  // Backend-aware HOME: a provisioned box (docker + every cloud provider) runs the
  // agent under the descriptor's workspaceRoot. `local` runs in-process as the host
  // unix user (keep its real $HOME); `selfhosted` runs on a user's machine and must
  // likewise preserve that machine's real HOME; `none` has no box.
  const descriptor = CAPABILITY_DESCRIPTORS[settings.sandboxBackend];
  if (
    settings.sandboxBackend !== "none" &&
    settings.sandboxBackend !== "local" &&
    settings.sandboxBackend !== "selfhosted"
  ) {
    environment.HOME ??= descriptor.workspaceRoot;
  }
  // TOKEN-BROKER (B1): the STABLE credential FILE PATHS and CLI wrapper PATH for
  // provisioned boxes only. Constants derived from the resolved HOME (falling
  // back to the descriptor workspaceRoot), so they are parity-safe — they join
  // the shared base and therefore appear IDENTICALLY on BOTH the worker-turn
  // manifest AND every API-direct attach manifest. Only PATHS are stable; token
  // VALUES live exclusively in files that runtime seeds off-manifest.
  const provisionedGitHelperBackend =
    settings.sandboxBackend !== "none" &&
    settings.sandboxBackend !== "local" &&
    settings.sandboxBackend !== "selfhosted";
  if (provisionedGitHelperBackend) {
    const home = environment.HOME ?? descriptor.workspaceRoot;
    environment.OPENGENI_GIT_CREDENTIALS_DIR ??= `${home}/.opengeni/git-credentials`;
    environment.OPENGENI_GIT_TOKEN_FILE ??= `${home}/.opengeni/git-token`;
    environment.OPENGENI_GIT_CLI_WRAPPER_DIR ??= `${home}/.opengeni/bin`;
    environment.PATH = prependPathEntry(environment.PATH, environment.OPENGENI_GIT_CLI_WRAPPER_DIR);
  }
  if (settings.sandboxBackend !== "selfhosted" && resolveFirstPartyDelegationSecret(settings)) {
    environment.OPENGENI_CODEMODE_TOKEN_FILE ??= `${environment.HOME ?? descriptor.workspaceRoot}/.opengeni/codemode-token`;
    if (settings.ogtoolPackageSpec) {
      environment.OPENGENI_OGTOOL_PACKAGE_SPEC ??= settings.ogtoolPackageSpec;
    }
    if (options.workspaceId) {
      environment.OPENGENI_CODEMODE_URL ??= codemodeWorkspaceUrl(settings, options.workspaceId);
    }
  }
  return environment;
}

/**
 * Whether a resource set carries a GitHub-App-connected repository (installation
 * + repository ids present) — the SAME predicate the worker turn uses to decide
 * whether it declares the stable git-auth pointers. Attach surfaces call this so
 * an attach-warmed cold box carries the IDENTICAL manifest env a later repo turn
 * declares (env parity — see applyGitAuthPointerEnvironment).
 */
export function hasGitHubRepositorySelection(
  resources: ReadonlyArray<{
    kind: string;
    provider?: unknown;
    installationId?: unknown;
    repositoryId?: unknown;
    githubInstallationId?: unknown;
    githubRepositoryId?: unknown;
  }>,
): boolean {
  const positive = (value: unknown): boolean =>
    (typeof value === "number" && Number.isInteger(value) && value > 0) ||
    (typeof value === "string" && /^\d+$/.test(value) && Number(value) > 0);
  return resources.some(
    (resource) =>
      resource.kind === "repository" &&
      ((positive(resource.githubInstallationId) && positive(resource.githubRepositoryId)) ||
        (resource.provider === "github" &&
          positive(resource.installationId) &&
          positive(resource.repositoryId))),
  );
}

export function hasGitCredentialRepositorySelection(
  resources: ReadonlyArray<{
    kind: string;
    provider?: unknown;
    githubInstallationId?: unknown;
    githubRepositoryId?: unknown;
  }>,
): boolean {
  return resources.some(
    (resource) =>
      resource.kind === "repository" &&
      (resource.provider === "github" ||
        resource.provider === "gitlab" ||
        resource.provider === "azure_devops" ||
        hasGitHubRepositorySelection([resource])),
  );
}

/**
 * TOKEN-BROKER (B1) parity: the STABLE git-auth POINTER environment a
 * repo-attached run declares — GIT_ASKPASS (a fixed path under HOME; the script
 * itself is provisioned at box setup), GIT_TERMINAL_PROMPT, and the GitHub-App
 * bot identity fallbacks. NO rotating value rides here (the token lives in the
 * file behind the askpass), so the layer is attach-reproducible and MUST be
 * applied identically by the worker turn (sandboxEnvironmentForRun) AND every
 * API-direct attach surface that can cold-create the box (viewer attach,
 * channel-A ops). A box cold-created WITHOUT this layer kills the next repo
 * turn: the turn's manifest declares these keys, the box's env lacks them, and
 * the SDK's provided-session guard throws "Live sandbox sessions cannot change
 * manifest environment variables" (observed live: an open session page's viewer
 * attach won the cold-create race and the first turn died).
 *
 * Mutates and returns `environment`. Identity fallbacks preserve values already
 * present (the deployment git-identity allowlist wins over the bot identity).
 */
export function applyGitAuthPointerEnvironment(
  environment: Record<string, string>,
  identity: { name: string; email: string } | null,
): Record<string, string> {
  environment.GIT_ASKPASS = `${environment.HOME ?? "/workspace"}/.opengeni/askpass`;
  environment.GIT_TERMINAL_PROMPT = "0";
  if (identity) {
    environment.GIT_AUTHOR_NAME = environment.GIT_AUTHOR_NAME || identity.name;
    environment.GIT_AUTHOR_EMAIL = environment.GIT_AUTHOR_EMAIL || identity.email;
    environment.GIT_COMMITTER_NAME = environment.GIT_COMMITTER_NAME || identity.name;
    environment.GIT_COMMITTER_EMAIL = environment.GIT_COMMITTER_EMAIL || identity.email;
  }
  return environment;
}

export type StartupRetryOptions = {
  attempts?: number;
  initialDelayMs?: number;
  maxDelayMs?: number;
  onRetry?: (event: {
    label: string;
    attempt: number;
    attempts: number;
    delayMs: number;
    error: unknown;
  }) => void;
};

export function startupRetryOptions(
  settings: Settings,
): Required<Omit<StartupRetryOptions, "onRetry">> {
  return {
    attempts: settings.startupDependencyRetryAttempts,
    initialDelayMs: settings.startupDependencyRetryInitialDelayMs,
    maxDelayMs: settings.startupDependencyRetryMaxDelayMs,
  };
}

export async function retryStartupDependency<T>(
  label: string,
  operation: () => Promise<T>,
  options: StartupRetryOptions = {},
): Promise<T> {
  const attempts = Math.max(1, Math.floor(options.attempts ?? 30));
  const initialDelayMs = Math.max(0, Math.floor(options.initialDelayMs ?? 1000));
  const maxDelayMs = Math.max(initialDelayMs, Math.floor(options.maxDelayMs ?? 5000));
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      if (attempt >= attempts) {
        throw error;
      }
      const delayMs = Math.min(maxDelayMs, initialDelayMs * 2 ** (attempt - 1));
      options.onRetry?.({ label, attempt, attempts, delayMs, error });
      await delay(delayMs);
    }
  }
  throw new Error(`unreachable startup retry state for ${label}`);
}

export function sandboxEnvironmentVariableNames(settings: Settings): string[] {
  const profiles = sandboxPreparationProfileNames(settings);
  const names: string[] = [];
  for (const profile of profiles) {
    names.push(...sandboxPreparationProfiles[profile]!.env);
  }
  names.push(...splitCsv(settings.sandboxEnvAllowlist));
  return uniqueEnvNames(names, "sandbox env");
}

export function sandboxLifecycleHookIds(settings: Settings): string[] {
  const ids: string[] = [];
  for (const profile of sandboxPreparationProfileNames(settings)) {
    ids.push(...sandboxPreparationProfiles[profile]!.hooks);
  }
  return uniqueValues(ids);
}

function sandboxPreparationProfileNames(settings: Settings): string[] {
  const profiles = splitCsv(settings.sandboxPreparationProfiles).map((value) =>
    value.toLowerCase(),
  );
  if (profiles.includes("none")) {
    if (profiles.length > 1) {
      throw new Error(
        "OPENGENI_SANDBOX_PREPARATION_PROFILES cannot combine none with other profiles",
      );
    }
    return ["none"];
  }
  for (const profile of profiles) {
    if (!sandboxPreparationProfiles[profile]) {
      throw new Error(`Unknown sandbox preparation profile ${profile}`);
    }
  }
  return profiles;
}

export function parseExposedPorts(raw: string): number[] {
  return splitCsv(raw).map((value) => {
    const port = Number(value);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      throw new Error("OPENGENI_DOCKER_EXPOSED_PORTS must contain TCP port numbers");
    }
    return port;
  });
}

export function parseMcpServers(raw: string | undefined): unknown[] | undefined {
  if (!raw) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      throw new Error("value must be a JSON array");
    }
    return parsed;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`OPENGENI_MCP_SERVERS must be a JSON array: ${message}`, {
      cause: error,
    });
  }
}

export function parseModelPricingJson(raw: string): Record<string, ModelPricing> {
  if (!raw.trim() || raw.trim() === "{}") {
    return {};
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`OPENGENI_MODEL_PRICING_JSON must be valid JSON: ${message}`, { cause: error });
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("OPENGENI_MODEL_PRICING_JSON must be a JSON object keyed by model name");
  }
  const out: Record<string, ModelPricing> = {};
  for (const [model, value] of Object.entries(parsed)) {
    if (!model.trim()) {
      throw new Error("OPENGENI_MODEL_PRICING_JSON contains an empty model name");
    }
    out[model] = ModelPricingSchema.parse(value);
  }
  return out;
}

// --- sandbox warm-rate table (P2.1) ---
// Per-backend usd_micros/sec, parsed from sandboxWarmRateMicrosPerSecondJson the
// same way model pricing is. An empty {} (the default) means no warm-cost is
// debited — warm-seconds are still metered for audit, just at rate 0.
export function parseSandboxWarmRateJson(raw: string): Record<string, number> {
  if (!raw.trim() || raw.trim() === "{}") {
    return {};
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(
      `OPENGENI_SANDBOX_WARM_RATE_MICROS_PER_SECOND_JSON must be valid JSON: ${message}`,
      { cause: error },
    );
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(
      "OPENGENI_SANDBOX_WARM_RATE_MICROS_PER_SECOND_JSON must be a JSON object keyed by backend name",
    );
  }
  const out: Record<string, number> = {};
  for (const [backend, value] of Object.entries(parsed)) {
    if (!backend.trim()) {
      throw new Error(
        "OPENGENI_SANDBOX_WARM_RATE_MICROS_PER_SECOND_JSON contains an empty backend name",
      );
    }
    const rate = typeof value === "number" ? value : Number(value);
    if (!Number.isFinite(rate) || rate < 0) {
      throw new Error(
        `OPENGENI_SANDBOX_WARM_RATE_MICROS_PER_SECOND_JSON rate for ${backend} must be a non-negative number`,
      );
    }
    out[backend] = rate;
  }
  return out;
}

// Resolve the warm rate (usd_micros/sec) for a backend; 0 when the backend has no
// configured rate (the box is metered in seconds but not cost-debited).
export function sandboxWarmRateMicrosPerSecond(settings: Settings, backend: string): number {
  const table = parseSandboxWarmRateJson(settings.sandboxWarmRateMicrosPerSecondJson);
  return table[backend] ?? 0;
}

/**
 * Parse + validate the extra-provider registry JSON. `[]` (or empty/whitespace)
 * yields an empty list. Surfaces JSON and zod errors prefixed with the env-var
 * name so a malformed registry fails fast at boot (validateSettings calls this).
 */
export function parseModelProvidersJson(raw: string): RegistryProvider[] {
  if (!raw.trim() || raw.trim() === "[]") {
    return [];
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`OPENGENI_MODEL_PROVIDERS_JSON must be valid JSON: ${message}`, {
      cause: error,
    });
  }
  if (!Array.isArray(parsed)) {
    throw new Error("OPENGENI_MODEL_PROVIDERS_JSON must be a JSON array of providers");
  }
  return parsed.map((entry, index) => {
    const result = RegistryProviderSchema.safeParse(entry);
    if (!result.success) {
      throw new Error(
        `OPENGENI_MODEL_PROVIDERS_JSON provider[${index}] is invalid: ${result.error.message}`,
      );
    }
    try {
      return normalizeRegistryProvider(result.data);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`OPENGENI_MODEL_PROVIDERS_JSON provider[${index}] is invalid: ${message}`, {
        cause: error,
      });
    }
  });
}

export function parseIntegrationsOauthClientsJson(
  raw: string | undefined,
): Record<string, IntegrationOAuthClientConfig> {
  if (!raw?.trim() || raw.trim() === "{}") {
    return {};
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`OPENGENI_INTEGRATIONS_OAUTH_CLIENTS_JSON must be valid JSON: ${message}`, {
      cause: error,
    });
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(
      "OPENGENI_INTEGRATIONS_OAUTH_CLIENTS_JSON must be a JSON object keyed by authorization-server issuer or URL",
    );
  }
  const out: Record<string, IntegrationOAuthClientConfig> = {};
  for (const [key, value] of Object.entries(parsed)) {
    if (!key.trim()) {
      throw new Error("OPENGENI_INTEGRATIONS_OAUTH_CLIENTS_JSON contains an empty issuer key");
    }
    const result = IntegrationOAuthClientConfigSchema.safeParse(value);
    if (!result.success) {
      throw new Error(
        `OPENGENI_INTEGRATIONS_OAUTH_CLIENTS_JSON client for ${key} is invalid: ${result.error.message}`,
      );
    }
    out[key] = result.data;
  }
  return out;
}

export const SocialOAuthClientConfigSchema = z.object({
  clientId: z.string().min(1),
  clientSecret: z.string().min(1).optional(),
});
export type SocialOAuthClientConfig = z.infer<typeof SocialOAuthClientConfigSchema>;

const SOCIAL_OAUTH_PROVIDER_IDS = ["x", "reddit"] as const;

export function parseSocialOauthClientsJson(
  raw: string | undefined,
): Partial<Record<(typeof SOCIAL_OAUTH_PROVIDER_IDS)[number], SocialOAuthClientConfig>> {
  if (!raw?.trim() || raw.trim() === "{}") {
    return {};
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`OPENGENI_SOCIAL_OAUTH_CLIENTS_JSON must be valid JSON: ${message}`, {
      cause: error,
    });
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(
      "OPENGENI_SOCIAL_OAUTH_CLIENTS_JSON must be a JSON object keyed by social provider id",
    );
  }
  const out: Partial<Record<(typeof SOCIAL_OAUTH_PROVIDER_IDS)[number], SocialOAuthClientConfig>> =
    {};
  for (const [key, value] of Object.entries(parsed)) {
    if (!SOCIAL_OAUTH_PROVIDER_IDS.includes(key as (typeof SOCIAL_OAUTH_PROVIDER_IDS)[number])) {
      throw new Error(
        `OPENGENI_SOCIAL_OAUTH_CLIENTS_JSON provider ${key} is not supported (expected: ${SOCIAL_OAUTH_PROVIDER_IDS.join(", ")})`,
      );
    }
    const result = SocialOAuthClientConfigSchema.safeParse(value);
    if (!result.success) {
      throw new Error(
        `OPENGENI_SOCIAL_OAUTH_CLIENTS_JSON client for ${key} is invalid: ${result.error.message}`,
      );
    }
    out[key as (typeof SOCIAL_OAUTH_PROVIDER_IDS)[number]] = result.data;
  }
  return out;
}

export function parseStaticUsageLimitsJson(raw: string): StaticUsageLimitsConfig {
  if (!raw.trim() || raw.trim() === "{}") {
    return {};
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`OPENGENI_STATIC_USAGE_LIMITS_JSON must be valid JSON: ${message}`, {
      cause: error,
    });
  }
  return StaticUsageLimits.parse(parsed);
}

export function parseStaticEntitlementsJson(raw: string): EntitlementsConfig {
  if (!raw.trim() || raw.trim() === "{}") {
    return {};
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`OPENGENI_STATIC_ENTITLEMENTS_JSON must be valid JSON: ${message}`, {
      cause: error,
    });
  }
  return Entitlements.parse(parsed);
}

function calculateEntryCostMicros(pricing: ModelPricing, entry: ModelUsageInput): number {
  const inputTokens = positiveInt(entry.inputTokens);
  const outputTokens = positiveInt(entry.outputTokens);
  const cachedTokens = Math.min(inputTokens, cachedInputTokens(entry));
  const uncachedInputTokens = Math.max(0, inputTokens - cachedTokens);
  const cachedInputRate =
    pricing.cachedInputMicrosPerMillionTokens ?? pricing.inputMicrosPerMillionTokens;
  return (
    Math.ceil((uncachedInputTokens * pricing.inputMicrosPerMillionTokens) / 1_000_000) +
    Math.ceil((cachedTokens * cachedInputRate) / 1_000_000) +
    Math.ceil((outputTokens * pricing.outputMicrosPerMillionTokens) / 1_000_000)
  );
}

function cachedInputTokens(entry: ModelUsageInput): number {
  const details = Array.isArray(entry.inputTokensDetails)
    ? entry.inputTokensDetails
    : entry.inputTokensDetails
      ? [entry.inputTokensDetails]
      : [];
  let total = 0;
  for (const detail of details) {
    total +=
      positiveInt(detail.cached_tokens) +
      positiveInt(detail.cachedInputTokens) +
      positiveInt(detail.cached_input_tokens);
  }
  return total;
}

function positiveInt(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

function ensureBuiltInMcpServers(settings: Settings): Settings["mcpServers"] {
  const existing = settings.mcpServers.filter((server) => server.id !== "opengeni");
  const firstPartyMcpUrl = firstPartyMcpServerUrl(settings);
  const firstPartyFilesMcpUrl = firstPartyFilesMcpServerUrl(firstPartyMcpUrl);
  const firstPartyDocsMcpUrl = firstPartyDocumentsMcpServerUrl(firstPartyMcpUrl);
  const hasFiles = existing.some((server) => server.id === "files");
  const hasDocs = existing.some((server) => server.id === "docs");
  return [
    {
      id: "opengeni",
      name: "OpenGeni",
      url: firstPartyMcpUrl,
      // The opengeni server's tools/list response is permission-scoped: it
      // varies by the calling session's delegated grant (e.g. a manager
      // session sees sessions_*/environment_* tools that a worker session
      // does not). The OpenAI Agents SDK caches tools/list in a process-global
      // map keyed only by the MCP server name, which is identical for every
      // session in the worker process. Caching here would let the first
      // session to warm the cache dictate what every later session sees,
      // regardless of permissions. tools/list is a cheap per-turn call, so we
      // never cache it. (The files server pins allowedTools to a single
      // permission-invariant tool and docs is already uncached, so both stay
      // safe to cache / leave as-is.)
      cacheToolsList: false,
    },
    ...(hasFiles
      ? []
      : [
          {
            id: "files",
            name: "Files",
            url: firstPartyFilesMcpUrl,
            allowedTools: ["files_get_download_url"],
            cacheToolsList: true,
          },
        ]),
    ...(hasDocs
      ? []
      : [
          {
            id: "docs",
            name: "Document Search",
            url: firstPartyDocsMcpUrl,
            allowedTools: [
              "search_documents",
              "fetch_document_chunk",
              "list_document_bases",
              "list_indexed_documents",
              "knowledge_search",
              "knowledge_get",
              "knowledge_browse",
              "knowledge_fetch",
              "memory_search",
              "memory_propose",
            ],
            cacheToolsList: false,
          },
        ]),
    ...existing,
  ];
}

/**
 * The sandbox/external base URL of OpenGeni's first-party MCP endpoint, as a
 * `{workspaceId}` template. Codemode and remote placements use this route.
 *
 * BINDING CONTRACT (`opengeniMcpUrl`):
 *   - STANDALONE (unset): falls back to the loopback default.
 *   - EMBEDDED / MOUNTED (must set): when OpenGeni's API is mounted as a host
 *     sub-app under a prefix (e.g. `https://host/og/v1/...`), the loopback
 *     default is WRONG — the worker runs in the host process and `127.0.0.1:
 *     ${apiPort}` is not where the mounted, sandbox-routable MCP lives. The host
 *     MUST set `OPENGENI_MCP_URL` to the externally/sandbox-routable base (a
 *     `{workspaceId}` template, or a concrete base that gets re-scoped). This is
 *     the one binding a mounted embed cannot leave unset.
 */
export function firstPartyMcpBaseUrl(settings: Settings): string {
  return (
    settings.opengeniMcpUrl ??
    `http://127.0.0.1:${settings.apiPort}/v1/workspaces/{workspaceId}/mcp`
  );
}

/**
 * Worker-side first-party MCP base. It never inherits the public/tunnel URL:
 * an operator may intentionally expose that route to Modal or a Connected
 * Machine, while the worker should still use loopback or cluster service DNS.
 */
export function firstPartyMcpInternalBaseUrl(settings: Settings): string {
  return (
    settings.opengeniMcpInternalUrl ??
    `http://127.0.0.1:${settings.apiPort}/v1/workspaces/{workspaceId}/mcp`
  );
}

function scopedFirstPartyMcpUrl(raw: string, workspaceId: string): string {
  if (raw.includes("{workspaceId}")) {
    return raw.replaceAll("{workspaceId}", workspaceId);
  }
  const url = new URL(raw);
  url.pathname = `/v1/workspaces/${workspaceId}/mcp`;
  url.search = "";
  url.hash = "";
  return url.toString();
}

export function firstPartyMcpWorkspaceUrl(settings: Settings, workspaceId: string): string {
  return scopedFirstPartyMcpUrl(firstPartyMcpBaseUrl(settings), workspaceId);
}

export function firstPartyMcpInternalWorkspaceUrl(settings: Settings, workspaceId: string): string {
  return scopedFirstPartyMcpUrl(firstPartyMcpInternalBaseUrl(settings), workspaceId);
}

export function codemodeWorkspaceUrl(settings: Settings, workspaceId: string): string {
  if (settings.opengeniMcpUrl) {
    const url = new URL(firstPartyMcpWorkspaceUrl(settings, workspaceId));
    if (!url.pathname.endsWith("/mcp")) {
      throw new Error("First-party MCP URL cannot be projected to the Codemode endpoint");
    }
    url.pathname = `${url.pathname.slice(0, -4)}/codemode`;
    return url.toString();
  }

  // Codemode executes inside the selected placement, not beside the worker.
  // Local Docker reaches the host through Docker's canonical host alias; an
  // in-process local sandbox uses loopback; remote managed providers use the
  // deployment's public origin. `OPENGENI_MCP_URL` above remains the explicit
  // escape hatch for mounted deployments and local remote-provider tunnels.
  const executionOrigin =
    settings.sandboxBackend === "docker"
      ? `http://host.docker.internal:${settings.apiPort}`
      : settings.sandboxBackend === "local"
        ? `http://127.0.0.1:${settings.apiPort}`
        : (settings.publicBaseUrl ?? `http://127.0.0.1:${settings.apiPort}`);
  const url = new URL(executionOrigin);
  url.pathname = `${url.pathname.replace(/\/+$/u, "")}/v1/workspaces/${workspaceId}/codemode`;
  url.search = "";
  url.hash = "";
  return url.toString();
}

function firstPartyMcpServerUrl(settings: Settings): string {
  return firstPartyMcpBaseUrl(settings);
}

function firstPartyDocumentsMcpServerUrl(mcpUrl: string): string {
  return `${mcpUrl.replace(/\/+$/, "")}/docs`;
}

function firstPartyFilesMcpServerUrl(mcpUrl: string): string {
  return `${mcpUrl.replace(/\/+$/, "")}/files`;
}

const MODAL_DESKTOP_IMAGE_DIGEST_REF = /@sha256:[0-9a-f]{64}$/i;

function isDigestPinnedModalDesktopImage(settings: Settings): boolean {
  if (settings.modalImageId) return true;
  return (
    typeof settings.modalImageRef === "string" &&
    MODAL_DESKTOP_IMAGE_DIGEST_REF.test(settings.modalImageRef)
  );
}

function validateSettings(settings: Settings, source: NodeJS.ProcessEnv = process.env): void {
  temporalConnectionOptions(settings);
  if (settings.goalIdleBackoffMs.some((delayMs) => delayMs > settings.goalIdleBackoffMaxMs)) {
    throw new Error(
      `OPENGENI_GOAL_IDLE_BACKOFF_MS entries must not exceed OPENGENI_GOAL_IDLE_BACKOFF_MAX_MS (${settings.goalIdleBackoffMaxMs})`,
    );
  }
  const allowedFirstPartyMcpTools = new Set(
    settings.allowedFirstPartyMcpTools ?? FIRST_PARTY_MCP_TOOL_NAMES,
  );
  const disallowedDefaults = (settings.defaultFirstPartyMcpTools ?? []).filter(
    (tool) => !allowedFirstPartyMcpTools.has(tool),
  );
  if (disallowedDefaults.length > 0) {
    throw new Error(
      `OPENGENI_DEFAULT_FIRST_PARTY_MCP_TOOLS must be a subset of OPENGENI_ALLOWED_FIRST_PARTY_MCP_TOOLS: ${disallowedDefaults.join(", ")}`,
    );
  }
  if (settings.productAccessMode === "managed") {
    if (!settings.publicBaseUrl) {
      throw new Error(
        "OPENGENI_PUBLIC_BASE_URL is required when OPENGENI_PRODUCT_ACCESS_MODE=managed",
      );
    }
    if (!settings.betterAuthSecret) {
      throw new Error(
        "OPENGENI_BETTER_AUTH_SECRET is required when OPENGENI_PRODUCT_ACCESS_MODE=managed",
      );
    }
    if (!settings.delegationSecret) {
      throw new Error(
        "OPENGENI_DELEGATION_SECRET is required when OPENGENI_PRODUCT_ACCESS_MODE=managed",
      );
    }
    if (
      settings.managedAuthSessionSetMode !== "legacy" &&
      !["local", "test"].includes(settings.environment) &&
      !settings.publicBaseUrl.startsWith("https://")
    ) {
      throw new Error(
        "OPENGENI_PUBLIC_BASE_URL must use https when browser session sets are enabled outside local/test",
      );
    }
    if (!["local", "test"].includes(settings.environment) && !settings.resendApiKey) {
      throw new Error("OPENGENI_RESEND_API_KEY is required for managed mode outside local/test");
    }
    if (!["local", "test"].includes(settings.environment) && !settings.environmentsEncryptionKey) {
      throw new Error(
        "OPENGENI_ENVIRONMENTS_ENCRYPTION_KEY is required for managed mode outside local/test",
      );
    }
  }
  if (
    Boolean(settings.managedAuthGoogleClientId) !== Boolean(settings.managedAuthGoogleClientSecret)
  ) {
    throw new Error(
      "OPENGENI_MANAGED_AUTH_GOOGLE_CLIENT_ID and OPENGENI_MANAGED_AUTH_GOOGLE_CLIENT_SECRET must be configured together",
    );
  }
  if (
    Boolean(settings.managedAuthGithubClientId) !== Boolean(settings.managedAuthGithubClientSecret)
  ) {
    throw new Error(
      "OPENGENI_MANAGED_AUTH_GITHUB_CLIENT_ID and OPENGENI_MANAGED_AUTH_GITHUB_CLIENT_SECRET must be configured together",
    );
  }
  const managedSocialAuthConfigured = Boolean(
    settings.managedAuthGoogleClientId || settings.managedAuthGithubClientId,
  );
  if (managedSocialAuthConfigured) {
    if (settings.productAccessMode !== "managed") {
      throw new Error(
        "Managed Google/GitHub authentication requires OPENGENI_PRODUCT_ACCESS_MODE=managed",
      );
    }
    const publicOrigin = canonicalPublicOrigin(settings.publicBaseUrl);
    if (!publicOrigin) {
      throw new Error(
        "OPENGENI_PUBLIC_BASE_URL must be a credential-free HTTP(S) origin when managed social authentication is configured",
      );
    }
    if (!publicOrigin.startsWith("https://") && !["local", "test"].includes(settings.environment)) {
      throw new Error(
        "OPENGENI_PUBLIC_BASE_URL must use https when managed social authentication is configured outside local/test",
      );
    }
  }
  environmentsEncryptionKeyBytes(settings);
  if (settings.integrationsEnabled) {
    if (settings.productAccessMode === "managed" && !settings.publicBaseUrl) {
      throw new Error(
        "OPENGENI_PUBLIC_BASE_URL is required when OPENGENI_INTEGRATIONS_ENABLED=true and OPENGENI_PRODUCT_ACCESS_MODE=managed",
      );
    }
    if (
      settings.publicBaseUrl &&
      !settings.publicBaseUrl.startsWith("https://") &&
      !["local", "test"].includes(settings.environment)
    ) {
      throw new Error(
        "OPENGENI_PUBLIC_BASE_URL must use https when OPENGENI_INTEGRATIONS_ENABLED=true outside local/test",
      );
    }
    if (!settings.integrationsStateSecret && !["local", "test"].includes(settings.environment)) {
      throw new Error(
        "OPENGENI_INTEGRATIONS_STATE_SECRET is required when OPENGENI_INTEGRATIONS_ENABLED=true outside local/test",
      );
    }
  }
  if (Boolean(settings.slackClientId) !== Boolean(settings.slackClientSecret)) {
    throw new Error(
      "OPENGENI_SLACK_CLIENT_ID and OPENGENI_SLACK_CLIENT_SECRET must be configured together",
    );
  }
  if (settings.slackClientId) {
    if (!settings.publicBaseUrl) {
      throw new Error(
        "OPENGENI_PUBLIC_BASE_URL is required when the OpenGeni Slack app is configured",
      );
    }
    if (
      !settings.publicBaseUrl.startsWith("https://") &&
      !["local", "test"].includes(settings.environment)
    ) {
      throw new Error(
        "OPENGENI_PUBLIC_BASE_URL must use https when the OpenGeni Slack app is configured outside local/test",
      );
    }
    if (!settings.integrationsStateSecret) {
      throw new Error(
        "OPENGENI_INTEGRATIONS_STATE_SECRET is required when the OpenGeni Slack app is configured",
      );
    }
  }
  if (Boolean(settings.googleDriveClientId) !== Boolean(settings.googleDriveClientSecret)) {
    throw new Error(
      "OPENGENI_GOOGLE_DRIVE_CLIENT_ID and OPENGENI_GOOGLE_DRIVE_CLIENT_SECRET must be configured together",
    );
  }
  if (
    Boolean(settings.githubPersonalOauthClientId) !==
    Boolean(settings.githubPersonalOauthClientSecret)
  ) {
    throw new Error(
      "OPENGENI_GITHUB_PERSONAL_OAUTH_CLIENT_ID and OPENGENI_GITHUB_PERSONAL_OAUTH_CLIENT_SECRET must be configured together",
    );
  }
  if (settings.githubPersonalOauthEnabled) {
    if (!settings.integrationsEnabled) {
      throw new Error(
        "OPENGENI_INTEGRATIONS_ENABLED=true is required when personal GitHub OAuth is enabled",
      );
    }
    if (!settings.githubPersonalOauthClientId || !settings.githubPersonalOauthClientSecret) {
      throw new Error(
        "personal GitHub OAuth requires OPENGENI_GITHUB_PERSONAL_OAUTH_CLIENT_ID and OPENGENI_GITHUB_PERSONAL_OAUTH_CLIENT_SECRET",
      );
    }
    if (settings.githubPersonalOauthClientId === settings.githubClientId) {
      throw new Error(
        "personal GitHub OAuth must use a different OAuth App client from the OpenGeni GitHub App",
      );
    }
    if (!personalGitHubOAuthCallbackUrl(settings.publicBaseUrl)) {
      throw new Error(
        "OPENGENI_PUBLIC_BASE_URL must be a credential-free origin without a path, query, or fragment when personal GitHub OAuth is enabled",
      );
    }
    if (
      !settings.publicBaseUrl?.startsWith("https://") &&
      !["local", "test"].includes(settings.environment)
    ) {
      throw new Error(
        "OPENGENI_PUBLIC_BASE_URL must use https when personal GitHub OAuth is enabled outside local/test",
      );
    }
    if (!settings.integrationsStateSecret) {
      throw new Error(
        "OPENGENI_INTEGRATIONS_STATE_SECRET is required when personal GitHub OAuth is enabled",
      );
    }
    if (!settings.environmentsEncryptionKey) {
      throw new Error(
        "OPENGENI_ENVIRONMENTS_ENCRYPTION_KEY is required when personal GitHub OAuth is enabled",
      );
    }
  }
  if (Boolean(settings.fikenClientId) !== Boolean(settings.fikenClientSecret)) {
    throw new Error(
      "OPENGENI_FIKEN_OAUTH_CLIENT_ID and OPENGENI_FIKEN_OAUTH_CLIENT_SECRET must be configured together",
    );
  }
  if (settings.fikenClientId) {
    if (!settings.publicBaseUrl) {
      throw new Error(
        "OPENGENI_PUBLIC_BASE_URL is required when the Fiken OAuth integration is configured",
      );
    }
    if (
      !settings.publicBaseUrl.startsWith("https://") &&
      !["local", "test"].includes(settings.environment)
    ) {
      throw new Error(
        "OPENGENI_PUBLIC_BASE_URL must use https when the Fiken OAuth integration is configured outside local/test",
      );
    }
    if (!settings.integrationsStateSecret) {
      throw new Error(
        "OPENGENI_INTEGRATIONS_STATE_SECRET is required when the Fiken OAuth integration is configured",
      );
    }
  }
  if (settings.googleDriveClientId) {
    if (!settings.integrationsEnabled) {
      throw new Error(
        "OPENGENI_INTEGRATIONS_ENABLED=true is required when the Google Drive integration is configured",
      );
    }
    if (!settings.publicBaseUrl) {
      throw new Error(
        "OPENGENI_PUBLIC_BASE_URL is required when the Google Drive integration is configured",
      );
    }
    if (!googleDriveOAuthCallbackUrl(settings.publicBaseUrl)) {
      throw new Error(
        "OPENGENI_PUBLIC_BASE_URL must be a credential-free origin without a path, query, or fragment when the Google Drive integration is configured",
      );
    }
    if (
      !settings.publicBaseUrl.startsWith("https://") &&
      !["local", "test"].includes(settings.environment)
    ) {
      throw new Error(
        "OPENGENI_PUBLIC_BASE_URL must use https when the Google Drive integration is configured outside local/test",
      );
    }
    if (!settings.integrationsStateSecret) {
      throw new Error(
        "OPENGENI_INTEGRATIONS_STATE_SECRET is required when the Google Drive integration is configured",
      );
    }
  }
  if (settings.googleDriveSyncMaxFileBytes > settings.googleDriveSyncMaxBytes) {
    throw new Error(
      "OPENGENI_GOOGLE_DRIVE_SYNC_MAX_FILE_BYTES must not exceed OPENGENI_GOOGLE_DRIVE_SYNC_MAX_BYTES",
    );
  }
  if (
    settings.googleDriveProviderRetryInitialDelayMs > settings.googleDriveProviderRetryMaxDelayMs
  ) {
    throw new Error(
      "OPENGENI_GOOGLE_DRIVE_PROVIDER_RETRY_INITIAL_DELAY_MS must not exceed OPENGENI_GOOGLE_DRIVE_PROVIDER_RETRY_MAX_DELAY_MS",
    );
  }
  if (settings.googleDriveProviderRetryInitialDelayMs > settings.googleDriveProviderRetryBudgetMs) {
    throw new Error(
      "OPENGENI_GOOGLE_DRIVE_PROVIDER_RETRY_INITIAL_DELAY_MS must not exceed OPENGENI_GOOGLE_DRIVE_PROVIDER_RETRY_BUDGET_MS",
    );
  }
  if (Boolean(settings.atlassianClientId) !== Boolean(settings.atlassianClientSecret)) {
    throw new Error(
      "OPENGENI_ATLASSIAN_CLIENT_ID and OPENGENI_ATLASSIAN_CLIENT_SECRET must be configured together",
    );
  }
  if (settings.atlassianClientId) {
    if (!settings.publicBaseUrl) {
      throw new Error(
        "OPENGENI_PUBLIC_BASE_URL is required when the Atlassian integration is configured",
      );
    }
    if (
      !settings.publicBaseUrl.startsWith("https://") &&
      !["local", "test"].includes(settings.environment)
    ) {
      throw new Error(
        "OPENGENI_PUBLIC_BASE_URL must use https when the Atlassian integration is configured outside local/test",
      );
    }
    if (!settings.integrationsStateSecret) {
      throw new Error(
        "OPENGENI_INTEGRATIONS_STATE_SECRET is required when the Atlassian integration is configured",
      );
    }
  }
  parseIntegrationsOauthClientsJson(settings.integrationsOauthClientsJson);
  parseSocialOauthClientsJson(settings.socialOauthClientsJson);
  if (
    settings.productAccessMode === "configured" &&
    !["local", "test"].includes(settings.environment) &&
    !settings.delegationSecret &&
    !settings.authRequired
  ) {
    throw new Error(
      "OPENGENI_PRODUCT_ACCESS_MODE=configured requires OPENGENI_DELEGATION_SECRET or OPENGENI_AUTH_REQUIRED=true outside local/test",
    );
  }
  if (settings.billingMode === "stripe") {
    if (!settings.stripeSecretKey || !settings.stripeWebhookSecret) {
      throw new Error(
        "OPENGENI_STRIPE_SECRET_KEY and OPENGENI_STRIPE_WEBHOOK_SECRET are required when OPENGENI_BILLING_MODE=stripe",
      );
    }
  }
  if (settings.productAccessMode !== "managed" && settings.billingMode === "stripe") {
    throw new Error("OPENGENI_BILLING_MODE=stripe requires OPENGENI_PRODUCT_ACCESS_MODE=managed");
  }
  if (settings.usageLimitsMode === "static") {
    const limits = configuredStaticUsageLimits(settings);
    if (Object.keys(limits).length === 0) {
      throw new Error(
        "OPENGENI_STATIC_USAGE_LIMITS_JSON must define at least one cap when OPENGENI_USAGE_LIMITS_MODE=static",
      );
    }
  } else {
    parseStaticUsageLimitsJson(settings.staticUsageLimitsJson);
  }
  if (settings.entitlementsMode === "static") {
    const entitlements = parseStaticEntitlementsJson(settings.staticEntitlementsJson);
    if (Object.keys(entitlements).length === 0) {
      throw new Error(
        "OPENGENI_STATIC_ENTITLEMENTS_JSON must define at least one feature when OPENGENI_ENTITLEMENTS_MODE=static",
      );
    }
  } else {
    parseStaticEntitlementsJson(settings.staticEntitlementsJson);
  }
  if (settings.authRequired && !settings.accessKey) {
    throw new Error("OPENGENI_ACCESS_KEY is required when OPENGENI_AUTH_REQUIRED=true");
  }
  if (settings.openaiProvider === "azure") {
    if (!settings.azureOpenaiBaseUrl && !settings.azureOpenaiEndpoint) {
      throw new Error(
        "Azure OpenAI requires OPENGENI_AZURE_OPENAI_BASE_URL or OPENGENI_AZURE_OPENAI_ENDPOINT",
      );
    }
    if (!settings.azureOpenaiBaseUrl && !settings.azureOpenaiDeployment) {
      throw new Error("Azure OpenAI endpoint mode requires OPENGENI_AZURE_OPENAI_DEPLOYMENT");
    }
    if (!settings.azureOpenaiBaseUrl && !settings.azureOpenaiApiVersion) {
      throw new Error("Azure OpenAI endpoint mode requires OPENGENI_AZURE_OPENAI_API_VERSION");
    }
    if (!settings.azureOpenaiApiKey && !settings.azureOpenaiAdToken) {
      throw new Error("Azure OpenAI requires an API key or AD token");
    }
  }
  // The Modal token is a both-or-neither pair regardless of the active backend
  // (a half-configured token is always a misconfiguration). This is orthogonal
  // to the backend-gated required-cred sweep below.
  if (Boolean(settings.modalTokenId) !== Boolean(settings.modalTokenSecret)) {
    throw new Error(
      "OPENGENI_MODAL_TOKEN_ID and OPENGENI_MODAL_TOKEN_SECRET must both be set or both omitted",
    );
  }
  // Backend-gated required credentials: only the *active* backend's creds are
  // required. A modal deployment must carry the Modal token; a daytona/e2b/none
  // deployment must NOT be forced to (and is not). Drives off the single
  // SANDBOX_REQUIRED_ENV table that the deployment package also mirrors.
  for (const required of SANDBOX_REQUIRED_ENV[settings.sandboxBackend] ?? []) {
    const value = settings[required.field];
    if (
      value === undefined ||
      value === null ||
      (typeof value === "string" && value.trim().length === 0)
    ) {
      throw new Error(
        `${required.env} is required when OPENGENI_SANDBOX_BACKEND=${settings.sandboxBackend}`,
      );
    }
  }
  if (
    settings.objectStorageBackend === "s3-compatible" ||
    settings.objectStorageBackend === "aws-s3"
  ) {
    if (
      Boolean(settings.objectStorageAccessKeyId) !== Boolean(settings.objectStorageSecretAccessKey)
    ) {
      throw new Error(
        "OPENGENI_OBJECT_STORAGE_ACCESS_KEY_ID and OPENGENI_OBJECT_STORAGE_SECRET_ACCESS_KEY must both be set or both omitted",
      );
    }
    if (
      settings.objectStorageBackend === "s3-compatible" &&
      (settings.objectStorageEndpoint ||
        settings.objectStorageInternalEndpoint ||
        settings.objectStorageSandboxEndpoint) &&
      (!settings.objectStorageAccessKeyId || !settings.objectStorageSecretAccessKey)
    ) {
      throw new Error(
        "S3-compatible object storage endpoints require OPENGENI_OBJECT_STORAGE_ACCESS_KEY_ID and OPENGENI_OBJECT_STORAGE_SECRET_ACCESS_KEY",
      );
    }
    if (
      settings.objectStorageAzureConnectionString ||
      settings.objectStorageAzureAccountName ||
      settings.objectStorageAzureAccountKey ||
      settings.objectStorageAzureEndpoint
    ) {
      throw new Error(
        "S3 object storage uses OPENGENI_OBJECT_STORAGE_* S3 settings, not OPENGENI_OBJECT_STORAGE_AZURE_* settings",
      );
    }
    if (
      settings.objectStorageGcsProjectId ||
      settings.objectStorageGcsCredentialsJson ||
      settings.objectStorageGcsKeyFilename ||
      settings.objectStorageGcsApiEndpoint
    ) {
      throw new Error(
        "S3 object storage uses OPENGENI_OBJECT_STORAGE_* S3 settings, not OPENGENI_OBJECT_STORAGE_GCS_* settings",
      );
    }
  } else if (settings.objectStorageBackend === "azure-blob") {
    if (
      settings.objectStorageEndpoint ||
      settings.objectStorageInternalEndpoint ||
      settings.objectStorageSandboxEndpoint ||
      settings.objectStorageAccessKeyId ||
      settings.objectStorageSecretAccessKey
    ) {
      throw new Error(
        "Azure Blob storage uses OPENGENI_OBJECT_STORAGE_AZURE_* settings, not S3-compatible object storage settings",
      );
    }
    if (
      settings.objectStorageGcsProjectId ||
      settings.objectStorageGcsCredentialsJson ||
      settings.objectStorageGcsKeyFilename ||
      settings.objectStorageGcsApiEndpoint
    ) {
      throw new Error(
        "Azure Blob storage uses OPENGENI_OBJECT_STORAGE_AZURE_* settings, not OPENGENI_OBJECT_STORAGE_GCS_* settings",
      );
    }
    const hasConnectionString = Boolean(settings.objectStorageAzureConnectionString);
    const hasSharedKey =
      Boolean(settings.objectStorageAzureAccountName) &&
      Boolean(settings.objectStorageAzureAccountKey);
    if (!hasConnectionString && !hasSharedKey) {
      throw new Error(
        "Azure Blob storage requires OPENGENI_OBJECT_STORAGE_AZURE_CONNECTION_STRING or OPENGENI_OBJECT_STORAGE_AZURE_ACCOUNT_NAME plus OPENGENI_OBJECT_STORAGE_AZURE_ACCOUNT_KEY",
      );
    }
  } else {
    if (
      settings.objectStorageEndpoint ||
      settings.objectStorageInternalEndpoint ||
      settings.objectStorageSandboxEndpoint ||
      settings.objectStorageAccessKeyId ||
      settings.objectStorageSecretAccessKey
    ) {
      throw new Error(
        "GCS object storage uses OPENGENI_OBJECT_STORAGE_GCS_* settings, not S3-compatible object storage settings",
      );
    }
    if (
      settings.objectStorageAzureConnectionString ||
      settings.objectStorageAzureAccountName ||
      settings.objectStorageAzureAccountKey ||
      settings.objectStorageAzureEndpoint
    ) {
      throw new Error(
        "GCS object storage uses OPENGENI_OBJECT_STORAGE_GCS_* settings, not OPENGENI_OBJECT_STORAGE_AZURE_* settings",
      );
    }
    if (settings.objectStorageGcsCredentialsJson) {
      parseGcsCredentialsJson(settings.objectStorageGcsCredentialsJson);
    }
  }
  if (settings.documentChunkOverlap >= settings.documentChunkSize) {
    throw new Error(
      "OPENGENI_DOCUMENT_CHUNK_OVERLAP must be smaller than OPENGENI_DOCUMENT_CHUNK_SIZE",
    );
  }
  parseExposedPorts(settings.dockerExposedPorts);
  sandboxEnvironmentVariableNames(settings);
  sandboxLifecycleHookIds(settings);
  // Fail fast on a malformed warm-rate table (P2.1).
  parseSandboxWarmRateJson(settings.sandboxWarmRateMicrosPerSecondJson);
  if (settings.sandboxBackend === "opensandbox") {
    if (!/@sha256:[0-9a-f]{64}$/i.test(settings.openSandboxImage ?? "")) {
      throw new Error(
        "OPENGENI_OPENSANDBOX_IMAGE must be an immutable OCI reference ending in @sha256:<64 hex characters>",
      );
    }
    if (!objectStorageConfiguredForWorkspaceArchives(settings)) {
      throw new Error(
        "OPENGENI_SANDBOX_BACKEND=opensandbox requires configured object storage for portable /workspace archives",
      );
    }
  }
  const serverIds = new Set<string>();
  for (const server of settings.mcpServers) {
    if (serverIds.has(server.id)) {
      throw new Error(`OPENGENI_MCP_SERVERS contains duplicate id ${server.id}`);
    }
    serverIds.add(server.id);
  }
  // --- sandbox lease cadence invariant (fail fast at boot) ---
  // Holder TTLs are provider-neutral. Modal's finite hard/idle clocks and
  // deadline rotation are validated only when Modal is active; renewable-TTL
  // providers such as OpenSandbox do not enter that deadline model.
  {
    const reaperPeriod = settings.sandboxLeaseReaperPeriodMs;
    const viewerTtl = settings.sandboxViewerHolderTtlMs;
    const interactionTtl = settings.sandboxInteractionHolderTtlMs;
    if (!(reaperPeriod < viewerTtl)) {
      throw new Error(
        `OPENGENI_SANDBOX_LEASE_REAPER_PERIOD_MS (${reaperPeriod}) must be strictly less than ` +
          `OPENGENI_SANDBOX_VIEWER_HOLDER_TTL_MS (${viewerTtl}): the reaper must run more often ` +
          `than the TTL it polices, or stale viewer holders outlive a full reaper period.`,
      );
    }
    if (!(reaperPeriod < interactionTtl)) {
      throw new Error(
        `OPENGENI_SANDBOX_LEASE_REAPER_PERIOD_MS (${reaperPeriod}) must be strictly less than ` +
          `OPENGENI_SANDBOX_INTERACTION_HOLDER_TTL_MS (${interactionTtl}): the reaper must run ` +
          `more often than the controller-heartbeat horizon.`,
      );
    }
    if (settings.sandboxBackend === "modal") {
      const idleGraceMs = settings.sandboxIdleGraceMs;
      const lifecycle = effectiveSandboxLifecycle(settings, "modal");
      const providerLifetimeMs = lifecycle.hardLifetimeMs!;
      const rotationLeadMs = lifecycle.rotationLeadMs!;
      const idleTimeoutMs = lifecycle.providerIdleTimeoutMs!;
      if (!(idleTimeoutMs <= providerLifetimeMs)) {
        throw new Error(
          `OPENGENI_MODAL_IDLE_TIMEOUT_SECONDS*1000 (${idleTimeoutMs}) must not exceed the hard provider ` +
            `lifetime (OPENGENI_MODAL_TIMEOUT_SECONDS*1000 = ${providerLifetimeMs}): the idle timeout is a ` +
            `floor under the hard lifetime, not above it.`,
        );
      }
      if (!(rotationLeadMs < providerLifetimeMs)) {
        throw new Error(
          `OPENGENI_SANDBOX_ROTATION_LEAD_MS (${rotationLeadMs}) must be strictly less than ` +
            `OPENGENI_MODAL_TIMEOUT_SECONDS*1000 (${providerLifetimeMs}).`,
        );
      }
      const captureTimeoutMs = sandboxArchiveCaptureTimeoutMs(settings);
      if (!(rotationLeadMs > captureTimeoutMs + reaperPeriod)) {
        throw new Error(
          `OPENGENI_SANDBOX_ROTATION_LEAD_MS (${rotationLeadMs}) must exceed the durable capture ` +
            `timeout plus one reaper period (${captureTimeoutMs + reaperPeriod}).`,
        );
      }
      if (!(viewerTtl < idleTimeoutMs)) {
        throw new Error(
          `OPENGENI_SANDBOX_VIEWER_HOLDER_TTL_MS (${viewerTtl}) must be strictly less than the effective box ` +
            `idle timeout (${idleTimeoutMs}): a viewer holder must be reapable before the box idles out from ` +
            `under it (the provider idle-timeout is the backstop).`,
        );
      }
      if (!(interactionTtl < idleTimeoutMs)) {
        throw new Error(
          `OPENGENI_SANDBOX_INTERACTION_HOLDER_TTL_MS (${interactionTtl}) must be strictly less than ` +
            `the effective box idle timeout (${idleTimeoutMs}): a dead browser controller must be ` +
            `reapable before the provider reclaims its placement.`,
        );
      }
      if (!(reaperPeriod + idleGraceMs < idleTimeoutMs)) {
        throw new Error(
          `OPENGENI_SANDBOX_LEASE_REAPER_PERIOD_MS + OPENGENI_SANDBOX_IDLE_GRACE_MS ` +
            `(${reaperPeriod} + ${idleGraceMs} = ${reaperPeriod + idleGraceMs}) must be strictly less than the ` +
            `effective box idle timeout (${idleTimeoutMs}): a drained box must SURVIVE its full warm window so ` +
            `the reaper can resume + snapshot /workspace + terminate it on the sweep AFTER the drain grace ` +
            `elapses — Modal's idle-reap must NOT fire first (or /workspace is lost). Raise ` +
            `OPENGENI_MODAL_IDLE_TIMEOUT_SECONDS (defaults to OPENGENI_MODAL_TIMEOUT_SECONDS) or lower ` +
            `OPENGENI_SANDBOX_IDLE_GRACE_MS.`,
        );
      }
    }
  }
  // --- stream-token secret: required-when-desktop, but GRACEFULLY DEGRADE (stream-token availability contract) ---
  // The desktop pixel plane needs an HMAC secret to mint scoped stream tokens.
  // It is REQUIRED when desktop is enabled — but per OD-8 a missing secret is NOT
  // a hard boot-fail: we emit a LOUD warning and the deployment ships with
  // DesktopStream.transport:null (resolveStreamTokenSecret returns undefined ->
  // negotiateCapabilities degrades the desktop cell). This keeps a desktop-
  // configured deployment bootable (headless + Channel-A still work) instead of
  // crashing the whole API on a missing secret.
  if (
    settings.sandboxDesktopEnabled &&
    settings.sandboxBackend === "modal" &&
    !["local", "test"].includes(settings.environment)
  ) {
    if (!isDigestPinnedModalDesktopImage(settings)) {
      throw new Error(
        "OPENGENI_MODAL_IMAGE_REF must be digest-pinned (registry/name@sha256:…) when " +
          "OPENGENI_SANDBOX_BACKEND=modal and OPENGENI_SANDBOX_DESKTOP_ENABLED=true. " +
          "Computer/Browser need docker/desktop.Dockerfile, not the official headless " +
          "opengeni-sandbox image. Helm desktop.imageRef writes this pin.",
      );
    }
  }
  if (settings.sandboxDesktopEnabled && resolveStreamTokenSecret(settings) === undefined) {
    console.warn(
      "[opengeni] OPENGENI_SANDBOX_DESKTOP_ENABLED=true but neither OPENGENI_STREAM_TOKEN_SECRET nor " +
        "OPENGENI_DELEGATION_SECRET is set: the desktop pixel plane will GRACEFULLY DEGRADE " +
        "(DesktopStream.transport=null — no scoped stream tokens can be minted). Set " +
        "OPENGENI_STREAM_TOKEN_SECRET to enable the live desktop stream.",
    );
  }
  if (settings.modelCatalogSource === "code") {
    validateModelCatalogSettings(settings, source);
  } else {
    // Database mode resolves membership asynchronously. Only the independent
    // deployment funding JSON is parsed here; env catalog and note inputs are
    // intentionally ignored until resolveCatalogSettings applies the singleton.
    parseModelCostPolicyJson(settings.modelCostPolicyJson);
  }
}

/** Validate one fully resolved, secret-bearing executable catalog. */
export function validateModelCatalogSettings(
  settings: Settings,
  source: NodeJS.ProcessEnv = process.env,
): ConfiguredModel[] {
  const costPolicy = parseModelCostPolicyJson(settings.modelCostPolicyJson);
  const notes = parseModelNotesJson(settings.modelNotesJson);
  const registryProviders = parseModelProvidersJson(settings.modelProvidersJson);
  const builtinId = builtinProviderId(settings);
  const providerIds = new Set<string>();
  for (const provider of registryProviders) {
    if (
      provider.kind === "vercel-gateway-managed" ||
      provider.kind === "vercel-gateway-workspace" ||
      provider.kind === "xai-subscription"
    ) {
      throw new Error(
        `OPENGENI_MODEL_PROVIDERS_JSON provider kind ${provider.kind} is reserved for a reviewed OpenGeni credential broker`,
      );
    }
    if (RESERVED_MODEL_PROVIDER_IDS.has(provider.id)) {
      throw new Error(
        `OPENGENI_MODEL_PROVIDERS_JSON provider id ${provider.id} is reserved for a reviewed OpenGeni provider`,
      );
    }
    if (provider.id === builtinId) {
      throw new Error(
        `OPENGENI_MODEL_PROVIDERS_JSON provider id ${provider.id} collides with the built-in provider id`,
      );
    }
    if (providerIds.has(provider.id)) {
      throw new Error(
        `OPENGENI_MODEL_PROVIDERS_JSON contains duplicate provider id ${provider.id}`,
      );
    }
    providerIds.add(provider.id);
    if (
      provider.kind !== "codex-subscription" &&
      provider.kind !== "anonymous" &&
      !resolveProviderApiKey(provider, source)
    ) {
      throw new Error(
        `OPENGENI_MODEL_PROVIDERS_JSON provider ${provider.id} requires a resolvable API key (set apiKey or apiKeyEnv)`,
      );
    }
  }
  // Materialize the normalized catalog at boot so canonical product ids,
  // aliases, definition digests, and capability/pricing normalization are
  // validated even when managed billing is disabled.
  const models = configuredModels(settings, source);
  const defaultCatalogSettings = settingsForTurnExecutionPolicy(settings, settings.openaiModel);
  const defaultCatalogModels =
    defaultCatalogSettings === settings ? models : configuredModels(defaultCatalogSettings, source);
  if (models.length === 0 && defaultCatalogModels.length === 0) {
    throw new Error("The resolved model catalog contains no executable models");
  }
  const defaultModelId = canonicalizeConfiguredModelId(
    defaultCatalogSettings,
    settings.openaiModel,
  );
  if (!defaultCatalogModels.some((model) => model.id === defaultModelId)) {
    throw new Error(
      `The default model ${settings.openaiModel} is not executable in the resolved model catalog`,
    );
  }

  const deploymentProductIds = new Set(
    models.filter((model) => model.credentialSource.kind === "deployment").map((model) => model.id),
  );
  const noteProductIds = new Set(models.map((model) => model.id));
  for (const model of configuredGatewayCatalogModels(settings)) {
    deploymentProductIds.add(model.productId);
    noteProductIds.add(model.productId);
    noteProductIds.add(model.workspaceProductId);
  }
  for (const model of configuredOpenRouterCatalogModels(settings)) {
    const productId = `${OPENROUTER_MODEL_ID_PREFIX}${model.upstreamModelId}`;
    deploymentProductIds.add(productId);
    noteProductIds.add(productId);
  }
  if (settings.modelCatalogSource === "code") {
    for (const productId of Object.keys(costPolicy)) {
      if (!deploymentProductIds.has(productId)) {
        throw new Error(
          `OPENGENI_MODEL_COST_POLICY_JSON references unknown deployment model ${productId}`,
        );
      }
    }
  }
  for (const productId of Object.keys(notes)) {
    if (!noteProductIds.has(productId)) {
      throw new Error(`OPENGENI_MODEL_NOTES_JSON references unknown catalog model ${productId}`);
    }
  }

  if (settings.billingMode === "stripe" || settings.usageLimitsMode === "managed") {
    const pricing = configuredModelPricing(settings);
    const missing = models
      .filter((model) => model.cost === "credits" && !pricing[model.id])
      .map((model) => model.id);
    if (missing.length > 0) {
      throw new Error(
        `Missing model pricing for managed billing model(s): ${missing.join(", ")}. Set OPENGENI_MODEL_PRICING_JSON.`,
      );
    }
  }
  return models;
}

/**
 * Resolve the secret used to sign/verify scoped stream tokens (sandbox contract
 * §C.3). Falls back to `delegationSecret` (the same HMAC envelope family —
 * `ogs_` vs `ogd_` prefix) so a deployment that already carries a delegation
 * secret does not need a second one. Returns undefined when neither is set,
 * which drives the graceful-degrade (DesktopStream.transport:null).
 */
export function resolveStreamTokenSecret(settings: Settings): string | undefined {
  const explicit = settings.streamTokenSecret?.trim();
  if (explicit) {
    return explicit;
  }
  const delegation = settings.delegationSecret?.trim();
  return delegation ? delegation : undefined;
}

/**
 * True iff the desktop pixel plane must GRACEFULLY DEGRADE because desktop is
 * enabled but no stream-token secret is resolvable (stream-token availability contract). When true,
 * negotiateCapabilities forces DesktopStream.transport:null.
 */
export function streamTokenDegraded(settings: Settings): boolean {
  return settings.sandboxDesktopEnabled && resolveStreamTokenSecret(settings) === undefined;
}

/**
 * Resolve the secret the control plane signs the enrollment bearer credential
 * with (the `oge_` envelope the agent presents back — M5). Falls
 * back to `delegationSecret` (the same HMAC envelope family) so a deployment that
 * already carries a delegation secret needs no second one. Returns undefined when
 * neither is set; when selfhosted is enabled but this is undefined, the poll route
 * reports the credential plane disabled (graceful degrade, never a 500). NEVER log
 * the returned value.
 */
export function resolveEnrollmentSigningSecret(settings: Settings): string | undefined {
  const explicit = settings.enrollmentSigningSecret?.trim();
  if (explicit) {
    return explicit;
  }
  const delegation = settings.delegationSecret?.trim();
  return delegation ? delegation : undefined;
}

/**
 * Resolve the HMAC secret the control plane signs the agent's relay PRODUCER token
 * with (the `ogr_` envelope; M8b). The RELAY verifies the producer
 * token with the SAME secret (injected into the relay via env). Prefers an explicit
 * `selfhostedRelayTokenSecret`, then the `streamTokenSecret` (the relay already
 * needs that one to verify the viewer's `ogs_` token, so a single secret can back
 * both planes), then `delegationSecret` (same HMAC family). Returns undefined when
 * none is set — the enrollment poll then returns an empty relayToken (graceful
 * degrade; the stream plane is unavailable until configured). NEVER log the value.
 */
export function resolveRelayTokenSecret(settings: Settings): string | undefined {
  const explicit = settings.selfhostedRelayTokenSecret?.trim();
  if (explicit) {
    return explicit;
  }
  const stream = settings.streamTokenSecret?.trim();
  if (stream) {
    return stream;
  }
  const delegation = settings.delegationSecret?.trim();
  return delegation ? delegation : undefined;
}

/**
 * The resolved NATS auth-callout responder config (M-AUTH). Present only when the
 * callout plane is FULLY configured: the account signing seed + the responder's own
 * login. When any piece is missing this returns null and the responder does not
 * start (selfhosted agents cannot connect — a graceful disabled state, never a boot
 * crash). The returned `accountSeed` is a secret; NEVER log it.
 */
export interface NatsCalloutConfig {
  /** The callout account SIGNING seed (`SA...`) — signs the user + response JWTs. */
  accountSeed: string;
  /** The target account NAME the user is placed into (the response `aud`). */
  accountName: string;
  /** The responder's NATS login (an `auth_callout.auth_users` user). */
  user: string;
  password: string;
}

export function resolveNatsCalloutConfig(settings: Settings): NatsCalloutConfig | null {
  const accountSeed = settings.selfhostedNatsCalloutAccountSeed?.trim();
  const accountName = settings.selfhostedNatsCalloutAccountName?.trim() || "APP";
  const user = settings.selfhostedNatsCalloutUser?.trim();
  const password = settings.selfhostedNatsCalloutPassword?.trim();
  if (!accountSeed || !user || !password) {
    return null;
  }
  return { accountSeed, accountName, user, password };
}

/**
 * The PRIVILEGED control-plane NATS login (api/worker). Present only when BOTH a
 * user and password are set; otherwise null and the bus connects anonymously (local
 * dev / a NATS without auth_callout). When the callout plane is on, this is the
 * static account user permitted to request exact generation-fenced agent RPC subjects.
 */
export interface NatsControlPlaneAuth {
  user: string;
  password: string;
}

export function resolveNatsControlPlaneAuth(settings: Settings): NatsControlPlaneAuth | null {
  const user = settings.selfhostedNatsControlUser?.trim();
  const password = settings.selfhostedNatsControlPassword?.trim();
  if (!user || !password) {
    return null;
  }
  return { user, password };
}

function splitCsv(raw: string): string[] {
  return raw
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
}

function uniqueEnvNames(raw: string[], fieldName: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const name of raw) {
    if (!envName.test(name)) {
      throw new Error(`${fieldName} contains invalid variable name ${name}`);
    }
    if (!seen.has(name)) {
      seen.add(name);
      out.push(name);
    }
  }
  return out;
}

function uniqueValues(raw: string[]): string[] {
  return [...new Set(raw.filter(Boolean))];
}

function parseGcsCredentialsJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`OPENGENI_OBJECT_STORAGE_GCS_CREDENTIALS_JSON must be valid JSON: ${message}`, {
      cause: error,
    });
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

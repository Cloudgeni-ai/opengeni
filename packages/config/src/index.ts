import {
  BillingMode,
  CAPABILITY_DESCRIPTORS,
  Entitlements,
  EntitlementsMode,
  ProductAccessMode,
  ReasoningEffort,
  SandboxBackend,
  StaticUsageLimits,
  UsageLimitsMode,
} from "@opengeni/contracts";
import { CODEX_MODEL_ID_PREFIX } from "@opengeni/codex/constants";
import { z } from "zod";

const envName = /^[A-Za-z_][A-Za-z0-9_]*$/;
const registryId = /^[A-Za-z0-9_-]+$/;
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
  "Repository resources are mounted under repos/<owner>/<repo>.",
  "File resources are mounted under files/<file-id>/ unless the session specifies another mount path.",
  "Attached files are mounted read-only; copy them before modifying.",
  "Bundled skills are under .agents/ and can include infrastructure, marketing, or other role-specific guidance.",
  "Use Checkov, Terraform, Azure CLI, git provider CLIs, and repository tools when relevant; gh, glab, and az repos are pre-authenticated when the host brokers matching git credentials.",
  "When the Azure sandbox preparation profile is enabled and service-principal variables are present, the sandbox is pre-authenticated with normal Azure CLI before work starts.",
  "Treat code-changing work as GitOps work: create a focused branch/commit/PR when git provider credentials are available; otherwise report exact commands and blockers.",
  "Return concise, factual summaries with files changed, commands run, and remaining blockers.",
  AGENT_INSTRUCTIONS_CORE_PLACEHOLDER,
].join(" ");

export const McpServerConnectionRefSchema = z.object({
  connectionId: z.string().uuid().optional(),
  providerDomain: z.string().min(1),
  kind: z.enum(["oauth2", "api_key", "app_install", "delegated"]).optional(),
  scopes: z.array(z.string().min(1)).optional(),
  resource: z.string().min(1).optional(),
  subjectScope: z.enum(["workspace", "subject"]).optional(),
}).strict();
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
  // query resolves into the dedicated schema with NO query rewrite (SPIKE-1 F1).
  dbSchema: z.string().default(""),
  // Step I (§7.7). RLS posture. "force" (default) = today's FORCE-RLS via the
  // non-owner `opengeni_app` role. "scoped" = the embedded owner-role path (the
  // GUC is still emitted defensively, so the query path is identical).
  rlsStrategy: z.enum(["force", "scoped"]).default("force"),
  natsUrl: z.string().default("nats://127.0.0.1:4222"),
  temporalHost: z.string().default("127.0.0.1:7233"),
  temporalNamespace: z.string().default("default"),
  temporalTaskQueue: z.string().default("opengeni-runs-ts"),
  startupDependencyRetryAttempts: z.coerce.number().int().positive().default(30),
  startupDependencyRetryInitialDelayMs: z.coerce.number().int().positive().default(1000),
  startupDependencyRetryMaxDelayMs: z.coerce.number().int().positive().default(5000),
  observabilityStructuredLogs: EnvBoolean.default(false),
  observabilityMetricsEnabled: EnvBoolean.default(true),
  observabilityOtlpEndpoint: z.string().url().optional(),
  observabilityOtlpHeaders: z.string().default(""),
  publicBaseUrl: z.string().url().optional(),
  // Base URL for the bring-your-own-compute agent release assets the get.<domain>
  // install routes redirect to. Defaults to this repo's GitHub Releases. The route
  // appends `/download/agent-v<ver>/<asset>` (or `/latest/download/<asset>`).
  agentReleasesBaseUrl: z.string().url().default("https://github.com/Cloudgeni-ai/opengeni/releases"),
  productAccessMode: ProductAccessMode.default("local"),
  billingMode: BillingMode.default("disabled"),
  entitlementsMode: EntitlementsMode.default("none"),
  usageLimitsMode: UsageLimitsMode.default("none"),
  staticEntitlementsJson: z.string().default("{}"),
  staticUsageLimitsJson: z.string().default("{}"),
  delegationSecret: z.string().optional(),
  // Sandbox-surfacing scoped stream-token HMAC secret (master-spine §C.3 / I8).
  // When unset, the API falls back to `delegationSecret` (the same HMAC envelope
  // family, `ogs_` vs `ogd_` prefix). REQUIRED-WHEN-DESKTOP, but the absence of
  // BOTH while sandboxDesktopEnabled=true is a GRACEFUL DEGRADE (DesktopStream
  // transport:null + a loud boot warning), NOT a hard boot-fail (I8/OD-8).
  streamTokenSecret: z.string().optional(),
  // The desktop input plane (raw stream:control writes) is OFF in v1: even a
  // holder of stream:control gets 403 until this flips. Keeps stream:control a
  // declared-but-inert permission so later hardening is a flag flip.
  streamControlEnabled: EnvBoolean.default(false),
  toolspaceEnabled: EnvBoolean.default(false),
  toolspaceMaxCallsPerTurn: z.coerce.number().int().positive().default(200),
  environmentsEncryptionKey: z.string().optional(),
  integrationsEnabled: EnvBoolean.default(false),
  integrationsStateSecret: z.string().optional(),
  integrationsAllowPrivateNetworkTargets: EnvBoolean.default(false),
  integrationsOauthClientsJson: z.string().default("{}"),
  // Session goal guard rails. Goals are designed for runs that legitimately
  // span days, so length is bounded by pathology detection (no-progress
  // streaks, budget exhaustion), never by count. goalMaxAutoContinuations is
  // therefore UNSET by default (no cap); deployments may configure one, and
  // it then acts as a hard ceiling that per-goal overrides can only lower.
  goalMaxAutoContinuations: z.coerce.number().int().positive().optional(),
  goalNoProgressLimit: z.coerce.number().int().positive().default(3),
  // Per-segment ceiling on agent loop turns (model calls) within a single
  // session turn. Effectively unbounded by default for the same reason as
  // above; the graceful max-turns valve (idle + goal continuation, never a
  // session failure) remains as inert safety should a deployment set a cap.
  agentMaxModelCallsPerTurn: z.coerce.number().int().positive().default(1_000_000),
  // Where turn-input conversation history comes from (issue #35):
  // "items" (default) = the session_history_items table (SDK-native,
  // version-stable conversation truth); "run_state" = the legacy serialized
  // RunState blob. Items and the sandbox envelope are dual-written
  // unconditionally; this flag governs the read path only, so flipping back to
  // "run_state" remains a safe rollback at any time.
  sessionHistorySource: z.enum(["run_state", "items"]).default("items"),
  // Provider-aware conversation context management (long-lived sessions
  // otherwise grow unbounded until they overflow the model context window and
  // hard-fail every turn). Resolution (see resolveContextCompactionMode):
  //   "auto" (default) -> "server" when openaiProvider === "openai" (the
  //     OpenAI platform Responses API honors server-side context_management),
  //     else "client" (Azure rejects context_management with a 400, so we run
  //     our own client-side compaction).
  //   "server" / "client" -> force that path regardless of provider.
  //   "off" -> neither path (legacy unbounded growth; escape hatch only).
  contextCompactionMode: z.enum(["auto", "server", "client", "off"]).default("auto"),
  // The model's real context window in tokens. gpt-5.5's true window is
  // 1,050,000; it is absent from the SDK's hardcoded compaction window map (it
  // knows only up to gpt-5.4), so the SDK's DynamicCompactionPolicy would fall
  // back to a wrong 240k. We pass an explicit StaticCompactionPolicy threshold
  // derived from these settings on the server path, and use the same numbers to
  // budget the client path.
  contextWindowTokens: z.coerce.number().int().positive().default(1_050_000),
  // Proactive compaction threshold as a ratio of the model context window.
  // Defaults to 60% and is clamped to [0.3, 0.9] so deployments can tune the
  // trigger without accidentally disabling compaction or waiting until the
  // provider is already at the cliff.
  contextCompactionThresholdRatio: z.coerce.number().default(0.6).transform((value) => {
    if (!Number.isFinite(value)) {
      return 0.6;
    }
    return Math.min(0.9, Math.max(0.3, value));
  }),
  // Tokens reserved for model output; subtracted from the window to get the
  // usable input budget B = contextWindowTokens - contextReservedOutputTokens.
  contextReservedOutputTokens: z.coerce.number().int().nonnegative().default(128_000),
  // Server path only: explicit compact_threshold (tokens) handed to the SDK's
  // StaticCompactionPolicy. Defaults to floor(contextWindowTokens *
  // contextCompactionThresholdRatio) when unset.
  contextServerCompactThresholdTokens: z.coerce.number().int().positive().optional(),
  // Deprecated back-compat knobs. The threshold is now controlled by
  // contextCompactionThresholdRatio; these remain parsed so older deployments do
  // not fail boot when their env still contains them.
  contextCompactSoftFraction: z.coerce.number().positive().max(1).default(0.70),
  contextCompactHardFraction: z.coerce.number().positive().max(1).default(0.85),
  // Deprecated for the client path; parsed for env/back-compat only.
  contextKeepRecentTokens: z.coerce.number().int().positive().default(32_000),
  // Parsed for back-compat. Client compaction uses the fixed 20k Codex summary
  // buffer as its generated-summary output ceiling.
  contextSummaryMaxTokens: z.coerce.number().int().positive().default(20_000),
  authRequired: EnvBoolean.default(false),
  accessKey: z.string().optional(),
  authAllowHealth: EnvBoolean.default(true),
  authAllowMetrics: EnvBoolean.default(false),
  apiHost: z.string().default("0.0.0.0"),
  apiPort: z.coerce.number().int().positive().default(8000),
  workerHttpPort: z.coerce.number().int().positive().default(8001),
  opengeniMcpUrl: z.string().url().optional(),
  corsAllowOriginRegex: z.string().default(String.raw`^https?://(localhost|127\.0\.0\.1)(:\d+)?$`),
  openaiProvider: z.enum(["openai", "azure"]).default("openai"),
  openaiApiKey: z.string().optional(),
  openaiBaseUrl: z.string().optional(),
  openaiModel: z.string().default("gpt-5.5"),
  openaiAllowedModels: z.string().default("gpt-5.5,gpt-5.4,gpt-5.4-mini"),
  modelPricingJson: z.string().default("{}"),
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
  codexSubscriptionEnabled: EnvBoolean.default(false),  // OPENGENI_CODEX_SUBSCRIPTION_ENABLED
  codexProductSku: z.string().optional(),               // OPENGENI_CODEX_PRODUCT_SKU (X-OpenAI-Product-Sku, apps only)
  // Progressive connector disclosure (Codex-CLI-style tool_search): on a codex
  // turn, flag the ~217 codex_apps connector tools `defer_loading:true` (dropping
  // their schemas from model context) and add one client-executed tool_search
  // tool that BM25-discloses only the matching connectors. Default OFF — a codex
  // turn is byte-for-byte unchanged until enabled. OPENGENI_CODEX_TOOL_SEARCH_ENABLED
  codexToolSearchEnabled: EnvBoolean.default(false),
  // Multi-account P3 (auto-rotation): an account is "near exhaustion" — ineligible to be
  // rotated TO — when EITHER usage window (5h/weekly) is at/over this percent. Default 90 to
  // match the UI danger flip (UsageBar danger at pct >= 90). OPENGENI_CODEX_ROTATION_NEAR_EXHAUSTION_PCT.
  codexRotationNearExhaustionPct: z.coerce.number().int().min(1).max(100).default(90),
  openaiReasoningEffort: ReasoningEffort.default("low"),
  openaiAllowedReasoningEfforts: z.string().default("low,medium,high,xhigh"),
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
  dockerExposedPorts: z.string().default(""),
  dockerNetwork: z.string().optional(),
  modalAppName: z.string().default("opengeni-sandbox"),
  modalImageRef: z.string().optional(),
  // Name of a Modal Secret (containing REGISTRY_USERNAME + REGISTRY_PASSWORD) used
  // to authenticate the pull of `modalImageRef` from a PRIVATE registry. When UNSET
  // (the default), the sandbox image is pulled UNAUTHENTICATED — i.e. it must be a
  // PUBLIC registry tag, which is the only shape the Agents-extension Modal backend
  // supports out of the box (`Image.fromRegistry(tag)` with no secret). Set this to
  // run a private image (e.g. a cloud-hosted ACR/ECR/GCR digest): the runtime resolves
  // the named Secret and builds the image via `fromRegistry(tag, secret)` before the
  // first sandbox is created. Knob: OPENGENI_MODAL_IMAGE_REGISTRY_SECRET.
  modalImageRegistrySecret: z.string().optional(),
  // Modal's hard sandbox lifetime (timeoutMs = this * 1000), counted from each
  // create/resume — it is the BACKSTOP that reclaims a box if the reaper/worker is
  // down, NOT the warm-window controller (that's sandboxIdleGraceMs). It must
  // comfortably exceed reaperPeriod + idleGrace so the reaper terminates a
  // genuinely-idle box FIRST; the boot invariant below enforces that. Default 1h
  // (was 900s/15min): the 15-min drain grace counts from the user's LAST release,
  // but Modal's clock starts at the preceding turn's resume — so a 15-min grace on
  // top of a 900s lifetime would let Modal kill the box mid-warm-window. 3600s
  // leaves ~45min of headroom for the active turn before the warm window opens.
  // Knob: OPENGENI_MODAL_TIMEOUT_SECONDS.
  modalTimeoutSeconds: z.coerce.number().int().positive().default(3600),
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
  // /workspace FILE PERSISTENCE across warm/cold cycles. Defaults to
  // `snapshot_filesystem` so EVERY box is created persistence-capable: the reaper
  // snapshots the live box before it terminates a drained group, and a later
  // cold-restore hydrates a fresh box from that snapshot (sandbox-file-persistence).
  // `snapshot_filesystem` requires the manifest declare NO ephemeralPersistencePaths
  // (buildManifest never sets entry.ephemeral, so it never downgrades to tar). Set
  // OPENGENI_MODAL_WORKSPACE_PERSISTENCE=tar to opt back out (no native snapshot;
  // the reaper persists a tar archive — same store+hydrate plumbing, slower).
  modalWorkspacePersistence: z
    .enum(["tar", "snapshot_filesystem", "snapshot_directory"])
    .default("snapshot_filesystem"),
  // Snapshot GC backstop (sandbox-file-persistence): the reaper keeps ONE latest
  // filesystem snapshot per lease (delete-prior-on-supersede + delete-on-teardown).
  // This is the TTL retention floor for the periodic orphan sweep — a snapshot
  // whose lease is cold and older than this is best-effort deleted so a crashed
  // persist-then-no-restore never leaks a Modal image. 0 disables the TTL sweep
  // (delete-on-supersede/teardown still run). Default 7 days.
  modalSnapshotRetentionSeconds: z.coerce.number().int().nonnegative().default(604_800),
  // Shared desktop toggle: this module reads it for the 6080 port-merge; the
  // owner module (P4.x) acts on it to launch the display stack.
  sandboxDesktopEnabled: EnvBoolean.default(false),
  // Human take-control toggle: when ON (default) the negotiated DesktopStream
  // cell advertises mode "interactive" — the noVNC viewer can drive mouse+keyboard
  // into :0 (x11vnc runs without -viewonly). Turn it OFF for a genuinely read-only
  // deployment: the cell reports mode "read-only" and the client disables the
  // "Take control" affordance. Independent of computerUseReadOnly (the AGENT
  // driver); this gates the HUMAN viewer plane.
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
  // P4.3 computer-use: the agent drives the SAME :0 humans watch (xdotool/XTEST +
  // scrot). Gated by sandboxDesktopEnabled + a desktop-capable backend in
  // buildAgentCapabilities; computerUseReadOnly:false is the agent-driver default
  // (it must click/type — the human viewer plane is the read-only one).
  computerUseEnabled: EnvBoolean.default(true),
  computerUseReadOnly: EnvBoolean.default(false),
  // P4.3 recording loop: ffmpeg x11grab of :0 → mp4/webm → @opengeni/storage.
  // recordingMaxBytes caps the in-memory finalize buffer (≤ storage single-PUT);
  // recordingMaxSeconds is the ffmpeg -t hard ceiling (bounds a multi-day turn).
  recordingEnabled: EnvBoolean.default(true),
  recordingDefaultCodec: z.enum(["h264-mp4", "vp9-webm"]).default("h264-mp4"),
  // Workbench v2 turn-end workspace capture (dossier §10.1). When on, the turn
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
  // --- vercel (headless) ---
  vercelToken: z.string().optional(),
  vercelProjectId: z.string().optional(),
  vercelTeamId: z.string().optional(),
  vercelRuntime: z.string().optional(),
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
  // the deploy-staging IaC secret/configmap pattern (dossier §17/§25.1).
  sandboxSelfhostedEnabled: EnvBoolean.default(false),
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
  // (the `ogr_` envelope threaded into EnrollmentCredentials.relayToken; M8b/dossier
  // §10.5). The relay verifies the producer token with the SAME secret. Optional:
  // when ABSENT the poll returns an empty relayToken (graceful degrade — the stream
  // plane is simply unavailable until configured). Falls back to streamTokenSecret /
  // delegationSecret (same HMAC family) so a deployment with a stream-token secret
  // needs no second one. NEVER logged. Lives in the opengeni-runtime secret.
  selfhostedRelayTokenSecret: z.string().optional(),
  // The minisign PUBLIC key the agent pins for self-update verification (handed to
  // the agent in EnrollmentCredentials; the SECRET key lives only in CI).
  agentUpdatePublicKey: z.string().optional(),
  // --- NATS auth-callout tenancy boundary (bring-your-own-compute M-AUTH; dossier
  //     §10.1 NATS Accounts per workspace + §17 the isolation smoke) -------------
  // nats-server is configured with AUTH CALLOUT: an external agent connects
  // presenting its `oge_` enrollment bearer as the connect auth-token; the server
  // issues an authorization request on $SYS.REQ.USER.AUTH to our responder, which
  // validates the bearer and returns a SIGNED NATS user JWT scoped to pub/sub ONLY
  // `agent.<ws>.>` (+ `_INBOX.>`). That per-subject scope IS the per-workspace
  // isolation. These are deployment-level secrets in the opengeni-runtime secret
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
  // privileged control plane connects into, so `agent.<ws>.<id>.rpc` request/reply
  // routes. Optional; resolveNatsCalloutConfig defaults it to "APP".
  selfhostedNatsCalloutAccountName: z.string().optional(),
  // The callout RESPONDER's own NATS login (one of the `auth_callout.auth_users`
  // in the AUTH account) — the responder connects with this to subscribe
  // $SYS.REQ.USER.AUTH. Username/password.
  selfhostedNatsCalloutUser: z.string().optional(),
  selfhostedNatsCalloutPassword: z.string().optional(),
  // The PRIVILEGED control-plane login (api/worker): a static account user that may
  // request `agent.*.rpc` + receive its inbox replies. The event bus + the
  // selfhosted control RPC ride THIS connection. Username/password; when unset the
  // bus connects anonymously (local dev / a NATS with no auth_callout).
  selfhostedNatsControlUser: z.string().optional(),
  selfhostedNatsControlPassword: z.string().optional(),
  // --- sandbox lease cadences (cadence invariant validated at boot below) ---
  // reaperPeriod < viewerHolderTTL, and reaperPeriod + idleGrace < the EFFECTIVE
  // box idle timeout (effectiveModalIdleTimeoutSeconds, which defaults to the hard
  // modalTimeoutSeconds). No keep-alive loop: between turns the box survives on its
  // idle timeout — which we pin high enough (via the idle-timeout default) that
  // OpenGeni's reaper, not Modal's idle-reap, governs teardown so /workspace is
  // snapshotted before the box dies (sandbox-file-persistence).
  sandboxLeaseReaperPeriodMs: z.coerce.number().int().positive().default(30_000),
  sandboxViewerHolderTtlMs: z.coerce.number().int().positive().default(90_000),
  // The DRAIN grace: how long a refcount-0 (draining) lease stays WARM before the
  // reaper resume-by-ids the box and terminates it. This is the cost-vs-snappiness
  // dial — when the user navigates away the box keeps refcount 0, but it survives
  // this whole window so a "glanced away then came back" re-arms the SAME warm box
  // (acquireLease re-arms draining->warm; the reaper's BEFORE-terminate re-read
  // skips a re-armed box). Default 15min so a brief detour never cold-creates a
  // fresh EMPTY box; lower it to trade warm cost for a snappier reclaim. Knob:
  // OPENGENI_SANDBOX_IDLE_GRACE_MS.
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
  sandboxSnapshotTimeoutMs: z.coerce.number().int().positive().default(60_000),
  // expires_at refresh window for a held lease (>> the turn 10s heartbeat so a
  // single missed heartbeat never TTL-reaps a live turn). The warming TTL is the
  // window a cold->warming spawner has to commit warm before a reaper resets it.
  sandboxLeaseTtlMs: z.coerce.number().int().positive().default(90_000),
  sandboxLeaseWarmingTtlMs: z.coerce.number().int().positive().default(120_000),
  // Overall user-facing budget for warming a sandbox lease. Unlike the lease TTL
  // (a liveness/reaper cadence), this bounds how long one turn waits for capacity
  // or provider creation before surfacing a clear turn.failed error.
  sandboxWarmingTimeoutMs: z.coerce.number().int().positive().default(600_000),
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
  objectStorageSandboxEndpoint: z.string().url().optional(),
  objectStorageBackend: z.enum(["s3-compatible", "aws-s3", "azure-blob", "gcs"]).default("s3-compatible"),
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
  gitAuthorName: z.string().optional(),
  gitAuthorEmail: z.string().optional(),
  gitCommitterName: z.string().optional(),
  gitCommitterEmail: z.string().optional(),
  githubAppManifestBaseUrl: z.string().optional(),
  githubAppManifestStateSecret: z.string().optional(),
  githubAppId: z.string().optional(),
  githubClientId: z.string().optional(),
  githubClientSecret: z.string().optional(),
  githubAppSlug: z.string().optional(),
  githubWebhookSecret: z.string().optional(),
  githubAppPrivateKey: z.string().optional(),
  betterAuthSecret: z.string().optional(),
  betterAuthAllowedHosts: z.string().default(""),
  betterAuthCookieDomain: z.string().optional(),
  betterAuthTrustedOrigins: z.string().default(""),
  resendApiKey: z.string().optional(),
  emailFrom: z.string().default("OpenGeni <auth@mail.opengeni.ai>"),
  stripeSecretKey: z.string().optional(),
  stripePublishableKey: z.string().optional(),
  stripeWebhookSecret: z.string().optional(),
  stripeCreditsProductId: z.string().optional(),
  mcpServers: z.array(z.object({
    id: z.string().min(1).regex(registryId),
    name: z.string().min(1).optional(),
    url: z.string().url(),
    allowedTools: z.array(z.string().min(1)).optional(),
    timeoutMs: z.number().int().positive().optional(),
    cacheToolsList: z.boolean().default(false),
    /**
     * Human-approval policy for this server's tools, overlaid per-run from a
     * session MCP server row (never from OPENGENI_MCP_SERVERS). `true` = all
     * tools require approval; a string[] = only the listed UNPREFIXED tool
     * names do; absent = auto-run (the historical default). Enforced in the
     * runtime by attaching `needsApproval` to the matching MCP tools.
     */
    requireApproval: z.union([z.boolean(), z.array(z.string().min(1))]).optional(),
    /**
     * Extra request headers sent to this MCP server (credential injection
     * for workspace-enabled capability MCPs). Populated at runtime from
     * encrypted capability-installation credentials; do not put secrets in
     * OPENGENI_MCP_SERVERS.
     */
    headers: z.record(z.string(), z.string()).optional(),
    connectionRef: McpServerConnectionRefSchema.optional(),
  })).default([]),
});

export type Settings = z.infer<typeof SettingsSchema>;
export type McpServerConfig = Settings["mcpServers"][number];
export type ModelPricing = {
  inputMicrosPerMillionTokens: number;
  cachedInputMicrosPerMillionTokens?: number | undefined;
  outputMicrosPerMillionTokens: number;
  marginBps?: number | undefined;
};
export type ModelUsageInput = {
  inputTokens?: number | undefined;
  outputTokens?: number | undefined;
  totalTokens?: number | undefined;
  inputTokensDetails?: Record<string, number> | Array<Record<string, number>> | undefined;
  requestUsageEntries?: ModelUsageInput[] | undefined;
};

export type StaticUsageLimitsConfig = StaticUsageLimits;
export type EntitlementsConfig = Entitlements;

const ModelPricingSchema = z.object({
  inputMicrosPerMillionTokens: z.number().int().nonnegative(),
  cachedInputMicrosPerMillionTokens: z.number().int().nonnegative().optional(),
  outputMicrosPerMillionTokens: z.number().int().nonnegative(),
  marginBps: z.number().int().min(0).max(100_000).optional(),
});

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
 * Registry provider kind. "api-key" providers carry their own static key/headers;
 * "codex-subscription" providers authenticate per-request with a ChatGPT/Codex
 * subscription token resolved at call time (no static key) — see @opengeni/codex.
 */
export const RegistryProviderKind = z.enum(["api-key", "codex-subscription"]);
export type RegistryProviderKind = z.infer<typeof RegistryProviderKind>;

/** A single model exposed by a registry provider. */
const RegistryModelSchema = z.object({
  id: z.string().min(1),                 // model id sent to the provider, e.g. "accounts/fireworks/models/glm-5p2"
  label: z.string().min(1).optional(),   // display name; defaults to id
  contextWindowTokens: z.number().int().positive().optional(),
  reasoningEffort: z.boolean().optional(),  // model accepts a reasoning-effort control
  hostedWebSearch: z.boolean().optional(),  // provider executes the hosted web_search tool for this model
  pricing: ModelPricingSchema.optional(),
});

/** A non-built-in provider declared by the host via OPENGENI_MODEL_PROVIDERS_JSON. */
const RegistryProviderSchema = z.object({
  kind: RegistryProviderKind.default("api-key"),  // "codex-subscription" => per-request token, no static key
  id: z.string().min(1).regex(registryId),  // stable provider id, e.g. "fireworks"
  label: z.string().min(1).optional(),
  api: ModelProviderApi.default("chat"),
  baseUrl: z.string().url(),
  apiKey: z.string().optional(),         // inline key (pragmatic) ...
  apiKeyEnv: z.string().optional(),      // ... OR name of the env var holding the key (preferred)
  defaultQuery: z.record(z.string(), z.string()).optional(),
  defaultHeaders: z.record(z.string(), z.string()).optional(),
  models: z.array(RegistryModelSchema).min(1),
});
export type RegistryProvider = z.infer<typeof RegistryProviderSchema>;

export const IntegrationOAuthClientConfigSchema = z.object({
  clientId: z.string().min(1),
  clientSecret: z.string().min(1).optional(),
  tokenEndpointAuthMethod: z.enum(["none", "client_secret_post", "client_secret_basic"]).default("none"),
});
export type IntegrationOAuthClientConfig = z.infer<typeof IntegrationOAuthClientConfigSchema>;

/**
 * Runtime-resolved provider (built-in or registry), client-construction-ready.
 * The built-in OpenAI/Azure provider is always present and always "responses";
 * registry providers carry their own base URL / key / wire API. compactionMode
 * is "server" only for the built-in OpenAI platform provider (its Responses API
 * honors server-side context_management) and "client" for everything else.
 */
export interface ResolvedModelProvider {
  id: string;                  // "openai" | "azure" | registry id
  label: string;
  kind: RegistryProviderKind;  // "api-key" (built-ins + most registry) | "codex-subscription"
  api: ModelProviderApi;
  builtin: boolean;
  baseUrl?: string | undefined;
  apiKey?: string | undefined;
  defaultQuery?: Record<string, string> | undefined;
  defaultHeaders?: Record<string, string> | undefined;
  compactionMode: ContextCompactionMode;   // "server" only for built-in OpenAI; "client" otherwise
}

/** A single exposed model + the provider that serves it. */
export interface ConfiguredModel {
  id: string;
  label: string;
  providerId: string;
  providerLabel: string;
  api: ModelProviderApi;
  contextWindowTokens?: number | undefined;
  reasoningEffort: boolean;
  hostedWebSearch: boolean;
}

export const defaultModelPricing: Record<string, ModelPricing> = {
  "gpt-5.5": {
    inputMicrosPerMillionTokens: 5_000_000,
    cachedInputMicrosPerMillionTokens: 500_000,
    outputMicrosPerMillionTokens: 30_000_000,
    marginBps: 2_500,
  },
  "gpt-5.4": {
    inputMicrosPerMillionTokens: 2_500_000,
    cachedInputMicrosPerMillionTokens: 250_000,
    outputMicrosPerMillionTokens: 15_000_000,
    marginBps: 2_500,
  },
  "gpt-5.4-mini": {
    inputMicrosPerMillionTokens: 750_000,
    cachedInputMicrosPerMillionTokens: 75_000,
    outputMicrosPerMillionTokens: 4_500_000,
    marginBps: 2_500,
  },
  "gpt-5.2": {
    inputMicrosPerMillionTokens: 1_750_000,
    cachedInputMicrosPerMillionTokens: 175_000,
    outputMicrosPerMillionTokens: 14_000_000,
    marginBps: 2_500,
  },
  "gpt-5.2-chat-latest": {
    inputMicrosPerMillionTokens: 1_750_000,
    cachedInputMicrosPerMillionTokens: 175_000,
    outputMicrosPerMillionTokens: 14_000_000,
    marginBps: 2_500,
  },
  "gpt-5.2-codex": {
    inputMicrosPerMillionTokens: 1_750_000,
    cachedInputMicrosPerMillionTokens: 175_000,
    outputMicrosPerMillionTokens: 14_000_000,
    marginBps: 2_500,
  },
  "gpt-5.1": {
    inputMicrosPerMillionTokens: 1_250_000,
    cachedInputMicrosPerMillionTokens: 125_000,
    outputMicrosPerMillionTokens: 10_000_000,
    marginBps: 2_500,
  },
  "gpt-5": {
    inputMicrosPerMillionTokens: 1_250_000,
    cachedInputMicrosPerMillionTokens: 125_000,
    outputMicrosPerMillionTokens: 10_000_000,
    marginBps: 2_500,
  },
  "gpt-5-mini": {
    inputMicrosPerMillionTokens: 250_000,
    cachedInputMicrosPerMillionTokens: 25_000,
    outputMicrosPerMillionTokens: 2_000_000,
    marginBps: 2_500,
  },
  "gpt-5-nano": {
    inputMicrosPerMillionTokens: 50_000,
    cachedInputMicrosPerMillionTokens: 5_000,
    outputMicrosPerMillionTokens: 400_000,
    marginBps: 2_500,
  },
  // Fireworks AI / GLM 5.2 — the first shipped non-OpenAI registry model. A
  // built-in default pricing entry makes managed billing work out of the box
  // for hosts that expose this model via OPENGENI_MODEL_PROVIDERS_JSON without
  // also setting OPENGENI_MODEL_PRICING_JSON.
  "accounts/fireworks/models/glm-5p2": {
    inputMicrosPerMillionTokens: 1_400_000,
    cachedInputMicrosPerMillionTokens: 260_000,
    outputMicrosPerMillionTokens: 4_400_000,
    marginBps: 2_500,
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

export const SANDBOX_REQUIRED_ENV: Record<z.infer<typeof SandboxBackend>, readonly SandboxRequiredEnv[]> = {
  // docker/local/none need no credentials (local dev container / in-process / off).
  docker: [],
  local: [],
  none: [],
  modal: [
    { field: "modalAppName", env: "OPENGENI_MODAL_APP_NAME" },
    { field: "modalTokenId", env: "OPENGENI_MODAL_TOKEN_ID" },
    { field: "modalTokenSecret", env: "OPENGENI_MODAL_TOKEN_SECRET" },
  ],
  daytona: [
    { field: "daytonaApiKey", env: "OPENGENI_DAYTONA_API_KEY" },
  ],
  runloop: [
    { field: "runloopApiKey", env: "OPENGENI_RUNLOOP_API_KEY" },
  ],
  e2b: [
    { field: "e2bApiKey", env: "OPENGENI_E2B_API_KEY" },
  ],
  blaxel: [
    { field: "blaxelApiKey", env: "OPENGENI_BLAXEL_API_KEY" },
  ],
  cloudflare: [
    { field: "cloudflareWorkerUrl", env: "OPENGENI_CLOUDFLARE_WORKER_URL" },
  ],
  vercel: [
    { field: "vercelToken", env: "OPENGENI_VERCEL_TOKEN" },
    { field: "vercelProjectId", env: "OPENGENI_VERCEL_PROJECT_ID" },
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

function optional(name: string): string | undefined {
  const value = process.env[name];
  return value && value.trim().length > 0 ? value : undefined;
}

export function getSettings(): Settings {
  const raw = {
    serviceName: optional("OPENGENI_SERVICE_NAME"),
    environment: optional("OPENGENI_ENVIRONMENT"),
    deploymentRevision: optional("OPENGENI_DEPLOYMENT_REVISION") ?? optional("SOURCE_VERSION") ?? optional("GITHUB_SHA"),
    serverVersion: optional("OPENGENI_SERVER_VERSION"),
    databaseUrl: optional("OPENGENI_DATABASE_URL"),
    dbSchema: optional("OPENGENI_DB_SCHEMA"),
    rlsStrategy: optional("OPENGENI_RLS_STRATEGY"),
    natsUrl: optional("OPENGENI_NATS_URL"),
    temporalHost: optional("OPENGENI_TEMPORAL_HOST"),
    temporalNamespace: optional("OPENGENI_TEMPORAL_NAMESPACE"),
    temporalTaskQueue: optional("OPENGENI_TEMPORAL_TASK_QUEUE"),
    startupDependencyRetryAttempts: optional("OPENGENI_STARTUP_DEPENDENCY_RETRY_ATTEMPTS"),
    startupDependencyRetryInitialDelayMs: optional("OPENGENI_STARTUP_DEPENDENCY_RETRY_INITIAL_DELAY_MS"),
    startupDependencyRetryMaxDelayMs: optional("OPENGENI_STARTUP_DEPENDENCY_RETRY_MAX_DELAY_MS"),
    observabilityStructuredLogs: optional("OPENGENI_OBSERVABILITY_STRUCTURED_LOGS"),
    observabilityMetricsEnabled: optional("OPENGENI_OBSERVABILITY_METRICS_ENABLED"),
    observabilityOtlpEndpoint: optional("OPENGENI_OTEL_EXPORTER_OTLP_ENDPOINT") ?? optional("OTEL_EXPORTER_OTLP_ENDPOINT"),
    observabilityOtlpHeaders: optional("OPENGENI_OTEL_EXPORTER_OTLP_HEADERS") ?? optional("OTEL_EXPORTER_OTLP_HEADERS"),
    publicBaseUrl: optional("OPENGENI_PUBLIC_BASE_URL"),
    agentReleasesBaseUrl: optional("OPENGENI_AGENT_RELEASES_BASE_URL"),
    productAccessMode: optional("OPENGENI_PRODUCT_ACCESS_MODE"),
    billingMode: optional("OPENGENI_BILLING_MODE"),
    entitlementsMode: optional("OPENGENI_ENTITLEMENTS_MODE"),
    usageLimitsMode: optional("OPENGENI_USAGE_LIMITS_MODE"),
    staticEntitlementsJson: optional("OPENGENI_STATIC_ENTITLEMENTS_JSON"),
    staticUsageLimitsJson: optional("OPENGENI_STATIC_USAGE_LIMITS_JSON"),
    delegationSecret: optional("OPENGENI_DELEGATION_SECRET"),
    streamTokenSecret: optional("OPENGENI_STREAM_TOKEN_SECRET"),
    streamControlEnabled: optional("OPENGENI_STREAM_CONTROL_ENABLED"),
    toolspaceEnabled: optional("OPENGENI_TOOLSPACE_ENABLED"),
    toolspaceMaxCallsPerTurn: optional("OPENGENI_TOOLSPACE_MAX_CALLS_PER_TURN"),
    environmentsEncryptionKey: optional("OPENGENI_ENVIRONMENTS_ENCRYPTION_KEY"),
    integrationsEnabled: optional("OPENGENI_INTEGRATIONS_ENABLED"),
    integrationsStateSecret: optional("OPENGENI_INTEGRATIONS_STATE_SECRET"),
    integrationsAllowPrivateNetworkTargets: optional("OPENGENI_INTEGRATIONS_ALLOW_PRIVATE_NETWORK_TARGETS"),
    integrationsOauthClientsJson: optional("OPENGENI_INTEGRATIONS_OAUTH_CLIENTS_JSON"),
    goalMaxAutoContinuations: optional("OPENGENI_GOAL_MAX_AUTO_CONTINUATIONS"),
    goalNoProgressLimit: optional("OPENGENI_GOAL_NO_PROGRESS_LIMIT"),
    agentMaxModelCallsPerTurn: optional("OPENGENI_AGENT_MAX_MODEL_CALLS_PER_TURN"),
    sessionHistorySource: optional("OPENGENI_SESSION_HISTORY_SOURCE"),
    contextCompactionMode: optional("OPENGENI_CONTEXT_COMPACTION_MODE"),
    contextWindowTokens: optional("OPENGENI_CONTEXT_WINDOW_TOKENS"),
    contextCompactionThresholdRatio: optional("OPENGENI_COMPACTION_THRESHOLD_RATIO"),
    contextReservedOutputTokens: optional("OPENGENI_CONTEXT_RESERVED_OUTPUT_TOKENS"),
    contextServerCompactThresholdTokens: optional("OPENGENI_CONTEXT_SERVER_COMPACT_THRESHOLD_TOKENS"),
    contextCompactSoftFraction: optional("OPENGENI_CONTEXT_COMPACT_SOFT_FRACTION"),
    contextCompactHardFraction: optional("OPENGENI_CONTEXT_COMPACT_HARD_FRACTION"),
    contextKeepRecentTokens: optional("OPENGENI_CONTEXT_KEEP_RECENT_TOKENS"),
    contextSummaryMaxTokens: optional("OPENGENI_CONTEXT_SUMMARY_MAX_TOKENS"),
    authRequired: optional("OPENGENI_AUTH_REQUIRED"),
    accessKey: optional("OPENGENI_ACCESS_KEY"),
    authAllowHealth: optional("OPENGENI_AUTH_ALLOW_HEALTH"),
    authAllowMetrics: optional("OPENGENI_AUTH_ALLOW_METRICS"),
    apiHost: optional("OPENGENI_API_HOST"),
    apiPort: optional("OPENGENI_API_PORT"),
    workerHttpPort: optional("OPENGENI_WORKER_HTTP_PORT"),
    opengeniMcpUrl: optional("OPENGENI_MCP_URL"),
    corsAllowOriginRegex: optional("OPENGENI_CORS_ALLOW_ORIGIN_REGEX"),
    openaiProvider: optional("OPENGENI_OPENAI_PROVIDER"),
    openaiApiKey: optional("OPENGENI_OPENAI_API_KEY") ?? optional("OPENAI_API_KEY"),
    openaiBaseUrl: optional("OPENGENI_OPENAI_BASE_URL") ?? optional("OPENAI_BASE_URL"),
    openaiModel: optional("OPENGENI_OPENAI_MODEL"),
    openaiAllowedModels: optional("OPENGENI_OPENAI_ALLOWED_MODELS"),
    modelPricingJson: optional("OPENGENI_MODEL_PRICING_JSON"),
    modelProvidersJson: optional("OPENGENI_MODEL_PROVIDERS_JSON"),
    codexSubscriptionEnabled: optional("OPENGENI_CODEX_SUBSCRIPTION_ENABLED"),
    codexToolSearchEnabled: optional("OPENGENI_CODEX_TOOL_SEARCH_ENABLED"),
    codexProductSku: optional("OPENGENI_CODEX_PRODUCT_SKU"),
    codexRotationNearExhaustionPct: optional("OPENGENI_CODEX_ROTATION_NEAR_EXHAUSTION_PCT"),
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
    dockerExposedPorts: optional("OPENGENI_DOCKER_EXPOSED_PORTS"),
    dockerNetwork: optional("OPENGENI_DOCKER_NETWORK"),
    modalAppName: optional("OPENGENI_MODAL_APP_NAME"),
    modalImageRef: optional("OPENGENI_MODAL_IMAGE_REF"),
    modalImageRegistrySecret: optional("OPENGENI_MODAL_IMAGE_REGISTRY_SECRET"),
    modalTimeoutSeconds: optional("OPENGENI_MODAL_TIMEOUT_SECONDS"),
    modalTokenId: optional("OPENGENI_MODAL_TOKEN_ID"),
    modalTokenSecret: optional("OPENGENI_MODAL_TOKEN_SECRET"),
    modalEnvironment: optional("OPENGENI_MODAL_ENVIRONMENT"),
    modalIdleTimeoutSeconds: optional("OPENGENI_MODAL_IDLE_TIMEOUT_SECONDS"),
    modalWorkspacePersistence: optional("OPENGENI_MODAL_WORKSPACE_PERSISTENCE"),
    modalSnapshotRetentionSeconds: optional("OPENGENI_MODAL_SNAPSHOT_RETENTION_SECONDS"),
    sandboxDesktopEnabled: optional("OPENGENI_SANDBOX_DESKTOP_ENABLED"),
    sandboxDesktopInteractive: optional("OPENGENI_SANDBOX_DESKTOP_INTERACTIVE"),
    sandboxTerminalEnabled: optional("OPENGENI_SANDBOX_TERMINAL_ENABLED"),
    streamResolutionWidth: optional("OPENGENI_STREAM_RESOLUTION_WIDTH"),
    streamResolutionHeight: optional("OPENGENI_STREAM_RESOLUTION_HEIGHT"),
    computerUseEnabled: optional("OPENGENI_COMPUTER_USE_ENABLED"),
    computerUseReadOnly: optional("OPENGENI_COMPUTER_USE_READONLY"),
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
    vercelToken: optional("OPENGENI_VERCEL_TOKEN"),
    vercelProjectId: optional("OPENGENI_VERCEL_PROJECT_ID"),
    vercelTeamId: optional("OPENGENI_VERCEL_TEAM_ID"),
    vercelRuntime: optional("OPENGENI_VERCEL_RUNTIME"),
    sandboxOwnershipEnabled: optional("OPENGENI_SANDBOX_OWNERSHIP_ENABLED"),
    sandboxLazyProvisionEnabled: optional("OPENGENI_SANDBOX_LAZY_PROVISION"),
    sandboxSelfhostedEnabled: optional("OPENGENI_SANDBOX_SELFHOSTED_ENABLED"),
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
    sandboxLeaseReaperPeriodMs: optional("OPENGENI_SANDBOX_LEASE_REAPER_PERIOD_MS"),
    sandboxViewerHolderTtlMs: optional("OPENGENI_SANDBOX_VIEWER_HOLDER_TTL_MS"),
    sandboxIdleGraceMs: optional("OPENGENI_SANDBOX_IDLE_GRACE_MS"),
    sandboxSnapshotIntervalMs: optional("OPENGENI_SANDBOX_SNAPSHOT_INTERVAL_MS"),
    sandboxSnapshotTimeoutMs: optional("OPENGENI_SANDBOX_SNAPSHOT_TIMEOUT_MS"),
    sandboxLeaseTtlMs: optional("OPENGENI_SANDBOX_LEASE_TTL_MS"),
    sandboxLeaseWarmingTtlMs: optional("OPENGENI_SANDBOX_LEASE_WARMING_TTL_MS"),
    sandboxWarmingTimeoutMs: optional("OPENGENI_SANDBOX_WARMING_TIMEOUT_MS"),
    sandboxWarmRateMicrosPerSecondJson: optional("OPENGENI_SANDBOX_WARM_RATE_MICROS_PER_SECOND_JSON"),
    sandboxMaxWarmSecondsPerWorkspace: optional("OPENGENI_SANDBOX_MAX_WARM_SECONDS_PER_WORKSPACE"),
    sandboxPreparationProfiles: optional("OPENGENI_SANDBOX_PREPARATION_PROFILES"),
    sandboxEnvAllowlist: optional("OPENGENI_SANDBOX_ENV_ALLOWLIST"),
    objectStorageEndpoint: optional("OPENGENI_OBJECT_STORAGE_ENDPOINT"),
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
    gitAuthorName: optional("OPENGENI_GIT_AUTHOR_NAME"),
    gitAuthorEmail: optional("OPENGENI_GIT_AUTHOR_EMAIL"),
    gitCommitterName: optional("OPENGENI_GIT_COMMITTER_NAME"),
    gitCommitterEmail: optional("OPENGENI_GIT_COMMITTER_EMAIL"),
    githubAppManifestBaseUrl: optional("OPENGENI_GITHUB_APP_MANIFEST_BASE_URL"),
    githubAppManifestStateSecret: optional("OPENGENI_GITHUB_APP_MANIFEST_STATE_SECRET"),
    githubAppId: optional("OPENGENI_GITHUB_APP_ID"),
    githubClientId: optional("OPENGENI_GITHUB_CLIENT_ID"),
    githubClientSecret: optional("OPENGENI_GITHUB_CLIENT_SECRET"),
    githubAppSlug: optional("OPENGENI_GITHUB_APP_SLUG"),
    githubWebhookSecret: optional("OPENGENI_GITHUB_WEBHOOK_SECRET"),
    githubAppPrivateKey: optional("OPENGENI_GITHUB_APP_PRIVATE_KEY"),
    betterAuthSecret: optional("OPENGENI_BETTER_AUTH_SECRET"),
    betterAuthAllowedHosts: optional("OPENGENI_BETTER_AUTH_ALLOWED_HOSTS"),
    betterAuthCookieDomain: optional("OPENGENI_BETTER_AUTH_COOKIE_DOMAIN"),
    betterAuthTrustedOrigins: optional("OPENGENI_BETTER_AUTH_TRUSTED_ORIGINS"),
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
    mcpServers: ensureBuiltInMcpServers(parsed),
  };
  validateSettings(settings);
  return settings;
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

export function collectSandboxEnvironment(settings: Settings, source: NodeJS.ProcessEnv = process.env): Record<string, string> {
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

/** The built-in provider's stable id: "openai" on the OpenAI platform, "azure" on Azure. */
function builtinProviderId(settings: Pick<Settings, "openaiProvider">): string {
  return settings.openaiProvider === "azure" ? "azure" : "openai";
}

function builtinProviderLabel(settings: Pick<Settings, "openaiProvider">): string {
  return settings.openaiProvider === "azure" ? "Azure OpenAI" : "OpenAI";
}

/**
 * Every provider a client may route to: the built-in OpenAI/Azure provider
 * first (id "openai"/"azure", always "responses", compactionMode from
 * resolveContextCompactionMode), then each registry provider in declaration
 * order (compactionMode "client"). Client-construction inputs are filled from
 * the existing flat openai/azure settings for the built-in, and from the
 * registry entry for the rest. Registry ids may not collide with the built-in
 * id — validateSettings rejects that at boot.
 */
export function configuredProviders(settings: Settings): ResolvedModelProvider[] {
  const builtin: ResolvedModelProvider = {
    id: builtinProviderId(settings),
    label: builtinProviderLabel(settings),
    kind: "api-key",
    api: "responses",
    builtin: true,
    compactionMode: resolveContextCompactionMode(settings),
  };
  if (settings.openaiProvider === "azure") {
    builtin.baseUrl = settings.azureOpenaiBaseUrl ?? settings.azureOpenaiEndpoint;
    builtin.apiKey = settings.azureOpenaiApiKey ?? settings.azureOpenaiAdToken;
  } else {
    builtin.baseUrl = settings.openaiBaseUrl;
    builtin.apiKey = settings.openaiApiKey;
  }
  const registry = parseModelProvidersJson(settings.modelProvidersJson).map((provider): ResolvedModelProvider => ({
    id: provider.id,
    label: provider.label ?? provider.id,
    kind: provider.kind,
    api: provider.api,
    builtin: false,
    baseUrl: provider.baseUrl,
    apiKey: resolveProviderApiKey(provider),
    defaultQuery: provider.defaultQuery,
    defaultHeaders: provider.defaultHeaders,
    compactionMode: "client",
  }));
  return [builtin, ...registry];
}

/**
 * Every model a client may use, the built-in provider's models first
 * (configuredAllowedModels-from-openai, mapped to "responses" with
 * hostedWebSearch/contextWindow/reasoningEffort from the flat settings), then
 * each registry provider's models (label→id, hostedWebSearch/reasoningEffort
 * default false). De-duplicated by id (first wins) so the default model stays
 * first and the built-in allow-list takes precedence over registry entries.
 */
export function configuredModels(settings: Settings): ConfiguredModel[] {
  const builtinId = builtinProviderId(settings);
  const builtinLabel = builtinProviderLabel(settings);
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
  // "gpt-5.5") is left in place so the built-in still wins it via the first-wins
  // de-dup below (preserving the documented built-in-precedence contract). When
  // a codex/ id has NO codex provider injected (no active subscription) it then
  // resolves to nothing and getModel fails loud with
  // CodexSubscriptionUnavailableError instead of mis-routing to Azure.
  const registryOwnedIds = new Set(
    parseModelProvidersJson(settings.modelProvidersJson).flatMap((provider) => provider.models.map((model) => model.id)),
  );
  const isRegistryNamespaced = (id: string): boolean =>
    id.startsWith(CODEX_MODEL_ID_PREFIX) || (id.includes("/") && registryOwnedIds.has(id));
  const out: ConfiguredModel[] = uniqueValues([settings.openaiModel, ...splitCsv(settings.openaiAllowedModels)])
    .filter((id) => !isRegistryNamespaced(id))
    .map((id) => ({
      id,
      label: id,
      providerId: builtinId,
      providerLabel: builtinLabel,
      api: "responses" as const,
      contextWindowTokens: settings.contextWindowTokens,
      reasoningEffort: true,
      hostedWebSearch: settings.webSearchEnabled,
    }));
  for (const provider of parseModelProvidersJson(settings.modelProvidersJson)) {
    const providerLabel = provider.label ?? provider.id;
    for (const model of provider.models) {
      out.push({
        id: model.id,
        label: model.label ?? model.id,
        providerId: provider.id,
        providerLabel,
        api: provider.api,
        ...(model.contextWindowTokens === undefined ? {} : { contextWindowTokens: model.contextWindowTokens }),
        reasoningEffort: model.reasoningEffort ?? false,
        hostedWebSearch: model.hostedWebSearch ?? false,
      });
    }
  }
  const seen = new Set<string>();
  return out.filter((model) => {
    if (seen.has(model.id)) {
      return false;
    }
    seen.add(model.id);
    return true;
  });
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
  const model = configuredModels(settings).find((candidate) => candidate.id === modelId);
  if (!model) {
    return undefined;
  }
  const provider = configuredProviders(settings).find((candidate) => candidate.id === model.providerId);
  if (!provider) {
    return undefined;
  }
  return { provider, model };
}

/**
 * Effective per-model pricing. Merge order (later wins):
 *   defaultModelPricing → registry model `pricing` entries (keyed by model id)
 *   → parseModelPricingJson(settings.modelPricingJson) (explicit JSON wins).
 */
export function configuredModelPricing(settings: Settings): Record<string, ModelPricing> {
  const registry: Record<string, ModelPricing> = {};
  for (const provider of parseModelProvidersJson(settings.modelProvidersJson)) {
    for (const model of provider.models) {
      if (model.pricing) {
        registry[model.id] = model.pricing;
      }
    }
  }
  const configured = parseModelPricingJson(settings.modelPricingJson);
  return {
    ...defaultModelPricing,
    ...registry,
    ...configured,
  };
}

/**
 * Resolved conversation-context compaction path for a run.
 *  - "server": let the OpenAI platform Responses API compact server-side (the
 *    SDK emits context_management; we pass the correct gpt-5.5 threshold).
 *  - "client": run OpenGeni's own client-side compaction (Azure and any other
 *    backend that rejects/ignores context_management).
 *  - "off": neither (legacy unbounded growth; escape hatch).
 *
 * "auto" maps to "server" on the OpenAI platform provider and "client"
 * otherwise — Azure's Responses API returns 400 unsupported_parameter for
 * context_management, so it must never take the server path.
 */
export type ContextCompactionMode = "server" | "client" | "off";

export function resolveContextCompactionMode(settings: Pick<Settings, "contextCompactionMode" | "openaiProvider">): ContextCompactionMode {
  switch (settings.contextCompactionMode) {
    case "server":
      return "server";
    case "client":
      return "client";
    case "off":
      return "off";
    case "auto":
    default:
      return settings.openaiProvider === "openai" ? "server" : "client";
  }
}

/** Usable input-token budget B = window - reserved output. */
export function contextInputBudgetTokens(settings: Pick<Settings, "contextWindowTokens" | "contextReservedOutputTokens">): number {
  return Math.max(0, settings.contextWindowTokens - settings.contextReservedOutputTokens);
}

/**
 * Server-path compact_threshold (tokens) handed to the SDK's
 * StaticCompactionPolicy: the explicit override when set, else
 * floor(B * softFraction). This is what sidesteps the SDK's wrong 240k
 * fallback for gpt-5.5 (which is absent from its hardcoded window map).
 */
export function contextServerCompactThreshold(settings: Pick<Settings, "contextWindowTokens" | "contextReservedOutputTokens" | "contextServerCompactThresholdTokens" | "contextCompactSoftFraction" | "contextCompactionThresholdRatio">): number {
  if (settings.contextServerCompactThresholdTokens) {
    return settings.contextServerCompactThresholdTokens;
  }
  return Math.floor(settings.contextWindowTokens * settings.contextCompactionThresholdRatio);
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

export function calculateModelUsageCostMicros(settings: Settings, model: string, usage: ModelUsageInput): number {
  const pricing = configuredModelPricing(settings)[model];
  if (!pricing) {
    throw new Error(`Missing model pricing for ${model}`);
  }
  const entries = usage.requestUsageEntries && usage.requestUsageEntries.length > 0 ? usage.requestUsageEntries : [usage];
  const rawCost = entries.reduce((sum, entry) => sum + calculateEntryCostMicros(pricing, entry), 0);
  const marginBps = pricing.marginBps ?? 0;
  return Math.ceil(rawCost * (10_000 + marginBps) / 10_000);
}

export function configuredAllowedReasoningEfforts(settings: Settings): Array<z.infer<typeof ReasoningEffort>> {
  return uniqueValues([settings.openaiReasoningEffort, ...splitCsv(settings.openaiAllowedReasoningEfforts)])
    .map((value) => ReasoningEffort.parse(value));
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
    throw new Error("OPENGENI_ENVIRONMENTS_ENCRYPTION_KEY must be base64 for exactly 32 bytes (generate with: openssl rand -base64 32)");
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
 * resolve (the SPIKE-1 live footgun). `opengeni_private` is on the path so the
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
  return Object.fromEntries(Object.entries({
    GIT_AUTHOR_NAME: settings.gitAuthorName,
    GIT_AUTHOR_EMAIL: settings.gitAuthorEmail,
    GIT_COMMITTER_NAME: settings.gitCommitterName ?? settings.gitAuthorName,
    GIT_COMMITTER_EMAIL: settings.gitCommitterEmail ?? settings.gitAuthorEmail,
  }).filter((entry): entry is [string, string] => typeof entry[1] === "string" && entry[1].trim().length > 0));
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
  // unix user (keep its real $HOME); `none` has no box.
  const descriptor = CAPABILITY_DESCRIPTORS[settings.sandboxBackend];
  if (settings.sandboxBackend !== "none" && settings.sandboxBackend !== "local") {
    environment.HOME ??= descriptor.workspaceRoot;
  }
  // TOKEN-BROKER (B1): the STABLE credential FILE PATHS and CLI wrapper PATH for
  // provisioned boxes only. Constants derived from the resolved HOME (falling
  // back to the descriptor workspaceRoot), so they are parity-safe — they join
  // the shared base and therefore appear IDENTICALLY on BOTH the worker-turn
  // manifest AND every API-direct attach manifest. Only PATHS are stable; token
  // VALUES live exclusively in files that runtime seeds off-manifest.
  const provisionedGitHelperBackend = settings.sandboxBackend !== "none"
    && settings.sandboxBackend !== "local"
    && settings.sandboxBackend !== "selfhosted";
  if (provisionedGitHelperBackend) {
    const home = environment.HOME ?? descriptor.workspaceRoot;
    environment.OPENGENI_GIT_CREDENTIALS_DIR ??= `${home}/.opengeni/git-credentials`;
    environment.OPENGENI_GIT_TOKEN_FILE ??= `${home}/.opengeni/git-token`;
    environment.OPENGENI_GIT_CLI_WRAPPER_DIR ??= `${home}/.opengeni/bin`;
    environment.PATH = prependPathEntry(environment.PATH, environment.OPENGENI_GIT_CLI_WRAPPER_DIR);
  }
  if (settings.toolspaceEnabled) {
    environment.OPENGENI_TOOLSPACE_TOKEN_FILE ??= `${environment.HOME ?? descriptor.workspaceRoot}/.opengeni/toolspace-token`;
    if (options.workspaceId) {
      environment.OPENGENI_TOOLSPACE_URL ??= firstPartyMcpWorkspaceUrl(settings, options.workspaceId);
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
    (typeof value === "number" && Number.isInteger(value) && value > 0)
    || (typeof value === "string" && /^\d+$/.test(value) && Number(value) > 0);
  return resources.some((resource) =>
    resource.kind === "repository"
    && (
      (positive(resource.githubInstallationId) && positive(resource.githubRepositoryId))
      || (resource.provider === "github" && positive(resource.installationId) && positive(resource.repositoryId))
    )
  );
}

export function hasGitCredentialRepositorySelection(
  resources: ReadonlyArray<{ kind: string; provider?: unknown; githubInstallationId?: unknown; githubRepositoryId?: unknown }>,
): boolean {
  return resources.some((resource) =>
    resource.kind === "repository"
    && (
      resource.provider === "github"
      || resource.provider === "gitlab"
      || resource.provider === "azure_devops"
      || hasGitHubRepositorySelection([resource])
    )
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

export function startupRetryOptions(settings: Settings): Required<Omit<StartupRetryOptions, "onRetry">> {
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
  const profiles = splitCsv(settings.sandboxPreparationProfiles).map((value) => value.toLowerCase());
  if (profiles.includes("none")) {
    if (profiles.length > 1) {
      throw new Error("OPENGENI_SANDBOX_PREPARATION_PROFILES cannot combine none with other profiles");
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
    throw new Error(`OPENGENI_MCP_SERVERS must be a JSON array: ${message}`, { cause: error });
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
    throw new Error(`OPENGENI_SANDBOX_WARM_RATE_MICROS_PER_SECOND_JSON must be valid JSON: ${message}`, { cause: error });
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("OPENGENI_SANDBOX_WARM_RATE_MICROS_PER_SECOND_JSON must be a JSON object keyed by backend name");
  }
  const out: Record<string, number> = {};
  for (const [backend, value] of Object.entries(parsed)) {
    if (!backend.trim()) {
      throw new Error("OPENGENI_SANDBOX_WARM_RATE_MICROS_PER_SECOND_JSON contains an empty backend name");
    }
    const rate = typeof value === "number" ? value : Number(value);
    if (!Number.isFinite(rate) || rate < 0) {
      throw new Error(`OPENGENI_SANDBOX_WARM_RATE_MICROS_PER_SECOND_JSON rate for ${backend} must be a non-negative number`);
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
    throw new Error(`OPENGENI_MODEL_PROVIDERS_JSON must be valid JSON: ${message}`, { cause: error });
  }
  if (!Array.isArray(parsed)) {
    throw new Error("OPENGENI_MODEL_PROVIDERS_JSON must be a JSON array of providers");
  }
  return parsed.map((entry, index) => {
    const result = RegistryProviderSchema.safeParse(entry);
    if (!result.success) {
      throw new Error(`OPENGENI_MODEL_PROVIDERS_JSON provider[${index}] is invalid: ${result.error.message}`);
    }
    return result.data;
  });
}

export function parseIntegrationsOauthClientsJson(raw: string | undefined): Record<string, IntegrationOAuthClientConfig> {
  if (!raw?.trim() || raw.trim() === "{}") {
    return {};
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`OPENGENI_INTEGRATIONS_OAUTH_CLIENTS_JSON must be valid JSON: ${message}`, { cause: error });
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("OPENGENI_INTEGRATIONS_OAUTH_CLIENTS_JSON must be a JSON object keyed by authorization-server issuer or URL");
  }
  const out: Record<string, IntegrationOAuthClientConfig> = {};
  for (const [key, value] of Object.entries(parsed)) {
    if (!key.trim()) {
      throw new Error("OPENGENI_INTEGRATIONS_OAUTH_CLIENTS_JSON contains an empty issuer key");
    }
    const result = IntegrationOAuthClientConfigSchema.safeParse(value);
    if (!result.success) {
      throw new Error(`OPENGENI_INTEGRATIONS_OAUTH_CLIENTS_JSON client for ${key} is invalid: ${result.error.message}`);
    }
    out[key] = result.data;
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
    throw new Error(`OPENGENI_STATIC_USAGE_LIMITS_JSON must be valid JSON: ${message}`, { cause: error });
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
    throw new Error(`OPENGENI_STATIC_ENTITLEMENTS_JSON must be valid JSON: ${message}`, { cause: error });
  }
  return Entitlements.parse(parsed);
}

function calculateEntryCostMicros(pricing: ModelPricing, entry: ModelUsageInput): number {
  const inputTokens = positiveInt(entry.inputTokens);
  const outputTokens = positiveInt(entry.outputTokens);
  const cachedTokens = Math.min(inputTokens, cachedInputTokens(entry));
  const uncachedInputTokens = Math.max(0, inputTokens - cachedTokens);
  const cachedInputRate = pricing.cachedInputMicrosPerMillionTokens ?? pricing.inputMicrosPerMillionTokens;
  return Math.ceil((uncachedInputTokens * pricing.inputMicrosPerMillionTokens) / 1_000_000)
    + Math.ceil((cachedTokens * cachedInputRate) / 1_000_000)
    + Math.ceil((outputTokens * pricing.outputMicrosPerMillionTokens) / 1_000_000);
}

function cachedInputTokens(entry: ModelUsageInput): number {
  const details = Array.isArray(entry.inputTokensDetails)
    ? entry.inputTokensDetails
    : entry.inputTokensDetails
      ? [entry.inputTokensDetails]
      : [];
  let total = 0;
  for (const detail of details) {
    total += positiveInt(detail.cached_tokens)
      + positiveInt(detail.cachedInputTokens)
      + positiveInt(detail.cached_input_tokens);
  }
  return total;
}

function positiveInt(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

function ensureBuiltInMcpServers(settings: Settings): Settings["mcpServers"] {
  const existing = settings.mcpServers.filter((server) => server.id !== "opengeni");
  const firstPartyMcpUrl = firstPartyMcpServerUrl(settings);
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
    ...(hasFiles ? [] : [{
      id: "files",
      name: "Files",
      url: firstPartyMcpUrl,
      allowedTools: ["files_get_download_url"],
      cacheToolsList: true,
    }]),
    ...(hasDocs ? [] : [{
      id: "docs",
      name: "Document Search",
      url: firstPartyDocsMcpUrl,
      allowedTools: ["search_documents", "fetch_document_chunk", "list_document_bases", "knowledge_search", "knowledge_fetch", "memory_search", "memory_propose"],
      cacheToolsList: false,
    }]),
    ...existing,
  ];
}

/**
 * The base URL of OpenGeni's own first-party MCP endpoint, as a `{workspaceId}`
 * template — the SINGLE source of truth for the `opengeniMcpUrl`-or-loopback
 * decision. Every site that needs the first-party MCP base (config's tool
 * registry here, and the worker-side `firstPartyMcpServerUrlForRun` /
 * `firstPartyMcpUrls` in @opengeni/runtime) MUST route through this so the
 * default lives in exactly one place.
 *
 * BINDING CONTRACT (`opengeniMcpUrl`):
 *   - STANDALONE (unset): falls back to the loopback default
 *     `http://127.0.0.1:${apiPort}/v1/workspaces/{workspaceId}/mcp` — the worker
 *     and API are in/next to the same host:port, so loopback resolves the
 *     workspace-scoped MCP. Byte-for-byte today's behavior.
 *   - EMBEDDED / MOUNTED (must set): when OpenGeni's API is mounted as a host
 *     sub-app under a prefix (e.g. `https://host/og/v1/...`), the loopback
 *     default is WRONG — the worker runs in the host process and `127.0.0.1:
 *     ${apiPort}` is not where the mounted, sandbox-routable MCP lives. The host
 *     MUST set `OPENGENI_MCP_URL` to the externally/sandbox-routable base (a
 *     `{workspaceId}` template, or a concrete base that gets re-scoped). This is
 *     the one binding a mounted embed cannot leave unset.
 */
export function firstPartyMcpBaseUrl(settings: Settings): string {
  return settings.opengeniMcpUrl ?? `http://127.0.0.1:${settings.apiPort}/v1/workspaces/{workspaceId}/mcp`;
}

export function firstPartyMcpWorkspaceUrl(settings: Settings, workspaceId: string): string {
  const raw = firstPartyMcpBaseUrl(settings);
  if (raw.includes("{workspaceId}")) {
    return raw.replaceAll("{workspaceId}", workspaceId);
  }
  const url = new URL(raw);
  url.pathname = `/v1/workspaces/${workspaceId}/mcp`;
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

function validateSettings(settings: Settings): void {
  if (settings.toolspaceEnabled && !settings.delegationSecret) {
    throw new Error("OPENGENI_DELEGATION_SECRET is required when OPENGENI_TOOLSPACE_ENABLED=true");
  }
  if (settings.productAccessMode === "managed") {
    if (!settings.publicBaseUrl) {
      throw new Error("OPENGENI_PUBLIC_BASE_URL is required when OPENGENI_PRODUCT_ACCESS_MODE=managed");
    }
    if (!settings.betterAuthSecret) {
      throw new Error("OPENGENI_BETTER_AUTH_SECRET is required when OPENGENI_PRODUCT_ACCESS_MODE=managed");
    }
    if (!settings.delegationSecret) {
      throw new Error("OPENGENI_DELEGATION_SECRET is required when OPENGENI_PRODUCT_ACCESS_MODE=managed");
    }
    if (!["local", "test"].includes(settings.environment) && !settings.resendApiKey) {
      throw new Error("OPENGENI_RESEND_API_KEY is required for managed mode outside local/test");
    }
    if (!["local", "test"].includes(settings.environment) && !settings.environmentsEncryptionKey) {
      throw new Error("OPENGENI_ENVIRONMENTS_ENCRYPTION_KEY is required for managed mode outside local/test");
    }
  }
  environmentsEncryptionKeyBytes(settings);
  if (settings.integrationsEnabled) {
    if (settings.productAccessMode === "managed" && !settings.publicBaseUrl) {
      throw new Error("OPENGENI_PUBLIC_BASE_URL is required when OPENGENI_INTEGRATIONS_ENABLED=true and OPENGENI_PRODUCT_ACCESS_MODE=managed");
    }
    if (settings.publicBaseUrl && !settings.publicBaseUrl.startsWith("https://") && !["local", "test"].includes(settings.environment)) {
      throw new Error("OPENGENI_PUBLIC_BASE_URL must use https when OPENGENI_INTEGRATIONS_ENABLED=true outside local/test");
    }
    if (!settings.integrationsStateSecret && !["local", "test"].includes(settings.environment)) {
      throw new Error("OPENGENI_INTEGRATIONS_STATE_SECRET is required when OPENGENI_INTEGRATIONS_ENABLED=true outside local/test");
    }
  }
  parseIntegrationsOauthClientsJson(settings.integrationsOauthClientsJson);
  if (
    settings.productAccessMode === "configured"
    && !["local", "test"].includes(settings.environment)
    && !settings.delegationSecret
    && !settings.authRequired
  ) {
    throw new Error("OPENGENI_PRODUCT_ACCESS_MODE=configured requires OPENGENI_DELEGATION_SECRET or OPENGENI_AUTH_REQUIRED=true outside local/test");
  }
  if (settings.billingMode === "stripe") {
    if (!settings.stripeSecretKey || !settings.stripeWebhookSecret) {
      throw new Error("OPENGENI_STRIPE_SECRET_KEY and OPENGENI_STRIPE_WEBHOOK_SECRET are required when OPENGENI_BILLING_MODE=stripe");
    }
  }
  if (settings.productAccessMode !== "managed" && settings.billingMode === "stripe") {
    throw new Error("OPENGENI_BILLING_MODE=stripe requires OPENGENI_PRODUCT_ACCESS_MODE=managed");
  }
  if (settings.billingMode === "stripe" || settings.usageLimitsMode === "managed") {
    const pricing = configuredModelPricing(settings);
    const missing = configuredAllowedModels(settings).filter((model) => !pricing[model]);
    if (missing.length > 0) {
      throw new Error(`Missing model pricing for managed billing model(s): ${missing.join(", ")}. Set OPENGENI_MODEL_PRICING_JSON.`);
    }
  }
  if (settings.usageLimitsMode === "static") {
    const limits = configuredStaticUsageLimits(settings);
    if (Object.keys(limits).length === 0) {
      throw new Error("OPENGENI_STATIC_USAGE_LIMITS_JSON must define at least one cap when OPENGENI_USAGE_LIMITS_MODE=static");
    }
  } else {
    parseStaticUsageLimitsJson(settings.staticUsageLimitsJson);
  }
  if (settings.entitlementsMode === "static") {
    const entitlements = parseStaticEntitlementsJson(settings.staticEntitlementsJson);
    if (Object.keys(entitlements).length === 0) {
      throw new Error("OPENGENI_STATIC_ENTITLEMENTS_JSON must define at least one feature when OPENGENI_ENTITLEMENTS_MODE=static");
    }
  } else {
    parseStaticEntitlementsJson(settings.staticEntitlementsJson);
  }
  if (settings.authRequired && !settings.accessKey) {
    throw new Error("OPENGENI_ACCESS_KEY is required when OPENGENI_AUTH_REQUIRED=true");
  }
  if (settings.openaiProvider === "azure") {
    if (!settings.azureOpenaiBaseUrl && !settings.azureOpenaiEndpoint) {
      throw new Error("Azure OpenAI requires OPENGENI_AZURE_OPENAI_BASE_URL or OPENGENI_AZURE_OPENAI_ENDPOINT");
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
    throw new Error("OPENGENI_MODAL_TOKEN_ID and OPENGENI_MODAL_TOKEN_SECRET must both be set or both omitted");
  }
  // Backend-gated required credentials: only the *active* backend's creds are
  // required. A modal deployment must carry the Modal token; a daytona/e2b/none
  // deployment must NOT be forced to (and is not). Drives off the single
  // SANDBOX_REQUIRED_ENV table that the deployment package also mirrors.
  for (const required of SANDBOX_REQUIRED_ENV[settings.sandboxBackend] ?? []) {
    const value = settings[required.field];
    if (value === undefined || value === null || (typeof value === "string" && value.trim().length === 0)) {
      throw new Error(`${required.env} is required when OPENGENI_SANDBOX_BACKEND=${settings.sandboxBackend}`);
    }
  }
  if (settings.objectStorageBackend === "s3-compatible" || settings.objectStorageBackend === "aws-s3") {
    if (Boolean(settings.objectStorageAccessKeyId) !== Boolean(settings.objectStorageSecretAccessKey)) {
      throw new Error("OPENGENI_OBJECT_STORAGE_ACCESS_KEY_ID and OPENGENI_OBJECT_STORAGE_SECRET_ACCESS_KEY must both be set or both omitted");
    }
    if (settings.objectStorageBackend === "s3-compatible" && (settings.objectStorageEndpoint || settings.objectStorageSandboxEndpoint) && (!settings.objectStorageAccessKeyId || !settings.objectStorageSecretAccessKey)) {
      throw new Error("S3-compatible object storage endpoints require OPENGENI_OBJECT_STORAGE_ACCESS_KEY_ID and OPENGENI_OBJECT_STORAGE_SECRET_ACCESS_KEY");
    }
    if (settings.objectStorageAzureConnectionString || settings.objectStorageAzureAccountName || settings.objectStorageAzureAccountKey || settings.objectStorageAzureEndpoint) {
      throw new Error("S3 object storage uses OPENGENI_OBJECT_STORAGE_* S3 settings, not OPENGENI_OBJECT_STORAGE_AZURE_* settings");
    }
    if (settings.objectStorageGcsProjectId || settings.objectStorageGcsCredentialsJson || settings.objectStorageGcsKeyFilename || settings.objectStorageGcsApiEndpoint) {
      throw new Error("S3 object storage uses OPENGENI_OBJECT_STORAGE_* S3 settings, not OPENGENI_OBJECT_STORAGE_GCS_* settings");
    }
  } else if (settings.objectStorageBackend === "azure-blob") {
    if (settings.objectStorageEndpoint || settings.objectStorageSandboxEndpoint || settings.objectStorageAccessKeyId || settings.objectStorageSecretAccessKey) {
      throw new Error("Azure Blob storage uses OPENGENI_OBJECT_STORAGE_AZURE_* settings, not S3-compatible object storage settings");
    }
    if (settings.objectStorageGcsProjectId || settings.objectStorageGcsCredentialsJson || settings.objectStorageGcsKeyFilename || settings.objectStorageGcsApiEndpoint) {
      throw new Error("Azure Blob storage uses OPENGENI_OBJECT_STORAGE_AZURE_* settings, not OPENGENI_OBJECT_STORAGE_GCS_* settings");
    }
    const hasConnectionString = Boolean(settings.objectStorageAzureConnectionString);
    const hasSharedKey = Boolean(settings.objectStorageAzureAccountName) && Boolean(settings.objectStorageAzureAccountKey);
    if (!hasConnectionString && !hasSharedKey) {
      throw new Error("Azure Blob storage requires OPENGENI_OBJECT_STORAGE_AZURE_CONNECTION_STRING or OPENGENI_OBJECT_STORAGE_AZURE_ACCOUNT_NAME plus OPENGENI_OBJECT_STORAGE_AZURE_ACCOUNT_KEY");
    }
  } else {
    if (settings.objectStorageEndpoint || settings.objectStorageSandboxEndpoint || settings.objectStorageAccessKeyId || settings.objectStorageSecretAccessKey) {
      throw new Error("GCS object storage uses OPENGENI_OBJECT_STORAGE_GCS_* settings, not S3-compatible object storage settings");
    }
    if (settings.objectStorageAzureConnectionString || settings.objectStorageAzureAccountName || settings.objectStorageAzureAccountKey || settings.objectStorageAzureEndpoint) {
      throw new Error("GCS object storage uses OPENGENI_OBJECT_STORAGE_GCS_* settings, not OPENGENI_OBJECT_STORAGE_AZURE_* settings");
    }
    if (settings.objectStorageGcsCredentialsJson) {
      parseGcsCredentialsJson(settings.objectStorageGcsCredentialsJson);
    }
  }
  if (settings.documentChunkOverlap >= settings.documentChunkSize) {
    throw new Error("OPENGENI_DOCUMENT_CHUNK_OVERLAP must be smaller than OPENGENI_DOCUMENT_CHUNK_SIZE");
  }
  parseExposedPorts(settings.dockerExposedPorts);
  sandboxEnvironmentVariableNames(settings);
  sandboxLifecycleHookIds(settings);
  // Fail fast on a malformed warm-rate table (P2.1).
  parseSandboxWarmRateJson(settings.sandboxWarmRateMicrosPerSecondJson);
  const serverIds = new Set<string>();
  for (const server of settings.mcpServers) {
    if (serverIds.has(server.id)) {
      throw new Error(`OPENGENI_MCP_SERVERS contains duplicate id ${server.id}`);
    }
    serverIds.add(server.id);
  }
  // --- sandbox lease cadence invariant (fail fast at boot) ---
  // reaperPeriod (30s) < viewerHolderTTL (90s), and reaperPeriod + idleGrace must
  // be strictly less than the provider lifetime (modalTimeoutSeconds*1000):
  //   - the reaper must run more often than the TTL it polices; and
  //   - the reaper must terminate a genuinely-idle box (after the full drain grace,
  //     observed on the NEXT sweep) BEFORE the provider's hard lifetime reclaims it
  //     out from under us — the provider lifetime is the backstop, not the
  //     warm-window controller. idleGrace counts from the user's last release;
  //     the provider clock counts from the preceding resume, so we leave the
  //     active-turn headroom in modalTimeoutSeconds (default 3600s).
  {
    const reaperPeriod = settings.sandboxLeaseReaperPeriodMs;
    const viewerTtl = settings.sandboxViewerHolderTtlMs;
    const idleGraceMs = settings.sandboxIdleGraceMs;
    const providerLifetimeMs = settings.modalTimeoutSeconds * 1000;
    // The EFFECTIVE box lifetime when it sits idle between turns is the Modal IDLE
    // timeout, NOT the hard lifetime (sandbox-file-persistence): a box with no
    // active connection is idle-reaped at idleTimeout. effectiveModalIdleTimeout
    // defaults to the hard lifetime (so the idle-reap never beats the OpenGeni
    // reaper), but an operator can pin it shorter — the invariants below bind the
    // reaper cadence + drain grace to the idle timeout (the REAL ceiling), so a
    // drained box always survives long enough for the reaper to snapshot it.
    const idleTimeoutMs = effectiveModalIdleTimeoutSeconds(settings) * 1000;
    if (!(reaperPeriod < viewerTtl)) {
      throw new Error(
        `OPENGENI_SANDBOX_LEASE_REAPER_PERIOD_MS (${reaperPeriod}) must be strictly less than `
        + `OPENGENI_SANDBOX_VIEWER_HOLDER_TTL_MS (${viewerTtl}): the reaper must run more often `
        + `than the TTL it polices, or stale viewer holders outlive a full reaper period.`);
    }
    if (!(idleTimeoutMs <= providerLifetimeMs)) {
      throw new Error(
        `OPENGENI_MODAL_IDLE_TIMEOUT_SECONDS*1000 (${idleTimeoutMs}) must not exceed the hard provider `
        + `lifetime (OPENGENI_MODAL_TIMEOUT_SECONDS*1000 = ${providerLifetimeMs}): the idle timeout is a `
        + `floor under the hard lifetime, not above it.`);
    }
    if (!(viewerTtl < idleTimeoutMs)) {
      throw new Error(
        `OPENGENI_SANDBOX_VIEWER_HOLDER_TTL_MS (${viewerTtl}) must be strictly less than the effective box `
        + `idle timeout (${idleTimeoutMs}): a viewer holder must be reapable before the box idles out from `
        + `under it (the provider idle-timeout is the backstop).`);
    }
    if (!(reaperPeriod + idleGraceMs < idleTimeoutMs)) {
      throw new Error(
        `OPENGENI_SANDBOX_LEASE_REAPER_PERIOD_MS + OPENGENI_SANDBOX_IDLE_GRACE_MS `
        + `(${reaperPeriod} + ${idleGraceMs} = ${reaperPeriod + idleGraceMs}) must be strictly less than the `
        + `effective box idle timeout (${idleTimeoutMs}): a drained box must SURVIVE its full warm window so `
        + `the reaper can resume + snapshot /workspace + terminate it on the sweep AFTER the drain grace `
        + `elapses — Modal's idle-reap must NOT fire first (or /workspace is lost). Raise `
        + `OPENGENI_MODAL_IDLE_TIMEOUT_SECONDS (defaults to OPENGENI_MODAL_TIMEOUT_SECONDS) or lower `
        + `OPENGENI_SANDBOX_IDLE_GRACE_MS.`);
    }
  }
  // --- stream-token secret: required-when-desktop, but GRACEFULLY DEGRADE (I8) ---
  // The desktop pixel plane needs an HMAC secret to mint scoped stream tokens.
  // It is REQUIRED when desktop is enabled — but per OD-8 a missing secret is NOT
  // a hard boot-fail: we emit a LOUD warning and the deployment ships with
  // DesktopStream.transport:null (resolveStreamTokenSecret returns undefined ->
  // negotiateCapabilities degrades the desktop cell). This keeps a desktop-
  // configured deployment bootable (headless + Channel-A still work) instead of
  // crashing the whole API on a missing secret.
  if (settings.sandboxDesktopEnabled && resolveStreamTokenSecret(settings) === undefined) {
    console.warn(
      "[opengeni] OPENGENI_SANDBOX_DESKTOP_ENABLED=true but neither OPENGENI_STREAM_TOKEN_SECRET nor "
      + "OPENGENI_DELEGATION_SECRET is set: the desktop pixel plane will GRACEFULLY DEGRADE "
      + "(DesktopStream.transport=null — no scoped stream tokens can be minted). Set "
      + "OPENGENI_STREAM_TOKEN_SECRET to enable the live desktop stream.",
    );
  }
  // Model provider registry: parse it here so JSON/zod errors surface at boot,
  // reject a registry id colliding with the built-in provider id (it would
  // shadow the built-in in configuredProviders), reject duplicate registry
  // ids, and require a resolvable API key for every registry provider (a
  // provider with no usable key can never serve a turn). Registry models flow
  // through configuredAllowedModels, so the managed-billing pricing check above
  // already covers them.
  const registryProviders = parseModelProvidersJson(settings.modelProvidersJson);
  const builtinId = builtinProviderId(settings);
  const providerIds = new Set<string>();
  for (const provider of registryProviders) {
    if (provider.id === builtinId) {
      throw new Error(`OPENGENI_MODEL_PROVIDERS_JSON provider id ${provider.id} collides with the built-in provider id`);
    }
    if (providerIds.has(provider.id)) {
      throw new Error(`OPENGENI_MODEL_PROVIDERS_JSON contains duplicate provider id ${provider.id}`);
    }
    providerIds.add(provider.id);
    if (!resolveProviderApiKey(provider)) {
      throw new Error(`OPENGENI_MODEL_PROVIDERS_JSON provider ${provider.id} requires a resolvable API key (set apiKey or apiKeyEnv)`);
    }
  }
}

/**
 * Resolve the secret used to sign/verify scoped stream tokens (master-spine
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
 * enabled but no stream-token secret is resolvable (I8/OD-8). When true,
 * negotiateCapabilities forces DesktopStream.transport:null.
 */
export function streamTokenDegraded(settings: Settings): boolean {
  return settings.sandboxDesktopEnabled && resolveStreamTokenSecret(settings) === undefined;
}

/**
 * Resolve the secret the control plane signs the enrollment bearer credential
 * with (the `oge_` envelope the agent presents back — M5/dossier §10.2). Falls
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
 * with (the `ogr_` envelope; M8b/dossier §10.5). The RELAY verifies the producer
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
 * static account user permitted to request `agent.*.rpc`.
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
  return raw.split(",").map((value) => value.trim()).filter(Boolean);
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
    throw new Error(`OPENGENI_OBJECT_STORAGE_GCS_CREDENTIALS_JSON must be valid JSON: ${message}`, { cause: error });
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

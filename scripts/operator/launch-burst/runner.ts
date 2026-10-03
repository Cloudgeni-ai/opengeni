import { z } from "zod";
import { parseSseStream } from "../../../packages/sdk/src/sse";
import { executeBounded } from "../connected-machine-load-profile";
import { freshSignup, PublicConfig, type VerificationReader } from "./auth";
import {
  Authorization,
  Cohort,
  digest,
  Intent,
  LUNA_MODEL,
  promptFor,
  publicPlan,
  validateAuthorization,
} from "./config";
import { HumanHttp, ProbeError, type FetchLike } from "./http";
import { Event, summarize, TurnObserver, type Sample } from "./measurements";

export type Clock = { mono: () => number; now: () => number; wall: () => string };
export const realClock: Clock = {
  mono: () => performance.now(),
  now: Date.now,
  wall: () => new Date().toISOString(),
};
export type RunInput = {
  intent: unknown;
  execute?: boolean;
  confirm?: boolean;
  cohortText?: string;
  authorization?: unknown;
  sourceSha: string;
  env?: Record<string, string | undefined>;
  fetchImpl?: FetchLike;
  clock?: Clock;
  verificationReader?: VerificationReader;
  checkpoint?: (result: object) => Promise<void>;
  stopRequested?: () => Promise<boolean>;
};
export async function runBurst(input: RunInput): Promise<object> {
  const intent = Intent.parse(input.intent);
  // This boundary comes before cohort parsing, credentials, callbacks or fetch.
  if (!input.execute) return publicPlan(intent);
  const env = input.env ?? process.env;
  const clock = input.clock ?? realClock;
  const cohortText = input.cohortText ?? "";
  const cohort = Cohort.parse(JSON.parse(cohortText));
  const gate = Authorization.parse(input.authorization);
  validateAuthorization({
    intent,
    cohort,
    cohortText,
    authorization: gate,
    confirm: input.confirm ?? false,
    sourceSha: input.sourceSha,
    env,
    nowMs: clock.now(),
  });
  if (intent.mode === "fresh" && !input.verificationReader)
    throw new ProbeError("mailbox_reader_required");
  const startedAt = clock.wall();
  let deploymentRevision: string | null = null;
  const samples: Sample[] = cohort.identities.map((identity) => ({
    label: identity.label,
    identityDigest: digest(
      identity.kind === "fresh" ? identity.email.toLowerCase() : identity.label,
    ),
    requestedSessionId: crypto.randomUUID(),
    sessionId: null,
    workspaceId: null,
    turnId: null,
    attemptIds: [],
    correlationId: crypto.randomUUID(),
    status: "not_started",
    stage: "not_started",
    httpStatus: null,
    errorCode: null,
    signupMs: null,
    promptSentAt: null,
    sentMonoMs: null,
    acceptedMs: null,
    workerStartMs: null,
    firstOutputMs: null,
    completionMs: null,
    receiptToOutputMs: null,
    sandboxEstablishMs: null,
    sandboxEstablishServerMs: null,
    firstCommandMs: null,
    commandCount: 0,
    commandExitCode: null,
    cleanup: "not_requested",
    terminalObservedAt: null,
  }));
  const result = (phase: string) => ({
    schemaVersion: 1,
    dryRun: false,
    sourceSha: input.sourceSha,
    runId: intent.runId,
    mode: intent.mode,
    count: intent.count,
    startedAt,
    checkpointedAt: clock.wall(),
    phase,
    authorizationRef: gate.authorizationRef,
    deploymentRevision,
    modelOverride: intent.mode === "fresh" ? null : LUNA_MODEL,
    effortOverride: intent.mode === "fresh" ? null : "low",
    costCapUsd: intent.costCapUsd,
    hardProviderCostCap: false,
    telemetry: {
      status: "not_collected",
      temporalScheduleToStart: null,
      replicasReadyPendingNodes: null,
      scaleUpAndBack: null,
      apiRestartsOom: null,
      databaseCpuConnectionsIops: null,
      natsPressure: null,
      temporalPressure: null,
    },
    samples,
    summary: summarize(samples),
  });
  // Checkpoints serialize through one writer; callbacks cannot race and regress a file.
  let writes = Promise.resolve();
  const checkpoint = (phase: string): Promise<void> => {
    const snapshot = structuredClone(result(phase));
    writes = writes.then(async () => {
      await input.checkpoint?.(snapshot);
    });
    return writes;
  };
  await checkpoint("authorized_not_started");
  const fetchImpl = input.fetchImpl ?? fetch;
  const configHttp = new HumanHttp(
    fetchImpl,
    intent.requestTimeoutMs,
    crypto.randomUUID(),
    Date.parse(gate.expiresAt),
    "",
    clock.now,
  );
  const publicSignal = AbortSignal.timeout(intent.requestTimeoutMs);
  let config: PublicConfig;
  try {
    config = PublicConfig.parse(await configHttp.json("/v1/config/client", "GET", publicSignal));
    deploymentRevision = config.deploymentRevision;
    if (intent.mode !== "plain" && config.defaultSandboxBackend !== "modal")
      throw new ProbeError("staging_default_sandbox_is_not_modal");
  } catch (error) {
    for (const sample of samples) {
      sample.stage = "client_config";
      recordFailure(sample, error, publicSignal);
    }
    await checkpoint("configuration_failed");
    return result("configuration_failed");
  }
  // Prepare auth/default evidence first, then release all ready prompt creates together.
  const ready: Array<{ http: HumanHttp; workspaceId: string } | null> = samples.map(() => null);
  await executeBounded(intent.count, intent.count, async (index) => {
    const identity = cohort.identities[index]!;
    const sample = samples[index]!;
    const signal = AbortSignal.timeout(intent.signupTimeoutMs);
    const http = new HumanHttp(
      fetchImpl,
      intent.requestTimeoutMs,
      sample.correlationId,
      Date.parse(gate.expiresAt),
      identity.kind === "existing" ? env[identity.cookieEnv]! : "",
      clock.now,
    );
    http.actorEpoch = identity.kind === "existing" ? identity.actorEpoch : undefined;
    http.contract = config.apiContractRevision;
    const authStarted = clock.mono();
    try {
      if (await input.stopRequested?.()) throw new ProbeError("operator_cutoff");
      const { workspaceId } =
        identity.kind === "fresh"
          ? await freshSignup({
              identity,
              http,
              config,
              password: env[identity.passwordEnv]!,
              verificationReader: input.verificationReader!,
              signal,
              stage: (stage) => {
                sample.stage = stage;
              },
              now: clock.now,
            })
          : { workspaceId: identity.workspaceId };
      sample.workspaceId = workspaceId;
      if (identity.kind === "fresh") sample.signupMs = clock.mono() - authStarted;
      sample.stage = "model_catalog";
      const catalog = z
        .object({
          defaultSelection: z
            .object({ model: z.string(), reasoningEffort: z.string(), source: z.string() })
            .optional(),
          models: z.array(
            z.object({
              id: z.string(),
              cost: z.string(),
              availability: z.object({ selectable: z.boolean() }),
            }),
          ),
        })
        .parse(await http.json(`/v1/workspaces/${workspaceId}/model-catalog`, "GET", signal));
      const luna = catalog.models.find((model) => model.id === LUNA_MODEL);
      if (!luna?.availability.selectable || luna.cost !== "credits")
        throw new ProbeError("credits_luna_unavailable");
      if (
        identity.kind === "fresh" &&
        (catalog.defaultSelection?.model !== LUNA_MODEL ||
          catalog.defaultSelection.reasoningEffort !== "xhigh" ||
          catalog.defaultSelection.source !== "credits")
      )
        throw new ProbeError("actual_fresh_default_is_not_credits_luna_xhigh");
      ready[index] = { http, workspaceId };
      sample.stage = "ready_at_prompt_barrier";
    } catch (error) {
      recordFailure(sample, error, signal);
    }
  });
  await checkpoint("auth_and_defaults_prepared");
  await executeBounded(intent.count, intent.count, async (index) => {
    const prepared = ready[index];
    if (!prepared) return;
    const sample = samples[index]!;
    const controller = new AbortController();
    const timer = setTimeout(
      () => controller.abort(new ProbeError("turn_timeout")),
      intent.turnTimeoutMs,
    );
    const cutoff = input.stopRequested
      ? setInterval(() => {
          void input.stopRequested!()
            .then((stop) => {
              if (stop) controller.abort(new ProbeError("operator_cutoff"));
            })
            .catch(() => controller.abort(new ProbeError("operator_cutoff_read_failed")));
        }, 250)
      : null;
    let terminal = false;
    try {
      if (await input.stopRequested?.()) throw new ProbeError("operator_cutoff");
      sample.stage = "create_session";
      sample.promptSentAt = clock.wall();
      sample.sentMonoMs = clock.mono();
      const session = z
        .object({
          id: z.string().uuid(),
          model: z.string(),
          reasoningEffort: z.string(),
          sandboxBackend: z.string(),
        })
        .parse(
          await prepared.http.json(
            `/v1/workspaces/${prepared.workspaceId}/sessions`,
            "POST",
            controller.signal,
            {
              requestedSessionId: sample.requestedSessionId,
              idempotencyKey: `${intent.runId}-${sample.label}`,
              initialMessage: promptFor(intent.mode),
              ...(intent.mode === "fresh" ? {} : { model: LUNA_MODEL, reasoningEffort: "low" }),
              ...(intent.mode === "plain" ? { sandboxBackend: "none" } : {}),
              sandbox: "new",
              resources: [],
              tools: [],
              mcpServers: [],
              bundledSkillIds: [],
              firstPartyMcpTools: intent.mode === "plain" ? [] : ["exec_command"],
              metadata: {
                launchBurstRunId: intent.runId,
                launchBurstMode: intent.mode,
                launchBurstIdentity: sample.label,
              },
            },
          ),
        );
      sample.sessionId = session.id;
      sample.acceptedMs = clock.mono() - sample.sentMonoMs;
      if (
        session.id !== sample.requestedSessionId ||
        session.model !== LUNA_MODEL ||
        session.reasoningEffort !== (intent.mode === "fresh" ? "xhigh" : "low") ||
        session.sandboxBackend !== (intent.mode === "plain" ? "none" : "modal")
      )
        throw new ProbeError("accepted_session_policy_mismatch");
      await checkpoint("session_accepted");
      sample.stage = "stream";
      const response = await prepared.http.request(
        `/v1/workspaces/${prepared.workspaceId}/sessions/${session.id}/events/stream?after=0`,
        "GET",
        controller.signal,
      );
      if (!response.body || !response.headers.get("content-type")?.includes("text/event-stream"))
        throw new ProbeError("not_an_sse_response");
      const observer = new TurnObserver(sample, intent.mode);
      let sequence = 0;
      // No retries or hidden warm-ups: a transport gap/close remains a failed initial attempt.
      for await (const message of parseSseStream(response.body)) {
        if (await input.stopRequested?.()) {
          controller.abort(new ProbeError("operator_cutoff"));
          break;
        }
        const event = Event.parse(JSON.parse(message.data));
        if (event.sequence <= sequence) continue;
        if (event.sequence !== sequence + 1) throw new ProbeError("sse_sequence_gap");
        // Match the SDK's trustedSseSequence: only the transport id can cover
        // coalesced raw events, never producer-controlled payload/body fields.
        const covered =
          message.id !== undefined && /^\d+$/.test(message.id)
            ? Number(message.id)
            : event.sequence;
        sequence =
          Number.isSafeInteger(covered) && covered >= event.sequence ? covered : event.sequence;
        terminal = observer.observe(event, clock.mono(), clock.wall());
        if (terminal) break;
      }
      if (!terminal) {
        controller.signal.throwIfAborted();
        sample.status = "stream_closed";
        sample.errorCode = "stream_closed_before_terminal";
        sample.cleanup = "held_unknown";
      }
    } catch (error) {
      recordFailure(sample, error, controller.signal);
      sample.cleanup = "held_unknown";
    } finally {
      clearTimeout(timer);
      if (cutoff !== null) clearInterval(cutoff);
    }
    // DELETE is the public quiescence-fenced lifecycle request, not a Modal RPC.
    // Only after durable terminal evidence; unknown/timeouts remain held for owner reconciliation.
    if (terminal && sample.sessionId) {
      try {
        await prepared.http.json(
          `/v1/workspaces/${prepared.workspaceId}/sessions/${sample.sessionId}`,
          "DELETE",
          AbortSignal.timeout(intent.requestTimeoutMs),
        );
        sample.cleanup = "requested";
      } catch {
        sample.cleanup = "failed";
      }
    }
    await checkpoint("session_settled");
  });
  await checkpoint("complete");
  return result("complete");
}
function recordFailure(sample: Sample, error: unknown, signal: AbortSignal) {
  const operatorCutoff =
    signal.reason instanceof ProbeError && signal.reason.code.startsWith("operator_cutoff");
  sample.status = signal.aborted && !operatorCutoff ? "timeout" : "failed";
  sample.httpStatus = error instanceof ProbeError ? error.status : null;
  sample.errorCode =
    error instanceof ProbeError
      ? error.code
      : signal.aborted
        ? "deadline"
        : error instanceof z.ZodError
          ? "response_contract_invalid"
          : "transport_or_local_failure";
}

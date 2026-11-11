import {
  decisionModelRoute,
  publicDecisionModelSettings,
  sideFeatureProcessingResidency,
  type Settings,
} from "@opengeni/config";
import {
  ModelCallError,
  settingsWithInferenceResidency,
  settleModelUsage,
  type DecisionCallService,
  type DecisionCallInput,
} from "@opengeni/core";
import type { Database } from "@opengeni/db";
import { DecisionError, type DecisionUsage } from "@opengeni/decisions";
import {
  configuredDecisionModel,
  assertSideFeatureRoute,
  normalizeModelCallUsage,
  withInferenceResidency,
} from "@opengeni/runtime/model-call";
import { withAccessGrantSessionRlsContext } from "../access-grant-rls";

/** Platform-funded, stateless judgments. No session/turn, allowance admission or customer debit. */
export function createDecisionCallService(deps: {
  db: Database;
  settings: Settings;
  fetch?: typeof fetch;
  log?: (message: string, attributes: Record<string, string | number>) => void;
}): DecisionCallService {
  // Content-free receipts only. Writes and DB-only retries never delay a provider answer.
  // Like other off-path API telemetry, abrupt process loss before persistence can lose a receipt.
  const receipts = new Map<string, () => Promise<unknown>>();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let flushing: Promise<void> | undefined;
  const schedule = (delay: number) => {
    if (timer) return;
    timer = setTimeout(() => {
      timer = undefined;
      void flushUsage().catch(() => undefined);
    }, delay);
    timer.unref?.();
  };
  const flushUsage = (): Promise<void> => {
    if (flushing) return flushing;
    if (timer) {
      clearTimeout(timer);
      timer = undefined;
    }
    flushing = (async () => {
      let failed = false;
      for (const [id, write] of receipts) {
        try {
          await write();
          receipts.delete(id);
        } catch (error) {
          failed = true;
          deps.log?.("Decision usage receipt write failed", {
            requestId: id,
            errorName: error instanceof Error ? error.name : typeof error,
          });
        }
      }
      if (failed) throw new Error("Decision usage receipts remain pending");
    })().finally(() => {
      flushing = undefined;
      if (receipts.size) schedule(1000);
    });
    return flushing;
  };
  return {
    flushUsage,
    async decide(input: DecisionCallInput) {
      input.signal?.throwIfAborted();
      const settings = publicDecisionModelSettings(
        await withAccessGrantSessionRlsContext(deps, input.grant, () =>
          settingsWithInferenceResidency(deps.db, {
            accountId: input.accountId,
            workspaceId: input.workspaceId,
            settings: deps.settings,
          }),
        ),
      );
      const target = decisionModelRoute(settings);
      if (target) assertSideFeatureRoute(settings, target);
      const configured = configuredDecisionModel(settings, deps.fetch ? { fetch: deps.fetch } : {});
      if (!configured || !target)
        throw new ModelCallError({
          status: 503,
          type: "service_unavailable",
          code: "unavailable",
          message: "The deployment's decision model is not configured.",
        });
      const record = (usage: DecisionUsage) => {
        const model = `${usage.provider}/${usage.model}`;
        const receipt = {
          accountId: input.accountId,
          workspaceId: input.workspaceId,
          model,
          chargesOpenGeniCredits: false,
          countsTowardTokenCap: true,
          byok: false,
          billingOrigin: "api" as const,
          sourceId: `model_call:${input.requestId}`,
          processingResidency: sideFeatureProcessingResidency(settings, target),
          initiator: {
            kind:
              input.grant.principalKind === "api_key" || input.grant.principalKind === "service"
                ? ("service" as const)
                : ("subject" as const),
            subjectId: input.subjectId,
          },
          initiatorContext: {
            modelCallId: input.requestId,
            model,
            usage,
            ...(input.request.tenantLabel !== undefined
              ? { tenantLabel: input.request.tenantLabel }
              : {}),
          },
          normalizedUsage: normalizeModelCallUsage({
            ...(usage.inputTokens !== null ? { inputTokens: usage.inputTokens } : {}),
            ...(usage.outputTokens !== null ? { outputTokens: usage.outputTokens } : {}),
          }),
          externalProviderCost:
            usage.costUsd !== null && usage.costSource !== "unknown"
              ? { costUsd: usage.costUsd, source: usage.costSource }
              : null,
        };
        receipts.set(input.requestId, () => settleModelUsage(settings, deps.db, receipt));
      };
      try {
        const result = await withInferenceResidency(settings, () =>
          configured.model.decide(input.request.input, input.request.questions, {
            ...(input.signal ? { signal: input.signal } : {}),
            onUsage: record,
          }),
        );
        return {
          id: input.requestId,
          object: "decision",
          model: `${result.usage.provider}/${result.usage.model}`,
          ...(input.request.tenantLabel !== undefined
            ? { tenantLabel: input.request.tenantLabel }
            : {}),
          ...result,
        };
      } catch (error) {
        if (error instanceof DecisionError)
          throw new ModelCallError({
            status: error.status === 429 ? 429 : 502,
            type: error.status === 429 ? "rate_limit_error" : "api_error",
            code: error.status === 429 ? "provider_rate_limited" : "provider_error",
            message: "The decision provider could not complete the request.",
          });
        throw error;
      } finally {
        if (receipts.size) schedule(0);
      }
    },
  };
}

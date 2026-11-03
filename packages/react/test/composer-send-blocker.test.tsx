import { afterEach, describe, expect, test } from "bun:test";
import type { WorkspaceModelCatalogModel } from "@opengeni/sdk";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import {
  ComposerSendBlockerNotice,
  composerSendBlockerIsLoading,
  composerSendBlockerNotice,
  getComposerSendBlocker,
  getNewSessionSendBlocker,
  NewSessionCreateFailureNotice,
  newSessionCreateFailureRecord,
  newSessionSendSignature,
  newSessionStartBlockerReason,
  pickerPolicyRunnable,
  visibleNewSessionCreateFailure,
  type ComposerSendBlocker,
  type NewSessionCreateFailure,
  type NewSessionSendState,
} from "../src/app/lib/composer-send-blocking";
import { coveredModelChoice } from "../src/app/lib/free-credit-gap";
import { composerFallbackModel } from "../src/app/lib/model-access-onboarding";
import { findPickerRow, projectPickerRows } from "../src/model-policy";
import { createOpenGeniText } from "../src/messages/runtime";
import { composerSubmissionCanRetry, composerSubmissionErrorMessage } from "../src/lib/format";
import { OpenGeniApiError } from "@opengeni/sdk";
import { registerDom } from "./render-hook";

registerDom();

const t = createOpenGeniText();

/**
 * The catalog a workspace sees after connecting a ChatGPT Free account: the
 * account's /models list offers only GPT-6 Luna, so Sol and Astra are not
 * entitled. Luna has no Ultrafast speed.
 */
function codexModel(
  slug: string,
  label: string,
  options: { entitled: boolean; ultrafast: boolean },
): WorkspaceModelCatalogModel {
  return {
    id: `codex/${slug}`,
    label,
    provider: "codex-subscription",
    providerLabel: "ChatGPT",
    source: "codex",
    api: "responses",
    cost: "subscription",
    capabilities: {
      reasoning: {
        upstream: "supported",
        runnable: true,
        efforts: ["low", "medium", "high", "xhigh"],
        defaultEffort: "medium",
        required: false,
      },
      functionCalling: { upstream: "supported", runnable: true },
      structuredOutput: { upstream: "supported", runnable: true },
      hostedTools: {
        webSearch: { upstream: "unsupported", runnable: false },
        xSearch: { upstream: "unsupported", runnable: false },
        codeExecution: { upstream: "unsupported", runnable: false },
      },
      inputModalities: ["text"],
      outputModalities: ["text"],
      transports: {
        sse: { upstream: "supported", runnable: true },
        responsesWebSocket: { upstream: "unsupported", runnable: false },
        realtimeAudio: { upstream: "unsupported", runnable: false },
      },
      // As the catalog declares them: Ultrafast only on Astra.
      latencyModes: [
        { id: "standard", upstream: "supported", runnable: true },
        { id: "fast", upstream: "supported", runnable: true },
        ...(options.ultrafast ? [{ id: "ultrafast", upstream: "supported", runnable: true }] : []),
      ],
    },
    credentialReadiness: {
      status: "ready",
      reason: null,
      basis: "configuration",
      checkedAt: null,
    },
    availability: options.entitled
      ? { status: "available", selectable: true, reason: null, checkedAt: null }
      : {
          status: "unavailable",
          selectable: false,
          reason: "not_entitled",
          checkedAt: "2026-11-02T15:59:00.000Z",
        },
  } as unknown as WorkspaceModelCatalogModel;
}

const FREE_PLAN_MODELS = [
  codexModel("gpt-6-astra", "GPT-6 Astra", { entitled: false, ultrafast: true }),
  codexModel("gpt-6-sol", "GPT-6 Sol", { entitled: false, ultrafast: false }),
  codexModel("gpt-6-luna", "GPT-6 Luna", { entitled: true, ultrafast: false }),
];

const READY: NewSessionSendState = {
  created: false,
  draftLoading: false,
  catalogLoading: false,
  catalogFailed: false,
  replacingModel: false,
  policyValid: true,
  anyModelSelectable: true,
  selectedModelNotConnected: false,
  selectedModelSelectable: true,
  privateSessionUnavailable: false,
  toolsLoading: false,
  accountsLoading: false,
  accountsFailed: false,
  accountChoice: false,
  resourcesLoading: false,
  resourcesResolved: true,
  uploadPending: false,
  computeLoading: false,
  computeReady: true,
};

/** The new-chat composer's state for a model choice against the Free-plan catalog. */
function freePlanSendState(
  model: string,
  effort: "medium" | "xhigh",
  latency: "standard" | "ultrafast",
): NewSessionSendState {
  const rows = projectPickerRows(t, FREE_PLAN_MODELS);
  const row = findPickerRow(rows, model);
  return {
    ...READY,
    policyValid: pickerPolicyRunnable(row, effort, latency),
    anyModelSelectable: rows.some((candidate) => candidate.selectable),
    selectedModelSelectable: row?.selectable === true,
  };
}

let mounted: { root: Root; container: HTMLElement } | null = null;

afterEach(async () => {
  if (!mounted) return;
  const current = mounted;
  mounted = null;
  await act(async () => current.root.unmount());
  current.container.remove();
});

async function mount(node: React.ReactNode): Promise<HTMLElement> {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  mounted = { root, container };
  await act(async () => root.render(node));
  return container;
}

describe("a ChatGPT Free account's catalog", () => {
  test("offers only GPT-6 Luna, and Luna on standard speed can send", () => {
    const rows = projectPickerRows(t, FREE_PLAN_MODELS);
    expect(rows.filter((row) => row.selectable).map((row) => row.id)).toEqual(["codex/gpt-6-luna"]);
    expect(
      getNewSessionSendBlocker(freePlanSendState("codex/gpt-6-luna", "medium", "standard")),
    ).toBeNull();
  });

  test("a saved model the plan lacks is replaced by Luna", () => {
    const rows = projectPickerRows(t, FREE_PLAN_MODELS);
    const fallback = composerFallbackModel({
      models: FREE_PLAN_MODELS,
      rows,
      defaultSelection: null,
    });
    expect(fallback?.id).toBe("codex/gpt-6-luna");
    // Until no replacement exists, the line names the problem.
    expect(
      getNewSessionSendBlocker(freePlanSendState("codex/gpt-6-sol", "medium", "standard")),
    ).toBe("model_unavailable");
  });

  test("a saved Ultrafast speed blocks Send with a visible line and a one-click fix", async () => {
    // Before this change the only message for this lived inside the closed
    // model menu: Send stayed disabled and nothing appeared.
    const state = freePlanSendState("codex/gpt-6-luna", "medium", "ultrafast");
    const blocker = getNewSessionSendBlocker(state);
    expect(blocker).toBe("policy");
    expect(composerSendBlockerIsLoading(blocker)).toBe(false);
    const actions: string[] = [];
    const container = await mount(
      <ComposerSendBlockerNotice blocker={blocker} onAction={(action) => actions.push(action)} />,
    );
    expect(container.textContent).toContain(
      "This model can't run with the selected reasoning level or speed.",
    );
    const button = container.querySelector("button");
    expect(button?.textContent).toBe("Use supported settings");
    await act(async () => button?.click());
    expect(actions).toEqual(["fix_model_settings"]);

    // The fix keeps Luna and the effort, and moves to a speed the plan offers.
    const rows = projectPickerRows(t, FREE_PLAN_MODELS);
    const choice = coveredModelChoice(
      findPickerRow(rows, "codex/gpt-6-luna")!,
      "medium",
      "ultrafast",
    );
    expect(choice).toEqual({
      model: "codex/gpt-6-luna",
      effort: "medium",
      latencyMode: "standard",
    });
    expect(
      getNewSessionSendBlocker(freePlanSendState("codex/gpt-6-luna", "medium", "standard")),
    ).toBeNull();
  });
});

describe("the new-chat Send guard", () => {
  test("every state Send depends on maps to one blocker", () => {
    expect(getNewSessionSendBlocker(READY)).toBeNull();
    for (const [change, expected] of [
      [{ draftLoading: true }, "loading"],
      [{ catalogLoading: true }, "loading"],
      [{ replacingModel: true }, "loading"],
      [{ policyValid: false, catalogFailed: true }, "model_catalog"],
      [{ policyValid: false, anyModelSelectable: false }, "no_model"],
      [{ policyValid: false, selectedModelNotConnected: true }, "model_not_connected"],
      [{ policyValid: false, selectedModelSelectable: false }, "model_unavailable"],
      [{ policyValid: false }, "policy"],
      [{ privateSessionUnavailable: true }, "private_session"],
      // Capabilities still loading in a Personal workspace: wait, never a false "unavailable".
      [{ privateSessionLoading: true, privateSessionUnavailable: true }, "loading"],
      [{ toolsLoading: true }, "loading"],
      [{ accountsLoading: true }, "loading"],
      [{ accountsFailed: true }, "accounts"],
      [{ accountChoice: true }, "account_choice"],
      [{ resourcesLoading: true }, "loading"],
      [{ resourcesResolved: false }, "resources"],
      [{ uploadPending: true }, "upload"],
      [{ computeLoading: true }, "loading"],
      [{ computeReady: false }, "compute"],
    ] as const) {
      expect(getNewSessionSendBlocker({ ...READY, ...change })).toBe(expected);
    }
  });

  test("a catalog refresh failure does not block a choice that still runs", () => {
    expect(getNewSessionSendBlocker({ ...READY, catalogFailed: true })).toBeNull();
  });

  test("voice skips the connected-tool accounts; a created session skips its setup", () => {
    expect(getNewSessionSendBlocker({ ...READY, voice: true, accountChoice: true })).toBeNull();
    expect(
      getNewSessionSendBlocker({
        ...READY,
        created: true,
        accountsFailed: true,
        resourcesResolved: false,
        computeReady: false,
      }),
    ).toBeNull();
    expect(getNewSessionSendBlocker({ ...READY, created: true, policyValid: false })).toBe(
      "policy",
    );
  });

  test("analytics keep their recorded reason names", () => {
    expect(newSessionStartBlockerReason("loading")).toBeNull();
    expect(newSessionStartBlockerReason("no_model")).toBe("no_model_connected");
    expect(newSessionStartBlockerReason("model_unavailable")).toBe("model_policy_unavailable");
    expect(newSessionStartBlockerReason("compute")).toBe("compute_unavailable");
  });
});

describe("every blocker is visible", () => {
  // Explained by their own surface: the upload chip, the personal access
  // card, the machine access notice, the picker's Connect state and the
  // accounts choice in the composer. Loading holds an early Send instead.
  const OWN_SURFACE = new Set<ComposerSendBlocker>([
    "upload",
    "personal_decision",
    "machine_permission",
    "no_model",
    "account_choice",
    "loading",
    "personal_loading",
  ]);
  const ALL: ComposerSendBlocker[] = [
    "upload",
    "repository",
    "policy",
    "personal_decision",
    "machine_permission",
    "personal_loading",
    "loading",
    "model_catalog",
    "no_model",
    "model_not_connected",
    "model_unavailable",
    "private_session",
    "accounts",
    "accounts_denied",
    "updating",
    "account_choice",
    "resources",
    "compute",
  ];

  test("each other blocker has one short line and at most one action", () => {
    for (const blocker of ALL) {
      const notice = composerSendBlockerNotice(blocker);
      if (OWN_SURFACE.has(blocker)) {
        expect(notice).toBeNull();
        continue;
      }
      expect(notice?.message.length).toBeGreaterThan(0);
      expect(notice!.message.length).toBeLessThan(80);
    }
  });

  test("a host that explains a blocker itself hides the line", async () => {
    const container = await mount(
      <ComposerSendBlockerNotice blocker="accounts" explained={["accounts"]} />,
    );
    expect(container.textContent).toBe("");
  });

  test("an open chat whose accounts failed to load says so instead of waiting", () => {
    const ready = {
      uploadPending: false,
      repositoryError: null,
      policyValid: true,
      personalDecision: false,
      personalLoading: false,
    };
    expect(getComposerSendBlocker({ ...ready, loadFailed: "failed" })).toBe("accounts");
    // A permission denial can't be retried, and a brief outage reconnects by itself.
    expect(getComposerSendBlocker({ ...ready, loadFailed: "denied" })).toBe("accounts_denied");
    expect(composerSendBlockerNotice("accounts_denied")?.action).toBeNull();
    expect(getComposerSendBlocker({ ...ready, loadFailed: "updating" })).toBe("updating");
    expect(composerSendBlockerNotice("updating")?.action).toBeNull();
    expect(getComposerSendBlocker({ ...ready, personalLoading: true, loadFailed: "failed" })).toBe(
      "personal_loading",
    );
  });
});

describe("a refused new chat stays visible", () => {
  // Production: Codex Luna + Low on a ChatGPT Free connection got a 422 from
  // POST /sessions; the only signal was a toast, so the chat looked like nothing happened.
  const sent = newSessionSendSignature({
    text: "hello",
    model: "codex/gpt-6-luna",
    reasoningEffort: "low",
    latencyMode: "standard",
  });
  const refusal = new OpenGeniApiError(
    422,
    JSON.stringify({
      code: "SESSION_CREATE_REJECTED",
      message: 'model "codex/gpt-6-luna" is not allowed by this workspace\'s model policy',
    }),
  );
  const failure: NewSessionCreateFailure = {
    workspaceId: "ws-1",
    signature: sent,
    message: composerSubmissionErrorMessage(t, refusal),
  };

  test("the server's reason is shown under the composer, not only in a toast", async () => {
    const message = visibleNewSessionCreateFailure(failure, {
      workspaceId: "ws-1",
      signature: sent,
    });
    expect(message).toContain("model policy");
    const container = await mount(<NewSessionCreateFailureNotice message={message} />);
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("model policy");
  });

  test("each create refusal names its reason instead of 'check your input'", () => {
    const generic = "The request could not be accepted. Check your input and try again.";
    expect(failure.message).toBe(
      'Model "codex/gpt-6-luna" is not allowed by this workspace\'s model policy.',
    );
    const speed = new OpenGeniApiError(
      422,
      JSON.stringify({
        code: "SESSION_CREATE_REJECTED",
        message: "latency mode fast is not runnable for model codex/gpt-6-luna (allowed: standard)",
        details: { code: "UNSUPPORTED_LATENCY_MODE", allowedLatencyModes: ["standard"] },
      }),
    );
    expect(composerSubmissionErrorMessage(t, speed)).toBe(t("lib.format.speedUnavailable"));
    const model = new OpenGeniApiError(
      422,
      JSON.stringify({
        code: "SESSION_CREATE_REJECTED",
        message: "model is not available: codex/gpt-6-sol",
        details: { code: "model_unavailable", modelId: "codex/gpt-6-sol" },
      }),
    );
    // A new chat has no "chat's model": the refusal names the choice instead.
    expect(composerSubmissionErrorMessage(t, model)).toBe(t("lib.format.newChatModelUnavailable"));
    const notSelectable = new OpenGeniApiError(
      422,
      JSON.stringify({
        code: "SESSION_CREATE_REJECTED",
        message: "model is not selectable: codex/gpt-6-sol",
        details: { code: "model_unavailable", modelId: "codex/gpt-6-sol" },
      }),
    );
    expect(composerSubmissionErrorMessage(t, notSelectable)).toBe(
      t("lib.format.newChatModelUnavailable"),
    );
    const policy = (reason: string) =>
      new OpenGeniApiError(
        422,
        JSON.stringify({
          code: "SESSION_CREATE_REJECTED",
          message: `model "codex/gpt-6-sol" is not allowed by this workspace's model policy`,
          details: { code: "model_policy", modelId: "codex/gpt-6-sol", reason },
        }),
      );
    expect(composerSubmissionErrorMessage(t, policy("credits"))).toBe(
      t("lib.format.modelPolicyCredits"),
    );
    expect(composerSubmissionErrorMessage(t, policy("provider"))).toBe(
      t("lib.format.modelPolicyRefused"),
    );
    // Typed refusals never show developer text such as model ids.
    for (const error of [model, notSelectable, policy("credits"), policy("model")]) {
      expect(composerSubmissionErrorMessage(t, error)).not.toContain("codex/");
    }
    // An open chat's turn refusal keeps its own wording.
    const turnRefusal = new OpenGeniApiError(
      422,
      JSON.stringify({
        error: {
          code: "validation_failed",
          message: "model is not available: codex/gpt-6-sol",
          details: { code: "model_unavailable" },
        },
      }),
    );
    expect(composerSubmissionErrorMessage(t, turnRefusal)).toBe(t("lib.format.modelUnavailable"));
    for (const message of [failure.message, composerSubmissionErrorMessage(t, speed)]) {
      expect(message).not.toBe(generic);
    }
  });

  test("it clears once the person changes the text, model, reasoning level or speed", () => {
    for (const change of [
      { text: "hello!" },
      { model: "codex/gpt-6-sol" },
      { reasoningEffort: "medium" as const },
      { latencyMode: "fast" as const },
    ]) {
      const signature = newSessionSendSignature({
        text: "hello",
        model: "codex/gpt-6-luna",
        reasoningEffort: "low",
        latencyMode: "standard",
        ...change,
      });
      expect(
        visibleNewSessionCreateFailure(failure, {
          workspaceId: "ws-1",
          signature,
        }),
      ).toBeNull();
    }
    expect(
      visibleNewSessionCreateFailure(failure, {
        workspaceId: "ws-2",
        signature: sent,
      }),
    ).toBeNull();
    expect(
      visibleNewSessionCreateFailure(null, {
        workspaceId: "ws-1",
        signature: sent,
      }),
    ).toBeNull();
  });

  test("a refusal that lands after the composer changed is never silent", () => {
    // Typing (or a voice link's model) changed what the composer holds while
    // the create was in flight: the line would be hidden at once, so the
    // caller must keep its toast instead.
    const typedMore = newSessionSendSignature({
      text: "hello there",
      model: "codex/gpt-6-luna",
      reasoningEffort: "low",
      latencyMode: "standard",
    });
    expect(
      newSessionCreateFailureRecord({
        workspaceId: "ws-1",
        sent,
        current: typedMore,
        message: failure.message,
      }),
    ).toBeNull();
    // Unchanged: the line is recorded and visible for exactly what was sent.
    const record = newSessionCreateFailureRecord({
      workspaceId: "ws-1",
      sent,
      current: sent,
      message: failure.message,
    });
    expect(visibleNewSessionCreateFailure(record, { workspaceId: "ws-1", signature: sent })).toBe(
      failure.message,
    );
  });

  test("a model policy refusal offers no retry that would be refused again", () => {
    for (const code of ["SESSION_CREATE_REJECTED", undefined]) {
      const policy = new OpenGeniApiError(
        422,
        JSON.stringify(
          code
            ? {
                code,
                message: "model is not allowed",
                details: { code: "model_policy", modelId: "codex/gpt-6-sol", reason: "model" },
              }
            : {
                error: {
                  code: "validation_failed",
                  message: "model is not allowed",
                  details: { code: "model_policy", modelId: "codex/gpt-6-sol", reason: "model" },
                },
              },
        ),
      );
      expect(composerSubmissionCanRetry(policy)).toBe(false);
    }
  });
});

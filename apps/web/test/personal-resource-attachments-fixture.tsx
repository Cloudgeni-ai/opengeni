import { usePersonalResourceScopeChoice } from "../src/lib/use-personal-resource-scope-choice";
import {
  newSessionPersonalResourceAttachment,
  buildPersonalResourceAttachmentIntent,
} from "../src/lib/personal-resource-attachments";
import { FailedSessionBanner } from "../src/components/session/failed-session-banner";
import { SessionChrome, type UseTurnQueueResult } from "@opengeni/react";
import { useMemo, useState } from "react";
import { createRoot } from "react-dom/client";

import { PersonalResourceAttachmentSurface as PersonalResourceAttachmentControl } from "../src/components/personal-resource-attachment-surface";
import type {
  PersonalResourceAttachmentController,
  PersonalResourceNotice,
} from "../src/lib/use-personal-resource-attachment";
import "../src/styles.css";

const variableSet = {
  id: "11111111-1111-4111-8111-111111111111",
  accountId: "22222222-2222-4222-8222-222222222222",
  workspaceId: "33333333-3333-4333-8333-333333333333",
  scope: "user" as const,
  generation: 1,
  status: "active" as const,
  name: "Private deploy keys",
  description: null,
  variables: [],
  createdAt: "2026-08-20T08:00:00.000Z",
  updatedAt: "2026-08-20T08:00:00.000Z",
};

function Fixture() {
  const [principal, setPrincipal] = useState("owner");
  const [epoch, setEpoch] = useState(3);
  const [sourceLost, setSourceLost] = useState(false);
  const [authorityUnavailable, setAuthorityUnavailable] = useState(false);
  const [notice, setNotice] = useState<PersonalResourceNotice | null>(null);
  const [createReceipt, setCreateReceipt] = useState("");
  const [sendReceipt, setSendReceipt] = useState("");

  const createChoice = usePersonalResourceScopeChoice(
    principal + ":new:" + sourceLost,
    "workspace",
  );
  const sendChoice = usePersonalResourceScopeChoice(
    principal + ":existing:" + sourceLost,
    "workspace",
  );
  const controller = useMemo<PersonalResourceAttachmentController>(() => {
    const resourceCount = principal === "owner" && !sourceLost && !authorityUnavailable ? 1 : 0;
    const intent =
      resourceCount > 0
        ? {
            mode: sendChoice.mode,
            expectedAuthorityEpoch: epoch,
            workspaceSharedAcknowledged: true,
            sharedOutputWarningVersion: 1 as const,
          }
        : undefined;
    return {
      eligible: principal === "owner",
      loading: false,
      refreshing: false,
      error: authorityUnavailable ? new Error("bounded authority closure unavailable") : null,
      notice,
      sourceLost,
      truncated: authorityUnavailable,
      catalog: null,
      selected: {
        variableSets: resourceCount > 0 ? [variableSet] : [],
        rigs: [],
        connectedMachines: [],
        resourceCount,
        personalResourceCount: resourceCount,
        closureUnverified: false,
      },
      mode: resourceCount > 0 ? sendChoice.mode : null,
      setMode: sendChoice.setMode,
      ongoingScope: null,
      visibility: "workspace",
      requiresDecision: sourceLost || authorityUnavailable,
      intent,
      refresh: async () => undefined,
      onAccepted: () => undefined,
      onDeliveryError: () => undefined,
    };
  }, [
    authorityUnavailable,
    epoch,
    notice,
    principal,
    sourceLost,
    sendChoice.mode,
    sendChoice.setMode,
  ]);

  const resetDecision = (message: PersonalResourceNotice | null) => {
    setNotice(message);
  };

  return (
    <main className="mx-auto grid max-w-3xl min-w-0 gap-8 [&>*]:min-w-0 p-4 sm:p-8">
      <style>{"html, body, #root { height: auto; min-height: 100%; overflow: visible; }"}</style>
      <h1 className="text-xl font-semibold">Personal attachment acceptance fixture</h1>
      <section aria-labelledby="create-heading">
        <h2 id="create-heading" className="font-medium">
          New session create
        </h2>
        <PersonalResourceAttachmentControl
          controller={{ ...controller, mode: createChoice.mode, setMode: createChoice.setMode }}
        />
        <button
          type="button"
          className="mt-3 rounded-md border p-2"
          disabled={!controller.intent}
          onClick={() => {
            setCreateReceipt(
              JSON.stringify(
                newSessionPersonalResourceAttachment({
                  personalResourceCount: controller.selected.resourceCount,
                  visibility: "workspace",
                  mode: createChoice.mode,
                }).intent,
              ),
            );
            createChoice.consume(createChoice.mode);
          }}
        >
          Create session
        </button>
        <output className="block text-xs break-all" data-testid="create-receipt">
          {createReceipt}
        </output>
      </section>
      <section aria-labelledby="send-heading">
        <h2 id="send-heading" className="font-medium">
          Existing session Send and Steer
        </h2>
        <PersonalResourceAttachmentControl controller={controller} />
        <button
          type="button"
          className="mr-2 rounded-md border p-2"
          onClick={() => {
            setSendReceipt(JSON.stringify(controller.intent));
            sendChoice.consume(sendChoice.mode);
          }}
          disabled={!controller.intent}
        >
          Send
        </button>
        <button
          type="button"
          className="rounded-md border p-2"
          onClick={() => {
            setSendReceipt(JSON.stringify({ delivery: "steer", ...controller.intent }));
            sendChoice.consume(sendChoice.mode);
          }}
          disabled={!controller.intent}
        >
          Steer
        </button>
        <FailedSessionBanner
          failure={{
            reason: "matching personal-resource grant required",
            failedAt: "2026-09-07T14:11:21Z",
            failureEventId: "failure-one",
            recoveryCount: 0,
            failedTurnCount: 0,
          }}
          actions={{
            failureId: "failure-one",
            continuationBlocker: null,
            composerBlocker: controller.intent ? null : "personal_decision",
            onContinue: async () => {
              setSendReceipt(
                JSON.stringify({
                  delivery: "continue",
                  ...buildPersonalResourceAttachmentIntent({
                    mode: sendChoice.mode,
                    visibility: "workspace",
                    acknowledged: true,
                    expectedAuthorityEpoch: epoch,
                    resourceCount: controller.selected.resourceCount,
                  }),
                }),
              );
              sendChoice.consume(sendChoice.mode);
              return true;
            },
            onChooseModel: () => {},
            modelDisabled: true,
          }}
        />
        <SessionChrome
          compact
          defaultActive="incoming"
          queue={
            {
              queue: [],
              pendingInputs: [
                {
                  id: "11111111-1111-4111-8111-111111111119",
                  sessionId: "11111111-1111-4111-8111-111111111118",
                  kind: "child_terminal_result",
                  classification: "success",
                  sourceId: "11111111-1111-4111-8111-111111111117",
                  summary: "The child reports that its reviewed PR merged.",
                  createdAt: "2026-09-07T15:05:00Z",
                },
              ],
              mutationFor: () => null,
            } as unknown as UseTurnQueueResult
          }
        />
        <output className="block text-xs break-all" data-testid="send-receipt">
          {sendReceipt}
        </output>
      </section>
      <section aria-label="Authority transition probes" className="flex flex-wrap gap-2">
        <button
          type="button"
          className="rounded-md border p-2"
          onClick={() => {
            setEpoch((current) => current + 1);
            resetDecision("reloaded");
          }}
        >
          Simulate stale epoch
        </button>
        <button
          type="button"
          className="rounded-md border p-2"
          onClick={() => {
            setSourceLost(true);
            resetDecision("source_changed");
          }}
        >
          Lose source access
        </button>
        <button
          type="button"
          className="rounded-md border p-2"
          onClick={() => {
            setSourceLost(false);
            setAuthorityUnavailable(true);
            resetDecision(null);
          }}
        >
          Truncate authority catalog
        </button>
        <button
          type="button"
          className="rounded-md border p-2"
          onClick={() => {
            setPrincipal("shared-user");
            setSourceLost(false);
            setAuthorityUnavailable(false);
            resetDecision(null);
          }}
        >
          Switch principal
        </button>
      </section>
      <output className="block text-xs break-all" data-testid="principal">
        {principal}
      </output>
    </main>
  );
}

createRoot(document.getElementById("root")!).render(<Fixture />);

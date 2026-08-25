import { useMemo, useState } from "react";
import { createRoot } from "react-dom/client";

import { PersonalResourceAttachmentControl } from "../src/components/personal-resource-attachment-control";
import type { PersonalAttachmentMode } from "../src/lib/personal-resource-attachments";
import type { PersonalResourceAttachmentController } from "../src/lib/use-personal-resource-attachment";
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
  const [mode, setMode] = useState<PersonalAttachmentMode | null>(null);
  const [acknowledged, setAcknowledged] = useState(false);
  const [epoch, setEpoch] = useState(3);
  const [sourceLost, setSourceLost] = useState(false);
  const [authorityUnavailable, setAuthorityUnavailable] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [createReceipt, setCreateReceipt] = useState("");
  const [sendReceipt, setSendReceipt] = useState("");

  const controller = useMemo<PersonalResourceAttachmentController>(() => {
    const resourceCount = principal === "owner" && !sourceLost && !authorityUnavailable ? 1 : 0;
    const intent =
      resourceCount > 0 && mode && acknowledged
        ? {
            mode,
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
      mode,
      acknowledged,
      visibility: "workspace",
      warning:
        "Personal resources used in a workspace-shared session may influence outputs visible to other workspace members. The underlying credentials and secret values are not shared by the attachment itself.",
      requiresDecision:
        sourceLost || authorityUnavailable || (resourceCount > 0 && (!mode || !acknowledged)),
      intent,
      setMode: (next) => {
        setMode(next);
        setNotice(null);
      },
      setAcknowledged: (next) => {
        setAcknowledged(next);
        setNotice(null);
      },
      refresh: async () => undefined,
      onAccepted: () => undefined,
      onDeliveryError: () => undefined,
    };
  }, [acknowledged, authorityUnavailable, epoch, mode, notice, principal, sourceLost]);

  const resetDecision = (message: string) => {
    setMode(null);
    setAcknowledged(false);
    setNotice(message);
  };

  return (
    <main className="mx-auto grid max-w-3xl gap-8 p-4 sm:p-8">
      <h1 className="text-xl font-semibold">Personal attachment acceptance fixture</h1>
      <section aria-labelledby="create-heading">
        <h2 id="create-heading" className="font-medium">
          New session create
        </h2>
        <PersonalResourceAttachmentControl controller={controller} />
        <button
          type="button"
          className="mt-3 rounded-md border p-2"
          disabled={!controller.intent}
          onClick={() =>
            setCreateReceipt(
              JSON.stringify({
                ...controller.intent,
                expectedAuthorityEpoch: undefined,
              }),
            )
          }
        >
          Create session
        </button>
        <output data-testid="create-receipt">{createReceipt}</output>
      </section>
      <section aria-labelledby="send-heading">
        <h2 id="send-heading" className="font-medium">
          Existing session Send and Steer
        </h2>
        <button
          type="button"
          className="mr-2 rounded-md border p-2"
          onClick={() => setSendReceipt(JSON.stringify(controller.intent))}
          disabled={!controller.intent}
        >
          Send
        </button>
        <button
          type="button"
          className="rounded-md border p-2"
          onClick={() =>
            setSendReceipt(JSON.stringify({ delivery: "steer", ...controller.intent }))
          }
          disabled={!controller.intent}
        >
          Steer
        </button>
        <output data-testid="send-receipt">{sendReceipt}</output>
      </section>
      <section aria-label="Authority transition probes" className="flex flex-wrap gap-2">
        <button
          type="button"
          className="rounded-md border p-2"
          onClick={() => {
            setEpoch((current) => current + 1);
            resetDecision(
              "Session authority changed. Personal resources were reloaded; review and confirm them again before retrying.",
            );
          }}
        >
          Simulate stale epoch
        </button>
        <button
          type="button"
          className="rounded-md border p-2"
          onClick={() => {
            setSourceLost(true);
            resetDecision(
              "Access to the selected personal resource changed. Choose an available resource before submitting.",
            );
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
            resetDecision("");
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
            resetDecision("");
          }}
        >
          Switch principal
        </button>
      </section>
      <output data-testid="principal">{principal}</output>
    </main>
  );
}

createRoot(document.getElementById("root")!).render(<Fixture />);

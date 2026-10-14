import { useCallback, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  ApprovalSurface,
  ToolActionReviewCard,
  ToolActionReviewDetails,
  type PendingApproval,
} from "@opengeni/react";
import {
  toolReviewAction,
  toolReviewFields,
  toolReviewDetails,
  type ToolActionReview,
  type ToolReviewStatus,
} from "@opengeni/contracts";
import "./styles.css";

const args = {
  messageIds: Array.from({ length: 600 }, (_, i) => `synthetic-message-${i + 1}`),
  addLabelIds: ["TRASH"],
  removeLabelIds: ["INBOX"],
};
const context = {
  kind: "gmail" as const,
  accountLabel: "Personal · mail@example.test",
  samples: [1, 2, 3].map((index) => ({
    id: `synthetic-message-${index}`,
    title: `Daily tracker: update failed · January ${index}`,
    subtitle: "Example notifications <notifications@example.test>",
    provenance: "provider_metadata" as const,
  })),
};
const base: ToolActionReview = {
  version: 1,
  id: "synthetic-action",
  actionDigest: "a".repeat(64),
  revision: "1",
  status: "pending",
  samples: context.samples,
  ...toolReviewAction("batch_modify_messages", args, context),
  ...toolReviewFields(args, context),
  accountLabel: context.accountLabel,
  reason: "Your permission setting for this action is Ask.",
  createdAt: "2026-01-01T12:00:00Z",
  updatedAt: "2026-01-01T12:00:00Z",
  availableActions: ["approve", "reject"],
  detailsAvailable: true,
};
const states: ToolReviewStatus[] = [
  "pending",
  "approved",
  "executing",
  "completed",
  "partial",
  "unknown",
  "rejected",
  "cancelled",
  "expired",
  "revoked",
  "stale",
  "failed",
  "unavailable",
];

function Gallery() {
  const [dark, setDark] = useState(false);
  const [status, setStatus] = useState<ToolReviewStatus>("pending");
  const [scenario, setScenario] = useState("bulk");
  const [details, setDetails] = useState<{ review: ToolActionReview; path: string } | null>(null);
  const [selectedApprovalId, setSelectedApprovalId] = useState<string | null>(null);
  const [submitted, setSubmitted] = useState<string | null>(null);
  const [remaining, setRemaining] = useState(() =>
    Array.from({ length: 100 }, (_, i) => `synthetic-${i}`),
  );
  const detailOrigin = useRef<string | null>(null);
  const openDetails = (current: ToolActionReview, path: string) => {
    detailOrigin.current = document.activeElement?.textContent ?? null;
    setDetails({ review: current, path });
  };
  const closeDetails = () => {
    setDetails(null);
    requestAnimationFrame(() => {
      [...document.querySelectorAll("button")]
        .find((button) => button.textContent === detailOrigin.current)
        ?.focus();
    });
  };
  const generic = {
    recipient: "teammate@example.test",
    subject: "Updated timeline",
    changes: { title: "Example project", status: "Ready" },
    apiKey: "not-for-display",
  };
  const values = scenario === "generic" ? generic : args;
  const review: ToolActionReview =
    scenario === "generic"
      ? {
          ...base,
          consequence: undefined,
          selectionCount: undefined,
          samples: undefined,
          ...toolReviewAction("update_record", generic, {
            kind: "generic",
            title: "Update project record",
          }),
          ...toolReviewFields(generic),
          accountLabel: "Projects · Example workspace",
          status,
        }
      : { ...base, status };
  const load = useCallback(
    async (current: ToolActionReview, path: string, offset: number) => ({
      version: 1 as const,
      id: current.id,
      actionDigest: current.actionDigest,
      ...toolReviewDetails(values, scenario === "generic" ? undefined : context, path, offset),
    }),
    [values, scenario],
  );
  const approvals: PendingApproval[] = (scenario === "many" ? remaining : [base.id]).map((id) => ({
    id,
    name: "batch_modify_messages",
    arguments: values,
  }));
  return (
    <div
      className="og-root min-h-screen bg-og-bg text-og-fg"
      data-og-theme={dark ? "dark" : "light"}
      style={{ colorScheme: dark ? "dark" : "light" }}
    >
      <header className="border-b border-og-border px-6 py-4">
        <div className="mx-auto flex max-w-3xl flex-wrap items-center justify-between gap-4">
          <span className="text-og-sm font-semibold">Action review studio</span>
          <button
            className="min-h-11 rounded-og-md border border-og-border px-3 text-og-sm"
            onClick={() => setDark((value) => !value)}
          >
            {dark ? "Light theme" : "Dark theme"}
          </button>
        </div>
      </header>
      {details ? (
        <ToolActionReviewDetails
          review={details.review}
          path={details.path}
          load={load}
          onBack={closeDetails}
        />
      ) : (
        <main className="mx-auto max-w-3xl px-6 py-8">
          <div className="mb-10 flex flex-wrap gap-4 border-b border-og-border pb-6 text-og-sm">
            <label>
              Example
              <select
                aria-label="Example"
                className="ml-2 min-h-11 rounded-og-md border border-og-border bg-og-surface-1 px-2"
                value={scenario}
                onChange={(event) => {
                  setScenario(event.target.value);
                  setSubmitted(null);
                  setRemaining(Array.from({ length: 100 }, (_, i) => `synthetic-${i}`));
                }}
              >
                <option value="bulk">Mailbox cleanup</option>
                <option value="generic">Generic action</option>
                <option value="many">100 pending actions</option>
                <option value="loading">Loading</option>
                <option value="unavailable">Unavailable details</option>
              </select>
            </label>
            <label>
              Status
              <select
                aria-label="Status"
                className="ml-2 min-h-11 rounded-og-md border border-og-border bg-og-surface-1 px-2"
                value={status}
                onChange={(event) => setStatus(event.target.value as ToolReviewStatus)}
              >
                {states.map((state) => (
                  <option key={state}>{state}</option>
                ))}
              </select>
            </label>
          </div>
          <p className="mb-6 text-og-sm leading-relaxed text-og-fg">
            {scenario === "generic"
              ? "The project changes are ready for review."
              : "I found the old tracker notifications. The selected messages are ready to move to Trash."}
          </p>
          {scenario === "loading" || scenario === "unavailable" || scenario === "many" ? (
            <ApprovalSurface
              selectedApprovalId={selectedApprovalId}
              onSelectedApprovalChange={setSelectedApprovalId}
              approvals={approvals}
              loadReview={
                scenario === "loading"
                  ? () => new Promise(() => {})
                  : scenario === "unavailable"
                    ? async () => {
                        throw new Error("Unavailable");
                      }
                    : async (approval) => ({ ...review, id: approval.id })
              }
              onApprove={(approval) =>
                setRemaining((ids) => ids.filter((id) => id !== approval.id))
              }
              onReject={(approval) => setRemaining((ids) => ids.filter((id) => id !== approval.id))}
              onViewDetails={openDetails}
            />
          ) : (
            <div className="border-t border-og-border">
              <ToolActionReviewCard
                review={review}
                disabled={submitted !== null}
                submitting={submitted as "approve" | "reject" | null}
                onApprove={() => {
                  setSubmitted("approve");
                  setTimeout(() => {
                    setSubmitted(null);
                    setStatus("executing");
                  }, 900);
                }}
                onReject={() => setStatus("rejected")}
                onViewDetails={(path) => openDetails(review, path)}
              />
            </div>
          )}
        </main>
      )}
    </div>
  );
}
const root = document.getElementById("root");
if (!root) throw new Error("Missing root");
createRoot(root).render(<Gallery />);

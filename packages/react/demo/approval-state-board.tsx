import { useCallback, useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  ApprovalSurface,
  ToolActionReviewCard,
  ToolActionReviewDetails,
  type PendingApproval,
} from "@opengeni/react";
import { OpenGeniApiError } from "@opengeni/sdk";
import {
  toolReviewAction,
  toolReviewFields,
  toolReviewDetails,
  type ToolActionReview,
  type ToolReviewContext,
  type ToolReviewStatus,
} from "@opengeni/contracts";
// `?skin=embed` renders with the package's own theme (what @opengeni/react hosts get);
// the default uses the Opengeni web app theme.
const skin = new URLSearchParams(location.search).get("skin");
await (skin === "embed" ? import("./styles.css") : import("../../../apps/web/src/styles.css"));
await import("./approval-state-board.css");

type Example = {
  id: string;
  label: string;
  note: string;
  tool: string;
  args: Record<string, unknown>;
  context?: ToolReviewContext;
  status?: ToolReviewStatus;
  mode?:
    | "loading"
    | "load-error"
    | "denied"
    | "legacy"
    | "no-arguments"
    | "many"
    | "approving"
    | "rejecting"
    | "decision-error"
    | "refresh"
    | "decline-only"
    | "details"
    | "details-error"
    | "details-loading";
  path?: string;
};
const gmail: ToolReviewContext = {
  kind: "gmail",
  accountLabel: "Gmail · alex@example.test",
};
const messages = Array.from({ length: 600 }, (_, i) => `example-message-${i + 1}`);
const cleanup = {
  messageIds: messages,
  addLabelIds: ["TRASH"],
  removeLabelIds: ["INBOX"],
};
const email = {
  from: "alex@example.test",
  to: "sam@example.test",
  cc: "",
  bcc: "",
  subject: "Friday project update",
  textBody:
    "Hi Sam,\n\nThe revised timeline is ready. Please review the attached notes before Friday.\n\nThanks,\nAlex",
  htmlBody: "",
  contentSha256: "a".repeat(64),
  attachments: [{ name: "project-notes.txt", mediaType: "text/plain", bytes: 2048 }],
};
const example = (
  id: string,
  label: string,
  note: string,
  tool: string,
  args: Record<string, unknown>,
  context: ToolReviewContext = gmail,
): Example => ({ id, label, note, tool, args, context });
const actions: Example[] = [
  example(
    "send",
    "Send one email",
    "Recipient, subject, message and attachment must be reviewable.",
    "send_message",
    { raw: "synthetic-encoded-message" },
    { ...gmail, email, protectedFields: ["raw"] },
  ),
  example("draft", "Create a draft", "Saving a draft must not imply sending.", "create_draft", {
    subject: "Project update",
    body: "Draft for review",
    to: "sam@example.test",
  }),
  example(
    "edit-draft",
    "Edit a draft",
    "Show the changed content and the exact saved draft.",
    "update_draft",
    {
      draftId: "example-draft-1",
      subject: "Revised project update",
      body: "Updated draft for review",
    },
  ),
  example(
    "delete-draft",
    "Delete a draft",
    "Distinguish deletion from sending or editing.",
    "delete_draft",
    { draftId: "example-draft-1" },
  ),
  example("label", "Create a label", "An ordinary single-item action.", "create_label", {
    name: "Project updates",
    labelListVisibility: "labelShow",
    messageListVisibility: "show",
  }),
  example(
    "one-email",
    "Move one email",
    "Same component and action semantics as a large selection.",
    "trash_message",
    { messageId: "example-message-1" },
  ),
  example(
    "cleanup",
    "Move many emails",
    "Exact frozen selection; every material effect remains visible.",
    "batch_modify_messages",
    cleanup,
  ),
  example(
    "samples",
    "Selection with examples",
    "Only saved representative subjects, never invented coverage.",
    "batch_modify_messages",
    cleanup,
    {
      ...gmail,
      samples: [1, 2, 3].map((i) => ({
        id: `example-message-${i}`,
        title: `Example notification ${i}`,
        subtitle: "Notifications · alerts@example.test",
        provenance: "provider_metadata" as const,
      })),
    },
  ),
  example(
    "compound",
    "Compound email changes",
    "An additional label must remain visible alongside Trash and Inbox effects.",
    "batch_modify_messages",
    { ...cleanup, addLabelIds: ["TRASH", "Project updates"] },
  ),
  example(
    "thread",
    "Change a conversation",
    "Explain that the action affects every message in the conversation.",
    "modify_thread",
    {
      threadId: "example-thread-1",
      addLabelIds: ["STARRED"],
      removeLabelIds: ["UNREAD"],
    },
  ),
  example(
    "generic",
    "Other integration",
    "Generic operation with meaningful scalar values and nested changes.",
    "update_record",
    {
      recordId: "example-record",
      changes: { title: "Project Atlas", status: "Ready" },
    },
    {
      kind: "generic",
      title: "Update project",
      accountLabel: "Projects · Example team",
    },
  ),
  example(
    "command",
    "Run a command",
    "Ordinary command approval uses the shared review without email assumptions.",
    "run_command",
    { command: "bun run build", workingDirectory: "/workspace/example" },
    {
      kind: "generic",
      title: "Build the project",
      accountLabel: "Development workspace",
    },
  ),
  example(
    "protected",
    "Protected fields",
    "Credentials never appear, including inside nested values.",
    "configure_service",
    {
      endpoint: "https://service.example.test",
      apiKey: "synthetic-never-display",
      settings: { region: "eu", token: "synthetic-nested-secret" },
    },
    {
      kind: "generic",
      title: "Configure service",
      accountLabel: "Example integration",
    },
  ),
  example(
    "long",
    "Long values",
    "Wrapping, expansion and details must work on a narrow screen.",
    "create_record",
    {
      title: "A longer project title with enough detail to wrap naturally on a narrow screen",
      description: "This is a long example description. ".repeat(30),
      reviewers: ["alex@example.test", "sam@example.test"],
    },
    {
      kind: "generic",
      title: "Create project record",
      accountLabel: "Projects · A team with a longer account name",
    },
  ),
];
const statuses: ToolReviewStatus[] = [
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
  "blocked",
  "stale",
  "failed",
  "unavailable",
];
const lifecycle = statuses.map((status) => ({
  ...actions[4]!,
  id: `status-${status}`,
  label: status.charAt(0).toUpperCase() + status.slice(1),
  note: "Authoritative lifecycle state; controls must match what can happen next.",
  status,
}));
const interactions: Example[] = [
  ...(
    [
      ["loading", "Initial loading"],
      ["load-error", "Load failure and retry"],
      ["denied", "Access denied"],
      ["legacy", "Legacy fallback"],
      ["no-arguments", "Legacy without saved arguments"],
      ["many", "Multiple pending actions"],
      ["approving", "Approving"],
      ["rejecting", "Declining"],
      ["decision-error", "Decision failure and retry"],
      ["refresh", "Unrelated chat updates"],
      ["decline-only", "Arguments not recoverable"],
    ] as const
  ).map(([mode, label]) => ({
    ...actions[6]!,
    id: mode,
    label,
    note:
      mode === "refresh"
        ? "Enable updates: the review and keyboard focus must stay stable."
        : "Exercise the real loading, decision or compatibility path.",
    mode,
  })),
];
const details: Example[] = [
  {
    ...actions[6]!,
    id: "details-root",
    label: "Full saved details",
    note: "Nested fields open with ordinary page navigation.",
    mode: "details",
  },
  {
    ...actions[6]!,
    id: "details-selection",
    label: "Paginated selection",
    note: "600 saved IDs; next and previous preserve the exact selection.",
    mode: "details",
    path: "/messageIds",
  },
  {
    ...actions[12]!,
    id: "details-protected",
    label: "Protected nested details",
    note: "No secret bytes in previews or full details.",
    mode: "details",
    path: "/settings",
  },
  {
    ...actions[6]!,
    id: "details-loading",
    label: "Details loading",
    note: "No decision buttons during an incomplete review.",
    mode: "details-loading",
  },
  {
    ...actions[6]!,
    id: "details-error",
    label: "Details failure and retry",
    note: "Retry retrieves the same immutable saved action.",
    mode: "details-error",
  },
];
const groups = [
  {
    id: "actions",
    title: "Actions",
    note: "Single-item and multi-item work, using identical production components.",
    items: actions,
  },
  {
    id: "lifecycle",
    title: "Lifecycle",
    note: `All ${statuses.length} review states.`,
    items: lifecycle,
  },
  {
    id: "interaction",
    title: "Loading & interaction",
    note: "Failures, older clients, queues, and the refresh regression.",
    items: interactions,
  },
  {
    id: "details",
    title: "Details",
    note: "Exact saved values, protected content and pagination.",
    items: details,
  },
];
function reviewFor(item: Example): ToolActionReview {
  return {
    version: 1,
    id: item.id,
    actionDigest: "a".repeat(64),
    revision: "example-1",
    status: item.status ?? "pending",
    ...toolReviewAction(item.tool, item.args, item.context),
    ...toolReviewFields(item.args, item.context),
    accountLabel: item.context?.accountLabel,
    samples: item.context?.samples,
    reason:
      item.status === "blocked"
        ? "Your permission settings block this action."
        : "This action is set to Ask first.",
    createdAt: "2026-01-01T12:00:00Z",
    updatedAt: "2026-01-01T12:00:00Z",
    availableActions:
      (item.status ?? "pending") !== "pending"
        ? []
        : item.mode === "decline-only"
          ? ["reject"]
          : ["approve", "reject"],

    detailsAvailable: item.mode !== "decline-only",
    ...(item.mode === "decline-only" ? { fields: [], moreFields: 0 } : {}),
  };
}
function ExampleView({ item, focused = false }: { item: Example; focused?: boolean }) {
  const base = useMemo(() => reviewFor(item), [item]);
  const [status, setStatus] = useState(base.status),
    [submitting, setSubmitting] = useState<"approve" | "reject" | null>(null),
    [path, setPath] = useState<string | null>(
      item.mode?.startsWith("details") ? (item.path ?? "") : null,
    ),
    [remaining, setRemaining] = useState(["one", "two", "three"]),
    [ticks, setTicks] = useState(0),
    [updating, setUpdating] = useState(false);
  // Fresh counters per example (each example remounts by key).
  const [attempts] = useState(() => ({ loads: 0, decisions: 0, details: 0 }));
  useEffect(() => {
    if (!updating) return;
    const timer = setInterval(() => setTicks((v) => v + 1), 500);
    return () => clearInterval(timer);
  }, [updating]);
  const review = useMemo(() => ({ ...base, status }), [base, status]);
  const loadReview = useCallback(
    async (approval: PendingApproval) => {
      attempts.loads++;
      if (item.mode === "loading") return new Promise<ToolActionReview>(() => {});
      if (item.mode === "legacy" || item.mode === "no-arguments")
        throw new OpenGeniApiError(404, "No stored review");
      if (item.mode === "denied") throw new OpenGeniApiError(403, "Access denied");
      if (item.mode === "load-error" && attempts.loads === 1)
        throw new Error("Synthetic unavailable");
      return { ...base, id: approval.id };
    },
    [item, base, attempts],
  );
  const loadDetails = useCallback(
    async (value: ToolActionReview, nextPath: string, offset: number) => {
      attempts.details++;
      if (item.mode === "details-loading") return new Promise<never>(() => {});
      if (item.mode === "details-error" && attempts.details === 1)
        throw new Error("Synthetic unavailable");
      return {
        version: 1 as const,
        id: value.id,
        actionDigest: value.actionDigest,
        ...toolReviewDetails(item.args, item.context, nextPath, offset),
      };
    },
    [item, attempts],
  );
  const decide = async (action: "approve" | "reject", id?: string) => {
    attempts.decisions++;
    if (item.mode === "decision-error" && attempts.decisions === 1)
      throw new Error("Decision unavailable");
    if (item.mode === "many") {
      setRemaining((v) => v.filter((x) => `${item.id}-${x}` !== id));
      return;
    }
    setSubmitting(action);
    await new Promise((resolve) => setTimeout(resolve, 500));
    setSubmitting(null);
    setStatus(action === "reject" ? "rejected" : "executing");
  };
  if (path !== null)
    return (
      <ToolActionReviewDetails
        review={review}
        manageFocus={focused}
        path={path}
        load={loadDetails}
        onBack={() => setPath(null)}
      />
    );
  const surface =
    item.mode &&
    !["approving", "rejecting"].includes(item.mode) &&
    !item.mode.startsWith("details");
  const approvals = (item.mode === "many" ? remaining : ["one"]).map((id) => ({
    id: `${item.id}-${id}`,
    name: item.tool,
    display: { toolName: item.tool, accountLabel: item.context?.accountLabel },
    ...(item.mode === "no-arguments" ? {} : { arguments: structuredClone(item.args) }),
  }));
  return (
    <>
      {item.mode === "refresh" && (
        <div className="board-test-controls">
          <button onClick={() => setUpdating((v) => !v)}>
            {updating ? "Stop updates" : "Start chat updates"}
          </button>
          <span>{ticks} updates</span>
        </div>
      )}
      {surface ? (
        <ApprovalSurface
          approvals={approvals}
          loadReview={loadReview}
          loadDetails={loadDetails}
          onApprove={(value) => decide("approve", value.id)}
          onReject={(value) => decide("reject", value.id)}
          onViewDetails={(_, next) => setPath(next)}
        />
      ) : (
        <ToolActionReviewCard
          review={review}
          submitting={
            item.mode === "approving"
              ? "approve"
              : item.mode === "rejecting"
                ? "reject"
                : submitting
          }
          onApprove={() => void decide("approve")}
          onReject={() => void decide("reject")}
          onViewDetails={setPath}
        />
      )}
    </>
  );
}
function Board() {
  const [dark, setDark] = useState(false),
    [mobile, setMobile] = useState(false),
    [focus, setFocus] = useState<string | null>(new URLSearchParams(location.search).get("case")),
    [revision, setRevision] = useState(0);
  useEffect(() => {
    document.documentElement.setAttribute("data-og-theme", dark ? "dark" : "light");
    document.documentElement.classList.toggle("dark", dark);
    document.documentElement.style.colorScheme = dark ? "dark" : "light";
  }, [dark]);
  const onlyGroup = new URLSearchParams(location.search).get("group");
  const shownGroups = onlyGroup ? groups.filter((g) => g.id === onlyGroup) : groups;
  const all = groups.flatMap((g) => g.items),
    selected = all.find((item) => item.id === focus);
  let number = 0;
  return (
    <div className="og-root board-shell">
      <header className="board-header">
        <div>
          <p className="board-eyebrow">OPENGENI / COMPONENT STUDIO</p>
          <h1>Approvals</h1>
          <p>{all.length} enumerated states · Real UI components · Synthetic data only</p>
        </div>
        <div className="board-toolbar">
          <button onClick={() => setDark((v) => !v)}>{dark ? "Light theme" : "Dark theme"}</button>
          <button aria-pressed={mobile} onClick={() => setMobile((v) => !v)}>
            {mobile ? "Desktop width" : "390px previews"}
          </button>
          <button onClick={() => setRevision((v) => v + 1)}>Reset examples</button>
        </div>
      </header>
      {focus ? (
        <main className="board-focus">
          <button className="board-back" onClick={() => setFocus(null)}>
            ← All states
          </button>
          <h2>{selected?.label}</h2>
          <p>{selected?.note}</p>
          <div className={mobile ? "board-mobile" : ""} key={`${focus}:${revision}`}>
            {selected ? <ExampleView item={selected} focused /> : <p>Unknown example.</p>}
          </div>
        </main>
      ) : (
        <>
          <nav className="board-nav" aria-label="State groups">
            {groups.map((g) => (
              <a href={`#${g.id}`} key={g.id}>
                {g.title} <span>{g.items.length}</span>
              </a>
            ))}
          </nav>
          <main className="board-content">
            {shownGroups.map((group) => (
              <section className="board-group" id={group.id} key={group.id}>
                <div className="board-group-heading">
                  <h2>{group.title}</h2>
                  <p>{group.note}</p>
                </div>
                <div className="board-grid">
                  {group.items.map((item) => (
                    <section
                      className="board-cell"
                      key={`${item.id}:${revision}`}
                      data-board-case={item.id}
                    >
                      <header className="board-cell-heading">
                        <div>
                          <span>{String(++number).padStart(2, "0")}</span>
                          <h3>{item.label}</h3>
                        </div>
                        <button
                          aria-label={`Focus ${item.label}`}
                          onClick={() => setFocus(item.id)}
                        >
                          Open ↗
                        </button>
                      </header>
                      <p className="board-note">{item.note}</p>
                      <div className={mobile ? "board-preview board-mobile" : "board-preview"}>
                        <ExampleView item={item} />
                      </div>
                    </section>
                  ))}
                </div>
              </section>
            ))}
          </main>
        </>
      )}
      <footer className="board-footer">
        Buttons exercise local state only. No email is sent and no connected account is modified.
      </footer>
    </div>
  );
}
createRoot(document.getElementById("root")!).render(<Board />);

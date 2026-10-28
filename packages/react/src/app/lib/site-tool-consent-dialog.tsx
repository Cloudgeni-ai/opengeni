import type { ToolGatewaySiteConsentReview } from "@opengeni/sdk";
import type {
  SiteToolConnectPrompt,
  SiteToolConsentDecision,
  SiteToolConsentPrompt,
} from "@opengeni/sdk/site";
import { useEffect, useRef, useState } from "react";
import { toolReviewAction } from "@opengeni/contracts";
import { McpConnectionCard } from "../../components/session-mcp-capability-card";
import { ConfirmDialog } from "../../ui/confirm-dialog";
import { CheckboxField } from "../../ui/field";
import { SelectMenu } from "../../ui/select-menu";
import { useAppContext } from "../app-context";

// The confirmation and connect card for Site tool calls. Loaded only when a
// Site asks, so the console's eager pages never carry it.

type Identity = { serverId: string; toolName: string };
const identityKey = (identity: Identity) => JSON.stringify([identity.serverId, identity.toolName]);

/**
 * What the confirmation says: the action, and to whom. With a provider review
 * (Gmail reads the message as it would be sent: raw, draft or reply), the rows
 * come only from it; otherwise from the arguments the tool receives.
 */
export function siteToolConsentSummary(
  prompt: Pick<SiteToolConsentPrompt, "tool" | "arguments">,
  review: ToolGatewaySiteConsentReview | null = null,
): {
  title: string;
  /** One plain consequence line, when the action has one (as in agent reviews). */
  consequence: string | null;
  confirmLabel: string;
  rows: { label: string; value: string }[];
} {
  const name = prompt.tool.entry.identity.toolName;
  // The agent action review's own wording, never a provider-supplied title.
  const action = toolReviewAction(
    name,
    prompt.arguments,
    review ? { kind: review.kind } : undefined,
  );
  const rows: { label: string; value: string }[] = [];
  const email = review?.email;
  if (email) {
    rows.push({ label: "To", value: email.to.trim() || "No recipients" });
    if (email.cc.trim()) rows.push({ label: "Cc", value: email.cc.trim() });
    if (email.bcc.trim()) rows.push({ label: "Bcc", value: email.bcc.trim() });
    rows.push({ label: "Subject", value: email.subject.trim() || "(No subject)" });
    if (email.attachments > 0)
      rows.push({
        label: "Attachments",
        value: email.attachments.toLocaleString("en-US"),
      });
  } else {
    for (const [key, label] of [
      ["to", "To"],
      ["cc", "Cc"],
      ["bcc", "Bcc"],
      ["recipients", "To"],
    ] as const) {
      const value = listText(prompt.arguments[key]);
      if (value) rows.push({ label, value });
    }
    const subject = prompt.arguments.subject;
    if (typeof subject === "string" && subject.trim())
      rows.push({ label: "Subject", value: subject.trim() });
  }
  return {
    title: action.title,
    consequence: action.consequence ?? null,
    confirmLabel: /(^|_)send(_|$)/u.test(name) ? "Send" : "Confirm",
    rows,
  };
}

function listText(value: unknown): string | null {
  const items = (Array.isArray(value) ? value : [value]).filter(
    (item): item is string => typeof item === "string" && item.trim() !== "",
  );
  return items.length > 0 ? items.map((item) => item.trim()).join(", ") : null;
}

/**
 * The Opengeni frame's confirmation for one Site tool call. Host UI only: the
 * Site never renders, answers or skips it.
 */
export function SiteToolConsentDialog({
  prompt,
  onDecision,
}: {
  prompt: SiteToolConsentPrompt;
  onDecision: (decision: SiteToolConsentDecision) => void;
}) {
  const [selected, setSelected] = useState(() =>
    prompt.selected ? identityKey(prompt.selected) : "",
  );
  // The provider's review per account: picking another account reads it again.
  const [reviews, setReviews] = useState<
    Record<string, ToolGatewaySiteConsentReview | null | "loading" | "failed">
  >(() => ({ [prompt.selected ? identityKey(prompt.selected) : ""]: prompt.review }));
  const review = reviews[selected];
  const summary = siteToolConsentSummary(
    prompt,
    review === "loading" || review === "failed" || review === undefined ? null : review,
  );
  const [alwaysAllow, setAlwaysAllow] = useState(false);
  // A Site may start a call while the person is typing or clicking elsewhere:
  // the confirmation is not answerable until it has been on screen briefly.
  const [armed, setArmed] = useState(false);
  useEffect(() => {
    const timer = setTimeout(() => setArmed(true), CONFIRM_ARM_MS);
    return () => clearTimeout(timer);
  }, []);
  const choose = (next: string) => {
    setSelected(next);
    if (reviews[next] !== undefined && reviews[next] !== "failed") return;
    const account = prompt.accounts.find((item) => identityKey(item.identity) === next);
    if (!account) return;
    setReviews((current) => ({ ...current, [next]: "loading" }));
    prompt.reviewFor(account.identity).then(
      (value) => setReviews((current) => ({ ...current, [next]: value })),
      () => setReviews((current) => ({ ...current, [next]: "failed" })),
    );
  };
  // ConfirmDialog closes itself after confirming; answer only once.
  const answered = useRef(false);
  const answer = (decision: SiteToolConsentDecision) => {
    if (answered.current) return;
    answered.current = true;
    onDecision(decision);
  };
  const account = prompt.accounts.find((item) => identityKey(item.identity) === selected);
  const from =
    prompt.accounts.length > 1 ? (
      <SelectMenu
        variant="native"
        size="sm"
        aria-label="From"
        value={selected}
        onValueChange={choose}
        options={prompt.accounts.map((item) => ({
          value: identityKey(item.identity),
          label: item.account,
        }))}
      />
    ) : account ? (
      account.account
    ) : null;
  return (
    <ConfirmDialog
      open
      onOpenChange={(open) => {
        if (!open) answer(null);
      }}
      title={summary.title}
      description={summary.consequence ?? account?.connector}
      confirmLabel={summary.confirmLabel}
      confirmDisabled={!armed || review === "loading" || review === "failed"}
      cancelAutoFocus
      destructive={false}
      onConfirm={() =>
        answer({
          ...(account ? { identity: account.identity } : {}),
          ...(alwaysAllow ? { alwaysAllow: true } : {}),
        })
      }
    >
      {from || summary.rows.length > 0 ? (
        <dl className="grid grid-cols-[auto_minmax(0,1fr)] items-center gap-x-4 gap-y-2 text-sm">
          {from ? (
            <>
              <dt className="text-fg-muted">From</dt>
              <dd className="min-w-0 truncate">{from}</dd>
            </>
          ) : null}
          {summary.rows.map((row) => (
            <div key={row.label} className="contents">
              <dt className="text-fg-muted">{row.label}</dt>
              <dd className="min-w-0 break-words">{row.value}</dd>
            </div>
          ))}
        </dl>
      ) : null}
      {review === "failed" ? (
        <p className="text-sm text-danger">Couldn't read this from the selected account.</p>
      ) : null}
      <CheckboxField
        label="Always allow for this Site"
        checked={alwaysAllow}
        onCheckedChange={setAlwaysAllow}
      />
    </ConfirmDialog>
  );
}

/** How long the confirmation is on screen before it can be answered. */
export const CONFIRM_ARM_MS = 500;

export type ConnectRequest = SiteToolConnectPrompt & { workspaceId: string };

/** The existing connect card, for a viewer with no account the Site's tool can use. */
export function SiteToolConnect({
  request,
  onDone,
}: {
  request: ConnectRequest;
  onDone: (connected: boolean) => void;
}) {
  const { client } = useAppContext();
  const connected = useRef(false);
  const { capabilityId } = request.connect;
  useEffect(() => {
    if (!capabilityId) onDone(false);
  }, [capabilityId, onDone]);
  if (!capabilityId) return null;
  return (
    <McpConnectionCard
      client={client}
      workspaceId={request.workspaceId}
      capabilityId={capabilityId}
      name={request.connect.name}
      returnUrl={window.location.href}
      personalOnly
      dialogOnly
      onConfigured={() => {
        connected.current = true;
        onDone(true);
      }}
      onClose={() => onDone(connected.current)}
    />
  );
}

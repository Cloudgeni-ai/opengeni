import { useEffect, useId, useMemo, useRef, useState } from "react";
import { CheckIcon, ChevronDownIcon, WandSparklesIcon, XIcon } from "lucide-react";
import type { SessionEvent, SkillRecord } from "@opengeni/sdk";
import { OpenGeniApiError } from "@opengeni/sdk/browser";
import type { SkillReviewReference } from "@opengeni/contracts";
import type { AppContextValue } from "../../app-context";
import { Button } from "../../../ui/button";
import { DecisionButton, DecisionMark, decisionCardClass } from "../../../components/decision-card";
import { cn } from "../../../lib/cn";
import { userErrorText } from "../../../ui/api-error";
import { hasWorkspacePermission } from "../../lib/permissions";
import { canAdministerOrganization } from "../../lib/workspaces";
import { sessionSkillReviews } from "../../lib/session-skill-reviews";

type ReviewReference = Omit<SkillReviewReference, "sourceOperationId">;
type Decision = "approved" | "declined";
type Decided = {
  reference: ReviewReference;
  name: string;
  removal: boolean;
  decision: Decision;
  /** The turn the decision was made in; its confirmation shows until the next one. */
  turn: string;
};

export function SessionSkillReviews({
  context,
  workspaceId,
  sessionId,
  events,
}: {
  context: AppContextValue;
  workspaceId: string;
  sessionId: string;
  events: readonly SessionEvent[];
}) {
  const receipts = useMemo(() => sessionSkillReviews(events), [events]);
  const receiptIdentity = JSON.stringify(receipts);
  const [catalog, setCatalog] = useState<ReviewReference[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [error, setError] = useState(false);
  const [reload, setReload] = useState(0);
  const [loading, setLoading] = useState(false);
  const [pagination, setPagination] = useState<{ identity: string; cursor: string }>();
  // A new receipt invalidates every page of the previous discovery snapshot.
  const page = pagination?.identity === receiptIdentity ? pagination.cursor : undefined;
  useEffect(() => {
    let live = true;
    setLoading(true);
    setError(false);
    void context.client
      .listWorkspaceSkills(workspaceId, {
        sessionId,
        limit: 100,
        ...(page ? { cursor: page } : {}),
      })
      .then((result) => {
        if (!live) return;
        const pending = result.skills.flatMap((skill) =>
          skill.pendingRevisionIds.map((revisionId) => ({
            skillId: skill.id,
            revisionId,
            expectedRevisionId: skill.activeRevisionId,
            expectedScopeVersion: skill.scopeVersion,
            ...(skill.removalOperationId ? { removalOperationId: skill.removalOperationId } : {}),
          })),
        );
        setCatalog((previous) => (page ? [...previous, ...pending] : pending));
        setCursor(result.nextCursor);
      })
      .catch(() => {
        if (live) setError(true);
      })
      .finally(() => {
        if (live) setLoading(false);
      });
    return () => {
      live = false;
    };
  }, [context.client, workspaceId, sessionId, receiptIdentity, reload, page]);
  useEffect(() => {
    const refresh = () => {
      setPagination(undefined);
      setReload((value) => value + 1);
    };
    window.addEventListener("focus", refresh);
    return () => window.removeEventListener("focus", refresh);
  }, []);
  // A decided review never comes back from a stale catalog page, and its short
  // confirmation is kept here, where a catalog refresh can't remove it, until
  // the next turn starts.
  const latestTurn = useMemo(() => {
    for (let index = events.length - 1; index >= 0; index -= 1)
      if (events[index]?.type === "turn.started") return events[index]!.id;
    return "";
  }, [events]);
  const turnRef = useRef(latestTurn);
  turnRef.current = latestTurn;
  const decisionScope = `${context.accessContext.subjectId}:${workspaceId}:${sessionId}`;
  const scopeRef = useRef(decisionScope);
  scopeRef.current = decisionScope;
  const [decisionState, setDecisionState] = useState<{ scope: string; entries: Decided[] }>({
    scope: decisionScope,
    entries: [],
  });
  const decided = decisionState.scope === decisionScope ? decisionState.entries : [];
  const decidedIds = new Set(decided.map((entry) => entry.reference.revisionId));
  const confirmations = new Map(
    decided
      .filter((entry) => entry.turn === latestTurn)
      .map((entry) => [entry.reference.revisionId, entry]),
  );
  const reviews = [
    ...new Map(catalog.map((reference) => [reference.revisionId, reference])).values(),
  ];
  const listed = new Set(reviews.map((reference) => reference.revisionId));
  const cards = [
    ...reviews.filter(
      (reference) =>
        !decidedIds.has(reference.revisionId) || confirmations.has(reference.revisionId),
    ),
    ...[...confirmations.values()]
      .filter((entry) => !listed.has(entry.reference.revisionId))
      .map((entry) => entry.reference),
  ];
  return (
    <>
      {cards.map((reference) => {
        const outcome = confirmations.get(reference.revisionId);
        return outcome ? (
          <SkillDecided key={`decided:${reference.revisionId}`} entry={outcome} />
        ) : (
          <SkillReview
            key={`${context.accessContext.subjectId}:${workspaceId}:${reference.revisionId}:${reference.expectedScopeVersion}:${reference.expectedRevisionId}:${reference.removalOperationId ?? ""}`}
            context={context}
            workspaceId={workspaceId}
            reference={reference}
            onDecided={(name, removal, decision) =>
              // A result for an account or chat no longer shown changes nothing here.
              setDecisionState((previous) =>
                scopeRef.current !== decisionScope
                  ? previous
                  : {
                      scope: decisionScope,
                      entries: [
                        ...(previous.scope === decisionScope ? previous.entries : []),
                        { reference, name, removal, decision, turn: turnRef.current },
                      ],
                    },
              )
            }
          />
        );
      })}
      {error ? (
        <p role="alert" className="text-sm">
          Could not load pending Skill reviews.{" "}
          <Button variant="ghost" onClick={() => setReload((value) => value + 1)}>
            Retry
          </Button>
        </p>
      ) : null}
      {cursor ? (
        <Button
          variant="ghost"
          disabled={loading}
          onClick={() => setPagination({ identity: receiptIdentity, cursor })}
        >
          More pending Skills
        </Button>
      ) : null}
    </>
  );
}

/** One compact bar: the mark, the Skill's name over one status line, and actions. */
const barClass = "flex flex-wrap items-center gap-x-3 gap-y-2 px-3 py-2.5";
const statusClass = "m-0 mt-0.5 flex min-w-0 items-center gap-1.5 text-og-xs text-og-fg-muted";
const compactButton = "w-auto shrink-0 px-3 @md/decision:min-h-8";

function decidedText({ decision, removal, reference }: Decided) {
  if (decision === "approved")
    return removal
      ? "Deleted"
      : reference.expectedRevisionId
        ? "Approved · Agents use this version from your next message"
        : "Approved · Agents can use it from your next message";
  if (removal) return "Kept · The Skill wasn't deleted";
  return reference.expectedRevisionId
    ? "Declined · The current version stays"
    : "Declined · Agents won't use it";
}

function SkillDecided({ entry }: { entry: Decided }) {
  const titleId = useId();
  const statusId = useId();
  // The clicked action is gone: keep keyboard and screen-reader focus on the
  // card, but never take it from somewhere the person has moved on to.
  useEffect(() => {
    const active = document.activeElement;
    if (!active || active === document.body)
      document.getElementById(titleId)?.focus({ preventScroll: true });
  }, [titleId]);
  const approved = entry.decision === "approved";
  return (
    <section aria-label="Skill review" className="my-3">
      <article
        aria-labelledby={titleId}
        data-skill-decision={entry.decision}
        className={cn(decisionCardClass, "shadow-none", barClass)}
      >
        <DecisionMark>
          {approved ? <CheckIcon aria-hidden="true" /> : <XIcon aria-hidden="true" />}
        </DecisionMark>
        <div className="min-w-0 flex-1">
          <h3
            id={titleId}
            tabIndex={-1}
            aria-describedby={statusId}
            className="m-0 truncate text-og-sm font-semibold text-og-fg outline-hidden"
          >
            {entry.name}
          </h3>
          <p id={statusId} className={statusClass}>
            {decidedText(entry)}
          </p>
        </div>
      </article>
    </section>
  );
}

function SkillReview({
  context,
  workspaceId,
  reference,
  onDecided,
}: {
  context: AppContextValue;
  workspaceId: string;
  reference: ReviewReference;
  onDecided: (name: string, removal: boolean, decision: Decision) => void;
}) {
  const [record, setRecord] = useState<SkillRecord | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<Decision | null>(null);
  const [settled, setSettled] = useState(false);
  const [open, setOpen] = useState(false);
  const [reload, setReload] = useState(0);
  const titleId = useId();
  const detailsId = useId();
  // Uncertain network outcomes must replay the same immutable operation.
  const operationIds = useRef<Partial<Record<Decision, string>>>({});
  // A disabled button drops focus to the page; after a failure, return it to
  // the button the person used, unless they have moved on.
  const actions = useRef<Partial<Record<Decision, HTMLButtonElement | null>>>({});
  const [failed, setFailed] = useState<Decision | null>(null);
  useEffect(() => {
    if (!failed || busy) return;
    const active = document.activeElement;
    if (!active || active === document.body)
      actions.current[failed]?.focus({ preventScroll: true });
    setFailed(null);
  }, [failed, busy]);
  const { client } = context;
  useEffect(() => {
    let live = true;
    setRecord(null);
    setError(null);
    setSettled(false);
    void client
      .readWorkspaceSkill(workspaceId, reference.skillId, reference.revisionId)
      .then((value) => {
        if (!live) return;
        // Never silently substitute a newer head, scope, or removal proposal.
        if (
          value.id !== reference.skillId ||
          value.revisionId !== reference.revisionId ||
          value.scopeVersion !== reference.expectedScopeVersion ||
          value.activeRevisionId !== reference.expectedRevisionId ||
          (value.removalOperationId ?? null) !== (reference.removalOperationId ?? null) ||
          !value.pendingRevisionIds.includes(reference.revisionId)
        ) {
          setSettled(true);
          return;
        }
        setRecord(value);
      })
      .catch((reason) => {
        if (!live) return;
        if (reason instanceof OpenGeniApiError && reason.status === 404) setSettled(true);
        else setError("Could not load this Skill review.");
      });
    return () => {
      live = false;
    };
  }, [
    client,
    workspaceId,
    reference.skillId,
    reference.revisionId,
    reference.expectedRevisionId,
    reference.expectedScopeVersion,
    reference.removalOperationId,
    reload,
  ]);

  if (settled) return null;
  const removal = Boolean(reference.removalOperationId);
  const update = Boolean(reference.expectedRevisionId);
  const name = record?.title || record?.stableKey || "Skill";
  const grant = context.accessContext.workspaceGrants.find(
    (entry) => entry.workspaceId === workspaceId,
  );
  const human = grant?.principalKind === "human_session" || context.authSession != null;
  const canManage = Boolean(
    record &&
    human &&
    (record.scope === "user" ||
      (record.scope === "workspace" &&
        hasWorkspacePermission(context.accessContext, workspaceId, "documents:manage")) ||
      (record.scope === "organization" &&
        canAdministerOrganization({
          accessContext: context.accessContext,
          clientConfig: context.clientConfig,
          accountId: grant?.accountId,
        }))),
  );

  async function decide(decision: Decision) {
    if (!record || !canManage || busy) return;
    setBusy(decision);
    setError(null);
    try {
      const request = {
        operationId: (operationIds.current[decision] ??= crypto.randomUUID()),
        revisionId: reference.revisionId,
        expectedRevisionId: reference.expectedRevisionId,
        expectedScopeVersion: reference.expectedScopeVersion,
        ...(reference.removalOperationId
          ? { removalOperationId: reference.removalOperationId }
          : {}),
        reason: `${decision === "approved" ? "Approve" : "Decline"} exact Skill revision from its session`,
      };
      const receipt =
        decision === "approved"
          ? await client.approveWorkspaceSkill(workspaceId, reference.skillId, request)
          : await client.rejectWorkspaceSkill(workspaceId, reference.skillId, request);
      // A rejection is preserved, not applied: never read one as the other.
      const done =
        decision === "approved"
          ? receipt.outcome === "applied" && receipt.decision !== "rejected"
          : receipt.decision === "rejected";
      if (!done) throw new Error("Reload its review, then try again.");
      onDecided(name, removal, decision);
    } catch (reason) {
      const verb =
        decision === "approved" ? (removal ? "delete" : "approve") : removal ? "keep" : "decline";
      setError(`Couldn't ${verb} this Skill. ${userErrorText(reason)}`);
      setFailed(decision);
    } finally {
      setBusy(null);
    }
  }

  // The bar says, without opening anything, that the Skill does nothing yet.
  const kind = removal ? "Delete Skill" : update ? "Skill update" : "New Skill";
  const effect = removal
    ? "Can't be undone once approved"
    : update
      ? "Not applied until approved"
      : "Not active until approved";
  const status = busy
    ? busy === "approved"
      ? removal
        ? "Deleting…"
        : "Approving…"
      : removal
        ? "Keeping…"
        : "Declining…"
    : record
      ? `${kind} · ${effect}`
      : error
        ? kind
        : "Loading Skill…";
  return (
    <section aria-label="Skill review" className="my-3 space-y-2">
      <article
        aria-labelledby={titleId}
        aria-busy={busy !== null}
        data-skill-review={removal ? "removal" : update ? "update" : "new"}
        className={cn(decisionCardClass, record && !canManage && "shadow-none")}
      >
        <div className={barClass}>
          <div className="flex min-w-0 flex-[1_1_14rem] items-center gap-3">
            <DecisionMark tone={removal ? "danger" : "neutral"}>
              <WandSparklesIcon aria-hidden="true" />
            </DecisionMark>
            <div className="min-w-0 flex-1">
              <h3 id={titleId} className="m-0 text-og-sm font-semibold text-og-fg">
                {record ? (
                  <button
                    type="button"
                    aria-expanded={open}
                    aria-controls={detailsId}
                    onClick={() => setOpen((value) => !value)}
                    className="inline-flex max-w-full items-center gap-1 rounded-og-sm text-left hover:underline focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-og-accent/40"
                  >
                    <span className="truncate">{name}</span>
                    <ChevronDownIcon
                      aria-hidden="true"
                      className={cn(
                        "size-3.5 shrink-0 text-og-fg-subtle transition-transform",
                        open && "rotate-180",
                      )}
                    />
                  </button>
                ) : (
                  <span className="block truncate">{name}</span>
                )}
              </h3>
              <p className={statusClass}>
                {record && canManage ? (
                  <span
                    aria-hidden="true"
                    className="size-1.5 shrink-0 rounded-full bg-og-status-waiting"
                  />
                ) : null}
                <span className="line-clamp-2 min-w-0">{status}</span>
              </p>
            </div>
          </div>
          {record && canManage ? (
            <div className="ml-auto flex shrink-0 items-center gap-2">
              <DecisionButton
                ref={(element) => {
                  actions.current.declined = element;
                }}
                kind="quiet"
                disabled={busy !== null}
                busy={busy === "declined"}
                className={compactButton}
                onClick={() => void decide("declined")}
              >
                {removal ? "Keep" : "Decline"}
              </DecisionButton>
              <DecisionButton
                ref={(element) => {
                  actions.current.approved = element;
                }}
                kind={removal ? "danger" : "primary"}
                disabled={busy !== null}
                busy={busy === "approved"}
                className={compactButton}
                onClick={() => void decide("approved")}
              >
                {removal ? "Delete" : "Approve"}
              </DecisionButton>
            </div>
          ) : null}
        </div>
        <div
          id={detailsId}
          hidden={!open}
          className="space-y-2 border-t border-og-border px-3 py-3 text-og-sm leading-relaxed"
        >
          {open && record ? (
            <>
              {removal ? (
                <p className="m-0 text-og-fg">
                  Permanently deletes this Skill and all stored revisions. This cannot be undone;
                  conversations remain unchanged.
                </p>
              ) : record.description ? (
                <p className="m-0 text-og-fg">{record.description}</p>
              ) : null}
              {canManage ? null : (
                <p className="m-0 text-og-fg-muted">
                  Someone who can manage Skills can approve it.
                </p>
              )}
              {record.files.map((file) => (
                <details key={file.path}>
                  <summary className="cursor-pointer break-all text-og-sm text-og-fg-muted">
                    {file.path}
                  </summary>
                  <pre className="mt-1 max-h-64 overflow-auto whitespace-pre-wrap break-words rounded-og-md bg-og-fg/[0.035] p-2 text-og-xs">
                    {file.content}
                  </pre>
                </details>
              ))}
            </>
          ) : null}
        </div>
      </article>
      {error ? (
        <div role="alert" className="text-sm">
          {error}{" "}
          <Button
            variant="ghost"
            disabled={busy !== null}
            onClick={() => setReload((value) => value + 1)}
          >
            Reload review
          </Button>
        </div>
      ) : null}
    </section>
  );
}

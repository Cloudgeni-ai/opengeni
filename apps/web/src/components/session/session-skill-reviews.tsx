import { useEffect, useMemo, useRef, useState } from "react";
import type { SessionEvent, SkillRecord } from "@opengeni/sdk";
import type { SkillReviewReference } from "@opengeni/contracts";
import type { AppContextValue } from "@/context";
import { Button } from "@/components/ui/button";
import { hasAccountPermission, hasWorkspacePermission } from "@/lib/permissions";
import { sessionSkillReviews } from "@/lib/session-skill-reviews";

export function SessionSkillReviews({
  context,
  workspaceId,
  events,
}: {
  context: AppContextValue;
  workspaceId: string;
  events: readonly SessionEvent[];
}) {
  const reviews = useMemo(() => sessionSkillReviews(events), [events]);
  return reviews.map((reference) => (
    <SkillReview
      key={`${context.accessContext.subjectId}:${workspaceId}:${reference.revisionId}`}
      context={context}
      workspaceId={workspaceId}
      reference={reference}
    />
  ));
}

function SkillReview({
  context,
  workspaceId,
  reference,
}: {
  context: AppContextValue;
  workspaceId: string;
  reference: SkillReviewReference;
}) {
  const [record, setRecord] = useState<SkillRecord | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [settled, setSettled] = useState(false);
  const [reload, setReload] = useState(0);
  // Uncertain network outcomes must replay the same immutable operation.
  const operationId = useRef<string | null>(null);
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
      .catch(() => {
        if (live) setError("Could not load this Skill review.");
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
  const grant = context.accessContext.workspaceGrants.find(
    (entry) => entry.workspaceId === workspaceId,
  );
  const human = grant?.principalKind === "human_session" || context.authSession != null;
  const canManage = Boolean(
    record &&
    human &&
    (record.scope === "user" ||
      (record.scope === "workspace" &&
        hasWorkspacePermission(context.accessContext, workspaceId, "workspace:admin")) ||
      (record.scope === "organization" &&
        grant &&
        hasAccountPermission(context.accessContext, grant.accountId, "account:admin"))),
  );

  async function approve() {
    if (!record || !canManage || busy) return;
    setBusy(true);
    setError(null);
    try {
      const receipt = await client.approveWorkspaceSkill(workspaceId, reference.skillId, {
        operationId: (operationId.current ??= crypto.randomUUID()),
        revisionId: reference.revisionId,
        expectedRevisionId: reference.expectedRevisionId,
        expectedScopeVersion: reference.expectedScopeVersion,
        ...(reference.removalOperationId
          ? { removalOperationId: reference.removalOperationId }
          : {}),
        reason: "Approve exact Skill revision from its session",
      });
      if (receipt.outcome !== "applied")
        throw new Error("The Skill was not approved. Reload its review before trying again.");
      setSettled(true);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not approve this Skill.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section aria-label="Skill review" className="my-3 space-y-2 rounded-lg border p-3">
      <details>
        <summary className="cursor-pointer text-sm font-medium">
          Review {record?.title || "pending Skill"}
        </summary>
        {record ? (
          <div className="mt-3 space-y-2">
            {reference.removalOperationId ? (
              <p className="text-sm">
                Permanently deletes this Skill and all stored revisions. This cannot be undone;
                conversations remain unchanged.
              </p>
            ) : (
              <p className="text-sm text-fg-muted">Approval activates these exact files.</p>
            )}
            {record.files.map((file) => (
              <details key={file.path} open={file.path === "SKILL.md"}>
                <summary className="cursor-pointer break-all text-sm">{file.path}</summary>
                <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-words p-2 text-xs">
                  {file.content}
                </pre>
              </details>
            ))}
            {canManage ? (
              <Button disabled={busy} onClick={() => void approve()}>
                {busy
                  ? "Approving…"
                  : reference.removalOperationId
                    ? "Permanently delete Skill"
                    : "Approve Skill"}
              </Button>
            ) : (
              <p className="text-sm text-fg-muted">
                You do not have permission to approve this Skill.
              </p>
            )}
          </div>
        ) : !error ? (
          <p role="status">Loading Skill…</p>
        ) : null}
      </details>
      {error ? (
        <div role="alert" className="text-sm">
          {error}{" "}
          <Button variant="ghost" disabled={busy} onClick={() => setReload((value) => value + 1)}>
            Reload review
          </Button>
        </div>
      ) : null}
    </section>
  );
}

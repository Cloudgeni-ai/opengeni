import type { AgentInstructionReviewItem, SkillRecord, SkillSummary } from "@opengeni/sdk";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { MetaChip } from "@/components/ui/meta-chip";
import { useAppContext } from "@/context";
import { canManageWorkspaceSettings, hasAccountPermission } from "@/lib/permissions";

/** Behavioral content keeps its native revision authority but shares the review surface. */
export function BehaviorReviews({ workspaceId }: { workspaceId: string }) {
  const context = useAppContext();
  const workspace = context.workspaces.find((item) => item.id === workspaceId) ?? null;
  const canManage = canManageWorkspaceSettings(
    context.accessContext,
    workspace,
    context.managedSelfContext,
  );
  const canManageOrganization = workspace
    ? hasAccountPermission(context.accessContext, workspace.accountId, "account:admin")
    : false;
  const [instructions, setInstructions] = useState<AgentInstructionReviewItem[]>([]);
  const [instructionCursor, setInstructionCursor] = useState<string | null>(null);
  const [skills, setSkills] = useState<SkillSummary[]>([]);
  const [skillCursor, setSkillCursor] = useState<string | null>(null);
  const [skill, setSkill] = useState<SkillRecord | null>(null);
  const [instruction, setInstruction] = useState<AgentInstructionReviewItem | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [refresh, setRefresh] = useState(0);
  const canReviewSkill = (value: SkillSummary) =>
    value.scope === "user" || (value.scope === "organization" ? canManageOrganization : canManage);
  const errorText = (reason: unknown) =>
    reason instanceof Error ? reason.message : String(reason);
  useEffect(() => {
    let current = true;
    setInstructions([]);
    setSkills([]);
    setInstructionCursor(null);
    setSkillCursor(null);
    setError(null);
    void Promise.allSettled([
      canManage
        ? context.client.listAgentInstructionReviews(workspaceId)
        : Promise.resolve({ entries: [], nextCursor: null }),
      context.client.listWorkspaceSkills(workspaceId, { limit: 100 }),
    ]).then(([policies, procedures]) => {
      if (!current) return;
      if (policies.status === "fulfilled") {
        setInstructions(policies.value.entries);
        setInstructionCursor(policies.value.nextCursor);
      }
      if (procedures.status === "fulfilled") {
        setSkills(procedures.value.skills);
        setSkillCursor(procedures.value.nextCursor);
      }
      const failures = [policies, procedures].flatMap((result) =>
        result.status === "rejected" ? [errorText(result.reason)] : [],
      );
      if (failures.length) setError(failures.join(" "));
    });
    return () => {
      current = false;
    };
  }, [context.client, workspaceId, canManage, refresh]);
  async function more(kind: "instructions" | "skills") {
    setBusy(true);
    setError(null);
    try {
      if (kind === "instructions" && instructionCursor) {
        const page = await context.client.listAgentInstructionReviews(
          workspaceId,
          instructionCursor,
        );
        setInstructions((prior) => [...prior, ...page.entries]);
        setInstructionCursor(page.nextCursor);
      } else if (skillCursor) {
        const page = await context.client.listWorkspaceSkills(workspaceId, {
          cursor: skillCursor,
          limit: 100,
        });
        setSkills((prior) => [...prior, ...page.skills]);
        setSkillCursor(page.nextCursor);
      }
    } catch (reason) {
      setError(errorText(reason));
    } finally {
      setBusy(false);
    }
  }
  async function decide(decision: "approve" | "reject") {
    setBusy(true);
    setError(null);
    try {
      if (instruction)
        await context.client.reviewAgentInstruction(workspaceId, {
          operationId: crypto.randomUUID(),
          revisionId: instruction.revisionId,
          decision,
          reason: `${decision === "approve" ? "Approved" : "Rejected"} in Knowledge review`,
        });
      else if (skill?.revisionId)
        await (
          decision === "approve"
            ? context.client.approveWorkspaceSkill.bind(context.client)
            : context.client.rejectWorkspaceSkill.bind(context.client)
        )(workspaceId, skill.id, {
          operationId: crypto.randomUUID(),
          revisionId: skill.revisionId,
          expectedRevisionId: skill.activeRevisionId,
          expectedScopeVersion: skill.scopeVersion,
          reason: `${decision === "approve" ? "Approved" : "Rejected"} in Knowledge review`,
        });
      setSkill(null);
      setInstruction(null);
      setRefresh((n) => n + 1);
    } catch (reason) {
      setError(errorText(reason));
    } finally {
      setBusy(false);
    }
  }
  const pendingSkills = skills.filter(
    (item) => item.pendingRevisionIds.length && canReviewSkill(item),
  );
  if (!instructions.length && !pendingSkills.length && !error && !instructionCursor && !skillCursor)
    return null;
  return (
    <section aria-labelledby="behavior-review-heading" className="mb-5 grid gap-3">
      <h3 id="behavior-review-heading" className="text-sm font-medium">
        Instructions and Skills
      </h3>
      {error ? (
        <p role="alert" className="text-xs text-status-error">
          {error}
        </p>
      ) : null}
      <div className="divide-y divide-border">
        {instructions.map((item) => (
          <div key={item.revisionId} className="flex items-start gap-3 py-3">
            <div className="min-w-0 flex-1">
              <MetaChip>Workspace instruction</MetaChip>
              <p className="mt-2 line-clamp-2 text-sm">{item.content}</p>
            </div>
            <Button variant="outline" size="sm" onClick={() => setInstruction(item)}>
              Review
            </Button>
          </div>
        ))}
        {pendingSkills.map((item) => (
          <div key={item.id} className="flex items-center gap-3 py-3">
            <div className="min-w-0 flex-1">
              <p className="text-sm font-medium">{item.title ?? item.stableKey}</p>
              <MetaChip>Skill</MetaChip>
            </div>
            <Button
              variant="outline"
              size="sm"
              disabled={busy}
              onClick={() => {
                setBusy(true);
                setError(null);
                void context.client
                  .readWorkspaceSkill(workspaceId, item.id, item.pendingRevisionIds[0])
                  .then(setSkill)
                  .catch((reason) => setError(errorText(reason)))
                  .finally(() => setBusy(false));
              }}
            >
              Review
            </Button>
          </div>
        ))}
      </div>
      {instructionCursor ? (
        <Button variant="ghost" disabled={busy} onClick={() => void more("instructions")}>
          More instructions
        </Button>
      ) : null}
      {skillCursor ? (
        <Button variant="ghost" disabled={busy} onClick={() => void more("skills")}>
          Check more Skills
        </Button>
      ) : null}
      <Dialog
        open={instruction !== null || skill !== null}
        onOpenChange={(open) => {
          if (!open) {
            setInstruction(null);
            setSkill(null);
          }
        }}
      >
        <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>{skill?.title ?? "Review workspace instruction"}</DialogTitle>
            <DialogDescription>
              Approval makes this exact revision available to agents.
            </DialogDescription>
          </DialogHeader>
          {instruction ? (
            <>
              <p className="whitespace-pre-wrap text-sm leading-6">{instruction.content}</p>
              <p className="text-xs text-fg-muted">{instruction.reason}</p>
            </>
          ) : (
            skill?.files.map((file) => (
              <section key={file.path} className="grid gap-2">
                <h3 className="text-sm font-medium">{file.path}</h3>
                <pre className="overflow-x-auto whitespace-pre-wrap break-words text-xs leading-5">
                  {file.content}
                </pre>
              </section>
            ))
          )}
          {error ? (
            <p role="alert" className="text-sm text-status-error">
              {error}
            </p>
          ) : null}
          <div className="flex gap-2">
            <Button disabled={busy} onClick={() => void decide("approve")}>
              Approve
            </Button>
            <Button variant="outline" disabled={busy} onClick={() => void decide("reject")}>
              Reject
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </section>
  );
}

import type {
  KnowledgeEntryReach,
  KnowledgeEntryReachRecord,
  KnowledgeEntryScope,
} from "@opengeni/sdk";
import { LayersIcon } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";

import { useAppContext } from "@opengeni/react/app/app-context";
import {
  WorkspaceReachFields,
  workspaceReachSummary,
  type ReachWorkspace,
  type WorkspaceReach,
} from "@opengeni/react/app/components/workspace-reach";
import { userErrorText } from "@opengeni/react/ui/api-error";
import { Button } from "@opengeni/react/ui/button";
import { DetailAsideItem } from "@opengeni/react/ui/detail-page";
import { FormDialog } from "@opengeni/react/ui/form-dialog";

import {
  OrganizationReachDialog,
  organizationReachSummary,
} from "@/components/organization-reach-dialog";
import { useOrganizationName } from "@/lib/use-organization-name";

/* ----------------------------------------------------------------------------
   "Available in" for an organization or personal Knowledge entry. The
   workspace it was added in always has it. An organization entry works in
   every shared workspace or the ones its managers pick, plus members'
   Personal workspaces when switched on. A personal entry works in its
   owner's Personal workspace and the workspaces they turn on. Workspace
   entries never leave their workspace, so they show nothing here.
   -------------------------------------------------------------------------- */

const HOME_REASON = "It was added here, so it's always included.";

export function KnowledgeReachItem({
  workspaceId,
  entryId,
  scope,
  title,
}: {
  workspaceId: string;
  entryId: string;
  scope: KnowledgeEntryScope;
  title: string;
}) {
  const context = useAppContext();
  const { client } = context;
  const [record, setRecord] = useState<KnowledgeEntryReachRecord | null>(null);
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (scope === "workspace") return;
    let live = true;
    // Older servers don't know where an entry works; the row stays hidden.
    void Promise.resolve()
      .then(() => client.getKnowledgeEntryReach(workspaceId, entryId))
      .then((value) => {
        if (live) setRecord(value);
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [client, workspaceId, entryId, scope]);
  const accountId = context.workspaces.find((workspace) => workspace.id === workspaceId)?.accountId;
  const organization = record?.scope === "organization";
  const organizationName =
    useOrganizationName(accountId ?? "", organization && record.canChange, context) ??
    "your organization";
  if (!record?.reach || record.scope === "workspace" || !accountId) return null;
  const reach = record.reach;
  const home = record.originWorkspaceId;
  const mine = context.workspaces.filter((workspace) => workspace.accountId === accountId);
  const personalId = mine.find((workspace) => workspace.kind === "personal")?.id;
  const save = async (next: KnowledgeEntryReach) => {
    const saved = await client.updateKnowledgeEntryReach(workspaceId, entryId, next);
    setRecord(saved);
    return saved;
  };
  const summary = organization
    ? organizationReachSummary(reach, home)
    : personalReachSummary(reach, home, personalId);

  return (
    <DetailAsideItem label="Available in" icon={<LayersIcon />}>
      <span className="flex min-w-0 flex-col items-start gap-1">
        <span>{summary}</span>
        {record.canChange ? (
          <Button
            type="button"
            variant="link"
            size="sm"
            className="h-auto p-0"
            onClick={() => setOpen(true)}
          >
            Change
          </Button>
        ) : null}
      </span>
      {record.canChange && organization ? (
        <OrganizationReachDialog
          open={open}
          onOpenChange={setOpen}
          client={client}
          noun="Knowledge entry"
          name={title}
          reach={reach}
          home={{ workspaceId: home, reason: HOME_REASON }}
          organizationId={accountId}
          organizationName={organizationName}
          managedBy="Organization owners manage it."
          hereId={workspaceId}
          save={async (next) => (await save(next)).reach ?? next}
          onSaved={() => setOpen(false)}
        />
      ) : null}
      {record.canChange && !organization ? (
        <PersonalKnowledgeReachDialog
          open={open}
          onOpenChange={setOpen}
          title={title}
          homeWorkspaceId={home}
          hereId={workspaceId}
          reachWorkspaceIds={reach.allowedWorkspaceIds}
          workspaces={mine.map(({ id, name, kind }) => ({
            id,
            name,
            personal: kind === "personal",
          }))}
          organizationName={organizationName}
          onSave={async (allowedWorkspaceIds) => {
            const saved = await save({ allowedWorkspaceIds, allowPersonalWorkspaces: true });
            toast.success(
              `${title} is available in ${personalReachSummary(saved.reach ?? reach, home, personalId).toLowerCase()}`,
            );
          }}
        />
      ) : null}
    </DetailAsideItem>
  );
}

/** "Personal + 2 workspaces": the workspace it was added in counts, unless that's Personal. */
export function personalReachSummary(
  reach: KnowledgeEntryReach,
  homeWorkspaceId: string,
  personalWorkspaceId: string | undefined,
): string {
  const workspaceIds =
    reach.allowedWorkspaceIds === null
      ? null
      : [...new Set([...reach.allowedWorkspaceIds, homeWorkspaceId])].filter(
          (id) => id !== personalWorkspaceId,
        );
  return workspaceReachSummary(
    { workspaceIds, personalWorkspaces: true },
    { owner: "person", personalWorkspaces: "always" },
  );
}

/**
 * Where the owner's personal entry works: the workspace it was added in and
 * their Personal workspace always, plus the ones they pick, or all of their
 * workspaces in the organization. It stays personal in each: only they, and
 * agent turns that learn for them, can use it there.
 */
function PersonalKnowledgeReachDialog({
  open,
  onOpenChange,
  title,
  homeWorkspaceId,
  hereId,
  reachWorkspaceIds,
  workspaces,
  organizationName,
  onSave,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  homeWorkspaceId: string;
  hereId: string;
  /** Its other workspaces now; null for all of them. */
  reachWorkspaceIds: readonly string[] | null;
  /** The owner's workspaces in this organization, their Personal workspace marked. */
  workspaces: readonly ReachWorkspace[];
  organizationName: string;
  onSave: (reachWorkspaceIds: string[] | null) => Promise<void>;
}) {
  const savedKey = reachWorkspaceIds === null ? null : [...reachWorkspaceIds].sort().join(",");
  const [value, setValue] = useState<WorkspaceReach>({
    workspaceIds: reachWorkspaceIds,
    personalWorkspaces: true,
  });
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (open) {
      setValue({
        workspaceIds: savedKey === null ? null : savedKey.split(",").filter(Boolean),
        personalWorkspaces: true,
      });
      setError(null);
    }
  }, [open, savedKey]);
  const personal = new Set(workspaces.filter((workspace) => workspace.personal).map((w) => w.id));
  const chosen =
    value.workspaceIds === null
      ? null
      : value.workspaceIds.filter((id) => id !== homeWorkspaceId && !personal.has(id)).sort();
  const unchanged = chosen === null ? savedKey === null : savedKey === chosen.join(",");
  return (
    <FormDialog
      open={open}
      onOpenChange={onOpenChange}
      title="Available in"
      description={`“${title}” stays personal: in each of these workspaces, only you and agents that learn for you can use it.`}
      submitLabel="Save"
      pendingLabel="Saving…"
      submitDisabled={unchanged}
      error={error}
      onSubmit={async () => {
        try {
          await onSave(chosen);
        } catch (cause) {
          setError(userErrorText(cause, "Couldn't change where this entry works."));
          return false;
        }
      }}
      onSubmitted={() => onOpenChange(false)}
    >
      <WorkspaceReachFields
        owner={{ kind: "person" }}
        organizationName={organizationName}
        label="Available in"
        labelHidden
        value={value}
        onChange={setValue}
        workspaces={workspaces}
        hereId={hereId}
        alwaysIncluded={{ [homeWorkspaceId]: HOME_REASON }}
        personalWorkspaces="always"
      />
    </FormDialog>
  );
}

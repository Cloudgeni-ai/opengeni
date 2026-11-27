import { useEffect, useMemo, useRef, useState, type RefObject } from "react";
import { LinkIcon } from "lucide-react";
import type { SkillRecord, SkillScope, SkillSummary } from "@opengeni/sdk";
import {
  SkillsPanel as SharedSkillsPanel,
  type SkillOwnerFilter,
  type SkillsPanelController,
} from "@opengeni/react/skills";
import { humanizeName } from "@opengeni/react/app/lib/skill-names";
import { CatalogHeader } from "@/components/capabilities/catalog-header";
import { useCapabilityPageSlot } from "@/components/capabilities/capability-page-slot";
import {
  OrganizationReachDialog,
  organizationReachSummary,
} from "@/components/organization-reach-dialog";
import { useOrganizationNameFrom } from "@/lib/use-organization-name";
import { DropdownMenuItem } from "@opengeni/react/ui/dropdown-menu";
import { useAppContext, type AppContextValue } from "@opengeni/react/app/app-context";
import { hasWorkspacePermission } from "@opengeni/react/app/lib/permissions";
import { useAppPackageStatus } from "@opengeni/react/app/lib/use-app-package-status";
import { canAdministerOrganization } from "@opengeni/react/app/lib/workspaces";

/*
 * The console's Skills tab: the shared Skills page from @opengeni/react/skills
 * with what only the console adds: the Capabilities toolbar and page slot,
 * personal and organization Skills, where an organization Skill works, and
 * import from a URL.
 */

export {
  SKILL_OWNER_FILTER_OPTIONS,
  skillOwnerListFilter,
  type SkillOwnerFilter,
} from "@opengeni/react/skills";

type SkillsPanelProps = {
  workspaceId: string;
  query?: string;
  owner?: SkillOwnerFilter;
  onFindSkill?: (() => void) | undefined;
  onImportSkill?: (() => void) | undefined;
  refreshRevision?: number;
  onSkillsChange?: (skills: SkillSummary[]) => void;
  onRemoved?: () => void;
  openSkillRef?: RefObject<((id: string) => void) | null>;
};

export function SkillsPanel(props: SkillsPanelProps) {
  return <SkillsPanelContent context={useAppContext()} {...props} />;
}

export function SkillsPanelContent({
  context,
  workspaceId,
  query = "",
  owner = "all",
  onFindSkill,
  onImportSkill,
  refreshRevision = 0,
  onSkillsChange,
  onRemoved,
  openSkillRef,
}: SkillsPanelProps & { context: AppContextValue }) {
  const { client } = context;
  // Inside Capabilities a skill opens as its own page in the route's page slot
  // (`?open=skill:<id>`); elsewhere the page replaces the list in place.
  const slot = useCapabilityPageSlot();
  const controllerRef = useRef<SkillsPanelController | null>(null);
  const grant = context.accessContext.workspaceGrants.find(
    (entry) => entry.workspaceId === workspaceId,
  );
  const human = grant?.principalKind === "human_session" || context.authSession != null;
  const canManage = (scope: SkillScope) =>
    Boolean(
      human &&
      (scope === "user" ||
        (scope === "workspace" &&
          hasWorkspacePermission(context.accessContext, workspaceId, "documents:manage")) ||
        (scope === "organization" &&
          canAdministerOrganization({
            accessContext: context.accessContext,
            clientConfig: context.clientConfig,
            accountId: grant?.accountId,
          }))),
    );
  // An organization Skill works in the workspaces its organization picks.
  // Whoever may change the organization's Skills also sees the ones that
  // don't work here, so they can change that; everyone else sees what this
  // workspace's agents use.
  const canManageOrganization = canManage("organization");
  const organizationId = grant?.accountId ?? "";
  const organizationName =
    useOrganizationNameFrom(context, organizationId, canManageOrganization) ?? "your organization";
  const [reachFor, setReachFor] = useState<string | null>(null);
  // Skills an app installed keep its name, also after the app is archived.
  const appPackages = useAppPackageStatus(client, workspaceId).apps;
  const skillSources = useMemo(() => {
    const sources = new Map<string, string>();
    for (const app of appPackages.values())
      for (const skill of app.skills)
        if (!sources.has(skill.id)) sources.set(skill.id, `From app ${app.title}`);
    return sources;
  }, [appPackages]);

  useEffect(() => {
    if (!openSkillRef) return;
    openSkillRef.current = (id) => controllerRef.current?.open(id);
    return () => {
      openSkillRef.current = null;
    };
  });

  return (
    <SharedSkillsPanel
      client={client}
      workspaceId={workspaceId}
      canManage={canManage}
      query={query}
      skillSources={skillSources}
      owner={owner}
      showUnavailable={canManageOrganization}
      refreshRevision={refreshRevision}
      onSkillsChange={onSkillsChange}
      onRemoved={onRemoved}
      controllerRef={controllerRef}
      slot={slot}
      backLabel={slot ? "Capabilities" : "Skills"}
      listTitle="Your skills"
      emptyText={
        onFindSkill
          ? "No skills installed yet. Browse the catalog below or add your own."
          : "No skills yet. Create one to give your agent reusable instructions."
      }
      renderHeader={(header) => (
        <CatalogHeader
          title={header.title}
          headingRef={header.headingRef}
          hidden={header.hidden}
          action={header.action}
        />
      )}
      addMenuItems={
        onImportSkill ? (
          <DropdownMenuItem onSelect={onImportSkill}>
            <LinkIcon />
            From a URL
          </DropdownMenuItem>
        ) : undefined
      }
      reach={{
        summary: (skill) => (skill.reach ? organizationReachSummary(skill.reach) : undefined),
        onChange: canManageOrganization ? (skill) => setReachFor(skill.id) : undefined,
      }}
    >
      {(record: SkillRecord | null) =>
        record?.scope === "organization" && record.reach && canManageOrganization ? (
          <OrganizationReachDialog
            open={reachFor === record.id}
            onOpenChange={(isOpen) => setReachFor(isOpen ? record.id : null)}
            client={client}
            noun="Skill"
            name={humanizeName(record.title || record.stableKey)}
            reach={record.reach}
            organizationId={organizationId}
            organizationName={organizationName}
            managedBy="Organization owners and admins manage it."
            hereId={workspaceId}
            save={async (next) =>
              (await client.updateSkillReach(workspaceId, record.id, next)).reach
            }
            onSaved={(reach) => {
              setReachFor(null);
              const skillId = record.id;
              controllerRef.current?.update(skillId, { reach });
              // Whether this workspace's agents still use it is the server's call.
              void client
                .readWorkspaceSkill(workspaceId, skillId)
                .then((fresh) =>
                  controllerRef.current?.update(skillId, {
                    reach: fresh.reach ?? reach,
                    availableHere: fresh.availableHere,
                  }),
                )
                .catch(() => undefined);
            }}
          />
        ) : null
      }
    </SharedSkillsPanel>
  );
}

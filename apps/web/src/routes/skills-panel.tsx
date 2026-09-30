import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import { BookOpenIcon, ChevronDownIcon, PlusIcon } from "lucide-react";
import { ConnectionInstalled } from "@opengeni/react/connect";
import "@opengeni/react/connect.css";
import type {
  SkillRecord,
  RemoveWorkspaceSkillRequest,
  SkillScope,
  SkillSummary,
  PreferenceRegistryRevisionSummary,
} from "@opengeni/sdk";
import { CatalogHeader } from "@/components/capabilities/catalog-header";
import {
  CapabilitySlotPage,
  useCapabilityPageSlot,
} from "@/components/capabilities/capability-page-slot";
import { humanizeName } from "@/components/capabilities/skill-copy";
import { SkillPage, skillStatus } from "@/components/capabilities/skill-page";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { DetailPage } from "@/components/ui/detail-page";
import { DetailSkeleton } from "@/components/ui/detail-sheet";
import { EmptyState } from "@/components/ui/empty-state";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
} from "@/components/ui/dropdown-menu";
import { useAppContext, type AppContextValue } from "@/context";
import { hasAccountPermission, hasWorkspacePermission } from "@/lib/permissions";

/** Both product destinations use this catalog and the same folder write API. */
export function SkillsPanel({
  workspaceId,
  personalWorkspace = false,
  query = "",
  onFindSkill,
  onImportSkill,
  refreshRevision = 0,
  onSkillsChange,
  onRemoved,
  openSkillRef,
}: {
  workspaceId: string;
  personalWorkspace?: boolean;
  query?: string;
  onFindSkill?: (() => void) | undefined;
  onImportSkill?: (() => void) | undefined;
  refreshRevision?: number;
  onSkillsChange?: (skills: SkillSummary[]) => void;
  onRemoved?: () => void;
  openSkillRef?: RefObject<((id: string) => void) | null>;
}) {
  return (
    <SkillsPanelContent
      context={useAppContext()}
      workspaceId={workspaceId}
      personalWorkspace={personalWorkspace}
      query={query}
      onFindSkill={onFindSkill}
      onImportSkill={onImportSkill}
      refreshRevision={refreshRevision}
      {...(onSkillsChange ? { onSkillsChange } : {})}
      {...(onRemoved ? { onRemoved } : {})}
      {...(openSkillRef ? { openSkillRef } : {})}
    />
  );
}

export function SkillsPanelContent({
  context,
  workspaceId,
  personalWorkspace = false,
  query = "",
  onFindSkill,
  onImportSkill,
  refreshRevision = 0,
  onSkillsChange,
  onRemoved,
  openSkillRef,
}: {
  context: AppContextValue;
  workspaceId: string;
  personalWorkspace?: boolean;
  query?: string;
  onFindSkill?: (() => void) | undefined;
  onImportSkill?: (() => void) | undefined;
  refreshRevision?: number;
  onSkillsChange?: (skills: SkillSummary[]) => void;
  onRemoved?: () => void;
  openSkillRef?: RefObject<((id: string) => void) | null>;
}) {
  const { client } = context;
  // Inside Capabilities a skill opens as its own page in the route's page slot
  // (`?open=skill:<id>`); elsewhere the page replaces the list in place.
  const slot = useCapabilityPageSlot();
  const openerRef = useRef<HTMLElement | null>(null);
  const removalTriggerRef = useRef<HTMLElement | null>(null);
  const newSkillRef = useRef<HTMLButtonElement | null>(null);
  const headingRef = useRef<HTMLHeadingElement | null>(null);
  const grant = context.accessContext.workspaceGrants.find(
    (entry) => entry.workspaceId === workspaceId,
  );
  const human = grant?.principalKind === "human_session" || context.authSession != null;
  const canManage = (scope: SkillScope) =>
    Boolean(
      human &&
      (scope === "user" ||
        (scope === "workspace" &&
          hasWorkspacePermission(context.accessContext, workspaceId, "workspace:admin")) ||
        (scope === "organization" &&
          grant &&
          hasAccountPermission(context.accessContext, grant.accountId, "account:admin"))),
    );
  const [skills, setSkills] = useState<SkillSummary[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [record, setRecord] = useState<SkillRecord | null>(null);
  const [files, setFiles] = useState<SkillRecord["files"]>([]);
  const [path, setPath] = useState("SKILL.md");
  const [newPath, setNewPath] = useState("");
  const [history, setHistory] = useState<PreferenceRegistryRevisionSummary[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [reload, setReload] = useState(0);
  const [removal, setRemoval] = useState<{
    skill: SkillRecord;
    request: RemoveWorkspaceSkillRequest;
  } | null>(null);
  const [removalError, setRemovalError] = useState<string | null>(null);
  const [discardAction, setDiscardAction] = useState<(() => void) | null>(null);
  // The id of a skill created on this page and not saved yet.
  const [draftId, setDraftId] = useState<string | null>(null);
  // The skill a page open is loading, so the URL sync does not load it twice.
  const openingRef = useRef<string | null>(null);
  const generation = useRef(0);
  const inventoryGeneration = useRef(0);
  const dirty = Boolean(
    record &&
    (files.length !== record.files.length ||
      files.some(
        (file, index) =>
          file.path !== record.files[index]?.path || file.content !== record.files[index]?.content,
      )),
  );

  useEffect(() => {
    generation.current++;
    openingRef.current = null;
    const current = ++inventoryGeneration.current;
    setLoading(true);
    setBusy(false);
    setRecord(null);
    setHistory([]);
    setNotice(null);
    setDiscardAction(null);
    setRemoval(null);
    setRemovalError(null);
    setSkills([]);
    setNextCursor(null);
    setError(null);
    void client
      .listWorkspaceSkills(workspaceId)
      .then((result) => {
        if (inventoryGeneration.current === current) {
          setLoading(false);
          setSkills(result.skills);
          setNextCursor(result.nextCursor ?? null);
        }
      })
      .catch((reason) => {
        if (inventoryGeneration.current === current)
          setError(reason instanceof Error ? reason.message : "Could not load Skills");
      })
      .finally(() => {
        if (inventoryGeneration.current === current) setLoading(false);
      });
    return () => {
      // Invalidate every request started since this effect, not only its initial list.
      // eslint-disable-next-line react-hooks/exhaustive-deps
      generation.current++;
      // eslint-disable-next-line react-hooks/exhaustive-deps
      inventoryGeneration.current++;
    };
  }, [client, workspaceId, reload]);

  useEffect(() => {
    onSkillsChange?.(skills);
  }, [skills, onSkillsChange]);
  useEffect(() => {
    if (!refreshRevision) return;
    let live = true;
    const current = ++inventoryGeneration.current;
    void client
      .listWorkspaceSkills(workspaceId)
      .then((result) => {
        if (live && current === inventoryGeneration.current) {
          setLoading(false);
          setSkills(result.skills);
          setNextCursor(result.nextCursor ?? null);
        }
      })
      .catch((reason) => {
        if (live && current === inventoryGeneration.current)
          setError(reason instanceof Error ? reason.message : "Could not refresh Skills");
      })
      .finally(() => {
        if (live && current === inventoryGeneration.current) setLoading(false);
      });
    return () => {
      live = false;
    };
  }, [client, workspaceId, refreshRevision]);
  useEffect(() => {
    if (!openSkillRef) return;
    openSkillRef.current = (id) => navigate(() => void open(id));
    return () => {
      openSkillRef.current = null;
    };
  });

  // Keep the open page and the URL in step: Back, Forward and shared links.
  const slotKey = slot?.openKey ?? null;
  useEffect(() => {
    if (!slot) return;
    if (slotKey?.startsWith("skill:")) {
      const id = slotKey.slice("skill:".length);
      if (id === "new") {
        if (record && record.id === draftId) return;
        const scope = ([personalWorkspace ? "user" : "workspace", "organization"] as const).find(
          canManage,
        );
        if (scope) create(scope);
        else slot.close({ replace: true });
        return;
      }
      if (record?.id === id || openingRef.current === id) return;
      void open(id);
      return;
    }
    if (record) {
      generation.current++;
      setRecord(null);
      setDraftId(null);
      setBusy(false);
    }
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- follows the URL and a reloaded inventory
  }, [slotKey, loading]);

  useEffect(() => {
    if (!dirty) return;
    const beforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", beforeUnload);
    return () => window.removeEventListener("beforeunload", beforeUnload);
  }, [dirty]);

  function navigate(action: () => void) {
    if (dirty) setDiscardAction(() => action);
    else action();
  }

  const loadMore = useCallback(async () => {
    if (!nextCursor || busy) return;
    const current = generation.current;
    const inventoryRequest = ++inventoryGeneration.current;
    setBusy(true);
    setError(null);
    try {
      const page = await client.listWorkspaceSkills(workspaceId, { cursor: nextCursor });
      if (inventoryGeneration.current !== inventoryRequest) return;
      setSkills((previous) => [
        ...new Map([...previous, ...page.skills].map((skill) => [skill.id, skill])).values(),
      ]);
      setNextCursor(page.nextCursor);
    } catch (reason) {
      if (generation.current === current)
        setError(reason instanceof Error ? reason.message : "Could not load more Skills");
    } finally {
      if (generation.current === current) setBusy(false);
    }
  }, [nextCursor, busy, client, workspaceId]);

  useEffect(() => {
    if (query.trim() && nextCursor && !busy && !error) void loadMore();
  }, [query, nextCursor, busy, error, loadMore]);

  function show(next: SkillRecord) {
    setRecord(next);
    setFiles(next.files);
    setPath("SKILL.md");
    setNewPath("");
  }
  async function open(skillId: string, revisionId?: string) {
    if (!record) openerRef.current = document.activeElement as HTMLElement | null;
    openingRef.current = skillId;
    if (slot && slot.openKey !== `skill:${skillId}`) slot.open(`skill:${skillId}`);
    const current = ++generation.current;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const [next, detail] = await Promise.all([
        client.readWorkspaceSkill(workspaceId, skillId, revisionId),
        client.getPreferenceRegistry(workspaceId, skillId),
      ]);
      if (generation.current !== current) return;
      setDraftId(null);
      show(next);
      setHistory(detail.revisions);
    } catch (reason) {
      if (generation.current === current)
        setError(reason instanceof Error ? reason.message : "Could not open Skill");
    } finally {
      if (generation.current === current) {
        setBusy(false);
        openingRef.current = null;
      }
    }
  }
  function closePage() {
    generation.current++;
    setRecord(null);
    setDraftId(null);
    setError(null);
    setNotice(null);
    setBusy(false);
    if (slot?.openKey?.startsWith("skill:")) slot.close();
    const opener = openerRef.current;
    openerRef.current = null;
    queueMicrotask(() => {
      if (opener?.isConnected && !opener.matches(":disabled")) opener.focus();
      else headingRef.current?.focus();
    });
  }
  function create(scope: SkillScope) {
    openerRef.current = newSkillRef.current;
    generation.current++;
    setHistory([]);
    setError(null);
    setNotice(null);
    const id = crypto.randomUUID();
    setDraftId(id);
    if (slot && slot.openKey !== "skill:new") slot.open("skill:new");
    show({
      id,
      stableKey: "",
      scope,
      scopeVersion: 1,
      activationMode: "workspace_managed",
      pendingRevisionIds: [],
      status: "proposed",
      activeRevisionId: null,
      revisionId: null,
      title: "",
      description: "",
      contentHash: null,
      source: null,
      files: [
        {
          path: "SKILL.md",
          content: "---\nname: my-skill\ndescription: When to use this Skill\n---\n\n",
        },
      ],
    });
  }
  async function changeScope(scope: SkillScope) {
    if (!record || scope === record.scope) return;
    if (!record.revisionId) {
      setRecord({ ...record, scope });
      return;
    }
    const current = ++generation.current;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await client.changePreferenceRegistryScope(workspaceId, record.id, {
        scope,
        expectedScopeVersion: record.scopeVersion,
        reason: "Change skill scope",
      });
      if (generation.current !== current) return;
      const inventoryRequest = ++inventoryGeneration.current;
      const [updated, inventory] = await Promise.all([
        client.readWorkspaceSkill(workspaceId, record.id, record.revisionId),
        client.listWorkspaceSkills(workspaceId),
      ]);
      if (inventoryGeneration.current === inventoryRequest) {
        setSkills(inventory.skills);
        setNextCursor(inventory.nextCursor ?? null);
      }
      if (generation.current !== current) return;
      // Keep any unsaved file edits while refreshing scope/version metadata.
      setRecord(updated);

      setNotice("Skill scope updated.");
    } catch (reason) {
      if (generation.current === current)
        setError(reason instanceof Error ? reason.message : "Could not change skill scope");
    } finally {
      if (generation.current === current) setBusy(false);
    }
  }
  async function mutate(operation: "save" | "approve" | "restore") {
    if (!record) return;
    const current = ++generation.current;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const version = {
        ...(operation === "approve" && record.removalOperationId
          ? { removalOperationId: record.removalOperationId }
          : {}),
        operationId: crypto.randomUUID(),
        expectedRevisionId: record.activeRevisionId,
        expectedScopeVersion: record.scopeVersion,
        reason: operation === "save" ? "Save Skill files" : `${operation} Skill revision`,
      };
      const receipt =
        operation === "save"
          ? await client.saveWorkspaceSkill(workspaceId, {
              ...version,
              skillId: record.id,
              scope: record.scope,
              stableKey: record.stableKey || `authored-${record.id.replaceAll("-", "")}`,
              files,
              deletions: record.files
                .filter((file) => !files.some((next) => next.path === file.path))
                .map((file) => file.path),
            })
          : await (
              operation === "approve"
                ? client.approveWorkspaceSkill.bind(client)
                : client.restoreWorkspaceSkill.bind(client)
            )(workspaceId, record.id, { ...version, revisionId: record.revisionId! });
      if (generation.current !== current) return;
      if (receipt.removed) {
        setRecord(null);
        if (slot?.openKey?.startsWith("skill:")) slot.close({ replace: true });
        setSkills((await client.listWorkspaceSkills(workspaceId)).skills);
        setNotice("Skill and all stored revisions permanently deleted.");
        return;
      }
      const inventoryRequest = ++inventoryGeneration.current;
      const [updated, inventory, detail] = await Promise.all([
        client.readWorkspaceSkill(workspaceId, receipt.skillId),
        client.listWorkspaceSkills(workspaceId),
        client.getPreferenceRegistry(workspaceId, receipt.skillId),
      ]);
      if (inventoryGeneration.current === inventoryRequest) {
        setSkills(inventory.skills);
        setNextCursor(inventory.nextCursor ?? null);
      }
      if (generation.current !== current) return;
      show(updated);
      if (draftId) {
        setDraftId(null);
        if (slot) slot.open(`skill:${updated.id}`, { replace: true });
      }

      setHistory(detail.revisions);
      setNotice(
        receipt.outcome === "pending"
          ? "Saved for approval; not active yet."
          : receipt.outcome === "preserved"
            ? "Your customized Skill was preserved."
            : "Skill saved and active.",
      );
    } catch (reason) {
      if (generation.current === current)
        setError(reason instanceof Error ? reason.message : "Skill change failed");
    } finally {
      if (generation.current === current) setBusy(false);
    }
  }
  async function remove(): Promise<boolean> {
    if (!removal || busy) return false;
    const current = ++generation.current;
    setBusy(true);
    setRemovalError(null);
    try {
      const receipt = await client.removeWorkspaceSkill(
        workspaceId,
        removal.skill.id,
        removal.request,
      );
      if (generation.current !== current) return false;
      if (!receipt.removed) throw new Error("The skill was not removed. Reload and try again.");
      // Invalidate outstanding inventory reads before removing the row locally.
      inventoryGeneration.current++;
      setSkills((previous) => previous.filter((skill) => skill.id !== removal.skill.id));
      setRecord(null);
      setHistory([]);
      setDraftId(null);
      setNotice("Skill and all stored revisions permanently deleted.");
      if (slot?.openKey?.startsWith("skill:")) slot.close({ replace: true });
      onRemoved?.();
      return true;
    } catch (reason) {
      if (generation.current === current)
        setRemovalError(reason instanceof Error ? reason.message : "Could not remove skill");
      return false;
    } finally {
      if (generation.current === current) setBusy(false);
    }
  }
  const editable =
    record &&
    canManage(record.scope) &&
    (record.revisionId === record.activeRevisionId || record.revisionId === null);
  const matchingSkills = skills.filter((skill) =>
    `${skill.title} ${skill.stableKey}`.toLowerCase().includes(query.trim().toLowerCase()),
  );

  const backLabel = slot ? "Capabilities" : "Skills";
  const back = () => navigate(() => closePage());
  const slotSkillKey = slot?.openKey?.startsWith("skill:") ? slot.openKey : null;
  const pageContent = record ? (
    <SkillPage
      record={record}
      files={files}
      path={path}
      newPath={newPath}
      history={history}
      error={error}
      notice={notice}
      busy={busy}
      dirty={dirty}
      isNew={record.id === draftId}
      editable={Boolean(editable)}
      canManage={canManage}
      backLabel={backLabel}
      onBack={back}
      onPathChange={setPath}
      onNewPathChange={setNewPath}
      onContentChange={(content) =>
        setFiles((current) =>
          current.map((file) => (file.path === path ? { ...file, content } : file)),
        )
      }
      onAddFile={() => {
        setFiles((current) => [...current, { path: newPath, content: "" }]);
        setPath(newPath);
        setNewPath("");
      }}
      onRemoveFile={() => {
        setFiles((current) => current.filter((file) => file.path !== path));
        setPath("SKILL.md");
      }}
      onRemove={() => {
        removalTriggerRef.current = document.activeElement as HTMLElement | null;
        setRemovalError(null);
        setRemoval({
          skill: record,
          request: {
            operationId: crypto.randomUUID(),
            expectedRevisionId: record.activeRevisionId,
            expectedScopeVersion: record.scopeVersion,
            reason: "Remove skill from the Skills editor",
          },
        });
      }}
      onSave={() => void mutate("save")}
      onDiscard={() => {
        setFiles(record.files);
        setPath("SKILL.md");
      }}
      onReviewRevision={(operation) => void mutate(operation)}
      onChangeScope={(scope) => void changeScope(scope)}
      onOpenRevision={(revisionId) => navigate(() => void open(record.id, revisionId))}
    />
  ) : slotSkillKey ? (
    <DetailPage back={{ label: backLabel, onClick: back }}>
      {error ? (
        <EmptyState
          variant="page"
          title="Couldn't open this skill"
          description={error}
          action={
            <Button type="button" variant="outline" size="sm" onClick={back}>
              Back to Capabilities
            </Button>
          }
        />
      ) : (
        <DetailSkeleton />
      )}
    </DetailPage>
  ) : null;
  const pageInPlace = !slot && record !== null;

  return (
    <section aria-label="Skills" className="skills-panel space-y-4">
      <div hidden={pageInPlace} className="space-y-4">
        <CatalogHeader
          title="Skills"
          headingRef={headingRef}
          hidden={Boolean(query.trim()) && !matchingSkills.length && !record}
          action={
            <div hidden={Boolean(query.trim())} className="flex flex-wrap gap-2">
              {([personalWorkspace ? "user" : "workspace", "organization"] as const)
                .filter(canManage)
                .slice(0, 1)
                .map((scope) => (
                  <DropdownMenu key={scope}>
                    <DropdownMenuTrigger asChild>
                      <Button ref={newSkillRef} variant="default" disabled={busy}>
                        <PlusIcon aria-hidden="true" />
                        New skill
                        <ChevronDownIcon aria-hidden="true" />
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end">
                      <DropdownMenuItem onSelect={() => navigate(() => create(scope))}>
                        Create manually
                      </DropdownMenuItem>
                      {onFindSkill ? (
                        <DropdownMenuItem onSelect={onFindSkill}>Browse skills</DropdownMenuItem>
                      ) : null}
                      {onImportSkill ? (
                        <DropdownMenuItem onSelect={onImportSkill}>
                          Import from URL
                        </DropdownMenuItem>
                      ) : null}
                    </DropdownMenuContent>
                  </DropdownMenu>
                ))}
            </div>
          }
        />
        {error && !record ? (
          <p role="alert" className="text-sm text-status-error">
            {error}{" "}
            <Button
              variant="outline"
              disabled={busy}
              onClick={() => navigate(() => setReload((value) => value + 1))}
            >
              Reload Skills
            </Button>
          </p>
        ) : null}
        {notice && !record ? (
          <p role="status" className="text-sm">
            {notice}
          </p>
        ) : null}
        {loading ? <p role="status">Loading Skills…</p> : null}
        {!loading && !skills.length ? (
          <p className="text-sm text-fg-subtle">
            {onFindSkill
              ? "No skills installed yet. Browse the catalog below or add your own."
              : "No skills yet. Create one to give your agent reusable instructions."}
          </p>
        ) : null}
        <ConnectionInstalled
          title="Your skills"
          items={matchingSkills.map((skill) => ({
            id: skill.id,
            name: humanizeName(skill.title || skill.stableKey),
            icon: <BookOpenIcon aria-hidden="true" className="size-10 p-2 text-fg-muted" />,
            status: skillStatus(skill),
            showStatus: skillStatus(skill) !== "Installed",
            needsAttention: Boolean(skill.pendingRevisionIds.length),
            disabled: busy,
            onOpen: () => {
              if (!busy) navigate(() => void open(skill.id));
            },
          }))}
        />
        {nextCursor ? (
          <Button variant="outline" disabled={busy} onClick={() => void loadMore()}>
            Load more Skills
          </Button>
        ) : null}
      </div>
      {pageContent ? (
        slot ? (
          <CapabilitySlotPage pageKey={slotSkillKey ?? ""}>{pageContent}</CapabilitySlotPage>
        ) : (
          pageContent
        )
      ) : null}
      <ConfirmDialog
        open={removal !== null}
        onOpenChange={(isOpen) => {
          if (!isOpen) setRemoval(null);
        }}
        title={`Remove “${humanizeName(removal?.skill.title || removal?.skill.stableKey || "skill")}”?`}
        description="This permanently deletes the skill and all its saved revisions. It cannot be undone. Existing conversations stay unchanged."
        confirmLabel="Remove skill"
        cancelAutoFocus
        restoreFocusRef={removalTriggerRef}
        restoreFocusFallbackRef={headingRef}
        onConfirm={remove}
      >
        {dirty ? (
          <p className="text-sm text-fg-muted">Unsaved changes will also be discarded.</p>
        ) : null}
        {removal?.skill.source ? (
          <p className="text-sm text-fg-muted">
            If a plugin still owns this skill, remove it from the plugin first.
          </p>
        ) : null}
        {removalError ? (
          <p role="alert" className="text-sm text-danger">
            {removalError}
          </p>
        ) : null}
      </ConfirmDialog>
      <ConfirmDialog
        open={discardAction !== null}
        onOpenChange={(isOpen) => {
          if (!isOpen) setDiscardAction(null);
        }}
        title="Discard unsaved Skill changes?"
        description="Your edits have not been saved. Switching will discard them."
        confirmLabel="Discard changes"
        cancelAutoFocus
        onConfirm={() => {
          discardAction?.();
        }}
      />
    </section>
  );
}

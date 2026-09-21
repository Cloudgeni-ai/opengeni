import { useCallback, useEffect, useId, useRef, useState, type RefObject } from "react";
import { BookOpenIcon, ChevronDownIcon, PlusIcon } from "lucide-react";
import { ConnectionInstalled } from "@opengeni/react/connect";
import "@opengeni/react/connect.css";
import type {
  SkillRecord,
  SkillScope,
  SkillSummary,
  PreferenceRegistryRevisionSummary,
} from "@opengeni/sdk";
import { CatalogHeader } from "@/components/capabilities/catalog-header";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Select } from "@/components/ui/select";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { CapabilityDialogContent } from "@/components/capabilities/detail-dialog";
import {
  Dialog as Sheet,
  DialogDescription as SheetDescription,
  DialogHeader as SheetHeader,
  DialogTitle as SheetTitle,
} from "@/components/ui/dialog";
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
  openSkillRef,
}: {
  workspaceId: string;
  personalWorkspace?: boolean;
  query?: string;
  onFindSkill?: (() => void) | undefined;
  onImportSkill?: (() => void) | undefined;
  refreshRevision?: number;
  onSkillsChange?: (skills: SkillSummary[]) => void;
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
  openSkillRef?: RefObject<((id: string) => void) | null>;
}) {
  const { client } = context;
  const editorId = useId();
  const openerRef = useRef<HTMLElement | null>(null);
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
  const [discardAction, setDiscardAction] = useState<(() => void) | null>(null);
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
    const current = ++inventoryGeneration.current;
    setLoading(true);
    setBusy(false);
    setRecord(null);
    setHistory([]);
    setNotice(null);
    setDiscardAction(null);
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
      show(next);
      setHistory(detail.revisions);
    } catch (reason) {
      if (generation.current === current)
        setError(reason instanceof Error ? reason.message : "Could not open Skill");
    } finally {
      if (generation.current === current) setBusy(false);
    }
  }
  function create(scope: SkillScope) {
    openerRef.current = newSkillRef.current;
    generation.current++;
    setHistory([]);
    setError(null);
    setNotice(null);
    show({
      id: crypto.randomUUID(),
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
  const editable =
    record &&
    canManage(record.scope) &&
    (record.revisionId === record.activeRevisionId || record.revisionId === null);
  const selected = files.find((file) => file.path === path);
  const matchingSkills = skills.filter((skill) =>
    `${skill.title} ${skill.stableKey}`.toLowerCase().includes(query.trim().toLowerCase()),
  );

  return (
    <section aria-label="Skills" className="skills-panel space-y-4">
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
                      <DropdownMenuItem onSelect={onFindSkill}>
                        Find a skill in the catalogue
                      </DropdownMenuItem>
                    ) : null}
                    {onImportSkill ? (
                      <DropdownMenuItem onSelect={onImportSkill}>Import from URL</DropdownMenuItem>
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
          name: skill.title || skill.stableKey,
          icon: <BookOpenIcon aria-hidden="true" className="size-10 p-2 text-fg-muted" />,
          status: skill.pendingRevisionIds.length
            ? "Pending changes"
            : skill.status === "active"
              ? "Installed"
              : `Not active · ${skill.status}`,
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
      <Sheet
        open={record !== null}
        onOpenChange={(isOpen) => {
          if (!isOpen && !busy) navigate(() => setRecord(null));
        }}
      >
        {record ? (
          <CapabilityDialogContent
            id={editorId}
            showCloseButton={!busy}
            onEscapeKeyDown={(event) => {
              if (busy) event.preventDefault();
            }}
            onInteractOutside={(event) => {
              if (busy) event.preventDefault();
            }}
            onCloseAutoFocus={(event) => {
              event.preventDefault();
              const opener = openerRef.current;
              openerRef.current = null;
              if (opener?.isConnected && !opener.matches(":disabled")) opener.focus();
              else headingRef.current?.focus();
            }}
          >
            <SheetHeader className="shrink-0 border-b border-border px-6 py-5 pr-12 text-left">
              <SheetTitle className="break-words text-xl font-semibold tracking-tight">
                {record.title || record.stableKey || "New skill"}
              </SheetTitle>
              <SheetDescription>
                Edit the name and description at the top of SKILL.md.
              </SheetDescription>
            </SheetHeader>
            <div className="skill-editor min-h-0 space-y-4 overflow-y-auto px-6 py-5">
              {error ? (
                <p role="alert" className="text-sm text-status-error">
                  {error}
                </p>
              ) : null}
              {notice ? (
                <p role="status" className="text-sm">
                  {notice}
                </p>
              ) : null}
              <div className="flex flex-wrap items-center gap-3 text-xs text-fg-subtle">
                {record.source
                  ? "Installed Skill · workspace edits preserve the upstream source"
                  : "Authored Skill"}{" "}
                <Select
                  aria-label="Skill scope"
                  value={record.scope}
                  disabled={busy || !canManage(record.scope)}
                  onChange={(event) => void changeScope(event.target.value as SkillScope)}
                >
                  {(["user", "workspace", "organization"] as const)
                    .filter((scope) => scope === record.scope || canManage(scope))
                    .map((scope) => (
                      <option key={scope} value={scope}>
                        {scope === "user"
                          ? "Personal"
                          : scope === "workspace"
                            ? "Workspace"
                            : "Organization"}
                      </option>
                    ))}
                </Select>
              </div>
              {history.length ? (
                <label className="flex flex-wrap items-center gap-3 text-sm">
                  History
                  <Select
                    aria-label="History"
                    value={record.revisionId ?? ""}
                    disabled={busy}
                    onChange={(event) => {
                      const revisionId = event.target.value;
                      navigate(() => void open(record.id, revisionId));
                    }}
                  >
                    {history.map((revision) => (
                      <option key={revision.id} value={revision.id}>
                        Version {revision.revision}
                        {revision.id === record.activeRevisionId ? " · active" : ""}
                        {record.pendingRevisionIds.includes(revision.id) ? " · pending" : ""}
                      </option>
                    ))}
                  </Select>
                </label>
              ) : null}
              <label className="flex flex-wrap items-center gap-3 text-sm">
                File
                <Select
                  aria-label="File"
                  value={path}
                  onChange={(event) => setPath(event.target.value)}
                >
                  {files.map((file) => (
                    <option key={file.path} value={file.path}>
                      {file.path}
                    </option>
                  ))}
                </Select>
              </label>
              <Textarea
                aria-label={`Contents of ${path}`}
                value={selected?.content ?? ""}
                disabled={!editable || busy}
                className="min-h-72 font-mono"
                onChange={(event) =>
                  setFiles((current) =>
                    current.map((file) =>
                      file.path === path ? { ...file, content: event.target.value } : file,
                    ),
                  )
                }
              />
              {editable ? (
                <div className="flex flex-wrap gap-2">
                  <Input
                    aria-label="New relative file path"
                    placeholder="references/example.md"
                    value={newPath}
                    onChange={(event) => setNewPath(event.target.value)}
                    disabled={busy}
                    className="max-w-sm"
                  />
                  <Button
                    variant="outline"
                    disabled={busy || !newPath || files.some((file) => file.path === newPath)}
                    onClick={() => {
                      setFiles((current) => [...current, { path: newPath, content: "" }]);
                      setPath(newPath);
                      setNewPath("");
                    }}
                  >
                    Add text file
                  </Button>
                  <Button
                    variant="outline"
                    disabled={busy || path === "SKILL.md"}
                    onClick={() => {
                      setFiles((current) => current.filter((file) => file.path !== path));
                      setPath("SKILL.md");
                    }}
                  >
                    Remove selected file
                  </Button>
                  <Button
                    disabled={
                      busy || !files.some((file) => file.path === "SKILL.md" && file.content.trim())
                    }
                    onClick={() => void mutate("save")}
                  >
                    Save Skill
                  </Button>
                </div>
              ) : null}
              {canManage(record.scope) &&
              record.revisionId &&
              record.revisionId !== record.activeRevisionId ? (
                <Button
                  disabled={busy}
                  onClick={() =>
                    void mutate(
                      record.pendingRevisionIds.includes(record.revisionId!)
                        ? "approve"
                        : "restore",
                    )
                  }
                >
                  {record.pendingRevisionIds.includes(record.revisionId)
                    ? record.removalOperationId
                      ? "Permanently delete Skill and all revisions (cannot be undone)"
                      : "Approve this revision"
                    : "Restore as a new revision"}
                </Button>
              ) : null}
            </div>
          </CapabilityDialogContent>
        ) : null}
      </Sheet>
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
